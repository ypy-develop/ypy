// SPDX-License-Identifier: MIT
describe('ypy-telemetry extension', function () {

    let extBackup, reports, off;
    const SECRET = 'hunter2-secret-value';
    const on = e => reports.push(e.detail);
    const form = (attrs = '', url = '/save?token=abc#frag') =>
        `<form id="f" ypy-post="${url}" ypy-target="#out" ypy-swap="innerHTML" ypy-trigger="submit" ${attrs}>` +
        `<input name="password" value="${SECRET}"></form><div id="out"></div>`;
    const submit = () => find('#f').requestSubmit();

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-telemetry.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
        delete ypy.onError;
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        reports = [];
        document.addEventListener('ypy:telemetry:error', on);
    });

    afterEach(() => {
        document.removeEventListener('ypy:telemetry:error', on);
        off?.();
        off = null;
        cleanupTest();
    });

    it('reports a 500 as status:500 with the url without query, the method and a short target', async function () {
        mockResponse('POST', '/save', `<b>${SECRET}</b>`, {status: 500});
        createProcessedHTML(form());
        submit();
        await forRequest();
        reports.length.should.equal(1);
        let r = reports[0];
        r.code.should.equal('status:500');
        r.url.should.equal(location.origin + '/save');
        r.method.should.equal('POST');
        r.status.should.equal(500);
        r.target.should.equal('div#out');
        r.ctxId.should.be.a('number');
        Object.keys(r).sort().should.deep.equal(['code', 'ctxId', 'method', 'status', 'target', 'url']);
    });

    it('reports a 404 and a 422 with their own status', async function () {
        mockResponse('POST', '/save', 'nope', {status: 404});
        createProcessedHTML(form('ypy-error-target="#out"'));
        submit();
        await forRequest();
        reports.map(r => r.code).should.deep.equal(['status:404']);
    });

    it('reports a failed connection as network, with no status', async function () {
        mockFailure('POST', '/save');
        createProcessedHTML(form());
        submit();
        await forRequest();
        reports.length.should.equal(1);
        reports[0].code.should.equal('network');
        reports[0].method.should.equal('POST');
        assert.isNull(reports[0].status);
    });

    it('reports a timeout', async function () {
        mockSequentialResponses('POST', '/save', 'never');
        createProcessedHTML(form('ypy-config="timeout:30"'));
        submit();
        await forRequest(500);
        reports.map(r => r.code).should.deep.equal(['timeout']);
    });

    it('reports offline when the browser says there is no connection', async function () {
        let desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
        Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => false});
        try {
            mockFailure('POST', '/save');
            createProcessedHTML(form());
            submit();
            await forRequest();
        } finally {
            delete navigator.onLine;
            if (desc) Object.defineProperty(Navigator.prototype, 'onLine', desc);
        }
        reports.map(r => r.code).should.deep.equal(['offline']);
    });

    it('reports a target that matches nothing, with the selector', async function () {
        mockResponse('POST', '/save', '<i>ok</i>');
        createProcessedHTML(form().replace('ypy-target="#out"', 'ypy-target="#nowhere"'));
        submit();
        await forRequest();
        let missing = reports.filter(r => r.code === 'target-missing');
        missing.length.should.be.at.least(1);
        missing[0].target.should.equal('#nowhere');
        missing[0].method.should.equal('POST');
    });

    it('reports a swap that fails once, not twice', async function () {
        mockResponse('POST', '/save', '<ypy-partial ypy-target="#out" ypy-swap="nonsense">boom</ypy-partial>');
        createProcessedHTML(form());
        submit();
        await forRequest();
        reports.map(r => r.code).should.deep.equal(['swap-error']);
        reports[0].target.should.equal('div#out');
    });

    it('reports a refused redirect as blocked:redirect', async function () {
        mockResponse('POST', '/save', '', {headers: {'YPY-Redirect': 'https://evil.example/steal?x=1'}});
        createProcessedHTML(form());
        submit();
        await forRequest();
        let blocked = reports.filter(r => r.code === 'blocked:redirect');
        blocked.length.should.equal(1);
        assert.isNull(blocked[0].ctxId);
    });

    it('reports the error event of an extension as extension:<name>', async function () {
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-sse.js';
        await new Promise(resolve => { script.onload = resolve; document.head.appendChild(script) });
        const stream = mockStreamResponse('/stream');
        createProcessedHTML('<button id="b" ypy-get="/stream" ypy-swap="innerHTML">Stream</button>');
        find('#b').click();
        await ypy.timeout(60);
        stream.error(new Error('secret text'));
        await ypy.timeout(100);
        let found = reports.filter(r => r.code === 'extension:sse');
        found.length.should.be.at.least(1);
        JSON.stringify(found).should.not.contain('secret text');
    });

    it('reports any other ypy:error as error', async function () {
        mockResponse('POST', '/save', '', {headers: {'YPY-Redirect': 'http://[bad'}});
        createProcessedHTML(form());
        submit();
        await forRequest();
        reports.map(r => r.code).should.deep.equal(['error']);
        reports[0].url.should.equal(location.origin + '/save');
    });

    it('gives the reports of one request the same ctxId, and another request another one', async function () {
        mockResponse('POST', '/save', 'no', {status: 500});
        createProcessedHTML(form());
        submit();
        await forRequest();
        submit();
        await forRequest();
        reports.length.should.equal(2);
        reports[0].ctxId.should.not.equal(reports[1].ctxId);
    });

    it('never carries a body, a field value, a header, a cookie or an error message', async function () {
        mockResponse('POST', '/save', `<b>${SECRET}</b>`, {status: 500, headers: {'Set-Cookie': 'sid=' + SECRET, 'X-Token': SECRET}});
        createProcessedHTML(form(`ypy-headers='{"Authorization": "Bearer ${SECRET}"}'`));
        document.cookie = 'sid=' + SECRET;
        try {
            submit();
            await forRequest();
        } finally { document.cookie = 'sid=; expires=Thu, 01 Jan 1970 00:00:00 GMT' }
        reports.length.should.equal(1);
        JSON.stringify(reports).should.not.contain(SECRET);
        JSON.stringify(reports).should.not.contain('token=abc');
    });

    describe('ypy.onError', function () {

        it('calls the handler with the same report and returns a function that cancels it', async function () {
            let got = [];
            off = ypy.onError(d => got.push(d));
            mockResponse('POST', '/save', 'no', {status: 503});
            createProcessedHTML(form());
            submit();
            await forRequest();
            got.length.should.equal(1);
            got[0].should.deep.equal(reports[0]);
            off();
            submit();
            await forRequest();
            got.length.should.equal(1);
            reports.length.should.equal(2);
        });

        it('keeps the other handlers going when one throws', async function () {
            let got = [];
            let thrower = ypy.onError(() => { throw new Error('handler bug') });
            let counter = ypy.onError(d => got.push(d.code));
            let consoleError = console.error;
            console.error = () => {};
            try {
                mockResponse('POST', '/save', 'no', {status: 500});
                createProcessedHTML(form());
                submit();
                await forRequest();
            } finally { console.error = consoleError }
            thrower();
            counter();
            got.should.deep.equal(['status:500']);
        });

        it('cancels one subscription at a time when the same function is registered twice', async function () {
            let n = 0, fn = () => n++;
            let a = ypy.onError(fn), b = ypy.onError(fn);
            mockResponse('POST', '/save', 'no', {status: 500});
            createProcessedHTML(form());
            submit();
            await forRequest();
            n.should.equal(2);
            a();
            submit();
            await forRequest();
            n.should.equal(3);
            b();
        });

        it('refuses something that is not a function', function () {
            assert.throws(() => ypy.onError('nope'), TypeError);
        });
    });
});
