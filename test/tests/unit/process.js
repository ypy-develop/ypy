// SPDX-License-Identifier: MIT
describe('process() unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('initializes element with ypy-get', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        ypy.process(div)
        assert.isTrue(div.hasAttribute('data-ypy-powered'))
    })

    it('initializes descendant elements', function () {
        let container = createProcessedHTML('<div><button ypy-get="/test"></button></div>')
        ypy.process(container)
        let button = container.querySelector('button')
        assert.isTrue(button.hasAttribute('data-ypy-powered'))
    })

    it('initializes boosted elements', function () {
        let a = createProcessedHTML('<a href="/test" ypy-boost="true">Link</a>')
        ypy.process(a)
        assert.isTrue(a.hasAttribute('data-ypy-powered'))
    })

    it('processes ypy-on attributes', function () {
        let div = createProcessedHTML('<div ypy-on:custom="this.setAttribute(\'fired\', \'true\')"></div>')
        ypy.process(div)
        div.dispatchEvent(new Event('custom'))
        assert.equal(div.getAttribute('fired'), 'true')
    })

    it('ignores elements with ypy-ignore', function () {
        let container = createProcessedHTML('<div ypy-ignore><button ypy-get="/test"></button></div>')
        ypy.process(container)
        let button = container.querySelector('button')
        assert.isFalse(button.hasAttribute('data-ypy-powered'))
    })

    it('ignores descendants of ypy-ignore', function () {
        let container = createProcessedHTML('<div><div ypy-ignore><button ypy-get="/test"></button></div></div>')
        ypy.process(container)
        let button = container.querySelector('button')
        assert.isFalse(button.hasAttribute('data-ypy-powered'))
    })

    it('processes element itself if it matches', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        ypy.process(div)
        assert.isTrue(div.hasAttribute('data-ypy-powered'))
    })

    it('triggers ypy:before:process event', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let fired = false
        div.addEventListener('ypy:before:process', () => fired = true)
        ypy.process(div)
        assert.isTrue(fired)
    })

    it('triggers ypy:after:process event', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let fired = false
        div.addEventListener('ypy:after:process', () => fired = true)
        ypy.process(div)
        assert.isTrue(fired)
    })

    it('ignores ypy-on: attributes under ypy-ignore', function () {
        let container = createProcessedHTML('<div><div ypy-ignore><button ypy-on:click="this.setAttribute(\'fired\', \'true\')">Click</button></div></div>')
        ypy.process(container)
        let button = container.querySelector('button')
        button.click()
        assert.isNull(button.getAttribute('fired'))
    })

    it('ypy-on:ypy:after:init fires during process', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-on:ypy:after:init="this.setAttribute(\'inited\', \'true\')"></div>')
        ypy.process(div)
        assert.equal(div.getAttribute('inited'), 'true')
    })

    it('processes elements inside a ShadowRoot', function () {
        let host = createProcessedHTML('<div></div>')
        let shadow = host.attachShadow({mode: 'open'})
        shadow.innerHTML = '<button ypy-get="/test"></button><div id="target"></div>'
        ypy.process(shadow)
        let button = shadow.querySelector('button')
        assert.isTrue(button.hasAttribute('data-ypy-powered'))
    })

    it('skips processing if ypy:before:process is cancelled', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        div.removeAttribute('data-ypy-powered')
        delete(div._ypy)
        div.addEventListener('ypy:before:process', (e) => e.preventDefault())
        ypy.process(div)
        assert.isFalse(div.hasAttribute('data-ypy-powered'))
    })

    it('ypy-trigger="load" does not re-fire on re-process', function () {
        mockResponse('GET', '/loadtest', '<span/>')
        let div = createProcessedHTML('<div ypy-get="/loadtest" ypy-trigger="load">x</div>')
        let count = 0
        div.addEventListener('ypy:before:request', () => count++)
        div.setAttribute('ypy-trigger', 'load delay:0')
        ypy.process(div)
        assert.equal(count, 0, 'load should not re-fire on re-process')
    })

    it('process(elt, true) picks up a changed ypy-trigger value', async function () {
        mockResponse('GET', '/test', '<span/>')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-trigger="click">x</button>')
        let fired = 0
        btn.addEventListener('ypy:before:request', () => fired++)

        btn.click()
        await waitForEvent('ypy:after:request', 100)
        assert.equal(fired, 1, 'baseline click fires')

        btn.setAttribute('ypy-trigger', 'keyup')
        ypy.process(btn, true)

        btn.click()
        await new Promise(r => setTimeout(r, 20))
        assert.equal(fired, 1, 'click no longer fires after trigger change')

        btn.dispatchEvent(new KeyboardEvent('keyup'))
        await waitForEvent('ypy:after:request', 100)
        assert.equal(fired, 2, 'keyup fires after force reprocess')
    })

    it('process(parent, true) reprocesses descendants with mutated ypy-on', function () {
        window._n = 0
        let div = createProcessedHTML('<div><button id="b" ypy-on:click="window._n++">b</button></div>')
        let btn = div.querySelector('#b')
        btn.click(); assert.equal(window._n, 1)
        btn.setAttribute('ypy-on:click', 'window._n += 10')
        ypy.process(div, true)
        btn.click()
        assert.equal(window._n, 11, 'descendant rebound from current attribute')
        delete window._n
    })

    it('process(elt, true) unwires a removed ypy-on attribute', function () {
        window._n = 0
        let btn = createProcessedHTML('<button ypy-on:click="window._n++">b</button>')
        btn.click(); assert.equal(window._n, 1)
        btn.removeAttribute('ypy-on:click')
        ypy.process(btn, true)
        btn.click()
        assert.equal(window._n, 1, 'removed handler is gone')
        delete window._n
    })

    it('process(elt, true) mid-request keeps the indicator wired to the running request', async function () {
        mockResponse('GET', '/slow', '<span/>')
        let btn = createProcessedHTML('<button ypy-get="/slow">x</button>')
        btn.click()
        assert.isTrue(btn.classList.contains('ypy-request'), 'indicator on during request')
        ypy.process(btn, true) // force mid-flight must not orphan the indicator
        await forRequest()
        assert.isFalse(btn.classList.contains('ypy-request'), 'indicator cleared when request completes')
    })

    it('cleanup fires before:cleanup and after:cleanup exactly once per element', async function () {
        let div = createProcessedHTML('<div id="target"><div id="parent" ypy-get="/a"><button id="child" ypy-get="/b">x</button></div></div>')
        let events = []
        div.addEventListener('ypy:before:cleanup', (e) => events.push('before:' + e.target.id))
        div.addEventListener('ypy:after:cleanup', (e) => events.push('after:' + e.target.id))
        await ypy.swap({target: '#target', text: '<p>replaced</p>', swap: 'innerHTML', sourceElement: div})
        assert.deepEqual(events, ['before:parent', 'after:parent', 'before:child', 'after:child'])
    })

    it('cleanup fires exactly once per element in nested tree (no double-fire)', async function () {
        let html = '<div id="target"><div id="gp" ypy-get="/a"><div id="p" ypy-get="/b"><button id="c" ypy-get="/c">x</button></div></div></div>'
        let div = createProcessedHTML(html)
        let counts = {}
        div.addEventListener('ypy:before:cleanup', (e) => {
            counts[e.target.id] = (counts[e.target.id] || 0) + 1
        })
        await ypy.swap({target: '#target', text: '<p>replaced</p>', swap: 'innerHTML', sourceElement: div})
        assert.equal(counts['gp'], 1, 'grandparent cleaned once')
        assert.equal(counts['p'], 1, 'parent cleaned once')
        assert.equal(counts['c'], 1, 'child cleaned once')
    })

});

describe('initialize() unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('initialize() processes document.body', function() {
        let btn = createProcessedHTML('<button ypy-get="/test"></button>')
        btn.removeAttribute('data-ypy-powered')
        delete btn._ypy
        ypy.initialize()
        assert.isTrue(btn.hasAttribute('data-ypy-powered'))
    })

    it('initialize() is idempotent - calling twice does not double-register history listeners', function() {
        let count = 0
        let orig = window.addEventListener
        window.addEventListener = function(type, ...args) {
            if (type === 'popstate') count++
            return orig.call(this, type, ...args)
        }
        ypy.initialize()
        ypy.initialize()
        window.addEventListener = orig
        assert.isAtMost(count, 1, 'popstate listener registered more than once')
    })

});