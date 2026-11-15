---
name: ypy-release
description: Get a YPY change ready to push or release, and understand a failing gate. Use when the request is to "run the CI", "is this ready to push", "build dist", "the sizes gate fails", "the names gate found a forbidden name", "dist is out of date", "licenses gate fails", "cut a release" or "why does ypy ci fail", or before any push to this repository. Covers the gates of ypy ci and what each one checks, ypy build and the committed dist/, the 18 kB and 6 kB budgets, the forbidden-name gate that has no exceptions, and why there is no Node anywhere in the toolchain.
license: MIT
---

# Before a push, and before a release

One command runs, on your machine, every gate the GitHub workflow runs. The
workflow is a single Linux job that calls the same command, so a green local run
is the prediction of a green remote one:

```sh
go run ./cmd/ypy ci            # every gate, in order, Chrome only
ci/local/run.sh                # the same, with the Go toolchain go.mod pins
go run ./cmd/ypy ci --list     # the gates
go run ./cmd/ypy ci names sizes gen   # only some
go run ./cmd/ypy ci --browsers chrome,firefox,safari
```

`--skip` exists for working, never for pushing: a push goes out after a run with
nothing skipped and nothing red. Nothing is pushed, merged or tagged by a task
agent; the orchestrator integrates.

## The gates

| gate | fails when | what to do |
| --- | --- | --- |
| `names` | any tracked file or file name contains a forbidden name; the list is in `internal/gates/names.go` and **has no exceptions** | remove the word; never edit the list to make it pass |
| `licenses` | `src/` imports anything, or a Go module or vendored file has a license outside the allowlist | drop the dependency; the framework has none |
| `spdx` | a source file lacks `SPDX-License-Identifier: MIT` in its first lines | add the line as the first one |
| `gofmt`, `vet`, `test` | `gofmt -l`, `go vet ./...` or `go test ./...` | run each directly and read the output |
| `sizes` | `dist/` is not what `src/` builds to, or a file is over its budget | `go run ./cmd/ypy build`, then see below |
| `guide` | the generated rule tables of the upgrade guide are stale | `go run ./cmd/ypy check --gen-guide`, then commit the result (the gate runs it with `--check`) |
| `gen` | the editor data, the config schema, `ypy.d.ts` or the names used in the sources drift from `src/attributes.json` and `src/attributes.d/` | `go run ./cmd/ypy gen`, see `ypy-extension` |
| `browser` | the main suite, or the extension and security suites against `dist/`, fail | `ypy-testing` |
| `e2e` | a scenario of the example app fails, strict | `go run ./cmd/ypy test --suite e2e --strict` |
| `bench-smoke` | opt-in: a deterministic metric regressed against `bench/results/` | run it only by naming it |

## The build, and `dist/`

`dist/` is committed. It is what a user loads, and the `sizes` gate fails when
the committed bytes differ from what `src/` produces. After any change to
`src/`:

```sh
go run ./cmd/ypy build           # writes dist/: ypy.js, ypy.min.js, ESM, ypy.max, ext/, editors/, skills/
go run ./cmd/ypy build --check   # writes nothing, exits 1 on drift
go run ./cmd/ypy build --sizes   # the min+gzip table; exits 1 over a budget
```

`dist/` also carries the files without the source map comment, under `dist/embed/`
(`ypy.min.js`, `ypy.esm.min.js`, `ypy.max.min.js`, `ext/*.min.js`). The files of
`dist/` end with `//# sourceMappingURL=...map` and sit next to their `.map`, which
is what a CDN needs; someone who embeds only the `.min.js` would get a 404 in
DevTools, so tell them to take the `embed/` copy (README, "Source maps"). The
`embed/` files have no `.br`, no `.map` and no budget of their own; the sizes
gate measures the others.

Commit the rebuilt `dist/` in its own commit, after the commit that changed
`src/`, so the history says which change moved which bytes. `src/skills/**/*.md`
is copied as it is to `dist/skills/`; `src/editors/**` too.

## The version

The version of the framework is written once, in the file `VERSION` at the
root. The build stamps it into `this.version` of the core, so `dist/ypy.js`,
`dist/ypy.min.js`, the ES module and `ypy.max` (`-max` is added) all report it;
`ypy gen` writes it into `src/editors/jetbrains/ypy.web-types.json`; `cmd/ypy`
reads it with `go:embed` (package `ypy` at the root, `ypy.Version()`).
`src/ypy.js` keeps the same literal so the tests run from `src/`, and
`version_test.go` fails when VERSION, `src/ypy.js`, the web-types and the files
of `dist/` disagree. To release a version, in this order: edit `VERSION` and the
`this.version` line of `src/ypy.js`, run `go run ./cmd/ypy gen` and
`go run ./cmd/ypy build`, commit `dist/`, and only then does the orchestrator
tag. Never tag before `dist/` was rebuilt: a tag must publish a build that
reports its own version. Right before the tag, run
`YPY_RELEASE_TAG=vX.Y.Z go test -run 'TestReleaseTag|TestVersion' .`: it fails
when the tag is not `v` + VERSION or VERSION has a suffix such as `-dev`. The
same test runs in CI on every pushed `v*` tag and on a HEAD that carries one.

## The budgets

The core may be 18432 bytes min+gzip (18 kB), each extension 6144 (6 kB), measured
at gzip level 9. `ypy.max` and the module build have no budget. At the time of
writing the core is at 99 % of its budget; read the real table before promising
that something fits. Going over is never fixed by raising the number: it is a
project principle, and changing it needs an ADR.

## The names gate

The project has one name, and the gate keeps it that way. It scans every tracked file and file name, so a single
word in a comment, a fixture, or a test title fails it, and a failing gate stops the push. When it fails:

```sh
go run ./cmd/ypy ci names       # prints the file and the line
```

Fix the text. A test that needs old-style input for `ypy check` or `ypy migrate` builds the
text from pieces at run time (`strings.Join` in `internal/check/check_test.go`,
`join` in `internal/gates/names.go`), so the file itself stays clean.

## No Node

There is no `package.json`, no `npm`, no bundler and no `node_modules`, and
there will not be one. The minifier is a Go library, the browser suites are
driven by the Go tool, and Mocha and Chai are vendored into the binary. A task
that seems to need `npm` means a Go package in `internal/` is missing. The Go
version is the one `go.mod` pins (`toolchain` line), and `ci/local/run.sh`
exports it.

## Before you say it is done

1. `ci/local/run.sh` is green with nothing skipped.
2. `git status --short` shows no stray file: no `CLAUDE.md`, no build output
   outside `dist/`, no copy of another project.
3. Commits are small, in English, with a short imperative subject, made with the
   identity configured in the repository and without `--author`.
4. Nothing is pushed, tagged or published: a release, a tag and a package name
   are decisions of the author.
