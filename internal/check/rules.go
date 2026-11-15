// SPDX-License-Identifier: MIT

package check

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

//go:embed rules.json
var embeddedRules []byte

// Markup generations and severities, lowest to highest.
var (
	Lines      = []string{"v1", "v2", "v4"}
	Severities = []string{"aviso", "muda", "quebra"}
)

// Meta is the header of the rule table.
type Meta struct {
	Schema     int               `json:"schema"`
	Version    string            `json:"version"`
	Guide      string            `json:"guide"`
	Lines      map[string]string `json:"lines"`
	Severities map[string]string `json:"severities"`
}

// Match holds the kind-specific matching data of a rule; every field is
// optional and which ones are read depends on Rule.Kind.
type Match struct {
	Names     []string `json:"names"`
	Name      string   `json:"name"`
	Prefix    *bool    `json:"prefix"`
	Tags      []string `json:"tags"`
	NotTags   []string `json:"notTags"`
	Value     string   `json:"value"`
	ValueNot  string   `json:"valueNot"`
	NameRegex string   `json:"nameRegex"`
	Flags     string   `json:"flags"`
	Regex     string   `json:"regex"`
	Group     int      `json:"group"`
	Key       string   `json:"key"`
	Keys      []string `json:"keys"`
	Src       string   `json:"src"`
	IDGroup   int      `json:"idGroup"`
	Check     string   `json:"check"`
	Context   string   `json:"context"`
	Suffixes  []string `json:"suffixes"`
	Skip      []string `json:"skip"`
}

// Rule is one entry of the table. The legacy identifier of the legacy markup is
// never written in a rule: kinds that need it (event, event-prefix, js-api,
// config, class, api-global, meta-config, script-library) apply to the
// identifier the scan learned from the project, or to the one given with --id.
type Rule struct {
	ID        string   `json:"id"`
	Lines     []string `json:"lines"`
	Severity  string   `json:"severity"`
	Group     string   `json:"group"`
	Kind      string   `json:"kind"`
	Match     Match    `json:"match"`
	Files     []string `json:"files"`
	Aggregate bool     `json:"aggregate"`
	Generic   bool     `json:"generic"`
	// Anchor marks the js-api rules whose method name belongs to the legacy API
	// alone: a call to it names the legacy identifier by itself.
	Anchor bool   `json:"anchor"`
	Signal string `json:"signal"`
	What   string `json:"what"`
	Fix    string `json:"fix"`
	Native string `json:"native"`
}

type fileData struct {
	Meta   Meta `json:"meta"`
	Detect struct {
		Attributes []struct {
			Line  string `json:"line"`
			Regex string `json:"regex"`
		} `json:"attributes"`
	} `json:"detect"`
	Rules []*Rule `json:"rules"`
}

type attrEntry struct {
	rule      *Rule
	names     map[string]bool
	nameRegex *regexp.Regexp
	value     *regexp.Regexp
	valueNot  *regexp.Regexp
	tags      map[string]bool
	notTags   map[string]bool
}

type eventEntry struct {
	rule *Rule
	// distinctive events are compound (camelCase or with a colon): no other
	// code spells them, so one of them names the legacy identifier.
	distinctive bool
	// nameRegex is set for event-prefix rules that match by pattern.
	nameRegex *regexp.Regexp
}

type headerEntry struct {
	rule *Rule
	re   *regexp.Regexp
	read bool
}

type patternEntry struct {
	rule *Rule
	re   *regexp.Regexp
	grp  int
}

type signatureEntry struct {
	line string
	re   *regexp.Regexp
}

// RuleSet is the compiled rule table.
type RuleSet struct {
	Meta  Meta
	Rules []*Rule
	byID  map[string]*Rule

	raw             []byte
	attrPre, hdrPre []string // the legacy prefixes bound by Bind, lower case, without the hyphen

	attr          []attrEntry
	events        map[string]eventEntry // by normalized event name
	eventNames    []eventEntry          // event-prefix rules by pattern
	jsAPI         map[string][]*Rule    // by method name
	config        map[string][]*Rule    // by config key
	distinctCfg   map[string]bool       // config keys written in camelCase
	headers       []headerEntry
	patterns      []patternEntry
	scriptSrc     []scriptSrcEntry
	structural    map[string]*Rule
	classRules    []*Rule
	apiGlobal     []*Rule
	metaConfig    []*Rule
	scriptLib     []*Rule
	detectAttrs   []signatureEntry
	anchorAPI     map[string]bool
	cfgKeyRe      *regexp.Regexp // any known config key, as a JSON key
	distinctKeyRe *regexp.Regexp // a camelCase config key, as a JSON key
	classRe       *regexp.Regexp // <id>-<suffix>
}

type scriptSrcEntry struct {
	rule *Rule
	re   *regexp.Regexp
	idG  int
}

// Load compiles the rule table embedded in the binary. The prefixes of the old
// library are not known yet: Bind gives the rule set the ones a project uses.
func Load() (*RuleSet, error) { return Parse(embeddedRules) }

// Parse compiles a rule table with no legacy prefix bound.
func Parse(data []byte) (*RuleSet, error) { return parse(data, nil, nil) }

// Bind returns the rule set with the attribute prefixes and the header
// prefixes of the legacy markup written into the rules that name them ({A} and
// {H} in the table). With no prefix, those rules match nothing.
func (rs *RuleSet) Bind(attr, hdr []string) (*RuleSet, error) { return parse(rs.raw, attr, hdr) }

// prefixAlt builds the regular expression of the prefixes, with the separator.
func prefixAlt(prefixes []string, sep string) string {
	if len(prefixes) == 0 {
		return `(?:\x00)`
	}
	q := make([]string, len(prefixes))
	for i, p := range prefixes {
		q[i] = regexp.QuoteMeta(p)
	}
	return "(?:" + strings.Join(q, "|") + ")" + sep
}

// expandRegex writes the prefixes into a pattern of the rule table.
func (rs *RuleSet) expandRegex(s string) string {
	if !strings.Contains(s, "{") {
		return s
	}
	s = strings.ReplaceAll(s, "{A}", prefixAlt(rs.attrPre, "-"))
	return strings.ReplaceAll(s, "{H}", prefixAlt(rs.hdrPre, "-"))
}

// expandNames writes the prefixes into names: "{A}get" becomes "acme-get".
func (rs *RuleSet) expandNames(names []string) []string {
	var out []string
	for _, n := range names {
		switch {
		case strings.HasPrefix(n, "{A}"):
			for _, p := range rs.attrPre {
				out = append(out, p+"-"+n[3:])
			}
		case strings.HasPrefix(n, "{H}"):
			for _, p := range rs.hdrPre {
				out = append(out, p+"-"+n[3:])
			}
		default:
			out = append(out, n)
		}
	}
	return out
}

func parse(data []byte, attr, hdr []string) (*RuleSet, error) {
	var fd fileData
	if err := json.Unmarshal(data, &fd); err != nil {
		return nil, fmt.Errorf("rules: %w", err)
	}
	rs := &RuleSet{
		raw: data, attrPre: attr, hdrPre: hdr,
		Meta: fd.Meta, Rules: fd.Rules, byID: map[string]*Rule{},
		events: map[string]eventEntry{}, jsAPI: map[string][]*Rule{}, config: map[string][]*Rule{},
		distinctCfg: map[string]bool{}, structural: map[string]*Rule{}, anchorAPI: map[string]bool{},
	}
	for _, s := range fd.Detect.Attributes {
		re, err := regexp.Compile("(?i)" + rs.expandRegex(s.Regex))
		if err != nil {
			return nil, fmt.Errorf("rules: detect %q: %w", s.Regex, err)
		}
		rs.detectAttrs = append(rs.detectAttrs, signatureEntry{line: s.Line, re: re})
	}
	for _, r := range rs.Rules {
		if len(r.Files) == 0 {
			r.Files = []string{"markup", "script"}
		}
		if _, dup := rs.byID[r.ID]; dup {
			return nil, fmt.Errorf("rules: duplicate id %s", r.ID)
		}
		rs.byID[r.ID] = r
		if err := rs.compile(r); err != nil {
			return nil, fmt.Errorf("rules: %s: %w", r.ID, err)
		}
	}
	var keys []string
	for k := range rs.config {
		keys = append(keys, regexp.QuoteMeta(k))
	}
	if len(keys) > 0 {
		rs.cfgKeyRe = regexp.MustCompile(`["']?\b(` + strings.Join(keys, "|") + `)\b["']?\s*:`)
	}
	var distinct []string
	for k := range rs.distinctCfg {
		distinct = append(distinct, regexp.QuoteMeta(k))
	}
	if len(distinct) > 0 {
		rs.distinctKeyRe = regexp.MustCompile(`["']?\b(` + strings.Join(distinct, "|") + `)\b["']?\s*:`)
	}
	var suffixes []string
	for _, r := range rs.classRules {
		for _, s := range r.Match.Suffixes {
			suffixes = append(suffixes, regexp.QuoteMeta(s))
		}
	}
	if len(suffixes) > 0 {
		rs.classRe = regexp.MustCompile(`([A-Za-z][A-Za-z0-9]*)-(` + strings.Join(suffixes, "|") + `)\b`)
	}
	return rs, nil
}

// Rule returns a rule by id.
func (rs *RuleSet) Rule(id string) (*Rule, bool) { r, ok := rs.byID[id]; return r, ok }

func set(list []string, lower bool) map[string]bool {
	m := make(map[string]bool, len(list))
	for _, s := range list {
		if lower {
			s = strings.ToLower(s)
		}
		m[s] = true
	}
	return m
}

func flagged(flags, pattern string) string {
	if strings.Contains(flags, "i") {
		return "(?i)" + pattern
	}
	return pattern
}

func (rs *RuleSet) compile(r *Rule) error {
	m := r.Match
	m.Names = rs.expandNames(m.Names)
	m.NameRegex = rs.expandRegex(m.NameRegex)
	m.Regex = rs.expandRegex(m.Regex)
	m.Value = rs.expandRegex(m.Value)
	m.ValueNot = rs.expandRegex(m.ValueNot)
	m.Src = rs.expandRegex(m.Src)
	if r.Kind != "header" {
		if strings.HasPrefix(m.Name, "{A}") || strings.HasPrefix(m.Name, "{H}") {
			m.Names = append(rs.expandNames([]string{m.Name}), m.Names...)
			m.Name = ""
		}
	}
	switch r.Kind {
	case "attr", "attr-value":
		e := attrEntry{rule: r, names: map[string]bool{}, tags: nil}
		for _, n := range m.Names {
			e.names[strings.ToLower(n)] = true
			if m.Prefix == nil || *m.Prefix {
				e.names["data-"+strings.ToLower(n)] = true
			}
		}
		var err error
		if m.NameRegex != "" {
			if e.nameRegex, err = regexp.Compile("(?i)" + m.NameRegex); err != nil {
				return err
			}
		}
		flags := m.Flags
		if flags == "" {
			flags = "i"
		}
		if m.Value != "" {
			if e.value, err = regexp.Compile(flagged(flags, m.Value)); err != nil {
				return err
			}
		}
		if m.ValueNot != "" {
			if e.valueNot, err = regexp.Compile(flagged(flags, m.ValueNot)); err != nil {
				return err
			}
		}
		if len(m.Tags) > 0 {
			e.tags = set(m.Tags, false)
		}
		if len(m.NotTags) > 0 {
			e.notTags = set(m.NotTags, false)
		}
		rs.attr = append(rs.attr, e)
	case "event":
		rs.events[normalizeEvent(m.Name)] = eventEntry{rule: r, distinctive: distinctiveEvent(m.Name)}
	case "event-prefix":
		if m.Regex != "" {
			re, err := regexp.Compile("^(?:" + m.Regex + ")$")
			if err != nil {
				return err
			}
			rs.eventNames = append(rs.eventNames, eventEntry{rule: r, nameRegex: re})
		}
		for _, n := range m.Names {
			rs.events[normalizeEvent(n)] = eventEntry{rule: r}
		}
	case "js-api":
		names := m.Names
		if m.Name != "" {
			names = append([]string{m.Name}, names...)
		}
		for _, n := range names {
			rs.jsAPI[n] = append(rs.jsAPI[n], r)
			if r.Anchor {
				rs.anchorAPI[n] = true
			}
		}
	case "config":
		keys := m.Keys
		if m.Key != "" {
			keys = append([]string{m.Key}, keys...)
		}
		for _, k := range keys {
			rs.config[k] = append(rs.config[k], r)
			if k != strings.ToLower(k) {
				rs.distinctCfg[k] = true
			}
		}
	case "header":
		name := strings.ReplaceAll(regexp.QuoteMeta(m.Name), "-", "[-_]")
		if strings.HasPrefix(m.Name, "{H}") {
			name = strings.TrimPrefix(name, `\{H\}`)
			name = prefixAlt(rs.hdrPre, "[-_]") + name
		}
		re, err := regexp.Compile("(?i)" + name)
		if err != nil {
			return err
		}
		rs.headers = append(rs.headers, headerEntry{rule: r, re: re, read: m.Context == "read"})
	case "pattern":
		flags := m.Flags
		re, err := regexp.Compile(flagged(flags, m.Regex))
		if err != nil {
			return err
		}
		rs.patterns = append(rs.patterns, patternEntry{rule: r, re: re, grp: m.Group})
	case "script-src":
		re, err := regexp.Compile("(?i)" + m.Src)
		if err != nil {
			return err
		}
		rs.scriptSrc = append(rs.scriptSrc, scriptSrcEntry{rule: r, re: re, idG: m.IDGroup})
	case "structural":
		rs.structural[m.Check] = r
	case "class":
		rs.classRules = append(rs.classRules, r)
	case "api-global":
		rs.apiGlobal = append(rs.apiGlobal, r)
	case "meta-config":
		rs.metaConfig = append(rs.metaConfig, r)
	case "script-library":
		rs.scriptLib = append(rs.scriptLib, r)
	default:
		return fmt.Errorf("unknown kind %q", r.Kind)
	}
	return nil
}

// normalizeEvent makes "after-swap" and "afterSwap" the same event name (the
// kebab twin of the v2 markup).
func normalizeEvent(name string) string {
	return strings.ReplaceAll(strings.ToLower(name), "-", "")
}

// distinctiveEvent reports whether an event name is spelled only by the old
// library: it has a capital letter (afterSwap) or a colon (xhr:loadstart).
func distinctiveEvent(name string) bool {
	return strings.ContainsRune(name, ':') || name != strings.ToLower(name)
}
