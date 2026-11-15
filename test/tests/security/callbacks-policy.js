// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

describe('config.callbacks policy', function() {

    let blocked

    function onBlocked(event) { blocked.push(event.detail) }

    beforeEach(function() {
        blocked = []
        window.pwned = 0
        document.addEventListener('ypy:security:blocked', onBlocked)
    })

    afterEach(function() {
        document.removeEventListener('ypy:security:blocked', onBlocked)
        delete ypy.config.callbacks
        delete window.pwned
        cleanupTest()
    })

    describe('the default', function() {

        itSource('author code is off and the policy is "none"', function() {
            setupTest(this, {authorCode: false})
            assert.equal(ypy.__callbacksPolicy(), 'none')
        })

        itSource('an explicit value beats the default in both directions', function() {
            setupTest(this, {authorCode: false})
            ypy.config.callbacks = 'all'
            assert.equal(ypy.__callbacksPolicy(), 'all')
            ypy.config.callbacks = 'none'
            assert.equal(ypy.__callbacksPolicy(), 'none')
        })

        itSource('an unknown value counts as "none" (fail closed)', function() {
            setupTest(this)
            for (let bad of ['yes', 'ALL', true, false, 1, '']) {
                ypy.config.callbacks = bad
                assert.equal(ypy.__callbacksPolicy(), 'none', JSON.stringify(bad))
            }
        })
    })

    describe('callbacks "none" (the default) compiles nothing', function() {

        beforeEach(function() {
            setupTest(this, {authorCode: false})
        })

        it('ypy-on does not run and fires ypy:security:blocked', function() {
            let button = createProcessedHTML('<button ypy-on:click="window.pwned++">Go</button>')
            button.click()
            assert.equal(window.pwned, 0)
            assert.equal(blocked.length, 1)
            assert.equal(blocked[0].reason, 'callbacks-none')
            assert.include(blocked[0].code, 'window.pwned++')
        })

        it('the multi-line ypy-on form does not run either', function() {
            let button = createProcessedHTML('<button ypy-on="click -> window.pwned++">Go</button>')
            button.click()
            assert.equal(window.pwned, 0)
            assert.equal(blocked.length, 1)
        })

        it('a js: value in ypy-vals is dropped and the request still goes out', async function() {
            mockResponse('POST', '/vars', 'ok')
            let button = createProcessedHTML('<button ypy-post="/vars" ypy-vals="js:{a: (window.pwned++, 1)}">Go</button>')
            button.click()
            await forRequest()
            assert.equal(window.pwned, 0)
            assert.isFalse(fetchMock.calls[0].request.body.has('a'))
            assert.equal(blocked.length, 1)
        })

        it('a js: value in ypy-headers is dropped', async function() {
            mockResponse('GET', '/h', 'ok')
            let button = createProcessedHTML('<button ypy-get="/h" ypy-headers="js:{X-Pwn: (window.pwned++, 1)}">Go</button>')
            button.click()
            await forRequest()
            assert.equal(window.pwned, 0)
            assert.notProperty(fetchMock.calls[0].request.headers, 'X-Pwn')
        })

        it('a js: ypy-confirm denies the request instead of confirming it', async function() {
            mockResponse('GET', '/c', 'ok')
            let button = createProcessedHTML('<button ypy-get="/c" ypy-confirm="js:(window.pwned++, true)">Go</button>')
            button.click()
            await forRequest()
            assert.equal(window.pwned, 0)
            assert.equal(fetchMock.calls.length, 0)
            assert.equal(blocked.length, 1)
        })

        it('a js: action does not run', async function() {
            let button = createProcessedHTML('<button ypy-get="js:window.pwned++">Go</button>')
            button.click()
            await ypy.timeout(30)
            assert.equal(window.pwned, 0)
            assert.equal(blocked.length, 1)
        })

        it('a [filter] on ypy-trigger never passes, so the request is not sent', async function() {
            mockResponse('GET', '/f', 'ok')
            let button = createProcessedHTML('<button ypy-get="/f" ypy-trigger="click[(window.pwned++, true)]">Go</button>')
            button.click()
            await ypy.timeout(30)
            assert.equal(window.pwned, 0)
            assert.equal(fetchMock.calls.length, 0)
            assert.equal(blocked.length, 1)
        })

        it('markup that arrives in a response gets no code either (injection)', async function() {
            mockResponse('GET', '/inject', '<img src="data:," ypy-on:error="window.pwned++"><b ypy-on:click="window.pwned++" id="victim">x</b>')
            let button = createProcessedHTML('<button ypy-get="/inject" ypy-target="#out">Go</button><div id="out"></div>')
            button.click()
            await forRequest()
            await ypy.timeout(30)
            find('#victim').click()
            assert.equal(window.pwned, 0)
        })

        it('the same injected markup runs when callbacks is "all", which is what the default prevents', async function() {
            setupTest(this)
            mockResponse('GET', '/inject', '<b ypy-on:click="window.pwned++" id="victim">x</b>')
            let button = createProcessedHTML('<button ypy-get="/inject" ypy-target="#out">Go</button><div id="out"></div>')
            button.click()
            await forRequest()
            find('#victim').click()
            assert.equal(window.pwned, 1)
        })

        itSource('compile mode returns a function that does nothing', function() {
            let run = ypy.__executeJavaScript(document.body, {}, 'window.pwned++', true, false, true)
            assert.isFunction(run)
            assert.isUndefined(run())
            assert.equal(window.pwned, 0)
        })

        itSource('async calls return a promise and sync calls return undefined', async function() {
            let promise = ypy.__executeJavaScript(document.body, {}, 'window.pwned++', false)
            assert.instanceOf(promise, Promise)
            assert.isUndefined(await promise)
            assert.isUndefined(ypy.__executeJavaScript(document.body, {}, 'window.pwned++', true, false))
            assert.equal(window.pwned, 0)
        })

        itSource('does not consult the scope hook, so extensions never see the code', function() {
            let saw = false
            let backup = backupExtensions()
            ypy.__extMethods.set('ypy_scope', [() => { saw = true }])
            try {
                ypy.__executeJavaScript(document.body, {}, '1', true, false)
            } finally {
                restoreExtensions(backup)
            }
            assert.isFalse(saw)
        })
    })

    describe('callbacks "all"', function() {

        it('runs ypy-on, js: values and [filter] triggers', async function() {
            setupTest(this)
            ypy.config.callbacks = 'all'
            mockResponse('POST', '/vars', 'ok')
            let button = createProcessedHTML('<button ypy-post="/vars" ypy-vals="js:{a: 1}" ypy-trigger="click[true]" ypy-on:click="window.pwned++">Go</button>')
            button.click()
            await forRequest()
            assert.equal(window.pwned, 1)
            assert.equal(fetchMock.calls[0].request.body.get('a'), '1')
            assert.equal(blocked.length, 0)
        })
    })

    describe('callbacks "nonce"', function() {

        it('blocks everything while no nonce extension is installed', function() {
            setupTest(this)
            ypy.config.callbacks = 'nonce'
            let button = createProcessedHTML('<button ypy-on:click="window.pwned++">Go</button>')
            button.click()
            assert.equal(window.pwned, 0)
            assert.equal(blocked.length, 1)
            assert.equal(blocked[0].reason, 'callbacks-nonce')
        })
    })

    describe('the one-time warning', function() {

        it('is logged once however many calls are blocked, the event fires every time', async function() {
            let page = await openPage({scripts: ['/src/ypy.js'], body: '<button id="b" ypy-on:click="1">x</button>'})
            try {
                let events = 0
                page.doc.addEventListener('ypy:security:blocked', () => events++)
                page.win.ypy.process(page.doc.body)
                for (let i = 0; i < 3; i++) page.doc.getElementById('b').click()
                assert.equal(events, 3)
                let warnings = page.logs.filter(l => l.includes('author code is off'))
                assert.equal(warnings.length, 1, page.logs.join('\n'))
                assert.include(warnings[0], 'config.callbacks is "none"')
            } finally {
                page.close()
            }
        })
    })

    describe('performance', function() {

        itSource('compiles the same code once and still reads fresh values on every call', function() {
            setupTest(this)
            let elt = document.createElement('div')
            let compiled = 0
            let backup = ypy.__extMethods.get('ypy_scope')
            // the scope hook runs on every call, the compile does not
            ypy.__extMethods.set('ypy_scope', [() => { compiled++ }])
            try {
                let results = []
                for (let i = 0; i < 5; i++) results.push(ypy.__executeJavaScript(elt, {value: i}, 'value * 2', true, false))
                assert.deepEqual(results, [0, 2, 4, 6, 8])
                assert.equal(compiled, 5)
            } finally {
                if (backup) ypy.__extMethods.set('ypy_scope', backup); else ypy.__extMethods.delete('ypy_scope')
            }
        })

        itSource('does not mix up code whose variable names differ', function() {
            setupTest(this)
            let elt = document.createElement('div')
            assert.equal(ypy.__executeJavaScript(elt, {a: 1}, 'typeof b', true, false), 'undefined')
            assert.equal(ypy.__executeJavaScript(elt, {a: 1, b: 2}, 'typeof b', true, false), 'number')
            assert.equal(ypy.__executeJavaScript(elt, {b: 3}, 'b', true, false), 3)
        })

        itSource('keeps `this`, find and findAll bound to the element of each call', function() {
            setupTest(this)
            let one = createProcessedHTML('<div id="one"><i class="x"></i></div>')
            let two = document.createElement('div')
            two.id = 'two'
            playground().appendChild(two)
            assert.equal(ypy.__executeJavaScript(one, {}, 'this.id', true, false), 'one')
            assert.equal(ypy.__executeJavaScript(two, {}, 'this.id', true, false), 'two')
            assert.equal(ypy.__executeJavaScript(one, {}, 'find(".x").tagName', true, false), 'I')
            assert.equal(ypy.__executeJavaScript(two, {}, '!find(this, ".y")', true, false), true)
            assert.equal(ypy.__executeJavaScript(one, {}, 'findAll(".x").length', true, false), 1)
        })

        itSource('treats a variable name that is not an identifier as the uncached call does', function() {
            setupTest(this)
            let elt = document.createElement('div')
            // form data can name a field anything: the compile fails, and fails every time
            for (let i = 0; i < 2; i++) {
                assert.throws(() => ypy.__executeJavaScript(elt, {'a b': 1}, '1', true, false))
            }
            // "a,b" reads as two parameters, in the cached call as in the first one
            for (let i = 0; i < 2; i++) {
                assert.equal(ypy.__executeJavaScript(elt, {'a,b': 5}, 'a + String(b)', true, false), '5undefined')
            }
            assert.equal(ypy.__executeJavaScript(elt, {a: 1, b: 2}, 'a + b', true, false), 3)
        })
    })
})
