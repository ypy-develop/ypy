// SPDX-License-Identifier: MIT
// TASK-008: the request queue lives outside the element. A node that morph reuses for other
// content (and a node that is removed) does not hand its queue to what comes next.
describe('Request queue and morph', function() {

    let dropped, onDropped, seq

    beforeEach(function() {
        dropped = []
        onDropped = evt => dropped.push(evt.detail)
        document.addEventListener('ypy:request:dropped', onDropped)
        seq = mockSequentialResponses('POST', '/old', '<i>old</i>')
        mockResponse('POST', '/fresh', '<i>fresh</i>')
        // the morph rewrites ypy-post, which restarts the button (the cleanup under test)
        mockResponse('GET', '/swap', '<button id="b" ypy-post="/fresh" ypy-swap="none" ypy-sync="this:queue all">go</button>')
    })

    afterEach(async function() {
        document.removeEventListener('ypy:request:dropped', onDropped)
        for (let i = 0; i < 12; i++) {
            await ypy.timeout(5)
            if (seq.pendingCount) await seq.next()
        }
        cleanupTest()
    })

    const OLD = '<button id="b" ypy-post="/old" ypy-swap="none" ypy-sync="this:queue all">go</button>'

    async function pile() {
        let btn = createProcessedHTML(OLD)
        btn.click()                       // in flight, holds the slot
        await ypy.timeout(5)
        btn.click(); btn.click()          // two waiting
        await ypy.timeout(5)
        return btn
    }

    async function morphIn() {
        await ypy.ajax('GET', '/swap', {target: '#b', swap: 'outerMorph'})
    }

    it('the morphed node starts with an empty queue and the old requests never run', async function() {
        setupTest(null)
        let btn = await pile()
        let queue = ypy.__requestQueues.get(btn)
        assert.equal(queue.pending, 3)

        await morphIn()
        assert.equal(find('#b'), btn, 'morph reuses the node')
        assert.equal(btn.getAttribute('ypy-post'), '/fresh')
        assert.equal(queue.pending, 0, 'the old queue was emptied')
        assert.notExists(ypy.__requestQueues.get(btn), 'and left the registry')
        assert.deepEqual(dropped.map(d => d.reason), ['cleanup', 'cleanup'])

        // the new content runs at once: the slot of the old in-flight request is not held against it
        let finished = []
        btn.addEventListener('ypy:finally:request', e => finished.push(e.detail.ctx.request.action))
        btn.click()
        await ypy.timeout(10)
        assert.deepEqual(finished, ['/fresh'], 'the fresh request ran while the old one is still in flight')
        assert.equal(seq.pendingCount, 1, 'only the old in-flight request is still waiting for its response')
        assert.equal(ypy.__requestQueues.get(btn).pending, 0, 'and finished')
        assert.notEqual(ypy.__requestQueues.get(btn), queue)

        // finishing the old request frees nothing in the new queue and runs nothing old
        await seq.next()
        await ypy.timeout(10)
        assert.deepEqual(finished, ['/fresh', '/old'], 'the two waiting requests of the old content never ran')
        assert.equal(seq.pendingCount, 0)
        assert.equal(ypy.__requestQueues.get(btn).pending, 0)
    })

    it('a removed element drops its waiting requests', async function() {
        setupTest(null)
        let btn = await pile()
        ypy.__cleanup(btn)
        btn.remove()
        assert.deepEqual(dropped.map(d => d.reason), ['cleanup', 'cleanup'])
        assert.equal(dropped[0].ctx.sourceElement, btn)
        await seq.next()
        await ypy.timeout(10)
        assert.equal(seq.pendingCount, 0, 'no waiting request was issued after the element went away')
    })

    it('cleanup of an element without requests is harmless', function() {
        setupTest(null)
        let btn = createProcessedHTML('<button ypy-post="/old">go</button>')
        ypy.__cleanup(btn, true)
        assert.notExists(ypy.__requestQueues.get(btn))
    })

    it('the element carries no queue of its own', async function() {
        setupTest(null)
        let btn = await pile()
        assert.notExists(ypy.__ypyState(btn).rq)
        assert.notExists(btn._ypy_state?.rq)
    })
})
