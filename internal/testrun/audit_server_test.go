// SPDX-License-Identifier: MIT

package testrun

// Security audit (TASK-044) of the test server that "ypy test" and
// "ypy test --serve" start, fixed in TASK-046. Tests named TestAudit..._Fixed_...
// assert the safe behaviour that replaced the vulnerable one the audit proved;
// the other TestAudit... tests record what was checked and found correct.

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const auditSecret = "AUDIT-SECRET-OUTSIDE-ROOT"

// auditTree builds <tmp>/outside/secret.txt and a served root <tmp>/root with a
// plain file, a .git/config holding a credential, a symlink to ../outside and
// the dist/ and src/ext/ directories the --dist mode reads.
func auditTree(t *testing.T) (root string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "root")
	write := func(p, body string) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(base, "outside", "secret.txt"), auditSecret)
	write(filepath.Join(base, "outside", "secret.min.js"), auditSecret)
	write(filepath.Join(root, "hello.txt"), "hello")
	write(filepath.Join(root, ".git", "config"), "[remote \"origin\"]\n\turl = https://user:AUDIT-TOKEN@example.invalid/repo.git\n")
	write(filepath.Join(root, "<b>bold</b>.txt"), "x")
	write(filepath.Join(root, "dist", "ypy.min.js"), "/* min */")
	write(filepath.Join(root, "src", "ext", "a.js"), "/* a */")
	write(filepath.Join(root, "test", "lib", "helpers.js"), "/* helpers */")
	write(filepath.Join(root, "test", "tests", "a.js"), "/* a test */")
	if err := os.Symlink(filepath.Join("..", "outside"), filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// a symlink inside a served directory, pointing out of the root
	if err := os.Symlink(filepath.Join("..", "..", "outside"), filepath.Join(root, "test", "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Join("..", "..", "outside", "secret.txt"), filepath.Join(root, "test", "secret-link.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// a symlink that stays inside the root is fine
	if err := os.Symlink(filepath.Join("lib", "helpers.js"), filepath.Join(root, "test", "inside-link.js")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	return root
}

func auditServer(t *testing.T, dist bool) *Server {
	t.Helper()
	s, err := NewServer(auditTree(t), Suites["main"], 0, dist)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// rawGet sends the request line exactly as given (no client side cleaning of
// the path) and returns the status and body.
func rawGet(t *testing.T, s *Server, target, host string, extra ...string) (int, http.Header, string) {
	t.Helper()
	c, err := net.Dial("tcp", s.ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if host == "localhost" { // the host name of the pages, with the port of this server
		host += ":" + fmt.Sprint(s.Port())
	}
	req := "GET " + target + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n"
	for _, h := range extra {
		req += h + "\r\n"
	}
	if _, err := c.Write([]byte(req + "\r\n")); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("%s: %v", target, err)
	}
	defer resp.Body.Close()
	var b strings.Builder
	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp.StatusCode, resp.Header, b.String()
}

// Verified safe: the server binds the loopback address only.
func TestAuditServerListensOnLoopbackOnly(t *testing.T) {
	s := auditServer(t, false)
	addr := s.ln.Addr().(*net.TCPAddr)
	if !addr.IP.IsLoopback() || addr.IP.String() != "127.0.0.1" {
		t.Fatalf("listens on %v, want 127.0.0.1", addr)
	}
}

// Verified safe: every lexical traversal attempt is rejected, plain and in
// dist mode (which rewrites /src/ext/*.js to dist/ext/*.min.js).
func TestAuditServerRejectsTraversal(t *testing.T) {
	for _, dist := range []bool{false, true} {
		s := auditServer(t, dist)
		abs := filepath.ToSlash(filepath.Join(filepath.Dir(s.root), "outside", "secret.txt"))
		for _, target := range []string{
			"/../outside/secret.txt",
			"/%2e%2e/outside/secret.txt",
			"/..%2foutside%2fsecret.txt",
			"/%2e%2e%2foutside%2fsecret.txt",
			"/..%5coutside%5csecret.txt",
			`/..\outside\secret.txt`,
			"/hello.txt/../../outside/secret.txt",
			"/src/ext/..%5c..%5c..%5coutside%5csecret.js",
			"/src/ext/%2e%2e%2f%2e%2e%2f%2e%2e%2foutside%2fsecret.js",
			"/src/ext/..js",
			"/__ypy__/..%2f..%2fserver.go",
			"/__ypy__/../server.go",
			"/__ypy__/assets.go",
			"/outside/secret.txt", // where the 307 of ServeMux path cleaning points
			"/server.go",
			"/hello.txt%00.js",
			"/outside/secret.txt%00",
			"/" + strings.TrimPrefix(abs, "/"),
			"//" + strings.TrimPrefix(abs, "/"),
			"http://localhost/../outside/secret.txt",
		} {
			code, _, body := rawGet(t, s, target, "localhost")
			t.Logf("dist=%v %-60q -> %d", dist, target, code)
			if code == http.StatusOK || strings.Contains(body, auditSecret) {
				t.Errorf("dist=%v %q: status %d, body %.80q", dist, target, code, body)
			}
		}
	}
}

// Verified safe: no CORS header is ever sent, so other origins cannot read
// responses through fetch (DNS rebinding aside, see below).
func TestAuditServerSendsNoCORSHeaders(t *testing.T) {
	s := auditServer(t, false)
	for _, target := range []string{"/hello.txt", "/__ypy__/mocha.js", "/__ypy__/result?session=x", "/?ypy-session=x"} {
		_, h, _ := rawGet(t, s, target, "localhost", "Origin: https://attacker.example")
		for k := range h {
			if strings.HasPrefix(strings.ToLower(k), "access-control-") {
				t.Errorf("%s: sends %s", target, k)
			}
		}
	}
}

// Verified safe: the report endpoint needs POST and a live 64-bit random
// session id; the embedded asset handler serves only embedded names.
func TestAuditServerResultAndAssetEndpoints(t *testing.T) {
	s := auditServer(t, false)
	if code, _, _ := rawGet(t, s, "/__ypy__/result?session=x", "localhost"); code != http.StatusMethodNotAllowed {
		t.Errorf("GET result: %d", code)
	}
	resp, err := http.Post("http://"+s.ln.Addr().String()+"/__ypy__/result?session=nope", "text/plain", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("POST unknown session: %d", resp.StatusCode)
	}
	if code, _, body := rawGet(t, s, "/?ypy-session=%3Cscript%3E", "localhost"); code != http.StatusNotFound || strings.Contains(body, "<script>") {
		t.Errorf("unknown session page: %d %q", code, body)
	}
	sess := s.register("x.js", "")
	defer s.forget(sess)
	if len(sess.id) != 16 {
		t.Errorf("session id %q is not 8 random bytes", sess.id)
	}
}

// SEC-22. The file server followed symlinks that left the root. Fixed: the
// files come through os.Root, so a path that resolves outside the root
// (symlink included) is a 404; a symlink that stays inside still works.
func TestAuditServer_Fixed_DoesNotFollowSymlinkOutsideRoot(t *testing.T) {
	s := auditServer(t, false)
	for _, target := range []string{"/link/secret.txt", "/test/escape/secret.txt", "/test/secret-link.txt"} {
		code, _, body := rawGet(t, s, target, "localhost")
		if code == http.StatusOK || strings.Contains(body, auditSecret) {
			t.Errorf("%s: %d %q", target, code, body)
		}
	}
	if code, _, body := rawGet(t, s, "/test/inside-link.js", "localhost"); code != http.StatusOK || body != "/* helpers */" {
		t.Errorf("a symlink inside the root: %d %q", code, body)
	}
}

// SEC-21. The whole repository root was served, dot directories included,
// with directory listings. Fixed: only src/, test/ and dist/ are
// served, no dot path (.git, .env), no listing.
func TestAuditServer_Fixed_ServesOnlyTheTestFiles(t *testing.T) {
	s := auditServer(t, false)
	for _, target := range []string{"/.git/config", "/.git/", "/src/.hidden", "/hello.txt", "/", "/src/", "/src/ext/", "/test/", "/dist/", "/%3Cb%3Ebold%3C/b%3E.txt"} {
		code, _, body := rawGet(t, s, target, "localhost")
		if code == http.StatusOK || strings.Contains(body, "AUDIT-TOKEN") || strings.Contains(body, "a.js") {
			t.Errorf("%s: %d %q", target, code, body)
		}
	}
	for target, want := range map[string]string{
		"/src/ext/a.js":        "/* a */",
		"/test/lib/helpers.js": "/* helpers */",
		"/dist/ypy.min.js":     "/* min */",
	} {
		if code, _, body := rawGet(t, s, target, "localhost"); code != http.StatusOK || body != want {
			t.Errorf("%s: %d %q, want %q", target, code, body, want)
		}
	}
}

// SEC-21. There was no Host check, so a DNS-rebinding page (attacker.example
// resolving to 127.0.0.1) could read every file the server served while it ran,
// for minutes with --serve. Fixed: 421 unless Host is localhost:PORT or
// 127.0.0.1:PORT, for every endpoint.
func TestAuditServer_Fixed_RejectsAForeignHostHeader(t *testing.T) {
	s := auditServer(t, false)
	for _, host := range []string{"attacker.example", "attacker.example:" + fmt.Sprint(s.Port()), "localhost:1", "127.0.0.1.attacker.example"} {
		for _, target := range []string{"/src/ext/a.js", "/__ypy__/mocha.js", "/?ypy-session=x"} {
			code, _, body := rawGet(t, s, target, host)
			if code != http.StatusMisdirectedRequest || strings.Contains(body, "/* a */") {
				t.Errorf("Host %q %s: %d %q", host, target, code, body)
			}
		}
	}
	for _, host := range []string{"localhost:" + fmt.Sprint(s.Port()), "127.0.0.1:" + fmt.Sprint(s.Port())} {
		if code, _, _ := rawGet(t, s, "/src/ext/a.js", host); code != http.StatusOK {
			t.Errorf("Host %q: %d", host, code)
		}
	}
}

// SEC-27. The server had no ReadHeaderTimeout (slowloris; local only because
// it binds 127.0.0.1). Fixed: the header read is limited, as the bench server's is.
func TestAuditServer_Fixed_HasAReadHeaderTimeout(t *testing.T) {
	s := auditServer(t, false)
	if s.srv.ReadHeaderTimeout <= 0 || s.srv.ReadHeaderTimeout > 30*time.Second {
		t.Fatalf("ReadHeaderTimeout = %v", s.srv.ReadHeaderTimeout)
	}
}
