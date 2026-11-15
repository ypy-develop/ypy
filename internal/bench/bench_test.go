// SPDX-License-Identifier: MIT

package bench

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
	"github.com/ypy-develop/ypy/internal/cli"
)

func TestToFixedMatchesJavaScript(t *testing.T) {
	cases := []struct {
		v      float64
		digits int
		want   string
	}{
		{0.5, 0, "1"}, {1.5, 0, "2"}, {2.5, 0, "3"}, {122.5, 0, "123"},
		{1.005, 2, "1.00"}, {1.4999, 1, "1.5"}, {0.31725, 3, "0.317"},
		{12.345, 1, "12.3"}, {0, 2, "0.00"}, {-1.25, 1, "-1.2"}, {1234.5, 0, "1235"},
		{0.0004, 3, "0.000"}, {99.95, 1, "100.0"},
	}
	for _, c := range cases {
		if got := toFixed(c.v, c.digits); got != c.want {
			t.Errorf("toFixed(%v, %d) = %q, want %q", c.v, c.digits, got, c.want)
		}
	}
}

func TestFormatNum(t *testing.T) {
	cases := map[float64]string{
		0: "0", 0.31725: "0.317", 1.5: "1.50", 12.345: "12.3", 123.456: "123", 1234.5: "1,235", 1234567: "1,234,567", -2500: "-2,500",
	}
	for v, want := range cases {
		if got := formatNum(v); got != want {
			t.Errorf("formatNum(%v) = %q, want %q", v, got, want)
		}
	}
}

func TestPercentileMedianAndSummary(t *testing.T) {
	v := []float64{9, 1, 5, 3, 7}
	if got := median(v); got != 5 {
		t.Errorf("median = %v", got)
	}
	if got := median([]float64{1, 2, 3, 4}); got != 2.5 {
		t.Errorf("even median = %v", got)
	}
	if got := percentile(v, 0.95); got != 9 {
		t.Errorf("p95 = %v", got)
	}
	if got := percentile(v, 0.25); got != 3 {
		t.Errorf("p25 = %v", got)
	}
	m := summarize([][]float64{{10, 10, 10}, {10, 10, 10}, {10, 10, 10}})
	if m.N != 9 || m.Median != 10 || m.Min != 10 || m.NoisePct != 0 || m.CV != 0 || len(m.RoundMedians) != 3 {
		t.Errorf("flat summary: %+v", m)
	}
	// round medians 8, 10, 12, 20 -> IQR over the pooled median
	noisy := summarize([][]float64{{8}, {10}, {12}, {20}})
	if want := (percentile([]float64{8, 10, 12, 20}, 0.75) - percentile([]float64{8, 10, 12, 20}, 0.25)) / noisy.Median * 100; noisy.NoisePct != want || want == 0 {
		t.Errorf("noise = %v, want %v", noisy.NoisePct, want)
	}
	if two := summarize([][]float64{{1}, {9}}); two.NoisePct != 0 {
		t.Errorf("two rounds must report no noise, got %v", two.NoisePct)
	}
}

func TestTableAlignment(t *testing.T) {
	got := table([][]string{{"a", "n"}, {"long", "1"}}, "l")
	want := "a     n\n----  -\nlong  1"
	if got != want {
		t.Errorf("table:\n%q\nwant\n%q", got, want)
	}
}

func metric(unit string, median, noise float64) Metric {
	lower := true
	return Metric{Unit: unit, LowerIsBetter: &lower, N: 1, Median: median, P95: median, Min: median, Mean: median, RoundMedians: []float64{median}, NoisePct: noise}
}

func result(sha string, metrics map[string]Metric, order ...string) *Result {
	r := &Result{Schema: 1, Date: "2026-11-14", SHA: sha, Build: "dist/ypy.min.js"}
	r.Config.Rounds = 5
	for _, id := range order {
		r.Metrics.Set(id, metrics[id])
	}
	return r
}

func TestCompareFlags(t *testing.T) {
	a := result("aaa", map[string]Metric{
		"x.slow":  metric("ms", 10, 0),
		"x.fast":  metric("ms", 10, 0),
		"x.same":  metric("ms", 10, 0),
		"x.noisy": metric("ms", 10, 20),
		"x.new":   metric("count", 0, 0),
		"x.gone":  metric("ms", 1, 0),
	}, "x.slow", "x.fast", "x.same", "x.noisy", "x.new", "x.gone")
	b := result("bbb", map[string]Metric{
		"x.slow":  metric("ms", 12, 0),
		"x.fast":  metric("ms", 8, 0),
		"x.same":  metric("ms", 10.2, 0),
		"x.noisy": metric("ms", 11, 0),
		"x.new":   metric("count", 3, 0),
		"x.extra": metric("ms", 1, 0),
	}, "x.slow", "x.fast", "x.same", "x.noisy", "x.new", "x.extra")
	var out bytes.Buffer
	c := Compare(&out, a, b, CompareOptions{Threshold: 5})
	text := out.String()
	if c.Regressions != 3 || c.Faster != 1 || c.Compared != 5 {
		t.Errorf("counts = %+v\n%s", c, text)
	}
	for _, want := range []string{
		"x.slow", "+20.0%", "REGRESSION", "-20.0%", "faster", "+2.0%", "new",
		"REGRESSION ~", "3 regression(s), 1 faster, 5 compared", "only in A: x.gone", "only in B: x.extra", "threshold 5%, rounds 5 vs 5",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("output lacks %q:\n%s", want, text)
		}
	}
	var onlyOut bytes.Buffer
	c = Compare(&onlyOut, a, b, CompareOptions{Threshold: 5, Only: regexp.MustCompile(`^x\.fast$`)})
	if c.Compared != 1 || c.Regressions != 0 {
		t.Errorf("--only: %+v", c)
	}
	var zero bytes.Buffer
	if c := Compare(&zero, a, b, CompareOptions{Threshold: 0, Only: regexp.MustCompile(`same`)}); c.Regressions != 1 {
		t.Errorf("threshold 0 must flag any worsening: %+v", c)
	}
}

func TestResultJSONKeepsOrderAndDoesNotEscape(t *testing.T) {
	r := result("abc", map[string]Metric{"z.last": metric("ms", 1, 0), "a.first": metric("ms", 2, 0)}, "z.last", "a.first")
	r.Notes.Set("session.500", "heap 1 KB -> peak +2 KB")
	r.MemoryCheckpoints.Set("session.500", []Checkpoint{{At: 100, HeapUsed: 5}, {At: "end", HeapUsed: 6}})
	path := filepath.Join(t.TempDir(), "r.json")
	if err := WriteJSON(path, r); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	text := string(b)
	if strings.Index(text, "z.last") > strings.Index(text, "a.first") {
		t.Errorf("metric order lost:\n%s", text)
	}
	if !strings.Contains(text, "heap 1 KB -> peak +2 KB") || strings.Contains(text, `\u003e`) {
		t.Errorf("notes are escaped:\n%s", text)
	}
	if !strings.HasSuffix(text, "}\n") || !strings.Contains(text, "\n  \"schema\": 1,") {
		t.Errorf("not indented by two spaces with a final newline:\n%s", text)
	}
	back, err := ReadResult(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(back.Metrics.Keys(), ","); got != "z.last,a.first" {
		t.Errorf("order after reading: %s", got)
	}
	cps, _ := back.MemoryCheckpoints.Get("session.500")
	if len(cps) != 2 || cps[1].At != "end" || cps[0].At != float64(100) {
		t.Errorf("checkpoints: %+v", cps)
	}
}

// The results recorded by the earlier harness still load, and writing them
// again gives the same bytes: the format did not change.
func TestRecordedResultsRoundTrip(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join("..", "..", "bench", "results", "20*.json"))
	if len(files) == 0 {
		t.Skip("no recorded results")
	}
	for _, f := range files {
		want, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		r, err := ReadResult(f)
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		out := filepath.Join(t.TempDir(), "out.json")
		if err := WriteJSON(out, r); err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(out)
		if !bytes.Equal(got, want) {
			t.Errorf("%s: writing the result again changes it", f)
		}
	}
}

func TestReadResultRejectsOtherJSON(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.json")
	os.WriteFile(p, []byte(`{"totalMs": 1}`), 0o644)
	if _, err := ReadResult(p); err == nil {
		t.Error("a profile summary is not a result")
	}
	os.WriteFile(p, []byte(`nope`), 0o644)
	if _, err := ReadResult(p); err == nil {
		t.Error("not JSON")
	}
}

func TestServerServesBuildPageAndModules(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644)
	os.WriteFile(filepath.Join(dir, "scenarios.js"), []byte("export {}"), 0o644)
	build := filepath.Join(t.TempDir(), "ypy.min.js")
	os.WriteFile(build, []byte("window.ypy={}"), 0o644)
	h := handler(build, dir)
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}
	for path, want := range map[string]string{"/build.js": "window.ypy={}", "/": "<html></html>", "/scenarios.js": "export {}"} {
		rec := get(path)
		if rec.Code != 200 || rec.Body.String() != want {
			t.Errorf("%s: %d %q", path, rec.Code, rec.Body.String())
		}
		hd := rec.Header()
		if hd.Get("Cross-Origin-Opener-Policy") != "same-origin" || hd.Get("Cross-Origin-Embedder-Policy") != "require-corp" || hd.Get("Cache-Control") != "no-store" {
			t.Errorf("%s: headers %v", path, hd)
		}
	}
	for _, path := range []string{"/missing.js", "/../secret.js", "/lib/scenarios.js", "/index.html", "/%2e%2e%2fx.js", "/a/b"} {
		if rec := get(path); rec.Code != 404 {
			t.Errorf("%s: status %d, want 404", path, rec.Code)
		}
	}
}

func TestRefBuildsACommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	os.MkdirAll(filepath.Join(repo, "src"), 0o755)
	os.WriteFile(filepath.Join(repo, "src", "ypy.js"), []byte("class Y { __count = 1 }\nwindow.ypy = new Y()\n"), 0o644)
	os.WriteFile(filepath.Join(repo, "src", "ypy.d.ts"), []byte("export {}\n"), 0o644)
	git("add", "-A")
	git("commit", "-q", "-m", "first")
	var errb bytes.Buffer
	dist, sha, cleanup, err := buildRef(context.Background(), repo, "HEAD", &errb)
	if err != nil {
		t.Fatalf("%v\n%s", err, errb.String())
	}
	tmp := filepath.Dir(dist)
	for _, f := range []string{"ypy.min.js", "ypy.js"} {
		if _, err := os.Stat(filepath.Join(dist, f)); err != nil {
			t.Errorf("missing %s: %v", f, err)
		}
	}
	if len(sha) != 9 {
		t.Errorf("sha = %q", sha)
	}
	cleanup()
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("the temporary directory was not removed: %s", tmp)
	}
	if _, _, _, err := buildRef(context.Background(), repo, "no-such-commit", &errb); err == nil {
		t.Error("an unknown commit must fail")
	}
}

func runCLI(t *testing.T, args ...string) (code int, out, errs string) {
	t.Helper()
	var o, e bytes.Buffer
	code = Command().Run(context.Background(), args, cli.IO{Out: &o, Err: &e, Dir: t.TempDir()})
	return code, o.String(), e.String()
}

func TestCommandUsage(t *testing.T) {
	if code, out, _ := runCLI(t, "--help"); code != 0 || !strings.Contains(out, "ypy bench compare") {
		t.Errorf("--help: %d\n%s", code, out)
	}
	for _, args := range [][]string{
		{"--nope"}, {"stray"}, {"--rounds", "0"}, {"--build", "a", "--ref", "b"}, {"--filter", "("},
		{"compare", "a.json"}, {"compare", "--only", "(", "a", "b"}, {"show"}, {"profile"}, {"profile", "x", "--build", "a", "--ref", "b"},
	} {
		if code, _, errs := runCLI(t, args...); code != cli.ExitUsage {
			t.Errorf("%v: exit %d, want 2 (%s)", args, code, errs)
		}
	}
	if code, _, errs := runCLI(t, "show", "missing.json"); code != cli.ExitUsage || !strings.Contains(errs, "missing.json") {
		t.Errorf("show missing: %d %s", code, errs)
	}
}

func TestCompareAndShowCommands(t *testing.T) {
	dir := t.TempDir()
	a := result("aaa", map[string]Metric{"m.one": metric("ms", 10, 0)}, "m.one")
	b := result("bbb", map[string]Metric{"m.one": metric("ms", 20, 0)}, "m.one")
	pa, pb := filepath.Join(dir, "a.json"), filepath.Join(dir, "b.json")
	WriteJSON(pa, a)
	WriteJSON(pb, b)
	if code, out, _ := runCLI(t, "compare", pa, pb); code != cli.ExitFailure || !strings.Contains(out, "REGRESSION") {
		t.Errorf("compare: %d\n%s", code, out)
	}
	if code, _, _ := runCLI(t, "compare", pa, pb, "--no-fail"); code != 0 {
		t.Errorf("--no-fail: %d", code)
	}
	if code, _, _ := runCLI(t, "compare", pa, pb, "--threshold", "200"); code != 0 {
		t.Errorf("--threshold 200: %d", code)
	}
	if code, out, _ := runCLI(t, "show", pa, "--md"); code != 0 || !strings.Contains(out, "| m.one | ms | 10.0 |") || !strings.Contains(out, "| --- | --- | ---: |") {
		t.Errorf("show --md: %d\n%s", code, out)
	}
	if code, out, _ := runCLI(t, "show", pa); code != 0 || !strings.Contains(out, "m.one   ms") {
		t.Errorf("show: %d\n%s", code, out)
	}
}

func TestAnalyzeProfile(t *testing.T) {
	// root -> run (scenarios.js, harness) ; root -> swap -> parse ; idle
	p := profilerFixture()
	s := analyzeProfile(p)
	if s.TotalMs != 3 || s.HarnessMs != 1 || s.IdleMs != 2 {
		t.Errorf("totals: %+v", s)
	}
	if len(s.Self) != 2 || s.Self[0].Name != "parse build.js:11" || s.Self[0].Ms != 2 || s.Self[0].Pct != 66.7 {
		t.Errorf("self: %+v", s.Self)
	}
	if len(s.Inclusive) != 2 || s.Inclusive[0].Name != "swap build.js:6" || s.Inclusive[0].Ms != 3 {
		t.Errorf("inclusive: %+v", s.Inclusive)
	}
}

// A real Chrome: skipped when none is installed.
func TestRunInChrome(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	if _, err := browsers.FindChrome("", os.Getenv); err != nil {
		t.Skip("no Chrome")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	build := filepath.Join(root, "dist", "ypy.min.js")
	if _, err := os.Stat(build); err != nil {
		t.Skip("no dist build")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var out, errb bytes.Buffer
	o := RunOptions{
		Root: root, Out: t.TempDir(), Quick: true, Rounds: 1, Filter: `^(request\.events|morph\.inner\.10|session\.500)$`,
		Out2: &out, Err: &errb, Env: os.Getenv,
	}
	res, err := Run(ctx, o)
	if err != nil {
		t.Fatalf("%v\n%s", err, errb.String())
	}
	if res.Failed {
		t.Fatalf("a scenario failed:\n%s", errb.String())
	}
	m := res.Result.Metrics
	for _, id := range []string{"request.events.empty.dispatched", "morph.inner.10.preserve_failures", "session.nodes_retained", "size.min_gzip"} {
		if _, ok := m.Get(id); !ok {
			t.Errorf("metric %s missing; got %v", id, m.Keys())
		}
	}
	if v, _ := m.Get("morph.inner.10.preserve_failures"); v.Median != 0 {
		t.Errorf("focus preservation failed: %+v", v)
	}
	if v, _ := m.Get("session.nodes_retained"); v.Median != 0 {
		t.Errorf("the session leaked nodes: %+v", v)
	}
	back, err := ReadResult(res.Path)
	if err != nil || back.SHA != res.Result.SHA {
		t.Errorf("written file: %v", err)
	}
	var raw map[string]json.RawMessage
	b, _ := os.ReadFile(res.Path)
	if json.Unmarshal(b, &raw) != nil || raw["metrics"] == nil {
		t.Error("the result is not valid JSON")
	}
}
