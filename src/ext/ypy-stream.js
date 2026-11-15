// SPDX-License-Identifier: MIT
//==========================================================
// ypy-stream.js
//
// The client of the YPY streaming protocol (spec/PROTOCOL.md): a response of type
// text/event-stream is read as it arrives, and each event changes the page.
//
//   <div id="room" ypy-stream="/room/events"></div>           open on load
//   <div ypy-stream.post="/jobs/7/run" ypy-trigger="click">   other verbs: .post .put .patch .delete
//
// Events: ypy-patch-elements, ypy-patch-signals, ypy-redirect, ypy-event.
// Reconnects with backoff and jitter; the server answers with the full state (the fat morph).
// Uses only the public API and the extension API. Load it before ypy-sse: an element with
// ypy-sse:connect stays with that extension.
//==========================================================
(() => {
    let api, sel, mo;
    const open = new Set();
    const E = m => Error('ypy: stream: ' + m);
    const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
    const STYLE = {outer: 'outerMorph', inner: 'innerMorph', replace: 'outerHTML', append: 'beforeend',
        prepend: 'afterbegin', before: 'beforebegin', after: 'afterend', remove: 'delete'};
    const TAG = {html: '', svg: 'svg', mathml: 'math'};

    const fail = (st, error) => api.triggerEvent(st.elt, 'ypy:stream:error', {error, stream: st});

    //============================================================================================
    // The SSE framing (WHATWG): lines end in LF, CRLF or CR, a field is "name: value", a blank line
    // ends a frame. feed(text) returns the frames the text completed. The BOM is dropped by
    // TextDecoder; a CR at the end of a chunk is not followed by a phantom blank line.
    //============================================================================================
    function decoder(st) {
        let buf = '', ev = '', data = [], lid = st.id, cr = false;
        return text => {
            let frames = [];
            if (cr && text[0] == '\n') text = text.slice(1);
            if (text) cr = text.endsWith('\r');
            let lines = (buf + text).split(/\r\n|\r|\n/);
            buf = lines.pop();
            for (let l of lines) {
                if (!l) {
                    st.id = lid;
                    if (data.length) frames.push({event: ev, data: data.join('\n')});
                    ev = ''; data = [];
                } else if (l[0] != ':') {
                    let i = l.indexOf(':'), f = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
                    if (f == 'data') data.push(v);
                    else if (f == 'event') ev = v;
                    else if (f == 'id') v.includes('\0') || (lid = v);
                    else if (f == 'retry' && /^\d+$/.test(v)) st.retry = +v;
                }
            }
            return frames;
        };
    }

    //============================================================================================
    // The events
    //============================================================================================
    function missing(st, selector) {
        if (api.triggerEvent(st.elt, 'ypy:target:missing', {selector, type: 'stream', stream: st}))
            console.warn(`ypy: stream: '${selector}' did not match any element`);
    }

    // The top-level elements of html, parsed into an inert template (nothing runs or loads)
    function top(html, ns) {
        let tt = api.ttPolicy(), t = document.createElement('template'), tag = TAG[ns];
        if (tag == null) throw E('unknown namespace ' + ns);
        if (!tt) throw E("Trusted Types policy 'ypy' is blocked by the CSP");
        t.innerHTML = tt.createHTML(tag ? `<${tag}>${html}</${tag}>` : html);
        return [...(tag ? t.content.firstChild : t.content).children];
    }

    async function patchElements(st, k) {
        let mode = k.mode || 'outer', ns = k.namespace || 'html', style = STYLE[mode], jobs = [], html = k.elements ?? '';
        if (!style) throw E('unknown mode ' + mode);
        if (k.selector) {
            let found = ypy.findAll(st.elt, k.selector);
            if (!found.length) return missing(st, k.selector);
            jobs = found.map(t => [t, html]);
        } else {
            // no selector: a top-level element goes to the page element with the same id. outer, replace
            // and remove take the element itself, the other modes its children
            for (let e of top(html, ns)) {
                let t = e.id && document.getElementById(e.id);
                if (t) jobs.push([t, /^(?:outer|replace|remove)$/.test(mode) ? e.outerHTML : e.innerHTML]);
                else missing(st, e.id ? '#' + CSS.escape(e.id) : '');
            }
        }
        let tag = TAG[ns];
        if (tag == null) throw E('unknown namespace ' + ns);
        for (let [target, h] of jobs) {
            // the same swap, morph, focus and security as a response; svg and math are parsed inside their
            // own element, which ctx.select then unwraps
            await ypy.swap({
                sourceElement: st.elt, target, status: 'stream', focus: 'none',
                swap: style + ' swapEmpty:true',
                text: mode == 'remove' ? '' : tag ? `<${tag} data-ypy-ns>${h}</${tag}>` : h,
                select: tag ? '[data-ypy-ns]>*' : undefined,
                transition: k.useViewTransition == 'true',
                request: {method: 'GET', action: st.url, headers: {}}, ypy: {}
            });
        }
    }

    function patchSignals(st, k) {
        let patch = JSON.parse(k.signals), missingOnly = k.onlyIfMissing == 'true';
        if (!patch || typeof patch != 'object' || Array.isArray(patch)) throw E('signals must be a JSON object');
        if (ypy.signals) ypy.signals.patch(patch, st.elt, missingOnly);
        else api.triggerEvent(st.elt, 'ypy:stream:signals', {patch, onlyIfMissing: missingOnly});
    }

    function redirect(st, k) {
        if (!k.url) throw E('ypy-redirect needs a url');
        let mode = k.mode || 'navigate', u = new URL(k.url, location.href);
        if (!/^https?:$/.test(u.protocol) || (u.origin != location.origin && ypy.config.mode == 'same-origin'))
            throw E('redirect to another origin refused: ' + k.url);
        if (!/^(?:navigate|replace|hard)$/.test(mode)) throw E('unknown redirect mode ' + mode);
        close(st, 'redirect');
        if (mode == 'hard') (ypy._loc || location).href = u.href;
        else ypy.ajax('GET', u.origin == location.origin ? u.pathname + u.search + u.hash : u.href, {push: mode == 'navigate' ? 'true' : undefined, replace: mode == 'replace' ? 'true' : undefined});
    }

    function fire(st, k) {
        if (!k.name) throw E('ypy-event needs a name');
        let target = document;
        if (k.selector && !(target = ypy.findAll(st.elt, k.selector)[0])) return missing(st, k.selector);
        ypy.trigger(target, k.name, k.detail ? JSON.parse(k.detail) : undefined);
    }

    const EVENTS = {'ypy-patch-elements': patchElements, 'ypy-patch-signals': patchSignals, 'ypy-redirect': redirect, 'ypy-event': fire};

    // data lines are "key value"; a repeated key joins its values with a line feed. An unknown event is ignored.
    async function handle(st, f) {
        let fn = EVENTS[f.event];
        if (!fn) return;
        let k = Object.create(null);
        for (let l of f.data.split('\n')) {
            let i = l.indexOf(' '), n = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1);
            k[n] = n in k ? k[n] + '\n' + v : v;
        }
        try { await fn(st, k) } catch (e) { fail(st, e) }
    }

    //============================================================================================
    // Connections
    //============================================================================================
    function make(elt, m, url) {
        let st = {elt, m, url, id: '', retry: 1000, att: 0, ac: new AbortController()};
        api.ypyProp(elt).stream = st;
        open.add(st);
        (mo ??= new MutationObserver(() => open.forEach(s => s.elt.isConnected || close(s, 'removed')))).observe(document, {childList: true, subtree: true});
        return st;
    }

    function close(st, reason) {
        if (st.stop) return;
        st.stop = true;
        open.delete(st);
        if (!open.size) mo?.disconnect();
        if (st.elt._ypy?.stream === st) delete st.elt._ypy.stream;
        st.ac.abort();
        st.rd?.cancel().catch(() => {});
        st.wake?.();
        api.triggerEvent(st.elt, 'ypy:stream:close', {stream: st, reason});
    }

    // waits ms, or without ms until the browser is online; close() ends the wait
    const sleep = (st, ms) => new Promise(resolve => {
        let t = ms == null ? 0 : setTimeout(done, ms);
        function done() { clearTimeout(t); removeEventListener('online', done); st.wake = null; resolve() }
        if (ms == null) addEventListener('online', done);
        st.wake = done;
    });

    // Reads one connection until it ends, then reconnects unless a stop condition holds
    async function run(st, res) {
        let rd = st.rd = res.body.getReader(), dec = new TextDecoder(), feed = decoder(st);
        if (st.stop) return rd.cancel();   // closed while the answer was on its way
        api.triggerEvent(st.elt, 'ypy:stream:open', {stream: st});
        try {
            for (let r; !st.stop && !(r = await rd.read()).done;) {
                for (let f of feed(dec.decode(r.value, {stream: true}))) {
                    if (st.stop) break;
                    st.att = 0;
                    await handle(st, f);
                }
            }
        } catch (e) {
            if (!st.stop && e.name != 'AbortError') fail(st, e);
        }
        st.rd = null;
        if (st.stop) return;
        if (!st.elt.isConnected) return close(st, 'removed');
        again(st);
    }

    // One attempt through the whole request pipeline (the current signals, headers and values travel).
    // true: the answer was a stream, or something else that ends the stream; false: no answer, try again
    async function connect(st) {
        st.res = null; st.claimed = false; st.att++;
        try {
            await ypy.ajax(st.m, st.url, {
                source: st.elt, stream: st, request: {signal: st.ac.signal},
                headers: {Accept: 'text/event-stream', 'Last-Event-ID': st.id || null}
            });
        } catch (e) { fail(st, e); close(st, 'error'); return true }
        if (st.claimed) return true;
        if (st.res) return close(st, 'status ' + st.res.status), true;   // 204, an error or a page: handled, not retried
        return false;
    }

    async function again(st) {
        while (!st.stop) {
            if (!st.elt.isConnected) return close(st, 'removed');
            if (navigator.onLine) {
                let delay = Math.min(30000, Math.max(10, st.retry) * 2 ** Math.max(0, st.att - 1)) * (1 - Math.random() * .25);
                api.triggerEvent(st.elt, 'ypy:stream:reconnect', {stream: st, delay});
                await sleep(st, delay);
            } else await sleep(st);
            if (st.stop || await connect(st)) return;
        }
    }

    function start(elt, m, url) {
        if (elt._ypy?.stream) return;
        let st = make(elt, m, url);
        connect(st).then(done => done || again(st));
    }

    //============================================================================================
    // Elements with ypy-stream
    //============================================================================================
    function scan(root) {
        if (!root.querySelectorAll) return;
        for (let elt of [root, ...root.querySelectorAll(sel)]) {
            if (!elt.matches(sel) || elt.closest(api.prefixSelector('[ypy-ignore]')) || api.ypyProp(elt).streamBound) continue;
            api.ypyProp(elt).streamBound = true;
            for (let m of METHODS) {
                let name = 'ypy-stream' + (m == 'get' ? '' : '.' + m);
                if (api.attr(elt, name)) {
                    // a microtask later: every extension has seen the element (the signals are wired) when the
                    // first request is built
                    api.onTrigger(elt, api.attributeValue(elt, 'ypy-trigger', undefined, undefined, false) || 'load',
                        () => queueMicrotask(() => start(elt, m.toUpperCase(), api.attr(elt, name))));
                    break;
                }
            }
        }
    }

    ypy.stream = {
        /** Closes the stream of an element; it does not reconnect. */
        close(elt) { let st = elt?._ypy?.stream; st && close(st, 'api') },
        /** {open}: the streams that are open, for leak tests and tooling. */
        stats: () => ({open: open.size})
    };

    ypy.registerExtension('ypy-stream', {
        init(internalApi) {
            api = internalApi;
            sel = api.prefixSelector(METHODS.map(m => '[ypy-stream' + (m == 'get' ? '' : '\\.' + m) + ']').join(','));
        },

        ypy_after_process(root) { scan(root) },

        // The routing by Content-Type: an event stream is read here. The request is over at once, it does
        // not hold the queue of its element. ypy-sse keeps the elements that name it.
        ypy_before_response(elt, {ctx}) {
            let res = ctx.response.raw, st = ctx.stream;
            if (st) st.res = res;
            if (res.status != 200 || !/^text\/event-stream/i.test(res.headers.get('Content-Type') ?? '')) return;
            if (!st) {
                if (api.attributeValue(elt, 'ypy-sse:connect') != null || elt.hasAttribute('ypy-sse-connect')) return;
                let prev = elt._ypy?.stream;
                prev && close(prev, 'replaced');
                st = make(elt, ctx.request.method, ctx.request.action);
            }
            st.claimed = true;
            clearTimeout(ctx.requestTimeout);
            run(st, res);
            return false;
        },

        ypy_before_cleanup(elt) {
            let st = elt._ypy?.stream;
            st && close(st, 'removed');
        }
    });
})();
