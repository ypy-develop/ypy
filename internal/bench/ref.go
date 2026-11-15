// SPDX-License-Identifier: MIT

package bench

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/ypy-develop/ypy/internal/build"
	"github.com/ypy-develop/ypy/internal/cli"
)

// gitOutput runs git in dir and returns its trimmed output.
func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return strings.TrimSpace(string(out)), nil
}

// buildRef builds the framework as it was at commit ref: it takes src/ of that
// commit out of git into a temporary directory and runs the repository's own
// build on it ("ypy build --only core"). It returns the output directory (with
// ypy.min.js and the unminified ypy.js, which the profiler needs for function
// names), the short sha of the commit and a function that removes the
// temporary directory.
func buildRef(ctx context.Context, root, ref string, errw io.Writer) (dist, sha string, cleanup func(), err error) {
	sha, err = gitOutput(ctx, root, "rev-parse", "--short=9", ref+"^{commit}")
	if err != nil {
		return "", "", nil, err
	}
	tmp, err := os.MkdirTemp("", "ypy-bench-"+sha+"-")
	if err != nil {
		return "", "", nil, err
	}
	remove := func() { os.RemoveAll(tmp) }
	defer func() {
		if err != nil {
			remove()
		}
	}()

	cmd := exec.CommandContext(ctx, "git", "-C", root, "archive", "--format=tar", sha, "src")
	cmd.Stderr = errw
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", "", nil, err
	}
	if err = cmd.Start(); err != nil {
		return "", "", nil, err
	}
	extractErr := extractTar(pipe, tmp)
	io.Copy(io.Discard, pipe)
	if waitErr := cmd.Wait(); err == nil && waitErr != nil {
		err = fmt.Errorf("git archive %s: %w", sha, waitErr)
	}
	if err == nil {
		err = extractErr
	}
	if err != nil {
		return "", "", nil, err
	}
	// the build also copies src/ext, src/editors, src/skills and src/ypy.d.ts; a commit
	// that predates any of them still builds its core
	for _, d := range []string{"ext", "editors", "skills"} {
		if err = os.MkdirAll(filepath.Join(tmp, "src", d), 0o755); err != nil {
			return "", "", nil, err
		}
	}
	if _, statErr := os.Stat(filepath.Join(tmp, "src", "ypy.d.ts")); statErr != nil {
		if err = os.WriteFile(filepath.Join(tmp, "src", "ypy.d.ts"), nil, 0o644); err != nil {
			return "", "", nil, err
		}
	}
	dist = filepath.Join(tmp, "dist")
	var buildOut strings.Builder
	code := build.Command().Run(ctx, []string{"--root", tmp, "--out", dist, "--only", "core"},
		cli.IO{Out: &buildOut, Err: errw, Dir: tmp})
	if code != cli.ExitOK {
		err = fmt.Errorf("ypy build of commit %s failed (exit %d)", sha, code)
		return "", "", nil, err
	}
	return dist, sha, remove, nil
}

// extractTar writes the files of a tar stream under dir.
func extractTar(r io.Reader, dir string) error {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		clean := filepath.Clean(filepath.FromSlash(h.Name))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return fmt.Errorf("unsafe path %q in the archive", h.Name)
		}
		dest := filepath.Join(dir, clean)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		}
	}
}
