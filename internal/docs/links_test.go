// SPDX-License-Identifier: MIT

// Package docs holds the checks of the Markdown files the repository keeps
// (the documentation itself lives on the website, not here): every relative
// link of the Markdown files at the root and under .agents/ points to a file
// that exists and, when it names an anchor, to a heading or an explicit anchor
// of that file.
package docs

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// root returns the repository root: the nearest parent directory with a go.mod.
func root(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("no go.mod above the test directory")
		}
		dir = parent
	}
}

// pages lists the Markdown files at the root and under .agents/, relative to root.
func pages(t *testing.T, base string) []string {
	t.Helper()
	var list []string
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			list = append(list, e.Name())
		}
	}
	agents := filepath.Join(base, ".agents")
	if _, err := os.Stat(agents); err == nil {
		err = filepath.WalkDir(agents, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() && strings.HasSuffix(path, ".md") {
				rel, err := filepath.Rel(base, path)
				if err != nil {
					return err
				}
				list = append(list, filepath.ToSlash(rel))
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	sort.Strings(list)
	return list
}

var (
	fence       = regexp.MustCompile("^\\s*(```|~~~)")
	codeSpan    = regexp.MustCompile("`[^`\n]*`")
	link        = regexp.MustCompile(`\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	heading     = regexp.MustCompile(`^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$`)
	explicitID  = regexp.MustCompile(`<a\s+(?:id|name)="([^"]+)"`)
	mdLink      = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	dropInSlugs = regexp.MustCompile(`[*_~]`)
)

// slug is the anchor GitHub gives a heading: lower case, punctuation removed,
// spaces turned into hyphens.
func slug(text string) string {
	text = mdLink.ReplaceAllString(text, "$1")
	text = strings.ReplaceAll(text, "`", "")
	text = dropInSlugs.ReplaceAllString(text, "")
	var sb strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(text)) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_':
			sb.WriteRune(r)
		case r == ' ':
			sb.WriteByte('-')
		}
	}
	return sb.String()
}

// anchors returns the anchors a Markdown file offers.
func anchors(src string) map[string]bool {
	out := map[string]bool{}
	seen := map[string]int{}
	inFence := false
	for _, line := range strings.Split(src, "\n") {
		if fence.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		for _, m := range explicitID.FindAllStringSubmatch(line, -1) {
			out[m[1]] = true
		}
		if m := heading.FindStringSubmatch(line); m != nil {
			s := slug(m[2])
			if n := seen[s]; n > 0 {
				out[s+"-"+strconv.Itoa(n)] = true
			} else {
				out[s] = true
			}
			seen[s]++
		}
	}
	return out
}

// links returns the link targets of a Markdown file, outside code.
func links(src string) []string {
	var out []string
	inFence := false
	for _, line := range strings.Split(src, "\n") {
		if fence.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		line = codeSpan.ReplaceAllString(line, "")
		for _, m := range link.FindAllStringSubmatch(line, -1) {
			out = append(out, m[1])
		}
	}
	return out
}

func external(target string) bool {
	for _, p := range []string{"http://", "https://", "mailto:", "tel:"} {
		if strings.HasPrefix(target, p) {
			return true
		}
	}
	return false
}

func TestLinksResolve(t *testing.T) {
	base := root(t)
	sources := map[string]string{}
	for _, page := range pages(t, base) {
		b, err := os.ReadFile(filepath.Join(base, page))
		if err != nil {
			t.Fatal(err)
		}
		sources[page] = string(b)
	}
	anchorCache := map[string]map[string]bool{}
	anchorsOf := func(page string) map[string]bool {
		if a, ok := anchorCache[page]; ok {
			return a
		}
		a := anchors(sources[page])
		anchorCache[page] = a
		return a
	}

	checked := 0
	for page, src := range sources {
		for _, target := range links(src) {
			if external(target) {
				continue
			}
			checked++
			path, anchor, _ := strings.Cut(target, "#")
			dest := page
			if path != "" {
				dest = filepath.ToSlash(filepath.Join(filepath.Dir(page), path))
			}
			info, err := os.Stat(filepath.Join(base, dest))
			if err != nil {
				t.Errorf("%s: link %q: %s does not exist", page, target, dest)
				continue
			}
			if anchor == "" {
				continue
			}
			if info.IsDir() || !strings.HasSuffix(dest, ".md") {
				continue // only Markdown files have anchors we can check
			}
			if _, ok := sources[dest]; !ok {
				// A Markdown file that is not among the pages: read it.
				b, err := os.ReadFile(filepath.Join(base, dest))
				if err != nil {
					t.Errorf("%s: link %q: %v", page, target, err)
					continue
				}
				sources[dest] = string(b)
			}
			if !anchorsOf(dest)[anchor] {
				t.Errorf("%s: link %q: %s has no heading or anchor %q", page, target, dest, anchor)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no relative link was checked: the pages were not found")
	}
	t.Logf("%d relative links checked in %d pages", checked, len(sources))
}

// TestSlug pins the anchor rule against the headings the guides link to.
func TestSlug(t *testing.T) {
	tests := map[string]string{
		"Step by step for an Arandu or Kyse project": "step-by-step-for-an-arandu-or-kyse-project",
		"Reference: every rule":                      "reference-every-rule",
		"`ypy-error-*`":                              "ypy-error-",
		"Path A: plain HTML":                         "path-a-plain-html",
		"Conceitos centrais":                         "conceitos-centrais",
		"Receita: Go (`net/http`)":                   "receita-go-nethttp",
	}
	for in, want := range tests {
		if got := slug(in); got != want {
			t.Errorf("slug(%q) = %q, want %q", in, got, want)
		}
	}
}
