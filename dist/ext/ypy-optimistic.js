// SPDX-License-Identifier: MIT
//==========================================================
// ypy-optimistic.js
//
// Optimistic UI for ypy: the page shows the result of a request before the server answers, and
// puts things back if the request fails.
//
// ypy-optimistic names what to show: a <template> or element (`#liked`), `remove` (the target
// goes away), or a function registered with ypy.optimistic.register(name, fn). The content is
// applied to the request target with the request's swap style. ypy-optimistic-target (a selector,
// extended forms such as `closest li` work) and ypy-optimistic-swap choose another place or style.
// A function gets {ctx, source, target, values} and returns HTML, a node or a list of nodes, or an
// undo function when it changes the page by itself.
//
// What ends it, once per request:
//   - a 4xx or 5xx response, a network failure, an abort or a cancelled request: everything is put
//     back (the original nodes, not copies) and ypy:optimistic:rolledback fires;
//   - a success: ypy:optimistic:confirmed fires. If the response is swapped into the same element
//     the server's content replaces the optimistic one (the original nodes are put back first, so a
//     morph keeps their identity); if nothing is swapped there (204, swap:none, another target)
//     the optimistic content stays as the final state and is processed.
// There is one overlay per element: a second request that changes the same element replaces (or,
// for append and prepend, adds to) the first. The overlay ends with the first success, or when the
// last request that wanted it has failed. Every ypy:optimistic:applied is followed by exactly one confirmed or rolledback.
//
// An outer style (outerHTML, outerMorph, delete) shows the content before the target and hides the
// target, which stays in the page so the request and the swap that aim at it still find it.
// The change is made right after ypy:before:request, so a request that is queued, dropped or
// not confirmed leaves nothing behind. The optimistic nodes get the ypy-optimistic class and are
// not processed while they are temporary.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <template id="liked"><button disabled>Liked</button></template>
//   <button ypy-post="/like/7" ypy-target="this" ypy-swap="outerMorph" ypy-optimistic="#liked">Like</button>
//==========================================================
(() => {

    let api;
    const fns = new Map();
    const active = new WeakMap();    // target element -> its overlay
    const records = new WeakMap();   // request context -> {elt, overlay, ok, done}
    // where each insertion style puts the nodes, as the Element method that does it
    const WHERE = {beforebegin: 'before', before: 'before', afterend: 'after', after: 'after', afterbegin: 'prepend', prepend: 'prepend', beforeend: 'append', append: 'append'};

    // The nodes a specification stands for.
    function nodesFor(spec, elt, ctx, target) {
        let fn = fns.get(spec), out;
        if (fn) {
            out = fn({ctx, source: elt, target, values: Object.fromEntries(ctx.request.body ?? [])});
            if (typeof out == 'string') {
                let policy = api.ttPolicy(), tpl = document.createElement('template');
                if (!policy) return [];
                tpl.innerHTML = policy.createHTML(out);
                out = tpl.content;
            }
            if (out instanceof Node) return out.nodeType === 11 ? [...out.childNodes] : [out];
            return Array.isArray(out) || out instanceof NodeList ? [...out] : typeof out == 'function' ? out : null;
        }
        if (spec === 'remove') return [];
        let source = ypy.find(elt, spec);
        return source ? [...(source.content ?? source).childNodes].map(n => n.cloneNode(true)) : null;
    }

    // Shows the nodes on the overlay's target the way its swap style does. An outer style puts them
    // before the target and hides the target instead of taking it out: it stays in the page, so the
    // request that came from it, and the swap that is aimed at it, still find it.
    function put(o, nodes) {
        for (let n of nodes) n.classList?.add('ypy-optimistic');
        let t = o.target;
        if (o.outer) {
            o.display = t.style.display;
            t.before(...nodes);
            t.style.display = 'none';
        } else if (o.inner) {
            t.append(...nodes);
        } else {
            t[o.where](...nodes);
        }
    }

    // Puts the page back as it was, unless somebody else changed the place in the meantime.
    function revert(o) {
        if (o.done) return;
        o.done = true;
        if (active.get(o.target) === o) active.delete(o.target);
        if (o.undo) return o.undo();
        let {target: t, nodes, home} = o, intact = nodes.every(n => n.parentNode === home);
        for (let n of nodes) n.remove();
        if (o.outer) t.style.display = o.display;
        if (o.inner && intact) t.append(...o.saved.childNodes);
    }

    // The overlay's nodes become the real content.
    function commit(o) {
        if (o.done) return;
        o.done = true;
        if (active.get(o.target) === o) active.delete(o.target);
        if (o.outer) o.target.remove();
        for (let n of o.nodes ?? []) {
            n.classList?.remove('ypy-optimistic');
            if (n.nodeType === 1 && n.isConnected) ypy.process(n);
        }
    }

    // Ends the change of one request, once: `ok` keeps it (confirmed). Otherwise the request leaves
    // the overlay, and the page is put back when no other request still wants it.
    function settle(ctx, ok, detail) {
        let r = records.get(ctx), o = r?.overlay;
        if (!r || r.settled) return;
        r.settled = true;
        if (ok) commit(o);
        else {
            o.ctxs.delete(ctx);
            if (!o.ctxs.size) revert(o);
        }
        api.triggerEvent(r.elt, 'ypy:optimistic:' + (ok ? 'confirmed' : 'rolledback'), {ctx, target: o.target, ...detail});
    }

    function apply(elt, ctx, spec) {
        let sel = api.attr(elt, 'ypy-optimistic-target'), target = sel ? ypy.find(elt, sel) : ctx.target;
        if (!elt.isConnected || !target?.isConnected) return;
        let swap = (api.attr(elt, 'ypy-optimistic-swap') || ctx.swap || '').trim(), style = /^\S*:/.test(swap) ? '' : swap.split(/\s+/)[0];
        if (!WHERE[style] && !/^(outer|inner|morph|delete)/.test(style)) style = 'innerHTML';
        let outer = /^(outer|delete)/.test(style), where = WHERE[style], inner = !outer && !where;
        let nodes = nodesFor(spec, elt, ctx, target), o = active.get(target);
        if (typeof nodes == 'function') {
            o = {target, undo: nodes};
        } else if (!nodes) {
            return;
        } else {
            if (o) {
                // one shape per element: a second change replaces the first (inner) or adds to it (insertion)
                if (o.undo || o.outer || outer || o.inner !== inner || o.where !== where) return;
                if (inner) o.nodes.forEach(n => n.remove());
                else o.nodes.push(...nodes);
                put(o, nodes);
                if (inner) o.nodes = nodes;
            } else {
                o = {target, nodes, outer, inner, where, ctxs: new Set()};
                o.home = outer || where === 'before' || where === 'after' ? target.parentNode : target;
                if (inner) {
                    o.saved = document.createDocumentFragment();
                    o.saved.append(...target.childNodes);
                }
                put(o, nodes);
                active.set(target, o);
            }
        }
        (o.ctxs ??= new Set()).add(ctx);
        records.set(ctx, {elt, overlay: o});
        if (!api.triggerEvent(elt, 'ypy:optimistic:applied', {ctx, target, nodes: o.nodes})) settle(ctx, false, {reason: 'cancelled'});
    }

    ypy.registerExtension('ypy-optimistic', {

        init: (internalApi) => {
            api = internalApi;
            ypy.optimistic = {
                /** Makes fn usable as ypy-optimistic="name". */
                register(name, fn) {
                    if (!name || typeof fn != 'function') throw new TypeError('register(name, fn)');
                    fns.set(name, fn);
                }
            };
        },

        ypy_before_request: (elt, {ctx}) => {
            let spec = api.attributeValue(elt, 'ypy-optimistic');
            // after the event has reached the element: the change may take the element out of the page
            if (spec && spec !== 'false') queueMicrotask(() => apply(elt, ctx, spec));
        },

        ypy_before_response: (elt, {ctx}) => {
            let r = records.get(ctx), {status} = ctx.response;
            if (!r) return;
            if (status >= 400) settle(ctx, false, {reason: 'status', status});
            else r.ok = status;
        },

        // the response is about to be swapped: the server's content replaces the optimistic one
        // where they meet, and the optimistic content stays where nothing else is put
        ypy_before_swap: (elt, {ctx, tasks}) => {
            let r = records.get(ctx), o = r?.overlay;
            if (!r || r.settled || !r.ok) return;
            let meets = tasks.some(t => {
                let to = typeof t.target == 'string' ? document.querySelector(t.target) : t.target, s = t.swapSpec?.style ?? t.swapSpec;
                return to === o.target && !/^none/.test(s);
            });
            if (meets && !o.undo) revert(o);
            settle(ctx, true, {status: r.ok});
        },

        ypy_error: (elt, {ctx}) => {
            if (ctx) settle(ctx, false, {reason: 'error', kind: ctx.errorKind});
        },

        ypy_finally_request: (elt, {ctx}) => {
            let r = records.get(ctx);
            if (r && !r.settled) settle(ctx, !!r.ok, r.ok ? {status: r.ok} : {reason: ctx.request.signal.aborted ? 'aborted' : 'cancelled'});
        }
    });

})();
