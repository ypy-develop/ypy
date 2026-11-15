// SPDX-License-Identifier: MIT

package bench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/chromedp/cdproto/browser"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/heapprofiler"
	"github.com/chromedp/cdproto/memory"
	cdppage "github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"

	"github.com/ypy-develop/ypy/internal/browsers"
)

// chromeFlags are the switches the measurements need: the page can force a
// garbage collection, the heap counters are precise, and a tab that is not in
// front is not slowed down.
var chromeFlags = map[string]any{
	"js-flags":                               "--expose-gc",
	"enable-precise-memory-info":             true,
	"disable-background-timer-throttling":    true,
	"disable-renderer-backgrounding":         true,
	"disable-backgrounding-occluded-windows": true,
}

// evalLimit ends a scenario that never returns.
const evalLimit = 10 * time.Minute

// memBinding is the name of the function the page calls to ask Go for a
// memory reading; memShim wraps it in window.__benchMem(), which the scenarios
// await.
const memBinding = "__benchMemCall"

const memShim = `(() => {
  const pending = new Map()
  let seq = 0
  window.__benchMem = (uam = false) => new Promise(resolve => {
    const id = ++seq
    pending.set(id, resolve)
    window.` + memBinding + `(JSON.stringify({ id, uam: !!uam }))
  })
  window.__benchMemDone = (id, value) => { pending.get(id)?.(value); pending.delete(id) }
})()`

// uamExpr reads performance.measureUserAgentSpecificMemory(), which is slow
// (about 18 s) and only exists in a cross-origin isolated page.
const uamExpr = `(async () => {
  if (!crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return null
  const result = await Promise.race([
    performance.measureUserAgentSpecificMemory(),
    new Promise(resolve => setTimeout(resolve, 8000))
  ])
  return result?.bytes ?? null
})()`

// session is the server and the browser of one run.
type session struct {
	srv *server
	br  browsers.Browser
}

// openSession starts the server for build and a Chrome with the benchmark
// switches. An *browsers.Unavailable error says Chrome is missing.
func openSession(ctx context.Context, pages, build string, port int, chromePath string, env func(string) string) (*session, error) {
	srv, err := startServer(build, pages, port)
	if err != nil {
		return nil, err
	}
	br, err := browsers.Open(ctx, browsers.Chrome, browsers.Options{ChromePath: chromePath, ChromeFlags: chromeFlags, Env: env})
	if err != nil {
		srv.close()
		return nil, err
	}
	return &session{srv: srv, br: br}, nil
}

func (s *session) close() {
	s.br.Close()
	s.srv.close()
}

// tab is a fresh tab (own browser context) with the benchmark page loaded.
type tab struct {
	ctx     context.Context
	crashed <-chan struct{}
	stop    func()
	logs    func() []string
}

// newPage opens a tab, installs window.__benchMem and loads the page. The
// returned page has window.__bench and window.ypy ready.
func (s *session) newPage(ctx context.Context) (*tab, error) {
	tctx, crashed, stop, logs, err := browsers.OpenTab(ctx, s.br, nil)
	if err != nil {
		return nil, err
	}
	p := &tab{ctx: tctx, crashed: crashed, stop: stop, logs: logs}
	if err := p.setup(s.srv.url + "/"); err != nil {
		stop()
		return nil, err
	}
	return p, nil
}

func (p *tab) setup(url string) error {
	err := chromedp.Listen(p.ctx, func(ev any) {
		if e, ok := ev.(*runtime.EventBindingCalled); ok && e.Name == memBinding {
			// a CDP call from inside the event loop would wait for the loop
			go p.memory(e.Payload)
		}
	})
	if err != nil {
		return err
	}
	steps := []func() error{
		func() error {
			_, err := chromedp.Call(p.ctx, emulation.SetDeviceMetricsOverride,
				emulation.SetDeviceMetricsOverrideParams{Width: 1280, Height: 800, DeviceScaleFactor: 1})
			return err
		},
		func() error { _, err := chromedp.Call(p.ctx, heapprofiler.Enable, cdp.Empty{}); return err },
		func() error {
			_, err := chromedp.Call(p.ctx, runtime.AddBinding, runtime.AddBindingParams{Name: memBinding})
			return err
		},
		func() error {
			_, err := chromedp.Call(p.ctx, cdppage.AddScriptToEvaluateOnNewDocument,
				cdppage.AddScriptToEvaluateOnNewDocumentParams{Source: memShim})
			return err
		},
		func() error { return chromedp.Do(p.ctx, chromedp.Navigate(url)) },
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return err
		}
	}
	return p.waitReady(15 * time.Second)
}

func (p *tab) waitReady(limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for {
		var ready bool
		if err := p.eval(`Boolean(window.__bench?.ready && window.ypy)`, &ready); err == nil && ready {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("the benchmark page did not become ready (no window.__bench or window.ypy): is the build a YPY core?")
		}
		select {
		case <-time.After(20 * time.Millisecond):
		case <-p.ctx.Done():
			return p.ctx.Err()
		case <-p.crashed:
			return errors.New("the page crashed")
		}
	}
}

// memory answers window.__benchMem(): it forces garbage collection through the
// DevTools protocol, then reads the JS heap in use, the DOM node and listener
// counters and, when asked, the user agent specific memory estimate.
func (p *tab) memory(payload string) {
	var req struct {
		ID  int  `json:"id"`
		UAM bool `json:"uam"`
	}
	if json.Unmarshal([]byte(payload), &req) != nil {
		return
	}
	for range 3 {
		if _, err := chromedp.Call(p.ctx, heapprofiler.CollectGarbage, cdp.Empty{}); err != nil {
			return
		}
	}
	heap, err := chromedp.Call(p.ctx, runtime.GetHeapUsage, cdp.Empty{})
	if err != nil {
		return
	}
	counters, err := chromedp.Call(p.ctx, memory.GetDOMCounters, cdp.Empty{})
	if err != nil {
		return
	}
	var uam *float64
	if req.UAM {
		v, err := chromedp.Run(p.ctx, chromedp.Evaluate[*float64](uamExpr, chromedp.EvalAwaitPromise))
		if err == nil {
			uam = v
		}
	}
	reading, _ := marshal(struct {
		HeapUsed  float64  `json:"heapUsed"`
		Nodes     int64    `json:"nodes"`
		Listeners int64    `json:"listeners"`
		Documents int64    `json:"documents"`
		UAM       *float64 `json:"uam"`
	}{heap.UsedSize, counters.Nodes, counters.JsEventListeners, counters.Documents, uam})
	chromedp.Run(p.ctx, chromedp.Evaluate[chromedp.Void](fmt.Sprintf("window.__benchMemDone(%d, %s)", req.ID, reading)))
}

// eval evaluates a JavaScript expression in the page, waits for a promise and
// decodes the JSON value into out (nil ignores it). A crashed page ends the
// call with an error.
func (p *tab) eval(expr string, out any) error {
	ctx, cancel := context.WithTimeout(p.ctx, evalLimit)
	defer cancel()
	go func() {
		select {
		case <-p.crashed:
			cancel()
		case <-ctx.Done():
		}
	}()
	raw, err := chromedp.Run(ctx, chromedp.Evaluate[[]byte](expr, chromedp.EvalAwaitPromise))
	if err != nil {
		select {
		case <-p.crashed:
			return errors.New("the page crashed")
		default:
		}
		return err
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// pageErrors returns the uncaught exceptions the page logged.
func (p *tab) pageErrors() []string {
	var out []string
	for _, line := range p.logs() {
		if rest, ok := strings.CutPrefix(line, "uncaught: "); ok {
			out = append(out, rest)
		}
	}
	return out
}

// chromeVersion is the version of the browser, like "157.0.8103.51".
func (p *tab) chromeVersion() string {
	v, err := chromedp.CallBrowser(p.ctx, browser.GetVersion, cdp.Empty{})
	if err != nil {
		return ""
	}
	product := v.Product
	if i := strings.LastIndex(product, "/"); i >= 0 {
		product = product[i+1:]
	}
	return product
}
