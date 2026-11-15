// SPDX-License-Identifier: MIT

package check

import (
	"regexp"
	"sort"
	"strings"
)

// The legacy markup is never named by this tool. Its identifier (the global, the
// event prefix, the class prefix) is learned from the project being scanned:
//
//   - strong evidence names it alone: an event spelled only by the legacy API
//     (<id>:afterSwap), a config key of the legacy API (<id>.config.historyCacheSize),
//     a method of the legacy API (<id>.defineExtension(), two or more different
//     state classes (<id>-request with <id>-indicator), a configuration meta tag that holds an old config key,
//     or the identifier given with --id;
//   - weak evidence is ambiguous alone (a script file named <id>.min.js, an
//     <id>:load event, a single state class, an
//     <id>-config meta tag); two different kinds of weak evidence for the
//     same identifier count as one piece of strong evidence, with medium
//     confidence.
//
// The identifier "ypy" is never learned.

// idSet accumulates the evidence found for each candidate identifier.
type idSet struct {
	strong map[string]bool
	weak   map[string]map[string]bool
	// attr and hdr hold the evidence of the attribute prefix and of the
	// header prefix of the legacy markup, by lower case prefix.
	attr, hdr evidenceMap
	// forcedAttr and forcedHdr are the prefixes given with --prefix and
	// --header-prefix.
	forcedAttr, forcedHdr []string
	minEvidence           int
	explicit              map[string]bool
}

func newIDSet() *idSet {
	return &idSet{strong: map[string]bool{}, weak: map[string]map[string]bool{}, explicit: map[string]bool{},
		attr: evidenceMap{}, hdr: evidenceMap{}, minEvidence: DefaultMinEvidence}
}

// attrPrefixes lists the attribute prefixes of the legacy markup: the forced
// ones, then the learned ones.
func (s *idSet) attrPrefixes() []string {
	return mergePrefixes(s.forcedAttr, s.withoutIDs(s.attr.resolve(s.minEvidence)))
}

// withoutIDs drops the prefixes that are the identifier of the legacy markup:
// its state classes (<id>-indicator) are written like attribute names.
func (s *idSet) withoutIDs(list []string) []string {
	ids := s.known()
	out := make([]string, 0, len(list))
	for _, p := range list {
		if !containsFold(ids, p) {
			out = append(out, p)
		}
	}
	return out
}

// hdrPrefixes lists the header prefixes: the forced ones, the learned ones,
// and the attribute prefixes that also spell headers.
func (s *idSet) hdrPrefixes() []string {
	learned := s.withoutIDs(s.hdr.resolve(s.minEvidence))
	for p, e := range s.hdr {
		if e.strong {
			for _, a := range s.attrPrefixes() {
				if a == p {
					learned = append(learned, p)
				}
			}
		}
	}
	forced := s.forcedHdr
	if len(forced) == 0 {
		forced = s.forcedAttr
	}
	return mergePrefixes(forced, learned)
}

func mergePrefixes(lists ...[]string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, l := range lists {
		for _, p := range l {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

func (s *idSet) addStrong(id string) { s.strong[id] = true }

func (s *idSet) addWeak(id, kind string) {
	m := s.weak[id]
	if m == nil {
		m = map[string]bool{}
		s.weak[id] = m
	}
	m[kind] = true
}

func (s *idSet) merge(o *idSet) {
	for id := range o.strong {
		s.strong[id] = true
	}
	for id, kinds := range o.weak {
		for k := range kinds {
			s.addWeak(id, k)
		}
	}
	for id := range o.explicit {
		s.explicit[id] = true
	}
	s.attr.merge(o.attr)
	s.hdr.merge(o.hdr)
}

func (s *idSet) clone() *idSet {
	c := newIDSet()
	c.merge(s)
	return c
}

// Confidence levels of a finding.
const (
	ConfHigh   = "high"
	ConfMedium = "medium"
)

// confidence of an identifier: high with strong evidence or --id, medium with
// two kinds of weak evidence, "" when the identifier is not evidenced.
func (s *idSet) confidence(id string) string {
	switch {
	case isYPY(id):
		return ""
	case s.explicit[id] || s.strong[id]:
		return ConfHigh
	case len(s.weak[id]) >= 2:
		return ConfMedium
	}
	return ""
}

// known lists the identifiers with evidence, sorted.
func (s *idSet) known() []string {
	seen := map[string]bool{}
	for id := range s.strong {
		seen[id] = true
	}
	for id := range s.explicit {
		seen[id] = true
	}
	for id, kinds := range s.weak {
		if len(kinds) >= 2 {
			seen[id] = true
		}
	}
	list := make([]string, 0, len(seen))
	for id := range seen {
		if !isYPY(id) {
			list = append(list, id)
		}
	}
	sort.Strings(list)
	return list
}

func isYPY(id string) bool { return strings.EqualFold(id, "ypy") }

var reID = regexp.MustCompile(`^[a-z][a-z0-9]{1,24}$`)

func plausible(id string) bool { return reID.MatchString(id) }

// event tokens ----------------------------------------------------------------

func isRunByte(c byte) bool { return isWordByte(c) || c == ':' || c == '-' }

func isIdent(s string) bool {
	if s == "" || !(s[0] >= 'A' && s[0] <= 'Z' || s[0] >= 'a' && s[0] <= 'z') {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// eventTokens finds the "<prefix>:<name>" spellings of text. A run of word
// characters, colons and hyphens is split at its colons: every segment that is
// a plain identifier and is followed by a colon is a candidate prefix, and the
// rest of the run (up to an underscore, without trailing colons) its name.
// visit receives each candidate, leftmost first, and returns true to stop at
// the first one that matched (one finding per run).
func eventTokens(text string, visit func(prefix, name string, start, end int) bool) {
	for i := 0; i < len(text); {
		if !isRunByte(text[i]) {
			i++
			continue
		}
		j := i
		for j < len(text) && isRunByte(text[j]) {
			j++
		}
		run := text[i:j]
		segStart := 0
		for k := 0; k < len(run); k++ {
			if run[k] != ':' {
				continue
			}
			prefix := run[segStart:k]
			nameStart := k + 1
			if isIdent(prefix) {
				name := run[nameStart:]
				if u := strings.IndexByte(name, '_'); u >= 0 {
					name = name[:u]
				}
				name = strings.TrimRight(name, ":")
				if name != "" && (name[0] >= 'A' && name[0] <= 'Z' || name[0] >= 'a' && name[0] <= 'z') {
					if visit(prefix, name, i+segStart, i+nameStart+len(name)) {
						break
					}
				}
			}
			segStart = k + 1
		}
		i = j
	}
}

// learning --------------------------------------------------------------------

var (
	reMember    = regexp.MustCompile(`(?:^|[^\w$./@-])(?:window\.)?([a-z][a-z0-9]{1,24})\.(config\.)?([A-Za-z_$][\w$]*)`)
	reMetaTag   = regexp.MustCompile(`(?is)<meta\b[^>]*>`)
	reMetaName  = regexp.MustCompile(`(?is)\bname\s*=\s*["']([A-Za-z][A-Za-z0-9]*)-config["']`)
	reScriptSrc = regexp.MustCompile(`(?is)<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']`)
	reSrcBase   = regexp.MustCompile(`^([a-z][a-z0-9]*)(?:[.-](?:min|esm|max))*\.m?js$`)
	reSrcPinned = regexp.MustCompile(`/([a-z][a-z0-9]*)(?:\.[a-z]+)?@\d`)
	reAssetName = regexp.MustCompile(`["'/]([a-z][a-z0-9]*)(?:\.(?:min|esm|max))*\.m?js["']`)
	reOnDash    = regexp.MustCompile(`(?i)\b(?:data-)?[a-z][a-z0-9]{0,11}-on-([a-z][a-z0-9]*)-([a-z][a-z-]*)`)
)

// callOrAssign reports whether the identifier that ends at end is called or
// assigned: "(" or a single "=" follows, after optional spaces. It returns the
// offset after the "(" or "=".
func callOrAssign(text string, end int) (int, bool) {
	k := end
	for k < len(text) && (text[k] == ' ' || text[k] == '\t' || text[k] == '\n' || text[k] == '\r') {
		k++
	}
	if k >= len(text) {
		return 0, false
	}
	if text[k] == '(' {
		return k + 1, true
	}
	if text[k] == '=' && (k+1 >= len(text) || text[k+1] != '=') {
		return k + 1, true
	}
	return 0, false
}

// serverOnly reports whether a file is server code and no template, no script and no style: a
// language where a string is a string, not markup.
func serverOnly(classes []string) bool {
	server := false
	for _, c := range classes {
		switch c {
		case clsMarkup, clsScript, clsStyle:
			return false
		case clsServer:
			server = true
		}
	}
	return server
}

// learn gathers the identifier evidence of one file.
func (rs *RuleSet) learn(text, ext string, classes []string, into *idSet) {
	has := func(c string) bool {
		for _, x := range classes {
			if x == c {
				return true
			}
		}
		return false
	}
	code := has("markup") || has("script") || has("server")
	learnPrefixes(text, into.attr, into.hdr, serverOnly(classes))
	if !code && !has("style") {
		return
	}
	if code {
		eventTokens(text, func(prefix, name string, _, _ int) bool {
			if isYPY(prefix) {
				return true // the rest of the run is a native event
			}
			if !plausible(prefix) {
				return false
			}
			if e, ok := rs.events[normalizeEvent(name)]; ok {
				if e.distinctive {
					into.addStrong(prefix)
				} else {
					into.addWeak(prefix, "event")
				}
				return true
			}
			for _, e := range rs.eventNames {
				if e.nameRegex.MatchString(name) {
					into.addWeak(prefix, "event")
					return true
				}
			}
			return false
		})
		for _, m := range reMember.FindAllStringSubmatchIndex(text, -1) {
			id := text[m[2]:m[3]]
			if isYPY(id) {
				continue
			}
			member := text[m[6]:m[7]]
			if m[4] >= 0 { // <id>.config.<key>
				if rs.distinctCfg[member] {
					into.addStrong(id)
				}
				continue
			}
			if _, ok := callOrAssign(text, m[7]); !ok {
				continue
			}
			// a call to a method that other objects have too (remove, on,
			// values) names no library: it is no evidence at all
			if rs.anchorAPI[member] {
				into.addStrong(id)
			}
		}
		for _, tag := range reMetaTag.FindAllString(text, -1) {
			nm := reMetaName.FindStringSubmatch(tag)
			if nm == nil || isYPY(nm[1]) || !plausible(nm[1]) {
				continue
			}
			if rs.distinctKeyRe != nil && rs.distinctKeyRe.MatchString(tag) {
				into.addStrong(nm[1])
			} else {
				into.addWeak(nm[1], "meta")
			}
		}
		for _, m := range reScriptSrc.FindAllStringSubmatch(text, -1) {
			src := m[1]
			if i := strings.IndexAny(src, "?#"); i >= 0 {
				src = src[:i]
			}
			base := src[strings.LastIndexByte(src, '/')+1:]
			if b := reSrcBase.FindStringSubmatch(base); b != nil && plausible(b[1]) {
				into.addWeak(b[1], "script")
			}
			if b := reSrcPinned.FindStringSubmatch(src); b != nil && plausible(b[1]) {
				into.addWeak(b[1], "script")
			}
		}
		if has("server") {
			for _, m := range reAssetName.FindAllStringSubmatch(text, -1) {
				if plausible(m[1]) {
					into.addWeak(m[1], "script")
				}
			}
		}
		for _, m := range reOnDash.FindAllStringSubmatch(text, -1) {
			if e, ok := rs.events[normalizeEvent(m[2])]; ok && e.distinctive && plausible(m[1]) && !isYPY(m[1]) {
				into.addStrong(m[1])
			}
		}
	}
	if rs.classRe != nil {
		suffixes := map[string]map[string]bool{}
		for _, m := range rs.classRe.FindAllStringSubmatchIndex(text, -1) {
			if m[0] > 0 && (isWordByte(text[m[0]-1]) || text[m[0]-1] == '-') {
				continue
			}
			id := text[m[2]:m[3]]
			if isYPY(id) || !plausible(id) {
				continue
			}
			if suffixes[id] == nil {
				suffixes[id] = map[string]bool{}
			}
			suffixes[id][text[m[4]:m[5]]] = true
		}
		for id, set := range suffixes {
			// one state class is common wording ("sim-swapping"); two of them
			// together (request and indicator) are the library's pair
			if len(set) >= 2 {
				into.addStrong(id)
			} else {
				into.addWeak(id, "class")
			}
		}
	}
}
