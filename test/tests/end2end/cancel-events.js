// SPDX-License-Identifier: MIT
// TASK-008: no request is cancelled, refused or replaced without an event. The strategies
// are checked elsewhere; only the events and their reasons are checked here.
describe('Request cancel events (ypy:request:queued, dropped, aborted)', function() {

    let seen, listener, seq

    beforeEach(function() {
        setupTest(this.currentTest)
        seen = []
        listener = evt => seen.push({type: evt.type.slice('ypy:request:'.length), reason: evt.detail.reason, detail: evt.detail, target: evt.target})
        for (let name of ['queued', 'dropped', 'aborted']) document.addEventListener('ypy:request:' + name, listener)
        seq = mockSequentialResponses('GET', '/x', '<i>ok</i>')
    })

    afterEach(async function() {
        for (let name of ['queued', 'dropped', 'aborted']) document.removeEventListener('ypy:request:' + name, listener)
        // let whatever is still waiting run to its end
        for (let i = 0; i < 12; i++) {
            await ypy.timeout(5)
            if (seq.pendingCount) await seq.next()
        }
        delete ypy.config.defaultTimeout
        cleanupTest()
    })

    const types = () => seen.map(e => e.type + ':' + e.reason)

    async function clicks(elt, n) {
        for (let i = 0; i < n; i++) {
            elt.click()
            await ypy.timeout(1)
        }
    }

    it('a single request fires no request event', async function() {
        let div = createProcessedHTML('<button ypy-get="/x" ypy-swap="none"></button>')
        div.click()
        await ypy.timeout(5)
        await seq.next()
        await forRequest()
        assert.deepEqual(seen, [])
    })

    it('drop: the refused request is reported as dropped with reason drop', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:drop"></button>')
        await clicks(btn, 3)
        assert.deepEqual(types(), ['dropped:drop', 'dropped:drop'])
        assert.equal(seen[0].target, btn)
        assert.notEqual(seen[0].detail.ctx, seen[1].detail.ctx)
        assert.equal(seen[0].detail.ctx.status, 'created')
    })

    it('abort: a request refused behind an abort request is reported with reason abort', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:abort"></button>')
        await clicks(btn, 2)
        assert.deepEqual(types(), ['dropped:abort'])
    })

    it('abort: an abort request displaced by another strategy is reported as aborted with reason abort', async function() {
        let html = '<div id="p"><button id="a" ypy-get="/x" ypy-swap="none" ypy-sync="#p:abort"></button>' +
            '<button id="b" ypy-get="/x" ypy-swap="none" ypy-sync="#p:drop"></button></div>'
        createProcessedHTML(html)
        let errors = []
        document.addEventListener('ypy:error', e => errors.push(e), {once: true})
        find('#a').click()
        await ypy.timeout(5)
        let first = null
        document.addEventListener('ypy:request:aborted', e => first = e.detail.ctx, {once: true})
        find('#b').click()
        await ypy.timeout(5)
        assert.deepEqual(types(), ['aborted:abort'])
        assert.equal(seen[0].target, find('#a'))
        assert.equal(first.sourceElement, find('#a'))
        assert.equal(errors.length, 0, 'an abort stays silent for ypy:error')
    })

    it('replace: the request in flight is reported as aborted with reason replace and ypy:error stays quiet', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:replace"></button>')
        let errors = 0
        document.addEventListener('ypy:error', () => errors++)
        await clicks(btn, 2)
        assert.deepEqual(types(), ['aborted:replace'])
        await ypy.timeout(5)
        assert.equal(errors, 0)
    })

    it('replace: the waiting requests are reported as dropped with reason replace', async function() {
        let html = '<div id="p"><button id="a" ypy-get="/x" ypy-swap="none" ypy-sync="#p:queue all"></button>' +
            '<button id="r" ypy-get="/x" ypy-swap="none" ypy-sync="#p:replace"></button></div>'
        createProcessedHTML(html)
        await clicks(find('#a'), 3)
        assert.deepEqual(types(), ['queued:queue', 'queued:queue'])
        seen.length = 0
        find('#r').click()
        await ypy.timeout(1)
        assert.deepEqual(types().sort(), ['aborted:replace', 'dropped:replace', 'dropped:replace'])
    })

    it('queue first: the second request is queued, the third is dropped as queue-overflow', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none"></button>')
        await clicks(btn, 3)
        assert.deepEqual(types(), ['queued:queue', 'dropped:queue-overflow'])
    })

    it('queue last: each new request replaces the waiting one, which is reported as dropped', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:queue last"></button>')
        await clicks(btn, 4)
        assert.deepEqual(types(), ['queued:queue', 'dropped:queue-overflow', 'queued:queue', 'dropped:queue-overflow', 'queued:queue'])
        let [firstQueued, , secondQueued] = seen
        assert.notEqual(firstQueued.detail.ctx, secondQueued.detail.ctx)
        assert.equal(seen[1].detail.ctx, firstQueued.detail.ctx, 'the dropped one is the one that was waiting')
    })

    it('queue all: every request waits', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:queue all"></button>')
        await clicks(btn, 4)
        assert.deepEqual(types(), ['queued:queue', 'queued:queue', 'queued:queue'])
    })

    it('every request is accounted for: five clicks produce exactly the events the strategy implies', async function() {
        // [queued, dropped, aborted] for five requests issued while the first is still in flight
        let expected = {
            'drop': [0, 4, 0], 'queue first': [1, 3, 0], 'queue last': [4, 3, 0],
            'queue all': [4, 0, 0], 'abort': [0, 4, 0], 'replace': [0, 0, 4],
        }
        for (let [sync, [queued, dropped, aborted]] of Object.entries(expected)) {
            seen.length = 0
            let btn = createProcessedHTML(`<button ypy-get="/x" ypy-swap="none" ypy-sync="this:${sync}"></button>`)
            await clicks(btn, 5)
            let count = type => seen.filter(e => e.type === type).length
            assert.deepEqual([count('queued'), count('dropped'), count('aborted')], [queued, dropped, aborted], sync)
            ypy.__cleanup(btn)
            btn.remove()
            await ypy.timeout(5)
            while (seq.pendingCount) await seq.next()
        }
    })

    it('timeout: the request is reported as aborted with reason timeout, and ypy:error still fires', async function() {
        ypy.config.defaultTimeout = 15
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none"></button>')
        let errors = []
        btn.addEventListener('ypy:error', e => errors.push(e))
        btn.click()
        await ypy.timeout(60)
        assert.deepEqual(types(), ['aborted:timeout'])
        assert.equal(errors.length, 1)
    })

    it('ypy:abort: the request is reported as aborted with reason user, once', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none"></button>')
        let errors = 0
        btn.addEventListener('ypy:error', () => errors++)
        btn.click()
        await ypy.timeout(5)
        ypy.trigger(btn, 'ypy:abort')
        ypy.trigger(btn, 'ypy:abort')
        await ypy.timeout(5)
        assert.deepEqual(types(), ['aborted:user'])
        assert.equal(errors, 0)
    })

    it('a direct ctx.request.abort() is reported with reason user', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none"></button>')
        let ctx
        btn.addEventListener('ypy:before:request', e => ctx = e.detail.ctx)
        btn.click()
        await ypy.timeout(5)
        ctx.request.abort()
        await ypy.timeout(5)
        assert.deepEqual(types(), ['aborted:user'])
        assert.equal(seen[0].detail.ctx, ctx)
    })

    it('an abort after the response arrived is not reported', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none"></button>')
        let ctx
        btn.addEventListener('ypy:before:request', e => ctx = e.detail.ctx)
        btn.click()
        await ypy.timeout(5)
        await seq.next()
        await forRequest()
        ctx.request.abort()
        assert.deepEqual(seen, [])
    })

    it('the events carry the request context of the request they are about', async function() {
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:drop"></button>')
        await clicks(btn, 2)
        assert.equal(seen[0].detail.ctx.sourceElement, btn)
        assert.equal(seen[0].detail.ctx.request.method, 'GET')
    })

    it('fires the same events for a drop', async function() {
        setupTest(null)
        let btn = createProcessedHTML('<button ypy-get="/x" ypy-swap="none" ypy-sync="this:drop"></button>')
        await clicks(btn, 2)
        assert.deepEqual(types(), ['dropped:drop'])
    })
})
