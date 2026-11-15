// SPDX-License-Identifier: MIT

package main

// The streaming lab of the example server: server-sent events, the YPY stream
// protocol (spec/PROTOCOL.md section 5) and a fake language model (ADR-0018).
// It serves what the scenarios of internal/e2e/scenarios_sse.go need, under
//
//	/<app>/lab/             an empty page with every extension loaded
//	/<app>/lab/page         a page that refreshes itself when a stream says so
//	/<app>/lab/redirected   where a stream redirect lands
//	/<app>/lab/api/...      streams, counters and the control endpoints
//
// The example server does not import the Go SDK, so every byte of a stream is
// written here by hand, the same bytes as the vectors in test/fixtures/stream.

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// labState is the state of the lab. One per process; POST /lab/api/reset
// restores it, so a scenario starts from nothing.
type labState struct {
	mu      sync.Mutex
	conns   map[string]int
	open    map[string]int
	lastIDs map[string][]string
	live    map[string]map[*labConn]struct{}
	subs    map[*labSub]struct{}
	stops   map[string]chan struct{}
	done    map[string]bool
	counter int
	cartGet int
	pwn     int
	tokens  int
	stopped int
	ended   string
}

type labConn struct {
	kill chan struct{}
	cut  bool
	once sync.Once
}

// labSub is a client waiting for a change of the counter.
type labSub struct {
	kind string // "state" or "room"
	arg  string
	ch   chan string
}

var lab = newLab()

func newLab() *labState {
	return &labState{
		conns:   map[string]int{},
		open:    map[string]int{},
		lastIDs: map[string][]string{},
		live:    map[string]map[*labConn]struct{}{},
		subs:    map[*labSub]struct{}{},
		stops:   map[string]chan struct{}{},
		done:    map[string]bool{},
	}
}

func (l *labState) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, set := range l.live {
		for c := range set {
			c.once.Do(func() { close(c.kill) })
		}
	}
	fresh := newLab()
	l.conns, l.open, l.lastIDs, l.live = fresh.conns, fresh.open, fresh.lastIDs, fresh.live
	l.subs, l.stops, l.done = fresh.subs, fresh.stops, fresh.done
	l.counter, l.cartGet, l.pwn, l.tokens, l.stopped, l.ended = 0, 0, 0, 0, 0, ""
}

// labServe answers the routes of the lab. It reports false for any other path.
func (s *server) labServe(w http.ResponseWriter, r *http.Request, rest string) bool {
	if rest != "/lab" && !strings.HasPrefix(rest, "/lab/") {
		return false
	}
	route := strings.TrimPrefix(rest, "/lab")
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case route == "" || route == "/":
		labPage(w, `<main id="main"><div id="mount"></div></main>`)
	case route == "/page":
		lab.mu.Lock()
		n := lab.counter
		lab.mu.Unlock()
		labPage(w, fmt.Sprintf(`<main id="main"><div id="room" ypy-stream="/native/lab/api/stream/room" ypy-history-elt>`+
			`<p id="n">%d</p><input id="draft" name="draft"></div></main>`, n))
	case route == "/redirected":
		labPage(w, `<main id="main"><p id="landed">landed</p></main>`)
	case strings.HasPrefix(route, "/api/"):
		lab.api(w, r, strings.TrimPrefix(route, "/api"))
	default:
		send(w, 404, "text/plain", "not found")
	}
	return true
}

// labPage writes a page with every extension. ypy-stream is loaded before ypy-sse: an element
// with ypy-stream must not be taken by the older extension.
func labPage(w http.ResponseWriter, body string) {
	const scripts = `<script src="/_lib/core.js"></script>` +
		`<script src="/_lib/ext/stream.js"></script>` +
		`<script src="/_lib/ext/model.js"></script>` +
		`<script src="/_lib/ext/signals.js"></script>` +
		`<script src="/_lib/ext/sse.js"></script>`
	page := `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Streaming lab</title>` +
		`<meta name="ypy-config" content='{"noSwap":[204,304,"5xx"]}'>` + scripts +
		`</head><body>` + body + `</body></html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(page))
}

func (l *labState) api(w http.ResponseWriter, r *http.Request, route string) {
	switch {
	case route == "/reset" && r.Method == http.MethodPost:
		l.reset()
		w.WriteHeader(http.StatusNoContent)
	case route == "/stats":
		l.mu.Lock()
		out, _ := json.Marshal(map[string]any{
			"conns": l.conns, "open": l.open, "lastIds": l.lastIDs, "counter": l.counter,
			"cartGets": l.cartGet, "pwn": l.pwn, "tokens": l.tokens, "stopped": l.stopped, "ended": l.ended,
		})
		l.mu.Unlock()
		send(w, 200, "application/json", string(out))
	case route == "/drop" && r.Method == http.MethodPost:
		q := r.URL.Query()
		n := l.drop(q.Get("name"), q.Get("mode") == "cut")
		send(w, 200, "text/plain", strconv.Itoa(n))
	case route == "/bump" && r.Method == http.MethodPost:
		l.bump()
		w.WriteHeader(http.StatusNoContent)
	case route == "/cart":
		l.mu.Lock()
		l.cartGet++
		n := l.counter
		l.mu.Unlock()
		sendHTML(w, 200, fmt.Sprintf(`<p class="count">%d items</p>`, n))
	case route == "/pwn":
		l.mu.Lock()
		l.pwn++
		l.mu.Unlock()
		send(w, 200, "text/plain", "pwned")
	case route == "/sse/hello":
		l.sseHello(w, r)
	case route == "/sse/flaky":
		l.sseTicker(w, r, "sse-flaky", false)
	case route == "/sse/silent":
		l.sseSilent(w, r)
	case route == "/stream/ticker":
		l.sseTicker(w, r, "st-ticker", true)
	case route == "/stream/patches":
		l.streamPatches(w, r)
	case route == "/stream/state":
		l.streamSubscribe(w, r, "st-state", "state", "")
	case route == "/stream/room":
		l.streamSubscribe(w, r, "st-room", "room", r.URL.Query().Get("sel"))
	case route == "/stream/none":
		l.mu.Lock()
		l.conns["st-none"]++
		l.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	case route == "/model/run":
		l.modelRun(w, r)
	case route == "/model/stop" && r.Method == http.MethodPost:
		l.mu.Lock()
		l.stopped++
		ch := l.stopChan(r.URL.Query().Get("id"))
		l.mu.Unlock()
		select {
		case <-ch:
		default:
			close(ch)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		send(w, 404, "text/plain", "not found")
	}
}

// ---- connections -----------------------------------------------------------------------

// begin starts an event stream: it counts the connection, remembers the Last-Event-ID the client
// sent and writes the headers. The caller defers the returned function.
func (l *labState) begin(w http.ResponseWriter, r *http.Request, name string) (*labConn, http.Flusher, func()) {
	fl, ok := w.(http.Flusher)
	if !ok {
		send(w, 500, "text/plain", "streaming unsupported")
		return nil, nil, nil
	}
	c := &labConn{kill: make(chan struct{})}
	l.mu.Lock()
	l.conns[name]++
	l.open[name]++
	l.lastIDs[name] = append(l.lastIDs[name], r.Header.Get("Last-Event-ID"))
	if l.live[name] == nil {
		l.live[name] = map[*labConn]struct{}{}
	}
	l.live[name][c] = struct{}{}
	l.mu.Unlock()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, ": open\n\n")
	fl.Flush()
	return c, fl, func() {
		l.mu.Lock()
		l.open[name]--
		delete(l.live[name], c)
		l.mu.Unlock()
	}
}

// drop ends every open connection of a stream: cleanly (the response finishes), or cut (the
// connection is torn down in the middle of the chunked body, like a crashed server).
func (l *labState) drop(name string, cut bool) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for c := range l.live[name] {
		c.cut = cut
		c.once.Do(func() { close(c.kill) })
		n++
	}
	return n
}

// end leaves the handler the way drop asked for.
func (c *labConn) end() {
	if c.cut {
		panic(http.ErrAbortHandler)
	}
}

func lastEventID(r *http.Request) int {
	n, _ := strconv.Atoi(r.Header.Get("Last-Event-ID"))
	return n
}

// evFrame is one event of a stream: the optional id and retry, the event name and its data lines.
func evFrame(id string, retry int, event string, data ...string) string {
	var b strings.Builder
	if retry > 0 {
		fmt.Fprintf(&b, "retry: %d\n", retry)
	}
	if id != "" {
		fmt.Fprintf(&b, "id: %s\n", id)
	}
	if event != "" {
		fmt.Fprintf(&b, "event: %s\n", event)
	}
	for _, d := range data {
		b.WriteString("data: " + d + "\n")
	}
	return b.String() + "\n"
}

// elementsLines carries multi-line HTML as one elements line per line (protocol 5.2).
func elementsLines(htmlText string) []string {
	var out []string
	for _, l := range strings.Split(htmlText, "\n") {
		out = append(out, "elements "+l)
	}
	return out
}

func patch(mode, selector, htmlText string, extra ...string) string {
	data := []string{}
	if mode != "" {
		data = append(data, "mode "+mode)
	}
	if selector != "" {
		data = append(data, "selector "+selector)
	}
	data = append(data, extra...)
	if mode != "remove" {
		data = append(data, elementsLines(htmlText)...)
	}
	return evFrame("", 0, "ypy-patch-elements", data...)
}

// ---- server-sent events (ypy-sse) --------------------------------------------------------------

// sseHello sends three messages, one named event and a closing event.
func (l *labState) sseHello(w http.ResponseWriter, r *http.Request) {
	c, fl, done := l.begin(w, r, "sse-hello")
	if c == nil {
		return
	}
	defer done()
	out := []string{
		"id: 1\ndata: <li class=\"msg\">hello 1</li>\n\n",
		"id: 2\ndata: <li class=\"msg\">hello 2</li>\n\n",
		"id: 3\ndata: <li class=\"msg\">hello 3</li>\n\n",
		"event: notice\ndata: hi there\n\n",
		"event: done\ndata: bye\n\n",
	}
	for _, f := range out {
		select {
		case <-time.After(60 * time.Millisecond):
		case <-r.Context().Done():
			return
		case <-c.kill:
			c.end()
			return
		}
		_, _ = fmt.Fprint(w, f)
		fl.Flush()
	}
	select { // the client closes on "done"; wait for it
	case <-r.Context().Done():
	case <-c.kill:
		c.end()
	case <-time.After(3 * time.Second):
	}
}

// sseTicker numbers messages 1, 2, 3 ... one every 80 ms and continues from the Last-Event-ID the
// client sends. With proto the messages are ypy-patch-elements events, otherwise plain SSE data.
func (l *labState) sseTicker(w http.ResponseWriter, r *http.Request, name string, proto bool) {
	c, fl, done := l.begin(w, r, name)
	if c == nil {
		return
	}
	defer done()
	tick := time.NewTicker(80 * time.Millisecond)
	defer tick.Stop()
	for n := lastEventID(r) + 1; ; n++ {
		select {
		case <-r.Context().Done():
			return
		case <-c.kill:
			c.end()
			return
		case <-tick.C:
		}
		li := fmt.Sprintf(`<li class="msg" data-n="%d">msg %d</li>`, n, n)
		if proto {
			_, _ = fmt.Fprint(w, evFrame(strconv.Itoa(n), 100, "ypy-patch-elements", "mode append", "selector #log", "elements "+li))
		} else {
			_, _ = fmt.Fprint(w, evFrame(strconv.Itoa(n), 100, "", li))
		}
		fl.Flush()
	}
}

// sseSilent sends one numbered message and then nothing, or with ?beat=ms a comment line every beat ms.
func (l *labState) sseSilent(w http.ResponseWriter, r *http.Request) {
	c, fl, done := l.begin(w, r, "sse-silent")
	if c == nil {
		return
	}
	defer done()
	n := lastEventID(r) + 1
	_, _ = fmt.Fprintf(w, "retry: 100\nid: %d\ndata: <li class=\"msg\">silent %d</li>\n\n", n, n)
	fl.Flush()
	beat, _ := strconv.Atoi(r.URL.Query().Get("beat"))
	var tick <-chan time.Time
	if beat > 0 {
		t := time.NewTicker(time.Duration(beat) * time.Millisecond)
		defer t.Stop()
		tick = t.C
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c.kill:
			c.end()
			return
		case <-tick:
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			fl.Flush()
		}
	}
}

// ---- the YPY protocol -----------------------------------------------------------------------------

// streamPatches sends the events of one conformance vector and keeps the connection open.
func (l *labState) streamPatches(w http.ResponseWriter, r *http.Request) {
	c, fl, done := l.begin(w, r, "st-patches")
	if c == nil {
		return
	}
	defer done()
	var out []string
	switch r.URL.Query().Get("case") {
	case "modes": // vector elements-modes
		out = []string{
			patch("", "#b", `<li id="b" class="x">B2</li>`),
			patch("inner", "#a", `<i>A2</i>`),
			patch("append", "#l", `<li id="d">D</li>`),
			patch("prepend", "#l", `<li id="z">Z</li>`),
			patch("before", "#c", `<li id="y">Y</li>`),
			patch("after", "#c", `<li id="x">X</li>`),
			patch("replace", "#d", `<li id="w">W</li>`),
			patch("remove", "#z", ""),
		}
	case "lists": // vectors list-key and list-append-limit, then list-prepend-limit
		out = []string{
			patch("append", "#users", `<li data-id="2">Bia!</li><li data-id="3">Caio</li>`, "key data-id"),
			patch("append", "#users", `<li data-id="4">Duda</li><li data-id="4">Duda 2</li>`, "key data-id"),
			patch("append", "#log", `<li>4</li>`, "limit 3"),
			patch("append", "#log", `<li>5</li><li>6</li>`, "limit 3"),
			patch("prepend", "#rlog", `<li>0</li>`, "limit 3"),
		}
	case "byid": // vector elements-by-id: no selector, the id says where it goes; multi-line HTML
		out = []string{
			evFrame("", 0, "ypy-patch-elements", "elements <ul id=\"messages\">", "elements   <li>héllo</li>", "elements </ul>"),
			patch("remove", "#typing", ""),
		}
	case "signals":
		out = []string{
			evFrame("", 0, "ypy-patch-signals", `signals {"name":"Ana","online":3}`),
			evFrame("", 0, "ypy-patch-signals", "onlyIfMissing true", `signals {"theme":"light","name":"Zed"}`),
		}
	case "event":
		out = []string{
			evFrame("", 0, "ypy-event", "name message:new", `detail {"id":42}`),
			evFrame("", 0, "ypy-event", "name badge:seen", "selector #badge"),
		}
	case "redirect":
		out = []string{evFrame("", 0, "ypy-redirect", "url /native/lab/redirected")}
	case "redirect-away":
		out = []string{evFrame("", 0, "ypy-redirect", "url https://example.org/elsewhere")}
	case "unknown": // unknown events and keys are ignored; the known one after them still works
		out = []string{
			evFrame("", 0, "ypy-from-the-future", "x 1"),
			evFrame("", 0, "ypy-patch-elements", "mode inner", "selector #t", "novelty yes", "elements ok"),
		}
	}
	for _, f := range out {
		_, _ = fmt.Fprint(w, f)
	}
	fl.Flush()
	select {
	case <-r.Context().Done():
	case <-c.kill:
		c.end()
	}
}

// bump changes the counter and then tells every subscriber (state first, event second: 6.1).
func (l *labState) bump() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.counter++
	for s := range l.subs {
		select {
		case s.ch <- l.event(s):
		default: // a slow client is dropped by its own loop; it gets the snapshot when it returns
		}
	}
}

func (l *labState) event(s *labSub) string {
	switch s.kind {
	case "state":
		return stateFrame(l.counter)
	default:
		data := []string{"debounce 150"}
		if s.arg != "" {
			data = append([]string{"selector " + s.arg}, data...)
		}
		return evFrame("", 0, "ypy-refresh", data...)
	}
}

func stateFrame(n int) string {
	return evFrame(strconv.Itoa(n), 300, "ypy-patch-elements",
		fmt.Sprintf(`elements <div id="state" data-count="%d">count=%d</div>`, n, n))
}

// streamSubscribe serves a stream that follows the counter. A state stream opens with the full
// state (the fat morph); a room stream sends a refresh for each change.
func (l *labState) streamSubscribe(w http.ResponseWriter, r *http.Request, name, kind, arg string) {
	c, fl, done := l.begin(w, r, name)
	if c == nil {
		return
	}
	defer done()
	s := &labSub{kind: kind, arg: arg, ch: make(chan string, 32)}
	l.mu.Lock() // register before reading the snapshot, so no change is lost
	l.subs[s] = struct{}{}
	n := l.counter
	l.mu.Unlock()
	defer func() { l.mu.Lock(); delete(l.subs, s); l.mu.Unlock() }()
	if kind == "state" {
		_, _ = fmt.Fprint(w, stateFrame(n))
		fl.Flush()
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c.kill:
			c.end()
			return
		case f := <-s.ch:
			_, _ = fmt.Fprint(w, f)
			fl.Flush()
		}
	}
}

// ---- a fake language model (ADR-0018, protocol 5.8) ------------------------------------------------

const labAnswer = "# A streamed answer\n\n" +
	"Hello **world**, this answer grows with `code` and a [link](https://example.com/docs).\n\n" +
	"- first point\n- second point\n\n" +
	"A second paragraph that keeps *growing* while the model writes it.\n\n" +
	"```go\nx := 1\nfmt.Println(x)\n```\n\n" +
	"The end.\n"

var labLong = strings.Repeat("Another paragraph of the long answer, written token by token.\n\n", 40)

const labEvil = "Safe intro.\n\n" +
	"<img src=\"x\" onerror=\"window.__pwned=1\">\n\n" +
	"<script>window.__pwned=2</script>\n\n" +
	"<a href=\"javascript:window.__pwned=3\" onclick=\"window.__pwned=4\">click me</a>\n\n" +
	"<div ypy-get=\"/native/lab/api/pwn\" ypy-trigger=\"load\">injected</div>\n\n" +
	"<form action=\"/native/lab/api/pwn\"><input name=\"a\"></form>\n\n" +
	"<style>body{display:none}</style>\n\n" +
	"<iframe src=\"/native/lab/api/pwn\"></iframe>\n\n" +
	"Safe outro.\n"

const labPlain = "Olá, mundo <b>!</b> & tchau"

var (
	reCode   = regexp.MustCompile("`([^`]+)`")
	reStrong = regexp.MustCompile(`\*\*(.+?)\*\*`)
	reEm     = regexp.MustCompile(`\*([^*]+)\*`)
	reLink   = regexp.MustCompile(`\[([^\]]+)\]\((https?://[^)\s]+)\)`)
	reLang   = regexp.MustCompile(`^[a-z0-9+-]{1,20}$`)
	reDangle = regexp.MustCompile(`\[([^\]]*)\]?(?:\([^)]*)?$`)
)

// stopChan is the channel that the stop endpoint closes for a generation. Call with the lock held.
func (l *labState) stopChan(id string) chan struct{} {
	if l.stops[id] == nil {
		l.stops[id] = make(chan struct{})
	}
	return l.stops[id]
}

// tokensOf cuts a text into pieces of a few characters, never inside a UTF-8 sequence.
func tokensOf(text string) []string {
	var out []string
	rs := []rune(text)
	for i := 0; i < len(rs); i += 4 {
		out = append(out, string(rs[i:min(i+4, len(rs))]))
	}
	return out
}

// splitBlocks returns the closed Markdown blocks of a text and the open one: a block closes at a
// blank line, or at the closing line of a code fence.
func splitBlocks(text string) (closed []string, open string) {
	lines := strings.Split(text, "\n")
	var cur []string
	fence := false
	flush := func() {
		if len(cur) > 0 {
			closed = append(closed, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	for i, ln := range lines {
		if i == len(lines)-1 { // the line still being written
			cur = append(cur, ln)
			break
		}
		isFence := strings.HasPrefix(ln, "```")
		switch {
		case fence:
			cur = append(cur, ln)
			if isFence {
				fence = false
				flush()
			}
		case isFence:
			flush()
			fence = true
			cur = append(cur, ln)
		case strings.TrimSpace(ln) == "":
			flush()
		default:
			cur = append(cur, ln)
		}
	}
	return closed, strings.TrimRight(strings.Join(cur, "\n"), "\n ")
}

// inline renders the spans of a line. With unsafe the text is not escaped: that is a server with a
// broken renderer, which the client wall of ypy-untrusted exists for.
func inline(s string, unsafe, open bool) string {
	if open { // close what the model has not closed yet, so the open block always renders
		s = reDangle.ReplaceAllString(s, "$1") // a link still being written shows its text only
		if strings.Count(s, "`")%2 == 1 {
			s += "`"
		}
		if strings.Count(s, "**")%2 == 1 {
			s += "**"
		} else if strings.Count(strings.ReplaceAll(s, "**", ""), "*")%2 == 1 {
			s += "*"
		}
	}
	if !unsafe {
		s = html.EscapeString(s)
	}
	s = reCode.ReplaceAllString(s, "<code>$1</code>")
	s = reStrong.ReplaceAllString(s, "<strong>$1</strong>")
	s = reEm.ReplaceAllString(s, "<em>$1</em>")
	if !unsafe {
		s = reLink.ReplaceAllString(s, `<a href="$2" rel="noopener noreferrer nofollow">$1</a>`)
	}
	return s
}

func renderBlock(b string, unsafe, open bool) string {
	b = strings.TrimRight(b, "\n ")
	switch {
	case strings.TrimSpace(b) == "":
		return ""
	case open && (b == "`" || b == "``" || b == "-" || b == "#"): // the start of a marker is not text yet
		return ""
	case strings.HasPrefix(b, "```"):
		lines := strings.Split(b, "\n")
		lang := strings.TrimSpace(strings.TrimPrefix(lines[0], "```"))
		body := lines[1:]
		if n := len(body); n > 0 && body[n-1] != "" && strings.Trim(body[n-1], "`") == "" { // the closing fence, or the start of it
			body = body[:n-1]
		}
		cls := ""
		if reLang.MatchString(lang) {
			cls = ` class="language-` + lang + `"`
		}
		return "<pre><code" + cls + ">" + html.EscapeString(strings.Join(body, "\n")) + "</code></pre>"
	case strings.HasPrefix(b, "# "):
		return "<h1>" + inline(strings.TrimPrefix(b, "# "), unsafe, open) + "</h1>"
	case strings.HasPrefix(b, "- "):
		var sb strings.Builder
		sb.WriteString("<ul>")
		lines := strings.Split(b, "\n")
		for i, ln := range lines {
			sb.WriteString("<li>" + inline(strings.TrimPrefix(ln, "- "), unsafe, open && i == len(lines)-1) + "</li>")
		}
		return sb.String() + "</ul>"
	}
	return "<p>" + inline(strings.ReplaceAll(b, "\n", " "), unsafe, open) + "</p>"
}

func renderAll(blocks []string, unsafe bool) string {
	var sb strings.Builder
	for _, b := range blocks {
		sb.WriteString(renderBlock(b, unsafe, false))
	}
	return sb.String()
}

const answerAttrs = `ypy-untrusted ypy-follow ypy-announce-start="Answer started" ypy-announce="Answer ready" ` +
	`ypy-announce-stop="Stopped" ypy-announce-error="Failed" aria-live="off"`

// modelRun streams one answer. ?mode is normal, long (slow, for the stop button), evil (a renderer
// that does not escape) or plain (the low-cost mode: escaped text, no Markdown, no regions);
// ?id names the answer; ?into is the selector that receives it.
func (l *labState) modelRun(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id, mode, into := q.Get("id"), q.Get("mode"), q.Get("into")
	if id == "" {
		id = "1"
	}
	if into == "" {
		into = "#chat"
	}
	l.mu.Lock()
	over := l.done[id]
	stop := l.stopChan(id)
	l.mu.Unlock()
	if over { // the client reconnects after the end of the response: a finished answer is not sent again
		l.mu.Lock()
		l.conns["model-again"]++
		l.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	c, fl, done := l.begin(w, r, "model")
	if c == nil {
		return
	}
	defer done()
	finish := func(how string) {
		l.mu.Lock()
		l.ended = how
		l.done[id] = true
		l.mu.Unlock()
	}

	aid := "a" + id
	text, pace := labAnswer, 25*time.Millisecond
	switch mode {
	case "long":
		text, pace = labLong, 30*time.Millisecond
	case "evil":
		text = labEvil
	case "plain":
		text = labPlain
	}
	unsafe, plain := mode == "evil", mode == "plain"
	write := func(f ...string) {
		_, _ = fmt.Fprint(w, strings.Join(f, ""))
		fl.Flush()
	}
	regions := fmt.Sprintf(`<div id="%s-done"></div><div id="%s-tail"></div>`, aid, aid)
	if plain {
		regions = fmt.Sprintf(`<div id="%s-done"></div>`, aid)
	}
	write(patch("append", into, fmt.Sprintf(`<article id="%s" %s aria-busy="true">%s</article>`, aid, answerAttrs, regions)))

	var got strings.Builder
	sent, lastTail := 0, "-"
	tick := time.NewTicker(pace)
	defer tick.Stop()
	for _, tok := range tokensOf(text) {
		select {
		case <-r.Context().Done():
			finish("dropped") // the policy "bound": a closed connection cancels the generation
			return
		case <-c.kill:
			finish("dropped")
			c.end()
			return
		case <-stop:
			closed, open := splitBlocks(got.String())
			final := renderAll(closed, unsafe) + renderBlock(open, unsafe, false) + `<p class="ypy-model-note">Stopped.</p>`
			write(patch("", "#"+aid, fmt.Sprintf(`<article id="%s" %s data-ypy-answer="stopped">%s</article>`, aid, answerAttrs, final)))
			finish("stopped")
			return
		case <-tick.C:
		}
		l.mu.Lock()
		l.tokens++
		l.mu.Unlock()
		got.WriteString(tok)
		if plain {
			write(patch("append", "#"+aid+"-done", html.EscapeString(tok)))
			continue
		}
		closed, open := splitBlocks(got.String())
		var out []string
		if len(closed) > sent {
			out = append(out, patch("append", "#"+aid+"-done", renderAll(closed[sent:], unsafe)))
			sent = len(closed)
		}
		if tail := renderBlock(open, unsafe, true); tail != lastTail {
			out = append(out, patch("inner", "#"+aid+"-tail", tail))
			lastTail = tail
		}
		if len(out) > 0 {
			write(out...)
		}
	}
	var final string
	if plain {
		final = fmt.Sprintf(`<div id="%s" %s data-ypy-answer="done"><div id="%s-done">%s</div></div>`, aid, answerAttrs, aid, html.EscapeString(got.String()))
	} else {
		closed, open := splitBlocks(got.String())
		final = fmt.Sprintf(`<article id="%s" %s data-ypy-answer="done">%s%s</article>`, aid, answerAttrs,
			renderAll(closed, unsafe), renderBlock(open, unsafe, false))
	}
	write(patch("", "#"+aid, final))
	finish("done")
}
