// SPDX-License-Identifier: MIT

package gates

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// The forbidden terms are matched case-insensitively and are assembled from
// pieces so that this file does not trip its own gate. One of them is a whole
// word match, because it is also a common substring of other words.
func join(parts ...string) string { return strings.Join(parts, "") }

type term struct {
	label string
	re    *regexp.Regexp
	// skipSuffix: files with this suffix are not searched for the term. Source maps are long runs of
	// base64 where a short identifier-like pattern turns up by chance.
	skipSuffix string
}

// hxw is the two letters of the old attribute prefix. The terms built from it are anchored at a word
// boundary, so words that only contain them (a phoenix tag, a thanks note) do not match.
var hxw = join("h", "x")

var terms = []term{
	{label: "library name", re: regexp.MustCompile(`(?i)` + join("ht", "mx"))},
	{label: "bundle name", re: regexp.MustCompile(`(?i)` + join("ht", "max"))},
	{label: "script language", re: regexp.MustCompile(`(?i)` + join("hyper", "script"))},
	{label: "company name", re: regexp.MustCompile(`(?i)` + join("big", "[ _-]?", "sky"))},
	{label: "author first name", re: regexp.MustCompile(`(?i)` + join("car", "son"))},
	{label: "author surname", re: regexp.MustCompile(`(?i)` + join(`\b`, "gro", "ss", `\b`))},
	// the old names of the attributes, the tag, the headers and the extensions (R-11); the case is ignored
	{label: "old attribute prefix", re: regexp.MustCompile(`(?i)\b` + hxw + `-`)},
	{label: "old data attribute prefix", re: regexp.MustCompile(`(?i)data-` + hxw + `\b`)},
	{label: "old underscore name", re: regexp.MustCompile(`(?i)\b` + hxw + `_`)},
	{label: "old event prefix", re: regexp.MustCompile(`(?i)\b` + hxw + `:`)},
	// identifiers that begin with the old prefix and a capital letter (in camel case, at the start of a word or
	// after an underscore), and those that carry it capitalised after a lower-case letter, a digit or an underscore
	{label: "old identifier", re: regexp.MustCompile(`(?:\b|_)` + hxw + `[A-Z]`), skipSuffix: ".map"},
	{label: "old identifier", re: regexp.MustCompile(`(?:\b|[a-z0-9_])H` + hxw[1:] + `[A-Z]`), skipSuffix: ".map"},
}

// trackedFiles lists the files git tracks, relative to root.
func trackedFiles(ctx context.Context, root string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "git", "ls-files", "-z")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("cannot list the files tracked by git: %w", err)
	}
	var files []string
	for _, f := range bytes.Split(out, []byte{0}) {
		if len(f) > 0 {
			files = append(files, string(f))
		}
	}
	return files, nil
}

type finding struct {
	file  string
	line  int
	text  string
	label string
}

// Names gate: no file tracked by git, and no tracked file name, may contain one
// of the forbidden terms. There is no path allowlist and no opt-out marker; the
// gate is always strict.
func gateNames(ctx context.Context, e *Env) Result {
	files, err := trackedFiles(ctx, e.Root)
	if err != nil {
		return Result{Err: err}
	}
	var kept []string
	for _, f := range files {
		if strings.HasPrefix(f, "node_modules/") || strings.Contains(f, "/node_modules/") {
			continue
		}
		kept = append(kept, f)
	}
	var findings []finding
	scanned := 0
	for _, file := range kept {
		for _, t := range terms {
			if t.re.MatchString(file) {
				findings = append(findings, finding{file, 0, "(file name)", t.label})
			}
		}
		data, err := os.ReadFile(filepath.Join(e.Root, file))
		if err != nil {
			continue // deleted in the working tree, not yet committed
		}
		head := data
		if len(head) > 8192 {
			head = head[:8192]
		}
		if bytes.IndexByte(head, 0) >= 0 {
			continue // binary
		}
		scanned++
		for i, line := range strings.Split(string(data), "\n") {
			for _, t := range terms {
				if t.skipSuffix != "" && strings.HasSuffix(file, t.skipSuffix) {
					continue
				}
				if t.re.MatchString(line) {
					text := strings.TrimSpace(line)
					if len(text) > 110 {
						text = text[:110]
					}
					findings = append(findings, finding{file, i + 1, text, t.label})
					break
				}
			}
		}
	}
	fmt.Fprintf(e.Out, "Name gate: %d text file(s) scanned of %d tracked\n", scanned, len(kept))
	if len(findings) == 0 {
		fmt.Fprintln(e.Out, "name gate passed (no forbidden name)")
		return Result{}
	}
	for i, f := range findings {
		if i == 40 {
			fmt.Fprintf(e.Out, "... and %d more\n", len(findings)-40)
			break
		}
		fmt.Fprintf(e.Out, "error: %s:%d: [%s] %s\n", f.file, f.line, f.label, f.text)
	}
	perFile := map[string]int{}
	for _, f := range findings {
		perFile[f.file]++
	}
	names := make([]string, 0, len(perFile))
	for f := range perFile {
		names = append(names, f)
	}
	sort.Slice(names, func(i, j int) bool {
		return perFile[names[i]] > perFile[names[j]] || perFile[names[i]] == perFile[names[j]] && names[i] < names[j]
	})
	fmt.Fprintf(e.Out, "%d finding(s) in %d file(s):\n", len(findings), len(perFile))
	for _, f := range names {
		fmt.Fprintf(e.Out, "  %5d  %s\n", perFile[f], f)
	}
	return Result{Err: fmt.Errorf("name gate: %d finding(s) in %d file(s)", len(findings), len(perFile))}
}
