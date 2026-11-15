// SPDX-License-Identifier: MIT
// TASK-009: the form convention. 422 is a validation error and renders in the form; 303
// is a success that redirects and is handled like any other success.
describe('form conventions: 422 and 303', function () {

    const FORM = `<div id="page"><form id="f" ypy-post="/signup" ypy-target="#page" ypy-swap="innerHTML">
        <label>Name <input id="name" name="name"></label>
        <label>Email <input id="email" name="email"></label>
        <button id="save">Save</button></form></div>`

    // The same form, boosted: a plain HTML form that works without JavaScript
    const BOOSTED = FORM.replace('ypy-post="/signup"', 'action="/signup" method="post" ypy-boost="true"')

    // The server answers a 422 with the content of the form, the invalid fields marked
    const INVALID = `<label>Name <input id="name" name="name"></label>
        <label>Email <input id="email" name="email" aria-invalid="true"></label>
        <p id="msg" role="alert">Email is required</p>
        <button id="save">Save</button>`

    // A fetch response that went through a redirect: the mock is a plain file, so the fixture adds
    // the two fields the browser sets (see TASK-009 in the ficha)
    function redirected(body, url) {
        let response = new MockResponse(body, {url})
        response.redirected = true
        return response
    }

    // Submits the form as the browser does and resolves with the context of the request that ended
    async function submit(form) {
        let ctx
        document.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx, {once: true})
        form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
        await forRequest()
        return ctx
    }

    afterEach(function () {
        cleanupTest()
    })

    describe('422', function () {

        beforeEach(function () {
            setupTest(this.currentTest)
        })

        it('renders in the form, not in the request target, and keeps the form element', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(FORM)
            let form = find('#f')
            let ctx = await submit(form)
            assert.equal(find('#f'), form, 'the form element is the same node')
            assert.equal(find('#msg').textContent, 'Email is required')
            assert.equal(find('#page > #f'), form, 'the page target was not replaced')
            assert.equal(ctx.errorKind, 'validation')
            assert.equal(ctx.status, 'swapped')
        })

        it('keeps what the user typed (morph), the other fields and the form attributes', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(FORM)
            find('#name').value = 'Ada'
            find('#email').value = 'typed@example.org'
            await submit(find('#f'))
            assert.equal(find('#name').value, 'Ada')
            assert.equal(find('#email').value, 'typed@example.org')
            assert.equal(find('#f').getAttribute('ypy-post'), '/signup')
        })

        it('puts the focus on the first invalid field, wherever it was', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(FORM)
            find('#name').focus()
            await submit(find('#f'))
            assert.equal(document.activeElement, find('#email'))
        })

        it('marks the form with data-ypy-state="error" until the next request', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(FORM)
            await submit(find('#f'))
            assert.equal(find('#f').dataset.ypyState, 'error')
            mockResponse('POST', '/signup', '<p>ok</p>')
            let seen = 'unset'
            find('#f').addEventListener('ypy:before:request', () => seen = find('#f').dataset.ypyState, {once: true})
            await submit(find('#f'))
            assert.equal(seen, 'request')   // the error is gone, the request state is on
            assert.equal(find('#page').innerHTML, '<p>ok</p>')
        })

        it('ypy-error-swap decides the style, for a server that answers with the whole form', async function () {
            mockResponse('POST', '/signup', `<form id="f" ypy-post="/signup"><input id="email" name="email" aria-invalid="true"><p id="msg">no</p></form>`, {status: 422})
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-error-swap="outerMorph"'))
            let form = find('#f')
            await submit(form)
            assert.equal(find('#f'), form)
            assert.equal(find('#f > #msg').textContent, 'no')
            assert.isUndefined(find('#name'), 'the response had no name field, the morph removed it')
        })

        it('still marks and focuses when the swap replaces the form itself (outerHTML)', async function () {
            mockResponse('POST', '/signup', `<form id="f" ypy-post="/signup"><input id="name" name="name"><input id="email" name="email" aria-invalid="true"></form>`, {status: 422})
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-error-swap="outerHTML"'))
            let old = find('#f')
            find('#name').focus()
            await submit(old)
            let form = find('#f')
            assert.notEqual(form, old, 'the form was replaced')
            assert.equal(form.dataset.ypyState, 'error')
            assert.equal(document.activeElement, find('#email'))
        })

        it('ypy-error-target and ypy-error-focus win over the default', async function () {
            mockResponse('POST', '/signup', '<p id="msg">no</p>', {status: 422})
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-error-target="#errors" ypy-error-swap="innerHTML" ypy-error-focus="#name"')
                .replace('</div>', '<div id="errors"></div></div>'))
            let ctx = await submit(find('#f'))
            assert.equal(find('#errors').textContent, 'no')
            assert.isUndefined(find('#f #msg'))
            assert.equal(document.activeElement, find('#name'))
            assert.equal(ctx.focus, '#name')
        })

        it('ypy-error-focus="false" turns the focus off', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-error-focus="false"'))
            find('#name').focus()
            let ctx = await submit(find('#f'))
            assert.isFalse(ctx.focus)
            assert.equal(document.activeElement, find('#name'))
        })

        it('ypy-status:422 still wins over the convention', async function () {
            mockResponse('POST', '/signup', '<p id="msg">no</p>', {status: 422})
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-status:422="target:#elsewhere swap:innerHTML"')
                .replace('</div>', '<div id="elsewhere"></div></div>'))
            await submit(find('#f'))
            assert.equal(find('#elsewhere').textContent, 'no')
            assert.isUndefined(find('#f #msg'))
        })

        it('a button outside any form keeps the request target', async function () {
            mockResponse('GET', '/x', '<i>no</i>', {status: 422})
            createProcessedHTML('<div id="t"></div><button ypy-get="/x" ypy-target="#t" ypy-swap="innerHTML">Go</button>')
            find('button').click()
            await forRequest()
            assert.equal(find('#t').innerHTML, '<i>no</i>')
        })

        it('a button inside the form sends the 422 to the form', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(`<div id="page"><form id="f"><input id="email" name="email">
                <button id="go" ypy-post="/signup" ypy-target="#page" ypy-swap="innerHTML">Go</button></form></div>`)
            find('#go').click()
            await forRequest()
            assert.equal(find('#page > #f #msg').textContent, 'Email is required')
        })

        it('a form that already swaps into itself keeps its swap: the server answers with the whole form', async function () {
            mockResponse('POST', '/signup', `<form id="f" ypy-post="/signup" ypy-target="this" ypy-swap="outerHTML"><input id="name" name="name"><input id="email" name="email" aria-invalid="true"></form>`, {status: 422})
            createProcessedHTML('<div id="page"><form id="f" ypy-post="/signup" ypy-target="this" ypy-swap="outerHTML"><input id="name" name="name"></form></div>')
            let old = find('#f')
            let ctx = await submit(old)
            assert.equal(ctx.errorKind, 'validation')
            assert.notEqual(find('#f'), old, 'replaced as the request says')
            assert.equal(find('#page').children.length, 1, 'no form inside the form')
            assert.equal(find('#f').dataset.ypyState, 'error')
            assert.equal(document.activeElement, find('#email'))
        })

        it('a boosted form is a navigation: the 422 page goes where the boost sends it, the focus is the default', async function () {
            mockResponse('POST', '/signup', '<h1>Check the form</h1><input id="email" name="email" aria-invalid="true">', {status: 422})
            createProcessedHTML(BOOSTED)
            await submit(find('#f'))
            assert.equal(find('#page > h1').textContent, 'Check the form')
            assert.isUndefined(find('#f'))
            assert.equal(document.activeElement, find('#email'))
        })

        it('other 4xx and 5xx go where the request goes (nothing new for them)', async function () {
            for (let status of [400, 404, 500]) {
                mockResponse('POST', '/signup', '<p id="msg">other</p>', {status})
                createProcessedHTML(FORM)
                await submit(find('#f'))
                assert.equal(find('#page').innerHTML, '<p id="msg">other</p>', String(status))
            }
        })
    })

    describe('303 is a success that redirects', function () {

        beforeEach(function () {
            setupTest(this.currentTest)
        })

        it('a boosted POST pushes the final URL of the redirect', async function () {
            mockResponse('POST', '/signup', redirected('<h1>Welcome</h1>', '/welcome'))
            createProcessedHTML(BOOSTED)
            let ctx = await submit(find('#f'))
            assert.isTrue(ctx.redirected)
            assert.isUndefined(ctx.errorKind)
            // the form was replaced by the page, so the focus goes to its heading (which gets a tabindex)
            assert.equal(find('#page h1').textContent, 'Welcome')
            assert.equal(document.activeElement, find('#page h1'))
            assert.equal(location.pathname, '/welcome')
        })

        it('without a boost the URL is not touched, the response is still a success', async function () {
            let before = location.href
            mockResponse('POST', '/signup', redirected('<h1>Welcome</h1>', '/welcome'))
            createProcessedHTML(FORM)
            let ctx = await submit(find('#f'))
            assert.isTrue(ctx.redirected)
            assert.isUndefined(ctx.errorKind)
            assert.equal(find('#page').innerHTML, '<h1>Welcome</h1>')
            assert.equal(location.href, before)
        })

        it('ypy-push-url="true" pushes the final URL, an explicit URL wins', async function () {
            mockResponse('POST', '/signup', redirected('<h1>Welcome</h1>', '/welcome'))
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-push-url="true"'))
            await submit(find('#f'))
            assert.equal(location.pathname, '/welcome')
            cleanupTest()
            setupTest(null)

            mockResponse('POST', '/signup', redirected('<h1>Welcome</h1>', '/welcome'))
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-push-url="/custom"'))
            await submit(find('#f'))
            assert.equal(location.pathname, '/custom')
        })

        it('a request that was not redirected has redirected false', async function () {
            mockResponse('POST', '/signup', '<h1>Hi</h1>')
            createProcessedHTML(FORM)
            let ctx = await submit(find('#f'))
            assert.isFalse(ctx.redirected)
        })

        it('is the second step: 422, then the fixed form answers 303 and the error state is gone', async function () {
            mockResponse('POST', '/signup', INVALID, {status: 422})
            createProcessedHTML(FORM.replace('<form id="f"', '<form id="f" ypy-push-url="true"'))
            let form = find('#f')
            let first = await submit(form)
            assert.equal(first.errorKind, 'validation')
            assert.equal(form.dataset.ypyState, 'error')
            assert.equal(document.activeElement, find('#email'))
            assert.notEqual(location.pathname, '/signup', 'a 422 does not touch the URL of the page')

            find('#email').value = 'ada@example.org'
            mockResponse('POST', '/signup', redirected('<h1>Welcome</h1>', '/welcome'))
            let second = await submit(form)
            assert.isTrue(second.redirected)
            assert.isUndefined(second.errorKind)
            assert.isUndefined(form.dataset.ypyState)
            assert.equal(find('#page').innerHTML, '<h1>Welcome</h1>')
            assert.equal(location.pathname, '/welcome')
        })
    })
})
