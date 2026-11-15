// SPDX-License-Identifier: MIT

package gates

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/ypy-develop/ypy/internal/build"
	"github.com/ypy-develop/ypy/internal/cli"
	"github.com/ypy-develop/ypy/internal/gen"
)

func runGo(ctx context.Context, e *Env, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = e.Root
	cmd.Stdout = e.Out
	cmd.Stderr = e.Out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, strings.Join(args, " "), err)
	}
	return nil
}

// gateGofmt: every tracked Go file is formatted. testdata/ holds fixtures that
// are not valid Go on purpose, and generated *.kyse.go files are skipped.
func gateGofmt(ctx context.Context, e *Env) Result {
	files, err := trackedFiles(ctx, e.Root)
	if err != nil {
		return Result{Err: err}
	}
	var gofiles []string
	for _, f := range files {
		if strings.HasSuffix(f, ".go") && !strings.Contains(f, "/testdata/") && !strings.HasSuffix(f, ".kyse.go") {
			gofiles = append(gofiles, f)
		}
	}
	var out, errb bytes.Buffer
	cmd := exec.CommandContext(ctx, "gofmt", append([]string{"-l"}, gofiles...)...)
	cmd.Dir = e.Root
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return Result{Err: fmt.Errorf("gofmt: %v: %s", err, strings.TrimSpace(errb.String()))}
	}
	if s := strings.TrimSpace(out.String()); s != "" {
		fmt.Fprintf(e.Out, "not gofmt'd:\n%s\n", s)
		var diff bytes.Buffer
		d := exec.CommandContext(ctx, "gofmt", append([]string{"-d"}, strings.Fields(s)...)...)
		d.Dir = e.Root
		d.Stdout = &diff
		_ = d.Run()
		if lines := strings.Split(diff.String(), "\n"); len(lines) > 40 {
			diff.Reset()
			diff.WriteString(strings.Join(lines[:40], "\n"))
		}
		fmt.Fprintln(e.Out, diff.String())
		return Result{Err: fmt.Errorf("%d file(s) not formatted", strings.Count(s, "\n")+1)}
	}
	fmt.Fprintf(e.Out, "%d Go file(s) formatted\n", len(gofiles))
	return Result{}
}

func gateVet(ctx context.Context, e *Env) Result {
	return Result{Err: runGo(ctx, e, "go", "vet", "./...")}
}

func gateTest(ctx context.Context, e *Env) Result {
	return Result{Err: runGo(ctx, e, "go", "test", "./...")}
}

// gateSizes: dist/ matches what the build generates and the min+gzip budgets hold.
func gateSizes(ctx context.Context, e *Env) Result {
	if code := build.Command().Run(ctx, []string{"--root", e.Root, "--check", "--sizes"}, e.IO); code != cli.ExitOK {
		return Result{Err: fmt.Errorf("ypy build --check --sizes exited %d (run ypy build if dist/ is out of date)", code)}
	}
	return Result{}
}

// gateGen: the editor data and the config schema are what the table of names generates, and
// ypy.d.ts and the sources do not disagree with the table.
func gateGen(ctx context.Context, e *Env) Result {
	if code := gen.Command().Run(ctx, []string{"--root", e.Root, "--check"}, e.IO); code != cli.ExitOK {
		return Result{Err: fmt.Errorf("ypy gen --check exited %d (run ypy gen, or update src/attributes.json and src/attributes.d)", code)}
	}
	return Result{}
}
