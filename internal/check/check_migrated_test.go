// SPDX-License-Identifier: MIT

package check

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// What `ypy check` must still see in a tree that `ypy migrate` already went over (the invented
// prefix is acme- and the invented identifier of the legacy markup is bolt).

func scanDirFindings(t testing.TB, dir string, o Options) []Finding {
	t.Helper()
	o.Rules = mustRules(t)
	o.Cwd = dir
	r, err := Scan([]string{dir}, o)
	if err != nil {
		t.Fatal(err)
	}
	return r.Findings
}

func ruleFiles(fs []Finding, rule string) []string {
	var out []string
	for _, f := range fs {
		if f.Rule == rule {
			out = append(out, f.File)
		}
	}
	sort.Strings(out)
	return out
}

func TestCheckReportsEventsYPYDoesNotEmit(t *testing.T) {
	cases := []struct {
		file, text string
		want       bool
	}{
		{"a.js", "document.addEventListener('ypy:afterSettle', f)", true},
		{"a.js", "document.addEventListener('ypy:load', f)", true},
		{"a.js", "el.addEventListener('ypy:after-swap', f)", true},
		{"a.html", `<div ypy-get="/x" ypy-trigger="ypy:afterSwap from:body"></div>`, true},
		{"a.html", `<div ypy-on::after-swap="f()"></div>`, true},
		{"a.html", `<div ypy-on::afterSettle="f()"></div>`, true},
		{"a.html", `<div data-ypy-on:ypy:beforeRequest="f()"></div>`, true},
		{"a.md", "Listen to `ypy:afterSettle`.", true},
		{"a.js", "document.addEventListener('ypy:after:settle', f)", false},
		{"a.js", "document.addEventListener('ypy:finally:request', f); x('ypy:request:queued'); y('ypy:ws:close')", false},
		{"a.html", `<div ypy-on::after:swap="f()" ypy-on::before:request:once="g()" ypy-on:click="h()"></div>`, false},
		{"a.html", `<div ypy-sse:connect="/s" ypy-trigger="ypy:before:request from:body"></div>`, false},
		{"a.md", "Every event is named ypy:before:* or ypy:after:*, and ypy:process:<type> is a family.", false},
	}
	for _, c := range cases {
		got := hasRule(ScanText(c.text, c.file, Options{AttrPrefixes: pfx, IDs: []string{bolt}}), "ANY-EVENT-NOT-EMITTED")
		if got != c.want {
			t.Errorf("%s %q: reported=%v, want %v", c.file, c.text, got, c.want)
		}
	}
	// the message names the native event
	fs := ScanText("el.addEventListener('ypy:afterSettle', f)", "a.js", Options{})
	if len(fs) != 1 || !strings.Contains(fs[0].Message, "use ypy:after:settle") || fs[0].Severity != "quebra" {
		t.Errorf("finding: %+v", fs)
	}
}

func TestCheckReportsLegacyIdentifiersInGo(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "p.go", "package p\n\ntype Props struct{ AcmeTarget, AcmeGet string; IsACME bool }\n")
	write(t, dir, "q.go", "package p\n\ntype Props struct{ YpyTarget string; IsYPY bool; Acmeish int }\n")
	write(t, dir, "a.html", `<b acme-get="/x" acme-target="#o"></b>`)
	fs := scanDirFindings(t, dir, Options{})
	if got := ruleFiles(fs, "ANY-IDENT-PREFIX"); strings.Join(got, ",") != "p.go" {
		t.Errorf("ANY-IDENT-PREFIX in %v", got)
	}
}

func TestCheckReportsTheStateClassInNestedCSSAndInGoStrings(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.scss", ".card {\n  .list {\n    & .bolt-indicator { display: none }\n    &:is(.bolt-request) { opacity: .5 }\n  }\n}\n")
	write(t, dir, "b.go", "package ui\n\nvar css = kyse.CSS(`\n.btn { .bolt-indicator { display: none } }\n`)\n")
	write(t, dir, "c.css", ".ypy-indicator { display: none }\n")
	fs := scanDirFindings(t, dir, Options{IDs: []string{bolt}})
	if got := ruleFiles(fs, "ANY-CLASS-PREFIX"); strings.Join(got, ",") != "a.scss,b.go" {
		t.Errorf("ANY-CLASS-PREFIX in %v", got)
	}
}

func TestCheckReportsAPlainIdInTheTargetHeader(t *testing.T) {
	cases := []struct {
		file, text string
		want       bool
	}{
		{"a.go", `r.Header.Set("YPY-Target", "content")`, true},
		{"a.go", `r.Header.Set("ACME-Target", "content")`, true},
		{"a.py", `client.get("/x", headers={"YPY-Target": "results"})`, true},
		{"a.js", `fetch('/x', {headers: {'YPY-Target': 'results'}})`, true},
		{"a.go", `r.Header.Set("YPY-Target", "main#content")`, false},
		{"a.go", `r.Header.Set("YPY-Target", "body")`, false},
		{"a.go", `r.Header.Set("YPY-Request", "true")`, false},
	}
	for _, c := range cases {
		got := hasRule(ScanText(c.text, c.file, Options{AttrPrefixes: pfx, IDs: []string{bolt}}), "ANY-HEADER-TARGET-PLAIN-ID")
		if got != c.want {
			t.Errorf("%q: reported=%v, want %v", c.text, got, c.want)
		}
	}
}

func TestCheckReadsMarkdownAndJSONByDefault(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "README.md", "Use it like this:\n\n```html\n<button acme-get=\"/x\" acme-target=\"#o\" class=\"bolt-indicator\">x</button>\n```\n")
	write(t, dir, "config.json", `{"snippet": "<div acme-get=\"/x\" acme-vars=\"a\"></div>", "on": "bolt:afterSwap"}`)
	write(t, dir, "package-lock.json", `{"x": "<div acme-get=\"/x\" acme-vars=\"a\"></div>"}`)
	fs := scanDirFindings(t, dir, Options{IDs: []string{bolt}})
	files := map[string]bool{}
	for _, f := range fs {
		files[f.File] = true
	}
	if !files["README.md"] || !files["config.json"] || files["package-lock.json"] {
		t.Errorf("files with findings: %v", files)
	}
	// and the migration converts what it can in them
	dir2 := t.TempDir()
	write(t, dir2, "README.md", "```html\n<button acme-get=\"/x\" acme-target=\"#o\">x</button>\n```\n")
	if code, _, errs := runMigrateCLI(t, dir2, "--write", "--id", bolt, "."); code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if got := string(mustRead(t, dir2, "README.md")); !strings.Contains(got, `ypy-get="/x" ypy-target="#o"`) {
		t.Errorf("README.md: %s", got)
	}
}

// A tree already migrated by the earlier version: the check finds what was left behind.
func TestCheckFindsWhatAnEarlierMigrationLeftBehind(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "page.html", `<div ypy-get="/x" ypy-trigger="ypy:afterSettle from:body" class="bolt-indicator"></div>`)
	write(t, dir, "ui.go", "package ui\n\ntype Props struct{ AcmeTarget string }\n")
	write(t, dir, "ui_test.go", "package ui\n\nfunc T() { r.Header.Set(\"YPY-Target\", \"content\") }\n")
	fs := scanDirFindings(t, dir, Options{IDs: []string{bolt}, AttrPrefixes: pfx})
	for _, rule := range []string{"ANY-EVENT-NOT-EMITTED", "ANY-CLASS-PREFIX", "ANY-IDENT-PREFIX", "ANY-HEADER-TARGET-PLAIN-ID"} {
		if !hasRule(fs, rule) {
			t.Errorf("%s not reported: %v", rule, ruleIDs(fs))
		}
	}
}

// ---------------------------------------------------------------------------
// The event table follows the source
// ---------------------------------------------------------------------------

func TestEmittedEventsMatchTheSource(t *testing.T) {
	root := filepath.Join("..", "..", "src")
	raw, err := os.ReadFile(filepath.Join(root, "attributes.json"))
	if err != nil {
		t.Skip("the source tree is not next to the package: " + err.Error())
	}
	var attrs struct {
		Events []struct {
			Name string `json:"name"`
		} `json:"events"`
	}
	if err := json.Unmarshal(raw, &attrs); err != nil {
		t.Fatal(err)
	}
	for _, e := range attrs.Events {
		name := e.Name
		if strings.HasSuffix(name, "*") {
			name = strings.TrimSuffix(name, "*") + "x"
		}
		if !isEmitted(name) {
			t.Errorf("%s is in src/attributes.json and not in events.json", e.Name)
		}
	}
	lit := regexp.MustCompile("[\"'`](ypy:[A-Za-z:]+)[\"'`]")
	files, _ := filepath.Glob(filepath.Join(root, "ext", "*.js"))
	files = append(files, filepath.Join(root, "ypy.js"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range lit.FindAllStringSubmatch(string(b), -1) {
			name := m[1]
			if strings.HasSuffix(name, ":") {
				name += "x" // a family: ypy:request:<name>
			}
			if !isEmitted(name) {
				t.Errorf("%s writes %s, which is not in events.json", filepath.Base(f), m[1])
			}
		}
	}
}

// Every event the migration writes is one YPY emits.
func TestEveryNativeEventOfTheRulesIsEmitted(t *testing.T) {
	rs := mustRules(t)
	n := 0
	for _, r := range rs.Rules {
		if r.Kind != "event" {
			continue
		}
		native := rs.nativeOfLegacy(r.Match.Name)
		if native == "" {
			continue
		}
		n++
		if !isEmitted(native) {
			t.Errorf("%s: %s is not an event YPY emits", r.ID, native)
		}
	}
	if n < 30 {
		t.Errorf("only %d legacy events have a native name", n)
	}
}
