// SPDX-License-Identifier: MIT
describe('__getRequestQueue / RequestQueue unit tests', function() {

    const noop = () => {}

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('allows first request when queue is empty', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)

        assert.equal(queue.admit('queue first', noop, noop), 'run')
    })

    it('queues request with "queue all" strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)

        queue.admit('queue all', noop, noop)
        let result = queue.admit('queue all', noop, noop)

        assert.equal(result, 'queued')
    })

    it('drops request with "drop" strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)

        queue.admit('drop', noop, noop)
        let result = queue.admit('drop', noop, noop)

        assert.equal(result, 'dropped')
    })

    it('queues only last with "queue last" strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let started = []

        queue.admit('queue last', () => started.push(1), noop)
        queue.admit('queue last', () => started.push(2), noop)
        let result = queue.admit('queue last', () => started.push(3), noop)

        assert.equal(result, 'queued')

        queue.continue(noop)
        queue.continue(noop)

        assert.deepEqual(started, [3])
    })

    it('replaces current request with "replace" strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('replace', noop, () => { aborted = true })
        let result = queue.admit('replace', noop, noop)

        assert.equal(result, 'run')
        assert.isTrue(aborted)
    })

    it('defaults to "queue first" when strategy not specified', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let started = []

        queue.admit('queue first', () => started.push(1), noop)
        let second = queue.admit('queue first', () => started.push(2), noop)
        let third = queue.admit('queue first', () => started.push(3), noop)

        assert.equal(second, 'queued')
        assert.equal(third, 'dropped')

        queue.continue(noop)
        queue.continue(noop)

        assert.deepEqual(started, [2])
    })

    it('continue runs the next queued request once', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let started = []

        queue.admit('queue all', () => started.push(1), noop)
        queue.admit('queue all', () => started.push(2), noop)
        queue.admit('queue all', () => started.push(3), noop)

        queue.continue(noop)

        assert.deepEqual(started, [2])
    })

    it('continue does nothing when the queue is empty', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)

        queue.continue(noop)
    })

    it('continue clears the current request', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)

        queue.admit('queue first', noop, noop)
        queue.continue(noop)

        assert.equal(queue.admit('queue first', noop, noop), 'run')
    })

    it('abort calls abort on the current request', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('queue first', noop, () => { aborted = true })
        queue.abort()

        assert.isTrue(aborted)
    })

    it('returns same queue for same element', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')

        let queue1 = ypy.__getRequestQueue(div)
        let queue2 = ypy.__getRequestQueue(div)

        assert.equal(queue1, queue2)
    })

    it('returns different queue for different elements', function () {
        let div1 = createProcessedHTML('<div ypy-get="/test1"></div>')
        let div2 = createProcessedHTML('<div ypy-get="/test2"></div>')

        let queue1 = ypy.__getRequestQueue(div1)
        let queue2 = ypy.__getRequestQueue(div2)

        assert.notEqual(queue1, queue2)
    })

    it('ypy-sync="drop" without selector uses drop strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="drop"></div>')
        let queue = ypy.__getRequestQueue(div)

        queue.admit(ypy.__determineSyncStrategy(div), noop, noop)
        let result = queue.admit(ypy.__determineSyncStrategy(div), noop, noop)

        assert.equal(result, 'dropped')
    })

    it('ypy-sync="abort" without selector uses abort strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="abort"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit(ypy.__determineSyncStrategy(div), noop, () => { aborted = true })
        let result = queue.admit(ypy.__determineSyncStrategy(div), noop, noop)

        assert.equal(result, 'dropped')
        assert.isFalse(aborted)
    })

    it('ypy-sync="selector:drop" uses drop strategy', function () {
        let container = createProcessedHTML('<div id="c"><div id="btn" ypy-get="/test" ypy-sync="#c:drop"></div></div>')
        let btn = container.querySelector('#btn')
        assert.equal(ypy.__determineSyncStrategy(btn), 'drop')
    })

    it('uses selector from ypy-sync for queue', function () {
        let container = createProcessedHTML('<div id="container"><div id="btn1" ypy-get="/test1" ypy-sync="#container:drop"></div><div id="btn2" ypy-get="/test2" ypy-sync="#container:drop"></div></div>')
        let btn1 = container.querySelector('#btn1')
        let btn2 = container.querySelector('#btn2')

        let queue1 = ypy.__getRequestQueue(btn1)
        let queue2 = ypy.__getRequestQueue(btn2)

        assert.equal(queue1, queue2)
    })

    it('inherited ypy-sync="this:replace" resolves queue to declaring parent', function () {
        let parent = createProcessedHTML('<div id="parent" ypy-sync:inherited="this:replace"><div id="a" ypy-get="/a"></div><div id="b" ypy-get="/b"></div></div>')
        let a = parent.querySelector('#a')
        let b = parent.querySelector('#b')

        let queueA = ypy.__getRequestQueue(a)
        let queueB = ypy.__getRequestQueue(b)

        // Both children should share the parent's queue
        assert.equal(queueA, queueB)
        assert.equal(ypy.__requestQueues.get(parent), queueA)
        assert.equal(ypy.__determineSyncStrategy(a), 'replace')
    })

    it('abort strategy: allows first abort request when queue is empty', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)

        assert.equal(queue.admit('abort', noop, noop), 'run')
    })

    it('abort strategy: any request can abort an abortable request', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('abort', noop, () => { aborted = true })
        let result = queue.admit('drop', noop, noop)

        assert.equal(result, 'run')
        assert.isTrue(aborted)
    })

    it('abort strategy: another abort request drops when abort request is in flight', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('abort', noop, () => { aborted = true })
        let result = queue.admit('abort', noop, noop)

        assert.equal(result, 'dropped')
        assert.isFalse(aborted)
    })

    it('abort strategy: abort request drops itself if non-abortable request is in flight', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('drop', noop, () => { aborted = true })
        let result = queue.admit('abort', noop, noop)

        assert.equal(result, 'dropped')
        assert.isFalse(aborted)
    })

    it('abort strategy: replace request can abort an abortable request', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('abort', noop, () => { aborted = true })
        let result = queue.admit('replace', noop, noop)

        assert.equal(result, 'run')
        assert.isTrue(aborted)
    })

    it('abort strategy: queue-all request can abort an abortable request', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('abort', noop, () => { aborted = true })
        let result = queue.admit('queue all', noop, noop)

        assert.equal(result, 'run')
        assert.isTrue(aborted)
    })

    it('abort strategy: abort request drops itself when replace request is in flight', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('replace', noop, () => { aborted = true })
        let result = queue.admit('abort', noop, noop)

        assert.equal(result, 'dropped')
        assert.isFalse(aborted)
    })

    it('abort strategy: abort request drops itself when queue-first request is in flight', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false

        queue.admit('queue first', noop, () => { aborted = true })
        let result = queue.admit('abort', noop, noop)

        assert.equal(result, 'dropped')
        assert.isFalse(aborted)
    })

    for (let strategy of ['replace', 'abort']) {
        it(`ignores cleanup of a replaced ${strategy} request`, async function () {
            let div = createProcessedHTML('<div ypy-get="/test"></div>')
            let queue = ypy.__getRequestQueue(div)
            let cleanup
            let abortFirst = () => { cleanup = Promise.resolve().then(() => queue.continue(abortFirst)) }
            let secondAborted = false
            let abortSecond = () => { secondAborted = true }
            let queuedStarted = false

            assert.equal(queue.admit(strategy, noop, abortFirst), 'run')
            assert.equal(queue.admit('replace', noop, abortSecond), 'run')
            assert.equal(queue.admit('queue all', () => { queuedStarted = true }, noop), 'queued')
            await cleanup

            assert.isFalse(queuedStarted)
            assert.equal(queue.admit('drop', noop, noop), 'dropped')
            assert.equal(queue.admit('replace', noop, noop), 'run')
            assert.isTrue(secondAborted)
        })
    }

    // ypy-sync value parsing tests

    it('ypy-sync="this" defaults to queue first strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="this"></div>')
        assert.equal(ypy.__determineSyncStrategy(div), 'queue first')
    })

    it('ypy-sync="this" uses same element for queue', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="this"></div>')
        let queue = ypy.__getRequestQueue(div)
        assert.isOk(queue)
    })

    it('ypy-sync="this:drop" uses drop strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="this:drop"></div>')
        assert.equal(ypy.__determineSyncStrategy(div), 'drop')
    })

    it('ypy-sync="this:replace" uses replace strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="this:replace"></div>')
        assert.equal(ypy.__determineSyncStrategy(div), 'replace')
    })

    it('ypy-sync="this:queue last" uses queue last strategy', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-sync="this:queue last"></div>')
        assert.equal(ypy.__determineSyncStrategy(div), 'queue last')
    })

    it('ypy-sync="closest form" uses closest form for queue with default strategy', function () {
        let form = createProcessedHTML('<form><div id="btn" ypy-get="/test" ypy-sync="closest form"></div></form>')
        let btn = form.querySelector('#btn')
        assert.equal(ypy.__determineSyncStrategy(btn), 'queue first')
        // queue should be on the form, not the button
        let queue = ypy.__getRequestQueue(btn)
        assert.equal(ypy.__requestQueues.get(form), queue)
    })

    it('ypy-sync="closest form:replace" uses closest form with replace strategy', function () {
        let form = createProcessedHTML('<form><div id="btn" ypy-get="/test" ypy-sync="closest form:replace"></div></form>')
        let btn = form.querySelector('#btn')
        assert.equal(ypy.__determineSyncStrategy(btn), 'replace')
        let queue = ypy.__getRequestQueue(btn)
        assert.equal(ypy.__requestQueues.get(form), queue)
    })

    it('ypy-sync with "this" shares queue between sibling elements synced to parent', function () {
        let container = createProcessedHTML('<div id="c"><div id="a" ypy-get="/a" ypy-sync="#c:drop"></div><div id="b" ypy-get="/b" ypy-sync="#c:drop"></div></div>')
        let a = container.querySelector('#a')
        let b = container.querySelector('#b')
        assert.equal(ypy.__getRequestQueue(a), ypy.__getRequestQueue(b))
    })

    it('replace strategy clears queued requests when aborting current', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let queue = ypy.__getRequestQueue(div)
        let aborted = false
        let started = []

        queue.admit('drop', noop, () => { aborted = true })
        queue.admit('queue all', () => started.push(2), noop)
        queue.admit('queue all', () => started.push(3), noop)

        let result = queue.admit('replace', noop, noop)

        assert.equal(result, 'run')
        assert.isTrue(aborted)

        queue.continue(noop)

        assert.deepEqual(started, [])
    })

});
