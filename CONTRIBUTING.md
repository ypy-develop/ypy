# Contributing to YPY

Thank you for your interest in YPY, a hypermedia framework: HTML over the wire
with attributes, no build step for the people who use it. Bug reports, small
fixes, tests and documentation are as welcome as new code.

## Ground rules

These are the project's principles. A change that breaks one needs an ADR
(the ADRs, kept in the project control repository) and the maintainers' approval before code is written.

1. **One name.** YPY reads and writes the `ypy` names only: `ypy-*` and
   `data-ypy-*` attributes, `<ypy-partial>`, `YPY-*` headers, the global `ypy`,
   events `ypy:*` and classes `ypy-*`. Projects written before YPY are
   converted by `ypy migrate`; there is one behavior and no compatibility
   layer. New features are added on top and never alter existing
   behavior.
2. **Small core.** The core is at most 18 kB min+gzip and each official
   extension at most 6 kB. The size gate fails the build otherwise.
3. **Zero runtime dependencies.** The framework imports nothing. The tools
   are Go (the `ypy` binary); their Go dependencies are checked by the license
   gate, and the project has no Node toolchain.
4. **Secure by default.** No `eval` and no `new Function` in the default mode,
   and no inline styles or scripts that a strict CSP would block.
5. **Style-agnostic.** YPY never imposes CSS. Every class it applies is
   configurable, and states are also exposed as attributes.
6. **Progressive enhancement.** Links and forms keep working without
   JavaScript.
7. **Explicit over magic.** No surprise behavior inherited from ancestors.

## Setup

You need Go 1.26 or later (`go.mod` pins the toolchain, currently go1.26.11, which
the `go` command downloads on its own) and, for the browser tests, Google Chrome or
Chromium. Nothing else is installed: there is no `npm`, no `node_modules`.

```sh
go run ./cmd/ypy --help      # the ypy binary: build, check, test, ci
```

## Running the checks

`go run ./cmd/ypy ci` runs, on your machine, the same gates as the GitHub
workflow, in order, and prints a summary. **Run it and see it green before
every push.** `ci/local/run.sh` is a one-line wrapper of it.

```sh
go run ./cmd/ypy ci                           # every gate; Chrome, and Firefox when geckodriver is found
go run ./cmd/ypy ci --browsers chrome,firefox,safari  # also Safari where it can run
go run ./cmd/ypy ci names sizes               # only some gates (--list shows them)
go run ./cmd/ypy ci --skip browser,migration  # leave some out, never before a push
```

The GitHub workflow also installs the TypeScript compiler outside the
repository (the pinned release from the npm registry, checked against a SHA-256,
in the runner's temporary directory; the repository has no `package.json`) and sets
`YPY_REQUIRE_TSC=1`, so the test that compiles `src/ypy.d.ts` with `tsc --noEmit`
(`internal/gen/tsc_test.go`) fails there instead of skipping. On your machine it
still skips when `tsc` is not installed; set `YPY_REQUIRE_TSC=1` to make it fail.

The gates, which can also be run alone as `ypy ci <name>`:

| Gate | What it checks |
| --- | --- |
| `names` | No file tracked by git, and no file name, contains a forbidden name (the list is in `internal/gates/names.go`). It has no exceptions. |
| `licenses` | The framework in `src/` imports nothing; the Go modules of the tool (`go list -m all`) and the vendored files have permissive licenses from an explicit allowlist (no GPL, AGPL, LGPL, MPL, no unknown). |
| `spdx` | `SPDX-License-Identifier: MIT` in the first lines of every source file (`src/`, Go). |
| `gofmt`, `vet`, `test` | `gofmt -l`, `go vet ./...` and `go test ./...` are clean. |
| `sizes` | `dist/` is what `src/` builds to, and core and extension sizes, min+gzip, are within the budgets. |
| `browser` | The `main` browser suite passes in the chosen browsers, and the extension and security suites also pass against the built `dist/` files. Without `--browsers` it runs Chrome and, when `geckodriver` and Firefox are found, Firefox too; if Firefox is missing it warns and runs Chrome only. With `YPY_REQUIRE_FIREFOX=1`, which the GitHub workflow sets, a missing Firefox fails the gate. Safari stays opt-in (`--browsers chrome,firefox,safari`). |
| `e2e` | The end to end scenarios of the example app, strict. They drive Chrome through the DevTools protocol, so they run in Chrome only. |
| `migration` | The migration matrix (example apps, four apps by 19 scenarios) passes, strict. |
| `bench-smoke` | Opt-in, so `ypy ci` does not run it: a quick benchmark of the deterministic metrics (events per request, focus kept by a morph, nodes and listeners left by a session, size) against the latest result in `bench/results/`, threshold 0. Run it as `ypy ci bench-smoke`. |

## Running the tests

`ypy test` runs the browser suites. It serves `src/`, `test/` and the vendored
mocha and chai from a local server, opens every test file in a fresh page and
collects the results. The details are in [the testing guide](https://ypy.dev/docs/contributing/testing).

```sh
go run ./cmd/ypy test                               # the main suite, in Chrome
go run ./cmd/ypy test --suite migration --strict    # the migration matrix
go run ./cmd/ypy test --grep 'ypy-swap' test/tests/unit/swap.js
go run ./cmd/ypy test --browsers chrome,safari,firefox
go run ./cmd/ypy build && go run ./cmd/ypy test --dist --files 'test/tests/ext/**/*.js' --files 'test/tests/security/**/*.js'
go run ./cmd/ypy test --serve                       # serve the repository, for test/manual
```

With `--dist` the pages load the built, minified files of `dist/` wherever a test
asks for `src/ypy.js` or `src/ext/*.js`, which is what a user loads: the core's
`__x` members are private fields there. A test that calls one is written with
`itSource` and is skipped in that mode; extensions must use the extension API.

Chrome is found on its own (`--chrome PATH` or `CHROME_BIN` to choose one).
Safari runs through `safaridriver`, which ships with macOS; Firefox runs
through `geckodriver` (`brew install geckodriver`). A browser that cannot run
is reported as skipped with the exact step to take, never silently. Safari
needs two things only you can do, and `ypy` never runs anything with `sudo`:
tick *Allow Remote Automation* in Safari's Develop menu, and run
`safaridriver --enable` once in a terminal of your own (it asks for the
administrator password).

## Benchmarks

`ypy bench` measures a build in Chrome, with the scenarios in `bench/pages/`. It
needs the same Chrome as `ypy test` and nothing else.

```sh
go run ./cmd/ypy bench                          # dist/ypy.min.js, 5 rounds, writes bench/results/<date>-<sha>.json
go run ./cmd/ypy bench --quick --filter 'swap'  # a smoke run, not a result
go run ./cmd/ypy bench --ref <commit>           # the build of another commit, for A/B
go run ./cmd/ypy bench compare A.json B.json    # REGRESSION above 5 %, "~" when inside the noise
go run ./cmd/ypy bench show A.json --md         # a stored result as a Markdown table
go run ./cmd/ypy bench profile swap.innerHTML.1000 --build dist/ypy.js
```

Quiet machine, nothing else running, and compare only runs made back to back:
the same build drifts by 10 to 15 % over hours. A change in the request path or
the swap code comes with a before and after (`bench compare`) in its pull
request. The [performance plan](https://ypy.dev/docs/performance/plan) explains how to read the numbers.

## Making a change

The code style of the core is in [coding standards](https://ypy.dev/docs/contributing/coding-standards)
and its map in [core map](https://ypy.dev/docs/contributing/core-map).

- **Branches.** Work on a topic branch from `develop` and open a pull request
  to `develop`. `main` only receives fast-forwards of commits already
  validated on `develop`.
- **Tests first.** Every new behavior has a test, and every bug fix has a test
  that fails without the fix. Tests live in `test/`.
- **Traceability.** Each deficiency and competitor-inspired feature in the
  project matrix maps to a task, a test and a documentation entry. Update the
  status of the rows your change touches in the pull request.
- **Source files.** Start every source file with
  `// SPDX-License-Identifier: MIT`. Use modern JavaScript (ES2020 or later),
  complete JSDoc, and keep code in clearly delimited sections by
  responsibility. Follow `.editorconfig`.
- **Documentation.** User documentation is written in English and pt-BR;
  technical text (code, comments, ADRs) is in English.
- **Commits.** Small commits with a short imperative subject in English
  ("Add error target fallback"). One logical change per commit.
- **Pull requests.** Fill in the template. A pull request is ready when CI is
  green, tests and docs are included, and the checklist is honest.

## Reporting problems

Use the issue templates for bugs and feature requests. Report security
vulnerabilities privately, as [`SECURITY.md`](SECURITY.md) describes.

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), copyright HYZIS - SERVICOS DIGITAIS LTDA - EPP.
