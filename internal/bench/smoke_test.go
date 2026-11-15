// SPDX-License-Identifier: MIT

package bench

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
)

func TestLatestReference(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, r *Result) {
		if err := WriteJSON(filepath.Join(dir, name), r); err != nil {
			t.Fatal(err)
		}
	}
	mk := func(sha, date, tm string, quick bool, filter string) *Result {
		r := result(sha, map[string]Metric{"size.min": metric("B", 1, 0)}, "size.min")
		r.Date, r.Time, r.Config.Quick = date, tm, quick
		if filter != "" {
			r.Config.Filter = &filter
		}
		return r
	}
	write("a.json", mk("old", "2026-11-13", "", false, ""))
	write("b.json", mk("same-day-untimed", "2026-11-14", "", false, ""))
	write("c.json", mk("same-day-timed", "2026-11-14", "2026-11-14T10:00:00Z", false, ""))
	write("d.json", mk("later-but-quick", "2026-11-15", "", true, ""))
	write("e.json", mk("later-but-filtered", "2026-11-15", "", false, "^swap"))
	os.WriteFile(filepath.Join(dir, "profile-x-abc.json"), []byte(`{"totalMs":1}`), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644)
	r, path, err := LatestReference(dir)
	if err != nil {
		t.Fatal(err)
	}
	if r.SHA != "same-day-timed" || filepath.Base(path) != "c.json" {
		t.Errorf("latest = %s (%s)", r.SHA, path)
	}
	if _, _, err := LatestReference(t.TempDir()); err == nil {
		t.Error("an empty directory has no reference")
	}
}

func TestDeterministicMetrics(t *testing.T) {
	for _, id := range []string{"request.events.empty.dispatched", "morph.inner.100.preserve_failures", "session.nodes_retained", "session.listeners_retained", "size.min_gzip"} {
		if !deterministic.MatchString(id) {
			t.Errorf("%s must be deterministic", id)
		}
	}
	for _, id := range []string{"swap.innerHTML.100", "session.heap_retained", "session.total", "morph.inner.100", "request.events"} {
		if deterministic.MatchString(id) {
			t.Errorf("%s must not be compared at threshold 0", id)
		}
	}
}

// The smoke gate against a synthetic reference: a build that does what the
// reference says passes, one that is worse on a deterministic metric fails.
func TestSmokeGate(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	if _, err := browsers.FindChrome("", os.Getenv); err != nil {
		t.Skip("no Chrome")
	}
	repo, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	build, err := os.ReadFile(filepath.Join(repo, "dist", "ypy.min.js"))
	if err != nil {
		t.Skip("no dist build")
	}
	root := t.TempDir()
	if err := os.CopyFS(filepath.Join(root, "bench", "pages"), os.DirFS(filepath.Join(repo, "bench", "pages"))); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(root, "dist"), 0o755)
	os.WriteFile(filepath.Join(root, "dist", "ypy.min.js"), build, 0o644)
	results := filepath.Join(root, "bench", "results")
	os.MkdirAll(results, 0o755)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	opts := func(out *bytes.Buffer) RunOptions { return RunOptions{Root: root, Out2: out, Err: out, Env: os.Getenv} }

	// no reference yet: skipped, with the way out
	var out bytes.Buffer
	skipped, err := Smoke(ctx, opts(&out))
	if err != nil || !strings.Contains(skipped, "record one with ypy bench") {
		t.Fatalf("no reference: skipped=%q err=%v", skipped, err)
	}

	reference := func(events float64) {
		r := result("ref", map[string]Metric{
			"request.events.empty.dispatched":  metric("count", events, 0),
			"morph.inner.10.preserve_failures": metric("count", 0, 0),
			"session.nodes_retained":           metric("count", 0, 0),
			"session.listeners_retained":       metric("count", 0, 0),
			"size.min":                         metric("B", float64(len(build)), 0),
		}, "request.events.empty.dispatched", "morph.inner.10.preserve_failures", "session.nodes_retained", "session.listeners_retained", "size.min")
		r.Time = "2026-11-14T12:00:00Z"
		WriteJSON(filepath.Join(results, "2026-11-14-ref.json"), r)
	}
	reference(10)
	out.Reset()
	if skipped, err := Smoke(ctx, opts(&out)); err != nil || skipped != "" {
		t.Fatalf("matching reference: skipped=%q err=%v\n%s", skipped, err, out.String())
	}
	if !strings.Contains(out.String(), "request.events.empty.dispatched") || !strings.Contains(out.String(), "0 regression(s)") {
		t.Errorf("comparison not printed:\n%s", out.String())
	}
	reference(5) // the reference dispatched fewer events: the build is worse
	out.Reset()
	if _, err := Smoke(ctx, opts(&out)); err == nil || !strings.Contains(err.Error(), "got worse") {
		t.Fatalf("a regression must fail the gate: %v\n%s", err, out.String())
	}
}
