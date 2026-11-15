// SPDX-License-Identifier: MIT
describe('ypy-dedupe extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-dedupe.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
    });

    afterEach(() => {
        cleanupTest();
    });

    const calls = () => fetchMock.getCalls();
    const settle = () => ypy.timeout(60);
    const page = (extra = '') => createProcessedHTML(
        '<button id="b1" ypy-get="/data" ypy-target="#o1">1</button><button id="b2" ypy-get="/data" ypy-target="#o1">2</button>' +
        '<div id="o1"></div><div id="o2"></div>' + extra);

    it('sends two identical GETs that are in flight together as one request', async function () {
        let held = mockSequentialResponses('GET', '/data', '<i id="got">data</i>');
        page();
        find('#b1').click();
        find('#b2').click();
        await ypy.timeout(30);
        calls().length.should.equal(1);
        await held.next();
        await settle();
        calls().length.should.equal(1);
        find('#o1').innerHTML.should.equal('<i id="got">data</i>');
    });

    it('gives every request its own copy of the answer, swapped into its own target', async function () {
        let held = mockSequentialResponses('GET', '/data', '<b>data</b>');
        ypy.config.dedupe = {ignore: ['YPY-Source', 'YPY-Target']};
        try {
            createProcessedHTML('<button id="b1" ypy-get="/data" ypy-target="#o1">1</button><button id="b2" ypy-get="/data" ypy-target="#o2">2</button><div id="o1"></div><div id="o2"></div>');
            find('#b1').click();
            find('#b2').click();
            await ypy.timeout(30);
            await held.next();
            await settle();
        } finally {
            delete ypy.config.dedupe;
        }
        calls().length.should.equal(1);
        find('#o1').innerHTML.should.equal('<b>data</b>');
        find('#o2').innerHTML.should.equal('<b>data</b>');
    });

    it('fires ypy:dedupe:joined on the request that joined', async function () {
        let held = mockSequentialResponses('GET', '/data', 'x');
        page();
        let joined = [];
        let spy = evt => joined.push([evt.target.id, evt.detail.url, evt.detail.waiters, !!evt.detail.ctx]);
        document.addEventListener('ypy:dedupe:joined', spy);
        try {
            find('#b1').click();
            find('#b2').click();
            await ypy.timeout(30);
            await held.next();
            await settle();
        } finally {
            document.removeEventListener('ypy:dedupe:joined', spy);
        }
        joined.should.deep.equal([['b2', '/data', 2, true]]);
    });

    it('does not share a request that differs in a relevant header, such as the target', async function () {
        let held = mockSequentialResponses('GET', '/data', 'x');
        createProcessedHTML('<button id="b1" ypy-get="/data" ypy-target="#o1">1</button><button id="b2" ypy-get="/data" ypy-target="#o2">2</button><div id="o1"></div><div id="o2"></div>');
        find('#b1').click();
        find('#b2').click();
        await ypy.timeout(30);
        calls().length.should.equal(2);
        await held.next();
        await held.next();
        await settle();
    });

    it('does not share a request with another URL, query or header', async function () {
        let held = mockSequentialResponses('GET', '/data', 'x');
        createProcessedHTML('<button id="b1" ypy-get="/data?a=1" ypy-target="#o1">1</button><button id="b2" ypy-get="/data?a=2" ypy-target="#o1">2</button>' +
            '<button id="b3" ypy-get="/data?a=1" ypy-target="#o1" ypy-headers=\'{"X-Mode":"b"}\'>3</button><div id="o1"></div>');
        for (let id of ['#b1', '#b2', '#b3']) find(id).click();
        await ypy.timeout(30);
        calls().length.should.equal(3);
        for (let i = 0; i < 3; i++) await held.next();
        await settle();
    });

    it('shares requests that differ only in a header the config says to ignore', async function () {
        let held = mockSequentialResponses('GET', '/data', 'x');
        ypy.config.dedupe = {ignore: ['yPy-source', 'x-trace']};
        try {
            createProcessedHTML('<button id="b1" ypy-get="/data" ypy-target="#o1" ypy-headers=\'{"X-Trace":"1"}\'>1</button><button id="b2" ypy-get="/data" ypy-target="#o1" ypy-headers=\'{"X-Trace":"2"}\'>2</button><div id="o1"></div>');
            find('#b1').click();
            find('#b2').click();
            await ypy.timeout(30);
            calls().length.should.equal(1);
            await held.next();
            await settle();
        } finally {
            delete ypy.config.dedupe;
        }
    });

    it('does not share once the first request has its answer', async function () {
        mockResponse('GET', '/data', 'x');
        page();
        find('#b1').click();
        await forRequest();
        find('#b2').click();
        await forRequest();
        calls().length.should.equal(2);
    });

    it('never shares a POST', async function () {
        let held = mockSequentialResponses('POST', '/data', 'x');
        createProcessedHTML('<button id="b1" ypy-post="/data" ypy-target="#o1">1</button><button id="b2" ypy-post="/data" ypy-target="#o1">2</button><div id="o1"></div>');
        find('#b1').click();
        find('#b2').click();
        await ypy.timeout(30);
        calls().length.should.equal(2);
        await held.next();
        await held.next();
        await settle();
    });

    it('opts out with ypy-dedupe="false", also from a container with ypy-dedupe:inherited', async function () {
        let held = mockSequentialResponses('GET', '/data', 'x');
        createProcessedHTML('<div ypy-dedupe:inherited="false"><button id="b1" ypy-get="/data" ypy-target="#o1">1</button></div><button id="b2" ypy-get="/data" ypy-target="#o1">2</button><div id="o1"></div>');
        find('#b1').click();
        find('#b2').click();
        await ypy.timeout(30);
        // the one that opted out is not wrapped, so both go out
        calls().length.should.equal(2);
        await held.next();
        await held.next();
        await settle();
    });

    it('shares a failure: every request gets the error', async function () {
        mockFailure('GET', '/data');
        page();
        let errors = [];
        let spy = evt => errors.push(evt.target.id);
        document.addEventListener('ypy:error', spy);
        try {
            find('#b1').click();
            find('#b2').click();
            await settle();
        } finally {
            document.removeEventListener('ypy:error', spy);
        }
        calls().length.should.equal(1);
        errors.sort().should.deep.equal(['b1', 'b2']);
    });

    it('shares an error status: both requests see it', async function () {
        mockResponse('GET', '/data', 'no', {status: 500});
        page();
        let seen = [];
        let spy = evt => seen.push([evt.target.id, evt.detail.ctx.response.status]);
        document.addEventListener('ypy:response:error', spy);
        try {
            find('#b1').click();
            find('#b2').click();
            await settle();
        } finally {
            document.removeEventListener('ypy:response:error', spy);
        }
        calls().length.should.equal(1);
        seen.sort().should.deep.equal([['b1', 500], ['b2', 500]]);
    });

    describe('abort', function () {
        const go = (source, signal) => ypy.ajax('GET', '/data', {source, target: '#o1', request: {signal}});

        it('aborting one request does not cancel what the other waits for', async function () {
            let held = mockSequentialResponses('GET', '/data', '<i id="late">late</i>');
            page();
            let ac = new AbortController();
            go('#b1', ac.signal);
            go('#b2');
            await ypy.timeout(30);
            ac.abort();
            await ypy.timeout(10);
            await held.next();
            await settle();
            calls().length.should.equal(1);
            find('#late').textContent.should.equal('late');
        });

        it('a request that joins and is aborted leaves the first one alone', async function () {
            let held = mockSequentialResponses('GET', '/data', '<i id="late">late</i>');
            page();
            let ac = new AbortController();
            go('#b1');
            go('#b2', ac.signal);
            await ypy.timeout(30);
            ac.abort();
            await held.next();
            await settle();
            find('#late').textContent.should.equal('late');
        });

        it('aborts the shared request when every request that waits for it was aborted', async function () {
            let held = mockSequentialResponses('GET', '/data', '<i id="late">late</i>');
            page();
            let a = new AbortController(), b = new AbortController();
            go('#b1', a.signal);
            go('#b2', b.signal);
            await ypy.timeout(30);
            a.abort();
            b.abort();
            await ypy.timeout(10);
            calls()[0].request.signal.aborted.should.equal(true);
            // a new request after that is a new request on the network
            await held.next();
            mockResponse('GET', '/data', '<i id="fresh">fresh</i>');
            go('#b1');
            await settle();
            calls().length.should.equal(2);
            find('#fresh').textContent.should.equal('fresh');
        });
    });
});
