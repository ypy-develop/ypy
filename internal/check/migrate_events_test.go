// SPDX-License-Identifier: MIT

package check

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Defect: the migration only swapped the prefix of an event (bolt:afterSettle became
// ypy:afterSettle), a name YPY never emits. It writes the native name now.
func TestMigrateWritesTheNativeEventNames(t *testing.T) {
	cases := []struct{ legacy, native string }{
		{"afterSettle", "ypy:after:settle"},
		{"afterSwap", "ypy:after:swap"},
		{"beforeRequest", "ypy:before:request"},
		{"beforeSwap", "ypy:before:swap"},
		{"afterRequest", "ypy:finally:request"},
		{"configRequest", "ypy:config:request"},
		{"responseError", "ypy:response:error"},
		{"load", "ypy:after:process"},
		{"after-swap", "ypy:after:swap"},
		{"pushedIntoHistory", "ypy:after:history:push"},
		{"sseMessage", "ypy:sse:after:message"},
	}
	for _, c := range cases {
		t.Run(c.legacy, func(t *testing.T) {
			in := "document.addEventListener('bolt:" + c.legacy + "', f);\n"
			want := "document.addEventListener('" + c.native + "', f);\n"
			got := convertOne(t, "a.js", in)
			if got != want {
				t.Errorf("got %q, want %q", got, want)
			}
			if again := convertOne(t, "a.js", got); again != got {
				t.Errorf("not idempotent: %q", again)
			}
		})
	}
	// the same names in the places an event is written in markup
	html := `<div acme-get="/x" acme-trigger="bolt:load from:body" acme-on::afterSettle="a()" acme-on::after-swap="b()" acme-on:bolt:beforeRequest="c()" acme-on-bolt-after-request="d()"></div>`
	want := `<div ypy-get="/x" ypy-trigger="ypy:after:process from:body" ypy-on::after:settle="a()" ypy-on::after:swap="b()" ypy-on:ypy:before:request="c()" ypy-on::finally:request="d()"></div>`
	if got := convertOne(t, "a.html", html); got != want {
		t.Errorf("markup:\ngot  %s\nwant %s", got, want)
	}
	// a v4 name already has the native spelling: only the prefix changes
	if got := convertOne(t, "a.js", "x('bolt:before:request'); y('bolt:error');\n"); got != "x('ypy:before:request'); y('ypy:error');\n" {
		t.Errorf("native names: %q", got)
	}
}

// A tree migrated by the earlier version holds ypy:afterSwap: a second run repairs it.
func TestMigrateRepairsEventsWrittenByTheEarlierVersion(t *testing.T) {
	in := "document.addEventListener('ypy:afterSettle', f);\nel.addEventListener('ypy:load', g);\nel.addEventListener('ypy:after:swap', h);\n"
	want := "document.addEventListener('ypy:after:settle', f);\nel.addEventListener('ypy:after:process', g);\nel.addEventListener('ypy:after:swap', h);\n"
	if got := convertOne(t, "a.js", in); got != want {
		t.Errorf("got %q", got)
	}
}

// An event with no equivalent keeps its legacy spelling and is reported.
func TestMigrateReportsEventsWithoutAnEquivalent(t *testing.T) {
	dir := t.TempDir()
	in := "el.addEventListener('bolt:xhr:loadstart', f);\nel.addEventListener('bolt:validation:failed', g);\nel.addEventListener('bolt:afterSwap', h);\n"
	write(t, dir, "a.js", in)
	code, out, errs := runMigrateCLI(t, dir, "--write", "--prefix", acme, "--id", bolt, "--json")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	got := string(mustRead(t, dir, "a.js"))
	want := "el.addEventListener('bolt:xhr:loadstart', f);\nel.addEventListener('bolt:validation:failed', g);\nel.addEventListener('ypy:after:swap', h);\n"
	if got != want {
		t.Errorf("got %q", got)
	}
	var rep MigrateReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, l := range rep.Unconverted {
		if l.Kind == kEvent && l.Reason == reasonNoEvent {
			n++
		}
	}
	if n != 2 {
		t.Errorf("two events without an equivalent are reported, got %d: %+v", n, rep.Unconverted)
	}
}

// detail.elt does not exist in a YPY event: the migration says so, it does not rewrite it.
func TestMigrateWarnsAboutDetailElt(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.js", "document.addEventListener('bolt:afterSwap', (e) => { go(e.detail.elt); const { elt } = e.detail; });\n")
	_, out, _ := runMigrateCLI(t, dir, "--write", "--prefix", acme, "--id", bolt, "--json")
	var rep MigrateReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, l := range rep.Unconverted {
		if l.Reason == reasonDetail {
			n++
		}
	}
	if n != 2 {
		t.Errorf("detail.elt is reported twice, got %d: %+v", n, rep.Unconverted)
	}
	if got := string(mustRead(t, dir, "a.js")); !strings.Contains(got, "e.detail.elt") {
		t.Errorf("the code is not rewritten: %s", got)
	}
}

// Defect: a Go string that is no attribute ("acme-swap", a test database name) was rewritten, and
// a prefix was learned from such strings.
func TestMigrateLeavesPlainGoStringsAlone(t *testing.T) {
	goTest := "package p\n\nfunc TestSwap(t *testing.T) {\n\tdb := open(\"acme-swap\")\n\tp := open(\"acme-partial\")\n\t_, _ = db, p\n}\n"
	dir := t.TempDir()
	write(t, dir, "moving_internal_test.go", goTest)
	// no flag: the prefix is not learned from the literals, so the dry run lists nothing
	code, out, errs := runMigrateCLI(t, dir, ".")
	if code != 0 || errs != "" {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if strings.Contains(out, "acme") || !strings.Contains(out, "0 of 1 file(s) would change") {
		t.Errorf("the dry run must not list the file or learn a prefix:\n%s", out)
	}
	if code, _, _ := runMigrateCLI(t, dir, "--write", "."); code != 0 {
		t.Fatal("write failed")
	}
	if got := string(mustRead(t, dir, "moving_internal_test.go")); got != goTest {
		t.Errorf("changed:\n%s", got)
	}
	// with the prefix known (given or learned from the markup) the Go strings still stay,
	// except where an attribute, a selector or a call that takes a name is written
	mixed := "package p\n\nvar a = open(\"acme-swap\")\nvar b = h.Attr(\"acme-swap\", \"none\")\nvar c = `<div acme-get=\"/x\"></div>`\nvar d = el.QuerySelector(\"[acme-target]\")\n"
	want := "package p\n\nvar a = open(\"acme-swap\")\nvar b = h.Attr(\"ypy-swap\", \"none\")\nvar c = `<div ypy-get=\"/x\"></div>`\nvar d = el.QuerySelector(\"[ypy-target]\")\n"
	if got := convertOne(t, "a.go", mixed); got != want {
		t.Errorf("got\n%s\nwant\n%s", got, want)
	}
	// the name left behind is listed for a person to decide
	dir = t.TempDir()
	write(t, dir, "a.go", mixed)
	_, out, _ = runMigrateCLI(t, dir, "--prefix", acme, "--id", bolt, "--json")
	var rep MigrateReport
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, l := range rep.Unconverted {
		if l.Reason == reasonString && l.Line == 3 {
			found = true
		}
	}
	if !found {
		t.Errorf("the plain string is listed as left alone: %+v", rep.Unconverted)
	}
}

func TestPrefixIsNotLearnedFromGoLiterals(t *testing.T) {
	text := "package p\n\nvar _ = []string{\"acme-swap\", \"acme-partial\", \"acme-get\", \"acme-target\"}\n"
	attr, hdr := evidenceMap{}, evidenceMap{}
	learnPrefixes(text, attr, hdr, true)
	if got := attr.resolve(DefaultMinEvidence); len(got) != 0 {
		t.Errorf("server code learned %v from plain strings", got)
	}
	learnPrefixes(text, attr, hdr, false)
	if got := attr.resolve(DefaultMinEvidence); len(got) != 1 {
		t.Errorf("a script or template still learns from quoted names: %v", got)
	}
	strictOK := "package p\n\nvar _ = `<b acme-get=\"/x\" acme-target=\"#o\"></b>`\n"
	attr = evidenceMap{}
	learnPrefixes(strictOK, attr, hdr, true)
	if got := attr.resolve(DefaultMinEvidence); len(got) != 1 {
		t.Errorf("markup inside a Go string is evidence: %v", got)
	}
}

func mustRead(t testing.TB, dir, rel string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
