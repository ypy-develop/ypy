// SPDX-License-Identifier: MIT

package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDriver answers Eval by looking at the expression, and records the calls.
type fakeDriver struct {
	mu    sync.Mutex
	calls []string
	eval  func(expr string) (string, error)
}

func (f *fakeDriver) rec(s string)                           { f.mu.Lock(); f.calls = append(f.calls, s); f.mu.Unlock() }
func (f *fakeDriver) Goto(_ context.Context, u string) error { f.rec("goto " + u); return nil }
func (f *fakeDriver) Eval(_ context.Context, expr string) (string, error) {
	f.rec("eval")
	return f.eval(expr)
}
func (f *fakeDriver) Click(_ context.Context, sel string) error { f.rec("click " + sel); return nil }
func (f *fakeDriver) Type(_ context.Context, t string) error    { f.rec("type " + t); return nil }
func (f *fakeDriver) PressEnter(context.Context) error          { f.rec("enter"); return nil }
func (f *fakeDriver) Back(context.Context) error                { f.rec("back"); return nil }
func (f *fakeDriver) Forward(context.Context) error             { f.rec("forward"); return nil }
func (f *fakeDriver) Logs() []string                            { return nil }
func (f *fakeDriver) Close()                                    {}

func newTestPage(f *fakeDriver) *Page {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = cancel
	return &Page{ctx: ctx, drv: f}
}

func TestPageDelegatesToTheDriver(t *testing.T) {
	f := &fakeDriver{eval: func(string) (string, error) { return `1`, nil }}
	p := newTestPage(f)
	p.Goto("http://h/")
	p.Click("#a")
	p.Back()
	p.Forward()
	p.PressSequentially("#i", "ab", 0)
	p.PressEnter("#i")
	got := strings.Join(f.calls, ",")
	for _, want := range []string{"goto http://h/", "click #a", "back", "forward", "type a", "type b", "enter"} {
		if !strings.Contains(got, want) {
			t.Errorf("driver calls lack %q: %s", want, got)
		}
	}
}

func TestPageEvalWrapsAndDecodesJSON(t *testing.T) {
	var seen string
	f := &fakeDriver{eval: func(expr string) (string, error) { seen = expr; return `{"n":3}`, nil }}
	p := newTestPage(f)
	var out struct{ N int }
	p.Eval("1+2", &out)
	if out.N != 3 || !strings.Contains(seen, "(1+2)") || !strings.Contains(seen, "JSON.stringify") {
		t.Errorf("out %+v, expression %q", out, seen)
	}
}

func TestPagePollRetriesAFailedStep(t *testing.T) {
	n := 0
	f := &fakeDriver{eval: func(string) (string, error) {
		n++
		if n < 3 {
			return "", errors.New("the page is navigating")
		}
		return "true", nil
	}}
	p := newTestPage(f)
	p.poll("x", 2*time.Second, func() bool { return p.evalBool("1") }) // fails the scenario on the first error without the retry
	if n < 3 {
		t.Errorf("evaluated %d times", n)
	}
}

func TestPagePollFailureNamesTheLastError(t *testing.T) {
	f := &fakeDriver{eval: func(string) (string, error) { return "", errors.New("boom") }}
	p := newTestPage(f)
	defer func() {
		fl, ok := recover().(failure)
		if !ok || !strings.Contains(fl.msg, "timeout waiting for") || !strings.Contains(fl.msg, "boom") {
			t.Errorf("recovered %v", fl)
		}
	}()
	p.poll("thing", 80*time.Millisecond, func() bool { return p.evalBool("1") })
}

func TestPageDialogHandler(t *testing.T) {
	p := &Page{}
	if !p.dialog("m") {
		t.Error("the default accepts a dialog")
	}
	var got string
	p.OnDialog(func(m string) bool { got = m; return false })
	if p.dialog("Delete Cherry?") || got != "Delete Cherry?" {
		t.Errorf("handler not used: %q", got)
	}
}
