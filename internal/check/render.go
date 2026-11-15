// SPDX-License-Identifier: MIT

package check

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

func paint(on bool, code, text string) string {
	if !on {
		return text
	}
	return "\x1b[" + code + "m" + text + "\x1b[0m"
}

func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}

// RenderText prints the report for people: file:line:column, severity, rule,
// message, fix and guide link, then the summary.
func RenderText(r *Report, color bool) string {
	var out []string
	sevColor := map[string]string{"quebra": "31", "muda": "33", "aviso": "36"}
	for _, f := range r.Findings {
		note := ""
		if f.Confidence == ConfMedium {
			note = "  (medium confidence)"
		}
		out = append(out, fmt.Sprintf("%s:%d:%d  %s %s  %s%s", f.File, f.Line, f.Column,
			paint(color, sevColor[f.Severity], padRight(f.Severity, 6)), paint(color, "2", f.Rule), f.Message, note))
		if f.Fix != nil {
			out = append(out, "    fix:   "+*f.Fix)
		}
		out = append(out, "    guide: "+f.Guide)
	}
	l := r.Line
	var how string
	switch {
	case l.Requested != "auto":
		how = "requested"
	case l.Assumed:
		how = "assumed, no legacy signal found"
	default:
		var ev []string
		for i, e := range l.Evidence {
			if i == 3 {
				break
			}
			ev = append(ev, fmt.Sprintf("%s (%s:%d)", e.What, e.File, e.Line))
		}
		how = "detected from " + strings.Join(ev, ", ")
	}
	if len(r.Findings) > 0 {
		out = append(out, "")
	}
	out = append(out, fmt.Sprintf("Markup generation: %s (%s).", l.Used, how))
	s := r.Summary
	out = append(out, fmt.Sprintf("%d file(s) scanned, %d with findings: %d quebra, %d muda, %d aviso.", r.Scanned, s.Files, s.Quebra, s.Muda, s.Aviso))
	if len(r.Legacy.AttributePrefixes) > 0 {
		out = append(out, "Legacy attribute prefix(es): "+strings.Join(r.Legacy.AttributePrefixes, ", ")+".")
	}
	if len(r.Legacy.HeaderPrefixes) > 0 {
		out = append(out, "Legacy header prefix(es): "+strings.Join(r.Legacy.HeaderPrefixes, ", ")+".")
	}
	if len(r.Legacy.Identifiers) > 0 {
		out = append(out, "Legacy identifier(s) of the legacy markup: "+strings.Join(r.Legacy.Identifiers, ", ")+".")
	} else if len(r.Legacy.AttributePrefixes) > 0 {
		out = append(out, "No identifier of the legacy markup was found in the code: its script tag, classes and global are reported only once it is known. Name it with --id <name>.")
	}
	for _, w := range r.Warnings {
		out = append(out, "warning: "+w)
	}
	return strings.Join(out, "\n") + "\n"
}

// marshal writes v as indented JSON without escaping <, > and &.
func marshal(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return "{}\n"
	}
	return buf.String()
}

// RenderJSON prints the report as one JSON document (schema 1).
func RenderJSON(r *Report) string { return marshal(r) }

// RenderRules prints the rule table, as text or JSON, for one markup generation
// ("auto" lists them all).
func RenderRules(rs *RuleSet, line string, asJSON bool) string {
	var list []*Rule
	for _, r := range rs.Rules {
		if line == "auto" || contains(r.Lines, line) {
			list = append(list, r)
		}
	}
	if asJSON {
		type row struct {
			ID       string   `json:"id"`
			Lines    []string `json:"lines"`
			Severity string   `json:"severity"`
			Group    string   `json:"group"`
			Kind     string   `json:"kind"`
			What     string   `json:"what"`
			Fix      *string  `json:"fix"`
			Native   *string  `json:"native"`
		}
		doc := struct {
			Schema       int    `json:"schema"`
			Tool         string `json:"tool"`
			RulesVersion string `json:"rulesVersion"`
			Rules        []row  `json:"rules"`
		}{1, "ypy-check", rs.Meta.Version, []row{}}
		for _, r := range list {
			x := row{r.ID, r.Lines, r.Severity, r.Group, r.Kind, plain(r.What), nil, nil}
			if r.Fix != "" {
				f := plain(r.Fix)
				x.Fix = &f
			}
			if r.Native != "" {
				n := r.Native
				x.Native = &n
			}
			doc.Rules = append(doc.Rules, x)
		}
		return marshal(doc)
	}
	var b strings.Builder
	for _, r := range list {
		fmt.Fprintf(&b, "%s %s %s %s\n", padRight(r.Severity, 6), padRight(strings.Join(r.Lines, ","), 8), padRight(r.ID, 34), plain(r.What))
	}
	fmt.Fprintf(&b, "%d rule(s)\n", len(list))
	return b.String()
}

// plain writes the identifier placeholder of a rule text as "<id>".
func plain(s string) string {
	s = strings.ReplaceAll(s, "{P}", "<id>")
	s = strings.ReplaceAll(s, "{A}", "<p>-")
	return strings.ReplaceAll(s, "{H}", "<P>-")
}
