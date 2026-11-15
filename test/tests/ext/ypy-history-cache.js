// SPDX-License-Identifier: MIT
describe('ypy-history-cache extension', function () {

    let extBackup;
    let historyElt;
    let writes;   // Safari refuses more than 100 history writes per 10 seconds: wait for room before a test

    before(async () => {
        writes = trackHistoryWrites();
        extBackup = backupExtensions();
        clearExtensions();
        ypy.config.extensions = 'ypy-history-cache';
        ypy.__approvedExt = 'ypy-history-cache';

        let script = document.createElement('script');
        script.src = '../src/ext/ypy-history-cache.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        writes.stop();
        restoreExtensions(extBackup);
    });

    beforeEach(async function () {
        this.timeout(15000);   // the wait for room can take up to the 10 seconds of the window
        await writes.room(20);
        setupTest();
        sessionStorage.clear();
        ypy.config.historyCache = { size: 10, refreshOnMiss: false, disable: false, swapStyle: 'outerSync' };

        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>initial content</p>';
        playground().appendChild(historyElt);
    });

    afterEach(() => {
        cleanupTest();
        sessionStorage.clear();
    });

    // The restore of a page on a cache miss asks the server for a whole page: a fragment makes the
    // core reload the page, so the server answers with a document that holds the history element
    const page = text => '<!doctype html><html><body><div ypy-history-elt>' + text + '</div></body></html>';

    // -------------------------------------------------------------------------
    // Helper: read the URL-keyed cache array from sessionStorage
    // -------------------------------------------------------------------------

    function readCache() {
        try { return JSON.parse(sessionStorage.getItem('ypy-history-index')) || []; } catch { return []; }
    }

    // -------------------------------------------------------------------------
    // saveCurrentPage / basic read-back
    // -------------------------------------------------------------------------

    it('does not cache a page when history is disabled', async function () {
        let originalHistory = ypy.config.history;
        ypy.config.history = false;
        mockResponse('GET', '/page2', '<p>page 2</p>');
        let button = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');

        try {
            button.click();
            await forRequest();
            assert.deepEqual(readCache(), []);
        } finally {
            ypy.config.history = originalHistory;
        }
    });

    it('saves current page on ypy:before:history:update', async function () {
        let savedDetail = null;
        document.addEventListener('ypy:history:cache:after:save', e => { savedDetail = e.detail; }, { once: true });

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>initial content</p>';
        playground().appendChild(historyElt);

        btn.click();
        await forRequest();

        assert.isNotNull(savedDetail);
        assert.include(savedDetail.content, 'initial content');
    });

    it('stores title and scroll in cache item', async function () {
        document.title = 'Test Page';
        let savedDetail = null;
        document.addEventListener('ypy:history:cache:after:save', e => { savedDetail = e.detail; }, { once: true });

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>initial content</p>';
        playground().appendChild(historyElt);

        btn.click();
        await forRequest();

        assert.equal(savedDetail.title, 'Test Page');
        assert.isNumber(savedDetail.scroll);
    });

    it('deduplicates entries for the same URL', async function () {
        let saveCount = 0;
        let savedUrls = [];
        document.addEventListener('ypy:history:cache:after:save', e => {
            saveCount++;
            savedUrls.push(e.detail.url ?? location.pathname + location.search);
        });

        let savedUrl = location.pathname + location.search;

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>content</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        // Navigate again from the same original URL
        history.replaceState(history.state, '', savedUrl);
        mockResponse('GET', '/page3', '<p>page 3</p>');
        let btn2 = createProcessedHTML('<button ypy-get="/page3" ypy-push-url="/page3">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>content</p>';
        playground().appendChild(historyElt);
        btn2.click();
        await forRequest();

        // Two saves fired but the extension deduplicates in history.state (same entry overwritten)
        assert.equal(saveCount, 2);
    });

    it('evicts oldest entry when size is exceeded', async function () {
        ypy.config.historyCache.size = 2;
        let saveCount = 0;
        document.addEventListener('ypy:history:cache:after:save', () => saveCount++);

        for (let i = 1; i <= 3; i++) {
            mockResponse('GET', `/p${i + 1}`, `<p>page ${i + 1}</p>`);
            let btn = createProcessedHTML(`<button ypy-get="/p${i + 1}" ypy-push-url="/p${i + 1}">go</button>`);
            historyElt = document.createElement('div');
            historyElt.setAttribute('ypy-history-elt', '');
            historyElt.innerHTML = `<p>page ${i}</p>`;
            playground().appendChild(historyElt);
            btn.click();
            await forRequest();
        }

        // 3 saves fired; size=2 means tier-2 sessionStorage eviction kicks in on overflow
        assert.equal(saveCount, 3);
    });

    it('does not save when size is 0', async function () {
        ypy.config.historyCache.size = 0;

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>content</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        assert.equal(readCache().length, 0);
    });

    it('does not cache when ypy-history="false" is present', async function () {
        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.setAttribute('ypy-history', 'false');
        historyElt.innerHTML = '<p>sensitive</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        assert.equal(readCache().length, 0);
    });

    it('does nothing when disable is true', async function () {
        ypy.config.historyCache.disable = true;

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>content</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        assert.equal(readCache().length, 0);
    });

    // -------------------------------------------------------------------------
    // ypy:history:cache:before:save event
    // -------------------------------------------------------------------------

    it('before:save cancellation skips the save', async function () {
        let handler = e => e.preventDefault();
        document.addEventListener('ypy:history:cache:before:save', handler, { once: true });

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>content</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        assert.equal(readCache().length, 0);
    });

    it('before:save mutation to detail.target changes the stored content', async function () {
        let handler = e => { e.detail.target.querySelector('p').textContent = 'mutated'; };
        document.addEventListener('ypy:history:cache:before:save', handler, { once: true });

        let savedDetail = null;
        document.addEventListener('ypy:history:cache:after:save', e => { savedDetail = e.detail; }, { once: true });

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>original</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        assert.include(savedDetail.content, 'mutated');
    });

    it('after:save fires with content and head', async function () {
        let afterDetail = null;
        document.addEventListener('ypy:history:cache:after:save', e => { afterDetail = e.detail; }, { once: true });

        mockResponse('GET', '/page2', '<p>page 2</p>');
        let btn = createProcessedHTML('<button ypy-get="/page2" ypy-push-url="/page2">go</button>');
        historyElt = document.createElement('div');
        historyElt.setAttribute('ypy-history-elt', '');
        historyElt.innerHTML = '<p>content</p>';
        playground().appendChild(historyElt);
        btn.click();
        await forRequest();

        assert.isNotNull(afterDetail);
        assert.isString(afterDetail.content);
        assert.isString(afterDetail.head);
    });

    // -------------------------------------------------------------------------
    // restoreFromCache — cache hit (via ypy_before_history_restore)
    // -------------------------------------------------------------------------

    it('cache:hit restores content and cancels server fetch', async function () {
        let cachedPath = location.pathname + location.search;
        createProcessedHTML(`
            <div ypy-history-elt><p>cached content</p></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        history.replaceState({ ypy: true, ypyId }, '', cachedPath);
        historyElt.innerHTML = '<p>current page</p>';

        let serverFetched = false;
        mockResponse('GET', cachedPath, () => { serverFetched = true; return page('<p>server</p>'); });

        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
            restoreHistory(history.state, cachedPath);
        });

        assert.isFalse(serverFetched);
        assert.include(historyElt.innerHTML, 'cached content');
    });

    it('cache:hit cancellation falls through to server fetch', async function () {
        createProcessedHTML(`
            <div ypy-history-elt><p>cached</p></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        history.replaceState({ ypy: true, ypyId }, '', '/page1');
        document.addEventListener('ypy:history:cache:hit', e => e.preventDefault(), { once: true });
        document.addEventListener('ypy:before:swap', e => e.preventDefault(), { once: true });

        let serverFetched = false;
        mockResponse('GET', '/page1', () => { serverFetched = true; return page('<p>from server</p>'); });

        restoreHistory(history.state, '/page1');
        await forRequest();

        assert.isTrue(serverFetched);
    });

    it('cache:hit item mutation uses the mutated item', async function () {
        let cachedPath = location.pathname + location.search;
        createProcessedHTML(`
            <div ypy-history-elt><p>original cached</p></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        history.replaceState({ ypy: true, ypyId }, '', cachedPath);
        historyElt.innerHTML = '<p>current page</p>';

        document.addEventListener('ypy:history:cache:hit', e => {
            e.detail.item = { ...e.detail.item, content: '<p>mutated</p>' };
        }, { once: true });

        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
            restoreHistory(history.state, cachedPath);
        });

        assert.include(historyElt.innerHTML, 'mutated');
    });

    it('restores document.title from cache item', async function () {
        let cachedPath = location.pathname + location.search;
        document.title = 'My Cached Title';
        createProcessedHTML(`
            <div ypy-history-elt><p>x</p></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        document.title = 'Changed Title';
        history.replaceState({ ypy: true, ypyId }, '', cachedPath);

        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
            restoreHistory(history.state, cachedPath);
        });

        assert.equal(document.title, 'My Cached Title');
    });

    // -------------------------------------------------------------------------
    // restoreFromCache — cache miss
    // -------------------------------------------------------------------------

    it('cache:miss fires when entry not found', async function () {
        let missDetail = null;
        document.addEventListener('ypy:history:cache:miss', e => { missDetail = e.detail; }, { once: true });
        document.addEventListener('ypy:before:swap', e => e.preventDefault(), { once: true });

        history.replaceState({ ypy: true }, '', '/missing');
        mockResponse('GET', '/missing', page('<p>from server</p>'));
        restoreHistory(history.state, '/missing');
        await forRequest();

        assert.isNotNull(missDetail);
        assert.equal(missDetail.path, '/missing');
    });

    it('cache:miss refreshOnMiss config causes reload on miss', async function () {
        ypy.config.historyCache.refreshOnMiss = true;

        let reloadWouldHaveFired = false;
        document.addEventListener('ypy:history:cache:miss', e => {
            reloadWouldHaveFired = e.detail.refreshOnMiss;
            e.detail.refreshOnMiss = false;
        }, { once: true });
        document.addEventListener('ypy:before:swap', e => e.preventDefault(), { once: true });

        history.replaceState({ ypy: true }, '', '/missing-reload');
        mockResponse('GET', '/missing-reload', page('<p>from server</p>'));
        restoreHistory(history.state, '/missing-reload');
        await forRequest();

        assert.isTrue(reloadWouldHaveFired);
    });

    it('falls back to sessionStorage when history.state quota exceeded', async function () {
        let original = history.replaceState.bind(history);
        history.replaceState = function(state, title, url) {
            if (state?.ypyContent) throw new DOMException('quota', 'QuotaExceededError');
            return original(state, title, url);
        };

        try {
            createProcessedHTML(`
                <div ypy-history-elt><p>tier 2 content</p></div>
                <button ypy-get="/page2" ypy-push-url="/page2">go</button>
            `);
            historyElt = playground().querySelector('[ypy-history-elt]');

            mockResponse('GET', '/page2', '<p>page 2</p>');
            playground().querySelector('button').click();
            await forRequest();

            let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
            assert.equal(index.length, 1);

            let ypyId = index[0];
            assert.isString(ypyId);

            let cachedPath = location.pathname + location.search;
            history.replaceState = original;
            history.replaceState({ ypy: true, ypyId }, '', cachedPath);
            historyElt.innerHTML = '<p>current page</p>';

            await new Promise(resolve => {
                document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
                restoreHistory(history.state, cachedPath);
            });

            assert.include(historyElt.innerHTML, 'tier 2 content');
        } finally {
            history.replaceState = original;
        }
    });

    it('uses configured swapStyle for cache restore', async function () {
        ypy.config.historyCache.swapStyle = 'innerHTML';
        let cachedPath = location.pathname + location.search;
        createProcessedHTML(`
            <div ypy-history-elt><p>swap style test</p></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        history.replaceState({ ypy: true, ypyId }, '', cachedPath);

        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
            restoreHistory(history.state, cachedPath);
        });

        assert.include(historyElt.innerHTML, 'swap style test');
    });

    // -------------------------------------------------------------------------
    // form state & scroll annotation
    // -------------------------------------------------------------------------

    async function saveAndRestore(setupFn) {
        let cachedPath = location.pathname + location.search;
        createProcessedHTML(`
            <div ypy-history-elt></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');
        setupFn(historyElt);

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        history.replaceState({ ypy: true, ypyId }, '', cachedPath);
        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
            restoreHistory(history.state, cachedPath);
        });
        return historyElt;
    }

    it('restores text input value', async function () {
        let elt = await saveAndRestore(root => {
            let input = document.createElement('input');
            input.type = 'text';
            root.appendChild(input);
            input.value = 'hello';
        });
        assert.equal(elt.querySelector('input').value, 'hello');
    });

    it('restores textarea value', async function () {
        let elt = await saveAndRestore(root => {
            let ta = document.createElement('textarea');
            root.appendChild(ta);
            ta.value = 'some text';
        });
        assert.equal(elt.querySelector('textarea').value, 'some text');
    });

    it('restores checked checkbox', async function () {
        let elt = await saveAndRestore(root => {
            let cb = document.createElement('input');
            cb.type = 'checkbox';
            root.appendChild(cb);
            cb.checked = true;
        });
        assert.isTrue(elt.querySelector('input').checked);
    });

    it('does not restore unchecked checkbox', async function () {
        let elt = await saveAndRestore(root => {
            let cb = document.createElement('input');
            cb.type = 'checkbox';
            root.appendChild(cb);
            cb.checked = false;
        });
        assert.isFalse(elt.querySelector('input').checked);
    });

    it('restores checked radio', async function () {
        let elt = await saveAndRestore(root => {
            ['a', 'b'].forEach(v => {
                let r = document.createElement('input');
                r.type = 'radio';
                r.name = 'r';
                r.value = v;
                root.appendChild(r);
            });
            root.querySelectorAll('input')[1].checked = true;
        });
        let radios = elt.querySelectorAll('input[type=radio]');
        assert.isFalse(radios[0].checked);
        assert.isTrue(radios[1].checked);
    });

    it('restores single select value', async function () {
        let elt = await saveAndRestore(root => {
            let sel = document.createElement('select');
            ['a', 'b', 'c'].forEach(v => {
                let o = document.createElement('option');
                o.value = v;
                sel.appendChild(o);
            });
            root.appendChild(sel);
            sel.value = 'b';
        });
        assert.equal(elt.querySelector('select').value, 'b');
    });

    it('restores multi-select values', async function () {
        let elt = await saveAndRestore(root => {
            let sel = document.createElement('select');
            sel.multiple = true;
            ['r', 'g', 'b'].forEach(v => {
                let o = document.createElement('option');
                o.value = v;
                sel.appendChild(o);
            });
            root.appendChild(sel);
            sel.options[0].selected = true;
            sel.options[2].selected = true;
        });
        let selected = Array.from(elt.querySelector('select').options)
            .filter(o => o.selected).map(o => o.value);
        assert.deepEqual(selected, ['r', 'b']);
    });

    it('does not save password input value', async function () {
        let elt = await saveAndRestore(root => {
            let input = document.createElement('input');
            input.type = 'password';
            root.appendChild(input);
            input.value = 'secret';
        });
        assert.equal(elt.querySelector('input').value, '');
    });

    it('restores element scroll position', async function () {
        let elt = await saveAndRestore(root => {
            let div = document.createElement('div');
            div.style.height = '50px';
            div.style.overflowY = 'scroll';
            div.innerHTML = '<div style="height:200px"></div>';
            root.appendChild(div);
            div.scrollTop = 80;
        });
        assert.equal(elt.querySelector('div').scrollTop, 80);
    });

    // -------------------------------------------------------------------------
    // anchor-jump entry stamping
    // -------------------------------------------------------------------------

    it('stamps and saves an anchor-jump entry before pushing a new URL', async function () {
        let cachedPath = location.pathname + location.search;
        createProcessedHTML(`
            <div ypy-history-elt><p>anchor page</p></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        historyElt = playground().querySelector('[ypy-history-elt]');

        location.hash = '#section';
        assert.isNull(history.state);

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');

        // the anchor-jump entry must get its own ypyId stamped and saved.
        // the original entry is never saved (nothing navigated away from it via ypy),
        // so the index has exactly 1 entry belonging to the anchor-jump entry.
        assert.equal(index.length, 1, 'expected exactly one cache entry for the anchor-jump entry');

        let anchorYpyId = index[0];
        history.replaceState({ ypy: true, ypyId: anchorYpyId }, '', cachedPath + '#section');
        historyElt.innerHTML = '<p>current page</p>';

        let serverFetched = false;
        mockResponse('GET', cachedPath, () => { serverFetched = true; return page('<p>server</p>'); });

        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
            restoreHistory(history.state, cachedPath);
        });

        assert.isFalse(serverFetched, 'should have served from cache, not server');
        assert.include(historyElt.innerHTML, 'anchor page');
    });

    // -------------------------------------------------------------------------
    // prefix config
    // -------------------------------------------------------------------------

    it('respects ypy.config.prefix for ypy-history-elt', async function () {
        ypy.config.prefix = 'data-ypy-';
        try {
            let savedDetail = null;
            document.addEventListener('ypy:history:cache:after:save', e => { savedDetail = e.detail; }, { once: true });

            historyElt.remove();
            let prefixedElt = document.createElement('div');
            prefixedElt.setAttribute('data-ypy-history-elt', '');
            prefixedElt.innerHTML = '<p>prefixed target</p>';
            playground().appendChild(prefixedElt);

            mockResponse('GET', '/page2', '<p>page 2</p>');
            ypy.ajax('GET', '/page2', { push: '/page2', swap: 'none' });
            await forRequest();

            assert.isNotNull(savedDetail);
            assert.include(savedDetail.content, 'prefixed target');
        } finally {
            ypy.config.prefix = '';
        }
    });

    it('respects ypy.config.prefix for ypy-history="false"', async function () {
        ypy.config.prefix = 'data-ypy-';
        try {
            historyElt.remove();
            let sensitiveElt = document.createElement('div');
            sensitiveElt.setAttribute('data-ypy-history-elt', '');
            sensitiveElt.setAttribute('data-ypy-history', 'false');
            sensitiveElt.innerHTML = '<p>sensitive</p>';
            playground().appendChild(sensitiveElt);

            mockResponse('GET', '/page2', '<p>page 2</p>');
            ypy.ajax('GET', '/page2', { push: '/page2', swap: 'none' });
            await forRequest();

            assert.equal(readCache().length, 0);
        } finally {
            ypy.config.prefix = '';
        }
    });

    describe('encrypt', function () {
        const KEY = 'ypy-history-key';
        const lastId = () => readCache().at(-1);
        const stored = () => Object.keys(sessionStorage).map(k => sessionStorage.getItem(k)).join('\n');

        // leaves the page for /page2 and waits until the snapshot of the page it left is stored
        async function leave() {
            let cachedPath = location.pathname + location.search;
            createProcessedHTML('<div ypy-history-elt><p>secret content</p></div><button ypy-get="/page2" ypy-push-url="/page2">go</button>');
            historyElt = playground().querySelector('[ypy-history-elt]');
            mockResponse('GET', '/page2', '<p>page 2</p>');
            let saved = waitForEvent('ypy:history:cache:after:save', 500);
            playground().querySelector('button').click();
            await forRequest();
            (await saved).should.not.equal(null);
            return cachedPath;
        }

        async function back(cachedPath) {
            history.replaceState({ ypy: true, ypyId: lastId() }, '', cachedPath);
            historyElt.innerHTML = '<p>current page</p>';
            let served = false;
            mockResponse('GET', cachedPath, () => { served = true; return page('<p>server</p>'); });
            await new Promise(resolve => {
                document.addEventListener('ypy:history:cache:after:restore', resolve, { once: true });
                restoreHistory(history.state, cachedPath);
            });
            return served;
        }

        beforeEach(() => { ypy.config.historyCache.encrypt = true; });

        it('does not leave what the page showed readable in sessionStorage', async function () {
            await leave();
            let record = JSON.parse(sessionStorage.getItem('ypy-history-' + lastId()));
            record.enc.should.equal(1);
            record.iv.length.should.equal(16);   // 12 bytes
            assert.isString(record.data);
            stored().should.not.contain('secret content');
            stored().should.not.contain('<p>');
            atob(sessionStorage.getItem(KEY)).length.should.equal(32);
        });

        it('opens the snapshot on back and does not ask the server', async function () {
            let path = await leave();
            let served = await back(path);
            served.should.equal(false);
            historyElt.innerHTML.should.contain('secret content');
        });

        it('uses a new IV for every snapshot', async function () {
            await leave();
            let first = JSON.parse(sessionStorage.getItem('ypy-history-' + lastId())).iv;
            let saved = waitForEvent('ypy:history:cache:after:save', 500);
            mockResponse('GET', '/page3', '<p>page 3</p>');
            ypy.ajax('GET', '/page3', { push: '/page3', swap: 'none' });
            await saved;
            let second = JSON.parse(sessionStorage.getItem('ypy-history-' + lastId())).iv;
            second.should.not.equal(first);
            history.replaceState({ ypy: true }, '', '/');
        });

        it("encrypt: 'memory' keeps the key out of sessionStorage", async function () {
            ypy.config.historyCache.encrypt = 'memory';
            let path = await leave();
            assert.isNull(sessionStorage.getItem(KEY));
            stored().should.not.contain('secret content');
            let served = await back(path);
            served.should.equal(false);
            historyElt.innerHTML.should.contain('secret content');
        });

        it('ypy.history.clear() forgets the snapshots and replaces the key', async function () {
            await leave();
            let before = sessionStorage.getItem(KEY);
            readCache().length.should.equal(1);
            ypy.history.clear();
            readCache().length.should.equal(0);
            let after = sessionStorage.getItem(KEY);
            assert.isString(after);
            after.should.not.equal(before);
            atob(after).length.should.equal(32);
        });

        it('clear() drops a snapshot that was still being sealed', async function () {
            createProcessedHTML('<div ypy-history-elt><p>late</p></div><button ypy-get="/page2" ypy-push-url="/page2">go</button>');
            mockResponse('GET', '/page2', '<p>page 2</p>');
            // clear() runs right after the snapshot was taken, while it is being sealed
            let clearSoon = () => queueMicrotask(() => ypy.history.clear());
            document.addEventListener('ypy:history:cache:before:save', clearSoon, { once: true });
            playground().querySelector('button').click();
            await forRequest();
            await ypy.timeout(60);
            readCache().length.should.equal(0);
            stored().should.not.contain('"enc"');
        });

        it('treats a sealed snapshot as a miss when encryption is off', async function () {
            let path = await leave();
            ypy.config.historyCache.encrypt = false;
            historyElt.innerHTML = '<p>current page</p>';
            history.replaceState({ ypy: true, ypyId: lastId() }, '', path);
            let missed = waitForEvent('ypy:history:cache:miss', 500);
            mockResponse('GET', path, page('<p>server</p>'));
            restoreHistory(history.state, path);
            (await missed).should.not.equal(null);
            stored().should.not.contain('"enc"');
        });

        it('stores nothing, and says so, without WebCrypto', async function () {
            let warnings = [], warn = console.warn;
            console.warn = (...args) => warnings.push(args.join(' '));
            Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
            try {
                createProcessedHTML('<div ypy-history-elt><p>secret content</p></div><button ypy-get="/page2" ypy-push-url="/page2">go</button>');
                mockResponse('GET', '/page2', '<p>page 2</p>');
                playground().querySelector('button').click();
                await forRequest();
                await ypy.timeout(20);
            } finally {
                delete crypto.subtle;
                console.warn = warn;
            }
            readCache().length.should.equal(0);
            stored().should.not.contain('secret content');
            warnings.some(w => w.includes('ypy-history-cache')).should.equal(true);
        });

        it('keeps plain snapshots when encrypt is off', async function () {
            ypy.config.historyCache.encrypt = false;
            await leave();
            stored().should.contain('secret content');
            assert.isNull(sessionStorage.getItem(KEY));
        });
    });
});
