// SPDX-License-Identifier: MIT
//==========================================================
// ypy-sort.js
//
// Drag and drop reordering of a list, with a keyboard, and the new order sent to the server.
//
//   <ul ypy-sort ypy-sort-url="/tasks/order">
//     <li id="task-1">Write</li>
//     <li id="task-2">Review</li>
//     <li id="task-3">Ship</li>
//   </ul>
//
// The items are the children of the container that have an id. They get draggable="true" and, when
// they have none, tabindex="0" (also the items a later swap brings). While one is dragged it has
// data-ypy-state="dragging"; the list moves as the pointer passes over the other items. The native
// drag of the browser is used, so it needs no style and no script of the page.
//
// Keyboard, on a focused item: Space picks it up (data-ypy-state="grabbed"), ArrowUp and ArrowLeft
// move it one place before, ArrowDown and ArrowRight one place after, Space puts it down, Escape puts
// everything back. Without a picked up item the arrows move the focus between the items.
//
// When an item is dropped in a new place, ypy:sort:change fires on the container with {ids, item}
// (cancel it to put the list back), and ypy-sort-url gets a POST: the field `id` once per item, in
// the new order, plus whatever the container's ypy-vals and enclosing form carry. The request is
// the usual one (indicators, ypy-confirm, ypy-headers, events); the response is not swapped
// (out-of-band elements and partials in it are), and an answer of 400 or more, or a connection
// that fails, puts the list back in the old order and fires ypy:sort:revert with {ids, reason}.
// A container with no ypy-sort-url only reorders and fires ypy:sort:change. ypy-sort="false" leaves
// the element to the page.
//
// config.sort.messages = {grab, move, drop, cancel, revert} are said in a live region when the
// page sets them ("{position}" and "{total}" are replaced): the core has no text of its own.
//==========================================================
(() => {

    let api, live;
    const sel = s => api.prefixSelector(s);
    const items = c => [...c.children].filter(x => x.id);
    const ids = c => items(c).map(x => x.id);
    const itemOf = (c, e) => { let i = e.target.closest?.('[id]'); while (i && i.parentNode !== c) i = i.parentNode?.closest?.('[id]'); return i };

    // data-ypy-state holds space separated tokens; this sets or clears the one of the sort
    function setState(elt, state) {
        let tokens = (elt.dataset.ypyState || '').split(' ').filter(s => s && s != 'dragging' && s != 'grabbed');
        if (state) tokens.push(state);
        tokens[0] ? elt.dataset.ypyState = tokens.join(' ') : delete elt.dataset.ypyState;
    }

    function say(c, key, item) {
        let text = ypy.config.sort?.messages?.[key];
        if (!text) return;
        if (!live?.isConnected) {
            live = document.createElement('div');
            live.setAttribute('role', 'status');
            live.setAttribute('aria-live', 'polite');
            // visually hidden with an adopted style sheet: no style attribute, so a strict CSP allows it
            try {
                let sheet = new CSSStyleSheet();
                sheet.replaceSync('[data-ypy-sort-live]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
                document.adoptedStyleSheets.push(sheet);
            } catch {}
            live.dataset.ypySortLive = '';
            document.body.append(live);
        }
        let list = items(c);
        live.textContent = text.replace('{position}', list.indexOf(item) + 1).replace('{total}', list.length);
    }

    function revert(c, snapshot, reason) {
        let focused = c.contains(document.activeElement) ? document.activeElement : null;
        c.replaceChildren(...snapshot);
        focused?.focus();
        api.triggerEvent(c, 'ypy:sort:revert', {ids: ids(c), reason});
        say(c, 'revert', focused);
    }

    // the item was put down: tell the page, then the server
    function commit(c, item, snapshot) {
        let before = snapshot.filter(x => x.id).map(x => x.id), now = ids(c);
        if (before.join('\n') == now.join('\n')) return;
        if (!api.triggerEvent(c, 'ypy:sort:change', {ids: now, item})) return revert(c, snapshot, 'cancelled');
        let url = api.attr(c, 'ypy-sort-url');
        if (!url) return;
        let done, back = () => { if (!done && c.isConnected) { done = 1; revert(c, snapshot, 'failed') } };
        ypy.ajax('POST', url, {source: c, target: c, swap: 'none', sortIds: now, sortRevert: back}).catch(back);
    }

    function watch(c) {
        if (c._ypy?.sort || c.closest(sel('[ypy-ignore]')) || api.attr(c, 'ypy-sort') == 'false' ||
            !api.triggerEvent(c, 'ypy:before:init', {})) return;
        let state = api.ypyProp(c), drag, grab;
        state.sort = 1;
        let tag = () => items(c).forEach(x => {
            x.hasAttribute('draggable') || x.setAttribute('draggable', 'true');
            x.hasAttribute('tabindex') || x.setAttribute('tabindex', '0');
        });
        tag();
        (state.sortObserver = new MutationObserver(tag)).observe(c, {childList: true});
        let on = (name, handler) => {
            c.addEventListener(name, handler);
            state.listeners.push({fromElt: c, eventName: name, handler});
        };

        on('dragstart', e => {
            let item = itemOf(c, e);
            if (!item || item !== e.target) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.id);   // Firefox does not start a drag without data
            drag = {item, snapshot: [...c.childNodes]};
            setState(item, 'dragging');
        });
        on('dragover', e => {
            if (!drag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            let over = itemOf(c, e), item = drag.item;
            if (!over || over === item) return;
            let a = item.getBoundingClientRect(), b = over.getBoundingClientRect();
            // a row of items is crossed by x, a column by y
            let after = Math.abs(a.top - b.top) < b.height / 2 ? e.clientX > b.left + b.width / 2 : e.clientY > b.top + b.height / 2;
            if (after ? over.nextElementSibling !== item : over.previousElementSibling !== item) after ? over.after(item) : over.before(item);
        });
        on('drop', e => {
            if (!drag) return;
            e.preventDefault();
            drag.dropped = true;
        });
        on('dragend', () => {
            if (!drag) return;
            let {item, snapshot, dropped} = drag;
            drag = null;
            setState(item, null);
            dropped ? commit(c, item, snapshot) : revert(c, snapshot, 'cancelled');
        });

        on('keydown', e => {
            let item = itemOf(c, e);
            if (!item || item !== e.target || e.altKey || e.ctrlKey || e.metaKey) return;
            let list = items(c), i = list.indexOf(item), step = {ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1}[e.key];
            if (e.key == ' ') {
                e.preventDefault();
                if (!grab) {
                    grab = {item, snapshot: [...c.childNodes]};
                    setState(item, 'grabbed');
                    say(c, 'grab', item);
                } else {
                    let {snapshot} = grab;
                    grab = null;
                    setState(item, null);
                    say(c, 'drop', item);
                    commit(c, item, snapshot);
                }
            } else if (e.key == 'Escape' && grab) {
                e.preventDefault();
                let {snapshot} = grab;
                grab = null;
                setState(item, null);
                revert(c, snapshot, 'cancelled');
                item.focus();
                say(c, 'cancel', item);
            } else if (step) {
                e.preventDefault();
                let next = list[i + step];
                if (!next) return;
                if (grab?.item == item) {
                    step < 0 ? next.before(item) : next.after(item);
                    item.focus();
                    say(c, 'move', item);
                } else {
                    next.focus();
                }
            }
        });
    }

    ypy.registerExtension('ypy-sort', {
        init: a => { api = a },

        ypy_after_process: root => {
            for (let c of [...root.querySelectorAll?.(sel('[ypy-sort]')) ?? [], ...root.matches?.(sel('[ypy-sort]')) ? [root] : []]) watch(c);
        },

        ypy_before_cleanup: c => { c._ypy?.sortObserver?.disconnect() },

        // the new order goes in the body: the field `id` once per item
        ypy_config_request: (elt, {ctx}) => ctx.sortIds?.forEach(id => ctx.request.body.append('id', id)),

        // the server said no, or never answered: the list goes back
        ypy_response_error: (elt, {ctx}) => ctx.sortRevert?.(),
        ypy_error: (elt, {ctx}) => { if (ctx?.errorKind || ctx && !ctx.response) ctx.sortRevert?.() }
    });

})();
