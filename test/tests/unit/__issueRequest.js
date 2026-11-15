// SPDX-License-Identifier: MIT
describe('__issueRequest unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('triggers ypy:before:request event', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let mockFetch = async () => ({
            status: 200,
            headers: new Headers(),
            text: async () => ''
        })
        ctx.fetch = mockFetch

        let beforeRequestFired = false
        div.addEventListener('ypy:before:request', () => beforeRequestFired = true)

        await ypy.__issueRequest(ctx)
        assert.isTrue(beforeRequestFired)
    })

    it('triggers ypy:after:request event', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let mockFetch = async () => ({
            status: 200,
            headers: new Headers(),
            text: async () => ''
        })
        ctx.fetch = mockFetch

        let afterRequestFired = false
        div.addEventListener('ypy:after:request', () => afterRequestFired = true)

        await ypy.__issueRequest(ctx)
        assert.isTrue(afterRequestFired)
    })

    it('calls custom fetch implementation', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let fetchCalled = false
        let fetchAction = null
        ctx.fetch = async (action, request) => {
            fetchCalled = true
            fetchAction = action
            return {
                status: 200,
                headers: new Headers(),
                text: async () => ''
            }
        }

        await ypy.__issueRequest(ctx)
        assert.isTrue(fetchCalled)
        assert.equal(fetchAction, '/test')
    })

    it('does not execute when queue blocks request', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-sync="drop"></div>')

        // Issue first request
        let ctx1 = ypy.__createRequestContext(div, new Event('click'))
        ctx1.fetch = async () => new Promise(() => {}) // never resolves
        ypy.__issueRequest(ctx1) // don't await

        // Try to issue second request
        let ctx2 = ypy.__createRequestContext(div, new Event('click'))
        let fetchCalled = false
        ctx2.fetch = async () => {
            fetchCalled = true
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        await ypy.__issueRequest(ctx2)
        assert.isFalse(fetchCalled)
    })

    it('replace aborts the active request and runs the replacement', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-sync="replace"></div>')
        let ctx1 = ypy.__createRequestContext(div, new Event('click'))
        ctx1.fetch = (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
        let ctx2 = ypy.__createRequestContext(div, new Event('click'))
        let replacementRan = false
        ctx2.fetch = async () => {
            replacementRan = true
            return {status: 200, headers: new Headers(), text: async () => ''}
        }

        let request1 = ypy.__issueRequest(ctx1)
        let request2 = ypy.__issueRequest(ctx2)
        await Promise.all([request1, request2])

        assert.isTrue(ctx1.request.signal.aborted)
        assert.isTrue(replacementRan)
    })

    it('a later request aborts an active abort request', async function () {
        let parent = createProcessedHTML('<div id="sync"><div id="first" ypy-get="/first" ypy-swap="none" ypy-sync="#sync:abort"></div><div id="second" ypy-get="/second" ypy-swap="none" ypy-sync="#sync:drop"></div></div>')
        let ctx1 = ypy.__createRequestContext(parent.querySelector('#first'), new Event('click'))
        ctx1.fetch = (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
        let ctx2 = ypy.__createRequestContext(parent.querySelector('#second'), new Event('click'))
        let secondRan = false
        ctx2.fetch = async () => {
            secondRan = true
            return {status: 200, headers: new Headers(), text: async () => ''}
        }

        let request1 = ypy.__issueRequest(ctx1)
        let request2 = ypy.__issueRequest(ctx2)
        await Promise.all([request1, request2])

        assert.isTrue(ctx1.request.signal.aborted)
        assert.isTrue(secondRan)
    })

    it('returns early if ypy:before:request is cancelled', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        div.addEventListener('ypy:before:request', (e) => e.preventDefault())

        let fetchCalled = false
        ctx.fetch = async () => {
            fetchCalled = true
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        await ypy.__issueRequest(ctx)
        assert.isFalse(fetchCalled)
    })

    it('returns early if confirm returns false', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-confirm="Are you sure?"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let originalConfirm = window.confirm
        window.confirm = () => false

        let fetchCalled = false
        ctx.fetch = async () => {
            fetchCalled = true
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        await ypy.__issueRequest(ctx)
        assert.isFalse(fetchCalled)

        window.confirm = originalConfirm
    })

    it('cancels request when dropRequest called after ypy:confirm preventDefault', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-confirm="Are you sure?"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        div.addEventListener('ypy:confirm', (e) => {
            e.preventDefault()
            e.detail.dropRequest()
        })

        let fetchCalled = false
        ctx.fetch = async () => {
            fetchCalled = true
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        await ypy.__issueRequest(ctx)
        assert.isFalse(fetchCalled)
    })

    it('creates response object with correct structure', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let mockHeaders = new Headers()
        ctx.fetch = async () => ({
            status: 201,
            headers: mockHeaders,
            text: async () => 'response text'
        })

        await ypy.__issueRequest(ctx)

        assert.equal(ctx.response.status, 201)
        assert.equal(ctx.response.headers, mockHeaders)
        assert.isDefined(ctx.response.raw)
    })

    it('catches errors and triggers ypy:error event', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let errorFired = false
        let capturedError = null
        div.addEventListener('ypy:error', (e) => {
            errorFired = true
            capturedError = e.detail.error
        })

        let testError = new Error('fetch failed')
        ctx.fetch = async () => { throw testError }

        await ypy.__issueRequest(ctx)

        assert.isTrue(errorFired)
        assert.equal(capturedError, testError)
    })

    it('fires YPY-Trigger event after swap completes', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let triggerFired = false
        div.addEventListener('myEvent', () => triggerFired = true)

        ctx.fetch = async () => ({
            status: 200,
            headers: new Headers({ 'YPY-Trigger': 'myEvent' }),
            text: async () => ''
        })

        await ypy.__issueRequest(ctx)
        assert.isTrue(triggerFired)
    })

    it('fires YPY-Trigger on replacement element after outerHTML swap', async function () {
        let div = createProcessedHTML('<div id="source" ypy-get="/test" ypy-swap="outerHTML"></div>')
        let source = find('#source')
        let ctx = ypy.__createRequestContext(source, new Event('click'))

        let triggerTarget = null
        document.addEventListener('myEvent', (e) => triggerTarget = e.target)

        ctx.fetch = async () => ({
            status: 200,
            headers: new Headers({ 'YPY-Trigger': 'myEvent' }),
            text: async () => '<span id="replacement">New</span>'
        })

        await ypy.__issueRequest(ctx)

        let replacement = find('#replacement')
        assert.isNotNull(replacement)
        assert.isFalse(source.isConnected)
        assert.equal(triggerTarget, replacement)
    })

    it('always triggers ypy:finally:request', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let finallyFired = false
        div.addEventListener('ypy:finally:request', () => finallyFired = true)

        ctx.fetch = async () => { throw new Error('fail') }

        await ypy.__issueRequest(ctx)
        assert.isTrue(finallyFired)
    })

    it('updates ctx.status through request lifecycle', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        let statuses = []
        div.addEventListener('ypy:before:request', () => statuses.push(ctx.status))

        ctx.fetch = async () => {
            statuses.push(ctx.status)
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        await ypy.__issueRequest(ctx)
        statuses.push(ctx.status)

        assert.include(statuses, 'issuing')
        assert.include(statuses, 'swapped')
    })

    it('processes next queued request after completion', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-sync="queue all"></div>')

        let request1Complete = false
        let request2Started = false

        // First request
        let ctx1 = ypy.__createRequestContext(div, new Event('click'))
        ctx1.fetch = async () => {
            await new Promise(r => setTimeout(r, 10))
            request1Complete = true
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        // Second request (should be queued)
        let ctx2 = ypy.__createRequestContext(div, new Event('click'))
        ctx2.fetch = async () => {
            request2Started = true
            return { status: 200, headers: new Headers(), text: async () => '' }
        }

        let p1 = ypy.__issueRequest(ctx1)
        await new Promise(r => setTimeout(r, 5)) // let first request start
        let p2 = ypy.__issueRequest(ctx2)

        await Promise.all([p1, p2])

        assert.isTrue(request1Complete)
        assert.isTrue(request2Started)
    })

    it('aborts request after timeout fires', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-config="timeout:50"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        ctx.fetch = (url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'))
            })
        })

        await ypy.__issueRequest(ctx)
        assert.isTrue(ctx.request.signal.aborted)
        assert.equal(ctx.request.signal.reason, 'timeout')
    })

    it('replace abort does not fire ypy:error', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none" ypy-sync="replace"></div>')
        let ctx1 = ypy.__createRequestContext(div, new Event('click'))
        ctx1.fetch = (url, opts) => new Promise((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
        let ctx2 = ypy.__createRequestContext(div, new Event('click'))
        ctx2.fetch = async () => ({status: 200, headers: new Headers(), text: async () => ''})

        let errorFired = false
        div.addEventListener('ypy:error', () => errorFired = true)

        await Promise.all([ypy.__issueRequest(ctx1), ypy.__issueRequest(ctx2)])
        assert.isFalse(errorFired)
    })

    it('ypy:abort event aborts in-flight request', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        ctx.fetch = (url, opts) => new Promise((_, reject) => {
            setTimeout(() => ypy.trigger(div, 'ypy:abort'), 10)
            opts.signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted', 'AbortError'))
            })
        })

        let errorFired = false
        div.addEventListener('ypy:error', () => errorFired = true)

        await ypy.__issueRequest(ctx)
        assert.isFalse(errorFired)
        assert.isTrue(ctx.request.signal.aborted)
    })

    it('does not crash when scroll target selector matches nothing', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="innerHTML scroll:top scrollTarget:#nonexistent"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        ctx.fetch = async () => ({
            status: 200,
            headers: new Headers(),
            text: async () => '<div>Response</div>'
        })

        let errorFired = false
        div.addEventListener('ypy:error', () => errorFired = true)

        await ypy.__issueRequest(ctx)
        assert.isFalse(errorFired)
    })

    it('does not crash when show target selector matches nothing', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="innerHTML show:top showTarget:#nonexistent"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        ctx.fetch = async () => ({
            status: 200,
            headers: new Headers(),
            text: async () => '<div>Response</div>'
        })

        let errorFired = false
        div.addEventListener('ypy:error', () => errorFired = true)

        await ypy.__issueRequest(ctx)
        assert.isFalse(errorFired)
    })

    it('does not crash when show target is a text node after outerHTML swap', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="outerHTML show:top"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        ctx.fetch = async () => ({
            status: 200,
            headers: new Headers(),
            text: async () => 'Response'
        })

        let errorFired = false
        let onError = () => errorFired = true
        document.addEventListener('ypy:error', onError)

        try {
            await ypy.__issueRequest(ctx)
            assert.isFalse(errorFired)
        } finally {
            document.removeEventListener('ypy:error', onError)
        }
    })

    it('throws clean error for unknown swap style with no extensions', async function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="foobar"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))

        ctx.fetch = async () => ({
            status: 200,
            headers: new Headers(),
            text: async () => '<div>Response</div>'
        })

        let capturedError = null
        div.addEventListener('ypy:error', (e) => capturedError = e.detail.error)

        await ypy.__issueRequest(ctx)
        assert.isNotNull(capturedError)
        assert.include(capturedError.message, 'Unknown swap style')
    })

});
