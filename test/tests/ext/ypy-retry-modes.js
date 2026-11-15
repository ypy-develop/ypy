// SPDX-License-Identifier: MIT
// TASK-067: the modes of ypy-retry (on: network, error, always, never), jitter and Retry-After.
// The basic loop (backoff, max, abort, unsafe methods) is covered by test/tests/end2end/offline.js.
describe('ypy-retry modes', function () {

    const down = () => Promise.reject(new TypeError('Failed to fetch'));
    let extBackup;

    before(async function () {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-retry.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
        if (SOURCE_BUILD) assert.isTrue(ypy.__registeredExt.has('ypy-retry'));
    });

    after(function () {
        restoreExtensions(extBackup);
    });

    beforeEach(function () {
        setupTest(this.currentTest);
    });

    afterEach(function () {
        delete ypy.config.retry;
        cleanupTest();
    });

    const count = url => fetchMock.getCalls().filter(c => c.url === url).length;

    // The first `failures` calls answer `status` (with these headers), then 200 "back"
    function answers(verb, url, failures, status, headers = {}) {
        let calls = 0;
        fetchMock.mockResponse(verb, url, () => new MockResponse(++calls <= failures ? 'bad' : 'back', calls <= failures ? {status, headers} : {}));
    }

    async function run(html) {
        let elt = createProcessedHTML(html), seen = [], errors = [];
        elt.addEventListener('ypy:request:retry', e => seen.push(e.detail));
        elt.addEventListener('ypy:error', e => errors.push(e.detail));
        elt.click();
        await forRequest(4000);
        return {elt, seen, errors};
    }

    describe('on', function () {

        it('network (the default) does not repeat a 503', async function () {
            answers('GET', '/r', 5, 503);
            let {seen, elt} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms"></div>');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
            assert.equal(elt.innerHTML, 'bad', 'the 503 goes through the normal flow');
        });

        it('network repeats a failed fetch, and reports no status', async function () {
            let calls = 0;
            fetchMock.mockResponse('GET', '/r', () => ++calls < 2 ? down() : new MockResponse('back'));
            let {seen, elt} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:network"></div>');
            assert.equal(count('/r'), 2);
            assert.isUndefined(seen[0].status);
            assert.equal(elt.innerHTML, 'back');
        });

        it('error repeats a 5xx until it works', async function () {
            answers('GET', '/r', 2, 500);
            let {seen, elt, errors} = await run('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms backoff:1 on:error"></div>');
            assert.equal(count('/r'), 3);
            assert.deepEqual(seen.map(d => [d.attempt, d.status]), [[1, 500], [2, 500]]);
            assert.equal(elt.innerHTML, 'back');
            assert.equal(errors.length, 0);
        });

        it('error also repeats a failed fetch', async function () {
            let calls = 0;
            fetchMock.mockResponse('GET', '/r', () => ++calls < 2 ? down() : new MockResponse('back'));
            let {elt} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:error"></div>');
            assert.equal(count('/r'), 2);
            assert.equal(elt.innerHTML, 'back');
        });

        it('error does not repeat a 4xx', async function () {
            answers('GET', '/r', 5, 404);
            let {seen} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:error"></div>');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
        });

        it('error gives the last 5xx to the normal flow when the attempts run out', async function () {
            answers('GET', '/r', 9, 502);
            let responseErrors = [];
            document.addEventListener('ypy:response:error', e => responseErrors.push(e.detail.ctx.response.status), {once: true});
            let {seen} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms backoff:1 on:error"></div>');
            assert.equal(count('/r'), 3);
            assert.equal(seen.length, 2);
            assert.deepEqual(responseErrors, [502], 'ypy:response:error fires once, for the last answer');
        });

        it('always repeats a 4xx too', async function () {
            answers('GET', '/r', 1, 404);
            let {seen, elt} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:always"></div>');
            assert.equal(count('/r'), 2);
            assert.equal(seen[0].status, 404);
            assert.equal(elt.innerHTML, 'back');
        });

        it('always does not repeat a success or a redirect answer', async function () {
            mockResponse('GET', '/r', 'fine');
            let {seen} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:always"></div>');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
        });

        it('never turns it off, also for a fetch that failed', async function () {
            mockResponse('GET', '/r', down);
            let {seen, errors} = await run('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms on:never"></div>');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
            assert.equal(errors.length, 1);
        });

        it('an unknown value behaves as network', async function () {
            answers('GET', '/r', 5, 500);
            let {seen} = await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:sometimes"></div>');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
        });

        it('retry.on in the config is the default, and the attribute overrides it', async function () {
            ypy.config.retry = {on: 'error', attempts: 2, delay: 5};
            answers('GET', '/r', 1, 500);
            let first = await run('<div ypy-get="/r" ypy-retry></div>');
            assert.equal(count('/r'), 2);
            assert.equal(first.elt.innerHTML, 'back');
            fetchMock.reset();
            answers('GET', '/s', 1, 500);
            await run('<div ypy-get="/s" ypy-retry="on:network"></div>');
            assert.equal(count('/s'), 1);
        });

        it('a bare attribute means three attempts, in any mode', async function () {
            answers('GET', '/r', 9, 503);
            let {seen} = await run('<div ypy-get="/r" ypy-retry="on:error delay:1ms backoff:1"></div>');
            assert.equal(seen.length, 3);
            assert.equal(count('/r'), 4);
        });

        it('without ypy-retry nothing is repeated, whatever retry.on says', async function () {
            ypy.config.retry = {on: 'always'};
            answers('GET', '/r', 5, 500);
            await run('<div ypy-get="/r"></div>');
            assert.equal(count('/r'), 1);
        });
    });

    describe('methods', function () {

        it('POST is not repeated after a 5xx, the server may have run it', async function () {
            answers('POST', '/r', 5, 500);
            let {seen} = await run('<div ypy-post="/r" ypy-retry="attempts:2 delay:5ms on:always"></div>');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
        });

        it('POST is repeated with unsafe:true', async function () {
            answers('POST', '/r', 1, 500);
            let {seen} = await run('<div ypy-post="/r" ypy-retry="attempts:2 delay:5ms on:error unsafe:true"></div>');
            assert.equal(count('/r'), 2);
            assert.equal(seen.length, 1);
        });

        it('a method that methods leaves out is not repeated', async function () {
            answers('GET', '/r', 5, 500);
            await run('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms on:error methods:HEAD"></div>');
            assert.equal(count('/r'), 1);
        });
    });

    describe('jitter', function () {

        async function delays(attrs, times = 12) {
            let out = [];
            for (let i = 0; i < times; i++) {
                fetchMock.reset();
                answers('GET', '/r', 1, 500);
                let {seen} = await run(`<div ypy-get="/r" ypy-retry="attempts:1 on:error ${attrs}"></div>`);
                out.push(seen[0].delay);
            }
            return out;
        }

        it('is configurable and varies each wait within the range', async function () {
            let list = await delays('delay:100ms jitter:0.2');
            assert.isTrue(list.every(d => d >= 80 && d <= 120), list.join());
            assert.isAbove(new Set(list).size, 1, 'the waits are not all equal');
        });

        it('takes a percentage', async function () {
            let list = await delays('delay:100ms jitter:50%', 12);
            assert.isTrue(list.every(d => d >= 50 && d <= 150), list.join());
            assert.isAbove(new Set(list).size, 1);
        });

        it('0 keeps the waits exact', async function () {
            let list = await delays('delay:100ms jitter:0', 4);
            assert.deepEqual(list, [100, 100, 100, 100]);
        });

        it('applies to the backoff, and the cap max still holds', async function () {
            ypy.config.retry = {jitter: 1};
            let list = await delays('delay:100ms max:120ms', 8);
            assert.isTrue(list.every(d => d >= 0 && d <= 120), list.join());
        });

        it('the page default comes from retry.jitter', async function () {
            ypy.config.retry = {jitter: 0.1};
            let list = await delays('delay:100ms', 12);
            assert.isTrue(list.every(d => d >= 90 && d <= 110), list.join());
            assert.isAbove(new Set(list).size, 1);
        });

        it('the attribute overrides retry.jitter', async function () {
            ypy.config.retry = {jitter: 0.5};
            let list = await delays('delay:100ms jitter:0', 3);
            assert.deepEqual(list, [100, 100, 100]);
        });
    });

    describe('Retry-After', function () {

        const retryOf = async (status, headers, attrs = 'delay:5ms jitter:0') => {
            answers('GET', '/r', 1, status, headers);
            return run(`<div ypy-get="/r" ypy-retry="attempts:2 on:error ${attrs}"></div>`);
        };

        it('a 503 waits at least the seconds that the server asks', async function () {
            let {seen, elt} = await retryOf(503, {'Retry-After': '1'}, 'delay:5ms jitter:0 max:5s');
            assert.equal(seen[0].delay, 1000);
            assert.equal(elt.innerHTML, 'back');
        });

        it('a 429 in mode always is also awaited', async function () {
            answers('GET', '/r', 1, 429, {'Retry-After': '1'});
            let {seen} = await run('<div ypy-get="/r" ypy-retry="attempts:2 on:always delay:5ms jitter:0"></div>');
            assert.equal(seen[0].delay, 1000);
            assert.equal(seen[0].status, 429);
        });

        it('the backoff wins when it is longer than the header', async function () {
            let {seen} = await retryOf(503, {'Retry-After': '0'}, 'delay:50ms jitter:0');
            assert.equal(seen[0].delay, 50);
        });

        it('jitter does not make the wait shorter than the header', async function () {
            this.timeout(10000);
            for (let i = 0; i < 3; i++) {
                fetchMock.reset();
                let {seen} = await retryOf(503, {'Retry-After': '1'}, 'delay:5ms jitter:1 max:5s');
                assert.isAtLeast(seen[0].delay, 1000);
            }
        });

        it('reads an HTTP date', async function () {
            this.timeout(6000);
            let date = new Date(Date.now() + 1500).toUTCString();
            let {seen} = await retryOf(503, {'Retry-After': date}, 'delay:5ms jitter:0 max:10s');
            assert.isAtLeast(seen[0].delay, 500, 'the date has second precision');
            assert.isAtMost(seen[0].delay, 1500);
        });

        it('a date in the past and a value that is not valid fall back to the backoff', async function () {
            let past = new Date(Date.now() - 60000).toUTCString();
            let a = await retryOf(503, {'Retry-After': past});
            assert.equal(a.seen[0].delay, 5);
            fetchMock.reset();
            let b = await retryOf(503, {'Retry-After': 'soon'});
            assert.equal(b.seen[0].delay, 5);
        });

        it('a wait longer than max is not awaited: the 503 goes to the normal flow', async function () {
            let {seen, elt} = await retryOf(503, {'Retry-After': '120'}, 'delay:5ms jitter:0 max:30s');
            assert.equal(count('/r'), 1);
            assert.equal(seen.length, 0);
            assert.equal(elt.innerHTML, 'bad');
        });

        it('other statuses ignore the header', async function () {
            let {seen} = await retryOf(500, {'Retry-After': '1'});
            assert.equal(seen[0].delay, 5);
        });
    });

    describe('abort and cleanup', function () {

        it('an abort during the wait for a repeated answer ends the request quietly', async function () {
            answers('GET', '/r', 5, 500);
            let elt = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:200ms on:error jitter:0"></div>');
            let retries = 0, errors = 0;
            elt.addEventListener('ypy:request:retry', () => { retries++; setTimeout(() => ypy.trigger(elt, 'ypy:abort'), 10) });
            elt.addEventListener('ypy:error', () => errors++);
            elt.click();
            await forRequest(1000);
            await ypy.timeout(300);
            assert.equal(retries, 1);
            assert.equal(count('/r'), 1, 'no second attempt after the abort');
            assert.equal(errors, 0);
        });

        it('the event can be cancelled: the answer is given to the page', async function () {
            answers('GET', '/r', 5, 503);
            let elt = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms on:error"></div>');
            elt.addEventListener('ypy:request:retry', e => e.preventDefault());
            elt.click();
            await forRequest(1000);
            assert.equal(count('/r'), 1);
            assert.equal(elt.innerHTML, 'bad');
        });
    });
});
