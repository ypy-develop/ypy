// SPDX-License-Identifier: MIT

package gen

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// requireTSCEnv names the variable that makes a missing tsc a failure instead of a skip.
const requireTSCEnv = "YPY_REQUIRE_TSC"

func tscRequired(getenv func(string) string) bool { return getenv(requireTSCEnv) == "1" }

// TestDeclarationsCompile runs the TypeScript compiler over src/ypy.d.ts and over a file that uses it.
// It needs tsc on the PATH; the project itself has no Node, so without it the test is skipped,
// unless YPY_REQUIRE_TSC=1 (the GitHub workflow sets it), which turns the skip into a failure.
func TestDeclarationsCompile(t *testing.T) {
	tsc, err := exec.LookPath("tsc")
	if err != nil {
		if tscRequired(os.Getenv) {
			t.Fatalf("tsc is not on the PATH, and %s=1 requires it", requireTSCEnv)
		}
		t.Skip("tsc is not installed: ypy.d.ts is checked against the table by ypy gen --check only")
	}
	root := repoRoot(t)
	args := []string{
		"--noEmit", "--strict", "--target", "es2022", "--lib", "es2022,dom",
		"--module", "esnext", "--moduleResolution", "bundler",
		filepath.Join(root, "src", "ypy.d.ts"),
		filepath.Join(root, "internal", "gen", "testdata", "types", "consume.ts"),
	}
	out, err := exec.Command(tsc, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("tsc failed:\n%s", out)
	}
}

func TestTSCRequired(t *testing.T) {
	for value, want := range map[string]bool{"": false, "0": false, "true": false, "1": true} {
		got := tscRequired(func(k string) string {
			if k != requireTSCEnv {
				t.Fatalf("read %q, want %q", k, requireTSCEnv)
			}
			return value
		})
		if got != want {
			t.Errorf("%s=%q: required = %v, want %v", requireTSCEnv, value, got, want)
		}
	}
}

// TestDeclarationsCompileFailsWithoutTSCWhenRequired runs the test in a child process
// with an empty PATH and YPY_REQUIRE_TSC=1: it must fail instead of skipping.
func TestDeclarationsCompileFailsWithoutTSCWhenRequired(t *testing.T) {
	if os.Getenv("YPY_TSC_CHILD") == "1" {
		t.Skip("child process")
	}
	run := func(require string) (string, error) {
		cmd := exec.Command(os.Args[0], "-test.run", "^TestDeclarationsCompile$", "-test.v")
		cmd.Env = []string{"PATH=" + t.TempDir(), "YPY_TSC_CHILD=1", requireTSCEnv + "=" + require, "HOME=" + t.TempDir()}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	if out, err := run("1"); err == nil || !strings.Contains(out, "requires it") {
		t.Errorf("with %s=1 and no tsc the test should fail; err=%v\n%s", requireTSCEnv, err, out)
	}
	if out, err := run(""); err != nil || !strings.Contains(out, "SKIP") {
		t.Errorf("without the variable and without tsc the test should skip; err=%v\n%s", err, out)
	}
}
