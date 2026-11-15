// SPDX-License-Identifier: MIT
// aria-busy and ypy-announce (TASK-013). The automatic behaviors are on by default (decision R-6)
// and are turned off with config.ariaBusy = false and config.announce = false.
describe('aria-busy and announcements', function() {
    let savedTitle = document.title

    function regions() {
        return [...document.querySelectorAll('[data-ypy-live]')]
    }

    function region(level = 'polite') {
        return document.querySelector('[data-ypy-live=' + level + ']')
    }

    // The text goes in a moment after the empty step, so wait past it
    async function settled() {
        await ypy.timeout(120)
    }

    function busy(selector) {
        return find(selector).getAttribute('aria-busy')
    }

    // A response that is held until release() is called
    function held(url, body = 'done') {
        let releases = []
        mockResponse('GET', url, () => new Promise(resolve => releases.push(() => resolve(body))))
        return {
            release: () => releases.shift()(),
            get pending() { return releases.length }
        }
    }

    afterEach(function() {
        cleanupTest()
        delete ypy.config.ariaBusy
        delete ypy.config.announce
        regions().forEach(r => r.remove())
        document.title = savedTitle
    })

    describe('aria-busy', function() {
        beforeEach(function() {
            setupTest(this.currentTest)
        })

        it('is set on the target during the request and removed after it', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            assert.isNull(busy('#t'))
            find('#b').click()
            await ypy.timeout(20)
            assert.equal(busy('#t'), 'true')
            assert.isNull(busy('#b'))
            h.release()
            await forRequest()
            assert.isNull(busy('#t'))
            assert.equal(find('#t').innerHTML, 'done')
        })

        it('marks the source element when there is no other target', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow">Go</button>')
            find('#b').click()
            await ypy.timeout(20)
            assert.equal(busy('#b'), 'true')
            h.release()
            await forRequest()
        })

        it('counts concurrent requests to one target', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="a" ypy-get="/slow" ypy-target="#t">A</button><button id="b" ypy-get="/slow" ypy-target="#t">B</button><div id="t"></div>')
            find('#a').click()
            find('#b').click()
            await ypy.timeout(20)
            assert.equal(h.pending, 2)
            assert.equal(busy('#t'), 'true')
            h.release()
            await forRequest()
            assert.equal(busy('#t'), 'true', 'one request is still running')
            h.release()
            await forRequest()
            assert.isNull(busy('#t'))
        })

        it('restores the value the author had put there', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t" aria-busy="false"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.equal(busy('#t'), 'true')
            h.release()
            await forRequest()
            assert.equal(busy('#t'), 'false')
        })

        it('is cleared when the network fails', async function() {
            mockFailure('GET', '/x')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            assert.isNull(busy('#t'))
        })

        it('is cleared when the request is aborted', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').addEventListener('ypy:before:request', e => setTimeout(() => e.detail.ctx.request.abort(), 10))
            find('#b').click()
            await ypy.timeout(5)
            assert.equal(busy('#t'), 'true')
            await forRequest()
            assert.isNull(busy('#t'))
        })

        it('is cleared when the response is an error status', async function() {
            mockResponse('GET', '/x', 'nope', {status: 500})
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            assert.isNull(busy('#t'))
        })

        it('never appears when the confirmation is denied', async function() {
            let real = window.confirm
            window.confirm = () => false
            try {
                mockResponse('GET', '/x', 'ok')
                createProcessedHTML('<button id="b" ypy-get="/x" ypy-confirm="Sure?" ypy-target="#t">Go</button><div id="t" aria-busy="false"></div>')
                find('#b').click()
                await forRequest()
                assert.equal(busy('#t'), 'false', 'the author value is untouched')
            } finally {
                window.confirm = real
            }
        })

        it('marks every swap target (OOB and partials) and clears them all when the request ends', async function() {
            let marks = {}
            let watch = id => new MutationObserver(() => { if (busy('#' + id) === 'true') marks[id] = true }).observe(find('#' + id), {attributes: true})
            mockResponse('GET', '/multi', '<div id="t">main</div><div id="o" ypy-swap-oob="innerHTML:#o" >oob</div><ypy-partial ypy-target="#p" ypy-swap="innerHTML">part</ypy-partial>')
            createProcessedHTML('<button id="b" ypy-get="/multi" ypy-target="#t" ypy-swap="innerHTML settle:30ms">Go</button><div id="t"></div><div id="o"></div><div id="p"></div>')
            for (let id of ['t', 'o', 'p']) watch(id)
            find('#b').click()
            await forRequest()
            await ypy.timeout(60)
            assert.isTrue(marks.t, 'main target')
            assert.isTrue(marks.o, 'OOB target')
            assert.isTrue(marks.p, 'partial target')
            for (let id of ['t', 'o', 'p']) assert.isNull(busy('#' + id), id)
        })

        it('ypy-busy="false" on the source leaves the OOB targets alone too', async function() {
            let marked = false
            mockResponse('GET', '/multi', 'main<div id="o" ypy-swap-oob="innerHTML:#o">oob</div>')
            createProcessedHTML('<button id="b" ypy-busy="false" ypy-get="/multi" ypy-target="#t">Go</button><div id="t"></div><div id="o"></div>')
            new MutationObserver(() => { if (busy('#o') === 'true') marked = true }).observe(find('#o'), {attributes: true})
            find('#b').click()
            await forRequest()
            await ypy.timeout(30)
            assert.isFalse(marked)
        })

        it('__unmarkBusy and __announce accept a context that was never marked', function() {
            let ctx = {sourceElement: document.body, status: 'issuing', request: {}}
            ypy.__unmarkBusy(ctx)
            ypy.__unmarkBusy(ctx)
            ypy.__announce(ctx)
        })

        it('__unmarkBusy twice on one context releases only one count', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="a" ypy-get="/slow" ypy-target="#t">A</button><button id="b" ypy-get="/slow" ypy-target="#t">B</button><div id="t"></div>')
            let ctxs = []
            find('#a').addEventListener('ypy:before:request', e => ctxs.push(e.detail.ctx))
            find('#a').click()
            find('#b').click()
            await ypy.timeout(20)
            ypy.__unmarkBusy(ctxs[0])
            ypy.__unmarkBusy(ctxs[0])
            assert.equal(busy('#t'), 'true')
            h.release()
            h.release()
            await ypy.timeout(30)
            assert.isNull(busy('#t'))
        })

        it('ypy-busy="false" on the source element opts out', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-busy="false" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.isNull(busy('#t'))
            h.release()
            await forRequest()
        })

        it('ypy-busy="false" on the target opts out', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t" ypy-busy="false"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.isNull(busy('#t'))
            h.release()
            await forRequest()
        })

        it('ypy-busy:inherited="false" on an ancestor opts out', async function() {
            let h = held('/slow')
            createProcessedHTML('<div ypy-busy:inherited="false"><button id="b" ypy-get="/slow" ypy-target="#t">Go</button></div><div id="t"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.isNull(busy('#t'))
            h.release()
            await forRequest()
        })

        it('config.ariaBusy = false turns it off', async function() {
            ypy.config.ariaBusy = false
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.isNull(busy('#t'))
            h.release()
            await forRequest()
        })

        it('keeps the target busy through a delayed swap', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-swap="innerHTML swap:80ms">Go</button><div id="t"></div>')
            find('#b').click()
            await ypy.timeout(40)
            assert.equal(busy('#t'), 'true')
            assert.equal(find('#t').innerHTML, '')
            await forRequest()
            assert.isNull(busy('#t'))
            assert.equal(find('#t').innerHTML, 'ok')
        })
    })

    describe('turning them off', function() {
        beforeEach(function() {
            setupTest(this.currentTest)
        })

        it('config.ariaBusy = false and config.announce = false add no ARIA attribute and no live region', async function() {
            ypy.config.ariaBusy = false
            ypy.config.announce = false
            regions().forEach(r => r.remove())
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t" ypy-announce="Saved">Go</button><div id="t"></div>')
            let ariaAttributes = () => [...playground().querySelectorAll('*')].flatMap(e => e.getAttributeNames()).filter(n => /^(aria-|role$)/.test(n))
            find('#b').click()
            await ypy.timeout(20)
            assert.isNull(busy('#t'))
            assert.deepEqual(ariaAttributes(), [])
            h.release()
            await forRequest()
            await settled()
            assert.isNull(busy('#t'))
            assert.equal(regions().length, 0)
            assert.deepEqual(ariaAttributes(), [])
        })

        it('config.ariaBusy = false turns off the busy mark alone', async function() {
            ypy.config.ariaBusy = false
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.isNull(busy('#t'))
            h.release()
            await forRequest()
        })

        it('config.announce as an object sets the messages', async function() {
            ypy.config.announce = {messages: {done: 'Finished'}}
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Finished')
        })

        it('the default is on', async function() {
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await ypy.timeout(20)
            assert.equal(busy('#t'), 'true')
            h.release()
            await forRequest()
        })
    })

    describe('live region', function() {
        beforeEach(function() {
            setupTest(this.currentTest)
            regions().forEach(r => r.remove())
            ypy.config.announce = {messages: {done: 'Finished', loading: 'Loading', offline: 'No connection', error: 'Something failed'}}
        })

        it('__initA11y creates the polite region once, however often it runs', function() {
            ypy.__initA11y()
            ypy.__initA11y()
            ypy.initialize()
            assert.equal(regions().length, 1)
            let r = region()
            assert.equal(r.getAttribute('role'), 'status')
            assert.equal(r.getAttribute('aria-live'), 'polite')
            assert.equal(r.parentNode, document.body)
        })

        it('__initA11y creates nothing when config.announce is false', function() {
            ypy.config.announce = false
            ypy.__initA11y()
            assert.equal(regions().length, 0)
        })

        it('is created on demand by the first announcement and reused after', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(regions().length, 1)
            let first = region()
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(regions().length, 1)
            assert.strictEqual(region(), first)
        })

        it('is recreated when a swap of the body removed it', async function() {
            ypy.__initA11y()
            region().remove()
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Finished')
        })

        it('is hidden by an adopted style sheet, with no inline style', async function() {
            ypy.__liveRegion('polite')
            let r = region()
            assert.isFalse(r.hasAttribute('style'))
            assert.isTrue(document.adoptedStyleSheets.some(s => [...s.cssRules].some(rule => rule.selectorText === '[data-ypy-live]')))
            let box = r.getBoundingClientRect()
            assert.isAtMost(box.width, 1)
            assert.isAtMost(box.height, 1)
        })

        it('is emptied after config.announce.clearAfter', async function() {
            ypy.config.announce.clearAfter = 60
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await ypy.timeout(100)
            assert.equal(region().textContent, 'Finished')
            await ypy.timeout(120)
            assert.equal(region().textContent, '')
        })

        it('says the same text again: empties first, writes a moment later', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Finished')
            find('#b').click()
            await forRequest()
            assert.equal(region().textContent, '', 'empty right after the second request')
            await settled()
            assert.equal(region().textContent, 'Finished')
        })
    })

    describe('announcements', function() {
        beforeEach(function() {
            setupTest(this.currentTest)
            regions().forEach(r => r.remove())
        })

        it('says nothing by default: the core carries no text of its own', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            let said = []
            document.addEventListener('ypy:announce', e => said.push(e.detail.message), {once: true})
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(said.length, 0)
            assert.isTrue(regions().every(r => r.textContent === ''))
        })

        it('ypy-announce on the source element is literal text', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="Item saved">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region('polite').textContent, 'Item saved')
            assert.equal(region('polite').getAttribute('role'), 'status')
        })

        it('the text is not parsed as HTML', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="&lt;b&gt;bold&lt;/b&gt;">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, '<b>bold</b>')
            assert.equal(region().children.length, 0)
        })

        it('ypy-announce on the target is used when the source has none', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t" ypy-announce="List updated"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'List updated')
        })

        it('the source element wins over the target', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="From source">Go</button><div id="t" ypy-announce="From target"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'From source')
        })

        it('ypy-announce:inherited reaches the request from an ancestor', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<div ypy-announce:inherited="Inherited text"><button id="b" ypy-get="/x" ypy-target="#t">Go</button></div><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Inherited text')
        })

        it('ypy-announce="title" says the new document title', async function() {
            mockResponse('GET', '/x', '<title>Fresh page</title><p>ok</p>')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="title">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Fresh page')
        })

        it('ypy-announce="none" says nothing, even with a configured message', async function() {
            ypy.config.announce = {messages: {done: 'Finished'}}
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="none">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.isTrue(regions().every(r => r.textContent === ''))
        })

        it('a boosted navigation says the new title by default', async function() {
            mockResponse('GET', '/page', '<title>Next page</title><p>ok</p>')
            createProcessedHTML('<div id="t"></div><a id="a" href="/page" ypy-boost="true" ypy-target="#t" ypy-push-url="false">Go</a>')
            find('#a').click()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Next page')
        })

        it('a boosted navigation does not say the title again when the focus moved to the heading', async function() {
            mockResponse('GET', '/page', '<title>Next page</title><main><h1>Next page</h1></main>')
            createProcessedHTML('<div id="t"></div><a id="a" href="/page" ypy-boost="true" ypy-target="#t" ypy-push-url="false">Go</a>')
            find('#a').click()
            await forRequest()
            await settled()
            assert.equal(document.activeElement.tagName, 'H1')
            assert.isTrue(regions().every(r => r.textContent === ''))
            document.activeElement.blur()
        })

        it('a boosted navigation can opt out with ypy-announce="none"', async function() {
            mockResponse('GET', '/page', '<title>Next page</title><p>ok</p>')
            createProcessedHTML('<div id="t"></div><a id="a" href="/page" ypy-boost="true" ypy-target="#t" ypy-push-url="false" ypy-announce="none">Go</a>')
            find('#a').click()
            await forRequest()
            await settled()
            assert.isTrue(regions().every(r => r.textContent === ''))
        })

        it('config.announce.messages: loading, then done', async function() {
            ypy.config.announce = {messages: {loading: 'Loading', done: 'Finished'}}
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await settled()
            assert.equal(region().textContent, 'Loading')
            h.release()
            await forRequest()
            await settled()
            assert.equal(region().textContent, 'Finished')
        })

        it('a failed request is assertive, with the error message', async function() {
            ypy.config.announce = {messages: {done: 'Finished', error: 'Something failed', offline: 'No connection'}}
            mockResponse('GET', '/x', 'bad', {status: 500})
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="Saved">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region('assertive').textContent, 'Something failed')
            assert.equal(region('assertive').getAttribute('role'), 'alert')
            assert.equal(region('assertive').getAttribute('aria-live'), 'assertive')
            assert.notEqual(region('polite')?.textContent, 'Saved', 'the success text is not said on failure')
        })

        it('a network failure says the offline message, assertive', async function() {
            ypy.config.announce = {messages: {error: 'Something failed', offline: 'No connection'}}
            mockFailure('GET', '/x')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(region('assertive').textContent, 'No connection')
        })

        it('ctx.errorKind picks the message and the politeness', function() {
            ypy.config.announce = {messages: {error: 'Something failed', offline: 'No connection'}}
            let said = []
            let h = e => said.push([e.detail.message, e.detail.politeness])
            document.addEventListener('ypy:announce', h)
            try {
                for (let errorKind of ['validation', 'client', 'server', 'network', 'offline']) {
                    ypy.__announce({sourceElement: document.body, status: 'response received', errorKind, request: {}})
                }
            } finally {
                document.removeEventListener('ypy:announce', h)
            }
            assert.deepEqual(said, [
                ['Something failed', 'assertive'], ['Something failed', 'assertive'], ['Something failed', 'assertive'],
                ['No connection', 'assertive'], ['No connection', 'assertive']
            ])
        })

        it('ctx.announce set by another phase is said, and false is silence', async function() {
            let said = []
            let h = e => said.push(e.detail.message)
            document.addEventListener('ypy:announce', h)
            try {
                ypy.__announce({sourceElement: document.body, status: 'swapped', announce: 'From a phase', request: {}})
                ypy.__announce({sourceElement: document.body, status: 'swapped', announce: false, request: {}})
                ypy.__announce({sourceElement: document.body, status: 'swapped', announce: 'none', request: {}})
            } finally {
                document.removeEventListener('ypy:announce', h)
            }
            assert.deepEqual(said, ['From a phase'])
        })

        it('a silent abort says nothing', async function() {
            ypy.config.announce = {messages: {error: 'Something failed', offline: 'No connection'}}
            let said = []
            document.addEventListener('ypy:announce', e => said.push(e), {once: true})
            let h = held('/slow')
            createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><div id="t"></div>')
            find('#b').addEventListener('ypy:before:request', e => setTimeout(() => e.detail.ctx.request.abort(), 10))
            find('#b').click()
            await forRequest(400)
            await settled()
            assert.equal(said.length, 0)
        })

        it('ypy:announce is cancelable and carries message and politeness', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="Saved">Go</button><div id="t"></div>')
            let detail
            let cancel = e => { detail = e.detail; e.preventDefault() }
            document.addEventListener('ypy:announce', cancel)
            try {
                find('#b').click()
                await forRequest()
                await settled()
            } finally {
                document.removeEventListener('ypy:announce', cancel)
            }
            assert.equal(detail.message, 'Saved')
            assert.equal(detail.politeness, 'polite')
            assert.exists(detail.ctx)
            assert.isTrue(regions().every(r => r.textContent === ''), 'cancelled, so nothing was written')
        })

        it('a ypy:announce listener can change the message and the politeness', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="Saved">Go</button><div id="t"></div>')
            let change = e => { e.detail.message = 'Rewritten'; e.detail.politeness = 'assertive' }
            document.addEventListener('ypy:announce', change)
            try {
                find('#b').click()
                await forRequest()
                await settled()
            } finally {
                document.removeEventListener('ypy:announce', change)
            }
            assert.equal(region('assertive').textContent, 'Rewritten')
        })

        it('config.announce = false turns announcements off', async function() {
            ypy.config.announce = false
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t" ypy-announce="Saved">Go</button><div id="t"></div>')
            find('#b').click()
            await forRequest()
            await settled()
            assert.equal(regions().length, 0)
        })

        it('the event fires on the document when the source element was replaced', async function() {
            mockResponse('GET', '/x', 'ok')
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="this" ypy-swap="outerHTML" ypy-announce="Replaced">Go</button>')
            let seen
            document.addEventListener('ypy:announce', e => seen = e.detail.message, {once: true})
            find('#b').click()
            await forRequest()
            assert.equal(seen, 'Replaced')
        })
    })
})
