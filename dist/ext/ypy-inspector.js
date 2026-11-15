// SPDX-License-Identifier: MIT
//==========================================================
// ypy-inspector.js
//
// A floating panel that shows what ypy does, as it happens. Free, for development.
//
// It records, and shows in tabs:
//   Requests  method, URL, status, time, size and the YPY-* headers of the request and the response
//   Swaps     the target, the style and the size of every swap, per request
//   Events    every ypy:* event with its origin (where it fired) and its destination (the target
//             it acts on); a row opens to show the detail and the elements that listen for it
//   Signals   the signals of the page now (when ypy-signals is loaded) and every patch and error
//   Stream    the events of the stream extensions (ypy-stream, ypy-sse, ypy-ws), once they appear
// The filter keeps the rows that contain every word you type. Pause stops the recording, Clear
// empties the lists, Export saves them as a JSON file.
//
// The panel is a Shadow DOM with an adopted style sheet and no inline style or markup from the
// page, so a strict CSP and Trusted Types are fine. It lives on <html>, outside <body>, so a swap
// never removes it. Recording starts when the script loads, with the panel closed.
//
// Keys: Alt+Shift+Y opens and closes the panel (config key), Escape closes it.
//
// Options (ypy.config.inspector, for example <meta name="ypy-config" content='inspector.open:true'>):
//   open  show the panel at start       key  the shortcut, "Alt+Shift+Y"
//   max   rows kept per list (500)      false turns the inspector off
// API: ypy.inspector.open() close() toggle() pause(on) clear() export() data() watch(...events)
//      filter(text) enable() disable()
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <script src="ypy.min.js"></script>
//   <script src="ypy-inspector.js"></script>
//==========================================================
(() => {

    let api, host, shadow, list, search, tabs, pauseBtn, running, shown, paused, tab = 'requests', query = [], timer, poll, orig;
    const D = {requests: [], swaps: [], events: [], signals: [], streams: []};
    const NAMES = {requests: 'Requests', swaps: 'Swaps', events: 'Events', signals: 'Signals', streams: 'Stream'};
    const opts = () => ({key: 'Alt+Shift+Y', max: 500, ...(typeof ypy.config.inspector == 'object' ? ypy.config.inspector : null)});
    const NATIVE = 'request:queued request:dropped request:aborted target:missing target:fallback swap:error security:blocked history:restore:fragment offline online announce'.split(' ');
    const watched = new Set();
    const rows = new WeakMap();   // request context -> its row
    const swaps = new WeakMap();  // request context -> [{task, row}]
    const open = new Set();       // ids of the rows that show their detail
    const t0 = performance.now();
    let seq = 0;

    const CSS = ':host{all:initial}.fab,.panel{position:fixed;right:12px;bottom:12px;z-index:2147483000;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#e6e6e6;background:#1b1b1f;border:1px solid #555;border-radius:8px}' +
        '.fab{padding:4px 10px;cursor:pointer}.panel{width:min(680px,calc(100vw - 24px));height:min(46vh,440px);display:flex;flex-direction:column;box-shadow:0 4px 24px #0008}' +
        '[hidden]{display:none!important}.bar{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:4px 6px;border-bottom:1px solid #333}.sp{flex:1}' +
        'button,input{font:inherit;color:inherit;background:#2a2a30;border:1px solid #444;border-radius:4px;padding:1px 7px}button{cursor:pointer}input{background:#111;margin:4px 6px;padding:2px 6px}' +
        '[aria-selected=true],[aria-pressed=true]{background:#3b5bdb;border-color:#3b5bdb}:focus-visible{outline:2px solid #8ab4ff}' +
        '.list{flex:1;overflow:auto;padding:0 6px 6px}.row{display:flex;gap:8px;padding:2px 0;border-bottom:1px solid #2a2a30;cursor:pointer;white-space:nowrap}.row span{overflow:hidden;text-overflow:ellipsis}.g{flex:1}' +
        '.dim{color:#888}.ok{color:#5fd38d}.bad{color:#ff6b6b}.wait{color:#e5c07b}.empty{color:#888;padding:8px 0}' +
        'pre{margin:0 0 4px;padding:6px;background:#111;border-radius:4px;white-space:pre-wrap;word-break:break-all;user-select:text}';

    //========================================================
    // Recording
    //========================================================

    const now = () => Math.round(performance.now() - t0);
    const h = (tag, cls, text, kids) => {
        let e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        if (kids) e.append(...kids);
        return e;
    };
    // div#main.card, document, window or the selector that was given
    const desc = e => e?.localName ? e.localName + (e.id ? '#' + e.id : '') + (c => c ? '.' + c : '')([...e.classList].find(c => !/^ypy-/.test(c)))
        : e === document ? 'document' : e === window ? 'window' : typeof e == 'string' ? e : e ? String(e.nodeName ?? e) : '';
    const yh = headers => {
        let o = {};
        for (let [k, v] of headers ?? []) if (/^ypy-/i.test(k)) o[k] = v;
        return o;
    };
    const size = fragment => [...fragment?.childNodes ?? []].reduce((n, c) => n + (c.outerHTML ?? c.textContent ?? '').length, 0);
    const text = v => { try { return JSON.stringify(v)?.slice(0, 300) } catch { return String(v) } };

    // The detail of an event as plain values: elements and contexts become short strings
    function brief(d) {
        let o = {};
        for (let [k, v] of Object.entries(d)) {
            o[k] = v instanceof Element ? desc(v) : v?.request ? `${v.request.method} ${v.request.action}` : v instanceof Error ? v.message
                : v?.constructor === Object ? text(v) : Array.isArray(v) ? `[${v.length}]` : typeof v == 'object' && v ? v.constructor?.name
                : typeof v == 'function' ? 'function' : typeof v == 'string' ? v.slice(0, 200) : v;
        }
        return o;
    }

    // Where the event acts: the swap target, when it names one
    function dest(d) {
        let t = d.used ?? d.selector ?? d.ctx?.target ?? d.target ?? d.task?.target ?? d.tasks?.map(x => desc(x.target)).join(' ');
        return typeof t == 'string' ? t : desc(t);
    }

    function add(kind, row) {
        let l = D[kind];
        row.id = ++seq;
        row.t = now();
        l.push(row);
        if (l.length > opts().max) l.shift();
        return row;
    }

    function reqRow(ctx, e, state) {
        let r = rows.get(ctx);
        if (!r) rows.set(ctx, r = add('requests', {method: ctx.request.method, url: ctx.request.action, state, source: desc(e.target), target: desc(ctx.target), swap: ctx.swap}));
        return r;
    }

    // What each event adds to the lists
    const HANDLERS = {
        'ypy:request:queued': (d, e) => Object.assign(reqRow(d.ctx, e, 'queued'), {reason: d.reason}),
        'ypy:request:dropped': (d, e) => Object.assign(reqRow(d.ctx, e, 'dropped'), {reason: d.reason}),
        'ypy:before:request': (d, e) => Object.assign(reqRow(d.ctx, e, 'sent'), {state: 'sent', requestHeaders: yh(Object.entries(d.ctx.request.headers)), target: desc(d.ctx.target), swap: d.ctx.swap}),
        'ypy:after:request': d => {
            let r = rows.get(d.ctx), s = d.ctx.response;
            if (r) Object.assign(r, {status: s.status, state: 'received', ms: now() - r.t, size: d.ctx.text?.length, responseHeaders: yh(s.headers)});
        },
        'ypy:finally:request': d => {
            let r = rows.get(d.ctx);
            if (r) { r.ms ??= now() - r.t; if (r.state == 'sent' || r.state == 'received') r.state = 'done' }
        },
        'ypy:request:aborted': (d, e) => Object.assign(reqRow(d.ctx, e, 'aborted'), {state: 'aborted', reason: d.reason}),
        'ypy:error': d => {
            let r = d.ctx && rows.get(d.ctx);
            if (r) Object.assign(r, {state: 'error', kind: d.ctx.errorKind, error: String(d.error?.message ?? d.error)});
        },
        'ypy:before:swap': (d, e) => {
            let r = reqRow(d.ctx, e, 'received');
            swaps.set(d.ctx, d.tasks.map(task => ({task, row: add('swaps', {request: r.id, type: task.type, target: desc(task.target), style: task.swapSpec?.style ?? task.swapSpec, size: size(task.fragment), state: 'swapping'})})));
        },
        'ypy:after:swap': d => {
            for (let {task, row} of swaps.get(d.ctx) ?? []) Object.assign(row, {target: desc(task.target), ms: now() - row.t, state: row.state == 'error' ? 'error' : 'done'});
        },
        'ypy:swap:error': d => {
            let s = swaps.get(d.ctx)?.find(x => x.task === d.task);
            if (s) Object.assign(s.row, {state: 'error', error: String(d.error?.message ?? d.error)});
        }
    };

    function record(e) {
        if (paused) return;
        let d = e.detail ?? {}, name = e.type, row = add('events', {name, from: desc(e.target), to: dest(d), info: brief(d)});
        queueMicrotask(() => { if (e.defaultPrevented) row.cancelled = true });
        try { HANDLERS[name]?.(d, e) } catch {}
        let kind = /^ypy:signals:/.test(name) ? 'signals' : /^ypy:(stream|sse|ws|multipart)\b/.test(name) ? 'streams' : null;
        if (kind) add(kind, {name, from: row.from, to: row.to, info: row.info});
        schedule();
    }

    function watch(...names) {
        for (let n of names) if (!watched.has(n)) { watched.add(n); document.addEventListener(n, record, true) }
    }

    // The signals the page declares, with their value now
    function signalsNow() {
        let out = [];
        if (!ypy.signals) return out;
        try {
            let it = document.evaluate('//*[@*[starts-with(name(),"ypy-signals") or starts-with(name(),"data-ypy-signals")]]', document, null, 7);
            for (let i = 0; i < it.snapshotLength; i++) {
                let e = it.snapshotItem(i);
                for (let a of e.attributes) if (/^(data-)?ypy-signals(?!-send)/.test(a.name)) {
                    for (let k of Object.keys(api.HCON.parse(a.value))) out.push({scope: desc(e), name: '$' + k, value: ypy.signals.get(k, e)});
                }
            }
        } catch {}
        return out;
    }

    //========================================================
    // The panel
    //========================================================

    // The elements that handle an event: ypy-on:<event> and ypy-trigger that names it
    function handlers(name) {
        let key = s => s.replace(/^ypy:/, '').replace(/[-:]/g, '').toLowerCase(), want = key(name), out = [];
        for (let e of document.querySelectorAll('*')) for (let a of e.attributes) {
            let m = /^(?:data-)?ypy-on:(.+)$/.exec(a.name);
            if (m ? key(m[1]) == want : /^(?:data-)?ypy-trigger$/.test(a.name) && a.value.split(/[\s,]+/).some(x => key(x) == want)) out.push(`${desc(e)} (${a.name})`);
        }
        return out;
    }

    const COLS = {
        requests: r => [r.method, r.url, r.status ?? r.state, r.ms != null ? r.ms + ' ms' : '', r.size != null ? r.size + ' B' : ''],
        swaps: r => [r.target, r.style, r.size + ' B', r.state],
        events: r => [r.name, r.from + ' → ' + (r.to || '-')],
        signals: r => [r.name, r.from + ' → ' + (r.to || '-'), Object.values(r.info).join(' ')],
        streams: r => [r.name, r.from + ' → ' + (r.to || '-'), Object.values(r.info).join(' ')]
    };
    const tone = r => r.state == 'error' || r.status >= 400 || r.cancelled ? 'bad' : r.status || r.state == 'done' ? 'ok' : r.state == 'dropped' || r.state == 'aborted' || r.state == 'queued' ? 'wait' : 'dim';

    function schedule() {
        if (shown && !timer) timer = setTimeout(render, 30);
    }

    function render() {
        timer = 0;
        if (!shown) return;
        // the signals of the page change without any event: read them again while their tab is on
        clearTimeout(poll);
        if (tab == 'signals') poll = setTimeout(render, 500);
        for (let [name, b] of Object.entries(tabs)) {
            b.hidden = (name == 'signals' && !ypy.signals && !D.signals.length) || (name == 'streams' && !D.streams.length);
            if (b.hidden && name == tab) tab = 'requests';
            b.textContent = NAMES[name] + ' ' + D[name].length;
        }
        for (let [name, b] of Object.entries(tabs)) b.setAttribute('aria-selected', name == tab);
        let all = D[tab].map(r => [r, COLS[tab](r).join(' ')]);
        let live = tab == 'signals' ? signalsNow().map(s => [{id: 's' + s.name + s.scope, live: 1, name: s.name, scope: s.scope, value: s.value}, `${s.scope} ${s.name} ${text(s.value)}`]) : [];
        let rowsOut = [...live, ...all.slice().reverse()].filter(([, s]) => query.every(w => s.toLowerCase().includes(w))).slice(0, 300);
        pauseBtn.setAttribute('aria-pressed', !!paused);
        list.replaceChildren(...(rowsOut.length ? rowsOut.flatMap(([r]) => {
            let cells = r.live ? [r.scope, r.name, text(r.value)] : [`#${r.id}`, `+${r.t}ms`, ...COLS[tab](r)];
            let row = h('div', 'row ' + (r.live ? 'ok' : tone(r)), null, cells.map((c, i) => h('span', i == cells.length - (tab == 'requests' ? 4 : 1) ? 'g' : i < 2 && !r.live ? 'dim' : '', c)));
            row.dataset.ypyId = r.id;
            row.tabIndex = 0;
            row.setAttribute('role', 'button');
            row.setAttribute('aria-expanded', open.has(r.id));
            return open.has(r.id) ? [row, h('pre', null, JSON.stringify(r.live ? r : {...r, listeners: tab == 'events' ? handlers(r.name) : undefined}, null, 1))] : [row];
        }) : [h('div', 'empty', D[tab].length ? 'No row matches the filter.' : 'Nothing recorded yet.')]));
    }

    function build() {
        host = h('div');
        host.id = 'ypy-inspector';
        host.setAttribute('ypy-ignore', '');
        shadow = host.attachShadow({mode: 'open'});
        try {
            let sheet = new CSSStyleSheet();
            sheet.replaceSync(CSS);
            shadow.adoptedStyleSheets = [sheet];
        } catch {}
        let btn = (label, title, fn) => Object.assign(h('button', null, label), {title, onclick: fn, type: 'button'});
        tabs = Object.fromEntries(Object.keys(NAMES).map(k => [k, btn(NAMES[k], NAMES[k], () => { tab = k; render() })]));
        for (let b of Object.values(tabs)) b.setAttribute('role', 'tab');
        pauseBtn = btn('Pause', 'Stop recording', () => api2.pause(!paused));
        search = Object.assign(h('input'), {type: 'search', placeholder: 'Filter: words that every row must contain', oninput: () => api2.filter(search.value)});
        search.setAttribute('aria-label', 'Filter');
        list = h('div', 'list');
        list.onclick = e => {
            let id = +e.target.closest?.('.row')?.dataset.ypyId;
            if (id) { open.has(id) ? open.delete(id) : open.add(id); render() }
        };
        list.onkeydown = e => { if (e.key == 'Enter') e.target.click() };
        let panel = h('section', 'panel', null, [
            h('div', 'bar', null, [h('b', null, 'YPY inspector'), ...Object.values(tabs), h('span', 'sp'), pauseBtn, btn('Clear', 'Empty the lists', () => api2.clear()),
                btn('Export', 'Save the lists as JSON', save), btn('Close', 'Close the panel', () => api2.close())]),
            search, list]);
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'YPY inspector');
        panel.hidden = true;
        let fab = btn('YPY', 'Open the YPY inspector', () => api2.open());
        fab.className = 'fab';
        shadow.append(fab, panel);
        host.panel = panel;
        host.fab = fab;
        document.documentElement.append(host);
    }

    const dataOut = () => ({version: 1, url: location.href, at: new Date().toISOString(), requests: D.requests, swaps: D.swaps, events: D.events, signals: D.signals, streams: D.streams, signalsNow: signalsNow()});

    function save() {
        let a = h('a');
        a.href = URL.createObjectURL(new Blob([api2.export()], {type: 'application/json'}));
        a.download = `ypy-inspector-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    function hotkey(e) {
        let parts = opts().key.split('+'), k = parts.pop().toLowerCase(), has = m => parts.some(p => p.toLowerCase() == m);
        if (e.key == 'Escape' && shown && e.composedPath().includes(host)) return api2.close();
        if (e.altKey == has('alt') && e.shiftKey == has('shift') && e.ctrlKey == has('ctrl') && e.metaKey == has('meta') && (e.key.toLowerCase() == k || e.code.toLowerCase() == 'key' + k)) {
            e.preventDefault();
            api2.toggle();
        }
    }

    const api2 = {
        open(name) { if (!running) return; if (name in D) tab = name; shown = true; host.panel.hidden = false; host.fab.hidden = true; render(); search.focus() },
        close() { shown = false; if (host) { host.panel.hidden = true; host.fab.hidden = false } },
        toggle() { shown ? api2.close() : api2.open() },
        pause(on = true) { paused = on; if (shown) render() },
        clear() { for (let k in D) D[k].length = 0; open.clear(); if (shown) render() },
        filter(s) { query = String(s).toLowerCase().split(/\s+/).filter(Boolean); if (search) search.value = s; if (shown) render() },
        watch,
        data: dataOut,
        export: () => JSON.stringify(dataOut(), null, 2),
        enable() {
            if (running) return;
            running = true;
            build();
            watch(...NATIVE.map(n => 'ypy:' + n));
            // Every event that goes through ypy.trigger (the core's and the extensions') is picked up by name, on first use
            orig = ypy.trigger;
            ypy.trigger = Object.assign(function (on, name, ...rest) { if (/^ypy:/.test(name)) watch(name); return orig.call(this, on, name, ...rest) }, {inspector: orig});
            document.addEventListener('keydown', hotkey);
            if (opts().open) api2.open();
        },
        disable() {
            if (!running) return;
            running = false;
            api2.close();
            for (let n of watched) document.removeEventListener(n, record, true);
            watched.clear();
            document.removeEventListener('keydown', hotkey);
            if (ypy.trigger.inspector === orig) ypy.trigger = orig;
            host.remove();
            host = null;
        }
    };

    ypy.registerExtension('ypy-inspector', {
        init: internalApi => {
            api = internalApi;
            ypy.inspector = api2;
            if (ypy.config.inspector !== false) api2.enable();
        }
    });

})();
