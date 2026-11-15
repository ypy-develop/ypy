// SPDX-License-Identifier: MIT

package check

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
)

var skipDirs = map[string]bool{"node_modules": true, ".git": true, ".hg": true, ".svn": true, "vendor": true, "dist": true,
	"build": true, "coverage": true, ".next": true, ".nuxt": true, ".venv": true, "venv": true, "__pycache__": true,
	"target": true, ".idea": true, ".vscode": true, ".cache": true, "tmp": true}

const maxBytes = 2 * 1024 * 1024

// keepTextBytes bounds the memory used to hold the files between the learning
// pass and the scanning pass; beyond it files are read again.
const keepTextBytes = 256 << 20

var reMinified = regexp.MustCompile(`\.min\.(js|css)$`)

// Options configure a scan.
type Options struct {
	Rules *RuleSet
	// Line is "v1", "v2", "v4" or "auto" (the default).
	Line          string
	MinSeverity   string // default "aviso"
	MinConfidence string // "medium" (default, everything) or "high"
	Ignore, Only  []string
	// ExtraExt lists extensions to read as templates, with the leading dot.
	ExtraExt []string
	// IDs names the identifier(s) of the legacy markup explicitly.
	IDs []string
	// AttrPrefixes and HeaderPrefixes force the attribute and header prefixes
	// of the legacy markup when the project does not reveal them (HeaderPrefixes
	// defaults to AttrPrefixes).
	AttrPrefixes, HeaderPrefixes []string
	// MinEvidence is the number of distinct names that make a prefix learned
	// (default DefaultMinEvidence).
	MinEvidence int
	// KeepText keeps the text of every file in the analysis (for the migration).
	KeepText bool
	// Cwd makes the reported paths relative; default the working directory.
	Cwd string
}

// Report is the result of a scan; its JSON form is schema 1.
type Report struct {
	Schema       int       `json:"schema"`
	Tool         string    `json:"tool"`
	RulesVersion string    `json:"rulesVersion"`
	Line         LineInfo  `json:"line"`
	Scanned      int       `json:"scanned"`
	Summary      Summary   `json:"summary"`
	Findings     []Finding `json:"findings"`
	Warnings     []string  `json:"warnings"`
	// Legacy says which spellings of the legacy markup the scan learned.
	Legacy LegacyInfo `json:"legacy"`
}

// LegacyInfo lists the spellings of the legacy markup that a scan learned from
// the project (or was given): the attribute prefixes, the header prefixes and
// the identifiers of its global, events and classes.
type LegacyInfo struct {
	AttributePrefixes []string `json:"attributePrefixes"`
	HeaderPrefixes    []string `json:"headerPrefixes"`
	Identifiers       []string `json:"identifiers"`
}

// LineInfo says which markup generation was used and why.
type LineInfo struct {
	Requested string     `json:"requested"`
	Used      string     `json:"used"`
	Assumed   bool       `json:"assumed"`
	Evidence  []Evidence `json:"evidence"`
}

// Evidence is one sign that decided the markup generation.
type Evidence struct {
	What string  `json:"what"`
	File string  `json:"file"`
	Line int     `json:"line"`
	Rule *string `json:"rule"`
}

// Summary counts the findings.
type Summary struct {
	Quebra int `json:"quebra"`
	Muda   int `json:"muda"`
	Aviso  int `json:"aviso"`
	Total  int `json:"total"`
	Files  int `json:"files"`
}

// Finding is one legacy use.
type Finding struct {
	File       string  `json:"file"`
	Line       int     `json:"line"`
	Column     int     `json:"column"`
	Severity   string  `json:"severity"`
	Rule       string  `json:"rule"`
	Message    string  `json:"message"`
	Match      string  `json:"match"`
	Fix        *string `json:"fix"`
	Native     *string `json:"native"`
	Guide      string  `json:"guide"`
	Count      int     `json:"count"`
	Confidence string  `json:"confidence"`
}

// Identifiers lists the identifiers of the legacy markup that the scan found or
// was given.
func (r *Report) Identifiers() []string { return r.Legacy.Identifiers }

func severityRank(s string) int {
	for i, x := range Severities {
		if x == s {
			return i
		}
	}
	return -1
}

// primary is the first of the prefixes, with its hyphen, or the placeholder
// the messages show when the project has none.
func primary(prefixes []string, placeholder string) string {
	if len(prefixes) == 0 {
		return placeholder
	}
	return prefixes[0] + "-"
}

// fill writes the identifier and the prefixes into a text of the rule table.
func fill(rs *RuleSet, text, id string) string {
	text = strings.ReplaceAll(text, "{P}", id)
	text = strings.ReplaceAll(text, "{A}", primary(rs.attrPre, "<p>-"))
	return strings.ReplaceAll(text, "{H}", primary(rs.hdrPre, "<P>-"))
}

func messageOf(rs *RuleSet, r *Rule, f finding) string {
	id := f.idText
	if id == "" {
		id = "<id>"
	}
	parts := []string{fill(rs, r.What, id)}
	if f.detail != "" {
		parts = append(parts, "("+f.detail+")")
	}
	if f.count > 1 {
		parts = append(parts, fmt.Sprintf("[%d occurrences in this file]", f.count))
	}
	return strings.Join(parts, " ")
}

func guideLink(rs *RuleSet, r *Rule) string { return rs.Meta.Guide + "#" + strings.ToLower(r.ID) }

type source struct {
	path    string
	display string
	ext     string
	classes []string
	text    string // kept between the passes while the memory bound allows
}

func collectFiles(paths []string, extensions map[string]bool, warnings *[]string) []string {
	var files []string
	var visit func(p string, explicit bool)
	visit = func(p string, explicit bool) {
		st, err := os.Stat(p)
		if err != nil {
			if explicit {
				*warnings = append(*warnings, fmt.Sprintf("cannot read %s: %s", p, errCode(err)))
			}
			return
		}
		switch {
		case st.IsDir():
			// a link to a directory met while walking is not followed: it can loop (a link to ".") and it
			// can leave the project. A path the user named is followed.
			if li, err := os.Lstat(p); !explicit && err == nil && li.Mode()&os.ModeSymlink != 0 {
				return
			}
			entries, err := os.ReadDir(p)
			if err != nil {
				*warnings = append(*warnings, fmt.Sprintf("cannot read %s: %s", p, errCode(err)))
				return
			}
			for _, e := range entries {
				if skipDirs[e.Name()] {
					continue
				}
				visit(filepath.Join(p, e.Name()), false)
			}
		case st.Mode().IsRegular():
			name := filepath.Base(p)
			if !explicit && (!extensions[strings.ToLower(filepath.Ext(name))] || reMinified.MatchString(name)) {
				return
			}
			if st.Size() > maxBytes {
				*warnings = append(*warnings, fmt.Sprintf("skipped %s: larger than 2 MB", p))
				return
			}
			files = append(files, p)
		}
	}
	for _, p := range paths {
		abs, err := filepath.Abs(p)
		if err != nil {
			abs = p
		}
		visit(abs, true)
	}
	return files
}

func errCode(err error) string {
	switch {
	case os.IsNotExist(err):
		return "ENOENT"
	case os.IsPermission(err):
		return "EACCES"
	}
	return err.Error()
}

// parallel runs fn for every index on all CPUs.
func parallel(n int, fn func(i int)) {
	workers := runtime.NumCPU()
	if workers > n {
		workers = n
	}
	var wg sync.WaitGroup
	next := make(chan int)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range next {
				fn(i)
			}
		}()
	}
	for i := 0; i < n; i++ {
		next <- i
	}
	close(next)
	wg.Wait()
}

// newIDSet starts the evidence of a scan with what the options force.
func (o Options) newIDSet() *idSet {
	ids := newIDSet()
	for _, id := range o.IDs {
		ids.explicit[id] = true
	}
	for _, p := range o.AttrPrefixes {
		if p = normalizePrefix(p); validPrefix(p) {
			ids.forcedAttr = append(ids.forcedAttr, p)
		}
	}
	for _, p := range o.HeaderPrefixes {
		if p = normalizePrefix(p); validPrefix(p) {
			ids.forcedHdr = append(ids.forcedHdr, p)
		}
	}
	if o.MinEvidence > 0 {
		ids.minEvidence = o.MinEvidence
	}
	return ids
}

// analysis is a project read, learned and scanned.
type analysis struct {
	opts     Options
	srcs     []source
	results  []scanResult
	env      *env
	warnings []string
}

// Scan walks paths, learns the identifier of the legacy markup from them, applies
// the rules and builds the report.
func Scan(paths []string, opts Options) (*Report, error) {
	a, err := analyze(paths, opts)
	if err != nil {
		return nil, err
	}
	return buildReport(a.env.rs, a.opts, a.srcs, a.results, a.env, a.warnings), nil
}

// analyze reads the files under paths, learns the spellings of the legacy markup
// from them (pass 1) and applies the rules (pass 2).
func analyze(paths []string, opts Options) (*analysis, error) {
	rs := opts.Rules
	if rs == nil {
		var err error
		if rs, err = Load(); err != nil {
			return nil, err
		}
	}
	if opts.Line == "" {
		opts.Line = "auto"
	}
	if opts.MinSeverity == "" {
		opts.MinSeverity = Severities[0]
	}
	cwd := opts.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	extra := map[string]bool{}
	accepted := map[string]bool{}
	for _, list := range DefaultExtensions {
		for _, e := range list {
			accepted[e] = true
		}
	}
	for _, e := range opts.ExtraExt {
		accepted[e] = true
		extra[e] = true
	}
	var warnings []string
	paths = append([]string(nil), paths...)
	files := collectFiles(paths, accepted, &warnings)

	srcs := make([]source, len(files))
	for i, f := range files {
		rel, err := filepath.Rel(cwd, f)
		display := f
		if err == nil && rel != "" && !strings.HasPrefix(rel, "..") {
			display = filepath.ToSlash(rel)
		}
		ext := extOf(f)
		classes := classesOf(ext)
		if extra[ext] { // --ext files are read as templates, on top of what their own extension means
			if !contains(classes, clsMarkup) {
				classes = append(append([]string(nil), classes...), clsMarkup)
			}
		}
		srcs[i] = source{path: f, display: display, ext: ext, classes: classes}
	}

	// pass 1: read the files and learn the identifier of the legacy markup
	var (
		mu       sync.Mutex
		ids      = opts.newIDSet()
		readErrs = make([]string, len(srcs))
		kept     int64
	)
	parallel(len(srcs), func(i int) {
		s := &srcs[i]
		b, err := os.ReadFile(s.path)
		if err != nil {
			readErrs[i] = fmt.Sprintf("cannot read %s: %s", s.path, errCode(err))
			s.classes = nil
			return
		}
		text := string(b)
		if strings.ContainsRune(text, 0) {
			s.classes = nil
			return
		}
		local := newIDSet()
		rs.learn(text, s.ext, s.classes, local)
		mu.Lock()
		ids.merge(local)
		if kept+int64(len(text)) <= keepTextBytes {
			kept += int64(len(text))
			s.text = text
		}
		mu.Unlock()
	})
	for _, w := range readErrs {
		if w != "" {
			warnings = append(warnings, w)
		}
	}

	// pass 2: scan
	e := newEnv(rs, ids)
	results := make([]scanResult, len(srcs))
	parallel(len(srcs), func(i int) {
		s := &srcs[i]
		if len(s.classes) == 0 {
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
		if !opts.KeepText {
			s.text = ""
		}
		results[i] = e.scanFile(text, s.display, s.ext, s.classes)
	})
	return &analysis{opts: opts, srcs: srcs, results: results, env: e, warnings: warnings}, nil
}

// ScanText scans one text, learning the identifier of the legacy markup from it
// (plus the ones in opts.IDs). It is the unit the tests and editors use.
func ScanText(text, file string, opts Options) []Finding {
	rs := opts.Rules
	if rs == nil {
		var err error
		if rs, err = Load(); err != nil {
			return nil
		}
	}
	ext := extOf(file)
	classes := classesOf(ext)
	ids := opts.newIDSet()
	rs.learn(text, ext, classes, ids)
	e := newEnv(rs, ids)
	res := e.scanFile(text, file, ext, classes)
	var out []Finding
	for _, f := range res.findings {
		out = append(out, toFinding(e.rs, f, file))
	}
	return out
}

func toFinding(rs *RuleSet, f finding, file string) Finding {
	r := f.rule
	out := Finding{
		File: file, Line: f.line, Column: f.column, Severity: r.Severity, Rule: r.ID,
		Message: messageOf(rs, r, f), Match: f.match, Guide: guideLink(rs, r), Count: f.count, Confidence: f.conf,
	}
	if r.Fix != "" {
		fix := fill(rs, r.Fix, orID(f.idText))
		out.Fix = &fix
	}
	if r.Native != "" {
		n := r.Native
		out.Native = &n
	}
	return out
}

func orID(id string) string {
	if id == "" {
		return "<id>"
	}
	return id
}

// detectLine picks the markup generation from the evidence: a construct that
// only v1 markup has wins, then v2, then v4; with no signal v2 is assumed.
func detectLine(signals []signal) (line string, assumed bool, evidence []signal) {
	for _, l := range Lines {
		var by []signal
		for _, s := range signals {
			if s.line == l {
				by = append(by, s)
			}
		}
		if len(by) > 0 {
			if len(by) > 8 {
				by = by[:8]
			}
			return l, false, by
		}
	}
	return "v2", true, nil
}

func buildReport(rs *RuleSet, opts Options, srcs []source, results []scanResult, e *env, warnings []string) *Report {
	var all []Finding
	var signals []signal
	byFile := map[string][]finding{}
	for i, s := range srcs {
		if len(s.classes) == 0 {
			continue
		}
		res := results[i]
		for _, f := range res.findings {
			byFile[s.display] = append(byFile[s.display], f)
			if sig := f.rule.Signal; sig != "" {
				signals = append(signals, signal{line: sig, what: f.match, rule: f.rule.ID, file: s.display, row: f.line, col: f.column})
			}
		}
		signals = append(signals, res.signals...)
	}
	for _, s := range srcs {
		for _, f := range byFile[s.display] {
			all = append(all, toFinding(rs, f, s.display))
		}
		delete(byFile, s.display)
	}

	requested := opts.Line
	var line string
	var assumed bool
	var evidence []signal
	if requested == "auto" {
		line, assumed, evidence = detectLine(signals)
	} else {
		line = requested
	}
	minRank := severityRank(opts.MinSeverity)
	ignore := map[string]bool{}
	for _, id := range opts.Ignore {
		ignore[id] = true
	}
	only := map[string]bool{}
	for _, id := range opts.Only {
		only[id] = true
	}
	findings := []Finding{}
	for _, f := range all {
		r, _ := rs.Rule(f.Rule)
		switch {
		case !contains(r.Lines, line):
		case severityRank(r.Severity) < minRank:
		case ignore[f.Rule]:
		case len(only) > 0 && !only[f.Rule]:
		case opts.MinConfidence == ConfHigh && f.Confidence != ConfHigh:
		default:
			findings = append(findings, f)
		}
	}
	sort.SliceStable(findings, func(i, j int) bool {
		a, b := findings[i], findings[j]
		switch {
		case a.File != b.File:
			return a.File < b.File
		case a.Line != b.Line:
			return a.Line < b.Line
		case a.Column != b.Column:
			return a.Column < b.Column
		}
		return a.Rule < b.Rule
	})
	sum := Summary{Total: len(findings)}
	files := map[string]bool{}
	for _, f := range findings {
		files[f.File] = true
		switch f.Severity {
		case "quebra":
			sum.Quebra++
		case "muda":
			sum.Muda++
		case "aviso":
			sum.Aviso++
		}
	}
	sum.Files = len(files)
	ev := []Evidence{}
	for _, s := range evidence {
		x := Evidence{What: s.what, File: s.file, Line: s.row}
		if s.rule != "" {
			r := s.rule
			x.Rule = &r
		}
		ev = append(ev, x)
	}
	if warnings == nil {
		warnings = []string{}
	}
	return &Report{
		Schema: 1, Tool: "ypy-check", RulesVersion: rs.Meta.Version,
		Line:    LineInfo{Requested: requested, Used: line, Assumed: assumed, Evidence: ev},
		Scanned: len(srcs), Summary: sum, Findings: findings, Warnings: warnings,
		Legacy: LegacyInfo{AttributePrefixes: nonNil(e.attrP), HeaderPrefixes: nonNil(e.hdrP), Identifiers: nonNil(e.known)},
	}
}

func nonNil(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
