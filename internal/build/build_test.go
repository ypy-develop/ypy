// SPDX-License-Identifier: MIT

package build

import (
	"bytes"
	"context"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
	"github.com/ypy-develop/ypy/internal/cli"
)

func TestPrivateNames(t *testing.T) {
	cases := map[string]string{
		"this.__x = 1":                "this.#x = 1",
		"{ __proto__: null }":         "{ __proto__: null }",
		"a.__proto__ = b; this.__y()": "a.__proto__ = b; this.#y()",
		"static __count = 0":          "static #count = 0",
		"no private names here":       "no private names here",
		"__proto__ and __proto__.__z": "__proto__ and __proto__.#z",
		"const s = 'a__b'":            "const s = 'a#b'", // text replacement, like the previous sed
		"__a __b __proto__ __c":       "#a #b __proto__ #c",
		"x.__proto__.__proto__":       "x.__proto__.__proto__",
	}
	for in, want := range cases {
		if got := string(privateNames([]byte(in))); got != want {
			t.Errorf("privateNames(%q) = %q, want %q", in, got, want)
		}
	}
}

// fixtureRoot writes a small but complete source tree.
func fixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("src/ypy.js", "// SPDX-License-Identifier: MIT\nvar ypy = (() => {\n  class Y { __n = 1; get() { return this.__n } }\n  return { version: '1', config: {}, y: new Y(), proto: { __proto__: null } }\n})()\n")
	write("src/ypy.d.ts", "export {}\n")
	write("src/editors/jetbrains/ypy.web-types.json", "{}\n")
	write("src/skills/ypy-guide/SKILL.md", "# guide\n")
	for _, name := range maxExtensions {
		write("src/ext/"+name+".js", "(() => { ypy.ext = (ypy.ext || []).concat('"+name+"') })();\n")
	}
	write("src/ext/ypy-other.js", "(() => { ypy.other = true })();\n")
	return root
}

func TestGenerateAllParts(t *testing.T) {
	root := fixtureRoot(t)
	out, err := Generate(Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"ypy.js", "ypy.min.js", "ypy.min.js.map", "ypy.min.js.br", "ypy.esm.js", "ypy.esm.min.js", "ypy.esm.min.js.map",
		"ypy.max.js", "ypy.max.min.js", "ypy.d.ts",
		"ext/ypy-sse.js", "ext/ypy-sse.min.js", "ext/ypy-sse.min.js.map", "ext/ypy-sse.min.js.br", "ext/ypy-other.min.js",
		"editors/jetbrains/ypy.web-types.json", "skills/ypy-guide/SKILL.md",
	} {
		if _, ok := out[name]; !ok {
			t.Errorf("missing output %s", name)
		}
	}
	if _, ok := out["editors/jetbrains/ypy.web-types.json.br"]; ok {
		t.Error("only scripts get a brotli copy")
	}
	if got := string(out["ypy.js"]); !strings.Contains(got, "#n") || strings.Contains(got, "__n") || !strings.Contains(got, "__proto__: null") {
		t.Errorf("private names not converted:\n%s", got)
	}
	if esm := string(out["ypy.esm.js"]); !strings.HasSuffix(esm, "\nif (typeof window !== \"undefined\") window.ypy = ypy;\nexport default ypy;\n") {
		t.Errorf("esm epilogue missing:\n%s", esm)
	}
	max := string(out["ypy.max.js"])
	if strings.Index(max, "'ypy-sse'") > strings.Index(max, "'ypy-ws'") || !strings.Contains(max, "ypy.version += \"-max\";") {
		t.Errorf("max bundle wrong:\n%s", max)
	}
	if !strings.HasSuffix(string(out["ypy.min.js"]), "//# sourceMappingURL=ypy.min.js.map\n") {
		t.Error("minified file must point at its source map")
	}
	if !bytes.Contains(out["ypy.min.js.map"], []byte(`"sources":["ypy.js"]`)) {
		t.Errorf("source map must name ypy.js: %s", out["ypy.min.js.map"])
	}
	// brotli copies decode back to the source
	r := brotli.NewReader(bytes.NewReader(out["ypy.min.js.br"]))
	dec, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(dec, out["ypy.min.js"]) {
		t.Errorf("brotli copy does not round trip: %v", err)
	}
}

func TestGenerateOnly(t *testing.T) {
	root := fixtureRoot(t)
	// the files each part may produce, by name prefix
	prefixes := map[Part][]string{
		PartCore: {"ypy.js", "ypy.min.js", "ypy.esm", "ypy.d.ts", "editors/", "skills/"},
		PartExt:  {"ext/"},
		PartMax:  {"ypy.max"},
	}
	must := map[Part]string{PartCore: "ypy.esm.js", PartExt: "ext/ypy-sse.js", PartMax: "ypy.max.min.js"}
	for part, allowed := range prefixes {
		out, err := Generate(Options{Root: root, Only: part})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := out[must[part]]; !ok {
			t.Errorf("--only %s: missing %s", part, must[part])
		}
		for n := range out {
			ok := false
			for _, p := range allowed {
				ok = ok || strings.HasPrefix(n, p)
			}
			if !ok {
				t.Errorf("--only %s produced %s", part, n)
			}
		}
	}
	if _, err := ParsePart("nope"); err == nil {
		t.Error("ParsePart must reject an unknown part")
	}
}

func TestGenerateErrors(t *testing.T) {
	root := fixtureRoot(t)
	if err := os.Remove(filepath.Join(root, "src/ext/ypy-sse.js")); err != nil {
		t.Fatal(err)
	}
	if _, err := Generate(Options{Root: root, Only: PartMax}); err == nil || !strings.Contains(err.Error(), "ypy-sse") {
		t.Errorf("want a missing extension error, got %v", err)
	}
	broken := fixtureRoot(t)
	if err := os.WriteFile(filepath.Join(broken, "src/ext/ypy-other.js"), []byte("let = ;"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Generate(Options{Root: broken, Only: PartExt}); err == nil || !strings.Contains(err.Error(), "ypy-other") {
		t.Errorf("want a syntax error naming the file, got %v", err)
	}
}

func TestWriteCompareDrift(t *testing.T) {
	root := fixtureRoot(t)
	out, err := Generate(Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(root, "dist")
	if d := Compare(dist, out, PartAll); len(d.Missing) != len(out) {
		t.Errorf("empty dist: every file is missing, got %d of %d", len(d.Missing), len(out))
	}
	if err := Write(dist, out, PartAll); err != nil {
		t.Fatal(err)
	}
	if d := Compare(dist, out, PartAll); !d.Empty() {
		t.Fatalf("fresh dist differs:\n%s", d)
	}
	// edit, delete, and add stale files
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dist, "ypy.js"), []byte("edited"), 0o644))
	must(os.Remove(filepath.Join(dist, "ypy.max.js")))
	must(os.WriteFile(filepath.Join(dist, "ext", "old-name.js"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(dist, "old-bundle.js"), []byte("x"), 0o644))
	must(os.WriteFile(filepath.Join(dist, "keep.txt"), []byte("not ours"), 0o644))
	d := Compare(dist, out, PartAll)
	if strings.Join(d.Changed, ",") != "ypy.js" || strings.Join(d.Missing, ",") != "ypy.max.js" ||
		strings.Join(d.Stale, ",") != "ext/old-name.js" {
		// old-bundle.js has no ypy prefix: not owned, not stale
		t.Errorf("unexpected drift: %+v", d)
	}
	if d := Compare(dist, out, PartCore); len(d.Stale) != 0 {
		t.Error("a partial build never reports stale files")
	}
	must(Write(dist, out, PartAll))
	if d := Compare(dist, out, PartAll); !d.Empty() {
		t.Errorf("a full build must clean the stale files:\n%s", d)
	}
	if _, err := os.Stat(filepath.Join(dist, "keep.txt")); err != nil {
		t.Error("files the build does not own must be kept")
	}
}

func TestSizes(t *testing.T) {
	small := bytes.Repeat([]byte("a"), 100)
	rows := Sizes(Output{"ypy.min.js": small, "ext/x.min.js": small, "ext/x.js": small, "ypy.max.min.js": small})
	if len(rows) != 2 || !rows[0].OK || rows[0].Budget != 18432 || rows[1].Budget != 6144 {
		t.Fatalf("rows: %+v", rows)
	}
	noisy := make([]byte, 20000)
	r := rand.New(rand.NewPCG(1, 2))
	for i := range noisy {
		noisy[i] = byte(r.IntN(256))
	}
	rows = Sizes(Output{"ypy.min.js": small, "ext/big.min.js": noisy})
	var b bytes.Buffer
	if WriteSizes(&b, rows) {
		t.Error("an extension over 6144 B gzip must fail the gate")
	}
	if !strings.Contains(b.String(), "OVER") || !strings.Contains(b.String(), "dist/ext/big.min.js") {
		t.Errorf("table:\n%s", b.String())
	}
}

func runCmd(t *testing.T, dir string, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(context.Background(), args, cli.IO{Out: &out, Err: &errb, Dir: dir})
	return code, out.String(), errb.String()
}

func TestCommand(t *testing.T) {
	root := fixtureRoot(t)
	if code, _, _ := runCmd(t, root, "--check"); code != cli.ExitFailure {
		t.Errorf("--check on a missing dist must exit 1, got %d", code)
	}
	if code, out, errs := runCmd(t, root, "--sizes"); code != cli.ExitOK || !strings.Contains(out, "size gate passed") {
		t.Errorf("build: code %d\n%s\n%s", code, out, errs)
	}
	if code, out, _ := runCmd(t, root, "--check"); code != cli.ExitOK || !strings.Contains(out, "up to date") {
		t.Errorf("--check after a build: code %d %s", code, out)
	}
	if err := os.WriteFile(filepath.Join(root, "src/ypy.js"), []byte("var ypy = {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, errs := runCmd(t, root, "--check"); code != cli.ExitFailure || !strings.Contains(errs, "changed: ypy.js") {
		t.Errorf("--check after a source change: code %d %s", code, errs)
	}
	other := filepath.Join(root, "other")
	if code, _, _ := runCmd(t, root, "--out", other, "--only", "ext"); code != cli.ExitOK {
		t.Errorf("--only ext --out: %d", code)
	}
	if _, err := os.Stat(filepath.Join(other, "ext", "ypy-sse.min.js")); err != nil {
		t.Error(err)
	}
	if _, err := os.Stat(filepath.Join(other, "ypy.js")); err == nil {
		t.Error("--only ext must not write the core")
	}
	for _, bad := range [][]string{{"--only", "x"}, {"--bogus"}, {"extra"}} {
		if code, _, _ := runCmd(t, root, bad...); code != cli.ExitUsage {
			t.Errorf("%v must exit 2, got %d", bad, code)
		}
	}
	if code, out, _ := runCmd(t, root, "--help"); code != cli.ExitOK || !strings.Contains(out, "Usage:") {
		t.Error("--help")
	}
	if code, _, errs := runCmd(t, t.TempDir()); code != cli.ExitUsage || !strings.Contains(errs, "core source") {
		t.Errorf("missing sources must exit 2: %d %s", code, errs)
	}
}

// The build turns the core's "__x" members into private fields, so an
// extension that reaches for one works from src/ and breaks in dist/. The
// extensions use the public API and the object they receive in init.
func TestExtensionsDoNotReachForPrivateMembers(t *testing.T) {
	root := filepath.Join("..", "..", "src", "ext")
	files, err := filepath.Glob(filepath.Join(root, "*.js"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no extension found under %s (%v)", root, err)
	}
	// member access on anything, an index with a "__" key, and a "__x" in obj check
	access := regexp.MustCompile(`[\w)\]]\??\.__[A-Za-z]|\[\s*['"` + "`" + `]__[A-Za-z]|['"` + "`" + `]__[A-Za-z]\w*['"` + "`" + `]\s+in\s`)
	// the one exception: ypy-lock freezes the approved list when the source build exposes it
	// and finds nothing to freeze in dist/, where the list is private (tested in
	// test/tests/security/config-lock.js)
	allowed := map[string]string{"ypy-lock.js": "'__approvedExt' in ypy"}
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(src), "\n") {
			if !access.MatchString(line) || strings.Contains(line, "__proto__") {
				continue
			}
			if want := allowed[filepath.Base(f)]; want != "" && strings.Contains(line, want) {
				continue
			}
			t.Errorf("%s:%d reaches for a private member of the core: %s", filepath.Base(f), i+1, strings.TrimSpace(line))
		}
	}
}
