// SPDX-License-Identifier: MIT

package build

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ypy-develop/ypy/internal/cli"
)

const helpText = `ypy build: generate dist/ from src/

Usage:
  ypy build [options]

Options:
  --root DIR       repository root, the directory that holds src/ (default: the current directory)
  --out DIR        output directory (default: <root>/dist)
  --only PART      build one part only: core, ext or max (default: everything)
  --check          write nothing; exit 1 when the output on disk differs from the generated one
  --sizes          print the min+gzip table and exit 1 when the core passes 18432 B
                   or an extension passes 6144 B
  -h, --help       this help

The core, the ES module build, the extensions and ypy.max are generated with
minified forms, source maps and brotli copies. The tables that drive it (the
extensions of ypy.max, the size budgets)
are in internal/build/config.go.
`

// Command is the "build" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "build", Summary: "generate dist/ (bundles, minified files, extensions, brotli)", Run: run}
}

func run(_ context.Context, args []string, io cli.IO) int {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	var (
		root, outDir, only string
		check, sizes, help bool
	)
	fs.StringVar(&root, "root", "", "")
	fs.StringVar(&outDir, "out", "", "")
	fs.StringVar(&only, "only", "", "")
	fs.BoolVar(&check, "check", false, "")
	fs.BoolVar(&sizes, "sizes", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy build: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) > 0 {
		fmt.Fprintf(io.Err, "ypy build: unexpected argument %q\nTry --help.\n", rest[0])
		return cli.ExitUsage
	}
	part, err := ParsePart(only)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy build: %v\n", err)
		return cli.ExitUsage
	}
	base := io.Dir
	if base == "" {
		base, _ = os.Getwd()
	}
	abs := func(p string) string {
		if filepath.IsAbs(p) {
			return p
		}
		return filepath.Join(base, p)
	}
	if root == "" {
		root = "."
	}
	root = abs(root)
	if outDir == "" {
		outDir = filepath.Join(root, "dist")
	}
	outDir = abs(outDir)

	out, err := Generate(Options{Root: root, Only: part})
	if err != nil {
		fmt.Fprintf(io.Err, "ypy build: %v\n", err)
		return cli.ExitUsage
	}
	code := cli.ExitOK
	if check {
		drift := Compare(outDir, out, part)
		if !drift.Empty() {
			fmt.Fprintf(io.Err, "ypy build: %s is out of date; run ypy build\n%s", outDir, drift)
			code = cli.ExitFailure
		} else {
			fmt.Fprintf(io.Out, "dist is up to date (%d files)\n", len(out))
		}
	} else {
		if err := Write(outDir, out, part); err != nil {
			fmt.Fprintf(io.Err, "ypy build: %v\n", err)
			return cli.ExitFailure
		}
		fmt.Fprintf(io.Out, "wrote %d files to %s\n", len(out), outDir)
	}
	if sizes {
		if !WriteSizes(io.Out, Sizes(out)) {
			fmt.Fprintln(io.Err, "size gate FAILED")
			code = cli.ExitFailure
		} else {
			fmt.Fprintln(io.Out, "size gate passed")
		}
	}
	return code
}
