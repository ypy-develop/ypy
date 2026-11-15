---
name: ypy-extension
description: Write, change or remove an official YPY extension, a file in src/ext/. Use when the request is to "add an extension", "make this optional", "move this out of the core", "add an attribute to ypy-sse", "the extension is over 6 kB", "ypy gen --check fails", "add it to ypy.max", or when a pull request touches src/ext/, src/attributes.d/ or the maxExtensions list in internal/build. Covers the registration call and the hooks, the internal API passed to init, the JSON fragment that names every attribute, event and config key, ypy gen, the 6 kB budget, and what decides whether an extension joins the ypy.max bundle.
license: MIT
---

# Writing an extension

An extension is one IIFE in `src/ext/<name>.js` that calls
`ypy.registerExtension(name, hooks)`. It is how a feature stays out of the
18 kB core. Everything the core exposes to it is below; an extension that needs
more asks for a new hook in the core (`ypy-core`), it does not reach for a
private name.

## What you are producing

Three files, committed together:

| file | what it is |
| --- | --- |
| `src/ext/ypy-<name>.js` | the code, starting with `// SPDX-License-Identifier: MIT` and a header comment with usage and options |
| `src/attributes.d/ypy-<name>.json` | the names it adds: attributes, events, config keys, headers, classes |
| `test/tests/ext/ypy-<name>.js` | the tests (see `ypy-testing`) |

The file name is the registration name, with the `ypy-` prefix. The name is
case-sensitive and it is what the `ypy.config.extensions` allow-list matches.

## The code

```js
(() => {
    let api;

    ypy.registerExtension('ypy-example', {
        init(internalAPI) {
            api = internalAPI;
        },
        ypy_before_request(elt, detail) {
            if (api.attributeValue(elt, 'ypy-example') == 'false') return;
            // ...
        },
    });
})();
```

- **Hook names are event names with the colons turned into underscores**:
  `ypy:before:request` is `ypy_before_request`, `ypy:after:swap` is
  `ypy_after_swap`. The core calls every registered function with
  `(elt, detail)`. A hook that returns `false` cancels the thing the event
  guards, the same as `preventDefault()` on the DOM event. `handle_swap` is the one
  hook that is not an event: it takes over the swap of a style the core does not
  know. List the hooks the existing extensions use with
  `grep -ho "^ *ypy_[a-z_]*" src/ext/*.js | sort | uniq -c | sort -rn`.
- **`init(api)` receives the internal API**: `attributeValue`, `getAttributeObject`,
  `parseTriggerSpecs`, `createRequestContext`, `collectFormData`, `insertContent`,
  `morph`, `ypyProp`, `triggerEvent`, `onTrigger`, `HCON`, among others. See the
  object built in the `config` section of `src/ypy.js`. Read an attribute with
  `api.attributeValue`, never with `getAttribute`: it adds the `data-` spelling,
  the prefix and inheritance.
- **Options come from the attribute value, then `ypy.config.<name>`**, parsed
  with `api.HCON.parse`. An attribute value of `false` leaves the element to the
  core.
- **Nothing inline.** No `style` attribute, no `<style>` the page did not allow,
  no `eval`, no `new Function`. A style a feature needs is a class the application
  styles, or a rule in `src/css/ypy.css`. The security suite fails on the rest.
- **Clean up.** A hook on `ypy_before_cleanup` removes every listener, timer and
  observer the element got in `ypy_after_process` or `ypy_after_init`. A page
  that swaps for hours must not grow.

## The fragment

Every name the extension introduces goes in `src/attributes.d/ypy-<name>.json`,
shaped like `src/attributes.d/ypy-poll.json`: `extension`, then `attributes`
(`name`, `description`, `valueType`, `syntax`, `values`, `modifiers`,
`inherited`), `events` (with `detail`), `config` and `headers` where there are
any. The description is what an editor shows on hover, so write it for the
person who has not read the source.

Then generate and check:

```sh
go run ./cmd/ypy gen          # writes the VS Code data, the JetBrains web-types and the config schema
go run ./cmd/ypy gen --check  # writes nothing; exit 1 on any drift
```

`gen --check` fails in three cases, and each one names the file: a generated
file is out of date, `src/ypy.d.ts` disagrees with the table about events and
config keys, or the sources use a `ypy-` name the table does not have. Add the
extension's public API to `src/ypy.d.ts` the way `ypy.stream` and `ypy.signals`
are declared.

## The budget, and `ypy.max`

Each `dist/ext/<name>.min.js` may be at most 6 kB min+gzip (6144 bytes, level 9).
The table shows the headroom of all of them:

```sh
go run ./cmd/ypy build && go run ./cmd/ypy ci sizes
```

If it does not fit, split it: a second extension that the first does not need
is better than a budget raised. The budgets are in `internal/build/sizes.go` and
changing one is an ADR, not a commit.

An extension joins the `ypy.max` bundle only by being in the `maxExtensions`
list of `internal/build/config.go`, in load order. Seven of them are not there
today and stay separate files: `ypy-csp`, `ypy-dev`, `ypy-head`,
`ypy-inspector`, `ypy-multipart`, `ypy-prompt` and `ypy-ptag`. Check the list
before deciding, because it changes. Add a name only when every page that loads
`ypy.max` should get the extension; the build test `TestGenerateAllParts` walks
the same list, so a name that has no file in `src/ext/` fails it.

## Before you commit

```sh
go run ./cmd/ypy gen --check
go run ./cmd/ypy build
go run ./cmd/ypy test test/tests/ext/ypy-<name>.js
go run ./cmd/ypy test --dist --files 'test/tests/ext/**/*.js' --files 'test/tests/security/**/*.js'
```

The last one runs the same tests against the minified file users load. A test
that fails only there called a private name; the extension must use the
extension API.
