// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"html"
	"regexp"
	"strings"
)

// HTML fragments returned by the example server, written in the native YPY idiom.

type app struct {
	id string // URL prefix and directory name under examples/
}

var apps = []app{{id: "native"}}

func (a app) base() string { return "/" + a.id + "/api" }

func esc(v string) string { return html.EscapeString(v) }

type item struct {
	ID   int
	Name string
}

// ---- CRUD -----------------------------------------------------------------

func itemRow(a app, it item) string {
	url := fmt.Sprintf("%s/items/%d", a.base(), it.ID)
	// There is no implicit inheritance: the tbody states the target with :inherited
	// and deletes use the "delete" swap style.
	swap := "delete swap:100ms"
	del := fmt.Sprintf(`ypy-delete="%s" ypy-confirm="Delete %s?" ypy-swap="%s"`, url, esc(it.Name), swap)
	return fmt.Sprintf(`<tr data-id="%d"><td class="name">%s</td>`, it.ID, esc(it.Name)) +
		fmt.Sprintf(`<td><button type="button" class="edit" ypy-get="%s/edit">Edit</button> `, url) +
		fmt.Sprintf(`<button type="button" class="delete" %s>Delete</button></td></tr>`, del)
}

func itemEditRow(a app, it item) string {
	url := fmt.Sprintf("%s/items/%d", a.base(), it.ID)
	return fmt.Sprintf(`<tr data-id="%d" class="editing"><td><input name="name" value="%s" aria-label="Name"></td>`, it.ID, esc(it.Name)) +
		fmt.Sprintf(`<td><button type="button" class="save" ypy-put="%s" ypy-include="closest tr">Save</button> `, url) +
		fmt.Sprintf(`<button type="button" class="cancel" ypy-get="%s">Cancel</button></td></tr>`, url)
}

func itemsTable(a app, items []item) string {
	inherit := `ypy-target:inherited="closest tr" ypy-swap:inherited="outerHTML"`
	var rows strings.Builder
	for _, it := range items {
		rows.WriteString(itemRow(a, it))
	}
	return `<table id="items-table"><thead><tr><th>Name</th><th>Actions</th></tr></thead>` +
		fmt.Sprintf(`<tbody id="items" %s>%s</tbody></table>`, inherit, rows.String())
}

// ---- Active search -----------------------------------------------------------

func searchResults(people []string) string {
	if len(people) == 0 {
		return `<li class="empty">No results</li>`
	}
	var b strings.Builder
	for _, p := range people {
		b.WriteString(`<li class="person">` + esc(p) + `</li>`)
	}
	return b.String()
}

// ---- Infinite scroll -----------------------------------------------------------

func scrollRows(a app, page, pageSize, total int) string {
	from := (page-1)*pageSize + 1
	to := min(page*pageSize, total)
	trigger := "intersect once"
	var b strings.Builder
	for n := from; n <= to; n++ {
		attrs := ""
		if n == to && to < total {
			attrs = fmt.Sprintf(` ypy-get="%s/rows?page=%d" ypy-trigger="%s" ypy-swap="afterend"`, a.base(), page+1, trigger)
		}
		fmt.Fprintf(&b, `<tr class="row" data-n="%d"%s><td>Row %d</td></tr>`, n, attrs, n)
	}
	return b.String()
}

// ---- Validation form -----------------------------------------------------------

type signupValues struct{ Name, Email, Password string }

func signupForm(a app, v signupValues, errs map[string]string) string {
	field := func(name, label, typ, value string) string {
		if typ == "password" {
			value = ""
		}
		s := fmt.Sprintf(`<p><label>%s <input name="%s" type="%s" value="%s"></label>`, label, name, typ, esc(value))
		if e, ok := errs[name]; ok {
			s += fmt.Sprintf(` <span class="error" data-field="%s">%s</span>`, name, esc(e))
		}
		return s + `</p>`
	}
	return fmt.Sprintf(`<form id="signup-form" ypy-post="%s/signup" ypy-target="this" ypy-swap="outerHTML" novalidate>`, a.base()) +
		field("name", "Name", "text", v.Name) +
		field("email", "Email", "text", v.Email) +
		field("password", "Password", "password", v.Password) +
		`<button type="submit">Sign up</button></form>`
}

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

func validateSignup(v signupValues) map[string]string {
	errs := map[string]string{}
	if len(strings.TrimSpace(v.Name)) < 2 {
		errs["name"] = "Name must have at least 2 characters."
	}
	if !emailRe.MatchString(v.Email) {
		errs["email"] = "Enter a valid email address."
	}
	if len(v.Password) < 8 {
		errs["password"] = "Password must have at least 8 characters."
	}
	return errs
}

// ---- SSE ---------------------------------------------------------------------------

func ssePanel(a app) string {
	return fmt.Sprintf(`<div id="sse-box" ypy-sse:connect="%s/sse" ypy-sse:close="done" ypy-target="#sse-log" ypy-swap="beforeend" `, a.base()) +
		`ypy-on:done="document.getElementById('sse-status').textContent = event.detail.data">` +
		`<ul id="sse-log"></ul><p id="sse-status">connected</p></div>`
}

func sseTick(_ app, n int) string {
	li := fmt.Sprintf(`<li class="tick">tick %d</li>`, n)
	// Unnamed events swap straight into the ypy-target of the connection.
	return "data: " + li + "\n\n"
}

// ---- WebSocket -----------------------------------------------------------------------

func wsPanel(a app) string {
	return fmt.Sprintf(`<div id="ws-box" ypy-ws:connect="/%s/ws" ypy-target="#ws-log" ypy-swap="beforeend">`, a.id) +
		`<div id="ws-log"></div>` +
		`<form id="ws-form" ypy-ws:send><input name="message" aria-label="Message"> <button type="submit">Send</button></form></div>`
}

// wsLine is swapped into the ypy-target of the connection.
func wsLine(_ app, text string) string {
	return `<p class="msg">` + esc(text) + `</p>`
}

var itemPath = regexp.MustCompile(`^/items/(\d+)(/edit)?$`)
