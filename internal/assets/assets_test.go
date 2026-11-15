// SPDX-License-Identifier: MIT

package assets_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/assets"
	"github.com/ypy-develop/ypy/internal/cli"
)

// write puts files (slash path -> content) under dir.
func write(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// run executes "ypy gen assets" in dir and returns the exit code and both streams.
func run(t *testing.T, dir string, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	cmd := assets.Under(cli.Command{Name: "gen", Run: func(context.Context, []string, cli.IO) int { return 99 }})
	code := cmd.Run(context.Background(), append([]string{"assets"}, args...), cli.IO{Out: &out, Err: &errb, Dir: dir})
	return code, out.String(), errb.String()
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func manifest(t *testing.T, p string) map[string]assets.Entry {
	t.Helper()
	var m map[string]assets.Entry
	if err := json.Unmarshal([]byte(read(t, p)), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

var hashed = regexp.MustCompile(`^[a-z0-9-]+\.[0-9a-f]{10}\.(css|js)$`)

const card = `<div class="card">Card</div>
<style ypy-asset>
  .card { color: red; }
</style>
<script ypy-asset>
  const el = document.querySelector(".card");
  el.dataset.ready = "1";
</script>
`

func TestExtractsPerPackage(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{
		"src/ui/card.html":        card,
		"src/ui/list.gohtml":      "<ul></ul>\n<style ypy-asset>ul { margin: 0 }</style>\n",
		"src/ui/list.ypy.css":     "li { list-style: none }\n",
		"src/ui/modal.templ":      "package ui\n\ntempl Modal() {\n\t<dialog></dialog>\n\t<script ypy-asset>const m = 1;</script>\n}\n",
		"src/ui/panel.kyse.go":    "package ui\n\nconst panel = `<aside></aside>\n<style ypy-asset>aside{padding:1px}</style>`\n",
		"src/pages/home.html":     "<h1>Home</h1>\n<style ypy-asset>h1 { font-size: 2rem }</style>\n",
		"src/pages/plain.html":    "<p>no assets</p>\n",
		"src/node_modules/x.html": "<style ypy-asset>bad{}</style>",
	})
	code, out, errs := run(t, dir, "src", "--out", "dist")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	if !strings.Contains(out, "2 stylesheets, 1 scripts") {
		t.Fatalf("report: %s", out)
	}
	m := manifest(t, filepath.Join(dir, "dist/manifest.json"))
	if len(m) != 2 || m["ui"].CSS == "" || m["ui"].JS == "" || m["pages"].CSS == "" || m["pages"].JS != "" {
		t.Fatalf("manifest = %+v", m)
	}
	for _, name := range []string{m["ui"].CSS, m["ui"].JS, m["pages"].CSS} {
		if !hashed.MatchString(name) {
			t.Fatalf("%q is not name.<hash>.ext", name)
		}
	}
	css := read(t, filepath.Join(dir, "dist", m["ui"].CSS))
	want := "/* ui/card.html */\n.card { color: red; }\n\n/* ui/list.gohtml */\nul { margin: 0 }\n\n/* ui/list.ypy.css */\nli { list-style: none }\n\n/* ui/panel.kyse.go */\naside{padding:1px}\n"
	if css != want {
		t.Fatalf("css =\n%s\nwant\n%s", css, want)
	}
	js := read(t, filepath.Join(dir, "dist", m["ui"].JS))
	if !strings.Contains(js, "(() => {\nconst el = document.querySelector(\".card\");\nel.dataset.ready = \"1\";\n})();") ||
		!strings.Contains(js, "/* ui/modal.templ */\n(() => {\nconst m = 1;\n})();") {
		t.Fatalf("js =\n%s", js)
	}
	if strings.Contains(read(t, filepath.Join(dir, "dist/manifest.json")), "bad") {
		t.Fatal("node_modules was scanned")
	}
	if !strings.Contains(m["pages"].CSS, "pages.") {
		t.Fatalf("name = %q", m["pages"].CSS)
	}
}

func TestGroupByTemplate(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{
		"card.html":      card,
		"card.ypy.css":   ".card:hover{color:blue}\n",
		"lonely.ypy.js":  "console.log(1);\n",
		"sub/deep.templ": "<style ypy-asset>a{b:c}</style>",
	})
	if code, _, errs := run(t, dir, ".", "--out", "out", "--group", "template"); code != 0 {
		t.Fatalf("exit %d: %s", code, errs)
	}
	m := manifest(t, filepath.Join(dir, "out/manifest.json"))
	if len(m) != 3 || m["card.html"].CSS == "" || m["card.html"].JS == "" || m["lonely.ypy.js"].JS == "" || m["sub/deep.templ"].CSS == "" {
		t.Fatalf("manifest = %+v", m)
	}
	css := read(t, filepath.Join(dir, "out", m["card.html"].CSS))
	if !strings.Contains(css, ".card { color: red; }") || !strings.Contains(css, ".card:hover{color:blue}") {
		t.Fatalf("the companion did not join its template:\n%s", css)
	}
	if !strings.HasPrefix(m["sub/deep.templ"].CSS, "sub-deep.") {
		t.Fatalf("name = %q", m["sub/deep.templ"].CSS)
	}
}

func TestDeterministicAndCheck(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{"a/x.html": card, "b/y.html": "<style ypy-asset>p{q:r}</style>"})
	if code, _, errs := run(t, dir, ".", "--out", "o1"); code != 0 {
		t.Fatal(errs)
	}
	if code, _, errs := run(t, dir, ".", "--out", "o2"); code != 0 {
		t.Fatal(errs)
	}
	// Both outputs hold only css, js and a manifest, none of them a template, so the second run sees the same input.
	if a, b := read(t, filepath.Join(dir, "o1/manifest.json")), read(t, filepath.Join(dir, "o2/manifest.json")); a != b {
		t.Fatalf("manifests differ:\n%s\n%s", a, b)
	}
	if code, out, errs := run(t, dir, ".", "--out", "o1", "--check"); code != 0 {
		t.Fatalf("check on fresh output: exit %d %s %s", code, out, errs)
	}

	// Change a source: the output is out of date.
	write(t, dir, map[string]string{"b/y.html": "<style ypy-asset>p{q:CHANGED}</style>"})
	code, _, errs := run(t, dir, ".", "--out", "o1", "--check")
	if code != cli.ExitFailure || !strings.Contains(errs, "out of date") {
		t.Fatalf("check on stale output: exit %d %s", code, errs)
	}
	oldCSS := manifest(t, filepath.Join(dir, "o1/manifest.json"))["b"].CSS
	if code, _, errs := run(t, dir, ".", "--out", "o1"); code != 0 {
		t.Fatal(errs)
	}
	newCSS := manifest(t, filepath.Join(dir, "o1/manifest.json"))["b"].CSS
	if oldCSS == newCSS {
		t.Fatal("the hash did not change with the content")
	}
	if _, err := os.Stat(filepath.Join(dir, "o1", oldCSS)); !os.IsNotExist(err) {
		t.Fatalf("the file of the old hash was not removed: %v", err)
	}
	if code, _, errs := run(t, dir, ".", "--out", "o1", "--check"); code != 0 {
		t.Fatalf("check after the rewrite: %s", errs)
	}

	// A file the manifest names that nothing produces any more is stale for --check.
	ghost := filepath.Join(dir, "o1/ghost.0123456789.css")
	write(t, dir, map[string]string{"o1/ghost.0123456789.css": "x"})
	m := manifest(t, filepath.Join(dir, "o1/manifest.json"))
	m["gone"] = assets.Entry{CSS: "ghost.0123456789.css"}
	raw, _ := json.Marshal(m)
	write(t, dir, map[string]string{"o1/manifest.json": string(raw)})
	code, _, errs = run(t, dir, ".", "--out", "o1", "--check")
	if code != cli.ExitFailure {
		t.Fatalf("check with a stale file: exit %d", code)
	}
	if _, err := os.Stat(ghost); err != nil {
		t.Fatal("--check removed a file")
	}
	if code, _, errs := run(t, dir, ".", "--out", "o1"); code != 0 {
		t.Fatal(errs)
	}
	if _, err := os.Stat(ghost); !os.IsNotExist(err) {
		t.Fatal("the stale file was not removed")
	}
}

func TestSameInputSameBytes(t *testing.T) {
	files := map[string]string{"a/x.html": card, "a/x.ypy.css": "b{c:d}", "z/y.templ": "<script ypy-asset>1+1</script>"}
	var first map[string]string
	for i := 0; i < 3; i++ {
		dir := t.TempDir()
		write(t, dir, files)
		if code, _, errs := run(t, dir, ".", "--out", "out"); code != 0 {
			t.Fatal(errs)
		}
		got := map[string]string{}
		entries, _ := os.ReadDir(filepath.Join(dir, "out"))
		for _, e := range entries {
			got[e.Name()] = read(t, filepath.Join(dir, "out", e.Name()))
		}
		if first == nil {
			first = got
		} else if len(got) != len(first) {
			t.Fatalf("file sets differ: %v vs %v", got, first)
		} else {
			for k, v := range first {
				if got[k] != v {
					t.Fatalf("%s differs between runs", k)
				}
			}
		}
	}
}

func TestStripOut(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{
		"t/card.html":  "<div></div>\r\n  <style ypy-asset>\r\n a{b:c}\r\n  </style>\r\n<p>x</p>\r\n",
		"t/plain.html": "<p>y</p>\n",
		"t/k.kyse.go":  "package t\nvar s = `<i></i><script ypy-asset>1</script><b></b>`\n",
	})
	if code, _, errs := run(t, dir, "t", "--out", "out", "--strip-out", "clean"); code != 0 {
		t.Fatal(errs)
	}
	if got := read(t, filepath.Join(dir, "clean/card.html")); got != "<div></div>\n<p>x</p>\n" {
		t.Fatalf("card.html = %q", got)
	}
	if got := read(t, filepath.Join(dir, "clean/plain.html")); got != "<p>y</p>\n" {
		t.Fatalf("plain.html = %q", got)
	}
	if got := read(t, filepath.Join(dir, "clean/k.kyse.go")); got != "package t\nvar s = `<i></i><b></b>`\n" {
		t.Fatalf("k.kyse.go = %q", got)
	}
	if code, _, errs := run(t, dir, "t", "--out", "out", "--strip-out", "clean", "--check"); code != 0 {
		t.Fatal(errs)
	}
	write(t, dir, map[string]string{"clean/card.html": "<div></div>"})
	if code, _, _ := run(t, dir, "t", "--out", "out", "--strip-out", "clean", "--check"); code != cli.ExitFailure {
		t.Fatal("check did not see a changed copy")
	}
}

func TestStripOutInsideDirIsNotScanned(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{"a.html": "<style ypy-asset>a{b:c}</style><p></p>"})
	for i := 0; i < 2; i++ {
		if code, _, errs := run(t, dir, ".", "--out", "dist", "--strip-out", "clean"); code != 0 {
			t.Fatal(errs)
		}
	}
	m := manifest(t, filepath.Join(dir, "dist/manifest.json"))
	if len(m) != 1 || m["."].CSS == "" {
		t.Fatalf("manifest = %+v", m)
	}
	if !strings.HasPrefix(m["."].CSS, "root.") {
		t.Fatalf("the root package is named %q", m["."].CSS)
	}
}

func TestManifestElsewhere(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, map[string]string{"src/a.html": "<style ypy-asset>a{b:c}</style>"})
	if code, _, errs := run(t, dir, "src", "--out", "web/dist", "--manifest", "web/manifest.json"); code != 0 {
		t.Fatal(errs)
	}
	m := manifest(t, filepath.Join(dir, "web/manifest.json"))
	if !strings.HasPrefix(m["."].CSS, "dist/root.") {
		t.Fatalf("the path is relative to the manifest: %q", m["."].CSS)
	}
	if code, _, _ := run(t, dir, "src", "--out", "web/dist", "--manifest", "web/dist/sub/manifest.json"); code != cli.ExitFailure {
		t.Fatal("a manifest below --out must be refused")
	}
}

func TestBadBlocks(t *testing.T) {
	cases := map[string]string{
		"media":    "<style ypy-asset media=print>a{}</style>",
		"module":   "<script ypy-asset type=module>1</script>",
		"src":      `<script ypy-asset src="x.js"></script>`,
		"action":   "<style ypy-asset>a{color:{{ .C }}}</style>",
		"unclosed": "<style ypy-asset>a{}",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			write(t, dir, map[string]string{"x.html": "<p></p>\n" + body})
			code, _, errs := run(t, dir, ".", "--out", "out")
			if code != cli.ExitFailure || !strings.Contains(errs, "x.html: line 2") {
				t.Fatalf("exit %d: %s", code, errs)
			}
			if _, err := os.Stat(filepath.Join(dir, "out")); err == nil {
				t.Fatal("something was written after an error")
			}
		})
	}
	// A template action is fine in a templ file, and an unmarked element is left alone.
	dir := t.TempDir()
	write(t, dir, map[string]string{"x.templ": "<style ypy-asset>a{b:{{c}}}</style>", "y.html": "<style>a{}</style><script>1</script>"})
	if code, _, errs := run(t, dir, ".", "--out", "out"); code != 0 {
		t.Fatal(errs)
	}
	m := manifest(t, filepath.Join(dir, "out/manifest.json"))
	if len(m) != 1 {
		t.Fatalf("manifest = %+v", m)
	}
}

func TestScanTolerance(t *testing.T) {
	src := `<STYLE YPY-ASSET>a{}</STYLE><style data-x=">" ypy-asset="">b{}</style><script type="text/javascript" ypy-asset>c()</script><style class="ypy-asset">d{}</style>`
	blocks, err := assets.Scan(src, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 3 || blocks[0].Content != "a{}" || blocks[1].Content != "b{}" || blocks[2].Kind != assets.JS {
		t.Fatalf("blocks = %+v", blocks)
	}
	if got := assets.Strip(src, blocks); got != `<style class="ypy-asset">d{}</style>` {
		t.Fatalf("strip = %q", got)
	}
}

func TestUsage(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{{}, {"."}, {"--out", "o"}, {"a", "b", "--out", "o"}, {"missing", "--out", "o"}, {".", "--out", "o", "--group", "x"}, {"--bogus"}} {
		if code, _, _ := run(t, dir, args...); code != cli.ExitUsage {
			t.Errorf("%v: exit %d, want usage", args, code)
		}
	}
	if code, out, _ := run(t, dir, "--help"); code != 0 || !strings.Contains(out, "--strip-out") {
		t.Fatalf("help: %d %q", code, out)
	}
	// Anything but "assets" still reaches the command it is under.
	var errb bytes.Buffer
	cmd := assets.Under(cli.Command{Name: "gen", Run: func(context.Context, []string, cli.IO) int { return 99 }})
	if code := cmd.Run(context.Background(), []string{"--check"}, cli.IO{Err: &errb}); code != 99 {
		t.Fatalf("gen without assets: %d", code)
	}
}
