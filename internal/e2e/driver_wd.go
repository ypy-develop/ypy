// SPDX-License-Identifier: MIT

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
)

// wdDriver drives a window of Firefox (geckodriver) or Safari (safaridriver)
// through the WebDriver protocol.
type wdDriver struct {
	page *browsers.WDPage
	stop context.CancelFunc
	wg   sync.WaitGroup
}

// hookScript installs, once per document, the capture of console errors and
// warnings and of uncaught errors. WebDriver has no console feed, so it sees
// what happens after the first command that ran in the document.
const hookScript = `if(!window.__ypyLog){window.__ypyLog=[];` +
	`for(const k of['error','warn']){const o=console[k];console[k]=function(){try{` +
	`__ypyLog.push((k==='warn'?'warning':k)+': '+[].map.call(arguments,String).join(' '))}catch(e){}` +
	`return o.apply(console,arguments)}}` +
	`addEventListener('error',e=>{__ypyLog.push('uncaught: '+e.message)});` +
	`addEventListener('unhandledrejection',e=>{__ypyLog.push('uncaught: '+e.reason)})}`

func openWD(ctx context.Context, b browsers.Browser, dialog func(string) bool) (*driverSession, error) {
	page, err := browsers.OpenWDPage(ctx, b)
	if err != nil {
		return nil, err
	}
	wctx, cancel := context.WithCancel(context.Background())
	d := &wdDriver{page: page, stop: cancel}
	// A dialog blocks the page, and WebDriver has no event for it: poll for one
	// and answer it the way the scenario chose.
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		for {
			select {
			case <-wctx.Done():
				return
			case <-time.After(40 * time.Millisecond):
			}
			qctx, qcancel := context.WithTimeout(wctx, 2*time.Second)
			if msg, ok := page.AlertText(qctx); ok {
				accept := false
				if dialog != nil {
					accept = dialog(msg)
				}
				_ = page.AlertAnswer(qctx, accept)
			}
			qcancel()
		}
	}()
	return &driverSession{Driver: d, Base: ctx}, nil
}

func (d *wdDriver) Goto(ctx context.Context, url string) error {
	return d.page.Navigate(ctx, url)
}

func (d *wdDriver) Eval(ctx context.Context, expr string) (string, error) {
	body := hookScript + ";Promise.resolve(" + expr + ").then(r=>done(['ok',r]),e=>done(['err',String(e&&e.stack||e)]))"
	raw, err := d.page.Execute(ctx, body)
	if err != nil {
		return "", err
	}
	var pair [2]json.RawMessage
	if err := json.Unmarshal(raw, &pair); err != nil {
		return "", fmt.Errorf("evaluate: unexpected answer %s", raw)
	}
	var kind string
	_ = json.Unmarshal(pair[0], &kind)
	var s string
	_ = json.Unmarshal(pair[1], &s)
	if kind != "ok" {
		return "", fmt.Errorf("evaluate: %s", s)
	}
	return s, nil
}

// clickCount reads a counter of the clicks the document received, and a token
// that names the document (a new document has a new token).
const clickCount = `if(!window.__ypyTok){window.__ypyTok=String(Math.random());window.__ypyClicks=0;` +
	`document.addEventListener('click',()=>{window.__ypyClicks++},true)}` +
	`done([window.__ypyTok,window.__ypyClicks])`

func (d *wdDriver) clicks(ctx context.Context) (tok string, n int, err error) {
	raw, err := d.page.Execute(ctx, clickCount)
	if err != nil {
		return "", 0, err
	}
	var v []any
	if err := json.Unmarshal(raw, &v); err != nil || len(v) != 2 {
		return "", 0, fmt.Errorf("unexpected answer %s", raw)
	}
	tok, _ = v[0].(string)
	f, _ := v[1].(float64)
	return tok, int(f), nil
}

func (d *wdDriver) scriptClick(ctx context.Context, sel string) error {
	raw, err := d.page.Execute(ctx, "const e=document.querySelector("+jsString(sel)+");if(e)e.click();done(!!e)")
	if err != nil {
		return err
	}
	if string(raw) != "true" {
		return fmt.Errorf("no element matches %s", sel)
	}
	return nil
}

// Click waits for the element to be there and to be clickable (the page
// swaps its content under the scenario), for up to ten seconds. Safari now and
// then drops a click that arrives while the page is busy, so the driver counts
// the clicks the document receives, clicks again when none arrived and, when
// the pointer click is lost twice, clicks through the page.
func (d *wdDriver) Click(ctx context.Context, sel string) error {
	end := time.Now().Add(10 * time.Second)
	lost := 0
	for {
		tok, n, cerr := d.clicks(ctx)
		err := d.page.Click(ctx, sel)
		if err == nil {
			if cerr != nil {
				return nil // cannot tell: the page was changing, take the click as made
			}
			tok2, n2, err2 := d.clicks(ctx)
			if err2 != nil || tok2 != tok || n2 > n {
				return nil
			}
			lost++ // the click never reached the document
			if lost >= 2 {
				// The pointer click keeps getting lost: click through the page
				// instead. It fires the same click event.
				return d.scriptClick(ctx, sel)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		if !browsers.RetryableClick(err) || time.Now().After(end) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func (d *wdDriver) Type(ctx context.Context, text string) error { return d.page.Keys(ctx, text) }
func (d *wdDriver) PressEnter(ctx context.Context) error        { return d.page.Keys(ctx, "") }
func (d *wdDriver) Back(ctx context.Context) error              { return d.page.Back(ctx) }
func (d *wdDriver) Forward(ctx context.Context) error           { return d.page.Forward(ctx) }

func (d *wdDriver) Logs() []string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	raw, err := d.page.Execute(ctx, "done(JSON.stringify(window.__ypyLog||[]))")
	if err != nil {
		return nil
	}
	var s string
	var lines []string
	if json.Unmarshal(raw, &s) != nil || json.Unmarshal([]byte(s), &lines) != nil {
		return nil
	}
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}
	return lines
}

func (d *wdDriver) Close() {
	d.stop()
	d.wg.Wait()
	d.page.Close()
}
