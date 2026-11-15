// SPDX-License-Identifier: MIT

package e2e

import (
	"context"

	"github.com/chromedp/chromedp"
	"github.com/chromedp/chromedp/kb"
	"github.com/ypy-develop/ypy/internal/browsers"
)

// cdpDriver drives a Chrome tab through the DevTools protocol (chromedp).
type cdpDriver struct {
	stop func()
	logs func() []string
}

func openCDP(ctx context.Context, b browsers.Browser, dialog func(string) bool) (*driverSession, error) {
	tab, crashed, stop, logs, err := browsers.OpenTab(ctx, b, dialog)
	if err != nil {
		return nil, err
	}
	return &driverSession{Driver: &cdpDriver{stop: stop, logs: logs}, Base: tab, Crashed: crashed}, nil
}

func (d *cdpDriver) Goto(ctx context.Context, url string) error {
	return chromedp.Do(ctx, chromedp.Navigate(url))
}

func (d *cdpDriver) Eval(ctx context.Context, expr string) (string, error) {
	return chromedp.Run(ctx, chromedp.Evaluate[string](expr, chromedp.EvalAwaitPromise))
}

func (d *cdpDriver) Click(ctx context.Context, sel string) error {
	return chromedp.Do(ctx, chromedp.Click(chromedp.CSS(sel)))
}

func (d *cdpDriver) Type(ctx context.Context, text string) error {
	return chromedp.Do(ctx, chromedp.KeyEvent(text))
}

func (d *cdpDriver) PressEnter(ctx context.Context) error {
	return chromedp.Do(ctx, chromedp.KeyEvent(kb.Enter))
}

func (d *cdpDriver) Back(ctx context.Context) error { return chromedp.Do(ctx, chromedp.NavigateBack()) }
func (d *cdpDriver) Forward(ctx context.Context) error {
	return chromedp.Do(ctx, chromedp.NavigateForward())
}
func (d *cdpDriver) Logs() []string { return d.logs() }
func (d *cdpDriver) Close()         { d.stop() }
