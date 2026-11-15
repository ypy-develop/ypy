// SPDX-License-Identifier: MIT
//==========================================================
// ypy-native.js
//
// The web side of the native app bridge (ADR-0017). A native shell (iOS, Android, a desktop web
// view) owns the navigation chrome and shows each screen in a web view that loads the page this
// server renders. This extension tells the server it is in an app, hands navigation and a few
// elements to the shell, and does nothing at all in a plain browser, where the same markup is
// still valid HTML. Full reference: https://ypy.dev/docs/reference/native.
//
// The channel
//   The shell gives the page window.ypyNative: postMessage(string) to talk to the shell, and
//   'message' events (event.data is a string) to hear it. Every message is JSON text with a
//   string "type". Nothing in a message is evaluated. The extension speaks only after a handshake:
//   it posts {type:'load'}, the shell answers {type:'hello', v, platform, caps, nonce}, the
//   extension answers {type:'ready', v, nonce}.
//
// The server learns it is an app from
//   the user agent suffix  YpyNative/<n> (<platform>)  (added by the shell, always there)
//   the request header     YPY-Native: <platform>; v=<n>; caps=<a,b>  (added here, same origin only)
//   the root attribute     data-ypy-native="<platform>"
//
// Visits (page -> shell)
//   visit {url, action: advance|replace|restore, source: boost|form|location|redirect|event|api}
//   A boosted link or form, a YPY-Location and a redirect after a post to the main target are
//   visits. The request is not made; the shell applies the path configuration. A route whose
//   presentation is "none" is left to YPY. Cancel ypy:native:before:visit to keep one in the page.
//
// Components (markup)
//   ypy-native-component="name"   ypy-native-props='{...}' (JSON, 2 KiB)   ypy-native-hide
//   ypy-native-only               ypy-native-click
//
// Only the public API and the extension API are used.
//==========================================================
(() => {
    let api, host, ready = false, announce = false, platform, version, caps = [], seq = 0, last = '', rules = [], sheet, bodyWatch, headWatch;

    const PATH = '/.well-known/ypy-native.json';
    const AGENT = /\bYpyNative\/(\d{1,4}) \(([a-z][a-z0-9_-]{0,31})\)/.exec(navigator.userAgent);
    const PLATFORM = /^[a-z][a-z0-9_-]{0,31}$/, TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
    const MAX_PROPS = 2048, MAX_MESSAGE = 65536, MAX_CAPS = 64;
    const elts = new Map(), info = new WeakMap();

    const cfg = () => ({path: PATH, web: false, ...ypy.config.native});
    const pf = n => api.prefixSelector('[ypy-native-' + n + ']');
    const all = () => api.prefixSelector(['component', 'props', 'hide', 'only', 'click'].map(n => '[ypy-native-' + n + ']').join());
    const sameOrigin = url => { try { return new URL(url, location.href).origin == location.origin } catch { return false } };

    //============================================================================================
    // The channel and the handshake
    //============================================================================================

    function post(type, fields) {
        try { host?.postMessage(JSON.stringify({type, ...fields})) } catch { /* a closing view */ }
    }

    const hear = e => receive(e.data);

    /** Attaches to the shell's channel (window.ypyNative by default) and asks for the handshake. */
    function connect(channel = window.ypyNative) {
        if (window.top !== window || typeof channel?.postMessage != 'function') return false;
        host?.removeEventListener?.('message', hear);
        host = channel;
        host.addEventListener?.('message', hear);
        post('load', {v: 1});
        return true;
    }

    /** Leaves the shell: components disconnect, the request header and the visits stop. */
    function disconnect() {
        for (let e of [...elts.values()]) drop(e);
        host?.removeEventListener?.('message', hear);
        host = undefined;
        ready = announce = false;
        caps = [];
        rules = [];
        last = '';
        bodyWatch?.disconnect();
        headWatch?.disconnect();
        platform = AGENT?.[2];
        version = +AGENT?.[1];
        stamp();
        scan(document.body);
    }

    /** One message from the shell, a string or an already parsed object. Anything else is ignored. */
    function receive(data) {
        let m;
        try { m = typeof data == 'string' ? (data.length <= MAX_MESSAGE ? JSON.parse(data) : null) : data } catch { /* not JSON */ }
        if (!m || typeof m != 'object' || typeof m.type != 'string') return;
        if (m.type == 'hello') return hello(m);
        // nothing but the handshake is heard before it is done
        if (ready && Object.hasOwn(HEARD, m.type)) HEARD[m.type](m);
    }

    function hello(m) {
        let n = m.nonce;
        if (!host || !Number.isInteger(m.v) || m.v < 1 || m.v > 9999 || !PLATFORM.test(m.platform) || typeof n != 'string' || !n || n.length > 128) return;
        for (let e of [...elts.values()]) drop(e);
        ready = true;
        platform = m.platform;
        version = m.v;
        announce = m.announce === true;
        caps = (Array.isArray(m.caps) ? m.caps : []).filter(c => typeof c == 'string' && TOKEN.test(c)).slice(0, MAX_CAPS);
        post('ready', {v: 1, nonce: n});
        stamp();
        loadRules();
        scan(document.body);
        bodyWatch ||= new MutationObserver(sweep);
        bodyWatch.observe(document.body, {subtree: true, childList: true, attributes: true,
            attributeFilter: ['ypy-native-component', 'data-ypy-native-component', 'ypy-native-props', 'data-ypy-native-props']});
        headWatch ||= new MutationObserver(page);
        headWatch.observe(document.head, {subtree: true, childList: true, characterData: true});
        page();
    }

    // what the shell may say once the handshake is done
    const HEARD = {
        'component:event'(m) {
            let e = elts.get(m.id);
            if (!e || typeof m.name != 'string') return;
            if (ypy.trigger(e, 'ypy:native:event', {id: m.id, name: m.name, detail: m.detail}) && m.name == 'action' && e.matches(pf('click'))) e.click();
        },
        // pull to refresh: the main target again, with a full response, as a boosted link would
        reload() {
            ypy.ajax('GET', location.pathname + location.search, {target: 'body', nativeReload: true, headers: {'YPY-Boosted': 'true'}});
        }
    };

    // the page tells the shell its address and title, for the native bar
    function page() {
        let key = location.href + '\n' + document.title;
        if (ready && key != last) post('page:update', {url: location.href, title: document.title}), last = key;
    }

    function stamp() {
        let root = document.documentElement;
        if (platform) root.setAttribute('data-ypy-native', platform);
        else root.removeAttribute('data-ypy-native');
    }

    //============================================================================================
    // Path configuration
    //============================================================================================

    async function loadRules() {
        let path = cfg().path;
        if (path === false) return;
        try {
            let res = await fetch(path, {method: 'GET', headers: {Accept: 'application/json'}, credentials: 'same-origin'});
            let doc = res.ok && await res.json();
            rules = (Array.isArray(doc?.rules) ? doc.rules : []).flatMap(rule => {
                try {
                    return [{res: rule.patterns.map(p => new RegExp(p)), props: rule.properties || {}}];
                } catch { return [] }
            });
        } catch { /* no document: every visit goes to the shell */ }
    }

    /** The properties the path configuration gives a URL: matching rules in order, the later one wins. */
    function properties(url) {
        let u = new URL(url, location.href), s = u.pathname + u.search;
        return Object.assign({}, ...rules.filter(r => r.res.some(re => re.test(s))).map(r => r.props));
    }

    //============================================================================================
    // Visits
    //============================================================================================

    /** Hands a visit to the shell. False when the page keeps it: no shell, or a route that is "none". */
    function route(elt, url, action, kind) {
        let p = properties(url);
        if (p.presentation == 'none') return false;
        if (!ready) {
            // outside the app a modal route becomes a layer, so one server and one document serve both
            if (!cfg().web || p.context != 'modal' || !ypy.layers) return false;
            ypy.layers.open(url, {mode: p.modal_style == 'drawer' ? 'drawer' : 'modal'});
            return true;
        }
        if (!api.triggerEvent(elt, 'ypy:native:before:visit', {url, action, source: kind})) return false;
        post('visit', {url, action, source: kind});
        return true;
    }

    /** A visit started by code or by the server: the shell takes it, and a browser swaps the page. */
    function visit(url, action = 'advance') {
        let u;
        try { u = new URL(url, location.href) } catch { return false }
        if (u.origin != location.origin) return false;
        if (action != 'replace' && action != 'restore') action = 'advance';
        if (!route(document.body, u.href, action, 'event')) {
            ypy.ajax('GET', u.pathname + u.search, {target: 'body', [action == 'advance' ? 'push' : 'replace']: 'true'});
        }
        return true;
    }

    //============================================================================================
    // Native components
    //============================================================================================

    function wire(e) {
        let name = api.attributeValue(e, 'ypy-native-component') ?? '', raw = api.attributeValue(e, 'ypy-native-props') || '{}', i = info.get(e), props;
        if (raw.length > MAX_PROPS) console.warn('ypy: native: ypy-native-props is over 2 KiB', {elt: e});
        else try { props = JSON.parse(raw) } catch { /* not JSON */ }
        if (!ready || !caps.includes(name) || !props || typeof props != 'object' || Array.isArray(props)) return drop(e);
        if (i?.name == name) {
            if (i.raw != raw) post('component:update', {id: i.id, props}), i.raw = raw;
            return;
        }
        drop(e);
        info.set(e, {id: ++seq, name, raw});
        elts.set(seq, e);
        post('component:connect', {id: seq, name, props});
    }

    function drop(e) {
        let i = info.get(e);
        if (!i) return;
        info.delete(e);
        elts.delete(i.id);
        post('component:disconnect', {id: i.id});
    }

    // an element that left the page disconnects; one whose props changed is updated
    function sweep() {
        for (let e of [...elts.values()]) e.isConnected ? wire(e) : drop(e);
    }

    // the gate the core applies before it initializes an element (the nonce extension answers it) comes
    // first, so markup the server did not stamp cannot ask the shell for anything or hide the page
    function scan(root) {
        if (!root?.querySelectorAll) return;
        let any = all();
        for (let e of [root, ...root.querySelectorAll(any)]) {
            if (!e.matches(any) || e.closest(api.prefixSelector('[ypy-ignore]')) || !api.triggerEvent(e, 'ypy:before:init', {native: true})) continue;
            let hide = e.matches(pf('hide'));
            // a hidden element also leaves the accessibility tree and the tab order
            if (hide || e.matches(pf('only'))) e.inert = hide ? !!platform : !platform;
            if (e.matches(pf('component'))) wire(e);
        }
    }

    function style() {
        if (sheet) return;
        try {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`:root[data-ypy-native] :is(${pf('hide')}){display:none!important}:root:not([data-ypy-native]) :is(${pf('only')}){display:none!important}`);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        } catch { sheet = null }
    }

    //============================================================================================
    // The extension
    //============================================================================================

    const hooks = {
        init(internalApi) { api = internalApi },

        // the server can tell an app from a browser on every request, a fetch included
        ypy_config_request(elt, {ctx}) {
            if (platform && sameOrigin(ctx.request.action)) {
                ctx.request.headers['YPY-Native'] = platform + '; v=' + version + (caps.length ? '; caps=' + caps.join(',') : '');
            }
        },

        // a navigation of the main content is the shell's: the request is not made
        ypy_before_request(elt, {ctx}) {
            let {request: r, target} = ctx;
            if ((!ready && !cfg().web) || ctx.nativeReload || r.method != 'GET' || target != document.body || !sameOrigin(r.action)) return;
            let boosted = r.headers['YPY-Boosted'];
            if (!boosted && !ctx.push && !ctx.replace) return;
            if (route(elt, new URL(r.action, location.href).href, ctx.replace ? 'replace' : 'advance', boosted ? (elt.matches?.('form') ? 'form' : 'boost') : 'location')) return false;
        },

        // a post that ended in a redirect to a page is a visit to that page
        ypy_after_request(elt, {ctx}) {
            let {response, request: r} = ctx;
            if (ready && ctx.redirected && !ctx.nativeReload && r.method != 'GET' && ctx.target == document.body && response.status < 300 && sameOrigin(response.raw.url)) {
                if (route(elt, response.raw.url, ctx.replace ? 'replace' : 'advance', 'redirect')) return false;
            }
        },

        // the shell owns the stack: the page writes no history entry and restores none
        ypy_before_history_update() { if (ready) return false },
        ypy_before_history_restore() { if (ready) return false },

        ypy_after_process(root) { scan(root) },
        ypy_before_cleanup(elt) { drop(elt) },
        ypy_after_swap() { stamp(); page() }
    };

    if (ypy.registerExtension('ypy-native', hooks) !== false) {
        // the server steers the app: YPY-Trigger {"ypy:native:navigate": {"url": "/orders", "action": "replace"}}
        document.addEventListener('ypy:native:navigate', e => {
            if (!e.defaultPrevented && typeof e.detail?.url == 'string') visit(e.detail.url, e.detail.action);
        });
        // a screen reader of the platform can say what the page announces, when the shell asks for it
        document.addEventListener('ypy:announce', e => {
            if (ready && announce && e.detail?.message) post('announce', {message: e.detail.message, politeness: e.detail.politeness});
        });

        ypy.native = {
            connect,
            disconnect,
            receive,
            /** Sends a message to the shell; false when there is no channel. */
            send: (type, fields) => !!host && (post(type, fields), true),
            visit,
            /** Loads the path configuration again (the shell does it on resume too). */
            load: loadRules,
            properties,
            get ready() { return ready },
            get platform() { return platform },
            get caps() { return [...caps] }
        };

        queueMicrotask(() => {
            platform = AGENT?.[2];
            version = +AGENT?.[1];
            if (!api) return;
            style();
            stamp();
            if (window.ypyNative) connect();
            else if (cfg().web) loadRules();
            if (document.body) scan(document.body);
        });
    }
})();
