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
// Events: ypy-patch-elements (with key and limit for append and prepend lists), ypy-patch-signals,
// ypy-redirect, ypy-event, ypy-refresh (fetch the page, or the elements of a selector, again).
// Reconnects with backoff and jitter; the server answers with the full state (the fat morph).
// pauseOnBackground (ypy.config.stream, or ypy-config='{"stream":{"pauseOnBackground":true}}') closes the
// connection while the tab is hidden and opens it again, with Last-Event-ID, when it is visible.
// Uses only the public API and the extension API. Load it before ypy-sse: an element with
// ypy-sse:connect stays with that extension.
//==========================================================
(() => {
    let api, sel, mo, vl;
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

    // the same swap, morph, focus and security as a response; svg and math are parsed inside their own
    // element, which ctx.select then unwraps
    const put = (st, k, target, style, html) => {
        let tag = TAG[k.namespace || 'html'];
        if (tag == null) throw E('unknown namespace ' + k.namespace);
        return ypy.swap({
            sourceElement: st.elt, target, status: 'stream', focus: 'none',
            swap: style + ' swapEmpty:true',
            text: style == 'delete' ? '' : tag ? `<${tag} data-ypy-ns>${html}</${tag}>` : html,
            select: tag ? '[data-ypy-ns]>*' : undefined,
            transition: k.useViewTransition == 'true',
            request: {method: 'GET', action: st.url, headers: {}}, ypy: {}
        });
    };

    // An append or prepend list (key and limit, the rules of ypy-list): an item whose key attribute has
    // the value of one in the list replaces it where it stands, the same key twice in a patch keeps the
    // last, and afterwards the list keeps at most limit items, the oldest going.
    async function fillList(st, k, target, html) {
        let append = k.mode == 'append', key = k.key == null ? '' : k.key || 'id', limit = k.limit;
        let val = e => key ? e.getAttribute(key) : null, items = top(html, k.namespace || 'html'), old = new Map(), last = new Map();
        for (let e of items) val(e) != null && last.set(val(e), e);
        for (let c of key ? target.children : []) val(c) != null && !old.has(val(c)) && old.set(val(c), c);
        let rest = [];
        for (let e of items) {
            if (val(e) != null && last.get(val(e)) !== e) continue;
            let was = val(e) != null && old.get(val(e));
            was ? await put(st, k, was, 'outerHTML', e.outerHTML) : rest.push(e);
        }
        if (rest.length) await put(st, k, target, STYLE[k.mode], rest.map(e => e.outerHTML).join(''));
        let kids = [...target.children], extra = limit ? kids.length - limit : 0;
        if (extra > 0) for (let c of append ? kids.slice(0, extra) : kids.slice(-extra)) await put(st, k, c, 'delete');
    }

    async function patchElements(st, k) {
        let mode = k.mode || 'outer', ns = k.namespace || 'html', style = STYLE[mode], jobs = [], html = k.elements ?? '';
        if (!style) throw E('unknown mode ' + mode);
        if (TAG[ns] == null) throw E('unknown namespace ' + ns);
        // key and limit mean something for append and prepend only, and are ignored in the other modes
        let list = /^(?:append|prepend)$/.test(mode) && (k.key != null || k.limit != null);
        if (list) {
            if (k.key && !/^[A-Za-z_][\w.-]*$/.test(k.key)) throw E('invalid key attribute ' + k.key);
            if (k.limit != null && !/^[1-9]\d*$/.test(k.limit)) throw E('limit must be a whole number of 1 or more');
            k = {...k, mode, limit: k.limit && +k.limit};
        }
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
        for (let [target, h] of jobs) await (list ? fillList(st, k, target, h) : put(st, k, target, style, mode == 'remove' ? '' : h));
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

    // ypy-refresh: the server says "something changed", this client fetches its own copy. Events with the
    // same selector (the page is one) that come within debounce ms of the first make one request, after
    // that window and up to jitter ms more; the next event after the request starts a new window.
    const delay = (v, def) => /^\d+$/.test(v ?? '') ? Math.min(60000, +v) : def;

    function refresh(st, k) {
        let sel = k.selector || '', rf = st.rf ??= new Map();
        if (rf.has(sel)) return;
        rf.set(sel, setTimeout(() => { rf.delete(sel); fetchAgain(st, sel) }, delay(k.debounce, 250) + Math.random() * delay(k.jitter, 0)));
    }

    async function fetchAgain(st, sel) {
        if (st.stop || !api.triggerEvent(st.elt, 'ypy:stream:refresh', {stream: st, selector: sel})) return;
        try {
            if (!sel) {
                // the page: the element that holds it for the history, or the body, like a history restore
                let page = document.querySelector(api.prefixSelector('[ypy-history-elt]')) || document.body;
                await ypy.ajax('GET', location.pathname + location.search, {
                    source: st.elt, target: page, swap: 'outerMorph',
                    select: page != document.body ? api.prefixSelector('[ypy-history-elt]') : undefined
                });
                return;
            }
            let found = ypy.findAll(st.elt, sel);
            if (!found.length) return missing(st, sel);
            for (let elt of found) {
                let url = api.attr(elt, 'ypy-get');
                if (url) await ypy.ajax('GET', url, {source: elt, target: elt, swap: 'innerMorph'});
                else fail(st, E(`refresh: '${sel}' has no ypy-get`));
            }
        } catch (e) { fail(st, e) }
    }

    const EVENTS = {'ypy-patch-elements': patchElements, 'ypy-patch-signals': patchSignals, 'ypy-redirect': redirect, 'ypy-event': fire, 'ypy-refresh': refresh};

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
        let cfg = {...ypy.config.stream, ...api.HCON.parse(api.attributeValue(elt, 'ypy-config')).stream};
        let st = {elt, m, url, id: '', retry: 1000, att: 0, ac: new AbortController(), pause: !!cfg.pauseOnBackground};
        api.ypyProp(elt).stream = st;
        open.add(st);
        (mo ??= new MutationObserver(() => open.forEach(s => s.elt.isConnected || close(s, 'removed')))).observe(document, {childList: true, subtree: true});
        if (st.pause && !vl) document.addEventListener('visibilitychange', vl = () => open.forEach(s => s.pause && (document.hidden ? hide(s) : s.paused && s.wake?.())));
        return st;
    }

    // The tab went to the background: close the connection, without counting it as a failure. again() waits
    // for the tab, and opens the next one at once
    function hide(st) {
        if (!st.rd || st.paused) return;
        st.paused = true;
        api.triggerEvent(st.elt, 'ypy:stream:pause', {stream: st});
        st.ac.abort();
        st.rd.cancel().catch(() => {});
    }

    function close(st, reason) {
        if (st.stop) return;
        st.stop = true;
        open.delete(st);
        if (!open.size) mo?.disconnect();
        if (vl && ![...open].some(s => s.pause)) document.removeEventListener('visibilitychange', vl), vl = null;
        st.rf?.forEach(clearTimeout);
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
        if (st.pause && document.hidden) { st.rd = null; rd.cancel().catch(() => {}); return again(st) }   // hidden while it was on its way
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
        if (st.ac.signal.aborted && !st.stop) st.ac = new AbortController();   // the last one ended with a pause
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
            if (st.pause && document.hidden) {
                // wait for the tab; hide() has already said so when it closed a connection
                if (!st.paused) { st.paused = true; api.triggerEvent(st.elt, 'ypy:stream:pause', {stream: st}) }
                await new Promise(resolve => st.wake = () => { st.wake = null; resolve() });
                continue;
            }
            if (st.paused) {   // the tab is back: no wait, no backoff
                st.paused = false; st.att = 0;
                api.triggerEvent(st.elt, 'ypy:stream:resume', {stream: st});
            } else if (navigator.onLine) {
                let delay = Math.min(30000, Math.max(10, st.retry) * 2 ** Math.max(0, st.att - 1)) * (1 - Math.random() * .25);
                api.triggerEvent(st.elt, 'ypy:stream:reconnect', {stream: st, delay});
                await sleep(st, delay);
            } else await sleep(st);
            if (st.pause && document.hidden) continue;
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
