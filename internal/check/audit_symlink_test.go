// SPDX-License-Identifier: MIT

package check

// Security audit (TASK-044) of "ypy check", fixed in TASK-046. Tests named
// TestAudit..._Fixed_... assert the safe behaviour that replaced the vulnerable
// one the audit proved.

import (
	"os"
	"path/filepath"
	"testing"
)

// SEC-23. collectFiles followed directory symlinks (os.Stat + recursion)
// without remembering what it visited. One self-referencing link made the same
// file appear ~MAXSYMLINKS times (32 on macOS, 40 on Linux); two such links in
// one directory made the walk exponential (2^32 visits): "ypy check" on such a
// tree ran at 100% CPU and was still running after 20 s in the audit.
// Fixed: a link to a directory met while walking is not followed, so each
// file is reported once and a link cannot leave the project; a path the user
// names is still followed.
func TestAuditCollectFiles_Fixed_DoesNotFollowDirectorySymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.html"), []byte("<div></div>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(".", filepath.Join(dir, "loop")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(".", filepath.Join(dir, "loop2")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.html"), []byte("<div></div>\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// a link to a file is still read (the project may link a shared template)
	if err := os.Symlink(filepath.Join(outside, "secret.html"), filepath.Join(dir, "linked.html")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	var warnings []string
	files := collectFiles([]string{dir}, map[string]bool{".html": true}, &warnings)
	if len(files) != 2 {
		t.Fatalf("want a.html and linked.html once each, got %d entries: %v", len(files), files)
	}
	// a directory the user names is followed, even through a link
	files = collectFiles([]string{filepath.Join(dir, "escape")}, map[string]bool{".html": true}, &warnings)
	if len(files) != 1 {
		t.Fatalf("an explicit link to a directory: %v", files)
	}
}
