---
name: ypy-debugging
description: Diagnose a YPY page that does not behave. Use when a request does not fire, a swap does not happen or lands in the wrong element, a form posts nothing or too much, an event handler never runs, an extension does nothing, a morph loses or keeps the wrong state, a console shows ypy:error, or the user says "nothing happens when I click", "the response arrives but the page does not change", "it swaps the whole page", "ypy-on is ignored". Gives the order to check, the logging switch, an event monitor, and the cause behind each common symptom.
license: MIT
---

# Debugging a YPY page

Most problems are in the first few steps. Go in order and stop at the first
one that is wrong.

## The checklist

1. **Is YPY loaded?** `typeof ypy` in the console, and `ypy.version`. The
   script tag must load before the markup uses it; extensions load after it.
2. **Was the element processed?** Content added by your own script is not seen
   until `ypy.process(element)` runs on it (or `ypy.onLoad(fn)` observes it).
   An ancestor with `ypy-ignore` switches YPY off for its whole subtree.
3. **Is the trigger what you think?** The default is `change` for `input`,
   `textarea` and `select`, `submit` for a `form`, `click` for the rest.
   `ypy-trigger="load"` needs the element in the DOM when YPY starts.
4. **Does the target exist?** `document.querySelector("<selector>")` in the
   console. A target that matches nothing falls to the main target (`ypy-main`
   or `<main>`) when `config.targetFallback` allows it; the event
   `ypy:target:missing` reports the miss.
5. **What did the server return?** Network tab: HTML, not JSON; the status; the
   `Content-Type`. `204` and `304` swap nothing (`config.noSwap`); 4xx and 5xx
   swap unless you changed `noSwap`.
6. **Is inheritance in play?** An attribute on a parent reaches its children
   only as `ypy-target:inherited="..."`.
7. **Is the extension loaded and approved?** See "An extension does nothing".

## See everything that YPY does

```html
<meta name="ypy-config" content='{"logAll": true}'>
```

or `ypy.config.logAll = true` in the console. Errors and warnings reach
`console.error` and `console.warn` without any switch, so error trackers see
them. To watch the lifecycle of one request without the rest:

```js
['ypy:config:request','ypy:before:request','ypy:after:request','ypy:before:swap',
 'ypy:after:swap','ypy:error','ypy:response:error','ypy:finally:request']
  .forEach(n => document.body.addEventListener(n, e =>
    console.log(n, e.detail?.ctx?.request?.action, e.detail?.ctx?.response?.status)));
monitorEvents(ypy.find("#the-element"));   // Chromium console: every event of one element
```

`ypy:request:queued`, `ypy:request:dropped` and `ypy:request:aborted` say what
`ypy-sync` did; `ypy:swap:error` and `ypy:security:blocked` say why a swap or a
script was refused.

## A request does not fire

- The event never happens: `monitorEvents` on the element.
- `ypy-sync` dropped it (`ypy:request:dropped`) or queued it behind another.
- `ypy-confirm` waits for an answer. A `ypy:confirm` listener that calls
  `preventDefault()` and never `detail.issueRequest()` blocks it forever.
- A `ypy:config:request` or `ypy:before:request` listener cancelled it with
  `preventDefault()`.
- `ypy-validate` (on by default for a form without `novalidate`) stopped it
  because a field is invalid.
- A cross-origin URL: `config.mode` is `same-origin`, and elements cannot
  override it.
- A `ypy-on`, `js:` value or `[filter]` that never runs: `config.callbacks` is
  `none` unless set. `nonce` needs the `ypy-csp` extension; `all` runs them.
- `ypy-boost="false"` on a subtree leaves its links and forms to the browser.

## The response arrives and nothing changes

- `ypy-swap="none"`, or the status is in `noSwap`.
- `ypy-select` matched nothing in the response, so nothing is inserted.
- A `ypy:before:swap` listener called `preventDefault()`.
- The response holds only out-of-band or `<ypy-partial>` content: the main swap
  is skipped unless `swapEmpty:true` (or `config.allowEmptySwapAfterOOB`).
- The target was replaced between request and response, so the old element is
  detached. Target by id, or a stable ancestor.
- `YPY-Retarget`, `YPY-Reswap` or `YPY-Reselect` from the server override the
  attributes, and `ypy-status:<code>` is applied after them. Read the response
  headers before blaming the markup.

## The wrong content, or the wrong place

- `ypy-select` or `ypy-target` points at a different element than you think.
  `closest ...` looks upward only; `find ...` looks downward.
- Out-of-band elements (`ypy-swap-oob`) and `<ypy-partial>` blocks swap into
  their own targets after the main content. A morph matches elements by `id`
  first, so a repeated id in the response updates the wrong node.
- A morph kept the old value of a field or the `open` state of a `<details>`:
  morphing preserves what the user did. Use `innerHTML` or `outerHTML` to reset,
  or `ypy-morph-force` in the response to let it win.
- A morph rewrote an element a script owns: mark it `ypy-morph-skip` (all) or
  `ypy-morph-skip-children`, or list attributes in `ypy-preserve-attrs`. Custom
  elements and `config.morphThirdParty` roots keep their children already.
- The page title changed: add `ignoreTitle:true` to `ypy-swap`.
- A validation error replaced the whole form: add `ypy-status:422="target:#errors"`
  or `ypy-error-target`.

## A request sends the wrong values

- GET and DELETE do not include the enclosing form: `ypy-include="closest form"`.
- `ypy-vals` and `ypy-headers` are an object notation (JSON works). A value that
  is code needs the `js:` prefix and `config.callbacks`.
- Files need `ypy-encoding="multipart/form-data"`.
- Inspect it live: in a `ypy:config:request` listener print
  `evt.detail.ctx.request` (`action`, `method`, `headers`, `body`).

## An extension does nothing

1. The script comes after `ypy.js` (or use `ypy.max.js`, which bundles the common
   ones).
2. If `config.extensions` is set, the name must be in it. It is the registration
   name, the file name without `.js`: `ypy-sse`, not `sse`. Unset allows all.
3. Names are case-sensitive; a second registration of the same name is ignored.
4. The extension's own attribute is spelled as the extension says
   (`ypy-sse:connect`, `ypy-ws:send`, `ypy-preload`).

## Handing the problem over

Say which steps above you checked, give the status and headers of the response,
the markup of the element, and the lines `logAll` printed for one click. A
reproduction is a single HTML file with `ypy.js` and a static fragment.
