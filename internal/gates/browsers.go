// SPDX-License-Identifier: MIT

package gates

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/ypy-develop/ypy/internal/browsers"
	"github.com/ypy-develop/ypy/internal/testrun"
)

// RequireFirefoxEnv, when set to 1, makes a missing Firefox or geckodriver fail the
// browser gate instead of falling back to Chrome. The GitHub workflow sets it.
const RequireFirefoxEnv = "YPY_REQUIRE_FIREFOX"

// ResolveBrowsers turns the --browsers option into the list the browser gate runs.
//
// Without an explicit list the default is chrome and, when Firefox can be driven,
// firefox. When it cannot: with require it is an error, otherwise the list is chrome
// and the warning says why Firefox was left out. An explicit list is used as given,
// except that with require the list must include firefox and Firefox must be ready.
func ResolveBrowsers(requested string, firefoxReady bool, why string, require bool) (list, warning string, err error) {
	if strings.TrimSpace(requested) == "" {
		switch {
		case firefoxReady:
			return "chrome,firefox", "", nil
		case require:
			return "", "", fmt.Errorf("Firefox is required (%s) but unavailable: %s", RequireFirefoxEnv+"=1", why)
		}
		return "chrome", "Firefox was left out: " + why + "; running Chrome only (the GitHub workflow requires Firefox)", nil
	}
	names, perr := browsers.ParseList(requested)
	if perr != nil {
		return "", "", perr
	}
	if require {
		hasFirefox := false
		for _, n := range names {
			hasFirefox = hasFirefox || n == browsers.Firefox
		}
		if !hasFirefox {
			return "", "", fmt.Errorf("Firefox is required (%s=1) but --browsers is %q", RequireFirefoxEnv, requested)
		}
		if !firefoxReady {
			return "", "", fmt.Errorf("Firefox is required (%s=1) but unavailable: %s", RequireFirefoxEnv, why)
		}
	}
	return strings.Join(names, ","), "", nil
}

func browserArgs(e *Env, extra ...string) []string {
	args := []string{"--root", e.Root, "--browsers", e.Browsers}
	if e.ChromePath != "" {
		args = append(args, "--chrome", e.ChromePath)
	}
	if e.Port != 0 {
		args = append(args, "--port", strconv.Itoa(e.Port))
	}
	return append(args, extra...)
}

// distSuites are the test files that run against the built files in dist/: the
// extension and security suites, and the parser the extensions share. Extensions
// reach the core only through the extension API; here the minified core is the
// one that must hold.
var distSuites = []string{"test/tests/ext/**/*.js", "test/tests/security/**/*.js", "test/tests/unit/HCON.js"}

// gateBrowser: the main suite against src/, then the extension
// and security suites against dist/ (the sizes gate, which runs before, has
// checked that dist/ is the build of the current sources), in the chosen browsers.
func gateBrowser(ctx context.Context, e *Env) Result {
	env := e.IO.Env
	if env == nil {
		env = os.Getenv
	}
	ready, why := browsers.FirefoxReady(env)
	list, warning, err := ResolveBrowsers(e.Browsers, ready, why, env(RequireFirefoxEnv) == "1")
	if err != nil {
		return Result{Err: err}
	}
	e.Browsers = list
	var warnings []string
	if warning != "" {
		warnings = append(warnings, warning)
	}
	fmt.Fprintf(e.Out, "-- browsers: %s\n", list)
	fmt.Fprintf(e.Out, "-- suite main\n")
	if code := testrun.Command().Run(ctx, browserArgs(e, "--suite", "main"), e.IO); code != 0 {
		return Result{Err: fmt.Errorf("suite main failed (exit %d)", code), Warnings: warnings}
	}
	fmt.Fprintf(e.Out, "-- suites ext and security against dist/\n")
	args := []string{"--suite", "main", "--dist"}
	for _, g := range distSuites {
		args = append(args, "--files", g)
	}
	if code := testrun.Command().Run(ctx, browserArgs(e, args...), e.IO); code != 0 {
		return Result{Err: fmt.Errorf("the extension and security suites failed against dist/ (exit %d)", code), Warnings: warnings}
	}
	return Result{Warnings: warnings}
}

// gateE2E: the end to end scenarios of the example app in Chrome, strict. The suite
// drives Chrome through the DevTools protocol, so Firefox cannot run it.
func gateE2E(ctx context.Context, e *Env) Result {
	args := []string{"--root", e.Root, "--browsers", "chrome", "--suite", "e2e", "--strict"}
	if e.ChromePath != "" {
		args = append(args, "--chrome", e.ChromePath)
	}
	if e.Port != 0 {
		args = append(args, "--port", strconv.Itoa(e.Port+100))
	}
	if code := testrun.Command().Run(ctx, args, e.IO); code != 0 {
		return Result{Err: fmt.Errorf("e2e suite failed (exit %d)", code)}
	}
	return Result{}
}
