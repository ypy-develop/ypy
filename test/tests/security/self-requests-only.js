// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// selfRequestsOnly is on by default: every request carries fetch mode "same-origin", so the browser
// refuses to send it to another origin, and nothing per element can change that.
describe('selfRequestsOnly (fetch mode same-origin)', function() {

    beforeEach(function() {
        setupTest(this)
    })

    afterEach(function() {
        ypy.config.mode = 'same-origin'
        cleanupTest()
    })

    it('is the default, and selfRequestsOnly reads as true', function() {
        assert.equal(ypy.config.mode, 'same-origin')
        assert.isTrue(ypy.config.selfRequestsOnly)
    })

    it('every request goes out with mode same-origin and same-origin credentials', async function() {
        mockResponse('GET', '/test', 'ok')
        let button = createProcessedHTML('<button ypy-get="/test">Go</button>')
        button.click()
        await forRequest()
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
        assert.equal(fetchMock.calls[0].request.credentials, 'same-origin')
    })

    it('an absolute URL to another origin is still sent with mode same-origin', async function() {
        mockResponse('GET', 'https://other.example/steal', 'ok')
        let button = createProcessedHTML('<button ypy-get="https://other.example/steal">Go</button>')
        button.click()
        await forRequest()
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
    })

    it('selfRequestsOnly = false means mode cors and back', async function() {
        ypy.config.selfRequestsOnly = false
        assert.equal(ypy.config.mode, 'cors')
        mockResponse('GET', '/test', 'ok')
        let button = createProcessedHTML('<button ypy-get="/test">Go</button>')
        button.click()
        await forRequest()
        assert.equal(fetchMock.calls[0].request.mode, 'cors')
        ypy.config.selfRequestsOnly = true
        assert.equal(ypy.config.mode, 'same-origin')
    })

    it('ypy-config on the element cannot change the mode', async function() {
        mockResponse('GET', '/test', 'ok')
        let button = createProcessedHTML(`<button ypy-get="/test" ypy-config='{"mode": "cors"}'>Go</button>`)
        button.click()
        await forRequest()
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
    })

    it('ypy-config cannot change the mode to no-cors either', async function() {
        mockResponse('GET', '/test', 'ok')
        let button = createProcessedHTML(`<button ypy-get="/test" ypy-config='mode:"no-cors"'>Go</button>`)
        button.click()
        await forRequest()
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
    })

    // The boost value is merged into the whole request context, so a `request.mode` written in
    // the attribute used to land on the request after the mode was set. The core pins the mode in
    // a ypy:config:request hook that runs before any page listener.
    it('ypy-boost on the element cannot change the mode', async function() {
        mockResponse('GET', '/test', 'ok')
        let link = createProcessedHTML(`<a ypy-boost='request.mode:"cors"' ypy-target="#t" href="/test">Go</a><div id="t"></div>`)
        link.click()
        await forRequest()
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
    })

    it('a page listener on ypy:config:request can still choose the mode on purpose', async function() {
        mockResponse('GET', '/test', 'ok')
        let button = createProcessedHTML('<button ypy-get="/test">Go</button>')
        let listener = event => { event.detail.ctx.request.mode = 'cors' }
        document.addEventListener('ypy:config:request', listener)
        try {
            button.click()
            await forRequest()
        } finally {
            document.removeEventListener('ypy:config:request', listener)
        }
        assert.equal(fetchMock.calls[0].request.mode, 'cors')
    })

    it('ajax() with a request option keeps the mode', async function() {
        mockResponse('GET', '/test', 'ok')
        let target = createProcessedHTML('<div></div>')
        await ypy.ajax('GET', '/test', {target, request: {headers: {'X-A': '1'}}})
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
    })

    // Found by reading the code: ajax() replaces ctx.request when options.request is given, which
    // drops credentials, validate and abort as well. ajax() belongs to TASK-016.
    it('ajax() with a request option keeps credentials and abort', async function() {
        mockResponse('GET', '/test', 'ok')
        let target = createProcessedHTML('<div></div>')
        await ypy.ajax('GET', '/test', {target, request: {headers: {'X-A': '1'}}})
        assert.equal(fetchMock.calls[0].request.credentials, 'same-origin')
        assert.isFunction(fetchMock.calls[0].request.abort)
    })

    it('ajax() without a request option keeps the mode', async function() {
        mockResponse('GET', '/test', 'ok')
        let target = createProcessedHTML('<div></div>')
        await ypy.ajax('GET', '/test', {target})
        assert.equal(fetchMock.calls[0].request.mode, 'same-origin')
    })

    describe('in a real browser request', function() {

        let page
        afterEach(function() { page?.close(); page = null })

        it('a request to another origin is refused by the browser before it leaves', async function() {
            page = await openPage({body: '<button id="b" ypy-get="https://other.example/steal">Go</button>'})
            let requested = []
            let observer = new page.win.PerformanceObserver(list => requested.push(...list.getEntries().map(e => e.name)))
            observer.observe({type: 'resource'})
            let failed = new Promise(resolve => page.doc.addEventListener('ypy:error', resolve, {once: true}))
            let after = 0
            page.doc.addEventListener('ypy:after:request', () => after++)
            page.win.ypy.process(page.doc.body)
            page.doc.getElementById('b').click()
            let event = await failed
            assert.isOk(event.detail.error)
            assert.equal(after, 0)
            assert.isFalse(requested.some(url => url.includes('other.example')))
        })
    })
})
