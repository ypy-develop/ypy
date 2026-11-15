// SPDX-License-Identifier: MIT

package bench

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// server serves the build under test as /build.js, the page and the scenario
// modules from bench/pages. The responses carry the cross-origin isolation
// headers so the page gets microsecond timers and
// performance.measureUserAgentSpecificMemory(). Nothing is cached, so a rebuilt
// file is always the one measured.
type server struct {
	ln  net.Listener
	srv *http.Server
	url string
}

// startServer listens on 127.0.0.1:port (0 picks a free port). build is the
// file served as /build.js; pages is the directory with index.html and the
// scenario modules.
func startServer(build, pages string, port int) (*server, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, err
	}
	s := &server{ln: ln, url: fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)}
	s.srv = &http.Server{Handler: handler(build, pages), ReadHeaderTimeout: 10 * time.Second}
	go s.srv.Serve(ln)
	return s, nil
}

func handler(build, pages string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var file, typ string
		switch name := strings.TrimPrefix(r.URL.Path, "/"); {
		case name == "build.js":
			file, typ = build, "text/javascript"
		case name == "":
			file, typ = filepath.Join(pages, "index.html"), "text/html; charset=utf-8"
		case strings.HasSuffix(name, ".js") && !strings.ContainsAny(name, `/\`) && name != "." && name != "..":
			file, typ = filepath.Join(pages, name), "text/javascript"
		default:
			http.NotFound(w, r)
			return
		}
		body, err := os.ReadFile(file)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", typ)
		h.Set("Cache-Control", "no-store")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Write(body)
	})
}

func (s *server) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if s.srv.Shutdown(ctx) != nil {
		s.srv.Close()
	}
}
