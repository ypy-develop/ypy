// SPDX-License-Identifier: MIT
//==========================================================
// ypy-lazy.js
//
// Regions that load when they come into view.
//
//   <div ypy-lazy="/reports/summary">Loading the summary...</div>
//
// The value is the URL of a GET request (the same origin, like every YPY request). When the
// element is about to be seen (config.lazy.margin, 200px by default) the extension requests
// the URL and the response replaces the element (outerHTML; ypy-swap, ypy-target and the other
// attributes of the element work as on ypy-get). It is an attribute, never a Custom Element, so
// it works on <tr>, <tbody>, <li>... where a Custom Element is not allowed. The element needs a
// box to be seen: an <option>, or anything with display:none or display:contents, never loads.
//
// While it waits, the content of the element is the placeholder. It is also what a visitor
// without JavaScript sees, so put a link there: <div ypy-lazy="/panel"><a href="/panel">Open
// the panel</a></div>. ypy-lazy-placeholder="#id" names a <template> (or an element) whose
// content replaces the children as soon as the element is processed, for a skeleton that only
// visitors with JavaScript get. The core marks the element during the request (the ypy-request
// class, data-ypy-state="request", aria-busy).
//
// If the request fails (no connection, a status of 400 or more, a swap error) the element gets
// data-ypy-state="error" and ypy:lazy:error fires on it with {ctx, error}. The body of an error
// response is not swapped in (ypy-error-swap="outerHTML" asks for it). ypy-lazy-error="#id"
// names a <template> (or an element) whose content replaces the children. An element with
// ypy-lazy-retry inside a failed region loads it again when clicked.
//
// Elements that carry ypy:before:init gates (the nonce extension) are checked like any other
// element YPY starts: an element that does not pass never loads. Only the public API and the
// extension API are used.
//==========================================================
(() => {

    let api, io;
    const sel = s => api.prefixSelector(s);

    // the content of a <template> or of an element, cloned; null when the attribute is absent or
    // its selector finds nothing (":not(*)" matches nothing)
    function content(elt, name) {
        let src = document.querySelector(api.attr(elt, name) || ':not(*)');
        return src && (src.content || src).cloneNode(true).childNodes;
    }

    function setState(elt, state, on) {
        let tokens = (elt.dataset.ypyState || '').split(' ').filter(s => s && s !== state);
        if (on) tokens.push(state);
        tokens[0] ? elt.dataset.ypyState = tokens.join(' ') : delete elt.dataset.ypyState;
    }

    function load(elt) {
        let swap = api.attr(elt, 'ypy-swap') ?? 'outerHTML';
        setState(elt, 'error');
        ypy.ajax('GET', api.attr(elt, 'ypy-lazy'), {source: elt, target: elt, swap})
            .catch(error => fail(elt, {error}));
    }

    function fail(elt, detail) {
        if (!elt._ypy?.lazy || !elt.isConnected) return;
        setState(elt, 'error', true);
        let error = content(elt, 'ypy-lazy-error');
        if (error) elt.replaceChildren(...error);
        api.triggerEvent(elt, 'ypy:lazy:error', detail);
    }

    function watch(elt) {
        if (elt._ypy?.lazy || elt.closest(sel('[ypy-ignore]')) || !api.attr(elt, 'ypy-lazy') ||
            !api.triggerEvent(elt, 'ypy:before:init', {})) return;
        let state = api.ypyProp(elt), placeholder = content(elt, 'ypy-lazy-placeholder');
        state.lazy = 1;
        if (placeholder) elt.replaceChildren(...placeholder);
        let retry = evt => {
            let button = evt.target.closest?.(sel('[ypy-lazy-retry]'));
            if (button && elt.contains(button) && elt.dataset.ypyState?.includes('error')) load(elt);
        };
        elt.addEventListener('click', retry);
        state.listeners.push({fromElt: elt, eventName: 'click', handler: retry});
        if (typeof IntersectionObserver == 'function') {
            io ||= new IntersectionObserver(entries => entries.forEach(x => {
                if (x.isIntersecting) { io.unobserve(x.target); load(x.target) }
            }), {rootMargin: ypy.config.lazy?.margin ?? '200px'});
            io.observe(elt);
        } else {
            load(elt);
        }
    }

    ypy.registerExtension('ypy-lazy', {
        init: a => { api = a },

        ypy_after_process: root => {
            for (let elt of [...root.querySelectorAll?.(sel('[ypy-lazy]')) ?? [], ...root.matches?.(sel('[ypy-lazy]')) ? [root] : []]) {
                watch(elt);
            }
        },

        ypy_before_cleanup: elt => { if (elt._ypy?.lazy) io?.unobserve(elt) },

        // a failed region shows its own error content: the body of the error response is not swapped
        // in, unless the element chose a destination with ypy-error-swap
        ypy_response_error: (elt, {ctx}) => {
            if (elt._ypy?.lazy && api.attributeValue(elt, 'ypy-error-swap') == null) ctx.swap = 'none';
            fail(elt, {ctx});
        },

        ypy_error: (elt, detail) => fail(elt, detail)
    });

})();
