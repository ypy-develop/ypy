// SPDX-License-Identifier: MIT

package check

import (
	"regexp"
	"sort"
	"strings"
)

// The attribute prefix and the header prefix of the legacy markup are never
// written in this tool either. They are learned from the project, by shape:
//
//   - the attribute prefix is the short word that stands in front of attribute
//     names of the request vocabulary (-get, -post, -target, -swap, -trigger,
//     -boost, -vals, -on, ...), in the form of an attribute (name="...", a
//     [name] selector or a quoted name);
//   - the header prefix is the short word that stands in front of the header
//     names of the response vocabulary (-Request, -Trigger, -Redirect,
//     -Location, -Push-Url, ...), inside a string literal.
//
// A prefix needs a minimum amount of evidence (DefaultMinEvidence distinct
// names; a request verb with a URL as its value counts double), and
// --prefix / --header-prefix force it when the project does not reveal it.

// DefaultMinEvidence is the number of distinct names that make a prefix learned.
const DefaultMinEvidence = 2

// attrStems are the attribute names of the request vocabulary, without prefix.
var attrStems = []string{
	"get", "post", "put", "patch", "delete", "target", "swap", "swap-oob", "select", "select-oob", "trigger", "boost",
	"vals", "vars", "on", "include", "indicator", "push-url", "replace-url", "confirm", "encoding", "headers", "params",
	"request", "ext", "history", "history-elt", "disable", "disabled-elt", "disinherit", "inherit", "preserve", "prompt",
	"sync", "validate", "ignore", "action", "config", "method", "query", "status", "sse", "ws", "partial", "oob",
	"morph-skip", "morph-skip-children", "preload",
}

// attrVerbs are the request verbs: with a URL as the value they are proof enough.
var attrVerbs = map[string]bool{"get": true, "post": true, "put": true, "patch": true, "delete": true}

// attrStrong are the names that no other vocabulary spells; one of them must be
// among the evidence of a prefix.
var attrStrong = map[string]bool{
	"get": true, "post": true, "put": true, "patch": true, "delete": true, "swap": true, "swap-oob": true, "select-oob": true,
	"boost": true, "vals": true, "vars": true, "indicator": true, "push-url": true, "replace-url": true,
	"disabled-elt": true, "disinherit": true, "history-elt": true, "sync": true, "oob": true, "morph-skip": true,
	"trigger": true,
}

// headerStems are the header names of the request/response vocabulary, without prefix.
var headerStems = []string{
	"Request", "Trigger", "Trigger-Name", "Trigger-After-Swap", "Trigger-After-Settle", "Target", "Redirect", "Location",
	"Push", "Push-Url", "Replace-Url", "Reswap", "Retarget", "Reselect", "Current-URL", "Boosted", "Refresh", "Prompt",
	"History-Restore-Request", "Source", "Request-Type", "Open-Layer",
}

// classLike are the stems that are also state classes of the legacy markup.
var classLike = map[string]bool{"request": true, "indicator": true, "config": true}

// headerStrong are the header names that no other vocabulary spells; one of
// them must be among the evidence of a header prefix.
var headerStrong = map[string]bool{
	"request": true, "trigger": true, "trigger-name": true, "trigger-after-swap": true, "trigger-after-settle": true,
	"push-url": true, "replace-url": true, "reswap": true, "retarget": true, "reselect": true, "current-url": true,
	"boosted": true, "history-restore-request": true, "request-type": true,
}

var (
	attrStemSet   = map[string]bool{}
	headerStemSet = map[string]bool{} // lower case
	// identStems are the words of the stems, for identifiers (<P>PushUrl, <p>_push_url).
	identStems = map[string][]string{}
	// identStemFirst indexes the stems by first word.
	identStemFirst = map[string][][]string{}
	// reservedPrefix are words that stand in front of attribute names for other reasons.
	reservedPrefix = map[string]bool{"data": true, "aria": true, "ypy": true, "xml": true, "xmlns": true, "http": true}
)

func init() {
	add := func(s string) {
		words := strings.Split(strings.ToLower(s), "-")
		key := strings.Join(words, "-")
		if _, ok := identStems[key]; ok {
			return
		}
		identStems[key] = words
		identStemFirst[words[0]] = append(identStemFirst[words[0]], words)
	}
	for _, s := range attrStems {
		attrStemSet[s] = true
		add(s)
	}
	for _, s := range headerStems {
		headerStemSet[strings.ToLower(s)] = true
		add(s)
	}
	for _, list := range identStemFirst { // longest stems first
		sort.Slice(list, func(i, j int) bool { return len(list[i]) > len(list[j]) })
	}
}

// reTargetStatus is the response-targets attribute: target-404, target-5*, target-error.
var reTargetStatus = regexp.MustCompile(`^target-(?:\d{3}|[1-5]\*|\*|error)$`)

// attrStem returns the stem of an attribute name written without its prefix
// ("target", "on" for "on::after-swap"), or "" when it is not one of the
// request vocabulary.
func attrStem(rest string) string {
	rest = strings.ToLower(rest)
	name := rest
	if c := strings.IndexByte(name, ':'); c >= 0 {
		name = name[:c]
	}
	switch {
	case attrStemSet[name]:
		return name
	case strings.HasPrefix(name, "on-"):
		return "on"
	case reTargetStatus.MatchString(name):
		return "target"
	}
	return ""
}

// legacyUnprefixed are the attribute names of the old extensions that carry no prefix, with the
// native spelling of the YPY extensions (a colon between the extension and the attribute). Only
// sse-swap keeps the dash: ypy-sse has no such attribute, and the extension warns about it.
var legacyUnprefixed = map[string]string{
	"sse-connect": "ypy-sse:connect", "sse-swap": "ypy-sse-swap", "sse-close": "ypy-sse:close",
	"ws-connect": "ypy-ws:connect", "ws-send": "ypy-ws:send",
}

// prefixEvidence is what one file or the whole project says about a prefix.
type prefixEvidence struct {
	stems  map[string]bool
	strong bool
	bonus  bool
}

func (p *prefixEvidence) score() int {
	n := len(p.stems)
	if p.bonus {
		n++
	}
	return n
}

type evidenceMap map[string]*prefixEvidence

func (m evidenceMap) get(prefix string) *prefixEvidence {
	e := m[prefix]
	if e == nil {
		e = &prefixEvidence{stems: map[string]bool{}}
		m[prefix] = e
	}
	return e
}

func (m evidenceMap) merge(o evidenceMap) {
	for p, oe := range o {
		e := m.get(p)
		for s := range oe.stems {
			e.stems[s] = true
		}
		e.strong = e.strong || oe.strong
		e.bonus = e.bonus || oe.bonus
	}
}

var (
	rePrefixWord = regexp.MustCompile(`^[a-z][a-z0-9]{0,11}$`)
	reHeaderWord = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,11}$`)
	reHeaderCtx  = regexp.MustCompile(`(?i)header|vary|_SERVER|META\s*\[|\.get\(|getallheaders`)
)

func isRunChar(c byte) bool { return isWordByte(c) || c == '-' || c == ':' }

// runs calls visit for every run of attribute-name characters (letters,
// digits, underscore, hyphen, colon) of text, with an asterisk right after a hyphen. A run that follows a
// backslash and starts with an escape letter (the "t" of "\t") is offered
// without that letter.
func runs(text string, visit func(run string, start int)) {
	for i := 0; i < len(text); {
		if !isRunChar(text[i]) {
			i++
			continue
		}
		j := i
		// an asterisk belongs to a name only after a hyphen (target-5*), never in a pattern ([^>]*name)
		for j < len(text) && (isRunChar(text[j]) || text[j] == '*' && j > i && text[j-1] == '-') {
			j++
		}
		run := text[i:j]
		if i > 0 && text[i-1] == '\\' && backslashesBefore(text, i)%2 == 1 && strings.IndexByte("tnrfv", run[0]) >= 0 && len(run) > 1 {
			// the "t" of "\t" is the escape, not the first letter of the name
			i++
			run = run[1:]
		}
		visit(run, i)
		i = j
	}
}

func backslashesBefore(text string, i int) int {
	n := 0
	for i > 0 && text[i-1] == '\\' {
		n++
		i--
	}
	return n
}

// afterRun reports what follows the run that ends at end: "=" (an attribute),
// "]" (a selector), a quote (the run closes a string) or "".
func afterRun(text string, end int) (kind byte, valueStart int) {
	k := end
	for k < len(text) && (text[k] == ' ' || text[k] == '\t') {
		k++
	}
	if k >= len(text) {
		return 0, -1
	}
	switch text[k] {
	case '=':
		v := k + 1
		for v < len(text) && (text[v] == ' ' || text[v] == '\t') {
			v++
		}
		return '=', v
	case ']':
		return ']', -1
	case '"', '\'', '`':
		return text[k], -1
	}
	return 0, -1
}

// urlLike reports whether the value that starts at v looks like a URL or a
// template expression that builds one.
func urlLike(text string, v int) bool {
	for v < len(text) && (text[v] == '"' || text[v] == '\'' || text[v] == '\\' || text[v] == '{' && v+1 < len(text) && text[v+1] == '{') {
		if text[v] == '{' {
			return true
		}
		v++
	}
	if v >= len(text) {
		return false
	}
	switch text[v] {
	case '/', '.', '#', '$', '@':
		return true
	case '<':
		return strings.HasPrefix(text[v:], "<?") || strings.HasPrefix(text[v:], "<%")
	case '{':
		return true
	case 'h':
		return strings.HasPrefix(text[v:], "http://") || strings.HasPrefix(text[v:], "https://")
	}
	return false
}

// learnPrefixes gathers the attribute and header prefix evidence of one file.
func learnPrefixes(text string, attr, hdr evidenceMap) {
	runs(text, func(run string, start int) {
		end := start + len(run)
		if run[0] == '-' || run[0] == ':' {
			return
		}
		low := strings.ToLower(run)
		// attribute-shaped: [data-]<prefix>-<known name> followed by "=", "]" or a closing quote
		rest := strings.TrimPrefix(low, "data-")
		if c := strings.IndexByte(rest, '-'); c > 0 && rePrefixWord.MatchString(rest[:c]) && !reservedPrefix[rest[:c]] {
			p := rest[:c]
			if stem := attrStem(rest[c+1:]); stem != "" {
				kind, v := afterRun(text, end)
				prev := byte(0)
				if start > 0 {
					prev = text[start-1]
				}
				ok := kind == '=' || (kind == ']' && prev == '[') || ((kind == '"' || kind == '\'' || kind == '`') && prev == kind)
				// a class (request, indicator, ...) is written like an attribute name in a quote
				if ok && kind != '=' && classLike[stem] {
					ok = false
				}
				if ok {
					e := attr.get(p)
					e.stems[stem] = true
					if attrStrong[stem] {
						e.strong = true
					}
					if attrVerbs[stem] && kind == '=' && urlLike(text, v) {
						e.bonus = true
					}
				}
			}
		}
		// header-shaped: <Prefix>-<Known-Header-Name>, written with capitals, inside a string
		hr := strings.TrimRight(run, ":")
		if c := strings.IndexByte(hr, '-'); c > 0 && reHeaderWord.MatchString(hr[:c]) && c+1 < len(hr) && hr[c+1] >= 'A' && hr[c+1] <= 'Z' && !reservedPrefix[strings.ToLower(hr[:c])] {
			if headerStemSet[strings.ToLower(hr[c+1:])] && inString(text, start) {
				e := hdr.get(strings.ToLower(hr[:c]))
				stem := strings.ToLower(hr[c+1:])
				e.stems[stem] = true
				e.strong = e.strong || headerStrong[stem]
				// a header API call is half a proof more; a one letter word (X-) proves nothing by itself
				if len(hr[:c]) > 1 && reHeaderCtx.MatchString(lineAround(text, start)) {
					e.bonus = true
				}
			}
		}
		// CGI spelling of a request header: HTTP_<PREFIX>_<NAME>
		if strings.HasPrefix(run, "HTTP_") {
			words := strings.Split(run[5:], "_")
			if len(words) >= 2 && reHeaderWord.MatchString(words[0]) && words[0] == strings.ToUpper(words[0]) && !reservedPrefix[strings.ToLower(words[0])] {
				name := strings.ToLower(strings.Join(words[1:], "-"))
				if headerStemSet[name] {
					e := hdr.get(strings.ToLower(words[0]))
					e.stems[name] = true
					e.strong = e.strong || headerStrong[name]
					e.bonus = len(words[0]) > 1
				}
			}
		}
	})
}

// lineAround is the line of text that holds offset i.
func lineAround(text string, i int) string {
	ls := strings.LastIndexByte(text[:i], '\n') + 1
	le := strings.IndexByte(text[i:], '\n')
	if le < 0 {
		le = len(text)
	} else {
		le += i
	}
	return text[ls:le]
}

// inString reports whether offset i is inside a quoted string, judged by the
// quotes that come before it on its line.
func inString(text string, i int) bool {
	ls := strings.LastIndexByte(text[:i], '\n') + 1
	var q byte
	for k := ls; k < i; k++ {
		c := text[k]
		switch {
		case c == '\\':
			k++
		case q == 0 && (c == '"' || c == '\'' || c == '`'):
			q = c
		case q != 0 && c == q:
			q = 0
		}
	}
	return q != 0
}

// resolve lists the prefixes with enough evidence, strongest first.
func (m evidenceMap) resolve(min int) []string {
	type kv struct {
		p string
		n int
	}
	var list []kv
	for p, e := range m {
		if e.strong && e.score() >= min {
			list = append(list, kv{p, e.score()})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].n != list[j].n {
			return list[i].n > list[j].n
		}
		return list[i].p < list[j].p
	})
	out := make([]string, len(list))
	for i, x := range list {
		out[i] = x.p
	}
	return out
}

// normalizePrefix accepts "acme", "acme-", "ACME-" and "data-acme-".
func normalizePrefix(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	p = strings.TrimPrefix(p, "data-")
	return strings.TrimRight(p, "-_")
}

// validPrefix reports whether p can be used as a foreign prefix.
func validPrefix(p string) bool {
	return rePrefixWord.MatchString(p) && !reservedPrefix[p]
}

// case styles ----------------------------------------------------------------

// matchCase writes word in the case style of like: upper, lower or capitalized.
func matchCase(like, word string) string {
	switch {
	case like == strings.ToUpper(like) && like != strings.ToLower(like):
		return strings.ToUpper(word)
	case like == strings.ToLower(like):
		return strings.ToLower(word)
	}
	return strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
}

// identifier words -------------------------------------------------------------

type word struct {
	text       string
	start, end int
}

// splitIdent splits an identifier into words: at underscores, at the change
// from a lower case letter or digit to an upper case letter, and before the
// last capital of a run of capitals that is followed by a lower case letter.
func splitIdent(id string) []word {
	var out []word
	start := -1
	flush := func(end int) {
		if start >= 0 && end > start {
			out = append(out, word{id[start:end], start, end})
		}
		start = -1
	}
	isUp := func(c byte) bool { return c >= 'A' && c <= 'Z' }
	isLow := func(c byte) bool { return c >= 'a' && c <= 'z' }
	isDig := func(c byte) bool { return c >= '0' && c <= '9' }
	for i := 0; i < len(id); i++ {
		c := id[i]
		if c == '_' || c == '$' {
			flush(i)
			continue
		}
		if start < 0 {
			start = i
			continue
		}
		prev := id[i-1]
		switch {
		case isUp(c) && (isLow(prev) || isDig(prev)):
			flush(i)
			start = i
		case isUp(c) && isUp(prev) && i+1 < len(id) && isLow(id[i+1]):
			flush(i)
			start = i
		case isDig(c) != isDig(prev) && (isDig(c) || isDig(prev)) && isUp(c) == false && isLow(c):
			// letters after digits stay in the same word (h2c)
		}
	}
	flush(len(id))
	return out
}

// identLeaders are the words that make a Go predicate or a flag out of a name: IsACME, HasACME, WithACME.
var identLeaders = map[string]bool{"is": true, "has": true, "was": true, "uses": true, "with": true, "without": true}

// identTailHits finds the identifiers that end in a prefix after a leader word (IsACME, hasACME):
// the legacy markup's name used as a predicate, with no stem of the vocabulary after it.
func identTailHits(id string, prefixes []string) []word {
	words := splitIdent(id)
	n := len(words)
	if n < 2 || !identLeaders[strings.ToLower(words[n-2].text)] {
		return nil
	}
	last := words[n-1]
	// a prefix that is spelled in capitals or with a capital (ACME, Acme): not "isacme" in one word
	if last.text[0] < 'A' || last.text[0] > 'Z' {
		return nil
	}
	for _, p := range prefixes {
		if strings.EqualFold(last.text, p) {
			return []word{last}
		}
	}
	return nil
}

// identPrefixHits finds, in the identifier id, the words that spell one of the
// prefixes in front of a stem of the vocabulary, and returns their spans.
func identPrefixHits(id string, prefixes []string) []word {
	words := splitIdent(id)
	var hits []word
	for i := 0; i+1 < len(words); i++ {
		w := strings.ToLower(words[i].text)
		known := false
		for _, p := range prefixes {
			if w == p {
				known = true
				break
			}
		}
		if !known {
			continue
		}
		next := strings.ToLower(words[i+1].text)
		for _, stem := range identStemFirst[next] {
			if i+1+len(stem) > len(words) {
				continue
			}
			match := true
			for k, sw := range stem {
				if strings.ToLower(words[i+1+k].text) != sw {
					match = false
					break
				}
			}
			if match {
				hits = append(hits, words[i])
				break
			}
		}
	}
	return hits
}
