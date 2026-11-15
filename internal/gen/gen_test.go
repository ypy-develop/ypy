// SPDX-License-Identifier: MIT

package gen

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/cli"
)

// repoRoot is the repository root: the tests read the real table, the real ypy.d.ts and the real sources.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "attributes.json")); err != nil {
		t.Skipf("not in a repository checkout: %v", err)
	}
	return root
}

func TestRepositoryTableIsConsistent(t *testing.T) {
	root := repoRoot(t)
	table, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Render(table)
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range out {
		have, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Errorf("%s is missing; run ypy gen", path)
			continue
		}
		if !bytes.Equal(have, want) {
			t.Errorf("%s is out of date; run ypy gen", path)
		}
	}
	problems, err := CheckDTS(table, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		t.Error(p)
	}
	scan, err := ScanSources(table, root)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range scan.Problems {
		t.Error(p)
	}
	for _, w := range scan.Warnings {
		t.Log("warning:", w)
	}
}

// The table takes its version from the file VERSION, which is the one the core reports.
func TestTableVersionIsTheCoreVersion(t *testing.T) {
	root := repoRoot(t)
	table, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(filepath.Join(root, "src", "ypy.js"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "this.version = '"+table.Version+"'") {
		t.Errorf("src/attributes.json says version %s, src/ypy.js does not set it", table.Version)
	}
}

func TestEditorDataLeavesOutLegacyNames(t *testing.T) {
	root := repoRoot(t)
	table, _ := Load(root)
	out, _ := Render(table)
	var vs vsData
	if err := json.Unmarshal(out[VSCodePath], &vs); err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, a := range vs.GlobalAttributes {
		have[a.Name] = true
	}
	for _, name := range []string{"ypy-get", "ypy-error-target", "ypy-sse-connect", "ypy-on::before:request", "ypy-on::sse:close", "ypy-live:text"} {
		if !have[name] {
			t.Errorf("the VS Code data lacks %s", name)
		}
	}
	for _, name := range []string{"ypy-vars", "ypy-params", "ypy-disabled-elt", "ypy-on::afterRequest", "ypy-computed:*", "ypy-on::scope"} {
		if have[name] {
			t.Errorf("the VS Code data offers %s", name)
		}
	}
}

func TestSchemaNestsDottedKeys(t *testing.T) {
	root := repoRoot(t)
	table, _ := Load(root)
	out, _ := Render(table)
	var s map[string]any
	if err := json.Unmarshal(out[SchemaPath], &s); err != nil {
		t.Fatal(err)
	}
	props := s["properties"].(map[string]any)
	classes := props["classes"].(map[string]any)
	if classes["additionalProperties"] != false {
		t.Errorf("classes should be closed: %v", classes["additionalProperties"])
	}
	req := classes["properties"].(map[string]any)["request"].(map[string]any)
	if req["default"] != "ypy-request" || req["type"] != "string" {
		t.Errorf("classes.request: %v", req)
	}
	if props["selfRequestsOnly"].(map[string]any)["deprecated"] != true {
		t.Error("a deprecated key must say so")
	}
}

// --- validation ---------------------------------------------------------------------------

func TestValidateReportsEveryProblem(t *testing.T) {
	tb := &Table{
		Version: "1",
		Attributes: []Attribute{
			{Named: Named{Name: "ypy-a"}, Description: "ok"},
			{Named: Named{Name: "ypy-a"}, Description: "twice"},
			{Named: Named{Name: "data-ypy-b"}, Description: "bad prefix"},
			{Named: Named{Name: "ypy-c"}, Description: ""},
			{Named: Named{Name: "ypy-d"}, Description: "x", ValueType: "weird", Profiles: []string{"v9"}},
			{Named: Named{Name: "ypy-e"}, Description: "x", Pattern: "^ypy-e"},
			{Named: Named{Name: "ypy-f"}, Description: "x", Doc: "docs/reference/f.md"},
		},
		Events: []Event{
			{Named: Named{Name: "ypy:x:y"}, Description: "x", Target: "element"},
			{Named: Named{Name: "load"}, Description: "x", Detail: map[string]string{}, Target: "element"},
			{Named: Named{Name: "ypy:ok"}, Description: "x", Detail: map[string]string{"a": ""}, Target: "nowhere"},
		},
		Headers: []Header{
			{Named: Named{Name: "YPY-A"}, Direction: "request", Description: "x"},
			{Named: Named{Name: "YPY-A"}, Direction: "request", Description: "x"},
			{Named: Named{Name: "YPY-A"}, Direction: "response", Description: "same name, other direction"},
			{Named: Named{Name: "YPY-B"}, Direction: "sideways", Description: "x"},
		},
		Config: []ConfigKey{
			{Named: Named{Name: "a.b"}, Description: "x", Schema: json.RawMessage(`{"type":"string"}`)},
			{Named: Named{Name: "n"}, Description: "x", Schema: json.RawMessage(`{"type":"integer"}`), Default: json.RawMessage(`"text"`)},
			{Named: Named{Name: "m"}, Description: "x"},
		},
		Elements: []Element{{Named: Named{Name: "ypy-el"}, Description: "x", Attributes: []string{"ypy-missing"}}},
		Internal: map[string]string{"ypy-a": ""},
	}
	got := strings.Join(tb.Validate(), "\n")
	for _, want := range []string{
		"attribute ypy-a is defined twice",
		`"data-ypy-b" (core): the name must start with ypy-`,
		"attribute ypy-c (core): no description",
		`unknown valueType "weird"`,
		`unknown profile "v9"`,
		"a pattern belongs to a family name",
		`attribute ypy-f (core): "doc" must be a page of https://ypy.dev/docs/`,
		`event ypy:x:y (core): "detail" is missing`,
		`event "load" (core): the name must look like`,
		`detail field "a" needs a TypeScript type`,
		`unknown target "nowhere"`,
		"header request YPY-A is defined twice",
		"direction must be request or response",
		"config key a.b (core): its parent a is not in the table",
		`the default "text" does not fit its schema`,
		`config key m (core): "schema" is missing`,
		"attribute ypy-missing is not in the table",
		"internal name ypy-a (core) is also a public name",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("no problem reported for %q in:\n%s", want, got)
		}
	}
	if strings.Count(got, "YPY-A is defined twice") != 1 {
		t.Error("a request and a response header of one name are two headers")
	}
}

func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	if _, ok := files["VERSION"]; !ok {
		files["VERSION"] = "1.0.0\n"
	}
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

const miniCore = `{
  "attributes": [{"name": "ypy-get", "description": "Gets.", "valueType": "url"}],
  "events": [{"name": "ypy:before:request", "description": "Before.", "detail": {"ctx": "YpyRequestCtx"}, "target": "element"}],
  "config": [{"name": "logAll", "description": "Logs.", "schema": {"type": "boolean"}, "default": false}]
}`

func TestLoadMergesFragmentsAndStampsTheOwner(t *testing.T) {
	root := writeTree(t, map[string]string{
		CoreTable: miniCore,
		FragmentsDir + "/ypy-demo.json": `{"extension": "ypy-demo",
		  "attributes": [{"name": "ypy-demo", "description": "Demo."}],
		  "config": [{"name": "demo", "description": "Demo.", "schema": {"type": "object"}}, {"name": "demo.on", "description": "On.", "schema": {"type": "boolean"}}]}`,
	})
	tb, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(tb.Attributes) != 2 || tb.Attributes[1].Extension != "ypy-demo" || tb.Attributes[0].Extension != "" {
		t.Errorf("attributes: %+v", tb.Attributes)
	}
	if got := strings.Join(tb.Extensions, ","); got != "ypy-demo" {
		t.Errorf("extensions: %s", got)
	}
}

func TestLoadRejectsABadFragment(t *testing.T) {
	cases := map[string]string{
		"wrong extension": `{"extension": "other", "attributes": []}`,
		"unknown field":   `{"extension": "ypy-demo", "attribute": []}`,
		"version":         `{"extension": "ypy-demo", "version": "2"}`,
		"duplicate":       `{"extension": "ypy-demo", "attributes": [{"name": "ypy-get", "description": "Again."}]}`,
	}
	for name, body := range cases {
		root := writeTree(t, map[string]string{CoreTable: miniCore, FragmentsDir + "/ypy-demo.json": body})
		if _, err := Load(root); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// --- ypy.d.ts -----------------------------------------------------------------------------

func TestParseDTS(t *testing.T) {
	d := ParseDTS(`
export namespace Ns {
  /** a comment with 'quotes' and { braces } */
  export interface Config { inner?: string; }
}
export interface YpyConfig {
  // a line comment, with an apostrophe: it's fine
  a: boolean;
  b?: 'x' | 'y';
  readonly c?: boolean;
  list: Array<string>;
  live?: Ns.Config;
  lock?(): void;
  fn: (a: number, b: string) => Promise<void>;
  [key: string]: unknown;
}
export interface YpyConfig { d: number }
export interface YpyNativeEventMap {
  'ypy:x:y': { ctx: YpyRequestCtx; reason: Exclude<Reason, 'queue' | 'other'> };
  'ypy:none': Record<string, never>;
}
`)
	if got := strings.Join(d.keys("YpyConfig", false), ","); got != "a,b,c,d,fn,list,live" {
		t.Errorf("YpyConfig keys: %s", got)
	}
	if got := strings.Join(d.keys("YpyConfig", true), ","); got != "a,b,c,d,fn,list,live,lock" {
		t.Errorf("with methods: %s", got)
	}
	if got := strings.Join(d.ConfigPaths(), ","); got != "a,b,c,d,fn,list,live,live.inner" {
		t.Errorf("config paths: %s", got)
	}
	ev := d.eventTypes()
	if keys, ok := detailKeys(ev["ypy:x:y"]); !ok || strings.Join(keys, ",") != "ctx,reason" {
		t.Errorf("detail keys: %v %v", keys, ok)
	}
	if keys, ok := detailKeys(ev["ypy:none"]); !ok || len(keys) != 0 {
		t.Errorf("empty detail: %v %v", keys, ok)
	}
}

func TestCheckDTSReportsDifferences(t *testing.T) {
	root := writeTree(t, map[string]string{
		DTSPath: `export interface YpyEventMap {
  'ypy:a': { x: string };
  'ypy:extra': {};
}
export interface YpyConfig { known: boolean; extra: boolean }`,
	})
	tb := &Table{
		Events: []Event{
			{Named: Named{Name: "ypy:a"}, Detail: map[string]string{"y": "string"}},
			{Named: Named{Name: "ypy:b"}, Detail: map[string]string{}},
			{Named: Named{Name: "ypy:hook"}, Detail: map[string]string{}, ExtensionOnly: true},
			{Named: Named{Name: "ypy:oldName"}, Detail: map[string]string{}, Legacy: true},
		},
		Config: []ConfigKey{{Named: Named{Name: "known"}}, {Named: Named{Name: "missing"}}},
	}
	got, err := CheckDTS(tb, root)
	if err != nil {
		t.Fatal(err)
	}
	all := strings.Join(got, "\n")
	for _, want := range []string{
		"event ypy:a: detail fields differ",
		"no YpyEventMap entry for ypy:b",
		"declares the event ypy:extra",
		"no type for the config key missing",
		"declares the config key extra",
	} {
		if !strings.Contains(all, want) {
			t.Errorf("missing %q in:\n%s", want, all)
		}
	}
	if strings.Contains(all, "ypy:hook") || strings.Contains(all, "ypy:oldName") {
		t.Errorf("a hook and a legacy name are not DOM events:\n%s", all)
	}
}

// --- sources ------------------------------------------------------------------------------

func TestScanSources(t *testing.T) {
	root := writeTree(t, map[string]string{
		CoreSource: `// ypy-in-a-comment is not code
/* ypy:also:ignored */
const a = 'ypy-get', b = "ypy-unknown", c = 'ypy:before:request', d = 'ypy-error-' + name, e = 'ypy:request:' + kind;
const f = "ypy-status:" + code, g = {h: 'YPY-Request'}, i = "data-ypy-get", j = '[ypy-hidden]';
for (let fn of ext.get('ypy_resolve_demo')) fn();`,
		ExtDir + "/ypy-demo.js":   `x('ypy-demo-attr')`,
		ExtDir + "/ypy-nofrag.js": `x('ypy-nofrag-a'); x('ypy-nofrag-b');`,
	})
	tb := &Table{
		Version: "1",
		Attributes: []Attribute{
			{Named: Named{Name: "ypy-get"}}, {Named: Named{Name: "ypy-error-target"}}, {Named: Named{Name: "ypy-status:*"}},
			{Named: Named{Name: "ypy-demo-attr", Extension: "ypy-demo"}},
			{Named: Named{Name: "ypy-never-mentioned"}},
		},
		Events: []Event{
			{Named: Named{Name: "ypy:before:request"}}, {Named: Named{Name: "ypy:request:queued"}},
			{Named: Named{Name: "ypy:resolve:demo"}, ExtensionOnly: true},
		},
		Headers:    []Header{{Named: Named{Name: "YPY-Request"}, Direction: "request"}},
		Internal:   map[string]string{"ypy-hidden": ""},
		Extensions: []string{"ypy-demo"},
	}
	scan, err := ScanSources(tb, root)
	if err != nil {
		t.Fatal(err)
	}
	if len(scan.Problems) != 1 || !strings.Contains(scan.Problems[0], CoreSource+":3: ypy-unknown") {
		t.Errorf("problems: %v", scan.Problems)
	}
	w := strings.Join(scan.Warnings, "\n")
	if !strings.Contains(w, "src/ext/ypy-nofrag.js has no fragment in src/attributes.d/ypy-nofrag.json: 2 name(s)") {
		t.Errorf("warnings: %v", scan.Warnings)
	}
	if !strings.Contains(w, "lists ypy-never-mentioned but no source mentions it") || strings.Contains(w, "ypy-get but") {
		t.Errorf("warnings: %v", scan.Warnings)
	}
	if strings.Contains(w, "ypy:resolve:demo") {
		t.Errorf("a hook written with underscores counts as mentioned: %v", scan.Warnings)
	}
}

// --- command ------------------------------------------------------------------------------

func runGen(t *testing.T, root string, args ...string) (int, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := Command().Run(context.Background(), append([]string{"--root", root}, args...), cli.IO{Out: &out, Err: &errb})
	return code, out.String() + errb.String()
}

func TestCommandWritesThenChecks(t *testing.T) {
	root := writeTree(t, map[string]string{
		CoreTable: miniCore,
		DTSPath: `export interface YpyEventMap { 'ypy:before:request': { ctx: YpyRequestCtx } }
export interface YpyConfig { logAll: boolean }`,
		CoreSource: `const a = 'ypy-get', b = 'ypy:before:request';`,
	})
	if code, out := runGen(t, root, "--check"); code != cli.ExitFailure || !strings.Contains(out, "is out of date") {
		t.Fatalf("check before gen: %d\n%s", code, out)
	}
	if code, out := runGen(t, root); code != cli.ExitOK || !strings.Contains(out, "wrote 3 files") {
		t.Fatalf("gen: %d\n%s", code, out)
	}
	for _, p := range []string{VSCodePath, WebTypesPath, SchemaPath} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(p))); err != nil {
			t.Errorf("%s was not written", p)
		}
	}
	if code, out := runGen(t, root, "--check"); code != cli.ExitOK {
		t.Fatalf("check after gen: %d\n%s", code, out)
	}
	// The table changes: the generated files are stale.
	os.WriteFile(filepath.Join(root, CoreTable), []byte(strings.Replace(miniCore, "Gets.", "Fetches.", 1)), 0o644)
	if code, out := runGen(t, root, "--check"); code != cli.ExitFailure || !strings.Contains(out, VSCodePath) {
		t.Fatalf("check after a change: %d\n%s", code, out)
	}
}

func TestCommandFlags(t *testing.T) {
	if code, out := runGen(t, ".", "--help"); code != cli.ExitOK || !strings.Contains(out, "ypy gen") {
		t.Errorf("--help: %d %s", code, out)
	}
	if code, _ := runGen(t, ".", "extra"); code != cli.ExitUsage {
		t.Errorf("an argument: %d", code)
	}
	if code, _ := runGen(t, t.TempDir()); code != cli.ExitFailure {
		t.Errorf("no table: %d", code)
	}
}
