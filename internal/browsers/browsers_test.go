// SPDX-License-Identifier: MIT

package browsers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseList(t *testing.T) {
	got, err := ParseList("Chrome, safari,chromium,webkit")
	if err != nil || strings.Join(got, ",") != "chrome,safari" {
		t.Errorf("ParseList = %v, %v", got, err)
	}
	if _, err := ParseList("opera"); err == nil {
		t.Error("an unknown browser must be an error")
	}
	if _, err := ParseList(" , "); err == nil {
		t.Error("an empty list must be an error")
	}
}

func TestSafariUnavailableGivesTheExactStep(t *testing.T) {
	cases := []struct{ msg, reason, hint string }{
		{"session not created: Could not create a session: You must enable the 'Allow remote automation' option in Safari's Develop menu to control Safari via WebDriver.", "remote automation is off", "Allow Remote Automation"},
		{"session not created: safaridriver is not enabled. Run safaridriver --enable", "not enabled", "safaridriver --enable"},
		{"session not created: another session is active", "could not start", "another session is active"},
	}
	for _, c := range cases {
		u := safariUnavailable(errors.New(c.msg))
		if !strings.Contains(u.Reason, c.reason) || !strings.Contains(u.Hint, c.hint) {
			t.Errorf("%q -> reason %q hint %q", c.msg, u.Reason, u.Hint)
		}
		if strings.Contains(u.Hint, "sudo") {
			t.Errorf("the hint must never suggest sudo: %q", u.Hint)
		}
	}
}

func TestWebDriverClient(t *testing.T) {
	var navigated string
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"value":{"ready":true}}`)) })
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"value":{"sessionId":"abc","capabilities":{}}}`))
	})
	mux.HandleFunc("/session/abc/url", func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 200)
		n, _ := r.Body.Read(buf)
		navigated = string(buf[:n])
		w.Write([]byte(`{"value":null}`))
	})
	mux.HandleFunc("/session/bad/url", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte(`{"value":{"error":"no such window","message":"gone"}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := &wdClient{base: srv.URL, http: srv.Client()}
	ctx := context.Background()
	if err := c.waitReady(ctx, 1e9); err != nil {
		t.Fatal(err)
	}
	if err := c.newSession(ctx, map[string]any{"browserName": "safari"}); err != nil || c.sid != "abc" {
		t.Fatalf("newSession: sid=%q err=%v", c.sid, err)
	}
	if err := c.navigate(ctx, "http://localhost:1/"); err != nil || !strings.Contains(navigated, "http://localhost:1/") {
		t.Errorf("navigate: %v (%q)", err, navigated)
	}
	c.sid = "bad"
	var we *wdError
	if err := c.navigate(ctx, "x"); !errors.As(err, &we) || we.Code != "no such window" || we.Message != "gone" {
		t.Errorf("error mapping: %v", err)
	}
}

func TestMissingChromeIsUnavailable(t *testing.T) {
	_, _, _, err := ChromeAllocator(context.Background(), Options{ChromePath: "/definitely/not/chrome"})
	var u *Unavailable
	if !errors.As(err, &u) || u.Browser != Chrome || !strings.Contains(u.Hint, "--chrome") {
		t.Errorf("err = %v", err)
	}
}
