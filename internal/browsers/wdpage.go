// SPDX-License-Identifier: MIT

package browsers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// elementKey is the key of a web element reference in a WebDriver answer.
const elementKey = "element-6066-11e4-a52e-4f735466cecf"

// IsWebDriver says whether b is driven through the WebDriver protocol (Firefox
// and Safari), so that OpenWDPage works on it.
func IsWebDriver(b Browser) bool {
	_, ok := b.(*wdBrowser)
	return ok
}

// WDPage is one window of a WebDriver browser, used by the end to end suite.
// Firefox and Safari allow a single session, so a WDPage holds the browser
// until Close: one page at a time.
type WDPage struct {
	b      *wdBrowser
	c      *wdClient
	handle string // the window of this page ("" when the browser had no spare window)
	home   string // the window to return to
}

// OpenWDPage waits for the browser to be free and opens a fresh window in it
// (own history), falling back to the session's window when the driver cannot
// open another one.
func OpenWDPage(ctx context.Context, b Browser) (*WDPage, error) {
	wb, ok := b.(*wdBrowser)
	if !ok {
		return nil, errors.New("not a WebDriver browser")
	}
	wb.mu.Lock()
	c := wb.proc.client
	p := &WDPage{b: wb, c: c}
	var home string
	if err := c.call(ctx, http.MethodGet, "/session/"+c.sid+"/window", nil, &home); err == nil {
		p.home = home
		var nw struct {
			Handle string `json:"handle"`
		}
		if err := c.call(ctx, http.MethodPost, "/session/"+c.sid+"/window/new", map[string]string{"type": "tab"}, &nw); err == nil && nw.Handle != "" {
			if err := c.call(ctx, http.MethodPost, "/session/"+c.sid+"/window", map[string]string{"handle": nw.Handle}, nil); err == nil {
				p.handle = nw.Handle
			}
		}
	}
	return p, nil
}

func (p *WDPage) path(s string) string { return "/session/" + p.c.sid + s }

// Navigate loads the address and returns after the load event.
func (p *WDPage) Navigate(ctx context.Context, url string) error {
	return p.c.call(ctx, http.MethodPost, p.path("/url"), map[string]string{"url": url}, nil)
}

// Execute runs the body of a script with the callback `done` in scope (it is
// the async form of "execute script"), and returns what it passed to done.
func (p *WDPage) Execute(ctx context.Context, body string) (json.RawMessage, error) {
	script := "const done = arguments[arguments.length - 1];\n" + body
	var out json.RawMessage
	err := p.c.call(ctx, http.MethodPost, p.path("/execute/async"), map[string]any{"script": script, "args": []any{}}, &out)
	return out, err
}

func (p *WDPage) find(ctx context.Context, css string) (string, error) {
	var el map[string]string
	if err := p.c.call(ctx, http.MethodPost, p.path("/element"), map[string]string{"using": "css selector", "value": css}, &el); err != nil {
		return "", err
	}
	return el[elementKey], nil
}

// Click clicks the element's center with the pointer, after scrolling it into view.
func (p *WDPage) Click(ctx context.Context, css string) error {
	id, err := p.find(ctx, css)
	if err != nil {
		return err
	}
	return p.c.call(ctx, http.MethodPost, p.path("/element/"+id+"/click"), nil, nil)
}

// RetryableClick says whether a failed click may work a moment later: the
// element is not there yet, is being replaced or is not shown yet.
func RetryableClick(err error) bool {
	var we *wdError
	if !errors.As(err, &we) {
		return false
	}
	switch we.Code {
	case "no such element", "stale element reference", "element not interactable", "element click intercepted":
		return true
	}
	return false
}

// Keys types the text, key by key, into the element that has the focus. A key
// is a WebDriver key code point (Enter is "").
func (p *WDPage) Keys(ctx context.Context, text string) error {
	var el map[string]string
	if err := p.c.call(ctx, http.MethodGet, p.path("/element/active"), nil, &el); err != nil {
		return err
	}
	return p.c.call(ctx, http.MethodPost, p.path("/element/"+el[elementKey]+"/value"), map[string]string{"text": text}, nil)
}

// Back goes one entry back in the history.
func (p *WDPage) Back(ctx context.Context) error {
	return p.c.call(ctx, http.MethodPost, p.path("/back"), nil, nil)
}

// Forward goes one entry forward in the history.
func (p *WDPage) Forward(ctx context.Context) error {
	return p.c.call(ctx, http.MethodPost, p.path("/forward"), nil, nil)
}

// AlertText returns the message of the open alert, confirm or prompt, and
// whether there is one.
func (p *WDPage) AlertText(ctx context.Context) (string, bool) {
	var s string
	if err := p.c.call(ctx, http.MethodGet, p.path("/alert/text"), nil, &s); err != nil {
		return "", false
	}
	return s, true
}

// AlertAnswer accepts or dismisses the open dialog.
func (p *WDPage) AlertAnswer(ctx context.Context, accept bool) error {
	end := "/alert/dismiss"
	if accept {
		end = "/alert/accept"
	}
	return p.c.call(ctx, http.MethodPost, p.path(end), nil, nil)
}

// Close dismisses a dialog left open, clears the storage the page used, closes
// its window and frees the browser for the next page.
func (p *WDPage) Close() {
	defer p.b.mu.Unlock()
	clean := context.Background()
	for i := 0; i < 3; i++ {
		if _, ok := p.AlertText(clean); !ok {
			break
		}
		_ = p.AlertAnswer(clean, false)
	}
	_ = p.c.execute(clean, "try{localStorage.clear();sessionStorage.clear()}catch(e){}")
	_ = p.c.deleteCookies(clean)
	if p.handle != "" {
		_ = p.c.call(clean, http.MethodDelete, p.path("/window"), nil, nil)
		if p.home != "" {
			_ = p.c.call(clean, http.MethodPost, p.path("/window"), map[string]string{"handle": p.home}, nil)
		}
		return
	}
	_ = p.c.navigate(clean, "about:blank")
}
