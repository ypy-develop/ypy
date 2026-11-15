// SPDX-License-Identifier: MIT

package e2e

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// How a scenario is registered
//
// A scenario is a Scenario value: a unique Name ("area/what", for example
// "crud/create"; --scenario TEXT selects by substring) and a Run function that
// gets an *Env. Run reads like a plain script: every helper of Env and of
// e.Page (Click, Fill, Count, Texts, WaitSelector, Eval, Back, Forward ...)
// stops the scenario with a message when it fails, so there are no error
// returns to check. Wait for an outcome with e.Until / e.UntilFor or the Wait*
// helpers, never with a fixed Sleep; assert with e.Equal and e.Assert.
//
// The first 19 scenarios are the literal slice Scenarios below. A new set of
// scenarios goes in its own file of this package and registers itself from an
// init function:
//
//	// scenarios_ssr.go
//	func init() {
//		Register(
//			Scenario{Name: "ssr/first-paint", Run: func(e *Env) { ... }},
//			Scenario{Name: "ssr/spa-swap", Run: func(e *Env) { ... },
//				Skip: map[string]string{"safari": "why it cannot run there"}},
//		)
//	}
//
// Scenarios run in the order of registration: the ones below first, then the
// files in alphabetical order. The scenario runs in a fresh page of every
// browser asked for (chrome, firefox, safari), on a server reset to its
// initial state, with the app already open (Env.Open). It must pass in all of
// them: write it with the Page helpers, which behave the same everywhere, and
// do not reach for DevTools. When a scenario really depends on one browser,
// name the browsers it cannot run in with Skip (browser name -> reason); the
// matrix prints it as "skip" with the reason and it does not count as a
// failure. Routes the scenarios need are added to examples/server, not here.
// A scenario that needs a new Env or Page helper adds it in its own file.

// Scenario is one end to end check of the example app.
type Scenario struct {
	Name string
	Run  func(e *Env)
	// Skip names the browsers the scenario does not run in, with the reason
	// (browser name, as in browsers.Chrome, -> reason). Nil runs everywhere.
	Skip map[string]string
}

// Register adds scenarios to the suite, after the ones registered before. Call
// it from an init function of a file of this package.
func Register(list ...Scenario) { Scenarios = append(Scenarios, list...) }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func nameSeq(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = float64(i + 1)
	}
	return out
}

var (
	thanksURL = regexp.MustCompile(`/thanks\.html\?name=Ana%20Souza$`)
	fruits3   = []string{"Apple", "Banana", "Cherry"}
)

// Scenarios in the order they run.
var Scenarios = []Scenario{
	{Name: "lib/global", Run: func(e *Env) {
		var v map[string]any
		e.Page.Eval(`({ t: typeof window.ypy, ajax: typeof window.ypy?.ajax, on: typeof window.ypy?.on })`, &v)
		e.Equal(v, map[string]any{"t": "object", "ajax": "function", "on": "function"}, "global ypy API")
	}},

	// ---- CRUD ----
	{Name: "crud/list", Run: func(e *Env) {
		e.Until("three rows loaded", func() bool { return len(e.rowNames()) == 3 })
		e.Equal(e.rowNames(), fruits3, "initial rows")
	}},
	{Name: "crud/create", Run: func(e *Env) {
		p := e.Page
		e.Until("list loaded", func() bool { return len(e.rowNames()) == 3 })
		p.Fill("#create-form input[name=name]", "Durian")
		p.Click("#create-form button")
		e.Until("new row appended", func() bool { return contains(e.rowNames(), "Durian") })
		e.Equal(e.rowNames(), []string{"Apple", "Banana", "Cherry", "Durian"}, "rows after create")
		e.Until("form reset after success", func() bool { return p.InputValue("#create-form input[name=name]") == "" })
	}},
	{Name: "crud/edit-inline", Run: func(e *Env) {
		p := e.Page
		e.Until("list loaded", func() bool { return len(e.rowNames()) == 3 })
		p.Click(`#items tr[data-id="2"] button.edit`)
		const input = `#items tr[data-id="2"] input[name=name]`
		p.WaitSelector(input)
		e.Equal(p.InputValue(input), "Banana", "edit input is pre-filled")
		p.Fill(input, "Blueberry")
		p.Click(`#items tr[data-id="2"] button.save`)
		e.Until("row shows the saved name", func() bool { return contains(e.rowNames(), "Blueberry") })
		e.Equal(p.Count("#items tr.editing"), 0, "row left edit mode")
		e.Equal(p.Count("#items tr"), 3, "row count unchanged")
	}},
	{Name: "crud/edit-cancel", Run: func(e *Env) {
		p := e.Page
		e.Until("list loaded", func() bool { return len(e.rowNames()) == 3 })
		p.Click(`#items tr[data-id="1"] button.edit`)
		p.Fill(`#items tr[data-id="1"] input[name=name]`, "Changed")
		p.Click(`#items tr[data-id="1"] button.cancel`)
		e.Until("edit mode closed", func() bool { return p.Count("#items tr.editing") == 0 })
		e.Equal(e.rowNames(), fruits3, "rows unchanged by cancel")
	}},
	{Name: "crud/delete-confirm", Run: func(e *Env) {
		p := e.Page
		e.Until("list loaded", func() bool { return len(e.rowNames()) == 3 })
		message := ""
		p.OnDialog(func(m string) bool { message = m; return true })
		p.Click(`#items tr[data-id="3"] button.delete`)
		e.Until("row removed", func() bool { return len(e.rowNames()) == 2 })
		e.Equal(message, "Delete Cherry?", "confirm message")
		e.Equal(e.rowNames(), []string{"Apple", "Banana"}, "remaining rows")
		server := e.Get(e.API("/items"))
		e.Assert(!strings.Contains(server, "Cherry"), "item deleted on the server")
	}},
	{Name: "crud/delete-dismissed", Run: func(e *Env) {
		p := e.Page
		e.Until("list loaded", func() bool { return len(e.rowNames()) == 3 })
		p.OnDialog(func(string) bool { return false })
		p.Click(`#items tr[data-id="3"] button.delete`)
		p.Sleep(400 * time.Millisecond)
		e.Equal(len(e.rowNames()), 3, "nothing deleted when confirm is dismissed")
	}},

	{Name: "errors/5xx-not-swapped", Run: func(e *Env) {
		p := e.Page
		e.Until("list loaded", func() bool { return len(e.rowNames()) == 3 })
		p.Fill("#create-form input[name=name]", "boom")
		p.Click("#create-form button")
		e.Until("error event handled", func() bool { return p.TextContent("#flash") == "Request failed (500)" })
		e.Equal(p.Count("#items tr.server-error"), 0, "the 500 body was not swapped in")
		e.Equal(p.Count("#items tr"), 3, "no row added")
	}},

	// ---- Active search ----
	{Name: "search/filter", Run: func(e *Env) {
		p := e.Page
		e.Until("initial results on load", func() bool { return p.Count("#search-results li.person") == 12 })
		p.Fill("#search-input", "ca")
		e.Until("results filtered", func() bool { return p.Count("#search-results li.person") == 3 })
		e.Equal(p.Texts("#search-results li"), []string{"Carla Cruz", "Felipe Fonseca", "Lucas Lima"}, "filtered names")
		p.Fill("#search-input", "zzz")
		e.Until("empty state", func() bool { return p.Count("#search-results li.empty") == 1 })
	}},
	{Name: "search/debounce", Run: func(e *Env) {
		p := e.Page
		e.Until("initial results on load", func() bool { return p.Count("#search-results li.person") == 12 })
		before := e.Stats().Search
		p.PressSequentially("#search-input", "maria", 40*time.Millisecond)
		e.Until("final results", func() bool { return p.Count("#search-results li.empty") == 1 })
		p.Sleep(500 * time.Millisecond)
		after := e.Stats().Search
		e.Equal(after-before, 1, "one request for a burst of keystrokes (delay:300ms)")
	}},
	{Name: "search/indicator", Run: func(e *Env) {
		p := e.Page
		e.Until("initial results on load", func() bool { return p.Count("#search-results li.person") == 12 })
		p.Eval(`(() => {
			window.__sawRequestClass = false
			const el = document.getElementById('search-indicator')
			new MutationObserver(() => { if (el.classList.contains('ypy-request')) window.__sawRequestClass = true })
				.observe(el, { attributes: true, attributeFilter: ['class'] })
			return true
		})()`, nil)
		p.Fill("#search-input", "jo")
		e.Until("results", func() bool { return p.Count("#search-results li.person") == 1 })
		var saw, still bool
		p.Eval("window.__sawRequestClass", &saw)
		e.Assert(saw, "ypy-request class was set on the indicator during the request")
		p.Eval("document.getElementById('search-indicator').classList.contains('ypy-request')", &still)
		e.Assert(!still, "ypy-request class removed afterwards")
	}},

	// ---- Headers ----
	{Name: "headers/request", Run: func(e *Env) {
		p := e.Page
		p.Click("#hdrs-btn")
		e.Until("headers echoed", func() bool { return strings.Contains(p.TextContent("#hdrs-out"), "ypy-request") })
		text := p.TextContent("#hdrs-out")
		h := map[string]string{}
		for _, l := range strings.Split(text, "\n") {
			if i := strings.Index(l, ":"); i >= 0 && i+2 <= len(l) {
				h[l[:i]] = l[i+2:]
			} else if i >= 0 {
				h[l[:i]] = ""
			}
		}
		e.Equal(h["ypy-request"], "true", "YPY-Request")
		e.Assert(strings.Contains(h["ypy-target"], "hdrs-out"), fmt.Sprintf("YPY-Target names the target (got %s)", h["ypy-target"]))
		e.Assert(strings.HasPrefix(h["ypy-current-url"], e.Base), fmt.Sprintf("YPY-Current-URL (got %s)", h["ypy-current-url"]))
		// The element that triggered the request is sent in YPY-Source.
		e.Assert(strings.Contains(h["ypy-source"], "hdrs-btn"), fmt.Sprintf("YPY-Source (got %s)", h["ypy-source"]))
	}},
	{Name: "headers/response", Run: func(e *Env) {
		p := e.Page
		p.Click("#resp-btn")
		e.Until("YPY-Retarget and YPY-Reswap honoured", func() bool { return p.Count("#retarget-box p.retargeted") == 1 })
		e.Until("YPY-Trigger event dispatched", func() bool { return p.TextContent("#toast") == "toast fired" })
		e.Until("YPY-Push-Url pushed the URL", func() bool { return strings.HasSuffix(p.URL(), "/"+e.App+"/pushed") })
		e.Equal(p.TextContent("#hdrs-out"), "", "the original target was left alone")
	}},

	// ---- Infinite scroll ----
	{Name: "scroll/infinite", Run: func(e *Env) {
		p := e.Page
		e.Until("first page loaded", func() bool { return p.Count("#rows tr.row") >= 10 })
		e.Equal(p.Count("#rows tr.row"), 10, "first page has 10 rows")
		for i := 0; i < 30 && p.Count("#rows tr.row") < 40; i++ {
			p.Eval("(()=>{window.scrollTo(0, document.documentElement.scrollHeight);return true})()", nil)
			p.Sleep(200 * time.Millisecond)
		}
		e.Equal(p.Count("#rows tr.row"), 40, "all pages loaded by scrolling")
		var nums []float64
		p.Eval("[...document.querySelectorAll('#rows tr.row')].map(r => Number(r.dataset.n))", &nums)
		e.Equal(nums, nameSeq(40), "rows in order, no duplicates")
	}},

	// ---- Form with server validation ----
	{Name: "form/invalid-422", Run: func(e *Env) {
		p := e.Page
		url := p.URL()
		p.Click("#signup-form button")
		e.Until("three validation messages", func() bool { return p.Count("#signup-form .error") == 3 })
		e.Equal(p.Texts("#signup-form .error"), []string{
			"Name must have at least 2 characters.",
			"Enter a valid email address.",
			"Password must have at least 8 characters.",
		}, "messages")
		e.Equal(p.URL(), url, "no navigation on validation error")
		p.Fill("#signup-form input[name=name]", "Ana")
		p.Fill("#signup-form input[name=email]", "not-an-email")
		p.Click("#signup-form button")
		e.Until("two messages left", func() bool { return p.Count("#signup-form .error") == 2 })
		e.Equal(p.InputValue("#signup-form input[name=name]"), "Ana", "typed values come back with the form")
		e.Equal(p.InputValue("#signup-form input[name=email]"), "not-an-email", "typed email comes back")
		e.Equal(e.Stats().Signups, 0, "nothing created")
	}},
	{Name: "form/valid-redirect", Run: func(e *Env) {
		p := e.Page
		p.Fill("#signup-form input[name=name]", "Ana Souza")
		p.Fill("#signup-form input[name=email]", "ana@example.com")
		p.Fill("#signup-form input[name=password]", "correct horse")
		p.Click("#signup-form button")
		p.WaitURL(thanksURL, 5*time.Second)
		e.Until("thanks page greets the user", func() bool { return p.TextContent("#who") == "Ana Souza" })
		e.Equal(e.Stats().Signups, 1, "one signup recorded")
	}},

	// ---- SSE ----
	{Name: "sse/stream", Run: func(e *Env) {
		p := e.Page
		p.Click("#sse-start")
		e.UntilFor("three streamed events", 6*time.Second, func() bool { return p.Count("#sse-log li.tick") == 3 })
		e.Equal(p.Texts("#sse-log li.tick"), []string{"tick 1", "tick 2", "tick 3"}, "events in order")
		e.Until("closing event handled", func() bool { return p.TextContent("#sse-status") == "bye" })
		p.Sleep(800 * time.Millisecond)
		s := e.Stats()
		e.Equal([]int{s.SSEConnections, s.SSEOpen}, []int{1, 0}, "one connection, closed, no reconnect after the close event")
		e.Equal(p.Count("#sse-log li.tick"), 3, "no duplicate events")
	}},

	// ---- WebSocket ----
	{Name: "ws/echo", Run: func(e *Env) {
		p := e.Page
		p.Click("#ws-start")
		e.Until("server greeting swapped in", func() bool { return contains(p.Texts("#ws-log p.msg"), "welcome") })
		p.Fill("#ws-form input[name=message]", "hello")
		p.Click("#ws-form button")
		e.Until("echo swapped in", func() bool { return contains(p.Texts("#ws-log p.msg"), "echo: hello") })
		s := e.Stats()
		e.Equal([]int{s.WSConnections, s.WSMessages}, []int{1, 1}, "one socket, one message sent")
		p.Fill("#ws-form input[name=message]", "again")
		p.PressEnter("#ws-form input[name=message]")
		e.Until("second echo", func() bool { return contains(p.Texts("#ws-log p.msg"), "echo: again") })
		e.Equal(p.Texts("#ws-log p.msg"), []string{"welcome", "echo: hello", "echo: again"}, "log order")
	}},

	// ---- Event names of the contract ----
	{Name: "events/names", Run: func(e *Env) {
		var seen []struct {
			N   string `json:"n"`
			Ctx string `json:"ctx"`
		}
		e.Page.Eval(`(async () => {
			const log = []
			const n = 'ypy:after:request'
			document.addEventListener(n, e => log.push({ n, ctx: typeof e.detail?.ctx }))
			document.getElementById('hdrs-btn').click()
			const end = Date.now() + 4000
			while (!log.length && Date.now() < end) await new Promise(r => setTimeout(r, 50))
			return log.slice(0, 1)
		})()`, &seen)
		var got [][2]string
		for _, x := range seen {
			got = append(got, [2]string{x.N, x.Ctx})
		}
		e.Equal(got, [][2]string{{"ypy:after:request", "object"}}, "event name and detail")
	}},
}
