// SPDX-License-Identifier: MIT

package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// AppOrder lists the example apps (mirrors examples/server/render.go): the
// native app is the only one.
var AppOrder = []string{"native"}

// Stats are the counters of the example server.
type Stats struct {
	Search         int `json:"search"`
	SSEConnections int `json:"sseConnections"`
	SSEOpen        int `json:"sseOpen"`
	WSConnections  int `json:"wsConnections"`
	WSOpen         int `json:"wsOpen"`
	WSMessages     int `json:"wsMessages"`
	Signups        int `json:"signups"`
}

// Env is what a scenario gets: the page, the app and a few helpers.
type Env struct {
	Page *Page
	Base string
	App  string
}

// API is the address of an endpoint of the app's API.
func (e *Env) API(path string) string { return fmt.Sprintf("%s/%s/api%s", e.Base, e.App, path) }

// Reset restores the server's state for the app.
func (e *Env) Reset() {
	resp, err := http.Post(e.API("/_reset"), "application/json", bytes.NewReader(nil))
	if err != nil {
		fail("reset: %v", err)
	}
	resp.Body.Close()
}

// Stats reads the server's counters for the app.
func (e *Env) Stats() Stats {
	resp, err := http.Get(e.API("/_stats"))
	if err != nil {
		fail("stats: %v", err)
	}
	defer resp.Body.Close()
	var s Stats
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		fail("stats: %v", err)
	}
	return s
}

// Get returns the body of a GET request made outside the page.
func (e *Env) Get(url string) string {
	resp, err := http.Get(url)
	if err != nil {
		fail("get %s: %v", url, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

// Open loads the app's page and waits until it is ready.
func (e *Env) Open() {
	e.Page.Goto(fmt.Sprintf("%s/%s/", e.Base, e.App))
	e.Page.WaitFunction("document.getElementById('lib-version')?.textContent")
}

// Until polls until f is true or five seconds pass.
func (e *Env) Until(message string, f func() bool) { e.UntilFor(message, 5*time.Second, f) }

// UntilFor polls until f is true or the timeout passes. A step of f that
// fails is retried; its last failure goes into the message.
func (e *Env) UntilFor(message string, timeout time.Duration, f func() bool) {
	end := time.Now().Add(timeout)
	var last string
	for {
		ok := func() (ok bool) {
			defer func() {
				if r := recover(); r != nil {
					if fl, is := r.(failure); is {
						last = fl.msg
						return
					}
					panic(r)
				}
			}()
			return f()
		}()
		if ok {
			return
		}
		if time.Now().After(end) {
			if last != "" {
				fail("timeout waiting for: %s (%s)", message, last)
			}
			fail("timeout waiting for: %s", message)
		}
		e.Page.Sleep(50 * time.Millisecond)
	}
}

// Assert fails the scenario when cond is false.
func (e *Env) Assert(cond bool, message string) {
	if !cond {
		fail("assertion failed: %s", message)
	}
}

// Equal compares two values by their JSON form.
func (e *Env) Equal(actual, expected any, message string) {
	a, _ := json.Marshal(actual)
	x, _ := json.Marshal(expected)
	if !bytes.Equal(a, x) {
		fail("%s: expected %s, got %s", message, x, a)
	}
}

// Rows is the list of item names in the CRUD table.
func (e *Env) rowNames() []string { return e.Page.Texts("#items tr .name") }
