// SPDX-License-Identifier: MIT

package e2e

// Security audit (TASK-044) of the example server (examples/server) that the
// e2e suite builds and drives, fixed in TASK-046. The server is a local
// test fixture; the findings matter only while it runs. Tests named
// TestAudit..._Fixed_... assert the safe behaviour that replaced the vulnerable one.

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// auditExampleServer builds examples/server (the Go build cache makes the
// repeated builds cheap) and starts it on a free port; it returns host:port.
func auditExampleServer(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("builds and runs examples/server")
	}
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not in PATH")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "example-server")
	cmd := exec.Command("go", "build", "-o", bin, "./examples/server")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	port := freePort(18300)
	_, stop, err := startServer(context.Background(), bin, root, port, filepath.Join(t.TempDir(), "server.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	return fmt.Sprintf("127.0.0.1:%d", port)
}

func auditRaw(t *testing.T, addr, req string) (*http.Response, string) {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.WriteString(c, req); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return resp, ""
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, string(b)
}

// Verified safe: /_lib/ is matched by an anchored regexp, so traversal and
// arbitrary names are 404; the reflected path is sent as text/plain.
func TestAuditExampleServerLibPaths(t *testing.T) {
	addr := auditExampleServer(t)
	for _, target := range []string{
		"/_lib/../../go.mod",
		"/_lib/ext/..%2f..%2f..%2fgo.mod.js",
		"/_lib/extra/..%2f..%2fgo.js",
		"/_lib/extra/%2e%2e.js",
		"/_lib/ext/a%00.js",
		"/_lib/other/core.js",
		"/native/../go.mod",
		"/native/..%2f..%2fgo.mod",
	} {
		resp, body := auditRaw(t, addr, "GET "+target+" HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
		if resp.StatusCode == http.StatusOK || strings.Contains(body, "module github.com") {
			t.Errorf("%s: %d %.80q", target, resp.StatusCode, body)
		}
	}
	resp, body := auditRaw(t, addr, "GET /_lib/%3Cscript%3Ealert(1)%3C/script%3E HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("reflected 404 has Content-Type %q (%q)", ct, body)
	}
	// SEC-33: the reflected 404 carries nosniff
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("no nosniff on the reflected 404: %q", resp.Header.Get("X-Content-Type-Options"))
	}
}

// Verified safe: user input echoed in HTML fragments is escaped.
func TestAuditExampleServerEscapesItemName(t *testing.T) {
	addr := auditExampleServer(t)
	payload := `"><script>alert(1)</script><img src=x onerror=alert(2)>`
	resp, err := http.PostForm("http://"+addr+"/native/api/items", url.Values{"name": {payload}})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	s := string(b)
	if strings.Contains(s, "<script>") || strings.Contains(s, "<img") || !strings.Contains(s, "&lt;script&gt;") {
		t.Errorf("item row not escaped: %s", s)
	}
}

// SEC-28. Request bodies were read without a limit (readParams used
// bytes.Buffer.ReadFrom on r.Body) and echoed back. Fixed: the body is capped
// (64 KiB) and a larger one is answered 413.
func TestAuditExampleServer_Fixed_BoundedRequestBody(t *testing.T) {
	addr := auditExampleServer(t)
	big := strings.Repeat("a", 16<<20)
	resp, err := http.Post("http://"+addr+"/native/api/items", "application/x-www-form-urlencoded", strings.NewReader("name="+big))
	if err == nil {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusRequestEntityTooLarge || len(b) > 1<<10 {
			t.Fatalf("a 16 MiB body: %d, %d bytes", resp.StatusCode, len(b))
		}
	} // else the server cut the connection while the body was still being sent: also a refusal
	resp, err = http.PostForm("http://"+addr+"/native/api/items", url.Values{"name": {"small"}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a normal form: %d", resp.StatusCode)
	}
}

// SEC-28. No Host check (DNS rebinding) and the WebSocket handshake accepted any
// Origin (cross-site WebSocket hijacking). Fixed: only Host 127.0.0.1:PORT /
// localhost:PORT is answered, and a WebSocket upgrade whose Origin is not that
// host is refused (a client with no Origin, which a browser never is, is let in).
func TestAuditExampleServer_Fixed_HostAndWebSocketOrigin(t *testing.T) {
	addr := auditExampleServer(t)
	resp, _ := auditRaw(t, addr, "GET /native/ HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n")
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("Host attacker.example: %d", resp.StatusCode)
	}
	if resp, _ = auditRaw(t, addr, "GET /native/ HTTP/1.1\r\nHost: "+addr+"\r\nConnection: close\r\n\r\n"); resp.StatusCode != http.StatusOK {
		t.Fatalf("Host %s: %d", addr, resp.StatusCode)
	}
	handshake := func(origin string) int {
		req := "GET /native/ws HTTP/1.1\r\nHost: " + addr + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
		if origin != "" {
			req += "Origin: " + origin + "\r\n"
		}
		resp, _ := auditRaw(t, addr, req+"\r\n")
		return resp.StatusCode
	}
	if code := handshake("https://attacker.example"); code != http.StatusForbidden {
		t.Fatalf("WebSocket from a foreign Origin: %d", code)
	}
	if code := handshake("http://" + addr); code != http.StatusSwitchingProtocols {
		t.Fatalf("WebSocket from the page's own Origin: %d", code)
	}
}

// SEC-27. http.ListenAndServe had no ReadHeaderTimeout: a client that sends
// headers slowly kept a connection (and goroutine) forever. Fixed: an
// http.Server with ReadHeaderTimeout (10 s), so the connection is cut.
func TestAuditExampleServer_Fixed_ReadHeaderTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the header timeout")
	}
	addr := auditExampleServer(t)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	io.WriteString(c, "GET / HTTP/1.1\r\nHost: localhost\r\n") // never finishes the headers
	c.SetReadDeadline(time.Now().Add(15 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("the server answered an unfinished request")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("the connection was still open after 15 s: %v", err)
	}
}
