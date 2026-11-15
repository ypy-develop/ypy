// SPDX-License-Identifier: MIT

package gates

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// allowedLicenses are the permissive licenses accepted for the dependencies of
// the tool and for vendored files. It is the single place that decides: add to
// it only after reading the license. Strong or weak copyleft, and licenses that
// cannot be recognized, fail the gate.
var allowedLicenses = map[string]bool{
	"MIT": true, "BSD-2-Clause": true, "BSD-3-Clause": true, "ISC": true,
	"Apache-2.0": true, "0BSD": true, "Unlicense": true, "Zlib": true, "CC0-1.0": true,
}

// licenseOverrides name modules whose license text cannot be recognized by
// detectLicense, with the license read by hand. Keep this list short and
// justified; it is empty now.
var licenseOverrides = map[string]string{}

// vendored lists third party files that are part of the repository, with the
// license file that goes with each and the license it must be, and their
// provenance: the package and version they were taken from, where, the sha256
// of the file as it is committed (the gate fails when it changes) and the local
// patches, if any. Updating a file means updating its row, so the change is
// seen in review.
var vendored = []struct {
	file, license, want  string
	pkg, version, source string
	sha256, patches      string
}{
	{"internal/testrun/assets/mocha.js", "internal/testrun/assets/LICENSE-mocha", "MIT",
		"mocha", "10.8.2", "npm: mocha@10.8.2 mocha.js (npm integrity sha512 checked when it was taken)",
		"4ab5741f0be77d93cd7dcf2e3ce444579f04679e4b5a3842bf1d55a2bcbf9350", ""},
	{"internal/testrun/assets/chai.js", "internal/testrun/assets/LICENSE-chai", "MIT",
		"chai", "4.5.0", "npm: chai@4.5.0 chai.js (the file's own version string still says 4.3.8; the bytes are 4.5.0)",
		"bdc229d660afad0313fc10d6afb5a339956a18c4c6e819d3eb5d8b94f314c202", ""},
	{"test/lib/alpine.js", "test/lib/LICENSE-alpine", "MIT",
		"alpinejs", "3.15.8", "npm: alpinejs@3.15.8 dist/cdn.js",
		"47bd4da9a773741e3229c33e913250a0f66ca2b09277568d0b402cddcaa0b556", "x-ref directive: `if (!root) return;`"},
}

var (
	copyleft = regexp.MustCompile(`(?i)GNU (GENERAL|LESSER|AFFERO)|Mozilla Public License|Eclipse Public License|Server Side Public License|European Union Public Licen`)
	spaces   = regexp.MustCompile(`\s+`)
)

// detectLicense recognizes a license text by its characteristic sentences.
func detectLicense(text string) string {
	t := strings.ToLower(spaces.ReplaceAllString(text, " "))
	has := func(s string) bool { return strings.Contains(t, strings.ToLower(s)) }
	switch {
	case copyleft.MatchString(text):
		return "COPYLEFT"
	case has("apache license") && has("version 2.0"):
		return "Apache-2.0"
	case has("permission is hereby granted, free of charge") && has("the above copyright notice and this permission notice shall be included"):
		return "MIT"
	case has("redistribution and use in source and binary forms") && has("neither the name"):
		return "BSD-3-Clause"
	case has("redistribution and use in source and binary forms"):
		return "BSD-2-Clause"
	case has("permission to use, copy, modify, and/or distribute this software for any purpose with or without fee"):
		return "ISC"
	case has("this is free and unencumbered software released into the public domain"):
		return "Unlicense"
	case has("provided \"as is\"") && has("permission is granted to anyone to use this software for any purpose") && has("altered source versions"):
		return "Zlib"
	}
	return ""
}

var licenseNames = []string{"LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "COPYING.md", "LICENSE-MIT", "LICENSE.MIT", "UNLICENSE"}

// readLicense reads the license file of a module directory.
func readLicense(dir string) (string, string, bool) {
	for _, n := range licenseNames {
		if b, err := os.ReadFile(filepath.Join(dir, n)); err == nil {
			return n, string(b), true
		}
	}
	return "", "", false
}

type goModule struct {
	Path    string
	Version string
	Dir     string
	Main    bool
	Replace *struct{ Path, Version, Dir string }
}

func listModules(ctx context.Context, root string) ([]goModule, error) {
	cmd := exec.CommandContext(ctx, "go", "list", "-m", "-json", "all")
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list -m all: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	dec := json.NewDecoder(bytes.NewReader(out))
	var mods []goModule
	for {
		var m goModule
		if err := dec.Decode(&m); err == io.EOF {
			break
		} else if err != nil {
			return nil, err
		}
		mods = append(mods, m)
	}
	return mods, nil
}

// usedModules are the modules that supply a package of the build, tests included.
func usedModules(ctx context.Context, root string) (map[string]bool, error) {
	cmd := exec.CommandContext(ctx, "go", "list", "-deps", "-test", "-f", "{{with .Module}}{{.Path}}{{end}}", "./...")
	cmd.Dir = root
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list -deps: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	used := map[string]bool{}
	for _, l := range strings.Split(string(out), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			used[l] = true
		}
	}
	return used, nil
}

var (
	importFrom = regexp.MustCompile(`(?m)^\s*(?:import|export)\b[^'"` + "`" + `;]*?\bfrom\s*['"]([^'"]+)['"]`)
	importBare = regexp.MustCompile(`(?m)^\s*import\s*['"]([^'"]+)['"]`)
	dynImport  = regexp.MustCompile(`\bimport\(\s*['"]([^'"]+)['"]\s*\)`)
	requireRe  = regexp.MustCompile(`\brequire\(\s*['"]([^'"]+)['"]\s*\)`)
)

// frameworkDeps finds what the framework sources pull in from outside: a
// package specifier (not a relative path or an URL) in an import or require.
func frameworkDeps(root string) (files int, deps map[string][]string, err error) {
	deps = map[string][]string{}
	src := filepath.Join(root, "src")
	if _, err := os.Stat(src); err != nil {
		return 0, deps, nil
	}
	err = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		switch filepath.Ext(p) {
		case ".js", ".mjs", ".cjs", ".ts":
		default:
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		files++
		rel, _ := filepath.Rel(root, p)
		for _, re := range []*regexp.Regexp{importFrom, importBare, dynImport, requireRe} {
			for _, m := range re.FindAllStringSubmatch(string(b), -1) {
				spec := m[1]
				if strings.HasPrefix(spec, ".") || strings.HasPrefix(spec, "/") || strings.Contains(spec, "://") || strings.HasPrefix(spec, "data:") {
					continue
				}
				deps[spec] = append(deps[spec], filepath.ToSlash(rel))
			}
		}
		return nil
	})
	return
}

func gateLicenses(ctx context.Context, e *Env) Result {
	var problems []string

	// 1. the framework has no dependencies
	fmt.Fprintln(e.Out, "Framework dependencies (src/)")
	n, deps, err := frameworkDeps(e.Root)
	if err != nil {
		return Result{Err: err}
	}
	if len(deps) == 0 {
		fmt.Fprintf(e.Out, "  none in %d source file(s) (ok)\n", n)
	}
	for spec, in := range deps {
		problems = append(problems, fmt.Sprintf("the framework imports %q (%s): it must have no dependencies", spec, in[0]))
	}
	for _, name := range []string{"package.json", "package-lock.json", "node_modules"} {
		if _, err := os.Lstat(filepath.Join(e.Root, name)); err == nil && name != "node_modules" {
			problems = append(problems, fmt.Sprintf("%s exists: the project has no Node dependencies", name))
		}
	}

	// 2. Go modules of the tool
	fmt.Fprintln(e.Out, "\nGo modules of the tool (go list -m all)")
	mods, err := listModules(ctx, e.Root)
	if err != nil {
		return Result{Err: err}
	}
	used, err := usedModules(ctx, e.Root)
	if err != nil {
		return Result{Err: err}
	}
	type row struct{ path, version, license, status string }
	var rows []row
	graphOnly := 0
	for _, m := range mods {
		if m.Main {
			continue
		}
		dir := m.Dir
		if m.Replace != nil && m.Replace.Dir != "" {
			dir = m.Replace.Dir
		}
		if dir == "" {
			if used[m.Path] {
				problems = append(problems, fmt.Sprintf("%s is built but its source is not in the module cache", m.Path))
			}
			graphOnly++
			continue
		}
		license := licenseOverrides[m.Path]
		if license == "" {
			name, text, ok := readLicense(dir)
			switch {
			case !ok:
				license = ""
			default:
				license = detectLicense(text)
				_ = name
			}
		}
		status := "ok"
		switch {
		case license == "":
			status = "UNKNOWN"
			problems = append(problems, fmt.Sprintf("%s@%s: license not found or not recognized (read it, then add a justified entry to licenseOverrides)", m.Path, m.Version))
		case license == "COPYLEFT" || !allowedLicenses[license]:
			status = "NOT ALLOWED"
			problems = append(problems, fmt.Sprintf("%s@%s: license %s is not on the allowlist", m.Path, m.Version, license))
		}
		rows = append(rows, row{m.Path, m.Version, license, status})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].path < rows[j].path })
	w := 0
	for _, r := range rows {
		if len(r.path) > w {
			w = len(r.path)
		}
	}
	for _, r := range rows {
		lic := r.license
		if lic == "" {
			lic = "-"
		}
		fmt.Fprintf(e.Out, "  %-*s  %-12s  %s\n", w, r.path, lic, r.status)
	}
	fmt.Fprintf(e.Out, "  %d module(s) checked, %d more in the module graph only (not built, not in the cache)\n", len(rows), graphOnly)

	// 3. vendored third party files
	fmt.Fprintln(e.Out, "\nVendored files")
	for _, v := range vendored {
		text, err := os.ReadFile(filepath.Join(e.Root, v.license))
		got := ""
		if err == nil {
			got = detectLicense(string(text))
		}
		status := "ok"
		if _, serr := os.Stat(filepath.Join(e.Root, v.file)); serr != nil {
			status = "missing"
			problems = append(problems, fmt.Sprintf("vendored file %s is missing", v.file))
		} else if got != v.want {
			status = "LICENSE?"
			problems = append(problems, fmt.Sprintf("%s: expected license %s in %s, found %q", v.file, v.want, v.license, got))
		}
		if b, rerr := os.ReadFile(filepath.Join(e.Root, v.file)); rerr == nil {
			if sum := fmt.Sprintf("%x", sha256.Sum256(b)); sum != v.sha256 {
				status = "HASH?"
				problems = append(problems, fmt.Sprintf("%s: sha256 is %s, the provenance record (%s %s) says %s: update the record in internal/gates/licenses.go with the new package, version and hash", v.file, sum, v.pkg, v.version, v.sha256))
			}
		}
		fmt.Fprintf(e.Out, "  %s  %s %s  %s\n", v.file, v.pkg, v.version, v.want+" "+status)
	}

	fmt.Fprintln(e.Out)
	if len(problems) > 0 {
		for _, p := range problems {
			fmt.Fprintf(e.Out, "error: %s\n", p)
		}
		return Result{Err: fmt.Errorf("license gate: %d problem(s)", len(problems))}
	}
	fmt.Fprintln(e.Out, "license gate passed")
	return Result{}
}
