// SPDX-License-Identifier: MIT
//==========================================================
// ypy-csrf.js
//
// CSRF token on every unsafe request of the page, without relying on header inheritance.
//
// The page carries the token in a meta tag:
//
//   <meta name="ypy-csrf" content="TOKEN">
//   <meta name="ypy-csrf" content="TOKEN" data-header="X-CSRF-Token">
//
// data-header names the request header (default X-CSRF-Token). Every request that is not a GET or
// HEAD and goes to the origin of the page carries that header with the token, whatever the
// element, an inherited header or a boosted navigation did before. A request to another origin
// never carries it: a header of that name that an element inherited is removed from it, so the
// token cannot leak.
//
// Renewal: when a same-origin response carries a YPY-CSRF header, its value replaces the content
// of the meta tag (the tag is created when the page has none), and the next request uses it.
//
// Safety net: an unsafe same-origin request that leaves without a token fires the cancelable
// ypy:csrf:missing event on the source element, with {ctx, header}, and a console warning once
// per URL (cancel the event to silence it). The request still goes out: the server decides.
//
// The meta tag is read at each request, so a page that swaps its head, or a script that sets the
// content, is always followed. Only the public API and the extension API are used, so it works
// with the built core too.
//
// Usage:
//   <script src="ypy-csrf.js"></script>
//   <meta name="ypy-csrf" content="{{ token }}">
//==========================================================
(() => {

    const META = 'meta[name="ypy-csrf"]';
    const warned = new Set();
    let api;

    const sameOrigin = url => {
        try {
            return new URL(url, document.baseURI).origin === location.origin;
        } catch {
            return false;
        }
    };

    // Removes a header whatever its letter case (the names are case insensitive on the wire)
    const dropHeader = (headers, name) => {
        for (let key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    };

    ypy.registerExtension('ypy-csrf', {

        init: (internalApi) => { api = internalApi },

        ypy_before_request: (elt, {ctx}) => {
            let {method, action, headers} = ctx.request;
            if (/^(GET|HEAD)$/.test(method)) return;
            let meta = document.querySelector(META), header = meta?.getAttribute('data-header') || 'X-CSRF-Token';
            dropHeader(headers, header);
            if (!sameOrigin(action)) return;
            let token = meta?.getAttribute('content');
            if (token) {
                headers[header] = token;
            } else if (api.triggerEvent(elt, 'ypy:csrf:missing', {ctx, header}) && !warned.has(action)) {
                warned.add(action);
                console.warn(`ypy-csrf: ${method} ${action} has no CSRF token: add <meta name="ypy-csrf" content="...">`);
            }
        },

        ypy_before_response: (elt, {ctx}) => {
            let token = ctx.ypy?.csrf;
            if (!token || !sameOrigin(ctx.request.action)) return;
            let meta = document.querySelector(META);
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = 'ypy-csrf';
                document.head.append(meta);
            }
            meta.setAttribute('content', token);
        }
    });

})();
