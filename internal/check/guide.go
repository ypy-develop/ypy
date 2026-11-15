// SPDX-License-Identifier: MIT

package check

import (
	"fmt"
	"os"
	"strings"
)

const (
	guideBegin = "<!-- rules:begin -->"
	guideEnd   = "<!-- rules:end -->"
)

var guideSections = [][2]string{
	{"attribute", "Attributes"},
	{"extension", "Extension attributes, swap styles and event sources"},
	{"event", "Events"},
	{"header", "HTTP headers"},
	{"config", "Configuration keys"},
	{"api", "JavaScript API"},
	{"inheritance", "Behavior changes"},
	{"syntax", "Behavior changes"},
	{"script", "Script tags"},
	{"naming", "Spelling only (prefix)"},
}

func cell(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "|", `\|`), "\n", " ")
}

func prose(s string) string {
	s = strings.ReplaceAll(cell(plain(s)), "<", "&lt;")
	return strings.ReplaceAll(s, ">", "&gt;")
}

func code(s string) string {
	if s == "" {
		return ""
	}
	return "`" + cell(plain(s)) + "`"
}

func codes(list []string) string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = code(s)
	}
	return strings.Join(out, ", ")
}

func legacyOf(r *Rule) string {
	m := r.Match
	switch r.Kind {
	case "attr":
		if len(m.Names) > 0 {
			return codes(m.Names)
		}
		return "attribute names that match the rule"
	case "attr-value":
		return codes(m.Names) + " with a matching value"
	case "event":
		return code("<id>:" + m.Name)
	case "event-prefix":
		if len(m.Names) > 0 {
			var l []string
			for _, n := range m.Names {
				l = append(l, "<id>:"+n)
			}
			return codes(l)
		}
		return "see the description"
	case "js-api":
		return code("<id>." + m.Name + "()")
	case "config":
		return code(m.Key)
	case "header":
		s := code(m.Name)
		if m.Context == "read" {
			s += " (request, read by the server)"
		}
		return s
	}
	return "see the description"
}

// RenderGuideTables renders the equivalence tables of the upgrade guide, from
// the rules, between the markers.
func RenderGuideTables(rs *RuleSet) string {
	out := []string{guideBegin, ""}
	emitted := map[string]bool{}
	for _, sec := range guideSections {
		title := sec[1]
		if emitted[title] {
			continue
		}
		emitted[title] = true
		groups := map[string]bool{}
		for _, s := range guideSections {
			if s[1] == title {
				groups[s[0]] = true
			}
		}
		var list []*Rule
		for _, r := range rs.Rules {
			if groups[r.Group] {
				list = append(list, r)
			}
		}
		if len(list) == 0 {
			continue
		}
		out = append(out, "### "+title, "", "| Rule | Markup | Severity | Legacy | YPY | What changes and what to do |", "|---|---|---|---|---|---|")
		for _, r := range list {
			out = append(out, fmt.Sprintf("| <a id=%q></a>`%s` | %s | %s | %s | %s | %s %s |",
				strings.ToLower(r.ID), r.ID, strings.Join(r.Lines, ", "), r.Severity, legacyOf(r), code(r.Native), prose(r.What), prose(r.Fix)))
		}
		out = append(out, "")
	}
	out = append(out, guideEnd)
	return strings.Join(out, "\n")
}

// UpdateGuide replaces the generated block of the guide text.
func UpdateGuide(text string, rs *RuleSet) (string, error) {
	a := strings.Index(text, guideBegin)
	b := strings.Index(text, guideEnd)
	if a == -1 || b == -1 || b < a {
		return "", fmt.Errorf("the guide needs the %s and %s markers", guideBegin, guideEnd)
	}
	return text[:a] + RenderGuideTables(rs) + text[b+len(guideEnd):], nil
}

// GenGuide rewrites the guide file; with checkOnly it only reports whether the
// file is up to date.
func GenGuide(path string, rs *RuleSet, checkOnly bool) (upToDate bool, err error) {
	cur, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	next, err := UpdateGuide(string(cur), rs)
	if err != nil {
		return false, err
	}
	if next == string(cur) {
		return true, nil
	}
	if checkOnly {
		return false, nil
	}
	return false, os.WriteFile(path, []byte(next), 0o644)
}
