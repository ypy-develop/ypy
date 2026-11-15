---
name: ypy-testing
description: Write, place and run a test in the YPY repository, whose browser suites run under the Go tool ypy test. Use when the request is to "add a test", "cover this case", "the suite is failing", "run the tests", "test this in Firefox or Safari", "this test passes in src and fails in dist", "where does this test go", or "write a test that fails without the fix". Covers the Chrome, Firefox and Safari runners, the directories under test/tests and what each holds, the --dist mode and itSource, the helpers in test/lib/helpers.js, the Go tests, and how to prove a test fails without the fix.
license: MIT
---

# Writing a test here

Tests run in a real browser, driven by the Go tool, with Mocha and Chai built
into the binary. There is no `npm`, no `node_modules`, no jsdom.

## Running

```sh
go run ./cmd/ypy test                                  # the main suite, in Chrome
go run ./cmd/ypy test test/tests/attributes/ypy-get.js # one file
go run ./cmd/ypy test --grep 'morph'                   # tests whose title matches
go run ./cmd/ypy test --headed --logs                  # watch it, and print the page console
go run ./cmd/ypy test --browsers chrome,firefox,safari
go run ./cmd/ypy test --suite e2e --strict             # the example app, end to end
go run ./cmd/ypy test --list                           # every file the suite would run
go run ./cmd/ypy test --serve                          # serve the repository for test/manual
```

Chrome is found on its own (`--chrome PATH` or `CHROME_BIN` to choose one).
Firefox needs `geckodriver`. Safari needs `safaridriver`, with *Allow Remote
Automation* ticked in the Develop menu and `safaridriver --enable` run once by
a person, because it asks for the administrator password; the tool never runs
`sudo`. A browser that cannot run is reported as skipped with the step to take,
never silently.

## Where a test goes

One new file per change, in the directory that matches what it exercises:

| directory | what it holds |
| --- | --- |
| `test/tests/unit/` | calls one function directly, public or `__private`; named after the function |
| `test/tests/attributes/` | an attribute end to end: `mockResponse()`, a processed element, a click, `await` the `ypy:finally:request` event, assert on the DOM |
| `test/tests/end2end/` | a behaviour that spans several attributes: history, morph state, offline, multi-target |
| `test/tests/ext/` | one file per extension, named like it |
| `test/tests/security/` | what a hostile response or a strict CSP must not be able to do |
| `test/tests/css/` | the state classes and the stylesheet |
| `test/e2e/`, `internal/e2e/` | scenarios against `examples/server`, run in Chrome, Firefox and Safari (`--suite e2e --browsers ...`); a new scenario is a `Register(...)` call in its own file, see `internal/e2e/scenarios.go` |

Do not edit another change's test file to make yours pass. A file starts with
`setupTest(this)` and ends cleaned up by the helper; `test/lib/helpers.js` has
`setupTest`, `cleanupTest`, `mockResponse`, `createProcessedHTML` and the rest.

## A test that fails without the fix

A fix with a test that passes before the fix proves nothing. Prove it:

```sh
git stash push -- src/ypy.js            # take the fix away, keep the test
go run ./cmd/ypy test test/tests/attributes/ypy-example.js   # must fail, for the reason you expect
git stash pop
go run ./cmd/ypy test test/tests/attributes/ypy-example.js   # must pass
```

Say in the commit message what the test fails with. Also add a test that shows
what stays the same: a new behaviour is half of the contract.

## `src` and `dist`

By default the pages load `src/ypy.js` and `src/ext/*.js`, where private names
are `__name`. With `--dist` they load the minified files of `dist/`, where a
private name is a `#field` nobody can call, so run `go run ./cmd/ypy build`
first:

```sh
go run ./cmd/ypy build && go run ./cmd/ypy test --dist \
  --files 'test/tests/ext/**/*.js' --files 'test/tests/security/**/*.js'
```

A test that calls a `__name` is written with `itSource` (or `describeSource`),
which runs it against `src/` and reports it as skipped with `--dist`. An
extension test must use the extension API, so it never needs `itSource`. A
script `dist/` does not have is a 404, never a fallback to `src/`.

## The Go tests

The tools are Go, and their tests sit beside the code in `internal/<pkg>/*_test.go`:

```sh
go test ./internal/build/... ./internal/gen/... ./internal/gates/...
go test -race ./...
```

The build tests use a fixture repository in a temp directory
(`fixtureRoot` in `internal/build/build_test.go`), so they pass whatever is in
`dist/`.

## Do not

- Sleep for a fixed time to wait for a swap. Await the event the behaviour fires.
- Leave a listener, timer or node behind: the next test shares the page's process.
- Put a test of an extension in `unit/`, or a unit test in `attributes/`.
- Add a test that needs the network. `mockResponse` is the server.
