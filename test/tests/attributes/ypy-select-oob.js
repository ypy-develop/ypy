// SPDX-License-Identifier: MIT
describe('ypy-select-oob', function() {

    beforeEach(() => {
        setupTest()
    })

    afterEach(() => {
        cleanupTest()
    })

    it('basic ypy-select-oob works', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div id="d2">bar</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#d2" ypy-swap="innerHTML">Click</div><div id="d2"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        assertTextContentIs('#d2', 'bar')
    })

    it('multiple ypy-select-oobs works', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div id="d2">bar</div><div id="d3">baz</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#d2, #d3" ypy-swap="innerHTML">Click</div><div id="d2"></div><div id="d3"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        assertTextContentIs('#d2', 'bar')
        assertTextContentIs('#d3', 'baz')
    })

    it('basic ypy-select-oob ignores bad selector', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div id="d2">bar</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#bad" ypy-swap="innerHTML">Click</div><div id="d2"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        assertTextContentIs('#d2', '')
    })

    it('ypy-select-oob works with advanced swap style like strip:false and target:', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div id="d2">bar</div>')
        createProcessedHTML('<div id="d0" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#d2:afterend strip:false target:#d0" ypy-swap="innerHTML">Click</div>')
        find('[ypy-get]').click()
        await forRequest()
        assertTextContentIs('#d0', 'foo')
        assertTextContentIs('#d2', 'bar')
    })

    it('ypy-select-oob works with basic targeting selector', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div id="d2">bar</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#d2:outerHTML:#d3" ypy-swap="innerHTML">Click</div><div class="foo" id="d3"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        assertTextContentIs('#d2', 'bar')
        assert.isNull(document.querySelector('.foo'))
    })

    it('ypy-select-oob can end with a blank swap style which is ignored', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div class="foo" id="d2">bar</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#d2:" ypy-swap="innerHTML">Click</div><div id="d2"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        let div2 = document.getElementById('d2')
        assert.equal(div2.textContent, 'bar')
        assert.isTrue(div2.classList.contains('foo'))
    })

    it('basic ypy-select-oob works supports non text based selectors', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div class="foo" id="d2">bar</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob=".foo" ypy-swap="innerHTML">Click</div><div id="d2"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        let div2 = document.getElementById('d2')
        assert.equal(div2.textContent, 'bar')
        assert.isTrue(div2.classList.contains('foo'))
    })

    it('basic ypy-select-oob works with CSS escaped id containing "."', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div id="my.div3">bar</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob="#my\\.div3" ypy-swap="innerHTML">Click</div><div id="my.div3"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        assertTextContentIs('#my\\.div3', 'bar')
    })

    it('ypy-select-oob can select multiple elements with a selector', async function () {
        mockResponse('GET', '/test', '<div id="d1">foo</div><div class="foo" id="d2">bar</div><div class="foo" id="d3">baz</div>')
        let div = createProcessedHTML('<div id="target" ypy-get="/test" ypy-select="#d1" ypy-select-oob=".foo" ypy-swap="innerHTML">Click</div><div id="d2"></div><div id="d3"></div>')
        div.click()
        await forRequest()
        assertTextContentIs('#target', 'foo')
        let div2 = document.getElementById('d2')
        assert.equal(div2.textContent, 'bar')
        assert.isTrue(div2.classList.contains('foo'))
        let div3 = document.getElementById('d3')
        assert.equal(div3.textContent, 'baz')
        assert.isTrue(div3.classList.contains('foo'))
    })
})
