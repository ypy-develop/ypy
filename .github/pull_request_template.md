## What and why

<!-- What does this change, and why is it needed? Link the issue or task. -->

Closes #

## How it was tested

<!-- Tests added or changed, and anything you checked by hand. -->

## Checklist

- [ ] Tests: new behavior has tests, and every bug fix has a test that failed before it.
- [ ] `ci/local/run.sh` passes on my machine (use `--all-browsers` for changes that touch the DOM or events).
- [ ] Traceability matrix updated: the rows this change affects (D# and C# in the mission matrix) have their status and the test that proves them.
- [ ] No behavior change for existing YPY markup, or the break has a decision record, a `ypy check` rule and was approved.
- [ ] Size: core stays at or under 18 kB min+gzip and each extension at or under 6 kB (`go run ./cmd/ypy build --sizes`).
- [ ] No runtime dependency added; new source files start with `// SPDX-License-Identifier: MIT`.
- [ ] Documentation updated (English and pt-BR where it exists) and `CHANGELOG.md` has an entry for user-visible changes.
- [ ] Product text says "YPY" and `go run ./cmd/ypy ci names` passes.
