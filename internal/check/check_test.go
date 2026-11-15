// SPDX-License-Identifier: MIT

package check

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/cli"
)

// The tests use "bolt" as the identifier of the legacy markup: the rules never
// name it, so a made-up one proves that detection goes by shape.
const bolt = "bolt"

// acme is the invented attribute prefix (and, in capitals, header prefix) of the legacy markup.
const acme = "acme"

var pfx = []string{acme}

var testLines = []string{"v1", "v2", "v4"}

// Rules about spelling only, or generic: not asserted in the per-line fixtures.
var spelling = map[string]bool{"ANY-ATTR-PREFIX": true, "ANY-API-GLOBAL": true, "ANY-CLASS-PREFIX": true, "ANY-META-CONFIG": true, "ANY-SCRIPT-LIBRARY": true}

func mustRules(t testing.TB) *RuleSet {
	t.Helper()
	rs, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	return rs
}

func write(t testing.TB, dir, rel, body string) string {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func ruleIDs(fs []Finding) []string {
	var ids []string
	for _, f := range fs {
		ids = append(ids, f.Rule)
	}
	return ids
}

func hasRule(fs []Finding, id string) bool {
	for _, f := range fs {
		if f.Rule == id {
			return true
		}
	}
	return false
}

func scanOne(t testing.TB, file, line string, ids ...string) *Report {
	t.Helper()
	r, err := Scan([]string{file}, Options{Rules: mustRules(t), Line: line, IDs: ids, Cwd: filepath.Dir(file)})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// ---------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------

func TestRulesWellFormed(t *testing.T) {
	rs := mustRules(t)
	idRe := regexp.MustCompile(`^(?:V1|V2|V4|ANY)-[A-Z0-9]+(?:-[A-Z0-9]+)*$`)
	seen := map[string]bool{}
	for _, r := range rs.Rules {
		if !idRe.MatchString(r.ID) {
			t.Errorf("bad id %s", r.ID)
		}
		if seen[r.ID] {
			t.Errorf("duplicate id %s", r.ID)
		}
		seen[r.ID] = true
		if severityRank(r.Severity) < 0 {
			t.Errorf("%s: severity %q", r.ID, r.Severity)
		}
		if len(r.Lines) == 0 {
			t.Errorf("%s: no lines", r.ID)
		}
		for _, l := range r.Lines {
			if !contains(Lines, l) {
				t.Errorf("%s: line %q", r.ID, l)
			}
		}
		if len(r.What) <= 10 {
			t.Errorf("%s: what is too short", r.ID)
		}
		if r.Severity != "aviso" && r.Fix == "" {
			t.Errorf("%s: a quebra or muda rule needs a fix", r.ID)
		}
		switch strings.SplitN(r.ID, "-", 2)[0] {
		case "V1":
			if len(r.Lines) != 1 || r.Lines[0] != "v1" {
				t.Errorf("%s: V1 rules apply to the v1 markup only", r.ID)
			}
		case "V4":
			if len(r.Lines) != 1 || r.Lines[0] != "v4" {
				t.Errorf("%s: V4 rules apply to the v4 markup only", r.ID)
			}
		}
		// the rules carry no identifier of the legacy markup: events are written
		// without a prefix and texts use the {P} placeholder
		if r.Kind == "event" && strings.HasPrefix(r.Match.Name, "{") {
			t.Errorf("%s: event name must not carry a prefix", r.ID)
		}
	}
	if len(rs.Rules) < 100 {
		t.Errorf("only %d rules", len(rs.Rules))
	}
}

// ---------------------------------------------------------------------------
// One positive and one negative case per rule
// ---------------------------------------------------------------------------

type caseData struct {
	Ext      string `json:"ext"`
	Positive string `json:"positive"`
	Negative string `json:"negative"`
}

func loadCases(t testing.TB) map[string]caseData {
	t.Helper()
	b, err := os.ReadFile("testdata/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]caseData{}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCasesCoverEveryRule(t *testing.T) {
	rs := mustRules(t)
	cases := loadCases(t)
	var want, got []string
	for _, r := range rs.Rules {
		want = append(want, r.ID)
	}
	for id, c := range cases {
		got = append(got, id)
		if c.Ext == "" || c.Positive == "" || c.Negative == "" {
			t.Errorf("%s: needs ext, positive and negative", id)
		}
	}
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(want, ",") != strings.Join(got, ",") {
		t.Errorf("cases.json and the rule table differ:\nrules: %v\ncases: %v", want, got)
	}
}

func TestEveryRuleFiresOnItsPositiveAndNotOnItsNegative(t *testing.T) {
	rs := mustRules(t)
	cases := loadCases(t)
	dir := t.TempDir()
	for id, c := range cases {
		write(t, dir, "pos/"+id+c.Ext, c.Positive+"\n")
		write(t, dir, "neg/"+id+c.Ext, c.Negative+"\n")
	}
	for _, line := range testLines {
		report, err := Scan([]string{dir}, Options{Rules: rs, Line: line, IDs: []string{bolt}, Cwd: dir})
		if err != nil {
			t.Fatal(err)
		}
		hit := map[string]bool{}
		for _, f := range report.Findings {
			parts := strings.SplitN(f.File, "/", 2)
			name := strings.TrimSuffix(parts[1], filepath.Ext(parts[1]))
			hit[parts[0]+"/"+name+":"+f.Rule] = true
		}
		for _, r := range rs.Rules {
			applies := contains(r.Lines, line)
			if got := hit["pos/"+r.ID+":"+r.ID]; got != applies {
				t.Errorf("%s on %s: positive case fired=%v, want %v", r.ID, line, got, applies)
			}
			if hit["neg/"+r.ID+":"+r.ID] {
				t.Errorf("%s on %s: negative case must not fire", r.ID, line)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Fixtures by template type and by markup generation
// ---------------------------------------------------------------------------

var expectRe = regexp.MustCompile(`expect:([^\n]*)`)
var ruleIDRe = regexp.MustCompile(`^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$`)

func expectations(t testing.TB, file string) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for i, line := range strings.Split(string(b), "\n") {
		m := expectRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		for _, id := range strings.FieldsFunc(m[1], func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
			if ruleIDRe.MatchString(id) {
				want[strconv.Itoa(i+1)+":"+id] = true
			}
		}
	}
	return want
}

func listFixtures(t testing.TB, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join("testdata", dir))
	if err != nil {
		t.Fatal(err)
	}
	var files []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			files = append(files, filepath.Join("testdata", dir, e.Name()))
		}
	}
	return files
}

func TestFixturesReportExactlyTheMarkedLines(t *testing.T) {
	fixtureLine := map[string]string{"templates": "v2", "v1": "v1", "v4": "v4", "server": "v2"}
	for dir, line := range fixtureLine {
		for _, file := range listFixtures(t, dir) {
			t.Run(file, func(t *testing.T) {
				// no --id: the identifier is learned from the file itself
				report := scanOne(t, file, line)
				got := map[string]bool{}
				for _, f := range report.Findings {
					if !spelling[f.Rule] {
						got[strconv.Itoa(f.Line)+":"+f.Rule] = true
					}
				}
				want := expectations(t, file)
				var missing, extra []string
				for k := range want {
					if !got[k] {
						missing = append(missing, k)
					}
				}
				for k := range got {
					if !want[k] {
						extra = append(extra, k)
					}
				}
				sort.Strings(missing)
				sort.Strings(extra)
				if len(missing)+len(extra) > 0 {
					t.Errorf("missing %v, extra %v", missing, extra)
				}
			})
		}
	}
}

func TestSameLegacyPageInEveryTemplateLanguage(t *testing.T) {
	ids := func(file string) map[string]bool {
		out := map[string]bool{}
		for _, f := range scanOne(t, file, "v2").Findings {
			if !spelling[f.Rule] {
				out[f.Rule] = true
			}
		}
		return out
	}
	base := ids("testdata/templates/page.html")
	if len(base) < 10 {
		t.Fatalf("the base page reports only %d rules", len(base))
	}
	files := listFixtures(t, "templates")
	if len(files) < 8 {
		t.Fatalf("want html, gohtml, templ, jinja, erb, blade, twig, php; got %v", files)
	}
	for _, file := range files {
		got := ids(file)
		for id := range base {
			if !got[id] {
				t.Errorf("%s must report %s", filepath.Base(file), id)
			}
		}
	}
}

func TestNativeMarkupIsClean(t *testing.T) {
	for _, line := range testLines {
		if r := scanOne(t, "testdata/native/clean.html", line); len(r.Findings) != 0 {
			t.Errorf("line %s: %+v", line, r.Findings)
		}
	}
	if code, _, _ := runCLI(t, ".", "testdata/native/clean.html"); code != 0 {
		t.Errorf("exit %d", code)
	}
}

// ---------------------------------------------------------------------------
// Scanner behavior
// ---------------------------------------------------------------------------

func TestMaskingKeepsOffsetsAndLines(t *testing.T) {
	source := "<a\n  href=\"{{ .URL }}\"\n  acme-vars=\"a:{% if x %}1{% endif %}\"\n  acme-get=\"<%= path %>\">x</a>\n<?php echo 1; ?>\n@if($x)\n<p acme-vars=\"b\">"
	masked := maskTemplates(source, ".php")
	if len(masked) != len(source) || strings.Count(masked, "\n") != strings.Count(source, "\n") {
		t.Fatal("masking must keep the length and the newlines")
	}
	loc := newLocator(masked)
	type pair struct {
		name string
		line int
	}
	var got []pair
	var visit func(n *node)
	visit = func(n *node) {
		for _, c := range n.children {
			for _, a := range c.attrs {
				l, _ := loc.at(a.offset)
				got = append(got, pair{a.name, l})
			}
			visit(c)
		}
	}
	visit(parseMarkup(masked))
	want := []pair{{"href", 2}, {"acme-vars", 3}, {"acme-get", 4}, {"acme-vars", 7}}
	if len(got) != len(want) {
		t.Fatalf("attrs %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("attr %d: %v, want %v", i, got[i], want[i])
		}
	}
}

func TestTokenizerEdgeCases(t *testing.T) {
	text := strings.Join([]string{
		`<div title="a > b" acme-vars="x"></div>`,
		`<!-- <div acme-params="*"></div> -->`,
		`<script>var s = "<div acme-prompt='x'>"</script>`,
		`<textarea acme-request="{}"></textarea>`,
	}, "\n")
	found := map[string]bool{}
	for _, f := range ScanText(text, "a.html", Options{AttrPrefixes: pfx}) {
		found[strconv.Itoa(f.Line)+":"+f.Rule] = true
	}
	if !found["1:V2-ATTR-VARS"] {
		t.Error("a > inside a quoted value must not end the tag")
	}
	for k := range found {
		if strings.HasPrefix(k, "2:") {
			t.Errorf("comments are not markup: %s", k)
		}
	}
	if !found["3:V2-ATTR-PROMPT"] {
		t.Error("markup written inside an inline script is still markup")
	}
	if !found["4:V2-ATTR-REQUEST"] {
		t.Error("textarea attributes")
	}
}

func TestTemplAttributeExpressions(t *testing.T) {
	text := "templ T() {\n\t<button acme-get={ fmt.Sprintf(\"/a/%d\", id) } acme-vars={ `{\"a\":\"}\"}` } class=\"b\">x</button>\n}\n"
	n := 0
	for _, f := range ScanText(text, "a.templ", Options{AttrPrefixes: pfx}) {
		if f.Rule == "V2-ATTR-VARS" {
			n++
			if f.Line != 2 {
				t.Errorf("line %d", f.Line)
			}
		}
	}
	if n != 1 {
		t.Errorf("want one finding, got %d", n)
	}
}

func TestColumnsCountUTF16Units(t *testing.T) {
	// "é" is one UTF-16 unit, the emoji two
	text := "<p title=\"é😀\" acme-vars=\"a\"></p>"
	for _, f := range ScanText(text, "a.html", Options{AttrPrefixes: pfx}) {
		if f.Rule == "V2-ATTR-VARS" && f.Column != 16 {
			t.Errorf("column %d, want 16", f.Column)
		}
	}
}

func rulesOf(file, text string, ids ...string) []string {
	return ruleIDs(ScanText(text, file, Options{AttrPrefixes: pfx, IDs: ids}))
}

func TestEventSpellings(t *testing.T) {
	run := func(text, file string) []string { return rulesOf(file, text, bolt) }
	in := func(list []string, id string) bool { return contains(list, id) }
	cases := []struct {
		text, file, rule string
		want             bool
		why              string
	}{
		{`addEventListener('bolt:after-swap', f)`, "a.js", "V2-EVENT-AFTER-SWAP", true, "kebab twin"},
		{`<div acme-on::after-swap="f()"></div>`, "a.html", "V2-EVENT-AFTER-SWAP", true, "shorthand"},
		{`<div acme-on::afterSwap="f()"></div>`, "a.html", "V2-EVENT-AFTER-SWAP", true, "shorthand camel"},
		{`<div acme-on-bolt-after-swap="f()"></div>`, "a.html", "V2-EVENT-AFTER-SWAP", true, "dash form"},
		{`<div acme-get="/x" acme-trigger="bolt:afterSwap from:body"></div>`, "a.html", "V2-EVENT-AFTER-SWAP", true, "acme-trigger value"},
		{`<div acme-on::after:swap="f()"></div>`, "a.html", "V2-EVENT-AFTER-SWAP", false, "the native colon spelling is not legacy"},
		{`addEventListener('bolt:loadstart', f)`, "a.js", "V2-EVENT-LOAD", false, "a name that merely starts like another"},
		{`addEventListener('ypy:afterSwap', f)`, "a.js", "V2-EVENT-AFTER-SWAP", false, "the ypy prefix is never legacy"},
		{`x := "bolt:afterSwap"`, "a.go", "V2-EVENT-AFTER-SWAP", false, "server files only get the header rules"},
	}
	for _, c := range cases {
		if got := in(run(c.text, c.file), c.rule); got != c.want {
			t.Errorf("%s: %q reports %s = %v, want %v", c.why, c.text, c.rule, got, c.want)
		}
	}
}

func TestConfigKeysInMetaAndGlobal(t *testing.T) {
	meta := "<meta name=\"bolt-config\"\n  content='{\n  \"historyCacheSize\": 10,\n  \"defaultSwapStyle\": \"x\"\n}'>"
	byRule := map[string]int{}
	for _, f := range ScanText(meta, "a.html", Options{AttrPrefixes: pfx}) { // learned from the meta tag itself
		byRule[f.Rule] = f.Line
	}
	if byRule["V2-CONFIG-HISTORY-CACHE-SIZE"] != 3 || byRule["V2-CONFIG-DEFAULT-SWAP-STYLE"] != 4 {
		t.Errorf("lines: %v", byRule)
	}
	other := `<meta name="viewport" content='{"historyCacheSize": 1}'>`
	if hasRule(ScanText(other, "a.html", Options{AttrPrefixes: pfx, IDs: []string{bolt}}), "V2-CONFIG-HISTORY-CACHE-SIZE") {
		t.Error("only the configuration meta tag of the library is read")
	}
	if !hasRule(ScanText("ypy.config.defaultSwapStyle = 'x'", "a.js", Options{AttrPrefixes: pfx}), "V2-CONFIG-DEFAULT-SWAP-STYLE") {
		t.Error("the removed key is wrong on the ypy global too")
	}
}

func TestInheritance(t *testing.T) {
	hit := func(html string) bool {
		return hasRule(ScanText(html, "a.html", Options{AttrPrefixes: pfx}), "V2-INHERIT-IMPLICIT")
	}
	cases := []struct {
		html string
		want bool
		why  string
	}{
		{`<div acme-target="#o"><button acme-get="/x">x</button></div>`, true, "descendant relies on it"},
		{`<div acme-target="#o"><button acme-get="/x" acme-target="#p">x</button></div>`, false, "descendant has its own target"},
		{`<div acme-target:inherited="#o"><button acme-get="/x">x</button></div>`, false, "explicit inheritance"},
		{`<div acme-target="#o"><span>no request here</span></div>`, false, "no request below"},
		{`<div acme-boost="true"><a href="/x">x</a></div>`, true, "boosted link"},
		{`<div acme-boost="false"><a href="/x">x</a></div>`, false, "boost off"},
		{`<div acme-boost="true"><span>x</span></div>`, false, "nothing boostable"},
		{`<div acme-swap="outerHTML"><div><div acme-post="/x"></div></div></div>`, true, "deeper descendants count"},
		{`<body acme-headers='{"X-CSRF-Token": "t"}'><main>{% block %}{% endblock %}</main></body>`, true, "base template with a CSRF header"},
		{`<div acme-target="#o" acme-get="/x"></div>`, false, "the element itself is not a container"},
	}
	for _, c := range cases {
		if hit(c.html) != c.want {
			t.Errorf("%s: %s", c.why, c.html)
		}
	}
}

func TestDeleteInForm(t *testing.T) {
	hit := func(html string) bool {
		return hasRule(ScanText(html, "a.html", Options{AttrPrefixes: pfx}), "V2-DELETE-IN-FORM")
	}
	for html, want := range map[string]bool{
		`<form><div><button acme-delete="/x">x</button></div></form>`:          true,
		`<form acme-include="this"><button acme-delete="/x">x</button></form>`: false,
		`<div><button acme-delete="/x">x</button></div>`:                       false,
		`<form acme-delete="/x"></form>`:                                       false,
	} {
		if hit(html) != want {
			t.Errorf("%s: want %v", html, want)
		}
	}
}

func TestHeaders(t *testing.T) {
	ids := func(text, file string) []string { return rulesOf(file, text) }
	for _, c := range []struct {
		text, file, rule string
		want             bool
	}{
		{`v := req.header("acme-trigger")`, "a.js", "V2-HEADER-REQ-TRIGGER", true},
		{`res.header("ACME-Trigger", "x")`, "a.js", "V2-HEADER-REQ-TRIGGER", false},
		{`$_SERVER['HTTP_ACME_TARGET']`, "a.php", "V2-HEADER-REQ-TARGET", true},
		{`request.headers['ACME-Target']`, "a.rb", "V2-HEADER-REQ-TARGET", true},
		{`<div acme-target="#x"></div>`, "a.html", "V2-HEADER-REQ-TARGET", false},
		{`ctx.Response().Header.Set("ACME-Trigger-After-Swap", "x")`, "a.go", "V2-HEADER-TRIGGER-AFTER-SWAP", true},
	} {
		if got := contains(ids(c.text, c.file), c.rule); got != c.want {
			t.Errorf("%s in %s: %s = %v, want %v", c.text, c.file, c.rule, got, c.want)
		}
	}
	if got := rulesOf("a.go", `x := "bolt:afterSwap"`, bolt); len(got) != 0 {
		t.Errorf("server files only get the header rules: %v", got)
	}
}

func TestGenericFindingDroppedWhenSpecificCoversIt(t *testing.T) {
	got := rulesOf("a.js", "bolt.addClass(el, 'a'); bolt.ajax('GET', '/x')", bolt)
	sort.Strings(got)
	if strings.Join(got, ",") != "ANY-API-GLOBAL,V2-API-ADD-CLASS" {
		t.Errorf("got %v", got)
	}
}

func TestAggregatedRulesReportOnce(t *testing.T) {
	found := ScanText("<a acme-get=\"/a\"></a>\n<a acme-get=\"/b\" acme-target=\"#c\"></a>", "a.html", Options{AttrPrefixes: pfx})
	var prefix []Finding
	for _, f := range found {
		if f.Rule == "ANY-ATTR-PREFIX" {
			prefix = append(prefix, f)
		}
	}
	if len(prefix) != 1 || prefix[0].Count != 3 || prefix[0].Line != 1 {
		t.Errorf("%+v", prefix)
	}
}

// ---------------------------------------------------------------------------
// Learning the identifier: shape, not name
// ---------------------------------------------------------------------------

func TestLearnsTheIdentifierFromStrongEvidence(t *testing.T) {
	cases := map[string]string{
		"an event only the legacy API spells": "el.addEventListener('zed:afterSwap', f)\nzed.find('#x')",
		"an old config key":                   "zed.config.historyCacheSize = 3\nzed.find('#x')",
		"an old-only method":                  "zed.defineExtension('x', {})\nzed.find('#x')",
		"two state classes":                   ".zed-request .zed-indicator { opacity: 1 }\n.zed-request { x: y }",
	}
	for name, text := range cases {
		file := "a.js"
		if strings.Contains(name, "classes") {
			file = "a.css"
		}
		fs := ScanText(text, file, Options{AttrPrefixes: pfx})
		if len(fs) == 0 {
			t.Errorf("%s: nothing found", name)
			continue
		}
		for _, f := range fs {
			if f.Confidence != ConfHigh {
				t.Errorf("%s: %s has confidence %s", name, f.Rule, f.Confidence)
			}
		}
		if strings.Contains(text, "zed.find") && !hasRule(fs, "ANY-API-GLOBAL") {
			t.Errorf("%s: the learned global is not reported", name)
		}
	}
}

func TestTwoWeakSignsMakeMediumConfidence(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "index.html", `<script src="/static/zed.min.js"></script>`+"\n")
	write(t, dir, "app.css", ".zed-indicator { opacity: 0 }\n")
	r, err := Scan([]string{dir}, Options{Rules: mustRules(t), Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Findings) != 2 {
		t.Fatalf("%+v", r.Findings)
	}
	for _, f := range r.Findings {
		if f.Confidence != ConfMedium {
			t.Errorf("%s: %s", f.Rule, f.Confidence)
		}
	}
	high, _ := Scan([]string{dir}, Options{Rules: mustRules(t), Cwd: dir, MinConfidence: ConfHigh})
	if len(high.Findings) != 0 {
		t.Error("--min-confidence high hides medium findings")
	}
	named, _ := Scan([]string{dir}, Options{Rules: mustRules(t), Cwd: dir, IDs: []string{"zed"}, MinConfidence: ConfHigh})
	if len(named.Findings) != 2 {
		t.Error("--id makes the evidence strong")
	}
}

// Code that merely looks like the legacy markup's must stay quiet.
func TestNoFalsePositivesOnCommonCode(t *testing.T) {
	files := map[string]string{
		"values.js": "const v = Object.values(x); el.remove(); node.closest('a'); socket.on('chat:load', f); $.ajax({}); jQuery.find('x'); axios.off(1)\n",
		"page.html": `<div class="loading-indicator sim-swapping hot-request"></div>` + "\n" + `<script src="/js/jquery.min.js"></script><script src="https://cdn.example/lodash@4.17.21/lodash.min.js"></script>` + "\n<a href=\"http://localhost:8080/x\">x</a>\n",
		"style.css": "a:hover { color: red } input:error { x: y } .item-added { x: y } .loading-request { x: y }\n.sim-swapping { x: y }\n",
		"server.py": "cfg = {'retry:timeout': 3, 'a:load': 1}\n",
		"page.js":   "const url = 'https://example.com/lib.org/x.js'; log('step:error'); foo.config.timeout = 3\n",
	}
	dir := t.TempDir()
	for name, body := range files {
		write(t, dir, name, body)
	}
	r, err := Scan([]string{dir}, Options{Rules: mustRules(t), Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Findings) != 0 {
		t.Errorf("false positives: %+v", r.Findings)
	}
	if len(r.Identifiers()) != 0 {
		t.Errorf("no identifier must be learned, got %v", r.Identifiers())
	}
}

func TestAmbiguousEventsAreMediumInEventCodeOfAProjectWithAttributePrefix(t *testing.T) {
	html := `<button acme-get="/x">x</button>` + "\n<script>\ndocument.body.addEventListener('zed:error', f)\nvar s = 'zed:error'\n</script>\n"
	fs := ScanText(html, "a.html", Options{AttrPrefixes: pfx})
	var ev []Finding
	for _, f := range fs {
		if f.Rule == "ANY-EVENT-PREFIX" {
			ev = append(ev, f)
		}
	}
	if len(ev) != 1 || ev[0].Line != 3 || ev[0].Confidence != ConfMedium {
		t.Errorf("only the listener line, with medium confidence: %+v", ev)
	}
	if hasRule(ScanText("document.body.addEventListener('zed:error', f)", "a.js", Options{}), "ANY-EVENT-PREFIX") {
		t.Error("without acme-* in the project an ambiguous event stays quiet")
	}
}

func TestYPYIsNeverTheLegacyIdentifier(t *testing.T) {
	text := "ypy.config.logAll = true\nel.addEventListener('ypy:afterSwap', f)\n.ypy-request .ypy-indicator { x: y }\n"
	for _, f := range ScanText(text, "a.js", Options{AttrPrefixes: pfx, IDs: []string{"ypy"}}) {
		if f.Rule == "ANY-EVENT-PREFIX" || f.Rule == "V2-EVENT-AFTER-SWAP" || f.Rule == "ANY-CLASS-PREFIX" || f.Rule == "ANY-API-GLOBAL" {
			t.Errorf("%s on the ypy identifier", f.Rule)
		}
	}
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

func runCLI(t testing.TB, dir string, args ...string) (int, string, string) {
	t.Helper()
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out, errb bytes.Buffer
	env := func(string) string { return "" }
	code := run(context.Background(), args, cli.IO{Out: &out, Err: &errb, Dir: abs, Env: env})
	return code, out.String(), errb.String()
}

func TestCLITextOutput(t *testing.T) {
	code, out, errs := runCLI(t, ".", "testdata/templates/page.html", "--no-color")
	if errs != "" {
		t.Errorf("stderr: %s", errs)
	}
	if code != 1 {
		t.Errorf("exit %d", code)
	}
	if !regexp.MustCompile(`(?m)^testdata/templates/page\.html:\d+:\d+  (?:quebra|muda  |aviso) `).MatchString(out) {
		t.Errorf("no file:line:column lines:\n%s", out)
	}
	if !regexp.MustCompile(`\n1 file\(s\) scanned, 1 with findings: \d+ quebra, \d+ muda, \d+ aviso\.\n`).MatchString(out) {
		t.Errorf("no summary:\n%s", out)
	}
}

func TestCLIExitCodes(t *testing.T) {
	exit := func(args ...string) int { c, _, _ := runCLI(t, ".", args...); return c }
	page := "testdata/templates/page.html"
	for _, c := range []struct {
		args []string
		want int
		why  string
	}{
		{[]string{"testdata/v1/legacy.html", "--line", "v1"}, 1, "a quebra fails"},
		{[]string{"testdata/native/clean.html"}, 0, "clean"},
		{[]string{page, "--ignore", "V2-EXT-SSE-SWAP"}, 0, "muda and aviso do not fail by default"},
		{[]string{page, "--ignore", "V2-EXT-SSE-SWAP", "--fail-on", "muda"}, 1, "fail on muda"},
		{[]string{page, "--fail-on", "never"}, 0, "never"},
		{[]string{"--bogus"}, 2, "unknown option"},
		{[]string{"--line", "v9"}, 2, "bad line"},
		{[]string{"--min-severity", "loud"}, 2, "bad severity"},
		{[]string{"--min-confidence", "none"}, 2, "bad confidence"},
		{[]string{"--ignore", "NOT-A-RULE", "testdata/native"}, 2, "unknown rule"},
		{[]string{"does/not/exist"}, 2, "missing path"},
		{[]string{"--line"}, 2, "flag without a value"},
		{[]string{"--check"}, 2, "--check needs --gen-guide"},
		{[]string{"--gen-guide"}, 2, "--gen-guide needs --guide FILE"},
	} {
		if got := exit(c.args...); got != c.want {
			t.Errorf("%s: %v exits %d, want %d", c.why, c.args, got, c.want)
		}
	}
}

func TestCLIJSONSchemaAndGolden(t *testing.T) {
	code, out, _ := runCLI(t, "testdata", "templates/page.html", "--json", "--line", "v2")
	if code != 1 {
		t.Fatalf("exit %d", code)
	}
	keys := func(raw json.RawMessage) []string {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.Token()
		var ks []string
		for dec.More() {
			tok, _ := dec.Token()
			ks = append(ks, tok.(string))
			var skip json.RawMessage
			dec.Decode(&skip)
		}
		return ks
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &top); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(keys(json.RawMessage(out)), ","); got != "schema,tool,rulesVersion,line,scanned,summary,findings,warnings,legacy" {
		t.Errorf("top keys %s", got)
	}
	var rep struct {
		Schema   int               `json:"schema"`
		Tool     string            `json:"tool"`
		Line     json.RawMessage   `json:"line"`
		Summary  json.RawMessage   `json:"summary"`
		Findings []json.RawMessage `json:"findings"`
	}
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Schema != 1 || rep.Tool != "ypy-check" {
		t.Errorf("schema %d tool %s", rep.Schema, rep.Tool)
	}
	if got := strings.Join(keys(rep.Line), ","); got != "requested,used,assumed,evidence" {
		t.Errorf("line keys %s", got)
	}
	if got := strings.Join(keys(rep.Summary), ","); got != "quebra,muda,aviso,total,files" {
		t.Errorf("summary keys %s", got)
	}
	if got := strings.Join(keys(rep.Findings[0]), ","); got != "file,line,column,severity,rule,message,match,fix,native,guide,count,confidence" {
		t.Errorf("finding keys %s", got)
	}
	golden := "testdata/expected/page.json"
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(golden, []byte(out), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if out != string(want) {
		t.Errorf("output differs from %s; run UPDATE_GOLDEN=1 go test ./internal/check after a deliberate change", golden)
	}
}

func TestCLIFindingsAreOrdered(t *testing.T) {
	_, out, _ := runCLI(t, ".", "testdata/templates", "--json")
	var rep Report
	if err := json.Unmarshal([]byte(out), &rep); err != nil {
		t.Fatal(err)
	}
	if !sort.SliceIsSorted(rep.Findings, func(i, j int) bool {
		a, b := rep.Findings[i], rep.Findings[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Column < b.Column
	}) {
		t.Error("findings must be ordered by file, line and column")
	}
}

func TestCLILineDetection(t *testing.T) {
	detect := func(file string) LineInfo {
		_, out, _ := runCLI(t, ".", file, "--json")
		var rep Report
		if err := json.Unmarshal([]byte(out), &rep); err != nil {
			t.Fatal(err)
		}
		return rep.Line
	}
	if l := detect("testdata/v1/legacy.html"); l.Used != "v1" || l.Assumed || len(l.Evidence) == 0 {
		t.Errorf("v1: %+v", l)
	}
	if l := detect("testdata/templates/page.html"); l.Used != "v2" {
		t.Errorf("v2: %+v", l)
	}
	if l := detect("testdata/v4/native-ish.html"); l.Used != "v4" {
		t.Errorf("v4: %+v", l)
	}
	if l := detect("testdata/native/clean.html"); l.Used != "v4" {
		t.Errorf("ypy- attributes are native: %+v", l)
	}
	dir := t.TempDir()
	write(t, dir, "a.html", `<button acme-get="/x">x</button>`)
	_, out, _ := runCLI(t, dir, "--json")
	var rep Report
	json.Unmarshal([]byte(out), &rep)
	if rep.Line.Used != "v2" || !rep.Line.Assumed {
		t.Errorf("no legacy-only signal: the v2 markup is assumed: %+v", rep.Line)
	}
}

func TestCLILineFiltersRules(t *testing.T) {
	rulesOf := func(file, line string) map[string]bool {
		_, out, _ := runCLI(t, ".", file, "--json", "--line", line)
		var rep Report
		json.Unmarshal([]byte(out), &rep)
		m := map[string]bool{}
		for _, f := range rep.Findings {
			m[f.Rule] = true
		}
		return m
	}
	page := "testdata/templates/page.html"
	if !rulesOf(page, "v2")["V2-ATTR-VARS"] || !rulesOf(page, "v1")["V2-ATTR-VARS"] || rulesOf(page, "v4")["V2-ATTR-VARS"] {
		t.Error("V2 rules apply to the v1 and v2 markups, not to v4")
	}
	if rulesOf("testdata/v1/legacy.html", "v2")["V1-ATTR-SSE"] {
		t.Error("V1 rules do not apply to a v2 project")
	}
}

func TestCLIFilters(t *testing.T) {
	findings := func(args ...string) []Finding {
		_, out, _ := runCLI(t, ".", append([]string{"testdata/templates/page.html", "--json"}, args...)...)
		var rep Report
		json.Unmarshal([]byte(out), &rep)
		return rep.Findings
	}
	if !func() bool {
		for _, f := range findings() {
			if f.Severity == "aviso" {
				return true
			}
		}
		return false
	}() {
		t.Fatal("expected aviso findings")
	}
	for _, f := range findings("--min-severity", "muda") {
		if f.Severity == "aviso" {
			t.Error("--min-severity muda hides aviso")
		}
	}
	for _, f := range findings("--min-severity", "quebra") {
		if f.Severity != "quebra" {
			t.Error("--min-severity quebra")
		}
	}
	for _, f := range findings("--ignore", "V2-ATTR-VARS,V2-ATTR-DISABLE") {
		if f.Rule == "V2-ATTR-VARS" || f.Rule == "V2-ATTR-DISABLE" {
			t.Error("--ignore")
		}
	}
	only := map[string]bool{}
	for _, f := range findings("--only", "V2-ATTR-VARS") {
		only[f.Rule] = true
	}
	if len(only) != 1 || !only["V2-ATTR-VARS"] {
		t.Errorf("--only: %v", only)
	}
	dir := t.TempDir()
	write(t, dir, "a.vm", `<button acme-vars="a:1">x</button>`)
	scanned := func(args ...string) Report {
		_, out, _ := runCLI(t, dir, append([]string{"--json"}, args...)...)
		var rep Report
		json.Unmarshal([]byte(out), &rep)
		return rep
	}
	if scanned().Scanned != 0 {
		t.Error("unknown extensions are not scanned")
	}
	if scanned("--ext", "vm").Scanned != 1 || scanned("--ext", ".vm").Scanned != 1 {
		t.Error("--ext adds an extension, with or without the dot")
	}
	hit := false
	for _, f := range scanned("--ext", ".vm", "--prefix", acme).Findings {
		hit = hit || f.Rule == "V2-ATTR-VARS"
	}
	if !hit {
		t.Error("--ext files are read as templates")
	}
}

func TestCLISkipsVendoredAndMinified(t *testing.T) {
	dir := t.TempDir()
	body := `<button acme-vars="a:1">x</button>`
	write(t, dir, "node_modules/x/a.html", body)
	write(t, dir, "vendor/y/a.html", body)
	write(t, dir, "src/a.html", body)
	write(t, dir, "src/lib.min.js", "bolt.addClass(a, b)")
	_, out, _ := runCLI(t, dir, "--json")
	var rep Report
	json.Unmarshal([]byte(out), &rep)
	if rep.Scanned != 1 {
		t.Errorf("scanned %d, want 1", rep.Scanned)
	}
}

func TestCLIIdentifierHint(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.html", `<button acme-get="/x" class="zed-indicator">x</button>`)
	_, out, _ := runCLI(t, dir, "--no-color")
	if !strings.Contains(out, "Name it with --id") {
		t.Errorf("missing hint:\n%s", out)
	}
	_, out, _ = runCLI(t, dir, "--no-color", "--id", "zed")
	if !strings.Contains(out, "ANY-CLASS-PREFIX") || !strings.Contains(out, "identifier(s) of the legacy markup: zed") {
		t.Errorf("--id not applied:\n%s", out)
	}
}

func TestCLIListRulesHelpVersion(t *testing.T) {
	rs := mustRules(t)
	_, out, _ := runCLI(t, ".", "--list-rules", "--json")
	var all struct {
		Rules []struct {
			ID    string   `json:"id"`
			Lines []string `json:"lines"`
			What  string   `json:"what"`
		} `json:"rules"`
	}
	if err := json.Unmarshal([]byte(out), &all); err != nil {
		t.Fatal(err)
	}
	if len(all.Rules) != len(rs.Rules) {
		t.Errorf("%d rules listed, %d in the table", len(all.Rules), len(rs.Rules))
	}
	for _, r := range all.Rules {
		if strings.Contains(r.What, "{P}") {
			t.Errorf("%s: placeholder leaked", r.ID)
		}
	}
	_, out, _ = runCLI(t, ".", "--list-rules", "--json", "--line", "v4")
	var v4 struct {
		Rules []struct{ Lines []string } `json:"rules"`
	}
	json.Unmarshal([]byte(out), &v4)
	if len(v4.Rules) == 0 || len(v4.Rules) >= len(all.Rules) {
		t.Errorf("v4 lists %d of %d", len(v4.Rules), len(all.Rules))
	}
	for _, r := range v4.Rules {
		if !contains(r.Lines, "v4") {
			t.Error("--line v4 lists only v4 rules")
		}
	}
	if _, text, _ := runCLI(t, ".", "--list-rules"); !strings.HasSuffix(text, "rule(s)\n") {
		t.Error("text listing ends with the count")
	}
	if _, h, _ := runCLI(t, ".", "--help"); !strings.Contains(h, "Usage:") {
		t.Error("--help")
	}
	if _, v, _ := runCLI(t, ".", "--version"); !regexp.MustCompile(`^ypy-check rules \d{4}\.\d+\.\d+`).MatchString(v) {
		t.Errorf("--version: %s", v)
	}
}

// The guide page lives on the website, not in this repository: the tables the
// command renders must still carry one anchor per rule, because every finding
// links to the page by rule id, and rendering twice must change nothing.
func TestGuideTablesCoverTheRules(t *testing.T) {
	rs := mustRules(t)
	page := "# guide\n" + guideBegin + "\nold\n" + guideEnd + "\ntail\n"
	once, err := UpdateGuide(page, rs)
	if err != nil {
		t.Fatal(err)
	}
	twice, err := UpdateGuide(once, rs)
	if err != nil {
		t.Fatal(err)
	}
	if once != twice {
		t.Error("rendering the guide tables twice changes the page")
	}
	for _, r := range rs.Rules {
		if !strings.Contains(once, `<a id="`+strings.ToLower(r.ID)+`"></a>`) {
			t.Errorf("guide tables have no anchor for %s", r.ID)
		}
	}
	if !strings.HasPrefix(rs.Meta.Guide, "https://ypy.dev/") {
		t.Errorf("the findings link to %q, want a page of the website", rs.Meta.Guide)
	}
}

func TestGenGuideCommand(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "g.md", "# guide\n"+guideBegin+"\nold\n"+guideEnd+"\ntail\n")
	if code, _, _ := runCLI(t, dir, "--gen-guide", "--check", "--guide", "g.md"); code != 1 {
		t.Errorf("an out of date guide must exit 1, got %d", code)
	}
	if code, out, _ := runCLI(t, dir, "--gen-guide", "--guide", "g.md"); code != 0 || !strings.Contains(out, "guide updated") {
		t.Errorf("rewrite: %d %s", code, out)
	}
	if code, out, _ := runCLI(t, dir, "--gen-guide", "--check", "--guide", "g.md"); code != 0 || !strings.Contains(out, "up to date") {
		t.Errorf("check after rewrite: %d %s", code, out)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "g.md"))
	if !strings.HasPrefix(string(b), "# guide\n") || !strings.HasSuffix(string(b), "\ntail\n") {
		t.Error("only the generated block changes")
	}
	write(t, dir, "bad.md", "no markers")
	if code, _, _ := runCLI(t, dir, "--gen-guide", "--guide", "bad.md"); code != 2 {
		t.Errorf("a guide without markers must exit 2, got %d", code)
	}
}

func TestRuleCountsReport(t *testing.T) {
	rs := mustRules(t)
	table := map[string]map[string]int{}
	for _, r := range rs.Rules {
		for _, l := range r.Lines {
			if table[l] == nil {
				table[l] = map[string]int{}
			}
			table[l][r.Severity]++
		}
	}
	t.Logf("rules per markup generation and severity: %v (%d rules)", table, len(rs.Rules))
}
