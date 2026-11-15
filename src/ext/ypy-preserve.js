// SPDX-License-Identifier: MIT
//==========================================================
// ypy-preserve.js
//
// What the visitor was doing survives a swap: the modes of ypy-preserve that name a state, and the
// wait for an input method editor (IME).
//
// ypy-preserve="value selection focus scroll". A list of words separated by spaces, on the live
// element. Each word keeps one state of the element and of its descendants that have an `id`,
// through a morph and through a raw swap (innerHTML, outerHTML) alike:
//   value      the text, choice or checked state the visitor gave a field, when it differs from the
//              default the HTML had; a field the visitor did not touch follows the response
//   selection  the caret or the selected text of a field
//   focus      the focus, when the element had it before the swap
//   scroll     the scroll position of the element
// The modes do not combine with `true`, `all`, `attrs` or `children`, which the core reads. A
// response that wants the server to win marks the element with `ypy-morph-force`, the same
// attribute that makes it win over the state of a morph.
//
// IME. While the visitor composes text (compositionstart without compositionend, as with
// Japanese, Chinese or Korean input) in a field that a swap target contains, the swap waits for
// compositionend, so the candidate text is not cut in half. The wait ends after
// config.compositionTimeout milliseconds (3000 by default) at the latest. A page without this
// extension swaps at once.
//
// Only the extension API is used. The core waits for ctx.hold, a promise this extension sets.
//==========================================================
(() => {

    let api, composing, waiting = [];

    const MODES = ['value', 'selection', 'focus', 'scroll'];
    const saved = new WeakMap();   // ctx -> the state taken before its swap

    const sel = s => api.prefixSelector(s);
    const elementOf = t => typeof t === 'string' ? document.querySelector(t) : t;

    // the state of the elements that carry a mode, with their descendants that have an id
    function capture(targets) {
        let list = [];
        for (let elt of document.querySelectorAll(sel('[ypy-preserve]'))) {
            let modes = (api.attr(elt, 'ypy-preserve') || '').split(/\s+/);
            if (!modes.some(m => MODES.includes(m)) || !targets.some(t => t.contains(elt) || elt.contains(t))) continue;
            for (let node of [elt, ...elt.querySelectorAll('[id]')]) {
                let r = {node, id: node.id}, has = m => modes.includes(m);
                if (has('value') && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) && node.type !== 'file') {
                    r.check = /^(checkbox|radio)$/.test(node.type);
                    r.value = r.check ? node.checked : node.value;
                    // only what the visitor changed: select has no default, so it always counts
                    r.dirty = r.check ? node.checked !== node.defaultChecked : node.value !== node.defaultValue;
                }
                if (has('selection') && node.selectionStart != null) r.range = [node.selectionStart, node.selectionEnd, node.selectionDirection];
                if (has('scroll') && (node.scrollTop || node.scrollLeft)) r.scroll = [node.scrollLeft, node.scrollTop];
                if (has('focus') && node === document.activeElement) r.focus = true;
                list.push(r);
            }
        }
        return list;
    }

    // puts the state back on the node that is in the page now, once; `within` limits it to one swap target
    function restore(list, within) {
        for (let r of list || []) {
            let n = r.node.isConnected ? r.node : document.getElementById(r.id);
            if (r.done || !n || within && !(within.contains(n) || n.contains(within))) continue;
            r.done = true;
            // the response asked to win
            if (n.matches(sel('[ypy-morph-force]'))) continue;
            if (r.dirty) r.check ? n.checked = r.value : n.value = r.value;
            if (r.focus && document.activeElement !== n) n.focus({preventScroll: true});
            try { if (r.range) n.setSelectionRange(...r.range); } catch (e) { /* the field has no selection */ }
            if (r.scroll) [n.scrollLeft, n.scrollTop] = r.scroll;
        }
    }

    ypy.registerExtension('ypy-preserve', {
        init: a => {
            api = a;
            document.addEventListener('compositionstart', e => { composing = e.target; }, true);
            document.addEventListener('compositionend', () => {
                composing = null;
                // the browser may still fire the last input event of the composition
                setTimeout(() => waiting.splice(0).forEach(done => done()));
            }, true);
        },

        ypy_before_swap: (elt, {ctx, tasks}) => {
            let targets = tasks.map(t => elementOf(t.target)).filter(t => t instanceof Element);
            let take = () => saved.set(ctx, capture(targets));
            if (composing?.isConnected && targets.some(t => t.contains(composing))) {
                ctx.hold = new Promise(done => {
                    waiting.push(done);
                    setTimeout(done, ypy.config.compositionTimeout ?? 3000);
                }).then(take);
            } else {
                take();
            }
        },

        // right after the DOM work of a task, before the settle delay, so nothing flashes
        ypy_before_settle: (elt, {task}) => restore(saved.get(task.ctx), elementOf(task.target)),

        // what no task restored (an element that came back with the last one)
        ypy_after_swap: (elt, {ctx}) => {
            restore(saved.get(ctx));
            saved.delete(ctx);
        }
    });

})();
