---
name: ypy-extensions
description: Load, restrict or write extensions for a page that uses YPY. Use when the request is to "stream from the server", "use SSE or WebSockets", "preload links", "poll without waste", "retry a failed request", "show pending content", "persist an element across navigation", "make YPY work under a strict CSP", "run alongside Alpine", "which extension does X", or "write my own ypy extension for this app". Covers the shipped extensions, loading order, the ypy.max bundle, the extensions allowlist, and the extension API an application extension is written against.
license: MIT
---

# Extensions in an application

The core does requests and swaps. Everything else (streams, preloading, retries,
persistence) is an extension: one script that registers itself and is active
page-wide once it has loaded. This skill is for the application that loads them
or writes one of its own. Changing the framework's own extensions is another job.

## Loading

```html
<script src="/ypy.js"></script>
<script src="/ext/ypy-sse.js"></script>
<script src="/ext/ypy-preload.js"></script>
```

Order matters: `ypy.js` first, extensions after it, all before markup that needs
them. The build writes `dist/ext/<name>.js` and `.min.js`. `dist/ypy.max.js` is
the core plus the common extensions in one file (`ypy.version` ends in `-max`):
stream, sse, ws, preload, browser-indicator, download, pending, targets, live,
history-cache, upsert, alpine-compat, retry, lock, signals, layers, nav,
progress, persist, lazy, cache, optimistic, validate, upload, csrf, poll, list,
telemetry. The rest (`ypy-csp`, `ypy-multipart`, `ypy-head`, `ypy-prompt`, `ypy-ptag`, `ypy-native`,
`ypy-dev`, `ypy-inspector`, `ypy-test`) load on their own.

An allowlist closes the door on a script you did not mean to run:

```html
<meta name="ypy-config" content='{"extensions": "ypy-sse,ypy-preload"}'>
```

Names are the **registration names**, the file name without `.js`. Unset allows
every extension; set, it refuses any other and `registerExtension` returns
`false`.

## Which one

| Extension | Use it to |
| --- | --- |
| `ypy-sse`, `ypy-ws`, `ypy-multipart`, `ypy-stream` | receive HTML from the server over time: SSE (`ypy-sse:connect`), WebSocket (`ypy-ws:connect`, `ypy-ws:send`), `multipart/mixed`, the YPY stream protocol |
| `ypy-signals` | declare client signals on a scope (`ypy-signals`) that stream events can set |
| `ypy-preload`, `ypy-nav` | fetch a GET before the click (`ypy-preload`), or the page of a link (`ypy-prefetch`) |
| `ypy-cache`, `ypy-history-cache` | show a stored response at once and revalidate; restore back/forward from `sessionStorage` |
| `ypy-poll`, `ypy-ptag` | make `every` triggers kind to hidden tabs; skip unchanged polls with `YPY-PTag` |
| `ypy-retry`, `ypy-lock`, `ypy-optimistic` | retry with backoff; lock an element during its request; show the result before the server answers |
| `ypy-pending`, `ypy-progress`, `ypy-browser-indicator` | pending content, a progress bar, the tab's own spinner |
| `ypy-validate`, `ypy-upload`, `ypy-prompt`, `ypy-csrf` | per-field server validation; upload progress; a prompt before a request; CSRF token on mutating requests |
| `ypy-targets`, `ypy-upsert`, `ypy-head`, `ypy-download`, `ypy-lazy`, `ypy-list`, `ypy-layers`, `ypy-persist`, `ypy-preserve` | one response into many targets; upsert elements; merge `<head>`; downloads; lazy load; lists; layers (dialogs); keep an element across navigation; keep the value, selection, focus or scroll of an element through a swap and wait for an IME composition |
| `ypy-live` | evaluate expressions when the DOM or a value changes |
| `ypy-csp` | run under a strict Content Security Policy: author code only through the page nonce |
| `ypy-alpine-compat` | run beside Alpine.js |
| `ypy-dev`, `ypy-inspector` | development aids; leave them out of production |
| `ypy-test` | end-to-end tests: `await ypy.idle()` before asserting |

The attributes each one adds are in `attributes.json` and `attributes.d/` (and in
your editor, after `ypy gen`). Read the extension's source in `src/ext/` for its
options: they are short.

## Writing an extension for one application

An extension is an object of **hooks** passed to `ypy.registerExtension(name, obj)`.
A hook is the event name with colons turned into underscores:
`ypy:after:swap` is `ypy_after_swap`. Any event YPY dispatches can be hooked,
including other extensions' events. Hooks receive `(elt, detail)`.

```js
// SPDX-License-Identifier: MIT
(() => {
  let api;
  ypy.registerExtension('ypy-flash', {
    init: internal => { api = internal; },

    ypy_after_init: elt => {
      const sel = api.attributeValue(elt, 'ypy-flash');   // reads inheritance too
      if (!sel) return;
      const on = () => document.querySelector(sel)?.classList.add('flash');
      elt.addEventListener('ypy:after:swap', on);
      (elt._ypy ??= {}).flashOff = () => elt.removeEventListener('ypy:after:swap', on);
    },

    ypy_before_request: (elt, detail) => {
      if (!navigator.onLine) return false;                // false cancels
    },

    ypy_before_cleanup: elt => elt._ypy?.flashOff?.(),    // listeners, timers
  });
})();
```

Rules that keep it working:

1. Wrap it in an IIFE and name it `ypy-<name>`, in the file `ypy-<name>.js`.
2. Keep the API object from `init`; check `attributeValue` and return early when
   the element has no attribute of yours.
3. Per-element state goes on `elt._ypy`; per-request state on `detail.ctx`.
4. Undo everything in `ypy_before_cleanup`; elements are removed by swaps.
5. Your attributes are `ypy-<name>` (or `ypy-<name>:<option>`).
6. Cancel with `return false` or `detail.cancelled = true`.

### Hooks you will use

Lifecycle: `ypy_before_init`, `ypy_after_init`, `ypy_before_process`,
`ypy_after_process`, `ypy_before_cleanup`, `ypy_after_cleanup`. Request:
`ypy_confirm`, `ypy_config_request`, `ypy_before_request`, `ypy_before_response`,
`ypy_after_request`, `ypy_finally_request`, `ypy_error`, `ypy_response_error`.
Swap: `ypy_before_swap`, `ypy_after_swap`, `ypy_finally_swap`,
`ypy_before_settle`, `ypy_after_settle`, plus `ypy_before_morph_node` and
`ypy_before_morph_attr` (extensions only; cancel to keep the existing node or
value). History and view transitions follow the same rule. Two direct calls:
`handle_swap(swapStyle, target, fragment, swapSpec)` returns truthy to take over
a custom swap style, and `ypy_process_<type>` handles a
`<template ypy type="<type>">` in a response.

### What `detail.ctx` holds

`sourceElement`, `sourceEvent`, `target`, `swap`, `select`, `selectOOB`, `push`,
`replace`, `transition`, `request.{action, method, headers, body, validate,
abort, signal, timeout, credentials, mode}`, `response.{raw, status, headers}`,
`text` (the body, editable in `ypy_after_request` before the swap) and `ypy` (the
parsed `YPY-*` response headers). Set `ctx.fetch` to a function returning a
`Response` to replace the network call.

### The internal API (`init`)

`api.HCON` (parse and merge the object notation), `attributeValue(elt, name,
default, returnElt)`, `parseTriggerSpecs`, `determineMethodAndAction`,
`createRequestContext`, `collectFormData`, `getAttributeObject`, `insertContent`,
`morph`, `isSoftMatch`, `onTrigger`, `ypyProp`, `triggerEvent`,
`executeJavaScript` (through the security policy) and `initSecurity`.
`src/ypy.d.ts` has the signatures.

## Check it

1. Load it after `ypy.js` in a page and set `ypy.config.logAll = true`.
2. If `config.extensions` is set, add your name.
3. Run the framework tests against your file only if it is part of the framework;
   an application extension is tested with the application's own browser tests.
4. Under a strict CSP, an extension file is a normal same-origin script; it must
   not use `eval`, `new Function` or inline handlers.
