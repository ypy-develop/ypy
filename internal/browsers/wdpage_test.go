// SPDX-License-Identifier: MIT

package browsers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeDriver is a WebDriver server that records the calls it gets.
type fakeDriver struct {
	mu    sync.Mutex
	calls []string
	alert string // the open dialog, "" when none
}

func (f *fakeDriver) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/session/s1")
	f.calls = append(f.calls, r.Method+" "+path+" "+string(body))
	write := func(code int, v any) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]any{"value": v})
	}
	switch {
	case path == "/window" && r.Method == http.MethodGet:
		write(200, "home")
	case path == "/window/new":
		write(200, map[string]string{"handle": "tab2", "type": "tab"})
	case path == "/execute/async":
		write(200, []any{"ok", "x"})
	case path == "/element":
		write(200, map[string]string{elementKey: "e1"})
	case path == "/element/active":
		write(200, map[string]string{elementKey: "e2"})
	case path == "/alert/text":
		if f.alert == "" {
			write(404, map[string]string{"error": "no such alert", "message": "none"})
			return
		}
		write(200, f.alert)
	case path == "/alert/dismiss" || path == "/alert/accept":
		f.alert = ""
		write(200, nil)
	default:
		write(200, nil)
	}
}

func (f *fakeDriver) seen(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if strings.Contains(c, sub) {
			return true
		}
	}
	return false
}

func fakeBrowser(t *testing.T) (*wdBrowser, *fakeDriver) {
	t.Helper()
	f := &fakeDriver{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	c := newWDClient(port)
	c.sid = "s1"
	return &wdBrowser{name: Firefox, proc: &driverProc{client: c}}, f
}

func TestWDPageOpensItsOwnWindowAndCleansUp(t *testing.T) {
	b, f := fakeBrowser(t)
	if !IsWebDriver(b) {
		t.Fatal("IsWebDriver is false for a WebDriver browser")
	}
	ctx := context.Background()
	p, err := OpenWDPage(ctx, b)
	if err != nil {
		t.Fatal(err)
	}
	if p.handle != "tab2" || p.home != "home" {
		t.Fatalf("handle %q home %q", p.handle, p.home)
	}
	if err := p.Navigate(ctx, "http://x/"); err != nil {
		t.Fatal(err)
	}
	if got, err := p.Execute(ctx, "done(1)"); err != nil || string(got) != `["ok","x"]` {
		t.Fatalf("execute %s %v", got, err)
	}
	if err := p.Click(ctx, "#a"); err != nil || !f.seen("POST /element/e1/click") {
		t.Fatalf("click %v", err)
	}
	if err := p.Keys(ctx, "ab"); err != nil || !f.seen(`POST /element/e2/value {"text":"ab"}`) {
		t.Fatalf("keys %v", err)
	}
	if p.Back(ctx) != nil || p.Forward(ctx) != nil || !f.seen("POST /back") || !f.seen("POST /forward") {
		t.Fatal("history calls missing")
	}
	f.alert = "Sure?"
	if msg, ok := p.AlertText(ctx); !ok || msg != "Sure?" {
		t.Fatalf("alert %q %v", msg, ok)
	}
	if err := p.AlertAnswer(ctx, true); err != nil || !f.seen("/alert/accept") {
		t.Fatalf("answer %v", err)
	}
	if _, ok := p.AlertText(ctx); ok {
		t.Fatal("the dialog is still open")
	}
	f.alert = "left open"
	p.Close()
	for _, want := range []string{"/alert/dismiss", "DELETE /window", "POST /window {\"handle\":\"home\"}"} {
		if !f.seen(want) {
			t.Errorf("Close did not call %q", want)
		}
	}
	// the browser is free again for the next page
	if !b.mu.TryLock() {
		t.Fatal("the browser is still held after Close")
	}
	b.mu.Unlock()
}

func TestWDPageHoldsTheBrowserOnePageAtATime(t *testing.T) {
	b, _ := fakeBrowser(t)
	p, err := OpenWDPage(context.Background(), b)
	if err != nil {
		t.Fatal(err)
	}
	if b.mu.TryLock() {
		t.Fatal("a second page could open while the first one is open")
	}
	p.Close()
}

func TestOpenWDPageRejectsChrome(t *testing.T) {
	if _, err := OpenWDPage(context.Background(), &chrome{}); err == nil {
		t.Fatal("a Chrome browser is not a WebDriver browser")
	}
}

func TestRetryableClick(t *testing.T) {
	for code, want := range map[string]bool{
		"no such element": true, "stale element reference": true, "element not interactable": true,
		"element click intercepted": true, "invalid selector": false, "unknown error": false,
	} {
		if got := RetryableClick(&wdError{Code: code}); got != want {
			t.Errorf("%s: %v, want %v", code, got, want)
		}
	}
	if RetryableClick(context.Canceled) {
		t.Error("a canceled context is not retryable")
	}
}

func TestPromptBehavior(t *testing.T) {
	if promptBehavior(Options{}) != "dismiss" || promptBehavior(Options{KeepDialogs: true}) != "ignore" {
		t.Error("promptBehavior")
	}
}
