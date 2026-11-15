// SPDX-License-Identifier: MIT

// Command server is the example server of the end to end suite.
//
//	go run ./examples/server
//
// Environment:
//
//	PORT          port to listen on (default 8205)
//	YPY_DIST      YPY build to serve: a file, or a directory holding ypy.min.js
//	              (default: dist/ of this checkout). Extensions are looked up in
//	              <dir>/ext, then in src/ext.
//	YPY_EXTRA     comma separated extension names (without .js) loaded after the core.
//
// Page URLs: /<app>/ where app is native.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	root     string
	ypyDist  string
	ypyExtra []string
}

type stats struct {
	Search         int `json:"search"`
	SSEConnections int `json:"sseConnections"`
	SSEOpen        int `json:"sseOpen"`
	WSConnections  int `json:"wsConnections"`
	WSOpen         int `json:"wsOpen"`
	WSMessages     int `json:"wsMessages"`
	Signups        int `json:"signups"`
}

type state struct {
	NextID int
	Items  []item
	Stats  stats
}

func freshState() *state {
	return &state{
		NextID: 4,
		Items:  []item{{1, "Apple"}, {2, "Banana"}, {3, "Cherry"}},
	}
}

var people = []string{"Alice Archer", "Bob Baker", "Carla Cruz", "Daniel Dias", "Eva Esteves", "Felipe Fonseca",
	"Gabriela Gomes", "Henrique Horta", "Isabela Itaim", "Joao Jardim", "Karina Klein", "Lucas Lima"}

const (
	scrollTotal = 40
	scrollPage  = 10
)

// maxBody is the largest request body the server reads: the forms of the
// examples are a few hundred bytes.
const maxBody = 64 << 10

type server struct {
	cfg  config
	port int
	mu   sync.Mutex
	st   *state
	site ssrSite // the server-rendered site of ssr.go
}

// hostOK reports whether the Host header names this server on the loopback
// address. A page of another origin whose name resolves to 127.0.0.1 (DNS
// rebinding) sends its own name, so it cannot read the pages or the state.
func (s *server) hostOK(host string) bool {
	return host == fmt.Sprintf("127.0.0.1:%d", s.port) || host == fmt.Sprintf("localhost:%d", s.port)
}

// originOK reports whether the Origin of a WebSocket handshake is a page served
// by this server. Browsers always send it, so a page of another site cannot open
// the socket (cross-site WebSocket hijacking).
func (s *server) originOK(origin string) bool {
	return origin == fmt.Sprintf("http://127.0.0.1:%d", s.port) || origin == fmt.Sprintf("http://localhost:%d", s.port)
}

func main() {
	root, err := findRoot()
	if err != nil {
		log.Fatal(err)
	}
	cfg := config{
		root:    root,
		ypyDist: os.Getenv("YPY_DIST"),
	}
	for _, e := range strings.Split(os.Getenv("YPY_EXTRA"), ",") {
		if e = strings.TrimSpace(e); e != "" {
			cfg.ypyExtra = append(cfg.ypyExtra, e)
		}
	}
	port := 8205
	if p, err := strconv.Atoi(os.Getenv("PORT")); err == nil && p > 0 {
		port = p
	}
	s := &server{cfg: cfg, port: port, st: freshState()}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	fmt.Printf("example server on http://%s/\n", addr)
	srv := &http.Server{
		Addr:              addr,
		Handler:           http.HandlerFunc(s.handle),
		ReadHeaderTimeout: 10 * time.Second, // a client that holds a connection half-open is cut
		IdleTimeout:       time.Minute,
	}
	log.Fatal(srv.ListenAndServe())
}

// findRoot returns the repository root: YPY_ROOT, or the first parent of the working
// directory that holds examples/server.
func findRoot() (string, error) {
	if r := os.Getenv("YPY_ROOT"); r != "" {
		return filepath.Abs(r)
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if st, err := os.Stat(filepath.Join(dir, "examples", "server")); err == nil && st.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("repository root not found: run from inside the checkout or set YPY_ROOT")
		}
		dir = parent
	}
}

func appByID(id string) (app, bool) {
	for _, a := range apps {
		if a.id == id {
			return a, true
		}
	}
	return app{}, false
}

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !s.hostOK(r.Host) {
		http.Error(w, "misdirected request: use 127.0.0.1:"+fmt.Sprint(s.port), http.StatusMisdirectedRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	p := r.URL.Path
	if p == "/" {
		var b strings.Builder
		b.WriteString("<ul>")
		for _, a := range apps {
			fmt.Fprintf(&b, `<li><a href="/%s/">%s</a></li>`, a.id, a.id)
		}
		b.WriteString("</ul>")
		send(w, 200, "text/html", b.String())
		return
	}
	if strings.HasPrefix(p, "/_lib/") {
		s.serveLib(w, p)
		return
	}
	if base, rest, ok := ssrPrefix(p); ok {
		s.ssr(w, r, base, rest)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 2)
	a, ok := appByID(parts[0])
	if !ok {
		send(w, 404, "text/plain", "not found")
		return
	}
	rest := "/"
	if len(parts) == 2 {
		rest = "/" + parts[1]
	}
	switch {
	case rest == "/" || rest == "/index.html":
		s.servePage(w, a, "index.html")
	case rest == "/thanks.html":
		s.servePage(w, a, "thanks.html")
	case rest == "/ws":
		s.websocket(w, r, a)
	case strings.HasPrefix(rest, "/api/"):
		s.api(w, r, a, strings.TrimPrefix(rest, "/api"))
	default:
		send(w, 404, "text/plain", "not found")
	}
}

func (s *server) servePage(w http.ResponseWriter, a app, file string) {
	raw, err := os.ReadFile(filepath.Join(s.cfg.root, "examples", a.id, file))
	if err != nil {
		send(w, 404, "text/plain", "not found")
		return
	}
	page := bytes.Replace(raw, []byte("<!--YPY_SCRIPTS-->"), []byte(s.cfg.scriptTags()), 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "YPY-Request")
	_, _ = w.Write(page)
}

func (s *server) serveLib(w http.ResponseWriter, p string) {
	file := s.cfg.resolveLib(p)
	if file == "" {
		send(w, 404, "text/plain", "library file not available: "+p)
		return
	}
	data, err := os.ReadFile(file)
	if err != nil {
		send(w, 404, "text/plain", "library file not available: "+p)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

// ---- API ---------------------------------------------------------------------------

// params reads a request value from the body (urlencoded or JSON), then from the query.
type params struct {
	body   map[string]string
	query  url.Values
	tooBig bool // the body is over maxBody
}

func readParams(r *http.Request) params {
	pr := params{body: map[string]string{}, query: r.URL.Query()}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return pr
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(r.Body); err != nil {
		var tooBig *http.MaxBytesError
		pr.tooBig = errors.As(err, &tooBig)
	}
	if buf.Len() == 0 {
		return pr
	}
	if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		var m map[string]any
		if json.Unmarshal(buf.Bytes(), &m) == nil {
			for k, v := range m {
				pr.body[k] = fmt.Sprint(v)
			}
		}
		return pr
	}
	if vals, err := url.ParseQuery(buf.String()); err == nil {
		for k := range vals {
			pr.body[k] = vals.Get(k)
		}
	}
	return pr
}

func (p params) get(k string) (string, bool) {
	if v, ok := p.body[k]; ok {
		return v, true
	}
	if p.query.Has(k) {
		return p.query.Get(k), true
	}
	return "", false
}

func (p params) str(k string) string { v, _ := p.get(k); return v }

func (s *server) api(w http.ResponseWriter, r *http.Request, a app, route string) {
	// Responses differ by YPY-Request (partial or full page), so caches must key on it.
	w.Header().Set("Vary", "YPY-Request")
	pr := readParams(r)
	if pr.tooBig {
		send(w, http.StatusRequestEntityTooLarge, "text/plain", "request body too large")
		return
	}
	q := r.URL.Query()

	s.mu.Lock()
	st := s.st
	s.mu.Unlock()
	with := func(f func()) { s.mu.Lock(); f(); s.mu.Unlock() }

	switch {
	case route == "/_reset" && r.Method == http.MethodPost:
		with(func() { s.st = freshState() })
		w.WriteHeader(http.StatusNoContent)
		return
	case route == "/_stats":
		var out []byte
		with(func() { out, _ = json.Marshal(s.st.Stats) })
		send(w, 200, "application/json", string(out))
		return

	// CRUD
	case route == "/items" && r.Method == http.MethodGet:
		var out string
		with(func() { out = itemsTable(a, st.Items) })
		sendHTML(w, 200, out)
		return
	case route == "/items" && r.Method == http.MethodPost:
		name := strings.TrimSpace(pr.str("name"))
		if name == "" {
			sendHTML(w, 422, `<tr><td colspan="2" class="error">Name is required</td></tr>`)
			return
		}
		if name == "boom" {
			sendHTML(w, 500, `<tr class="server-error"><td colspan="2">Server exploded</td></tr>`)
			return
		}
		var out string
		with(func() {
			it := item{st.NextID, name}
			st.NextID++
			st.Items = append(st.Items, it)
			out = itemRow(a, it)
		})
		sendHTML(w, 200, out)
		return

	// Active search (a little latency, so the indicator and the debounce are observable)
	case route == "/search":
		with(func() { st.Stats.Search++ })
		term := strings.ToLower(strings.TrimSpace(q.Get("q")))
		time.Sleep(150 * time.Millisecond)
		var found []string
		for _, n := range people {
			if strings.Contains(strings.ToLower(n), term) {
				found = append(found, n)
			}
		}
		sendHTML(w, 200, searchResults(found))
		return

	// Infinite scroll
	case route == "/rows":
		page := 1
		if n, err := strconv.Atoi(q.Get("page")); err == nil && n > 1 {
			page = n
		}
		time.Sleep(60 * time.Millisecond)
		sendHTML(w, 200, scrollRows(a, page, scrollPage, scrollTotal))
		return

	// Form with server-side validation: 422 with messages, 200 + YPY-Redirect on success
	case route == "/signup" && r.Method == http.MethodPost:
		v := signupValues{pr.str("name"), pr.str("email"), pr.str("password")}
		if errs := validateSignup(v); len(errs) > 0 {
			sendHTML(w, 422, signupForm(a, v, errs))
			return
		}
		with(func() { st.Stats.Signups++ })
		w.Header()["YPY-Redirect"] = []string{fmt.Sprintf("/%s/thanks.html?name=%s", a.id, strings.ReplaceAll(url.QueryEscape(strings.TrimSpace(v.Name)), "+", "%20"))}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		return

	// Request and response headers
	case route == "/headers":
		var lines []string
		for k, v := range r.Header {
			if lk := strings.ToLower(k); strings.HasPrefix(lk, "ypy-") {
				lines = append(lines, lk+": "+strings.Join(v, ", "))
			}
		}
		sort.Strings(lines)
		send(w, 200, "text/plain; charset=utf-8", strings.Join(lines, "\n"))
		return
	case route == "/respheaders":
		h := w.Header()
		h.Set("Content-Type", "text/html; charset=utf-8")
		h["YPY-Trigger"] = []string{`{"toast":"saved"}`}
		h["YPY-Retarget"] = []string{"#retarget-box"}
		h["YPY-Reswap"] = []string{"beforeend"}
		h["YPY-Push-Url"] = []string{"/" + a.id + "/pushed"}
		_, _ = w.Write([]byte(`<p class="retargeted">done</p>`))
		return
	case route == "/toast":
		send(w, 200, "text/plain; charset=utf-8", "toast fired")
		return

	// SSE and WebSocket panels
	case route == "/sse/panel":
		sendHTML(w, 200, ssePanel(a))
		return
	case route == "/sse":
		s.sse(w, r, a)
		return
	case route == "/ws/panel":
		sendHTML(w, 200, wsPanel(a))
		return
	}

	if m := itemPath.FindStringSubmatch(route); m != nil {
		id, _ := strconv.Atoi(m[1])
		s.itemRoute(w, r, a, pr, id, m[2] != "")
		return
	}
	send(w, 404, "text/plain", "not found")
}

func (s *server) itemRoute(w http.ResponseWriter, r *http.Request, a app, pr params, id int, edit bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.st
	idx := -1
	for i, it := range st.Items {
		if it.ID == id {
			idx = i
		}
	}
	if idx < 0 {
		send(w, 404, "text/plain", "not found")
		return
	}
	it := st.Items[idx]
	switch {
	case edit && r.Method == http.MethodGet:
		sendHTML(w, 200, itemEditRow(a, it))
	case r.Method == http.MethodGet:
		sendHTML(w, 200, itemRow(a, it))
	case r.Method == http.MethodPut:
		if name := strings.TrimSpace(pr.str("name")); name != "" {
			st.Items[idx].Name = name
			it = st.Items[idx]
		}
		sendHTML(w, 200, itemRow(a, it))
	case r.Method == http.MethodDelete:
		st.Items = append(st.Items[:idx:idx], st.Items[idx+1:]...)
		send(w, 200, "text/html", "")
	default:
		send(w, 404, "text/plain", "not found")
	}
}

func (s *server) sse(w http.ResponseWriter, r *http.Request, a app) {
	fl, ok := w.(http.Flusher)
	if !ok {
		send(w, 500, "text/plain", "streaming unsupported")
		return
	}
	s.mu.Lock()
	s.st.Stats.SSEConnections++
	s.st.Stats.SSEOpen++
	st := s.st
	s.mu.Unlock()
	defer func() { s.mu.Lock(); st.Stats.SSEOpen--; s.mu.Unlock() }()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, ": open\n\n")
	fl.Flush()

	ticker := time.NewTicker(120 * time.Millisecond)
	defer ticker.Stop()
	for n := 1; ; n++ {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
		if n <= 3 {
			_, _ = fmt.Fprint(w, sseTick(a, n))
			fl.Flush()
			continue
		}
		_, _ = fmt.Fprint(w, "event: done\ndata: bye\n\n")
		fl.Flush()
		return
	}
}

func (s *server) websocket(w http.ResponseWriter, r *http.Request, a app) {
	if origin := r.Header.Get("Origin"); origin != "" && !s.originOK(origin) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	st := s.st
	st.Stats.WSConnections++
	st.Stats.WSOpen++
	s.mu.Unlock()
	conn := acceptWebSocket(w, r,
		func(text string, c *wsConn) {
			s.mu.Lock()
			st.Stats.WSMessages++
			s.mu.Unlock()
			var data map[string]any
			msg := text
			if json.Unmarshal([]byte(text), &data) == nil {
				msg = ""
				if m, ok := data["message"]; ok && m != nil {
					msg = fmt.Sprint(m)
				}
			}
			c.Send(wsLine(a, "echo: "+msg))
		},
		func() { s.mu.Lock(); st.Stats.WSOpen--; s.mu.Unlock() },
	)
	if conn == nil {
		s.mu.Lock()
		st.Stats.WSConnections--
		st.Stats.WSOpen--
		s.mu.Unlock()
		return
	}
	conn.Send(wsLine(a, "welcome"))
}

func send(w http.ResponseWriter, status int, typ, body string) {
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func sendHTML(w http.ResponseWriter, status int, body string) {
	send(w, status, "text/html; charset=utf-8", body)
}
