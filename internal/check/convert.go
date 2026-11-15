// SPDX-License-Identifier: MIT

package check

// The converter: it finds, in one file, the places where the legacy markup is
// spelled and returns the edits that write them the YPY way. It reads files as
// text, like the scanner, and edits only in a context it recognizes: an
// attribute inside a tag, a string literal, a selector, a template expression.
// Running text, comments (unless asked) and anything it cannot place are left
// alone and reported by the caller.

import (
	"regexp"
	"sort"
	"strings"
)

// edit replaces text[start:end] with repl.
type edit struct {
	start, end int
	repl       string
	kind       string
}

// Kinds of edit, as they appear in the report.
const (
	kAttribute  = "attribute"
	kHeader     = "header"
	kEvent      = "event"
	kClass      = "class"
	kGlobal     = "global"
	kIdentifier = "identifier"
	kScript     = "script"
	kPartial    = "partial"
	kExtension  = "extension"
	kConfig     = "config"
)

// Kinds lists the kinds of edit, in report order.
var Kinds = []string{kAttribute, kHeader, kEvent, kClass, kGlobal, kIdentifier, kScript, kExtension, kPartial, kConfig}

// convOpts are the options of a conversion.
type convOpts struct {
	// Comments also converts the recognized names inside comments.
	Comments bool
	// NoIdentifiers leaves identifiers (a prefix word in front of a name: <P>Target, <p>_request) alone.
	NoIdentifiers bool
	// ScriptSrc replaces the URL of an external script tag of the legacy markup.
	ScriptSrc string
}

// converter holds what a conversion knows about the project.
type converter struct {
	e      *env
	opts   convOpts
	attrP  []string
	hdrP   []string
	identP []string
	ids    []string
	suffix map[string]bool
	// importRe finds a module import of the legacy markup.
	importRe *regexp.Regexp
}

func newConverter(e *env, opts convOpts) *converter {
	c := &converter{e: e, opts: opts, attrP: e.attrP, hdrP: e.hdrP, ids: e.known, suffix: map[string]bool{}}
	c.importRe = importPattern(e.known)
	seen := map[string]bool{}
	for _, p := range append(append([]string(nil), e.attrP...), e.hdrP...) {
		if len(p) >= 2 && !seen[p] {
			seen[p] = true
			c.identP = append(c.identP, p)
		}
	}
	for _, r := range e.rs.classRules {
		for _, s := range r.Match.Suffixes {
			c.suffix[s] = true
		}
	}
	return c
}

// modes of a token pass
const (
	mKebab = 1 << iota
	mIdent
	mGlobal
	mBare
	mAnywhere
)

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

func containsFold(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}

func isUpperWord(s string) bool { return s != strings.ToLower(s) }

// fileConv converts one file.
type fileConv struct {
	c        *converter
	text     string
	edits    []edit
	noGlobal bool
	// goFile marks Go source, where IsACME-style predicates are renamed too.
	goFile bool
	// strLit is set while a string literal of a programming language is read: a backslash written
	// in a selector inside it must itself be escaped.
	strLit bool
	// external collects the script tags with a URL it cannot rewrite.
	external []edit
	// strict marks server code that is no template (Go, Python, Ruby...): a name inside one of its
	// strings is converted only where an attribute, a selector or a class belongs.
	strict bool
	// noEquiv collects the events of the legacy markup that YPY has no equivalent for.
	noEquiv []edit
	// renames maps every whole identifier this file renames to its new name.
	renames map[string]string
}

func (f *fileConv) add(start, end int, repl, kind string) {
	if start < 0 || end > len(f.text) || start > end {
		return
	}
	if f.text[start:end] == repl {
		return
	}
	f.edits = append(f.edits, edit{start, end, repl, kind})
}

// tokens runs the passes of mode over text[lo:hi].
func (f *fileConv) tokens(lo, hi, mode int) {
	if lo >= hi {
		return
	}
	if mode&mKebab != 0 {
		f.kebab(lo, hi, mode&mAnywhere != 0)
	}
	if mode&mIdent != 0 && !f.c.opts.NoIdentifiers {
		f.idents(lo, hi)
	}
	if mode&mGlobal != 0 && !f.noGlobal {
		f.globals(lo, hi, mode&mBare != 0)
	}
}

// knownAttr reports whether name (after the prefix) is an attribute of the
// request vocabulary.
func knownAttr(name string) bool { return attrStem(name) != "" }

func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

// kebab converts the dashed names inside text[lo:hi]: attributes, headers,
// extension script names, state classes, event prefixes and the script file of
// the legacy markup.
func (f *fileConv) kebab(lo, hi int, anywhere bool) {
	c := f.c
	text := f.text
	runs(text[lo:hi], func(run string, rel int) {
		start := lo + rel
		f.events(run, start)
		end := start + len(run)
		if run[0] == '-' || run[0] == ':' || run[0] == '*' {
			return
		}
		core := strings.TrimRight(run, ":")
		prev := byte(0)
		if start > 0 {
			prev = text[start-1]
		}
		next := byte(0)
		if end < len(text) {
			next = text[end]
		}
		quotedExact := (prev == '"' || prev == '\'' || prev == '`') && next == prev
		dataLen := 0
		if hasPrefixFold(core, "data-") {
			dataLen = 5
		}
		rest := core[dataLen:]
		low := strings.ToLower(rest)
		// in a string of server code a name is converted only in an attribute context
		inContext := !f.strict || !f.strLit || attributeContext(text, start, start+len(core))

		// attributes of the old extensions that carry no prefix
		if to, ok := legacyUnprefixed[low]; ok && inContext && (prev == '[' || quotedExact || next == '=' || anywhere) {
			if prev == '[' && strings.Contains(to, ":") {
				// the colon of ypy-sse:connect is escaped in a selector (and the backslash again in a string)
				esc := `\:`
				if f.strLit {
					esc = `\\:`
				}
				to = strings.Replace(to, ":", esc, 1)
			}
			f.add(start+dataLen, start+len(core), to, kAttribute)
			return
		}
		if cdash := strings.IndexByte(rest, '-'); cdash > 0 {
			word, name := rest[:cdash], rest[cdash+1:]
			wl := strings.ToLower(word)
			nameBase := name
			if k := strings.IndexByte(nameBase, ':'); k >= 0 {
				nameBase = nameBase[:k]
			}
			switch {
			case isUpperWord(word) && dataLen == 0:
				// a header: Prefix-Name, with capitals
				if containsFold(c.hdrP, wl) && headerStemSet[strings.ToLower(name)] {
					f.add(start, start+len(word), matchCase(word, "ypy"), kHeader)
					return
				}
			case containsFold(c.attrP, wl) && name != "" && isLetter(name[0]):
				after := text[end:]
				script := strings.HasPrefix(after, ".js") || strings.HasPrefix(after, ".min.js") || strings.HasPrefix(after, ".mjs")
				if (knownAttr(name) && inContext) || script {
					f.add(start+dataLen, start+dataLen+len(word), "ypy", kAttribute)
					f.onEvent(name, start+dataLen+len(word)+1)
					return
				}
				if dataLen == 0 && containsFold(c.hdrP, wl) && headerStemSet[strings.ToLower(nameBase)] {
					f.add(start, start+len(word), "ypy", kHeader)
					return
				}
			case dataLen == 0 && containsFold(c.hdrP, wl) && headerStemSet[strings.ToLower(nameBase)]:
				f.add(start, start+len(word), "ypy", kHeader)
				return
			}
			if dataLen == 0 && containsFold(c.ids, wl) && word == wl && inContext {
				switch {
				case c.suffix[name]:
					f.add(start, start+len(word), "ypy", kClass)
					return
				case strings.HasPrefix(name, "ext-") && len(name) > 4:
					f.add(start, start+len(word)+1+4, "ypy-", kExtension)
					return
				case name == "config" && (quotedExact || prev == '"' || prev == '\'' || anywhere):
					f.add(start, start+len(word), "ypy", kConfig)
					return
				}
			}
		}
		// the script file of the previous library: <id>.min.js
		if dataLen == 0 && containsFold(c.ids, core) && core == strings.ToLower(core) {
			after := text[end:]
			switch {
			case strings.HasPrefix(after, ".min.js") && !followsWord(after, 7):
				f.add(start, end+7, "ypy.min.js", kScript)
				return
			case strings.HasPrefix(after, ".js") && !followsWord(after, 3):
				f.add(start, end+3, "ypy.js", kScript)
				return
			}
		}
	})
}

// legacyEvent looks up the event named by the start of name in the rule table. It returns the
// entry and the length of the name it read.
func (c *converter) legacyEvent(name string) (eventEntry, int, bool) {
	if u := strings.IndexByte(name, '_'); u >= 0 {
		name = name[:u]
	}
	// "xhr:loadstart" has a colon in its name: try two segments, then one
	segs := strings.Split(name, ":")
	for n := min(len(segs), 2); n >= 1; n-- {
		cand := strings.Join(segs[:n], ":")
		if cand == "" {
			continue
		}
		if en, ok := c.e.rs.events[normalizeEvent(cand)]; ok && en.rule != nil && en.rule.Kind == "event" {
			return en, len(cand), true
		}
	}
	return eventEntry{}, 0, false
}

// nativeEvent returns the YPY event that replaces the legacy event written at the start of name
// and the length of the name it read. known is false when the name is not a legacy event; equiv
// is false when it is one that YPY has no equivalent for.
func (c *converter) nativeEvent(name string) (native string, n int, known, equiv bool) {
	en, n, found := c.legacyEvent(name)
	if !found {
		return "", 0, false, false
	}
	native = en.rule.Native
	if i := strings.IndexByte(native, ' '); i >= 0 {
		native = native[:i]
	}
	if !strings.HasPrefix(native, "ypy:") || strings.ContainsAny(native, "()<>") {
		return "", n, true, false
	}
	return native, n, true, true
}

// events converts the event prefixes of a run: <id>:name, also in the middle of a run
// (<p>-on:<id>:name). A name that the legacy markup spelled differently is written the way YPY
// emits it (<id>:afterSwap becomes ypy:after:swap); a name with no equivalent is left alone. A
// "ypy:" prefix in front of a legacy name (what an earlier migration wrote) is repaired.
func (f *fileConv) events(run string, start int) {
	if strings.IndexByte(run, ':') < 0 {
		return
	}
	pos := 0
	for _, seg := range strings.Split(run, ":") {
		segEnd := pos + len(seg)
		isID := seg != "" && containsFold(f.c.ids, seg) && seg == strings.ToLower(seg)
		isYpy := seg == "ypy"
		if (isID || isYpy) && segEnd+1 < len(run) && isLetter(run[segEnd+1]) {
			name := run[segEnd+1:]
			native, n, known, equiv := f.c.nativeEvent(name)
			switch {
			case known && equiv:
				if native != "ypy:"+name[:n] {
					f.add(start+pos, start+segEnd+1+n, native, kEvent)
				}
			case known:
				f.noEquiv = append(f.noEquiv, edit{start + pos, start + segEnd + 1 + n, run[pos : segEnd+1+n], kEvent})
			case isID:
				f.add(start+pos, start+segEnd, "ypy", kEvent)
			}
		}
		pos = segEnd + 1
	}
}

// onEvent converts the event of an "on" attribute: tail is the attribute name after the prefix and
// its hyphen ("on::after-swap", "on-bolt-after-swap"), found at text offset base.
func (f *fileConv) onEvent(tail string, base int) {
	low := strings.ToLower(tail)
	if strings.HasPrefix(low, "on::") {
		name := tail[4:]
		if native, n, known, equiv := f.c.nativeEvent(name); known && equiv {
			if short := strings.TrimPrefix(native, "ypy:"); short != name[:n] {
				f.add(base+4, base+4+n, short, kEvent)
			}
		}
		return
	}
	m := reOnID.FindStringSubmatchIndex(low)
	if m == nil || !containsFold(f.c.ids, low[m[2]:m[3]]) {
		return
	}
	if native, n, known, equiv := f.c.nativeEvent(tail[m[1]:]); known && equiv {
		// on-<id>-after-swap becomes on::after:swap
		f.add(base+2, base+m[1]+n, "::"+strings.TrimPrefix(native, "ypy:"), kEvent)
		return
	}
	f.add(base+m[2], base+m[3], "ypy", kEvent)
}

var reOnID = regexp.MustCompile(`^on-([a-z][a-z0-9]*)-`)

// followsWord reports whether the character at after[n] continues a word.
func followsWord(after string, n int) bool {
	return n < len(after) && (isWordByte(after[n]) || after[n] == '-')
}

// idents renames the identifiers that spell a prefix in front of a name of the
// vocabulary (<P>Target, <p>On, <p>_request, HTTP_<P>_REQUEST).
func (f *fileConv) idents(lo, hi int) {
	if len(f.c.identP) == 0 {
		return
	}
	text := f.text
	for i := lo; i < hi; {
		ch := text[i]
		if !(isLetter(ch) || ch == '_' || ch == '$') {
			i++
			continue
		}
		j := i
		for j < hi && (isWordByte(text[j]) || text[j] == '$') {
			j++
		}
		hits := identPrefixHits(text[i:j], f.c.identP)
		if f.goFile {
			hits = append(hits, identTailHits(text[i:j], f.c.identP)...)
		}
		for _, w := range hits {
			f.add(i+w.start, i+w.end, matchCase(w.text, "ypy"), kIdentifier)
		}
		if len(hits) > 0 {
			f.noteRename(text[i:j], hits)
		}
		i = j
	}
}

// noteRename records that the identifier tok is renamed as a whole.
func (f *fileConv) noteRename(tok string, hits []word) {
	sort.Slice(hits, func(a, b int) bool { return hits[a].start < hits[b].start })
	var b strings.Builder
	pos := 0
	for _, w := range hits {
		if w.start < pos {
			continue
		}
		b.WriteString(tok[pos:w.start])
		b.WriteString(matchCase(w.text, "ypy"))
		pos = w.end
	}
	b.WriteString(tok[pos:])
	if f.renames == nil {
		f.renames = map[string]string{}
	}
	f.renames[tok] = b.String()
}

// renameIdentifiers renames, in text, every whole identifier of the project-wide map that is still
// spelled the old way: a declaration in a place the converter does not read as code (the header
// of a templ component, text between tags) must follow its uses, or only half of the identifier
// would change and the build break.
func renameIdentifiers(text string, renames map[string]string) (string, int) {
	if len(renames) == 0 {
		return text, 0
	}
	var b strings.Builder
	n, pos := 0, 0
	for i := 0; i < len(text); {
		ch := text[i]
		if !(isLetter(ch) || ch == '_' || ch == '$') {
			i++
			continue
		}
		j := i
		for j < len(text) && (isWordByte(text[j]) || text[j] == '$') {
			j++
		}
		if to, ok := renames[text[i:j]]; ok {
			b.WriteString(text[pos:i])
			b.WriteString(to)
			pos = j
			n++
		}
		i = j
	}
	if n == 0 {
		return text, 0
	}
	b.WriteString(text[pos:])
	return b.String(), n
}

var skipMembers = map[string]bool{"org": true, "js": true, "min": true, "esm": true, "max": true}

// globals renames the global object of the legacy markup. In a string only
// "<id>.member" and "window.<id>" count; in code (bare) any reference does.
func (f *fileConv) globals(lo, hi int, bare bool) {
	text := f.text
	for _, id := range f.c.ids {
		for pos := lo; pos < hi; {
			k := strings.Index(text[pos:hi], id)
			if k < 0 {
				break
			}
			s := pos + k
			e := s + len(id)
			pos = e
			if s > 0 && (isWordByte(text[s-1]) || text[s-1] == '$' || text[s-1] == '-' || text[s-1] == '/' || text[s-1] == '@' || text[s-1] == ':') {
				continue
			}
			windowed := false
			if s > 0 && text[s-1] == '.' {
				if !(strings.HasSuffix(text[:s], "window.") || strings.HasSuffix(text[:s], "globalThis.") || strings.HasSuffix(text[:s], "self.")) {
					continue
				}
				windowed = true
			}
			if e < len(text) && (isWordByte(text[e]) || text[e] == '$' || text[e] == '-' || text[e] == ':' || text[e] == '/') {
				continue
			}
			member := ""
			if e < len(text) && text[e] == '.' {
				m := e + 1
				for m < len(text) && (isWordByte(text[m]) || text[m] == '$') {
					m++
				}
				member = text[e+1 : m]
				if member == "" || skipMembers[member] {
					continue
				}
			}
			if member != "" || windowed || bare {
				f.add(s, e, "ypy", kGlobal)
			}
		}
	}
}

// lexing -----------------------------------------------------------------------

type segKind int

const (
	segCode segKind = iota
	segString
	segComment
)

type seg struct {
	start, end int
	kind       segKind
}

type lexLang struct {
	line     []string
	block    bool
	quotes   string
	template bool // `...${code}...`
	triple   bool
	// selectors marks style sheets: names in code are selectors, so they are
	// converted too.
	selectors bool
}

var (
	langGo     = lexLang{line: []string{"//"}, block: true, quotes: "\"`'"}
	langJS     = lexLang{line: []string{"//"}, block: true, quotes: "\"'`", template: true}
	langJava   = lexLang{line: []string{"//"}, block: true, quotes: "\"'"}
	langRust   = lexLang{line: []string{"//"}, block: true, quotes: "\""}
	langCSS    = lexLang{block: true, quotes: "\"'", selectors: true}
	langSCSS   = lexLang{line: []string{"//"}, block: true, quotes: "\"'", selectors: true}
	langPython = lexLang{line: []string{"#"}, quotes: "\"'", triple: true}
	langRuby   = lexLang{line: []string{"#"}, quotes: "\"'"}
	langPHP    = lexLang{line: []string{"//", "#"}, block: true, quotes: "\"'"}
	langTmpl   = lexLang{quotes: "\"'`"}
)

func langOf(ext string) (lexLang, bool) {
	switch ext {
	case ".go", ".kyse.go":
		return langGo, true
	case ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx":
		return langJS, true
	case ".java", ".kt", ".cs":
		return langJava, true
	case ".rs":
		return langRust, true
	case ".css":
		return langCSS, true
	case ".scss", ".sass", ".less":
		return langSCSS, true
	case ".py":
		return langPython, true
	case ".rb", ".ex", ".exs":
		return langRuby, true
	case ".php", ".phtml":
		return langPHP, true
	}
	return lexLang{}, false
}

// lex splits text[lo:hi] into code, string and comment segments.
func lex(text string, lo, hi int, lang lexLang) []seg {
	var out []seg
	emit := func(s, e int, k segKind) {
		if e > s {
			out = append(out, seg{s, e, k})
		}
	}
	codeStart := lo
	i := lo
	for i < hi {
		c := text[i]
		// comments
		if lang.block && c == '/' && i+1 < hi && text[i+1] == '*' {
			emit(codeStart, i, segCode)
			e := strings.Index(text[i+2:hi], "*/")
			end := hi
			if e >= 0 {
				end = i + 2 + e + 2
			}
			emit(i, end, segComment)
			i, codeStart = end, end
			continue
		}
		isLine := false
		for _, l := range lang.line {
			if strings.HasPrefix(text[i:hi], l) {
				isLine = true
			}
		}
		if isLine {
			emit(codeStart, i, segCode)
			e := strings.IndexByte(text[i:hi], '\n')
			end := hi
			if e >= 0 {
				end = i + e
			}
			emit(i, end, segComment)
			i, codeStart = end, end
			continue
		}
		if strings.IndexByte(lang.quotes, c) >= 0 {
			emit(codeStart, i, segCode)
			end, parts := readString(text, i, hi, lang)
			if parts == nil {
				emit(i, end, segString)
			} else {
				for _, p := range parts {
					emit(p.start, p.end, p.kind)
				}
			}
			i, codeStart = end, end
			continue
		}
		i++
	}
	emit(codeStart, hi, segCode)
	return out
}

// readString reads the string literal that starts at i and returns its end.
// For a JavaScript template literal it also returns its parts: the text and
// the ${code} expressions.
func readString(text string, i, hi int, lang lexLang) (int, []seg) {
	q := text[i]
	if lang.triple && i+2 < hi && text[i+1] == q && text[i+2] == q {
		e := strings.Index(text[i+3:hi], string([]byte{q, q, q}))
		if e < 0 {
			return hi, nil
		}
		return i + 3 + e + 3, nil
	}
	multiline := q == '`'
	var parts []seg
	partStart := i
	j := i + 1
	for j < hi {
		ch := text[j]
		switch {
		case ch == '\\' && q != '`' || ch == '\\' && lang.template:
			j += 2
			continue
		case ch == q:
			if parts != nil {
				parts = append(parts, seg{partStart, j + 1, segString})
				return j + 1, parts
			}
			return j + 1, nil
		case ch == '\n' && !multiline:
			return j, nil
		case q == '`' && lang.template && ch == '$' && j+1 < hi && text[j+1] == '{':
			parts = append(parts, seg{partStart, j, segString})
			depth := 0
			k := j + 1
			for ; k < hi; k++ {
				if text[k] == '{' {
					depth++
				} else if text[k] == '}' {
					depth--
					if depth == 0 {
						break
					}
				}
			}
			parts = append(parts, seg{j + 2, k, segCode})
			j = k + 1
			partStart = j
			continue
		}
		j++
	}
	if parts != nil {
		parts = append(parts, seg{partStart, hi, segString})
		return hi, parts
	}
	return hi, nil
}

// lexRange converts the segments of a code range written in lang.
func (f *fileConv) lexRange(lo, hi int, lang lexLang, bareGlobal bool) {
	for _, s := range lex(f.text, lo, hi, lang) {
		switch s.kind {
		case segString:
			f.strLit = !lang.selectors
			f.tokens(s.start, s.end, mKebab|mIdent|mGlobal)
			f.strLit = false
		case segComment:
			mode := mIdent
			if f.c.opts.Comments {
				mode |= mKebab | mGlobal
			}
			f.tokens(s.start, s.end, mode)
		default:
			mode := mIdent
			if bareGlobal {
				mode |= mGlobal | mBare
			}
			if lang.selectors {
				mode |= mKebab // selectors
			}
			f.tokens(s.start, s.end, mode)
		}
	}
}

// templates ----------------------------------------------------------------------

type spanKind int

const (
	spComment spanKind = iota
	spCode
	spPHP
	spERB
	spGo
)

type span struct {
	start, end int
	kind       spanKind
}

// templateSpans finds the regions of text that are template syntax, the same
// ones maskTemplates blanks.
func templateSpans(text, ext string) []span {
	var spans []span
	t := text
	find := func(re *regexp.Regexp, kind spanKind) {
		for _, m := range re.FindAllStringIndex(t, -1) {
			spans = append(spans, span{m[0], m[1], kind})
		}
		t = replaceAll(re, t, "")
	}
	find(reTwigComment, spComment)
	find(reBladeComment, spComment)
	find(reGoComment, spComment)
	find(reStatement, spCode)
	find(reRawEcho, spCode)
	find(reEcho, spCode)
	find(reERB, spERB)
	for _, m := range rePHP.FindAllStringIndex(t, -1) {
		spans = append(spans, span{m[0], m[1], spPHP})
	}
	t = rePHP.ReplaceAllStringFunc(t, func(b string) string { return blank(b, "") })
	if reKyseExt.MatchString(ext) {
		find(reGoBlock, spGo)
		// Blade directives: name and balanced parentheses
		masked := maskDirectives(t)
		start := -1
		for i := 0; i <= len(t); i++ {
			diff := i < len(t) && t[i] != masked[i]
			switch {
			case diff && start < 0:
				start = i
			case !diff && start >= 0:
				spans = append(spans, span{start, i, spCode})
				start = -1
			}
		}
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	return spans
}

// markup ------------------------------------------------------------------------

var (
	reComment = regexp.MustCompile(`<!--[\s\S]*?-->`)
)

// importPattern finds an import or require of a module named after the legacy markup.
func importPattern(ids []string) *regexp.Regexp {
	if len(ids) == 0 {
		return nil
	}
	q := make([]string, len(ids))
	for i, id := range ids {
		q[i] = regexp.QuoteMeta(id)
	}
	return regexp.MustCompile(`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@?(?:` + strings.Join(q, "|") + `)(?:\.org)?["'/.@-]`)
}

// markup converts a template or markup file.
func (f *fileConv) markup(ext string) {
	c := f.c
	text := f.text
	masked := maskTemplates(text, ext)
	spans := templateSpans(text, ext)
	for _, s := range spans {
		switch s.kind {
		case spComment:
			mode := mIdent
			if c.opts.Comments {
				mode |= mKebab | mGlobal
			}
			f.tokens(s.start, s.end, mode)
		case spPHP:
			f.lexRange(s.start, s.end, langPHP, false)
		case spERB:
			f.lexRange(s.start, s.end, langRuby, false)
		case spGo:
			f.lexRange(s.start, s.end, langGo, false)
		default:
			f.lexRange(s.start, s.end, langTmpl, false)
		}
	}
	if c.opts.Comments {
		for _, m := range reComment.FindAllStringIndex(masked, -1) {
			f.tokens(m[0], m[1], mKebab|mIdent|mGlobal)
		}
	}
	if !reTagStart.MatchString(masked) {
		return
	}
	// <P-partial> tags
	if len(c.attrP) > 0 {
		re := regexp.MustCompile(`(?i)</?(` + strings.TrimSuffix(strings.TrimPrefix(prefixAlt(c.attrP, ""), "(?:"), ")") + `)-partial[\s/>]`)
		for _, m := range re.FindAllStringSubmatchIndex(masked, -1) {
			f.add(m[2], m[3], "ypy", kPartial)
		}
	}
	root := parseMarkup(masked)
	walk(root, func(nd *node) {
		for _, a := range nd.attrs {
			f.attribute(nd, a)
		}
		switch {
		case nd.tag == "script" && nd.hasRaw && !hasAttr(nd, "src"):
			f.lexRange(nd.rawStart, nd.rawEnd, langJS, true)
		case nd.tag == "style" && nd.hasRaw:
			f.lexRange(nd.rawStart, nd.rawEnd, langCSS, false)
		}
	})
}

func hasAttr(nd *node, name string) bool {
	for _, a := range nd.attrs {
		if strings.EqualFold(a.name, name) {
			return true
		}
	}
	return false
}

var preloadValues = map[string]bool{"mouseover": true, "mousedown": true, "always": true, "init": true, "touchstart": true}

// attribute converts the name and the value of one attribute of a tag.
func (f *fileConv) attribute(nd *node, a attr) {
	c := f.c
	name := a.name
	dataLen := 0
	if hasPrefixFold(name, "data-") {
		dataLen = 5
	}
	rest := name[dataLen:]
	low := strings.ToLower(rest)
	switch {
	case legacyUnprefixed[low] != "":
		f.add(a.offset+dataLen, a.offset+len(name), legacyUnprefixed[low], kAttribute)
	case low == "preload" && !(nd.tag == "video" || nd.tag == "audio" || nd.tag == "link") && preloadValues[strings.ToLower(strings.TrimSpace(a.value))]:
		f.add(a.offset+dataLen, a.offset+len(name), "ypy-preload", kExtension)
	default:
		if cd := strings.IndexByte(rest, '-'); cd > 0 && cd+1 < len(rest) && isLetter(rest[cd+1]) && containsFold(c.attrP, rest[:cd]) {
			f.add(a.offset+dataLen, a.offset+dataLen+cd, "ypy", kAttribute)
			f.onEvent(rest[cd+1:], a.offset+dataLen+cd+1)
		}
	}
	f.events(name, a.offset)
	if !a.hasValue || a.valueOffset < 0 {
		return
	}
	lo, hi := a.valueOffset, a.valueOffset+len(a.value)
	if nd.tag == "script" && low == "src" {
		f.scriptSrc(nd, a, lo, hi)
		return
	}
	f.tokens(lo, hi, mKebab|mIdent|mGlobal)
}

var reExternal = regexp.MustCompile(`^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?//`)

// scriptSrc converts the src of a script tag. A local file of the legacy markup
// is renamed; an external URL is rewritten only when a replacement is given.
func (f *fileConv) scriptSrc(nd *node, a attr, lo, hi int) {
	c := f.c
	before := len(f.edits)
	f.tokens(lo, hi, mKebab)
	added := append([]edit(nil), f.edits[before:]...)
	f.edits = f.edits[:before]
	isLib := false
	for _, id := range c.ids {
		if re := c.e.scriptLib[id]; re != nil && re.MatchString(a.value) {
			isLib = true
		}
	}
	if len(added) == 0 && !isLib {
		return
	}
	if reExternal.MatchString(a.value) {
		if c.opts.ScriptSrc != "" {
			f.add(lo, hi, c.opts.ScriptSrc, kScript)
			f.dropIntegrity(nd)
		} else {
			f.external = append(f.external, edit{lo, hi, a.value, kScript})
		}
		return
	}
	lib := false
	for _, e := range added {
		f.edits = append(f.edits, e)
		lib = lib || e.kind == kScript
	}
	if lib {
		f.dropIntegrity(nd)
	}
}

func (f *fileConv) dropIntegrity(nd *node) {
	for _, a := range nd.attrs {
		if !strings.EqualFold(a.name, "integrity") {
			continue
		}
		end := a.offset + len(a.name)
		if a.hasValue {
			end = a.valueOffset + len(a.value)
			if a.valueOffset > 0 && (f.text[a.valueOffset-1] == '"' || f.text[a.valueOffset-1] == '\'') && end < len(f.text) {
				end++
			}
		}
		start := a.offset
		for start > 0 && (f.text[start-1] == ' ' || f.text[start-1] == '\t') {
			start--
		}
		f.add(start, end, "", kScript)
	}
}

// convert returns the edits of one file, sorted and without overlaps.
func (c *converter) convert(text, ext string, classes []string) (edits []edit, external []edit, renames map[string]string) {
	f := &fileConv{c: c, text: text, goFile: ext == ".go" || ext == ".kyse.go", strict: serverOnly(classes)}
	if c.importRe != nil && c.importRe.MatchString(text) {
		f.noGlobal = true
	}
	markupLike := contains(classes, clsMarkup)
	switch {
	case markupLike:
		f.markup(ext)
	case ext == ".vue" || ext == ".svelte" || ext == ".astro":
		f.markup(ext)
	default:
		if lang, ok := langOf(ext); ok {
			f.lexRange(0, len(text), lang, ext != ".go" && contains(classes, clsScript))
			if ext == ".jsx" || ext == ".tsx" {
				f.markup(ext)
			}
		}
	}
	f.extensionNames()
	return normalize(f.edits), f.external, f.renames
}

// shortExtensions are the names the official extensions registered under before they were all
// named after their file: config.extensions lists them as ypy-<name> now .
var shortExtensions = map[string]bool{
	"sse": true, "ws": true, "preload": true, "ptag": true, "upsert": true, "download": true,
	"history-cache": true, "browser-indicator": true, "alpine-compat": true,
}

// reExtensionsConfig finds the value of the extensions setting of the configuration: in a meta tag
// (extensions:"a,b"), in JSON ("extensions": "a,b") and in code (config.extensions = 'a,b').
var reExtensionsConfig = regexp.MustCompile(`\bextensions\b["']?\s*[:=]\s*(?:&quot;|["'])([^"'&<>\n]*)`)

// extensionNames writes the names of the official extensions in the extensions setting with the
// ypy- prefix: the old short names are not accepted any more. Only the closed list of names above
// is touched, so the name of an extension of the project is never rewritten.
func (f *fileConv) extensionNames() {
	for _, m := range reExtensionsConfig.FindAllStringSubmatchIndex(f.text, -1) {
		lo, hi := m[2], m[3]
		for pos := lo; pos <= hi; {
			end := strings.IndexByte(f.text[pos:hi], ',')
			if end < 0 {
				end = hi
			} else {
				end += pos
			}
			name := strings.TrimSpace(f.text[pos:end])
			if shortExtensions[name] {
				at := pos + strings.Index(f.text[pos:end], name)
				f.add(at, at+len(name), "ypy-"+name, kExtension)
			}
			pos = end + 1
		}
	}
}

// normalize sorts edits, drops duplicates and edits that overlap an earlier one.
func normalize(edits []edit) []edit {
	sort.SliceStable(edits, func(i, j int) bool {
		if edits[i].start != edits[j].start {
			return edits[i].start < edits[j].start
		}
		return edits[i].end < edits[j].end
	})
	var out []edit
	for _, e := range edits {
		if n := len(out); n > 0 {
			last := out[n-1]
			if e.start == last.start && e.end == last.end && e.repl == last.repl {
				continue
			}
			if e.start < last.end {
				continue
			}
		}
		out = append(out, e)
	}
	return out
}

// applyEdits writes the edits into text.
func applyEdits(text string, edits []edit) string {
	if len(edits) == 0 {
		return text
	}
	var b strings.Builder
	pos := 0
	for _, e := range edits {
		b.WriteString(text[pos:e.start])
		b.WriteString(e.repl)
		pos = e.end
	}
	b.WriteString(text[pos:])
	return b.String()
}
