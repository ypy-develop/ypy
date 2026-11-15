---
name: ypy-migrate
description: Move an existing project to YPY, or check that it is moved. Use when the request is to "convert this project to YPY", "migrate the templates", "rename the attributes, headers and events", "what breaks when we switch", "run ypy migrate", "run ypy check", or when a project's HTML, server code or scripts use attributes, headers, events or an extension written for markup that came before YPY. Covers the report-then-write order, what ypy check classifies (quebra, muda, aviso), what ypy migrate converts and what it only lists, the flags that teach it the project's prefix, and the checks to run afterwards.
license: MIT
---

# Moving a project to YPY

Two commands, both in the `ypy` binary (`go run ./cmd/ypy` from this repository,
or the installed `ypy`). **`ypy check` reads and tells; `ypy migrate` rewrites.**
Neither needs the network, and neither touches `node_modules`, `vendor`, `dist`,
`build`, `.git`, minified or binary files.

## The order

1. **Commit or stash** what is in the working tree. Migration is a diff you review.
2. **Check first.**

```sh
ypy check .                       # human report
ypy check . --json > check.json   # one JSON document, schema 1
ypy check --list-rules            # every rule, its severity and what it means
```

   Each finding has a severity:

   | severity | meaning | what to do |
   | --- | --- | --- |
   | `quebra` | stops working after the move | fix by hand; the migrator cannot |
   | `muda` | works but behaves differently | read it; decide |
   | `aviso` | only the spelling changes | `ypy migrate` converts it |

   and a confidence: `high` (the project's own identifier is evidenced, or the
   construct is unambiguous) or `medium`. Useful filters:
   `--min-severity muda`, `--min-confidence high`, `--only RULE`,
   `--ignore RULE`, `--fail-on quebra|muda|aviso|never` (the exit code; default
   `quebra`), `--ext .tmpl,.gohtml` to scan more template extensions.

3. **Dry-run the migration.** Without `--write` it prints a unified diff and
   changes nothing:

```sh
ypy migrate .
```

4. **Apply it**, then check again:

```sh
ypy migrate --write .
ypy check .      # should report no aviso; only quebra and muda remain, if any
git diff --stat
```

   Running `--write` twice changes nothing the second time.

## What it converts

Only in a context it recognises: an attribute inside a tag, a string, a
selector, a template expression, never running text.

| what | becomes |
| --- | --- |
| attributes `<prefix>-name`, `data-<prefix>-name` | `ypy-name`, `data-ypy-name` |
| the partial tag | `<ypy-partial>` |
| request and response headers (also `Vary` and `HTTP_<PREFIX>_NAME` in server code) | `YPY-Name` |
| events `<id>:name` | `ypy:name` |
| the old global object and its methods | `ypy.method` |
| state classes (`-request`, `-indicator`, ...) | `ypy-request`, `ypy-indicator`, ... |
| extension scripts and their attributes | `ypy-sse.js`, `ypy-sse:connect`, `ypy-ws:send` |
| identifiers in code (`<P>Target`, `<p>On`, `<p>_request`; `Is<P>`/`Has<P>` in Go) | `YpyTarget`, `ypyOn`, `ypy_request`, `IsYPY`, `HasYPY` |
| the `extensions` setting | `"ypy-sse,ypy-ws"` |
| the library script tag name | `ypy.min.js` |

It reads the project to learn the old prefix and identifier. Teach it when the
project does not reveal them:

```sh
ypy migrate --prefix acme --id acme .          # prefix and identifier of the old markup
ypy migrate --header-prefix ACME .             # headers spelled differently
ypy migrate --ext .tmpl,.gohtml,.blade.php .   # more template extensions
ypy migrate --comments --no-identifiers .      # also comments; leave identifiers alone
ypy migrate --script-src /static/ypy.min.js .  # replace an external script URL
ypy migrate --min-evidence 3 .                 # distinct names needed to trust a learned prefix
```

External script tags are left alone and listed until `--script-src` is given.
`--json` prints the result as one document.

## What stays for you

- Every `quebra` and every `muda` of `ypy check`: removed attributes whose job
  moved (`-vars`, `-params`, `-request`, `-ext`, `-disinherit`), the `queue:`
  trigger modifier (now `ypy-sync`), DELETE requests that no longer carry the
  form, inheritance that is now explicit (`:inherited`), cross-origin requests
  (blocked by default), and the SSE and WebSocket attributes with no direct
  equivalent. `ypy check --list-rules` names each with its replacement.
- Inline code in attributes (`ypy-on`, `js:` values) runs only when
  `config.callbacks` allows it; set it deliberately.
- Server responses that vary by these headers must say so in `Vary`.
- Out-of-band swaps now run after the main swap, and a response with only
  out-of-band content no longer empties the main target.

## After the move

```sh
ypy check . --fail-on aviso      # exit 0 means nothing is left
```

Then run the application's own tests and click through the pages that use
`ypy-status`, `ypy-swap-oob`, streams and history. Add the extensions the page
needs (`ypy-extensions`); the migration renames the script tags it knows but
does not add any. Do not leave a second spelling around "for now": there is one
set of names.
