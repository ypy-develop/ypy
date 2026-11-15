// SPDX-License-Identifier: MIT

package testrun

import (
	"fmt"
	"html"
	"net/url"
	"strings"
)

// Suite describes one test suite: which files it runs and the page every file
// runs in.
type Suite struct {
	Name string
	// Globs select the test files, relative to the repository root.
	Globs []string
	// Timeout is the mocha timeout of one test in milliseconds.
	TimeoutMS int
	// page is the HTML of a test page; RUNNER is replaced by the script tag
	// that runs the file.
	page string
}

// Suites are the browser suites of the repository. The "e2e" suite is
// not here: it drives the example app, see internal/e2e.
var Suites = map[string]Suite{
	"main": {
		Name:      "main",
		Globs:     []string{"test/tests/**/*.js"},
		TimeoutMS: 2000,
		page: `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>YPY Tests</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="ypy-config" content='{"logAll":false}'>
    <script src="/__ypy__/boot.js"></script>
    <script src="/__ypy__/mocha.js"></script>
</head>
<body>

<h2>YPY Test Suite</h2>

<script src="/__ypy__/chai.js"></script>
<script src="/test/lib/fetch-mock.js"></script>
<script src="/src/ypy.js"></script>

<script class="mocha-init">
    window.should = window.chai.should()
    window.assert = window.chai.assert
</script>

<script src="/test/lib/helpers.js"></script>
RUNNER

<div id="test-playground"></div>

</body>
</html>`,
	},
}

// SuiteNames lists the names of the browser suites plus the e2e suite.
func SuiteNames() []string { return []string{"main", "e2e"} }

// Page renders the HTML for one test file.
func (s Suite) Page(file, grep string) string {
	q := url.Values{}
	q.Set("file", "/"+strings.TrimPrefix(file, "/"))
	q.Set("timeout", fmt.Sprint(s.TimeoutMS))
	if grep != "" {
		q.Set("grep", grep)
	}
	tag := fmt.Sprintf(`<script type="module" src="/__ypy__/runner.js?%s"></script>`, html.EscapeString(q.Encode()))
	return strings.Replace(s.page, "RUNNER", tag, 1)
}
