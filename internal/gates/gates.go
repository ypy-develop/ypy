// SPDX-License-Identifier: MIT

// Package gates is "ypy ci": the checks every change passes before it is
// pushed. Each gate is a small function with a name; "ypy ci" runs them in
// order and prints a summary. The same command runs in the GitHub workflow.
package gates

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ypy-develop/ypy/internal/cli"
)

// Env is what a gate may use.
type Env struct {
	Root string
	Out  io.Writer
	Err  io.Writer
	IO   cli.IO
	// Browser options, passed to the "browser" and "e2e" gates.
	Browsers   string
	ChromePath string
	Port       int
	Strict     bool
}

// Result of a gate. A nil Err passes; Warnings are shown but do not fail.
type Result struct {
	Err      error
	Warnings []string
	// Skipped, when not empty, says why the gate did not run.
	Skipped string
}

// Gate is one check.
type Gate struct {
	Name    string
	Summary string
	Run     func(ctx context.Context, e *Env) Result
}

// All returns the gates in the order "ypy ci" runs them: the cheap ones first.
func All() []Gate {
	return []Gate{
		{"names", "no forbidden name in any tracked file or file name", gateNames},
		{"licenses", "no dependency in the framework; Go dependencies and vendored files have permissive licenses", gateLicenses},
		{"spdx", "SPDX-License-Identifier: MIT in the first lines of every source file", gateSPDX},
		{"gofmt", "every Go file is formatted", gateGofmt},
		{"vet", "go vet ./...", gateVet},
		{"test", "go test ./...", gateTest},
		{"sizes", "dist/ is up to date and the min+gzip budgets hold", gateSizes},
		{"gen", "editor data and the config schema are generated from src/attributes.json, and ypy.d.ts and the sources agree with it", gateGen},
		{"browser", "the browser suites (main; extensions and security also against dist/) in the chosen browsers", gateBrowser},
		{"e2e", "the end to end scenarios of the example app in Chrome, strict", gateE2E},
	}
}

// OptIn returns the gates that "ypy ci" does not run unless they are named:
// they are slower or need a reference, so they are off by default.
func OptIn() []Gate {
	return []Gate{
		{"bench-smoke", "quick benchmark, deterministic metrics only, against the latest result in bench/results (opt-in)", gateBenchSmoke},
	}
}

const helpText = `ypy ci: run the gates a change must pass before it is pushed

Usage:
  ypy ci [options] [gate ...]

Without gate names it runs every gate in order and prints a summary. A gate marked
opt-in runs only when it is named (ypy ci bench-smoke). Gates:
`

const helpOptions = `
Options:
  --skip LIST        gates to leave out (comma separated)
  --fail-fast        stop at the first failing gate (default: run all, then summarize)
  --browsers LIST    browsers of the "browser" gate: chrome, safari, firefox (default: chrome, plus firefox when
                     geckodriver and Firefox are found; YPY_REQUIRE_FIREFOX=1 makes that mandatory)
  --chrome PATH      Chrome or Chromium executable
  --port N           first port for the test and example servers
  --strict           reserved: every gate is already strict
  --root DIR         repository root (default: the current directory)
  --list             list the gates and exit
  -h, --help         this help

Exit status: 0 when every gate passed (or was skipped), 1 when one failed, 2 on bad usage.
`

// Command is the "ci" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "ci", Summary: "run every gate (names, licenses, formatting, tests, sizes, browsers, e2e)", Run: run}
}

func run(ctx context.Context, args []string, io cli.IO) int {
	fs := flag.NewFlagSet("ci", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	var (
		skip, browsers, chrome, root string
		port                         int
		failFast, list, help, strict bool
	)
	fs.StringVar(&skip, "skip", "", "")
	fs.StringVar(&browsers, "browsers", "", "")
	fs.StringVar(&chrome, "chrome", "", "")
	fs.StringVar(&root, "root", "", "")
	fs.IntVar(&port, "port", 0, "")
	fs.BoolVar(&failFast, "fail-fast", false, "")
	fs.BoolVar(&list, "list", false, "")
	fs.BoolVar(&strict, "strict", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy ci: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	gates := All()
	optIn := OptIn()
	if help || list {
		var b strings.Builder
		if help {
			b.WriteString(helpText)
		}
		for _, g := range append(append([]Gate{}, gates...), optIn...) {
			fmt.Fprintf(&b, "  %-11s %s\n", g.Name, g.Summary)
		}
		if help {
			b.WriteString(helpOptions)
		}
		fmt.Fprint(io.Out, b.String())
		return cli.ExitOK
	}
	byName := map[string]Gate{}
	for _, g := range append(append([]Gate{}, gates...), optIn...) {
		byName[g.Name] = g
	}
	selected := gates
	if len(rest) > 0 {
		selected = nil
		for _, n := range rest {
			g, ok := byName[n]
			if !ok {
				fmt.Fprintf(io.Err, "ypy ci: unknown gate %q (see --list)\n", n)
				return cli.ExitUsage
			}
			selected = append(selected, g)
		}
	}
	skipped := map[string]bool{}
	for _, n := range strings.Split(skip, ",") {
		if n = strings.TrimSpace(n); n != "" {
			if _, ok := byName[n]; !ok {
				fmt.Fprintf(io.Err, "ypy ci: --skip: unknown gate %q\n", n)
				return cli.ExitUsage
			}
			skipped[n] = true
		}
	}
	base := io.Dir
	if base == "" {
		base, _ = os.Getwd()
	}
	if root == "" {
		root = base
	} else if !filepath.IsAbs(root) {
		root = filepath.Join(base, root)
	}
	root = filepath.Clean(root)
	env := &Env{Root: root, Out: io.Out, Err: io.Err, IO: io, Browsers: browsers, ChromePath: chrome, Port: port, Strict: strict}
	env.IO.Dir = root

	type row struct {
		name   string
		status string // passed, warning, failed, skipped
		note   string
		took   time.Duration
	}
	var rows []row
	failed := false
	for _, g := range selected {
		if skipped[g.Name] {
			rows = append(rows, row{g.Name, "skipped", "--skip", 0})
			continue
		}
		if failed && failFast {
			rows = append(rows, row{g.Name, "skipped", "after a failure (--fail-fast)", 0})
			continue
		}
		fmt.Fprintf(io.Out, "\n==> %s\n", g.Name)
		start := time.Now()
		res := g.Run(ctx, env)
		r := row{name: g.Name, took: time.Since(start)}
		switch {
		case res.Err != nil:
			r.status, r.note = "failed", firstLine(res.Err.Error())
			fmt.Fprintf(io.Out, "FAILED: %s\n", res.Err)
			failed = true
		case res.Skipped != "":
			r.status, r.note = "skipped", res.Skipped
			fmt.Fprintf(io.Out, "skipped: %s\n", res.Skipped)
		case len(res.Warnings) > 0:
			r.status, r.note = "warning", fmt.Sprintf("%d warning(s)", len(res.Warnings))
			for _, w := range res.Warnings {
				fmt.Fprintf(io.Out, "warning: %s\n", w)
			}
		default:
			r.status = "passed"
		}
		rows = append(rows, r)
		if ctx.Err() != nil {
			break
		}
	}
	fmt.Fprintf(io.Out, "\n==> Summary\n")
	for _, r := range rows {
		note := ""
		if r.note != "" {
			note = "  " + r.note
		}
		took := ""
		if r.took > 0 {
			took = "  " + r.took.Round(100*time.Millisecond).String()
		}
		fmt.Fprintf(io.Out, "  %-8s %-11s%s%s\n", r.status, r.name, took, note)
	}
	if failed {
		fmt.Fprintln(io.Out, "\nFAILED.")
		return cli.ExitFailure
	}
	fmt.Fprintln(io.Out, "\nAll gates passed.")
	return cli.ExitOK
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
