// SPDX-License-Identifier: MIT
// TASK-076: every request context has an id; a response is only applied while it is still the
// current one for its target (two queues on one target, ypy-sync="replace" and "latest"); "parallel"
// takes no queue; YPY-Group: atomic swaps all or nothing; ctx.timing and ctx.tasks trace a request;
// a skipped view transition leaves no unhandled rejection.
describe('Request generations, sync strategies and trace', function() {

    beforeEach(function() {
        setupTest(this.currentTest)
    })

    afterEach(function() {
        cleanupTest()
    })

    /** A URL whose responses are held until the test sends them, in any order. */
    function held(url) {
        let waiting = []
        mockResponse('GET', url, () => new Promise(resolve => waiting.push(resolve)))
        return {
            get count() { return waiting.length },
            send(i, html, headers) { waiting[i](new MockResponse(html, {headers})) }
        }
    }

    /** The contexts of every request, in the order they finished */
    function collectCtx() {
        let list = []
        let handler = evt => list.push(evt.detail.ctx)
        document.addEventListener('ypy:finally:request', handler)
        return {list, stop: () => document.removeEventListener('ypy:finally:request', handler)}
    }

    describe('a response is only applied while it is the current one', function() {

        it('replace: the old response never overwrites the new one', async function() {
            let r = held('/r')
            let btn = createProcessedHTML('<button ypy-get="/r" ypy-sync="this:replace" ypy-target="#out" ypy-swap="innerHTML">go</button>')
            createHTMLNoProcessing('<div id="out">start</div>')
            btn.click(); await ypy.timeout(10)
            btn.click(); await ypy.timeout(10)
            assert.equal(r.count, 2)
            r.send(1, 'new'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'new')
            r.send(0, 'old'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'new', 'the aborted request left the content alone')
        })

        it('two queues on one target: the older response that arrives last is discarded', async function() {
            let a = held('/a'), b = held('/b')
            let c = collectCtx()
            createProcessedHTML('<div><button id="a" ypy-get="/a" ypy-target="#out" ypy-swap="innerHTML">a</button>' +
                '<button id="b" ypy-get="/b" ypy-target="#out" ypy-swap="innerHTML">b</button><div id="out">start</div></div>')
            find('#a').click(); await ypy.timeout(10)
            find('#b').click(); await ypy.timeout(10)
            b.send(0, 'from b'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'from b')
            a.send(0, 'from a'); await ypy.timeout(20)
            c.stop()
            assert.equal(find('#out').textContent, 'from b', 'the older request did not overwrite the newer one')
            assert.equal(c.list.length, 2, 'both requests ended')
            assert.isBelow(c.list[1].id, c.list[0].id, 'the one that ended last is the older one')
        })

        it('two queues on one target: the older response that arrives first is applied, then the newer one wins', async function() {
            let a = held('/a'), b = held('/b')
            createProcessedHTML('<div><button id="a" ypy-get="/a" ypy-target="#out" ypy-swap="innerHTML">a</button>' +
                '<button id="b" ypy-get="/b" ypy-target="#out" ypy-swap="innerHTML">b</button><div id="out">start</div></div>')
            find('#a').click(); await ypy.timeout(10)
            find('#b').click(); await ypy.timeout(10)
            a.send(0, 'from a'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'from a')
            b.send(0, 'from b'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'from b')
        })

        it('a swap that only adds content is never discarded', async function() {
            let a = held('/a'), b = held('/b')
            createProcessedHTML('<div><button id="a" ypy-get="/a" ypy-target="#out" ypy-swap="beforeend">a</button>' +
                '<button id="b" ypy-get="/b" ypy-target="#out" ypy-swap="beforeend">b</button><div id="out"></div></div>')
            find('#a').click(); await ypy.timeout(10)
            find('#b').click(); await ypy.timeout(10)
            b.send(0, 'B'); await ypy.timeout(20)
            a.send(0, 'A'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'BA')
        })

        it('an abort during the swap delay is respected', async function() {
            let r = held('/r')
            let ctx
            let onAfter = evt => ctx = evt.detail.ctx
            document.addEventListener('ypy:after:request', onAfter)
            let btn = createProcessedHTML('<button ypy-get="/r" ypy-target="#out" ypy-swap="innerHTML swap:60ms">go</button>')
            createHTMLNoProcessing('<div id="out">start</div>')
            btn.click(); await ypy.timeout(10)
            r.send(0, 'late'); await ypy.timeout(25)
            document.removeEventListener('ypy:after:request', onAfter)
            assert.exists(ctx, 'the response arrived and the swap waits for its delay')
            ctx.request.abort()
            await ypy.timeout(100)
            assert.equal(find('#out').textContent, 'start', 'the aborted swap was not applied')
            assert.notInclude(find('#out').className, 'swapping')
        })
    })

    describe('ypy-sync latest and parallel', function() {

        it('latest: the older response is discarded when it arrives, before and after the newer one', async function() {
            let r = held('/r')
            let ctxs = collectCtx()
            let aborted = []
            let onAbort = evt => aborted.push(evt.detail.reason)
            document.addEventListener('ypy:request:aborted', onAbort)
            let btn = createProcessedHTML('<button ypy-get="/r" ypy-sync="this:latest" ypy-target="#out" ypy-swap="innerHTML">go</button>')
            createHTMLNoProcessing('<div id="out">start</div>')
            btn.click(); await ypy.timeout(10)
            btn.click(); await ypy.timeout(10)
            btn.click(); await ypy.timeout(10)
            assert.equal(r.count, 3, 'nothing waits and nothing is dropped')
            r.send(0, 'one'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'start', 'the first response was superseded')
            r.send(2, 'three'); await ypy.timeout(20)
            assert.equal(find('#out').textContent, 'three')
            r.send(1, 'two'); await ypy.timeout(20)
            ctxs.stop()
            document.removeEventListener('ypy:request:aborted', onAbort)
            assert.equal(find('#out').textContent, 'three', 'the newest request wins whatever the order of arrival')
            assert.deepEqual(aborted, [], 'latest does not abort the older requests')
            assert.isTrue(ctxs.list[0].superseded && ctxs.list[2].superseded)
            assert.notExists(ctxs.list[1].superseded)
        })

        it('parallel: requests of one element do not wait for each other', async function() {
            let r = held('/r')
            let btn = createProcessedHTML('<button ypy-get="/r" ypy-sync="this:parallel" ypy-target="#out" ypy-swap="beforeend">go</button>')
            createHTMLNoProcessing('<div id="out"></div>')
            btn.click(); btn.click(); btn.click()
            await ypy.timeout(20)
            assert.equal(r.count, 3, 'all three are in flight at once')
            assert.equal(ypy.__getRequestQueue(btn).pending, 0, 'and none holds a slot')
            r.send(2, 'c'); r.send(0, 'a'); r.send(1, 'b'); await ypy.timeout(30)
            assert.equal(find('#out').textContent, 'cab')
        })

        it('queue first stays the default: the second click waits', async function() {
            let r = held('/r')
            let btn = createProcessedHTML('<button ypy-get="/r" ypy-swap="none">go</button>')
            btn.click(); btn.click(); await ypy.timeout(20)
            assert.equal(r.count, 1)
            r.send(0, ''); await ypy.timeout(30)
            assert.equal(r.count, 2, 'the waiting request ran after the first ended')
            r.send(1, ''); await ypy.timeout(20)
        })
    })

    describe('YPY-Group: atomic', function() {
        const RESPONSE = 'main<div id="x" ypy-swap-oob="innerHTML">x new</div><div id="gone" ypy-swap-oob="innerHTML">lost</div>'
        const PAGE = '<div><button id="btn" ypy-get="/r" ypy-target="#out" ypy-swap="innerHTML">go</button>' +
            '<div id="out">out old</div><div id="x">x old</div></div>'

        it('without the header the tasks that can run are applied', async function() {
            let r = held('/r')
            createProcessedHTML(PAGE)
            find('#btn').click(); await ypy.timeout(10)
            r.send(0, RESPONSE); await ypy.timeout(30)
            assert.equal(find('#out').textContent, 'main')
            assert.equal(find('#x').textContent, 'x new')
        })

        it('with the header one task without a target stops them all', async function() {
            let r = held('/r')
            let failed = []
            let onMissing = evt => failed.push(evt.detail.selector)
            document.addEventListener('ypy:target:missing', onMissing)
            createProcessedHTML(PAGE)
            find('#btn').click(); await ypy.timeout(10)
            r.send(0, RESPONSE, {'YPY-Group': 'atomic'}); await ypy.timeout(30)
            document.removeEventListener('ypy:target:missing', onMissing)
            assert.equal(find('#out').textContent, 'out old')
            assert.equal(find('#x').textContent, 'x old')
            assert.isAbove(failed.length, 0, 'the missing target is reported')
        })

        it('with the header and every target present they are all applied', async function() {
            let r = held('/r')
            createProcessedHTML(PAGE)
            find('#btn').click(); await ypy.timeout(10)
            r.send(0, 'main<div id="x" ypy-swap-oob="innerHTML">x new</div>', {'YPY-Group': 'atomic'}); await ypy.timeout(30)
            assert.equal(find('#out').textContent, 'main')
            assert.equal(find('#x').textContent, 'x new')
        })

        it('with the header a refused swap does not touch the history', async function() {
            let r = held('/r')
            let url = location.href
            createProcessedHTML(PAGE.replace('ypy-target="#out"', 'ypy-target="#out" ypy-push-url="/atomic-refused"'))
            find('#btn').click(); await ypy.timeout(10)
            r.send(0, RESPONSE, {'YPY-Group': 'atomic'}); await ypy.timeout(30)
            assert.equal(location.href, url)
        })
    })

    describe('ctx.id, ctx.timing and ctx.tasks', function() {

        it('ids grow with every request context', function() {
            let btn = createProcessedHTML('<button ypy-get="/r">go</button>')
            let first = ypy.__createRequestContext(btn, new Event('click'))
            let second = ypy.__createRequestContext(btn, new Event('click'))
            assert.isNumber(first.id)
            assert.isAbove(second.id, first.id)
            assert.isNumber(first.timing.start)
        })

        it('a swapped request records its phases in order and keeps its tasks', async function() {
            mockResponse('GET', '/r', 'main<div id="x" ypy-swap-oob="innerHTML">x</div>')
            let c = collectCtx()
            createProcessedHTML('<div><button id="btn" ypy-get="/r" ypy-target="#out" ypy-swap="innerHTML">go</button>' +
                '<div id="out"></div><div id="x"></div></div>')
            find('#btn').click(); await forRequest()
            find('#btn').click(); await forRequest()
            c.stop()
            let [first, second] = c.list
            assert.isAbove(second.id, first.id)
            for (let ctx of c.list) {
                let t = ctx.timing
                for (let phase of ['start', 'sent', 'response', 'swapped', 'settled']) assert.isNumber(t[phase], phase)
                assert.isAtMost(t.start, t.sent)
                assert.isAtMost(t.sent, t.response)
                assert.isAtMost(t.response, t.swapped)
                assert.isAtMost(t.swapped, t.settled)
                assert.deepEqual(ctx.tasks.map(task => task.type), ['main', 'oob'])
            }
            assert.isAtLeast(second.timing.start, first.timing.settled, 'the second request waited for the first')
        })

        it('a request whose swap was cancelled has no swapped stamp but settles', async function() {
            mockResponse('GET', '/r', 'x')
            let c = collectCtx()
            let cancel = evt => evt.preventDefault()
            document.addEventListener('ypy:before:swap', cancel)
            createProcessedHTML('<button id="btn" ypy-get="/r">go</button>')
            find('#btn').click(); await forRequest()
            document.removeEventListener('ypy:before:swap', cancel)
            c.stop()
            assert.isNumber(c.list[0].timing.settled)
            assert.notExists(c.list[0].timing.swapped)
        })
    })

    describe('view transitions', function() {
        let realStart, realMedia, rejections

        const onRejection = evt => { rejections.push(evt.reason); evt.preventDefault() }

        beforeEach(function() {
            realStart = document.startViewTransition
            realMedia = window.matchMedia
            rejections = []
            window.addEventListener('unhandledrejection', onRejection)
        })

        afterEach(function() {
            window.removeEventListener('unhandledrejection', onRejection)
            document.startViewTransition = realStart
            window.matchMedia = realMedia
        })

        it('a skipped transition does not leave an unhandled rejection', async function() {
            let skipped = new Error('skipped')
            document.startViewTransition = update => {
                let done = Promise.resolve().then(update)
                return {ready: Promise.reject(skipped), updateCallbackDone: done, finished: done, skipTransition() {}}
            }
            mockResponse('GET', '/r', 'swapped')
            createProcessedHTML('<div><button id="btn" ypy-get="/r" ypy-target="#out" ypy-swap="innerHTML transition:true">go</button><div id="out">start</div></div>')
            find('#btn').click(); await forRequest()
            await ypy.timeout(50)   // unhandledrejection fires after the microtask checkpoint
            assert.equal(find('#out').textContent, 'swapped')
            assert.deepEqual(rejections, [])
        })

        it('prefers-reduced-motion swaps without a view transition', async function() {
            let started = 0
            document.startViewTransition = update => { started++; return realStart.call(document, update) }
            window.matchMedia = query => ({matches: /reduce/.test(query)})
            mockResponse('GET', '/r', 'swapped')
            createProcessedHTML('<div><button id="btn" ypy-get="/r" ypy-target="#out" ypy-swap="innerHTML transition:true">go</button><div id="out">start</div></div>')
            find('#btn').click(); await forRequest()
            assert.equal(find('#out').textContent, 'swapped')
            assert.equal(started, 0)
        })
    })
})
