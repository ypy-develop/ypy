// SPDX-License-Identifier: MIT
//==========================================================
// ypy-list.js
//
// Keyed and bounded lists for the append and prepend swap styles:
//   key:<attr>   an item whose attribute has the value of one already in the list
//                replaces it where it stands instead of being added again
//                (`key` alone means the id)
//   limit:<n>    after the swap the list keeps at most n items; the oldest go
//                (the first ones for append, the last ones for prepend)
//
// Usage:
//   <ul ypy-get="/events" ypy-trigger="every 2s" ypy-swap="append key:data-id limit:50">...</ul>
//
// ypy:list:pruned fires on the list with the items that were removed to keep the limit.
// The list is the element the swap goes into; every element child counts as an item.
//==========================================================
(() => {
    let api;

    // A swap spec given as a string (a task made by an extension) is read in the same way.
    function spec(task) {
        let s = task.swapSpec;
        if (typeof s !== 'string') return s || {};
        let [style, ...mods] = s.trim().split(/\s+/);
        return {style, ...api.HCON.parse(mods.join(' '))};
    }

    // Takes an item out the way the core does for what it removes.
    function drop(el) {
        for (let e of [el, ...el.querySelectorAll('[data-ypy-powered]')]) {
            if (!e._ypy) continue;
            api.triggerEvent(e, 'ypy:before:cleanup', {}, false);
            for (let s of e._ypy.triggerSpecs) {
                clearInterval(s.interval);
                clearTimeout(s.timeout);
                s.observer?.disconnect();
            }
            for (let i of e._ypy.listeners) i.fromElt.removeEventListener(i.eventName, i.handler, i);
        }
        el.remove();
    }

    ypy.registerExtension('ypy-list', {
        init(internalAPI) { api = internalAPI },

        // After the swap, before the settle: the list never shows a duplicate or an item over the limit.
        ypy_before_settle(list, {task, newContent}) {
            let s = spec(task), style = {append: 'beforeend', prepend: 'afterbegin'}[s.style] || s.style;
            if (style !== 'beforeend' && style !== 'afterbegin') return;
            let key = s.key === true ? 'id' : s.key, limit = Math.floor(s.limit);
            let gone = new Set();

            if (key && typeof key === 'string') {
                let added = new Set(newContent), old = new Map(), fresh = new Map();
                for (let el of list.children) {
                    let v = added.has(el) ? null : el.getAttribute(key);
                    if (v != null && !old.has(v)) old.set(v, el);
                }
                for (let el of newContent) {
                    let v = el.nodeType === 1 && el.parentNode === list ? el.getAttribute(key) : null;
                    if (v == null) continue;
                    // the same key twice in one response: the last one counts
                    if (fresh.has(v)) { drop(fresh.get(v)); gone.add(fresh.get(v)) }
                    fresh.set(v, el);
                }
                for (let [v, el] of fresh) {
                    let was = old.get(v);
                    if (!was) continue;
                    was.replaceWith(el);
                    drop(was);
                }
            }

            if (limit >= 1) {
                let items = [...list.children], extra = items.length - limit;
                if (extra > 0) {
                    let removed = style === 'beforeend' ? items.slice(0, extra) : items.slice(-extra);
                    removed.forEach(el => { drop(el); gone.add(el) });
                    api.triggerEvent(list, 'ypy:list:pruned', {removed, limit, task});
                }
            }

            // what left the page is not processed after the swap
            for (let i = newContent.length; i--;) if (gone.has(newContent[i])) newContent.splice(i, 1);
        }
    });
})();
