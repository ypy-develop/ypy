// SPDX-License-Identifier: MIT

package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync/atomic"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/chromedp/chromedp/kb"
)

// failure is the panic value of a scenario that failed; the runner recovers it.
// Scenarios read like plain scripts: every helper that
// fails stops the scenario.
type failure struct{ msg string }

func (f failure) Error() string { return f.msg }

func fail(format string, args ...any) { panic(failure{fmt.Sprintf(format, args...)}) }

// Page is a Chrome tab with the few operations the scenarios use.
type Page struct {
	ctx context.Context
	// accept decides what a dialog gets: true accepts it. The default accepts.
	accept atomic.Pointer[func(message string) bool]
}

func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func (p *Page) must(err error) {
	if err == nil {
		return
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		panic(err)
	}
	fail("%v", err)
}

// OnDialog sets the handler of alert, confirm and prompt dialogs.
func (p *Page) OnDialog(f func(message string) bool) { p.accept.Store(&f) }

func (p *Page) dialog(message string) bool {
	if f := p.accept.Load(); f != nil {
		return (*f)(message)
	}
	return true
}

// Goto loads a URL and waits for the load event.
func (p *Page) Goto(url string) { p.must(chromedp.Do(p.ctx, chromedp.Navigate(url))) }

// Eval evaluates a JavaScript expression (a promise is awaited) and decodes its
// JSON value into out, when out is not nil.
func (p *Page) Eval(expr string, out any) {
	wrapped := "(async()=>{const r=await (" + expr + ");return JSON.stringify(r===undefined?null:r)})()"
	s, err := chromedp.Run(p.ctx, chromedp.Evaluate[string](wrapped, chromedp.EvalAwaitPromise))
	p.must(err)
	if out != nil {
		if err := json.Unmarshal([]byte(s), out); err != nil {
			fail("evaluate: cannot read %q: %v", s, err)
		}
	}
}

func (p *Page) evalBool(expr string) bool {
	var b bool
	p.Eval(expr, &b)
	return b
}

// URL is the current address.
func (p *Page) URL() string {
	var u string
	p.Eval("location.href", &u)
	return u
}

// Count is the number of elements that match the selector.
func (p *Page) Count(sel string) int {
	var n int
	p.Eval("document.querySelectorAll("+jsString(sel)+").length", &n)
	return n
}

// Texts is the text content of every element that matches the selector.
func (p *Page) Texts(sel string) []string {
	out := []string{}
	p.Eval("[...document.querySelectorAll("+jsString(sel)+")].map(e=>e.textContent)", &out)
	return out
}

// WaitSelector waits until an element matches the selector.
func (p *Page) WaitSelector(sel string) {
	p.poll("selector "+sel, 10*time.Second, func() bool { return p.Count(sel) > 0 })
}

// WaitFunction waits until the JavaScript expression is truthy.
func (p *Page) WaitFunction(expr string) {
	p.poll("function "+expr, 10*time.Second, func() bool { return p.evalBool("!!(" + expr + ")") })
}

// WaitURL waits until the address matches the regular expression.
func (p *Page) WaitURL(re *regexp.Regexp, timeout time.Duration) {
	p.poll("url "+re.String(), timeout, func() bool { return re.MatchString(p.URL()) })
}

// Sleep pauses the scenario.
func (p *Page) Sleep(d time.Duration) {
	select {
	case <-time.After(d):
	case <-p.ctx.Done():
		panic(p.ctx.Err())
	}
}

func (p *Page) poll(what string, timeout time.Duration, f func() bool) {
	end := time.Now().Add(timeout)
	for {
		if f() {
			return
		}
		if time.Now().After(end) {
			fail("timeout waiting for %s", what)
		}
		p.Sleep(30 * time.Millisecond)
	}
}

// TextContent waits for the element and returns its text.
func (p *Page) TextContent(sel string) string {
	p.WaitSelector(sel)
	var s string
	p.Eval("document.querySelector("+jsString(sel)+").textContent", &s)
	return s
}

// InputValue waits for the element and returns its value.
func (p *Page) InputValue(sel string) string {
	p.WaitSelector(sel)
	var s string
	p.Eval("document.querySelector("+jsString(sel)+").value", &s)
	return s
}

// Focus gives the element the focus.
func (p *Page) Focus(sel string) {
	p.WaitSelector(sel)
	p.Eval("(()=>{document.querySelector("+jsString(sel)+").focus();return true})()", nil)
}

// Fill focuses the field, replaces its value and fires the input event, the
// same steps a user takes to fill a field.
func (p *Page) Fill(sel, value string) {
	p.WaitSelector(sel)
	p.Eval("(()=>{const e=document.querySelector("+jsString(sel)+");e.focus();if(e.select)e.select();"+
		"e.value="+jsString(value)+";e.dispatchEvent(new Event('input',{bubbles:true}));return true})()", nil)
}

// Click scrolls the element into view and clicks its center with the mouse.
func (p *Page) Click(sel string) {
	p.must(chromedp.Do(p.ctx, chromedp.Click(chromedp.CSS(sel))))
}

// PressSequentially types text key by key into the field, pausing between keys.
func (p *Page) PressSequentially(sel, text string, delay time.Duration) {
	p.Focus(sel)
	for _, r := range text {
		p.must(chromedp.Do(p.ctx, chromedp.KeyEvent(string(r))))
		p.Sleep(delay)
	}
}

// PressEnter focuses the element and presses Enter.
func (p *Page) PressEnter(sel string) {
	p.Focus(sel)
	p.must(chromedp.Do(p.ctx, chromedp.KeyEvent(kb.Enter)))
}

func trimLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, " | ")
}
