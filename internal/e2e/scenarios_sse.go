// SPDX-License-Identifier: MIT

package e2e

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var redirectedURL = regexp.MustCompile(`/lab/redirected$`)

// The streaming scenarios: ypy-sse, the YPY stream protocol (ypy-stream) and the streaming of a
// language-model answer (ypy-model, ADR-0018), against the lab of examples/server/sse.go.
//
// They use only what every browser has: page script, DOM and events. The tab going to the
// background is made by overriding document.hidden and firing visibilitychange, the network coming
// back by firing online; nothing here needs the DevTools protocol, so the same scenarios run in
// every browser the runner can drive. A second browsing context is an iframe of the same origin.

func init() { Register(streamScenarios...) }

// ---- helpers ---------------------------------------------------------------------------

// labStats are the counters of the lab (GET /native/lab/api/stats).
type labStats struct {
	Conns    map[string]int      `json:"conns"`
	Open     map[string]int      `json:"open"`
	LastIDs  map[string][]string `json:"lastIds"`
	Counter  int                 `json:"counter"`
	CartGets int                 `json:"cartGets"`
	Pwn      int                 `json:"pwn"`
	Tokens   int                 `json:"tokens"`
	Stopped  int                 `json:"stopped"`
	Ended    string              `json:"ended"`
}

func labURL(e *Env, path string) string { return fmt.Sprintf("%s/%s/lab%s", e.Base, e.App, path) }

func labPost(e *Env, path string) string {
	resp, err := http.Post(labURL(e, path), "application/json", strings.NewReader(""))
	if err != nil {
		fail("post %s: %v", path, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func labGetStats(e *Env) labStats {
	var s labStats
	if err := json.Unmarshal([]byte(e.Get(labURL(e, "/api/stats"))), &s); err != nil {
		fail("lab stats: %v", err)
	}
	return s
}

// labLogJS records, on window.__log, the events the scenarios look at (they bubble to the document).
const labLogJS = `(() => {
	window.__log = []
	const names = ['ypy:sse:after:connection', 'ypy:sse:close', 'ypy:sse:error', 'ypy:stream:open', 'ypy:stream:close',
		'ypy:stream:error', 'ypy:stream:reconnect', 'ypy:stream:pause', 'ypy:stream:resume', 'ypy:announce',
		'notice', 'message:new', 'badge:seen']
	for (const n of names) document.addEventListener(n, e => {
		const d = e.detail || {}
		window.__log.push({ n, id: (e.target && e.target.id) || '', reason: d.reason || '', message: d.message || '',
			data: d.data || '', detail: /^(message|badge):/.test(n) ? JSON.stringify(e.detail ?? null) : '', error: d.error ? String(d.error.message || d.error) : '' })
	})
	return true
})()`

// labBegin restores the lab, opens its empty page and starts the event log.
func labBegin(e *Env) {
	labPost(e, "/api/reset")
	e.Page.Goto(labURL(e, "/"))
	e.Page.WaitFunction("window.ypy && document.getElementById('mount')")
	e.Page.Eval(labLogJS, nil)
}

// labMount puts markup in the lab page and lets YPY process it, like an element that arrived in a response.
func labMount(e *Env, markup string) {
	e.Page.Eval(`(() => {
		const d = document.createElement('div')
		d.innerHTML = `+jsString(markup)+`
		document.getElementById('mount').append(d)
		ypy.process(d)
		return true
	})()`, nil)
}

// logSel is a JavaScript filter over the event log.
func logCount(e *Env, name string) int {
	var n int
	e.Page.Eval("window.__log.filter(x => x.n === "+jsString(name)+").length", &n)
	return n
}

func logField(e *Env, name, field string) []string {
	out := []string{}
	e.Page.Eval("window.__log.filter(x => x.n === "+jsString(name)+").map(x => x."+field+")", &out)
	return out
}

// waitEqual polls a JavaScript expression until its JSON value is want; on timeout the last value is in the message.
func waitEqual(e *Env, expr string, want any, message string) {
	wantJSON, _ := json.Marshal(want)
	var last any
	end := time.Now().Add(6 * time.Second)
	for {
		e.Page.Eval(expr, &last)
		if got, _ := json.Marshal(last); string(got) == string(wantJSON) {
			return
		}
		if time.Now().After(end) {
			fail("timeout waiting for %s: expected %s, got %v", message, wantJSON, last)
		}
		e.Page.Sleep(50 * time.Millisecond)
	}
}

func items(e *Env) []float64 {
	var ns []float64
	e.Page.Eval("[...document.querySelectorAll('#log li.msg')].map(e => Number(e.dataset.n))", &ns)
	return ns
}

func setHidden(e *Env, hidden bool) {
	if hidden {
		e.Page.Eval(`(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
			document.dispatchEvent(new Event('visibilitychange'))
			return true
		})()`, nil)
		return
	}
	e.Page.Eval(`(() => {
		delete document.hidden
		document.dispatchEvent(new Event('visibilitychange'))
		return true
	})()`, nil)
}

func atLeast(e *Env, sel string, n int) func() bool {
	return func() bool { return e.Page.Count(sel) >= n }
}

// ---- the scenarios -------------------------------------------------------------------------

var streamScenarios = []Scenario{
	// ---- ypy-sse ----
	{Name: "sse-lab/messages-and-events", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<ul id="log"></ul><div id="conn" ypy-sse:connect="/native/lab/api/sse/hello" ypy-sse:close="done" ypy-target="#log" ypy-swap="beforeend"></div>`)
		e.Until("three messages in the target", func() bool { return p.Count("#log li.msg") == 3 })
		e.Equal(p.Texts("#log li.msg"), []string{"hello 1", "hello 2", "hello 3"}, "messages in order")
		e.Until("the named event reached the page", func() bool { return logCount(e, "notice") == 1 })
		e.Equal(logField(e, "notice", "data"), []string{"hi there"}, "named event data")
		e.Until("closed by the closing event", func() bool { return logCount(e, "ypy:sse:close") == 1 })
		e.Equal(logField(e, "ypy:sse:close", "reason"), []string{"message"}, "close reason")
		p.Sleep(700 * time.Millisecond)
		s := labGetStats(e)
		e.Equal([]int{s.Conns["sse-hello"], s.Open["sse-hello"]}, []int{1, 0}, "one connection, closed, no reconnection")
		e.Equal(p.Count("#log li.msg"), 3, "no duplicate message")
	}},
	{Name: "sse-lab/reconnect-after-clean-end", Run: func(e *Env) { sseReconnect(e, "end") }},
	{Name: "sse-lab/reconnect-after-cut", Run: func(e *Env) { sseReconnect(e, "cut") }},
	{Name: "sse-lab/heartbeat-stalled", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<ul id="log"></ul><div id="conn" ypy-sse:connect="/native/lab/api/sse/silent" ypy-target="#log" ypy-swap="beforeend" ypy-config='{"sse":{"heartbeat":600}}'></div>`)
		e.UntilFor("the silent connection was closed and opened again", 8*time.Second, func() bool { return p.Count("#log li.msg") >= 2 })
		e.Equal(p.Texts("#log li.msg")[:2], []string{"silent 1", "silent 2"}, "the second connection continues the first")
		s := labGetStats(e)
		e.Assert(s.Conns["sse-silent"] >= 2, "the watchdog opened a second connection")
		e.Assert(len(s.LastIDs["sse-silent"]) >= 2 && s.LastIDs["sse-silent"][0] == "" && s.LastIDs["sse-silent"][1] == "1",
			fmt.Sprintf("Last-Event-ID of the reconnection (got %v)", s.LastIDs["sse-silent"]))
	}},
	{Name: "sse-lab/heartbeat-kept-alive", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<ul id="log"></ul><div id="conn" ypy-sse:connect="/native/lab/api/sse/silent?beat=200" ypy-target="#log" ypy-swap="beforeend" ypy-config='{"sse":{"heartbeat":700}}'></div>`)
		e.Until("first message", atLeast(e, "#log li.msg", 1))
		p.Sleep(2200 * time.Millisecond)
		s := labGetStats(e)
		e.Equal([]int{s.Conns["sse-silent"], s.Open["sse-silent"]}, []int{1, 1}, "comments keep the connection: no restart")
	}},
	{Name: "sse-lab/background-pause-and-resume", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<ul id="log"></ul><div id="conn" ypy-sse:connect="/native/lab/api/sse/flaky" ypy-target="#log" ypy-swap="beforeend"></div>`)
		e.Until("two messages", atLeast(e, "#log li.msg", 2))
		setHidden(e, true)
		e.Until("the server sees the connection close while the tab is hidden", func() bool { return labGetStats(e).Open["sse-flaky"] == 0 })
		before := p.Count("#log li.msg")
		p.Sleep(500 * time.Millisecond)
		e.Equal(p.Count("#log li.msg"), before, "nothing arrives while hidden")
		e.Equal(labGetStats(e).Conns["sse-flaky"], 1, "no reconnection while hidden")
		setHidden(e, false)
		e.UntilFor("messages continue when the tab is back", 6*time.Second, atLeast(e, "#log li.msg", before+3))
		ns := items(e)
		e.Equal(ns, nameSeq(len(ns)), "no message lost or repeated across the pause")
		ids := labGetStats(e).LastIDs["sse-flaky"]
		e.Assert(len(ids) == 2 && ids[0] == "" && ids[1] != "", fmt.Sprintf("Last-Event-ID sent when the tab came back (got %v)", ids))
	}},
	{Name: "sse-lab/online-wakes-the-connection", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<ul id="log"></ul><div id="conn" ypy-sse:connect="/native/lab/api/sse/flaky" ypy-target="#log" ypy-swap="beforeend"></div>`)
		e.Until("three messages", atLeast(e, "#log li.msg", 3))
		p.Eval(`(() => { window.dispatchEvent(new Event('online')); return true })()`, nil)
		e.UntilFor("a new connection after the browser says it is online", 6*time.Second, func() bool { return labGetStats(e).Conns["sse-flaky"] >= 2 })
		e.UntilFor("messages continue", 6*time.Second, atLeast(e, "#log li.msg", 7))
		ns := items(e)
		e.Equal(ns, nameSeq(len(ns)), "continuous sequence")
		e.Equal(labGetStats(e).Open["sse-flaky"], 1, "the old connection was released, not kept beside the new one")
	}},

	// ---- ypy-stream: the events of the protocol ----
	{Name: "stream-lab/patch-modes", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<ul id="l"><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul><div ypy-stream="/native/lab/api/stream/patches?case=modes"></div>`)
		waitEqual(e, "document.getElementById('l').outerHTML",
			`<ul id="l"><li id="a"><i>A2</i></li><li id="b" class="x">B2</li><li id="y">Y</li><li id="c">C</li><li id="x">X</li><li id="w">W</li></ul>`,
			"the eight patch modes")
	}},
	{Name: "stream-lab/patch-key-and-limit", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<ul id="users"><li data-id="1">Ana</li><li data-id="2">Bia</li></ul>`+
			`<ul id="log"><li>1</li><li>2</li><li>3</li></ul><ul id="rlog"><li>1</li><li>2</li><li>3</li></ul>`+
			`<div ypy-stream="/native/lab/api/stream/patches?case=lists"></div>`)
		waitEqual(e, "document.getElementById('users').outerHTML",
			`<ul id="users"><li data-id="1">Ana</li><li data-id="2">Bia!</li><li data-id="3">Caio</li><li data-id="4">Duda 2</li></ul>`,
			"append with key: replace in place, last of a repeated key wins")
		waitEqual(e, "document.getElementById('log').outerHTML", `<ul id="log"><li>4</li><li>5</li><li>6</li></ul>`, "append with limit 3")
		waitEqual(e, "document.getElementById('rlog').outerHTML", `<ul id="rlog"><li>0</li><li>1</li><li>2</li></ul>`, "prepend with limit 3")
	}},
	{Name: "stream-lab/patch-by-id-and-remove", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<ul id="messages"><li>old</li></ul><p id="typing">...</p><div ypy-stream="/native/lab/api/stream/patches?case=byid"></div>`)
		waitEqual(e, "document.getElementById('messages').outerHTML", "<ul id=\"messages\">\n  <li>héllo</li>\n</ul>", "multi-line patch by id")
		waitEqual(e, "document.getElementById('typing') === null", true, "remove")
	}},
	{Name: "stream-lab/unknown-events-and-keys", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<p id="t">old</p><div ypy-stream="/native/lab/api/stream/patches?case=unknown"></div>`)
		waitEqual(e, "document.getElementById('t').textContent", "ok", "the known event after an unknown one")
		e.Equal(logCount(e, "ypy:stream:error"), 0, "an unknown event or key is not an error")
	}},
	{Name: "stream-lab/patch-signals", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<div ypy-signals="name:'x', online:0"><b id="s-name" ypy-text="$name"></b> <b id="s-online" ypy-text="$online"></b> `+
			`<b id="s-theme" ypy-text="$theme ?? 'none'"></b><span ypy-stream="/native/lab/api/stream/patches?case=signals"></span></div>`)
		waitEqual(e, "[document.getElementById('s-name').textContent, document.getElementById('s-online').textContent, document.getElementById('s-theme').textContent]",
			[]string{"Ana", "3", "light"}, "signals patched; onlyIfMissing kept the name and added the theme")
	}},
	{Name: "stream-lab/event", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<b id="badge">0</b><div ypy-stream="/native/lab/api/stream/patches?case=event"></div>`)
		e.Until("both events fired", func() bool { return logCount(e, "message:new") == 1 && logCount(e, "badge:seen") == 1 })
		e.Equal(logField(e, "message:new", "detail"), []string{`{"id":42}`}, "detail on the document")
		e.Equal(logField(e, "message:new", "id"), []string{""}, "fired on the document")
		e.Equal(logField(e, "badge:seen", "id"), []string{"badge"}, "fired on the element of the selector")
		e.Equal(logField(e, "badge:seen", "detail"), []string{"{}"}, "no detail")
	}},
	{Name: "stream-lab/redirect", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="s" ypy-stream="/native/lab/api/stream/patches?case=redirect"></div>`)
		p.WaitURL(redirectedURL, 5*time.Second)
		e.Until("the page shows the destination", func() bool { return p.Count("#landed") == 1 })
		p.Sleep(700 * time.Millisecond)
		e.Equal(labGetStats(e).Conns["st-patches"], 1, "a redirect ends the stream: no reconnection")
	}},
	{Name: "stream-lab/redirect-to-another-origin-refused", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		start := p.URL()
		labMount(e, `<div id="s" ypy-stream="/native/lab/api/stream/patches?case=redirect-away"></div>`)
		e.Until("the refusal is reported", func() bool { return logCount(e, "ypy:stream:error") == 1 })
		e.Assert(strings.Contains(strings.Join(logField(e, "ypy:stream:error", "error"), ""), "redirect"), "the error names the redirect")
		e.Equal(p.URL(), start, "the page did not move")
	}},
	{Name: "stream-lab/204-ends-the-stream", Run: func(e *Env) {
		labBegin(e)
		labMount(e, `<div id="s" ypy-stream="/native/lab/api/stream/none"></div>`)
		e.Until("closed", func() bool { return logCount(e, "ypy:stream:close") == 1 })
		e.Equal(logField(e, "ypy:stream:close", "reason"), []string{"status 204"}, "close reason")
		e.Page.Sleep(700 * time.Millisecond)
		e.Equal(labGetStats(e).Conns["st-none"], 1, "204 means: do not reconnect")
	}},

	// ---- ypy-stream: reconnection ----
	{Name: "stream-lab/reconnect-after-clean-end", Run: func(e *Env) { streamReconnect(e, "end") }},
	{Name: "stream-lab/reconnect-after-cut", Run: func(e *Env) { streamReconnect(e, "cut") }},
	{Name: "stream-lab/reconnect-fat-morph", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="state" data-count="x">count=x</div><div id="s" ypy-stream="/native/lab/api/stream/state"></div>`)
		waitEqual(e, "document.getElementById('state').textContent", "count=0", "the snapshot on the first connection")
		p.Eval(`(() => { const s = document.getElementById('state'); s.__kept = true; return true })()`, nil)
		labPost(e, "/api/bump")
		waitEqual(e, "document.getElementById('state').textContent", "count=1", "a live update")
		e.Equal(labPost(e, "/api/drop?name=st-state&mode=cut"), "1", "one connection dropped")
		// the changes made while the client is away are never sent as events; the snapshot has them all
		for i := 0; i < 3; i++ {
			labPost(e, "/api/bump")
		}
		waitEqual(e, "document.getElementById('state').textContent", "count=4", "the full state after the reconnection")
		var kept bool
		p.Eval("document.getElementById('state').__kept === true", &kept)
		e.Assert(kept, "the snapshot was morphed in: the element is the same node")
		e.Equal(labGetStats(e).LastIDs["st-state"], []string{"", "1"}, "Last-Event-ID of the reconnection")
	}},
	{Name: "stream-lab/background-pause-and-resume", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<ul id="log"></ul><div id="s" ypy-stream="/native/lab/api/stream/ticker" ypy-config='{"stream":{"pauseOnBackground":true}}'></div>`)
		e.Until("two events", atLeast(e, "#log li.msg", 2))
		setHidden(e, true)
		e.Until("paused", func() bool { return logCount(e, "ypy:stream:pause") == 1 })
		e.Until("the server sees the connection close", func() bool { return labGetStats(e).Open["st-ticker"] == 0 })
		before := p.Count("#log li.msg")
		p.Sleep(500 * time.Millisecond)
		e.Equal(p.Count("#log li.msg"), before, "nothing arrives while hidden")
		e.Equal(labGetStats(e).Conns["st-ticker"], 1, "no reconnection while hidden")
		setHidden(e, false)
		e.Until("resumed", func() bool { return logCount(e, "ypy:stream:resume") == 1 })
		e.UntilFor("events continue", 6*time.Second, atLeast(e, "#log li.msg", before+3))
		ns := items(e)
		e.Equal(ns, nameSeq(len(ns)), "no event lost or repeated across the pause")
		ids := labGetStats(e).LastIDs["st-ticker"]
		e.Assert(len(ids) == 2 && ids[0] == "" && ids[1] != "", fmt.Sprintf("Last-Event-ID sent when the tab came back (got %v)", ids))
	}},

	// ---- ypy-refresh ----
	{Name: "stream-lab/refresh-broadcast-two-contexts", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="room-a" ypy-stream="/native/lab/api/stream/room?sel=%23cart-a"></div>`+
			`<div id="room-b" ypy-stream="/native/lab/api/stream/room?sel=%23cart-b"></div>`+
			`<div id="cart-a" ypy-get="/native/lab/api/cart" ypy-trigger="load"></div>`+
			`<div id="cart-b" ypy-get="/native/lab/api/cart" ypy-trigger="load"></div>`+
			`<iframe id="other" src="/native/lab/page" title="the same page in a second context"></iframe>`)
		const other = `(() => { const d = document.getElementById('other').contentDocument; return d && d.getElementById('n') ? d.getElementById('n').textContent : null })()`
		waitEqual(e, `[document.getElementById('cart-a').textContent, document.getElementById('cart-b').textContent]`, []string{"0 items", "0 items"}, "both carts loaded")
		waitEqual(e, other, "0", "the second context loaded")
		e.UntilFor("every stream is open", 5*time.Second, func() bool { return labGetStats(e).Open["st-room"] == 3 })
		// three changes at once: every client asks once (the debounce joins them)
		p.Eval(`Promise.all([1, 2, 3].map(() => fetch('/native/lab/api/bump', { method: 'POST' }))).then(() => true)`, nil)
		waitEqual(e, `[document.getElementById('cart-a').textContent, document.getElementById('cart-b').textContent]`, []string{"3 items", "3 items"}, "both carts refreshed")
		waitEqual(e, other, "3", "the second context refreshed its page")
		p.Sleep(400 * time.Millisecond)
		e.Equal(labGetStats(e).CartGets, 4, "two loads and one refresh each: three changes became one request per element")
	}},
	{Name: "stream-lab/refresh-page-morph", Run: func(e *Env) {
		p := e.Page
		labPost(e, "/api/reset")
		p.Goto(labURL(e, "/page"))
		p.WaitFunction("window.ypy && document.getElementById('draft')")
		e.Until("the stream is open", func() bool { return labGetStats(e).Open["st-room"] == 1 })
		e.Equal(p.TextContent("#n"), "0", "initial state")
		p.Fill("#draft", "typed")
		p.Eval(`(() => { window.__marker = 'same page'; document.getElementById('draft').focus(); return true })()`, nil)
		labPost(e, "/api/bump")
		e.Until("the page shows the new state", func() bool { return p.TextContent("#n") == "1" })
		e.Equal(p.InputValue("#draft"), "typed", "what the user typed survived the refresh")
		var same string
		var focused bool
		p.Eval("window.__marker", &same)
		p.Eval("document.activeElement && document.activeElement.id === 'draft'", &focused)
		e.Equal(same, "same page", "the page was not reloaded")
		e.Assert(focused, "focus stayed in the field")
	}},

	// ---- a language model answer (ADR-0018) ----
	{Name: "model-lab/answer-grows-in-stable-blocks", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="chat"></div><button id="send" type="button" ypy-stream.post="/native/lab/api/model/run?id=1" ypy-trigger="click" `+
			`ypy-config='{"stream":{"frame":true}}'>Ask</button>`)
		// what the reader sees: the answer at every animation frame, and the blocks that must never be rewritten
		p.Eval(`(() => {
			const m = window.__model = { lens: [], txt: [], busy: [], broken: 0, marked: false }
			const tick = () => {
				const a = document.getElementById('a1')
				if (a) {
					m.lens.push(a.textContent.length); m.txt.push(a.textContent)
					m.busy.push(a.getAttribute('aria-busy'))
					const first = document.getElementById('a1-done') && document.getElementById('a1-done').firstElementChild
					if (first && !m.marked) { first.__block = true; m.marked = true }
					if (m.marked && a.getAttribute('aria-busy') === 'true' && !(first && first.__block)) m.broken++
				}
				if (!window.__modelStop) requestAnimationFrame(tick)
			}
			requestAnimationFrame(tick)
			return true
		})()`, nil)
		p.Click("#send")
		waitEqual(e, "document.getElementById('a1') && document.getElementById('a1').getAttribute('data-ypy-answer')", "done", "the answer is complete")
		var m struct {
			Lens   []int
			Txt    []string
			Busy   []string
			Broken int
			Marked bool
		}
		p.Eval("window.__model", &m)
		distinct := map[int]bool{}
		for i, n := range m.Lens {
			distinct[n] = true
			if i > 0 && m.Lens[i-1] > n && m.Busy[i] == "true" {
				fail("the answer got shorter while it was written (%d to %d): %q then %q", m.Lens[i-1], n, m.Txt[i-1], m.Txt[i])
			}
		}
		e.Assert(len(distinct) >= 8, fmt.Sprintf("the answer grew in many steps (%d lengths seen)", len(distinct)))
		e.Assert(m.Marked, "a closed block reached the done region")
		e.Equal(m.Broken, 0, "a closed block is never rewritten while the answer is written")

		var shape map[string]any
		p.Eval(`(() => {
			const a = document.getElementById('a1'), q = s => a.querySelectorAll(s).length
			return { busy: a.hasAttribute('aria-busy'), h1: q('h1'), strong: q('strong'), em: q('em'), code: q('p code'),
				link: a.querySelector('a') && a.querySelector('a').getAttribute('rel'), li: q('ul li'),
				fence: q('pre code.language-go'), fenceText: (a.querySelector('pre code') || {}).textContent,
				end: a.lastElementChild.textContent, untrusted: a.hasAttribute('ypy-untrusted') }
		})()`, &shape)
		e.Equal(shape, map[string]any{"busy": false, "h1": 1, "strong": 1, "em": 1, "code": 1, "link": "noopener noreferrer nofollow",
			"li": 2, "fence": 1, "fenceText": "x := 1\nfmt.Println(x)", "end": "The end.", "untrusted": true}, "the rendered answer")
		e.Until("the end is announced", func() bool { return len(logField(e, "ypy:announce", "message")) == 2 })
		e.Equal(logField(e, "ypy:announce", "message"), []string{"Answer started", "Answer ready"}, "announcements: one at the start, one at the end")
		waitEqual(e, "(document.querySelector('[data-ypy-live=polite]') || {}).textContent || ''", "Answer ready", "the live region says it")
		p.Sleep(600 * time.Millisecond)
		s := labGetStats(e)
		e.Equal([]any{s.Ended, s.Open["model"]}, []any{"done", 0}, "generation ended, connection closed")
		e.Equal([]int{s.Conns["model"], s.Conns["model-again"]}, []int{1, 1}, "the client asked once more after the end, got 204 and stopped")
	}},
	{Name: "model-lab/untrusted-content-is-cleaned", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="chat"></div><button id="send" type="button" ypy-stream.post="/native/lab/api/model/run?id=2&mode=evil" ypy-trigger="click">Ask</button>`)
		p.Eval(`(() => {
			window.__bad = 0
			new MutationObserver(() => {
				const a = document.getElementById('a2')
				if (a) window.__bad = Math.max(window.__bad, a.querySelectorAll('img,script,form,style,iframe,input,svg,object,embed').length)
			}).observe(document.getElementById('chat'), { subtree: true, childList: true })
			return true
		})()`, nil)
		p.Click("#send")
		waitEqual(e, "document.getElementById('a2') && document.getElementById('a2').getAttribute('data-ypy-answer')", "done", "the answer is complete")
		var r struct {
			Bad    int
			Attrs  []string
			Pwned  any
			Text   string
			Hrefs  []string
			Marked int
		}
		p.Eval(`(() => {
			const a = document.getElementById('a2')
			return { bad: window.__bad, pwned: window.__pwned ?? null, text: a.textContent,
				attrs: [...a.querySelectorAll('*')].flatMap(e => [...e.attributes].map(x => x.name + '=' + x.value))
					.filter(x => /^(on|ypy-|data-ypy|style|srcdoc)/i.test(x) || /javascript:/i.test(x)),
				hrefs: [...a.querySelectorAll('a')].map(x => x.getAttribute('href')) }
		})()`, &r)
		e.Equal(r.Bad, 0, "no active element was ever in the answer, not for a frame")
		e.Equal(r.Attrs, []string{}, "no event handler, ypy attribute, style or javascript: address is left")
		e.Equal(r.Pwned, nil, "nothing the model wrote ran")
		e.Assert(strings.Contains(r.Text, "Safe intro.") && strings.Contains(r.Text, "Safe outro."), "the safe text is still there")
		p.Sleep(700 * time.Millisecond)
		e.Equal(labGetStats(e).Pwn, 0, "no request came from the answer")
		e.Equal(p.Count("body > style, #chat style, #chat iframe"), 0, "no style or frame outside the container either")
	}},
	{Name: "model-lab/stop-button", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="chat"></div><button id="send" type="button" ypy-stream.post="/native/lab/api/model/run?id=3&mode=long" ypy-trigger="click">Ask</button>`+
			`<button id="stop" type="button" ypy-post="/native/lab/api/model/stop?id=3" ypy-swap="none" ypy-stop="#send">Stop</button>`)
		p.Click("#send")
		e.Until("the answer is growing", func() bool {
			var n int
			p.Eval("(document.getElementById('a3') || { textContent: '' }).textContent.length", &n)
			return n >= 60
		})
		p.Click("#stop")
		waitEqual(e, "document.getElementById('a3').getAttribute('data-ypy-answer')", "stopped", "the answer is marked as stopped")
		var busy bool
		p.Eval("document.getElementById('a3').hasAttribute('aria-busy')", &busy)
		e.Assert(!busy, "the answer is no longer busy")
		e.Until("the stop is announced", func() bool { return len(logField(e, "ypy:announce", "message")) == 2 })
		e.Equal(logField(e, "ypy:announce", "message"), []string{"Answer started", "Stopped"}, "announcements")
		var before, after int
		p.Eval("document.getElementById('a3').textContent.length", &before)
		e.Until("the server has seen the connection close", func() bool { return labGetStats(e).Open["model"] == 0 })
		t1 := labGetStats(e).Tokens
		p.Sleep(600 * time.Millisecond)
		p.Eval("document.getElementById('a3').textContent.length", &after)
		s := labGetStats(e)
		e.Equal(after, before, "the answer stopped growing")
		e.Equal(s.Tokens, t1, "the server stopped generating")
		e.Assert(s.Tokens < 300, fmt.Sprintf("the generation was cut short (%d tokens)", s.Tokens))
		e.Equal(s.Stopped, 1, "the application's own stop endpoint was called once")
		e.Assert(s.Ended == "stopped" || s.Ended == "dropped", "the server ended the generation: "+s.Ended)
		e.Equal(s.Conns["model"], 1, "a stopped stream does not reconnect")
	}},
	{Name: "model-lab/plain-text-mode", Run: func(e *Env) {
		p := e.Page
		labBegin(e)
		labMount(e, `<div id="chat"></div><button id="send" type="button" ypy-stream.post="/native/lab/api/model/run?id=7&mode=plain" ypy-trigger="click">Ask</button>`)
		p.Click("#send")
		waitEqual(e, "document.getElementById('a7') && document.getElementById('a7').getAttribute('data-ypy-answer')", "done", "the answer is complete")
		e.Equal(p.TextContent("#a7-done"), "Olá, mundo <b>!</b> & tchau", "the text is text")
		e.Equal(p.Count("#a7 b"), 0, "markup in the text was not turned into elements")
	}},

	// ---- ypy-ws ----
	{Name: "ws/text-is-not-markup", Run: func(e *Env) {
		p := e.Page
		p.Click("#ws-start")
		e.Until("greeting", func() bool { return contains(p.Texts("#ws-log p.msg"), "welcome") })
		const text = `<b>bold</b> & "quoted" olá ✓`
		p.Fill("#ws-form input[name=message]", text)
		p.Click("#ws-form button")
		e.Until("echo", func() bool { return contains(p.Texts("#ws-log p.msg"), "echo: "+text) })
		e.Equal(p.Count("#ws-log b"), 0, "the echoed text did not become markup")
	}},
}

// sseReconnect drops the server side of a ypy-sse connection and checks that the page goes on from
// the last message, exactly once each.
func sseReconnect(e *Env, mode string) {
	p := e.Page
	labBegin(e)
	labMount(e, `<ul id="log"></ul><div id="conn" ypy-sse:connect="/native/lab/api/sse/flaky" ypy-target="#log" ypy-swap="beforeend"></div>`)
	e.Until("three messages", atLeast(e, "#log li.msg", 3))
	e.Equal(labPost(e, "/api/drop?name=sse-flaky&mode="+mode), "1", "one connection dropped")
	e.UntilFor("messages continue after the reconnection", 8*time.Second, atLeast(e, "#log li.msg", 8))
	ns := items(e)
	e.Equal(ns, nameSeq(len(ns)), "no message lost or repeated")
	ids := labGetStats(e).LastIDs["sse-flaky"]
	e.Assert(len(ids) == 2 && ids[0] == "" && ids[1] != "", fmt.Sprintf("Last-Event-ID sent by the reconnection (got %v)", ids))
	p.Eval(`(() => { document.getElementById('conn').remove(); return true })()`, nil)
	e.UntilFor("the server connection is released when the element leaves", 4*time.Second, func() bool { return labGetStats(e).Open["sse-flaky"] == 0 })
}

// streamReconnect does the same for ypy-stream.
func streamReconnect(e *Env, mode string) {
	p := e.Page
	labBegin(e)
	labMount(e, `<ul id="log"></ul><div id="s" ypy-stream="/native/lab/api/stream/ticker"></div>`)
	e.Until("three events", atLeast(e, "#log li.msg", 3))
	e.Equal(labPost(e, "/api/drop?name=st-ticker&mode="+mode), "1", "one connection dropped")
	e.UntilFor("events continue after the reconnection", 8*time.Second, atLeast(e, "#log li.msg", 8))
	ns := items(e)
	e.Equal(ns, nameSeq(len(ns)), "no event lost or repeated")
	e.Assert(logCount(e, "ypy:stream:reconnect") >= 1, "the reconnection was announced")
	ids := labGetStats(e).LastIDs["st-ticker"]
	e.Assert(len(ids) == 2 && ids[0] == "" && ids[1] != "", fmt.Sprintf("Last-Event-ID sent by the reconnection (got %v)", ids))
	p.Eval(`(() => { document.getElementById('s').remove(); return true })()`, nil)
	e.UntilFor("the server connection is released when the element leaves", 4*time.Second, func() bool { return labGetStats(e).Open["st-ticker"] == 0 })
}
