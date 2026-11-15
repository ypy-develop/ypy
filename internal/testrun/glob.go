// SPDX-License-Identifier: MIT

package testrun

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// compileGlob turns a slash separated glob into a regular expression. It
// understands "**" (any number of directories, also none), "*" (anything but a
// slash), "?" and "{a,b}".
func compileGlob(glob string) (*regexp.Regexp, error) {
	var b strings.Builder
	b.WriteString("^")
	depth := 0
	for i := 0; i < len(glob); i++ {
		c := glob[i]
		switch c {
		case '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				i++
				if i+1 < len(glob) && glob[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '{':
			depth++
			b.WriteString("(?:")
		case '}':
			if depth > 0 {
				depth--
				b.WriteString(")")
			} else {
				b.WriteString(`\}`)
			}
		case ',':
			if depth > 0 {
				b.WriteString("|")
			} else {
				b.WriteString(",")
			}
		case '.', '+', '(', ')', '|', '^', '$', '[', ']', '\\':
			b.WriteString(`\`)
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

// globBase is the longest directory prefix of a glob without wildcards.
func globBase(glob string) string {
	parts := strings.Split(glob, "/")
	var keep []string
	for _, p := range parts[:len(parts)-1] {
		if strings.ContainsAny(p, "*?{") {
			break
		}
		keep = append(keep, p)
	}
	if len(keep) == 0 {
		return "."
	}
	return strings.Join(keep, "/")
}

// Discover lists the files below root (as slash separated paths relative to
// root) that match any of the globs, sorted. node_modules and .git are skipped.
func Discover(root string, globs []string) ([]string, error) {
	seen := map[string]bool{}
	for _, g := range globs {
		g = strings.TrimPrefix(filepath.ToSlash(g), "./")
		re, err := compileGlob(g)
		if err != nil {
			return nil, err
		}
		base := globBase(g)
		start := filepath.Join(root, filepath.FromSlash(base))
		if _, err := os.Stat(start); err != nil {
			continue
		}
		err = filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if n := d.Name(); n == "node_modules" || n == ".git" {
					return filepath.SkipDir
				}
				return nil
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return nil
			}
			rel = filepath.ToSlash(rel)
			if re.MatchString(rel) {
				seen[rel] = true
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	out := make([]string, 0, len(seen))
	for f := range seen {
		out = append(out, f)
	}
	sort.Strings(out)
	return out, nil
}

// cleanRel normalizes a user supplied file (relative to root or absolute) to a
// slash separated path relative to root.
func cleanRel(root, file string) string {
	if filepath.IsAbs(file) {
		if rel, err := filepath.Rel(root, file); err == nil {
			file = rel
		}
	}
	return path.Clean(filepath.ToSlash(file))
}
