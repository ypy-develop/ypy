/**
 * Order of events (and request status) of one request, for the cases the core phases
 * must keep identical: success, server error, network failure, abort, timeout, denied
 * confirmation, cancelled request, cancelled swap, out-of-band swap, header redirect and
 * queue admission. The sequences below were recorded on the core BEFORE it was split into
 * phases; a refactor of __issueRequest, swap or __insertContent must not change them.
 *
 * Each token is "<event>|<ctx.status>|<R if the source carries the request class>".
 */
// Recorded before the split into phases. Keys are the test titles.
const GOLDEN = {
    "records a successful request": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a server error": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:response:error|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a network failure": [
        "ypy:before:request|issuing|R",
        "ypy:error|error: TypeError: Failed to fetch|R",
        "ypy:finally:request|error: TypeError: Failed to fetch|R"
    ],
    "records an abort": [
        "ypy:before:request|issuing|R",
        "ypy:request:aborted|issuing|R",
        "ypy:finally:request|error: AbortError: aborted|R"
    ],
    "records a timeout": [
        "ypy:before:request|issuing|R",
        "ypy:request:aborted|issuing|R",
        "ypy:error|error: AbortError: aborted|R",
        "ypy:finally:request|error: AbortError: aborted|R"
    ],
    "records a denied confirmation": [
        "ypy:confirm|issuing|-",
        "ypy:finally:request|issuing|-"
    ],
    "records an accepted confirmation": [
        "ypy:confirm|issuing|-",
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a request cancelled in before:request": [
        "ypy:before:request|issuing|R",
        "ypy:finally:request|issuing|R"
    ],
    "records a swap cancelled in before:swap": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records an out-of-band swap with a main swap": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a history update": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:before:history:update|-|-",
        "ypy:after:history:push|-|-",
        "ypy:after:history:update|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a transition swap": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:viewTransition|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:viewTransition|response received|R",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a header that takes over the response": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:finally:request|issuing|R"
    ],
    "records the YPY-Trigger header after the response": [
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ],
    "records a dropped request as one ypy:request:dropped event": [
        "ypy:request:dropped|created|R"
    ],
    "records a queued request running after the first one": [
        "ypy:before:request|issuing|R",
        "ypy:request:queued|created|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R",
        "ypy:before:request|issuing|R",
        "ypy:before:response|issuing|R",
        "ypy:after:request|issuing|R",
        "ypy:before:swap|response received|R",
        "ypy:before:settle|-|-",
        "ypy:after:settle|-|-",
        "ypy:before:process|-|-",
        "ypy:before:on:init|-|-",
        "ypy:after:process|-|-",
        "ypy:after:swap|response received|R",
        "ypy:finally:swap|response received|R",
        "ypy:finally:request|swapped|R"
    ]
}

describe('request phases: event order', function () {

    let recorded
    let realDispatch
    let realConfirm

    beforeEach(function () {
        setupTest()
        recorded = []
        realDispatch = ypy.__dispatch
        realConfirm = window.confirm
        ypy.__dispatch = function (on, eventName, detail, bubbles) {
            if (eventName.startsWith('ypy:')) {
                let ctx = detail && detail.ctx
                let running = ctx && ctx.sourceElement && ctx.sourceElement.classList &&
                    ctx.sourceElement.classList.contains('ypy-request')
                recorded.push(eventName + '|' + (ctx ? ctx.status : '-') + '|' + (running ? 'R' : '-'))
            }
            return realDispatch.call(this, on, eventName, detail, bubbles)
        }
    })

    afterEach(function () {
        ypy.__dispatch = realDispatch
        window.confirm = realConfirm
        cleanupTest()
    })

    function okFetch(body, init = {}) {
        return async () => ({
            status: init.status || 200,
            headers: new Headers(init.headers || {}),
            text: async () => body
        })
    }

    // a fetch that never answers and rejects the way the browser does when the signal aborts
    function hangingFetch() {
        return (action, request) => new Promise((resolve, reject) => {
            let fail = () => reject(new DOMException('aborted', 'AbortError'))
            if (request.signal.aborted) return fail()
            request.signal.addEventListener('abort', fail)
        })
    }

    function expectEvents(name) {
        let expected = GOLDEN[name]
        // a browser without view transitions runs the tasks without the two events
        if (!document.startViewTransition) expected = expected.filter(e => !/viewTransition/.test(e))
        assert.deepEqual(recorded, expected)
    }

    // creates a processed element and its context; events recorded start after this
    function newRequest(attrs = '', fetchImpl = okFetch('<b>ok</b>')) {
        let div = createProcessedHTML(`<div ypy-get="/phases" ${attrs}>x</div>`)
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        ctx.fetch = fetchImpl
        recorded.length = 0   // forget the events of processing the element
        return {div, ctx}
    }

    it('records a successful request', async function () {
        let {ctx} = newRequest()
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(ctx.status, 'swapped')
    })

    it('records a server error', async function () {
        let {div, ctx} = newRequest('', okFetch('<b>boom</b>', {status: 500}))
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(ctx.status, 'swapped')
        assert.equal(div.innerHTML, '<b>boom</b>')
    })

    it('records a network failure', async function () {
        let {div, ctx} = newRequest('', async () => { throw new TypeError('Failed to fetch') })
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(ctx.status, 'error: TypeError: Failed to fetch')
        assert.equal(div.innerHTML, 'x')
    })

    it('records an abort', async function () {
        let {div, ctx} = newRequest('', hangingFetch())
        div.addEventListener('ypy:before:request', () => ctx.request.abort(), {once: true})
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(ctx.status, 'error: AbortError: aborted')
    })

    it('records a timeout', async function () {
        let {ctx} = newRequest('', hangingFetch())
        ctx.request.timeout = 5
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(ctx.status, 'error: AbortError: aborted')
    })

    it('records a denied confirmation', async function () {
        let {div, ctx} = newRequest('', async () => { throw new Error('must not be called') })
        ctx.confirm = 'sure?'
        window.confirm = () => false
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(ctx.status, 'issuing')
        assert.isFalse(div.classList.contains('ypy-request'))
    })

    it('records an accepted confirmation', async function () {
        let {ctx} = newRequest()
        ctx.confirm = 'sure?'
        window.confirm = () => true
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
    })

    it('records a request cancelled in before:request', async function () {
        let {div, ctx} = newRequest()
        div.addEventListener('ypy:before:request', e => e.preventDefault(), {once: true})
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.isFalse(div.classList.contains('ypy-request'))
    })

    it('records a swap cancelled in before:swap', async function () {
        let {div, ctx} = newRequest()
        div.addEventListener('ypy:before:swap', e => e.preventDefault(), {once: true})
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(div.innerHTML, 'x')
    })

    it('records an out-of-band swap with a main swap', async function () {
        let {ctx} = newRequest('', okFetch('<b>main</b><div id="phases-oob" ypy-swap-oob="true">oob</div>'))
        let oob = document.createElement('div')
        oob.id = 'phases-oob'
        playground().appendChild(oob)
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(document.getElementById('phases-oob').textContent, 'oob')
    })

    it('records a history update', async function () {
        let {ctx} = newRequest()
        ctx.push = '/phases-pushed'
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(location.pathname, '/phases-pushed')
    })

    it('records a transition swap', async function () {
        let {div, ctx} = newRequest('', okFetch('<b>moved</b>'))
        ctx.transition = true
        await ypy.__issueRequest(ctx)
        expectEvents(this.test.title)
        assert.equal(div.innerHTML, '<b>moved</b>')
    })

    it('fires the request events on the original element after the swap replaced it', async function () {
        let {div, ctx} = newRequest('ypy-swap="outerHTML"', okFetch('<b id="phases-new">new</b>'))
        let targets = []
        document.addEventListener('ypy:finally:request', e => targets.push(e.target), {once: true})
        await ypy.__issueRequest(ctx)
        assert.isFalse(div.isConnected)
        assert.isTrue(ctx.sourceElement.isConnected)   // the swap moved ctx.sourceElement to the new element
        assert.deepEqual(targets, [document])          // the detached original reports on document
    })

    it('reaches fetch in the same tick when there is no confirmation', async function () {
        let fetched = false
        let {ctx} = newRequest('', async () => { fetched = true; return {status: 200, headers: new Headers(), text: async () => '' } })
        let running = ypy.__issueRequest(ctx)
        assert.isTrue(fetched)   // before any await of the caller
        await running
    })

    it('records a header that takes over the response', async function () {
        let {ctx} = newRequest('', okFetch('<b>ignored</b>', {headers: {'YPY-Redirect': '/elsewhere'}}))
        let loc = ypy._loc
        let seen = []
        ypy._loc = {set href(v) { seen.push(v) }, reload() {}}
        try {
            await ypy.__issueRequest(ctx)
        } finally {
            ypy._loc = loc
        }
        assert.deepEqual(seen, [location.origin + '/elsewhere'])   // the validated, resolved URL is what is assigned
        expectEvents(this.test.title)
    })

    it('records the YPY-Trigger header after the response', async function () {
        let {ctx} = newRequest('', okFetch('<b>ok</b>', {headers: {'YPY-Trigger': 'phasesDone'}}))
        let fired = false
        document.addEventListener('phasesDone', () => fired = true, {once: true})
        await ypy.__issueRequest(ctx)
        assert.isTrue(fired)
        expectEvents(this.test.title)
    })

    it('records a dropped request as one ypy:request:dropped event', async function () {
        let div = createProcessedHTML('<div ypy-get="/phases" ypy-sync="drop">x</div>')
        let first = ypy.__createRequestContext(div, new Event('click'))
        first.fetch = hangingFetch()
        let running = ypy.__issueRequest(first)
        let second = ypy.__createRequestContext(div, new Event('click'))
        second.fetch = async () => { throw new Error('must not be called') }
        recorded.length = 0
        await ypy.__issueRequest(second)
        expectEvents(this.test.title)
        assert.equal(second.status, 'created')
        first.request.abort()
        await running
    })

    it('records a queued request running after the first one', async function () {
        let div = createProcessedHTML('<div ypy-get="/phases">x</div>')
        let release
        let first = ypy.__createRequestContext(div, new Event('click'))
        first.fetch = () => new Promise(resolve => release = () => resolve({
            status: 200, headers: new Headers(), text: async () => '<i>first</i>'
        }))
        let second = ypy.__createRequestContext(div, new Event('click'))
        second.fetch = okFetch('<i>second</i>')
        recorded.length = 0
        let firstDone = ypy.__issueRequest(first)
        await ypy.__issueRequest(second)
        assert.equal(second.status, 'created')
        release()
        await firstDone
        await new Promise(r => setTimeout(r, 20))
        expectEvents(this.test.title)
        assert.equal(second.status, 'swapped')
        assert.equal(div.innerHTML, '<i>second</i>')
    })
})

/**
 * Order in which the phase methods of one request run. The phases are the contract between the
 * tasks of Phase 1: each task fills the body of its own phase and relies on when it is called.
 */
describe('request phases: phase order', function () {

    const PHASES = [
        '__admitRequest', '__confirmRequest', '__beginRequest', '__markBusy', '__sendRequest',
        '__receiveResponse', '__failRequest', '__endRequest', '__unmarkBusy', '__announce',
        '__buildSwapTasks', '__runSwapTasks', '__finishSwap', '__applyScrollPolicy',
        '__insertContent', '__resolveSwapTarget', '__captureFocus', '__applySwapStyle',
        '__restoreFocus', '__afterInsert'
    ]
    let calls
    let realConfirm

    beforeEach(function () {
        setupTest(this)
        calls = []
        realConfirm = window.confirm
        for (let name of PHASES) {
            let original = ypy[name]
            ypy[name] = function (...args) {
                calls.push({name, args})
                return original.apply(this, args)
            }
        }
    })

    afterEach(function () {
        for (let name of PHASES) delete ypy[name]   // back to the prototype method
        window.confirm = realConfirm
        cleanupTest()
    })

    const names = () => calls.map(c => c.name)

    const MAIN_INSERT = [
        '__buildSwapTasks', '__runSwapTasks', '__markBusy', '__insertContent', '__resolveSwapTarget',
        '__captureFocus', '__applySwapStyle', '__restoreFocus', '__afterInsert', '__finishSwap',
        '__applyScrollPolicy'
    ]
    const START = ['__admitRequest', '__beginRequest', '__markBusy', '__sendRequest']
    const END = ['__endRequest', '__unmarkBusy', '__announce']

    function request(fetchImpl, attrs = '') {
        let div = createProcessedHTML(`<div ypy-get="/phases" ${attrs}>x</div>`)
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        ctx.fetch = fetchImpl
        return {div, ctx}
    }

    const answer = (status = 200, body = '<b>ok</b>') => async () => ({
        status, headers: new Headers(), text: async () => body
    })

    it('runs every phase of a successful request in order', async function () {
        let {ctx} = request(answer())
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), [...START, '__receiveResponse', ...MAIN_INSERT, ...END])
    })

    it('swaps an error response like any other', async function () {
        let {ctx} = request(answer(500, '<b>boom</b>'))
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), [...START, '__receiveResponse', ...MAIN_INSERT, ...END])
    })

    it('fails a request whose fetch rejects', async function () {
        let {ctx} = request(async () => { throw new TypeError('Failed to fetch') })
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), [...START, '__failRequest', ...END])
    })

    it('fails an aborted request', async function () {
        let {ctx} = request((action, req) => Promise.reject(new DOMException('aborted', 'AbortError')))
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), [...START, '__failRequest', ...END])
    })

    it('stops before beginning when the confirmation is denied', async function () {
        let {ctx} = request(answer())
        ctx.confirm = 'sure?'
        window.confirm = () => false
        await ypy.__issueRequest(ctx)
        // __unmarkBusy runs without a __markBusy before it: a hook must accept that
        assert.deepEqual(names(), ['__admitRequest', '__confirmRequest', ...END])
    })

    it('goes on after a confirmation', async function () {
        let {ctx} = request(answer())
        ctx.confirm = 'sure?'
        window.confirm = () => true
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), ['__admitRequest', '__confirmRequest', ...START.slice(1), '__receiveResponse', ...MAIN_INSERT, ...END])
    })

    it('stops after sending when before:request is cancelled', async function () {
        let {div, ctx} = request(answer())
        div.addEventListener('ypy:before:request', e => e.preventDefault(), {once: true})
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), [...START, ...END])
    })

    it('stops after receiving when a header takes over', async function () {
        let {ctx} = request(async () => ({status: 200, headers: new Headers({'YPY-Redirect': '/x'}), text: async () => ''}))
        let loc = ypy._loc
        ypy._loc = {set href(v) {}, reload() {}}
        try {
            await ypy.__issueRequest(ctx)
        } finally {
            ypy._loc = loc
        }
        assert.deepEqual(names(), [...START, '__receiveResponse', ...END])
        assert.isTrue(ctx.keepIndicators)
    })

    it('stops after building the tasks when before:swap is cancelled', async function () {
        let {div, ctx} = request(answer())
        div.addEventListener('ypy:before:swap', e => e.preventDefault(), {once: true})
        await ypy.__issueRequest(ctx)
        assert.deepEqual(names(), [...START, '__receiveResponse', '__buildSwapTasks', ...END])
    })

    it('does not enter the swap phases for a dropped request', async function () {
        let div = createProcessedHTML('<div ypy-get="/phases" ypy-sync="drop">x</div>')
        let first = ypy.__createRequestContext(div, new Event('click'))
        first.fetch = (action, req) => new Promise((resolve, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        let running = ypy.__issueRequest(first)
        calls.length = 0
        let second = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__issueRequest(second)
        assert.deepEqual(names(), ['__admitRequest'])
        first.request.abort()
        await running
    })

    it('passes the context to the busy, announce and scroll hooks', async function () {
        let {ctx} = request(answer())
        ctx.scroll = 'top'
        await ypy.__issueRequest(ctx)
        for (let name of ['__markBusy', '__unmarkBusy', '__announce']) {
            let call = calls.find(c => c.name === name)
            assert.strictEqual(call.args[0], ctx, name)
        }
        let scroll = calls.find(c => c.name === '__applyScrollPolicy')
        assert.strictEqual(scroll.args[0], ctx)
        assert.equal(scroll.args[1], 'top')
    })

    it('hands the original element and the error to __failRequest', async function () {
        let {div, ctx} = request(async () => { throw new TypeError('Failed to fetch') })
        await ypy.__issueRequest(ctx)
        let [failedCtx, error, elt] = calls.find(c => c.name === '__failRequest').args
        assert.strictEqual(failedCtx, ctx)
        assert.instanceOf(error, TypeError)
        assert.strictEqual(elt, div)
    })

    it('gives the queue slot back when the request ends', async function () {
        let {div, ctx} = request(answer())
        await ypy.__issueRequest(ctx)
        // a second request on the same element is admitted straight away
        let next = ypy.__createRequestContext(div, new Event('click'))
        next.fetch = answer()
        calls.length = 0
        await ypy.__issueRequest(next)
        assert.equal(next.status, 'swapped')
    })

    it('runs an out-of-band task through the insert phases as well', async function () {
        let {ctx} = request(answer(200, '<b>main</b><div id="phases-oob2" ypy-swap-oob="true">oob</div>'))
        let oob = document.createElement('div')
        oob.id = 'phases-oob2'
        playground().appendChild(oob)
        await ypy.__issueRequest(ctx)
        assert.equal(names().filter(n => n === '__insertContent').length, 2)
        assert.equal(names().filter(n => n === '__afterInsert').length, 2)
    })

    it('stops inserting at a delete swap, before focus and settle', async function () {
        let {div, ctx} = request(answer(200, ''), 'ypy-swap="delete"')
        ctx.swap = 'delete'
        await ypy.__issueRequest(ctx)
        let insert = names().slice(names().indexOf('__insertContent'))
        assert.deepEqual(insert.slice(0, 2), ['__insertContent', '__resolveSwapTarget'])
        assert.notInclude(names(), '__applySwapStyle')
        assert.notInclude(names(), '__afterInsert')
        assert.isFalse(div.isConnected)
    })

    it('does not insert when the swap style is none', async function () {
        let {ctx} = request(answer())
        ctx.swap = 'none'
        await ypy.__issueRequest(ctx)
        assert.notInclude(names(), '__captureFocus')
        assert.notInclude(names(), '__afterInsert')
    })

    it('does not insert when the target is missing', async function () {
        let {div, ctx} = request(answer())
        await ypy.__issueRequest(ctx)   // warm up
        calls.length = 0
        let task = {type: 'main', fragment: document.createDocumentFragment(), target: '#no-such-element', swapSpec: 'innerHTML'}
        await ypy.__insertContent(task)
        assert.deepEqual(names(), ['__insertContent', '__resolveSwapTarget'])
    })
})

describe('swap phases', function () {

    beforeEach(function () { setupTest(this) })
    afterEach(function () { cleanupTest() })

    it('__buildSwapTasks puts the main task first and returns it', function () {
        let div = createProcessedHTML('<div ypy-get="/x"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        ctx.text = '<title>t</title><i>main</i><div id="phases-o3" ypy-swap-oob="true">o</div>'
        let o = document.createElement('div'); o.id = 'phases-o3'; playground().appendChild(o)
        let [tasks, mainSwap] = ypy.__buildSwapTasks(ctx)
        assert.equal(tasks.length, 2)
        assert.strictEqual(tasks[0], mainSwap)
        assert.equal(mainSwap.type, 'main')
        assert.equal(tasks[1].type, 'oob')
        assert.equal(ctx.title, 't')
    })

    it('__buildSwapTasks has no main task when only an out-of-band element was sent', function () {
        let div = createProcessedHTML('<div ypy-get="/x"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        ctx.text = '<div id="phases-o4" ypy-swap-oob="true">o</div>'
        let o = document.createElement('div'); o.id = 'phases-o4'; playground().appendChild(o)
        let [tasks, mainSwap] = ypy.__buildSwapTasks(ctx)
        assert.equal(tasks.length, 1)
        assert.isUndefined(mainSwap)
    })

    it('__resolveSwapTarget looks a selector up in the document and returns an element as is', function () {
        let div = createProcessedHTML('<div id="phases-t1">x</div>')
        assert.strictEqual(ypy.__resolveSwapTarget({target: '#phases-t1'}), div)
        assert.strictEqual(ypy.__resolveSwapTarget({target: div}), div)
        assert.isNull(ypy.__resolveSwapTarget({target: '#phases-none'}))
    })

    it('__captureFocus remembers a focused element with an id in an in-place swap', function () {
        let input = createProcessedHTML('<input id="phases-f1" value="hello">')
        input.focus()
        input.setSelectionRange(1, 3)
        let info = ypy.__captureFocus('innerHTML', playground())
        assert.strictEqual(info.elt, input)
        assert.equal(info.start, 1)
        assert.equal(info.end, 3)
        assert.isUndefined(ypy.__captureFocus('beforeend', playground()))
        assert.isUndefined(ypy.__captureFocus('outerHTML', null))
    })

    it('__restoreFocus puts the focus on the element with the same id', function () {
        let input = createProcessedHTML('<input id="phases-f2" value="hello">')
        input.focus()
        let info = ypy.__captureFocus('innerHTML', playground())
        playground().innerHTML = '<input id="phases-f2" value="hello">'
        let fresh = playground().firstElementChild
        assert.notEqual(document.activeElement, fresh)
        ypy.__restoreFocus(info, {})
        assert.equal(document.activeElement, fresh)
        ypy.__restoreFocus(undefined, {})   // nothing to restore, no error
    })

    it('__applySwapStyle returns the new target of an outerHTML swap and the inserted nodes', function () {
        let div = createProcessedHTML('<div id="phases-s1">old</div>')
        let fragment = document.createRange().createContextualFragment('<p id="phases-s2">new</p>')
        let [target, newContent] = ypy.__applySwapStyle(div, 'outerHTML', {style: 'outerHTML'}, fragment, playground())
        assert.equal(target.id, 'phases-s2')
        assert.equal(newContent.length, 1)
        assert.strictEqual(newContent[0], target)
    })

    it('__applySwapStyle throws for an unknown style and clears the swapping class', function () {
        let div = createProcessedHTML('<div>old</div>')
        ypy.__addClass(div, 'swapping')
        let fragment = document.createDocumentFragment()
        assert.throws(() => ypy.__applySwapStyle(div, 'nonsense', {style: 'nonsense'}, fragment, playground()), 'Unknown swap style')
        assert.isFalse(div.classList.contains('ypy-swapping'))
    })
})

describe('start-up hooks', function () {

    beforeEach(function () { setupTest(this) })

    it('initialize runs the history, offline and a11y hooks, then processes the body', function () {
        let order = []
        for (let name of ['__initHistory', '__initOffline', '__initA11y', 'process']) {
            let original = ypy[name]
            ypy[name] = function (...args) { order.push(name); return original.apply(this, args) }
        }
        try {
            ypy.initialize()
        } finally {
            for (let name of ['__initHistory', '__initOffline', '__initA11y', 'process']) delete ypy[name]
            cleanupTest()
        }
        assert.deepEqual(order.slice(0, 4), ['__initHistory', '__initOffline', '__initA11y', 'process'])
    })

    it('initialize can be called again: the history listeners are registered once', function () {
        let added = 0
        let realAdd = window.addEventListener
        let nav = window.navigation
        let realNavAdd = nav && nav.addEventListener
        window.addEventListener = function (type, ...rest) { if (type === 'popstate') added++; return realAdd.call(this, type, ...rest) }
        if (nav) nav.addEventListener = function (type, ...rest) { if (type === 'navigate') added++; return realNavAdd.call(this, type, ...rest) }
        try {
            ypy.initialize()
            ypy.initialize()
        } finally {
            window.addEventListener = realAdd
            if (nav) nav.addEventListener = realNavAdd
            cleanupTest()
        }
        assert.equal(added, 0)   // already registered by the first initialize at page load
    })
})

describe('shared utilities', function () {

    afterEach(function () { cleanupTest() })

    describe('__setState', function () {

        beforeEach(function () { setupTest(this) })

        it('adds the configured classes and the data-ypy-state token', function () {
            let div = createProcessedHTML('<div></div>')
            ypy.__setState(div, 'request', true)
            assert.isTrue(div.classList.contains('ypy-request'))
            assert.equal(div.getAttribute('data-ypy-state'), 'request')
        })

        it('keeps several states and removes them one by one', function () {
            let div = createProcessedHTML('<div></div>')
            ypy.__setState(div, 'request', true)
            ypy.__setState(div, 'swapping', true)
            assert.equal(div.getAttribute('data-ypy-state'), 'request swapping')
            ypy.__setState(div, 'request', false)
            assert.equal(div.getAttribute('data-ypy-state'), 'swapping')
            assert.isFalse(div.classList.contains('ypy-request'))
            assert.isTrue(div.classList.contains('ypy-swapping'))
            ypy.__setState(div, 'swapping', false)
            assert.isFalse(div.hasAttribute('data-ypy-state'))
            assert.isFalse(div.hasAttribute('class'))
        })

        it('does not repeat a token that is turned on twice', function () {
            let div = createProcessedHTML('<div></div>')
            ypy.__setState(div, 'request', true)
            ypy.__setState(div, 'request', true)
            assert.equal(div.getAttribute('data-ypy-state'), 'request')
        })

        it('turning off a state that is not on changes nothing', function () {
            let div = createProcessedHTML('<div class="keep"></div>')
            ypy.__setState(div, 'request', false)
            assert.isFalse(div.hasAttribute('data-ypy-state'))
            assert.equal(div.className, 'keep')
        })

        it('uses the class names configured for the state', function () {
            let saved = ypy.config.classes
            ypy.config.classes = {...saved, busy: 'is-busy my-busy'}
            try {
                let div = createProcessedHTML('<div></div>')
                ypy.__setState(div, 'busy', true)
                assert.equal(div.className, 'is-busy my-busy')
                assert.equal(div.getAttribute('data-ypy-state'), 'busy')
                ypy.__setState(div, 'busy', false)
                assert.isFalse(div.hasAttribute('class'))
            } finally {
                ypy.config.classes = saved
            }
        })

        it('still sets the attribute for a state without configured classes', function () {
            let div = createProcessedHTML('<div></div>')
            ypy.__setState(div, 'offline', true)
            assert.equal(div.getAttribute('data-ypy-state'), 'offline')
            assert.equal(div.classList.length, 0)
        })

        it('ignores a missing element', function () {
            ypy.__setState(null, 'request', true)
            ypy.__setState(undefined, 'request', false)
        })
    })

    describe('__triggerNative', function () {

        beforeEach(function () { setupTest(this) })

        it('passes the detail and bubbles', function () {
            let div = createProcessedHTML('<div></div>')
            let detail
            document.addEventListener('ypy:thing:happen', e => detail = e.detail, {once: true})
            ypy.__triggerNative(div, 'ypy:thing:happen', {a: 1})
            assert.equal(detail.a, 1)
        })

        it('returns false when a listener cancels', function () {
            let div = createProcessedHTML('<div></div>')
            div.addEventListener('ypy:thing:happen', e => e.preventDefault())
            assert.isFalse(ypy.__triggerNative(div, 'ypy:thing:happen'))
        })

        it('runs the extension hook first and honors its cancel', function () {
            let div = createProcessedHTML('<div></div>')
            let backup = backupExtensions()
            let fired = false
            div.addEventListener('ypy:thing:happen', () => fired = true)
            try {
                ypy.__extMethods.set('ypy_thing_happen', [() => false])
                assert.isFalse(ypy.__triggerNative(div, 'ypy:thing:happen'))
                assert.isFalse(fired)
            } finally {
                restoreExtensions(backup)
            }
        })

        it('accepts a selector for the element', function () {
            let div = createProcessedHTML('<div id="phases-native-sel"></div>')
            let fired = false
            div.addEventListener('ypy:thing:happen', () => fired = true)
            ypy.__triggerNative('#phases-native-sel', 'ypy:thing:happen')
            assert.isTrue(fired)
        })

        it('logs a warn detail at warn level, an error detail at error level, and the rest with logAll', function () {
            let div = createProcessedHTML('<div></div>')
            let realWarn = console.warn, realError = console.error, realLog = console.log
            let out = []
            console.warn = (...a) => out.push(['warn', a[0]])
            console.error = (...a) => out.push(['error', a[0]])
            console.log = (...a) => out.push(['log', a[0]])
            let savedLogAll = ypy.config.logAll
            try {
                ypy.__triggerNative(div, 'ypy:thing:happen', {warn: 'careful'})
                ypy.__triggerNative(div, 'ypy:thing:happen', {error: new Error('bad')})
                ypy.__triggerNative(div, 'ypy:thing:happen', {})
                ypy.config.logAll = true
                ypy.__triggerNative(div, 'ypy:thing:happen', {})
            } finally {
                console.warn = realWarn; console.error = realError; console.log = realLog
                ypy.config.logAll = savedLogAll
            }
            assert.deepEqual(out, [
                ['warn', 'ypy: ypy:thing:happen'],
                ['error', 'ypy: ypy:thing:happen'],
                ['log', 'ypy: ypy:thing:happen']
            ])
        })
    })
})
