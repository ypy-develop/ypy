// SPDX-License-Identifier: MIT

package check

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// MigrateOptions configure a migration.
type MigrateOptions struct {
	// Scan holds what the scan needs: Rules, Line ("auto" or the line pinned
	// into the converted script tags), IDs, AttrPrefixes, HeaderPrefixes,
	// MinEvidence, ExtraExt and Cwd.
	Scan Options
	// Write applies the edits; without it nothing is written.
	Write bool
	// Comments also converts the recognized names inside comments.
	Comments bool
	// NoIdentifiers leaves identifiers (<P>Target, <p>_request) alone.
	NoIdentifiers bool
	// ScriptSrc replaces the URL of an external script tag of the legacy markup.
	ScriptSrc string
}

// MigrateReport is the result of a migration; its JSON form is schema 1.
type MigrateReport struct {
	Schema       int            `json:"schema"`
	Tool         string         `json:"tool"`
	RulesVersion string         `json:"rulesVersion"`
	Mode         string         `json:"mode"`
	Line         LineInfo       `json:"line"`
	Legacy       LegacyInfo     `json:"legacy"`
	Scanned      int            `json:"scanned"`
	Summary      MigrateSummary `json:"summary"`
	Files        []FileChange   `json:"files"`
	Unconverted  []Leftover     `json:"unconverted"`
	Skipped      []string       `json:"skipped"`
	Warnings     []string       `json:"warnings"`
}

// MigrateSummary counts what changed and what was left.
type MigrateSummary struct {
	Files        int            `json:"files"`
	Replacements int            `json:"replacements"`
	ByKind       map[string]int `json:"byKind"`
	Unconverted  int            `json:"unconverted"`
	Mentions     int            `json:"mentions"`
}

// FileChange is one converted file.
type FileChange struct {
	File         string         `json:"file"`
	Replacements int            `json:"replacements"`
	ByKind       map[string]int `json:"byKind"`
	Written      bool           `json:"written"`
	Diff         string         `json:"diff,omitempty"`
}

// Leftover is a place that still spells the legacy markup after the conversion:
// a comment, running text or a context the converter does not recognize.
type Leftover struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Reason string `json:"reason"`
}

const (
	reasonProse    = "comment, prose or a context that is not recognized"
	reasonExternal = "external script URL: serve the YPY build yourself or pass --script-src"
	reasonString   = "a plain string of server code: not converted unless it is an attribute, a selector or a class; edit it by hand if it names one"
	reasonNoEvent  = "no YPY event does what this legacy event did: handle it by hand"
	reasonDetail   = "detail.elt does not exist in a YPY event: read evt.target"
)

// reDetailElt finds a read of the element in the detail of an event: evt.detail.elt, detail.elt.
var reDetailElt = regexp.MustCompile(`\bdetail\s*(?:\?\.|\.)\s*elt\b|\{[^{}]*\belt\b[^{}]*\}\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*detail\b`)

// reExtensionFile is the name of a script of one of the official extensions
// of the legacy markup written with any prefix (<prefix>-sse.js, <id>-ext-ws.min.js).
var reExtensionFile = regexp.MustCompile(`^[a-z0-9]+-(?:ext-)?(?:sse|ws|head-support|preload|response-targets|class-tools|loading-states|path-params|json-enc|multi-swap|client-side-templates|alpine-morph|idiomorph|include-vals|remove-me|restored|debug|disable-element|event-header|method-override|morphdom-swap|path-deps|rails-method|ajax-header)(?:\.min)?\.m?js$`)

// vendoredFile reports whether the file is a copy of the library or of one of
// its extensions: it is replaced by the YPY file, not converted.
func (c *converter) vendoredFile(base string) bool {
	b := strings.ToLower(base)
	if !strings.HasSuffix(b, ".js") && !strings.HasSuffix(b, ".mjs") {
		return false
	}
	for _, id := range c.ids {
		if b == id+".js" || strings.HasPrefix(b, id+".") || strings.HasPrefix(b, id+"-") {
			return true
		}
	}
	if reExtensionFile.MatchString(b) {
		return true
	}
	for _, p := range c.attrP {
		if strings.HasPrefix(b, p+"-") {
			return true
		}
	}
	return false
}

// Migrate converts the files under paths.
func Migrate(paths []string, opts MigrateOptions) (*MigrateReport, error) {
	so := opts.Scan
	so.KeepText = true
	if so.Line == "" {
		so.Line = "auto"
	}
	a, err := analyze(paths, so)
	if err != nil {
		return nil, err
	}
	rep := buildReport(a.env.rs, a.opts, a.srcs, a.results, a.env, a.warnings)
	mode := "dry-run"
	if opts.Write {
		mode = "write"
	}
	out := &MigrateReport{
		Schema: 1, Tool: "ypy-migrate", RulesVersion: a.env.rs.Meta.Version, Mode: mode,
		Legacy: rep.Legacy, Scanned: rep.Scanned,
		Summary: MigrateSummary{ByKind: map[string]int{}},
		Files:   []FileChange{}, Unconverted: []Leftover{}, Skipped: []string{}, Warnings: append([]string{}, rep.Warnings...),
	}
	co := convOpts{Comments: opts.Comments, NoIdentifiers: opts.NoIdentifiers, ScriptSrc: opts.ScriptSrc}
	c := newConverter(a.env, co)
	if len(c.attrP) == 0 && len(c.hdrP) == 0 && len(c.ids) == 0 {
		out.Warnings = append(out.Warnings, "no attribute prefix, header prefix or identifier of the legacy markup was found; only the unprefixed extension attributes can be converted. Name them with --prefix, --header-prefix and --id.")
	}

	type result struct {
		change   *FileChange
		leftover []Leftover
		warn     string
		skipped  string
		write    func() error
		mentions int
	}
	results := make([]result, len(a.srcs))
	parallel(len(a.srcs), func(i int) {
		s := &a.srcs[i]
		if len(s.classes) == 0 {
			return
		}
		if c.vendoredFile(filepath.Base(s.path)) {
			results[i].skipped = s.display + ": a copy of the legacy script or of one of its extensions; replace it with the YPY file"
			return
		}
		text := s.text
		if text == "" {
			b, err := os.ReadFile(s.path)
			if err != nil {
				return
			}
			text = string(b)
		}
		edits, external := c.convert(text, s.ext, s.classes)
		next := applyEdits(text, edits)
		r := &results[i]
		if len(edits) > 0 {
			// the result must be stable: converting it again changes nothing
			if again, _ := c.convert(next, s.ext, s.classes); len(again) > 0 {
				r.warn = fmt.Sprintf("%s: a second pass would still change %d place(s); the file was left as it is", s.display, len(again))
				next = text
				edits = nil
			}
		}
		if len(edits) > 0 {
			ch := &FileChange{File: s.display, Replacements: len(edits), ByKind: map[string]int{}}
			for _, e := range edits {
				ch.ByKind[e.kind]++
			}
			ch.Diff = unifiedDiff(s.display, text, next)
			r.change = ch
			path, mode := s.path, os.FileMode(0o644)
			if st, err := os.Stat(path); err == nil {
				mode = st.Mode().Perm()
			}
			r.write = func() error { return os.WriteFile(path, []byte(next), mode) }
		}
		r.leftover = c.leftovers(next, s.display, s.ext, s.classes, external)
		r.mentions = c.mentions(next)
	})
	for _, r := range results {
		if r.skipped != "" {
			out.Skipped = append(out.Skipped, r.skipped)
		}
		if r.warn != "" {
			out.Warnings = append(out.Warnings, r.warn)
		}
		out.Unconverted = append(out.Unconverted, r.leftover...)
		out.Summary.Mentions += r.mentions
		if r.change == nil {
			continue
		}
		if opts.Write {
			if err := r.write(); err != nil {
				return nil, fmt.Errorf("cannot write %s: %w", r.change.File, err)
			}
			r.change.Written = true
		}
		out.Files = append(out.Files, *r.change)
		out.Summary.Files++
		out.Summary.Replacements += r.change.Replacements
		for k, n := range r.change.ByKind {
			out.Summary.ByKind[k] += n
		}
	}
	sort.Slice(out.Files, func(i, j int) bool { return out.Files[i].File < out.Files[j].File })
	sort.SliceStable(out.Unconverted, func(i, j int) bool {
		x, y := out.Unconverted[i], out.Unconverted[j]
		if x.File != y.File {
			return x.File < y.File
		}
		return x.Line < y.Line
	})
	sort.Strings(out.Skipped)
	out.Summary.Unconverted = len(out.Unconverted)
	return out, nil
}

// leftovers lists what still spells the legacy markup in the converted text.
func (c *converter) leftovers(text, display, ext string, classes []string, external []edit) []Leftover {
	f := &fileConv{c: c, text: text}
	f.kebab(0, len(text), true)
	f.idents(0, len(text))
	f.globals(0, len(text), false)
	var out []Leftover
	loc := newLocator(text)
	for _, e := range normalize(f.edits) {
		line, _ := loc.at(e.start)
		kind := e.kind
		s, t := e.start, e.end
		for s > 0 && (isWordByte(text[s-1]) || text[s-1] == '-' || text[s-1] == ':') {
			s--
		}
		for t < len(text) && (isWordByte(text[t]) || text[t] == '-' || text[t] == ':') {
			t++
		}
		reason := reasonProse
		if serverOnly(classes) && (kind == kAttribute || kind == kClass || kind == kExtension || kind == kConfig) {
			reason = reasonString
		}
		out = append(out, Leftover{File: display, Line: line, Kind: kind, Text: clipText(text[s:t], 60), Reason: reason})
	}
	for _, e := range f.noEquiv {
		line, _ := loc.at(e.start)
		out = append(out, Leftover{File: display, Line: line, Kind: kEvent, Text: clipText(e.repl, 60), Reason: reasonNoEvent})
	}
	if contains(classes, clsMarkup) || contains(classes, clsScript) {
		for _, m := range reDetailElt.FindAllStringIndex(text, -1) {
			line, _ := loc.at(m[0])
			out = append(out, Leftover{File: display, Line: line, Kind: kEvent, Text: clipText(text[m[0]:m[1]], 60), Reason: reasonDetail})
		}
	}
	for _, e := range external {
		line, _ := loc.at(e.start)
		out = append(out, Leftover{File: display, Line: line, Kind: kScript, Text: clipText(e.repl, 80), Reason: reasonExternal})
	}
	return out
}

func clipText(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// mentions counts the lines that name the legacy markup in words.
func (c *converter) mentions(text string) int {
	if len(c.ids) == 0 {
		return 0
	}
	q := make([]string, len(c.ids))
	for i, id := range c.ids {
		q[i] = regexp.QuoteMeta(id)
	}
	re := regexp.MustCompile(`(?i)\b(?:` + strings.Join(q, "|") + `)\b`)
	n := 0
	for _, line := range strings.Split(text, "\n") {
		if re.MatchString(line) {
			n++
		}
	}
	return n
}

// Diff returns the unified diff of one converted file ("" when it did not change).
func (r *MigrateReport) Diff(file string) string {
	for _, f := range r.Files {
		if f.File == file {
			return f.Diff
		}
	}
	return ""
}

// unified diff -------------------------------------------------------------------

// unifiedDiff renders the difference between a and b as a unified diff with 3
// lines of context. Lines are compared exactly; the changed middle part is
// aligned with a longest-common-subsequence table.
func unifiedDiff(name, a, b string) string {
	if a == b {
		return ""
	}
	al := splitLines(a)
	bl := splitLines(b)
	pre := 0
	for pre < len(al) && pre < len(bl) && al[pre] == bl[pre] {
		pre++
	}
	suf := 0
	for suf < len(al)-pre && suf < len(bl)-pre && al[len(al)-1-suf] == bl[len(bl)-1-suf] {
		suf++
	}
	am, bm := al[pre:len(al)-suf], bl[pre:len(bl)-suf]
	type op struct {
		kind byte // ' ', '-', '+'
		text string
	}
	var ops []op
	for _, l := range al[:pre] {
		ops = append(ops, op{' ', l})
	}
	if len(am)*len(bm) > 4_000_000 {
		for _, l := range am {
			ops = append(ops, op{'-', l})
		}
		for _, l := range bm {
			ops = append(ops, op{'+', l})
		}
	} else {
		n, m := len(am), len(bm)
		t := make([][]int32, n+1)
		for i := range t {
			t[i] = make([]int32, m+1)
		}
		for i := n - 1; i >= 0; i-- {
			for j := m - 1; j >= 0; j-- {
				if am[i] == bm[j] {
					t[i][j] = t[i+1][j+1] + 1
				} else if t[i+1][j] >= t[i][j+1] {
					t[i][j] = t[i+1][j]
				} else {
					t[i][j] = t[i][j+1]
				}
			}
		}
		i, j := 0, 0
		for i < n && j < m {
			switch {
			case am[i] == bm[j]:
				ops = append(ops, op{' ', am[i]})
				i++
				j++
			case t[i+1][j] >= t[i][j+1]:
				ops = append(ops, op{'-', am[i]})
				i++
			default:
				ops = append(ops, op{'+', bm[j]})
				j++
			}
		}
		for ; i < n; i++ {
			ops = append(ops, op{'-', am[i]})
		}
		for ; j < m; j++ {
			ops = append(ops, op{'+', bm[j]})
		}
	}
	for _, l := range al[len(al)-suf:] {
		ops = append(ops, op{' ', l})
	}
	// hunks
	const ctx = 3
	var out strings.Builder
	fmt.Fprintf(&out, "--- a/%s\n+++ b/%s\n", name, name)
	aLine, bLine := 1, 1
	type pos struct{ a, b int }
	at := make([]pos, len(ops)+1)
	for i, o := range ops {
		at[i] = pos{aLine, bLine}
		if o.kind != '+' {
			aLine++
		}
		if o.kind != '-' {
			bLine++
		}
	}
	at[len(ops)] = pos{aLine, bLine}
	var changes []int
	for i, o := range ops {
		if o.kind != ' ' {
			changes = append(changes, i)
		}
	}
	for g := 0; g < len(changes); {
		first, last := changes[g], changes[g]
		g++
		for g < len(changes) && changes[g]-last-1 <= 2*ctx {
			last = changes[g]
			g++
		}
		start, stop := first-ctx, last+1+ctx
		if start < 0 {
			start = 0
		}
		if stop > len(ops) {
			stop = len(ops)
		}
		aCount, bCount := 0, 0
		for _, o := range ops[start:stop] {
			if o.kind != '+' {
				aCount++
			}
			if o.kind != '-' {
				bCount++
			}
		}
		aStart, bStart := at[start].a, at[start].b
		if aCount == 0 {
			aStart--
		}
		if bCount == 0 {
			bStart--
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", aStart, aCount, bStart, bCount)
		for _, o := range ops[start:stop] {
			out.WriteByte(o.kind)
			out.WriteString(o.text)
			out.WriteByte('\n')
		}
	}
	return out.String()
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := strings.Split(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}
