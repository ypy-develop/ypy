// SPDX-License-Identifier: MIT

package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/profiler"
	"github.com/chromedp/chromedp"
)

// ProfileOptions configure a CPU profile run. Every path is absolute.
type ProfileOptions struct {
	RunOptions
	Scenarios []string
	Seconds   float64
	Top       int
	// Raw, when set, receives the .cpuprofile files (loadable in the DevTools
	// Performance panel).
	Raw string
}

// Ranked is one function of a profile summary.
type Ranked struct {
	Name string  `json:"name"`
	Ms   float64 `json:"ms"`
	Pct  float64 `json:"pct"`
}

// ProfileSummary is the JSON a profile run writes as
// profile-<scenario>-<sha>.json.
type ProfileSummary struct {
	TotalMs   float64  `json:"totalMs"`
	HarnessMs float64  `json:"harnessMs"`
	IdleMs    float64  `json:"idleMs"`
	Self      []Ranked `json:"self"`
	Inclusive []Ranked `json:"inclusive"`
	Scenario  string   `json:"scenario"`
	SHA       string   `json:"sha"`
	Build     string   `json:"build"`
	Runs      int      `json:"runs"`
}

// harnessScript is the module whose own time the profile leaves out.
const harnessScript = "/scenarios.js"

// Profile profiles the scenarios through the DevTools Profiler domain. The
// build defaults to dist/ypy.js, the unminified one, so the profile shows
// function names (private methods appear as #name).
func Profile(ctx context.Context, o ProfileOptions) error {
	pages := filepath.Join(o.Root, "bench", "pages")
	if _, err := os.Stat(filepath.Join(pages, "index.html")); err != nil {
		return usageError{fmt.Errorf("no benchmark page at %s (run from the repository root or pass --root)", pages)}
	}
	rb, err := resolveBuild(ctx, o.RunOptions, false, o.Err)
	if err != nil {
		return err
	}
	defer rb.cleanup()
	if _, err := os.Stat(rb.file); err != nil {
		return usageError{fmt.Errorf("the build to profile does not exist: %s (run ypy build, or pass --build)", rb.file)}
	}
	if err := os.MkdirAll(o.Out, 0o755); err != nil {
		return err
	}
	sha := buildSHA(ctx, o.RunOptions, rb)
	buildName := displayPath(o.Root, rb.file)
	if o.Ref != "" {
		buildName = "ref " + rb.sha + " (ypy build --only core)"
	}
	s, err := openSession(ctx, pages, rb.file, o.Port, o.ChromePath, o.Env)
	if err != nil {
		return err
	}
	defer s.close()

	for _, scenario := range o.Scenarios {
		summary, raw, err := profileScenario(ctx, s, scenario, o.Seconds)
		if err != nil {
			fmt.Fprintf(o.Err, "%s: %v\n", scenario, err)
			continue
		}
		summary.Scenario, summary.SHA, summary.Build = scenario, sha, buildName
		if err := WriteJSON(filepath.Join(o.Out, fmt.Sprintf("profile-%s-%s.json", scenario, sha)), summary); err != nil {
			return err
		}
		if o.Raw != "" {
			if err := os.MkdirAll(o.Raw, 0o755); err != nil {
				return err
			}
			b, _ := json.Marshal(raw)
			if err := os.WriteFile(filepath.Join(o.Raw, fmt.Sprintf("%s-%s.cpuprofile", scenario, sha)), b, 0o644); err != nil {
				return err
			}
		}
		printProfile(o.Out2, summary, o.Top)
	}
	return nil
}

func profileScenario(ctx context.Context, s *session, scenario string, seconds float64) (*ProfileSummary, *profiler.Profile, error) {
	t, err := s.newPage(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer t.stop()
	call := func(ms int) (loopResult, error) {
		name, _ := marshal(scenario)
		var r loopResult
		err := t.eval(fmt.Sprintf("window.__bench.loop(%s, %d, { scale: 0.3 })", name, ms), &r)
		return r, err
	}
	if _, err := chromedp.Call(t.ctx, profiler.Enable, cdp.Empty{}); err != nil {
		return nil, nil, err
	}
	if _, err := chromedp.Call(t.ctx, profiler.SetSamplingInterval, profiler.SetSamplingIntervalParams{Interval: 100}); err != nil {
		return nil, nil, err
	}
	// a short run first: the JIT is warm when the profile starts
	if _, err := call(800); err != nil {
		return nil, nil, err
	}
	if _, err := chromedp.Call(t.ctx, profiler.Start, cdp.Empty{}); err != nil {
		return nil, nil, err
	}
	run, err := call(int(seconds * 1000))
	stopped, stopErr := chromedp.Call(t.ctx, profiler.Stop, cdp.Empty{})
	if err != nil {
		return nil, nil, err
	}
	if stopErr != nil {
		return nil, nil, stopErr
	}
	if run.Error != "" {
		return nil, nil, fmt.Errorf("%s", run.Error)
	}
	if run.Skipped != "" {
		return nil, nil, fmt.Errorf("skipped: %s", run.Skipped)
	}
	summary := analyzeProfile(stopped.Profile)
	summary.Runs = run.Runs
	return summary, stopped.Profile, nil
}

type loopResult struct {
	Runs    int    `json:"runs"`
	Error   string `json:"error"`
	Skipped string `json:"skipped"`
}

// analyzeProfile turns a CPU profile into self and inclusive time per
// function. Idle time and the harness's own setup code are left out of the
// shares; time the page spends in native code called straight from the harness
// (for example the focus() of a morph scenario) counts under the native
// function's name.
func analyzeProfile(p *profiler.Profile) *ProfileSummary {
	nodes := map[int64]*profiler.ProfileNode{}
	parent := map[int64]int64{}
	for _, n := range p.Nodes {
		nodes[n.ID] = n
	}
	for _, n := range p.Nodes {
		for _, c := range n.Children {
			parent[c] = n.ID
		}
	}
	keyOf := func(n *profiler.ProfileNode) string {
		f := n.CallFrame
		name := f.FunctionName
		if name == "" {
			name = "(anonymous)"
		}
		if f.URL == "" { // (program), (idle), (garbage collector), (root)
			return name
		}
		file := f.URL[strings.LastIndex(f.URL, "/")+1:]
		return fmt.Sprintf("%s %s:%d", name, file, f.LineNumber+1)
	}
	var self, inclusive Ordered[float64]
	add := func(o *Ordered[float64], k string, dt float64) {
		v, _ := o.Get(k)
		o.Set(k, v+dt)
	}
	var total, idle, harness float64
	for i, id := range p.Samples {
		// the delta that follows a sample is the time it covers
		var dt int64
		switch {
		case i+1 < len(p.TimeDeltas):
			dt = p.TimeDeltas[i+1]
		case i < len(p.TimeDeltas):
			dt = p.TimeDeltas[i]
		}
		d := float64(dt)
		node := nodes[id]
		if node == nil {
			continue
		}
		leaf := keyOf(node)
		if leaf == "(idle)" {
			idle += d
			continue
		}
		// time the harness itself spends (building the page for a scenario) is not YPY's
		if strings.HasSuffix(node.CallFrame.URL, harnessScript) {
			harness += d
			continue
		}
		total += d
		add(&self, leaf, d)
		seen := map[string]bool{}
		for cur, ok := node.ID, true; ok; cur, ok = parentOf(parent, cur) {
			key := keyOf(nodes[cur])
			if key == "(root)" || seen[key] {
				continue
			}
			seen[key] = true
			add(&inclusive, key, d)
		}
	}
	rank := func(o *Ordered[float64]) []Ranked {
		type kv struct {
			k string
			v float64
		}
		list := make([]kv, 0, o.Len())
		for _, k := range o.Keys() {
			v, _ := o.Get(k)
			list = append(list, kv{k, v})
		}
		sort.SliceStable(list, func(i, j int) bool { return list[i].v > list[j].v })
		out := make([]Ranked, 0, 60)
		for _, e := range list {
			if len(out) == 60 {
				break
			}
			out = append(out, Ranked{Name: e.k, Ms: round(e.v/1000, 1), Pct: pctOf(e.v, total)})
		}
		return out
	}
	return &ProfileSummary{
		TotalMs:   round(total/1000, 0),
		HarnessMs: round(harness/1000, 0),
		IdleMs:    round(idle/1000, 0),
		Self:      rank(&self),
		Inclusive: rank(&inclusive),
	}
}

// pctOf is the share of total in percent, rounded to one decimal.
func pctOf(v, total float64) float64 {
	if total == 0 {
		return 0
	}
	return round(v/total*100, 1)
}

func parentOf(parent map[int64]int64, id int64) (int64, bool) {
	p, ok := parent[id]
	return p, ok
}

// round rounds like JavaScript's +(v).toFixed(digits).
func round(v float64, digits int) float64 {
	f, err := strconv.ParseFloat(toFixed(v, digits), 64)
	if err != nil {
		return 0
	}
	return f
}

var runtimeNoise = regexp.MustCompile(`^\((program|garbage collector)\)`)

func printProfile(w io.Writer, s *ProfileSummary, top int) {
	fmt.Fprintf(w, "\n=== %s @ %s (%s) ===\n", s.Scenario, s.SHA, s.Build)
	fmt.Fprintf(w, "busy %s ms over %d scenario runs (%s ms of harness setup left out)\n\n", formatNum(s.TotalMs), s.Runs, formatNum(s.HarnessMs))
	show := func(title string, list []Ranked) {
		fmt.Fprintln(w, title)
		rows := [][]string{{"%", "ms", "function"}}
		for _, r := range list {
			if len(rows) > top {
				break
			}
			rows = append(rows, []string{toFixed(r.Pct, 1), formatNum(r.Ms), r.Name})
		}
		fmt.Fprintln(w, table(rows, "rrl"))
		fmt.Fprintln(w)
	}
	show("self time", s.Self)
	var incl []Ranked
	for _, r := range s.Inclusive {
		if !runtimeNoise.MatchString(r.Name) {
			incl = append(incl, r)
		}
	}
	show("inclusive time", incl)
}
