// SPDX-License-Identifier: MIT

package gates

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/cli"
)

// repo makes a git repository with the given files, all added.
func repo(t *testing.T, files map[string]string) *Env {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "-A"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git unavailable: %v %s", err, out)
		}
	}
	var out bytes.Buffer
	return &Env{Root: root, Out: &out, Err: &out, IO: cli.IO{Out: &out, Err: &out, Dir: root}}
}

func TestNamesGateFindsContentAndFileNames(t *testing.T) {
	bad := join("ht", "mx")
	surname := join("gro", "ss")
	e := repo(t, map[string]string{
		"ok.txt":                     "nothing to see\n",
		"notes.txt":                  "line one\nuses " + strings.ToUpper(bad) + " here\n",
		"docs/" + bad + ".md":        "clean content\n",
		surname + "-margin.txt":      "a whole word hit: " + surname + "\n",
		surname + "ly-unrelated.txt": surname + "ly overstated\n",
		"binary.bin":                 "a\x00" + bad,
	})
	res := gateNames(context.Background(), e)
	if res.Err == nil {
		t.Fatalf("expected findings:\n%s", e.Out)
	}
	out := e.Out.(*bytes.Buffer).String()
	for _, want := range []string{"notes.txt:2: [library name]", "docs/" + bad + ".md:0: [library name]", surname + "-margin.txt:1: [author surname]"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	for _, not := range []string{surname + "ly-unrelated.txt:", "binary.bin:", "ok.txt:"} {
		if strings.Contains(out, not) {
			t.Errorf("output must not flag %q:\n%s", not, out)
		}
	}
	clean := repo(t, map[string]string{"a.txt": "fine\n"})
	if res := gateNames(context.Background(), clean); res.Err != nil {
		t.Errorf("clean repository failed: %v", res.Err)
	}
}

// The old attribute names are found at a word boundary, in every case, in content and in file names;
// words that only contain the two letters are left alone.
func TestNamesGateOldAttributeNames(t *testing.T) {
	h, H := join("h", "x"), join("H", "X")
	positives := []string{
		"<button " + h + "-get=\"/x\">",
		"<div data-" + h + "-target=\"#a\">",
		"<" + h + "-partial " + h + "-target=\"#a\">",
		"Vary: " + H + "-Request",
		"w.Header().Set(\"" + H + "-Redirect\", \"/\")",
		"headers[\"" + join("H", "x") + "-Select\"]",
		"let " + h + "On = 1",
		"this.#" + h + "OnQuery = null",
		"function __handle" + join("H", "x") + "Headers() {}",
		"export namespace " + join("H", "x") + "Live {}",
		"detail.message.event === '" + h + ":release'",
		"name = '" + h + "_trigger'",
		"data-" + h + " is the old data prefix",
	}
	negatives := []string{
		"<button phx-click=\"inc\">",
		"thx-note and thx: thanks",
		"a " + h + " alone, and " + h + "get without a separator",
		"rhx_value and xhxOn",
		"the word " + join("p", "hx") + "On is not one of ours",
		"<button ypy-get=\"/x\" data-ypy-target=\"#a\">",
		"Vary: YPY-Request",
	}
	files := map[string]string{}
	for i, line := range positives {
		files[fmt.Sprintf("pos%02d.txt", i)] = line + "\n"
	}
	for i, line := range negatives {
		files[fmt.Sprintf("neg%02d.txt", i)] = line + "\n"
	}
	files["docs/"+h+"-guide.md"] = "clean content\n"
	files["bundle.js.map"] = "{\"mappings\":\"AAAA;" + join("H", "x") + "BAAC,a" + join("H", "x") + "BAAC\"}\n"
	files["other.js.map"] = "{\"sources\":[\"" + h + "-get.js\"]}\n"
	e := repo(t, files)
	res := gateNames(context.Background(), e)
	if res.Err == nil {
		t.Fatalf("expected findings:\n%s", e.Out)
	}
	out := e.Out.(*bytes.Buffer).String()
	for i := range positives {
		if want := fmt.Sprintf("pos%02d.txt:1:", i); !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	for i := range negatives {
		if not := fmt.Sprintf("neg%02d.txt:", i); strings.Contains(out, not) {
			t.Errorf("output must not flag %q:\n%s", not, out)
		}
	}
	for _, want := range []string{"docs/" + h + "-guide.md:0: [old attribute prefix]", "other.js.map:1: [old attribute prefix]"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "bundle.js.map:") {
		t.Errorf("identifier-like base64 in a source map must not be flagged:\n%s", out)
	}
}

func TestDetectLicense(t *testing.T) {
	mit := "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software.\nThe above copyright notice and this permission notice shall be included in all copies.\n"
	bsd3 := "Redistribution and use in source and binary forms, with or without modification, are permitted provided that:\n3. Neither the name of the copyright holder nor the names of its contributors may be used"
	bsd2 := "Redistribution and use in source and binary forms, with or without modification, are permitted"
	cases := []struct{ text, want string }{
		{mit, "MIT"},
		{bsd3, "BSD-3-Clause"},
		{bsd2, "BSD-2-Clause"},
		{"                GNU GENERAL PUBLIC LICENSE\n Version 3", "COPYLEFT"},
		{"Mozilla Public License Version 2.0", "COPYLEFT"},
		{"Apache License\n Version 2.0, January 2004", "Apache-2.0"},
		{"do what you want", ""},
	}
	for _, c := range cases {
		if got := detectLicense(c.text); got != c.want {
			t.Errorf("detectLicense(%.30q) = %q, want %q", c.text, got, c.want)
		}
	}
	for _, id := range []string{"MIT", "BSD-3-Clause", "Apache-2.0"} {
		if !allowedLicenses[id] {
			t.Errorf("%s must be allowed", id)
		}
	}
	if allowedLicenses["COPYLEFT"] || allowedLicenses["GPL-3.0"] {
		t.Error("copyleft must not be allowed")
	}
}

func TestFrameworkDeps(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	write("src/ypy.js", "import { a } from './a.js'\nimport 'https://cdn.example/x.js'\nconst m = await import('./ext/b.js')\n")
	write("src/ext/b.js", "export { c } from \"./c.js\"\n")
	n, deps, err := frameworkDeps(root)
	if err != nil || n != 2 || len(deps) != 0 {
		t.Fatalf("clean framework: n=%d deps=%v err=%v", n, deps, err)
	}
	write("src/ext/bad.js", "import lodash from 'lodash'\nconst x = require('left-pad')\nconst y = import('react')\nimport 'side-effect'\n")
	_, deps, _ = frameworkDeps(root)
	for _, want := range []string{"lodash", "left-pad", "react", "side-effect"} {
		if len(deps[want]) == 0 {
			t.Errorf("dependency %q not found in %v", want, deps)
		}
	}
}

func TestSPDXGate(t *testing.T) {
	e := repo(t, map[string]string{
		"src/a.js":        "// SPDX-License-Identifier: MIT\nexport {}\n",
		"src/b.js":        "export {}\n",
		"cmd/x/main.go":   "// SPDX-License-Identifier: MIT\n\npackage main\n",
		"testdata/t/z.go": "not go\n",
		"docs/readme.md":  "no header needed\n",
		"internal/y/y.go": "package y\n",
	})
	res := gateSPDX(context.Background(), e)
	out := e.Out.(*bytes.Buffer).String()
	if res.Err == nil || !strings.Contains(out, "missing: src/b.js") || !strings.Contains(out, "missing: internal/y/y.go") {
		t.Fatalf("expected two findings:\n%s", out)
	}
	if strings.Contains(out, "src/a.js") || strings.Contains(out, "readme.md") {
		t.Errorf("flagged a file that is fine:\n%s", out)
	}
}

func TestCommandListsGatesAndRejectsUnknown(t *testing.T) {
	var out, errb bytes.Buffer
	io := cli.IO{Out: &out, Err: &errb}
	if code := Command().Run(context.Background(), []string{"--list"}, io); code != cli.ExitOK {
		t.Fatalf("--list exit %d", code)
	}
	for _, g := range All() {
		if !strings.Contains(out.String(), g.Name) {
			t.Errorf("--list lacks gate %q", g.Name)
		}
	}
	if code := Command().Run(context.Background(), []string{"nope"}, io); code != cli.ExitUsage {
		t.Errorf("unknown gate: exit %d", code)
	}
	if code := Command().Run(context.Background(), []string{"--skip", "nope"}, io); code != cli.ExitUsage {
		t.Errorf("unknown --skip: exit %d", code)
	}
}

func TestCommandSummaryAndFailure(t *testing.T) {
	e := repo(t, map[string]string{"a.txt": join("ht", "mx") + "\n", "b.go": "// SPDX-License-Identifier: MIT\n\npackage b\n"})
	var out bytes.Buffer
	io := cli.IO{Out: &out, Err: &out, Dir: e.Root}
	code := Command().Run(context.Background(), []string{"names", "spdx"}, io)
	if code != cli.ExitFailure {
		t.Errorf("exit = %d, want 1\n%s", code, out.String())
	}
	for _, want := range []string{"==> Summary", "failed   names", "passed   spdx", "FAILED."} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("summary lacks %q:\n%s", want, out.String())
		}
	}
}
