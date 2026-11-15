// SPDX-License-Identifier: MIT
//==========================================================
// ypy-nav.js
//
// Application navigation for ypy: global boost, link prefetch, the current link and ypy-once.
//
// Global boost. With ypy.config.nav.boost on, every link and form of the page is navigated with
// a request and a swap, with no attribute on any of them. The extension listens once on the
// document (not on each element), so content that arrives later is covered without being
// processed. It leaves to the browser everything the browser does better:
//   - a link with target (other than _self) or download, a link to another origin or to a
//     fragment of the same page, a click with Ctrl, Meta, Shift or Alt or a button other than
//     the main one, and any event another listener already cancelled;
//   - a form whose target, formtarget, method or formmethod points at another window or at
//     "dialog", or whose action or formaction is on another origin.
// The method, the action and the target of a form are the HTML ones: the method and action of
// the submitter (formmethod, formaction) win over those of the form, and put, patch and delete
// are accepted as method values. A region turns it off with ypy-boost="false" (also with
// :inherited); elements the core already handles (ypy-get, ypy-boost and the like) are left to
// the core. The request is the core's own: the same headers, the same target and swap rules, the
// same history entry as a link that carries ypy-boost.
//
// Prefetch. With nav.prefetch on (or ypy-prefetch on a link or a region), the page a link opens
// is requested ahead of the click, and the response is the one the click uses. Only a link
// YPY would navigate is prefetched, only with GET, only on the page's own origin, with no form
// data and with the fetch mode and credentials of the page (a ypy-boost value or ypy-config
// cannot change them). The request carries Sec-Purpose, Purpose and YPY-Purpose: prefetch. A script
// cannot set Sec-Purpose (the browser drops every header that starts with Sec-), so servers
// should read Purpose or YPY-Purpose. The response is used by the click only when the click's
// request is the same: same URL and same headers; otherwise the click goes to the server as
// usual. Budget: nav.prefetchMax entries alive, nav.prefetchParallel requests in flight for
// the visibility mode, nav.prefetchTtl ms of life; a hover that ends before the request is
// done cancels it, and nothing is prefetched when the browser asks to save data. The "hover"
// mode also covers the keyboard: a link that gets focus (Tab) is requested after the same
// delay, and leaving it before the request is done cancels it. A focus that comes from the
// pointer is left to the hover and the touch.
//
// The current link. A link to the URL of the page (same path and query, no fragment) gets
// aria-current="page" and the class ypy-current; the mark is renewed on every navigation: after
// each history push or replace, on back and forward, and on content that arrives. The extension
// owns aria-current="page" on links, so a server-rendered one is moved too. nav.current: false
// turns it off.
//
// ypy-once. A <script ypy-once> in swapped content runs only once per page: when a response
// brings it again, it is taken out before the swap. The script's identity is the value of
// ypy-once when it has one, else its src, else its text. A script that came with the page
// counts as already run.
//
// Configuration (ypy.config.nav, or the ypy-config meta tag):
//   boost            false  turn global boost on
//   prefetch         false  "hover", "visible" or "hover visible" (true means "hover")
//   prefetchDelay    65     ms of hover before the request
//   prefetchTtl      10000  ms an unused response is kept
//   prefetchMax      10     entries alive at once
//   prefetchParallel 2      requests in flight for the visibility mode
//   current          true   mark the link to the current page (aria-current, ypy-current)
//
// With config.nonce set, global boost is off: it works without attributes, and the nonce gate
// is about attributes. Only the public API and the extension API are used.
//==========================================================
(() => {

    let api;
    const cfg = () => ypy.config.nav || {};
    const sel = s => api.prefixSelector(s);
    const cache = new Map();   // action -> {p: response promise, ac, k: headers key, t: expiry timer, hover, done}
    const waiting = [];        // links the visibility mode wants to prefetch
    const ran = new Set();     // identities of the ypy-once scripts that already run on this page
    let active = 0, timer, ftimer, io, last, pointer;

    const boostOn = () => cfg().boost && !ypy.config.nonce;
    const key = h => JSON.stringify(Object.entries(h).sort());
    const handled = elt => elt._ypy?.initialized;   // the core already runs it (ypy-get, ypy-boost...)
    const optedOut = elt => !!elt.closest(sel('[ypy-boost="false"],[ypy-boost\\:inherited="false"],[ypy-ignore]'));

    // The URL a link opens in this window, or undefined when the browser has to handle it.
    function pageUrl(a) {
        if (!(a instanceof HTMLAnchorElement) || !a.getAttribute('href') || a.hasAttribute('download') || a.target && a.target !== '_self') return;
        let u = new URL(a.href);
        if (u.origin === location.origin && u.href.split('#')[0] !== location.href.split('#')[0]) return u;
    }

    // Runs the request through the core as a boosted element would.
    function go(elt, method, action, evt) {
        api.ypyProp(elt).boosted ||= 'true';
        ypy.ajax(method, action, {source: elt, event: evt}).catch(error => api.triggerEvent(elt, 'ypy:error', {error}));
    }

    document.addEventListener('click', evt => {
        if (!boostOn() || evt.defaultPrevented || evt.button || evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
        let a = (evt.composedPath?.()[0] || evt.target).closest?.('a[href]');
        if (a && pageUrl(a) && !handled(a) && !optedOut(a)) {
            evt.preventDefault();
            go(a, 'GET', a.getAttribute('href'), evt);
        }
    });

    document.addEventListener('submit', evt => {
        let f = evt.target, s = evt.submitter;
        if (!boostOn() || evt.defaultPrevented || !(f instanceof HTMLFormElement) || handled(f) || optedOut(f)) return;
        let pick = (own, name) => s?.hasAttribute(own) ? s.getAttribute(own) : f.getAttribute(name);
        let method = (pick('formmethod', 'method') || 'get').toUpperCase(), target = pick('formtarget', 'target');
        let action = pick('formaction', 'action') ?? '';
        if (/^(GET|POST|PUT|PATCH|DELETE|QUERY)$/.test(method) && (!target || target === '_self') &&
            new URL(action, document.baseURI).origin === location.origin) {
            evt.preventDefault();
            go(f, method, action, evt);
        }
    });

    //------------------------------------------------------
    // prefetch
    //------------------------------------------------------

    // "hover", "visible", both, or "" for none: the nearest ypy-prefetch, else the configuration
    function mode(a) {
        let r = a.closest(sel('[ypy-prefetch]')), v = r ? api.attr(r, 'ypy-prefetch') || 'true' : cfg().prefetch;
        return v === true || v === 'true' ? 'hover' : v === false || v === 'false' || v == null ? '' : String(v);
    }

    function drop(action) {
        let e = cache.get(action);
        if (e) { clearTimeout(e.t); e.ac.abort(); cache.delete(action) }
    }

    function clear() {
        for (let action of [...cache.keys()]) drop(action);
        waiting.length = 0;
        last = null;
    }

    function pump() {
        while (active < (cfg().prefetchParallel ?? 2) && waiting.length) {
            let a = waiting.shift();
            if (a.isConnected) start(a);
        }
    }

    function start(a, hover) {
        if (!pageUrl(a) || navigator.connection?.saveData || optedOut(a) || !mode(a) ||
            !(a._ypy?.boosted || boostOn() && !handled(a))) return;
        api.ypyProp(a).boosted ||= 'true';
        // the core builds the request from this very element, as it does at the click
        let ctx = api.createRequestContext(a, new Event('click')), req = ctx.request;
        let u = new URL(req.action, document.baseURI), action = u.pathname + u.search, o = cfg();
        if (u.origin !== location.origin || cache.has(action)) return;
        if (cache.size >= (o.prefetchMax ?? 10)) drop(cache.keys().next().value);
        let headers = {...req.headers, 'YPY-Request-Type': ctx.target === document.body || ctx.select ? 'full' : 'partial'};
        let e = {ac: new AbortController(), k: key(headers), hover};
        e.p = fetch(action, {
            method: 'GET',
            // never req.mode or req.credentials: an attribute can write there, the page's policy cannot be lifted
            headers: {...headers, 'Sec-Purpose': 'prefetch', Purpose: 'prefetch', 'YPY-Purpose': 'prefetch'},
            credentials: 'same-origin', mode: ypy.config.mode, signal: e.ac.signal
        }).then(r => { if (!r.ok) throw r; return r });
        e.t = setTimeout(drop, o.prefetchTtl ?? 10000, action);
        cache.set(action, e);
        last = {a, action, e};
        active++;
        let end = () => { e.done = true; active--; pump() };
        e.p.then(end, () => { end(); if (cache.get(action) === e) drop(action) });
    }

    document.addEventListener('mouseover', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && !a.contains(evt.relatedTarget) && /hover/.test(mode(a))) {
            clearTimeout(timer);
            timer = setTimeout(start, cfg().prefetchDelay ?? 65, a, true);
        }
    });

    document.addEventListener('mouseout', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && !a.contains(evt.relatedTarget)) {
            clearTimeout(timer);
            if (last?.a === a && last.e.hover === true && !last.e.done) drop(last.action);   // the hover ended first
        }
    });

    document.addEventListener('touchstart', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && /hover/.test(mode(a))) start(a, true);
    }, {passive: true});

    // the keyboard: a link that gets focus is prefetched like a hovered one, unless the pointer put it there
    document.addEventListener('pointerdown', () => { pointer = true }, true);
    document.addEventListener('keydown', () => { pointer = false }, true);

    document.addEventListener('focusin', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && !pointer && /hover/.test(mode(a))) {
            clearTimeout(ftimer);
            ftimer = setTimeout(start, cfg().prefetchDelay ?? 65, a, 'focus');
        }
    });

    document.addEventListener('focusout', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a) {
            clearTimeout(ftimer);
            if (last?.a === a && last.e.hover === 'focus' && !last.e.done) drop(last.action);
        }
    });

    //------------------------------------------------------
    // the current link
    //------------------------------------------------------

    // Marks the links of a subtree that point to the page being shown, and clears the others.
    function current(root = document) {
        if (cfg().current === false) return;
        let here = location.origin + location.pathname + location.search;
        for (let a of [...root.querySelectorAll?.('a[href]') ?? [], ...root.matches?.('a[href]') ? [root] : []]) {
            let on = !a.hash && !a.hasAttribute('download') && (!a.target || a.target === '_self') && a.origin + a.pathname + a.search === here;
            if (on) {
                a.classList.add('ypy-current');
                a.setAttribute('aria-current', 'page');
            } else if (a.classList.contains('ypy-current') || a.getAttribute('aria-current') === 'page') {
                a.classList.remove('ypy-current');
                a.removeAttribute('aria-current');
            }
        }
    }

    window.addEventListener('popstate', () => current());

    //------------------------------------------------------
    // ypy-once
    //------------------------------------------------------

    // links that ask to be prefetched when they become visible
    function watch(root) {
        if (typeof IntersectionObserver != 'function') return;
        for (let a of [...root.querySelectorAll?.('a[href]') ?? [], ...root.matches?.('a[href]') ? [root] : []]) {
            if (/visible/.test(mode(a))) {
                io ||= new IntersectionObserver(entries => entries.forEach(x => {
                    if (x.isIntersecting) { io.unobserve(x.target); waiting.push(x.target); pump() }
                }));
                io.observe(a);
            }
        }
    }

    // The scripts of a subtree that ask to run once, with their identity.
    const onceScripts = root => [...root.querySelectorAll?.(sel('script[ypy-once]')) ?? []].map(s =>
        [s, api.attr(s, 'ypy-once') || s.getAttribute('src') || s.textContent]);

    ypy.registerExtension('ypy-nav', {
        init: a => { api = a },

        // a new page, or new content: the current link, and the scripts that came with it
        ypy_after_process: root => {
            current(root);
            watch(root);
            for (let [, id] of onceScripts(root)) ran.add(id);
        },

        ypy_after_history_update: () => current(),

        // a script that already ran does not come in again
        ypy_before_swap: (elt, {tasks}) => {
            for (let {fragment} of tasks) {
                for (let [script, id] of fragment ? onceScripts(fragment) : []) {
                    if (ran.has(id)) script.remove();
                    else ran.add(id);
                }
            }
        },

        // the click uses the response of the prefetch when it is the same request
        ypy_before_request: (elt, {ctx}) => {
            let r = ctx.request, e = r.method === 'GET' && !r.body && cache.get(r.action);
            if (e && e.k === key(r.headers)) {
                cache.delete(r.action);
                clearTimeout(e.t);
                let real = ctx.fetch;
                ctx.fetch = (...args) => e.p.catch(() => real(...args));
            }
        },

        // the page changed: what was prefetched for the old one is stale
        ypy_after_swap: (elt, {ctx}) => { if (ctx.request.headers['YPY-Boosted']) clear() }
    });

})();
