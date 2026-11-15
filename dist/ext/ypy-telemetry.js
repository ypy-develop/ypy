// SPDX-License-Identifier: MIT
//==========================================================
// ypy-telemetry.js
//
// Every failure of the page in one event, for an error tracker or a log.
//
// Network failures, timeouts, a lost connection, 4xx and 5xx responses, a target that is not
// there, a refused swap and the errors of the extensions each have their own event, and some of
// them only reach the console. This extension reports all of them the same way:
//
//   ypy.onError(report => send(report))       returns a function that cancels the subscription
//   document.addEventListener('ypy:telemetry:error', evt => send(evt.detail))
//
// The report is {code, url, method, status, target, ctxId}:
//   code    a stable name of what failed:
//             network, offline, timeout      the request did not get an answer
//             status:<n>                     the response has status 400 or more, for example status:500
//             target-missing                 no element matches the target
//             swap-error                     inserting the response into the page failed
//             blocked:<reason>               a swap, redirect or script was refused (redirect,
//                                            websocket-origin, callbacks-none, ...)
//             extension:<name>               an extension reported an error: sse, ws, stream, multipart,
//                                            lazy or signals
//             error                          any other ypy:error (for example a listener that threw)
//   url     the address without query, fragment or credentials; null when there is none
//   method  the HTTP method in upper case; null when there is none
//   status  the HTTP status of the answer; null when there was none
//   target  a short selector of the target: "div#results", or the selector that matched nothing; null
//   ctxId   a number shared by every report of one request; null outside a request
//
// A report never carries the body, the value of a field, a header or a cookie, nor the message of
// the error: those can hold what the user typed. Only the fields above leave the page. A path can
// still hold an identifier, so a tracker that must not see it should cut the url on its side.
//
// The event fires on the element the failure belongs to (on the document when that element is
// gone), bubbles, and is not cancelable. A handler of ypy.onError that throws is logged and does
// not stop the others.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {

    let api, count = 0;
    const subscribers = new Set;
    const ids = new WeakMap;        // request ctx -> ctxId
    const swapErrors = new WeakMap; // request ctx -> errors already reported as swap-error

    const cut = (text, max = 80) => String(text).slice(0, max);

    // "div#results": the tag and the id, never the content of the element
    const short = target => target?.localName ? cut(target.localName + (target.id ? '#' + target.id : '')) : target ? cut(target) : null;

    const clean = href => {
        try {
            let url = new URL(href, document.baseURI);
            url.search = url.hash = url.username = url.password = '';
            return url.href;
        } catch { return null }
    };

    function report(code, elt, {ctx, url, target} = {}) {
        let request = ctx?.request;
        if (ctx && !ids.has(ctx)) ids.set(ctx, ++count);
        let detail = {
            code,
            url: (url ?? request?.action) == null ? null : clean(url ?? request.action),
            method: request?.method ? String(request.method).toUpperCase() : null,
            status: ctx?.response?.status ?? null,
            target: short(target ?? ctx?.target ?? ctx?.targetSelector),
            ctxId: ctx ? ids.get(ctx) : null
        };
        for (let fn of [...subscribers]) {
            try { fn({...detail}) } catch (error) { console.error('ypy-telemetry: an onError handler threw', error) }
        }
        api.triggerEvent(elt?.isConnected ? elt : document, 'ypy:telemetry:error', detail);
    }

    const hooks = {
        init: a => {
            api = a;
            ypy.onError = fn => {
                if (typeof fn !== 'function') throw new TypeError('ypy.onError: a function is required');
                let handler = detail => fn(detail);   // two subscriptions of one function cancel apart
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            };
        },

        ypy_error: (elt, {ctx, error}) => {
            if (swapErrors.get(ctx)?.has(error)) return;   // already reported by ypy:swap:error
            let kind = ctx?.errorKind;
            report(/^(network|offline|timeout)$/.test(kind) ? kind : 'error', elt, {ctx});
        },

        ypy_response_error: (elt, {ctx}) => report('status:' + ctx.response.status, elt, {ctx}),

        ypy_target_missing: (elt, {ctx, selector}) => report('target-missing', elt, {ctx, target: selector}),

        ypy_swap_error: (elt, {ctx, task, error}) => {
            if (ctx) swapErrors.set(ctx, (swapErrors.get(ctx) || new Set).add(error));
            report('swap-error', elt, {ctx, target: task?.target});
        },

        ypy_security_blocked: (elt, {reason, url}) => report('blocked:' + cut(reason, 40), elt, {url})
    };

    // the errors the extensions report on their own
    for (let name of ['sse', 'ws', 'stream', 'multipart', 'lazy', 'signals']) {
        hooks[`ypy_${name}_error`] = (elt, {ctx, url}) => report('extension:' + name, elt, {ctx, url});
    }

    ypy.registerExtension('ypy-telemetry', hooks);

})();
