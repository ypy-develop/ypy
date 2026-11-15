// SPDX-License-Identifier: MIT
// TASK-075: the submit button of a form. The core builds the body with new FormData(form,
// submitter): a button without a name sends no field, a named one sends its name and value, and
// the button's formaction and formmethod decide the request, with or without ypy-boost.
describe('the submit button of a form', function() {

    beforeEach(function() {
        setupTest(this.currentTest)
    })

    afterEach(function() {
        cleanupTest()
    })

    // Clicks the button as a person does: the browser fires submit with the button as its submitter
    async function press(button) {
        button.click()
        await forRequest()
        return lastFetch().request
    }

    describe('the body', function() {

        it('a button without a name sends no field', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><input name="a" value="1"><button id="b">Go</button></form>')
            let request = await press(find('#b'))
            assert.deepEqual([...request.body.keys()], ['a'])
        })

        it('a button with an empty name sends no field', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><input name="a" value="1"><button id="b" name="" value="x">Go</button></form>')
            let request = await press(find('#b'))
            assert.deepEqual([...request.body.keys()], ['a'])
        })

        it('a named button sends its name and value', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><input name="a" value="1"><button id="b" name="act" value="save">Go</button></form>')
            let request = await press(find('#b'))
            assert.equal(request.body.get('act'), 'save')
            assert.equal(request.body.get('a'), '1')
        })

        it('only the button that was pressed is sent', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><button id="b1" name="act" value="save">Save</button><button id="b2" name="act" value="draft">Draft</button></form>')
            let request = await press(find('#b2'))
            assert.deepEqual(request.body.getAll('act'), ['draft'])
        })

        it('a named button that owns ypy-post sends its own name and value once', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form><input name="a" value="1"><button id="b" ypy-post="/sub" name="act" value="save">Go</button></form>')
            let request = await press(find('#b'))
            assert.deepEqual(request.body.getAll('act'), ['save'])
            assert.equal(request.body.get('a'), '1')
        })

        it('an unnamed button that owns ypy-post sends no field', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form><input name="a" value="1"><button id="b" ypy-post="/sub">Go</button></form>')
            let request = await press(find('#b'))
            assert.deepEqual([...request.body.keys()], ['a'])
        })
    })

    describe('formaction and formmethod, without ypy-boost', function() {

        it('the formaction of the button wins over the ypy-post of the form', async function() {
            mockResponse('POST', '/other', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><button id="b" formaction="/other">Go</button></form>')
            let request = await press(find('#b'))
            assert.equal(request.method, 'POST')
            assert.equal(request.action, '/other')
        })

        it('a button without formaction still goes where the form goes', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><button id="b" formaction="/other">Other</button><button id="c">Go</button></form>')
            let request = await press(find('#c'))
            assert.equal(request.action, '/sub')
        })

        it('the formmethod of the button wins over the verb of the form', async function() {
            mockResponse('GET', /\/sub.*/, 'ok')
            createProcessedHTML('<form ypy-post="/sub"><input name="q" value="1"><button id="b" formmethod="get">Go</button></form>')
            let request = await press(find('#b'))
            assert.equal(request.method, 'GET')
            assert.include(request.action, '/sub')
        })

        it('formaction and formmethod together, with ypy-action on the form', async function() {
            mockResponse('POST', '/other', 'ok')
            createProcessedHTML('<form ypy-action="/sub" ypy-method="get"><button id="b" formaction="/other" formmethod="post">Go</button></form>')
            let request = await press(find('#b'))
            assert.equal(request.method, 'POST')
            assert.equal(request.action, '/other')
        })

        it('formmethod="dialog" makes no request', async function() {
            mockResponse('POST', '/sub', 'ok')
            createProcessedHTML('<form ypy-post="/sub"><button id="b" formmethod="dialog">Close</button></form>')
            find('#b').click()
            await ypy.timeout(30)
            assert.equal(fetchMock.getCalls().length, 0)
        })
    })

    describe('the request state of the element', function() {

        it('data-ypy-state has "request" with the class while the request is in flight', async function() {
            mockResponse('GET', '/state', 'done')
            let btn = createProcessedHTML('<button ypy-get="/state">Go</button>')
            assert.isUndefined(btn.dataset.ypyState)
            btn.click()
            assert.equal(btn.dataset.ypyState, 'request')
            assert.isTrue(btn.classList.contains('ypy-request'))
            await forRequest()
            assert.isUndefined(btn.dataset.ypyState)
            assert.isFalse(btn.classList.contains('ypy-request'))
        })

        it('an indicator that is not the trigger gets the state, the trigger does not', async function() {
            mockResponse('GET', '/state', 'done')
            createProcessedHTML('<div><button id="b" ypy-get="/state" ypy-indicator="#i">Go</button><span id="i"></span></div>')
            find('#b').click()
            assert.equal(find('#i').dataset.ypyState, 'request')
            assert.isTrue(find('#i').classList.contains('ypy-request'))
            assert.isUndefined(find('#b').dataset.ypyState)
            await forRequest()
            assert.isUndefined(find('#i').dataset.ypyState)
        })

        it('two requests on one indicator keep the state until the last one ends', async function() {
            mockResponse('GET', '/state', 'done')
            createProcessedHTML('<div><button id="a" ypy-get="/state" ypy-indicator="#i" ypy-sync="this:queue all">A</button><button id="b" ypy-get="/state" ypy-indicator="#i">B</button><span id="i"></span></div>')
            find('#a').click()
            find('#b').click()
            await forRequest()
            await forRequest()
            assert.isUndefined(find('#i').dataset.ypyState)
        })

        it('keeps the other states of the element', async function() {
            mockResponse('GET', '/state', 'done')
            let btn = createProcessedHTML('<button ypy-get="/state" data-ypy-state="error">Go</button>')
            btn.click()
            assert.equal(btn.dataset.ypyState, 'error request')
            await forRequest()
            assert.equal(btn.dataset.ypyState, 'error')
        })
    })

    describe('inert', function() {

        it('is off by default: the target stays active during the request', async function() {
            mockResponse('GET', '/inert', 'done')
            createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t">Go</button><div id="t">old</div></div>')
            find('#b').click()
            assert.isFalse(find('#t').inert)
            await forRequest()
            assert.isFalse(find('#t').inert)
        })

        it('ypy-inert="true" makes the target inert until the request ends', async function() {
            mockResponse('GET', '/inert', 'done')
            createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t" ypy-inert="true">Go</button><div id="t">old</div></div>')
            find('#b').click()
            assert.isTrue(find('#t').inert)
            await forRequest()
            assert.isFalse(find('#t').inert)
            assert.equal(find('#t').textContent, 'done')
        })

        it('config.inert turns it on for every request, ypy-inert="false" turns it off again', async function() {
            mockResponse('GET', '/inert', 'done')
            ypy.config.inert = true
            try {
                createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t">Go</button><button id="c" ypy-get="/inert" ypy-target="#u" ypy-inert="false">Go</button><div id="t">old</div><div id="u">old</div></div>')
                find('#b').click()
                assert.isTrue(find('#t').inert)
                await forRequest()
                assert.isFalse(find('#t').inert)
                find('#c').click()
                assert.isFalse(find('#u').inert)
                await forRequest()
            } finally {
                delete ypy.config.inert
            }
        })

        it('a form that swaps into itself is inert during the submit and works again after', async function() {
            mockResponse('POST', '/inert', '<input name="n" value="new">')
            createProcessedHTML('<form id="f" ypy-post="/inert" ypy-target="this" ypy-swap="innerHTML" ypy-inert="true"><input name="n" value="old"><button id="b">Go</button></form>')
            find('#b').click()
            assert.isTrue(find('#f').inert)
            await forRequest()
            assert.isFalse(find('#f').inert)
            assert.equal(find('#f > input').value, 'new')
        })

        it('is released when the request fails', async function() {
            mockResponse('GET', '/inert', 'oops', {status: 500})
            createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t" ypy-inert="true">Go</button><div id="t">old</div></div>')
            find('#b').click()
            assert.isTrue(find('#t').inert)
            await forRequest()
            assert.isFalse(find('#t').inert)
        })
    })
})
