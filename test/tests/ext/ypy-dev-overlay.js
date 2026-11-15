// SPDX-License-Identifier: MIT
// TASK-067: ypy-dev: the error overlay, the warnings for a request cut by ypy-sync and the message
// for 401, 403 and 419.
describe('ypy-dev overlay and sync warnings', function () {

    let saved = {};

    before(async () => {
        if (!ypy.dev) {
            let script = document.createElement('script');
            script.src = '../src/ext/ypy-dev.js';
            await new Promise(resolve => {
                script.onload = resolve;
                document.head.appendChild(script);
            });
        }
        assert.isObject(ypy.dev, 'ypy-dev registered');
    });

    beforeEach(function () {
        setupTest(this.currentTest);
        ypy.dev.clear();
        ypy.dev.overlay.close();
        for (let level of ['info', 'warn', 'error']) {
            saved[level] = console[level];
            console[level] = () => {};
        }
    });

    afterEach(function () {
        for (let level in saved) console[level] = saved[level];
        ypy.dev.overlay.close();
        delete ypy.config.dev;
        cleanupTest();
    });

    const host = () => document.getElementById('ypy-dev-overlay');
    const panel = () => host()?.shadowRoot.querySelector('.box');
    const shown = () => !!panel() && !panel().hidden;
    const shownText = () => panel().textContent;
    const find1 = code => ypy.dev.messages.find(m => m.code === code);

    async function send(html, wait) {
        let elt = createProcessedHTML(html);
        elt.click();
        await forRequest(wait);
        return elt;
    }

    describe('overlay', function () {

        it('shows the status, the URL, the element and the start of the response', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/boom', 'Server blew up: <b>trace</b>', {status: 500, statusText: 'Internal Server Error'});
            await send('<button id="go" ypy-get="/boom" ypy-target="#out">Go</button><div id="out"></div>');
            assert.isTrue(shown());
            assert.include(shownText(), '500 Internal Server Error');
            assert.include(shownText(), 'GET /boom');
            assert.include(shownText(), '<button#go');
            assert.include(shownText(), 'Server blew up: <b>trace</b>', 'the body is text, never markup');
            assert.include(host().shadowRoot.querySelector('b').textContent, '500');
        });

        it('is a Shadow DOM on <html>, outside the body, with no inline style and no markup from the response', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/boom', '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>', {status: 500});
            await send('<button ypy-get="/boom" ypy-swap="none">Go</button>');
            assert.equal(host().parentElement, document.documentElement);
            assert.isFalse(document.body.contains(host()));
            assert.equal(host().getAttribute('ypy-ignore'), '');
            let all = [...host().shadowRoot.querySelectorAll('*')];
            assert.isAbove(all.length, 3);
            assert.isTrue(all.every(e => !e.hasAttribute('style') && !/^(img|script|style|iframe)$/.test(e.localName)));
            assert.isUndefined(window.__pwned);
            assert.lengthOf(host().shadowRoot.adoptedStyleSheets, 1);
            assert.include(shownText(), '<img src=x');
        });

        it('cuts a long response and keeps only its start', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/long', 'a'.repeat(5000), {status: 500});
            await send('<button ypy-get="/long">Go</button>');
            let pre = host().shadowRoot.querySelector('pre');
            assert.isBelow(pre.textContent.length, 700);
            assert.isAbove(pre.textContent.length, 500);
        });

        it('closes with Escape and with its button, and opens again on the next error', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/boom', 'x', {status: 500});
            await send('<button ypy-get="/boom">Go</button>');
            assert.isTrue(shown());
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
            assert.isFalse(shown());
            find('button').click();
            await forRequest();
            assert.isTrue(shown());
            host().shadowRoot.querySelector('button').click();
            assert.isFalse(shown());
        });

        it('shows the last error: one panel, not a pile', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/a', 'first', {status: 500});
            mockResponse('GET', '/b', 'second', {status: 404});
            let a = await send('<button ypy-get="/a">A</button>');
            a.remove();
            await send('<button ypy-get="/b">B</button>');
            assert.equal(document.querySelectorAll('#ypy-dev-overlay').length, 1);
            assert.include(shownText(), 'GET /b');
            assert.notInclude(shownText(), 'GET /a');
        });

        it('shows a request that never reached the server', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/down', () => Promise.reject(new TypeError('Failed to fetch')));
            await send('<button ypy-get="/down">Go</button>');
            assert.isTrue(shown());
            assert.include(shownText(), 'network');
            assert.include(shownText(), 'GET /down');
        });

        it('stays closed for a success and for a response that is not an error', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/ok', 'fine');
            await send('<button ypy-get="/ok" ypy-target="#out">Go</button><div id="out"></div>');
            assert.isFalse(shown());
        });

        it('overlay: false keeps it away, and the console message stays', async function () {
            ypy.config.dev = {overlay: false};
            mockResponse('GET', '/boom', 'x', {status: 500});
            await send('<button ypy-get="/boom">Go</button>');
            assert.isFalse(shown());
            assert.exists(find1('status-500'));
        });

        it('is on by default on a development host', async function () {
            assert.match(location.hostname, /^(localhost|127\.)/, 'the test server is a development host');
            mockResponse('GET', '/boom', 'x', {status: 500});
            await send('<button ypy-get="/boom">Go</button>');
            assert.isTrue(shown());
        });

        it('dev: false turns it off with the extension', async function () {
            ypy.config.dev = false;
            mockResponse('GET', '/boom', 'x', {status: 500});
            await send('<button ypy-get="/boom">Go</button>');
            assert.isFalse(shown());
        });

        it('has a role for assistive technology and a real button to close it', async function () {
            ypy.config.dev = {overlay: true};
            mockResponse('GET', '/boom', 'x', {status: 500});
            await send('<button ypy-get="/boom">Go</button>');
            assert.equal(panel().getAttribute('role'), 'alert');
            assert.equal(host().shadowRoot.querySelector('button').type, 'button');
        });
    });

    describe('401, 403 and 419', function () {

        for (let [status, word] of [[401, 'session'], [403, 'CSRF'], [419, 'CSRF']]) {
            it(`${status} points at ${word}`, async function () {
                ypy.config.dev = {overlay: true};
                mockResponse('POST', '/save', 'denied', {status});
                await send('<button ypy-post="/save" ypy-swap="none">Save</button>');
                let m = find1('status-' + status);
                assert.exists(m);
                assert.isTrue(m.auth);
                assert.include(m.text, `answered ${status}: `);
                assert.include(m.text, word);
                assert.include(m.text, 'Response starts: "denied"');
                assert.include(shownText(), word);
            });
        }

        it('a 404 keeps its own hint', async function () {
            mockResponse('GET', '/gone', 'no', {status: 404});
            await send('<button ypy-get="/gone">Go</button>');
            let m = find1('status-404');
            assert.isFalse(m.auth);
            assert.include(m.text, 'Hint: check the URL and the route');
        });
    });

    describe('ypy-sync', function () {

        it('warns when a POST in flight is aborted by replace', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            let btn = createProcessedHTML('<button ypy-post="/save" ypy-sync="replace" ypy-swap="none">Save</button>');
            btn.click();
            await ypy.timeout(30);
            btn.click();
            await ypy.timeout(30);
            let m = find1('sync-aborted');
            assert.exists(m, 'the first POST was aborted');
            assert.equal(m.level, 'warn');
            assert.equal(m.method, 'POST');
            assert.equal(m.strategy, 'replace');
            assert.include(m.text, 'POST /save');
            assert.include(m.text, '<button');
            assert.include(m.text, 'aborted in flight');
            assert.include(m.text, 'ypy-sync replace');
            assert.equal(m.elt, btn);
            await hold.next();
            await hold.next();
        });

        for (let method of ['put', 'patch', 'delete']) {
            it(`warns for ${method.toUpperCase()}`, async function () {
                let hold = mockSequentialResponses(method.toUpperCase(), '/item', 'done');
                let btn = createProcessedHTML(`<button ypy-${method}="/item" ypy-sync="replace" ypy-swap="none">Go</button>`);
                btn.click();
                await ypy.timeout(30);
                btn.click();
                await ypy.timeout(30);
                assert.exists(find1('sync-aborted'));
                await hold.next();
                await hold.next();
            });
        }

        it('does not warn when a GET is aborted: a read is safe to repeat', async function () {
            let hold = mockSequentialResponses('GET', '/read', 'data');
            let btn = createProcessedHTML('<button ypy-get="/read" ypy-sync="replace" ypy-swap="none">Read</button>');
            btn.click();
            await ypy.timeout(30);
            btn.click();
            await ypy.timeout(30);
            assert.isUndefined(find1('sync-aborted'));
            assert.isUndefined(find1('sync-dropped'));
            await hold.next();
            await hold.next();
        });

        it('warns when a POST is dropped by drop and never sent', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            let btn = createProcessedHTML('<button ypy-post="/save" ypy-sync="drop" ypy-swap="none">Save</button>');
            btn.click();
            await ypy.timeout(30);
            btn.click();
            await ypy.timeout(30);
            let m = find1('sync-dropped');
            assert.exists(m);
            assert.equal(m.strategy, 'drop');
            assert.include(m.text, 'dropped, never sent');
            assert.equal(fetchMock.getCalls().length, 1);
            await hold.next();
        });

        it('does not warn for a request that waits in the queue (the default)', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            let btn = createProcessedHTML('<button ypy-post="/save" ypy-swap="none">Save</button>');
            btn.click();
            await ypy.timeout(30);
            btn.click();
            await ypy.timeout(30);
            assert.isUndefined(find1('sync-aborted'));
            assert.isUndefined(find1('sync-dropped'));
            await hold.next();
            await hold.next();
        });

        it('does not warn for a timeout or an abort the page asked for', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            let btn = createProcessedHTML('<button ypy-post="/save" ypy-swap="none">Save</button>');
            btn.click();
            await ypy.timeout(30);
            ypy.trigger(btn, 'ypy:abort');
            await ypy.timeout(30);
            assert.isUndefined(find1('sync-aborted'));
            await hold.next().catch(() => {});
        });

        it('is quiet with dev: false', async function () {
            ypy.config.dev = false;
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            let btn = createProcessedHTML('<button ypy-post="/save" ypy-sync="replace" ypy-swap="none">Save</button>');
            btn.click();
            await ypy.timeout(30);
            btn.click();
            await ypy.timeout(30);
            assert.lengthOf(ypy.dev.messages, 0);
            await hold.next();
            await hold.next();
        });
    });
});
