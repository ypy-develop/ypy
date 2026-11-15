// SPDX-License-Identifier: MIT

package styling

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const root = "../.."

func read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// stateVariants are the Tailwind variants of the plugin and the state each one reads.
var stateVariants = map[string]string{
	"ypy-request":  "request",
	"ypy-swapping": "swapping",
	"ypy-settling": "settling",
	"ypy-added":    "added",
	"ypy-error":    "error",
	"ypy-dirty":    "dirty",
	"ypy-offline":  "offline",
}

func TestTailwindPluginDeclaresEveryVariant(t *testing.T) {
	css := read(t, "src/css/ypy-tailwind.css")
	decl := regexp.MustCompile(`(?m)^@custom-variant\s+(\S+)\s+\((.*)\);$`)
	found := map[string]string{}
	for _, m := range decl.FindAllStringSubmatch(css, -1) {
		found[m[1]] = m[2]
	}
	want := []string{"ypy-request", "ypy-swapping", "ypy-settling", "ypy-added", "ypy-error", "ypy-dirty", "ypy-busy", "ypy-offline"}
	var got []string
	for name := range found {
		got = append(got, name)
	}
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("variants: got %v, want %v", got, want)
	}
	for name, state := range stateVariants {
		sel := found[name]
		if !strings.Contains(sel, "."+name+",") && !strings.Contains(sel, "."+name+" ") && !strings.Contains(sel, "."+name+")") {
			t.Errorf("%s does not match the class .%s: %s", name, name, sel)
		}
		if !strings.Contains(sel, `[data-ypy-state~="`+state+`"]`) {
			t.Errorf("%s does not match data-ypy-state~=%q: %s", name, state, sel)
		}
		if !strings.HasPrefix(sel, "&:") {
			t.Errorf("%s: the selector must start with &: %s", name, sel)
		}
	}
	if !strings.Contains(found["ypy-busy"], `[aria-busy="true"]`) {
		t.Errorf("ypy-busy must read aria-busy: %s", found["ypy-busy"])
	}
	// offline is the one state that lives on <html>: the variant must reach the descendants
	if !strings.Contains(found["ypy-offline"], ".ypy-offline *") || !strings.Contains(found["ypy-offline"], `[data-ypy-state~="offline"] *`) {
		t.Errorf("ypy-offline must match the descendants of <html>: %s", found["ypy-offline"])
	}
	if !strings.Contains(css, "SPDX-License-Identifier: MIT") {
		t.Error("the plugin has no SPDX header")
	}
	// only variants: no import, utility, theme or url in the file (the comment may show an @import)
	for _, bad := range []string{"\n@import", "url(", "@apply", "@theme", "@utility", "@layer"} {
		if strings.Contains(css, bad) {
			t.Errorf("the plugin must only declare variants, found %q", strings.TrimSpace(bad))
		}
	}
}

func TestTailwindFixtureHasEveryClassOfTheMatrix(t *testing.T) {
	js := read(t, "test/fixtures/css/tailwind/fixture.js")
	css := read(t, "test/fixtures/css/tailwind/tailwind.css")
	// every ypy variant used by the fixture must be in the generated sheet, escaped as Tailwind writes it
	tok := regexp.MustCompile(`(?:[a-z-]+:)*ypy-[a-z]+:[a-z0-9/.-]+`)
	seen := map[string]bool{}
	for _, c := range tok.FindAllString(js, -1) {
		if seen[c] {
			continue
		}
		seen[c] = true
		esc := strings.NewReplacer(":", `\:`, "/", `\/`, ".", `\.`).Replace(c)
		if !strings.Contains(css, "."+esc) {
			t.Errorf("tailwind.css has no rule for %q: build it again (test/fixtures/css/README.md)", c)
		}
	}
	if len(seen) < 10 {
		t.Errorf("only %d ypy variants in the fixture, the matrix uses more", len(seen))
	}
	// and the plugin's own variants are all exercised
	for name := range stateVariants {
		if !strings.Contains(js, name+":") {
			t.Errorf("the Tailwind fixture never uses %s:", name)
		}
	}
	if !strings.Contains(js, "ypy-busy:") {
		t.Error("the Tailwind fixture never uses ypy-busy:")
	}
}

// The classes of a sheet: what follows a dot in a selector, with comments, strings and urls removed.
func sheetClasses(css string) map[string]bool {
	css = regexp.MustCompile(`(?s)/\*.*?\*/`).ReplaceAllString(css, "")
	css = regexp.MustCompile(`"[^"]*"|'[^']*'`).ReplaceAllString(css, "") // before url(): a data URI holds parentheses
	css = regexp.MustCompile(`url\([^)]*\)`).ReplaceAllString(css, "")
	prelude := regexp.MustCompile(`([^{};]+)\{`)
	class := regexp.MustCompile(`\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)`)
	out := map[string]bool{}
	for _, m := range prelude.FindAllStringSubmatch(css, -1) {
		p := strings.TrimSpace(m[1])
		if strings.HasPrefix(p, "@") {
			continue
		}
		for _, c := range class.FindAllStringSubmatch(p, -1) {
			out[c[1]] = true
		}
	}
	return out
}

func TestSheetClassExtraction(t *testing.T) {
	got := sheetClasses(`/* .no */ .a.b > .c:hover, .d{color:red;background:url(x.png)} @media (min-width:1px){.e{margin:1.5em}} a[href$=".pdf"]{x:y}`)
	for _, c := range []string{"a", "b", "c", "d", "e"} {
		if !got[c] {
			t.Errorf("missing class %q in %v", c, got)
		}
	}
	for _, c := range []string{"no", "png", "pdf", "5em"} {
		if got[c] {
			t.Errorf("%q is not a class", c)
		}
	}
}

var (
	classListCall = regexp.MustCompile(`classList\.(?:add|remove|toggle|replace|contains)\(\s*(?:'([^']+)'|"([^"]+)")`)
	classesBlock  = regexp.MustCompile(`(?s)classes:\s*\{(.*?)\}`)
	classEntry    = regexp.MustCompile(`\w+:\s*["']([^"']*)["']`)
	classAssign   = regexp.MustCompile(`config\.classes\.\w+\s*\?\?=\s*['"]([^'"]+)['"]`)
	classFallback = regexp.MustCompile(`classes\??\.\w+\s*\|\|\s*['"]([^'"]+)['"]`)
)

// ypyClasses are the class names the core and the extensions write on elements, in the order of
// the files. A name chosen by the page (ypy-class, ypy-live, config.classes) is not here.
func ypyClasses(t *testing.T) map[string][]string {
	t.Helper()
	files := []string{"src/ypy.js"}
	ents, err := os.ReadDir(filepath.Join(root, "src/ext"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".js") {
			files = append(files, "src/ext/"+e.Name())
		}
	}
	out := map[string][]string{}
	add := func(file, list string) {
		for _, c := range strings.Fields(list) {
			out[c] = append(out[c], file)
		}
	}
	for _, f := range files {
		src := read(t, f)
		for _, m := range classListCall.FindAllStringSubmatch(src, -1) {
			add(f, m[1]+m[2])
		}
		for _, b := range classesBlock.FindAllStringSubmatch(src, -1) {
			for _, e := range classEntry.FindAllStringSubmatch(b[1], -1) {
				add(f, e[1])
			}
		}
		for _, m := range classAssign.FindAllStringSubmatch(src, -1) {
			add(f, m[1])
		}
		for _, m := range classFallback.FindAllStringSubmatch(src, -1) {
			add(f, m[1])
		}
	}
	return out
}

// wellKnown are the names MISSION section 7 lists, and a few more that styles use for state.
var wellKnown = []string{"active", "show", "hide", "hidden", "fade", "collapse", "collapsing", "disabled", "open", "loading",
	"is-loading", "is-active", "is-hidden", "is-invalid", "is-danger", "modal", "modal-backdrop", "dropdown", "visible", "invisible",
	"spinner", "dirty", "error", "offline", "request", "swapping", "settling", "added", "indicator", "busy"}

func TestYpyClassesDoNotCollideWithTheStyles(t *testing.T) {
	ours := ypyClasses(t)
	for _, c := range []string{"ypy-request", "ypy-swapping", "ypy-settling", "ypy-added", "ypy-indicator", "ypy-pending", "ypy-dirty"} {
		if _, ok := ours[c]; !ok {
			t.Errorf("the scan did not find the class %s: the patterns of this test are out of date", c)
		}
	}
	theirs := map[string]string{}
	for _, name := range wellKnown {
		theirs[name] = "the list of MISSION section 7"
	}
	for _, s := range []struct {
		name, file string
		min        int // Pico is nearly classless: it has a dozen
	}{
		{"Bootstrap 5.3.9", "test/fixtures/css/bootstrap/bootstrap.min.css", 500},
		{"Bulma 1.0.4", "test/fixtures/css/bulma/bulma.min.css", 500},
		{"Pico 2.1.1", "test/fixtures/css/pico/pico.min.css", 10},
	} {
		css := sheetClasses(read(t, s.file))
		if len(css) < s.min {
			t.Fatalf("%s: only %d classes found, the extraction is broken", s.name, len(css))
		}
		for c := range css {
			if _, ok := theirs[c]; !ok {
				theirs[c] = s.name
			}
		}
	}
	var names []string
	for c := range ours {
		names = append(names, c)
	}
	sort.Strings(names)
	for _, c := range names {
		if !strings.HasPrefix(c, "ypy-") {
			t.Errorf("class %q (%s) has no ypy- prefix", c, strings.Join(ours[c], ", "))
		}
		if who, ok := theirs[c]; ok {
			t.Errorf("class %q (%s) is also a class of %s", c, strings.Join(ours[c], ", "), who)
		}
	}
	// the classes of the shipped stylesheets too
	for _, f := range []string{"src/css/ypy.css"} {
		for c := range sheetClasses(read(t, f)) {
			if !strings.HasPrefix(c, "ypy-") {
				t.Errorf("%s styles .%s, which is not a ypy- class", f, c)
			}
			if who, ok := theirs[c]; ok {
				t.Errorf("%s styles .%s, a class of %s", f, c, who)
			}
		}
	}
}

func TestYpyWritesOnlyYpyDataAttributes(t *testing.T) {
	data := regexp.MustCompile(`\.dataset\.([A-Za-z]+)\s*=|setAttribute\(\s*['"](data-[a-z-]+)['"]`)
	files := []string{"src/ypy.js"}
	ents, _ := os.ReadDir(filepath.Join(root, "src/ext"))
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".js") {
			files = append(files, "src/ext/"+e.Name())
		}
	}
	for _, f := range files {
		if strings.Contains(f, "alpine-compat") {
			continue // writes Alpine's own data-alpine-state, which is Alpine's attribute
		}
		for _, m := range data.FindAllStringSubmatch(read(t, f), -1) {
			name := m[1] + m[2]
			if !strings.HasPrefix(name, "ypy") && !strings.HasPrefix(name, "data-ypy-") {
				t.Errorf("%s writes the attribute %q", f, name)
			}
		}
	}
}

// inlineStyle finds the writes to the style of an element (CSSOM, not markup: a strict CSP allows them).
var inlineStyle = regexp.MustCompile(`\b(?:elt|el|element|node|target|child|pendingDiv|indicator|clone)\.style\b|setAttribute\(\s*['"]style['"]`)

func TestNoInlineStyleByDefault(t *testing.T) {
	if hits := inlineStyle.FindAllString(read(t, "src/ypy.js"), -1); len(hits) > 0 {
		t.Errorf("the core writes inline styles: %v", hits)
	}
	// Extensions that write element.style do it only for what the page asks with an attribute of
	// theirs: ypy-pending hides the swapped content, ypy-live and ypy-signals bind a style or ypy-show.
	allowed := map[string]string{
		"ypy-pending.js": "opt-in with ypy-pending; hides the content it stands in for",
		"ypy-live.js":    "ypy-live style bindings written by the page",
		"ypy-signals.js": "ypy-show and ypy-style bindings written by the page",
		"ypy-upload.js":  "opt-in with ypy-upload-progress=\"#bar\": sets the --ypy-upload custom property on the bar the page names",
	}
	ents, err := os.ReadDir(filepath.Join(root, "src/ext"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".js") || strings.HasPrefix(e.Name(), "compat") {
			continue
		}
		hits := inlineStyle.FindAllString(read(t, "src/ext/"+e.Name()), -1)
		if len(hits) > 0 && allowed[e.Name()] == "" {
			t.Errorf("%s writes inline styles %v: if it is opt-in, add it to the list of this test with the reason; if not, remove it", e.Name(), hits)
		}
	}
	// the one stylesheet the core injects is a constructable sheet, not a style attribute or element
	core := read(t, "src/ypy.js")
	if strings.Contains(core, "createElement('style')") || strings.Contains(core, `createElement("style")`) {
		t.Error("the core creates a <style> element: use a constructable stylesheet")
	}
}

func TestYpyCSS(t *testing.T) {
	css := read(t, "src/css/ypy.css")
	for _, v := range []string{"--ypy-duration", "--ypy-easing", "--ypy-progress-color", "--ypy-progress-height", "--ypy-progress-duration", "--ypy-progress-z"} {
		if !strings.Contains(css, v+":") {
			t.Errorf("custom property %s is not defined", v)
		}
	}
	for _, want := range []string{"prefers-reduced-motion", ".ypy-indicator", ".ypy-progress", ".ypy-fade", ".ypy-fade-in", "@starting-style", `[data-ypy-state~="request"]`, `[data-ypy-state~="swapping"]`} {
		if !strings.Contains(css, want) {
			t.Errorf("ypy.css has no %s", want)
		}
	}
	for _, bad := range []string{"@import", "url(", "expression(", "!important", "@font-face", "javascript:"} {
		if strings.Contains(css, bad) {
			t.Errorf("ypy.css must not contain %q", bad)
		}
	}
	// no colour, font or size of the page's own elements: every rule is for a ypy- class or :root
	if regexp.MustCompile(`(?m)^(?:body|html|a|p|button|input|h[1-6]|ul|li|div|span)\b`).MatchString(css) {
		t.Error("ypy.css styles a bare element")
	}
	var gz bytes.Buffer
	w, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	w.Write([]byte(css))
	w.Close()
	if gz.Len() > 2048 {
		t.Errorf("ypy.css is %d bytes gzipped, the budget is 2048", gz.Len())
	}
}

func TestFixtureSheetsMatchTheReadme(t *testing.T) {
	readme := read(t, "test/fixtures/css/README.md")
	row := regexp.MustCompile("(?m)^\\| `([a-z]+/[A-Za-z0-9.-]+\\.css)` \\|.*\\| `([0-9a-f]{64})` \\|$")
	rows := row.FindAllStringSubmatch(readme, -1)
	if len(rows) != 4 {
		t.Fatalf("the README lists %d sheets, want 4 (Tailwind, Bootstrap, Bulma, Pico)", len(rows))
	}
	for _, r := range rows {
		sum := sha256.Sum256([]byte(read(t, "test/fixtures/css/"+r[1])))
		if got := hex.EncodeToString(sum[:]); got != r[2] {
			t.Errorf("%s: sha256 is %s, the README says %s", r[1], got, r[2])
		}
	}
	for _, v := range []string{"5.3.9", "1.0.4", "2.1.1", "4.3.5", "MIT", "dist.integrity"} {
		if !strings.Contains(readme, v) {
			t.Errorf("the README does not record %q", v)
		}
	}
	// the version in each sheet's own banner agrees with the README
	for file, banner := range map[string]string{
		"bootstrap/bootstrap.min.css": "Bootstrap  v5.3.9",
		"bulma/bulma.min.css":         "bulma.io v1.0.4",
		"pico/pico.min.css":           "Pico CSS ✨ v2.1.1",
		"tailwind/tailwind.css":       "tailwindcss v4.3.5",
	} {
		if !strings.Contains(read(t, "test/fixtures/css/"+file)[:300], banner) {
			t.Errorf("%s: banner %q not found in its first bytes", file, banner)
		}
	}
}
