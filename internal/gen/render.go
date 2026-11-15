// SPDX-License-Identifier: MIT

package gen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Output paths, relative to the repository root.
const (
	VSCodePath   = "editors/vscode/ypy.html-data.json"
	WebTypesPath = "src/editors/jetbrains/ypy.web-types.json"
	SchemaPath   = "src/editors/schema/ypy.config.schema.json"
)

// Render returns every generated file, keyed by its path relative to the repository root.
func Render(t *Table) (map[string][]byte, error) {
	out := map[string][]byte{}
	for path, v := range map[string]any{
		VSCodePath:   vscodeData(t),
		WebTypesPath: webTypes(t),
		SchemaPath:   configSchema(t),
	} {
		b, err := marshal(v)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", path, err)
		}
		out[path] = b
	}
	return out, nil
}

func marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// editorAttrs are the attributes the editors offer: the ones of the native profile.
func editorAttrs(t *Table) []Attribute {
	var out []Attribute
	for _, a := range t.Attributes {
		if InNative(a.Profiles) {
			out = append(out, a)
		}
	}
	return out
}

// editorEvents are the events a page can listen to: DOM events of the native profile, not the legacy names.
func editorEvents(t *Table) []Event {
	var out []Event
	for _, e := range t.Events {
		if InNative(e.Profiles) && !e.Legacy && !e.ExtensionOnly {
			out = append(out, e)
		}
	}
	return out
}

// sections returns the markdown blocks that follow the description of an attribute.
func sections(t *Table, a Attribute) (values, modifiers, syntax, inheritance string) {
	if len(a.Values) > 0 {
		values = bullets(a.Values)
	}
	if len(a.Modifiers) > 0 {
		modifiers = bullets(a.Modifiers)
	}
	syntax = a.Syntax
	if a.Inherited {
		inheritance = "Use the `:inherited` modifier to apply this attribute to YPY requests in child elements."
		if !strings.Contains(a.Name, "*") {
			inheritance = "Use the `:inherited` modifier (for example, `" + a.Name + ":inherited`) to apply this attribute to YPY requests in child elements."
		}
	}
	return
}

func bullets(vs []Value) string {
	var b strings.Builder
	for i, v := range vs {
		if i > 0 {
			b.WriteByte('\n')
		}
		fmt.Fprintf(&b, "- `%s`: %s", v.Name, v.Description)
	}
	return b.String()
}

func requires(a Named) string {
	if a.Extension == "" {
		return ""
	}
	return "Requires the `" + a.Extension + "` extension."
}

// markdown is the full description of an attribute, for editors that show one block of text.
func markdown(t *Table, a Attribute) string {
	var parts []string
	parts = append(parts, a.Description)
	if r := requires(a.Named); r != "" {
		parts = append(parts, r)
	}
	values, modifiers, syntax, inheritance := sections(t, a)
	if syntax != "" {
		parts = append(parts, "Syntax: "+syntax)
	}
	if values != "" {
		parts = append(parts, "**Values**\n\n"+values)
	}
	if modifiers != "" {
		parts = append(parts, "**Modifiers**\n\n"+modifiers)
	}
	if inheritance != "" {
		parts = append(parts, "**Inheritance**\n\n"+inheritance)
	}
	if a.Deprecated != "" {
		parts = append(parts, "Deprecated: "+a.Deprecated)
	}
	return strings.Join(parts, "\n\n")
}

// --- VS Code: HTML Custom Data -------------------------------------------------------------

type vsDesc struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

type vsValue struct {
	Name        string  `json:"name"`
	Description *vsDesc `json:"description,omitempty"`
}

type vsAttr struct {
	Name        string    `json:"name"`
	Description vsDesc    `json:"description"`
	Values      []vsValue `json:"values,omitempty"`
}

type vsTag struct {
	Name        string   `json:"name"`
	Description vsDesc   `json:"description"`
	Attributes  []vsAttr `json:"attributes,omitempty"`
}

type vsData struct {
	Version          float64  `json:"version"`
	Tags             []vsTag  `json:"tags"`
	GlobalAttributes []vsAttr `json:"globalAttributes"`
}

func md(s string) vsDesc { return vsDesc{Kind: "markdown", Value: s} }

func vsValues(a Attribute) []vsValue {
	var out []vsValue
	for _, v := range a.Values {
		d := md(v.Description)
		out = append(out, vsValue{Name: v.Name, Description: &d})
	}
	if len(out) == 0 && a.ValueType == "boolean" {
		out = []vsValue{{Name: "true"}, {Name: "false"}}
	}
	return out
}

func vscodeData(t *Table) vsData {
	attrs := editorAttrs(t)
	byName := map[string]Attribute{}
	for _, a := range attrs {
		byName[a.Name] = a
	}
	data := vsData{Version: 1.1, Tags: []vsTag{}, GlobalAttributes: []vsAttr{}}
	for _, e := range t.Elements {
		tag := vsTag{Name: e.Name, Description: md(joinNonEmpty(e.Description, requires(e.Named)))}
		for _, name := range e.Attributes {
			if a, ok := byName[name]; ok {
				tag.Attributes = append(tag.Attributes, vsAttr{Name: a.Name, Description: md(markdown(t, a)), Values: vsValues(a)})
			}
		}
		data.Tags = append(data.Tags, tag)
	}
	events := editorEvents(t)
	for _, a := range attrs {
		// A family such as ypy-computed:<name> has no literal spelling: VS Code cannot complete
		// a pattern, so only its variants are offered.
		if !strings.HasSuffix(a.Name, "*") {
			data.GlobalAttributes = append(data.GlobalAttributes, vsAttr{Name: a.Name, Description: md(markdown(t, a)), Values: vsValues(a)})
		}
		for _, v := range a.Variants {
			if v != a.Name {
				data.GlobalAttributes = append(data.GlobalAttributes, vsAttr{Name: v, Description: md(markdown(t, a)), Values: vsValues(a)})
			}
		}
		if a.ExpandEvents {
			for _, e := range events {
				desc := "Runs the JavaScript when `" + e.Name + "` fires. " + e.Description
				data.GlobalAttributes = append(data.GlobalAttributes, vsAttr{Name: a.Name + "::" + strings.TrimPrefix(e.Name, "ypy:"), Description: md(desc)})
			}
		}
	}
	return data
}

func joinNonEmpty(parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "\n\n")
}

// --- JetBrains: web-types ------------------------------------------------------------------

type wtValue struct {
	Kind string `json:"kind"`
	Type string `json:"type,omitempty"`
}

type wtRegex struct {
	Regex string `json:"regex"`
}

type wtAttr struct {
	Name                string            `json:"name"`
	Pattern             any               `json:"pattern,omitempty"`
	Description         string            `json:"description"`
	DescriptionSections map[string]string `json:"description-sections,omitempty"`
	Value               *wtValue          `json:"value,omitempty"`
	Deprecated          bool              `json:"deprecated,omitempty"`
}

type wtElement struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Attributes  []wtAttr `json:"attributes,omitempty"`
}

type wtNamed struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type wtJSEvent struct {
	Name        string `json:"name"`
	Pattern     any    `json:"pattern,omitempty"`
	Description string `json:"description,omitempty"`
}

type wtTemplate struct {
	Items    []string `json:"items"`
	Template []string `json:"template"`
}

type wtOr struct {
	Or []wtTemplate `json:"or"`
}

type wtHTML struct {
	Elements   []wtElement `json:"elements"`
	Attributes []wtAttr    `json:"attributes"`
}

type wtCSS struct {
	Classes []wtNamed `json:"classes"`
}

type wtJS struct {
	Events    []wtJSEvent `json:"events"`
	YpyEvents []wtNamed   `json:"ypy-events"`
}

type wtContrib struct {
	HTML wtHTML `json:"html"`
	CSS  wtCSS  `json:"css"`
	JS   wtJS   `json:"js"`
}

type wtRoot struct {
	Schema      string    `json:"$schema"`
	Name        string    `json:"name"`
	Version     string    `json:"version"`
	Syntax      string    `json:"js-types-syntax"`
	Markup      string    `json:"description-markup"`
	Contributes wtContrib `json:"contributions"`
}

var anchors = regexp.MustCompile(`^\^|\$$`)

func webAttr(t *Table, a Attribute) wtAttr {
	w := wtAttr{Name: a.Name, Description: a.Description, Deprecated: a.Deprecated != ""}
	if r := requires(a.Named); r != "" {
		w.Description += " " + r
	}
	values, modifiers, syntax, inheritance := sections(t, a)
	w.DescriptionSections = map[string]string{}
	if syntax != "" {
		w.DescriptionSections["Syntax"] = syntax
	}
	if values != "" {
		w.DescriptionSections["Values"] = values
	}
	if modifiers != "" {
		w.DescriptionSections["Modifiers"] = modifiers
	}
	if inheritance != "" {
		w.DescriptionSections["Inheritance"] = inheritance
	}
	if len(w.DescriptionSections) == 0 {
		w.DescriptionSections = nil
	}
	switch a.ValueType {
	case "none":
		w.Value = &wtValue{Kind: "no-value"}
	case "boolean":
		w.Value = &wtValue{Kind: "plain", Type: "boolean"}
	case "number":
		w.Value = &wtValue{Kind: "plain", Type: "number"}
	case "expression":
		w.Value = &wtValue{Kind: "expression"}
	case "":
	default:
		w.Value = &wtValue{Kind: "plain", Type: "string"}
	}
	switch {
	case a.ExpandEvents:
		w.Pattern = wtOr{Or: []wtTemplate{
			{Items: []string{"/js/events"}, Template: []string{a.Name + ":", "#...", "#item:JS event"}},
			{Items: []string{"/js/ypy-events"}, Template: []string{a.Name + "::", "#...", "#item:YPY event"}},
		}}
		w.Name = a.Name
	case a.Pattern != "":
		w.Pattern = wtRegex{Regex: anchors.ReplaceAllString(a.Pattern, "")}
	case strings.HasSuffix(a.Name, "*"):
		w.Pattern = wtRegex{Regex: regexp.QuoteMeta(strings.TrimSuffix(a.Name, "*")) + ".+"}
	}
	return w
}

func webTypes(t *Table) wtRoot {
	root := wtRoot{
		Schema:  "https://json.schemastore.org/web-types",
		Name:    "ypy",
		Version: t.Version,
		Syntax:  "typescript",
		Markup:  "markdown",
	}
	attrs := editorAttrs(t)
	byName := map[string]Attribute{}
	for _, a := range attrs {
		byName[a.Name] = a
	}
	html := wtHTML{Elements: []wtElement{}, Attributes: []wtAttr{}}
	for _, e := range t.Elements {
		el := wtElement{Name: e.Name, Description: joinNonEmpty(e.Description, requires(e.Named))}
		for _, name := range e.Attributes {
			if a, ok := byName[name]; ok {
				el.Attributes = append(el.Attributes, webAttr(t, a))
			}
		}
		html.Elements = append(html.Elements, el)
	}
	for _, a := range attrs {
		html.Attributes = append(html.Attributes, webAttr(t, a))
	}
	css := wtCSS{Classes: []wtNamed{}}
	classes := append([]Class(nil), t.Classes...)
	sort.SliceStable(classes, func(i, j int) bool { return classes[i].Name < classes[j].Name })
	for _, c := range classes {
		css.Classes = append(css.Classes, wtNamed{Name: c.Name, Description: joinNonEmpty(c.Description, requires(c.Named))})
	}
	js := wtJS{
		Events: []wtJSEvent{{
			Name:    "YPY event",
			Pattern: wtTemplate{Items: []string{"/js/ypy-events"}, Template: []string{"ypy:", "$...", "#item:YPY event"}},
		}},
		YpyEvents: []wtNamed{},
	}
	for _, e := range editorEvents(t) {
		desc := e.Description
		if r := requires(e.Named); r != "" {
			desc += " " + r
		}
		js.YpyEvents = append(js.YpyEvents, wtNamed{Name: strings.TrimPrefix(e.Name, "ypy:"), Description: desc})
	}
	root.Contributes = wtContrib{HTML: html, CSS: css, JS: js}
	return root
}

// --- JSON schema of ypy.config -------------------------------------------------------------

type node struct {
	key      ConfigKey
	children []*node
}

// configSchema builds a JSON Schema (draft 2020-12) of the object written in the ypy-config meta tag.
// Every key of the table is listed, the keys of the compatibility profiles and the deprecated ones
// marked as deprecated. Objects do not accept keys that are not in the table.
func configSchema(t *Table) map[string]any {
	nodes := map[string]*node{}
	var roots []*node
	for _, c := range t.Config {
		n := &node{key: c}
		nodes[c.Name] = n
	}
	for _, c := range t.Config {
		n := nodes[c.Name]
		if i := strings.LastIndex(c.Name, "."); i > 0 {
			p := nodes[c.Name[:i]]
			p.children = append(p.children, n)
		} else {
			roots = append(roots, n)
		}
	}
	schema := map[string]any{
		"$schema":              "https://json-schema.org/draft/2020-12/schema",
		"title":                "YPY configuration",
		"description":          "The object written in `<meta name=\"ypy-config\" content='...'>` and the keys of `ypy.config`.",
		"type":                 "object",
		"additionalProperties": false,
		"properties":           properties(roots),
	}
	return schema
}

func properties(nodes []*node) map[string]any {
	props := map[string]any{}
	for _, n := range nodes {
		name := n.key.Name
		if i := strings.LastIndex(name, "."); i >= 0 {
			name = name[i+1:]
		}
		props[name] = propertySchema(n)
	}
	return props
}

func propertySchema(n *node) map[string]any {
	s, _ := n.key.SchemaMap()
	if s == nil {
		s = map[string]any{}
	}
	desc := n.key.Description
	if n.key.Extension != "" {
		desc += " Requires the `" + n.key.Extension + "` extension."
	}
	if len(n.key.Profiles) > 0 {
		desc += " Profiles: " + strings.Join(n.key.Profiles, ", ") + "."
	}
	s["description"] = desc
	s["markdownDescription"] = desc
	if len(n.key.Default) > 0 {
		var def any
		_ = json.Unmarshal(n.key.Default, &def)
		s["default"] = def
	}
	if n.key.Deprecated != "" || !InNative(n.key.Profiles) {
		s["deprecated"] = true
	}
	if len(n.children) > 0 {
		s["properties"] = properties(n.children)
		if _, ok := s["additionalProperties"]; !ok {
			s["additionalProperties"] = false
		}
	}
	return s
}
