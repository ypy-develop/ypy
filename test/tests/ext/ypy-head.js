// SPDX-License-Identifier: MIT
describe('ypy-head extension', function() {

    let extBackup;
    let addedHeadElts = [];

    function addToHead(elt) {
        document.head.appendChild(elt);
        addedHeadElts.push(elt);
    }

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();

        ypy.config.extensions = 'ypy-head';

        let script = document.createElement('script');
        script.src = '../src/ext/ypy-head.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    afterEach(function() {
        for (const elt of addedHeadElts) {
            if (elt.parentNode === document.head) document.head.removeChild(elt);
        }
        addedHeadElts = [];
        cleanupTest();
    });

    function headResponse(headHtml, bodyHtml) {
        return `<html><head>${headHtml}</head><body>${bodyHtml}</body></html>`;
    }

    // Wait for head merge to complete
    async function afterMerge() {
        await waitForEvent('ypy:head:after:merge', 500)
            .catch(() => {}); // no head = no event, that's fine
        await forRequest();
    }

    it('merges new meta tags into head', async function() {
        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-desc" content="new page">', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

       div.click();
        await afterMerge();

        let meta = document.head.querySelector('meta[name="ypy-head-test-desc"]');
        assert.isNotNull(meta, 'meta tag should be added to head');
        assert.equal(meta.content, 'new page');
        if (meta) addedHeadElts.push(meta);
    });

    it('preserves existing head elements present in new head', async function() {
        let existing = document.createElement('meta');
        existing.setAttribute('name', 'ypy-head-test-preserve');
        existing.setAttribute('content', 'keep');
        addToHead(existing);

        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-preserve" content="keep">', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let metas = document.head.querySelectorAll('meta[name="ypy-head-test-preserve"]');
        assert.equal(metas.length, 1, 'should not duplicate preserved elements');
    });

    it('removes head elements not in new head under merge strategy', async function() {
        let stale = document.createElement('meta');
        stale.setAttribute('name', 'ypy-head-test-stale');
        stale.setAttribute('content', 'remove-me');
        addToHead(stale);

        mockResponse('GET', '/page', `<html><head ypy-head="merge"></head><body><div>swapped</div></body></html>`);
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        assert.isNull(document.head.querySelector('meta[name="ypy-head-test-stale"]'), 'stale element should be removed under merge');
    });

    it('does not remove head elements under append strategy', async function() {
        let existing = document.createElement('meta');
        existing.setAttribute('name', 'ypy-head-test-keep');
        existing.setAttribute('content', 'yes');
        addToHead(existing);

        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-new" content="added">', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let added = document.head.querySelector('meta[name="ypy-head-test-new"]');
        if (added) addedHeadElts.push(added);

        assert.isNotNull(document.head.querySelector('meta[name="ypy-head-test-keep"]'), 'existing element should be kept under append');
        assert.isNotNull(added, 'new element should be added');
    });

    it('fires ypy:head:before:merge and ypy:head:after:merge events', async function() {
        let beforeFired = false;
        let afterFired = false;

        let onBefore = () => { beforeFired = true; };
        let onAfter = () => { afterFired = true; };
        document.body.addEventListener('ypy:head:before:merge', onBefore);
        document.body.addEventListener('ypy:head:after:merge', onAfter);

        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-evt" content="val">', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        document.body.removeEventListener('ypy:head:before:merge', onBefore);
        document.body.removeEventListener('ypy:head:after:merge', onAfter);

        let added = document.head.querySelector('meta[name="ypy-head-test-evt"]');
        if (added) addedHeadElts.push(added);

        assert.isTrue(beforeFired, 'ypy:head:before:merge should fire');
        assert.isTrue(afterFired, 'ypy:head:after:merge should fire');
    });

    it('ypy:head:before:merge cancellation prevents merge', async function() {
        let onBefore = (e) => { e.preventDefault(); };
        document.body.addEventListener('ypy:head:before:merge', onBefore, {once: true});

        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-cancel" content="val">', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        assert.isNull(document.head.querySelector('meta[name="ypy-head-test-cancel"]'), 'merge should be cancelled');
    });

    it('re-eval elements are removed and re-appended', async function() {
        let executionCount = 0;
        window.testReEval = () => { executionCount++; };
        
        let existing = document.createElement('script');
        existing.setAttribute('ypy-head', 're-eval');
        existing.textContent = 'window.testReEval();';
        addToHead(existing);
        
        // Script should have executed once when added
        assert.equal(executionCount, 1, 'script should execute when first added');

        mockResponse('GET', '/page', headResponse('<script ypy-head="re-eval">window.testReEval();</script>', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let scripts = document.head.querySelectorAll('script');
        let reEvalScripts = Array.from(scripts).filter(s => s.textContent.includes('testReEval'));
        assert.equal(reEvalScripts.length, 1, 'should have exactly one re-eval script');
        assert.equal(executionCount, 2, 'script should have been re-executed');
        
        // track for cleanup
        addedHeadElts.push(reEvalScripts[0]);
        delete window.testReEval;
    });

    it('swap happens after head merge completes', async function() {
        let headMergeTime = null;
        let swapTime = null;

        let onMerge = () => { headMergeTime = Date.now(); };
        let onSwap = () => { swapTime = Date.now(); };
        document.body.addEventListener('ypy:head:after:merge', onMerge);
        document.body.addEventListener('ypy:after:swap', onSwap);

        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-timing" content="val">', '<div>swapped</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        document.body.removeEventListener('ypy:head:after:merge', onMerge);
        document.body.removeEventListener('ypy:after:swap', onSwap);

        let added = document.head.querySelector('meta[name="ypy-head-test-timing"]');
        if (added) addedHeadElts.push(added);

        assert.isNotNull(headMergeTime, 'head merge should have fired');
        assert.isNotNull(swapTime, 'swap should have fired');
        assert.isAtMost(headMergeTime, swapTime, 'head merge must complete before swap');
    });

    it('replaces title in append mode when new title differs', async function() {
        let title = document.createElement('title');
        title.textContent = 'Page 1';
        addToHead(title);

        mockResponse('GET', '/page', headResponse('<title>Page 2</title>', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let titles = document.head.querySelectorAll('title');
        assert.equal(titles.length, 1, 'should have exactly one title element');
        assert.equal(titles[0].textContent, 'Page 2', 'title should be updated to new page title');
    });

    it('does not duplicate title when navigating back and forth', async function() {
        let title = document.createElement('title');
        title.textContent = 'Page 1';
        addToHead(title);

        mockResponse('GET', '/page2', headResponse('<title>Page 2</title>', '<div>page 2</div>'));
        let div = createProcessedHTML('<div ypy-get="/page2" ypy-swap="innerHTML">click</div>');
        div.click();
        await afterMerge();

        mockResponse('GET', '/page1', headResponse('<title>Page 1</title>', '<div>page 1</div>'));
        let div2 = createProcessedHTML('<div ypy-get="/page1" ypy-swap="innerHTML">click</div>');
        div2.click();
        await afterMerge();

        let titles = document.head.querySelectorAll('title');
        assert.equal(titles.length, 1, 'should still have exactly one title after navigating back');
        assert.equal(titles[0].textContent, 'Page 1', 'title should reflect current page');
    });

    it('preserves title in append mode when new head has no title', async function() {
        let title = document.createElement('title');
        title.textContent = 'My Page';
        addToHead(title);

        let titleCountBefore = document.head.querySelectorAll('title').length;

        mockResponse('GET', '/page', headResponse('<meta name="ypy-head-test-notitle" content="yes">', '<div>content</div>'));
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let added = document.head.querySelector('meta[name="ypy-head-test-notitle"]');
        if (added) addedHeadElts.push(added);

        let titles = document.head.querySelectorAll('title');
        assert.equal(titles.length, titleCountBefore, 'title count should not change in append mode when new head has no title');
        assert.equal(title.textContent, 'My Page', 'original title should be preserved');
    });

    it('removes title in merge mode when incoming head has no title', async function() {
        let title = document.createElement('title');
        title.textContent = 'My Page';
        addToHead(title);

        let titleCountBefore = document.head.querySelectorAll('title').length;

        // ypy-head="merge" on the head tag forces merge strategy
        mockResponse('GET', '/page', `<html><head ypy-head="merge"><meta name="ypy-head-test-merge-notitle" content="yes"></head><body><div>content</div></body></html>`);
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let added = document.head.querySelector('meta[name="ypy-head-test-merge-notitle"]');
        if (added) addedHeadElts.push(added);

        let titles = document.head.querySelectorAll('title');
        assert.isBelow(titles.length, titleCountBefore, 'title should be removed in merge mode when new head has no title');
    });

    it('adds stylesheets to head', async function() {
        mockResponse('GET', '/page', headResponse('<link rel="stylesheet" href="/test-styles.css">', '<div>swapped content</div>'));
        
        let div = createProcessedHTML('<div ypy-get="/page" ypy-swap="innerHTML">click</div>');

        div.click();
        await afterMerge();

        let addedLink = document.head.querySelector('link[href="/test-styles.css"]');
        assert.isNotNull(addedLink, 'stylesheet should be added to head');
        assert.equal(addedLink.rel, 'stylesheet', 'link should have rel="stylesheet"');
        
        if (addedLink) addedHeadElts.push(addedLink);
    });
});

describe('ypy-head + ypy-history-cache integration', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        ypy.config.extensions = 'ypy-history-cache,ypy-head';
        ypy.__approvedExt = 'ypy-history-cache,ypy-head';

        for (const src of ['../src/ext/ypy-history-cache.js', '../src/ext/ypy-head.js']) {
            let script = document.createElement('script');
            script.src = src;
            await new Promise(resolve => {
                script.onload = resolve;
                document.head.appendChild(script);
            });
        }
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest();
        sessionStorage.clear();
        ypy.config.historyCache = {size: 10, refreshOnMiss: false, disable: false, swapStyle: 'outerSync'};
    });

    afterEach(() => {
        document.getElementById('cached-deferred-script')?.remove();
        delete window.cachedInputValueSeenByDeferred;
        cleanupTest();
        sessionStorage.clear();
    });

    it('runs deferred scripts after cached form state is restored', async function () {
        let cachedPath = location.pathname + location.search;
        createProcessedHTML(`
            <div ypy-history-elt><input id="cached-input"></div>
            <button ypy-get="/page2" ypy-push-url="/page2">go</button>
        `);
        let historyElt = playground().querySelector('[ypy-history-elt]');
        historyElt.querySelector('input').value = 'restored value';

        mockResponse('GET', '/page2', '<p>page 2</p>');
        playground().querySelector('button').click();
        await forRequest();

        let index = JSON.parse(sessionStorage.getItem('ypy-history-index') || '[]');
        let ypyId = index[index.length - 1];
        history.replaceState({ypy: true, ypyId}, '', cachedPath);
        historyElt.innerHTML = '<p>current page</p>';

        document.addEventListener('ypy:history:cache:hit', event => {
            let script = `<script id="cached-deferred-script" defer>
                window.cachedInputValueSeenByDeferred = document.getElementById('cached-input').value;
            <\/script>`;
            event.detail.item.head = event.detail.item.head.replace('</head>', script + '</head>');
        }, {once: true});

        await new Promise(resolve => {
            document.addEventListener('ypy:history:cache:after:restore', resolve, {once: true});
            restoreHistory(null, cachedPath);
        });

        assert.equal(
            window.cachedInputValueSeenByDeferred,
            'restored value',
            'deferred cached head script must see restored input value'
        );
    });
});
