// SPDX-License-Identifier: MIT

package browsers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/inspector"
	"github.com/chromedp/cdproto/page"
	cdpruntime "github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

// FindChrome returns the Chrome or Chromium executable: the explicit path,
// then $CHROME_BIN, then the usual install locations and the PATH.
func FindChrome(explicit string, env func(string) string) (string, error) {
	if explicit != "" {
		if _, err := os.Stat(explicit); err != nil {
			return "", fmt.Errorf("chrome executable %q: %w", explicit, err)
		}
		return explicit, nil
	}
	if env != nil {
		if p := env("CHROME_BIN"); p != "" {
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
		}
	}
	var fixed, names []string
	switch runtime.GOOS {
	case "darwin":
		fixed = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
		}
		if home, err := os.UserHomeDir(); err == nil {
			fixed = append(fixed,
				filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
				filepath.Join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"))
		}
	case "windows":
		for _, base := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			if dir := os.Getenv(base); dir != "" {
				fixed = append(fixed, filepath.Join(dir, "Google", "Chrome", "Application", "chrome.exe"))
			}
		}
	}
	names = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"}
	for _, p := range fixed {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return p, nil
		}
	}
	return "", errors.New("Chrome or Chromium not found")
}

type chrome struct {
	path   string
	ctx    context.Context
	cancel context.CancelFunc
	logs   bool
}

// ChromeAllocator starts Chrome and returns a chromedp context bound to the
// browser. Its first tab is open. The caller must call cancel.
func ChromeAllocator(parent context.Context, opts Options) (ctx context.Context, cancel context.CancelFunc, path string, err error) {
	path, err = FindChrome(opts.ChromePath, opts.Env)
	if err != nil {
		return nil, nil, "", &Unavailable{
			Browser: Chrome,
			Reason:  "not installed",
			Hint:    "install Google Chrome or Chromium, or pass --chrome PATH (or set CHROME_BIN)",
		}
	}
	flags := []chromedp.ExecAllocatorOption{
		chromedp.ExecPath(path),
		chromedp.WindowSize(1280, 720),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-default-browser-check", true),
		chromedp.Flag("disable-search-engine-choice-screen", true),
		chromedp.Flag("disable-features", "Translate,MediaRouter,OptimizationHints"),
	}
	for name, value := range opts.ChromeFlags {
		flags = append(flags, chromedp.Flag(name, value))
	}
	if opts.Headed {
		flags = append(flags, chromedp.Flag("headless", false), chromedp.Flag("hide-scrollbars", false), chromedp.Flag("mute-audio", false))
	}
	if opts.env("GITHUB_ACTIONS") == "true" || (runtime.GOOS == "linux" && os.Geteuid() == 0) {
		// The runner's user namespaces are restricted; root cannot use the sandbox.
		flags = append(flags, chromedp.Flag("no-sandbox", true))
	}
	all := append(append([]chromedp.ExecAllocatorOption{}, chromedp.DefaultExecAllocatorOptions[:]...), flags...)
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(parent, all...)
	bctx, cancelCtx := chromedp.NewContext(allocCtx)
	if _, err := chromedp.Run(bctx, chromedp.Func(func(context.Context, *chromedp.Target) error { return nil })); err != nil {
		cancelCtx()
		cancelAlloc()
		return nil, nil, "", fmt.Errorf("starting Chrome (%s): %w", path, err)
	}
	return bctx, func() { cancelCtx(); cancelAlloc() }, path, nil
}

func openChrome(ctx context.Context, opts Options) (Browser, error) {
	bctx, cancel, path, err := ChromeAllocator(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &chrome{path: path, ctx: bctx, cancel: cancel, logs: opts.Logs}, nil
}

func (c *chrome) Name() string     { return Chrome }
func (c *chrome) Label() string    { return "Chrome (" + c.path + ")" }
func (c *chrome) MaxParallel() int { return 0 }
func (c *chrome) Close() error     { c.cancel(); return nil }

// NewTab opens a page in a fresh browser context (own storage, own cookies)
// with the settings every run needs: focus emulation and auto-dismissed
// dialogs. The returned stop closes the tab. crashed closes if the tab dies.
func (c *chrome) NewTab(runCtx context.Context, onLog func(string), dialog func(message string) bool) (tab context.Context, crashed <-chan struct{}, stop func(), err error) {
	tab, cancel := chromedp.NewContext(c.ctx, chromedp.WithNewBrowserContext())
	crash := make(chan struct{})
	var once sync.Once
	stopWatch := context.AfterFunc(runCtx, cancel)
	stop = func() { stopWatch(); cancel() }
	err = chromedp.Listen(tab, func(ev any) {
		switch e := ev.(type) {
		case *page.EventJavascriptDialogOpening:
			// Like the other drivers, dismiss alert, confirm and prompt.
			accept := false
			if dialog != nil {
				accept = dialog(e.Message)
			}
			go chromedp.Call(tab, page.HandleJavaScriptDialog, page.HandleJavaScriptDialogParams{Accept: accept})
		case *inspector.EventTargetCrashed:
			once.Do(func() { close(crash) })
		case *cdpruntime.EventConsoleAPICalled:
			if onLog != nil {
				onLog(consoleLine(e))
			}
		case *cdpruntime.EventExceptionThrown:
			if onLog != nil && e.ExceptionDetails != nil {
				line := "uncaught: " + e.ExceptionDetails.Text
				if ex := e.ExceptionDetails.Exception; ex != nil {
					switch {
					case ex.Description != "":
						line += " " + ex.Description
					case ex.Value != nil:
						line += " " + string(ex.Value)
					}
				}
				onLog(line)
			}
		}
	})
	if err != nil {
		stop()
		return nil, nil, nil, err
	}
	if _, err = chromedp.Call(tab, emulation.SetFocusEmulationEnabled, emulation.SetFocusEmulationEnabledParams{Enabled: true}); err != nil {
		stop()
		return nil, nil, nil, err
	}
	return tab, crash, stop, nil
}

func consoleLine(e *cdpruntime.EventConsoleAPICalled) string {
	line := string(e.Type) + ":"
	for _, a := range e.Args {
		switch {
		case a.Value != nil:
			s := string(a.Value)
			if len(s) >= 2 && s[0] == '"' {
				var v string
				if err := unmarshalString(a.Value, &v); err == nil {
					s = v
				}
			}
			line += " " + s
		case a.Description != "":
			line += " " + a.Description
		}
	}
	return line
}

func (c *chrome) RunPage(ctx context.Context, url string, done <-chan struct{}) PageReport {
	var (
		mu   sync.Mutex
		logs []string
	)
	var onLog func(string)
	if c.logs {
		onLog = func(s string) { mu.Lock(); logs = append(logs, s); mu.Unlock() }
	}
	tab, crashed, stop, err := c.NewTab(ctx, onLog, nil)
	if err != nil {
		return PageReport{Err: err}
	}
	defer stop()
	if err := chromedp.Do(tab, chromedp.Navigate(url)); err != nil {
		if ctx.Err() != nil {
			return PageReport{Err: ctx.Err()}
		}
		return PageReport{Err: err}
	}
	var rerr error
	select {
	case <-done:
	case <-crashed:
		rerr = errors.New("the page crashed")
	case <-ctx.Done():
		rerr = ctx.Err()
	}
	mu.Lock()
	defer mu.Unlock()
	return PageReport{Logs: append([]string(nil), logs...), Err: rerr}
}

// OpenTab is the end to end harness's view of Chrome: open a tab with the same
// settings as the test pages.
func OpenTab(ctx context.Context, b Browser, dialog func(message string) bool) (tab context.Context, crashed <-chan struct{}, stop func(), logs func() []string, err error) {
	c, ok := b.(*chrome)
	if !ok {
		return nil, nil, nil, nil, errors.New("not a Chrome browser")
	}
	var mu sync.Mutex
	var lines []string
	tab, crashed, stop, err = c.NewTab(ctx, func(s string) { mu.Lock(); lines = append(lines, s); mu.Unlock() }, dialog)
	logs = func() []string { mu.Lock(); defer mu.Unlock(); return append([]string(nil), lines...) }
	return
}
