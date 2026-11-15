// SPDX-License-Identifier: MIT

package testrun

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// ErrInfo is a failure as the page reports it.
type ErrInfo struct {
	Name    string `json:"name"`
	Message string `json:"message"`
	Stack   string `json:"stack"`
}

// TestResult is one test as mocha ran it.
type TestResult struct {
	Path     []string `json:"path"`
	Status   string   `json:"status"` // passed, failed, skipped
	Duration float64  `json:"duration"`
	Error    *ErrInfo `json:"error"`
}

// Title is the full title of the test.
func (t TestResult) Title() string { return strings.Join(t.Path, " > ") }

type hookError struct {
	Title []string `json:"title"`
	Error ErrInfo  `json:"error"`
}

// payload is what the runner script posts when a file finished.
type payload struct {
	Tests       []TestResult `json:"tests"`
	HookErrors  []hookError  `json:"hookErrors"`
	ImportError *ErrInfo     `json:"importError"`
}

// session is one test file in one page.
type session struct {
	id      string
	file    string
	grep    string
	done    chan struct{}
	once    sync.Once
	payload payload
}

// servedDirs are the top-level directories of the repository the server hands
// out: the framework, the tests and their fixtures, the built output and the
// documents a test reads. Nothing else of the root is reachable (not .git, not
// the Go sources, not a stray file), and no directory is listed.
var servedDirs = map[string]bool{"src": true, "test": true, "dist": true}

// Server serves the files of the repository the tests need, the vendored mocha
// and chai, the test pages and the endpoint where pages report their results.
// It answers only to the host names of the loopback address it listens on, and
// never follows a symlink out of the repository root.
type Server struct {
	root  string
	dist  bool
	suite Suite
	ln    net.Listener
	srv   *http.Server
	rootH *os.Root // the repository root; paths cannot leave it, symlinks included
	fsys  fs.FS

	mu       sync.Mutex
	sessions map[string]*session
}

// NewServer listens on 127.0.0.1:port (0 picks a free port). With dist true the
// files of src/ are answered by their built, minified counterparts in dist/
// (see distFile), so the suites exercise what a user loads.
func NewServer(root string, suite Suite, port int, dist bool) (*Server, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, err
	}
	rootH, err := os.OpenRoot(root)
	if err != nil {
		ln.Close()
		return nil, err
	}
	s := &Server{root: root, dist: dist, suite: suite, ln: ln, rootH: rootH, fsys: rootH.FS(), sessions: map[string]*session{}}
	mux := http.NewServeMux()
	files := http.FileServerFS(s.fsys)
	mux.HandleFunc("/__ypy__/", s.serveAsset)
	mux.HandleFunc("/__ypy__/result", s.result)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			if id := r.URL.Query().Get("ypy-session"); id != "" {
				s.page(w, id)
				return
			}
		}
		if s.dist {
			if name, ok := distFile(r.URL.Path); ok {
				// never fall back to the source: a file missing from dist/ must fail, not pass
				http.ServeFileFS(w, r, s.fsys, "dist/"+name)
				return
			}
		}
		if !s.servable(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	s.srv = &http.Server{
		Handler:           s.onlyLoopbackHosts(noStore(mux)),
		ReadHeaderTimeout: 10 * time.Second, // a client that holds a connection half-open is cut
		IdleTimeout:       time.Minute,
	}
	go s.srv.Serve(ln)
	return s, nil
}

// servable reports whether the URL path names a file the server may hand out:
// inside one of servedDirs, with no dot segment (.git, .env...), and not a
// directory (there are no listings).
func (s *Server) servable(urlPath string) bool {
	parts := strings.Split(strings.TrimPrefix(urlPath, "/"), "/")
	if !servedDirs[parts[0]] {
		return false
	}
	for _, p := range parts {
		if strings.HasPrefix(p, ".") {
			return false
		}
	}
	info, err := fs.Stat(s.fsys, strings.TrimSuffix(strings.Join(parts, "/"), "/"))
	return err == nil && !info.IsDir()
}

// onlyLoopbackHosts answers 421 to a request whose Host is not the address the
// server listens on. A page of another origin that resolves its own name to
// 127.0.0.1 (DNS rebinding) sends its own name as Host, so it cannot read what
// the server serves.
func (s *Server) onlyLoopbackHosts(next http.Handler) http.Handler {
	port := fmt.Sprint(s.Port())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Host {
		case "localhost:" + port, "127.0.0.1:" + port:
			next.ServeHTTP(w, r)
		default:
			http.Error(w, "misdirected request: use localhost:"+port, http.StatusMisdirectedRequest)
		}
	})
}

// distFile maps a source script of the tests to the file of dist/ that replaces
// it: /src/ypy.js is dist/ypy.min.js and /src/ext/x.js is dist/ext/x.min.js.
func distFile(urlPath string) (string, bool) {
	switch {
	case urlPath == "/src/ypy.js":
		return "ypy.min.js", true
	case strings.HasPrefix(urlPath, "/src/ext/") && strings.HasSuffix(urlPath, ".js"):
		name := strings.TrimPrefix(urlPath, "/src/ext/")
		if name == "" || strings.Contains(name, "/") {
			return "", false
		}
		return "ext/" + strings.TrimSuffix(name, ".js") + ".min.js", true
	}
	return "", false
}

func noStore(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

// Port is the port the server listens on.
func (s *Server) Port() int { return s.ln.Addr().(*net.TCPAddr).Port }

// Close stops the server.
func (s *Server) Close() error {
	defer s.rootH.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2e9)
	defer cancel()
	if err := s.srv.Shutdown(ctx); err != nil {
		return s.srv.Close()
	}
	return nil
}

func (s *Server) serveAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/__ypy__/")
	if name == "result" {
		s.result(w, r)
		return
	}
	data, err := assets.ReadFile("assets/" + name)
	if err != nil || strings.Contains(name, "/") {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(name, ".js") {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.Write(data)
}

// Register prepares a page for a test file and returns its session.
func (s *Server) register(file, grep string) *session {
	var b [8]byte
	rand.Read(b[:])
	sess := &session{id: hex.EncodeToString(b[:]), file: file, grep: grep, done: make(chan struct{})}
	s.mu.Lock()
	s.sessions[sess.id] = sess
	s.mu.Unlock()
	return sess
}

func (s *Server) forget(sess *session) {
	s.mu.Lock()
	delete(s.sessions, sess.id)
	s.mu.Unlock()
}

// pageURL is the address a browser opens for the session. The host is
// localhost, like the page of the previous runner, so tests that read
// location.host see what they always saw.
func (s *Server) pageURL(sess *session) string {
	return fmt.Sprintf("http://localhost:%d/?ypy-session=%s", s.Port(), sess.id)
}

func (s *Server) page(w http.ResponseWriter, id string) {
	s.mu.Lock()
	sess := s.sessions[id]
	s.mu.Unlock()
	if sess == nil {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	io.WriteString(w, s.suite.Page(sess.file, sess.grep))
}

func (s *Server) result(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	sess := s.sessions[r.URL.Query().Get("session")]
	s.mu.Unlock()
	if sess == nil {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	var p payload
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&p); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sess.once.Do(func() {
		sess.payload = p
		close(sess.done)
	})
	w.WriteHeader(http.StatusNoContent)
}
