// SPDX-License-Identifier: MIT

package e2e

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/browsers"
)

func TestReportMatrixAndFailures(t *testing.T) {
	outcomes := []Outcome{
		{App: "native", Browser: "chrome", Version: "1.0", Results: []Result{{Scenario: "lib/global", Pass: true}, {Scenario: "crud/list", Pass: false, Error: "expected 3", Console: []string{"error: boom"}}}},
		{App: "native", Browser: "chrome", Version: "1.0", Results: []Result{{Scenario: "lib/global", Pass: true}}},
	}
	var out bytes.Buffer
	md := filepath.Join(t.TempDir(), "matrix.md")
	failed := report(&out, md, outcomes)
	if failed != 1 {
		t.Errorf("failed = %d", failed)
	}
	s := out.String()
	for _, want := range []string{"Browser: chrome", "lib/global", "FAIL", "1/2", "1/1", "ypy.version", "[native] crud/list: expected 3", "console> error: boom", "failures: 1"} {
		if !strings.Contains(s, want) {
			t.Errorf("report lacks %q:\n%s", want, s)
		}
	}
	b, err := os.ReadFile(md)
	if err != nil || !strings.Contains(string(b), "| lib/global | ok | ok |") {
		t.Errorf("markdown: %v\n%s", err, b)
	}
}

func TestScenariosAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range Scenarios {
		if s.Name == "" || s.Run == nil || seen[s.Name] {
			t.Errorf("bad or duplicate scenario %q", s.Name)
		}
		seen[s.Name] = true
		for b, why := range s.Skip {
			if !contains(browsers.All, b) || why == "" {
				t.Errorf("scenario %q: Skip needs a browser name and a reason, got %q: %q", s.Name, b, why)
			}
		}
	}
	// the 19 scenarios of the first version; other files register more
	for _, name := range []string{"lib/global", "crud/list", "crud/create", "crud/edit-inline", "crud/edit-cancel",
		"crud/delete-confirm", "crud/delete-dismissed", "errors/5xx-not-swapped", "search/filter", "search/debounce",
		"search/indicator", "headers/request", "headers/response", "scroll/infinite", "form/invalid-422",
		"form/valid-redirect", "sse/stream", "ws/echo", "events/names"} {
		if !seen[name] {
			t.Errorf("scenario %q is missing", name)
		}
	}
}

func TestRegisterAppendsInOrder(t *testing.T) {
	saved := Scenarios
	defer func() { Scenarios = saved }()
	n := len(Scenarios)
	Register(Scenario{Name: "x/one", Run: func(*Env) {}}, Scenario{Name: "x/two", Run: func(*Env) {}})
	if len(Scenarios) != n+2 || Scenarios[n].Name != "x/one" || Scenarios[n+1].Name != "x/two" {
		t.Errorf("Register did not append in order: %v", Scenarios[n:])
	}
}

// stubBrowser is a browser the runner cannot open a page in.
type stubBrowser struct{ name string }

func (s stubBrowser) Name() string     { return s.name }
func (s stubBrowser) Label() string    { return s.name }
func (s stubBrowser) MaxParallel() int { return 1 }
func (s stubBrowser) Close() error     { return nil }
func (s stubBrowser) RunPage(context.Context, string, <-chan struct{}) browsers.PageReport {
	return browsers.PageReport{}
}

func TestSkippedScenarioDoesNotOpenAPage(t *testing.T) {
	ran := false
	sc := Scenario{Name: "x/skip", Run: func(*Env) { ran = true }, Skip: map[string]string{"safari": "needs DevTools"}}
	res, _ := runScenario(context.Background(), Options{}, stubBrowser{"safari"}, "http://x", "native", sc)
	if ran || !res.Skipped || !res.Pass || res.SkipReason != "needs DevTools" {
		t.Errorf("skipped scenario: %+v ran=%v", res, ran)
	}
	// in another browser it is not skipped: the runner then needs a page
	res, _ = runScenario(context.Background(), Options{}, stubBrowser{"firefox"}, "http://x", "native", sc)
	if res.Skipped || res.Pass || !strings.Contains(res.Error, "no end to end driver") {
		t.Errorf("not skipped in firefox: %+v", res)
	}
}

func TestReportShowsSkipsAndLeavesThemOutOfTheCount(t *testing.T) {
	outcomes := []Outcome{{App: "native", Browser: "safari", Version: "1", Results: []Result{
		{Scenario: "a", Pass: true},
		{Scenario: "b", Pass: true, Skipped: true, SkipReason: "needs DevTools"},
	}}}
	var out bytes.Buffer
	if failed := report(&out, "", outcomes); failed != 0 {
		t.Errorf("failed = %d", failed)
	}
	for _, want := range []string{"skip", "1/1", "[native] b: needs DevTools", "failures: 0"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("report lacks %q:\n%s", want, out.String())
		}
	}
}

func TestEqualComparesJSONForms(t *testing.T) {
	e := &Env{}
	e.Equal([]string{"a"}, []string{"a"}, "same")
	defer func() {
		r := recover()
		f, ok := r.(failure)
		if !ok || !strings.Contains(f.msg, `expected ["b"], got ["a"]`) {
			t.Errorf("recovered %v", r)
		}
	}()
	e.Equal([]string{"a"}, []string{"b"}, "differ")
}
