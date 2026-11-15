// SPDX-License-Identifier: MIT

package bench

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
)

// RunOptions configure a measurement run. Every path is absolute.
type RunOptions struct {
	// Root is the repository root: it holds bench/pages and dist/.
	Root string
	// Build is the file to measure; empty means $YPY_BUILD, then dist/ypy.min.js.
	Build string
	// Ref, when set, builds that commit in a temporary directory and measures it.
	Ref string
	// Out is the directory of the JSON result.
	Out string
	// Label is added to the file name: <date>-<sha>-<label>.json.
	Label string
	// Filter keeps the scenarios whose name matches (the size entries always run).
	Filter string
	// Quick is one round with fewer samples: a smoke run, not a result.
	Quick bool
	// Rounds is the number of fresh pages per scenario, pooled (default 5).
	Rounds int
	// UAM also takes performance.measureUserAgentSpecificMemory() before and
	// after the session (about 18 s per call).
	UAM bool
	// Port of the local server; 0 picks a free one.
	Port       int
	ChromePath string
	// List prints the scenario names and stops.
	List bool

	Out2  io.Writer // table and progress
	Err   io.Writer
	IsTTY bool
	Env   func(string) string
}

// Outcome of a run.
type Outcome struct {
	Result *Result
	// Path of the JSON file; empty when nothing was written (--list).
	Path string
	// Failed is true when a scenario reported an error; the result is written
	// all the same, without that scenario.
	Failed bool
}

func (o RunOptions) env(key string) string {
	if o.Env == nil {
		return ""
	}
	return o.Env(key)
}

// resolvedBuild is the file to measure, plus the commit that produced it and
// the function that removes what was built for it.
type resolvedBuild struct {
	file    string
	sha     string // short sha when it comes from --ref
	cleanup func()
}

func resolveBuild(ctx context.Context, o RunOptions, minified bool, errw io.Writer) (resolvedBuild, error) {
	if o.Ref != "" {
		dist, sha, cleanup, err := buildRef(ctx, o.Root, o.Ref, errw)
		if err != nil {
			return resolvedBuild{}, err
		}
		name := "ypy.min.js"
		if !minified {
			name = "ypy.js"
		}
		return resolvedBuild{file: filepath.Join(dist, name), sha: sha, cleanup: cleanup}, nil
	}
	file := o.Build
	if file == "" {
		file = o.env("YPY_BUILD")
		if file != "" && !filepath.IsAbs(file) {
			file = filepath.Join(o.Root, file)
		}
	}
	if file == "" {
		name := "ypy.min.js"
		if !minified {
			name = "ypy.js"
		}
		file = filepath.Join(o.Root, "dist", name)
	}
	return resolvedBuild{file: file, cleanup: func() {}}, nil
}

// buildSHA is the commit of the build: $YPY_SHA, else the commit --ref built,
// else HEAD (with -dirty when src or dist differ from it).
func buildSHA(ctx context.Context, o RunOptions, rb resolvedBuild) string {
	if v := o.env("YPY_SHA"); v != "" {
		return v
	}
	if rb.sha != "" {
		return rb.sha
	}
	sha, err := gitOutput(ctx, o.Root, "rev-parse", "--short=9", "HEAD")
	if err != nil {
		return "unknown"
	}
	if status, err := gitOutput(ctx, o.Root, "status", "--porcelain", "--", "src", "dist"); err == nil && status != "" {
		sha += "-dirty"
	}
	return sha
}

// buildSizes measures the build: bytes, gzip (level 9) and brotli.
func buildSizes(file string) (bytes_, gz, br int, err error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return 0, 0, 0, err
	}
	var g bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&g, gzip.BestCompression)
	zw.Write(data)
	zw.Close()
	var b bytes.Buffer
	bw := brotli.NewWriterLevel(&b, brotli.BestCompression)
	bw.Write(data)
	bw.Close()
	return len(data), g.Len(), b.Len(), nil
}

// rawMetric collects the samples of one metric, one slice per round.
type rawMetric struct {
	unit   string
	rounds [][]float64
}

type sampleSet struct {
	Unit    string    `json:"unit"`
	Samples []float64 `json:"samples"`
}

// scenarioOut is what window.__bench.run() returns.
type scenarioOut struct {
	Error   string             `json:"error"`
	Skipped string             `json:"skipped"`
	Metrics Ordered[sampleSet] `json:"metrics"`
	Note    string             `json:"note"`
	Memory  []Checkpoint       `json:"memory"`
}

type scenarioInfo struct {
	Name  string `json:"name"`
	Group string `json:"group"`
}

// Run measures the build and writes the result. It returns the outcome, or an
// error: *browsers.Unavailable when Chrome is missing, any other for what
// could not run at all.
func Run(ctx context.Context, o RunOptions) (*Outcome, error) {
	var filter *regexp.Regexp
	if o.Filter != "" {
		var err error
		if filter, err = regexp.Compile(o.Filter); err != nil {
			return nil, usageError{fmt.Errorf("--filter: %w", err)}
		}
	}
	rounds := max(1, o.Rounds)
	scale := 1.0
	if o.Quick {
		rounds, scale = 1, 0.3
	}
	pages := filepath.Join(o.Root, "bench", "pages")
	if _, err := os.Stat(filepath.Join(pages, "index.html")); err != nil {
		return nil, usageError{fmt.Errorf("no benchmark page at %s (run from the repository root or pass --root)", pages)}
	}
	rb, err := resolveBuild(ctx, o, true, o.Err)
	if err != nil {
		return nil, err
	}
	defer rb.cleanup()
	if _, err := os.Stat(rb.file); err != nil {
		return nil, usageError{fmt.Errorf("the build to measure does not exist: %s (run ypy build, or pass --build)", rb.file)}
	}

	s, err := openSession(ctx, pages, rb.file, o.Port, o.ChromePath, o.Env)
	if err != nil {
		return nil, err
	}
	defer s.close()

	probe, err := s.newPage(ctx)
	if err != nil {
		return nil, err
	}
	var all []scenarioInfo
	err = probe.eval(`window.__bench.list()`, &all)
	chromeVersion := probe.chromeVersion()
	probe.stop()
	if err != nil {
		return nil, err
	}
	if o.List {
		for _, sc := range all {
			fmt.Fprintln(o.Out2, sc.Name)
		}
		return &Outcome{}, nil
	}
	var chosen []scenarioInfo
	for _, sc := range all {
		if filter == nil || filter.MatchString(sc.Name) {
			chosen = append(chosen, sc)
		}
	}

	var (
		raw     Ordered[*rawMetric]
		notes   = map[string][]string{}
		skipped Ordered[string]
		memory  Ordered[[]Checkpoint]
		failed  bool
		started = time.Now()
	)
	for r := range rounds {
		for _, sc := range chosen {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if o.IsTTY {
				fmt.Fprintf(o.Err, "\r%-60s", fmt.Sprintf("[%d/%d] %s", r+1, rounds, sc.Name))
			}
			out, err := runScenario(ctx, s, sc.Name, scale, o.UAM, o.Err)
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				fmt.Fprintf(o.Err, "\n%s: %v\n", sc.Name, err)
				failed = true
				continue
			}
			if out.Error != "" {
				fmt.Fprintf(o.Err, "\n%s: %s\n", sc.Name, out.Error)
				failed = true
				continue
			}
			if out.Skipped != "" {
				skipped.Set(sc.Name, out.Skipped)
				continue
			}
			for _, id := range out.Metrics.Keys() {
				ss, _ := out.Metrics.Get(id)
				entry, ok := raw.Get(id)
				if !ok {
					entry = &rawMetric{unit: ss.Unit}
					raw.Set(id, entry)
				}
				entry.rounds = append(entry.rounds, ss.Samples)
			}
			if out.Note != "" {
				notes[sc.Name] = append(notes[sc.Name], out.Note)
			}
			if out.Memory != nil {
				memory.Set(sc.Name, out.Memory)
			}
		}
	}
	if o.IsTTY {
		fmt.Fprintf(o.Err, "\r%70s\r", "")
	}

	var res Result
	res.Schema = 1
	now := time.Now().UTC()
	res.Date = now.Format("2006-01-02")
	res.Time = now.Format(time.RFC3339)
	res.SHA = buildSHA(ctx, o, rb)
	res.Build = displayPath(o.Root, rb.file)
	if o.Ref != "" {
		res.Build = "ref " + rb.sha + " (ypy build --only core)"
	}
	res.Config = Config{Rounds: rounds, Scale: scale, Quick: o.Quick}
	if o.Filter != "" {
		f := o.Filter
		res.Config.Filter = &f
	}
	res.Environment = Environment{
		Chrome: chromeVersion, Go: runtime.Version(), OS: osName(ctx), CPU: cpuModel(ctx), CrossOriginIsolated: true,
	}
	res.DurationSeconds = int(time.Since(started).Seconds() + 0.5)
	res.Skipped = skipped
	for _, sc := range chosen {
		if n := notes[sc.Name]; len(n) > 0 {
			res.Notes.Set(sc.Name, n[len(n)-1])
		}
	}
	res.MemoryCheckpoints = memory
	for _, id := range raw.Keys() {
		entry, _ := raw.Get(id)
		m := summarize(entry.rounds)
		m.Unit = entry.unit
		res.Metrics.Set(id, m)
	}
	size, gz, br, err := buildSizes(rb.file)
	if err != nil {
		return nil, err
	}
	res.Metrics.Set("size.min", exactMetric("B", float64(size)))
	res.Metrics.Set("size.min_gzip", exactMetric("B", float64(gz)))
	res.Metrics.Set("size.min_brotli", exactMetric("B", float64(br)))

	if err := os.MkdirAll(o.Out, 0o755); err != nil {
		return nil, err
	}
	name := res.Date + "-" + res.SHA
	if o.Label != "" {
		name += "-" + o.Label
	}
	path := filepath.Join(o.Out, name+".json")
	if err := WriteJSON(path, res); err != nil {
		return nil, err
	}
	printResult(o.Out2, &res)
	fmt.Fprintf(o.Out2, "\nwrote %s\n", displayPath(o.Root, path))
	return &Outcome{Result: &res, Path: path, Failed: failed}, nil
}

// runScenario runs one scenario in a fresh page.
func runScenario(ctx context.Context, s *session, name string, scale float64, uam bool, errw io.Writer) (*scenarioOut, error) {
	t, err := s.newPage(ctx)
	if err != nil {
		return nil, err
	}
	defer t.stop()
	nameJSON, _ := marshal(name)
	opts, _ := marshal(map[string]any{"scale": scale, "uam": uam})
	var out scenarioOut
	err = t.eval(fmt.Sprintf("window.__bench.run(%s, %s)", nameJSON, opts), &out)
	for _, msg := range t.pageErrors() {
		fmt.Fprintf(errw, "page error: %s\n", msg)
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func printResult(w io.Writer, r *Result) {
	rows := [][]string{{"metric", "unit", "median", "p95", "min", "noise % (IQR of rounds)"}}
	for _, id := range r.Metrics.Keys() {
		m, _ := r.Metrics.Get(id)
		rows = append(rows, []string{id, m.Unit, formatNum(m.Median), formatNum(m.P95), formatNum(m.Min), noiseText(m)})
	}
	fmt.Fprintf(w, "\nbuild %s  sha %s  %s  rounds %d\n", r.Build, r.SHA, r.Environment.Chrome, r.Config.Rounds)
	fmt.Fprintln(w, table(rows, "ll"))
	for _, name := range r.Notes.Keys() {
		note, _ := r.Notes.Get(name)
		fmt.Fprintf(w, "note %s: %s\n", name, note)
	}
	for _, name := range r.Skipped.Keys() {
		why, _ := r.Skipped.Get(name)
		fmt.Fprintf(w, "skipped %s: %s\n", name, why)
	}
}

func noiseText(m Metric) string {
	if m.NoisePct == 0 {
		return "-"
	}
	return toFixed(m.NoisePct, 1)
}

func displayPath(root, p string) string {
	if rel, err := filepath.Rel(root, p); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.ToSlash(rel)
	}
	return p
}

// osName is "darwin 27.2.0": the system and its kernel release.
func osName(ctx context.Context) string {
	if runtime.GOOS == "windows" {
		return runtime.GOOS
	}
	out, err := exec.CommandContext(ctx, "uname", "-r").Output()
	if err != nil {
		return runtime.GOOS
	}
	return runtime.GOOS + " " + strings.TrimSpace(string(out))
}

// cpuModel is the name of the processor, when the system tells it.
func cpuModel(ctx context.Context) string {
	switch runtime.GOOS {
	case "darwin":
		if out, err := exec.CommandContext(ctx, "sysctl", "-n", "machdep.cpu.brand_string").Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	case "linux":
		if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "model name" {
					return strings.TrimSpace(v)
				}
			}
		}
	}
	return ""
}

// usageError is a problem with what the person asked for (exit status 2).
type usageError struct{ error }

func (e usageError) Unwrap() error { return e.error }
