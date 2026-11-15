// SPDX-License-Identifier: MIT

// Package gen is "ypy gen": it reads the table of YPY names (src/attributes.json
// and one fragment per extension in src/attributes.d/) and generates the editor
// data from it: the VS Code HTML Custom Data, the JetBrains web-types and the JSON
// schema of ypy.config. It also checks that src/ypy.d.ts and the sources say the
// same as the table.
//
// The table is the only place where a name, its value, its default and its owner
// are written down. Nothing in this package hard-codes an attribute, an event, a
// header or a config key.
package gen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Paths, relative to the repository root.
const (
	CoreTable    = "src/attributes.json"
	FragmentsDir = "src/attributes.d"
	DTSPath      = "src/ypy.d.ts"
	ExtDir       = "src/ext"
	CSSDir       = "src/css"
	CoreSource   = "src/ypy.js"
)

// Profiles are the compatibility profiles a name can belong to.
var Profiles = []string{"native", "v1", "v2", "v4"}

// ValueTypes are the kinds of attribute values the table knows.
var ValueTypes = []string{"none", "string", "url", "selector", "time", "boolean", "enum", "json", "expression", "text", "number"}

// Named is something with a name and an owner.
type Named struct {
	Name string `json:"name"`
	// Extension is the slug of the extension that owns the entry; empty for the core.
	// It is stamped by Load from the fragment, never written in the files.
	Extension string `json:"-"`
}

// Value is one entry of an enumerated value or one modifier.
type Value struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Attribute is an attribute (or a family of attributes) of the HTML.
type Attribute struct {
	Named
	Description string   `json:"description"`
	ValueType   string   `json:"valueType,omitempty"`
	Values      []Value  `json:"values,omitempty"`
	Syntax      string   `json:"syntax,omitempty"`
	Modifiers   []Value  `json:"modifiers,omitempty"`
	Inherited   bool     `json:"inherited,omitempty"`
	Profiles    []string `json:"profiles,omitempty"`
	Variants    []string `json:"variants,omitempty"`
	Pattern     string   `json:"pattern,omitempty"`
	// ExpandEvents offers one variant per event (ypy-on::<event>) in editors.
	ExpandEvents bool   `json:"expandEvents,omitempty"`
	Doc          string `json:"doc,omitempty"`
	Deprecated   string `json:"deprecated,omitempty"`
}

// DocBase is where the documentation lives: the pages are on the website, not in
// the repository, so a "doc" field is an address under it.
const DocBase = "https://ypy.dev/docs/"

// Element is a custom element.
type Element struct {
	Named
	Description string   `json:"description"`
	Attributes  []string `json:"attributes,omitempty"`
}

// Event is a ypy:* event, or an extension hook of the same name.
type Event struct {
	Named
	Description string            `json:"description"`
	Detail      map[string]string `json:"detail"`
	Cancelable  bool              `json:"cancelable,omitempty"`
	Target      string            `json:"target,omitempty"`
	// Listen is true when YPY listens to the event instead of firing it.
	Listen bool `json:"listen,omitempty"`
	// Legacy marks the old camelCase names that exist only in the compat profiles.
	Legacy bool `json:"legacy,omitempty"`
	// ExtensionOnly marks hooks delivered to extensions (ypy_<name>), never to the DOM.
	ExtensionOnly bool     `json:"extensionOnly,omitempty"`
	Profiles      []string `json:"profiles,omitempty"`
	Doc           string   `json:"doc,omitempty"`
}

// Header is a YPY-* HTTP header.
type Header struct {
	Named
	Direction   string   `json:"direction"`
	Description string   `json:"description"`
	Value       string   `json:"value,omitempty"`
	Profiles    []string `json:"profiles,omitempty"`
	Legacy      bool     `json:"legacy,omitempty"`
}

// ConfigKey is a key of ypy.config and of the ypy-config meta tag. Nested keys use a dotted path.
type ConfigKey struct {
	Named
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
	Default     json.RawMessage `json:"default,omitempty"`
	Deprecated  string          `json:"deprecated,omitempty"`
	Profiles    []string        `json:"profiles,omitempty"`
}

// Class is a CSS class YPY adds.
type Class struct {
	Named
	Description string `json:"description"`
}

// file is the shape of the core table and of every fragment.
type file struct {
	Comment       string      `json:"$comment,omitempty"`
	Version       string      `json:"version,omitempty"`
	Extension     string      `json:"extension,omitempty"`
	Elements      []Element   `json:"elements,omitempty"`
	Attributes    []Attribute `json:"attributes,omitempty"`
	Events        []Event     `json:"events,omitempty"`
	Headers       []Header    `json:"headers,omitempty"`
	Config        []ConfigKey `json:"config,omitempty"`
	Classes       []Class     `json:"classes,omitempty"`
	InternalNames []string    `json:"internalNames,omitempty"`
}

// Table is the merged table: the core and every extension fragment.
type Table struct {
	Version    string
	Elements   []Element
	Attributes []Attribute
	Events     []Event
	Headers    []Header
	Config     []ConfigKey
	Classes    []Class
	// Internal maps a name that appears in the sources but is not public to its owner.
	Internal map[string]string
	// Extensions lists the slugs that have a fragment, sorted.
	Extensions []string
}

// Load reads the core table and every fragment under root and checks the result.
func Load(root string) (*Table, error) {
	core, err := readFile(filepath.Join(root, filepath.FromSlash(CoreTable)))
	if err != nil {
		return nil, err
	}
	if core.Extension != "" {
		return nil, fmt.Errorf("%s: the core table has no \"extension\"", CoreTable)
	}
	if core.Version != "" {
		return nil, fmt.Errorf("%s: no \"version\" here; the version is the file VERSION at the root", CoreTable)
	}
	version, err := os.ReadFile(filepath.Join(root, "VERSION"))
	if err != nil {
		return nil, err
	}
	t := &Table{Version: strings.TrimSpace(string(version)), Internal: map[string]string{}}
	t.add("", core)

	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(FragmentsDir)))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		rel := FragmentsDir + "/" + n
		f, err := readFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		slug := strings.TrimSuffix(n, ".json")
		if f.Extension != slug {
			return nil, fmt.Errorf("%s: \"extension\" is %q, want %q (the file name)", rel, f.Extension, slug)
		}
		if f.Version != "" {
			return nil, fmt.Errorf("%s: no \"version\" here; the version is the file VERSION at the root", rel)
		}
		t.Extensions = append(t.Extensions, slug)
		t.add(slug, f)
	}
	if problems := t.Validate(); len(problems) > 0 {
		return nil, &ValidationError{Problems: problems}
	}
	return t, nil
}

// ValidationError lists every problem of a table.
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "the table of names is not valid:\n  " + strings.Join(e.Problems, "\n  ")
}

func readFile(path string) (*file, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f file
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("%s: %v", filepath.Base(path), err)
	}
	return &f, nil
}

func (t *Table) add(slug string, f *file) {
	for _, e := range f.Elements {
		e.Extension = slug
		t.Elements = append(t.Elements, e)
	}
	for _, a := range f.Attributes {
		a.Extension = slug
		t.Attributes = append(t.Attributes, a)
	}
	for _, e := range f.Events {
		e.Extension = slug
		t.Events = append(t.Events, e)
	}
	for _, h := range f.Headers {
		h.Extension = slug
		t.Headers = append(t.Headers, h)
	}
	for _, c := range f.Config {
		c.Extension = slug
		t.Config = append(t.Config, c)
	}
	for _, c := range f.Classes {
		c.Extension = slug
		t.Classes = append(t.Classes, c)
	}
	for _, n := range f.InternalNames {
		if _, dup := t.Internal[n]; !dup {
			t.Internal[n] = slug
		}
	}
}

var (
	attrName   = regexp.MustCompile(`^ypy-[a-z0-9][a-z0-9:.*-]*$`)
	eventName  = regexp.MustCompile(`^ypy:[A-Za-z0-9][A-Za-z0-9:*_-]*$`)
	headerName = regexp.MustCompile(`^YPY-[A-Za-z0-9][A-Za-z0-9-]*$`)
	configName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$`)
	// A variant is a spelling of a family: ypy-live:?disabled, ypy-live:.active, ypy-on::after:swap.
	variantName = regexp.MustCompile(`^ypy-[a-z0-9][a-z0-9-]*(:[:.?A-Za-z0-9_-]+)?$`)
	className   = regexp.MustCompile(`^ypy-[a-z0-9][a-z0-9-]*$`)
)

func in(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Validate checks the table and returns every problem found.
func (t *Table) Validate() []string {
	var p []string
	bad := func(format string, args ...any) { p = append(p, fmt.Sprintf(format, args...)) }
	where := func(ext string) string {
		if ext == "" {
			return "core"
		}
		return ext
	}
	profiles := func(kind, name, ext string, list []string) {
		for _, x := range list {
			if !in(Profiles, x) {
				bad("%s %s (%s): unknown profile %q", kind, name, where(ext), x)
			}
		}
	}
	if t.Version == "" {
		bad("the file VERSION is empty")
	}

	seen := map[string]string{}
	dup := func(kind, key, ext string) {
		id := kind + " " + key
		if first, ok := seen[id]; ok {
			bad("%s %s is defined twice (%s and %s)", kind, key, where(first), where(ext))
			return
		}
		seen[id] = ext
	}

	attrs := map[string]bool{}
	for _, a := range t.Attributes {
		dup("attribute", a.Name, a.Extension)
		attrs[a.Name] = true
		if !attrName.MatchString(a.Name) {
			bad("attribute %q (%s): the name must start with ypy- and use lower case", a.Name, where(a.Extension))
		}
		if strings.TrimSpace(a.Description) == "" {
			bad("attribute %s (%s): no description", a.Name, where(a.Extension))
		}
		if a.Doc != "" && !strings.HasPrefix(a.Doc, DocBase) {
			bad("attribute %s (%s): \"doc\" must be a page of %s", a.Name, where(a.Extension), DocBase)
		}
		if a.ValueType != "" && !in(ValueTypes, a.ValueType) {
			bad("attribute %s (%s): unknown valueType %q", a.Name, where(a.Extension), a.ValueType)
		}
		profiles("attribute", a.Name, a.Extension, a.Profiles)
		if a.Pattern != "" {
			if _, err := regexp.Compile(a.Pattern); err != nil {
				bad("attribute %s (%s): bad pattern: %v", a.Name, where(a.Extension), err)
			}
			if !strings.HasSuffix(a.Name, "*") {
				bad("attribute %s (%s): a pattern belongs to a family name that ends with *", a.Name, where(a.Extension))
			}
		}
		for _, v := range a.Variants {
			if !variantName.MatchString(v) {
				bad("attribute %s (%s): variant %q is not an attribute name", a.Name, where(a.Extension), v)
			}
		}
		for _, v := range append(append([]Value{}, a.Values...), a.Modifiers...) {
			if v.Name == "" || v.Description == "" {
				bad("attribute %s (%s): a value or modifier needs a name and a description", a.Name, where(a.Extension))
			}
		}
	}
	for _, e := range t.Elements {
		dup("element", e.Name, e.Extension)
		if !attrName.MatchString(e.Name) {
			bad("element %q (%s): the name must start with ypy-", e.Name, where(e.Extension))
		}
		if strings.TrimSpace(e.Description) == "" {
			bad("element %s (%s): no description", e.Name, where(e.Extension))
		}
		for _, a := range e.Attributes {
			if !attrs[a] {
				bad("element %s (%s): attribute %s is not in the table", e.Name, where(e.Extension), a)
			}
		}
	}
	for _, e := range t.Events {
		dup("event", e.Name, e.Extension)
		if !eventName.MatchString(e.Name) {
			bad("event %q (%s): the name must look like ypy:<noun>:<verb>", e.Name, where(e.Extension))
		}
		if strings.TrimSpace(e.Description) == "" {
			bad("event %s (%s): no description", e.Name, where(e.Extension))
		}
		if e.Detail == nil {
			bad("event %s (%s): \"detail\" is missing (write {} for an empty detail)", e.Name, where(e.Extension))
		}
		for k, v := range e.Detail {
			if k == "" || strings.TrimSpace(v) == "" {
				bad("event %s (%s): detail field %q needs a TypeScript type", e.Name, where(e.Extension), k)
			}
		}
		if e.Doc != "" && !strings.HasPrefix(e.Doc, DocBase) {
			bad("event %s (%s): \"doc\" must be a page of %s", e.Name, where(e.Extension), DocBase)
		}
		if e.Target != "" && !in([]string{"element", "document", "window"}, e.Target) {
			bad("event %s (%s): unknown target %q", e.Name, where(e.Extension), e.Target)
		}
		if e.Target == "" && !e.ExtensionOnly {
			bad("event %s (%s): \"target\" is missing", e.Name, where(e.Extension))
		}
		profiles("event", e.Name, e.Extension, e.Profiles)
	}
	for _, h := range t.Headers {
		dup("header", h.Direction+" "+h.Name, h.Extension)
		if !headerName.MatchString(h.Name) {
			bad("header %q (%s): the name must start with YPY-", h.Name, where(h.Extension))
		}
		if h.Direction != "request" && h.Direction != "response" {
			bad("header %s (%s): direction must be request or response", h.Name, where(h.Extension))
		}
		if strings.TrimSpace(h.Description) == "" {
			bad("header %s (%s): no description", h.Name, where(h.Extension))
		}
		profiles("header", h.Name, h.Extension, h.Profiles)
	}
	cfg := map[string]bool{}
	for _, c := range t.Config {
		cfg[c.Name] = true
	}
	for _, c := range t.Config {
		dup("config", c.Name, c.Extension)
		if !configName.MatchString(c.Name) {
			bad("config key %q (%s): use a name or a dotted path", c.Name, where(c.Extension))
		}
		if strings.TrimSpace(c.Description) == "" {
			bad("config key %s (%s): no description", c.Name, where(c.Extension))
		}
		profiles("config key", c.Name, c.Extension, c.Profiles)
		if i := strings.LastIndex(c.Name, "."); i > 0 && !cfg[c.Name[:i]] {
			bad("config key %s (%s): its parent %s is not in the table", c.Name, where(c.Extension), c.Name[:i])
		}
		schema, err := c.SchemaMap()
		if err != nil {
			bad("config key %s (%s): %v", c.Name, where(c.Extension), err)
			continue
		}
		if len(c.Default) > 0 {
			var def any
			if err := json.Unmarshal(c.Default, &def); err != nil {
				bad("config key %s (%s): the default is not JSON: %v", c.Name, where(c.Extension), err)
			} else if !fits(schema, def) {
				bad("config key %s (%s): the default %s does not fit its schema", c.Name, where(c.Extension), c.Default)
			}
		}
	}
	for _, c := range t.Classes {
		dup("class", c.Name, c.Extension)
		if !className.MatchString(c.Name) {
			bad("class %q (%s): the name must start with ypy-", c.Name, where(c.Extension))
		}
		if strings.TrimSpace(c.Description) == "" {
			bad("class %s (%s): no description", c.Name, where(c.Extension))
		}
	}
	for n, ext := range t.Internal {
		if t.Known(n) {
			bad("internal name %s (%s) is also a public name; keep it in one place", n, where(ext))
		}
	}
	sort.Strings(p)
	return p
}

// SchemaMap decodes the JSON Schema fragment of a config key.
func (c ConfigKey) SchemaMap() (map[string]any, error) {
	if len(c.Schema) == 0 {
		return nil, fmt.Errorf("\"schema\" is missing")
	}
	var m map[string]any
	if err := json.Unmarshal(c.Schema, &m); err != nil {
		return nil, fmt.Errorf("the schema is not a JSON object: %v", err)
	}
	return m, nil
}

// fits reports whether a value is acceptable for the small subset of JSON Schema the table uses
// (type, enum). Anything else is accepted.
func fits(schema map[string]any, v any) bool {
	if enum, ok := schema["enum"].([]any); ok {
		for _, e := range enum {
			if jsonEqual(e, v) {
				return true
			}
		}
		return false
	}
	var types []string
	switch t := schema["type"].(type) {
	case string:
		types = []string{t}
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				types = append(types, s)
			}
		}
	}
	if len(types) == 0 {
		return true
	}
	for _, t := range types {
		switch t {
		case "boolean":
			if _, ok := v.(bool); ok {
				return true
			}
		case "string":
			if _, ok := v.(string); ok {
				return true
			}
		case "integer":
			if f, ok := v.(float64); ok && f == float64(int64(f)) {
				return true
			}
		case "number":
			if _, ok := v.(float64); ok {
				return true
			}
		case "array":
			if _, ok := v.([]any); ok {
				return true
			}
		case "object":
			if _, ok := v.(map[string]any); ok {
				return true
			}
		case "null":
			if v == nil {
				return true
			}
		}
	}
	return false
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// Known reports whether name is a public name of any kind: attribute, element, event, header or class.
func (t *Table) Known(name string) bool {
	for _, a := range t.Attributes {
		if a.Name == name {
			return true
		}
	}
	for _, e := range t.Elements {
		if e.Name == name {
			return true
		}
	}
	for _, e := range t.Events {
		if e.Name == name {
			return true
		}
	}
	for _, h := range t.Headers {
		if h.Name == name {
			return true
		}
	}
	for _, c := range t.Classes {
		if c.Name == name {
			return true
		}
	}
	return false
}

// HasProfile reports whether a list of profiles includes p; an empty list means every profile.
func HasProfile(list []string, p string) bool {
	return len(list) == 0 || in(list, p)
}

// InNative reports whether a name belongs to the native profile (the one new pages use).
func InNative(list []string) bool { return HasProfile(list, "native") }
