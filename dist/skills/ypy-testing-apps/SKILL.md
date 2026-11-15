---
name: ypy-testing-apps
description: Write end-to-end tests for an application that uses YPY, and report its failures to a tracker. Use when the request is to "test this page with Playwright or Cypress", "wait for the swap to finish", "the test is flaky", "stop using sleep or waitForTimeout", "know when the page has settled", "send YPY errors to Sentry or a log", "see failed requests in production", or when a test sleeps for a fixed time after a click. Covers the ypy-test extension (ypy.idle and data-ypy-busy), what counts as pending work, and the ypy-telemetry extension (ypy.onError and the ypy:telemetry:error event).
license: MIT
---

# Testing an application that uses YPY

A click starts a request, the response is swapped in, the new content settles
and may start another request. A test that asserts too early is flaky, and a
test that sleeps 300 ms is slow and still flaky. Load `ypy-test` and wait for
the page itself.

## Wait for the page, never for the clock

```html
<script src="/ypy.js"></script>
<script src="/ext/ypy-test.js"></script>   <!-- test and staging builds only -->
```

`ypy.idle()` returns a promise that resolves when no request is in flight or
queued, no swap or settle is pending, and the page stayed quiet for 50 ms (the
content just swapped in may start the next request).

Playwright:

```js
await page.click('#save');
await page.evaluate(() => ypy.idle());
await expect(page.locator('#flash')).toHaveText('Saved');
```

Cypress:

```js
cy.get('#save').click();
cy.window().then(win => win.ypy.idle());
cy.get('#flash').should('have.text', 'Saved');
```

A helper keeps the tests short:

```js
export const settled = (page, opts) => page.evaluate(o => ypy.idle(o), opts);
```

Options, per call or in `ypy.config.test`: `timeout` (default 5000 ms; on expiry
the promise rejects with an `Error` that names what is still pending, so the
test fails with a reason instead of hanging), `quiet` (default 50 ms; `0`
resolves at once), both as milliseconds or a string such as `"2s"`.

## The same state, in the DOM

While work is pending `<html>` has `data-ypy-busy`, and it loses it when the
work ends. The value lists the kinds, for example `request swap`: `request` in
flight, `queued` waiting in an `ypy-sync` queue, `swap` being inserted,
`settle` settling. A tool that cannot call `ypy.idle()` waits for the DOM:

```js
await page.waitForSelector('html:not([data-ypy-busy])');
```

The attribute is output. Do not write it, and style with it only for a "the
page is working" cue.

## What it does not wait for

- A server-sent event stream stays open for the life of the page, so it is not
  pending work. Neither is a WebSocket.
- Polling (`every 2s`) counts only while a poll request runs, so `ypy.idle()`
  resolves between polls.
- A timer that has not fired yet: a `delay:` debounce or a `setTimeout` of your
  own. Wait for the first request to start, or pass a longer `quiet`.
- Animations and view transitions that finish after the swap. Assert on the
  final DOM with the test tool's own retrying assertions.

When the page never settles, read the message of the rejection: it names the
kind of work still open, and `data-ypy-busy` shows the same in the browser.

## Do not

- `waitForTimeout(300)` after a click. Use `ypy.idle()`.
- Load `ypy-test` in production for no reason. It is harmless (about 1 kB) but
  it is test scaffolding.
- Call `ypy.idle()` before the action that starts the request. Click first, then wait.

## Failures, as data

`ypy-telemetry` turns every failure into one event, in tests and in
production, so a test can assert that the page raised no error and a tracker
can count them:

```js
const errors = [];
const stop = ypy.onError(e => errors.push(e));   // returns the function that unsubscribes
// ... the scenario ...
expect(errors).toEqual([]);
stop();
```

```js
ypy.onError(e => navigator.sendBeacon('/telemetry', JSON.stringify(e)));
document.addEventListener('ypy:telemetry:error', evt => track(evt.detail));
```

The report is `{code, url, method, status, target, ctxId}`:

| `code` | what failed |
| --- | --- |
| `network`, `offline`, `timeout` | the request got no answer |
| `status:<n>` | a response with status 400 or more, for example `status:500` |
| `target-missing` | no element matches the target; `target` is the selector |
| `swap-error` | inserting the response failed |
| `blocked:<reason>` | a swap, redirect or script was refused, for example `blocked:redirect` |
| `extension:<name>` | `sse`, `ws`, `stream`, `multipart`, `lazy` or `signals` reported an error |
| `error` | any other `ypy:error` |

`url` has no query, fragment or credentials; `target` is short (`div#results`);
`ctxId` is the same for every report of one request. A report never holds a
body, a field value, a header, a cookie or the text of an error, so it is safe
to send. A path can still hold an identifier (`/orders/8141`): cut it on your
side if it must not leave the page.

In a Playwright test, collect the reports of the page after it loaded:

```js
await page.goto('/orders');
await page.evaluate(() => { window.__ypyErrors = []; ypy.onError(e => window.__ypyErrors.push(e)); });
// ... the scenario ...
expect(await page.evaluate(() => window.__ypyErrors)).toEqual([]);
```
