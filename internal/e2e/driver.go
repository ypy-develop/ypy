// SPDX-License-Identifier: MIT

package e2e

import (
	"context"
	"fmt"

	"github.com/ypy-develop/ypy/internal/browsers"
)

// Driver is what the scenarios need from a browser, nothing more: open a page,
// run script in it, click, type, move through the history and read the
// console. Page builds the scenario helpers (Fill, Count, Texts, WaitSelector
// ...) on top of it, so a scenario never knows which browser runs it.
//
// There are two implementations: cdpDriver (Chrome, DevTools protocol) and
// wdDriver (Firefox and Safari, WebDriver). Every method gets the context of
// the scenario, and an error is a failure of the step.
type Driver interface {
	// Goto loads the address and returns after the load event.
	Goto(ctx context.Context, url string) error
	// Eval runs the async function expression `(async()=>{...})()` built by
	// Page.Eval, awaits it and returns the JSON text it produced.
	Eval(ctx context.Context, expr string) (string, error)
	// Click scrolls the element into view and clicks its center with the
	// pointer; it waits for the element to be there.
	Click(ctx context.Context, selector string) error
	// Type sends the text, key by key, to the element that has the focus.
	Type(ctx context.Context, text string) error
	// PressEnter presses Enter in the element that has the focus.
	PressEnter(ctx context.Context) error
	// Back and Forward move through the history of the page.
	Back(ctx context.Context) error
	Forward(ctx context.Context) error
	// Logs are the console lines the page wrote: "error: ...", "warning: ...",
	// "uncaught: ...". Chrome reports all of them; WebDriver browsers report
	// what happened after the first command that ran in the document.
	Logs() []string
	// Close ends the page and frees the browser.
	Close()
}

// driverSession is a Driver opened for one scenario.
type driverSession struct {
	Driver
	// Base is the context the scenario's context derives from (for Chrome, the
	// tab's, because DevTools commands need it).
	Base context.Context
	// Crashed closes when the page dies; nil when the browser cannot tell.
	Crashed <-chan struct{}
}

// openDriver opens a page of the browser. dialog decides what an alert, a
// confirm or a prompt gets: true accepts it.
func openDriver(ctx context.Context, b browsers.Browser, dialog func(message string) bool) (*driverSession, error) {
	switch {
	case b.Name() == browsers.Chrome:
		return openCDP(ctx, b, dialog)
	case browsers.IsWebDriver(b):
		return openWD(ctx, b, dialog)
	}
	return nil, fmt.Errorf("no end to end driver for %s", b.Name())
}
