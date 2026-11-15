<!-- SPDX-License-Identifier: MIT -->
# End to end suite: the example app

Acceptance test of the example server. `examples/native` is a small app written in the native YPY
idiom: `ypy-*` attributes, `YPY-*` headers in the Go backend, `ypy-sse:connect`, `ypy-ws:connect`,
`ypy-on::after:request` and the `ypy:` event names. It loads `ypy.min.js` from `dist/`.

    go run ./cmd/ypy build                      # the suite serves dist/
    go run ./cmd/ypy test --suite e2e           # Chrome
    go run ./cmd/ypy test --suite e2e --browsers chrome,firefox,safari
    go run ./cmd/ypy test --suite e2e --scenario crud
    go run ./cmd/ypy test --suite e2e --md matrix.md --strict

- The harness is Go (`internal/e2e`): it builds and starts the example server (`examples/server`,
  standard library only), drives the browsers, runs the scenarios and prints the result matrix, one
  table per browser. Chrome is driven through the DevTools protocol (chromedp); Firefox
  (`geckodriver`) and Safari (`safaridriver`, once `safaridriver --enable` was run and Allow Remote
  Automation is ticked) through WebDriver, with `internal/browsers`. Both sit behind one `Driver`
  interface (`internal/e2e/driver.go`: open a page, run script, click, type, history, console), so a
  scenario written with the `Page` helpers runs unchanged in all three. A browser that is not
  installed is reported as skipped, with the step to take. Firefox and Safari run one scenario at a
  time, each in a window of its own.
  The `e2e` gate of `ypy ci` uses the browsers of the `browser` gate (`--browsers`; Chrome and
  Firefox by default when `geckodriver` exists). `--strict` exits 1 when any scenario fails; `--scenario TEXT` runs
  the scenarios whose name contains the text; `--port N` is the first port to try (the next free one
  is used).
- Environment: `YPY_DIST` (a file or a directory; default `dist/`), `YPY_EXTRA` (extra scripts after
  the core), `CHROME_BIN` or `--chrome PATH` (a Chrome other than the discovered one).
- The first scenarios are in `internal/e2e/scenarios.go`: CRUD, active search, headers, infinite
  scroll, validation, SSE, WebSocket and event names.
- To add scenarios, put them in a new file of `internal/e2e` and register them from an `init`
  function with `Register(Scenario{Name: "area/what", Run: func(e *Env) { ... }})`; the comment at the
  top of `scenarios.go` says how a scenario is written. A scenario that cannot run in one browser
  says so with `Skip: map[string]string{"safari": "reason"}`; the matrix prints it as `skip` with the
  reason, and it does not count as a failure. Routes the scenarios need go in `examples/server`.
- Firefox and Safari report the page console only from the first command that ran in the document
  (WebDriver has no console feed), and a pointer click that Safari drops is repeated, then made
  through the page.
