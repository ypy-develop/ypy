// SPDX-License-Identifier: MIT
//==========================================================
// ypy-upload.js
//
// Upload progress for ypy.
//
// fetch() cannot report how much of a request body has been sent, so a progress bar needs
// XMLHttpRequest. This extension swaps the transport of one request, and only that request,
// when both are true:
//   1. the body is a FormData that holds at least one File that is not empty, and
//   2. the element asks for progress with the ypy-upload-progress attribute (on the element,
//      on the form, or on a container with ypy-upload-progress:inherited).
// Every other request, including a file upload without the attribute, keeps going through fetch.
//
// While the file is sent, the event ypy:upload:progress (not cancelable) fires on the source
// element with {loaded, total, percent, ctx}. percent is a whole number from 0 to 100; when the
// browser does not know the total, total is 0 and percent stays at 0 until the upload ends.
//
// The attribute value is optional and names where to show the progress:
//   <form ypy-post="/files" ypy-upload-progress>             events only
//   <form ypy-post="/files" ypy-upload-progress="#bar">      also updates #bar
//   <form ypy-post="/files" ypy-upload-progress="false">     off for this element
// The element found by the selector gets the CSS variable --ypy-upload (for example "42%") and
// the attribute data-ypy-upload (the number), both set through the DOM API, so a strict CSP is
// fine. A <progress> element also gets max=100 and value. An element with role="progressbar"
// also gets aria-valuenow.
//
// What the core sees is the same as with fetch: ctx.fetch resolves with a Response (status,
// headers, body, redirected, url), the abort of ctx.request.signal (the timeout included) aborts
// the transfer and rejects with the signal's reason, and a failed transfer rejects with a
// TypeError, so ctx.errorKind and ypy-retry work as usual. Headers set on the request are sent;
// credentials "include" sets withCredentials. Limitations of XMLHttpRequest: credentials "omit"
// cannot hide the cookies of the same origin, and the request has no mode, cache or redirect
// option (redirects are followed).
//
// How it hooks in: like ypy-retry, from ypy_before_request this extension wraps ctx.fetch, so
// it stacks with ypy-retry and ypy-dev in any registration order.
//
// Only the public API and the extension API are used, so it works with the built core too.
//==========================================================
(() => {

    let api;

    const hasFile = body => body instanceof FormData && [...body.values()].some(v => v instanceof File && v.size);

    // Shows the progress in the element named by the attribute value.
    function show(target, percent) {
        if (!target) return;
        target.style.setProperty('--ypy-upload', percent + '%');
        target.setAttribute('data-ypy-upload', percent);
        if (target instanceof HTMLProgressElement) { target.max = 100; target.value = percent }
        if (target.getAttribute('role') === 'progressbar') target.setAttribute('aria-valuenow', percent);
    }

    // The request sent with XMLHttpRequest, resolved as a Response as fetch would.
    function send(elt, ctx, action, request, to) {
        let {signal} = request, off = new AbortController();
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            let xhr = new XMLHttpRequest(), up = xhr.upload;
            let report = (loaded, total) => {
                let percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : 0;
                show(to, percent);
                api.triggerEvent(elt, 'ypy:upload:progress', {loaded, total, percent, ctx});
            };
            xhr.open(request.method, action);
            xhr.responseType = 'blob';
            xhr.withCredentials = request.credentials === 'include';
            // no Content-Type for a FormData: the browser adds the multipart one with its boundary
            for (let [name, value] of Object.entries(request.headers || {})) {
                if (!/^content-type$/i.test(name)) xhr.setRequestHeader(name, value);
            }
            up.onloadstart = () => report(0, 0);
            up.onprogress = e => report(e.loaded, e.lengthComputable ? e.total : 0);
            // the last event is always 100, even when the browser reported few events
            up.onload = e => report(e.total || e.loaded, e.total || e.loaded);
            xhr.onload = () => {
                let headers = new Headers();
                for (let line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
                    let i = line.indexOf(':');
                    if (i > 0) try { headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()) } catch {}
                }
                let status = xhr.status, body = [204, 205, 304].includes(status) ? null : xhr.response;
                let response = new Response(body, {status, statusText: xhr.statusText, headers});
                Object.defineProperties(response, {
                    url: {value: xhr.responseURL},
                    redirected: {value: xhr.responseURL !== new URL(action, location.href).href}
                });
                resolve(response);
            };
            xhr.onerror = () => reject(new TypeError('Network error'));
            xhr.onabort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
            signal.addEventListener('abort', () => xhr.abort(), {signal: off.signal});
            xhr.send(request.body);
        }).finally(() => off.abort());
    }

    ypy.registerExtension('ypy-upload', {

        init: (internalApi) => { api = internalApi },

        ypy_before_request: (elt, {ctx}) => {
            // When ypy-retry registered first, ctx.fetch is its accessor: assigning to it puts this
            // wrapper inside the retry loop, and the call that stays is the plain window.fetch
            // (the same rule as ypy-dev)
            let inner = Object.getOwnPropertyDescriptor(ctx, 'fetch')?.set ? window.fetch.bind(window) : ctx.fetch || window.fetch.bind(window);
            ctx.fetch = (action, request) => {
                let attr = api.attributeValue(elt, 'ypy-upload-progress');
                if (attr == null || attr === 'false' || !hasFile(request.body) || /^(GET|HEAD)$/i.test(request.method)) {
                    return inner(action, request);
                }
                let to;
                try { to = attr && document.querySelector(attr) } catch {}
                return send(elt, ctx, action, request, to);
            };
        }
    });

})();
