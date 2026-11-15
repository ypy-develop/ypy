// SPDX-License-Identifier: MIT
describe('ypy-trigger attribute', function() {
    beforeEach(function() {
        setupTest(this.currentTest)
    })
    afterEach(function() {
        cleanupTest()
    })

    it('non-default triggers work', async function () {
        mockResponse('GET', '/test', 'Clicked!')
        createProcessedHTML('<form ypy-get="/test" ypy-trigger="click">Click Me!</form>')
        find("form").click()
        await forRequest()
        playground().innerText.should.equal('Clicked!')
    })

    it('works with multiple events', async function () {
        mockResponse('GET', '/test', 'Clicked!')
        let div = createProcessedHTML('<div ypy-trigger="foo, bar" ypy-get="/test" ypy-swap="innerHTML">Requests: 0</div>');
        ypy.trigger(div, 'foo');
        await forRequest()
        ypy.trigger(div, 'bar');
        await forRequest()
        fetchMock.calls.length.should.equal(2)
    })

    it('filters properly with false expression filter spec', function() {
        mockResponse('GET', '/test', 'Called!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-trigger="evt[false]">Not Called</form>')
        let event = new CustomEvent("evt");
        event.foo = false
        form.dispatchEvent(event)
        fetchMock.calls.length.should.equal(0)
    })

    it('filters properly with false filter spec', function() {
        mockResponse('GET', '/test', 'Called!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-trigger="evt[foo]">Not Called</form>')
        let event = new CustomEvent("evt");
        event.foo = false
        form.dispatchEvent(event)
        fetchMock.calls.length.should.equal(0)
    })

    it('filters properly with true filter spec', async function() {
        mockResponse('GET', '/test', 'Called!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-trigger="evt[foo]">Not Called</form>')
        let event = new CustomEvent("evt");
        event.foo = true
        form.dispatchEvent(event)
        fetchMock.calls.length.should.equal(1)
        await forRequest()
    })

    it('filter does not throw when event has a non-identifier property', async function() {
        mockResponse('GET', '/test', 'Called!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-trigger="evt[foo]">Not Called</form>')
        let event = new CustomEvent('evt')
        event.foo = true
        event['__nrNode:1234'] = {}
        form.dispatchEvent(event)
        fetchMock.calls.length.should.equal(1)
        await forRequest()
    })

    it('filters properly with true expression filter spec', async function() {
        mockResponse('GET', '/test', 'Called!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-trigger="evt[true]">Not Called</form>')
        let event = new CustomEvent("evt");
        event.foo = true
        form.dispatchEvent(event)
        fetchMock.calls.length.should.equal(1)
        await forRequest()
    })

    for (let spec of ['every 20ms [this.dataset.go]', 'every 20ms[this.dataset.go]']) {
        it(`filters polling with \`${spec}\``, async function () {
            mockResponse('GET', '/test', 'Called!')
            let div = createProcessedHTML(`<div ypy-get="/test" ypy-trigger="${spec}"></div>`)
            await ypy.timeout(100)
            fetchMock.calls.length.should.equal(0)
            div.dataset.go = 'true'
            await forRequest()
            delete div.dataset.go
        })
    }

    it('can filter polling', async function () {
        mockResponse('GET', '/test', 'Called!')
        window.foo = false
        try {
            createProcessedHTML('<div id="d1" ypy-get="/test" ypy-trigger="every 5ms[foo]">Not Called</div>' +
                '<div id="d2" ypy-get="/test" ypy-trigger="every 5ms">Not Called</div>')
            await ypy.timeout(100)
            find('#d1').innerHTML.should.equal('Not Called')
            find('#d2').innerHTML.should.equal('Called!')
            find('#d1').remove()
        } finally {
            delete window.foo
        }
    })

    it('polling issues repeated requests', async function () {
        mockResponse('GET', '/test', 'Called!')
        createProcessedHTML('<div ypy-get="/test" ypy-trigger="every 5ms" ypy-swap="none"></div>')
        await ypy.timeout(100)
        fetchMock.calls.length.should.be.greaterThan(1)
    })

    it('removing the element stops polling', async function () {
        mockResponse('GET', '/test', 'Called!')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-trigger="every 5ms" ypy-swap="none"></div>')
        await ypy.timeout(50)
        div.remove()
        await ypy.timeout(20)
        let calls = fetchMock.calls.length
        await ypy.timeout(50)
        fetchMock.calls.length.should.equal(calls)
    })

    it('removing the polling trigger and force processing the element stops polling', async function () {
        mockResponse('GET', '/test', 'Called!')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-trigger="every 5ms" ypy-swap="none"></div>')
        div.removeAttribute('ypy-trigger')
        ypy.process(div, true)
        await ypy.timeout(20)
        let calls = fetchMock.calls.length
        await ypy.timeout(50)
        fetchMock.calls.length.should.equal(calls)
    })

    it('polling does not fire after a swap replaces the element', async function () {
        mockResponse('GET', '/test', '<span id="done">Done</span>')
        createProcessedHTML('<div id="poller" ypy-get="/test" ypy-trigger="every 5ms" ypy-swap="outerHTML"></div>')
        await ypy.timeout(60)
        assert.notExists(find('#poller'))
        fetchMock.calls.length.should.equal(1)
    })

    for (let sync of ['', 'ypy-sync="this:replace"']) {
        it(`submit cancels a pending delayed trigger ${sync}`, async function () {
            mockResponse('POST', '/test', 'Done')
            let form = createProcessedHTML(`<form ypy-post="/test" ypy-trigger="input delay:20ms, submit" ypy-swap="none" ${sync}></form>`)
            form.dispatchEvent(new Event('input'))
            form.dispatchEvent(new Event('submit', {cancelable: true}))
            await ypy.timeout(60)
            fetchMock.calls.length.should.equal(1)
            assert.isFalse(fetchMock.calls[0].request.signal.aborted)
        })
    }

    it('once modifier works', function () {
        mockResponse('GET', '/test', "Response")
        createProcessedHTML('<button ypy-trigger="click once" ypy-get="/test"/></button>')
        find('button').click()
        fetchMock.calls.length.should.equal(1)
        find('button').click()
        fetchMock.calls.length.should.equal(1)
    })

    it('event listeners can filter on target', function() {
        mockResponse('GET', '/test', "foo")
        createProcessedHTML('<div>' +
            '<div id="d1" ypy-trigger="click from:body target:#d3" ypy-get="/test">Requests: 0</div>' +
            '<div id="d2"></div>' +
            '<div id="d3"></div>' +
            '</div>')

        document.body.click()
        fetchMock.calls.length.should.equal(0)

        find('#d1').click()
        fetchMock.calls.length.should.equal(0)

        find('#d2').click()
        fetchMock.calls.length.should.equal(0)

        find('#d3').click()
        fetchMock.calls.length.should.equal(1)
    })


    it('consume prevents event propagation', async function () {
        mockResponse('GET', '/foo', 'foo')
        mockResponse('GET', '/bar', 'bar')
        createProcessedHTML(
            "<div ypy-trigger='click' ypy-get='/foo' ypy-target='#d3' ypy-swap='innerHTML'>" +
            "   <div id='d1' ypy-trigger='click consume' ypy-get='/bar'></div>" +
            "</div><div id='d3'>bar</div>")
        find('#d1').click()
        await forRequest()
        await ypy.timeout(100)
        // should not have been replaced by click
        find('#d3').innerText.should.equal('bar')
    })

    it('changed modifier suppresses request when input value is unchanged', async function () {
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        let input = createProcessedHTML('<input ypy-get="/test" ypy-trigger="keydown changed" value="hello">')
        // first fire records value and fires
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        // same value — suppressed
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        fetchMock.calls.length.should.equal(1)
        // changed value — fires
        input.value = 'world'
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(2)
    })

    it('changed modifier fires on form keydown when child input value changes', async function () {
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-swap="none" ypy-trigger="keydown changed"><input id="i" value="hello"></form>')
        let input = find('#i')
        // first fire records value and fires
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        // same value — suppressed
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        fetchMock.calls.length.should.equal(1)
        // changed value — fires
        input.value = 'world'
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(2)
    })

    it('changed modifier tracks each input independently', async function () {
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-swap="none" ypy-trigger="keydown changed"><input id="i1" value="a"><input id="i2" value="b"></form>')
        let i1 = find('#i1'), i2 = find('#i2')
        // first fire from i1 records value and fires
        i1.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        // fire from i1 unchanged — suppressed
        i1.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        fetchMock.calls.length.should.equal(1)
        // change i1, fire — fires
        i1.value = 'x'
        i1.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(2)
        // first fire from i2 records value and fires
        i2.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(3)
        // fire from i2 unchanged — suppressed
        i2.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        fetchMock.calls.length.should.equal(3)
    })

    it('changed modifier on checkbox fires on each click', async function () {
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        let input = createProcessedHTML('<input type="checkbox" ypy-get="/test" ypy-trigger="click changed">')
        input.click()
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        input.click()
        await forRequest()
        fetchMock.calls.length.should.equal(2)
        input.click()
        await forRequest()
        fetchMock.calls.length.should.equal(3)
    })

    it('changed modifier on radio fires on each click', async function () {
        mockResponse('GET', '/test', 'Changed!')
        mockResponse('GET', '/test', 'Changed!')
        let input = createProcessedHTML('<input type="radio" ypy-get="/test" ypy-trigger="click changed">')
        input.click()
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        input.click()
        await forRequest()
        fetchMock.calls.length.should.equal(2)
    })

    it('changed modifier shared across specs — blur does not double-fire after input changed', async function () {
        mockResponse('GET', '/test', 'Saved!')
        let input = createProcessedHTML('<input ypy-get="/test" ypy-trigger="keydown changed, blur changed" value="">')
        input.value = 'hello'
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        // blur with same value — shared WeakMap should suppress this
        input.dispatchEvent(new Event('blur', {bubbles: true}))
        fetchMock.calls.length.should.equal(1)
    })
    
    it('changed modifier with delay — blur fires immediately and pending timer does not double-fire', async function () {
        mockResponse('GET', '/test', 'Saved!')
        mockResponse('GET', '/test', 'Saved!')
        let input = createProcessedHTML('<input ypy-get="/test" ypy-trigger="keydown changed delay:50ms, blur changed" value="">')
        input.value = 'hello'
        input.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true}))
        // blur immediately before the 50ms delay fires
        input.dispatchEvent(new Event('blur', {bubbles: true}))
        await forRequest()
        fetchMock.calls.length.should.equal(1)
        // wait for the delay to expire — timer should be suppressed by changed check
        await ypy.timeout(100)
        fetchMock.calls.length.should.equal(1)
    })

    it('load event triggers on element creation', async function () {
        debug(this)
        mockResponse('GET', '/test', 'Loaded!')
        createProcessedHTML('<div ypy-get="/test" ypy-trigger="load">Not Loaded</div>')
        await forRequest()
        playground().innerText.should.equal('Loaded!')
    })

    // TODO figure out how to test throttling
    // it('throttle prevents multiple requests from happening', async function () {
    //     mockResponse('GET', '/test', "Success!")


    //     var div = initHTML("<div ypy-trigger='click throttle:20ms' ypy-get='/test'></div>")
    //
    //     // First click fires immediately
    //     div.click()
    //     await ypy.waitATick();
    //     fetchMock.calls.length.should.equal(1);
    //
    //     // Second click during throttle window - gets queued
    //     div.click()
    //     await ypy.waitATick();
    //     fetchMock.calls.length.should.equal(1); // Still just 1
    //
    //     // Wait for throttle to expire + trailing call (100ms + margin)
    //     await ypy.timeout(150);
    //     fetchMock.calls.length.should.equal(2); // Queued click now fired
    // })
    //


    // // This test and the next one should be kept in sync.
    // it('changed modifier works along from clause with two inputs', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var input1 = make('<input type="text"/>')
    //     var input2 = make('<input type="text"/>')
    //     make('<div ypy-trigger="click changed from:input" ypy-target="#d1" ypy-get="/test"></div>')
    //     var div = make('<div id="d1"></div>')
    //
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //
    //     input1.value = 'bar'
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //
    //     input2.value = 'foo'
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    // })
    //
    // // This test and the previous one should be kept in sync.
    // it('changed modifier counts each triggerspec separately', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var input1 = make('<input type="text"/>')
    //     var input2 = make('<input type="text"/>')
    //     make('<div ypy-trigger="click changed from:input" ypy-target="#d1" ypy-get="/test"></div>')
    //     make('<div ypy-trigger="click changed from:input" ypy-target="#d1" ypy-get="/test"></div>')
    //     var div = make('<div id="d1"></div>')
    //
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //
    //     input1.value = 'bar'
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    //
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    //
    //     input2.value = 'foo'
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 4')
    // })
    //
    // it('separate changed modifier works along from clause with two inputs', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var input1 = make('<input type="text"/>')
    //     var input2 = make('<input type="text"/>')
    //     make('<div ypy-trigger="click changed from:input:nth-child(1), click changed from:input:nth-child(2)" ypy-target="#d1" ypy-get="/test"></div>')
    //     var div = make('<div id="d1"></div>')
    //
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //
    //     input1.value = 'bar'
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('')
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //
    //     input2.value = 'foo'
    //     input1.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input2.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    // })
    //

    //
    // it('once modifier works with multiple triggers', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var input = make('<input ypy-trigger="click once, foo" ypy-target="#d1" ypy-get="/test" value="foo"/>')
    //     var div = make('<div id="d1"></div>')
    //     input.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input.value = 'bar'
    //     input.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     input.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     ypy.trigger(input, 'foo')
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    // })
    //

    //
    // it('non-default value works w/ data-* prefix', function() {
    //     this.server.respondWith('GET', '/test', 'Clicked!')
    //     var form = make('<form data-ypy-get="/test" data-ypy-trigger="click">Click Me!</form>')
    //     form.click()
    //     form.innerHTML.should.equal('Click Me!')
    //     this.server.respond()
    //     form.innerHTML.should.equal('Clicked!')
    // })
    //
    // it('works with multiple events', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div = make('<div ypy-trigger="load,click" ypy-get="/test">Requests: 0</div>')
    //     div.innerHTML.should.equal('Requests: 0')
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     div.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    // })
    //
    // it('parses spec strings', function() {
    //     var specExamples = {
    //         '': [{ trigger: 'click' }],
    //         'every 1s': [{ trigger: 'every', pollInterval: 1000 }],
    //         'every 0s': [{ trigger: 'every', pollInterval: 0 }],
    //         'every 0ms': [{ trigger: 'every', pollInterval: 0 }],
    //         click: [{ trigger: 'click' }],
    //         customEvent: [{ trigger: 'customEvent' }],
    //         'event changed': [{ trigger: 'event', changed: true }],
    //         'event once': [{ trigger: 'event', once: true }],
    //         'event throttle:1s': [{ trigger: 'event', throttle: 1000 }],
    //         'event throttle:0s': [{ trigger: 'event', throttle: 0 }],
    //         'event throttle:0ms': [{ trigger: 'event', throttle: 0 }],
    //         'event throttle:1s, foo': [{ trigger: 'event', throttle: 1000 }, { trigger: 'foo' }],
    //         'event delay:1s': [{ trigger: 'event', delay: 1000 }],
    //         'event delay:1s, foo': [{ trigger: 'event', delay: 1000 }, { trigger: 'foo' }],
    //         'event delay:0s, foo': [{ trigger: 'event', delay: 0 }, { trigger: 'foo' }],
    //         'event delay:0ms, foo': [{ trigger: 'event', delay: 0 }, { trigger: 'foo' }],
    //         'event changed once delay:1s': [{ trigger: 'event', changed: true, once: true, delay: 1000 }],
    //         'event1,event2': [{ trigger: 'event1' }, { trigger: 'event2' }],
    //         'event1, event2': [{ trigger: 'event1' }, { trigger: 'event2' }],
    //         'event1 once, event2 changed': [{ trigger: 'event1', once: true }, { trigger: 'event2', changed: true }],
    //         'event1,': [{ trigger: 'event1' }],
    //         '  ': [{ trigger: 'click' }]
    //     }
    //
    //     for (var specString in specExamples) {
    //         var div = make("<div ypy-trigger='" + specString + "'></div>")
    //         var spec = ypy._('getTriggerSpecs')(div)
    //         spec.should.deep.equal(specExamples[specString], 'Found : ' + JSON.stringify(spec) + ', expected : ' + JSON.stringify(specExamples[specString]) + ' for spec: ' + specString)
    //     }
    // })
    //
    // it('sets default trigger for forms', function() {
    //     var form = make('<form></form>')
    //     var spec = ypy._('getTriggerSpecs')(form)
    //     spec.should.deep.equal([{ trigger: 'submit' }])
    // })
    //
    // it('sets default trigger for form elements', function() {
    //     var form = make('<input></input>')
    //     var spec = ypy._('getTriggerSpecs')(form)
    //     spec.should.deep.equal([{ trigger: 'change' }])
    // })
    //
    // it('filters properly with false filter spec', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var form = make('<form ypy-get="/test" ypy-trigger="evt[foo]">Not Called</form>')
    //     form.click()
    //     form.innerHTML.should.equal('Not Called')
    //     var event = ypy._('makeEvent')('evt')
    //     form.dispatchEvent(event)
    //     this.server.respond()
    //     form.innerHTML.should.equal('Not Called')
    // })
    //
    // it('filters properly with true filter spec', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var form = make('<form ypy-get="/test" ypy-trigger="evt[foo]">Not Called</form>')
    //     form.click()
    //     form.innerHTML.should.equal('Not Called')
    //     var event = ypy._('makeEvent')('evt')
    //     event.foo = true
    //     form.dispatchEvent(event)
    //     this.server.respond()
    //     form.innerHTML.should.equal('Called!')
    // })
    //
    // it('filters properly compound filter spec', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="evt[foo&&bar]">Not Called</div>')
    //     var event = ypy._('makeEvent')('evt')
    //     event.foo = true
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Not Called')
    //     event.bar = true
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Called!')
    // })
    //
    // it('can refer to target element in condition', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="evt[target.classList.contains(\'doIt\')]">Not Called</div>')
    //     var event = ypy._('makeEvent')('evt')
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Not Called')
    //     div.classList.add('doIt')
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Called!')
    // })
    //
    // it('can refer to target element in condition w/ equality', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="evt[target.id==\'foo\']">Not Called</div>')
    //     var event = ypy._('makeEvent')('evt')
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Not Called')
    //     div.id = 'foo'
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Called!')
    // })
    //
    // it('negative condition', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="evt[!target.classList.contains(\'disabled\')]">Not Called</div>')
    //     div.classList.add('disabled')
    //     var event = ypy._('makeEvent')('evt')
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Not Called')
    //     div.classList.remove('disabled')
    //     div.dispatchEvent(event)
    //     this.server.respond()
    //     div.innerHTML.should.equal('Called!')
    // })
    //
    // it('global function call works', function() {
    //     window.globalFun = function(evt) {
    //         return evt.bar
    //     }
    //     try {
    //         this.server.respondWith('GET', '/test', 'Called!')
    //         var div = make('<div ypy-get="/test" ypy-trigger="evt[globalFun(event)]">Not Called</div>')
    //         var event = ypy._('makeEvent')('evt')
    //         event.bar = false
    //         div.dispatchEvent(event)
    //         this.server.respond()
    //         div.innerHTML.should.equal('Not Called')
    //         event.bar = true
    //         div.dispatchEvent(event)
    //         this.server.respond()
    //         div.innerHTML.should.equal('Called!')
    //     } finally {
    //         delete window.globalFun
    //     }
    // })
    //
    // it('global property event filter works', function() {
    //     window.foo = {
    //         bar: false
    //     }
    //     try {
    //         this.server.respondWith('GET', '/test', 'Called!')
    //         var div = make('<div ypy-get="/test" ypy-trigger="evt[foo.bar]">Not Called</div>')
    //         var event = ypy._('makeEvent')('evt')
    //         div.dispatchEvent(event)
    //         this.server.respond()
    //         div.innerHTML.should.equal('Not Called')
    //         foo.bar = true
    //         div.dispatchEvent(event)
    //         this.server.respond()
    //         div.innerHTML.should.equal('Called!')
    //     } finally {
    //         delete window.foo
    //     }
    // })
    //
    // it('global variable filter works', function() {
    //     try {
    //         this.server.respondWith('GET', '/test', 'Called!')
    //         var div = make('<div ypy-get="/test" ypy-trigger="evt[foo]">Not Called</div>')
    //         var event = ypy._('makeEvent')('evt')
    //         div.dispatchEvent(event)
    //         this.server.respond()
    //         div.innerHTML.should.equal('Not Called')
    //         window.foo = true
    //         div.dispatchEvent(event)
    //         this.server.respond()
    //         div.innerHTML.should.equal('Called!')
    //     } finally {
    //         delete window.foo
    //     }
    // })
    //
    // it('bad condition issues error', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="evt[a.b]">Not Called</div>')
    //     var errorEvent = null
    //     var handler = ypy.on('ypy:eventFilter:error', function(event) {
    //         errorEvent = event
    //     })
    //     try {
    //         var event = ypy._('makeEvent')('evt')
    //         div.dispatchEvent(event)
    //         should.not.equal(null, errorEvent)
    //         should.not.equal(null, errorEvent.detail.source)
    //         console.log(errorEvent.detail.source)
    //     } finally {
    //         ypy.off('ypy:eventFilter:error', handler)
    //     }
    // })
    //
    // it('filters properly with true for empty condition', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var form = make('<form ypy-get="/test" ypy-trigger="evt[]">Not Called</form>')
    //     form.click()
    //     form.innerHTML.should.equal('Not Called')
    //     var event = ypy._('makeEvent')('evt')
    //     form.dispatchEvent(event)
    //     this.server.respond()
    //     form.innerHTML.should.equal('Called!')
    // })
    //
    // it('syntax error in condition issues error', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var errorEvent = null
    //     var handler = ypy.on('ypy:syntax:error', function(event) {
    //         errorEvent = event
    //     })
    //     var form = make('<form ypy-get="/test" ypy-trigger="evt[{]">Not Called</form>')
    //     try {
    //         var event = ypy._('makeEvent')('evt')
    //         form.dispatchEvent(event)
    //         should.not.equal(null, errorEvent)
    //         should.not.equal(null, errorEvent.detail.source)
    //         console.log(errorEvent.detail.source)
    //     } finally {
    //         ypy.off('ypy:syntax:error', handler)
    //     }
    // })
    //
    it('filters properly with condition containing square brackets', async function() {
        mockResponse('GET', '/test', 'Called!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-trigger="evt[foo[0]]">Not Called</form>')
        let off = new CustomEvent('evt')
        off.foo = [false]
        form.dispatchEvent(off)
        fetchMock.calls.length.should.equal(0)
        let event = new CustomEvent('evt')
        event.foo = [true]
        form.dispatchEvent(event)
        await forRequest()
        form.innerHTML.should.equal('Called!')
    })

    it('filter with a bracket inside a quoted string', async function() {
        mockResponse('GET', '/test', 'Called!')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-trigger="evt[key==\'[\']">Not Called</div>')
        let event = new CustomEvent('evt')
        event.key = ']'
        div.dispatchEvent(event)
        fetchMock.calls.length.should.equal(0)
        event = new CustomEvent('evt')
        event.key = '['
        div.dispatchEvent(event)
        await forRequest()
        div.innerHTML.should.equal('Called!')
    })

    it('filter with a closing bracket inside a quoted string', async function() {
        mockResponse('GET', '/test', 'Called!')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-trigger="evt[key==\']\'] delay:1ms">Not Called</div>')
        let event = new CustomEvent('evt')
        event.key = ']'
        div.dispatchEvent(event)
        await forRequest()
        div.innerHTML.should.equal('Called!')
    })

    itSource('nested bracket filter works with modifiers and a second trigger', async function() {
        mockResponse('GET', '/test', 'Called!')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-trigger="evt[a[0][1]] once, other">Not Called</div>')
        let event = new CustomEvent('evt')
        event.a = [[0, true]]
        div.dispatchEvent(event)
        await forRequest()
        div.innerHTML.should.equal('Called!')
        ypy.__parseTriggerSpecs('evt[a[0][1]] once, other').map(s => s.name).should.deep.equal(['evt[a[0][1]]', 'other'])
    })

    itSource('every with a nested bracket filter keeps the interval first', function() {
        let [spec] = ypy.__parseTriggerSpecs('every 20ms [a[0]] queue:none')
        spec.name.should.equal('every[a[0]]')
        Object.keys(spec)[1].should.equal('20ms')
    })

    itSource('an unterminated filter still throws', function() {
        assert.throws(() => ypy.__parseTriggerSpecs('click[a[0]'), /unterminated/)
    })

    itSource('a bracket after a modifier is not a filter', function() {
        let [spec] = ypy.__parseTriggerSpecs('click from:input[type=text]')
        spec.name.should.equal('click')
        spec.from.should.equal('input[type=text]')
    })

    // it('from clause works', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div2 = make('<div id="d2"></div>')
    //     var div1 = make('<div ypy-trigger="click from:#d2" ypy-get="/test">Requests: 0</div>')
    //     div1.innerHTML.should.equal('Requests: 0')
    //     div1.click()
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 0')
    //     div2.click()
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with body selector', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div1 = make('<div ypy-trigger="click from:body" ypy-get="/test">Requests: 0</div>')
    //     div1.innerHTML.should.equal('Requests: 0')
    //     document.body.click()
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with document selector', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div1 = make('<div ypy-trigger="foo from:document" ypy-get="/test">Requests: 0</div>')
    //     div1.innerHTML.should.equal('Requests: 0')
    //     ypy.trigger(document, 'foo')
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with window selector', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div1 = make('<div ypy-trigger="foo from:window" ypy-get="/test">Requests: 0</div>')
    //     div1.innerHTML.should.equal('Requests: 0')
    //     ypy.trigger(window, 'foo')
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with closest clause', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div1 = make('<div><a id="a1" ypy-trigger="click from:closest div" ypy-get="/test">Requests: 0</a></div>')
    //     var a1 = byId('a1')
    //     a1.innerHTML.should.equal('Requests: 0')
    //     div1.click()
    //     this.server.respond()
    //     a1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with find clause', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div1 = make('<div ypy-trigger="click from:find a" ypy-target="#a1" ypy-get="/test"><a id="a1">Requests: 0</a></div>')
    //     var a1 = byId('a1')
    //     a1.innerHTML.should.equal('Requests: 0')
    //     a1.click()
    //     this.server.respond()
    //     a1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with next', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     make('<div ypy-trigger="click from:next" ypy-target="#a1" ypy-get="/test"></div><a id="a1">Requests: 0</a>')
    //     var a1 = byId('a1')
    //     a1.innerHTML.should.equal('Requests: 0')
    //     a1.click()
    //     this.server.respond()
    //     a1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('from clause works with previous', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     make('<a id="a1">Requests: 0</a><div ypy-trigger="click from:previous" ypy-target="#a1" ypy-get="/test"></div>')
    //     var a1 = byId('a1')
    //     a1.innerHTML.should.equal('Requests: 0')
    //     a1.click()
    //     this.server.respond()
    //     a1.innerHTML.should.equal('Requests: 1')
    // })
    //
    // it('event listeners on other elements are removed when an element is swapped out', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/test2', 'Clicked')
    //
    //     var div1 = make('<div ypy-get="/test2">' +
    //         '<div id="d2" ypy-trigger="click from:body" ypy-get="/test">Requests: 0</div>' +
    //         '</div>')
    //     var div2 = byId('d2')
    //
    //     div2.innerHTML.should.equal('Requests: 0')
    //     document.body.click()
    //     this.server.respond()
    //     requests.should.equal(1)
    //
    //     requests.should.equal(1)
    //
    //     div1.click()
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Clicked')
    //
    //     requests.should.equal(2)
    //
    //     document.body.click()
    //     this.server.respond()
    //
    //     requests.should.equal(2)
    // })
    //
    // it('multiple triggers with from clauses mixed in work', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div2 = make('<div id="d2"></div>')
    //     var div1 = make('<div ypy-trigger="click from:#d2, click" ypy-get="/test">Requests: 0</div>')
    //     div1.innerHTML.should.equal('Requests: 0')
    //     div1.click()
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 1')
    //     div2.click()
    //     this.server.respond()
    //     div1.innerHTML.should.equal('Requests: 2')
    // })
    //
    // it('from clause works with multiple extended selectors', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     make('<button id="btn" type="button">Click me</button>' +
    //         '<div ypy-trigger="click from:(previous button, next a)" ypy-target="#a1" ypy-get="/test"></div>' +
    //         '<a id="a1">Requests: 0</a>')
    //     var btn = byId('btn')
    //     var a1 = byId('a1')
    //     a1.innerHTML.should.equal('Requests: 0')
    //     btn.click()
    //     this.server.respond()
    //     a1.innerHTML.should.equal('Requests: 1')
    //     a1.click()
    //     this.server.respond()
    //     a1.innerHTML.should.equal('Requests: 2')
    // })
    //
    // it('event listeners can filter on target', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //
    //     var div1 = make('<div>' +
    //         '<div id="d1" ypy-trigger="click from:body target:#d3" ypy-get="/test">Requests: 0</div>' +
    //         '<div id="d2"></div>' +
    //         '<div id="d3"></div>' +
    //         '</div>')
    //     var div1 = byId('d1')
    //     var div2 = byId('d2')
    //     var div3 = byId('d3')
    //
    //     div1.innerHTML.should.equal('Requests: 0')
    //     document.body.click()
    //     this.server.respond()
    //     requests.should.equal(0)
    //
    //     div1.click()
    //     this.server.respond()
    //     requests.should.equal(0)
    //
    //     div2.click()
    //     this.server.respond()
    //     requests.should.equal(0)
    //
    //     div3.click()
    //     this.server.respond()
    //     requests.should.equal(1)
    // })
    //
    // it('throttle prevents multiple requests from happening', function(done) {
    //     var requests = 0
    //     var server = this.server
    //     server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     server.respondWith('GET', '/bar', 'bar')
    //     var div = make("<div ypy-trigger='click throttle:10ms' ypy-get='/test'></div>")
    //
    //     div.click()
    //     server.respond()
    //
    //     div.click()
    //     server.respond()
    //
    //     div.click()
    //     server.respond()
    //
    //     div.click()
    //     server.respond()
    //
    //     // should not have been replaced by click
    //     div.innerText.should.equal('Requests: 1')
    //
    //     setTimeout(function() {
    //         div.click()
    //         server.respond()
    //         div.innerText.should.equal('Requests: 2')
    //
    //         div.click()
    //         server.respond()
    //         div.innerText.should.equal('Requests: 2')
    //
    //         done()
    //     }, 50)
    // })
    //
    // it('A throttle of 0 does not prevent multiple requests from happening', function(done) {
    //     var requests = 0
    //     var server = this.server
    //     server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     server.respondWith('GET', '/bar', 'bar')
    //     var div = make(
    //         "<div ypy-trigger='click throttle:0ms' ypy-get='/test'></div>"
    //     )
    //
    //     div.click()
    //     server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     div.click()
    //     server.respond()
    //     div.innerText.should.equal('Requests: 2')
    //
    //     div.click()
    //     server.respond()
    //     div.innerText.should.equal('Requests: 3')
    //
    //     div.click()
    //     server.respond()
    //     div.innerText.should.equal('Requests: 4')
    //
    //     done()
    // })
    //
    // it('delay delays the request', function(done) {
    //     var requests = 0
    //     var server = this.server
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/bar', 'bar')
    //     var div = make("<div ypy-trigger='click delay:10ms' ypy-get='/test'></div>")
    //
    //     div.click()
    //     this.server.respond()
    //
    //     div.click()
    //     this.server.respond()
    //
    //     div.click()
    //     this.server.respond()
    //
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('')
    //
    //     setTimeout(function() {
    //         server.respond()
    //         div.innerText.should.equal('Requests: 1')
    //
    //         div.click()
    //         server.respond()
    //         div.innerText.should.equal('Requests: 1')
    //
    //         done()
    //     }, 50)
    // })
    //
    // it('A 0 delay does not delay the request', function(done) {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/bar', 'bar')
    //     var div = make(
    //         "<div ypy-trigger='click delay:0ms' ypy-get='/test'></div>"
    //     )
    //
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 2')
    //
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 3')
    //
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 4')
    //
    //     done()
    // })
    //
    // it('requests are queued with last one winning by default', function() {
    //     var requests = 0
    //     var server = this.server
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/bar', 'bar')
    //     var div = make("<div ypy-trigger='click' ypy-get='/test'></div>")
    //
    //     div.click()
    //     div.click()
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 2')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 2')
    // })
    //
    // it('queue:all queues all requests', function() {
    //     var requests = 0
    //     var server = this.server
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/bar', 'bar')
    //     var div = make("<div ypy-trigger='click queue:all' ypy-get='/test'></div>")
    //
    //     div.click()
    //     div.click()
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 2')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 3')
    // })
    //
    // it('queue:first queues first request', function() {
    //     var requests = 0
    //     var server = this.server
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/bar', 'bar')
    //     var div = make("<div ypy-trigger='click queue:first' ypy-get='/test'></div>")
    //
    //     div.click()
    //     div.click()
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 2')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 2')
    // })
    //
    // it('queue:none queues no requests', function() {
    //     var requests = 0
    //     var server = this.server
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     this.server.respondWith('GET', '/bar', 'bar')
    //     var div = make("<div ypy-trigger='click queue:none' ypy-get='/test'></div>")
    //
    //     div.click()
    //     div.click()
    //     div.click()
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    //
    //     this.server.respond()
    //     div.innerText.should.equal('Requests: 1')
    // })
    //
    // it('load event works w/ positive filters', function() {
    //     this.server.respondWith('GET', '/test', 'Loaded!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="load[true]">Load Me!</div>')
    //     div.innerHTML.should.equal('Load Me!')
    //     this.server.respond()
    //     div.innerHTML.should.equal('Loaded!')
    // })
    //
    // it('load event works w/ negative filters', function() {
    //     this.server.respondWith('GET', '/test', 'Loaded!')
    //     var div = make('<div ypy-get="/test" ypy-trigger="load[false]">Load Me!</div>')
    //     div.innerHTML.should.equal('Load Me!')
    //     this.server.respond()
    //     div.innerHTML.should.equal('Load Me!')
    // })
    //
    // it('reveal event works on two elements', function() {
    //     this.server.respondWith('GET', '/test1', 'test 1')
    //     this.server.respondWith('GET', '/test2', 'test 2')
    //     var div = make('<div ypy-get="/test1" ypy-trigger="revealed"></div>')
    //     var div2 = make('<div ypy-get="/test2" ypy-trigger="revealed"></div>')
    //     div.innerHTML.should.equal('')
    //     div2.innerHTML.should.equal('')
    //     ypy.trigger(div, 'revealed')
    //     ypy.trigger(div2, 'revealed')
    //     this.server.respondAll()
    //     div.innerHTML.should.equal('test 1')
    //     div2.innerHTML.should.equal('test 2')
    // })
    //
    // it('scrolling triggers revealed event', function(done) {
    //     this.server.respondWith('GET', '/test', 'test')
    //     this.server.autoRespond = true
    //     this.server.autoRespondAfter = 0
    //     var div = make('<div ypy-get="/test" ypy-trigger="revealed"></div>')
    //     div.innerHTML.should.equal('')
    //     div.scrollIntoView({ block: 'end', behavior: ypy.config.scrollBehavior })
    //     ypy.trigger(document.body, 'scroll')
    //
    //     setTimeout(function() {
    //         div.innerHTML.should.equal('test')
    //         done()
    //     }, 250)
    // })
    //
    // if (/headlesschrome/i.test(navigator.userAgent)) {
    //     it('scrolling triggers intersect event', function(done) {
    //         // test only works reliably with playwright
    //         this.server.respondWith('GET', '/test', 'test')
    //         this.server.autoRespond = true
    //         this.server.autoRespondAfter = 0
    //         var div = make('<div ypy-get="/test" ypy-trigger="intersect"></div>')
    //         div.innerHTML.should.equal('')
    //         div.scrollIntoView({ block: 'end', behavior: ypy.config.scrollBehavior })
    //         ypy.trigger(document.body, 'scroll')
    //
    //         setTimeout(function() {
    //             div.innerHTML.should.equal('test')
    //             done()
    //         }, 250)
    //     })
    // }
    //
    // it('triggering revealed while component not yet inited still works', function(done) {
    //     this.server.respondWith('GET', '/test', 'test')
    //     var div = make('<div ypy-get="/test" ypy-trigger="revealed"></div>')
    //     var data = div['ypy-internal-data']
    //     delete data.initHash // simulate not inited or revealed yet
    //     div.removeAttribute('data-ypy-revealed')
    //     var server1 = this.server
    //     div.innerHTML.should.equal('')
    //     div.scrollIntoView({ block: 'end', behavior: ypy.config.scrollBehavior })
    //     ypy.trigger(document.body, 'scroll')
    //     setTimeout(function() {
    //         server1.autoRespond = true
    //         server1.autoRespondAfter = 0
    //         ypy.process(div) // processing the div should also trigger revealed event now
    //         setTimeout(function() {
    //             div.innerHTML.should.equal('test')
    //             done()
    //         }, 10)
    //     }, 250)
    // })
    //
    // it('reveal event works when triggered by window', function() {
    //     this.server.respondWith('GET', '/test1', 'test 1')
    //     var div = make('<div ypy-get="/test1" ypy-trigger="revealed" style="position: fixed; top: 1px; left: 1px; border: 3px solid red">foo</div>')
    //     div.innerHTML.should.equal('foo')
    //     this.server.respondAll()
    //     div.innerHTML.should.equal('test 1')
    // })
    //
    // it('revealed can be paired w/ other events', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div = make('<div ypy-get="/test" ypy-trigger="revealed, click" style="position: fixed; top: 1px; left: 1px; border: 3px solid red">foo</div>')
    //     div.innerHTML.should.equal('foo')
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     div.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    // })
    //
    // it('revealed doesnt cause other events to trigger', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div = make('<div ypy-get="/test" ypy-trigger="revealedToTheWorld" style="position: fixed; top: 1px; left: 1px; border: 3px solid red">foo</div>')
    //     div.innerHTML.should.equal('foo')
    //     this.server.respondAll()
    //     div.innerHTML.should.equal('foo')
    // })
    //
    // it('fires the ypy:trigger event when an AJAX attribute is specified', function() {
    //     var param = 'foo'
    //     var handler = ypy.on('ypy:trigger', function(evt) {
    //         param = 'bar'
    //     })
    //     try {
    //         this.server.respondWith('GET', '/test1', 'test 1')
    //         var div = make('<button ypy-get="/test1">Submit</button>')
    //         div.click()
    //         should.equal(param, 'bar')
    //     } finally {
    //         ypy.off('ypy:trigger', handler)
    //     }
    // })
    //
    // it('fires the ypy:trigger event when no AJAX attribute is specified', function() {
    //     var param = 'foo'
    //     var handler = ypy.on('ypy:trigger', function(evt) {
    //         param = 'bar'
    //     })
    //     try {
    //         var div = make('<button ypy-trigger="click">Submit</button>')
    //         div.click()
    //         should.equal(param, 'bar')
    //     } finally {
    //         ypy.off('ypy:trigger', handler)
    //     }
    // })
    //
    // it('fires the ypy:trigger event for delayed triggers', function(done) {
    //     var param = 'foo'
    //     var handler = ypy.on('ypy:trigger', function(evt) {
    //         param = 'bar'
    //     })
    //     var div = make('<button ypy-trigger="click delay:10ms">Submit</button>')
    //     div.click()
    //     setTimeout(function() {
    //         try {
    //             should.equal(param, 'bar')
    //             done()
    //         } finally {
    //             ypy.off('ypy:trigger', handler)
    //         }
    //     }, 50)
    // })
    //
    // it('fires the ypy:trigger event when the trigger is a load', function(done) {
    //     this.server.respondWith(
    //         'GET',
    //         '/test',
    //         '<div ypy-trigger="load delay:50ms" ypy-on::trigger="this.innerText = \'Done\'">Response</div>'
    //     )
    //
    //     var div = make('<div ypy-get="/test">Submit</div>')
    //     div.click()
    //     this.server.respond()
    //     var response = div.children[0]
    //     response.innerText.should.equal('Response')
    //
    //     setTimeout(function() {
    //         try {
    //             response.innerText.should.equal('Done')
    //             done()
    //         } finally {
    //         }
    //     }, 100)
    // })
    //
    // it('filters support "this" reference to the current element', function() {
    //     this.server.respondWith('GET', '/test', 'Called!')
    //     var form = make('<form ypy-get="/test" ypy-trigger="click[this.classList.contains(\'bar\')]">Not Called</form>')
    //     form.click()
    //     this.server.respond()
    //     form.innerHTML.should.equal('Not Called')
    //
    //     form.classList.add('bar')
    //     form.click()
    //     this.server.respond()
    //     form.innerHTML.should.equal('Called!')
    // })
    //
    // it('correctly handles CSS descendant combinators', function() {
    //     this.server.respondWith('GET', '/test', 'Clicked!')
    //
    //     var outer = make(`
    //     <div>
    //         <div id='outer'>
    //             <div id='first'>
    //                 <div id='inner'></div>
    //             </div>
    //             <div id='second' ypy-get='/test' ypy-trigger='click from:previous (#outer div)'>Unclicked.</div>
    //         </div>
    //         <div id='other' ypy-get='/test' ypy-trigger='click from:(div #inner)'>Unclicked.</div>
    //     </div>
    //     `)
    //
    //     var inner = byId('inner')
    //     var second = byId('second')
    //     var other = byId('other')
    //
    //     second.innerHTML.should.equal('Unclicked.')
    //     other.innerHTML.should.equal('Unclicked.')
    //
    //     inner.click()
    //     this.server.respond()
    //
    //     second.innerHTML.should.equal('Clicked!')
    //     other.innerHTML.should.equal('Clicked!')
    // })
    //
    // it('correctly handles CSS descendant combinators in modifier target', function() {
    //     this.server.respondWith('GET', '/test', 'Called')
    //
    //     make('<div class="d1"><a id="a1" class="a1">Click me</a><a id="a2" class="a2">Click me</a></div>')
    //     var div = make('<div ypy-trigger="click from:body target:(.d1 .a2)" ypy-get="/test">Not Called</div>')
    //
    //     byId('a1').click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Not Called')
    //
    //     byId('a2').click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Called')
    // })
    //
    // it('correctly handles CSS descendant combinators in modifier root', function() {
    //     this.server.respondWith('GET', '/test', 'Called')
    //     var errorEvent = null
    //     var handler = ypy.on('ypy:syntax:error', function(event) {
    //         errorEvent = event
    //     })
    //     var form = make('<div ypy-trigger="intersect root:{form input}" ypy-get="/test">Not Called</div>')
    //     try {
    //         var event = ypy._('makeEvent')('evt')
    //         form.dispatchEvent(event)
    //         should.equal(null, errorEvent)
    //     } finally {
    //         ypy.off('ypy:syntax:error', handler)
    //     }
    // })
    //
    // it('correctly handles intersect with modifier threshold', function() {
    //     this.server.respondWith('GET', '/test', 'Called')
    //     var errorEvent = null
    //     var handler = ypy.on('ypy:syntax:error', function(event) {
    //         errorEvent = event
    //     })
    //     var form = make('<div ypy-trigger="intersect threshold:0.5" ypy-get="/test">Not Called</div>')
    //     try {
    //         var event = ypy._('makeEvent')('evt')
    //         form.dispatchEvent(event)
    //         should.equal(null, errorEvent)
    //     } finally {
    //         ypy.off('ypy:syntax:error', handler)
    //     }
    // })
    //
    // it('issues error with invalid trigger spec', function() {
    //     this.server.respondWith('GET', '/test', 'Called')
    //     var errorEvent = null
    //     var handler = ypy.on('ypy:syntax:error', function(event) {
    //         errorEvent = event
    //     })
    //     var form = make('<div ypy-trigger="intersect invalid:0.5" ypy-get="/test">Not Called</div>')
    //     try {
    //         var event = ypy._('makeEvent')('evt')
    //         form.dispatchEvent(event)
    //         should.not.equal(null, errorEvent)
    //         should.not.equal(null, errorEvent.detail.source)
    //         console.log(errorEvent.detail.source)
    //     } finally {
    //         ypy.off('ypy:syntax:error', handler)
    //     }
    // })
    //
    // it('uses trigger specs cache if defined', function() {
    //     var initialCacheConfig = ypy.config.triggerSpecsCache
    //     ypy.config.triggerSpecsCache = {}
    //
    //     var specExamples = {
    //         'every 1s': [{ trigger: 'every', pollInterval: 1000 }],
    //         click: [{ trigger: 'click' }],
    //         customEvent: [{ trigger: 'customEvent' }],
    //         'event changed': [{ trigger: 'event', changed: true }],
    //         'event once': [{ trigger: 'event', once: true }],
    //         'event delay:1s': [{ trigger: 'event', delay: 1000 }],
    //         'event throttle:1s': [{ trigger: 'event', throttle: 1000 }],
    //         'event delay:1s, foo': [{ trigger: 'event', delay: 1000 }, { trigger: 'foo' }],
    //         'event throttle:1s, foo': [{ trigger: 'event', throttle: 1000 }, { trigger: 'foo' }],
    //         'event changed once delay:1s': [{ trigger: 'event', changed: true, once: true, delay: 1000 }],
    //         'event1,event2': [{ trigger: 'event1' }, { trigger: 'event2' }],
    //         'event1, event2': [{ trigger: 'event1' }, { trigger: 'event2' }],
    //         'event1 once, event2 changed': [{ trigger: 'event1', once: true }, { trigger: 'event2', changed: true }]
    //     }
    //
    //     for (var specString in specExamples) {
    //         var div = make("<div ypy-trigger='" + specString + "'></div>")
    //         var spec = ypy._('getTriggerSpecs')(div)
    //         spec.should.deep.equal(specExamples[specString], 'Found : ' + JSON.stringify(spec) + ', expected : ' + JSON.stringify(specExamples[specString]) + ' for spec: ' + specString)
    //     }
    //
    //     Object.keys(ypy.config.triggerSpecsCache).length.should.greaterThan(0)
    //     Object.keys(ypy.config.triggerSpecsCache).length.should.equal(Object.keys(specExamples).length)
    //
    //     ypy.config.triggerSpecsCache = initialCacheConfig
    // })
    //
    // it('correctly reuses trigger specs from the cache if defined', function() {
    //     var initialCacheConfig = ypy.config.triggerSpecsCache
    //     ypy.config.triggerSpecsCache = {}
    //
    //     var triggerStr = 'event changed once delay:1s'
    //     var expectedSpec = [{ trigger: 'event', changed: true, once: true, delay: 1000 }]
    //
    //     var div = make("<div ypy-trigger='event changed once delay:1s'></div>")
    //     var spec = ypy._('getTriggerSpecs')(div)
    //     spec.should.deep.equal(expectedSpec, 'Found : ' + JSON.stringify(spec) + ', expected : ' + JSON.stringify(expectedSpec) + ' for spec: ' + triggerStr)
    //     spec.push('This should be carried to further identical specs thanks to the cache')
    //
    //     var div2 = make("<div ypy-trigger='event changed once delay:1s'></div>")
    //     var spec2 = ypy._('getTriggerSpecs')(div2)
    //     spec2.should.deep.equal(spec, 'Found : ' + JSON.stringify(spec) + ', expected : ' + JSON.stringify(spec2) + ' for cached spec: ' + triggerStr)
    //
    //     Object.keys(ypy.config.triggerSpecsCache).length.should.equal(1)
    //
    //     ypy.config.triggerSpecsCache = initialCacheConfig
    // })
    //
    // it('handles spaces at the end of trigger specs', function() {
    //     var requests = 0
    //     this.server.respondWith('GET', '/test', function(xhr) {
    //         requests++
    //         xhr.respond(200, {}, 'Requests: ' + requests)
    //     })
    //     var div = make('<div ypy-trigger="load , click consume " ypy-get="/test">Requests: 0</div>')
    //     div.innerHTML.should.equal('Requests: 0')
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 1')
    //     div.click()
    //     this.server.respond()
    //     div.innerHTML.should.equal('Requests: 2')
    // })
})
