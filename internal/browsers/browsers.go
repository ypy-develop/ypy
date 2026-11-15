// SPDX-License-Identifier: MIT

// Package browsers finds and drives the browsers that run the YPY test suites:
// Chrome or Chromium through the DevTools protocol (chromedp), Safari through
// safaridriver and Firefox through geckodriver (the WebDriver HTTP protocol).
//
// A browser that is not available is not an error of the run: Open returns an
// *Unavailable value that carries the instruction to make it available, and the
// caller reports it as skipped.
package browsers

import (
	"context"
	"fmt"
	"strings"
)

// Names of the supported browsers, as they are spelled on the command line.
const (
	Chrome  = "chrome"
	Safari  = "safari"
	Firefox = "firefox"
)

// All lists the supported browsers in report order.
var All = []string{Chrome, Safari, Firefox}

// Options configure how a browser is found and started.
type Options struct {
	// ChromePath is the Chrome or Chromium executable; empty means discover it.
	ChromePath string
	// Headed shows the browser window (Chrome only; Safari always shows one).
	Headed bool
	// Logs collects the console output of every page (Chrome only).
	Logs bool
	// ChromeFlags adds command line switches to Chrome (Chrome only): the key is
	// the switch without the leading dashes, the value a string or a bool.
	ChromeFlags map[string]any
	// KeepDialogs leaves an alert, confirm or prompt open for the caller to
	// answer (WebDriver browsers; the default dismisses it at once). The end to
	// end suite sets it so that a scenario can choose the answer.
	KeepDialogs bool
	// Env reads an environment variable; nil means "no variables".
	Env func(string) string
}

func (o Options) env(key string) string {
	if o.Env == nil {
		return ""
	}
	return o.Env(key)
}

// PageReport is what a browser tells about a page it ran.
type PageReport struct {
	// Logs are console lines (only when Options.Logs is set).
	Logs []string
	// Err is set when the page could not be opened, crashed or the run was
	// canceled before the page finished.
	Err error
}

// Browser runs one page at a time per call; RunPage may be called from several
// goroutines up to MaxParallel.
type Browser interface {
	// Name is the command line name: chrome, safari or firefox.
	Name() string
	// Label is a human name with the version when known.
	Label() string
	// MaxParallel is how many pages may run at once (0 means no limit).
	MaxParallel() int
	// RunPage opens url in a fresh page and returns when done is closed, ctx
	// ends or the page dies. The page is closed before it returns.
	RunPage(ctx context.Context, url string, done <-chan struct{}) PageReport
	// Close stops the browser and its driver.
	Close() error
}

// Unavailable says a browser cannot be used here and how to fix it.
type Unavailable struct {
	Browser string
	// Reason is one line: what is missing.
	Reason string
	// Hint is the exact instruction for the person at the keyboard.
	Hint string
}

func (u *Unavailable) Error() string {
	if u.Hint == "" {
		return fmt.Sprintf("%s: skipped (%s)", u.Browser, u.Reason)
	}
	return fmt.Sprintf("%s: skipped (%s): %s", u.Browser, u.Reason, u.Hint)
}

// ParseList splits a comma separated list of browser names and validates it.
func ParseList(s string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, name := range strings.Split(s, ",") {
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		switch name {
		case "chromium":
			name = Chrome
		case "webkit":
			name = Safari
		}
		known := false
		for _, k := range All {
			if k == name {
				known = true
			}
		}
		if !known {
			return nil, fmt.Errorf("unknown browser %q (use %s)", name, strings.Join(All, ", "))
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no browser given (use %s)", strings.Join(All, ", "))
	}
	return out, nil
}

// Open starts the named browser. When the browser is not available it returns
// an *Unavailable error.
func Open(ctx context.Context, name string, opts Options) (Browser, error) {
	switch name {
	case Chrome:
		return openChrome(ctx, opts)
	case Safari:
		return openSafari(ctx, opts)
	case Firefox:
		return openFirefox(ctx, opts)
	}
	return nil, fmt.Errorf("unknown browser %q", name)
}
