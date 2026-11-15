// SPDX-License-Identifier: MIT
describe('ypy-test extension', function () {

    let extBackup;
    const busy = () => document.documentElement.getAttribute('data-ypy-busy');
    const btn = (attrs = '', url = '/page') => `<button id="b" ypy-get="${url}" ypy-target="#out" ypy-swap="innerHTML" ${attrs}>go</button><div id="out"></div>`;
    const load = src => new Promise(resolve => {
        let script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        document.head.appendChild(script);
    });

    before(async () => {
        extBackup = backupExtensions();
        await load('../src/ext/ypy-sse.js');
        await load('../src/ext/ypy-test.js');
    });

    after(() => {
        restoreExtensions(extBackup);
        delete ypy.idle;
    });

    beforeEach(() => {
        setupTest(this.currentTest);
    });

    afterEach(() => {
        delete ypy.config.test;
        cleanupTest();
    });

    it('resolves at once when the page has nothing pending, and leaves no data-ypy-busy', async function () {
        createProcessedHTML(btn());
        assert.isNull(busy());
        let before = Date.now();
        await ypy.idle();
        assert.isBelow(Date.now() - before, 300);
        assert.isNull(busy());
    });

    it('waits for a request in flight and marks <html> while it runs', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Done');
        createProcessedHTML(btn());
        find('#b').click();
        busy().should.contain('request');
        let state = 'waiting';
        let idle = ypy.idle().then(() => { state = 'idle' });
        await ypy.timeout(120);
        state.should.equal('waiting');
        await held.next();
        await idle;
        find('#out').textContent.should.equal('Done');
        assert.isNull(busy());
    });

    it('resolves only after the swap: the new content is there when it resolves', async function () {
        mockResponse('GET', '/page', '<i id="new">fresh</i>');
        createProcessedHTML(btn());
        find('#b').click();
        await ypy.idle();
        assert.isNotNull(find('#new'));
    });

    it('waits for every one of several requests', async function () {
        let held = mockSequentialResponses('GET', '/page', 'x');
        createProcessedHTML(btn() + btn('', '/page').replace('id="b"', 'id="c"').replace('id="out"', 'id="out2"').replace('#out', '#out2'));
        find('#b').click();
        find('#c').click();
        let state = 'waiting';
        let idle = ypy.idle().then(() => { state = 'idle' });
        await held.next();
        await ypy.timeout(120);
        state.should.equal('waiting');
        await held.next();
        await idle;
        assert.isNull(busy());
    });

    it('counts a request that waits in an ypy-sync queue', async function () {
        let held = mockSequentialResponses('GET', '/page', 'x');
        createProcessedHTML(btn('ypy-sync="this:queue all"'));
        find('#b').click();
        find('#b').click();
        let state = 'waiting';
        let idle = ypy.idle().then(() => { state = 'idle' });
        await held.next();
        await ypy.timeout(120);
        state.should.equal('waiting');
        busy().should.match(/request|queued/);
        await held.next();
        await idle;
        assert.isNull(busy());
    });

    it('waits for the request that the swapped content starts (a load trigger)', async function () {
        mockResponse('GET', '/page', '<div id="inner" ypy-get="/second" ypy-trigger="load" ypy-swap="innerHTML">first</div>');
        let held = mockSequentialResponses('GET', '/second', 'second');
        createProcessedHTML(btn());
        find('#b').click();
        let state = 'waiting';
        let idle = ypy.idle().then(() => { state = 'idle' });
        await ypy.timeout(200);
        state.should.equal('waiting');
        await held.next();
        await idle;
        find('#inner').textContent.should.equal('second');
    });

    it('is idle after an error response and after a network failure', async function () {
        mockResponse('GET', '/boom', 'no', {status: 500});
        mockFailure('GET', '/down');
        createProcessedHTML(btn('', '/boom') + btn('', '/down').replace('id="b"', 'id="c"').replace('id="out"', 'id="out2"').replace('#out', '#out2'));
        find('#b').click();
        find('#c').click();
        await ypy.idle();
        assert.isNull(busy());
    });

    it('is idle once the source element was replaced by the swap', async function () {
        mockResponse('GET', '/page', '<p id="after">replaced</p>');
        createProcessedHTML('<button id="b" ypy-get="/page" ypy-swap="outerHTML">go</button>');
        find('#b').click();
        await ypy.idle();
        assert.isNotNull(find('#after'));
        assert.isNull(busy());
    });

    it('rejects after the timeout and names what is still pending', async function () {
        let held = mockSequentialResponses('GET', '/page', 'late');
        createProcessedHTML(btn());
        find('#b').click();
        let error;
        try { await ypy.idle({timeout: 80}) } catch (e) { error = e }
        assert.instanceOf(error, Error);
        error.message.should.contain('request');
        error.message.should.contain('80');
        await held.next();
        await ypy.idle();
    });

    it('takes the timeout and the quiet period from ypy.config.test', async function () {
        let held = mockSequentialResponses('GET', '/page', 'late');
        ypy.config.test = {timeout: '60ms', quiet: 0};
        createProcessedHTML(btn());
        find('#b').click();
        let error;
        try { await ypy.idle() } catch (e) { error = e }
        error.message.should.contain('60');
        await held.next();
        await ypy.idle();
    });

    it('does not count a request that became an event stream', async function () {
        const stream = mockStreamResponse('/stream');
        createProcessedHTML('<button id="b" ypy-get="/stream" ypy-swap="innerHTML">Stream</button>');
        find('#b').click();
        await ypy.idle({timeout: 1000});
        assert.isNull(busy());
        stream.close();
        await forRequest(500);
    });

    it('fires ypy:test:idle on the document with the time waited', async function () {
        mockResponse('GET', '/page', 'x');
        createProcessedHTML(btn());
        let seen = [];
        let off = e => seen.push(e.detail);
        document.addEventListener('ypy:test:idle', off);
        try {
            find('#b').click();
            await ypy.idle();
        } finally { document.removeEventListener('ypy:test:idle', off) }
        seen.length.should.equal(1);
        seen[0].waited.should.be.a('number');
    });

    it('keeps the page busy while new content settles, and waits for it', async function () {
        mockResponse('GET', '/page', '<p id="new" class="b">New</p>');
        createProcessedHTML('<button id="b" ypy-get="/page" ypy-target="#out" ypy-swap="innerHTML settle:200ms">go</button><div id="out"><p id="new" class="a">Old</p></div>');
        let seen = new Set();
        let watch = setInterval(() => (busy() || '').split(' ').forEach(k => seen.add(k)), 10);
        let before = Date.now();
        find('#b').click();
        await ypy.idle();
        clearInterval(watch);
        assert.isAtLeast(Date.now() - before, 190);
        assert.isTrue(seen.has('settle'), 'settle was reported, saw ' + [...seen]);
        assert.isNull(busy());
    });
});
