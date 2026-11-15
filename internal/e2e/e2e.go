// SPDX-License-Identifier: MIT

// Package e2e runs the end to end scenarios of the example app
// (examples/native), driven in Chrome, Firefox and Safari against the Go
// example server (examples/server). It is what "ypy test --suite e2e" runs.
// Chrome is driven through the DevTools protocol, Firefox and Safari through
// WebDriver; see Driver.
package e2e

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
)

// Options of an end to end run.
type Options struct {
	Root            string
	Apps            string // comma list; empty means every app
	Scenario        string // only scenarios whose name contains this text
	Port            int    // first port to try (default 8205); the next free one is used
	MD              string // also write the matrix as markdown to this file
	Strict          bool   // exit 1 when any scenario fails
	Browsers        []string
	ChromePath      string
	Headed          bool
	Logs            bool
	ScenarioTimeout time.Duration
	Out, Err        io.Writer
	Env             func(string) string
}

// Result is the outcome of one scenario.
type Result struct {
	Scenario string
	Pass     bool // false for a scenario that failed; a skipped one is Pass and Skipped
	Skipped  bool
	// SkipReason is why the scenario was left out in this browser (see Scenario.Skip).
	SkipReason string
	Error      string
	Duration   time.Duration
	Console    []string
}

// Outcome is every result of one app in one browser.
type Outcome struct {
	App     string
	Browser string
	Version string
	Results []Result
}

// Run starts the example server, runs the scenarios and prints the matrix.
// It returns 0, or 1 when --strict is set and a scenario failed or nothing ran.
func Run(ctx context.Context, o Options) int {
	if o.ScenarioTimeout == 0 {
		o.ScenarioTimeout = 12 * time.Second
	}
	if o.Port == 0 {
		o.Port = 8205
	}
	apps := AppOrder
	if o.Apps != "" {
		apps = nil
		for _, a := range strings.Split(o.Apps, ",") {
			a = strings.TrimSpace(a)
			if !contains(AppOrder, a) {
				fmt.Fprintf(o.Err, "ypy test: unknown app %q (use %s)\n", a, strings.Join(AppOrder, ", "))
				return 2
			}
			apps = append(apps, a)
		}
	}
	runBrowsers := o.Browsers
	if len(runBrowsers) == 0 {
		runBrowsers = []string{browsers.Chrome}
	}

	tmp, err := os.MkdirTemp("", "ypy-e2e-")
	if err != nil {
		fmt.Fprintf(o.Err, "ypy test: %v\n", err)
		return 1
	}
	defer os.RemoveAll(tmp)

	bin := filepath.Join(tmp, "example-server")
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, "./examples/server")
	build.Dir = o.Root
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(o.Err, "ypy test: building examples/server: %v\n%s", err, out)
		return 1
	}
	port := freePort(o.Port)
	_, stop, err := startServer(ctx, bin, o.Root, port, filepath.Join(tmp, "server.log"))
	if err != nil {
		fmt.Fprintf(o.Err, "ypy test: %v\n", err)
		return 1
	}
	defer stop()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Fprintf(o.Out, "server: %s\n", base)
	fmt.Fprintf(o.Out, "build served: %s\n", served(base+"/_lib/core.js"))

	var outcomes []Outcome
	for _, name := range runBrowsers {
		b, err := browsers.Open(ctx, name, browsers.Options{ChromePath: o.ChromePath, Headed: o.Headed, Logs: o.Logs, KeepDialogs: true, Env: o.Env})
		if err != nil {
			var u *browsers.Unavailable
			if errors.As(err, &u) {
				fmt.Fprintf(o.Out, "%s: skipped (%s)\n  to run it: %s\n", name, u.Reason, u.Hint)
				continue
			}
			fmt.Fprintf(o.Err, "ypy test: %v\n", err)
			return 1
		}
		fmt.Fprintf(o.Out, "-- %s (%s)\n", name, strings.Join(apps, ","))
		for _, app := range apps {
			oc := runApp(ctx, o, b, base, name, app)
			for _, r := range oc.Results {
				mark := "ok  "
				extra := ""
				switch {
				case r.Skipped:
					mark = "skip"
					extra = " :: " + r.SkipReason
				case !r.Pass:
					mark = "FAIL"
					extra = " :: " + r.Error
				}
				fmt.Fprintf(o.Out, "%s %s %s %s%s\n", mark, name, app, r.Scenario, extra)
			}
			outcomes = append(outcomes, oc)
		}
		b.Close()
	}
	if len(outcomes) == 0 {
		fmt.Fprintln(o.Err, "ypy test: no results (no browser ran)")
		return 1
	}
	fmt.Fprintln(o.Out)
	failed := report(o.Out, o.MD, outcomes)
	if failed > 0 && o.Strict {
		return 1
	}
	return 0
}

func served(url string) string {
	resp, err := http.Get(url)
	if err != nil {
		return "NO (" + err.Error() + ")"
	}
	resp.Body.Close()
	if resp.StatusCode == 200 {
		return "yes"
	}
	return fmt.Sprintf("NO (http %d)", resp.StatusCode)
}

// freePort returns the first port from start upwards that nothing listens on.
func freePort(start int) int {
	for p := start; p < start+200; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			l.Close()
			return p
		}
	}
	return start
}

func startServer(ctx context.Context, bin, root string, port int, logPath string) (*exec.Cmd, func(), error) {
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(), "YPY_ROOT="+root, fmt.Sprintf("PORT=%d", port))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return nil, nil, err
	}
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			logFile.Close()
		})
	}
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	for i := 0; i < 100; i++ {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return cmd, stop, nil
			}
		}
		select {
		case <-ctx.Done():
			stop()
			return nil, nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	stop()
	log, _ := os.ReadFile(logPath)
	return nil, nil, fmt.Errorf("the example server did not start:\n%s", log)
}

// runApp runs every applicable scenario against one app, each in a fresh tab.
func runApp(ctx context.Context, o Options, b browsers.Browser, base, browserName, appName string) Outcome {
	oc := Outcome{App: appName, Browser: browserName}
	for _, sc := range Scenarios {
		if o.Scenario != "" && !strings.Contains(sc.Name, o.Scenario) {
			continue
		}
		res, version := runScenario(ctx, o, b, base, appName, sc)
		if oc.Version == "" {
			oc.Version = version
		}
		oc.Results = append(oc.Results, res)
	}
	return oc
}

func runScenario(ctx context.Context, o Options, b browsers.Browser, base, appName string, sc Scenario) (res Result, version string) {
	start := time.Now()
	res = Result{Scenario: sc.Name}
	if reason, ok := sc.Skip[b.Name()]; ok {
		res.Pass, res.Skipped, res.SkipReason = true, true, reason
		return
	}
	page := &Page{}
	sess, err := openDriver(ctx, b, page.dialog)
	if err != nil {
		res.Error = err.Error()
		return
	}
	defer sess.Close()
	sctx, cancel := context.WithTimeout(sess.Base, o.ScenarioTimeout)
	defer cancel()
	if sess.Crashed != nil {
		go func() {
			select {
			case <-sess.Crashed:
				cancel()
			case <-sctx.Done():
			}
		}()
	}
	page.ctx, page.drv = sctx, sess.Driver
	env := &Env{Page: page, Base: base, App: appName}

	func() {
		defer func() {
			if r := recover(); r != nil {
				switch v := r.(type) {
				case failure:
					res.Error = trimLines(v.msg, 4)
				case error:
					if errors.Is(v, context.DeadlineExceeded) {
						res.Error = fmt.Sprintf("scenario timed out after %d ms", o.ScenarioTimeout.Milliseconds())
					} else {
						res.Error = v.Error()
					}
				default:
					panic(r)
				}
			}
		}()
		env.Reset()
		env.Open()
		sc.Run(env)
	}()
	res.Pass = res.Error == ""

	// the library version, read from the page the scenario used (best effort)
	vctx, vcancel := context.WithTimeout(sess.Base, 2*time.Second)
	defer vcancel()
	if v, err := sess.Eval(vctx, `(async()=>String(window.ypy?.version ?? ''))()`); err == nil {
		version = v
	}
	if !res.Pass {
		for _, l := range sess.Logs() {
			if strings.HasPrefix(l, "error:") || strings.HasPrefix(l, "warning:") || strings.HasPrefix(l, "uncaught:") {
				res.Console = append(res.Console, l)
			}
		}
		if len(res.Console) > 6 {
			res.Console = res.Console[:6]
		}
	}
	res.Duration = time.Since(start)
	return
}
