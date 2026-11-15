// SPDX-License-Identifier: MIT

package browsers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// wdError is an error answer of a WebDriver server.
type wdError struct {
	Code    string
	Message string
}

func (e *wdError) Error() string { return e.Code + ": " + e.Message }

// wdClient is the smallest WebDriver (W3C classic) client the runner needs:
// one session, navigation and script execution.
type wdClient struct {
	base string
	http *http.Client
	sid  string
}

func newWDClient(port int) *wdClient {
	return &wdClient{base: fmt.Sprintf("http://127.0.0.1:%d", port), http: &http.Client{Timeout: 60 * time.Second}}
}

func (c *wdClient) call(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	} else if method == http.MethodPost {
		rd = strings.NewReader("{}")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var env struct {
		Value json.RawMessage `json:"value"`
	}
	_ = json.Unmarshal(raw, &env)
	if resp.StatusCode >= 400 {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(env.Value, &e)
		if e.Error == "" {
			e.Error = resp.Status
			e.Message = strings.TrimSpace(string(raw))
		}
		return &wdError{Code: e.Error, Message: e.Message}
	}
	if out != nil && len(env.Value) > 0 {
		return json.Unmarshal(env.Value, out)
	}
	return nil
}

func (c *wdClient) waitReady(ctx context.Context, d time.Duration) error {
	end := time.Now().Add(d)
	for {
		if err := c.call(ctx, http.MethodGet, "/status", nil, nil); err == nil {
			return nil
		} else if time.Now().After(end) {
			return fmt.Errorf("driver did not answer: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func (c *wdClient) newSession(ctx context.Context, caps map[string]any) error {
	var out struct {
		SessionID string `json:"sessionId"`
	}
	err := c.call(ctx, http.MethodPost, "/session", map[string]any{"capabilities": map[string]any{"alwaysMatch": caps}}, &out)
	if err != nil {
		return err
	}
	c.sid = out.SessionID
	return nil
}

func (c *wdClient) navigate(ctx context.Context, url string) error {
	return c.call(ctx, http.MethodPost, "/session/"+c.sid+"/url", map[string]string{"url": url}, nil)
}

func (c *wdClient) execute(ctx context.Context, script string) error {
	return c.call(ctx, http.MethodPost, "/session/"+c.sid+"/execute/sync", map[string]any{"script": script, "args": []any{}}, nil)
}

func (c *wdClient) deleteCookies(ctx context.Context) error {
	return c.call(ctx, http.MethodDelete, "/session/"+c.sid+"/cookie", nil, nil)
}

func (c *wdClient) closeSession(ctx context.Context) {
	if c.sid != "" {
		_ = c.call(ctx, http.MethodDelete, "/session/"+c.sid, nil, nil)
		c.sid = ""
	}
}

// driverProc is a running driver executable (safaridriver, geckodriver).
type driverProc struct {
	cmd    *exec.Cmd
	client *wdClient
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func startDriver(ctx context.Context, exe string, portFlag func(port int) []string) (*driverProc, error) {
	port, err := freePort()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, portFlag(port)...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &driverProc{cmd: cmd, client: newWDClient(port)}
	if err := p.client.waitReady(ctx, 15*time.Second); err != nil {
		p.stop()
		return nil, err
	}
	return p, nil
}

func (p *driverProc) stop() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
	}
}

// wdBrowser runs the pages of a suite one after the other in one WebDriver
// session: these drivers allow a single session, and a visible window.
type wdBrowser struct {
	name  string
	label string
	proc  *driverProc
	mu    sync.Mutex
}

func (b *wdBrowser) Name() string     { return b.name }
func (b *wdBrowser) Label() string    { return b.label }
func (b *wdBrowser) MaxParallel() int { return 1 }

func (b *wdBrowser) Close() error {
	b.proc.client.closeSession(context.Background())
	b.proc.stop()
	return nil
}

func (b *wdBrowser) RunPage(ctx context.Context, url string, done <-chan struct{}) PageReport {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.proc.client
	// Navigation returns after the load event; the page then reports to the
	// server and the driver only waits.
	navErr := make(chan error, 1)
	go func() { navErr <- c.navigate(ctx, url) }()
	var rerr error
	select {
	case err := <-navErr:
		if err != nil && ctx.Err() == nil {
			return PageReport{Err: err}
		}
		select {
		case <-done:
		case <-ctx.Done():
			rerr = ctx.Err()
		}
	case <-done:
	case <-ctx.Done():
		rerr = ctx.Err()
	}
	// Leave a clean slate for the next page: same origin, same storage.
	clean := context.Background()
	_ = c.execute(clean, "try{localStorage.clear();sessionStorage.clear()}catch(e){}")
	_ = c.deleteCookies(clean)
	_ = c.navigate(clean, "about:blank")
	return PageReport{Err: rerr}
}

// promptBehavior is what the driver does with a dialog nobody answered.
func promptBehavior(o Options) string {
	if o.KeepDialogs {
		return "ignore"
	}
	return "dismiss"
}

func exists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

// --- Safari ----------------------------------------------------------------

const safariDriver = "/usr/bin/safaridriver"

func openSafari(ctx context.Context, opts Options) (Browser, error) {
	exe := safariDriver
	if !exists(exe) {
		p, err := exec.LookPath("safaridriver")
		if err != nil {
			return nil, &Unavailable{Browser: Safari, Reason: "not installed",
				Hint: "safaridriver ships with Safari on macOS; Safari cannot run on this system"}
		}
		exe = p
	}
	proc, err := startDriver(ctx, exe, func(port int) []string { return []string{"-p", fmt.Sprint(port)} })
	if err != nil {
		return nil, &Unavailable{Browser: Safari, Reason: "safaridriver did not start", Hint: err.Error()}
	}
	if err := proc.client.newSession(ctx, map[string]any{"browserName": "safari", "unhandledPromptBehavior": promptBehavior(opts)}); err != nil {
		proc.stop()
		return nil, safariUnavailable(err)
	}
	return &wdBrowser{name: Safari, label: "Safari (safaridriver)", proc: proc}, nil
}

// safariUnavailable turns a session error into the exact step for the author.
func safariUnavailable(err error) *Unavailable {
	msg := err.Error()
	low := strings.ToLower(msg)
	u := &Unavailable{Browser: Safari}
	switch {
	case strings.Contains(low, "allow remote automation"):
		u.Reason = "Safari remote automation is off"
		u.Hint = "in Safari open Settings > Advanced and tick \"Show features for web developers\", then in the Develop menu tick \"Allow Remote Automation\""
	case strings.Contains(low, "safaridriver --enable") || strings.Contains(low, "not enabled") || strings.Contains(low, "enable"):
		u.Reason = "safaridriver is not enabled"
		u.Hint = "run once, in a terminal of your own (it asks for the administrator password): safaridriver --enable"
	default:
		u.Reason = "could not start a Safari session"
		u.Hint = msg
	}
	return u
}

// --- Firefox ---------------------------------------------------------------

func firefoxBinary(env func(string) string) string {
	if env != nil {
		if p := env("FIREFOX_BIN"); exists(p) {
			return p
		}
	}
	for _, p := range []string{
		"/Applications/Firefox.app/Contents/MacOS/firefox",
		"/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
	} {
		if exists(p) {
			return p
		}
	}
	for _, n := range []string{"firefox", "firefox-esr"} {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
}

// FirefoxReady says whether Firefox can be driven here: geckodriver on the PATH and a
// Firefox executable. When it cannot, the string is the one-line reason.
func FirefoxReady(env func(string) string) (bool, string) {
	if _, err := exec.LookPath("geckodriver"); err != nil {
		return false, "geckodriver is not on the PATH"
	}
	if firefoxBinary(env) == "" {
		return false, "Firefox is not installed (set FIREFOX_BIN to its executable)"
	}
	return true, ""
}

func openFirefox(ctx context.Context, opts Options) (Browser, error) {
	gecko, err := exec.LookPath("geckodriver")
	if err != nil {
		return nil, &Unavailable{Browser: Firefox, Reason: "not installed",
			Hint: "install geckodriver and Firefox (macOS: brew install geckodriver; Linux: your package manager or the geckodriver release)"}
	}
	ff := firefoxBinary(opts.Env)
	if ff == "" {
		return nil, &Unavailable{Browser: Firefox, Reason: "Firefox not installed",
			Hint: "install Firefox, or set FIREFOX_BIN to its executable"}
	}
	proc, err := startDriver(ctx, gecko, func(port int) []string { return []string{"--port", fmt.Sprint(port), "--binary", ff} })
	if err != nil {
		return nil, &Unavailable{Browser: Firefox, Reason: "geckodriver did not start", Hint: err.Error()}
	}
	ffOpts := map[string]any{}
	if !opts.Headed {
		ffOpts["args"] = []string{"-headless"}
	}
	err = proc.client.newSession(ctx, map[string]any{
		"browserName":             "firefox",
		"moz:firefoxOptions":      ffOpts,
		"unhandledPromptBehavior": promptBehavior(opts),
		"acceptInsecureCerts":     true,
	})
	if err != nil {
		proc.stop()
		var we *wdError
		if errors.As(err, &we) {
			return nil, &Unavailable{Browser: Firefox, Reason: "could not start a Firefox session", Hint: we.Message}
		}
		return nil, &Unavailable{Browser: Firefox, Reason: "could not start a Firefox session", Hint: err.Error()}
	}
	return &wdBrowser{name: Firefox, label: "Firefox (geckodriver)", proc: proc}, nil
}
