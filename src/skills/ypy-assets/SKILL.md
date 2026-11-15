---
name: ypy-assets
description: Keep a component's CSS or small script next to its template while the page runs under a strict Content Security Policy. Use when the request is "put the styles beside the template", "no inline style or script", "style-src without unsafe-inline", "my component needs a little JavaScript", or when a template has a style or script block marked ypy-asset, a file named x.ypy.css or x.ypy.js, or a call to ypy gen assets or ypy.LoadManifest.
license: MIT
---

# Assets beside the template

`ypy gen assets` takes the CSS and the small scripts written next to the templates and turns them into
files with a hash in the name, plus a manifest. The page then links those files: nothing stays inline,
so a strict CSP (`style-src 'self'`, `script-src 'self' 'nonce-…'`) keeps working.

## Write

- In a template (`.html`, `.gohtml`, `.templ`, `.kyse.go`): `<style ypy-asset>…</style>` or
  `<script ypy-asset>…</script>`. Or a file beside it: `card.ypy.css`, `card.ypy.js`.
- Not in those blocks: `media`, `type="module"`, `src`, or template actions (`{{ }}`) in `.html` and
  `.gohtml`. The command stops with the file and line. Pass values through classes, CSS variables or
  `data-` attributes.
- In `.templ` and `.kyse.go` the block is markup or a raw string literal.
- Each script runs in its own function, so two templates may use the same names. Assign to `window` for a
  global.

## Build

```sh
ypy gen assets ./ui --out ./web/assets --strip-out ./web/templates
```

- One CSS and one JS file per directory (`--group template` gives one pair per template), named
  `<name>.<hash>.css`. The same input gives the same bytes.
- `manifest.json` maps each directory (or template) to its files.
- `--strip-out` writes a copy of every template without the blocks: serve and embed **that** copy, never
  the originals, or the inline blocks reach the page.
- In CI run the same command with `--check`: it writes nothing and fails when the output is out of date.
  Never edit the files in `--out` or write a hash by hand.

## Serve (Go)

```go
m, err := ypy.LoadManifest(assetsFS, "manifest.json") // fails at start when a file is missing
tmpl := template.New("").Funcs(m.FuncMap())
http.Handle("/assets/", http.StripPrefix("/assets", m.Handler()))
```

In the `<head>` of the page: `{{ assets "ui" .Nonce }}` writes `<link rel="stylesheet" integrity>` and
`<script src defer integrity>` with the page nonce. An unknown origin writes nothing.

## Check

The final HTML has no `<style>`, no `<script>` with code, no `style=` and no `on*=` attribute. In a Go
test: `res.AssertNoInline(t)` from `ypytest`.
