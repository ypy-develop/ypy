// SPDX-License-Identifier: MIT

package build

// Security audit (TASK-044) of "ypy build", fixed in TASK-046. Tests named
// TestAudit..._Fixed_... assert the safe behaviour that replaced the vulnerable
// one the audit proved.

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ypy-develop/ypy/internal/cli"
)

// SEC-20. Write followed a symlink that sat where an output file goes, so a
// checkout whose dist/ carries a symlink (git stores symlinks) made "ypy build"
// overwrite a file outside the output directory. Fixed: the files are written
// through an os.Root and a symlink at the target is replaced by the regular file.
func TestAuditWrite_Fixed_ReplacesASymlinkedOutputFile(t *testing.T) {
	base := t.TempDir()
	victim := filepath.Join(base, "victim.txt")
	if err := os.WriteFile(victim, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(base, "repo", "dist")
	if err := os.MkdirAll(filepath.Join(dist, "ext"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dist, "ext", "a.min.js")
	if err := os.Symlink(filepath.Join("..", "..", "..", "victim.txt"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := Write(dist, Output{"ypy.js": []byte("core"), "ext/a.min.js": []byte("generated")}, PartAll); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(victim); string(got) != "original" {
		t.Fatalf("the file outside was written: victim = %q", got)
	}
	fi, err := os.Lstat(link)
	if err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("the symlink was not replaced by a regular file: %v %v", fi, err)
	}
	if got, _ := os.ReadFile(link); string(got) != "generated" {
		t.Fatalf("output = %q", got)
	}
}

// SEC-20. A symlinked directory that leaves the output (dist/ext -> outside) is
// replaced too, and nothing outside is touched or deleted.
func TestAuditWrite_Fixed_ReplacesASymlinkedOutputDirectory(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(keep, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(base, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dist, "ext")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := Write(dist, Output{"ypy.js": []byte("core"), "ext/a.js": []byte("a")}, PartAll); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(keep); string(got) != "keep" {
		t.Fatalf("a file outside was changed or removed: %q", got)
	}
	if _, err := os.Stat(filepath.Join(outside, "a.js")); err == nil {
		t.Fatal("the build wrote outside the output directory")
	}
	if got, _ := os.ReadFile(filepath.Join(dist, "ext", "a.js")); string(got) != "a" {
		t.Fatalf("ext/a.js = %q", got)
	}
}

// SEC-20, end to end: a checkout (for example a pull request) carries
// src/editors/jetbrains/acme.json with chosen bytes and dist/editors/jetbrains/
// acme.json as a symlink to ../../../.git/config (git stores symlinks; their
// targets may leave the tree). "ypy build", which every contributor runs,
// used to write those bytes over the target (a git config can set
// core.fsmonitor, which git runs on the next status: code execution). The
// target here is a stand-in file, nothing real is touched. Fixed: the target is
// left alone and the link is replaced by a regular file.
func TestAuditBuild_Fixed_SymlinkInDistDoesNotWriteOutside(t *testing.T) {
	root := fixtureRoot(t)
	payload := "[core]\n\tfsmonitor = \"echo audit-proof\"\n"
	if err := os.WriteFile(filepath.Join(root, "src", "editors", "jetbrains", "acme.json"), []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	original := "[core]\n\tbare = false\n"
	victim := filepath.Join(root, "standin-git-config")
	if err := os.WriteFile(victim, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "dist", "editors", "jetbrains", "acme.json")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", "..", "standin-git-config"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	var stderr strings.Builder
	if code := Command().Run(context.Background(), []string{"--root", root}, cli.IO{Out: io.Discard, Err: &stderr, Dir: root}); code != cli.ExitOK {
		t.Fatalf("ypy build: exit %d\n%s", code, stderr.String())
	}
	if got, _ := os.ReadFile(victim); string(got) != original {
		t.Fatalf("the target outside was written: %q", got)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("the symlink was not replaced by a regular file: %v %v", fi, err)
	}
	// --check also reports a symlink where a file should be, whatever it points at
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(victim, []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", "..", "standin-git-config"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	var out strings.Builder
	if code := Command().Run(context.Background(), []string{"--root", root, "--check"}, cli.IO{Out: &out, Err: &stderr, Dir: root}); code == cli.ExitOK {
		t.Fatalf("--check passed with a symlink in dist: %s", out.String())
	}
}

// SEC-24. The build read symlinked source files and copied their content into
// dist/ (src/editors/** is copied as-is, src/skills/**/*.md too), so a symlink in
// src/editors pointing at a private file ended up in dist/, which the project
// commits. Fixed: a symlink in the sources is an error.
func TestAuditGenerate_Fixed_RefusesASymlinkedSource(t *testing.T) {
	root := fixtureRoot(t)
	secret := filepath.Join(t.TempDir(), "private.key")
	if err := os.WriteFile(secret, []byte("AUDIT-PRIVATE-KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(root, "src", "editors", "leak.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	out, err := Generate(Options{Root: root, Only: PartCore})
	if err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("expected a refusal of the symlink, got err=%v", err)
	}
	for name, b := range out {
		if strings.Contains(string(b), "AUDIT-PRIVATE-KEY") {
			t.Fatalf("%s carries the private file", name)
		}
	}
}

func TestAuditGenerate_Fixed_RefusesASymlinkedExtension(t *testing.T) {
	root := fixtureRoot(t)
	secret := filepath.Join(t.TempDir(), "private.js")
	if err := os.WriteFile(secret, []byte("AUDIT-PRIVATE-KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(root, "src", "ext", "leak.js")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := Generate(Options{Root: root, Only: PartExt}); err == nil || !strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("expected a refusal of the symlink, got err=%v", err)
	}
}

// SEC-25. A full build deleted every file it did not generate in <out>/ext,
// <out>/editors, <out>/skills and every top-level <out>/ypy* file. With a
// mistaken --out (for example --out ~ or --out .) that removed user files.
// Fixed: a full build cleans only a directory that is empty, holds a ypy build
// or holds only what the build writes, and refuses any other.
func TestAuditWrite_Fixed_FullBuildRefusesAForeignOut(t *testing.T) {
	out := t.TempDir() // stands for a directory the user named with --out
	files := map[string]string{
		"ext/notes.txt":       "user file",
		"editors/settings.js": "user file",
		"skills/todo.md":      "user file",
		"ypy-notes.txt":       "user file",
		"other.txt":           "kept",
	}
	for rel, body := range files {
		p := filepath.Join(out, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := Write(out, Output{"ypy.js": []byte("x")}, PartAll); err == nil {
		t.Fatal("a full build into a foreign directory must be refused")
	}
	for rel := range files {
		if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(rel))); err != nil {
			t.Errorf("%s was removed", rel)
		}
	}
	// a partial build only writes: it is allowed, and deletes nothing
	if err := Write(out, Output{"ypy.js": []byte("x")}, PartCore); err != nil {
		t.Fatal(err)
	}
	for rel := range files {
		if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(rel))); err != nil {
			t.Errorf("%s was removed by a partial build", rel)
		}
	}
	// once the directory holds a ypy build, the full build cleans it as before
	if err := Write(out, Output{"ypy.js": []byte("x")}, PartAll); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(out, "other.txt")); err != nil {
		t.Error("a file of another name was removed")
	}
	if _, err := os.Stat(filepath.Join(out, "ext", "notes.txt")); err == nil {
		t.Error("a stale file of a managed directory in a build output was kept")
	}
}
