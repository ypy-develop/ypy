// SPDX-License-Identifier: MIT
//==========================================================
// ypy-layers.js
//
// Layers: modals, drawers and popups that stack on the native <dialog>. No style is
// required: the extension ships one optional, zero-specificity stylesheet that the
// page can turn off (config.layers.style = false) or override with the --ypy-layer-*
// variables and with classes (config.layers.classes). Nothing is written to a style
// attribute, so a strict CSP is fine. Full reference: https://ypy.dev/docs/reference/layers.
//
// Open a layer
//   <a href="/items/new" ypy-layer="modal">New</a>        a link or a form; the response fills the layer
//   <button ypy-get="/menu" ypy-layer="popup">Menu</button>
//   ypy.layers.open('/items/new', {mode: 'drawer'})       a URL, or a string of HTML ("<...")
//   response header  YPY-Open-Layer: {"url":"/items/new","mode":"modal","closeOn":"saved"}
//
// Options (API object, ypy-layer-* attributes on the opener, keys of the header JSON):
//   mode (modal|drawer|popup)  closeOn (events)  closeOnUrl (globs)  closeOnFragment (selector)
//   outside  escape  history  side  label  class  select  values  method
//
// Result: open() returns a promise that settles when the layer closes with
//   {accepted: true, value} or {accepted: false, reason}; promise.layer is the handle.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {
    let api;

    const KINDS = ['modal', 'drawer', 'popup'];
    const DIALOG = 'dialog[data-ypy-layer-kind]';
    const KEYS = ['url', 'html', 'mode', 'closeOn', 'closeOnUrl', 'closeOnFragment', 'history', 'side', 'label', 'outside', 'escape', 'class'];
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    const stack = [], layers = new WeakMap(), wired = new WeakSet();
    let seq = 0, sheet, ownBack = false;

    //============================================================================================
    // Configuration, parsing, style
    //============================================================================================

    const cfg = () => ({style: true, scrollLock: true, outside: true, escape: true, history: false, ...ypy.config.layers});
    const opener = () => ypy.config.layers?.classes?.opener ?? 'ypy-layer-opener';
    const list = v => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).filter(Boolean);
    const json = v => { try { return JSON.parse(v) } catch { return v } };
    const glob = (p, s) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s);
    const layerOf = elt => layers.get(elt?.closest?.(DIALOG));
    const sel = n => api.prefixSelector('[ypy-' + n + ']');
    const bool = v => v == null ? undefined : v !== 'false';
    const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

    function style() {
        if (sheet || cfg().style === false) return;
        try {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`
:where(dialog[data-ypy-layer-kind]){box-sizing:border-box;background:var(--ypy-layer-bg,Canvas);color:var(--ypy-layer-color,CanvasText);border:var(--ypy-layer-border,1px solid #8884);border-radius:var(--ypy-layer-radius,.5rem);padding:var(--ypy-layer-padding,1rem);width:var(--ypy-layer-width,min(32rem,calc(100% - 2rem)));max-width:100%;max-height:var(--ypy-layer-max-height,calc(100dvh - 2rem));overflow:auto;box-shadow:var(--ypy-layer-shadow,0 .5rem 2rem #0005)}
:where(dialog[data-ypy-layer-kind])::backdrop{background:var(--ypy-layer-backdrop,#0006)}
:where(dialog[data-ypy-layer-kind=drawer]){inset:0 0 0 auto;margin:0;height:100dvh;max-height:none;border-radius:0;width:var(--ypy-layer-drawer-width,min(24rem,100%))}
:where(dialog[data-ypy-layer-side=start]){inset:0 auto 0 0}
:where(dialog[data-ypy-layer-side=top],dialog[data-ypy-layer-side=bottom]){width:100%;height:auto;max-height:var(--ypy-layer-drawer-height,50dvh)}
:where(dialog[data-ypy-layer-side=top]){inset:0 0 auto 0}
:where(dialog[data-ypy-layer-side=bottom]){inset:auto 0 0 0}
:where(dialog[data-ypy-layer-kind=popup]){position:fixed;inset:auto;top:var(--ypy-layer-popup-top,1rem);right:var(--ypy-layer-popup-right,1rem);margin:0;z-index:var(--ypy-layer-z,1000);width:var(--ypy-layer-popup-width,min(20rem,calc(100% - 2rem)))}
@supports(anchor-name:--a){
:where(.${CSS.escape(opener())}){anchor-name:--ypy-layer}
:where(dialog[data-ypy-layer-anchored]){position-anchor:--ypy-layer;inset:auto;top:anchor(bottom);left:anchor(left);margin:.25rem 0 0;position-try-fallbacks:flip-block,flip-inline}}
:root[data-ypy-layer-lock]{overflow:hidden;scrollbar-gutter:stable}`);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        } catch { sheet = null }
    }

    // The page behind a modal or a drawer does not scroll
    const sync = () => cfg().scrollLock && document.documentElement.toggleAttribute('data-ypy-layer-lock', stack.some(l => l.mode != 'popup'));

    //============================================================================================
    // Opening
    //============================================================================================

    /**
     * Creates a layer and fills it; it is shown once its content is in. Returns a promise of the
     * result, with the handle as promise.layer.
     */
    function open(spec, o = {}) {
        o = {...o};
        if (spec && typeof spec == 'object') o = {...spec, ...o};
        else if (typeof spec == 'string') o[/^\s*</.test(spec) ? 'html' : 'url'] = spec;
        let mode = KINDS.includes(o.mode) ? o.mode : 'modal', c = cfg(), src = o.source, host;
        if (!api.triggerEvent(src?.isConnected ? src : document, 'ypy:layer:before:open', {options: o, mode})) return Promise.resolve({accepted: false, reason: 'cancelled'});
        style();

        let d = document.createElement('dialog'), top = stack.at(-1);
        // a popup over a modal has to live inside it: the rest of the page is inert while a modal is open
        host = mode == 'popup' && top ? (top.mode == 'popup' ? top.element.parentElement : top.element) : document.body;
        d.id = 'ypy-layer-' + ++seq;
        d.tabIndex = -1;
        d.setAttribute('data-ypy-layer-kind', mode);
        if (mode != 'popup') d.setAttribute('aria-modal', 'true');
        if (mode == 'drawer') d.setAttribute('data-ypy-layer-side', o.side || 'end');
        if (o.label) d.setAttribute('aria-label', o.label);
        d.classList.add(...list(`${c.classes?.[mode] ?? ''} ${o.class ?? ''}`));
        if (mode == 'popup' && src?.isConnected) d.setAttribute('data-ypy-layer-anchored', '');

        let L = {
            element: d, mode, source: src, options: o, closed: false, loaded: false, shown: false,
            returnTo: src?.isConnected ? src : document.activeElement,
            outside: o.outside ?? c.outside, escape: o.escape ?? c.escape,
            history: (o.history ?? c.history) && ypy.config.history !== false,
            accept: v => finish(L, true, v),
            dismiss: r => finish(L, false, r ?? 'dismissed')
        };
        layers.set(d, L);
        let p = new Promise(resolve => L.resolve = resolve);
        p.layer = L;
        L.result = p;
        host.append(d);

        // close by an event: the value is its detail. An event from inside the layer counts for that layer;
        // one from the page counts for the top one.
        L.off = list(o.closeOn).map(name => {
            let h = e => {
                let from = e.target instanceof Element && e.target.closest(DIALOG);
                if (from ? layers.get(from) === L : stack.at(-1) === L) L.accept(e.detail);
            };
            document.addEventListener(name, h);
            return [name, h];
        });
        listen(L);

        // The content is in (or will never come): show the layer. A request tells it by ypy:finally:request or
        // ypy:request:dropped, which is why the promise of ypy.ajax (it ends when the request is queued) is no use.
        L.settle = () => L.closed || (L.loaded ? reveal(L) : finish(L, false, 'error', true));
        let base = {layer: L, target: d, swap: 'innerHTML', push: false, replace: false};
        if (o.html != null) ypy.swap({...base, sourceElement: d, text: String(o.html)}).then(L.settle, L.settle);
        else ypy.ajax(String(o.method || 'GET').toUpperCase(), o.url, {...base, ...defined({source: src, event: o.event, select: o.select, values: o.values})}).catch(L.settle);
        return p;
    }

    function reveal(L) {
        let d = L.element;
        try { L.mode == 'popup' ? d.show() : d.showModal() } catch { return finish(L, false, 'error', true) }
        L.shown = true;
        stack.push(L);
        d.setAttribute('data-ypy-layer-depth', stack.length);
        sync();
        if (L.mode == 'popup' && L.source?.isConnected) L.source.classList.add(opener());
        if (L.history && L.url) {
            // a browser may refuse a write (Safari: 100 per 10 seconds): the layer then opens without its URL
            try {
                if (!history.state?.ypy) history.replaceState({ypy: true}, '', location.href);
                history.pushState({ypy: true, ypyLayer: d.id}, '', L.url);
                L.pushed = true;
            } catch {}
        }
        focus(L);
        api.triggerEvent(d, 'ypy:layer:opened', {layer: L});
    }

    // The layer holds the focus: on the first control, or on the layer itself when it has none
    function focus(L) {
        let d = L.element;
        if (!d.contains(document.activeElement)) (d.querySelector('[autofocus]') || d.querySelector(FOCUSABLE) || d).focus({preventScroll: true});
    }

    //============================================================================================
    // Closing
    //============================================================================================

    /**
     * Closes a layer: first the layers above it, then it. A ypy:layer:before:close listener may cancel
     * (unless force is set); the closing then returns false and nothing changes.
     */
    function finish(L, accepted, v, force) {
        if (L.closed) return true;
        let i = stack.indexOf(L), detail = {layer: L, accepted, ...(accepted ? {value: v} : {reason: v})};
        for (let c of i < 0 ? [] : stack.slice(i + 1).reverse()) if (!finish(c, false, 'parent', force)) return false;
        if (L.shown && !force && !api.triggerEvent(L.element, 'ypy:layer:before:close', detail)) return false;
        L.closed = true;
        if (i >= 0) stack.splice(i, 1);
        for (let [name, h] of L.off) document.removeEventListener(name, h);
        sync();
        if (L.mode == 'popup') L.source?.classList?.remove(opener());
        let d = L.element;
        if (d.open) d.close();
        if (L.pushed && !L.popped && history.state?.ypyLayer == d.id) {
            ownBack = true;
            setTimeout(() => ownBack = false, 500);
            history.back();
        }
        if (L.returnTo?.isConnected) L.returnTo.focus?.({preventScroll: true});
        api.triggerEvent(d, accepted ? 'ypy:layer:accepted' : 'ypy:layer:dismissed', detail);
        d.remove();
        L.resolve(accepted ? {accepted, value: v} : {accepted, reason: v});
        return true;
    }

    //============================================================================================
    // Inside a layer: Esc, a click outside, accept and dismiss buttons, links and forms
    //============================================================================================

    const outside = (d, e) => {
        let r = d.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };

    function listen(L) {
        let d = L.element, down;
        d.addEventListener('cancel', e => { e.preventDefault(); if (L.mode != 'popup' && L.escape) L.dismiss('escape') });
        d.addEventListener('close', () => L.closed || finish(L, false, d.returnValue || 'closed', true));
        d.addEventListener('pointerdown', e => down = e.target == d && outside(d, e));
        d.addEventListener('click', e => {
            let t = e.target;
            if (t == d) {
                if (down && L.outside && outside(d, e)) L.dismiss('outside');
                return down = false;
            }
            if (!(t instanceof Element) || layerOf(t) != L) return;
            let b = t.closest(sel('layer-accept') + ',' + sel('layer-dismiss'));
            if (b && d.contains(b)) {
                e.preventDefault();
                let a = api.attr(b, 'ypy-layer-accept');
                return a != null ? L.accept(a ? json(a) : undefined) : L.dismiss(api.attr(b, 'ypy-layer-dismiss') || undefined);
            }
            let a = t.closest('a[href]');
            if (a && d.contains(a) && !e.defaultPrevented && !e.button && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
                && /^(_self)?$/.test(a.target) && !a.hasAttribute('download') && !a.getAttribute('href').startsWith('#') && a.origin == location.origin && stays(a, e)) {
                e.preventDefault();
                go(L, 'GET', a.getAttribute('href'), a, e);
            }
        });
        d.addEventListener('submit', e => {
            let f = e.target, s = e.submitter;
            if (!(f instanceof HTMLFormElement) || layerOf(f) != L || e.defaultPrevented) return;
            let {action, method} = api.determineMethodAndAction(f, e);
            action ||= s?.getAttribute('formaction') ?? f.getAttribute('action') ?? location.href;
            if (method == 'DIALOG' || !/^(_self)?$/.test(s?.formTarget || f.target) || new URL(action, location.href).origin != location.origin || !stays(f, e)) return;
            e.preventDefault();
            go(L, method, action, f, e);
        });
    }

    // Does the layer take over this link or form? Not when it opens a layer, has a request of its own
    // (ypy-get...), or opts out with ypy-boost="false".
    function stays(elt, e) {
        return !elt.matches(sel('layer')) && !api.determineMethodAndAction(elt, e).action && api.attributeValue(elt, 'ypy-boost') != 'false';
    }

    // A link or form inside a layer navigates the layer, unless it names a target or a swap of its own
    function go(L, method, url, source, event) {
        let has = n => api.attributeValue(source, n) != null;
        return ypy.ajax(method, url, {
            source, event, layer: L, push: false, replace: false,
            ...(has('ypy-target') ? {} : {target: L.element}),
            ...(has('ypy-swap') ? {} : {swap: 'innerHTML'})
        }).catch(() => {});
    }

    //============================================================================================
    // Openers: an element with ypy-layer
    //============================================================================================

    function wire(elt) {
        if (wired.has(elt) || elt.closest(sel('ignore'))) return;
        // the same gate the core applies before it initializes an element (the nonce extension answers it)
        if (!api.triggerEvent(elt, 'ypy:before:init', {layers: true})) return;
        wired.add(elt);
        // the core cancels the click of a link; with a modifier key the browser keeps it (a new tab)
        if (elt.matches('a[href]')) elt.addEventListener('click', e => { if (e.ctrlKey || e.metaKey || e.shiftKey) e.stopImmediatePropagation() }, true);
        api.onTrigger(elt, api.attributeValue(elt, 'ypy-trigger', undefined, undefined, false) || (elt.matches('form') ? 'submit' : 'click'), evt => activate(elt, evt));
    }

    function activate(elt, evt) {
        let {action, method} = api.determineMethodAndAction(elt, evt);
        action ??= evt.submitter?.getAttribute?.('formaction') ?? elt.getAttribute(elt.matches('a') ? 'href' : 'action') ?? (elt.matches('form') ? location.href : null);
        if (action == null) return;
        evt.preventDefault?.();
        let mode = api.attr(elt, 'ypy-layer'), shown = stack.find(l => l.mode == 'popup' && l.source == elt);
        if (shown) return shown.dismiss('toggle');
        let a = n => api.attributeValue(elt, 'ypy-layer-' + n);
        open({url: action}, defined({
            mode, method, source: elt, event: evt, closeOn: a('close-on'), closeOnUrl: a('close-on-url'), closeOnFragment: a('close-on-fragment'),
            outside: bool(a('outside')), escape: bool(a('escape')), history: bool(a('history')), side: a('side'), label: a('label'), class: a('class')
        }));
    }

    //============================================================================================
    // Extension hooks and the public API
    //============================================================================================

    // A layer's content has arrived: name the layer after its heading, keep the focus inside
    function ready(L, own) {
        let d = L.element;
        if (own) {
            L.loaded = true;
            if (L.shown) d.scrollTop = 0;
        }
        if (!d.hasAttribute('aria-label')) {
            let h = d.querySelector('h1,h2,h3,[role=heading]');
            if (h) d.setAttribute('aria-labelledby', h.id ||= d.id + '-title');
            else d.removeAttribute('aria-labelledby');
        }
        if (L.shown) {
            focus(L);
            if (own && L.pushed && L.url) try { history.replaceState({ypy: true, ypyLayer: d.id}, '', L.url) } catch {}
        }
    }

    const hooks = {
        init(internalApi) { api = internalApi },

        // an element that opens a layer is the extension's, not the core's
        ypy_before_init(elt, detail) {
            if (!detail.layers && elt.matches?.(sel('layer'))) return false;
        },

        ypy_after_process(root) {
            for (let elt of [root, ...root.querySelectorAll(sel('layer'))]) if (elt.matches?.(sel('layer'))) wire(elt);
        },

        ypy_before_cleanup(elt) { wired.delete(elt) },

        // the request that fills a layer has ended: swapped, failed or answered with a header
        ypy_finally_request(elt, {ctx}) {
            let L = ctx.layer;
            if (L && !L.shown && ctx.target == L.element) L.settle();
        },

        // the server can tell a request from a layer by YPY-Layer (send Vary: YPY-Layer with a cacheable answer)
        ypy_config_request(elt, {ctx}) {
            let L = ctx.layer ||= layerOf(elt);
            if (L) ctx.request.headers['YPY-Layer'] = L.mode;
        },

        // YPY-Open-Layer: the response opens a layer instead of being swapped
        ypy_after_request(elt, {ctx}) {
            let h = ctx.ypy?.openlayer, o;
            if (h == null) return;
            try { o = h.trim()[0] == '{' ? JSON.parse(h) : {url: h} } catch (error) { return console.warn('ypy: layers: YPY-Open-Layer is not valid', {error}) }
            if (!o || typeof o != 'object') return;
            if (ctx.layer && !ctx.layer.shown) finish(ctx.layer, false, 'replaced', true);
            open(Object.fromEntries(KEYS.filter(k => k in o).map(k => [k, o[k]])), {source: elt});
            return false;
        },

        // what a swap into a layer may do before it happens: close the layer, or keep the address bar
        ypy_before_swap(elt, {ctx, tasks}) {
            let L = ctx.layer;
            if (!L) return;
            if (L.closed) return false;
            if (ctx.target != L.element) return;
            ctx.push = ctx.replace = null;
            if (ctx.ypy) ctx.ypy.pushurl = ctx.ypy.replaceurl = undefined;
            try {
                let u = new URL(ctx.response?.raw?.url || ctx.request?.action, location.href);
                L.url = u.pathname + u.search;
            } catch { /* no URL to follow */ }
            if (L.url && list(L.options.closeOnUrl).some(g => glob(g, L.url))) return L.accept(L.url), false;
            let s = L.options.closeOnFragment, hit = s && tasks.map(t => t.fragment?.querySelector?.(s)).find(Boolean);
            if (hit) {
                let v = api.attr(hit, 'ypy-layer-value');
                return L.accept(v ? json(v) : undefined), false;
            }
            // a popup inside this layer would be swapped away with the content
            for (let c of stack.slice(stack.indexOf(L) + 1)) if (L.element.contains(c.element)) finish(c, false, 'navigate', true);
        },

        ypy_after_swap(elt, {ctx}) {
            let L = ctx.layer || layerOf(elt);
            if (L && !L.closed) ready(L, ctx.layer && ctx.target == L.element && !/^none\b/.test(ctx.swap));
        },

        // Back closes the layer that pushed an entry, and does not reload the page behind it
        ypy_before_history_restore() {
            if (ownBack) return ownBack = false;
            let h = stack.findLast(l => l.pushed);
            if (!h) return;
            h.popped = true;
            finish(h, false, 'history', true);
            return false;
        }
    };

    if (ypy.registerExtension('ypy-layers', hooks) !== false) {
        // a popup is not modal: Esc and a pointer outside close it (a modal has the dialog's own)
        document.addEventListener('keydown', e => {
            let t = stack.at(-1);
            if (e.key == 'Escape' && t?.mode == 'popup' && !e.defaultPrevented) {
                e.preventDefault();
                if (t.escape) t.dismiss('escape');
            }
        });
        document.addEventListener('pointerdown', e => {
            let t = stack.at(-1);
            if (t?.mode == 'popup' && t.outside && !t.element.contains(e.target) && !t.source?.contains?.(e.target)) t.dismiss('outside');
        }, true);

        document.addEventListener('ypy:request:dropped', e => {
            let L = e.detail.ctx?.layer;
            if (L && !L.shown) finish(L, false, 'dropped', true);
        });

        ypy.layers = {
            /** Opens a layer. A string starting with "<" is HTML, any other string is a URL. */
            open,
            /** The open layers, bottom first. */
            get stack() { return [...stack] },
            /** The top layer, or undefined. */
            top: () => stack.at(-1),
            /** Accepts the top layer with a value. */
            accept: v => stack.at(-1)?.accept(v),
            /** Dismisses the top layer. */
            dismiss: r => stack.at(-1)?.dismiss(r),
            /** Dismisses every layer, the top one first; false when one refused. */
            closeAll: r => [...stack].reverse().every(l => l.dismiss(r))
        };

        if (document.readyState != 'loading' && document.body) queueMicrotask(() => hooks.ypy_after_process(document.body));
    }
})();
