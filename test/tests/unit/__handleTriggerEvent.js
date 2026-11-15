// SPDX-License-Identifier: MIT
describe('__handleTriggerEvent unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('returns early if element not connected', async function () {
        let div = createProcessedHTML('<div ypy-get="js:window.testExecuted = true"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        div.remove()
        await ypy.__handleTriggerEvent(ctx)
        assert.isUndefined(window.testExecuted)
    })

    it('returns early if modifier key click on a link', async function () {
        let link = createProcessedHTML('<a href="/test" ypy-get="js:window.testExecuted = true">link</a>')
        let evt = new MouseEvent('click', {ctrlKey: true, bubbles: true, cancelable: true})
        Object.defineProperty(evt, 'currentTarget', {value: link})
        let ctx = ypy.__createRequestContext(link, evt)
        await ypy.__handleTriggerEvent(ctx)
        assert.isUndefined(window.testExecuted)
    })

    it('does not return early if modifier key click on a non-link', async function () {
        let div = createProcessedHTML('<div ypy-get="js:window.testExecuted = true"></div>')
        let evt = new MouseEvent('click', {ctrlKey: true})
        let ctx = ypy.__createRequestContext(div, evt)
        await ypy.__handleTriggerEvent(ctx)
        assert.isTrue(window.testExecuted)
        delete window.testExecuted
    })

    it('a click on a link with a request is cancelled once, by the trigger handler', async function () {
        let link = createProcessedHTML('<a href="/test" ypy-get="js:">Link</a>')
        let evt = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0})
        link.dispatchEvent(evt)
        assert.isTrue(evt.defaultPrevented)
    })

    it('resolves target from ctx.target', async function () {
        createProcessedHTML('<div id="target"></div><button ypy-get="js:" ypy-target="#target"></button>')
        let button = document.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.target.id, 'target')
    })

    it('collects form data from element', async function () {
        let form = createProcessedHTML('<form><input name="field" value="test"><button ypy-post="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.body.get('field'), 'test')
    })

    it('applies ypy-vals to body', async function () {
        let div = createProcessedHTML('<div ypy-get="js:window.foo = extra" ypy-vals=\'{"extra":"value"}\'></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(window.foo, 'value')
        delete window.foo
    })

    it('applies ctx.values to body', async function () {
        let div = createProcessedHTML('<div ypy-get="js:window.foo = custom"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        ctx.values = {custom: 'data'}
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(window.foo, 'data')
        delete window.foo
    })

    it('ctx.values override form data', async function () {
        let form = createProcessedHTML('<form><input name="field" value="original"><button ypy-post="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        ctx.values = {field: 'override'}
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.body.get('field'), 'override')
    })

    it('strips anchor from action', async function () {
        let div = createProcessedHTML('<div ypy-get="js:#anchor"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.action, 'js:')
    })

    it('stores anchor separately from action', async function () {
        let div = createProcessedHTML('<div ypy-get="js:#anchor"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.anchor, 'anchor')
    })

    it('returns early if ypy:config:request cancelled', async function () {
        let div = createProcessedHTML('<div ypy-get="js:window.testExecuted = true"></div>')
        div.addEventListener('ypy:config:request', (e) => e.preventDefault())
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.isUndefined(window.testExecuted)
    })

    it('executes javascript when action starts with js:', async function () {
        let div = createProcessedHTML('<div ypy-get="js:window.testExecuted = true"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.isTrue(window.testExecuted)
        delete window.testExecuted
    })

    it('executes javascript when action starts with javascript:', async function () {
        let div = createProcessedHTML('<div ypy-get="javascript:window.testExecuted = true"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.isTrue(window.testExecuted)
        delete window.testExecuted
    })

    // GET/DELETE on form element itself - includes form data in query params
    it('GET on form element includes form data in query params', async function () {
        let form = createProcessedHTML('<form ypy-get="/test"><input name="q" value="search"></form>')
        let ctx = ypy.__createRequestContext(form, new Event('submit'))
        await ypy.__handleTriggerEvent(ctx)
        assert.include(ctx.request.action, '/test?q=search')
    })

    it('DELETE on form element includes form data in query params', async function () {
        let form = createProcessedHTML('<form ypy-delete="/test"><input name="id" value="123"></form>')
        let ctx = ypy.__createRequestContext(form, new Event('submit'))
        await ypy.__handleTriggerEvent(ctx)
        assert.include(ctx.request.action, '/test?id=123')
    })

    // GET/DELETE on element inside form - excludes enclosing form data
    it('GET on element inside form excludes enclosing form data', async function () {
        let form = createProcessedHTML('<form><input name="form_field" value="excluded"><button ypy-get="/test" name="btn" value="included"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.notInclude(ctx.request.action, 'form_field')
        assert.include(ctx.request.action, 'btn=included')
    })

    it('DELETE on element inside form excludes enclosing form data', async function () {
        let form = createProcessedHTML('<form><input name="form_field" value="excluded"><button ypy-delete="/test" name="btn" value="included"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.notInclude(ctx.request.action, 'form_field')
        assert.include(ctx.request.action, 'btn=included')
    })

    it('sets body to null for GET requests', async function () {
        let form = createProcessedHTML('<form ypy-get="/test"><input name="q" value="search"></form>')
        let ctx = ypy.__createRequestContext(form, new Event('submit'))
        await ypy.__handleTriggerEvent(ctx)
        assert.isNull(ctx.request.body)
    })

    it('sets body to null for DELETE requests', async function () {
        let form = createProcessedHTML('<form ypy-delete="/test"><input name="id" value="123"></form>')
        let ctx = ypy.__createRequestContext(form, new Event('submit'))
        await ypy.__handleTriggerEvent(ctx)
        assert.isNull(ctx.request.body)
    })

    // POST/PUT/PATCH on element inside form - includes form data in body
    it('POST on element inside form includes form data in body', async function () {
        let form = createProcessedHTML('<form><input name="field" value="test"><button ypy-post="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.body.get('field'), 'test')
    })

    it('PUT on element inside form includes form data in body', async function () {
        let form = createProcessedHTML('<form><input name="field" value="test"><button ypy-put="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.body.get('field'), 'test')
    })

    it('PATCH on element inside form includes form data in body', async function () {
        let form = createProcessedHTML('<form><input name="field" value="test"><button ypy-patch="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.body.get('field'), 'test')
    })

    it('converts body to URLSearchParams for POST', async function () {
        let form = createProcessedHTML('<form><input name="field" value="test"><button ypy-post="/test"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        let originalFetch = ctx.fetch
        ctx.fetch = async () => ({ status: 200, headers: new Headers(), text: async () => '' })
        await ypy.__handleTriggerEvent(ctx)
        assert.instanceOf(ctx.request.body, URLSearchParams)
    })

    it('keeps multipart form data as FormData', async function () {
        let form = createProcessedHTML('<form><input name="field" value="test"><button ypy-post="js:" ypy-encoding="multipart/form-data"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.instanceOf(ctx.request.body, FormData)
    })

    it('stores form in ctx.request', async function () {
        let form = createProcessedHTML('<form><button ypy-post="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.form, form)
    })

    it('stores submitter in ctx.request', async function () {
        let form = createProcessedHTML('<form><button name="action" value="save" ypy-post="js:"></button></form>')
        let button = form.querySelector('button')
        let evt = {type: 'submit', submitter: button}
        let ctx = ypy.__createRequestContext(button, evt)
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.submitter, button)
    })

    it('keeps multipart form data as FormData when form enctype is multipart/form-data', async function () {
        let form = createProcessedHTML('<form enctype="multipart/form-data"><input name="field" value="test"><button ypy-post="js:"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.instanceOf(ctx.request.body, FormData)
    })

    it('ypy-encoding takes precedence over form enctype', async function () {
        let form = createProcessedHTML('<form enctype="multipart/form-data"><input name="field" value="test"><button ypy-post="/test" ypy-encoding="application/x-www-form-urlencoded"></button></form>')
        let button = form.querySelector('button')
        let ctx = ypy.__createRequestContext(button, new Event('click'))
        ctx.fetch = async () => ({ status: 200, headers: new Headers(), text: async () => '' })
        await ypy.__handleTriggerEvent(ctx)
        assert.instanceOf(ctx.request.body, URLSearchParams)
    })

    it('sets credentials to same-origin', async function () {
        let div = createProcessedHTML('<div ypy-get="js:"></div>')
        let ctx = ypy.__createRequestContext(div, new Event('click'))
        await ypy.__handleTriggerEvent(ctx)
        assert.equal(ctx.request.credentials, 'same-origin')
    })

    it('appends to existing query string with &', async function () {
        let form = createProcessedHTML('<form ypy-get="/test?existing=1"><input name="new" value="val"></form>')
        let ctx = ypy.__createRequestContext(form, new Event('submit'))
        await ypy.__handleTriggerEvent(ctx)
        assert.include(ctx.request.action, '/test?existing=1&new=val')
    })

});