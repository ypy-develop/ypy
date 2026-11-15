// SPDX-License-Identifier: MIT
describe('ypy events', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('ypy:before:request fires on sourceElement', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let firedOnSource = false
        div.addEventListener('ypy:before:request', () => firedOnSource = true)
        div.click();
        await forRequest()
        assert.isTrue(firedOnSource)
    })

    it('ypy:after:request fires on sourceElement', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let firedOnSource = false
        div.addEventListener('ypy:after:request', () => firedOnSource = true)
        div.click()
        await forRequest()
        assert.isTrue(firedOnSource)
    })

    it('ypy:before:swap fires on sourceElement', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let firedOnSource = false
        div.addEventListener('ypy:before:swap', () => firedOnSource = true)
        div.click()
        await forRequest()
        assert.isTrue(firedOnSource)
    })

    it('ypy:after:swap fires on sourceElement', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let firedOnSource = false
        div.addEventListener('ypy:after:swap', () => firedOnSource = true)
        div.click()
        await forRequest()
        assert.isTrue(firedOnSource)
    })

    it('ypy:after:swap does not fire on element removed from DOM by swap', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="outerHTML"></div>')
        let firedOnSource = false
        div.addEventListener('ypy:after:swap', () => firedOnSource = true)
        div.click()
        await forRequest()
        assert.isFalse(firedOnSource)
    })

    it('ypy:after:swap triggers on replacement element when source is removed by outerHTML swap', async function () {
        mockResponse('GET', '/test', '<span id="replacement">Response</span>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="outerHTML"></div>')
        let swapTarget = null
        document.addEventListener('ypy:after:swap', (e) => {
            swapTarget = e.target
        }, {once: true})
        div.click()
        await forRequest()
        let replacement = find('#replacement')
        assert.isNotNull(replacement)
        assert.equal(swapTarget, replacement)
    })


    it('events bubble from sourceElement to document', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let bubbledToDocument = false
        document.addEventListener('ypy:before:request', (e) => {
            if (e.target === div) {
                bubbledToDocument = true
            }
        }, {once: true})
        div.click()
        await forRequest()
        assert.isTrue(bubbledToDocument)
    })

    it('ypy:before:response fires with ctx after fetch', async function () {
        mockResponse('GET', '/test', 'Response')
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let firedCtx = null
        div.addEventListener('ypy:before:response', (e) => {
            firedCtx = e.detail.ctx
        })
        div.click()
        await forRequest()
        assert.isNotNull(firedCtx, 'should fire with ctx')
        assert.equal(firedCtx.response.status, 200)
    })

    it('ypy:before:response cancellation prevents swap', async function () {
        mockResponse('GET', '/test', 'Should not appear')
        let div = createProcessedHTML('<div ypy-get="/test">Original</div>')
        div.addEventListener('ypy:before:response', (e) => {
            e.preventDefault()
        })
        div.click()
        await forRequest()
        assertTextContentIs('div', 'Original')
    })

    it('ypy:response:error fires on HTTP 4xx/5xx', async function () {
        fetchMock.mockErrorResponse('GET', '/test', 500, 'Internal Server Error')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let errorStatus = null
        div.addEventListener('ypy:response:error', (e) => {
            errorStatus = e.detail.ctx.response.status
        })
        div.click()
        await forRequest()
        assert.equal(errorStatus, 500)
    })

    it('ypy:response:error does not fire on HTTP 2xx', async function () {
        mockResponse('GET', '/test', 'OK')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let fired = false
        div.addEventListener('ypy:response:error', () => { fired = true })
        div.click()
        await forRequest()
        assert.isFalse(fired)
    })

    it('YPY-Trigger header with null event detail does not throw', async function () {
        fetchMock.mockResponse('GET', '/test', new Response('OK', {
            headers: { 'YPY-Trigger': '{"resetForm":null}' }
        }))
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let errorFired = false
        div.addEventListener('ypy:error', () => { errorFired = true })
        div.click()
        await forRequest()
        assert.isFalse(errorFired)
    })

    it('YPY-Trigger header fires event with null detail alongside object detail', async function () {
        fetchMock.mockResponse('GET', '/test', new Response('OK', {
            headers: { 'YPY-Trigger': '{"resetForm":null,"showMessage":{"level":"success"}}' }
        }))
        let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>')
        let showMessageDetail = null
        document.addEventListener('showMessage', (e) => { showMessageDetail = e.detail }, {once: true})
        div.click()
        await forRequest()
        assert.deepEqual(showMessageDetail, { level: 'success' })
    })

    // The order a listener can rely on: settle belongs to each task, so it fires for every task
    // before the single ypy:after:swap of the whole swap. See guides/events.md.
    it('ypy:after:settle of every task fires before ypy:after:swap', async function () {
        mockResponse('GET', '/test', '<div id="main-out">main</div><div id="oob-out" ypy-swap-oob="true">oob</div>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-target="#main-out" ypy-swap="outerHTML"></div>' +
            '<div id="main-out"></div><div id="oob-out"></div>')
        let seen = []
        let names = ['ypy:before:swap', 'ypy:before:settle', 'ypy:after:settle', 'ypy:after:swap', 'ypy:finally:swap', 'ypy:finally:request']
        let listeners = names.map(name => [name, () => seen.push(name)])
        for (let [name, fn] of listeners) document.addEventListener(name, fn)
        div.click()
        await forRequest()
        for (let [name, fn] of listeners) document.removeEventListener(name, fn)
        let order = seen.filter(name => names.includes(name))
        assert.equal(order.filter(n => n === 'ypy:after:swap').length, 1)
        assert.equal(order.filter(n => n === 'ypy:after:settle').length, 2)
        assert.deepEqual([...new Set(order)], names)
        assert.isBelow(order.lastIndexOf('ypy:after:settle'), order.indexOf('ypy:after:swap'))
    })

    // Documented in guides/events.md: only elements YPY processed (with a ypy-* attribute) get the event.
    it('ypy:before:cleanup reaches a removed element with a ypy attribute and not one without', async function () {
        mockResponse('GET', '/test', '<p>replaced</p>')
        let box = createProcessedHTML('<div id="cleanup-box" ypy-get="/test" ypy-swap="innerHTML">' +
            '<span id="plain" data-widget="x"></span><span id="powered" ypy-get="/other"></span></div>')
        let plain = box.querySelector('#plain')
        let powered = box.querySelector('#powered')
        let cleaned = []
        let record = (e) => cleaned.push(e.target)
        document.addEventListener('ypy:before:cleanup', record)
        box.click()
        await forRequest()
        document.removeEventListener('ypy:before:cleanup', record)
        assert.include(cleaned, powered)
        assert.notInclude(cleaned, plain)
    })

    // TODO - verify shape of details in these events
})
