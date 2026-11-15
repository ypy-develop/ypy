// SPDX-License-Identifier: MIT
describe('ypy-swap-oob', function() {

    beforeEach(() => {
        setupTest()
    })

    afterEach(() => {
        cleanupTest()
    })

    it('swaps oob element by id with default outerHTML', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="oob1" ypy-swap-oob="true">OOB Content</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div id="oob1">Original</div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#oob1', 'OOB Content')
    })

    it('swaps oob element with innerHTML', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="oob2" ypy-swap-oob="innerHTML">New Inner</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div id="oob2"><span>Old</span></div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#oob2', 'New Inner')
    })

    it('swaps oob element with custom selector', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="x" ypy-swap-oob="outerHTML:#target">OOB Target</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div id="target">Original Target</div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#x', 'OOB Target')
    })

    it('swaps multiple oob elements', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="a" ypy-swap-oob="true">A</div><div id="b" ypy-swap-oob="true">B</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div id="a">Old A</div><div id="b">Old B</div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#a', 'A')
        assertTextContentIs('#b', 'B')
    })

    it('swaps oob with target: modifier', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="x" ypy-swap-oob="innerHTML target:#custom">Target Content</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div id="custom">Original</div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#custom', 'Target Content')
    })

    it('swaps oob with target: modifier and multi-word selector', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="x" ypy-swap-oob="innerHTML target:&quot;.foo .bar&quot;">Multi Selector</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div class="foo"><div class="bar">Original</div></div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('.foo .bar', 'Multi Selector')
    })

    it('swaps oob with the style:selector format', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div id="x" ypy-swap-oob="innerHTML:#colon">Colon Format</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div id="colon">Original</div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#colon', 'Colon Format')
    })

    it('swaps oob to all elements matching a class selector', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div ypy-swap-oob="innerHTML:.target">Updated</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div class="target">A</div><div class="target">B</div>');
        find('[ypy-get]').click()
        await forRequest()
        playground().querySelectorAll('.target').forEach(el => el.innerText.should.equal('Updated'))
    })

    it('swaps oob with colon form selector containing a space', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div ypy-swap-oob="innerHTML:.outer .inner">New Content</div>')
        createProcessedHTML('<div ypy-get="/test">Click</div><div class="outer"><div class="inner">Original</div></div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('.outer .inner', 'New Content')
    })

    it('swaps oob with colon form using closest extended selector', async function () {
        mockResponse('GET', '/test', '<div>Main</div><div ypy-swap-oob="innerHTML:closest #container">New Content</div>')
        createProcessedHTML('<div id="container"><div ypy-get="/test">Click</div><div>Original</div></div>');
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#container', 'New Content')
    })

    it('swaps oob with global selector crossing shadow root boundary', async function () {
        mockResponse('GET', '/test', '<div ypy-swap-oob="innerHTML:global #outside">New Content</div>Clicked')
        let name = 'oob-global-shadow'
        if (!customElements.get(name)) {
            customElements.define(name, class extends HTMLElement {
                connectedCallback() {
                    let root = this.attachShadow({mode: 'open'})
                    root.innerHTML = `<button ypy-get="/test" ypy-target="next div">Click me!</button><div></div>`
                    ypy.process(root)
                }
            })
        }
        createProcessedHTML(`<${name}></${name}><div id="outside">Original</div>`)
        let wc = find(name)
        wc.shadowRoot.querySelector('button').click()
        await forRequest()
        assertTextContentIs('#outside', 'New Content')
    })

    it('swaps an oob target inside the shadow root of the triggering element', async function () {
        mockResponse('GET', '/test', '<div ypy-swap-oob="innerHTML:#oob-target">new contents</div>Clicked')
        let name = 'oob-shadow-scoped'
        if (!customElements.get(name)) {
            customElements.define(name, class extends HTMLElement {
                connectedCallback() {
                    let root = this.attachShadow({mode: 'open'})
                    root.innerHTML = `
                        <button ypy-get="/test" ypy-target="next div">Click me!</button>
                        <div id="main-target"></div>
                        <div id="oob-target">this should get swapped</div>
                    `
                    ypy.process(root)
                }
            })
        }
        createProcessedHTML(`<div id="oob-target">this should not get swapped</div><${name}></${name}>`)
        let wc = find(name)
        wc.shadowRoot.querySelector('button').click()
        await forRequest()
        wc.shadowRoot.querySelector('#oob-target').textContent.should.equal('new contents')
        find('#oob-target').textContent.should.equal('this should not get swapped')
    })
})
