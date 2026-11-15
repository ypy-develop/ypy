// SPDX-License-Identifier: MIT

package ypy_test

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy"
)

func read(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The version is written once, in VERSION. Every place that carries it must
// agree: the core source, the editor data, the table of names, and the built
// files of dist/ (run `ypy build` and `ypy gen` after a change of VERSION).
func TestVersionIsTheSameEverywhere(t *testing.T) {
	v := ypy.Version()
	if !regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$`).MatchString(v) {
		t.Fatalf("VERSION %q is not a version like 1.2.3", v)
	}

	if !strings.Contains(read(t, "src/ypy.js"), "this.version = '"+v+"'") {
		t.Errorf("src/ypy.js does not set this.version = '%s'", v)
	}

	var table struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(read(t, "src/attributes.json")), &table); err != nil {
		t.Fatal(err)
	}
	if table.Version != "" {
		t.Errorf("src/attributes.json has its own version %q; it comes from VERSION", table.Version)
	}

	for _, name := range []string{"src/editors/jetbrains/ypy.web-types.json", "dist/editors/jetbrains/ypy.web-types.json"} {
		var wt struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal([]byte(read(t, name)), &wt); err != nil {
			t.Fatal(err)
		}
		if wt.Version != v {
			t.Errorf("%s says %q, VERSION says %q", name, wt.Version, v)
		}
	}

	// what a user loads: the unminified and the minified quote differently
	for name, want := range map[string]string{
		"dist/ypy.js":               "this.version = '" + v + "'",
		"dist/ypy.esm.js":           "this.version = '" + v + "'",
		"dist/ypy.max.js":           "this.version = '" + v + "'",
		"dist/ypy.min.js":           `.version="` + v + `"`,
		"dist/ypy.esm.min.js":       `.version="` + v + `"`,
		"dist/ypy.max.min.js":       `.version="` + v + `"`,
		"dist/embed/ypy.min.js":     `.version="` + v + `"`,
		"dist/embed/ypy.max.min.js": `.version="` + v + `"`,
	} {
		if !strings.Contains(read(t, name), want) {
			t.Errorf("%s does not report version %s (run ypy build)", name, v)
		}
	}
}
