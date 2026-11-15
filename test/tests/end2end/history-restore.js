// SPDX-License-Identifier: MIT
//
// TASK-016: trustworthy history. Restoration asks the server again, with the headers of a
// real request (minus YPY-Request), a cache mode that revalidates, a safety net for fragments
// and the saved scroll position. ypy.ajax() merges options.request instead of replacing it.

const PAGE = '<html><head><title>t</title></head><body><main ypy-history-elt><p id="page">restored</p></main></body></html>';

describe('ypy.ajax() keeps the request it builds (TASK-016)', function() {

    describe('the request of ypy.ajax()', function() {
        beforeEach(function() { setupTest(this.currentTest); });
        afterEach(function() { cleanupTest(); });

        it('keeps mode, credentials, abort, validate and the core headers when request is passed', async function() {
            mockResponse('GET', '/ajax-merge', 'ok');
            await ypy.ajax('GET', '/ajax-merge', {target: playground(), request: {cache: 'no-store'}});

            let request = lastFetch().request;
            assert.equal(request.cache, 'no-store');
            assert.equal(request.mode, ypy.config.mode);
            assert.equal(request.credentials, 'same-origin');
            assert.isFunction(request.abort);
            assert.equal(request.validate, false);
            assert.equal(request.method, 'GET');
            assert.equal(request.action, '/ajax-merge');
            assert.equal(request.headers['Accept'], 'text/html');
            assert.equal(request.headers['YPY-Request'], 'true');
            assert.equal(request.headers['YPY-Current-URL'], location.href);
            assert.instanceOf(request.signal, AbortSignal);
        });

        it('merges request.headers with the core headers instead of replacing them', async function() {
            mockResponse('GET', '/ajax-merge', 'ok');
            await ypy.ajax('GET', '/ajax-merge', {
                target: playground(),
                headers: {'X-One': '1'},
                request: {headers: {'X-Two': '2'}}
            });

            let headers = lastFetch().request.headers;
            assert.equal(headers['X-One'], '1');
            assert.equal(headers['X-Two'], '2');
            assert.equal(headers['Accept'], 'text/html');
            assert.equal(headers['YPY-Request'], 'true');
        });

        it('removes a header set to null, from headers and from request.headers', async function() {
            mockResponse('GET', '/ajax-merge', 'ok');
            await ypy.ajax('GET', '/ajax-merge', {
                target: playground(),
                headers: {'YPY-Source': null},
                request: {headers: {'YPY-Request': null}}
            });

            let headers = lastFetch().request.headers;
            assert.isFalse('YPY-Request' in headers);
            assert.isFalse('YPY-Source' in headers);
            assert.equal(headers['Accept'], 'text/html');
        });

        it('does not let a request option change the action or the method', async function() {
            mockResponse('POST', '/ajax-real', 'ok');
            await ypy.ajax('POST', '/ajax-real', {target: playground(), request: {action: '/other', method: 'GET'}});

            assert.equal(lastFetch().request.action, '/ajax-real');
            assert.equal(lastFetch().request.method, 'POST');
        });

        it('aborts the fetch from a signal passed in request.signal, and from request.abort', async function() {
            let seen = [];
            let listener = (e) => seen.push(e.detail.ctx);
            document.addEventListener('ypy:before:request', listener);
            try {
                let outer = new AbortController();
                mockResponse('GET', '/ajax-signal', () => new Promise(() => {}));
                ypy.ajax('GET', '/ajax-signal', {target: playground(), request: {signal: outer.signal}});
                await ypy.timeout(20);
                let ctx = seen[0];
                assert.isFalse(ctx.request.signal.aborted);
                outer.abort('mine');
                assert.isTrue(ctx.request.signal.aborted);
                assert.equal(ctx.request.signal.reason, 'mine');

                mockResponse('GET', '/ajax-abort', () => new Promise(() => {}));
                ypy.ajax('GET', '/ajax-abort', {target: playground(), request: {signal: new AbortController().signal}});
                await ypy.timeout(20);
                let second = seen[1];
                second.request.abort('timeout');
                assert.isTrue(second.request.signal.aborted);
                assert.equal(second.request.signal.reason, 'timeout');
            } finally {
                document.removeEventListener('ypy:before:request', listener);
            }
        });

        it('a signal that is already aborted aborts the request at once', async function() {
            let outer = new AbortController();
            outer.abort();
            mockResponse('GET', '/ajax-aborted', 'ok');
            await ypy.ajax('GET', '/ajax-aborted', {target: playground(), request: {signal: outer.signal}});
            assert.equal(playground().textContent, '');
        });

        it('a plain ajax() call still sends the same headers as before', async function() {
            mockResponse('GET', '/ajax-plain', 'ok');
            await ypy.ajax('GET', '/ajax-plain', playground());
            let headers = lastFetch().request.headers;
            assert.equal(headers['YPY-Request'], 'true');
            assert.equal(headers['Accept'], 'text/html');
        });
    });
});

describe('history restore requests (TASK-016)', function() {

    // A restore swaps a whole page into the history element, so the playground holds one;
    // without it the response would replace the body and the playground with it.
    beforeEach(function() {
        playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
        ypy.process(playground());
    });

    afterEach(function() {
        delete ypy.config.historyRestore;
        cleanupTest();
    });

    describe('headers', function() {
        beforeEach(function() { setupTest(this.currentTest); });

        it('sends a complete request without YPY-Request', async function() {
            playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
            ypy.process(playground());
            mockResponse('GET', '/hr-headers', PAGE);
            await ypy.__restoreHistory({ypy: true}, '/hr-headers');

            let request = lastFetch().request;
            let headers = request.headers;
            assert.equal(headers['Accept'], 'text/html');
            assert.equal(headers['YPY-Current-URL'], location.href);
            assert.equal(headers['YPY-Source'], 'body');
            assert.equal(headers['YPY-History-Restore-Request'], 'true');
            assert.equal(headers['YPY-Request-Type'], 'full');
            assert.isFalse('YPY-Request' in headers);
            assert.equal(request.mode, ypy.config.mode);
            assert.equal(request.credentials, 'same-origin');
            assert.equal(request.method, 'GET');
            assert.equal(request.action, '/hr-headers');
            assert.equal(playground().textContent, 'restored');
        });
    });

    describe('fetch cache mode', function() {
        it('is "no-cache" by default', async function() {
            setupTest(null);
            mockResponse('GET', '/hr-cache', PAGE);
            await ypy.__restoreHistory({ypy: true}, '/hr-cache');
            assert.equal(lastFetch().request.cache, 'no-cache');
        });

        it('is configurable with config.historyRestore.cache', async function() {
            setupTest(null);
            ypy.config.historyRestore = {cache: 'reload'};
            mockResponse('GET', '/hr-cache', PAGE);
            await ypy.__restoreHistory({ypy: true}, '/hr-cache');
            assert.equal(lastFetch().request.cache, 'reload');
        });

        it('accepts any fetch cache mode, such as "default"', async function() {
            setupTest(null);
            ypy.config.historyRestore = {cache: 'default'};
            mockResponse('GET', '/hr-cache', PAGE);
            await ypy.__restoreHistory({ypy: true}, '/hr-cache');
            assert.equal(lastFetch().request.cache, 'default');
        });

    });

    describe('safety net for a response that is not a whole page', function() {
        let realLoc;
        let reloads;
        beforeEach(function() {
            realLoc = ypy._loc;
            reloads = 0;
            ypy._loc = {reload: () => reloads++};
        });
        afterEach(function() { ypy._loc = realLoc; });

        it('reloads when it gets a fragment, and does not swap it', async function() {
            setupTest(null);
            playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
            ypy.process(playground());
            mockResponse('GET', '/hr-frag', '<main ypy-history-elt><p>fragment</p></main>');
            let events = [];
            let listener = (e) => events.push(e.detail);
            document.addEventListener('ypy:history:restore:fragment', listener);
            try {
                await ypy.__restoreHistory({ypy: true}, '/hr-frag');
            } finally {
                document.removeEventListener('ypy:history:restore:fragment', listener);
            }
            assert.equal(reloads, 1);
            assert.equal(events.length, 1);
            assert.equal(events[0].ctx.request.action, '/hr-frag');
            assert.equal(playground().textContent, 'old');
        });

        it('swaps the fragment when config.historyRestore.fragment is false', async function() {
            setupTest(null);
            ypy.config.historyRestore = {fragment: false};
            playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
            ypy.process(playground());
            mockResponse('GET', '/hr-frag', '<main ypy-history-elt><p>fragment</p></main>');
            await ypy.__restoreHistory({ypy: true}, '/hr-frag');
            assert.equal(reloads, 0);
            assert.equal(playground().textContent, 'fragment');
        });

        it('does not reload for a whole page', async function() {
            setupTest(null);
            playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
            ypy.process(playground());
            mockResponse('GET', '/hr-page', PAGE);
            await ypy.__restoreHistory({ypy: true}, '/hr-page');
            assert.equal(reloads, 0);
            assert.equal(playground().textContent, 'restored');
        });

        it('a doctype or a body tag is enough to count as a whole page', async function() {
            setupTest(null);
            for (let [url, text] of [['/hr-doctype', '<!DOCTYPE html><main ypy-history-elt><p>x</p></main>'],
                                     ['/hr-body', '<BODY><main ypy-history-elt><p>x</p></main></BODY>']]) {
                playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
                ypy.process(playground());
                mockResponse('GET', url, text);
                await ypy.__restoreHistory({ypy: true}, url);
            }
            assert.equal(reloads, 0);
        });


        it('does not touch the swaps of other requests', async function() {
            setupTest(null);
            playground().innerHTML = '<main ypy-history-elt><p>old</p></main><div id="t">old</div>';
            ypy.process(playground());
            mockResponse('GET', '/other', '<p>fragment</p>');
            mockResponse('GET', '/hr-slow', () => new Promise(resolve =>
                setTimeout(() => resolve(new MockResponse(PAGE)), 60)));
            let restore = ypy.__restoreHistory({ypy: true}, '/hr-slow');
            await ypy.timeout(20);
            await ypy.ajax('GET', '/other', {source: '#t', target: '#t'});
            await restore;
            assert.equal(reloads, 0);
            assert.equal(document.querySelector('#t').textContent, 'fragment');
            assert.equal(document.querySelector('#page').textContent, 'restored');
        });

        it('removes its listener when the restore ends', async function() {
            setupTest(null);
            mockResponse('GET', '/hr-page', PAGE);
            let events = 0;
            let listener = () => events++;
            document.addEventListener('ypy:history:restore:fragment', listener);
            try {
                await ypy.__restoreHistory({ypy: true}, '/hr-page');
                playground().innerHTML = '<div id="t">old</div>';
                ypy.process(playground());
                mockResponse('GET', '/other', '<p>fragment</p>');
                await ypy.ajax('GET', '/other', '#t');
            } finally {
                document.removeEventListener('ypy:history:restore:fragment', listener);
            }
            assert.equal(events, 0);
            assert.equal(reloads, 0);
        });
    });

    describe('aborting', function() {
        beforeEach(function() { setupTest(this.currentTest); });

        it('a second restore aborts the signal of the first', async function() {
            let signals = [];
            let listener = (e) => signals.push(e.detail.ctx.request.signal);
            document.addEventListener('ypy:before:request', listener);
            try {
                mockResponse('GET', '/hr-first', () => new Promise(resolve =>
                    setTimeout(() => resolve(new MockResponse(PAGE)), 100)));
                mockResponse('GET', '/hr-second', PAGE);
                ypy.__restoreHistory({ypy: true}, '/hr-first');
                await ypy.timeout(30);
                assert.equal(signals.length, 1);
                assert.isFalse(signals[0].aborted);
                await ypy.__restoreHistory({ypy: true}, '/hr-second');
                await ypy.timeout(250);   // the second request waits for the aborted first one to end
                assert.isTrue(signals[0].aborted);
                assert.isFalse(signals[1].aborted);
            } finally {
                document.removeEventListener('ypy:before:request', listener);
            }
        });

        it('the default timeout aborts a restore (request.abort is kept)', async function() {
            let before = ypy.config.defaultTimeout;
            ypy.config.defaultTimeout = 30;
            let signals = [];
            let listener = (e) => signals.push(e.detail.ctx.request.signal);
            document.addEventListener('ypy:before:request', listener);
            try {
                mockResponse('GET', '/hr-hang', () => new Promise(() => {}));
                await ypy.__restoreHistory({ypy: true}, '/hr-hang');
                assert.isTrue(signals[0].aborted);
                assert.equal(signals[0].reason, 'timeout');
            } finally {
                ypy.config.defaultTimeout = before;
                document.removeEventListener('ypy:before:request', listener);
            }
        });
    });

    describe('history modes', function() {
        beforeEach(function() { setupTest(this.currentTest); });

        it('history="reload" reloads the page and sends no request', async function() {
            let realLoc = ypy._loc;
            let reloads = 0;
            let before = ypy.config.history;
            ypy._loc = {reload: () => reloads++};
            ypy.config.history = 'reload';
            try {
                await ypy.__restoreHistory({ypy: true}, '/hr-reload');
            } finally {
                ypy._loc = realLoc;
                ypy.config.history = before;
            }
            assert.equal(reloads, 1);
            assert.equal(fetchMock.getCalls().length, 0);
        });

        it('history=false leaves history alone: no push, no stamp, no scroll record', async function() {
            let before = ypy.config.history;
            ypy.config.history = false;
            let state = history.state;
            try {
                ypy.__pushUrlIntoHistory('/hr-off');
                ypy.__replaceUrlInHistory('/hr-off');
            } finally {
                ypy.config.history = before;
            }
            assert.equal(location.pathname === '/hr-off', false);
            assert.deepEqual(history.state, state);
        });

        it('an entry that is not ours is not restored', async function() {
            mockResponse('GET', '/hr-foreign', PAGE);
            await ypy.__restoreHistory({other: true}, '/hr-foreign');
            assert.equal(fetchMock.getCalls().length, 0);
        });
    });

    describe('scroll position', function() {
        let calls;
        let realPolicy;
        beforeEach(function() {
            calls = [];
            realPolicy = ypy.__applyScrollPolicy;
            ypy.__applyScrollPolicy = (ctx, policy) => calls.push({ctx, policy});
        });
        afterEach(function() {
            ypy.__applyScrollPolicy = realPolicy;
            window.scrollTo(0, 0);
        });

        it('a push records the scroll position of the entry it leaves, keeping other state', async function() {
            setupTest(null);
            playground().innerHTML = '<main ypy-history-elt><div style="height:3000px"></div></main>';
            mockResponse('GET', '/hr-scroll-a', PAGE);
            history.replaceState({ypy: true, keep: 'me'}, '', '/hr-scroll-a');
            window.scrollTo(0, 400);
            await ypy.timeout(20);
            ypy.__pushUrlIntoHistory('/hr-scroll-b');
            assert.deepEqual(history.state, {ypy: true});
            history.back();
            await ypy.timeout(150);
            assert.equal(location.pathname, '/hr-scroll-a');
            assert.equal(history.state.ypy, true);
            assert.equal(history.state.keep, 'me');
            assert.deepEqual(history.state.scroll, [0, 400]);
        });

        it('the restore calls __applyScrollPolicy(ctx, "restore") after the swap, with the position', async function() {
            setupTest(null);
            playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
            ypy.process(playground());
            mockResponse('GET', '/hr-scroll', PAGE);
            let order = [];
            let listener = () => order.push('after:swap');
            document.addEventListener('ypy:after:swap', listener);
            ypy.__applyScrollPolicy = (ctx, policy) => { order.push('policy'); calls.push({ctx, policy}); };
            try {
                await ypy.__restoreHistory({ypy: true, scroll: [10, 250]}, '/hr-scroll');
            } finally {
                document.removeEventListener('ypy:after:swap', listener);
            }
            assert.equal(calls.length, 1);
            assert.equal(calls[0].policy, 'restore');
            assert.deepEqual(calls[0].ctx.scrollPosition, [10, 250]);
            assert.equal(calls[0].ctx.scroll, 'restore');
            assert.deepEqual(order, ['after:swap', 'policy']);
            assert.equal(playground().textContent, 'restored');
        });

        it('an entry without a saved position asks for no scroll policy', async function() {
            setupTest(null);
            mockResponse('GET', '/hr-scroll', PAGE);
            await ypy.__restoreHistory({ypy: true}, '/hr-scroll');
            assert.equal(calls.length, 1);
            assert.isUndefined(calls[0].policy);
        });


        it('back from a pushed entry restores the page and hands the position to the policy', async function() {
            setupTest(null);
            playground().innerHTML = '<main ypy-history-elt><div style="height:3000px">page A</div></main>';
            ypy.process(playground());
            history.replaceState({ypy: true}, '', '/hr-trav-a');
            window.scrollTo(0, 350);
            await ypy.timeout(20);
            ypy.__pushUrlIntoHistory('/hr-trav-b');
            playground().innerHTML = '<main ypy-history-elt><p>page B</p></main>';
            mockResponse('GET', '/hr-trav-a',
                '<html><body><main ypy-history-elt><div style="height:3000px">page A restored</div></main></body></html>');

            history.back();
            await forRequest(600);

            assert.include(playground().textContent, 'page A restored');
            assert.equal(calls.length, 1);
            assert.equal(calls[0].policy, 'restore');
            assert.deepEqual(calls[0].ctx.scrollPosition, [0, 350]);
        });
    });
});
