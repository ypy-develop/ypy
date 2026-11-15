// SPDX-License-Identifier: MIT

package bench

// Security audit (TASK-044): extractTar (used on "git archive" output by
// "ypy bench --ref") was checked against hostile archives and found correct.

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func auditTar(t *testing.T, entries ...tar.Header) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, h := range entries {
		h := h
		body := "x"
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(body))
		}
		if h.Mode == 0 {
			h.Mode = 0o644
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write([]byte(body))
		}
	}
	tw.Close()
	return &buf
}

// Verified safe: "..", absolute names and names that climb after cleaning are
// rejected before anything is written.
func TestAuditExtractTarRejectsEscapingNames(t *testing.T) {
	for _, name := range []string{"../evil.js", "src/../../evil.js", "/tmp/evil.js", "..", "./../evil.js"} {
		base := t.TempDir()
		dir := filepath.Join(base, "x")
		os.MkdirAll(dir, 0o755)
		err := extractTar(auditTar(t, tar.Header{Name: name, Typeflag: tar.TypeReg}), dir)
		if err == nil || !strings.Contains(err.Error(), "unsafe path") {
			t.Errorf("%q: err = %v", name, err)
		}
		if _, err := os.Stat(filepath.Join(base, "evil.js")); err == nil {
			t.Errorf("%q: wrote outside", name)
		}
	}
}

// Verified safe: symlink and hard link entries are ignored, so a link
// followed by a file written "through" it cannot escape.
func TestAuditExtractTarIgnoresLinks(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "x")
	os.MkdirAll(dir, 0o755)
	err := extractTar(auditTar(t,
		tar.Header{Name: "src/out", Typeflag: tar.TypeSymlink, Linkname: base},
		tar.Header{Name: "src/hard", Typeflag: tar.TypeLink, Linkname: "../../etc/hosts"},
		tar.Header{Name: "src/out/evil.js", Typeflag: tar.TypeReg},
	), dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(base, "evil.js")); err == nil {
		t.Fatal("wrote through a symlink entry")
	}
	if fi, err := os.Lstat(filepath.Join(dir, "src", "out")); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("src/out: %v %v", fi, err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "src", "hard")); err == nil {
		t.Fatal("hard link entry was created")
	}
}
