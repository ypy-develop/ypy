// SPDX-License-Identifier: MIT
// TASK-008: ypy-sync takes SELECTOR:STRATEGY, is inheritable with :inherited, and accepts the
// `target` selector.
describe('ypy-sync attribute', function() {

    beforeEach(function() {
        setupTest(this.currentTest)
    })

    afterEach(function() {
        cleanupTest()
    })

    const ctxOf = btn => ypy.__createRequestContext(btn, new Event('click'))

    describe('spellings and strategies', function() {
        for (let attr of ['ypy-sync', 'data-ypy-sync']) {
            it(`${attr} sets the strategy`, function() {
                let div = createProcessedHTML(`<div ypy-get="/t" ${attr}="this:replace"></div>`)
                assert.equal(ypy.__determineSyncStrategy(div), 'replace')
                assert.equal(ypy.__getRequestQueue(div), ypy.__getRequestQueue(div))
            })
        }

        it('defaults to queue first without the attribute', function() {
            let div = createProcessedHTML('<div ypy-get="/t"></div>')
            assert.equal(ypy.__determineSyncStrategy(div), 'queue first')
        })

        it('a bare strategy applies to the element itself', function() {
            let div = createProcessedHTML('<div ypy-get="/t" ypy-sync="drop"></div>')
            assert.equal(ypy.__determineSyncStrategy(div), 'drop')
            assert.equal(ypy.__requestQueues.get(div), undefined)
            let queue = ypy.__getRequestQueue(div)
            assert.equal(ypy.__requestQueues.get(div), queue)
        })

        it('an unknown strategy falls back to queue first', function() {
            let div = createProcessedHTML('<div ypy-get="/t" ypy-sync="this:nonsense"></div>')
            assert.equal(ypy.__determineSyncStrategy(div), 'queue first')
        })
    })

    describe('which element owns the queue', function() {
        it('a selector names the sync element', function() {
            let html = '<div id="panel"><button id="a" ypy-get="/t" ypy-sync="#panel:drop"></button>' +
                '<button id="b" ypy-get="/t" ypy-sync="#panel:drop"></button></div>'
            createProcessedHTML(html)
            assert.equal(ypy.__getRequestQueue(find('#a')), ypy.__getRequestQueue(find('#b')))
            assert.equal(ypy.__requestQueues.get(find('#panel')), ypy.__getRequestQueue(find('#a')))
        })

        it('closest form shares the queue of every button in the form', function() {
            let form = createProcessedHTML('<form><button id="a" ypy-post="/t" ypy-sync="closest form:replace"></button>' +
                '<button id="b" ypy-post="/t" ypy-sync="closest form:replace"></button></form>')
            let queue = ypy.__getRequestQueue(find('#a'))
            assert.equal(ypy.__requestQueues.get(form), queue)
            assert.equal(ypy.__getRequestQueue(find('#b')), queue)
            assert.equal(ypy.__determineSyncStrategy(find('#a')), 'replace')
        })

        it('this names the element itself', function() {
            let div = createProcessedHTML('<div ypy-get="/t" ypy-sync="this:abort"></div>')
            assert.equal(ypy.__requestQueues.get(div), undefined)
            assert.equal(ypy.__getRequestQueue(div), ypy.__getRequestQueue(div))
            assert.equal(ypy.__requestQueues.get(div), ypy.__getRequestQueue(div))
        })

        it('target keys the queue by the resolved request target', function() {
            createProcessedHTML('<div><div id="panel"></div>' +
                '<button id="a" ypy-get="/t" ypy-target="#panel" ypy-sync="target:drop"></button>' +
                '<button id="b" ypy-get="/t" ypy-target="#panel" ypy-sync="target:drop"></button>' +
                '<button id="c" ypy-get="/t" ypy-target="#other" ypy-sync="target:drop"></button><div id="other"></div></div>')
            let qa = ypy.__getRequestQueue(find('#a'), ctxOf(find('#a')))
            let qb = ypy.__getRequestQueue(find('#b'), ctxOf(find('#b')))
            let qc = ypy.__getRequestQueue(find('#c'), ctxOf(find('#c')))
            assert.equal(qa, qb, 'two buttons that update the same panel share a queue')
            assert.notEqual(qa, qc)
            assert.equal(ypy.__requestQueues.get(find('#panel')), qa)
            assert.equal(ypy.__determineSyncStrategy(find('#a')), 'drop')
        })

        it('target without a strategy uses queue first', function() {
            createProcessedHTML('<div><div id="panel"></div><button id="a" ypy-get="/t" ypy-target="#panel" ypy-sync="target"></button></div>')
            assert.equal(ypy.__determineSyncStrategy(find('#a')), 'queue first')
            assert.equal(ypy.__getRequestQueue(find('#a'), ctxOf(find('#a'))), ypy.__requestQueues.get(find('#panel')))
        })

        it('target serializes two buttons that update the same panel', async function() {
            let seq = mockSequentialResponses('GET', '/t', '<i>ok</i>')
            createProcessedHTML('<div><div id="panel"></div>' +
                '<button id="a" ypy-get="/t" ypy-target="#panel" ypy-sync="target:drop"></button>' +
                '<button id="b" ypy-get="/t" ypy-target="#panel" ypy-sync="target:drop"></button></div>')
            let dropped = []
            document.addEventListener('ypy:request:dropped', e => dropped.push(e.detail), {once: true})
            find('#a').click()
            await ypy.timeout(5)
            find('#b').click()
            await ypy.timeout(5)
            assert.equal(dropped.length, 1)
            assert.equal(dropped[0].ctx.sourceElement, find('#b'))
            assert.equal(dropped[0].reason, 'drop')
            await seq.next()
            await forRequest()
            assert.equal(find('#panel').innerHTML, '<i>ok</i>')
        })

        it('target without a target element falls back to the element itself', function() {
            let btn = createProcessedHTML('<button ypy-get="/t" ypy-sync="target:drop"></button>')
            let ctx = ctxOf(btn)
            assert.equal(ypy.__getRequestQueue(btn, ctx), ypy.__requestQueues.get(ctx.target))
        })
    })

    describe('inheritance', function() {
        it('ypy-sync:inherited applies to the descendants', function() {
            let parent = createProcessedHTML('<div id="p" ypy-sync:inherited="this:replace"><button id="a" ypy-get="/t"></button>' +
                '<button id="b" ypy-get="/t"></button></div>')
            assert.equal(ypy.__determineSyncStrategy(find('#a')), 'replace')
            assert.equal(ypy.__getRequestQueue(find('#a')), ypy.__getRequestQueue(find('#b')))
            assert.equal(ypy.__requestQueues.get(parent), ypy.__getRequestQueue(find('#a')),
                'an inherited "this" is the element that declares the attribute')
        })

        it('ypy-sync:inherited with a selector shares one queue', function() {
            createProcessedHTML('<div id="p" ypy-sync:inherited="#p:drop"><button id="a" ypy-get="/t"></button>' +
                '<button id="b" ypy-get="/t"></button></div>')
            assert.equal(ypy.__getRequestQueue(find('#a')), ypy.__getRequestQueue(find('#b')))
            assert.equal(ypy.__requestQueues.get(find('#p')), ypy.__getRequestQueue(find('#a')))
            assert.equal(ypy.__determineSyncStrategy(find('#b')), 'drop')
        })

        it('without :inherited the attribute stays on its element', function() {
            createProcessedHTML('<div id="p" ypy-sync="#p:drop"><button id="a" ypy-get="/t"></button></div>')
            assert.equal(ypy.__determineSyncStrategy(find('#a')), 'queue first')
        })
    })
})
