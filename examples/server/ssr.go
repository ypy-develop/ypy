// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// A small server-rendered site for the SSR and SPA scenarios of the end to end
// suite. The same URL answers a whole page to the browser and a fragment (the
// body, with the title) to a YPY request, and says so with Vary: YPY-Request.
//
//	/ssr/        YPY loaded: boosted links and forms, prefetch, progress, persist
//	/ssr-nojs/   the same pages with a CSP that forbids every script: plain HTML
//
// Both are served by one handler; the prefix is the only difference.

const (
	ssrBase     = "/ssr"
	ssrNoJSBase = "/ssr-nojs"
)

// ssrHit is one request the site answered, read back by the scenarios.
type ssrHit struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Request bool   `json:"request"`           // carried YPY-Request
	Boosted bool   `json:"boosted"`           // carried YPY-Boosted
	Restore bool   `json:"restore"`           // carried YPY-History-Restore-Request
	Purpose string `json:"purpose,omitempty"` // YPY-Purpose
	Whole   bool   `json:"whole"`             // the answer was a whole page
}

type ssrSite struct {
	mu       sync.Mutex
	hits     []ssrHit
	note     string // the last value saved by the notes field
	messages int    // contact messages accepted
}

func (s *ssrSite) record(h ssrHit) {
	s.mu.Lock()
	s.hits = append(s.hits, h)
	s.mu.Unlock()
}

func ssrPrefix(p string) (string, string, bool) {
	for _, base := range []string{ssrNoJSBase, ssrBase} {
		if p == base || strings.HasPrefix(p, base+"/") {
			rest := strings.TrimPrefix(p, base)
			if rest == "" {
				rest = "/"
			}
			return base, rest, true
		}
	}
	return "", "", false
}

func (s *server) ssr(w http.ResponseWriter, r *http.Request, base, rest string) {
	site := &s.site
	h := w.Header()
	h.Set("Vary", "YPY-Request")
	h.Set("Cache-Control", "no-store")
	switch {
	case rest == "/_reset" && r.Method == http.MethodPost:
		site.mu.Lock()
		site.hits, site.note, site.messages = nil, "", 0
		site.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	case rest == "/_log":
		site.mu.Lock()
		out, _ := json.Marshal(map[string]any{"hits": site.hits, "note": site.note, "messages": site.messages})
		site.mu.Unlock()
		send(w, 200, "application/json", string(out))
		return
	}

	req := r.Header.Get("YPY-Request") != ""
	hit := ssrHit{
		Method:  r.Method,
		Path:    r.URL.RequestURI(),
		Request: req,
		Boosted: r.Header.Get("YPY-Boosted") != "",
		Restore: r.Header.Get("YPY-History-Restore-Request") != "",
		Purpose: r.Header.Get("YPY-Purpose"),
	}
	// page answers with the body of a page, whole or as a fragment.
	page := func(status int, title, main string) {
		hit.Whole = !req
		site.record(hit)
		body := ssrBody(base, title, main)
		h.Set("Content-Type", "text/html; charset=utf-8")
		if base == ssrNoJSBase {
			h.Set("Content-Security-Policy", "script-src 'none'")
		}
		w.WriteHeader(status)
		if req {
			_, _ = fmt.Fprintf(w, "<title>%s</title>\n%s", esc(ssrTitle(title)), body)
			return
		}
		_, _ = w.Write([]byte(ssrDocument(ssrScripts, title, body)))
	}

	switch {
	case rest == "/" && r.Method == http.MethodGet:
		page(200, "Home", `<h1>Home</h1><p id="lead">A server-rendered site.</p>`)
	case rest == "/about" && r.Method == http.MethodGet:
		page(200, "About", `<h1>About</h1><p id="lead">Every page works as plain HTML.</p>`)
	case rest == "/slow" && r.Method == http.MethodGet:
		time.Sleep(700 * time.Millisecond)
		page(200, "Slow", `<h1>Slow</h1><p id="lead">This page took a while.</p>`)
	case rest == "/legacy" && r.Method == http.MethodGet:
		// a page of the server that is not part of the app: no #app root, always whole
		hit.Whole = true
		site.record(hit)
		h.Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(ssrDocument(ssrScripts, "Legacy",
			`<h1 id="legacy">Legacy page</h1><p><a href="`+base+`/">Back to the app</a></p>`)))
	case rest == "/contact" && r.Method == http.MethodGet:
		page(200, "Contact", ssrContact(base, "", "", nil))
	case rest == "/contact" && r.Method == http.MethodPost:
		if err := r.ParseForm(); err != nil {
			send(w, http.StatusBadRequest, "text/plain", "bad form")
			return
		}
		name, msg := strings.TrimSpace(r.PostForm.Get("name")), strings.TrimSpace(r.PostForm.Get("message"))
		errs := map[string]string{}
		if len(name) < 2 {
			errs["name"] = "Name must have at least 2 characters."
		}
		if len(msg) < 5 {
			errs["message"] = "Message must have at least 5 characters."
		}
		if len(errs) > 0 {
			page(422, "Contact", ssrContact(base, r.PostForm.Get("name"), r.PostForm.Get("message"), errs))
			return
		}
		site.mu.Lock()
		site.messages++
		site.mu.Unlock()
		site.record(hit)
		h.Set("Location", base+"/thanks?name="+strings.ReplaceAll(url.QueryEscape(name), "+", "%20"))
		w.WriteHeader(http.StatusSeeOther)
	case rest == "/thanks" && r.Method == http.MethodGet:
		page(200, "Thanks", `<h1>Thanks</h1><p>Message from <span id="who">`+esc(r.URL.Query().Get("name"))+`</span> received.</p>`)
	case rest == "/notes" && r.Method == http.MethodGet:
		site.mu.Lock()
		note := site.note
		site.mu.Unlock()
		page(200, "Notes", `<h1>Notes</h1>`+
			`<p><label>Note <input id="note" name="note" value="`+esc(note)+`" autocomplete="off" `+
			`ypy-post="`+base+`/notes/save" ypy-trigger="change" ypy-swap="none"></label></p>`+
			`<p>Saved: <span id="saved">`+esc(note)+`</span></p>`)
	case rest == "/notes/save" && r.Method == http.MethodPost:
		_ = r.ParseForm()
		time.Sleep(300 * time.Millisecond) // a save that is still in flight when the user clicks a link
		site.mu.Lock()
		site.note = r.PostForm.Get("note")
		site.mu.Unlock()
		site.record(hit)
		w.WriteHeader(http.StatusNoContent)
	default:
		send(w, 404, "text/plain", "not found")
	}
}

// ssrScripts loads the core and the three extensions of an application shell.
const ssrScripts = `<script src="/_lib/core.js"></script>
<script src="/_lib/ext/nav.js"></script>
<script src="/_lib/ext/persist.js"></script>
<script src="/_lib/ext/progress.js"></script>`

func ssrTitle(t string) string { return t + " - SSR demo" }

func ssrContact(base, name, msg string, errs map[string]string) string {
	field := func(key string) string {
		if e, ok := errs[key]; ok {
			return ` <span class="error" data-field="` + key + `">` + esc(e) + `</span>`
		}
		return ""
	}
	invalid := func(key string) string {
		if _, ok := errs[key]; ok {
			return ` aria-invalid="true"`
		}
		return ""
	}
	return `<h1>Contact</h1>` +
		`<form id="contact-form" action="` + base + `/contact" method="post" novalidate>` +
		`<p><label>Name <input name="name" value="` + esc(name) + `"` + invalid("name") + `></label>` + field("name") + `</p>` +
		`<p><label>Message <textarea name="message"` + invalid("message") + `>` + esc(msg) + `</textarea></label>` + field("message") + `</p>` +
		`<button type="submit">Send</button></form>`
}

// ssrBody is what a YPY request gets (with the title) and what a whole page wraps:
// the navigation, the main area and the player that persists between pages.
func ssrBody(base, title, main string) string {
	link := func(id, path, label, extra string) string {
		return `<a id="nav-` + id + `" href="` + base + path + `"` + extra + `>` + label + `</a> `
	}
	return `<header><nav aria-label="Main">` +
		link("home", "/", "Home", "") + link("about", "/about", "About", "") +
		link("contact", "/contact", "Contact", "") + link("notes", "/notes", "Notes", "") +
		link("slow", "/slow", "Slow", "") + link("legacy", "/legacy", "Legacy", "") +
		link("plain", "/about", "About, full load", ` ypy-boost="false"`) +
		`</nav></header>` + "\n" +
		`<main id="app" ypy-main>` + main + `</main>` + "\n" +
		`<aside id="player" ypy-persist><label>Player note <input id="player-input" name="player" autocomplete="off"></label> ` +
		`<span id="player-born">born on ` + esc(title) + `</span></aside>`
}

func ssrDocument(scripts, title, body string) string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + esc(ssrTitle(title)) + `</title>
<meta name="ypy-config" content='{"nav":{"boost":true,"prefetch":"hover","root":"#app"}}'>
` + scripts + `
</head>
<body>
` + body + `
</body>
</html>
`
}
