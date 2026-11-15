// SPDX-License-Identifier: MIT
// TASK-065: upload progress. The transport swap to XMLHttpRequest goes to the test server itself:
// the file server answers a POST to a static file with the file, which is enough to see the
// events, the response and the abort. fetchMock is not involved in those requests, so a call that
// reaches it proves the request stayed on fetch.
describe('ypy-upload extension', function () {

    const OK = '/test/fixtures/upload/ok.html';
    let extBackup;

    before(async function () {
        extBackup = backupExtensions();
        clearExtensions();
        ypy.config.extensions = 'ypy-upload';
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-upload.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(function () {
        restoreExtensions(extBackup);
    });

    beforeEach(function () {
        setupTest(this.currentTest);
    });

    afterEach(function () {
        cleanupTest();
    });

    // A button that sends the file input with a multipart body.
    function page(attrs = 'ypy-upload-progress', action = OK, content = 'hello upload', name = 'a.txt') {
        createProcessedHTML(
            '<input type="file" name="doc" id="file">' +
            `<button id="go" ypy-post="${action}" ypy-include="#file" ypy-encoding="multipart/form-data" ` +
            `ypy-target="#out" ypy-swap="innerHTML" ${attrs}>Send</button>` +
            '<progress id="bar"></progress><div id="meter" role="progressbar"></div><div id="out"></div>');
        let dt = new DataTransfer();
        dt.items.add(new File([content], name, {type: 'text/plain'}));
        find('#file').files = dt.files;
    }

    let listeners = [];
    function listen(type, fn, opts) {
        document.addEventListener(type, fn, opts);
        listeners.push([type, fn]);
    }
    function events() {
        let list = [];
        listen('ypy:upload:progress', e => list.push(e.detail));
        return list;
    }
    afterEach(function () {
        for (let [type, fn] of listeners) document.removeEventListener(type, fn);
        listeners = [];
    });

    it('sends a file with the attribute through XMLHttpRequest and swaps the answer', async function () {
        page();
        let list = events();
        find('#go').click();
        await forRequest(3000);
        assert.equal(fetchMock.getCalls().length, 0, 'fetch was not used');
        assert.equal(find('#out').textContent.trim(), 'uploaded');
        assert.isAbove(list.length, 1);
        assert.equal(list[0].percent, 0);
        let last = list[list.length - 1];
        assert.equal(last.percent, 100);
        assert.equal(last.loaded, last.total);
        assert.isAbove(last.total, 0);
        assert.property(last, 'ctx');
    });

    it('fires the event on the source element and it bubbles', async function () {
        page();
        let sources = [];
        find('#go').addEventListener('ypy:upload:progress', e => sources.push(e.target));
        find('#go').click();
        await forRequest(3000);
        assert.isAbove(sources.length, 0);
        assert.equal(sources[0].id, 'go');
    });

    it('gives the core the same response as fetch: status, headers and text', async function () {
        page();
        let seen;
        listen('ypy:after:request', e => {
            let {response, text} = e.detail.ctx;
            seen = {status: response.status, type: response.headers.get('content-type'), text};
        }, {once: true});
        find('#go').click();
        await forRequest(3000);
        assert.equal(seen.status, 200);
        assert.include(seen.type, 'text/html');
        assert.include(seen.text, 'uploaded');
    });

    it('passes a status error through', async function () {
        page('ypy-upload-progress', '/test/fixtures/upload/missing.html');
        let status;
        listen('ypy:response:error', e => { status = e.detail.ctx.response.status }, {once: true});
        find('#go').click();
        await forRequest(3000);
        assert.equal(status, 404);
    });

    it('sends the request headers and leaves Content-Type to the browser', async function () {
        let sent = {}, original = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            sent[name.toLowerCase()] = value;
            return original.call(this, name, value);
        };
        try {
            page();
            find('#go').click();
            await forRequest(3000);
        } finally {
            XMLHttpRequest.prototype.setRequestHeader = original;
        }
        assert.equal(sent['ypy-request'], 'true');
        assert.equal(sent['accept'], 'text/html');
        assert.notProperty(sent, 'content-type');
    });

    it('credentials include sets withCredentials', async function () {
        let flag, send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) { flag = this.withCredentials; return send.call(this, body) };
        try {
            page();
            listen('ypy:config:request', e => { e.detail.ctx.request.credentials = 'include' }, {once: true});
            find('#go').click();
            await forRequest(3000);
        } finally {
            XMLHttpRequest.prototype.send = send;
        }
        assert.isTrue(flag);
    });

    it('updates the <progress> the attribute names', async function () {
        page('ypy-upload-progress="#bar"');
        find('#go').click();
        await forRequest(3000);
        let bar = find('#bar');
        assert.equal(bar.max, 100);
        assert.equal(bar.value, 100);
        assert.equal(bar.getAttribute('data-ypy-upload'), '100');
        assert.equal(bar.style.getPropertyValue('--ypy-upload'), '100%');
    });

    it('sets the variable and aria-valuenow on any element', async function () {
        page('ypy-upload-progress="#meter"');
        find('#go').click();
        await forRequest(3000);
        let meter = find('#meter');
        assert.equal(meter.style.getPropertyValue('--ypy-upload'), '100%');
        assert.equal(meter.getAttribute('aria-valuenow'), '100');
    });

    it('a selector that matches nothing is ignored', async function () {
        page('ypy-upload-progress="#nope"');
        let list = events();
        find('#go').click();
        await forRequest(3000);
        assert.equal(find('#out').textContent.trim(), 'uploaded');
        assert.isAbove(list.length, 0);
    });

    it('an invalid selector is ignored', async function () {
        page('ypy-upload-progress="[[["');
        find('#go').click();
        await forRequest(3000);
        assert.equal(find('#out').textContent.trim(), 'uploaded');
    });

    it('can be inherited from a container', async function () {
        createProcessedHTML(
            '<div ypy-upload-progress:inherited><input type="file" name="doc" id="file">' +
            `<button id="go" ypy-post="${OK}" ypy-include="#file" ypy-encoding="multipart/form-data" ypy-target="#out">Send</button></div><div id="out"></div>`);
        let dt = new DataTransfer();
        dt.items.add(new File(['x'], 'a.txt'));
        find('#file').files = dt.files;
        let list = events();
        find('#go').click();
        await forRequest(3000);
        assert.isAbove(list.length, 0);
        assert.equal(fetchMock.getCalls().length, 0);
    });

    describe('stays on fetch', function () {

        it('without the attribute', async function () {
            mockResponse('POST', OK, 'mocked');
            page('');
            let list = events();
            find('#go').click();
            await forRequest();
            assert.equal(fetchMock.getCalls().length, 1);
            assert.equal(find('#out').textContent, 'mocked');
            assert.equal(list.length, 0);
        });

        it('with ypy-upload-progress="false"', async function () {
            mockResponse('POST', OK, 'mocked');
            page('ypy-upload-progress="false"');
            find('#go').click();
            await forRequest();
            assert.equal(fetchMock.getCalls().length, 1);
        });

        it('when the file is empty', async function () {
            mockResponse('POST', OK, 'mocked');
            page('ypy-upload-progress', OK, '', 'empty.txt');
            let list = events();
            find('#go').click();
            await forRequest();
            assert.equal(fetchMock.getCalls().length, 1);
            assert.equal(list.length, 0);
        });

        it('when the body has no file', async function () {
            mockResponse('POST', '/plain', 'mocked');
            createProcessedHTML('<button id="go" ypy-post="/plain" ypy-vals=\'{"a":"1"}\' ypy-encoding="multipart/form-data" ypy-target="#out" ypy-upload-progress>Send</button><div id="out"></div>');
            find('#go').click();
            await forRequest();
            assert.equal(fetchMock.getCalls().length, 1);
        });

        it('when the body is URL-encoded', async function () {
            mockResponse('POST', '/plain', 'mocked');
            createProcessedHTML('<button id="go" ypy-post="/plain" ypy-vals=\'{"a":"1"}\' ypy-target="#out" ypy-upload-progress>Send</button><div id="out"></div>');
            find('#go').click();
            await forRequest();
            assert.equal(fetchMock.getCalls().length, 1);
        });
    });

    describe('abort and failure', function () {

        it('aborting the request aborts the transfer without an error', async function () {
            page();
            let errors = 0;
            listen('ypy:error', () => errors++);
            // the first event is the 0% one: it fires while the transfer is still open
            listen('ypy:upload:progress', e => e.detail.ctx.request.abort(), {once: true});
            find('#go').click();
            await forRequest(3000);
            assert.equal(errors, 0, 'an abort is silent');
            assert.equal(find('#out').textContent.trim(), '', 'nothing was swapped');
        });

        it('a request already aborted never reaches the server', async function () {
            page();
            let sent = 0, send = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function (b) { sent++; return send.call(this, b) };
            try {
                listen('ypy:before:request', e => e.detail.ctx.request.abort(), {once: true});
                find('#go').click();
                await forRequest(3000);
            } finally {
                XMLHttpRequest.prototype.send = send;
            }
            assert.equal(sent, 0);
        });

        it('the timeout aborts the transfer and is reported as a timeout', async function () {
            page();
            let kind;
            listen('ypy:error', e => { kind = e.detail.ctx.errorKind }, {once: true});
            listen('ypy:upload:progress', e => e.detail.ctx.request.abort('timeout'), {once: true});
            find('#go').click();
            await forRequest(3000);
            assert.equal(kind, 'timeout');
        });

        it('a connection that fails is a network error', async function () {
            page('ypy-upload-progress', 'http://127.0.0.1:1/upload');
            let kind;
            listen('ypy:error', e => { kind = e.detail.ctx.errorKind }, {once: true});
            find('#go').click();
            await forRequest(3000);
            assert.include(['network', 'offline'], kind);
        });
    });
});
