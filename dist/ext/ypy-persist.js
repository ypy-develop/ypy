// SPDX-License-Identifier: MIT
//==========================================================
// ypy-persist.js
//
// Elements that outlive a navigation, and deploy detection.
//
// ypy-persist. An element with an id and ypy-persist stays in the page when a navigation (a
// boosted link or form, back and forward) brings a response that holds an element with the same
// id: the live element, with its state (a playing video, an iframe, typed text, a third-party
// widget), takes the place of the new one. The attribute goes on the live element only; the
// server does not have to mark the next page. It is the same mechanism as ypy-preserve, applied
// to the elements the page asks to keep. A response without the id removes the element as any
// other. A swap that is not a navigation never keeps anything.
//
// ypy-track="reload". An element of the page (usually in <head>) that carries it names a value:
// <meta name="app-version" content="a1b2c3" ypy-track="reload">. When a response that is a whole
// page does not carry the same tracked elements with the same values (a changed content, href,
// src or text, an element added or gone), the page was deployed after it loaded: the extension
// fires the cancelable ypy:track:reload event (detail: {url, from, to}) and, unless a listener
// cancels it (the response is then swapped as usual), loads the URL of the response with a
// normal page load instead of swapping it. A
// response that is a fragment, an error, or the answer to a request that is not a GET never
// triggers it. A page that tracks nothing pays one attribute lookup per response.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {

    let api;

    const sel = s => api.prefixSelector(s);

    // the identity and value of every tracked element of a document, in a comparable form
    const tracked = doc => [...doc.querySelectorAll(sel('[ypy-track="reload"]'))].map(e =>
        e.tagName + '|' + (e.getAttribute('name') || e.id) + '|' +
        (e.getAttribute('content') ?? e.getAttribute('href') ?? e.getAttribute('src') ?? e.getAttribute('value') ?? e.textContent)).sort();

    ypy.registerExtension('ypy-persist', {
        init: a => { api = a },

        ypy_before_swap: (elt, {ctx, tasks}) => {
            let h = ctx.request.headers;
            if (!h['YPY-Boosted'] && !h['YPY-History-Restore-Request']) return;
            for (let live of document.querySelectorAll(sel('[ypy-persist][id]'))) {
                if (api.attr(live, 'ypy-persist') === 'false') continue;
                for (let task of tasks) {
                    // the response copy becomes a ypy-preserve element, and the core keeps the live one
                    task.fragment?.querySelector?.('#' + CSS.escape(live.id))?.setAttribute('ypy-preserve', '');
                }
            }
        },

        ypy_after_request: (elt, {ctx}) => {
            let {text, request: r, response} = ctx, now = tracked(document);
            if (r.method !== 'GET' || response.status >= 400 || !now.length && !text.includes('ypy-track') ||
                !/<(?:!doctype|html|head|body)\b/i.test(text.slice(0, 2048))) return;
            let policy = api.ttPolicy();
            let next = tracked(new DOMParser().parseFromString(policy ? policy.createHTML(text) : text, 'text/html'));
            if (now.join() === next.join()) return;
            let url = response.raw.url || new URL(r.action, document.baseURI).href;
            if (!api.triggerEvent(elt, 'ypy:track:reload', {ctx, url, from: now, to: next})) return;
            location.assign(url);
            return false;
        }
    });

})();
