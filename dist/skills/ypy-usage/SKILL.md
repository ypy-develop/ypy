---
name: ypy-usage
description: Write or change a screen that talks to the server with YPY attributes. Use when the request is to "add a button that loads X", "make this form submit without a reload", "update part of the page", "live search", "polling", "infinite scroll", "show a spinner", "validate a form on the server", "update two places with one response", or when a page uses ypy-get, ypy-post, ypy-target, ypy-swap, ypy-trigger, ypy-status or ypy-partial. Covers the request attributes, triggers, targets, swap styles, explicit inheritance, the events and headers, error handling by status code, multi-region updates and the configuration, for people who use YPY rather than change it.
license: MIT
---

# Writing screens with YPY

An element asks the server for HTML, and the response is put into the page. The
server returns **HTML fragments**, never JSON. Everything below is an attribute
on an ordinary element, with `ypy-` or `data-ypy-` in front of the name (when an
element carries both, `ypy-` wins).

## The shape of a request

```html
<button ypy-get="/contacts/7" ypy-target="#detail" ypy-swap="innerHTML">Open</button>
<div id="detail"></div>
```

| Attribute | Method |
| --- | --- |
| `ypy-get`, `ypy-post`, `ypy-put`, `ypy-patch`, `ypy-delete`, `ypy-query` | the verb, with the URL as value |
| `ypy-action` + `ypy-method` | the URL and the verb written apart |

What fires it, unless `ypy-trigger` says otherwise: `change` for `input`,
`textarea` and `select`, `submit` for a `form`, `click` for everything else.

## ypy-trigger

```html
<input name="q" ypy-get="/search" ypy-target="#results"
       ypy-trigger="input changed delay:300ms, keyup[key=='Enter']">
<div ypy-get="/clock" ypy-trigger="every 2s"></div>
<div ypy-get="/more" ypy-trigger="revealed" ypy-swap="outerHTML"></div>
<div ypy-get="/table" ypy-trigger="refresh from:body"></div>
```

Modifiers: `once`, `changed`, `delay:<time>` (debounce), `throttle:<time>`,
`from:<selector>`, `target:<selector>`, `prevent`, `stop`, `halt`, `capture`,
`passive`. A filter goes in brackets: `click[ctrlKey]`. Special triggers: `load`,
`revealed`, `intersect` (`root:`, `threshold:`) and `every <time>`. A selector
with spaces or commas is quoted: `from:'form input'`.

## ypy-target and ypy-select

`ypy-target` is a CSS selector, or `this`, `closest <sel>`, `find <sel>`,
`next [sel]`, `previous [sel]`. Without it the element itself is the target. Use
the relative forms inside lists instead of inventing ids:

```html
<button ypy-delete="/rows/9" ypy-target="closest tr" ypy-swap="delete">Remove</button>
```

`ypy-select` keeps only the matching part of the response. If a target selector
matches nothing, the swap falls to the main target (`ypy-main`, or `<main>`).

## ypy-swap

Default `innerMorph` (see `ypy.config.defaultSwap`). The styles:

| Style | Effect |
| --- | --- |
| `innerHTML`, `outerHTML`, `textContent` | replace the content, the element, or its text |
| `innerMorph`, `outerMorph` | merge into what is there: keeps focus, scroll, typed values, listeners |
| `outerSync` | morph the target's attributes, then replace its children |
| `beforebegin` / `before`, `afterbegin` / `prepend`, `beforeend` / `append`, `afterend` / `after` | insert |
| `delete`, `none` | remove the target, or swap nothing |

Modifiers go after the style: `swap:100ms settle:200ms transition:true
ignoreTitle:true scroll:top show:top strip:true swapEmpty:true`. Morphing keeps
what the user typed, so it cannot reset a form: use `innerHTML` or `outerHTML`
for that. Opt an element out with `ypy-morph-skip` (all of it) or
`ypy-morph-skip-children` (attributes still update), and keep a node by id with
`ypy-preserve`.

## Inheritance is explicit

A parent's attribute reaches its children only with `:inherited`:

```html
<div ypy-target:inherited="#output">
  <button ypy-get="/a">A</button>
  <button ypy-get="/b">B</button>
</div>
```

`:inherited:append` adds to the inherited value (`ypy-include`, for one).

## What a request carries

- POST, PUT and PATCH include the values of the enclosing form. GET and DELETE do
  not: add `ypy-include="closest form"` when they should.
- `ypy-vals='{"sort":"name"}'` adds values; `ypy-vals='js:{"n": count()}'` computes
  them. `ypy-headers` and `ypy-config` (`timeout`, `credentials`, ...) take the
  same notation. `ypy-encoding="multipart/form-data"` for files.
- `ypy-confirm`, `ypy-sync` (`[<selector>:]<strategy>`, default `queue first`: what to do when a second request from the same owner arrives),
  `ypy-validate`, `ypy-disable="find button"` and `ypy-inert` (the `ypy-disable` extension), `ypy-boost` (links and forms of a
  subtree), `ypy-push-url`, `ypy-replace-url`, `ypy-history-elt`, `ypy-ignore`.

The server sees `YPY-Request`, `YPY-Source`, `YPY-Target`, `YPY-Current-URL`,
`YPY-Request-Type` (`partial` or `full`), `YPY-Boosted` and
`YPY-History-Restore-Request`. It can answer with `YPY-Trigger` (event names or
JSON), `YPY-Push-Url`, `YPY-Replace-Url`, `YPY-Redirect`, `YPY-Location`,
`YPY-Refresh`, `YPY-Retarget`, `YPY-Reswap` and `YPY-Reselect`. A response that
differs by these headers must say `Vary` for them.

## Errors, by status code

`204` and `304` swap nothing; 4xx and 5xx are swapped like any other response.
For a form that fails validation:

```html
<form ypy-post="/register" ypy-target="#result"
      ypy-status:422="target:#errors select:#validation-errors"
      ypy-status:5xx="swap:none">
  <input name="email" type="email">
  <div id="errors"></div><div id="result"></div>
  <button>Register</button>
</form>
```

`ypy-status:404`, `ypy-status:50x` and `ypy-status:5xx` are tried in that order.
The keys are `swap:`, `target:`, `select:`, `push:`, `replace:`, `transition:`.
`ypy-error-target`, `ypy-error-swap` and `ypy-error-focus` (`first-invalid`, a
selector or `false`) cover every status of 400 or more at once.

## Several places from one response

1. **A wider target.** Target a container that holds every region.
2. **`<ypy-partial>`**, the explicit choice:

```html
<ypy-partial ypy-target="#messages" ypy-swap="beforeend"><div>New message</div></ypy-partial>
<ypy-partial ypy-target="#badge" ypy-swap="innerHTML"><span>5</span></ypy-partial>
```

3. **`ypy-swap-oob`** on an element of the response (`beforeend:#table`), which
   runs after the main swap. `ypy-select-oob` picks them by id.
4. **An event.** The server sends `YPY-Trigger: newContact`; the list has
   `ypy-trigger="newContact from:body"` and `ypy-get`.

## Feedback while waiting

```html
<button ypy-get="/slow" ypy-indicator="#spin">Load <span id="spin" class="ypy-indicator">...</span></button>
```

An element with class `ypy-indicator` is hidden until the request puts
`ypy-request` on its source. Delay it to avoid a flash on fast answers:
`.ypy-request .ypy-indicator { transition: opacity 200ms ease-in 200ms }`. States
are also classes (`ypy-swapping`, `ypy-settling`, `ypy-added`). `ypy-announce`,
`ypy-focus` and `ypy-scroll` say what screen readers, the focus and the scroll do
when the swap ends.

## Events and the script API

Events are `ypy:<phase>:<action>`: `ypy:confirm`, `ypy:config:request` (change
headers, body, URL), `ypy:before:request`, `ypy:after:request`,
`ypy:before:swap`, `ypy:after:swap`, `ypy:after:settle`, `ypy:error`,
`ypy:response:error`, `ypy:finally:request`, the history and view-transition
ones. `evt.preventDefault()` cancels a request or a swap; `detail.ctx` holds the
source element, target, swap and `request.{action,method,headers,body}`. Inline:
`ypy-on:ypy:after:swap="..."` (or `ypy-on::after:swap`).

```js
ypy.ajax("GET", "/data", {target: "#result"});   // a Promise
ypy.on("ypy:after:swap", evt => {});
ypy.process(element);                            // content you inserted yourself
ypy.trigger("#slow", "ypy:abort");               // cancel its in-flight requests
```

## Configuration

`<meta name="ypy-config" content='{"defaultSwap":"outerHTML"}'>` in the `<head>`,
or `ypy.config.key = value` in code. Short form: `defaultSwap:outerHTML, logAll:true`.
Author code (`ypy-on`, `js:` values, `[filter]` triggers) runs only when `config.callbacks` allows it (`none` by default; `nonce` with the `ypy-csp` extension; `all`).
Common keys: `defaultSwap`, `defaultTimeout` (60000), `noSwap` (`[204, 304]`),
`history`, `mode` (`same-origin`), `transitions`, `extensions`, `logAll`,
`classes`, `morphSkip`. The full list is `ypy.d.ts` and `attributes.json`.

## Rules to follow

1. Endpoints return fragments; a full page is a layout around the same fragment.
2. Put `:inherited` on any attribute meant for the children.
3. Give long requests an indicator; give forms a `ypy-status:422` target.
4. Choose morph to keep what the user typed, `innerHTML` to start clean.
5. Show the HTML and say what the endpoint must return.
6. For streams, polling or preloading load an extension first (`ypy-extensions`).
