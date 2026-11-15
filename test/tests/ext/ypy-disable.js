// SPDX-License-Identifier: MIT
// ypy-disable and ypy-inert (src/ext/ypy-disable.js): the elements a request holds back while it runs.
describe('ypy-disable extension', function() {
    let extBackup;

    before(async function() {
        extBackup = backupExtensions()
        await loadExtension('../src/ext/ypy-disable.js')
        if (SOURCE_BUILD) assert.isTrue(ypy.__registeredExt.has('ypy-disable'))
    })

    after(function() {
        restoreExtensions(extBackup)
    })

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('single element can be disabled w/ ypy-disable', async function() {
        mockResponse('GET', '/test', 'Clicked!')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-disable="this">Click Me!</button>')
        btn.hasAttribute('disabled').should.equal(false)
        btn.click()
        btn.hasAttribute('disabled').should.equal(true)
        await forRequest()
        btn.hasAttribute('disabled').should.equal(false)
    })

    it('single element can be disabled w/ closest syntax', async function() {
        mockResponse('GET', '/test', 'Clicked!')
        let fieldset = createProcessedHTML('<fieldset><button id="b1" ypy-get="/test" ypy-disable="closest fieldset">Click Me!</button></fieldset>')
        let btn = find('#b1')
        fieldset.hasAttribute('disabled').should.equal(false)
        btn.click()
        fieldset.hasAttribute('disabled').should.equal(true)
        await forRequest()
        fieldset.hasAttribute('disabled').should.equal(false)
    })

    it('multiple requests with same disabled elt are handled properly', async function() {
        const responses = mockSequentialResponses('GET', '/test', 'Clicked!')
        createProcessedHTML('<button id="b1" ypy-get="/test" ypy-disable="#b3">Click Me!</button>' +
            '<button id="b2" ypy-get="/test" ypy-disable="#b3">Click Me!</button>' +
            '<button id="b3">Demo</button>')

        let b1 = find('#b1')
        let b2 = find('#b2')
        let b3 = find('#b3')

        b3.hasAttribute('disabled').should.equal(false)

        b1.click()
        b3.hasAttribute('disabled').should.equal(true)

        b2.click()
        b3.hasAttribute('disabled').should.equal(true)

        // Release first request and wait for ypy to process
        await responses.next()

        b3.hasAttribute('disabled').should.equal(true)  // Still disabled, request 2 in flight

        // Release second request and wait for ypy to process
        await responses.next()

        b3.hasAttribute('disabled').should.equal(false)  // Now re-enabled
    })

    it('multiple elts can be disabled', async function() {
        mockResponse('GET', '/test', 'Clicked!')
        createProcessedHTML('<button id="b1" ypy-get="/test" ypy-disable="#b2, #b3">Click Me!</button>' +
            '<button id="b2">Click Me!</button>' +
            '<button id="b3">Demo</button>')

        let b1 = find('#b1')
        let b2 = find('#b2')
        let b3 = find('#b3')

        b2.hasAttribute('disabled').should.equal(false)
        b3.hasAttribute('disabled').should.equal(false)

        b1.click()
        b2.hasAttribute('disabled').should.equal(true)
        b3.hasAttribute('disabled').should.equal(true)

        await forRequest()

        b2.hasAttribute('disabled').should.equal(false)
        b3.hasAttribute('disabled').should.equal(false)
    })

    it('load trigger does not prevent disabled element working', async function() {
        mockResponse('GET', '/test', 'Loaded!')
        createProcessedHTML('<div id="d1" ypy-get="/test" ypy-disable="#b1" ypy-trigger="load">Load Me!</div><button id="b1">Demo</button>')

        let div = find('#d1')
        let btn = find('#b1')

        div.innerHTML.should.equal('Load Me!')
        btn.hasAttribute('disabled').should.equal(true)

        await forRequest()

        div.innerHTML.should.equal('Loaded!')
        btn.hasAttribute('disabled').should.equal(false)
    })

    it('ypy-disable supports multiple extended selectors', async function() {
        mockResponse('GET', '/test', 'Clicked!')
        let form = createProcessedHTML('<form ypy-get="/test" ypy-disable="find input[type=\'text\'], find button" ypy-swap="none"><input id="i1" type="text" placeholder="Type here..."><button id="b2" type="submit">Send</button></form>')

        let i1 = find('#i1')
        let b2 = find('#b2')

        i1.hasAttribute('disabled').should.equal(false)
        b2.hasAttribute('disabled').should.equal(false)

        b2.click()
        i1.hasAttribute('disabled').should.equal(true)
        b2.hasAttribute('disabled').should.equal(true)

        await forRequest()

        i1.hasAttribute('disabled').should.equal(false)
        b2.hasAttribute('disabled').should.equal(false)
    })

    it('closest/find/next/previous handle nothing to find without exception', async function() {
        mockResponse('GET', '/test', 'Clicked!')
        createProcessedHTML('<button id="btn1" ypy-get="/test" ypy-disable="closest input">Click Me!</button>' +
            '<button id="btn2" ypy-get="/test" ypy-disable="find input">Click Me!</button>' +
            '<button id="btn3" ypy-get="/test" ypy-disable="next input">Click Me!</button>' +
            '<button id="btn4" ypy-get="/test" ypy-disable="previous input">Click Me!</button>')

        let btn1 = find('#btn1')
        let btn2 = find('#btn2')
        let btn3 = find('#btn3')
        let btn4 = find('#btn4')

        btn1.click()
        btn1.hasAttribute('disabled').should.equal(false)
        await forRequest()

        btn2.click()
        btn2.hasAttribute('disabled').should.equal(false)
        await forRequest()

        btn3.click()
        btn3.hasAttribute('disabled').should.equal(false)
        await forRequest()

        btn4.click()
        btn4.hasAttribute('disabled').should.equal(false)
        await forRequest()
    })

    // what the elements of one request look like, observed through a real request
    async function disabledDuring(html, source, ...watch) {
        mockResponse('GET', '/test', 'done')
        let root = createProcessedHTML(html)
        let elts = watch.map(selector => root.matches(selector) ? root : root.querySelector(selector))
        let elt = source ? root.querySelector(source) : root
        elt.click()
        let during = elts.map(el => el.disabled)
        await forRequest()
        return {root, during, after: elts.map(el => el.disabled)}
    }

    it('names the element with this', async function() {
        let seen = await disabledDuring('<button ypy-disable="this" ypy-get="/test"></button>', null, 'button')
        assert.deepEqual(seen.during, [true])
        assert.deepEqual(seen.after, [false])
    })

    it('an element can name itself with a class selector', async function() {
        let seen = await disabledDuring('<button ypy-disable=".disable-me" class="disable-me" ypy-get="/test"></button>', null, 'button')
        assert.deepEqual(seen.during, [true])
        assert.deepEqual(seen.after, [false])
    })

    it('nested elements are disabled together and enabled together', async function() {
        let seen = await disabledDuring('<div ypy-disable=".disable-me" class="disable-me" ypy-get="/test"><button class="disable-me"></button></div>', null, 'div', 'button')
        assert.deepEqual(seen.during, [true, true])
        assert.deepEqual(seen.after, [false, false])
    })

    it('does nothing without a selector', async function() {
        let seen = await disabledDuring('<div ypy-get="/test"><button class="disable-me"></button></div>', null, 'button')
        assert.deepEqual(seen.during, [false])
    })

    it('an inherited this names the element that holds the attribute', async function() {
        let seen = await disabledDuring('<button ypy-disable:inherited="this"><span ypy-get="/test"></span></button>', 'span', 'button')
        assert.deepEqual(seen.during, [true])
        assert.deepEqual(seen.after, [false])
    })

    it('a ypy-disable on a closer ancestor replaces the farther one', async function() {
        let seen = await disabledDuring('<button ypy-disable="this"><span ypy-disable=".other"><i ypy-get="/test"></i></span></button>', 'i', 'button')
        assert.deepEqual(seen.during, [false])
    })

    it('append adds to the inherited elements', async function() {
        let seen = await disabledDuring('<button ypy-disable:inherited="this"><span ypy-disable:append="this" ypy-get="/test"></span></button>', 'span', 'button', 'span')
        assert.deepEqual(seen.during, [true, true])
        assert.deepEqual(seen.after, [false, false])
    })

    it('comma separated values may include this', async function() {
        let seen = await disabledDuring('<button ypy-disable="this, .other" ypy-get="/test"></button>', null, 'button')
        assert.deepEqual(seen.during, [true])
    })

    it('an element stays disabled while another request still holds it, even when the first ends early', async function() {
        const responses = mockSequentialResponses('GET', '/test', 'x')
        createProcessedHTML('<button id="a" ypy-get="/test" ypy-disable="#c"></button><button id="b" ypy-get="/test" ypy-disable="#c"></button><button id="c"></button>')
        find('#b').click()
        find('#a').click()
        await responses.next()
        assert.isTrue(find('#c').disabled)
        await responses.next()
        assert.isFalse(find('#c').disabled)
    })

    it('a request that fails enables the elements again', async function() {
        mockResponse('GET', '/test', 'oops', {status: 500})
        createProcessedHTML('<button id="a" ypy-get="/test" ypy-disable="this"></button>')
        find('#a').click()
        assert.isTrue(find('#a').disabled)
        await forRequest()
        assert.isFalse(find('#a').disabled)
    })

    it('a request cancelled by a before:request listener leaves nothing disabled', async function() {
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-disable="this"></button>')
        btn.addEventListener('ypy:before:request', e => e.preventDefault())
        btn.click()
        await forRequest()
        assert.isFalse(btn.disabled)
    })

    it('disabled elements are carried through an ypy-location chain', async function() {
        mockResponse('GET', '/first', '', { headers: { 'YPY-Location': '{"path":"/second","target":"#dest"}' } })
        mockResponse('GET', '/second', 'Done')
        createProcessedHTML(
            '<div id="dest"></div>' +
            '<button id="btn" ypy-get="/first" ypy-disable="this" ypy-target="#dest">Click</button>'
        )
        find('#btn').click()
        await forRequest()  // /first
        assert.isTrue(find('#btn').disabled, 'button should still be disabled during chain')
        await forRequest()  // /second
        await ypy.timeout(10)
        assert.isFalse(find('#btn').disabled, 'button should be re-enabled after chain completes')
        assert.equal(find('#dest').textContent, 'Done')
    })

    it('a denied confirmation never disables anything', async function() {
        let originalConfirm = window.confirm
        window.confirm = () => false
        try {
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Cancel?" ypy-disable="this">Click</button>')
            btn.click()
            await ypy.timeout(20)
            assert.isFalse(btn.disabled)
        } finally {
            window.confirm = originalConfirm
        }
    })

    describe('ypy-inert', function() {

        it('is off by default: the target stays active during the request', async function() {
            mockResponse('GET', '/inert', 'done')
            createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t">Go</button><div id="t">old</div></div>')
            find('#b').click()
            assert.isFalse(find('#t').inert)
            await forRequest()
            assert.isFalse(find('#t').inert)
        })

        it('ypy-inert="true" makes the target inert until the request ends', async function() {
            mockResponse('GET', '/inert', 'done')
            createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t" ypy-inert="true">Go</button><div id="t">old</div></div>')
            find('#b').click()
            assert.isTrue(find('#t').inert)
            await forRequest()
            assert.isFalse(find('#t').inert)
            assert.equal(find('#t').textContent, 'done')
        })

        it('config.inert turns it on for every request, ypy-inert="false" turns it off again', async function() {
            mockResponse('GET', '/inert', 'done')
            ypy.config.inert = true
            try {
                createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t">Go</button><button id="c" ypy-get="/inert" ypy-target="#u" ypy-inert="false">Go</button><div id="t">old</div><div id="u">old</div></div>')
                find('#b').click()
                assert.isTrue(find('#t').inert)
                await forRequest()
                assert.isFalse(find('#t').inert)
                find('#c').click()
                assert.isFalse(find('#u').inert)
                await forRequest()
            } finally {
                delete ypy.config.inert
            }
        })

        it('a form that swaps into itself is inert during the submit and works again after', async function() {
            mockResponse('POST', '/inert', '<input name="n" value="new">')
            createProcessedHTML('<form id="f" ypy-post="/inert" ypy-target="this" ypy-swap="innerHTML" ypy-inert="true"><input name="n" value="old"><button id="b">Go</button></form>')
            find('#b').click()
            assert.isTrue(find('#f').inert)
            await forRequest()
            assert.isFalse(find('#f').inert)
            assert.equal(find('#f > input').value, 'new')
        })

        it('is released when the request fails', async function() {
            mockResponse('GET', '/inert', 'oops', {status: 500})
            createProcessedHTML('<div><button id="b" ypy-get="/inert" ypy-target="#t" ypy-inert="true">Go</button><div id="t">old</div></div>')
            find('#b').click()
            assert.isTrue(find('#t').inert)
            await forRequest()
            assert.isFalse(find('#t').inert)
        })
    })

})
