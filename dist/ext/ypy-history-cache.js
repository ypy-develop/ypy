// SPDX-License-Identifier: MIT
//==========================================================
// ypy-history-cache.js
//
// Pages kept in sessionStorage for back and forward (see historyCache in the configuration).
//
// historyCache.encrypt seals the snapshots with WebCrypto (AES-GCM, a 256 bit key made for the
// session, a new IV for each snapshot, the snapshot id as additional data), so what a page showed
// is not readable in the storage of the browser:
//
//   ypy.config.historyCache = {encrypt: true}       // the key is kept in sessionStorage: the
//                                                   // snapshots survive a reload of the tab
//   ypy.config.historyCache = {encrypt: 'memory'}   // the key lives in memory only: after a reload
//                                                   // the old snapshots can not be read and the
//                                                   // pages come from the server
//
// ypy.history.clear() forgets every snapshot and also replaces the key. Without WebCrypto (a page
// that is not a secure context) nothing is stored: a snapshot is never written in the clear when
// encryption was asked for. The key is as safe as the page itself: a script of the page can read
// it, so this protects the storage at rest, not the page from its own scripts. Sealing is
// asynchronous, so ypy:history:cache:after:save fires when the snapshot is stored. A restore of a
// sealed snapshot is asynchronous as well: if a ypy:history:cache:hit listener cancels it, or the
// snapshot can not be opened, the page is reloaded instead of requested.
//==========================================================
(() => {
    let api;
    let _currentId = null;
    let _raw = null;        // the key of the session, base64
    let _sealKey = null;    // {raw, key: Promise<CryptoKey>}
    let _gen = 0;           // grows when the key is replaced: a snapshot sealed before is dropped
    const KEY_NAME = 'ypy-history-key';

    const INDEX_KEY = 'ypy-history-index';

    function cfg() {
        return ypy.config.historyCache;
    }

    function prefixSelector(s) {
        return ['ypy-', 'data-ypy-', ypy.config.prefix].filter(Boolean).map(p => s.replaceAll('ypy-', p)).join(',');
    }

    function canUseStorage() {
        try {
            sessionStorage.setItem('__ypy_test__', '1');
            sessionStorage.removeItem('__ypy_test__');
            return true;
        } catch (_) { return false; }
    }

    function genId() {
        return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    }

    function getHistoryTarget() {
        return ypy.find(prefixSelector('[ypy-history-elt]')) || document.body;
    }

    const ATTR_VALUE   = 'data-ypy-history-value';
    const ATTR_CHECKED = 'data-ypy-history-checked';
    const ATTR_SCROLL  = 'data-ypy-history-scroll';

    // A field the browser itself is told not to remember (password, autocomplete off, a card or a one-time
    // code) is not remembered here either: neither what was typed nor the value the server rendered.
    // Hidden fields are kept on purpose: they hold no secret from a script of the page, and a restored form
    // that lost its token could not be submitted.
    function isSensitive(el) {
        return el.type?.toLowerCase() === 'password' ||
            /(?:^|\s)(?:off|one-time-code|cc-\S+|current-password|new-password)(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
    }

    function annotateState(root) {
        root.querySelectorAll('input, textarea, select').forEach(el => {
            let type = el.type?.toLowerCase();
            if (type === 'file' || isSensitive(el)) return;
            if (type === 'checkbox' || type === 'radio') {
                if (el.checked) el.setAttribute(ATTR_CHECKED, '1');
            } else if (el.tagName === 'SELECT' && el.multiple) {
                let selected = Array.from(el.options).filter(o => o.selected).map(o => o.value);
                if (selected.length) el.setAttribute(ATTR_VALUE, JSON.stringify(selected));
            } else if (el.value) {
                el.setAttribute(ATTR_VALUE, el.value);
            }
        });
        root.querySelectorAll('*').forEach(el => {
            if (el.scrollTop > 0 || el.scrollLeft > 0)
                el.setAttribute(ATTR_SCROLL, `${el.scrollTop},${el.scrollLeft}`);
        });
    }

    function restoreAnnotations(root) {
        root.querySelectorAll(`[${ATTR_CHECKED}]`).forEach(el => {
            el.checked = true;
            el.removeAttribute(ATTR_CHECKED);
        });
        root.querySelectorAll(`[${ATTR_VALUE}]`).forEach(el => {
            let raw = el.getAttribute(ATTR_VALUE);
            if (el.tagName === 'SELECT' && el.multiple) {
                let values = JSON.parse(raw);
                Array.from(el.options).forEach(o => { o.selected = values.includes(o.value); });
            } else {
                el.value = raw;
            }
            el.removeAttribute(ATTR_VALUE);
        });
        root.querySelectorAll(`[${ATTR_SCROLL}]`).forEach(el => {
            let [top, left] = el.getAttribute(ATTR_SCROLL).split(',').map(Number);
            el.scrollTop = top;
            el.scrollLeft = left;
            el.removeAttribute(ATTR_SCROLL);
        });
    }

    function cleanContent(elt) {
        let clone = elt.cloneNode(true);
        let requestClasses = (ypy.config.classes?.request ?? '').split(/\s+/).filter(Boolean);
        for (let cls of requestClasses) clone.querySelectorAll('.' + CSS.escape(cls)).forEach(el => el.classList.remove(...requestClasses));
        clone.querySelectorAll('input, textarea').forEach(el => {
            if (!isSensitive(el)) return;
            el.removeAttribute('value');
            if (el.tagName === 'TEXTAREA') el.textContent = '';
        });
        clone.querySelectorAll('[disabled][data-disabled-by-ypy]').forEach(el => {
            el.removeAttribute('disabled');
            el.removeAttribute('data-disabled-by-ypy');
        });
        return clone.outerHTML;
    }

    // --- Stamp the current history entry with an id and track it ---

    function stampCurrentEntry() {
        let state = history.state || { ypy: true };
        let id = state.ypyId;
        if (!id) {
            id = genId();
            // a browser may refuse the write (Safari: 100 per 10 seconds): the entry is then not stamped and a
            // return to it is a cache miss
            try { history.replaceState({ ...state, ypyId: id }, '', location.href); } catch {}
        }
        _currentId = id;
    }

    // --- sessionStorage (LRU index of ypyIds) ---

    function readIndex() {
        try { return JSON.parse(sessionStorage.getItem(INDEX_KEY)) || []; } catch { return []; }
    }

    function writeIndex(index) {
        sessionStorage.setItem(INDEX_KEY, JSON.stringify(index));
    }

    function store(ypyId, data) {
        let index = readIndex().filter(id => id !== ypyId);
        while (index.length >= cfg().size) {
            sessionStorage.removeItem('ypy-history-' + index.shift());
        }
        while (true) {
            try {
                sessionStorage.setItem('ypy-history-' + ypyId, data);
                index.push(ypyId);
                writeIndex(index);
                return true;
            } catch (e) {
                if (index.length === 0) return false;
                sessionStorage.removeItem('ypy-history-' + index.shift());
            }
        }
    }

    // --- encryption (historyCache.encrypt) ---

    const b64 = bytes => btoa(String.fromCharCode(...bytes));
    const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const encrypting = () => cfg().encrypt ? cfg().encrypt === 'memory' ? 'memory' : 'session' : null;

    // the key of the session, made when `create` says so; the one in sessionStorage survives a reload
    function rawKey(create) {
        if (!_raw && encrypting() === 'session') try { _raw = sessionStorage.getItem(KEY_NAME); } catch (_) { /* no storage */ }
        if (!_raw && create) {
            _raw = b64(crypto.getRandomValues(new Uint8Array(32)));
            if (encrypting() === 'session') try { sessionStorage.setItem(KEY_NAME, _raw); } catch (_) { /* memory only */ }
        }
        return _raw;
    }

    function cryptoKey(create) {
        let raw = rawKey(create);
        if (!raw) return null;
        if (_sealKey?.raw !== raw) {
            _sealKey = {raw, key: crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])};
        }
        return _sealKey.key;
    }

    async function seal(ypyId, entry) {
        let iv = crypto.getRandomValues(new Uint8Array(12));
        let data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(ypyId)},
            await cryptoKey(true), new TextEncoder().encode(JSON.stringify(entry)));
        return JSON.stringify({enc: 1, iv: b64(iv), data: b64(new Uint8Array(data))});
    }

    async function open(ypyId, record) {
        let data = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(record.iv), additionalData: new TextEncoder().encode(ypyId)},
            await cryptoKey(false), unb64(record.data));
        return JSON.parse(new TextDecoder().decode(data));
    }

    // Stores a snapshot. Returns true, or false when it could not be stored; with encryption it
    // returns the promise of that, so the caller can wait for the snapshot to be there.
    function saveToStorage(ypyId, entry) {
        if (!canUseStorage() || cfg().size <= 0) return false;
        if (!encrypting()) return store(ypyId, JSON.stringify(entry));
        if (!crypto?.subtle) {
            console.warn('ypy-history-cache: encrypt needs WebCrypto (a secure context); the page is not cached');
            return false;
        }
        let gen = _gen;
        return seal(ypyId, entry).then(data => gen === _gen && store(ypyId, data), () => false);
    }

    function getFromStorage(ypyId) {
        try { return JSON.parse(sessionStorage.getItem('ypy-history-' + ypyId)); } catch { return null; }
    }

    // --- save / get ---


    function saveCurrentPage(targetId) {
        targetId = targetId || _currentId;
        if (!targetId) return;
        if (ypy.find(prefixSelector('[ypy-history="false"]'))) return;

        let target = getHistoryTarget();
        annotateState(target);
        let head = document.head.outerHTML;
        let scroll = window.scrollY;
        let title = document.title;

        let detail = { target, head };
        if (api.triggerEvent(document, 'ypy:history:cache:before:save', detail) === false) return;
        let content = cleanContent(target);
        head = detail.head;

        let saved = saveToStorage(targetId, { content, head, scroll, title });
        let announce = () => api.triggerEvent(document, 'ypy:history:cache:after:save', { content, head, scroll, title });
        saved instanceof Promise ? saved.then(announce) : announce();
    }

    function getCachedContent() {
        let id = history.state?.ypyId;
        if (!id) return null;
        return canUseStorage() ? getFromStorage(id) : null;
    }

    async function restoreFromCache(item) {
        let detail = { head: item.head, ready: null };
        api.triggerEvent(document, 'ypy:history:cache:before:restore', detail);
        if (detail.ready) await detail.ready;

        let cachedHTML = item.content;
        let restoreSwapTarget = getHistoryTarget();
        let restoreSwapStyle = cfg().swapStyle;
        let ctx = {
            sourceElement: document.body,
            target: restoreSwapTarget,
            swap: restoreSwapStyle,
            text: cachedHTML,
            transition: ypy.config.transitions ?? false
        };
        await ypy.swap(ctx);

        document.title = item.title || document.title;
        requestAnimationFrame(() => {
            window.scrollTo(0, item.scroll || 0);
            restoreAnnotations(getHistoryTarget());
            detail.item = item;
            api.triggerEvent(document, 'ypy:history:cache:after:restore', detail);
        });
    }

    // Forgets every snapshot of this tab (call it when the user signs out). With encryption the key
    // is replaced too, so a snapshot that was being sealed, or one that is left somewhere, is lost.
    function clearAll() {
        _gen++;
        _raw = _sealKey = null;
        try {
            for (let key of Object.keys(sessionStorage)) {
                if (key === INDEX_KEY || key.startsWith('ypy-history-')) sessionStorage.removeItem(key);   // the key too
            }
        } catch (_) { /* storage unavailable: nothing was stored */ }
        if (encrypting() && crypto?.subtle) rawKey(true);   // the new key
    }

    // The restore of a sealed snapshot: the core was told to wait, so whatever goes wrong here is a reload.
    async function restoreSealed(ypyId, record, path) {
        let item;
        try {
            item = await open(ypyId, record);
        } catch (_) {
            sessionStorage.removeItem('ypy-history-' + ypyId);
            api.triggerEvent(document, 'ypy:history:cache:miss', { path, refreshOnMiss: true });
            return location.reload();
        }
        let hitDetail = { path, item };
        if (api.triggerEvent(document, 'ypy:history:cache:hit', hitDetail) === false) return location.reload();
        restoreFromCache(hitDetail.item);
    }

    ypy.registerExtension('ypy-history-cache', {
        init: (internalAPI) => {
            api = internalAPI;
            (ypy.history ??= {}).clear = clearAll;
            ypy.config.historyCache            ??= {};
            ypy.config.historyCache.size          ??= 10;
            ypy.config.historyCache.refreshOnMiss ??= false;
            ypy.config.historyCache.disable       ??= false;
            ypy.config.historyCache.swapStyle     ??= 'outerSync';
            ypy.config.historyCache.encrypt       ??= false;
            // Only stamp if core already tagged this entry (YPY-navigated page).
            // If history.state is null this is a fresh/POST-result page - leave it
            // alone so F5 still triggers the browser's resubmit prompt.
            if (history.state?.ypy) stampCurrentEntry();
        },

        // Before core pushes/replaces, save the outgoing page
        ypy_before_history_update: (elt, detail) => {
            if (cfg().disable) return;
            stampCurrentEntry();
            saveCurrentPage();
        },

        // After core pushes/replaces, stamp the new entry and track it
        ypy_after_history_update: () => {
            if (cfg().disable) return;
            stampCurrentEntry();
        },

        ypy_before_history_restore: (elt, detail) => {
            if (cfg().disable) return;

            let outgoingId = _currentId;
            let destinationId = history.state?.ypyId;

            if (outgoingId && outgoingId !== destinationId) {
                saveCurrentPage(outgoingId);
            }

            if (!destinationId) {
                stampCurrentEntry();
            } else {
                _currentId = destinationId;
            }

            let item = getCachedContent();
            if (item?.enc) {
                // sealed: it can only be opened without a key if there is one to open it
                if (encrypting() && rawKey(false)) {
                    detail.cancelled = true;
                    restoreSealed(destinationId, item, detail.path);
                    return false;
                }
                sessionStorage.removeItem('ypy-history-' + destinationId);
                item = null;
            }
            if (!item) {
                let missDetail = { path: detail.path, refreshOnMiss: cfg().refreshOnMiss };
                api.triggerEvent(document, 'ypy:history:cache:miss', missDetail);
                if (missDetail.refreshOnMiss) { location.reload(); return false; }
                return;
            }

            let hitDetail = { path: detail.path, item };
            if (api.triggerEvent(document, 'ypy:history:cache:hit', hitDetail) === false) return;

            detail.cancelled = true;
            restoreFromCache(hitDetail.item);
            return false;
        }
    });
})();
