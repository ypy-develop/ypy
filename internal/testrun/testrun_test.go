// SPDX-License-Identifier: MIT

package testrun

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
)

func TestCompileGlob(t *testing.T) {
	cases := []struct {
		glob, path string
		want       bool
	}{
		{"test/tests/**/*.js", "test/tests/a.js", true},
		{"test/tests/**/*.js", "test/tests/unit/deep/a.js", true},
		{"test/tests/**/*.js", "test/other/a.js", false},
		{"test/tests/**/*.js", "test/tests/a.mjs", false},
		{"test/*.js", "test/sub/a.js", false},
		{"a/{b,c}.js", "a/c.js", true},
		{"a/{b,c}.js", "a/d.js", false},
		{"a/?.js", "a/x.js", true},
		{"a.b", "aXb", false},
	}
	for _, c := range cases {
		re, err := compileGlob(c.glob)
		if err != nil {
			t.Fatal(err)
		}
		if got := re.MatchString(c.path); got != c.want {
			t.Errorf("glob %q on %q = %v, want %v", c.glob, c.path, got, c.want)
		}
	}
}

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDiscover(t *testing.T) {
	root := t.TempDir()
	for _, f := range []string{"test/tests/b.js", "test/tests/a/c.js", "test/tests/readme.md", "node_modules/x/test/tests/d.js", "src/e.js"} {
		write(t, root, f, "")
	}
	got, err := Discover(root, []string{"test/tests/**/*.js"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "test/tests/a/c.js,test/tests/b.js" {
		t.Errorf("Discover = %v", got)
	}
	if got, _ := Discover(root, []string{"nothing/**/*.js"}); len(got) != 0 {
		t.Errorf("a missing directory has no files, got %v", got)
	}
}

func TestPageCarriesTheFileAndTheGrep(t *testing.T) {
	html := Suites["main"].Page("test/tests/x.js", "a b")
	for _, want := range []string{"/__ypy__/runner.js?", "file=%2Ftest%2Ftests%2Fx.js", "grep=a+b", "timeout=2000", `<meta name="ypy-config" content='{"logAll":false}'>`} {
		if !strings.Contains(html, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if strings.Contains(html, "RUNNER") {
		t.Error("the runner placeholder was not replaced")
	}
}

// fakeBrowser answers every page like the runner script would: it posts a
// payload to the server, or nothing at all.
type fakeBrowser struct {
	reply func(file string) *payload
}

func (f fakeBrowser) Name() string     { return "chrome" }
func (f fakeBrowser) Label() string    { return "Fake" }
func (f fakeBrowser) MaxParallel() int { return 0 }
func (f fakeBrowser) Close() error     { return nil }
func (f fakeBrowser) RunPage(ctx context.Context, pageURL string, done <-chan struct{}) browsers.PageReport {
	u, _ := url.Parse(pageURL)
	session := u.Query().Get("ypy-session")
	resp, err := http.Get(pageURL)
	if err != nil {
		return browsers.PageReport{Err: err}
	}
	var page bytes.Buffer
	page.ReadFrom(resp.Body)
	resp.Body.Close()
	i := strings.Index(page.String(), "file=")
	file, _ := url.QueryUnescape(strings.SplitN(page.String()[i+5:], "&", 2)[0])
	if p := f.reply(file); p != nil {
		body, _ := json.Marshal(p)
		r, err := http.Post("http://"+u.Host+"/__ypy__/result?session="+session, "application/json", bytes.NewReader(body))
		if err != nil {
			return browsers.PageReport{Err: err}
		}
		r.Body.Close()
	}
	select {
	case <-done:
		return browsers.PageReport{}
	case <-ctx.Done():
		return browsers.PageReport{Err: ctx.Err()}
	}
}

func runFake(t *testing.T, files []string, reply func(string) *payload, timeout time.Duration) (string, int) {
	t.Helper()
	root := t.TempDir()
	for _, f := range files {
		write(t, root, f, "")
	}
	var out bytes.Buffer
	code := Run(context.Background(), Options{
		Root: root, Suite: Suites["main"], Browsers: []string{"chrome"}, Concurrency: 2, Timeout: timeout,
		Out: &out, Err: &out,
		Open: func(context.Context, string, browsers.Options) (browsers.Browser, error) {
			return fakeBrowser{reply}, nil
		},
	})
	return out.String(), code
}

func TestRunCountsAndExitCode(t *testing.T) {
	reply := func(file string) *payload {
		if strings.HasSuffix(file, "bad.js") {
			return &payload{Tests: []TestResult{
				{Path: []string{"s", "works"}, Status: "passed"},
				{Path: []string{"s", "breaks"}, Status: "failed", Error: &ErrInfo{Name: "AssertionError", Message: "expected 1 to equal 2", Stack: "at x (http://localhost:1234/test/tests/bad.js:3:1)"}},
			}}
		}
		return &payload{Tests: []TestResult{{Path: []string{"a"}, Status: "passed"}, {Path: []string{"b"}, Status: "skipped"}}}
	}
	out, code := runFake(t, []string{"test/tests/ok.js", "test/tests/bad.js"}, reply, 5*time.Second)
	if code != 1 {
		t.Errorf("exit = %d, want 1\n%s", code, out)
	}
	for _, want := range []string{"2/2 test files | 2 passed, 1 failed, 1 skipped", "FAIL test/tests/bad.js", "s > breaks", "expected 1 to equal 2", "test/tests/bad.js:3:1"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "localhost:1234") {
		t.Errorf("the origin of the server leaked into a stack:\n%s", out)
	}

	out, code = runFake(t, []string{"test/tests/ok.js"}, reply, 5*time.Second)
	if code != 0 || !strings.Contains(out, "all tests passed") {
		t.Errorf("exit = %d\n%s", code, out)
	}
}

func TestRunReportsAPageThatNeverAnswers(t *testing.T) {
	out, code := runFake(t, []string{"test/tests/hang.js"}, func(string) *payload { return nil }, 300*time.Millisecond)
	if code != 1 || !strings.Contains(out, "did not finish") {
		t.Errorf("exit = %d\n%s", code, out)
	}
}

func TestRunReportsImportAndHookErrors(t *testing.T) {
	out, code := runFake(t, []string{"test/tests/a.js"}, func(string) *payload {
		return &payload{ImportError: &ErrInfo{Message: "boom"}, HookErrors: []hookError{{Title: []string{"s", `"before each" hook`}, Error: ErrInfo{Message: "hook broke"}}}}
	}, 5*time.Second)
	if code != 1 || !strings.Contains(out, "could not import the test module") || !strings.Contains(out, "hook broke") {
		t.Errorf("exit = %d\n%s", code, out)
	}
}

func TestUnavailableBrowserIsSkippedNotFailed(t *testing.T) {
	root := t.TempDir()
	write(t, root, "test/tests/a.js", "")
	var out bytes.Buffer
	code := Run(context.Background(), Options{
		Root: root, Suite: Suites["main"], Browsers: []string{"safari"}, Out: &out, Err: &out,
		Open: func(context.Context, string, browsers.Options) (browsers.Browser, error) {
			return nil, &browsers.Unavailable{Browser: "safari", Reason: "off", Hint: "do this"}
		},
	})
	if code != 1 || !strings.Contains(out.String(), "skipped (off)") || !strings.Contains(out.String(), "do this") {
		t.Errorf("exit = %d\n%s", code, out.String())
	}
}

// A real Chrome, when the machine has one: a tiny suite of its own.
func TestChromeRunsMocha(t *testing.T) {
	if _, err := browsers.FindChrome("", os.Getenv); err != nil {
		t.Skip("Chrome not installed")
	}
	root := t.TempDir()
	write(t, root, "test/tests/a.js", `
describe('math', () => {
  it('adds', () => { chai.assert.equal(1 + 1, 2) })
  it('subtracts wrongly', () => { chai.assert.equal(3 - 1, 5) })
  it.skip('later', () => {})
  it('is async', async () => { await new Promise(r => setTimeout(r, 20)) })
})`)
	suite := Suite{Name: "tiny", Globs: []string{"test/tests/**/*.js"}, TimeoutMS: 1000, page: `<!doctype html><html><head>
<script src="/__ypy__/boot.js"></script><script src="/__ypy__/mocha.js"></script><script src="/__ypy__/chai.js"></script></head>
<body>RUNNER</body></html>`}
	var out bytes.Buffer
	code := Run(context.Background(), Options{
		Root: root, Suite: suite, Browsers: []string{"chrome"}, Concurrency: 1, Timeout: 30 * time.Second,
		Out: &out, Err: &out, Env: os.Getenv,
	})
	if code != 1 || !strings.Contains(out.String(), "2 passed, 1 failed, 1 skipped") || !strings.Contains(out.String(), "math > subtracts wrongly") {
		t.Errorf("exit = %d\n%s", code, out.String())
	}
	out.Reset()
	code = Run(context.Background(), Options{
		Root: root, Suite: suite, Browsers: []string{"chrome"}, Grep: "adds|async", Concurrency: 1, Timeout: 30 * time.Second,
		Out: &out, Err: &out, Env: os.Getenv,
	})
	if code != 0 || !strings.Contains(out.String(), "2 passed, 0 failed") {
		t.Errorf("with --grep: exit = %d\n%s", code, out.String())
	}
}

// A file with thousands of tests posts a result far above 64 KiB; the report
// must still reach the runner (a keepalive fetch would be refused).
func TestChromeReportsAHugeResult(t *testing.T) {
	if _, err := browsers.FindChrome("", os.Getenv); err != nil {
		t.Skip("Chrome not installed")
	}
	root := t.TempDir()
	write(t, root, "test/tests/big.js", `describe('big', () => { for (let i = 0; i < 3000; i++) it('test number ' + i + ' with a reasonably long title to grow the payload', () => {}) })`)
	suite := Suite{Name: "tiny", Globs: []string{"test/tests/**/*.js"}, TimeoutMS: 1000, page: `<!doctype html><html><head>
<script src="/__ypy__/boot.js"></script><script src="/__ypy__/mocha.js"></script></head><body>RUNNER</body></html>`}
	var out bytes.Buffer
	code := Run(context.Background(), Options{
		Root: root, Suite: suite, Browsers: []string{"chrome"}, Concurrency: 1, Timeout: 30 * time.Second,
		Out: &out, Err: &out, Env: os.Getenv,
	})
	if code != 0 || !strings.Contains(out.String(), "3000 passed, 0 failed") {
		t.Errorf("exit = %d\n%s", code, out.String())
	}
}

func TestDistServesTheBuiltFilesInPlaceOfTheSources(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/ypy.js", "SOURCE-CORE")
	write(t, root, "src/ext/ypy-a.js", "SOURCE-A")
	write(t, root, "src/ext/ypy-only-src.js", "SOURCE-ONLY")
	write(t, root, "dist/ypy.min.js", "DIST-CORE")
	write(t, root, "dist/ext/ypy-a.min.js", "DIST-A")
	write(t, root, "test/lib/helpers.js", "HELPERS")

	get := func(dist bool, path string) (int, string) {
		t.Helper()
		srv, err := NewServer(root, Suites["main"], 0, dist)
		if err != nil {
			t.Fatal(err)
		}
		defer srv.Close()
		resp, err := http.Get("http://" + srv.ln.Addr().String() + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var b bytes.Buffer
		b.ReadFrom(resp.Body)
		return resp.StatusCode, b.String()
	}
	for _, c := range []struct {
		dist       bool
		path, want string
		status     int
	}{
		{false, "/src/ypy.js", "SOURCE-CORE", 200},
		{true, "/src/ypy.js", "DIST-CORE", 200},
		{true, "/src/ext/ypy-a.js", "DIST-A", 200},
		{true, "/test/lib/helpers.js", "HELPERS", 200},
		// a script that dist/ does not have is missing, never the source
		{true, "/src/ext/ypy-only-src.js", "", 404},
	} {
		status, body := get(c.dist, c.path)
		if status != c.status || (c.want != "" && body != c.want) {
			t.Errorf("dist=%v %s = %d %q, want %d %q", c.dist, c.path, status, body, c.status, c.want)
		}
	}
}

func TestDistNeedsABuild(t *testing.T) {
	root := t.TempDir()
	write(t, root, "test/tests/a.js", "")
	var out bytes.Buffer
	code := Run(context.Background(), Options{
		Root: root, Suite: Suites["main"], Dist: true,
		Browsers: []string{"chrome"}, Out: &out, Err: &out,
	})
	if code != 2 || !strings.Contains(out.String(), "run ypy build first") {
		t.Errorf("exit code %d, output %q: want a usage error that says to build", code, out.String())
	}
}
