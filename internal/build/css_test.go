// SPDX-License-Identifier: MIT

package build

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAddCSSIsOptional(t *testing.T) {
	out := Output{}
	if err := addCSS(t.TempDir(), out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 {
		t.Errorf("a tree without src/css must add nothing, got %v", out.Names())
	}
}

func TestAddCSSPublishesTheSheets(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, cssDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("ypy.css", "/*! legal */\n/* gone */\n.ypy-a {\n  color: red;\n}\n")
	write("ypy-tailwind.css", "@custom-variant ypy-a (&:is(.ypy-a));\n")
	out := Output{}
	if err := addCSS(root, out); err != nil {
		t.Fatal(err)
	}
	if string(out["ypy.css"]) != "/*! legal */\n/* gone */\n.ypy-a {\n  color: red;\n}\n" {
		t.Errorf("ypy.css must be copied as is: %q", out["ypy.css"])
	}
	min := string(out["ypy.min.css"])
	if !strings.Contains(min, "/*! legal */") || strings.Contains(min, "gone") || strings.Contains(min, "\n  ") || !strings.Contains(min, ".ypy-a{color:red}") {
		t.Errorf("ypy.min.css is not minified with the legal comment kept: %q", min)
	}
	if string(out["ypy-tailwind.css"]) != "@custom-variant ypy-a (&:is(.ypy-a));\n" {
		t.Errorf("ypy-tailwind.css must be copied as is: %q", out["ypy-tailwind.css"])
	}
}

func TestAddCSSNeedsBothFiles(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, cssDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := addCSS(root, Output{}); err == nil {
		t.Error("src/css without ypy.css must fail the build")
	}
	if err := os.WriteFile(filepath.Join(dir, "ypy.css"), []byte(".a{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := addCSS(root, Output{}); err == nil {
		t.Error("src/css without ypy-tailwind.css must fail the build")
	}
}

// The real sheets of the repository: they build, they are in the core part, and ypy.min.css is smaller.
func TestGenerateIncludesTheSheetsOfTheRepository(t *testing.T) {
	out, err := Generate(Options{Root: "../..", Only: PartCore})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ypy.css", "ypy.min.css", "ypy-tailwind.css"} {
		if len(out[name]) == 0 {
			t.Errorf("%s is not in the output", name)
		}
	}
	if len(out["ypy.min.css"]) >= len(out["ypy.css"]) {
		t.Errorf("ypy.min.css (%d B) is not smaller than ypy.css (%d B)", len(out["ypy.min.css"]), len(out["ypy.css"]))
	}
	if only, err := Generate(Options{Root: "../..", Only: PartExt}); err != nil || only["ypy.css"] != nil {
		t.Errorf("the sheets belong to the core part only (err %v)", err)
	}
}
