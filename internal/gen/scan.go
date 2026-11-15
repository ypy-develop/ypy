// SPDX-License-Identifier: MIT

package gen

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Scan is the result of reading the sources for names.
type Scan struct {
	// Problems are names the sources use that the table does not know, in a file that has a table
	// (the core, or an extension with a fragment).
	Problems []string
	// Warnings are extensions that have no fragment yet, and table entries no source mentions.
	Warnings []string
}

// A token is any ypy- name in the code: an attribute, a class, an element, an event or a header.
var token = regexp.MustCompile(`(?:data-)?(?:ypy-[A-Za-z0-9][A-Za-z0-9-]*(?::[A-Za-z0-9*][A-Za-z0-9:_*-]*)?|ypy-|ypy:[A-Za-z0-9][A-Za-z0-9:_-]*:?|YPY-[A-Za-z0-9][A-Za-z0-9-]*)`)

// ScanSources reads src/ypy.js and every src/ext/*.js and compares the names it finds with the table.
func ScanSources(t *Table, root string) (*Scan, error) {
	files := []string{CoreSource}
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(ExtDir)))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".js") {
			files = append(files, ExtDir+"/"+e.Name())
		}
	}
	known := t.nameSet()
	fragments := map[string]bool{}
	for _, s := range t.Extensions {
		fragments[s] = true
	}
	mentioned := map[string]bool{}
	sources := map[string]string{} // slug of the owner ("" for the core) -> code
	scan := &Scan{}
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		slug := strings.TrimSuffix(filepath.Base(rel), ".js")
		hasTable := rel == CoreSource || fragments[slug]
		var unknown []string
		code := stripComments(string(data))
		if rel == CoreSource {
			sources[""] = code
		} else {
			sources[slug] = code
		}
		for ln, line := range strings.Split(code, "\n") {
			for _, tok := range token.FindAllString(line, -1) {
				tok = strings.TrimPrefix(tok, "data-")
				for name := range known.matches(tok) {
					mentioned[name] = true
				}
				if !known.has(tok) {
					unknown = append(unknown, fmt.Sprintf("%s:%d: %s", rel, ln+1, tok))
				}
			}
		}
		if len(unknown) == 0 {
			continue
		}
		if hasTable {
			scan.Problems = append(scan.Problems, dedupe(unknown)...)
		} else {
			scan.Warnings = append(scan.Warnings, fmt.Sprintf("%s has no fragment in %s/%s.json: %d name(s) are not in the table, for example %s",
				rel, FragmentsDir, slug, len(dedupeTokens(unknown)), strings.Join(first(dedupeTokens(unknown), 3), ", ")))
		}
	}
	// The stylesheets of src/css style the classes of the table: they only count as a mention (their
	// custom properties and the Tailwind variants are not names of the table).
	cssFiles, _ := filepath.Glob(filepath.Join(root, filepath.FromSlash(CSSDir), "*.css"))
	for _, f := range cssFiles {
		data, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		for _, tok := range token.FindAllString(string(data), -1) {
			for name := range known.matches(strings.TrimPrefix(tok, "data-")) {
				mentioned[name] = true
			}
		}
	}
	for _, name := range known.public {
		if !mentioned[name] && !known.dynamic[name] && !t.builtFromParts(name, sources) {
			scan.Warnings = append(scan.Warnings, fmt.Sprintf("the table lists %s but no source mentions it", name))
		}
	}
	sort.Strings(scan.Problems)
	sort.Strings(scan.Warnings)
	return scan, nil
}

// nameSpace answers whether a token of the sources is a name of the table.
type nameSpace struct {
	exact    map[string]bool
	families []string // prefixes of names that end with *
	public   []string
	internal map[string]bool
	// dynamic names are built from parts, so no source holds them as one word.
	dynamic map[string]bool
}

func (t *Table) nameSet() *nameSpace {
	n := &nameSpace{exact: map[string]bool{}, internal: map[string]bool{}, dynamic: map[string]bool{}}
	add := func(name string) {
		n.public = append(n.public, name)
		if strings.HasSuffix(name, "*") {
			n.families = append(n.families, strings.TrimSuffix(name, "*"))
			n.dynamic[name] = true
			return
		}
		n.exact[name] = true
	}
	for _, a := range t.Attributes {
		add(a.Name)
		for _, v := range a.Variants {
			n.exact[v] = true
		}
	}
	for _, e := range t.Elements {
		add(e.Name)
	}
	for _, e := range t.Events {
		add(e.Name)
		// Names that the code builds: the request events ("ypy:request:" + name), the old names that
		// the compat layer lists in a table of pairs.
		if strings.HasPrefix(e.Name, "ypy:request:") {
			n.dynamic[e.Name] = true
		}
	}
	for _, h := range t.Headers {
		add(h.Name)
		// Response headers reach the code lower cased, as ctx.ypy.<name>.
		if h.Direction == "response" {
			n.dynamic[h.Name] = true
		}
	}
	for _, c := range t.Classes {
		add(c.Name)
	}
	for name := range t.Internal {
		n.internal[name] = true
	}
	// The HTTP verbs build ypy-get, ypy-post and the others.
	for _, verb := range []string{"get", "post", "put", "patch", "delete", "query"} {
		n.dynamic["ypy-"+verb] = true
	}
	return n
}

// has reports whether tok is a name, a prefix of names ("ypy-error-", "ypy:request:", "ypy-"), or internal.
func (n *nameSpace) has(tok string) bool {
	if tok == "ypy-" || tok == "ypy:" || tok == "YPY-" {
		return true
	}
	if n.exact[tok] || n.internal[tok] {
		return true
	}
	for _, f := range n.families {
		// ypy-live:text is in the family ypy-live:*; "ypy-status" is the word before its ":" in "ypy-status:" + code.
		if strings.HasPrefix(tok, f) || strings.HasPrefix(f, tok+":") {
			return true
		}
	}
	if strings.HasSuffix(tok, "-") || strings.HasSuffix(tok, ":") {
		for _, name := range n.public {
			if strings.HasPrefix(name, tok) {
				return true
			}
		}
		for name := range n.internal {
			if strings.HasPrefix(name, tok) {
				return true
			}
		}
	}
	return false
}

// matches returns the table names that a token stands for.
func (n *nameSpace) matches(tok string) map[string]bool {
	out := map[string]bool{}
	if len(tok) <= 4 {
		return out
	}
	for _, name := range n.public {
		switch {
		case name == tok:
			out[name] = true
		case strings.HasSuffix(name, "*") && strings.HasPrefix(tok, strings.TrimSuffix(name, "*")):
			out[name] = true
		case (strings.HasSuffix(tok, "-") || strings.HasSuffix(tok, ":")) && strings.HasPrefix(name, tok):
			out[name] = true
		}
	}
	return out
}

func dedupe(list []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func dedupeTokens(list []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range list {
		tok := s[strings.LastIndex(s, " ")+1:]
		if !seen[tok] {
			seen[tok] = true
			out = append(out, tok)
		}
	}
	return out
}

func first(list []string, n int) []string {
	if len(list) > n {
		return list[:n]
	}
	return list
}

// builtFromParts reports whether the code of the owner of a name mentions its short form
// ("attr" for ypy-attr) as a quoted word: extensions build ypy-<name> from a list of names.
func (t *Table) builtFromParts(name string, sources map[string]string) bool {
	short := strings.TrimPrefix(strings.TrimPrefix(name, "ypy-"), "ypy:")
	if short == name || short == "" {
		return false
	}
	owner := ""
	for _, a := range t.Attributes {
		if a.Name == name {
			owner = a.Extension
		}
	}
	for _, e := range t.Elements {
		if e.Name == name {
			owner = e.Extension
		}
	}
	for _, e := range t.Events {
		if e.Name == name {
			owner = e.Extension
		}
	}
	// the short form up to the first ":" or "."
	if i := strings.IndexAny(short, ":."); i > 0 {
		short = short[:i]
	}
	re := regexp.MustCompile(`['"` + "`" + `]` + regexp.QuoteMeta(short) + `['"` + "`" + `:.]`)
	return re.MatchString(sources[owner])
}
