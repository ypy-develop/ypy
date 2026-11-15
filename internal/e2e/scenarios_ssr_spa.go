// SPDX-License-Identifier: MIT

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Scenarios of the server-rendered site of examples/server/ssr.go: SSR (the same
// URL answers a page or a fragment, forms work with and without scripts) and SPA
// (global boost, history, focus, persist, progress, prefetch, edits kept).
//
// They use only what every browser has: a page load, a mouse click, key presses,
// JavaScript evaluated in the page, and plain HTTP from the runner. No DevTools
// protocol feature is needed.

func init() { Register(ssrSpaScenarios...) }

// ssrHit mirrors examples/server/ssr.go.
type ssrHit struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Request bool   `json:"request"`
	Boosted bool   `json:"boosted"`
	Restore bool   `json:"restore"`
	Purpose string `json:"purpose"`
	Whole   bool   `json:"whole"`
}

type ssrLog struct {
	Hits     []ssrHit `json:"hits"`
	Note     string   `json:"note"`
	Messages int      `json:"messages"`
}

func (l ssrLog) count(method, path string) int {
	n := 0
	for _, h := range l.Hits {
		if h.Method == method && h.Path == path {
			n++
		}
	}
	return n
}

func (l ssrLog) last(path string) (ssrHit, bool) {
	for i := len(l.Hits) - 1; i >= 0; i-- {
		if l.Hits[i].Path == path {
			return l.Hits[i], true
		}
	}
	return ssrHit{}, false
}

var ssrClient = &http.Client{
	Timeout:       5 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// ssrRaw makes a request from the runner (no browser, no redirect followed).
func ssrRaw(e *Env, method, path string, header map[string]string, form url.Values) (int, http.Header, string) {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequest(method, e.Base+path, body)
	if err != nil {
		fail("%v", err)
	}
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := ssrClient.Do(req)
	if err != nil {
		fail("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(b)
}

func ssrReset(e *Env) {
	if st, _, _ := ssrRaw(e, "POST", "/ssr/_reset", nil, nil); st != 204 {
		fail("ssr reset answered %d", st)
	}
}

func ssrReadLog(e *Env) ssrLog {
	_, _, body := ssrRaw(e, "GET", "/ssr/_log", nil, nil)
	var l ssrLog
	if err := json.Unmarshal([]byte(body), &l); err != nil {
		fail("ssr log: %v", err)
	}
	return l
}

// ssrOpen resets the site and loads one of its pages (a whole page, with YPY).
func ssrOpen(e *Env, path string) {
	ssrReset(e)
	e.Page.Goto(e.Base + "/ssr" + path)
	e.Page.WaitFunction("window.ypy && document.querySelector('#app h1')")
}

// ssrMark puts a value on the window: a boosted navigation keeps it, a page load drops it.
func ssrMark(e *Env) { e.Page.Eval("(()=>{window.__marker='alive';return true})()", nil) }

func ssrAlive(e *Env) bool { return e.Page.evalBool("window.__marker === 'alive'") }

func ssrOn(e *Env, path string) bool {
	u := e.Page.URL()
	return strings.HasSuffix(u, "/ssr"+path)
}

func ssrString(e *Env, expr string) string {
	var s string
	e.Page.Eval(expr, &s)
	return s
}

// ssrGo clicks a link of the navigation and waits for the page it opens.
func ssrGo(e *Env, link, path, heading string) {
	e.Page.Click(link)
	e.Until("on "+path, func() bool { return ssrOn(e, path) && e.Page.TextContent("#app h1") == heading })
}

const (
	docTitle = "document.title"
	current  = "[...document.querySelectorAll('a[aria-current=page]')].map(a => a.id)"
)

var ssrSpaScenarios = []Scenario{
	// ---------------------------------------------------------------- SSR
	{Name: "ssr/same-url-page-or-fragment", Run: func(e *Env) {
		ssrReset(e)
		st, h, whole := ssrRaw(e, "GET", "/ssr/about", nil, nil)
		e.Equal(st, 200, "status of the whole page")
		e.Assert(strings.Contains(h.Get("Vary"), "YPY-Request"), "Vary names YPY-Request on the whole page, got "+h.Get("Vary"))
		for _, want := range []string{"<!doctype html>", "<title>About - SSR demo</title>", "<header>", `id="app"`, "<h1>About</h1>"} {
			e.Assert(strings.Contains(whole, want), "the whole page has "+want)
		}
		st, h, frag := ssrRaw(e, "GET", "/ssr/about", map[string]string{"YPY-Request": "true"}, nil)
		e.Equal(st, 200, "status of the fragment")
		e.Assert(strings.Contains(h.Get("Vary"), "YPY-Request"), "Vary names YPY-Request on the fragment, got "+h.Get("Vary"))
		e.Assert(!strings.Contains(strings.ToLower(frag), "<!doctype") && !strings.Contains(frag, "<html") && !strings.Contains(frag, "<head>"),
			"the fragment is not a document")
		for _, want := range []string{"<title>About - SSR demo</title>", "<h1>About</h1>"} {
			e.Assert(strings.Contains(frag, want), "the fragment has "+want)
		}
		e.Assert(len(frag) < len(whole), "the fragment is smaller than the page")
		// the restore request of the history is a plain GET with YPY-History-Restore-Request: a whole page
		_, _, restored := ssrRaw(e, "GET", "/ssr/about", map[string]string{"YPY-History-Restore-Request": "true"}, nil)
		e.Assert(strings.HasPrefix(restored, "<!doctype html>"), "a restore request gets the whole page")
	}},
	{Name: "ssr/direct-load-is-whole-page", Run: func(e *Env) {
		ssrOpen(e, "/about")
		e.Equal(ssrString(e, docTitle), "About - SSR demo", "title of a direct load")
		e.Equal(e.Page.Count("header nav a"), 7, "the navigation is there")
		e.Equal(e.Page.Count("#player"), 1, "the player is there")
		hit, ok := ssrReadLog(e).last("/ssr/about")
		e.Assert(ok && hit.Whole && !hit.Request, "the browser asked without YPY-Request and got a whole page")
	}},
	{Name: "ssr/refresh-after-push-shows-whole-page", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrMark(e)
		ssrGo(e, "#nav-contact", "/contact", "Contact")
		e.Assert(ssrAlive(e), "the link was a navigation of the application, not a page load")
		e.Page.Eval("(()=>{location.reload();return true})()", nil)
		e.Until("the page was loaded again", func() bool {
			return e.Page.evalBool("document.readyState === 'complete' && window.__marker === undefined && !!window.ypy")
		})
		e.Equal(e.Page.Count("header nav a"), 7, "the whole page, with its navigation, after a refresh")
		e.Equal(e.Page.Count("#contact-form"), 1, "the contact form")
		e.Equal(ssrString(e, docTitle), "Contact - SSR demo", "title after a refresh")
		hit, _ := ssrReadLog(e).last("/ssr/contact")
		e.Assert(hit.Whole && !hit.Request, "the refresh did not send YPY-Request")
	}},
	{Name: "ssr/restore-asks-for-whole-page", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrMark(e)
		ssrGo(e, "#nav-about", "/about", "About")
		ssrGo(e, "#nav-contact", "/contact", "Contact")
		e.Page.Eval("(()=>{history.back();return true})()", nil)
		e.Until("back to about", func() bool { return ssrOn(e, "/about") && e.Page.TextContent("#app h1") == "About" })
		var restores []ssrHit
		for _, h := range ssrReadLog(e).Hits {
			if h.Restore {
				restores = append(restores, h)
			}
		}
		e.Assert(len(restores) >= 1, "the history restore asked the server")
		r := restores[len(restores)-1]
		e.Assert(r.Path == "/ssr/about" && !r.Request && r.Whole, fmt.Sprintf("restore asks without YPY-Request and gets a page: %+v", r))
		e.Assert(ssrAlive(e), "restoring did not reload the page")
	}},
	{Name: "ssr/form-422-keeps-typed-text", Run: func(e *Env) {
		ssrOpen(e, "/contact")
		ssrMark(e)
		p := e.Page
		p.Fill("#contact-form input[name=name]", "A")
		p.Fill("#contact-form textarea[name=message]", "hi")
		url := p.URL()
		p.Click("#contact-form button")
		e.Until("two messages", func() bool { return p.Count("#contact-form .error") == 2 })
		e.Equal(p.Texts("#contact-form .error"), []string{"Name must have at least 2 characters.", "Message must have at least 5 characters."}, "messages")
		e.Equal(p.InputValue("#contact-form input[name=name]"), "A", "name kept")
		e.Equal(p.InputValue("#contact-form textarea[name=message]"), "hi", "message kept")
		e.Equal(p.URL(), url, "the address of a form with errors does not change")
		e.Assert(ssrAlive(e), "the form was sent by the application, not by a page load")
		e.Equal(e.Page.Count("#contact-form [aria-invalid=true]"), 2, "the invalid fields are marked")
		e.Equal(ssrReadLog(e).Messages, 0, "nothing accepted")
		// fix one field: one message left, the other text is still there
		p.Fill("#contact-form input[name=name]", "Ana")
		p.Click("#contact-form button")
		e.Until("one message", func() bool { return p.Count("#contact-form .error") == 1 })
		e.Equal(p.InputValue("#contact-form input[name=name]"), "Ana", "fixed name kept")
		e.Equal(p.InputValue("#contact-form textarea[name=message]"), "hi", "message kept again")
	}},
	{Name: "ssr/form-303-final-url-in-history", Run: func(e *Env) {
		ssrOpen(e, "/contact")
		ssrMark(e)
		p := e.Page
		p.Fill("#contact-form input[name=name]", "Ana Souza")
		p.Fill("#contact-form textarea[name=message]", "Hello there")
		p.Click("#contact-form button")
		p.WaitURL(regexp.MustCompile(`/ssr/thanks\?name=Ana%20Souza$`), 5*time.Second)
		e.Until("thanks page", func() bool { return p.TextContent("#who") == "Ana Souza" })
		e.Equal(ssrString(e, docTitle), "Thanks - SSR demo", "title of the final page")
		e.Assert(ssrAlive(e), "the redirect was followed by the application")
		l := ssrReadLog(e)
		e.Equal(l.Messages, 1, "one message accepted")
		e.Equal(l.count("POST", "/ssr/contact"), 1, "one post")
		// the entry in the history is the final URL, and the one before it is the form
		p.Eval("(()=>{history.back();return true})()", nil)
		e.Until("back on the form", func() bool { return ssrOn(e, "/contact") && p.Count("#contact-form") == 1 })
		e.Equal(ssrReadLog(e).Messages, 1, "going back did not post again")
	}},
	{Name: "ssr/server-forms-over-http", Run: func(e *Env) {
		ssrReset(e)
		bad := url.Values{"name": {"A"}, "message": {"x"}}
		st, h, page := ssrRaw(e, "POST", "/ssr/contact", nil, bad)
		e.Equal(st, 422, "invalid form, no script")
		e.Assert(strings.HasPrefix(page, "<!doctype html>") && strings.Contains(page, `value="A"`) && strings.Contains(page, "Name must have"),
			"a whole page with the error and the typed text")
		e.Assert(strings.Contains(h.Get("Vary"), "YPY-Request"), "Vary on the 422")
		st, _, frag := ssrRaw(e, "POST", "/ssr/contact", map[string]string{"YPY-Request": "true"}, bad)
		e.Equal(st, 422, "invalid form, YPY request")
		e.Assert(!strings.Contains(frag, "<html") && strings.Contains(frag, `value="A"`), "a fragment with the error and the typed text")
		st, h, _ = ssrRaw(e, "POST", "/ssr/contact", nil, url.Values{"name": {"Ana Souza"}, "message": {"Hello there"}})
		e.Equal(st, 303, "valid form")
		e.Equal(h.Get("Location"), "/ssr/thanks?name=Ana%20Souza", "redirect to the final page")
		e.Assert(strings.Contains(h.Get("Vary"), "YPY-Request"), "Vary on the 303")
	}},
	{Name: "ssr/works-without-javascript", Run: func(e *Env) {
		ssrReset(e)
		p := e.Page
		p.Goto(e.Base + "/ssr-nojs/")
		e.Until("home loaded", func() bool { return p.Count("#app h1") == 1 })
		e.Equal(ssrString(e, "typeof window.ypy"), "undefined", "the policy of the page kept every script out")
		// a plain link
		p.Click("#nav-about")
		p.WaitURL(regexp.MustCompile(`/ssr-nojs/about$`), 5*time.Second)
		e.Until("about page", func() bool { return p.Count("#app h1") == 1 && p.TextContent("#app h1") == "About" })
		e.Equal(ssrString(e, docTitle), "About - SSR demo", "title")
		p.Click("#nav-contact")
		p.WaitURL(regexp.MustCompile(`/ssr-nojs/contact$`), 5*time.Second)
		e.Until("contact page", func() bool { return p.Count("#contact-form") == 1 })
		// a plain form, invalid: the browser shows the whole 422 page, the typed text kept
		p.Fill("#contact-form input[name=name]", "A")
		p.Fill("#contact-form textarea[name=message]", "hi")
		p.Click("#contact-form button")
		e.Until("errors from the server", func() bool { return p.Count("#contact-form .error") == 2 })
		e.Equal(p.InputValue("#contact-form input[name=name]"), "A", "typed name")
		e.Equal(p.InputValue("#contact-form textarea[name=message]"), "hi", "typed message")
		// a plain form, valid: the redirect ends on the thanks page
		p.Fill("#contact-form input[name=name]", "Ana Souza")
		p.Fill("#contact-form textarea[name=message]", "Hello there")
		p.Click("#contact-form button")
		p.WaitURL(regexp.MustCompile(`/ssr-nojs/thanks\?name=Ana%20Souza$`), 5*time.Second)
		e.Until("thanks page", func() bool { return p.TextContent("#who") == "Ana Souza" })
		e.Equal(ssrReadLog(e).Messages, 1, "one message accepted")
	}},

	// ---------------------------------------------------------------- SPA
	{Name: "spa/boost-link-without-reload", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrMark(e)
		ssrGo(e, "#nav-about", "/about", "About")
		e.Assert(ssrAlive(e), "the page was not loaded again")
		e.Equal(ssrString(e, docTitle), "About - SSR demo", "title")
		e.Equal(e.Page.Count("header nav a"), 7, "navigation still there")
		hit, ok := ssrReadLog(e).last("/ssr/about")
		e.Assert(ok && hit.Request && hit.Boosted && !hit.Whole, fmt.Sprintf("a boosted request got a fragment: %+v", hit))
	}},
	{Name: "spa/boost-form", Run: func(e *Env) {
		ssrOpen(e, "/contact")
		ssrMark(e)
		e.Page.Fill("#contact-form input[name=name]", "Ana Souza")
		e.Page.Fill("#contact-form textarea[name=message]", "Hello there")
		e.Page.Click("#contact-form button")
		e.Page.WaitURL(regexp.MustCompile(`/ssr/thanks\?name=`), 5*time.Second)
		e.Until("thanks", func() bool { return e.Page.TextContent("#app h1") == "Thanks" })
		e.Assert(ssrAlive(e), "the form did not load the page")
		var post ssrHit
		for _, h := range ssrReadLog(e).Hits {
			if h.Method == "POST" {
				post = h
			}
		}
		e.Assert(post.Request && post.Boosted, fmt.Sprintf("the post carried YPY-Request and YPY-Boosted: %+v", post))
	}},
	{Name: "spa/current-link", Run: func(e *Env) {
		ssrOpen(e, "/")
		var ids []string
		e.Page.Eval(current, &ids)
		e.Equal(ids, []string{"nav-home"}, "the home link is current on load")
		ssrGo(e, "#nav-about", "/about", "About")
		e.Until("the mark moved", func() bool {
			e.Page.Eval(current, &ids)
			return len(ids) == 2
		})
		e.Equal(ids, []string{"nav-about", "nav-plain"}, "both links to /about are current, the others are not")
		e.Equal(e.Page.Count("a.ypy-current"), 2, "ypy-current follows aria-current")
	}},
	{Name: "spa/history-back-forward", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrMark(e)
		ssrGo(e, "#nav-about", "/about", "About")
		ssrGo(e, "#nav-contact", "/contact", "Contact")
		step := func(action, path, heading, title string) {
			e.Page.Eval("(()=>{history."+action+"();return true})()", nil)
			e.Until(action+" to "+path, func() bool { return ssrOn(e, path) && e.Page.TextContent("#app h1") == heading })
			e.Until("title of "+path, func() bool { return ssrString(e, docTitle) == title })
			e.Assert(ssrAlive(e), action+" did not load the page again")
		}
		step("back", "/about", "About", "About - SSR demo")
		step("back", "/", "Home", "Home - SSR demo")
		step("forward", "/about", "About", "About - SSR demo")
		step("forward", "/contact", "Contact", "Contact - SSR demo")
		e.Equal(e.Page.Count("#contact-form"), 1, "the form is back")
		var ids []string
		e.Page.Eval(current, &ids)
		e.Equal(ids, []string{"nav-contact"}, "the current link follows the history")
	}},
	{Name: "spa/focus-moves-to-the-title", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrGo(e, "#nav-about", "/about", "About")
		e.Until("focus on the heading of the new page", func() bool {
			return e.Page.evalBool("document.activeElement?.tagName === 'H1' && document.activeElement.textContent === 'About' && !!document.activeElement.closest('#app')")
		})
		// back: the restored page does not steal the focus into a stale element, the page is intact
		e.Page.Eval("(()=>{history.back();return true})()", nil)
		e.Until("home again", func() bool { return ssrOn(e, "/") && e.Page.TextContent("#app h1") == "Home" })
	}},
	{Name: "spa/persist-keeps-the-player", Run: func(e *Env) {
		ssrOpen(e, "/")
		p := e.Page
		p.Fill("#player-input", "keep me")
		p.Eval("(()=>{document.getElementById('player').__mine = 1;return true})()", nil)
		const kept = "document.getElementById('player').__mine === 1 && document.getElementById('player-input').value === 'keep me' && document.getElementById('player-born').textContent === 'born on Home'"
		ssrGo(e, "#nav-about", "/about", "About")
		e.Assert(p.evalBool(kept), "the player of the first page is still the live one after a link")
		ssrGo(e, "#nav-contact", "/contact", "Contact")
		p.Eval("(()=>{history.back();return true})()", nil)
		e.Until("back on about", func() bool { return ssrOn(e, "/about") && p.TextContent("#app h1") == "About" })
		e.Assert(p.evalBool(kept), "and after going back")
		// the control: a full page load brings a new player
		p.Click("#nav-plain")
		e.Until("full load of about", func() bool {
			return p.evalBool("document.readyState === 'complete' && document.getElementById('player-born')?.textContent === 'born on About'")
		})
		e.Equal(p.InputValue("#player-input"), "", "a page load starts a new player")
	}},
	{Name: "spa/progress-bar", Run: func(e *Env) {
		ssrOpen(e, "/")
		p := e.Page
		p.Eval(`(()=>{window.__bars = 0
			new MutationObserver(m => { for (const r of m) for (const n of r.addedNodes) if (n.localName === 'ypy-progress-bar') window.__bars++ })
				.observe(document.documentElement, {childList: true})
			return true})()`, nil)
		// a fast answer shows nothing
		ssrGo(e, "#nav-about", "/about", "About")
		p.Sleep(400 * time.Millisecond)
		var bars int
		p.Eval("window.__bars", &bars)
		e.Equal(bars, 0, "no bar for a fast answer")
		// a slow one shows the bar, with its role and its label
		p.Click("#nav-slow")
		e.Until("the bar shows while the server works", func() bool {
			return p.evalBool("(() => { const b = document.documentElement.querySelector('ypy-progress-bar')?.shadowRoot?.querySelector('[role=progressbar]'); return !!b && b.getAttribute('aria-label') === 'Loading' })()")
		})
		e.Until("slow page", func() bool { return ssrOn(e, "/slow") && p.TextContent("#app h1") == "Slow" })
		e.Until("the bar left", func() bool { return p.Count("ypy-progress-bar") == 0 })
	}},
	{Name: "spa/prefetch-is-used-by-the-click", Run: func(e *Env) {
		ssrOpen(e, "/")
		p := e.Page
		ssrMark(e)
		p.Eval(`(()=>{document.getElementById('nav-about').dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));return true})()`, nil)
		e.Until("the page was requested before the click", func() bool {
			h, ok := ssrReadLog(e).last("/ssr/about")
			return ok && h.Purpose == "prefetch"
		})
		ssrGo(e, "#nav-about", "/about", "About")
		e.Equal(ssrReadLog(e).count("GET", "/ssr/about"), 1, "the click reused the prefetched response")
		e.Assert(ssrAlive(e), "the page was not loaded again")
	}},
	{Name: "spa/response-from-outside-the-app-loads-in-full", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrMark(e)
		e.Page.Click("#nav-legacy")
		e.Until("legacy page loaded in full", func() bool {
			return ssrOn(e, "/legacy") && e.Page.evalBool("document.readyState === 'complete' && !!document.getElementById('legacy') && window.__marker === undefined")
		})
		e.Equal(ssrString(e, docTitle), "Legacy - SSR demo", "title")
		hit, _ := ssrReadLog(e).last("/ssr/legacy")
		e.Assert(!hit.Request, "the final load is a plain page load")
	}},
	{Name: "spa/boost-off-region-loads-in-full", Run: func(e *Env) {
		ssrOpen(e, "/")
		ssrMark(e)
		e.Page.Click("#nav-plain")
		e.Until("about loaded in full", func() bool {
			return ssrOn(e, "/about") && e.Page.evalBool("document.readyState === 'complete' && !!document.querySelector('#app h1') && window.__marker === undefined")
		})
		hit, _ := ssrReadLog(e).last("/ssr/about")
		e.Assert(!hit.Request && hit.Whole, "ypy-boost=false left the link to the browser")
	}},
	{Name: "spa/edit-is-saved-before-leaving", Run: func(e *Env) {
		ssrOpen(e, "/notes")
		ssrMark(e)
		p := e.Page
		p.PressSequentially("#note", "draft text", 20*time.Millisecond)
		// the link is clicked while the field still has the focus and its change did not run yet
		p.Click("#nav-about")
		e.Until("on about", func() bool { return ssrOn(e, "/about") && p.TextContent("#app h1") == "About" })
		l := ssrReadLog(e)
		e.Equal(l.Note, "draft text", "the edit reached the server before the page changed")
		e.Equal(l.count("POST", "/ssr/notes/save"), 1, "one save")
		e.Assert(ssrAlive(e), "navigation of the application")
		ssrGo(e, "#nav-notes", "/notes", "Notes")
		e.Equal(p.InputValue("#note"), "draft text", "the saved text is on the page when it comes back")
	}},
}
