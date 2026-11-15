// SPDX-License-Identifier: MIT
//==========================================================
// ypy-model.js
//
// The client side of a language-model answer that streams into fragments (ADR-0018, protocol 5.8). The
// words of a model are untrusted: what they could do is stopped here as a second wall behind the server's
// renderer. This extension has four jobs.
//
//   ypy-untrusted   marks a container whose content is written by a model. Everything that enters it (and
//                   every container with the attribute that arrives in a response) loses scripts, styles,
//                   forms, frames, svg, ypy-*, data-ypy-*, on* and framework attributes, javascript: and
//                   data: addresses and, unless the value is "images", media that loads from the network.
//   announce        a container with aria-busy="true" is an answer being written. The live region says one
//                   short message when it starts (ypy-announce-start, or config.announce.messages.answerStart)
//                   and one when aria-busy goes away: ypy-announce / answerReady, or ypy-announce-stop /
//                   answerStopped when data-state is "stopped", ypy-announce-error / answerFailed when it is
//                   "failed" (assertive). Nothing is said in between, unless config.announce.stream is
//                   "blocks": then the text of each closed block, shortened, at most once every 3 seconds.
//   ypy-follow      on the container: the page scrolls down with the answer, only when the reader was already
//                   at the bottom and prefers-reduced-motion is not set.
//   ypy-stop        on a button: ypy-stop="#selector" sends ypy:abort to those elements, which closes their
//                   stream. The answer that was open is closed in the page as stopped (the server records the
//                   stop with its own request, for example ypy-post on the same button).
//
// Usage:
//   <article id="a1" ypy-untrusted ypy-follow aria-busy="true"><div id="a1-done"></div><div id="a1-tail"></div></article>
//   <button ypy-post="/generations/1/stop" ypy-swap="none" ypy-stop="#gen">Stop</button>
//
// Uses only the public API and the extension API.
//==========================================================
(() => {
    let api, sel;
    // answers being written: container id -> element that holds the stream
    const open = new Map(), said = new Map();
    const BAD = 'script,style,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,link,meta,base,template,noscript,svg,math,portal';
    const MEDIA = 'img,picture,source,video,audio,track';
    const URL_ATTR = /^(?:href|src|action|formaction|poster|data|xlink:href|srcset)$/;
    const BLOCK_EVERY = 3000, BLOCK_LENGTH = 140;

    //============================================================================================
    // The wall: what is left of a model's HTML
    //============================================================================================
    function clean(root, images) {
        let pfx = ypy.config.prefix ? ypy.config.prefix.toLowerCase() : null, bad = images ? BAD : BAD + ',' + MEDIA;
        for (let e of root.querySelectorAll('*')) {
            if (e.matches(bad)) { e.remove(); continue }
            for (let a of [...e.attributes]) {
                let n = a.name.toLowerCase(), v = a.value.replace(/[\0-\x20\x7f-\x9f]/g, '').toLowerCase();
                if (/^(?:on|ypy-|data-ypy-|x-|[@:])/.test(n) || pfx && n.startsWith(pfx) || /^(?:style|srcdoc|target|form)$/.test(n)
                    || URL_ATTR.test(n) && /^(?:javascript|data|vbscript):/.test(v)) e.removeAttribute(a.name);
            }
            if (e.localName == 'a' && e.hasAttribute('href')) e.setAttribute('rel', 'noopener noreferrer nofollow');
        }
    }

    const wants = box => api.attr(box, 'ypy-untrusted') == 'images';

    // Before the swap: the content of every task that goes into an untrusted container, or that is one
    function guard(ctx, tasks) {
        let m = ctx.model = {ids: [], boxes: new Set(), text: ''};
        for (let t of tasks) {
            let f = t.fragment, tg = t.target instanceof Element ? t.target : null, box = tg?.closest(sel);
            let style = t.swapSpec?.style ?? t.swapSpec ?? '';
            if (box && !(box == tg && /^outer/.test(style))) {
                // everything of the content is the model's (an outer patch of the container itself brings the
                // container, which the server wrote)
                clean(f, wants(box));
                m.boxes.add(box);
                if (style == 'beforeend') m.text += (f.textContent || '').trim() + ' ';
            } else {
                for (let r of f.querySelectorAll(sel)) { clean(r, wants(r)); r.id && m.ids.push(r.id) }
                if (box) m.boxes.add(box);
            }
        }
    }

    //============================================================================================
    // The live region
    //============================================================================================
    function say(box, ctx, message, politeness) {
        let cfg = ypy.config.announce;
        if (!message || !(cfg ?? true)) return;
        let detail = {ctx, message, politeness};
        if (!api.triggerEvent(box, 'ypy:announce', detail) || !detail.message) return;
        let level = detail.politeness, live = document.querySelector('[data-ypy-live=' + level + ']');
        if (!live) {
            // the core makes the polite region at start-up and the other on first use; the style that hides it is the core's
            live = document.createElement('div');
            live.setAttribute('data-ypy-live', level);
            live.setAttribute('role', level == 'polite' ? 'status' : 'alert');
            live.setAttribute('aria-live', level);
            document.body.append(live);
        }
        let s = live._ypy_state ||= {};
        clearTimeout(s.t);
        live.textContent = '';
        s.t = setTimeout(() => {
            live.textContent = detail.message;
            s.t = setTimeout(() => live.textContent = '', ypy.config.announce?.clearAfter ?? 5000);
        }, 50);
    }

    const text = (box, attr, key) => api.attr(box, attr) || ypy.config.announce?.messages?.[key];

    // the end of an answer: aria-busy is gone, data-state says how it ended
    function ended(box, ctx) {
        let state = box.getAttribute('data-state');
        if (state == 'stopped') say(box, ctx, text(box, 'ypy-announce-stop', 'answerStopped'), 'assertive');
        else if (state == 'failed') say(box, ctx, text(box, 'ypy-announce-error', 'answerFailed'), 'assertive');
        else say(box, ctx, text(box, 'ypy-announce', 'answerReady'), 'polite');
    }

    function track(box, ctx, blocks) {
        let id = box.id;
        if (!id) return;
        let busy = box.getAttribute('aria-busy') == 'true';
        if (open.has(id) && !open.get(id).isConnected) open.delete(id);   // its stream went away with the page
        if (busy && !open.has(id)) {
            open.set(id, ctx.sourceElement);
            say(box, ctx, text(box, 'ypy-announce-start', 'answerStart'), 'polite');
        } else if (!busy && open.has(id)) {
            open.delete(id);
            said.delete(id);
            ended(box, ctx);
        } else if (busy && blocks && Date.now() - (said.get(id) ?? 0) >= BLOCK_EVERY) {
            let t = ctx.model.text.trim();
            if (t) {
                said.set(id, Date.now());
                say(box, ctx, t.length > BLOCK_LENGTH ? t.slice(0, BLOCK_LENGTH - 1) + '…' : t, 'polite');
            }
        }
    }

    //============================================================================================
    // Following the answer
    //============================================================================================
    const atBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 24;
    const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    ypy.registerExtension('ypy-model', {
        init(internalAPI) {
            api = internalAPI;
            sel = api.prefixSelector('[ypy-untrusted]');
        },

        ypy_before_swap(elt, {ctx, tasks}) {
            guard(ctx, tasks);
            let m = ctx.model;
            m.follow = atBottom() && !still() && [...m.boxes].some(b => api.attr(b, 'ypy-follow') != null && b.getAttribute('aria-busy') == 'true');
        },

        ypy_after_swap(elt, {ctx}) {
            let m = ctx.model;
            if (!m) return;
            let boxes = new Set(m.boxes);
            for (let id of m.ids) { let b = document.getElementById(id); b && boxes.add(b) }
            let blocks = ypy.config.announce?.stream == 'blocks';
            for (let b of boxes) {
                if (!b.isConnected) continue;
                b = b.closest(sel) || b;
                track(b, ctx, blocks);
            }
            if (m.follow) scrollTo(scrollX, document.documentElement.scrollHeight);
        },

        // A stream that ends while an answer is open (the user pressed Stop, or the request failed) leaves a
        // page that says so: stopped after an abort, failed after an error
        ypy_stream_close(elt, {reason}) {
            let how = /^(?:abort|api)$/.test(reason) ? 'stopped' : /^(?:error|status )/.test(reason) ? 'failed' : null;
            if (!how) return;
            for (let [id, from] of [...open]) {
                if (from != elt) continue;
                open.delete(id);
                said.delete(id);
                let box = document.getElementById(id);
                if (!box) continue;
                box.removeAttribute('aria-busy');
                if (!box.hasAttribute('data-state')) box.setAttribute('data-state', how);
                ended(box, {sourceElement: elt});
            }
        },

        ypy_after_process(root) {
            if (!root.querySelectorAll) return;
            let stop = api.prefixSelector('[ypy-stop]');
            for (let b of [root, ...root.querySelectorAll(stop)]) {
                if (!b.matches?.(stop) || api.ypyProp(b).stopBound) continue;
                api.ypyProp(b).stopBound = true;
                b.addEventListener('click', () => {
                    for (let t of api.findAll(b, api.attr(b, 'ypy-stop'))) api.triggerEvent(t, 'ypy:abort');
                });
            }
        }
    });
})();
