// SPDX-License-Identifier: MIT
// TASK-010: the offline state, the kinds of network failure and the opt-in retry.
describe('ypy offline and retry', function () {

    const html = document.documentElement
    const down = () => Promise.reject(new TypeError('Failed to fetch'))
    let onLineDescriptor

    // Overrides navigator.onLine for the test; afterEach puts the real getter back
    function setOnLine(value) {
        Object.defineProperty(navigator, 'onLine', {value, configurable: true})
    }

    // A GET (or the verb given) that fails `failures` times with a TypeError, then answers `body`
    function flaky(url, failures, body = 'back', verb = 'GET') {
        let calls = 0
        fetchMock.mockResponse(verb, url, () => ++calls <= failures ? down() : new MockResponse(body))
    }

    function fetchCount(url) {
        return fetchMock.getCalls().filter(c => c.url === url).length
    }

    // Records events of the document; log.stop() removes the listeners
    function recordOnce(names) {
        let log = []
        let handlers = names.map(name => {
            let h = e => log.push({name, detail: e.detail})
            document.addEventListener(name, h)
            return () => document.removeEventListener(name, h)
        })
        log.stop = () => handlers.forEach(off => off())
        return log
    }

    beforeEach(function () {
        onLineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine')
        ypy.__initOffline()
    })

    afterEach(function () {
        delete navigator.onLine
        if (onLineDescriptor) Object.defineProperty(navigator, 'onLine', onLineDescriptor)
        delete ypy.config.retry
        delete ypy.config.classes.offline
        cleanupTest()
        window.dispatchEvent(new Event('online'))
        html.classList.remove('ypy-offline', 'is-offline')
        delete html.dataset.ypyState
    })

    // ---------------------------------------------------------------------------------------
    // Criterion 1: a network failure is classified and told apart from an HTTP error
    // ---------------------------------------------------------------------------------------
    describe('failure kinds', function () {

        async function failedCtx(attrs = '') {
            let div = createProcessedHTML(`<div ypy-get="/kind" ${attrs}></div>`)
            let ctx, errors = []
            div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
            div.addEventListener('ypy:error', e => errors.push(e.detail))
            div.click()
            await forRequest(500)
            return {ctx, errors}
        }

        beforeEach(function () {
            setupTest(this)
        })

        it('is offline when fetch rejects and the browser reports no connection', async function () {
            setOnLine(false)
            mockResponse('GET', '/kind', down)
            let {ctx, errors} = await failedCtx()
            assert.equal(ctx.errorKind, 'offline')
            assert.equal(errors.length, 1)
            assert.equal(errors[0].ctx, ctx)
            assert.instanceOf(errors[0].error, TypeError)
        })

        it('is network when fetch rejects while the browser reports a connection', async function () {
            setOnLine(true)
            mockResponse('GET', '/kind', down)
            let {ctx, errors} = await failedCtx()
            assert.equal(ctx.errorKind, 'network')
            assert.equal(errors.length, 1)
        })

        it('classifies any rejection of the fetch call, not only a TypeError', async function () {
            mockFailure('GET', '/kind')
            let {ctx} = await failedCtx()
            assert.equal(ctx.errorKind, 'network')
        })

        it('is timeout when the request timeout aborts it', async function () {
            mockSequentialResponses('GET', '/kind', 'never')
            let {ctx, errors} = await failedCtx('ypy-config="timeout:30"')
            assert.equal(ctx.errorKind, 'timeout')
            assert.equal(errors.length, 1)
        })

        it('leaves errorKind unset after a user abort, which stays silent', async function () {
            mockSequentialResponses('GET', '/kind', 'never')
            let div = createProcessedHTML('<div ypy-get="/kind"></div>')
            let ctx, errors = []
            div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
            div.addEventListener('ypy:error', e => errors.push(e))
            div.addEventListener('ypy:before:request', e => setTimeout(() => e.detail.ctx.request.abort(), 10))
            div.click()
            await forRequest(500)
            assert.isUndefined(ctx.errorKind)
            assert.equal(errors.length, 0)
        })

        it('leaves errorKind unset on success', async function () {
            mockResponse('GET', '/kind', 'fine')
            let {ctx} = await failedCtx()
            assert.isUndefined(ctx.errorKind)
        })

        it('does not call a server error a network failure', async function () {
            mockResponse('GET', '/kind', 'boom', {status: 500})
            let {ctx, errors} = await failedCtx()
            assert.notInclude(['offline', 'network', 'timeout'], ctx.errorKind)
            assert.equal(errors.length, 0)
        })
    })

    // ---------------------------------------------------------------------------------------
    // Criterion 2: the state of <html> follows the real state
    // ---------------------------------------------------------------------------------------
    describe('page state', function () {

        beforeEach(function () {
            setupTest(this)
        })

        it('marks <html> when the window goes offline and clears it when it comes back', function () {
            let events = recordOnce(['ypy:offline', 'ypy:online'])
            window.dispatchEvent(new Event('offline'))
            assert.isTrue(html.classList.contains('ypy-offline'))
            assert.equal(html.dataset.ypyState, 'offline')
            assert.deepEqual(events.map(e => e.name), ['ypy:offline'])
            window.dispatchEvent(new Event('online'))
            assert.isFalse(html.classList.contains('ypy-offline'))
            assert.isUndefined(html.dataset.ypyState)
            assert.deepEqual(events.map(e => e.name), ['ypy:offline', 'ypy:online'])
            events.stop()
        })

        it('fires ypy:offline on the document and lets it bubble to the window', function () {
            let onDocument = 0, onWindow = 0
            let d = () => onDocument++, w = () => onWindow++
            document.addEventListener('ypy:offline', d)
            window.addEventListener('ypy:offline', w)
            window.dispatchEvent(new Event('offline'))
            document.removeEventListener('ypy:offline', d)
            window.removeEventListener('ypy:offline', w)
            assert.equal(onDocument, 1)
            assert.equal(onWindow, 1)
        })

        it('fires each event once per change', function () {
            let events = recordOnce(['ypy:offline', 'ypy:online'])
            window.dispatchEvent(new Event('online'))   // already online: nothing changes
            window.dispatchEvent(new Event('offline'))
            window.dispatchEvent(new Event('offline'))
            events.stop()
            assert.deepEqual(events.map(e => e.name), ['ypy:offline'])
        })

        it('reads the state at load, and initialize can run again without repeating it', function () {
            setOnLine(false)
            let events = recordOnce(['ypy:offline'])
            ypy.__initOffline()
            ypy.__initOffline()
            events.stop()
            assert.isTrue(html.classList.contains('ypy-offline'))
            assert.equal(html.dataset.ypyState, 'offline')
            assert.equal(events.length, 1)
        })

        it('registers one listener however often initialize runs', function () {
            let events = recordOnce(['ypy:offline'])
            ypy.__initOffline()
            ypy.__initOffline()
            window.dispatchEvent(new Event('offline'))
            events.stop()
            assert.equal(events.length, 1)
        })

        it('uses the class configured in config.classes.offline', function () {
            ypy.config.classes.offline = 'is-offline'
            window.dispatchEvent(new Event('offline'))
            assert.isTrue(html.classList.contains('is-offline'))
            assert.isFalse(html.classList.contains('ypy-offline'))
            assert.equal(html.dataset.ypyState, 'offline')
        })

        it('keeps the attribute only when the class is configured empty', function () {
            ypy.config.classes.offline = ''
            window.dispatchEvent(new Event('offline'))
            assert.equal(html.dataset.ypyState, 'offline')
            assert.isFalse(html.classList.contains('ypy-offline'))
        })

        it('treats a response as proof of connection when the page was marked offline', async function () {
            window.dispatchEvent(new Event('offline'))
            let events = recordOnce(['ypy:online'])
            mockResponse('GET', '/proof', 'ok')
            let div = createProcessedHTML('<div ypy-get="/proof"></div>')
            div.click()
            await forRequest()
            events.stop()
            assert.isFalse(html.classList.contains('ypy-offline'))
            assert.isUndefined(html.dataset.ypyState)
            assert.equal(events.length, 1)
        })

        it('keeps the page marked offline when a request fails', async function () {
            setOnLine(false)
            window.dispatchEvent(new Event('offline'))
            mockResponse('GET', '/proof', down)
            let div = createProcessedHTML('<div ypy-get="/proof"></div>')
            div.click()
            await forRequest()
            assert.isTrue(html.classList.contains('ypy-offline'))
        })

        it('still fires ypy:error for a failed request', async function () {
            setOnLine(false)
            mockResponse('GET', '/err', down)
            let div = createProcessedHTML('<div ypy-get="/err"></div>')
            let errors = 0
            div.addEventListener('ypy:error', () => errors++)
            div.click()
            await forRequest()
            assert.equal(errors, 1)
        })
    })

    // ---------------------------------------------------------------------------------------
    // Criterion 3: retry, off by default, never on a method that is not idempotent
    // ---------------------------------------------------------------------------------------
    describe('retry', function () {

        // Retry is the ypy-retry extension: it is loaded for these tests and taken away afterwards
        let extBackup

        before(async function () {
            extBackup = backupExtensions()
            let script = document.createElement('script')
            script.src = '../src/ext/ypy-retry.js'
            await new Promise(resolve => {
                script.onload = resolve
                document.head.appendChild(script)
            })
            assert.isTrue(ypy.__registeredExt.has('ypy-retry'))
        })

        after(function () {
            restoreExtensions(extBackup)
        })

        beforeEach(function () {
            setupTest(this)
        })

        it('does nothing without the extension, and does not break', async function () {
            let hooks = ypy.__extMethods.get('ypy_before_request')
            ypy.__extMethods.delete('ypy_before_request')
            try {
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms"></div>')
                let errors = 0, retries = 0
                div.addEventListener('ypy:error', () => errors++)
                div.addEventListener('ypy:request:retry', () => retries++)
                await click(div)
                assert.equal(fetchCount('/r'), 1)
                assert.equal(errors, 1)
                assert.equal(retries, 0)
            } finally {
                ypy.__extMethods.set('ypy_before_request', hooks)
            }
        })

        async function click(div, wait = 1000) {
            div.click()
            return forRequest(wait)
        }

        it('is off by default: one fetch, one ypy:error', async function () {
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r"></div>')
            let errors = 0, retries = 0
            div.addEventListener('ypy:error', () => errors++)
            div.addEventListener('ypy:request:retry', () => retries++)
            await click(div)
            assert.equal(fetchCount('/r'), 1)
            assert.equal(errors, 1)
            assert.equal(retries, 0)
        })

        it('repeats the request until it succeeds, in one call of the phase', async function () {
            flaky('/r', 2)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:10ms backoff:1">first</div>')
            let seen = [], errors = 0, before = 0, finals = 0
            div.addEventListener('ypy:request:retry', e => seen.push(e.detail))
            div.addEventListener('ypy:error', () => errors++)
            div.addEventListener('ypy:before:request', () => before++)
            div.addEventListener('ypy:finally:request', () => finals++)
            await click(div)
            assert.equal(fetchCount('/r'), 3)
            assert.equal(div.innerHTML, 'back')
            assert.deepEqual(seen.map(d => [d.attempt, d.delay]), [[1, 10], [2, 10]])
            assert.isDefined(seen[0].ctx)
            assert.equal(errors, 0)
            assert.equal(before, 1, 'ypy:before:request fires once')
            assert.equal(finals, 1, 'one request, one ypy:finally:request')
            assert.isUndefined(seen[0].ctx.errorKind, 'errorKind is cleared once the retry worked')
        })

        it('waits longer each time and caps the wait at max', async function () {
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:10 backoff:10 max:30"></div>')
            let delays = []
            div.addEventListener('ypy:request:retry', e => delays.push(e.detail.delay))
            await click(div)
            assert.deepEqual(delays, [10, 30, 30])
        })

        it('doubles the wait by default', async function () {
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms"></div>')
            let delays = []
            div.addEventListener('ypy:request:retry', e => delays.push(e.detail.delay))
            await click(div)
            assert.deepEqual(delays, [5, 10, 20])
        })

        it('waits on the clock: the attempts are spread over the backoff', async function () {
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:2 delay:40ms backoff:1"></div>')
            let start = Date.now()
            await click(div)
            assert.isAtLeast(Date.now() - start, 70)
            assert.equal(fetchCount('/r'), 3)
        })

        it('stops at the limit of attempts and then reports the failure', async function () {
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms backoff:1"></div>')
            let errors = [], ctx
            div.addEventListener('ypy:error', e => errors.push(e.detail))
            div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
            await click(div)
            assert.equal(fetchCount('/r'), 3)
            assert.equal(errors.length, 1)
            assert.equal(ctx.errorKind, 'network')
        })

        it('classifies as offline when the browser reports no connection', async function () {
            setOnLine(false)
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:1 delay:5ms"></div>')
            let ctx
            div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
            await click(div)
            assert.equal(ctx.errorKind, 'offline')
        })

        it('does not wait for the clock when the window goes online', async function () {
            flaky('/r', 1)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:1 delay:30s">first</div>')
            div.addEventListener('ypy:request:retry', () => setTimeout(() => window.dispatchEvent(new Event('online')), 20))
            let start = Date.now()
            await click(div, 2000)
            assert.isBelow(Date.now() - start, 1500)
            assert.equal(div.innerHTML, 'back')
            assert.equal(fetchCount('/r'), 2)
        })

        it('holds the queue slot while it waits', async function () {
            flaky('/r', 1)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:1 delay:120ms">first</div>')
            let finals = 0
            div.addEventListener('ypy:finally:request', () => finals++)
            div.click()
            await ypy.timeout(40)
            div.click()   // queued behind the first request, which is waiting to retry
            await ypy.timeout(40)
            assert.equal(fetchCount('/r'), 1, 'the second request has not started')
            await ypy.timeout(400)
            assert.equal(fetchCount('/r'), 3, 'first, its retry, then the queued one')
            assert.equal(finals, 2)
        })

        it('can be cancelled by ypy:request:retry', async function () {
            mockResponse('GET', '/r', down)
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms"></div>')
            let errors = [], ctx
            div.addEventListener('ypy:request:retry', e => e.preventDefault())
            div.addEventListener('ypy:error', e => errors.push(e.detail))
            div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
            await click(div)
            assert.equal(fetchCount('/r'), 1)
            assert.equal(errors.length, 1)
            assert.equal(ctx.errorKind, 'network')
        })

        it('does not repeat a timeout', async function () {
            mockSequentialResponses('GET', '/r', 'never')
            let div = createProcessedHTML('<div ypy-get="/r" ypy-config="timeout:30" ypy-retry="attempts:3 delay:5ms"></div>')
            let ctx, retries = 0
            div.addEventListener('ypy:request:retry', () => retries++)
            div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
            await click(div, 1500)
            assert.equal(retries, 0)
            assert.equal(ctx.errorKind, 'timeout')
        })

        it('does not repeat a server error', async function () {
            mockResponse('GET', '/r', 'boom', {status: 503})
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms"></div>')
            await click(div)
            assert.equal(fetchCount('/r'), 1)
        })

        it('does not repeat a user abort', async function () {
            mockSequentialResponses('GET', '/r', 'never')
            let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5ms"></div>')
            div.addEventListener('ypy:before:request', e => setTimeout(() => e.detail.ctx.request.abort(), 10))
            await click(div)
            assert.equal(fetchCount('/r'), 1)
        })

        describe('methods', function () {

            it('does not repeat a POST without unsafe', async function () {
                mockResponse('POST', '/r', down)
                let div = createProcessedHTML('<div ypy-post="/r" ypy-retry="attempts:3 delay:5ms"></div>')
                let retries = 0
                div.addEventListener('ypy:request:retry', () => retries++)
                await click(div)
                assert.equal(fetchCount('/r'), 1)
                assert.equal(retries, 0)
            })

            it('does not repeat a POST even when methods lists it', async function () {
                mockResponse('POST', '/r', down)
                let div = createProcessedHTML('<div ypy-post="/r" ypy-retry="attempts:3 delay:5ms methods:POST"></div>')
                await click(div)
                assert.equal(fetchCount('/r'), 1)
            })

            for (let verb of ['post', 'put', 'patch', 'delete']) {
                it(`repeats a ${verb.toUpperCase()} with unsafe:true`, async function () {
                    flaky('/r', 1, 'done', verb)
                    let div = createProcessedHTML(`<div ypy-${verb}="/r" ypy-retry="attempts:2 delay:5ms unsafe:true">first</div>`)
                    await click(div)
                    assert.equal(fetchCount('/r'), 2)
                    assert.equal(div.innerHTML, 'done')
                })
            }

            it('repeats a QUERY by default', async function () {
                flaky('/r', 1, 'done', 'query')
                let div = createProcessedHTML('<div ypy-query="/r" ypy-retry="attempts:2 delay:5ms">first</div>')
                await click(div)
                assert.equal(fetchCount('/r'), 2)
            })

            it('narrows the safe methods with methods', async function () {
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:2 delay:5ms methods:QUERY"></div>')
                await click(div)
                assert.equal(fetchCount('/r'), 1)
            })

            it('sends the same body again', async function () {
                let bodies = []
                let calls = 0
                fetchMock.mockResponse('POST', '/r', () => {
                    let last = fetchMock.getLastCall().request.body
                    bodies.push(String(last))
                    return ++calls < 2 ? down() : new MockResponse('ok')
                })
                let div = createProcessedHTML('<form ypy-post="/r" ypy-retry="attempts:2 delay:5ms unsafe:true"><input name="a" value="1"></form>')
                div.dispatchEvent(new Event('submit', {cancelable: true}))
                await forRequest(1000)
                assert.deepEqual(bodies, ['a=1', 'a=1'])
            })
        })

        describe('configuration', function () {

            it('config.retry turns it on for every element', async function () {
                ypy.config.retry = {attempts: 1, delay: 5}
                flaky('/r', 1)
                let div = createProcessedHTML('<div ypy-get="/r">first</div>')
                await click(div)
                assert.equal(fetchCount('/r'), 2)
                assert.equal(div.innerHTML, 'back')
            })

            it('the attribute overrides config.retry', async function () {
                ypy.config.retry = {attempts: 1, delay: 5}
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:5"></div>')
                await click(div)
                assert.equal(fetchCount('/r'), 4)
            })

            it('ypy-retry="false" turns it off for one element', async function () {
                ypy.config.retry = {attempts: 3, delay: 5}
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="false"></div>')
                await click(div)
                assert.equal(fetchCount('/r'), 1)
            })

            it('attempts:0 turns it off for one element', async function () {
                ypy.config.retry = {attempts: 3, delay: 5}
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:0"></div>')
                await click(div)
                assert.equal(fetchCount('/r'), 1)
            })

            it('a bare attribute means 3 attempts with the configured wait', async function () {
                ypy.config.retry = {delay: 5, backoff: 1}
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry></div>')
                await click(div)
                assert.equal(fetchCount('/r'), 4)
            })

            it('config.retry.methods and unsafe apply', async function () {
                ypy.config.retry = {attempts: 1, delay: 5, unsafe: true}
                flaky('/r', 1, 'done', 'post')
                let div = createProcessedHTML('<div ypy-post="/r">first</div>')
                await click(div)
                assert.equal(fetchCount('/r'), 2)
            })

            it('is inherited with :inherited', async function () {
                flaky('/r', 1)
                createProcessedHTML('<section ypy-retry:inherited="attempts:1 delay:5ms"><button ypy-get="/r" ypy-target="this">first</button></section>')
                let button = find('button')
                await click(button)
                assert.equal(fetchCount('/r'), 2)
                assert.equal(button.innerHTML, 'back')
            })

            it('is not inherited without :inherited', async function () {
                mockResponse('GET', '/r', down)
                createProcessedHTML('<section ypy-retry="attempts:1 delay:5ms"><button ypy-get="/r">first</button></section>')
                await click(find('button'))
                assert.equal(fetchCount('/r'), 1)
            })

            it('accepts the data-ypy- and ypy- spellings', async function () {
                mockResponse('GET', '/r', down)
                let a = createProcessedHTML('<div ypy-get="/r" data-ypy-retry="attempts:1 delay:5ms"></div>')
                await click(a)
                assert.equal(fetchCount('/r'), 2)
                let b = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:1 delay:5ms"></div>')
                await click(b)
                assert.equal(fetchCount('/r'), 4)
            })
        })

        describe('cleanup', function () {

            it('aborts a request that is waiting when its element is cleaned up, and frees its timer', async function () {
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:30s"></div>')
                let errors = 0, ctx
                div.addEventListener('ypy:error', () => errors++)
                div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
                div.addEventListener('ypy:request:retry', () => setTimeout(() => ypy.__cleanup(div), 20))
                let start = Date.now()
                await click(div, 2000)
                assert.isBelow(Date.now() - start, 1500, 'it did not wait for the 30 s timer')
                assert.isTrue(ctx.request.signal.aborted)
                assert.equal(errors, 0, 'a cleaned-up request ends quietly')
                // the online listener is gone too: no new attempt
                window.dispatchEvent(new Event('online'))
                await ypy.timeout(50)
                assert.equal(fetchCount('/r'), 1)
            })

            it('aborting the request ends the wait', async function () {
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:3 delay:30s"></div>')
                let ctx
                div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
                div.addEventListener('ypy:request:retry', e => setTimeout(() => e.detail.ctx.request.abort(), 20))
                let start = Date.now()
                await click(div, 2000)
                assert.isBelow(Date.now() - start, 1500)
                assert.match(ctx.status, /^error: AbortError/)
                assert.equal(fetchCount('/r'), 1)
            })

            it('leaves no listener behind after the retry worked', async function () {
                flaky('/r', 1)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-retry="attempts:1 delay:30s">first</div>')
                div.addEventListener('ypy:request:retry', () => setTimeout(() => window.dispatchEvent(new Event('online')), 10))
                await click(div, 2000)
                assert.equal(fetchCount('/r'), 2)
                window.dispatchEvent(new Event('online'))
                ypy.__cleanup(div)   // would abort a stale waiter, and must not throw
                await ypy.timeout(30)
                assert.equal(fetchCount('/r'), 2)
            })

            it('the request timeout covers all the attempts together', async function () {
                mockResponse('GET', '/r', down)
                let div = createProcessedHTML('<div ypy-get="/r" ypy-config="timeout:60" ypy-retry="attempts:5 delay:40ms backoff:1"></div>')
                let ctx
                div.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx)
                await click(div, 2000)
                assert.isBelow(fetchCount('/r'), 6)
                assert.equal(ctx.errorKind, 'timeout')
            })
        })
    })
})
