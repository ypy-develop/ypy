// SPDX-License-Identifier: MIT
// TASK-075: a navigation is atomic. The URL and the history entry are written after the swap
// was applied, never before and never when it failed; a script that replaces the state of an
// entry of ypy does not lose its restoration; only a GET (or a redirect to a page) is pushed
// by a boost without ypy-push-url.
describe('atomic navigation', function() {

    const page = text => `<html><head><title>t</title></head><body><main ypy-history-elt><p id="page">${text}</p></main></body></html>`
    const boostedForm = (attrs = '') => `<div id="box"><form id="f" action="/nav-form" method="post" ypy-boost="true" ypy-target="#box" ypy-swap="innerHTML" ${attrs}><button id="b">Go</button></form></div>`

    // Submits the form the way the browser does, and resolves with the context of the request
    async function submit(form) {
        let ctx
        document.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx, {once: true})
        form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
        await forRequest()
        return ctx
    }

    function redirected(body, url) {
        let response = new MockResponse(body, {url})
        response.redirected = true
        return response
    }

    beforeEach(function() {
        setupTest(this.currentTest)
        history.replaceState(null, '', location.pathname)
    })

    afterEach(function() {
        cleanupTest()
    })

    describe('the URL is written after the swap', function() {

        it('the page has the new content when the history is updated, and the URL is still the old one', async function() {
            mockResponse('GET', '/nav-new', '<p id="new">new</p>')
            let before = location.href
            let seen
            let listener = () => seen = {content: playground().textContent, url: location.href}
            document.addEventListener('ypy:before:history:update', listener, {once: true})
            createProcessedHTML('<div><button id="b" ypy-get="/nav-new" ypy-target="#t" ypy-push-url="true">Go</button><div id="t">old</div></div>')
            find('#b').click()
            await forRequest()
            assert.isDefined(seen, 'the history was updated')
            assert.include(seen.content, 'new')
            assert.equal(seen.url, before)
            assert.equal(location.pathname, '/nav-new')
        })

        it('the history events fire after the content is processed and before ypy:after:swap', async function() {
            mockResponse('GET', '/nav-order', '<p>x</p>')
            let order = []
            let names = ['ypy:after:process', 'ypy:before:history:update', 'ypy:after:history:push', 'ypy:after:swap']
            let listeners = names.map(name => {
                let fn = () => order.push(name)
                document.addEventListener(name, fn)
                return [name, fn]
            })
            try {
                createProcessedHTML('<div><button id="b" ypy-get="/nav-order" ypy-target="#t" ypy-push-url="true">Go</button><div id="t">old</div></div>')
                find('#b').click()
                await forRequest()
            } finally {
                for (let [name, fn] of listeners) document.removeEventListener(name, fn)
            }
            assert.deepEqual(order.slice(-3), names.slice(1))
            assert.isBelow(order.indexOf('ypy:after:process'), order.indexOf('ypy:before:history:update'))
        })

        it('the URL does not change when a task of the swap fails', async function() {
            mockResponse('GET', '/nav-fail', '<p>new</p>')
            let before = location.href
            let errors = []
            let onError = e => errors.push(e)
            document.addEventListener('ypy:error', onError)
            let pushed = false
            let onPush = () => pushed = true
            document.addEventListener('ypy:after:history:push', onPush)
            try {
                createProcessedHTML('<div><button id="b" ypy-get="/nav-fail" ypy-target="#t" ypy-swap="bogus" ypy-push-url="true">Go</button><div id="t">old</div></div>')
                find('#b').click()
                await forRequest()
            } finally {
                document.removeEventListener('ypy:error', onError)
                document.removeEventListener('ypy:after:history:push', onPush)
            }
            assert.isAbove(errors.length, 0, 'the swap failed')
            assert.isFalse(pushed)
            assert.equal(location.href, before)
        })

        it('a swap cancelled in ypy:before:swap leaves the URL alone', async function() {
            mockResponse('GET', '/nav-cancel', '<p>new</p>')
            let before = location.href
            document.addEventListener('ypy:before:swap', e => e.preventDefault(), {once: true})
            createProcessedHTML('<div><button id="b" ypy-get="/nav-cancel" ypy-target="#t" ypy-push-url="true">Go</button><div id="t">old</div></div>')
            find('#b').click()
            await forRequest()
            assert.equal(find('#t').textContent, 'old')
            assert.equal(location.href, before)
        })

        it('a push records where the page being left was scrolled to, from before the swap', async function() {
            mockResponse('GET', '/nav-scroll-a', page('a'))
            history.replaceState({ypy: true}, '', '/nav-scroll-a')
            createProcessedHTML('<main ypy-history-elt><button id="b" ypy-get="/nav-scroll-b" ypy-target="#t" ypy-push-url="true">Go</button><div id="t" style="height:3000px">tall</div></main>')
            mockResponse('GET', '/nav-scroll-b', '<p>short</p>')
            window.scrollTo(0, 400)
            await ypy.timeout(20)
            find('#b').click()
            await forRequest()
            assert.equal(location.pathname, '/nav-scroll-b')
            history.back()
            await forRequest(1500)
            assert.equal(location.pathname, '/nav-scroll-a')
            assert.deepEqual(history.state.scroll, [0, 400])
            window.scrollTo(0, 0)
        })
    })

    describe('a script that replaces the state of an entry of ypy', function() {

        it('the next push stamps the entry again, and going back restores it with the keys of the script', async function() {
            createProcessedHTML('<main ypy-history-elt><button id="b1" ypy-get="/nav-ext-b" ypy-target="#t" ypy-push-url="true">B</button><button id="b2" ypy-get="/nav-ext-c" ypy-target="#t" ypy-push-url="true">C</button><div id="t">a</div></main>')
            mockResponse('GET', '/nav-ext-b', '<p>b</p>')
            mockResponse('GET', '/nav-ext-c', '<p>c</p>')
            find('#b1').click()
            await forRequest()
            assert.equal(location.pathname, '/nav-ext-b')
            assert.isTrue(history.state.ypy)

            history.replaceState({router: 1}, '', location.href)   // another script
            assert.isUndefined(history.state.ypy)

            find('#b2').click()
            await forRequest()
            assert.equal(location.pathname, '/nav-ext-c')

            mockResponse('GET', '/nav-ext-b', page('b restored'))
            history.back()
            await forRequest(1500)
            assert.equal(location.pathname, '/nav-ext-b')
            assert.equal(find('#page').textContent, 'b restored')
            assert.equal(history.state.router, 1)
            assert.isTrue(history.state.ypy)
        })

        it('going back to an entry the script emptied restores it, whatever the script did in between', async function() {
            createProcessedHTML('<main ypy-history-elt><button id="b1" ypy-get="/nav-ext2-b" ypy-target="#t" ypy-push-url="true">B</button><div id="t">a</div></main>')
            mockResponse('GET', '/nav-ext2-b', '<p>b</p>')
            find('#b1').click()
            await forRequest()
            assert.equal(location.pathname, '/nav-ext2-b')

            history.replaceState(null, '', location.href)   // another script clears the state
            history.pushState({other: true}, '', '/nav-ext2-away')   // and goes on without ypy

            mockResponse('GET', '/nav-ext2-b', page('b restored'))
            history.back()
            await forRequest(1500)
            assert.equal(location.pathname, '/nav-ext2-b')
            assert.equal(find('#page').textContent, 'b restored')
        })

        it('an entry that another router owns, on a path ypy never wrote, is still left alone', async function() {
            createProcessedHTML('<main ypy-history-elt><p id="page">here</p></main>')
            history.replaceState({ypy: true}, '', '/nav-own-a')
            history.pushState({vue: true}, '', '/nav-own-foreign')
            history.pushState({vue: true}, '', '/nav-own-foreign-2')
            mockResponse('GET', '/nav-own-foreign', page('should not load'))
            history.back()
            let evt = await forRequest(150)
            assert.isNull(evt)
            assert.equal(find('#page').textContent, 'here')
        })
    })

    describe('what a boost pushes', function() {

        it('a boosted POST answered with a page does not push, the URL stays', async function() {
            mockResponse('POST', '/nav-form', '<p id="done">saved</p>')
            let before = location.href
            createProcessedHTML(boostedForm())
            let ctx = await submit(find('#f'))
            assert.equal(ctx.request.method, 'POST')
            assert.equal(find('#done').textContent, 'saved')
            assert.equal(location.href, before)
        })

        it('a boosted PUT, PATCH and DELETE do not push either', async function() {
            let before = location.href
            for (let method of ['put', 'patch', 'delete']) {
                mockResponse(method.toUpperCase(), '/nav-form', '<p id="done">' + method + '</p>')
                createProcessedHTML(boostedForm(`ypy-method="${method}"`))
                let ctx = await submit(find('#f'))
                assert.equal(ctx.request.method, method.toUpperCase())
                assert.equal(find('#done').textContent, method)
                assert.equal(location.href, before, method)
            }
        })

        it('a boosted POST with an explicit ypy-push-url pushes it', async function() {
            mockResponse('POST', '/nav-form', '<p id="done">saved</p>')
            createProcessedHTML(boostedForm('ypy-push-url="/nav-explicit"'))
            await submit(find('#f'))
            assert.equal(location.pathname, '/nav-explicit')
        })

        it('a boosted POST that redirects to a page pushes the page it ended on', async function() {
            mockResponse('POST', '/nav-form', redirected('<p id="done">welcome</p>', '/nav-welcome'))
            createProcessedHTML(boostedForm())
            await submit(find('#f'))
            assert.equal(location.pathname, '/nav-welcome')
        })

        it('a boosted GET form pushes, as a link does', async function() {
            mockResponse('GET', /\/nav-search.*/, '<p id="done">found</p>')
            createProcessedHTML('<div id="box"><form id="f" action="/nav-search" method="get" ypy-boost="true" ypy-target="#box" ypy-swap="innerHTML"><input name="q" value="x"></form></div>')
            await submit(find('#f'))
            assert.equal(location.pathname, '/nav-search')
        })

        it('a POST that is not boosted never pushes', async function() {
            mockResponse('POST', '/nav-form', '<p id="done">saved</p>')
            let before = location.href
            let pushed = false
            let onPush = () => pushed = true
            document.addEventListener('ypy:after:history:push', onPush)
            try {
                createProcessedHTML('<div id="box"><form id="f" ypy-post="/nav-form" ypy-target="#box" ypy-swap="innerHTML"><button>Go</button></form></div>')
                await submit(find('#f'))
            } finally {
                document.removeEventListener('ypy:after:history:push', onPush)
            }
            assert.equal(find('#done').textContent, 'saved')
            assert.isFalse(pushed)
            assert.equal(location.href, before)
        })

        it('a POST by ypy.ajax() without a push does not touch the URL', async function() {
            mockResponse('POST', '/nav-form', '<p>x</p>')
            let before = location.href
            await ypy.ajax('POST', '/nav-form', {target: playground()})
            assert.equal(location.href, before)
        })
    })
})
