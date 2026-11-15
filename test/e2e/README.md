<!-- SPDX-License-Identifier: MIT -->
# End to end suite: the example app

Acceptance test of the example server. `examples/native` is a small app written in the native YPY
idiom: `ypy-*` attributes, `YPY-*` headers in the Go backend, `ypy-sse:connect`, `ypy-ws:connect`,
`ypy-on::after:request` and the `ypy:` event names. It loads `ypy.min.js` from `dist/`.

    go run ./cmd/ypy build                      # the suite serves dist/
    go run ./cmd/ypy test --suite e2e           # Chrome
    go run ./cmd/ypy test --suite e2e --scenario crud
    go run ./cmd/ypy test --suite e2e --md matrix.md --strict

- The harness is Go (`internal/e2e`): it builds and starts the example server (`examples/server`,
  standard library only), drives Chrome through the DevTools protocol (chromedp), runs the scenarios
  and prints the result matrix. `--strict` exits 1 when any scenario fails; `--scenario TEXT` runs
  the scenarios whose name contains the text; `--port N` is the first port to try (the next free one
  is used).
- Environment: `YPY_DIST` (a file or a directory; default `dist/`), `YPY_EXTRA` (extra scripts after
  the core), `CHROME_BIN` or `--chrome PATH` (a Chrome other than the discovered one).
- The scenarios are in `internal/e2e/scenarios.go`: CRUD, active search, headers, infinite scroll,
  validation, SSE, WebSocket and event names.
