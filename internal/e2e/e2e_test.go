// SPDX-License-Identifier: MIT

package e2e

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	}
	if len(Scenarios) != 19 {
		t.Errorf("%d scenarios, expected 19", len(Scenarios))
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
