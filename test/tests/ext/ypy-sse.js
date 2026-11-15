// SPDX-License-Identifier: MIT
describe('ypy-sse SSE extension', function() {

    // These tests run author code (ypy-on, js: values, [filter]), which config.callbacks must allow
    beforeEach(function() { ypy.config.callbacks = 'all' })
    afterEach(function() { delete ypy.config.callbacks })

    let extBackup;
    let docListeners = [];

    function onDoc(event, handler) {
        document.addEventListener(event, handler);
        docListeners.push({event, handler});
    }

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();

        ypy.config.extensions = 'ypy-sse';
        ypy.__approvedExt = 'ypy-sse';

        let script = document.createElement('script');
        script.src = '../src/ext/ypy-sse.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });

        if (SOURCE_BUILD && !ypy.__registeredExt.has('ypy-sse')) {
            throw new Error('SSE extension failed to register - check approval');
        }
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    afterEach(function() {
        // Clean up document-level listeners added during tests
        for (let l of docListeners) {
            document.removeEventListener(l.event, l.handler);
        }
        docListeners = [];

        // Restore document.hidden if overridden
        Object.defineProperty(document, 'hidden', {value: false, configurable: true});

        cleanupTest()
    })

    it('basic one-off SSE stream works', async function() {
        const stream = mockStreamResponse('/stream');
        createProcessedHTML('<button ypy-get="/stream" ypy-swap="innerHTML">Stream</button>');

        find('button').click();
        await ypy.timeout(1);

        stream.send('message 1');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'message 1');

        stream.send('message 2');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'message 2');

        stream.close();
    });

    it('continuous stream reconnects with exponential backoff', async function() {
        const stream = mockStreamResponse('/reconnect');
        createProcessedHTML('<button ypy-get="/reconnect" ypy-config="sse.reconnect:true sse.reconnectDelay:50ms sse.reconnectMaxAttempts:3 sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        let reconnectAttempts = 0;

        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) {
                reconnectAttempts++;
            }
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('first');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'first');

        stream.close();
        await waitForEvent('ypy:sse:after:connection');

        assert.equal(reconnectAttempts, 1, 'Should attempt to reconnect');

        stream.send('second');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'second');

        stream.close();
    });

    it('Last-Event-ID header sent on reconnect', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/with-id');
        createProcessedHTML('<button ypy-get="/with-id" ypy-config="sse.reconnect:true sse.reconnectDelay:50ms sse.reconnectMaxAttempts:2" ypy-swap="innerHTML">Connect</button>');

        let lastEventIdSent = null;
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) {
                lastEventIdSent = e.detail.connection.lastEventId;
            }
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('first message', null, 'msg-123');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'first message');

        await new Promise(r => setTimeout(r, 50));

        stream.close();
        await waitForEvent('ypy:sse:after:connection', 5000);

        assert.equal(lastEventIdSent, 'msg-123', 'Should send last event ID on reconnect');

        const lastCall = lastFetch();
        assert.equal(lastCall.request.headers['Last-Event-ID'], 'msg-123', 'Last-Event-ID header should be set');

        stream.close();
    });

    it('events without id inherit the buffered event ID', async function() {
        const stream = mockStreamResponse('/inherited-id');
        createProcessedHTML('<button ypy-get="/inherited-id" ypy-swap="innerHTML">Connect</button>');

        let ids = [];
        onDoc('ypy:sse:before:message', (e) => {
            ids.push(e.detail.message.id);
        });

        find('button').click();
        await ypy.timeout(1);

        stream.sendRaw('id: 42\ndata: first\n\n');
        await waitForEvent('ypy:sse:after:message');
        stream.sendRaw('data: second\n\n');
        await waitForEvent('ypy:sse:after:message');

        assert.deepEqual(ids, ['42', '42']);
        stream.close();
    });

    it('empty id clears the connection cursor', async function() {
        const stream = mockStreamResponse('/clear-id');
        createProcessedHTML('<button ypy-get="/clear-id" ypy-swap="innerHTML">Connect</button>');

        let lastMessageId = null;
        onDoc('ypy:sse:before:message', (e) => {
            lastMessageId = e.detail.message.id;
        });

        find('button').click();
        await ypy.timeout(1);

        stream.sendRaw('id: 42\ndata: first\n\n');
        await waitForEvent('ypy:sse:after:message');
        stream.sendRaw('id:\ndata: reset\n\n');
        await waitForEvent('ypy:sse:after:message');

        assert.equal(lastMessageId, '');
        assert.equal(find('button')._ypy.sse.lastEventId, '');
        stream.close();
    });

    it('clearing the event ID removes a stale reconnect header', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/clear-reconnect-id');
        createProcessedHTML('<button ypy-get="/clear-reconnect-id" ypy-config="sse.reconnect:true sse.reconnectDelay:10ms sse.reconnectMaxAttempts:2 sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        find('button').click();
        await ypy.timeout(1);

        stream.sendRaw('id: 42\ndata: first\n\n');
        await waitForEvent('ypy:sse:after:message');
        stream.close();
        await waitForEvent('ypy:sse:after:connection', 1000);

        let reconnectCall = fetchMock.getLastCall();
        assert.equal(reconnectCall.request.headers['Last-Event-ID'], '42');

        stream.sendRaw('id:\ndata: reset\n\n');
        await waitForEvent('ypy:sse:after:message');
        stream.close();
        await waitForEvent('ypy:sse:after:connection', 1000);

        reconnectCall = fetchMock.getLastCall();
        assert.isFalse(
            Object.keys(reconnectCall.request.headers).some(name => name.toLowerCase() === 'last-event-id'),
            'Cleared Last-Event-ID header should not be sent'
        );
    });

    it('id-only blocks update the reconnect cursor without message events', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/id-only');
        createProcessedHTML('<button ypy-get="/id-only" ypy-config="sse.reconnect:true sse.reconnectDelay:10ms sse.reconnectMaxAttempts:1 sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        let beforeMessages = 0;
        let afterMessages = 0;
        onDoc('ypy:sse:before:message', () => { beforeMessages++; });
        onDoc('ypy:sse:after:message', () => { afterMessages++; });

        find('button').click();
        await ypy.timeout(1);

        stream.sendRaw('id: cursor-7\n\n');
        await ypy.timeout(20);

        assert.equal(find('button')._ypy.sse.lastEventId, 'cursor-7');
        assert.equal(beforeMessages, 0);
        assert.equal(afterMessages, 0);
        assertTextContentIs('button', 'Connect');

        stream.close();
        await waitForEvent('ypy:sse:after:connection', 1000);

        assert.equal(fetchMock.getLastCall().request.headers['Last-Event-ID'], 'cursor-7');
    });

    it('empty id-only blocks clear the reconnect cursor', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/empty-id-only');
        createProcessedHTML('<button ypy-get="/empty-id-only" ypy-config="sse.reconnect:true sse.reconnectDelay:10ms sse.reconnectMaxAttempts:1 sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        find('button').click();
        await ypy.timeout(1);

        stream.sendRaw('id: 42\ndata: first\n\n');
        await waitForEvent('ypy:sse:after:message');

        let beforeMessages = 0;
        let afterMessages = 0;
        onDoc('ypy:sse:before:message', () => { beforeMessages++; });
        onDoc('ypy:sse:after:message', () => { afterMessages++; });

        stream.sendRaw('id:\n\n');
        await ypy.timeout(20);

        assert.equal(find('button')._ypy.sse.lastEventId, '');
        assert.equal(beforeMessages, 0);
        assert.equal(afterMessages, 0);

        stream.close();
        await waitForEvent('ypy:sse:after:connection', 1000);

        assert.isFalse(
            Object.keys(fetchMock.getLastCall().request.headers).some(name => name.toLowerCase() === 'last-event-id'),
            'Empty ID-only block should clear Last-Event-ID header'
        );
    });

    it('event IDs containing NULL remain ignored', async function() {
        const stream = mockStreamResponse('/null-id');
        createProcessedHTML('<button ypy-get="/null-id" ypy-swap="innerHTML">Connect</button>');

        let ids = [];
        onDoc('ypy:sse:before:message', (e) => {
            ids.push(e.detail.message.id);
        });

        find('button').click();
        await ypy.timeout(1);

        stream.sendRaw('id: 42\ndata: first\n\n');
        await waitForEvent('ypy:sse:after:message');
        stream.sendRaw('id: bad\0id\ndata: second\n\n');
        await waitForEvent('ypy:sse:after:message');

        assert.deepEqual(ids, ['42', '42']);
        assert.equal(find('button')._ypy.sse.lastEventId, '42');
        stream.close();
    });

    it('events fire correctly and can cancel operations', async function() {
        const stream = mockStreamResponse('/cancelable');
        createProcessedHTML('<button ypy-get="/cancelable" ypy-swap="innerHTML">Go</button>');

        let beforeConnectFired = false;
        let beforeMessageFired = false;
        let afterMessageFired = false;
        let connection;
        let messageConnections = [];

        onDoc('ypy:sse:before:connection', event => {
            beforeConnectFired = true;
            connection = event.detail.connection;
        });
        onDoc('ypy:sse:before:message', event => {
            beforeMessageFired = true;
            messageConnections.push(event.detail.connection);
        });
        onDoc('ypy:sse:after:message', event => {
            afterMessageFired = true;
            messageConnections.push(event.detail.connection);
        });

        find('button').click();
        await ypy.timeout(1);

        assert.isTrue(beforeConnectFired, 'sse:before:connection should fire');

        stream.send('test');
        await waitForEvent('ypy:sse:after:message');

        assert.isTrue(beforeMessageFired, 'sse:before:message should fire');
        assert.isTrue(afterMessageFired, 'sse:after:message should fire');
        assert.isTrue(messageConnections.every(value => value === connection));
        assertTextContentIs('button', 'test');

        stream.close();
    });

    it('element removal stops streaming and fires close event', async function() {
        const stream = mockStreamResponse('/removable');
        createProcessedHTML('<div id="container"><button ypy-get="/removable" ypy-config="sse.reconnect:true sse.reconnectDelay:50ms" ypy-swap="innerHTML">Connect</button></div>');

        find('button').click();
        await ypy.timeout(1);

        stream.send('message 1');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'message 1');

        let closeFired = false;
        let closeReason = null;
        onDoc('ypy:sse:close', (e) => {
            closeFired = true;
            closeReason = e.detail.reason;
        });

        // Remove the element
        find('#container').innerHTML = '';
        await ypy.timeout(50);

        // Verify no further messages are processed
        let messageAfterRemoval = false;
        onDoc('ypy:sse:after:message', () => { messageAfterRemoval = true; });
        stream.send('message 2');
        await ypy.timeout(50);

        assert.isFalse(messageAfterRemoval, 'Should not process messages after element removal');
        assert.isTrue(closeFired, 'ypy:sse:close should fire');
        assert.equal(closeReason, 'removed', 'Close reason should be "removed"');

        stream.close();
    });

    it('HTTP vs SSE differentiation', async function() {
        mockResponse('GET', '/regular', 'HTTP response');
        createProcessedHTML('<button id="http" ypy-get="/regular" ypy-swap="innerHTML">HTTP</button>');

        find('#http').click()
        await forRequest();
        assertTextContentIs('#http', 'HTTP response');

        const stream = mockStreamResponse('/sse');
        createProcessedHTML('<button id="sse" ypy-get="/sse" ypy-swap="innerHTML">SSE</button>');

        find('#sse').click();
        await ypy.timeout(1);

        stream.send('SSE response');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('#sse', 'SSE response');
        stream.close();
    });

    it('SSE message parsing with id field', async function() {
        const stream = mockStreamResponse('/parse');
        createProcessedHTML('<div id="target"></div><button ypy-get="/parse" ypy-target="#target">Go</button>');

        find('button').click();
        await ypy.timeout(1);

        // Send HTML with id field (no event field, so it swaps)
        stream.send('<div id="msg1">message with id</div>', null, '42');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('#msg1', 'message with id');
        stream.close();
    });

    it('reconnectMaxAttempts configuration works', async function() {
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/max-attempts', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            throw new Error('Network error');
        });

        createProcessedHTML('<button ypy-get="/max-attempts" ypy-config="sse.reconnect:true sse.reconnectDelay:20ms sse.reconnectMaxAttempts:2" ypy-swap="innerHTML">Connect</button>');

        let reconnectAttempts = 0;
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectAttempts++;
        });

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');

        await new Promise(r => setTimeout(r, 150));

        assert.equal(reconnectAttempts, 2, 'Should attempt reconnecting 2 times');
        assert.equal(fetchCount, 3, 'Should fetch 3 times total (initial + 2 retries)');
    });

    it('reconnectMaxDelay configuration caps backoff', async function() {
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/max-delay', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            throw new Error('Network error');
        });

        createProcessedHTML('<button ypy-get="/max-delay" ypy-config="sse.reconnect:true sse.reconnectDelay:20ms sse.reconnectMaxDelay:60ms sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        let reconnectAttempts = [];
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectAttempts.push(e.detail.connection.attempt);
        });

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');

        await new Promise(r => setTimeout(r, 350));

        assert.isAtLeast(reconnectAttempts.length, 4, 'Should have at least 4 reconnect attempts');
    });

    it('reconnectJitter randomizes reconnect delays', async function() {
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/jitter-test', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            throw new Error('Network error');
        });

        // Use a jitter of 0.5 (50%) and a reconnectDelay of 100ms
        createProcessedHTML('<button ypy-get="/jitter-test" ypy-config="sse.reconnect:true, sse.reconnectDelay:100ms, sse.reconnectJitter:0.5, sse.reconnectMaxAttempts: 5" ypy-swap="innerHTML">Connect</button>');

        let reconnectAttempts = [];
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectAttempts.push(e.detail.connection.attempt);
        });

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');

        // Wait for multiple reconnects
        await new Promise(r => setTimeout(r, 800));

        // Verify we have multiple reconnects (jitter affects timing but reconnects still happen)
        assert.isAtLeast(reconnectAttempts.length, 3, 'Should have at least 3 reconnect attempts');
    });

    it('connectTimeout triggers reconnect when server hangs on reconnect fetch', async function() {
        this.timeout(3000);
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/ct-hang', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            // Hang forever — simulates a server that accepts the TCP connection but never responds
            return new Promise(() => {});
        });

        createProcessedHTML('<button ypy-get="/ct-hang" ypy-config="sse.reconnect:true sse.connectTimeout:100ms sse.reconnectDelay:10ms sse.reconnectMaxAttempts:2 sse.reconnectJitter:0" ypy-swap="innerHTML">Go</button>');

        let reconnectAttempts = 0;
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectAttempts++;
        });

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');

        // Wait long enough for the timeout to fire and at least one reconnect attempt to start
        await new Promise(r => setTimeout(r, 400));

        assert.isAtLeast(fetchCount, 2, 'Should have re-fetched after connectTimeout');
        assert.isAtLeast(reconnectAttempts, 1, 'Should have attempted reconnect after connectTimeout');
    });

    it('connectTimeout:0 disables the timeout', async function() {
        this.timeout(3000);
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/ct-zero', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            // Hang forever
            return new Promise(() => {});
        });

        createProcessedHTML('<button ypy-get="/ct-zero" ypy-config="sse.reconnect:true sse.connectTimeout:0 sse.reconnectDelay:10ms sse.reconnectMaxAttempts:3 sse.reconnectJitter:0" ypy-swap="innerHTML">Go</button>');

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');

        // Wait long enough that a 100ms default timeout would have fired multiple times
        await new Promise(r => setTimeout(r, 400));

        // With timeout disabled, the hanging reconnect fetch should not have been retried
        assert.equal(fetchCount, 2, 'Should only have the initial fetch plus one hanging reconnect — no further retries');
    });

    it('explicit abort (not timeout) stops reconnection', async function() {
        this.timeout(3000);
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/ct-abort', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            // Hang so we can abort it manually
            return new Promise(() => {});
        });

        createProcessedHTML('<button ypy-get="/ct-abort" ypy-config="sse.reconnect:true sse.connectTimeout:500ms sse.reconnectDelay:10ms sse.reconnectMaxAttempts:3 sse.reconnectJitter:0" ypy-swap="innerHTML">Go</button>');

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');
        // Wait for the reconnect fetch to start
        await new Promise(r => setTimeout(r, 50));

        // Explicitly abort — this is a user/cleanup abort, not a timeout
        find('button')._ypy.sse.abortController.abort();
        await new Promise(r => setTimeout(r, 200));

        assert.equal(fetchCount, 2, 'Explicit abort should stop reconnection, not trigger another retry');
    });

    it('reconnectJitter of 0 disables jitter', async function() {
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/no-jitter', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            throw new Error('Network error');
        });

        createProcessedHTML('<button ypy-get="/no-jitter" ypy-config="sse.reconnect:true, sse.reconnectDelay:100ms, sse.reconnectJitter:0, sse.reconnectMaxAttempts:3" ypy-swap="innerHTML">Connect</button>');

        let reconnectAttempts = [];
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectAttempts.push(e.detail.connection.attempt);
        });

        find('button').click();
        await waitForEvent('ypy:sse:before:connection');

        await new Promise(r => setTimeout(r, 450));

        assert.isAtLeast(reconnectAttempts.length, 2, 'Should have at least 2 reconnect attempts');
    });

    it('pauseOnBackground stops reconnection while tab is hidden', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/pause-test');
        createProcessedHTML('<button ypy-get="/pause-test" ypy-config="sse.reconnect:true sse.pauseOnBackground:true sse.reconnectDelay:50ms sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        let connectionAttempts = 0;
        onDoc('ypy:sse:before:connection', () => { connectionAttempts++; });

        find('button').click();
        await waitForEvent('ypy:sse:after:connection');
        assert.equal(connectionAttempts, 1, 'Initial connection');

        stream.send('hello');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'hello');

        // Simulate tab going hidden
        Object.defineProperty(document, 'hidden', {value: true, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));

        // Wait long enough that reconnection would have happened if not paused
        await new Promise(r => setTimeout(r, 300));

        assert.equal(connectionAttempts, 1, 'Should NOT reconnect while tab is hidden');

        // Simulate tab becoming visible again
        Object.defineProperty(document, 'hidden', {value: false, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));

        await waitForEvent('ypy:sse:after:connection', 3000);
        assert.equal(connectionAttempts, 2, 'Should reconnect when tab becomes visible');

        stream.send('world');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'world');

        stream.close();
    });

    it('pauseOnBackground does not inflate attempt counter across pause cycles', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/pause-counter');
        createProcessedHTML('<button ypy-get="/pause-counter" ypy-config="sse.reconnect:true sse.pauseOnBackground:true sse.reconnectDelay:50ms sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

        let attempts = [];
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) {
                attempts.push(e.detail.connection.attempt);
            }
        });

        find('button').click();
        await waitForEvent('ypy:sse:after:connection');

        stream.send('msg1');
        await waitForEvent('ypy:sse:after:message');

        // First pause/resume cycle
        Object.defineProperty(document, 'hidden', {value: true, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r => setTimeout(r, 50));
        Object.defineProperty(document, 'hidden', {value: false, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        await waitForEvent('ypy:sse:after:connection', 3000);

        stream.send('msg2');
        await waitForEvent('ypy:sse:after:message');

        // Second pause/resume cycle
        Object.defineProperty(document, 'hidden', {value: true, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r => setTimeout(r, 50));
        Object.defineProperty(document, 'hidden', {value: false, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        await waitForEvent('ypy:sse:after:connection', 3000);

        // Both attempts should be 1 (not escalating across pause cycles)
        assert.equal(attempts.length, 2, 'Should have 2 reconnections');
        assert.equal(attempts[0], 1, 'First attempt should be 1');
        assert.equal(attempts[1], 1, 'Second attempt should also be 1 (not escalating)');

        stream.close();
    });

    it('cancelling an already-released reader does not produce an unhandled rejection', async function() {
        // Hand-rolled reader so the test can fire visibilitychange (→ cancel()) off the same
        // promise the extension's `await reader.read()` is waiting on, landing it deterministically
        // in the same tick the stream closes on.
        let resolveRead;
        let released = false;
        const pendingRead = new Promise(resolve => { resolveRead = resolve; });
        const reader = {
            read: () => pendingRead,
            releaseLock() { released = true; },
            cancel() {
                if (released) return Promise.reject(new TypeError('Cannot cancel a stream using a released reader'));
                released = true;
                return Promise.resolve();
            }
        };

        fetchMock.mockResponse('GET', '/reader-cancel-race', () => {
            const response = new MockResponse({getReader: () => reader}, {
                headers: {'Content-Type': 'text/event-stream'}
            });
            response.body = {getReader: () => reader};
            return response;
        });

        createProcessedHTML('<button ypy-get="/reader-cancel-race" ypy-config="sse.pauseOnBackground:true" ypy-swap="innerHTML">Connect</button>');

        let rejections = [];
        let onRejection = e => rejections.push(e.reason);
        window.addEventListener('unhandledrejection', onRejection);

        find('button').click();
        await waitForEvent('ypy:after:sse:connection');

        pendingRead.then(() => {
            Object.defineProperty(document, 'hidden', {value: true, configurable: true});
            document.dispatchEvent(new Event('visibilitychange'));
        });
        resolveRead({done: true, value: undefined});

        await ypy.timeout(20);
        window.removeEventListener('unhandledrejection', onRejection);

        assert.deepEqual(rejections, [], 'Attempting to cancel an already-released reader must not produce an unhandled rejection');
    });

    it('custom events trigger on element and bubble', async function() {
        const stream = mockStreamResponse('/custom-events');
        createProcessedHTML('<button ypy-get="/custom-events" ypy-swap="innerHTML">Connect</button>');

        let customEventFired = false;
        let customEventData = null;
        let customEventId = null;

        // Listen for custom event on the button
        find('button').addEventListener('update', (e) => {
            customEventFired = true;
            customEventData = e.detail.data;
            customEventId = e.detail.id;
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('some data', 'update', 'event-123');
        await ypy.timeout(1);

        assert.isTrue(customEventFired, 'Custom event should be triggered');
        assert.equal(customEventData, 'some data', 'Event should include data');
        assert.equal(customEventId, 'event-123', 'Event should include id');

        stream.close();
    });

    it('custom events bubble to document', async function() {
        const stream = mockStreamResponse('/bubble-test');
        createProcessedHTML('<button ypy-get="/bubble-test" ypy-swap="innerHTML">Connect</button>');

        let documentEventFired = false;
        let eventTarget = null;

        // Listen for custom event on document
        onDoc('notification', (e) => {
            documentEventFired = true;
            eventTarget = e.target;
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('notification message', 'notification');
        await ypy.timeout(1);

        assert.isTrue(documentEventFired, 'Event should bubble to document');
        assert.equal(eventTarget, find('button'), 'Event target should be the button');

        stream.close();
    });

    it('custom events work with ypy-on attribute', async function() {
        const stream = mockStreamResponse('/ypy-on-test');
        createProcessedHTML('<button ypy-get="/ypy-on-test" ypy-swap="innerHTML" ypy-on:progress="this.setAttribute(\'data-progress\', event.detail.data)">Connect</button>');

        find('button').click();
        await ypy.timeout(1);

        stream.send('50%', 'progress');
        await waitForEvent('ypy:sse:after:message');

        assert.equal(find('button').getAttribute('data-progress'), '50%', 'ypy-on should handle custom event');

        stream.send('100%', 'progress');
        await waitForEvent('ypy:sse:after:message');

        assert.equal(find('button').getAttribute('data-progress'), '100%', 'ypy-on should handle multiple custom events');

        stream.close();
    });

    it('custom events and HTML swaps can coexist', async function() {
        const stream = mockStreamResponse('/mixed-test');
        createProcessedHTML('<button ypy-get="/mixed-test" ypy-swap="innerHTML">Connect</button>');

        let statusEventFired = false;

        find('button').addEventListener('status', (e) => {
            statusEventFired = true;
        });

        find('button').click();
        await ypy.timeout(1);

        // Send a custom event (should NOT swap)
        stream.send('processing', 'status');
        await waitForEvent('ypy:sse:after:message');
        assert.isTrue(statusEventFired, 'Custom event should fire');
        assertTextContentIs('button', 'Connect', 'Content should NOT be swapped for custom events');

        // Send HTML content (no event field, so it swaps normally)
        stream.send('<div>Result</div>');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'Result');

        stream.close();
    });

    it('custom events do not swap content', async function() {
        const stream = mockStreamResponse('/event-only');
        createProcessedHTML('<button ypy-get="/event-only" ypy-swap="innerHTML">Connect</button>');

        let notifyFired = false;
        let notifyData = null;

        find('button').addEventListener('notify', (e) => {
            notifyFired = true;
            notifyData = e.detail.data;
        });

        find('button').click();
        await ypy.timeout(1);

        // Send event - should trigger event but NOT swap
        stream.send('notification data', 'notify');
        await waitForEvent('ypy:sse:after:message');

        assert.isTrue(notifyFired, 'Custom event should fire');
        assert.equal(notifyData, 'notification data', 'Event should have data');
        assertTextContentIs('button', 'Connect', 'Content should NOT be swapped');

        stream.close();
    });

    it('only trims single space after colon', async function() {
        const stream = mockStreamResponse('/sse-whitespace');
        createProcessedHTML('<button id="ws-btn" ypy-get="/sse-whitespace" ypy-swap="innerHTML">Whitespace</button>');

        find('#ws-btn').click();
        await ypy.timeout(1);

        stream.send('   \ttext-with-two-leading-spaces');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('#ws-btn', '   \ttext-with-two-leading-spaces');

        stream.send('NoTrim');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('#ws-btn', 'NoTrim');

        stream.close();
    });

    it('ypy-sse:connect auto-connects on load and streams', async function() {
        const stream = mockStreamResponse('/connect-test');
        createProcessedHTML('<div ypy-sse:connect="/connect-test" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        stream.send('connected!');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'connected!');

        stream.close();
    });

    it('ypy-sse:connect enables reconnect by default', async function() {
        const stream = mockStreamResponse('/connect-reconnect');
        createProcessedHTML('<div ypy-sse:connect="/connect-reconnect" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        stream.send('first');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'first');

        let reconnectFired = false;
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectFired = true;
        });

        stream.close();
        await waitForEvent('ypy:sse:after:connection');

        assert.isTrue(reconnectFired, 'connect should reconnect by default');
    });

    it('ypy-sse:connect with ypy-trigger="load delay:100ms" delays connection', async function() {
        const stream = mockStreamResponse('/delayed');
        createProcessedHTML('<div ypy-sse:connect="/delayed" ypy-trigger="load delay:100ms" ypy-swap="innerHTML">Waiting</div>');

        // Should NOT have connected yet
        await ypy.timeout(10);
        stream.send('too early');
        await ypy.timeout(10);
        assertTextContentIs('div', 'Waiting');

        // Wait for delay to elapse + connection
        await ypy.timeout(150);

        stream.send('delayed!');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'delayed!');

        stream.close();
    });

    it('ypy-sse:connect with ypy-trigger="click" connects on click', async function() {
        const stream = mockStreamResponse('/on-click');
        createProcessedHTML('<button ypy-sse:connect="/on-click" ypy-trigger="click" ypy-swap="innerHTML">Click me</button>');

        // Should NOT have connected yet
        await ypy.timeout(10);
        assertTextContentIs('button', 'Click me');

        find('button').click();
        await ypy.timeout(1);

        stream.send('clicked!');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'clicked!');

        stream.close();
    });

    it('ypy-sse:connect with ypy-trigger="click once" only connects once', async function() {
        let fetchCount = 0;
        fetchMock.mockResponse('GET', '/once-test', () => {
            fetchCount++;
            let ctrl;
            const body = new ReadableStream({ start(c) { ctrl = c; } });
            const response = new MockResponse(body, {
                headers: { 'Content-Type': 'text/event-stream' }
            });
            response.body = body;
            return response;
        });

        createProcessedHTML('<button ypy-sse:connect="/once-test" ypy-trigger="click once" ypy-swap="innerHTML">Click</button>');

        find('button').click();
        await ypy.timeout(10);
        assert.equal(fetchCount, 1, 'First click should connect');

        find('button').click();
        await ypy.timeout(10);
        assert.equal(fetchCount, 1, 'Second click should be ignored (once modifier)');
    });

    it('ypy-sse:connect with ypy-target swaps into correct target', async function() {
        const stream = mockStreamResponse('/targeted');
        createProcessedHTML('<div><button ypy-sse:connect="/targeted" ypy-target="#output">Go</button><span id="output">empty</span></div>');

        await ypy.timeout(1);

        stream.send('targeted!');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('#output', 'targeted!');

        stream.close();
    });

    it('ypy-sse:connect respects ypy-select', async function() {
        const stream = mockStreamResponse('/select-test');
        createProcessedHTML('<div ypy-sse:connect="/select-test" ypy-select=".message">Waiting</div>');

        await ypy.timeout(1);

        stream.send('<p>Ignored</p><p class="message">Selected</p>');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('div', 'Selected');
        assert.isUndefined(find('div > p:not(.message)'));

        stream.close();
    });

    it('ypy-sse:connect respects ypy-select-oob', async function() {
        const stream = mockStreamResponse('/select-oob-test');
        createProcessedHTML('<div id="stream" ypy-sse:connect="/select-oob-test" ypy-select-oob="#status">Waiting</div><div id="status">Offline</div>');

        await ypy.timeout(1);

        stream.send('<p>Message</p><div id="status">Online</div>');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('#stream', 'Message');
        assertTextContentIs('#status', 'Online');

        stream.close();
    });

    it('ypy-sse:connect respects ypy-swap style', async function() {
        const stream = mockStreamResponse('/append-test');
        createProcessedHTML('<div ypy-sse:connect="/append-test" ypy-swap="beforeend">start</div>');

        await ypy.timeout(1);

        stream.send('<span>1</span>');
        await waitForEvent('ypy:sse:after:message');
        stream.send('<span>2</span>');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('div', 'start12');

        stream.close();
    });

    it('named SSE event on parent does NOT trigger child ypy-trigger without from:', async function() {
        const stream = mockStreamResponse('/bubble-down');
        mockResponse('GET', '/child-refresh', 'Refreshed!');
        createProcessedHTML('<div ypy-sse:connect="/bubble-down"><div id="child" ypy-get="/child-refresh" ypy-trigger="update" ypy-swap="innerHTML">Original</div></div>');

        await ypy.timeout(1);

        stream.send('payload', 'update');
        await waitForEvent('ypy:sse:after:message');
        await ypy.timeout(50);

        // Event dispatches on parent, bubbles UP — child doesn't see it
        assertTextContentIs('#child', 'Original');

        stream.close();
    });

    it('named SSE event triggers child with ypy-trigger="... from:body"', async function() {
        const stream = mockStreamResponse('/bubble-from');
        mockResponse('GET', '/child-action', 'Updated!');
        createProcessedHTML('<div ypy-sse:connect="/bubble-from"><div id="child" ypy-get="/child-action" ypy-trigger="update from:body" ypy-swap="innerHTML">Original</div></div>');

        await ypy.timeout(1);

        stream.send('payload', 'update');
        await waitForEvent('ypy:sse:after:message');
        await forRequest();

        assertTextContentIs('#child', 'Updated!');

        stream.close();
    });

    it('ypy:sse:error fires on stream errors', async function() {
        let fetchCount = 0;
        let connection;
        fetchMock.mockResponse('GET', '/error-test', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({
                    start(c) { ctrl = c; },
                });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                // Trigger an error on the stream
                setTimeout(() => ctrl.error(new Error('stream broken')), 20);
                return response;
            }
            throw new Error('Network error');
        });

        createProcessedHTML('<button ypy-get="/error-test" ypy-swap="innerHTML">Go</button>');

        let errorFired = false;
        let errorDetail = null;
        onDoc('ypy:sse:before:connection', (e) => {
            connection = e.detail.connection;
        });
        onDoc('ypy:sse:error', (e) => {
            errorFired = true;
            errorDetail = e.detail;
        });

        find('button').click();
        await new Promise(r => setTimeout(r, 100));

        assert.isTrue(errorFired, 'ypy:sse:error should fire on stream error');
        assert.isNotNull(errorDetail.error, 'Error detail should contain error object');
        assert.strictEqual(errorDetail.connection, connection);
    });

    it('ypy:sse:error fires on non-2xx reconnect response', async function() {
        this.timeout(5000);
        let fetchCount = 0;
        let connection;
        fetchMock.mockResponse('GET', '/status-error', () => {
            fetchCount++;
            if (fetchCount === 1) {
                let ctrl;
                const body = new ReadableStream({ start(c) { ctrl = c; } });
                const response = new MockResponse(body, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
                response.body = body;
                setTimeout(() => ctrl.close(), 10);
                return response;
            }
            // Return a 500 on reconnect
            const body = new ReadableStream({ start(c) { c.close(); } });
            const response = new MockResponse(body, {
                status: 500,
                headers: { 'Content-Type': 'text/event-stream' }
            });
            response.body = body;
            response.ok = false;
            return response;
        });

        createProcessedHTML('<button ypy-get="/status-error" ypy-config="sse.reconnect:true sse.reconnectDelay:20ms sse.reconnectMaxAttempts:1" ypy-swap="innerHTML">Go</button>');

        let errorFired = false;
        let errorDetail = null;
        onDoc('ypy:sse:before:connection', (e) => {
            connection = e.detail.connection;
        });
        onDoc('ypy:sse:error', (e) => {
            errorFired = true;
            errorDetail = e.detail;
        });

        find('button').click();
        await new Promise(r => setTimeout(r, 200));

        assert.isTrue(errorFired, 'ypy:sse:error should fire for non-2xx reconnect');
        assert.equal(errorDetail.status, 500, 'Error detail should include status code');
        assert.strictEqual(errorDetail.connection, connection);
    });

    it('ypy:sse:before:message cancellation prevents swap', async function() {
        const stream = mockStreamResponse('/cancel-msg');
        createProcessedHTML('<button ypy-get="/cancel-msg" ypy-swap="innerHTML">Original</button>');

        onDoc('ypy:sse:before:message', (e) => {
            if (e.detail.message.data === 'skip me') {
                e.detail.cancelled = true;
            }
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('skip me');
        await ypy.timeout(50);
        assertTextContentIs('button', 'Original', 'Cancelled message should not swap');

        stream.send('keep me');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'keep me', 'Non-cancelled message should swap');

        stream.close();
    });

    it('ypy:sse:before:message waits for async work', async function() {
        const stream = mockStreamResponse('/wait-msg');
        createProcessedHTML('<button ypy-get="/wait-msg" ypy-swap="innerHTML">Original</button>');

        onDoc('ypy:sse:before:message', event => {
            event.detail.waitUntil(ypy.timeout(20).then(() => {
                event.detail.message.data = 'Changed';
            }));
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('Ignored');
        await ypy.timeout(5);
        assertTextContentIs('button', 'Original');

        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'Changed');

        stream.close();
    });

    it('processes messages in arrival order while waiting', async function() {
        const stream = mockStreamResponse('/ordered-msg');
        createProcessedHTML('<button ypy-get="/ordered-msg" ypy-swap="innerHTML">Original</button>');
        let messages = [];

        onDoc('ypy:sse:before:message', event => {
            if (event.detail.message.data === 'first') event.detail.waitUntil(ypy.timeout(20));
        });
        onDoc('ypy:sse:after:message', event => messages.push(event.detail.message.data));

        find('button').click();
        await ypy.timeout(1);

        stream.send('first');
        stream.send('second');
        await ypy.timeout(40);

        assert.deepEqual(messages, ['first', 'second']);
        assertTextContentIs('button', 'second');

        stream.close();
    });

    it('reconnects after waitUntil rejects', async function() {
        const stream = mockStreamResponse('/rejected-work');
        createProcessedHTML('<button ypy-get="/rejected-work" ypy-config="sse.reconnect:true sse.reconnectDelay:1ms" ypy-swap="innerHTML">Original</button>');
        let reject = true;

        onDoc('ypy:sse:before:message', event => {
            if (reject) {
                reject = false;
                event.detail.waitUntil(Promise.reject(new Error('message failed')));
            }
        });

        find('button').click();
        await ypy.timeout(1);

        let error = waitForEvent('ypy:sse:error');
        let reconnected = waitForEvent('ypy:sse:after:connection');
        stream.send('Rejected');
        assert.isNotNull(await error);
        assert.isNotNull(await reconnected);

        stream.send('Recovered');
        assert.isNotNull(await waitForEvent('ypy:sse:after:message'));
        assertTextContentIs('button', 'Recovered');

        stream.close();
    });

    it('ypy:sse:before:message cancellation via preventDefault', async function() {
        const stream = mockStreamResponse('/cancel-prevent');
        createProcessedHTML('<button ypy-get="/cancel-prevent" ypy-swap="innerHTML">Original</button>');

        onDoc('ypy:sse:before:message', (e) => {
            if (e.detail.message.data === 'blocked') {
                e.preventDefault();
            }
        });

        find('button').click();
        await ypy.timeout(1);

        stream.send('blocked');
        await ypy.timeout(50);
        assertTextContentIs('button', 'Original', 'preventDefault should skip message');

        stream.send('allowed');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'allowed');

        stream.close();
    });

    it('ypy-sse:close does not produce an unhandled AbortError rejection (server keeps stream open)', async function() {
        // Regression: server leaves response open after sending close event
        const stream = mockStreamResponse('/close-abort-open');
        createProcessedHTML('<div ypy-sse:connect="/close-abort-open" ypy-sse:close="done" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        let rejections = [];
        let onRejection = e => rejections.push(e.reason);
        window.addEventListener('unhandledrejection', onRejection);

        stream.send('goodbye', 'done'); // server keeps stream open — does NOT call stream.close()
        await waitForEvent('ypy:sse:close');
        await ypy.timeout(20);

        window.removeEventListener('unhandledrejection', onRejection);
        assert.deepEqual(rejections, [], 'ypy-sse:close should not produce an unhandled AbortError when server keeps stream open');
    });

    it('ypy-sse:close does not produce an unhandled AbortError rejection (server closes stream simultaneously)', async function() {
        // Regression: server closes the response at the same time as sending the close event
        const stream = mockStreamResponse('/close-abort-closed');
        createProcessedHTML('<div ypy-sse:connect="/close-abort-closed" ypy-sse:close="done" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        let rejections = [];
        let onRejection = e => rejections.push(e.reason);
        window.addEventListener('unhandledrejection', onRejection);

        stream.send('goodbye', 'done');
        stream.close(); // server closes immediately after
        await waitForEvent('ypy:sse:close');
        await ypy.timeout(20);

        window.removeEventListener('unhandledrejection', onRejection);
        assert.deepEqual(rejections, [], 'ypy-sse:close should not produce an unhandled AbortError when server closes stream simultaneously');
    });

    it('ypy-sse:close closes connection on matching event', async function() {
        const stream = mockStreamResponse('/close-test');
        createProcessedHTML('<div ypy-sse:connect="/close-test" ypy-sse:close="done" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        stream.send('message 1');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'message 1');

        let closeFired = false;
        let closeReason = null;
        onDoc('ypy:sse:close', (e) => {
            closeFired = true;
            closeReason = e.detail.reason;
        });

        // Send the close event
        stream.send('goodbye', 'done');
        await waitForEvent('ypy:sse:close');

        assert.isTrue(closeFired, 'ypy:sse:close should fire');
        assert.equal(closeReason, 'message', 'Close reason should be "message"');

        // Verify no reconnection occurs
        let reconnectFired = false;
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnectFired = true;
        });

        await ypy.timeout(100);
        assert.isFalse(reconnectFired, 'Should NOT attempt reconnect after ypy-sse:close');
    });

    it('ypy-sse:close closes connection on matching event with no data', async function() {
        const stream = mockStreamResponse('/close-nodata');
        createProcessedHTML('<div ypy-sse:connect="/close-nodata" ypy-sse:close="done" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        stream.send('message 1');
        await waitForEvent('ypy:sse:after:message');

        let closeFired = false;
        let beforeMessageFired = false;
        let afterMessageFired = false;
        onDoc('ypy:sse:close', (e) => { closeFired = true; });
        onDoc('ypy:sse:before:message', (e) => { if (e.detail.message.event === 'done') beforeMessageFired = true; });
        onDoc('ypy:sse:after:message', (e) => { if (e.detail.message.event === 'done') afterMessageFired = true; });

        stream.sendRaw('event: done\n\n');
        await waitForEvent('ypy:sse:close');

        assert.isTrue(closeFired);
        assert.isTrue(beforeMessageFired, 'ypy:sse:before:message should fire for data-less named event');
        assert.isTrue(afterMessageFired, 'ypy:sse:after:message should fire for data-less named event');
    });

    it('ypy-sse:close does not close on non-matching events', async function() {
        const stream = mockStreamResponse('/close-nomatch');
        createProcessedHTML('<div ypy-sse:connect="/close-nomatch" ypy-sse:close="done" ypy-swap="innerHTML">Waiting</div>');

        await ypy.timeout(1);

        let closeFired = false;
        onDoc('ypy:sse:close', () => { closeFired = true; });

        // Send a different named event — should NOT close
        stream.send('status update', 'status');
        await waitForEvent('ypy:sse:after:message');

        assert.isFalse(closeFired, 'Should NOT close on non-matching event');

        // Regular messages should still swap
        stream.send('content');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'content');

        stream.close();
    });

    it('ypy:sse:close fires with "ended" reason when stream ends naturally', async function() {
        let ctrl;
        fetchMock.mockResponse('GET', '/end-test', () => {
            const body = new ReadableStream({ start(c) { ctrl = c; } });
            const response = new MockResponse(body, {
                headers: { 'Content-Type': 'text/event-stream' }
            });
            response.body = body;
            return response;
        });

        createProcessedHTML('<button ypy-get="/end-test" ypy-swap="innerHTML">Go</button>');

        let closeReason = null;
        onDoc('ypy:sse:close', (e) => { closeReason = e.detail.reason; });

        find('button').click();
        await ypy.timeout(1);

        // Close the stream (no reconnect configured)
        ctrl.close();
        await waitForEvent('ypy:sse:close');

        assert.equal(closeReason, 'ended', 'Close reason should be "ended"');
    });

    it('pauseOnBackground reconnect sends Last-Event-ID for message replay', async function() {
        this.timeout(5000);
        const enc = new TextEncoder();
        const controllers = [];

        // All notifications the "server" knows about
        const allMessages = [
            {id: 'n-1', data: '<p>Notification 1</p>'},
            {id: 'n-2', data: '<p>Notification 2</p>'},
            {id: 'n-3', data: '<p>Notification 3</p>'}
        ];

        // Simulate a server that replays missed messages using Last-Event-ID
        fetchMock.mockResponse('GET', '/notifications', () => {
            let ctrl;
            const body = new ReadableStream({ start(c) { ctrl = c; controllers.push(c); } });
            const response = new MockResponse(body, {
                headers: { 'Content-Type': 'text/event-stream' }
            });
            response.body = body;

            // On reconnect, check Last-Event-ID and replay missed messages
            if (controllers.length > 1) {
                const calls = fetchMock.getCalls();
                const lastId = calls[calls.length - 1].request.headers?.['Last-Event-ID'];
                if (lastId) {
                    let start = allMessages.findIndex(m => m.id === lastId) + 1;
                    for (let i = start; i < allMessages.length; i++) {
                        ctrl.enqueue(enc.encode(`id: ${allMessages[i].id}\ndata: ${allMessages[i].data}\n\n`));
                    }
                }
            }
            return response;
        });

        createProcessedHTML('<button ypy-get="/notifications" ypy-target="#output" ypy-config="sse.reconnect:true sse.pauseOnBackground:true sse.reconnectDelay:50ms sse.reconnectJitter:0" ypy-swap="beforeend">Connect</button><div id="output"></div>');

        find('button').click();
        await waitForEvent('ypy:sse:after:connection');

        // Server sends first 2 notifications
        controllers[0].enqueue(enc.encode('id: n-1\ndata: <p>Notification 1</p>\n\n'));
        await waitForEvent('ypy:sse:after:message');
        controllers[0].enqueue(enc.encode('id: n-2\ndata: <p>Notification 2</p>\n\n'));
        await waitForEvent('ypy:sse:after:message');

        assert.include(find('#output').innerHTML, 'Notification 1');
        assert.include(find('#output').innerHTML, 'Notification 2');

        // Tab goes to background (n-3 exists on the server but client never received it)
        Object.defineProperty(document, 'hidden', {value: true, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r => setTimeout(r, 50));

        // Tab comes back — extension reconnects with Last-Event-ID: n-2
        Object.defineProperty(document, 'hidden', {value: false, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        await waitForEvent('ypy:sse:after:connection', 3000);

        // Verify Last-Event-ID header was sent
        const reconnectCall = fetchMock.getCalls()[fetchMock.getCalls().length - 1];
        assert.equal(reconnectCall.request.headers['Last-Event-ID'], 'n-2', 'Should send Last-Event-ID of last received message');

        // Server replayed n-3 on reconnect — verify it was swapped in
        await waitForEvent('ypy:sse:after:message', 1000);
        assert.include(find('#output').innerHTML, 'Notification 3', 'Missed notification should be replayed on reconnect');

        controllers[controllers.length - 1].close();
    });

    it('server retry field updates reconnect delay', async function() {
        this.timeout(5000);
        const stream = mockStreamResponse('/retry-test');
        createProcessedHTML('<button ypy-get="/retry-test" ypy-config="sse.reconnect:true sse.reconnectDelay:50ms sse.reconnectMaxAttempts:2 sse.reconnectJitter:0" ypy-swap="innerHTML">Go</button>');

        let reconnected = false;
        onDoc('ypy:sse:before:connection', (e) => {
            if (e.detail.connection.attempt > 0) reconnected = true;
        });

        find('button').click();
        await ypy.timeout(1);

        // Send a message with retry field set to 200ms
        stream.sendRaw('retry: 200\ndata: hello\n\n');
        await waitForEvent('ypy:sse:after:message');

        stream.close();
        await waitForEvent('ypy:sse:after:connection', 5000);

        // Server retry field should be respected (reconnection happens)
        assert.isTrue(reconnected, 'Should reconnect using server-provided retry delay');

        stream.close();
    });

    it('sends Accept: text/html, text/event-stream header on every request', async function() {
        const stream = mockStreamResponse('/accept-header-test');
        createProcessedHTML('<button ypy-get="/accept-header-test" ypy-swap="innerHTML">Go</button>');

        find('button').click();
        await ypy.timeout(1);

        assert.equal(fetchMock.getLastCall().request.headers['Accept'], 'text/html, text/event-stream');

        stream.close();
    });

    it('preserves existing Accept values', async function() {
        const stream = mockStreamResponse('/accept-header-existing');
        createProcessedHTML('<button ypy-get="/accept-header-existing" ypy-headers=\'"Accept":"text/html, multipart/mixed"\'>Go</button>');

        find('button').click();
        await ypy.timeout(1);

        assert.equal(
            fetchMock.getLastCall().request.headers.Accept,
            'text/html, multipart/mixed, text/event-stream'
        );

        stream.close();
    });

    it('oob-only SSE message does not blank main target by default', async function() {
        const stream = mockStreamResponse('/oob-only');
        createProcessedHTML('<div id="target" ypy-sse:connect="/oob-only" ypy-swap="innerHTML">Original</div><div id="oob">OOB</div>');

        await ypy.timeout(1);

        stream.send('<div id="oob" ypy-swap-oob="true">Updated</div>');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('#target', 'Original');
        assertTextContentIs('#oob', 'Updated');

        stream.close();
    });

    it('oob-only SSE message blanks main target when swapEmpty:true explicitly set', async function() {
        const stream = mockStreamResponse('/oob-empty-true');
        createProcessedHTML('<div id="target" ypy-sse:connect="/oob-empty-true" ypy-swap="innerHTML swapEmpty:true">Original</div><div id="oob">OOB</div>');

        await ypy.timeout(1);

        stream.send('<div id="oob" ypy-swap-oob="true">Updated</div>');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('#target', '');
        assertTextContentIs('#oob', 'Updated');

        stream.close();
    });

    it('SSE message with real content alongside oob still swaps main target', async function() {
        const stream = mockStreamResponse('/oob-with-content');
        createProcessedHTML('<div id="target" ypy-sse:connect="/oob-with-content" ypy-swap="innerHTML">Original</div><div id="oob">OOB</div>');

        await ypy.timeout(1);

        stream.send('<div>New Content</div><div id="oob" ypy-swap-oob="true">Updated</div>');
        await waitForEvent('ypy:sse:after:message');

        assertTextContentIs('#oob', 'Updated');
        find('#target').innerText.trim().should.equal('New Content');

        stream.close();
    });

    it('supports legacy ypy-sse-connect attribute and warns once', async function() {
        let warnings = [];
        let originalWarn = console.warn;
        console.warn = warning => warnings.push(warning);

        const stream = mockStreamResponse('/legacy-test');
        createProcessedHTML('<div ypy-sse-connect="/legacy-test" ypy-swap="innerHTML">Waiting</div>');
        ypy.process(find('div'));
        await ypy.timeout(1);

        console.warn = originalWarn;

        stream.send('legacy works');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'legacy works');
        assert.equal(warnings.filter(warning => warning.includes('ypy-sse-connect')).length, 1);

        stream.close();
    });

    it('supports legacy ypy-sse-close attribute and warns once', async function() {
        let warnings = [];
        let originalWarn = console.warn;
        console.warn = warning => warnings.push(warning);

        const stream = mockStreamResponse('/legacy-close');
        createProcessedHTML('<div ypy-sse:connect="/legacy-close" ypy-sse-close="done">Waiting</div>');
        ypy.process(find('div'));
        await ypy.timeout(1);

        console.warn = originalWarn;

        let closeReason;
        onDoc('ypy:sse:close', event => closeReason = event.detail.reason);
        stream.send('Complete', 'done');
        await waitForEvent('ypy:sse:close');

        assert.equal(closeReason, 'message');
        assert.equal(warnings.filter(warning => warning.includes('ypy-sse-close')).length, 1);
    });

    it('cleanup aborts the initial connection fetch when element is swapped out', async function() {
        const stream = mockStreamResponse('/abort-initial');
        mockResponse('GET', '/replace', '<div id="replacement">Replaced</div>');
        
        createProcessedHTML('<div id="container" ypy-get="/replace" ypy-trigger="click" ypy-swap="innerHTML"><div id="sse" ypy-sse:connect="/abort-initial" ypy-swap="innerHTML">Waiting</div></div>');

        await ypy.timeout(1);

        stream.send('connected');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('#sse', 'connected');

        // Grab the connection before cleanup
        let connection = find('#sse')._ypy.sse;
        assert.isNotNull(connection.abortController, 'Initial connection should have abortController');
        assert.isNotNull(connection.abortController.signal, 'abortController should have signal');
        assert.isFalse(connection.abortController.signal.aborted, 'Signal should not be aborted yet');

        let closeFired = false;
        onDoc('ypy:sse:close', () => { closeFired = true; });

        // Trigger ypy swap which should call ypy_before_cleanup on the SSE element
        find('#container').click();
        await forRequest();

        assertTextContentIs('#container', 'Replaced');
        assert.isTrue(closeFired, 'ypy:sse:close should fire');
        assert.isTrue(connection.abortController.signal.aborted, 'Cleanup should abort the initial connection');
    });

    it('warns once for removed ypy-sse-swap attribute', function() {
        let warnings = [];
        let originalWarn = console.warn;
        console.warn = warning => warnings.push(warning);

        createProcessedHTML('<div ypy-sse-swap="message"></div>');
        ypy.process(find('div'));

        console.warn = originalWarn;

        assert.equal(warnings.filter(warning => warning.includes('ypy-sse-swap')).length, 1);
    });

    // ========================================
    // releaseOn / ypy:release tests
    // ========================================

    it('releases when stream closes by default (releaseOn:end)', async function() {
        const stream = mockStreamResponse('/default-release');
        createProcessedHTML('<button ypy-get="/default-release" ypy-swap="innerHTML" ypy-indicator="#spinner">Go</button><div id="spinner" class="ypy-indicator">Loading...</div>');

        find('button').click();
        await ypy.timeout(1);

        stream.send('first message');
        await waitForEvent('ypy:sse:after:message');
        await ypy.timeout(10);

        // Indicator should still be visible (default is releaseOn:end)
        assert.isTrue(find('#spinner').classList.contains('ypy-request'), 'Indicator should stay visible during streaming');

        stream.send('second message');
        await waitForEvent('ypy:sse:after:message');
        await ypy.timeout(10);

        // Still visible
        assert.isTrue(find('#spinner').classList.contains('ypy-request'), 'Indicator should stay visible after multiple messages');

        stream.close();
        await waitForEvent('ypy:sse:close');
        await ypy.timeout(10);

        // Now hidden
        assert.isFalse(find('#spinner').classList.contains('ypy-request'), 'Indicator should hide when stream closes');
    });

    it('releaseOn:first releases after first message', async function() {
        const stream = mockStreamResponse('/first-release');
        createProcessedHTML('<button ypy-get="/first-release" ypy-config="sse.releaseOn:first" ypy-swap="innerHTML" ypy-indicator="#spinner">Go</button><div id="spinner" class="ypy-indicator">Loading...</div>');

        find('button').click();
        await ypy.timeout(1);

        // Indicator should be visible before first message
        assert.isTrue(find('#spinner').classList.contains('ypy-request'), 'Indicator should be visible initially');

        stream.send('first message');
        await waitForEvent('ypy:sse:after:message');
        await ypy.timeout(10);

        // Indicator should be hidden after first message
        assert.isFalse(find('#spinner').classList.contains('ypy-request'), 'Indicator should hide after first message with releaseOn:first');

        // Subsequent messages still work (background streaming)
        stream.send('second message');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'second message');

        stream.close();
    });

    it('ypy:release event triggers early release', async function() {
        const stream = mockStreamResponse('/release-test');
        createProcessedHTML('<button ypy-get="/release-test" ypy-config="sse.releaseOn:end" ypy-swap="innerHTML" ypy-indicator="#spinner">Go</button><div id="spinner" class="ypy-indicator">Loading...</div>');

        find('button').click();
        await ypy.timeout(1);

        // Indicator should be visible
        assert.isTrue(find('#spinner').classList.contains('ypy-request'), 'Indicator should be visible initially');

        stream.send('Still streaming...');
        await waitForEvent('ypy:sse:after:message');
        await ypy.timeout(10);

        // Indicator should still be visible (releaseOn:end)
        assert.isTrue(find('#spinner').classList.contains('ypy-request'), 'Indicator should stay visible with releaseOn:end');

        // Send ypy:release event to trigger early release
        stream.send('', 'ypy:release');
        await waitForEvent('ypy:sse:after:message');
        await ypy.timeout(10);

        // Indicator should be hidden after ypy:release
        assert.isFalse(find('#spinner').classList.contains('ypy-request'), 'Indicator should hide after ypy:release');

        // But streaming should continue
        stream.send('More content');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'More content');

        stream.close();
    });

    it('releaseOn:immediate releases right away for ypy-sse:connect', async function() {
        const stream = mockStreamResponse('/immediate-test');
        createProcessedHTML('<div ypy-sse:connect="/immediate-test" ypy-swap="innerHTML" ypy-indicator="#spinner">Waiting</div><div id="spinner" class="ypy-indicator">Loading...</div>');

        await ypy.timeout(10);

        // Indicator should already be hidden (immediate release)
        assert.isFalse(find('#spinner').classList.contains('ypy-request'), 'Indicator should hide immediately for ypy-sse:connect');

        // But streaming should work
        stream.send('content');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('div', 'content');

        stream.close();
    });


    it('multiple ypy:release events are idempotent', async function() {
        const stream = mockStreamResponse('/multi-release');
        createProcessedHTML('<button ypy-get="/multi-release" ypy-config="sse.releaseOn:end" ypy-swap="innerHTML">Go</button>');

        find('button').click();
        await ypy.timeout(1);

        stream.send('content');
        await waitForEvent('ypy:sse:after:message');

        // Send multiple ypy:release events - should not cause errors
        stream.send('', 'ypy:release');
        await waitForEvent('ypy:sse:after:message');
        stream.send('', 'ypy:release');
        await waitForEvent('ypy:sse:after:message');
        stream.send('', 'ypy:release');
        await waitForEvent('ypy:sse:after:message');

        // Streaming should still work
        stream.send('more content');
        await waitForEvent('ypy:sse:after:message');
        assertTextContentIs('button', 'more content');

        stream.close();
    });

    describe('heartbeat and resume', function() {
        let realNow = Date.now;

        afterEach(() => { Date.now = realNow; });

        function fetchCount(url) {
            return fetchMock.getCalls().filter(c => c.url.includes(url)).length;
        }

        function skewClock(ms) {
            Date.now = () => realNow() + ms;
        }

        // an element that reconnects fast, so the test waits milliseconds
        function connectHTML(url, heartbeat) {
            let config = 'sse.reconnect:true sse.reconnectDelay:20ms sse.reconnectJitter:0'
                + (heartbeat ? ` sse.heartbeat:${heartbeat}` : '');
            createProcessedHTML(`<button ypy-get="${url}" ypy-config="${config}" ypy-swap="innerHTML">Connect</button>`);
        }

        it('a silent stream is closed and opened again after the heartbeat', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/hb-silent');
            connectHTML('/hb-silent', '120ms');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            stream.send('one');
            await waitForEvent('ypy:sse:after:message');
            assert.equal(fetchCount('/hb-silent'), 1);

            // nothing arrives: no error, no end, the connection just hangs
            await waitForEvent('ypy:sse:after:connection', 2000);
            assert.equal(fetchCount('/hb-silent'), 2, 'one new request, not a second connection on top of the first');

            stream.send('two');
            await waitForEvent('ypy:sse:after:message');
            assertTextContentIs('button', 'two');
            stream.close();
        });

        it('any byte keeps the stream alive, a comment line included', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/hb-alive');
            connectHTML('/hb-alive', '150ms');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');

            for (let i = 0; i < 8; i++) {
                stream.sendRaw(': ping\n\n');
                await ypy.timeout(50);
            }
            assert.equal(fetchCount('/hb-alive'), 1, 'the pings are bytes, the stream is not silent');
            stream.close();
        });

        it('without heartbeat a silent stream is left alone', async function() {
            this.timeout(5000);
            mockStreamResponse('/hb-off');
            connectHTML('/hb-off');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            await ypy.timeout(400);
            assert.equal(fetchCount('/hb-off'), 1);
        });

        it('heartbeat accepts a number of milliseconds', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/hb-number');
            createProcessedHTML('<button ypy-get="/hb-number" ypy-config="sse.reconnect:true sse.reconnectDelay:20ms sse.reconnectJitter:0 sse.heartbeat:100" ypy-swap="innerHTML">Connect</button>');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            await waitForEvent('ypy:sse:after:connection', 2000);
            assert.equal(fetchCount('/hb-number'), 2);
            stream.close();
        });

        it('a silent stream that must not reconnect just ends', async function() {
            this.timeout(5000);
            mockStreamResponse('/hb-no-reconnect');
            createProcessedHTML('<button ypy-get="/hb-no-reconnect" ypy-config="sse.reconnect:false sse.heartbeat:100ms" ypy-swap="innerHTML">Connect</button>');

            let reasons = [];
            find('button').addEventListener('ypy:sse:close', e => reasons.push(e.detail.reason));
            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            await ypy.timeout(400);
            assert.deepEqual(reasons, ['ended'], 'the silent stream is closed');
            assert.equal(fetchCount('/hb-no-reconnect'), 1);
        });

        it('removing the element stops the watchdog', async function() {
            this.timeout(5000);
            mockStreamResponse('/hb-removed');
            connectHTML('/hb-removed', '80ms');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            find('button').remove();
            await ypy.timeout(300);
            assert.equal(fetchCount('/hb-removed'), 1);
        });

        it('becoming visible after a long silence reopens the stream at once', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-visible');
            connectHTML('/resume-visible', '30s');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            stream.send('before sleep');
            await waitForEvent('ypy:sse:after:message');

            // the phone slept for a minute: the clock jumped, the stream never failed
            skewClock(60000);
            document.dispatchEvent(new Event('visibilitychange'));

            await waitForEvent('ypy:sse:after:connection', 1000);
            assert.equal(fetchCount('/resume-visible'), 2);
            stream.close();
        });

        it('becoming visible when the stream spoke lately does nothing', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-fresh');
            connectHTML('/resume-fresh', '30s');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            stream.send('fresh');
            await waitForEvent('ypy:sse:after:message');

            document.dispatchEvent(new Event('visibilitychange'));
            await ypy.timeout(200);
            assert.equal(fetchCount('/resume-fresh'), 1);
            stream.close();
        });

        it('becoming visible without a heartbeat does not restart a stream', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-no-hb');
            connectHTML('/resume-no-hb');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            skewClock(60000);
            document.dispatchEvent(new Event('visibilitychange'));
            await ypy.timeout(200);
            assert.equal(fetchCount('/resume-no-hb'), 1);
            stream.close();
        });

        it('the hidden state does not wake anything', async function() {
            this.timeout(5000);
            mockStreamResponse('/resume-hidden');
            createProcessedHTML('<button ypy-get="/resume-hidden" ypy-config="sse.reconnect:true sse.pauseOnBackground:true sse.heartbeat:30s" ypy-swap="innerHTML">Connect</button>');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            skewClock(60000);
            Object.defineProperty(document, 'hidden', {value: true, configurable: true});
            document.dispatchEvent(new Event('visibilitychange'));
            window.dispatchEvent(new Event('online'));
            await ypy.timeout(200);
            assert.equal(fetchCount('/resume-hidden'), 1, 'a hidden tab stays paused');
        });

        it('online reopens the stream once, with no second connection', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-online');
            connectHTML('/resume-online', '30s');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            stream.send('hello');
            await waitForEvent('ypy:sse:after:message');

            window.dispatchEvent(new Event('online'));
            window.dispatchEvent(new Event('online'));
            await waitForEvent('ypy:sse:after:connection', 1000);
            await ypy.timeout(150);
            assert.equal(fetchCount('/resume-online'), 2, 'one new request for two events');
            stream.send('again');
            await waitForEvent('ypy:sse:after:message');
            assertTextContentIs('button', 'again');
            stream.close();
        });

        it('pageshow from the back/forward cache reopens the stream', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-bfcache');
            connectHTML('/resume-bfcache');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');

            let restored = new Event('pageshow');
            restored.persisted = true;
            window.dispatchEvent(restored);

            await waitForEvent('ypy:sse:after:connection', 1000);
            assert.equal(fetchCount('/resume-bfcache'), 2);
            stream.close();
        });

        it('a first pageshow of a page, not from the cache, does not reopen anything', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-pageshow');
            connectHTML('/resume-pageshow');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');

            let shown = new Event('pageshow');
            shown.persisted = false;
            window.dispatchEvent(shown);
            await ypy.timeout(200);
            assert.equal(fetchCount('/resume-pageshow'), 1);
            stream.close();
        });

        it('a wake-up skips the wait for the next attempt', async function() {
            this.timeout(5000);
            const stream = mockStreamResponse('/resume-backoff');
            createProcessedHTML('<button ypy-get="/resume-backoff" ypy-config="sse.reconnect:true sse.reconnectDelay:10s sse.reconnectJitter:0" ypy-swap="innerHTML">Connect</button>');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            stream.close();
            await ypy.timeout(100);
            assert.equal(fetchCount('/resume-backoff'), 1, 'it waits ten seconds');

            window.dispatchEvent(new Event('online'));
            await waitForEvent('ypy:sse:after:connection', 1000);
            assert.equal(fetchCount('/resume-backoff'), 2);
            stream.close();
        });

        it('a wake-up after the element left the page opens nothing', async function() {
            this.timeout(5000);
            mockStreamResponse('/resume-gone');
            connectHTML('/resume-gone', '30s');

            find('button').click();
            await waitForEvent('ypy:sse:after:connection');
            find('button').remove();
            await ypy.timeout(50);

            skewClock(60000);
            window.dispatchEvent(new Event('online'));
            document.dispatchEvent(new Event('visibilitychange'));
            await ypy.timeout(200);
            assert.equal(fetchCount('/resume-gone'), 1);
        });
    });
});
