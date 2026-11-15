// SPDX-License-Identifier: MIT
//==========================================================
// ypy-dev.js
//
// Development mode for ypy. For development only: do not ship this file to production.
//
// What it adds:
//   - error messages with context (the element, the selector, the status, the start of the
//     response) for a missing target, an unknown swap style, an empty response, a 4xx or 5xx
//     response and a timeout;
//   - a warning when a POST, PUT, PATCH or DELETE is aborted or dropped by ypy-sync, which can lose
//     the user's action;
//   - for 401, 403 and 419, a message that points at an expired session or a CSRF token;
//   - an error overlay: a panel with the status, the URL, the start of the response and the element
//     of a failed request, closed with Esc (on by default only on a development host);
//   - a latency and an offline simulator: ypy.dev.latency(ms), ypy.dev.offline(true);
//   - warnings for incorrect use: an unknown attribute ("did you mean ..."), an attribute that
//     does not inherit, a ypy-target that matches nothing, ypy-on while
//     config.callbacks is "none", a ypy- and a data-ypy- spelling of one attribute that disagree;
//   - warnings for attributes and event names of the earlier lines, which are no longer read, with a
//     link to the page of the guide that explains the change;
//   - automatic reload of templates: the page listens to a Server-Sent Events endpoint of the
//     development server and refreshes itself when a template changes.
//
// Every message is logged to the console as "ypy-dev: ...", kept in ypy.dev.messages and fired
// as the ypy:dev:message event ({level, code, text, elt, ...}).
//
// Options (ypy.config.dev, for example <meta name="ypy-config" content='dev.latency:300'>):
//   latency  milliseconds, or [min, max]       reload  true (the default path) or a URL
//   offline  true                              lint    false turns the markup warnings off
//   log      false keeps the console quiet     docs    base URL of the guide pages
//   overlay  true or false: the error overlay (default: on for a development host only)
//   dev:false turns the whole extension off
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <script src="ypy.min.js"></script>
//   <script src="ypy-dev.js"></script>
//==========================================================
(() => {

    let api;
    const conf = () => ypy.config.dev || {};
    const on = () => ypy.config.dev !== false;
    const messages = [];
    const sim = {min: 0, max: 0, offline: false};
    const GUIDE = 'https://ypy.dev/docs/guides/upgrade-check';

    // Attribute names (without the prefix and the :modifier) that YPY or an official extension reads
    const KNOWN = new Set(('action get post put patch delete query trigger target swap swap-oob select select-oob push-url ' +
        'replace-url confirm config encoding sync method include vals headers indicator disable boost status validate ' +
        'error-target error-swap error-focus focus scroll announce retry busy fallback main preserve preserve-attrs ' +
        'morph-skip morph-skip-children morph-force ignore on history-elt history history-index sse ws sse-connect ' +
        'sse-close sse-swap ws-connect ws-send preload browser-indicator pending targets live ptag prompt head multipart ' +
        'csp nonce lock signals signals-send bind computed text show class attr powered state stream lazy optimistic ' +
        'layer layers revalidate cache open').split(' '));
    const SWAPS = 'innerHTML outerHTML outerSync innerMorph outerMorph textContent beforebegin afterbegin beforeend afterend delete none upsert download'.split(' ');
    // Attributes an ancestor passes down only with :inherited; the rest start requests
    const INHERITED = new Set('target swap select select-oob push-url replace-url confirm config encoding sync method include vals headers indicator disable boost status error-target error-swap error-focus focus scroll announce retry busy'.split(' '));
    const VERBS = '[ypy-get],[ypy-post],[ypy-put],[ypy-patch],[ypy-delete],[ypy-query],[ypy-action]';

    // Attributes of the earlier lines that are no longer read: name, what to do, guide anchor
    const LEGACY = {
        vars: ['use ypy-vals with the js: prefix, for example ypy-vals="js:{a: 1}"', 'attributes'],
        params: ['filter the parameters in a ypy:config:request listener (detail.ctx.request.body)', 'attributes'],
        ext: ['delete it: an extension is active when its script is loaded (limit them with config.extensions)', 'attributes'],
        disinherit: ['delete it and write :inherited on the attributes that must reach descendants', 'behavior-changes'],
        inherit: ['delete it and write :inherited on the attributes that must reach descendants', 'behavior-changes'],
        request: ['rename it to ypy-config (same JSON)', 'attributes'],
        'disabled-elt': ['rename it to ypy-disable', 'attributes'],
        sse: ['use ypy-sse:connect="/url"', 'attributes'],
        ws: ['use ypy-ws:connect="/url" and ypy-ws:send', 'attributes'],
        'sse-connect': ['rename it to ypy-sse:connect', 'extension-attributes-swap-styles-and-event-sources'],
        'sse-close': ['rename it to ypy-sse:close', 'extension-attributes-swap-styles-and-event-sources'],
        'sse-swap': ['drop it: unnamed messages are swapped, named ones become DOM events', 'extension-attributes-swap-styles-and-event-sources'],
        'ws-connect': ['rename it to ypy-ws:connect', 'extension-attributes-swap-styles-and-event-sources'],
        'ws-send': ['rename it to ypy-ws:send', 'extension-attributes-swap-styles-and-event-sources']
    };

    //========================================================
    // Messages
    //========================================================

    const devHost = () => !location.hostname || /^(localhost|127\.|\[::1\]|.*\.(local|test|localhost)$)/.test(location.hostname);

    function say(level, code, elt, text, more) {
        let m = {level, code, text, ...more, elt};
        messages.push(m);
        if (messages.length > 200) messages.shift();
        if (conf().log !== false) console[level]('ypy-dev: ' + text, m);
        overlay(m);
        ypy.trigger(elt?.isConnected ? elt : document, 'ypy:dev:message', m);
    }

    // <button#save ypy-post="/save" ypy-target="#out">
    const desc = e => !e?.localName ? String(e?.nodeName ?? e ?? 'none') : '<' + e.localName + (e.id ? '#' + e.id : '') +
        [...e.attributes].filter(a => /^(data-)?ypy-(get|post|put|patch|delete|query|action|target|on)\b/.test(a.name))
            .slice(0, 2).map(a => ` ${a.name}="${a.value.slice(0, 40)}"`).join('') + '>';
    const req = ctx => `${ctx.request.method} ${ctx.request.action}`;
    const start = t => typeof t == 'string' && t ? ` Response starts: ${JSON.stringify(t.replace(/\s+/g, ' ').trim().slice(0, 120))}` : '';

    // The closest known name to a typo, or undefined (one edit for a short name, two for a longer one)
    function nearest(name, list) {
        let best, limit = name.length < 5 ? 2 : 3, a = name.toLowerCase();
        for (let k of list) {
            let b = k.toLowerCase(), d = Array.from({length: a.length + 1}, (_, i) => [i]);
            for (let j = 1; j <= b.length; j++) d[0][j] = j;
            for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1]),
                    a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] ? d[i - 2][j - 2] + 1 : 9);
            }
            if (d[a.length][b.length] < limit) { limit = d[a.length][b.length]; best = k }
        }
        return best;
    }

    //========================================================
    // Errors with context
    //========================================================

    const reported = new WeakSet();
    const AUTH = {
        401: 'the session probably expired, or the user is not signed in',
        403: 'not allowed, or a CSRF check failed: check the permission and the CSRF token',
        419: 'the session expired, or the CSRF token is missing or stale: reload the page for a new one'
    };
    const HINTS = {404: 'check the URL and the route', 422: 'a rejected form: it is swapped into the closest form (ypy-error-target changes that)', 500: 'the server failed: read its log'};

    function failed(ctx, error, elt) {
        let kind = ctx?.errorKind, text = String(error?.message ?? error), m = /^Unknown swap style: (.*)/.exec(text);
        if (m) {
            let near = nearest(m[1], SWAPS);
            return say('error', 'unknown-swap', elt, `unknown swap style "${m[1]}"${near ? `; did you mean "${near}"?` : ''} Styles: ${SWAPS.join(', ')}, or one an extension adds.`, {style: m[1], suggestion: near});
        }
        if (!ctx?.request) return say('error', 'error', elt, `${text} (on ${desc(elt)})`, {error});
        let t = ctx.request.timeout ?? ypy.config.defaultTimeout;
        say('error', kind ?? 'error', elt, kind == 'timeout' ? `${req(ctx)} timed out after ${ypy.parseInterval(t)} ms: the server did not answer in time. Raise config.defaultTimeout or ypy-config="timeout:..."`
            : kind == 'offline' ? `${req(ctx)} failed: the browser is offline${sim.offline ? ' (simulated by ypy.dev.offline)' : ''}`
            : kind == 'network' ? `${req(ctx)} could not reach the server (${text}): is it running, is the URL right, is it a cross-origin request while config.mode is "same-origin"?`
            : `${req(ctx)} failed: ${text} (source ${desc(elt)}, target ${desc(ctx.target)})`, {ctx, error});
    }

    //========================================================
    // Error overlay
    //========================================================

    const CSS = ':host{all:initial}.box{position:fixed;left:12px;right:12px;bottom:12px;max-width:640px;z-index:2147483000;font:12px/1.4 ui-monospace,monospace;color:#f4f4f5;background:#2a1215;border:1px solid #ff6b6b;border-radius:8px;padding:8px 10px}' +
        '[hidden]{display:none!important}.top{display:flex;gap:8px}b{flex:1;color:#ff8f8f}button{font:inherit}:focus-visible{outline:2px solid #8ab4ff}' +
        'p,pre{margin:4px 0;overflow-wrap:anywhere}pre{max-height:30vh;overflow:auto;white-space:pre-wrap}';
    let box, parts;

    const hideOverlay = () => { if (box) box.panel.hidden = true };

    // Shows the request that failed: the status, the URL, the element and the start of the response.
    // Built on first use as a Shadow DOM with an adopted style sheet and text nodes only (strict CSP and
    // Trusted Types are fine), on <html> so that a swap never removes it. Esc closes it.
    function overlay(m) {
        let ctx = m.ctx;
        if (!ctx?.request || !(m.status >= 400 || /^(network|offline|timeout)$/.test(m.code)) || !(conf().overlay ?? devHost())) return;
        if (!box) {
            let h = (tag, cls = '', kids = []) => { let e = document.createElement(tag); e.className = cls; e.append(...kids); return e };
            parts = {title: h('b'), url: h('p'), elt: h('p'), hint: h('p'), body: h('pre')};
            let close = Object.assign(h('button'), {type: 'button', textContent: 'Close (Esc)', onclick: hideOverlay});
            let panel = h('section', 'box', [h('div', 'top', [parts.title, close]), parts.url, parts.elt, parts.hint, parts.body]);
            panel.setAttribute('role', 'alert');
            box = h('div');
            box.id = 'ypy-dev-overlay';
            box.setAttribute('ypy-ignore', '');
            let shadow = box.attachShadow({mode: 'open'});
            try {
                let sheet = new CSSStyleSheet();
                sheet.replaceSync(CSS);
                shadow.adoptedStyleSheets = [sheet];
            } catch {}
            shadow.append(panel);
            box.panel = panel;
            document.addEventListener('keydown', e => { if (e.key == 'Escape' && !panel.hidden) hideOverlay() });
        }
        if (!box.isConnected) document.documentElement.append(box);
        let status = m.status >= 400, text = ctx.text;
        parts.title.textContent = status ? `${m.status} ${ctx.response.raw?.statusText ?? ''}`.trim() : `Request failed (${m.code})`;
        parts.url.textContent = req(ctx);
        parts.elt.textContent = 'from ' + desc(m.elt);
        parts.hint.textContent = m.hint ?? m.text;
        parts.body.textContent = typeof text == 'string' && text.length > 600 ? text.slice(0, 600) + '...' : text ?? '';
        parts.body.hidden = !parts.body.textContent;
        box.panel.hidden = false;
    }

    //========================================================
    // ypy-sync
    //========================================================

    // A request that changes data and is cut by ypy-sync may have run on the server, or never be sent
    function synced(e) {
        let {ctx, reason} = e.detail ?? {}, method = ctx?.request?.method, sent = e.type == 'ypy:request:aborted';
        if (!on() || !/^(POST|PUT|PATCH|DELETE)$/.test(method) || !/^(replace|abort|drop|queue-overflow)$/.test(reason)) return;
        let elt = ctx.sourceElement, strategy = reason;
        say('warn', sent ? 'sync-aborted' : 'sync-dropped', elt, `${req(ctx)} (from ${desc(elt)}) was ${sent ? 'aborted in flight' : 'dropped, never sent'} by ypy-sync ${strategy}: ` +
            `${sent ? 'the server may have run it' : 'the action is lost'}. Use "queue all" for a request that must complete`, {ctx, strategy, reason, method});
    }

    //========================================================
    // Markup warnings
    //========================================================

    const seen = new WeakMap();
    function once(elt, key) {
        let keys = seen.get(elt) ?? seen.set(elt, new Set()).get(elt);
        return !keys.has(key) && keys.add(key);
    }

    function lint(root) {
        let ignore = api.prefixSelector('[ypy-ignore]'), docs = conf().docs ?? GUIDE;
        let policy = ypy.config.callbacks ?? 'none', none = policy != 'all' && policy != 'nonce';
        for (let e of [root, ...root.querySelectorAll('*')]) {
            if (!e.attributes?.length || e.closest(ignore)) continue;
            for (let {name, value} of [...e.attributes]) {
                let [, data, bare] = /^(data-)?ypy-([a-z0-9:._-]+)/.exec(name) ?? [];
                if (!bare) continue;
                let own = (data ?? '') + 'ypy-', base = bare.split(/[:.]/)[0], at = {attribute: name};
                if (LEGACY[bare]) {
                    let [fix, anchor] = LEGACY[bare], guide = `${docs}#${anchor}`;
                    if (once(e, 'l:' + name)) say('warn', 'removed-attribute', e, `ypy does not read "${name}" on ${desc(e)}: ${fix}. Guide: ${guide}`, {...at, guide});
                    continue;
                }
                let kebab = base == 'on' && /^on(?:::|:ypy:)([a-z]+-[a-z-]+)$/.exec(bare);
                if (kebab) {
                    let ev = kebab[1], now = ev.replace(/-/g, ':');
                    if (once(e, 'e:' + name)) say('warn', 'legacy-event', e, `"${name}" waits for "${ev}", which never fires: write "${now}" (${own}on::${now}). Guide: ${docs}#events`, {...at, guide: `${docs}#events`});
                } else if (!KNOWN.has(base)) {
                    let near = nearest(base, KNOWN);
                    if (near && once(e, 'u:' + name)) say('warn', 'unknown-attribute', e, `unknown attribute "${name}" on ${desc(e)}; did you mean "${own}${near}"?`, {...at, suggestion: own + near});
                    continue;
                }
                if (!data && e.hasAttribute('data-' + name) && e.getAttribute('data-' + name) != value && once(e, 'p:' + name)) {
                    say('warn', 'prefix-conflict', e, `${desc(e)} has "${name}" and "data-${name}" with different values; "${name}" wins`, at);
                }
                if (base == 'on' && none && !ypy.signals && once(e, 'c:' + name)) {
                    say('warn', 'callbacks-none', e, `"${name}" on ${desc(e)} will not run: config.callbacks is "${policy}" and the page has no ypy-signals. Use ypy-signals, or set callbacks:"all" while developing`, at);
                }
                if (bare == 'target' && value && !/^(?:js|javascript):/.test(value) && once(e, 't:' + name)) {
                    try {
                        if (!ypy.find(e, value)) say('warn', 'target-no-match', e, `ypy-target "${value}" on ${desc(e)} matches nothing right now (fine if the element exists before the request is sent)`, {selector: value});
                    } catch {
                        say('warn', 'target-invalid', e, `ypy-target "${value}" on ${desc(e)} is not a valid selector`, {selector: value});
                    }
                }
                if (INHERITED.has(bare) && once(e, 'i:' + name) && !e.matches(api.prefixSelector(VERBS))) {
                    let users = [...e.querySelectorAll(api.prefixSelector(bare == 'boost' ? 'a,form' : VERBS))].filter(x => api.attr(x, 'ypy-' + bare) == null);
                    if (users[0]) say('warn', 'implicit-inheritance', e, `"${name}" on ${desc(e)} does not reach ${desc(users[0])} (${users.length} element(s) below): an attribute is inherited only with "${name}:inherited"`, {...at, descendants: users.length});
                }
            }
        }
    }

    //========================================================
    // Simulator
    //========================================================

    const sleep = (ms, signal) => new Promise((ok, no) => {
        if (signal?.aborted) return no(signal.reason);
        let t = setTimeout(ok, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason) }, {once: true});
    });

    function offline(flag = true) {
        if (flag === sim.offline) return;
        sim.offline = flag;
        try { flag ? Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => false}) : delete navigator.onLine } catch {}
        window.dispatchEvent(new Event(flag ? 'offline' : 'online'));
    }

    function latency(min, max = min) {
        sim.min = Math.max(0, +min || 0);
        sim.max = Math.max(sim.min, +max || 0);
    }

    //========================================================
    // Reload of templates
    //========================================================

    let source, down, timer;

    // Fetches the current page again and morphs it into the body: the state of the page stays
    async function refresh(attempt = 0) {
        let ok, swapped = () => { ok = true };
        document.addEventListener('ypy:after:swap', swapped, {once: true});
        say('info', 'reload', null, `templates changed: refreshing ${location.pathname}`);
        try { await ypy.ajax('GET', location.pathname + location.search, {target: 'body', swap: 'innerMorph'}) } catch {}
        document.removeEventListener('ypy:after:swap', swapped);
        if (!ok) attempt < 5 ? setTimeout(refresh, 400, attempt + 1) : location.reload();
    }

    function reload(url) {
        source?.close();
        source = null;
        if (!url) return;
        source = new EventSource(url === true ? '/__ypy/reload' : url);
        source.onerror = () => { down = true };
        source.onopen = () => { if (down) { down = false; refresh() } };
        source.addEventListener('templates', () => { clearTimeout(timer); timer = setTimeout(refresh, 50) });
        source.addEventListener('reload', () => location.reload());
        say('info', 'reload-on', null, `listening for template changes on ${source.url}`);
    }

    //========================================================
    // The extension
    //========================================================

    ypy.registerExtension('ypy-dev', {

        init: internalApi => {
            api = internalApi;
            ypy.dev = {messages, latency, offline, reload, known: (...names) => names.forEach(n => KNOWN.add(n)), clear: () => { messages.length = 0 }, simulation: sim, overlay: {close: hideOverlay}};
            for (let name of ['aborted', 'dropped']) document.addEventListener('ypy:request:' + name, synced, true);
            if (!on()) return;
            let c = conf();
            if (c.latency != null) [].concat(c.latency).length > 1 ? latency(...c.latency) : latency(c.latency);
            if (c.offline) offline();
            if (c.reload) reload(c.reload);
            if (c.log !== false) {
                console.info('ypy-dev: development helpers are on. Do not ship ypy-dev to production.');
                if (!devHost()) console.warn(`ypy-dev: loaded on ${location.hostname}, which does not look like a development host`);
            }
        },

        // The latency and offline simulators wrap ctx.fetch, like ypy-retry (whose accessor takes the wrapper as its inner call)
        ypy_before_request: (elt, {ctx}) => {
            if (!on() || !(sim.offline || sim.max)) return;
            let inner = Object.getOwnPropertyDescriptor(ctx, 'fetch')?.set ? window.fetch.bind(window) : ctx.fetch;
            ctx.fetch = async (action, request) => {
                if (sim.offline) throw new TypeError('Failed to fetch (offline simulated by ypy.dev.offline)');
                await sleep(sim.min + Math.random() * (sim.max - sim.min), request.signal);
                return inner(action, request);
            };
        },

        ypy_after_request: (elt, {ctx}) => {
            let status = ctx.response.status;
            if (on() && ctx.text === '' && status < 400 && !ypy.config.noSwap?.includes(status)) {
                say('warn', 'empty-response', elt, `${req(ctx)} (from ${desc(elt)}) answered ${status} with an empty body: there is nothing to swap into ${desc(ctx.target)}. Send content, or answer 204 to skip the swap`, {ctx, status});
            }
        },

        ypy_response_error: (elt, {ctx}) => {
            if (!on()) return;
            let status = ctx.response.status, auth = AUTH[status], hint = auth ?? HINTS[status] ?? (status >= 500 ? HINTS[500] : 'the server refused the request');
            say(status >= 500 ? 'error' : 'warn', 'status-' + status, elt, auth ? `${req(ctx)} (from ${desc(elt)}) answered ${status}: ${auth}.${start(ctx.text)}`
                : `${req(ctx)} (from ${desc(elt)}) answered ${status}${ctx.text === '' ? ' with an empty body' : ''}; target ${desc(ctx.target)}, swap ${ctx.swap}. Hint: ${hint}.${start(ctx.text)}`, {ctx, status, hint, auth: !!auth});
        },

        ypy_target_missing: (elt, {ctx, selector, type}) => {
            if (!on()) return;
            let who = type == 'oob' ? 'an out-of-band element of the response' : type == 'partial' ? 'a <ypy-partial> of the response' : `ypy-target of ${desc(elt)}`;
            say('warn', 'target-missing', elt, `no element matches "${selector}", asked by ${who}${ctx ? ` (${req(ctx)} answered ${ctx.response?.status})` : ''}. Check the selector, and that the element exists when the response arrives.${start(ctx?.text)}`, {ctx, selector, type});
        },

        ypy_swap_error: (elt, {ctx, task, error}) => {
            if (!on() || reported.has(error)) return;
            reported.add(error);
            failed(ctx, error, elt);
        },

        ypy_error: (elt, {ctx, error}) => {
            if (!on() || (error && typeof error == 'object' && reported.has(error))) return;
            if (error && typeof error == 'object') reported.add(error);
            failed(ctx, error, elt);
        },

        ypy_security_blocked: (elt, {reason, code}) => {
            if (on()) say('warn', 'blocked', elt, `author code on ${desc(elt)} did not run (${reason}): ${String(code).slice(0, 80)}`, {reason, source: code});
        },

        ypy_after_process: elt => {
            if (on() && conf().lint !== false && elt.querySelectorAll) lint(elt);
        }
    });

})();
