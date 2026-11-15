// SPDX-License-Identifier: MIT

package testrun

import (
	"context"
	"flag"
	"fmt"
	"strings"
	"time"

	"github.com/ypy-develop/ypy/internal/browsers"
	"github.com/ypy-develop/ypy/internal/cli"
	"github.com/ypy-develop/ypy/internal/e2e"
)

const helpText = `ypy test: run the browser test suites

Usage:
  ypy test [options] [file ...]

Options:
  --suite NAME       main (default) or e2e
  --browsers LIST    chrome, safari, firefox, comma separated (default: chrome)
                     a browser that is not installed is reported as skipped
                     with the step to take; it never fails silently
  --chrome PATH      Chrome or Chromium executable (default: discovered, or $CHROME_BIN)
  --concurrency N    pages at a time (default: half of the CPUs; Safari and Firefox: 1)
  --grep REGEX       run only the tests whose full title matches
  --dist             load the built, minified files of dist/ (ypy.min.js, ext/*.min.js) wherever the
                     tests ask for src/ypy.js or src/ext/*.js; run ypy build first. A script that
                     dist/ does not have is a 404, never a fallback to src/
  --files GLOBS      test files or globs instead of the suite's own (repeatable)
  --port N           port of the test server (default: a free one)
  --timeout DUR      limit for one test file (default 2m)
  --root DIR         repository root (default: the current directory)
  --headed           show the browser window (Chrome, Firefox)
  --logs             print the console output of the pages (Chrome)
  --list             print the test files and exit
  --serve            serve src/, test/ and dist/ (and mocha, chai) at http://localhost:PORT/
                     until interrupted, for the manual pages in test/manual and for debugging
  -v, --verbose      one line for every test file, not only for failing ones
  -h, --help         this help

Suite "e2e" drives Chrome against the example server (examples/server) and the native app:
  --apps LIST        example apps to run (default: all; today only native)
  --scenario TEXT    only scenarios whose name contains the text
  --md FILE          also write the result matrix as markdown
  --strict           exit 1 when any scenario fails
  --scenario-timeout DUR   limit for one scenario (default 12s)
Environment for the e2e suite: YPY_DIST (a build file or directory),
YPY_EXTRA (extra extensions).

Tests run in fresh pages served by a local server (src/, test/ and dist/ of the
repository root; localhost and 127.0.0.1 only); mocha and chai are built into the binary. Positional arguments are test files.
Exit status: 0 all passed, 1 a test failed or nothing could run, 2 bad usage.
`

// Command is the "test" subcommand.
func Command() cli.Command {
	return cli.Command{Name: "test", Summary: "run the browser test suites (main, e2e)", Run: run}
}

func run(ctx context.Context, args []string, io cli.IO) int {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.SetOutput(io.Err)
	fs.Usage = func() {}
	var (
		suiteName, browserList, chrome, grep, root             string
		concurrency, port                                      int
		timeout, scenarioTimeout                               time.Duration
		headed, logs, list, serve, verbose, help, strict, dist bool
		files                                                  []string
		apps, scenario, md                                     string
	)
	fs.StringVar(&suiteName, "suite", "main", "")
	fs.StringVar(&browserList, "browsers", browsers.Chrome, "")
	fs.StringVar(&chrome, "chrome", "", "")
	fs.StringVar(&grep, "grep", "", "")
	fs.StringVar(&root, "root", "", "")
	fs.IntVar(&concurrency, "concurrency", 0, "")
	fs.IntVar(&port, "port", 0, "")
	fs.DurationVar(&timeout, "timeout", 0, "")
	fs.DurationVar(&scenarioTimeout, "scenario-timeout", 0, "")
	fs.BoolVar(&headed, "headed", false, "")
	fs.BoolVar(&logs, "logs", false, "")
	fs.BoolVar(&list, "list", false, "")
	fs.BoolVar(&serve, "serve", false, "")
	fs.BoolVar(&dist, "dist", false, "")
	fs.BoolVar(&verbose, "v", false, "")
	fs.BoolVar(&verbose, "verbose", false, "")
	fs.BoolVar(&help, "h", false, "")
	fs.BoolVar(&help, "help", false, "")
	fs.BoolVar(&strict, "strict", false, "")
	fs.Var(cli.ListValue{Items: &files}, "files", "")
	fs.StringVar(&apps, "apps", "", "")
	fs.StringVar(&scenario, "scenario", "", "")
	fs.StringVar(&md, "md", "", "")
	rest, err := cli.ParseInterspersed(fs, args)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy test: %v\nTry --help.\n", err)
		return cli.ExitUsage
	}
	if help {
		fmt.Fprint(io.Out, helpText)
		return cli.ExitOK
	}
	files = append(files, rest...)
	names, err := browsers.ParseList(browserList)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy test: --browsers: %v\n", err)
		return cli.ExitUsage
	}
	dir, err := dirOrCwd(root, io.Dir)
	if err != nil {
		fmt.Fprintf(io.Err, "ypy test: %v\n", err)
		return cli.ExitUsage
	}
	if suiteName == "e2e" {
		return e2e.Run(ctx, e2e.Options{
			Root: dir, Apps: apps, Scenario: scenario, Port: port, MD: md, Strict: strict,
			Browsers: names, ChromePath: chrome, Headed: headed, Logs: logs,
			ScenarioTimeout: scenarioTimeout, Out: io.Out, Err: io.Err, Env: io.Env,
		})
	}
	suite, ok := Suites[suiteName]
	if !ok {
		fmt.Fprintf(io.Err, "ypy test: unknown suite %q (use %s)\n", suiteName, strings.Join(SuiteNames(), ", "))
		return cli.ExitUsage
	}
	opts := Options{
		Root: dir, Suite: suite, Files: files, Browsers: names, Concurrency: concurrency, Grep: grep,
		Dist: dist, Port: port, Timeout: timeout, Verbose: verbose, Headed: headed, Logs: logs, ChromePath: chrome,
		Out: io.Out, Err: io.Err, IsTTY: io.IsTTY, Env: io.Env,
	}
	if serve {
		return Serve(ctx, dir, suite, port, dist, io.Out, io.Err)
	}
	if list {
		found, err := opts.files()
		if err != nil {
			fmt.Fprintf(io.Err, "ypy test: %v\n", err)
			return cli.ExitUsage
		}
		for _, f := range found {
			fmt.Fprintln(io.Out, f)
		}
		return cli.ExitOK
	}
	return Run(ctx, opts)
}
