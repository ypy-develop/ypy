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
// Grouping. Several regions that come into view together can share one request:
//
//   <div id="sales"  ypy-lazy="/reports/sales"  ypy-lazy-group="reports">...</div>
//   <div id="visits" ypy-lazy="/reports/visits" ypy-lazy-group="reports">...</div>
//
// Regions of the same group (the name) that enter the view within config.lazy.window (50 ms by
// default) are loaded with one GET: the URL is ypy-lazy-group-url of the first region that has it, or
// the ypy-lazy of the first region, plus ?group=<name>&id=<id>&id=<id> (the ids of the regions, in
// the order they came into view) and the header YPY-Lazy-Group. The server answers with one
// <ypy-partial id="sales">...</ypy-partial> per id; a partial with no ypy-swap replaces its region,
// like an individual region does. A region the answer leaves out is an error, like a failed one. A
// region without an id, or one that is alone in its window, loads on its own with its own URL, so
// the individual mode needs nothing from the server.
//
// Elements that carry ypy:before:init gates (the nonce extension) are checked like any other
// element YPY starts: an element that does not pass never loads. Only the public API and the
// extension API are used.
//==========================================================
(() => {

    let api, io;
    const groups = new Map();   // name -> {elts, timer}
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
        let group = api.attr(elt, 'ypy-lazy-group');
        if (!group || !elt.id) return single(elt);
        let g = groups.get(group);
        if (!g) groups.set(group, g = {elts: [], timer: setTimeout(() => flush(group), windowMs())});
        if (!g.elts.includes(elt)) g.elts.push(elt);
    }

    function windowMs() {
        let w = ypy.config.lazy?.window ?? 50;
        return typeof w == 'number' ? w : parseFloat(w) * (/\ds$/.test(w) ? 1000 : 1) || 0;
    }

    function single(elt) {
        let swap = api.attr(elt, 'ypy-swap') ?? 'outerHTML';
        setState(elt, 'error');
        ypy.ajax('GET', api.attr(elt, 'ypy-lazy'), {source: elt, target: elt, swap})
            .catch(error => fail(elt, {error}));
    }

    function flush(name) {
        let elts = groups.get(name).elts.filter(x => x.isConnected && x._ypy?.lazy);
        groups.delete(name);
        if (elts.length < 2) return elts.forEach(single);
        let first = elts[0], url = new URL(elts.map(x => api.attr(x, 'ypy-lazy-group-url')).find(Boolean) ||
            api.attr(first, 'ypy-lazy'), document.baseURI);
        url.searchParams.set('group', name);
        for (let x of elts) url.searchParams.append('id', x.id);
        elts.forEach(x => setState(x, 'error'));
        api.triggerEvent(first, 'ypy:lazy:group', {group: name, ids: elts.map(x => x.id), url: url.href});
        let batch = {elts, hit: new Set()};
        ypy.ajax('GET', url.origin == location.origin ? url.pathname + url.search + url.hash : url.href,
            {source: first, target: first, swap: 'none', lazyBatch: batch, headers: {'YPY-Lazy-Group': name}})
            .catch(error => failAll(batch, {error}))
            .then(() => failAll(batch, {error: new Error('ypy-lazy: no partial for the region')}, true));
    }

    // the regions of a batch the answer did not reach (missing: only the ones with no partial)
    function failAll(batch, detail, missing) {
        for (let x of batch.elts) {
            if (!(missing && batch.hit.has(x)) && !x.dataset.ypyState?.includes('error')) fail(x, detail);
        }
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

        // the partials of a group answer: a partial that names no swap replaces its region, and every
        // region that got one is marked as reached
        ypy_before_swap: (elt, {ctx, tasks}) => {
            let batch = ctx.lazyBatch;
            for (let task of batch ? tasks : []) {
                if (!batch.elts.includes(task.target)) continue;
                batch.hit.add(task.target);
                if (task.swapSpec.default) task.swapSpec = {...task.swapSpec, style: (api.attr(task.target, 'ypy-swap') || 'outerHTML').split(/\s/)[0]};
            }
        },

        // a failed region shows its own error content: the body of the error response is not swapped
        // in, unless the element chose a destination with ypy-error-swap
        ypy_response_error: (elt, {ctx}) => {
            if (elt._ypy?.lazy && api.attributeValue(elt, 'ypy-error-swap') == null) ctx.swap = 'none';
            ctx.lazyBatch ? failAll(ctx.lazyBatch, {ctx}) : fail(elt, {ctx});
        },

        ypy_error: (elt, detail) => detail.ctx?.lazyBatch ? failAll(detail.ctx.lazyBatch, detail) : fail(elt, detail)
    });

})();
