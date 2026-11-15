// SPDX-License-Identifier: MIT

package check

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// File classes that decide which rules read a file.
const (
	clsMarkup = "markup"
	clsScript = "script"
	clsStyle  = "style"
	clsServer = "server"
)

// DefaultExtensions maps each class to the extensions read as that class.
var DefaultExtensions = map[string][]string{
	clsMarkup: {".kyse.go", ".html", ".htm", ".xhtml", ".gohtml", ".tmpl", ".tpl", ".templ", ".jinja", ".jinja2", ".j2", ".njk", ".twig",
		".erb", ".rhtml", ".php", ".phtml", ".hbs", ".handlebars", ".mustache", ".ejs", ".liquid", ".pug"},
	clsScript: {".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte", ".astro"},
	clsStyle:  {".css", ".scss", ".sass", ".less"},
	clsServer: {".go", ".py", ".rb", ".java", ".kt", ".cs", ".ex", ".exs", ".rs"},
}

// extOf is the extension that decides how a file is read: Kyse templates are
// Go files with a double extension.
func extOf(file string) string {
	name := strings.ToLower(filepath.Base(file))
	if strings.HasSuffix(name, ".kyse.go") {
		return ".kyse.go"
	}
	return filepath.Ext(name)
}

func classesOf(ext string) []string {
	ext = strings.ToLower(ext)
	var classes []string
	for _, cls := range []string{clsMarkup, clsScript, clsStyle, clsServer} {
		for _, e := range DefaultExtensions[cls] {
			if e == ext {
				classes = append(classes, cls)
				break
			}
		}
	}
	if ext == ".php" {
		classes = append(classes, clsServer)
	}
	return classes
}

var (
	readContext  = regexp.MustCompile(`(?:\.Get\(|\.get\(|\.getHeader\(|\.get_header\(|\.GetHeader\(|\.header\(\s*['"` + "`" + `][^'"` + "`" + `]*['"` + "`" + `]\s*\)|\.headers?\s*\[|META\s*\[|_SERVER\s*\[|HTTP_[A-Z0-9]+_|\.Values\(|getallheaders|headers\.get|\.Header\.Get|hasHeader)`)
	writeContext = regexp.MustCompile(`(?:\.Set\(|\.Add\(|\.set\(|\.setHeader\(|\.put\(|\.header\(\s*['"` + "`" + `][^'"` + "`" + `]*['"` + "`" + `]\s*,|\bheader\(\s*['"` + "`" + `][A-Za-z0-9]+-[^'"` + "`" + `]*:|\]\s*=[^=]|=>\s*['"` + "`" + `])`)
	// eventContext is code that listens to or dispatches an event by name.
	eventContext = `addEventListener|removeEventListener|dispatchEvent|CustomEvent|\.on\(|\.off\(|\.once\(|\.trigger\(`
)

var (
	// inheritable and requestAttrs list the stems (the name without the
	// prefix) of the attributes that descendants inherit implicitly in the
	// v2 markup, and of the ones that issue a request.
	inheritable = map[string]bool{"boost": true, "confirm": true, "encoding": true, "headers": true, "include": true,
		"indicator": true, "push-url": true, "replace-url": true, "select": true, "select-oob": true,
		"swap": true, "sync": true, "target": true, "vals": true, "disabled-elt": true}
	requestAttrs = map[string]bool{"get": true, "post": true, "put": true, "patch": true, "delete": true}
	csrf         = regexp.MustCompile(`(?i)csrf|xsrf`)
)

// attrBase turns "data-acme-target:inherited" into "target" for the attribute
// prefixes of the project; names that do not carry one give "".
func attrBase(prefixes []string, name string) string {
	n := strings.ToLower(name)
	n = strings.TrimPrefix(n, "data-")
	for _, p := range prefixes {
		if rest, ok := strings.CutPrefix(n, p+"-"); ok {
			if c := strings.IndexByte(rest, ':'); c >= 0 {
				rest = rest[:c]
			}
			return rest
		}
	}
	return ""
}

func hasModifier(name string) bool { return strings.Contains(name, ":") }

func ownAttr(prefixes []string, nd *node, base string) *attr {
	for i := range nd.attrs {
		if attrBase(prefixes, nd.attrs[i].name) == base {
			return &nd.attrs[i]
		}
	}
	return nil
}

func isBoostable(nd *node) bool {
	if nd.tag == "form" {
		return true
	}
	if nd.tag == "a" {
		for _, a := range nd.attrs {
			if strings.EqualFold(a.name, "href") {
				return true
			}
		}
	}
	return false
}

func boostValue(v string) bool {
	if v == "" {
		return true
	}
	return strings.ToLower(strings.TrimSpace(v)) != "false"
}

// boostedSet holds the elements that a boost container turns into request
// sources (links and forms).
func boostedSet(prefixes []string, root *node) map[*node]bool {
	boosted := map[*node]bool{}
	var visit func(nd *node, boost bool)
	visit = func(nd *node, boost bool) {
		for _, a := range nd.attrs {
			if attrBase(prefixes, a.name) == "boost" {
				boost = boostValue(a.value)
			}
		}
		if boost && isBoostable(nd) {
			boosted[nd] = true
		}
		for _, c := range nd.children {
			visit(c, boost)
		}
	}
	for _, c := range root.children {
		visit(c, false)
	}
	return boosted
}

func requestSource(prefixes []string, nd *node, boosted map[*node]bool) string {
	for _, a := range nd.attrs {
		if requestAttrs[attrBase(prefixes, a.name)] {
			return strings.ToLower(a.name)
		}
	}
	if boosted[nd] {
		return "boosted <" + nd.tag + ">"
	}
	return ""
}

// finding is a hit of one rule in one file.
type finding struct {
	rule       *Rule
	start, end int
	match      string
	detail     string
	// idText is the legacy identifier of the match, shown in the message.
	idText string
	conf   string
	count  int
	line   int
	column int
}

type signal struct {
	line, what string
	rule       string
	file       string
	row, col   int
}

// env is what a scan needs besides the file: the rules, the evidence of
// the project and the patterns built from the identifiers it names.
type env struct {
	rs        *RuleSet // bound to the prefixes of the project
	ids       *idSet
	attrP     []string // attribute prefixes of the legacy markup
	hdrP      []string // header prefixes of the legacy markup
	known     []string
	eventCtx  *regexp.Regexp
	memberRe  *regexp.Regexp
	scriptLib map[string]*regexp.Regexp // by identifier
}

func newEnv(rs *RuleSet, ids *idSet) *env {
	attrP, hdrP := ids.attrPrefixes(), ids.hdrPrefixes()
	bound, err := rs.Bind(attrP, hdrP)
	if err != nil {
		bound = rs
	}
	e := &env{rs: bound, ids: ids, attrP: attrP, hdrP: hdrP, known: ids.known(), scriptLib: map[string]*regexp.Regexp{}}
	ctx := eventContext
	if len(attrP) > 0 {
		ctx += "|" + prefixAlt(attrP, "-") + "(?:trigger|on)"
	}
	e.eventCtx = regexp.MustCompile(ctx)
	alt := []string{"ypy"}
	for _, id := range e.known {
		alt = append(alt, regexp.QuoteMeta(id))
		q := regexp.QuoteMeta(id)
		e.scriptLib[id] = regexp.MustCompile(`\b` + q + `(?:[.-](?:min|esm|max))*\.js\b|\b` + q + `\.org\b|/` + q + `@\d`)
	}
	e.memberRe = regexp.MustCompile(`(?:^|[^\w$./@-])((?:window\.)?)(` + strings.Join(alt, "|") + `)\.(config\.)?([A-Za-z_$][\w$]*)`)
	return e
}

func matchAttrRule(e attrEntry, nd *node, a attr) bool {
	name := strings.ToLower(a.name)
	if len(e.names) > 0 {
		if !e.names[name] {
			return false
		}
	} else if e.nameRegex == nil || !e.nameRegex.MatchString(name) {
		return false
	}
	if e.tags != nil && !e.tags[nd.tag] {
		return false
	}
	if e.notTags != nil && e.notTags[nd.tag] {
		return false
	}
	if e.value != nil && !e.value.MatchString(a.value) {
		return false
	}
	if e.valueNot != nil && e.valueNot.MatchString(a.value) {
		return false
	}
	return true
}

var (
	reOnShort = regexp.MustCompile(`^on::(.+)$`)
	reOnDash2 = regexp.MustCompile(`^on--(.+)$`)
	reOnLong  = regexp.MustCompile(`^on-([a-z][a-z0-9]*)-(.+)$`)
)

// eventOfOnAttribute reads the event of an "on" attribute name written with
// one of the prefixes: the shorthand ("<p>-on::after-swap") and the dash form
// ("<p>-on--after-swap") carry no identifier; the long form
// ("<p>-on-<id>-after-swap") does.
func eventOfOnAttribute(prefixes []string, name string) (id, event string, ok bool) {
	n := strings.TrimPrefix(strings.ToLower(name), "data-")
	for _, p := range prefixes {
		rest, found := strings.CutPrefix(n, p+"-")
		if !found {
			continue
		}
		if m := reOnShort.FindStringSubmatch(rest); m != nil {
			return "", m[1], true
		}
		if m := reOnDash2.FindStringSubmatch(rest); m != nil {
			return "", m[1], true
		}
		if m := reOnLong.FindStringSubmatch(rest); m != nil {
			return m[1], m[2], true
		}
	}
	return "", "", false
}

// scanResult is what one file gives.
type scanResult struct {
	findings []finding
	signals  []signal
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// scanFile applies every rule to one file.
func (e *env) scanFile(text, file, ext string, classes []string) scanResult {
	rs := e.rs
	var res scanResult
	if len(classes) == 0 {
		return res
	}
	loc := newLocator(text)
	var all []finding
	add := func(r *Rule, start, end int, match, detail, id, conf string) {
		all = append(all, finding{rule: r, start: start, end: end, match: match, detail: detail, idText: id, conf: conf, count: 1})
	}
	applies := func(r *Rule) bool {
		for _, f := range r.Files {
			if contains(classes, f) {
				return true
			}
		}
		return false
	}
	isCode := contains(classes, clsMarkup) || contains(classes, clsScript)

	// eventRule finds the rule of an event name, and whether it is distinctive.
	eventRule := func(name string) (eventEntry, bool) {
		if en, ok := rs.events[normalizeEvent(name)]; ok {
			return en, true
		}
		for _, en := range rs.eventNames {
			if en.nameRegex.MatchString(name) {
				return en, true
			}
		}
		return eventEntry{}, false
	}
	// eventConf decides whether "<id>:<name>" is the legacy markup's event and
	// with which confidence.
	eventConf := func(id string, en eventEntry, at int) string {
		if c := e.ids.confidence(id); c != "" {
			return c
		}
		if en.distinctive {
			return ConfHigh
		}
		if len(e.attrP) > 0 {
			ls := strings.LastIndexByte(text[:at], '\n') + 1
			le := strings.IndexByte(text[at:], '\n')
			if le == -1 {
				le = len(text)
			} else {
				le += at
			}
			if e.eventCtx.MatchString(text[ls:le]) {
				return ConfMedium
			}
		}
		return ""
	}

	// ---- markup rules ---------------------------------------------------------
	var masked string
	if isCode {
		masked = maskTemplates(text, ext)
	}
	if masked != "" && reTagStart.MatchString(masked) {
		mainRoot := parseMarkup(masked)
		roots := []*node{mainRoot}
		// HTML written inside inline <script> blocks (template strings, x-template) is markup too
		walk(mainRoot, func(nd *node) {
			if nd.tag != "script" || !nd.hasRaw {
				return
			}
			for _, a := range nd.attrs {
				if strings.EqualFold(a.name, "src") {
					return
				}
			}
			inner := blankOutside(masked, nd.rawStart, nd.rawEnd)
			if reTagStart.MatchString(inner) {
				roots = append(roots, parseMarkup(inner))
			}
		})
		for _, root := range roots {
			walk(root, func(nd *node) {
				for _, a := range nd.attrs {
					for _, en := range rs.attr {
						if applies(en.rule) && matchAttrRule(en, nd, a) {
							add(en.rule, a.offset, a.offset+len(a.name), a.name, "", "", ConfHigh)
						}
					}
					if id, ev, ok := eventOfOnAttribute(e.attrP, a.name); ok {
						if en, found := eventRule(ev); found && applies(en.rule) && !isYPY(id) {
							conf := ConfHigh
							if id != "" {
								conf = eventConf(id, en, a.offset)
							}
							if conf != "" {
								add(en.rule, a.offset, a.offset+len(a.name), a.name, "", id, conf)
							}
						}
					}
				}
				if nd.tag == "meta" {
					e.scanMeta(nd, applies, add)
				}
				if nd.tag == "script" {
					e.scanScriptTag(nd, applies, add)
				}
			})
			if r := rs.structural["inheritance"]; r != nil && applies(r) {
				checkInheritance(e.attrP, root, loc, func(start, end int, match, detail string) { add(r, start, end, match, detail, "", ConfHigh) })
			}
			if r := rs.structural["delete-in-form"]; r != nil && applies(r) {
				checkDeleteInForm(e.attrP, root, func(start, end int, match, detail string) { add(r, start, end, match, detail, "", ConfHigh) })
			}
			// detection signals that are not issues (native YPY and the v4 markup)
			walk(root, func(nd *node) {
				for _, a := range nd.attrs {
					name := strings.ToLower(a.name)
					for _, sig := range rs.detectAttrs {
						if sig.re.MatchString(name) {
							ln, col := loc.at(a.offset)
							res.signals = append(res.signals, signal{line: sig.line, what: a.name, file: file, row: ln, col: col})
						}
					}
				}
			})
		}
	}

	// ---- events written as "<prefix>:<name>", in any context ------------------
	if isCode {
		eventTokens(text, func(prefix, name string, start, end int) bool {
			if isYPY(prefix) {
				return true // the rest of the run is a native event
			}
			en, ok := eventRule(name)
			if !ok {
				return false
			}
			if applies(en.rule) {
				if conf := eventConf(prefix, en, start); conf != "" {
					add(en.rule, start, end, text[start:end], "", prefix, conf)
				}
			}
			return true
		})
	}

	// ---- the identifier of the legacy markup: global, config, classes -----------
	if isCode {
		e.scanMembers(text, applies, add)
	}
	if rs.classRe != nil {
		e.scanClasses(text, applies, add)
	}

	// ---- text rules -----------------------------------------------------------
	for _, h := range rs.headers {
		if !applies(h.rule) {
			continue
		}
		for _, m := range h.re.FindAllStringIndex(text, -1) {
			if m[0] > 0 && (isAlnum(text[m[0]-1]) || text[m[0]-1] == '-') {
				continue
			}
			if !headerAfterOK(text, m[1], h.read) {
				continue
			}
			if h.read {
				ls := strings.LastIndexByte(text[:m[0]], '\n') + 1
				le := strings.IndexByte(text[m[0]:], '\n')
				if le == -1 {
					le = len(text)
				} else {
					le += m[0]
				}
				line := text[ls:le]
				if !readContext.MatchString(line) || writeContext.MatchString(line) {
					continue
				}
			}
			add(h.rule, m[0], m[1], text[m[0]:m[1]], "", "", ConfHigh)
		}
	}
	for _, p := range rs.patterns {
		if !applies(p.rule) {
			continue
		}
		for _, m := range p.re.FindAllStringSubmatchIndex(text, -1) {
			s, en := m[0], m[1]
			if p.grp > 0 && m[2*p.grp] >= 0 {
				s, en = m[2*p.grp], m[2*p.grp+1]
			}
			if en > s {
				add(p.rule, s, en, text[s:en], "", "", ConfHigh)
			}
		}
	}

	// ---- drop repeated hits, generic hits covered by a specific one, collapse ----
	seen := map[string]bool{}
	var unique []finding
	for _, f := range all {
		key := f.rule.ID + ":" + itoa(f.start)
		if seen[key] {
			continue
		}
		seen[key] = true
		unique = append(unique, f)
	}
	var kept []finding
	for _, f := range unique {
		if !f.rule.Generic {
			kept = append(kept, f)
			continue
		}
		covered := false
		for _, s := range unique {
			if !s.rule.Generic && s.start < f.end && f.start < s.end {
				covered = true
				break
			}
		}
		if !covered {
			kept = append(kept, f)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].start != kept[j].start {
			return kept[i].start < kept[j].start
		}
		return kept[i].rule.ID < kept[j].rule.ID
	})
	first := map[string]int{}
	for _, f := range kept {
		if !f.rule.Aggregate {
			res.findings = append(res.findings, f)
			continue
		}
		if i, ok := first[f.rule.ID]; ok {
			res.findings[i].count++
		} else {
			first[f.rule.ID] = len(res.findings)
			res.findings = append(res.findings, f)
		}
	}
	for i := range res.findings {
		res.findings[i].line, res.findings[i].column = loc.at(res.findings[i].start)
	}
	return res
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func isAlnum(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// headerAfterOK checks the character after a header name: a request header
// read by the server must end at a quote, bracket, comma or space (or the end
// of the text); any other use must not continue the name.
func headerAfterOK(text string, end int, read bool) bool {
	if read {
		if end >= len(text) {
			return true
		}
		switch c := text[end]; c {
		case '"', '\'', '`', ']', ')', '}', ',':
			return true
		default:
			return isSpace(c)
		}
	}
	if end >= len(text) {
		return true
	}
	c := text[end]
	return !(isAlnum(c) || c == '_' || c == '-')
}

// scanMeta reads <meta name="<id>-config" content="{...}">.
func (e *env) scanMeta(nd *node, applies func(*Rule) bool, add func(r *Rule, start, end int, match, detail, id, conf string)) {
	var nameAttr, content *attr
	for i := range nd.attrs {
		switch strings.ToLower(nd.attrs[i].name) {
		case "name":
			nameAttr = &nd.attrs[i]
		case "content":
			content = &nd.attrs[i]
		}
	}
	if nameAttr == nil {
		return
	}
	v := nameAttr.value
	id, ok := strings.CutSuffix(v, "-config")
	if !ok || !isIdent(id) {
		return
	}
	conf := e.ids.confidence(id)
	if isYPY(id) {
		conf = ConfHigh
	} else {
		for _, r := range e.rs.metaConfig {
			if conf != "" && applies(r) {
				add(r, nameAttr.offset, nameAttr.offset+len(nameAttr.name), nameAttr.name, "", id, conf)
			}
		}
	}
	if conf == "" || content == nil || e.rs.cfgKeyRe == nil {
		return
	}
	for _, m := range e.rs.cfgKeyRe.FindAllStringSubmatchIndex(content.value, -1) {
		key := content.value[m[2]:m[3]]
		start := content.valueOffset + m[0]
		for _, r := range e.rs.config[key] {
			if applies(r) {
				add(r, start, start+m[1]-m[0], key, "", id, conf)
			}
		}
	}
}

// scanScriptTag reads <script src="...">.
func (e *env) scanScriptTag(nd *node, applies func(*Rule) bool, add func(r *Rule, start, end int, match, detail, id, conf string)) {
	var src *attr
	for i := range nd.attrs {
		if strings.EqualFold(nd.attrs[i].name, "src") {
			src = &nd.attrs[i]
		}
	}
	if src == nil {
		return
	}
	for _, en := range e.rs.scriptSrc {
		if !applies(en.rule) {
			continue
		}
		m := en.re.FindStringSubmatch(src.value)
		if m == nil {
			continue
		}
		if en.idG > 0 && en.idG < len(m) && m[en.idG] != "" && isYPY(m[en.idG]) {
			continue
		}
		add(en.rule, src.offset, src.offset+len(src.name), src.value, "", "", ConfHigh)
	}
	for _, r := range e.rs.scriptLib {
		if !applies(r) {
			continue
		}
		for _, id := range e.known {
			if e.scriptLib[id].MatchString(src.value) {
				add(r, src.offset, src.offset+len(src.name), src.value, "", id, e.ids.confidence(id))
				break
			}
		}
	}
}

// scanMembers finds <id>.<method>(, <id>.config.<key> and any other <id>.<member>
// of the global of the legacy markup (and of "ypy", for the removed methods).
func (e *env) scanMembers(text string, applies func(*Rule) bool, add func(r *Rule, start, end int, match, detail, id, conf string)) {
	rs := e.rs
	for _, m := range e.memberRe.FindAllStringSubmatchIndex(text, -1) {
		start := m[2] // start of "window." or of the id
		id := text[m[4]:m[5]]
		conf := ConfHigh
		if !isYPY(id) {
			conf = e.ids.confidence(id)
			if conf == "" {
				continue
			}
		}
		member := text[m[8]:m[9]]
		if m[6] >= 0 { // <id>.config.<key>
			end := m[9]
			for _, r := range rs.config[member] {
				if applies(r) {
					add(r, start, end, text[start:end], "", id, conf)
				}
			}
			if !isYPY(id) {
				cfgEnd := m[7] - 1 // the "." after "config"
				for _, r := range rs.apiGlobal {
					if applies(r) {
						add(r, start, cfgEnd, text[start:cfgEnd], "", id, conf)
					}
				}
			}
			continue
		}
		if after, ok := callOrAssign(text, m[9]); ok {
			for _, r := range rs.jsAPI[member] {
				if applies(r) {
					add(r, start, after, text[start:after], "", id, conf)
				}
			}
		}
		if !isYPY(id) {
			skip := false
			for _, r := range rs.apiGlobal {
				if contains(r.Match.Skip, member) {
					skip = true
				}
			}
			if !skip {
				for _, r := range rs.apiGlobal {
					if applies(r) {
						add(r, start, m[9], text[start:m[9]], "", id, conf)
					}
				}
			}
		}
	}
}

// scanClasses finds <id>-request and the other state classes of the legacy markup.
func (e *env) scanClasses(text string, applies func(*Rule) bool, add func(r *Rule, start, end int, match, detail, id, conf string)) {
	if len(e.rs.classRules) == 0 {
		return
	}
	for _, m := range e.rs.classRe.FindAllStringSubmatchIndex(text, -1) {
		if m[0] > 0 && (isWordByte(text[m[0]-1]) || text[m[0]-1] == '-') {
			continue
		}
		id := text[m[2]:m[3]]
		if isYPY(id) {
			continue
		}
		conf := e.ids.confidence(id)
		if conf == "" {
			continue
		}
		suffix := text[m[4]:m[5]]
		for _, r := range e.rs.classRules {
			if applies(r) && contains(r.Match.Suffixes, suffix) {
				add(r, m[0], m[1], text[m[0]:m[1]], "", id, conf)
			}
		}
	}
}

func checkInheritance(prefixes []string, root *node, loc *locator, add func(start, end int, match, detail string)) {
	boosted := boostedSet(prefixes, root)
	walk(root, func(nd *node) {
		for _, a := range nd.attrs {
			base := attrBase(prefixes, a.name)
			if !inheritable[base] || hasModifier(a.name) {
				continue
			}
			hint := ""
			if base == "headers" && csrf.MatchString(a.value) {
				hint = "; this looks like a CSRF token, the server rejects the requests that lose it"
			}
			found := ""
			if base == "boost" {
				if !boostValue(a.value) {
					continue
				}
				walk(nd, func(d *node) {
					if found == "" && (d.tag == "a" || d.tag == "form") && ownAttr(prefixes, d, "boost") == nil {
						ln, _ := loc.at(d.offset)
						found = "descendant <" + d.tag + "> on line " + itoa(ln)
					}
				})
			} else {
				walk(nd, func(d *node) {
					if found != "" || ownAttr(prefixes, d, base) != nil {
						return
					}
					if src := requestSource(prefixes, d, boosted); src != "" {
						ln, _ := loc.at(d.offset)
						found = "descendant on line " + itoa(ln) + " has " + src
					}
				})
			}
			switch {
			case found != "":
				add(a.offset, a.offset+len(a.name), a.name, a.name+" is inherited implicitly ("+found+")"+hint)
			case base == "headers" || nd.tag == "body" || nd.tag == "html":
				add(a.offset, a.offset+len(a.name), a.name,
					a.name+" on <"+nd.tag+"> reaches elements of other templates by implicit inheritance (no request in this file)"+hint)
			}
		}
	})
}

func checkDeleteInForm(prefixes []string, root *node, add func(start, end int, match, detail string)) {
	walk(root, func(nd *node) {
		var a *attr
		for i := range nd.attrs {
			if attrBase(prefixes, nd.attrs[i].name) == "delete" {
				a = &nd.attrs[i]
				break
			}
		}
		if a == nil {
			return
		}
		chain := append([]*node{nd}, ancestors(nd)...)
		inForm := false
		for _, n := range chain {
			if n.tag == "form" && n != nd {
				inForm = true
			}
		}
		if !inForm {
			return
		}
		for _, n := range chain {
			if ownAttr(prefixes, n, "include") != nil {
				return
			}
		}
		add(a.offset, a.offset+len(a.name), a.name, a.name+" inside a <form> relies on the form values being sent")
	})
}
