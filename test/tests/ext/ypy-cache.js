// SPDX-License-Identifier: MIT
describe('ypy-cache extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-cache.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        ypy.cache.clear();
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        sessionStorage.clear();
        ypy.cache.clear();
    });

    afterEach(() => {
        cleanupTest();
        delete ypy.config.cache;
        ypy.cache.clear();
        sessionStorage.clear();
    });

    const page = (attrs = 'ypy-cache') =>
        createProcessedHTML(`<div><button ypy-get="/p" ypy-target="#out" ${attrs}>Go</button><div id="out"></div></div>`);
    const out = () => find('#out');
    const gets = () => fetchMock.getCalls().filter(c => c.request.method === 'GET');
    const wait = ms => ypy.timeout(ms);

    async function click(selector = 'button') {
        find(selector).click();
        await forRequest();
    }

    // -------------------------------------------------------------------------
    // The basic flow
    // -------------------------------------------------------------------------

    it('does nothing without ypy-cache', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {ETag: '"1"'}});
        page('');
        await click();
        await click();
        assert.equal(gets().length, 2);
        assert.equal(ypy.cache.stats().entries, 0);
    });

    it('stores a GET, shows it at once next time and revalidates with If-None-Match', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {ETag: '"1"'}});
        page();
        await click();
        assert.equal(out().textContent, 'v1');
        assert.equal(ypy.cache.stats().entries, 1);

        let held = mockSequentialResponses('GET', '/p', new MockResponse('', {status: 304}));
        let hit = waitForEvent('ypy:cache:hit');
        await click();
        assert.equal(out().textContent, 'v1', 'the copy is on the page before the server answered');
        assert.isNotNull(await hit);
        assert.equal(held.pendingCount, 1);
        assert.equal(lastFetch().request.headers['If-None-Match'], '"1"');
        assert.isTrue(out().classList.contains('ypy-revalidating'));

        let done = waitForEvent('ypy:cache:revalidated');
        await held.next();
        let evt = await done;
        assert.isFalse(evt.detail.changed);
        assert.equal(evt.detail.status, 304);
        assert.isFalse(out().classList.contains('ypy-revalidating'));
        assert.equal(out().textContent, 'v1');
    });

    it('sends If-Modified-Since from Last-Modified', async function () {
        let date = 'Wed, 21 Oct 2026 07:28:00 GMT';
        mockResponse('GET', '/p', 'v1', {headers: {'Last-Modified': date}});
        page();
        await click();
        mockResponse('GET', '/p', new MockResponse('', {status: 304}));
        await click();
        assert.equal(lastFetch().request.headers['If-Modified-Since'], date);
        assert.equal(out().textContent, 'v1');
        await wait(10);
    });

    it('does not swap again when the revalidated body is the same', async function () {
        mockResponse('GET', '/p', '<b>same</b>');
        page();
        await click();
        let held = mockSequentialResponses('GET', '/p', '<b>same</b>');
        await click();
        let shown = out().firstElementChild;
        let done = waitForEvent('ypy:cache:revalidated');
        await held.next();
        assert.isFalse((await done).detail.changed);
        assert.equal(out().firstElementChild, shown, 'the element was not replaced');
        assert.isFalse(out().classList.contains('ypy-revalidating'));
    });

    it('swaps the revalidated content when it changed, once, and keeps it for the next visit', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {ETag: '"1"'}});
        page();
        await click();
        let held = mockSequentialResponses('GET', '/p', 'v2', {headers: {ETag: '"2"'}});
        await click();
        assert.equal(out().textContent, 'v1');
        let done = waitForEvent('ypy:cache:revalidated');
        await held.next();
        let evt = await done;
        assert.isTrue(evt.detail.changed);
        await wait(10);
        assert.equal(out().textContent, 'v2');
        assert.isFalse(out().classList.contains('ypy-revalidating'));

        let again = mockSequentialResponses('GET', '/p', new MockResponse('', {status: 304}));
        await click();
        assert.equal(out().textContent, 'v2', 'the renewed copy is the one shown');
        assert.equal(lastFetch().request.headers['If-None-Match'], '"2"');
        await again.next();
        await wait(10);
    });

    it('does not add a history entry, scroll or move the focus when it swaps the revalidated content', async function () {
        mockResponse('GET', '/p', 'v1');
        let pushes = 0, count = () => pushes++;
        document.addEventListener('ypy:after:history:push', count);
        page('ypy-cache ypy-push-url="true"');
        await click();
        let held = mockSequentialResponses('GET', '/p', 'v2');
        await click();
        assert.equal(pushes, 2, 'one push for each click');
        await held.next();
        await wait(20);
        assert.equal(out().textContent, 'v2');
        assert.equal(pushes, 2, 'the revalidation made no entry');
        document.removeEventListener('ypy:after:history:push', count);
    });

    it('drops the result of a revalidation when another request went to the same target meanwhile', async function () {
        mockResponse('GET', '/p', 'A1');
        mockResponse('GET', '/q', 'B1');
        createProcessedHTML('<div><button id="a" ypy-get="/p" ypy-target="#out" ypy-cache>A</button>' +
            '<button id="b" ypy-get="/q" ypy-target="#out" ypy-cache>B</button><div id="out"></div></div>');
        await click('#a');
        await click('#b');
        let held = mockSequentialResponses('GET', '/p', 'A2');
        await click('#a');
        assert.equal(out().textContent, 'A1');
        await click('#b');
        assert.equal(out().textContent, 'B1');
        await held.next();
        await wait(20);
        assert.equal(out().textContent, 'B1', 'the late answer did not overwrite the newer page');
        // but the copy was renewed
        mockResponse('GET', '/p', new MockResponse('', {status: 304}));
        await click('#a');
        assert.equal(out().textContent, 'A2');
        await wait(10);
    });

    it('revalidates with a morph: the element the user is in is kept', async function () {
        mockResponse('GET', '/p', '<input id="q"><p>v1</p>');
        page();
        await click();
        let input = find('#q');
        let held = mockSequentialResponses('GET', '/p', '<input id="q"><p>v2</p>');
        await click();
        input = find('#q');
        input.value = 'typed meanwhile';
        input.focus();
        await held.next();
        await wait(30);
        assert.equal(out().querySelector('p').textContent, 'v2');
        assert.equal(find('#q'), input, 'the morph kept the field');
        assert.equal(input.value, 'typed meanwhile');
        assert.equal(document.activeElement, input);
    });

    it('keeps the copy and the page when the revalidation cannot reach the server', async function () {
        mockResponse('GET', '/p', 'v1');
        page();
        await click();
        mockFailure('GET', '/p');
        let errors = 0;
        document.addEventListener('ypy:error', () => errors++);
        await click();
        await wait(20);
        assert.equal(out().textContent, 'v1');
        assert.equal(errors, 0);
        assert.isFalse(out().classList.contains('ypy-revalidating'));
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('drops the copy, and leaves the page alone, when the revalidation gets an error status', async function () {
        mockResponse('GET', '/p', 'v1');
        page();
        await click();
        mockResponse('GET', '/p', 'gone', {status: 404});
        await click();
        await wait(20);
        assert.equal(out().textContent, 'v1');
        assert.equal(ypy.cache.stats().entries, 0);
    });

    // -------------------------------------------------------------------------
    // What is kept
    // -------------------------------------------------------------------------

    it('never keeps no-store, and keeps private only when asked', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {'Cache-Control': 'no-store'}});
        page();
        await click();
        assert.equal(ypy.cache.stats().entries, 0);

        mockResponse('GET', '/p', 'v1', {headers: {'Cache-Control': 'private, max-age=0'}});
        await click();
        assert.equal(ypy.cache.stats().entries, 0);

        page('ypy-cache="private"');
        await click();
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('never keeps a response whose Vary is *', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {Vary: '*'}});
        page();
        await click();
        assert.equal(ypy.cache.stats().entries, 0);
    });

    it('keeps only GET requests, only 200, and nothing from another origin', async function () {
        mockResponse('POST', '/p', 'posted');
        createProcessedHTML('<div><button ypy-post="/p" ypy-target="#out" ypy-cache>Post</button><div id="out"></div></div>');
        await click();
        assert.equal(ypy.cache.stats().entries, 0);

        mockResponse('GET', '/p', 'nf', {status: 404});
        page();
        await click();
        assert.equal(ypy.cache.stats().entries, 0);

        mockResponse('GET', 'other.example/p', 'foreign');
        createProcessedHTML('<div><button ypy-get="https://other.example/p" ypy-target="#out" ypy-cache>X</button><div id="out"></div></div>');
        await click();
        assert.equal(ypy.cache.stats().entries, 0);
    });

    it('caches every GET with config.cache.all and respects ypy-cache="false"', async function () {
        ypy.config.cache = {all: true};
        mockResponse('GET', '/p', 'v1');
        page('');
        await click();
        assert.equal(ypy.cache.stats().entries, 1);

        ypy.cache.clear();
        page('ypy-cache="false"');
        await click();
        assert.equal(ypy.cache.stats().entries, 0);
    });

    it('reads ypy-cache from a container with :inherited', async function () {
        mockResponse('GET', '/p', 'v1');
        createProcessedHTML('<div ypy-cache:inherited><button ypy-get="/p" ypy-target="#out">Go</button><div id="out"></div></div>');
        await click();
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('keeps one copy per Vary value of the request', async function () {
        mockResponse('GET', '/p', 'english', {headers: {Vary: 'X-Lang', ETag: '"en"'}});
        createProcessedHTML('<div><button id="en" ypy-get="/p" ypy-target="#out" ypy-cache ypy-headers=\'{"X-Lang":"en"}\'>en</button>' +
            '<button id="fr" ypy-get="/p" ypy-target="#out" ypy-cache ypy-headers=\'{"X-Lang":"fr"}\'>fr</button><div id="out"></div></div>');
        await click('#en');
        out().textContent = '';
        let held = mockSequentialResponses('GET', '/p', 'francais');
        find('#fr').click();
        await wait(20);
        assert.equal(out().textContent, '', 'a copy made for another language is not shown');
        await held.next();
        await wait(20);
        assert.equal(out().textContent, 'francais');
    });

    // -------------------------------------------------------------------------
    // Expiry, commanded by the server
    // -------------------------------------------------------------------------

    function fill(...paths) {
        paths.forEach(p => mockResponse('GET', '^' + p.replace(/\?/g, '\\?') + '$', 'page ' + p));
        createProcessedHTML('<div>' + paths.map((p, i) => `<button id="b${i}" ypy-get="${p}" ypy-target="#out" ypy-cache>${p}</button>`).join('') + '<div id="out"></div></div>');
    }

    it('drops the copies a YPY-Cache-Expire pattern names, and only those', async function () {
        fill('/items?page=1', '/items?page=2', '/other');
        await click('#b0');
        await click('#b1');
        await click('#b2');
        assert.equal(ypy.cache.stats().entries, 3);

        mockResponse('POST', '/items', 'ok', {headers: {'YPY-Cache-Expire': '/items*'}});
        createProcessedHTML('<div><button id="save" ypy-post="/items" ypy-target="#out">Save</button><div id="out"></div></div>');
        let expired = waitForEvent('ypy:cache:expire');
        await click('#save');
        let evt = await expired;
        assert.equal(evt.detail.removed, 2);
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('matches a path without * against the path of any query string', async function () {
        fill('/items?page=1', '/other');
        await click('#b0');
        await click('#b1');
        mockResponse('POST', '/items', 'ok', {headers: {'YPY-Cache-Expire': '/items'}});
        createProcessedHTML('<div><button id="save" ypy-post="/items" ypy-target="#out">Save</button><div id="out"></div></div>');
        await click('#save');
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('expires everything after a successful POST unless the response says false', async function () {
        fill('/items?page=1');
        await click('#b0');
        mockResponse('POST', '/items', 'ok');
        createProcessedHTML('<div><button id="save" ypy-post="/items" ypy-target="#out">Save</button><div id="out"></div></div>');
        await click('#save');
        assert.equal(ypy.cache.stats().entries, 0);

        fill('/items?page=1');
        await click('#b0');
        mockResponse('POST', '/items', 'ok', {headers: {'YPY-Cache-Expire': 'false'}});
        createProcessedHTML('<div><button id="save" ypy-post="/items" ypy-target="#out">Save</button><div id="out"></div></div>');
        await click('#save');
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('does not expire anything after a failed POST', async function () {
        fill('/items?page=1');
        await click('#b0');
        mockResponse('POST', '/items', 'bad', {status: 422});
        createProcessedHTML('<div><button id="save" ypy-post="/items" ypy-target="#out">Save</button><div id="out"></div></div>');
        await click('#save');
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('does not expire anything for a validation request (YPY-Validate)', async function () {
        fill('/items?page=1');
        await click('#b0');
        mockResponse('POST', '/check', '', {status: 204});
        createProcessedHTML('<div><button id="check" ypy-post="/check" ypy-headers=\'{"YPY-Validate":"email"}\'>Check</button></div>');
        await click('#check');
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('drops a copy by the JavaScript API', async function () {
        fill('/items?page=1', '/other');
        await click('#b0');
        await click('#b1');
        assert.equal(ypy.cache.expire('/items*, /nothing'), 1);
        assert.equal(ypy.cache.stats().entries, 1);
        ypy.cache.clear();
        assert.equal(ypy.cache.stats().entries, 0);
    });

    it('a copy dropped by the server is not shown the next time', async function () {
        fill('/items?page=1');
        await click('#b0');
        ypy.cache.expire('/items*');
        out().textContent = 'cleared';
        let held = mockSequentialResponses('GET', '/items', 'fresh page');
        find('#b0').click();
        await wait(20);
        assert.equal(out().textContent, 'cleared', 'nothing is shown while the server is asked');
        await held.next();
        await forRequest();
        assert.equal(out().textContent, 'fresh page');
    });

    // -------------------------------------------------------------------------
    // Freshness, memory
    // -------------------------------------------------------------------------

    it('serves a copy younger than max-age without asking the server', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {'Cache-Control': 'max-age=60'}});
        page();
        await click();
        await click();
        assert.equal(gets().length, 1);
        assert.equal(out().textContent, 'v1');
        assert.isFalse(out().classList.contains('ypy-revalidating'));
    });

    it('serves a copy younger than the fresh option without asking', async function () {
        mockResponse('GET', '/p', 'v1');
        page('ypy-cache="fresh:1m"');
        await click();
        await click();
        assert.equal(gets().length, 1);
    });

    it('asks again, with the validators, for a copy older than ttl, and shows the copy on a 304', async function () {
        ypy.config.cache = {ttl: '1ms'};
        mockResponse('GET', '/p', 'v1', {headers: {ETag: '"1"'}});
        page();
        await click();
        await wait(15);
        out().textContent = 'cleared';
        mockResponse('GET', '/p', new MockResponse('', {status: 304}));
        await click();
        assert.equal(lastFetch().request.headers['If-None-Match'], '"1"');
        assert.equal(out().textContent, 'v1');
        assert.equal(gets().length, 2, 'no second revalidation after a 304');
    });

    it('replaces an old copy when the server answers with new content', async function () {
        ypy.config.cache = {ttl: '1ms'};
        mockResponse('GET', '/p', 'v1', {headers: {ETag: '"1"'}});
        page();
        await click();
        await wait(15);
        mockResponse('GET', '/p', 'v2', {headers: {ETag: '"2"'}});
        await click();
        assert.equal(out().textContent, 'v2');
        assert.equal(ypy.cache.stats().entries, 1);
    });

    it('holds at most config.cache.size copies and drops the least recently used', async function () {
        ypy.config.cache = {size: 2};
        fill('/a', '/b', '/c');
        await click('#b0');
        await click('#b1');
        await click('#b0');   // a is used again: b is now the oldest
        await wait(10);
        await click('#b2');
        assert.equal(ypy.cache.stats().entries, 2);
        out().textContent = '';
        let held = mockSequentialResponses('GET', '^/b$', 'page /b');
        find('#b1').click();
        await wait(20);
        assert.equal(out().textContent, '', '/b was the least recently used: it is a miss');
        await held.next();
        await wait(20);
        out().textContent = '';
        find('#b0').click();
        await wait(20);
        assert.equal(out().textContent, 'page /a', '/a was kept: it is a hit');
    });

    it('holds at most config.cache.bytes characters', async function () {
        ypy.config.cache = {bytes: 100};
        mockResponse('GET', '/a', 'a'.repeat(40));
        mockResponse('GET', '/b', 'b'.repeat(40));
        mockResponse('GET', '/c', 'c'.repeat(40));
        createProcessedHTML('<div><button id="a" ypy-get="/a" ypy-target="#out" ypy-cache>a</button><button id="b" ypy-get="/b" ypy-target="#out" ypy-cache>b</button>' +
            '<button id="c" ypy-get="/c" ypy-target="#out" ypy-cache>c</button><div id="out"></div></div>');
        await click('#a');
        await click('#b');
        await click('#c');
        assert.equal(ypy.cache.stats().entries, 2);
        assert.isAtMost(ypy.cache.stats().chars, 100);
    });

    it('does not keep one response that is more than half the budget', async function () {
        ypy.config.cache = {bytes: 100};
        mockResponse('GET', '/p', 'x'.repeat(60));
        page();
        await click();
        assert.equal(ypy.cache.stats().entries, 0);
    });

    // -------------------------------------------------------------------------
    // Offline screens
    // -------------------------------------------------------------------------

    it('keeps a screen in sessionStorage with the offline option and shows it when the network fails', async function () {
        mockResponse('GET', '/p', 'critical screen');
        page('ypy-cache="offline"');
        await click();
        let keys = Object.keys(sessionStorage).filter(k => k.startsWith('ypy-cache:'));
        assert.equal(keys.length, 1);
        assert.include(JSON.parse(sessionStorage.getItem(keys[0])).text, 'critical screen');

        // not fresh enough to show and the server is out of reach
        ypy.config.cache = {ttl: '1ms'};
        await wait(15);
        out().textContent = 'cleared';
        mockFailure('GET', '/p');
        let hit = waitForEvent('ypy:cache:hit');
        await click();
        let evt = await hit;
        assert.isTrue(evt.detail.offline);
        assert.equal(out().textContent, 'critical screen');
    });

    it('does not show a copy for a failing network without the offline option', async function () {
        ypy.config.cache = {ttl: '1ms'};
        mockResponse('GET', '/p', 'screen');
        page();
        await click();
        await wait(15);
        out().textContent = 'cleared';
        mockFailure('GET', '/p');
        await click();
        assert.equal(out().textContent, 'cleared');
    });

    it('removes the stored screen when it is dropped', async function () {
        mockResponse('GET', '/p', 'critical screen');
        page('ypy-cache="offline"');
        await click();
        assert.equal(Object.keys(sessionStorage).filter(k => k.startsWith('ypy-cache:')).length, 1);
        ypy.cache.clear();
        assert.equal(Object.keys(sessionStorage).filter(k => k.startsWith('ypy-cache:')).length, 0);
    });

    // -------------------------------------------------------------------------
    // The copy is a response like any other
    // -------------------------------------------------------------------------

    it('replays the headers that steer the swap (YPY-Retarget) from the copy', async function () {
        mockResponse('GET', '/p', '<i>moved</i>', {headers: {'YPY-Retarget': '#other'}});
        createProcessedHTML('<div><button ypy-get="/p" ypy-target="#out" ypy-cache>Go</button><div id="out"></div><div id="other"></div></div>');
        await click();
        assert.equal(find('#other').textContent, 'moved');
        find('#other').textContent = '';
        mockSequentialResponses('GET', '/p', new MockResponse('', {status: 304}));
        await click();
        assert.equal(find('#other').textContent, 'moved');
        assert.equal(out().textContent, '');
    });

    it('does not replay one-off headers (YPY-Trigger) from the copy', async function () {
        mockResponse('GET', '/p', 'v1', {headers: {'YPY-Trigger': 'saved'}});
        let fired = 0;
        document.addEventListener('saved', () => fired++);
        page();
        await click();
        await click();
        await wait(20);
        assert.equal(fired, 1);
    });

    it('treats a hit as a success for the request events and the status', async function () {
        mockResponse('GET', '/p', 'v1');
        page();
        await click();
        let seen = [];
        for (let name of ['ypy:before:request', 'ypy:after:request', 'ypy:before:swap', 'ypy:after:swap'])
            document.addEventListener(name, () => seen.push(name), {once: true});
        await click();
        assert.deepEqual(seen, ['ypy:before:request', 'ypy:after:request', 'ypy:before:swap', 'ypy:after:swap']);
    });
});
