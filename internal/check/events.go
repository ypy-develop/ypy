// SPDX-License-Identifier: MIT

package check

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// events.json lists the events YPY emits: the table of src/attributes.json, the events of the
// extensions and the families built at run time. TestEmittedEventsMatchTheSource keeps it in step
// with the source.
//
//go:embed events.json
var emittedJSON []byte

type emittedTable struct {
	names    map[string]bool
	families []string // prefixes, without the trailing "*"
}

var emitted = loadEmitted()

func loadEmitted() emittedTable {
	var raw struct {
		Events   []string `json:"events"`
		Families []string `json:"families"`
	}
	if err := json.Unmarshal(emittedJSON, &raw); err != nil {
		panic("check: events.json: " + err.Error())
	}
	t := emittedTable{names: map[string]bool{}}
	for _, n := range raw.Events {
		t.names[n] = true
	}
	for _, f := range raw.Families {
		t.families = append(t.families, strings.TrimSuffix(f, "*"))
	}
	return t
}

// isEmitted reports whether YPY emits the event (name with its "ypy:" prefix).
func isEmitted(name string) bool {
	if emitted.names[name] {
		return true
	}
	for _, f := range emitted.families {
		if strings.HasPrefix(name, f) && len(name) > len(f) {
			return true
		}
	}
	return false
}

// isEmittedWithModifiers is isEmitted for a name followed by modifiers that are not part of it
// (ypy-on::after:swap:once): any whole-segment start of the name that is emitted counts.
func isEmittedWithModifiers(name string) bool {
	for n := name; n != ""; {
		if isEmitted(n) {
			return true
		}
		i := strings.LastIndexByte(n, ':')
		if i < 0 {
			return false
		}
		n = n[:i]
	}
	return false
}

// nativeOfLegacy returns the YPY event that replaces a legacy event name written without a
// prefix ("afterSwap", "after-swap"), or "".
func (rs *RuleSet) nativeOfLegacy(name string) string {
	if en, ok := rs.events[normalizeEvent(name)]; ok && en.rule != nil && en.rule.Kind == "event" {
		native := en.rule.Native
		if i := strings.IndexByte(native, ' '); i >= 0 {
			native = native[:i]
		}
		if strings.HasPrefix(native, "ypy:") && !strings.ContainsAny(native, "()<>") {
			return native
		}
	}
	return ""
}
