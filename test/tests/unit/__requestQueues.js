// SPDX-License-Identifier: MIT
// TASK-008: the registry of request queues does not grow with the number of requests.
describe('request queue registry', function() {

    afterEach(function() {
        cleanupTest()
    })

    it('500 requests on one element leave one idle queue', async function() {
        this.timeout(20000)
        setupTest(this.currentTest)
        mockResponse('GET', '/m', '<i>ok</i>')
        let btn = createProcessedHTML('<button ypy-get="/m" ypy-swap="none"></button>')
        let first = ypy.__getRequestQueue(btn)
        for (let i = 0; i < 500; i++) {
            let done = forRequest(1000)
            btn.click()
            await done
        }
        assert.equal(ypy.__getRequestQueue(btn), first, 'always the same queue')
        assert.equal(first.pending, 0, 'nothing is left running or waiting')
        assert.equal(btn._ypy_state?.rq, undefined)
    })

    it('500 requests, half of them refused, leave nothing behind', async function() {
        this.timeout(20000)
        setupTest(this.currentTest)
        let seq = mockSequentialResponses('GET', '/m', '<i>ok</i>')
        let btn = createProcessedHTML('<button ypy-get="/m" ypy-swap="none" ypy-sync="this:drop"></button>')
        let dropped = 0
        let count = () => dropped++
        document.addEventListener('ypy:request:dropped', count)
        for (let i = 0; i < 250; i++) {
            btn.click()
            await ypy.timeout(0)
            btn.click()                  // refused while the first one is in flight
            await seq.next()
            await ypy.timeout(0)
        }
        document.removeEventListener('ypy:request:dropped', count)
        assert.equal(dropped, 250)
        assert.equal(ypy.__getRequestQueue(btn).pending, 0)
    })

    it('500 elements that come and go leave no queue registered', async function() {
        this.timeout(20000)
        setupTest(this.currentTest)
        let seq = mockSequentialResponses('GET', '/m', '<i>ok</i>')
        let elements = []
        for (let i = 0; i < 500; i++) {
            let btn = createProcessedHTML('<button ypy-get="/m" ypy-swap="none" ypy-sync="this:queue all"></button>')
            btn.click(); btn.click()      // one in flight, one waiting
            elements.push(btn)
            ypy.__cleanup(btn, true)
            btn.remove()
        }
        for (let btn of elements) assert.isFalse(ypy.__requestQueues.has(btn))
        await ypy.timeout(5)
        // no waiting request of a removed element was issued
        assert.equal(seq.pendingCount, 500)
        while (seq.pendingCount) await seq.next()
        await ypy.timeout(5)
        assert.equal(seq.pendingCount, 0)
    })
})
