// SPDX-License-Identifier: MIT

package testrun

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
)

// Options configure a browser run of a suite.
type Options struct {
	Root        string
	Suite       Suite
	Files       []string // overrides the globs of the suite when not empty
	Browsers    []string
	Concurrency int
	Grep        string
	Dist        bool // serve the built dist/ files in place of src/
	Port        int
	Timeout     time.Duration // per test file
	Verbose     bool
	Headed      bool
	Logs        bool
	ChromePath  string
	// Open starts a browser; nil means browsers.Open. Tests replace it.
	Open func(ctx context.Context, name string, opts browsers.Options) (browsers.Browser, error)

	Out   io.Writer
	Err   io.Writer
	IsTTY bool
	Env   func(string) string
}

// FileReport is the outcome of one test file in one browser.
type FileReport struct {
	File     string
	Tests    []TestResult
	Errors   []FileError
	Duration time.Duration
	Logs     []string
}

// FileError is a failure that belongs to the file and not to one test: a hook,
// a module that did not load, a timeout, a crashed page.
type FileError struct {
	Title string
	Err   ErrInfo
}

// Counts of a report.
func (f FileReport) Counts() (passed, failed, skipped int) {
	for _, t := range f.Tests {
		switch t.Status {
		case "passed":
			passed++
		case "failed":
			failed++
		case "skipped":
			skipped++
		}
	}
	failed += len(f.Errors)
	return
}

// BrowserReport is the outcome of a suite in one browser.
type BrowserReport struct {
	Browser     string
	Label       string
	Unavailable *browsers.Unavailable
	Files       []FileReport
	Duration    time.Duration
}

// Totals of a browser report.
func (b BrowserReport) Totals() (files, passed, failed, skipped int) {
	for _, f := range b.Files {
		p, fa, s := f.Counts()
		passed += p
		failed += fa
		skipped += s
		files++
	}
	return
}

// Files resolves the test files of a run, relative to the root.
func (o Options) files() ([]string, error) {
	if len(o.Files) == 0 {
		return Discover(o.Root, o.Suite.Globs)
	}
	var globs []string
	for _, f := range o.Files {
		globs = append(globs, cleanRel(o.Root, f))
	}
	return Discover(o.Root, globs)
}

// Run executes the suite in every requested browser and returns the exit code:
// 0 when every test passed in every browser that ran, 1 when a test failed or
// nothing could run.
func Run(ctx context.Context, o Options) int {
	if o.Timeout == 0 {
		o.Timeout = 2 * time.Minute
	}
	if o.Concurrency <= 0 {
		o.Concurrency = defaultConcurrency()
	}
	if o.Grep != "" {
		if _, err := regexp.Compile(o.Grep); err != nil {
			fmt.Fprintf(o.Err, "ypy test: --grep: %v\n", err)
			return 2
		}
	}
	files, err := o.files()
	if err != nil {
		fmt.Fprintf(o.Err, "ypy test: %v\n", err)
		return 2
	}
	if len(files) == 0 {
		fmt.Fprintf(o.Err, "ypy test: no test file found for suite %q under %s\n", o.Suite.Name, o.Root)
		return 1
	}
	if o.Dist {
		if err := checkDist(o.Root); err != nil {
			fmt.Fprintf(o.Err, "ypy test: --dist: %v\n", err)
			return 2
		}
	}
	srv, err := NewServer(o.Root, o.Suite, o.Port, o.Dist)
	if err != nil {
		fmt.Fprintf(o.Err, "ypy test: %v\n", err)
		return 2
	}
	defer srv.Close()

	var reports []BrowserReport
	for _, name := range o.Browsers {
		if ctx.Err() != nil {
			break
		}
		rep := runBrowser(ctx, o, srv, name, files)
		reports = append(reports, rep)
		printBrowser(o, rep)
	}
	return summarize(o, reports)
}

func defaultConcurrency() int {
	n := numCPU() / 2
	if n < 1 {
		n = 1
	}
	return n
}

func runBrowser(ctx context.Context, o Options, srv *Server, name string, files []string) BrowserReport {
	rep := BrowserReport{Browser: name}
	start := time.Now()
	open := o.Open
	if open == nil {
		open = browsers.Open
	}
	b, err := open(ctx, name, browsers.Options{ChromePath: o.ChromePath, Headed: o.Headed, Logs: o.Logs, Env: o.Env})
	if err != nil {
		var u *browsers.Unavailable
		if errors.As(err, &u) {
			rep.Unavailable = u
		} else {
			rep.Unavailable = &browsers.Unavailable{Browser: name, Reason: "could not start", Hint: err.Error()}
		}
		return rep
	}
	defer b.Close()
	rep.Label = b.Label()

	workers := o.Concurrency
	if m := b.MaxParallel(); m > 0 && workers > m {
		workers = m
	}
	if workers > len(files) {
		workers = len(files)
	}
	fmt.Fprintf(o.Out, "%s: %d test files, %d at a time\n", rep.Label, len(files), workers)

	results := make([]FileReport, len(files))
	var next, finished, passed, failed, skipped atomic.Int64
	var progressMu sync.Mutex
	progress := func() {
		if !o.IsTTY {
			return
		}
		progressMu.Lock()
		defer progressMu.Unlock()
		fmt.Fprintf(o.Out, "\r%s: %d/%d test files | %d passed, %d failed, %d skipped\x1b[K", browserTitle(name), finished.Load(), len(files), passed.Load(), failed.Load(), skipped.Load())
	}
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1)) - 1
				if i >= len(files) || ctx.Err() != nil {
					return
				}
				fr := runFile(ctx, o, srv, b, files[i])
				results[i] = fr
				p, f, s := fr.Counts()
				passed.Add(int64(p))
				failed.Add(int64(f))
				skipped.Add(int64(s))
				finished.Add(1)
				progress()
			}
		}()
	}
	wg.Wait()
	if o.IsTTY {
		fmt.Fprint(o.Out, "\r\x1b[K")
	}
	for _, r := range results {
		if r.File != "" {
			rep.Files = append(rep.Files, r)
		}
	}
	rep.Duration = time.Since(start)
	return rep
}

func runFile(ctx context.Context, o Options, srv *Server, b browsers.Browser, file string) FileReport {
	start := time.Now()
	sess := srv.register(file, o.Grep)
	defer srv.forget(sess)
	fr := FileReport{File: file}

	fctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	page := b.RunPage(fctx, srv.pageURL(sess), sess.done)
	fr.Logs = page.Logs
	fr.Duration = time.Since(start)

	select {
	case <-sess.done:
		p := sess.payload
		if p.ImportError != nil {
			fr.Errors = append(fr.Errors, FileError{Title: "could not import the test module", Err: *p.ImportError})
		}
		for _, h := range p.HookErrors {
			fr.Errors = append(fr.Errors, FileError{Title: strings.Join(h.Title, " > "), Err: h.Error})
		}
		fr.Tests = p.Tests
		for i := range fr.Tests {
			if e := fr.Tests[i].Error; e != nil {
				e.Stack = cleanStack(e.Stack, srv.Port())
			}
		}
		for i := range fr.Errors {
			fr.Errors[i].Err.Stack = cleanStack(fr.Errors[i].Err.Stack, srv.Port())
		}
	default:
		msg := "the page did not report a result"
		switch {
		case errors.Is(page.Err, context.DeadlineExceeded):
			msg = fmt.Sprintf("the file did not finish in %s", o.Timeout)
		case page.Err != nil:
			msg = page.Err.Error()
		}
		fr.Errors = append(fr.Errors, FileError{Title: "the page did not finish", Err: ErrInfo{Name: "Error", Message: msg}})
	}
	return fr
}

var originRe = regexp.MustCompile(`https?://(?:localhost|127\.0\.0\.1):\d+`)

// cleanStack drops the origin of the test server so stacks show repository paths.
func cleanStack(stack string, _ int) string { return originRe.ReplaceAllString(stack, "") }

func browserTitle(name string) string {
	switch name {
	case browsers.Chrome:
		return "Chrome"
	case browsers.Safari:
		return "Safari"
	case browsers.Firefox:
		return "Firefox"
	}
	return name
}

func printBrowser(o Options, rep BrowserReport) {
	title := browserTitle(rep.Browser)
	if rep.Unavailable != nil {
		fmt.Fprintf(o.Out, "%s: skipped (%s)\n", title, rep.Unavailable.Reason)
		if rep.Unavailable.Hint != "" {
			fmt.Fprintf(o.Out, "  to run it: %s\n", rep.Unavailable.Hint)
		}
		return
	}
	files, passed, failed, skipped := rep.Totals()
	for _, f := range rep.Files {
		p, fa, s := f.Counts()
		if fa == 0 && !o.Verbose {
			continue
		}
		mark := "ok  "
		if fa > 0 {
			mark = "FAIL"
		}
		fmt.Fprintf(o.Out, "%s %s (%d passed, %d failed, %d skipped, %s)\n", mark, f.File, p, fa, s, f.Duration.Round(time.Millisecond))
		if fa > 0 {
			for _, e := range f.Errors {
				fmt.Fprintf(o.Out, "  x %s\n", e.Title)
				printErr(o.Out, e.Err)
			}
			for _, t := range f.Tests {
				if t.Status == "failed" {
					fmt.Fprintf(o.Out, "  x %s\n", t.Title())
					if t.Error != nil {
						printErr(o.Out, *t.Error)
					}
				}
			}
		}
		if o.Logs && len(f.Logs) > 0 {
			fmt.Fprintln(o.Out, "  browser logs:")
			for _, l := range f.Logs {
				fmt.Fprintf(o.Out, "    %s\n", l)
			}
		}
	}
	fmt.Fprintf(o.Out, "%s: %d/%d test files | %d passed, %d failed, %d skipped (%s)\n",
		title, files, files, passed, failed, skipped, rep.Duration.Round(100*time.Millisecond))
}

func printErr(w io.Writer, e ErrInfo) {
	msg := strings.TrimSpace(e.Message)
	if e.Name != "" && e.Name != "Error" && !strings.HasPrefix(msg, e.Name) {
		msg = e.Name + ": " + msg
	}
	for _, l := range strings.Split(msg, "\n") {
		fmt.Fprintf(w, "      %s\n", l)
	}
	n := 0
	for _, l := range strings.Split(e.Stack, "\n") {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, "at ") && !strings.Contains(l, "@/") {
			continue
		}
		if strings.Contains(l, "/__ypy__/") {
			continue
		}
		fmt.Fprintf(w, "        %s\n", l)
		if n++; n == 4 {
			break
		}
	}
}

func summarize(o Options, reports []BrowserReport) int {
	ran, failed := 0, 0
	var skippedNames []string
	for _, r := range reports {
		if r.Unavailable != nil {
			skippedNames = append(skippedNames, r.Browser)
			continue
		}
		ran++
		_, _, f, _ := r.Totals()
		failed += f
	}
	switch {
	case ran == 0:
		fmt.Fprintf(o.Out, "no browser ran (skipped: %s)\n", strings.Join(skippedNames, ", "))
		return 1
	case failed > 0:
		fmt.Fprintf(o.Out, "%d test(s) failed\n", failed)
		return 1
	}
	fmt.Fprintln(o.Out, "all tests passed")
	return 0
}

// dirOrCwd resolves the repository root option.
func dirOrCwd(dir, base string) (string, error) {
	if dir == "" {
		dir = "."
	}
	if !filepath.IsAbs(dir) {
		if base == "" {
			var err error
			if base, err = os.Getwd(); err != nil {
				return "", err
			}
		}
		dir = filepath.Join(base, dir)
	}
	return filepath.Clean(dir), nil
}

// checkDist fails when dist/ has not been built: a run against it would only
// report a wall of missing scripts.
func checkDist(root string) error {
	if _, err := os.Stat(filepath.Join(root, "dist", "ypy.min.js")); err != nil {
		return fmt.Errorf("dist/ypy.min.js not found under %s; run ypy build first", root)
	}
	return nil
}

// Serve serves the repository root until ctx ends. Pages are at
// http://localhost:PORT/<path>, for example /test/manual/sse.html.
func Serve(ctx context.Context, root string, suite Suite, port int, dist bool, out, errw io.Writer) int {
	srv, err := NewServer(root, suite, port, dist)
	if err != nil {
		fmt.Fprintf(errw, "ypy test: %v\n", err)
		return 2
	}
	defer srv.Close()
	fmt.Fprintf(out, "serving %s at http://localhost:%d/ (Ctrl-C to stop)\n", root, srv.Port())
	<-ctx.Done()
	return 0
}
