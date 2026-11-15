// SPDX-License-Identifier: MIT

// Package bench is "ypy bench": the performance harness of the framework. It
// opens the benchmark page (bench/pages) in Chrome through the DevTools
// protocol, runs the scenarios in fresh pages, summarizes the samples and
// stores them as JSON in bench/results; it also compares and shows stored
// results and profiles scenarios with the DevTools Profiler.
package bench

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/ypy-develop/ypy/internal/browsers"
	"github.com/ypy-develop/ypy/internal/cli"
)

const helpText = `ypy bench: measure the performance of a build

Usage:
  ypy bench [options]                         run the scenarios and store the result
  ypy bench compare A.json B.json [options]   compare two results (A is the reference)
  ypy bench show RESULT.json [--md]           print a stored result
  ypy bench profile SCENARIO... [options]     CPU profile of scenarios

Run options:
  --build PATH       build to measure (default: $YPY_BUILD, else dist/ypy.min.js)
  --ref COMMIT       build that commit with "ypy build" in a temporary directory
                     and measure it (not with --build)
  --filter REGEX     only the scenarios whose name matches (the size entries always run)
  --quick            one round, fewer samples: a smoke run, not a result
  --rounds N         fresh pages per scenario, pooled (default 5)
  --out DIR          where the JSON goes (default bench/results); the file is
                     <date>-<sha>[-<label>].json
  --label TEXT       added to the file name
  --uam              also take performance.measureUserAgentSpecificMemory() before
                     and after the session (about 18 s per call)
  --list             print the scenario names and stop
  --port N           port of the local server (default: a free one)
  --chrome PATH      Chrome or Chromium executable (default: discovered, or $CHROME_BIN)
  --root DIR         repository root (default: the current directory)
  -h, --help         this help

The sha in the file name is the commit of the build: $YPY_SHA, else the commit
--ref built, else HEAD (with -dirty when src or dist differ from it).

Compare options:
  --threshold PCT    difference in percent that counts (default 5)
  --only REGEX       only the metrics whose id matches
  --no-fail          exit 0 even when there is a regression
  A metric flagged REGRESSION is more than the threshold worse in B than in A;
  "faster" is better by more than the threshold; a trailing "~" means the noise
  between the rounds is as large as the difference.

Profile options:
  --build PATH       build to profile (default dist/ypy.js, the unminified one, so
                     the profile shows function names; also --ref COMMIT)
  --seconds N        how long each scenario runs under the profiler (default 4)
  --top N            rows per table (default 20)
  --out DIR          summaries go here as profile-<scenario>-<sha>.json (default bench/results)
  --raw DIR          also write the raw .cpuprofile, loadable in the DevTools Performance panel

Exit status: 0 done, 1 a regression (compare) or a scenario failed, 2 bad usage.
`

// Command is the "bench" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "bench", Summary: "measure performance (run, compare, show, profile)", Run: run}
}

func run(ctx context.Context, args []string, io cli.IO) int {
	if len(args) > 0 {
		switch args[0] {
		case "compare":
			return compareCmd(args[1:], io)
		case "show":
			return showCmd(args[1:], io)
		case "profile":
			return profileCmd(ctx, args[1:], io)
		}
	}
	return runCmd(ctx, args, io)
}

// flags shared by the run and the profile commands.
type common struct {
	build, ref, out, root, chrome string
	port                          int
	help                          bool
}

func (c *common) register(fs *flag.FlagSet) {
	fs.StringVar(&c.build, "build", "", "")
	fs.StringVar(&c.ref, "ref", "", "")
	fs.StringVar(&c.out, "out", "", "")
	fs.StringVar(&c.root, "root", "", "")
	fs.StringVar(&c.chrome, "chrome", "", "")
	fs.IntVar(&c.port, "port", 0, "")
	fs.BoolVar(&c.help, "h", false, "")
	fs.BoolVar(&c.help, "help", false, "")
}

func newFlagSet(name string, io cli.IO) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	return fs
}

// abs resolves p against the directory the command works in.
func abs(io cli.IO, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	base := io.Dir
	if base == "" {
		base, _ = os.Getwd()
	}
	return filepath.Join(base, p)
}

func (c *common) options(io cli.IO) (RunOptions, error) {
	if c.build != "" && c.ref != "" {
		return RunOptions{}, errors.New("--build and --ref cannot be used together")
	}
	root := abs(io, ".")
	if c.root != "" {
		root = abs(io, c.root)
	}
	o := RunOptions{Root: root, Ref: c.ref, Port: c.port, ChromePath: c.chrome, Out2: io.Out, Err: io.Err, IsTTY: io.IsTTY, Env: io.Env}
	if c.build != "" {
		o.Build = abs(io, c.build)
	}
	o.Out = filepath.Join(root, "bench", "results")
	if c.out != "" {
		o.Out = abs(io, c.out)
	}
	return o, nil
}

// exitFor reports an error of a run and gives the exit status.
func exitFor(name string, err error, io cli.IO) int {
	var unavailable *browsers.Unavailable
	var usage usageError
	switch {
	case errors.As(err, &unavailable):
		fmt.Fprintf(io.Err, "ypy %s: %v\n", name, unavailable)
		return cli.ExitFailure
	case errors.As(err, &usage):
		fmt.Fprintf(io.Err, "ypy %s: %v\n", name, usage)
		return cli.ExitUsage
	case errors.Is(err, context.Canceled):
		fmt.Fprintf(io.Err, "ypy %s: interrupted\n", name)
		return cli.ExitFailure
	}
	fmt.Fprintf(io.Err, "ypy %s: %v\n", name, err)
	return cli.ExitFailure
}

func runCmd(ctx context.Context, args []string, io cli.IO) int {
	fs := newFlagSet("bench", io)
	var c common
	c.register(fs)
	var (
		filter, label    string
		rounds           int
		quick, uam, list bool
	)
	fs.StringVar(&filter, "filter", "", "")
	fs.StringVar(&label, "label", "", "")
	fs.IntVar(&rounds, "rounds", 5, "")
	fs.BoolVar(&quick, "quick", false, "")
	fs.BoolVar(&uam, "uam", false, "")
	fs.BoolVar(&list, "list", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if c.help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) > 0 {
		fmt.Fprintf(io.Err, "ypy bench: unexpected argument %q\nTry --help.\n", rest[0])
		return cli.ExitUsage
	}
	if rounds < 1 {
		fmt.Fprintln(io.Err, "ypy bench: --rounds must be at least 1")
		return cli.ExitUsage
	}
	o, err := c.options(io)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench: %v\n", err)
		return cli.ExitUsage
	}
	o.Filter, o.Label, o.Rounds, o.Quick, o.UAM, o.List = filter, label, rounds, quick, uam, list
	out, err := Run(ctx, o)
	if err != nil {
		return exitFor("bench", err, io)
	}
	if out.Failed {
		return cli.ExitFailure
	}
	return cli.ExitOK
}

func compareCmd(args []string, io cli.IO) int {
	fs := newFlagSet("bench compare", io)
	var (
		threshold float64
		only      string
		noFail    bool
		help      bool
	)
	fs.Float64Var(&threshold, "threshold", 5, "")
	fs.StringVar(&only, "only", "", "")
	fs.BoolVar(&noFail, "no-fail", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench compare: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) != 2 {
		fmt.Fprintln(io.Err, "usage: ypy bench compare A.json B.json [--threshold 5] [--no-fail] [--only REGEX]")
		return cli.ExitUsage
	}
	var re *regexp.Regexp
	if only != "" {
		if re, err = regexp.Compile(only); err != nil {
			fmt.Fprintf(io.Err, "ypy bench compare: --only: %v\n", err)
			return cli.ExitUsage
		}
	}
	a, err := ReadResult(abs(io, rest[0]))
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench compare: %v\n", err)
		return cli.ExitUsage
	}
	b, err := ReadResult(abs(io, rest[1]))
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench compare: %v\n", err)
		return cli.ExitUsage
	}
	c := Compare(io.Out, a, b, CompareOptions{Threshold: threshold, Only: re})
	if c.Regressions > 0 && !noFail {
		return cli.ExitFailure
	}
	return cli.ExitOK
}

func showCmd(args []string, io cli.IO) int {
	fs := newFlagSet("bench show", io)
	var md, help bool
	fs.BoolVar(&md, "md", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench show: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) != 1 {
		fmt.Fprintln(io.Err, "usage: ypy bench show RESULT.json [--md]")
		return cli.ExitUsage
	}
	r, err := ReadResult(abs(io, rest[0]))
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench show: %v\n", err)
		return cli.ExitUsage
	}
	Show(io.Out, r, md)
	return cli.ExitOK
}

func profileCmd(ctx context.Context, args []string, io cli.IO) int {
	fs := newFlagSet("bench profile", io)
	var c common
	c.register(fs)
	var (
		seconds float64
		top     int
		raw     string
	)
	fs.Float64Var(&seconds, "seconds", 4, "")
	fs.IntVar(&top, "top", 20, "")
	fs.StringVar(&raw, "raw", "", "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench profile: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if c.help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	if len(rest) == 0 {
		fmt.Fprintln(io.Err, "usage: ypy bench profile SCENARIO... [--build PATH] [--seconds N] [--top N] [--out DIR] [--raw DIR]")
		return cli.ExitUsage
	}
	if seconds <= 0 || top < 1 {
		fmt.Fprintln(io.Err, "ypy bench profile: --seconds and --top must be positive")
		return cli.ExitUsage
	}
	o, err := c.options(io)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy bench profile: %v\n", err)
		return cli.ExitUsage
	}
	po := ProfileOptions{RunOptions: o, Scenarios: rest, Seconds: seconds, Top: top}
	if raw != "" {
		po.Raw = abs(io, raw)
	}
	if err := Profile(ctx, po); err != nil {
		return exitFor("bench profile", err, io)
	}
	return cli.ExitOK
}
