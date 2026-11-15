---
name: ypy-core
description: Change the YPY core, the single file src/ypy.js that ships as ypy.min.js. Use when the request is to "add an attribute", "add an event", "add a config key", "fix the swap", "change how the request is issued", "make the core smaller", "the size gate fails", "ypy.min.js is over budget", or when a pull request touches src/ypy.js or src/ypy.d.ts. Covers how the file is divided into sections, the 18 kB budget and how little of it is left, the helpers a new attribute, event and state must go through, the double-underscore names the tests call, and what the core may never contain.
license: MIT
---

# Changing the core

The core is one file, `src/ypy.js`, an IIFE that assigns `var ypy`. The build
turns it into `dist/ypy.js`, `dist/ypy.min.js` and the ESM files. There is no
bundler to configure and no module graph: if a thing is not in that file, it is
an extension.

## The budget comes first

`dist/ypy.min.js` may be at most 18 kB min+gzip, and 1 kB is 1024 bytes, so
18432 bytes. Measure it, do not estimate it:

```sh
go run ./cmd/ypy build
gzip -9 -c dist/ypy.min.js | wc -c          # the gate uses level 9
go run ./cmd/ypy ci sizes                   # the table, with the headroom
```

At the time this was written the core measured 18253 bytes, 99 % of the budget.
That is 179 bytes of room. A feature that costs a kilobyte does not fit, and the
answer is almost never "raise the budget": it is an extension (`ypy-extension`),
or a smaller version of the same code. The budget is a principle of the project
(`CONTRIBUTING.md`, rule 2); changing it needs an ADR and the maintainers, not a
commit.

## How the file is divided

Code is grouped by `// SECTION <name>: <what it holds>` markers. A section
appears again as `(cont.)` where related code was kept apart. List them with:

```sh
grep -n "SECTION" src/ypy.js
```

| section | holds |
| --- | --- |
| `config` | construction, `__initConfig`, `registerExtension`, the extension registry |
| `attributes` | prefixes, `__attributeValue`, inheritance, attribute objects, element queries |
| `processing` | `process`, element state, boosting, cleanup, preserved elements, state classes |
| `request` | the request context and its phases, indicators, form values, abort, status rules |
| `swap` | parsing a response, OOB and partials, the swap phases, view transitions |
| `morph` | the morphing algorithm |
| `history` | push, replace, restore |
| `events` | trigger specifications, `__trigger`, `ypy-on` |
| `security` | running author JavaScript, parsing HTML, re-creating scripts |
| `a11y` | focus and scroll helpers, busy state, announcements |
| `offline` | connection state and failure kinds |

Put new code in the section that owns the responsibility. Do not move existing
code to tidy a diff: the history is how the next person finds out why it is
there.

## The rules a change follows

1. **A new attribute is read through `__attributeValue(elt, 'ypy-<name>')`.**
   The resolver adds the `ypy-` and `data-ypy-` spellings and `config.prefix`.
   Calling `getAttribute('ypy-...')` yourself skips the prefix and the
   inheritance rules.
2. **A new event is named `ypy:<noun>:<verb>` and fired through the event
   helpers** (`__trigger`, or `__triggerNative` for one that is not an
   extension hook). Extensions receive the same event as a hook named with
   underscores: `ypy:before:swap` is `ypy_before_swap`.
3. **A new state of an element goes through `__setState`**, which sets the
   configured classes and `data-ypy-state` together.
4. **All state of the trigger, request, swap life cycle lives on `ctx`.** Pick
   a property name nobody uses; the properties of `ctx` are public API and have
   to be in `src/ypy.d.ts`.
5. **Double-underscore names are private to the file and public to the tests.**
   The build rewrites `__name` to `#name`, so a unit test can call it in `src/`
   and nobody can call it in `dist/`. Never rename one and never change its
   parameters: more than forty test files call them. Add a new name instead.
   Names with one underscore are "internal": they may change, and an extension
   that needs one gets it through the internal API passed to `init`.
6. **The orchestrators only order phases.** `__issueRequest`, `swap`,
   `__insertContent` and `initialize` call phase functions; put logic in the
   phase, not in the orchestrator.
7. **A public method is forever.** Public names are not abbreviated, except
   `Config`.

## Style

`let`, not `const`. `for` loops, not `forEach`. Curly braces on every `if`.
Local names are descriptive: the minifier shortens them, so short names buy no
bytes. Every file starts with `// SPDX-License-Identifier: MIT`, and every
function has JSDoc.

## What the core must never contain

- `eval` and `new Function` in the default mode (the gated path goes through
  `initSecurity`, which only the CSP extension fills in).
- Inline styles and inline scripts that a strict CSP would block.
- A second spelling of anything. There is one name, `ypy`: attributes `ypy-*`
  and `data-ypy-*`, events `ypy:*`, headers `YPY-*`, classes `ypy-*`. There is no
  switch that restores another library's behaviour.
- A runtime dependency, an import or a `require`.
- A default that depends on inheritance from an ancestor: inheritance is
  explicit, with `:inherited`.

## Finishing a change

Every item is a command that has to be green:

```sh
go run ./cmd/ypy gen                      # after touching a name; see ypy-extension
go run ./cmd/ypy build                    # dist/ is committed and the sizes gate compares it
go run ./cmd/ypy test                     # the main browser suite
go run ./cmd/ypy ci sizes names spdx gen  # the cheap gates
```

Edit `src/ypy.d.ts` for any public change, in the same commit as the code:
`ypy gen --check` fails when the events and config keys of the file differ from
the table in `src/attributes.json`. Add the name to that table too; the
description and the value type are what the editors show. The test comes first:
`ypy-testing` says where it lives.
