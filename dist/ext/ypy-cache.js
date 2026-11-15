// SPDX-License-Identifier: MIT
//==========================================================
// ypy-cache.js
//
// A response cache with revalidation for ypy: the page shows the copy it has at once, asks the
// server whether it is still current, and swaps again only when it is not (stale-while-revalidate).
//
// Opt in per element with ypy-cache (inherited with ypy-cache:inherited) or for every GET with
// ypy.config.cache.all. Only GET requests to the page's own origin are kept, and never a response
// whose Cache-Control says no-store, or private unless the element asks for it with `private`.
//
// Options (attribute value, as HCON, over ypy.config.cache): ttl (10m: an older copy is not shown,
// it is only revalidated), fresh (0: a copy younger than this is shown without asking, the
// server's max-age wins), offline (keep the copy in sessionStorage and show it when the network
// fails), private, size (50 entries), bytes (2 MiB of text). ypy-cache="false" turns it off.
//
// Expiring is not removing. The server marks copies with two response headers, each a comma
// separated list of patterns (`/items*`, `/cart`, `*`, `tag:products`) or `false`:
//   YPY-Cache-Expire  the copy is marked old: it is still shown at once, and always revalidated
//                     (stale-while-revalidate), whatever its age or max-age;
//   YPY-Cache-Evict   the copy is deleted: the next request goes to the server and waits for it.
// A successful request that is not a GET evicts everything unless the response carries either
// header (`false` keeps everything). ypy.cache.expire(patterns) and ypy.cache.evict(patterns) do
// the same from script.
//
// Tags. ypy-cache-tags="products, featured" on the element (inherited with
// ypy-cache-tags:inherited) labels the copy of its request; the pattern `tag:products` then names
// every copy with that tag, in either header or in the script API.
//
// How it hooks in: from ypy_before_request the extension wraps ctx.fetch, so a copy is answered as
// a response and every later phase (headers, status codes, swap) runs as for the network. The
// copy is stored in ypy_after_request, when the body has been read. After the swap
// (ypy_finally_request) a copy that was not fresh is revalidated with If-None-Match and
// If-Modified-Since; a 304 or an identical body changes nothing, a new body is swapped again into
// the same target with the original context, without a history entry, scroll or focus change.
// While it runs the target carries the ypy-revalidating class.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <script src="ypy-cache.js"></script>
//   <a ypy-get="/reports" ypy-target="#main" ypy-cache>Reports</a>
//==========================================================
(() => {

    let api;
    const KEY = 'ypy-cache:';
    const store = new Map();         // key -> entry, oldest first (a hit moves its entry last)
    const latest = new WeakMap();    // target element -> the last request that went to it
    // the response headers worth replaying with a copy: what the swap reads, not one-off events
    const KEEP = /^(content-type|etag|last-modified|cache-control|vary|ypy-(retarget|reswap|reselect|push-url|replace-url))$/;
    let chars = 0;                   // text held by the store

    const lower = pairs => Object.fromEntries([...pairs].map(([k, v]) => [k.toLowerCase(), v]));
    const options = attr => ({size: 50, bytes: 2097152, ttl: '10m', fresh: 0, ...ypy.config.cache, ...api.HCON.parse(attr)});

    // Removes a copy from the store and from sessionStorage.
    function drop(key) {
        let e = store.get(key);
        if (!e) return;
        chars -= e.text.length;
        store.delete(key);
        if (e.off) try { sessionStorage.removeItem(KEY + key) } catch {}
    }

    // Does the pattern name the copy? `tag:x` is a tag; `*` is anything; otherwise a path, with `*` as a wildcard.
    const matches = (p, e) => /^tag:/.test(p) ? (e.tags || []).includes(p.slice(4).trim()) : p === '*' || (p.includes('*')
        ? new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(e.path)
        : p === e.path || p === e.path.split('?')[0]);

    const persist = e => { if (e.off) try { sessionStorage.setItem(KEY + e.key, JSON.stringify(e)) } catch {} };

    // Marks old (shown, then revalidated) or, with `evict`, deletes the copies the comma separated patterns name; returns how many.
    function mark(spec, evict) {
        let patterns = String(spec).split(',').map(s => s.trim()).filter(Boolean), n = 0;
        for (let [key, e] of store) {
            if (!patterns.some(p => matches(p, e))) continue;
            n++;
            if (evict) drop(key);
            else if (!e.stale) { e.stale = true; persist(e) }
        }
        if (n) api.triggerEvent(document, evict ? 'ypy:cache:evict' : 'ypy:cache:expire', evict ? {patterns, removed: n} : {patterns, expired: n});
        return n;
    }

    // Keeps the response in the store, unless it must not be kept.
    function save(ctx, c) {
        let {response, text} = ctx, h = lower(response.headers), cc = h['cache-control'] || '', o = c.o;
        drop(c.key);
        if (/no-store/i.test(cc) || /private/i.test(cc) && !o.private || /^\s*\*/.test(h.vary) || text.length > o.bytes / 2) return;
        let age = /max-age=(\d+)/i.exec(cc)?.[1];
        let e = {
            key: c.key, href: c.url.href, path: c.url.pathname + c.url.search, text, time: Date.now(),
            headers: Object.fromEntries(Object.entries(h).filter(([k]) => KEEP.test(k))),
            vary: Object.fromEntries((h.vary || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(n => [n, c.rh[n] ?? ''])),
            fresh: age == null ? undefined : age * 1000, redirected: !!ctx.redirected, off: !!o.offline, tags: c.tags
        };
        store.set(c.key, e);
        chars += text.length;
        persist(e);
        while (store.size > o.size || chars > o.bytes) drop(store.keys().next().value);
    }

    // The stored copy as the response the core expects.
    function reply(ctx, e, offline) {
        api.triggerEvent(ctx.sourceElement, 'ypy:cache:hit', {ctx, url: e.href, age: Date.now() - e.time, offline: !!offline});
        // a response proves the connection to the core: say again that the device is offline
        if (!navigator.onLine) setTimeout(() => window.dispatchEvent(new Event('offline')));
        return Object.defineProperties(new Response(e.text, {status: 200, headers: e.headers}), {
            url: {value: e.href}, redirected: {value: e.redirected}
        });
    }

    // Asks the server whether the copy shown is still current; swaps again when it is not.
    async function revalidate(ctx, c) {
        let e = c.hit, mark = ctx.target?.isConnected ? ctx.target : ctx.sourceElement, headers = {...ctx.request.headers};
        let done = (changed, status) => api.triggerEvent(ctx.sourceElement, 'ypy:cache:revalidated', {ctx, url: e.href, changed, status});
        if (e.headers.etag) headers['If-None-Match'] = e.headers.etag;
        if (e.headers['last-modified']) headers['If-Modified-Since'] = e.headers['last-modified'];
        mark.classList.add('ypy-revalidating');
        try {
            let {credentials, mode} = ctx.request;
            let res = await fetch(e.href, {method: 'GET', headers, credentials, mode, signal: AbortSignal.timeout(ypy.config.defaultTimeout || 30000)});
            if (res.status === 304) {
                e.time = Date.now();
                e.stale = false;
                persist(e);
                return done(false, 304);
            }
            if (res.status !== 200) {
                drop(c.key);
                return done(false, res.status);
            }
            let text = await res.text(), same = text === e.text;
            if (same) { e.time = Date.now(); e.stale = false; persist(e) }
            else save({response: res, text, redirected: res.redirected}, c);
            // the region may have moved on to another request or left the page: then only the copy is renewed
            let live = !same && latest.get(ctx.target) === ctx && ctx.target?.isConnected;
            done(live, 200);
            if (live) {
                let ypyHeaders = {};
                for (let [k, v] of res.headers) if (/^ypy-/i.test(k) && !/^ypy-(push|replace)-url$/i.test(k)) ypyHeaders[k.slice(4).toLowerCase().replace(/-/g, '')] = v;
                Object.assign(ctx, {
                    text, response: {raw: res, status: 200, headers: res.headers}, ypy: ypyHeaders,
                    push: 'false', replace: 'false', scroll: 'keep', focus: 'none', swap: ctx.swap + ' show:none'
                });
                ctx.request.anchor = undefined;
                await ypy.swap(ctx);
            }
        } catch {
            // offline or timed out: the copy stays, and the next request tries again
        } finally {
            mark.classList.remove('ypy-revalidating');
        }
    }

    ypy.registerExtension('ypy-cache', {

        init: (internalApi) => {
            api = internalApi;
            // copies kept for offline use by an earlier page of this tab
            try {
                let kept = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    let k = sessionStorage.key(i);
                    if (k?.startsWith(KEY)) try { kept.push(JSON.parse(sessionStorage.getItem(k))) } catch {}
                }
                for (let e of kept.sort((a, b) => a.time - b.time)) {
                    store.set(e.key, e);
                    chars += e.text.length;
                }
            } catch {}
            ypy.cache = {
                /** Marks old the copies named by the comma separated patterns (they are still shown, then revalidated); returns how many. */
                expire: spec => mark(spec),
                /** Deletes the copies named by the comma separated patterns; returns how many. */
                evict: spec => mark(spec, true),
                /** Deletes every copy (call it when the user signs out). */
                clear: () => mark('*', true),
                /** What the store holds, for tests and tooling. */
                stats: () => ({entries: store.size, chars})
            };
        },

        ypy_before_request: (elt, {ctx}) => {
            if (ctx.target?.nodeType === 1) latest.set(ctx.target, ctx);
            let {request} = ctx, attr = api.attributeValue(elt, 'ypy-cache'), url;
            if (request.method !== 'GET' || attr === 'false' || attr == null && !ypy.config.cache?.all) return;
            try { url = new URL(request.action, document.baseURI) } catch { return }
            if (url.origin !== location.origin) return;
            url.hash = '';
            let rh = lower(Object.entries(request.headers)), key = (rh['YPY-Request-Type'.toLowerCase()] || '') + ' ' + url.href;
            let e = store.get(key), o = options(attr);
            if (e && !Object.entries(e.vary).every(([n, v]) => (rh[n] ?? '') === v)) e = null;
            let tags = String(api.attributeValue(elt, 'ypy-cache-tags') ?? '').split(/[\s,]+/).filter(Boolean);
            let c = ctx.cache = {key, url, o, rh, tags}, age = e && Date.now() - e.time, inner = ctx.fetch;
            ctx.fetch = async (action, req) => {
                if (e && age <= ypy.parseInterval(o.ttl)) {
                    store.delete(key);
                    store.set(key, e);
                    c.hit = e;
                    c.fresh = !e.stale && age < (e.fresh ?? ypy.parseInterval(o.fresh));
                    return reply(ctx, e);
                }
                // too old to show: ask with its validators and keep it when the server agrees
                if (e?.headers.etag) req.headers['If-None-Match'] = e.headers.etag;
                if (e?.headers['last-modified']) req.headers['If-Modified-Since'] = e.headers['last-modified'];
                let res;
                try {
                    res = await inner(action, req);
                } catch (error) {
                    if (!e || !(o.offline || e.off) || req.signal.aborted) throw error;
                    c.hit = e;
                    c.fresh = true;
                    return reply(ctx, e, true);
                }
                if (res.status !== 304 || !e) return res;
                e.time = Date.now();
                e.stale = false;
                c.hit = e;
                c.fresh = true;
                return reply(ctx, e);
            };
        },

        ypy_after_request: (elt, {ctx}) => {
            let {response, request} = ctx, c = ctx.cache, h = lower(response.headers), old = h['YPY-Cache-Expire'.toLowerCase()], gone = h['YPY-Cache-Evict'.toLowerCase()];
            if (gone != null && gone.trim() !== 'false') mark(gone, true);
            if (old != null && old.trim() !== 'false') mark(old);
            if (old == null && gone == null && request.method !== 'GET' && response.status < 400 && !request.headers['YPY-Validate']) {
                mark('*', true);
            }
            if (c && !c.hit) response.status === 200 ? save(ctx, c) : drop(c.key);
        },

        ypy_finally_request: (elt, {ctx}) => {
            let c = ctx.cache;
            if (c?.hit && !c.fresh && ctx.status === 'swapped') revalidate(ctx, c);
        }
    });

})();
