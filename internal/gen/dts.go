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

// member is one property or method of an interface, or one field of an object type.
type member struct {
	Name     string
	Type     string // the type text, comments removed; empty for a method
	Optional bool
	Method   bool
}

// DTS is what the checks need to know about src/ypy.d.ts: its interfaces with every
// member of every merged declaration.
type DTS struct {
	Interfaces map[string][]member
}

// stripComments removes /* */ and // comments and keeps strings as they are.
func stripComments(src string) string {
	var b strings.Builder
	for i := 0; i < len(src); {
		c := src[i]
		switch {
		case c == '\'' || c == '"' || c == '`':
			// A ' or " string ends with its line (a quote inside a regular expression literal must not
			// swallow the rest of the file); only a template literal spans lines.
			j := i + 1
			for j < len(src) && src[j] != c && (c == '`' || src[j] != '\n') {
				if src[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(src) {
				j = len(src) - 1
			}
			end := j + 1
			if src[j] == '\n' {
				end = j
			}
			b.WriteString(src[i:end])
			i = end
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			j := strings.Index(src[i+2:], "*/")
			if j < 0 {
				return b.String()
			}
			// Keep the lines, so a position in the result is a position in the file.
			b.WriteString(strings.Repeat("\n", strings.Count(src[i:i+j+4], "\n")))
			b.WriteByte(' ')
			i += j + 4
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String()
}

var (
	reInterface = regexp.MustCompile(`(?m)^\s*(?:export\s+)?interface\s+([A-Za-z_]\w*)(?:<[^>{]*>)?(?:\s+extends\s+[^{]+)?\s*\{`)
	reNamespace = regexp.MustCompile(`(?m)^\s*(?:export\s+)?namespace\s+([A-Za-z_]\w*)\s*\{`)
)

// ParseDTS parses the interfaces of a declaration file. It understands what ypy.d.ts uses
// (interfaces, namespaces that hold interfaces, property and method signatures) and nothing more.
func ParseDTS(src string) *DTS {
	src = stripComments(src)
	d := &DTS{Interfaces: map[string][]member{}}
	// Namespaces: remember the span of each, so an interface in it gets the qualified name.
	type span struct {
		name       string
		start, end int
	}
	var spans []span
	for _, m := range reNamespace.FindAllStringSubmatchIndex(src, -1) {
		open := m[1] - 1
		spans = append(spans, span{src[m[2]:m[3]], open, matching(src, open)})
	}
	for _, m := range reInterface.FindAllStringSubmatchIndex(src, -1) {
		name := src[m[2]:m[3]]
		open := m[1] - 1
		for _, s := range spans {
			if open > s.start && open < s.end {
				name = s.name + "." + name
			}
		}
		end := matching(src, open)
		d.Interfaces[name] = append(d.Interfaces[name], parseMembers(src[open+1:end])...)
	}
	return d
}

// matching returns the index of the brace that closes the one at open.
func matching(src string, open int) int {
	depth := 0
	for i := open; i < len(src); i++ {
		switch src[i] {
		case '\'', '"', '`':
			q := src[i]
			i++
			for i < len(src) && src[i] != q {
				if src[i] == '\\' {
					i++
				}
				i++
			}
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return len(src) - 1
}

// parseMembers reads the members of an interface body or an object type body.
func parseMembers(body string) []member {
	var out []member
	i := 0
	skipSpace := func() {
		for i < len(body) && (body[i] == ' ' || body[i] == '\t' || body[i] == '\n' || body[i] == '\r' || body[i] == ';' || body[i] == ',') {
			i++
		}
	}
	for {
		skipSpace()
		if i >= len(body) {
			return out
		}
		var m member
		start := i
		switch {
		case body[i] == '\'' || body[i] == '"':
			q := body[i]
			j := i + 1
			for j < len(body) && body[j] != q {
				j++
			}
			m.Name = body[i+1 : j]
			i = j + 1
		case body[i] == '[':
			// An index signature: skip it entirely.
			i = endOfMember(body, i)
			continue
		default:
			for i < len(body) && (isIdent(body[i])) {
				i++
			}
			m.Name = body[start:i]
			if m.Name == "readonly" && i < len(body) && body[i] == ' ' {
				skipSpace()
				start = i
				for i < len(body) && isIdent(body[i]) {
					i++
				}
				m.Name = body[start:i]
			}
		}
		if m.Name == "" {
			i++
			continue
		}
		for i < len(body) && body[i] == ' ' {
			i++
		}
		if i < len(body) && body[i] == '?' {
			m.Optional = true
			i++
		}
		if i < len(body) && (body[i] == '(' || body[i] == '<') {
			m.Method = true
			i = endOfMember(body, i)
			out = append(out, m)
			continue
		}
		if i < len(body) && body[i] == ':' {
			i++
			end := endOfMember(body, i)
			m.Type = strings.TrimSpace(body[i:end])
			i = end
		}
		out = append(out, m)
	}
}

func isIdent(c byte) bool {
	return c == '_' || c == '$' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// endOfMember returns the index of the ';' or ',' that ends the member that contains from,
// or the end of the text.
func endOfMember(body string, from int) int {
	depth := 0
	for i := from; i < len(body); i++ {
		switch body[i] {
		case '\'', '"', '`':
			q := body[i]
			i++
			for i < len(body) && body[i] != q {
				if body[i] == '\\' {
					i++
				}
				i++
			}
		case '(', '{', '[', '<':
			depth++
		case ')', '}', ']':
			depth--
		case '>':
			// the > of an arrow function type (=>) closes nothing
			if i == 0 || body[i-1] != '=' {
				depth--
			}
		case ';', ',':
			if depth == 0 {
				return i
			}
		case '\n':
			// A member may end at a newline when the next line starts a new member; ypy.d.ts always
			// uses ';', so a newline does not end one.
		}
	}
	return len(body)
}

// keys returns the names of the members of an interface, sorted, without methods.
func (d *DTS) keys(iface string, withMethods bool) []string {
	seen := map[string]bool{}
	for _, m := range d.Interfaces[iface] {
		if m.Method && !withMethods {
			continue
		}
		seen[m.Name] = true
	}
	return sortedKeys(seen)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// eventTypes returns the type text of each event of YpyNativeEventMap and YpyEventMap.
func (d *DTS) eventTypes() map[string]string {
	out := map[string]string{}
	for _, iface := range []string{"YpyNativeEventMap", "YpyEventMap"} {
		for _, m := range d.Interfaces[iface] {
			out[m.Name] = m.Type
		}
	}
	return out
}

var reIdent = regexp.MustCompile(`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*`)

// configChild finds the interface that describes the keys of a config member from its type text:
// "YpyClasses", "boolean | YpyAnnounceConfig", "Partial<YpyRetryOptions>", "YpyLive.Config".
func (d *DTS) configChild(typ string) string {
	// A list of objects (responseHandling) is one key; the fields of its items are not config keys.
	if strings.Contains(typ, "[]") || strings.Contains(typ, "Array<") {
		return ""
	}
	for _, id := range reIdent.FindAllString(typ, -1) {
		if id == "Partial" || id == "Record" || id == "Omit" {
			continue
		}
		if _, ok := d.Interfaces[id]; ok {
			return id
		}
	}
	return ""
}

// ConfigPaths returns every dotted config path that ypy.d.ts declares, starting at YpyConfig.
func (d *DTS) ConfigPaths() []string {
	seen := map[string]bool{}
	var walk func(iface, prefix string, depth int)
	walk = func(iface, prefix string, depth int) {
		if depth > 6 {
			return
		}
		for _, m := range d.Interfaces[iface] {
			if m.Method {
				continue
			}
			path := prefix + m.Name
			seen[path] = true
			if child := d.configChild(m.Type); child != "" {
				walk(child, path+".", depth+1)
			}
		}
	}
	walk("YpyConfig", "", 0)
	return sortedKeys(seen)
}

// detailKeys returns the keys of the object type of an event detail, and whether it could tell.
func detailKeys(typ string) ([]string, bool) {
	typ = strings.TrimSpace(typ)
	if strings.HasPrefix(typ, "Record<") {
		return nil, true
	}
	if !strings.HasPrefix(typ, "{") {
		return nil, false
	}
	end := matching(typ, 0)
	seen := map[string]bool{}
	for _, m := range parseMembers(typ[1:end]) {
		seen[m.Name] = true
	}
	return sortedKeys(seen), true
}

// CheckDTS compares src/ypy.d.ts with the table and returns what differs.
func CheckDTS(t *Table, root string) ([]string, error) {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(DTSPath)))
	if err != nil {
		return nil, err
	}
	d := ParseDTS(string(data))
	var p []string

	// Events: the DOM events of the table and the ones of YpyEventMap are the same set, with the same detail fields.
	declared := d.eventTypes()
	wanted := map[string]Event{}
	for _, e := range t.Events {
		if e.Legacy || e.ExtensionOnly || strings.HasSuffix(e.Name, "*") {
			continue
		}
		wanted[e.Name] = e
	}
	for name, e := range wanted {
		typ, ok := declared[name]
		if !ok {
			p = append(p, fmt.Sprintf("ypy.d.ts has no YpyEventMap entry for %s (%s)", name, owner(e.Extension)))
			continue
		}
		got, known := detailKeys(typ)
		if !known {
			continue
		}
		want := make([]string, 0, len(e.Detail))
		for k := range e.Detail {
			want = append(want, k)
		}
		sort.Strings(want)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			p = append(p, fmt.Sprintf("event %s: detail fields differ: ypy.d.ts has [%s], the table has [%s]", name, strings.Join(got, " "), strings.Join(want, " ")))
		}
	}
	for name := range declared {
		if _, ok := wanted[name]; !ok {
			p = append(p, fmt.Sprintf("ypy.d.ts declares the event %s, which is not a DOM event in the table (add it to the table, or move a hook to YpyHookMap)", name))
		}
	}

	// Config: the paths of YpyConfig and the config keys of the table are the same set.
	paths := map[string]bool{}
	for _, c := range d.ConfigPaths() {
		paths[c] = true
	}
	tableKeys := map[string]ConfigKey{}
	for _, c := range t.Config {
		tableKeys[c.Name] = c
	}
	for name, c := range tableKeys {
		if !paths[name] {
			p = append(p, fmt.Sprintf("ypy.d.ts has no type for the config key %s (%s)", name, owner(c.Extension)))
		}
	}
	for name := range paths {
		if _, ok := tableKeys[name]; !ok {
			p = append(p, fmt.Sprintf("ypy.d.ts declares the config key %s, which is not in the table", name))
		}
	}
	sort.Strings(p)
	return p, nil
}

func owner(ext string) string {
	if ext == "" {
		return "core"
	}
	return ext
}
