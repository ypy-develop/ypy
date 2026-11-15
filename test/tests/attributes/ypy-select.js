// SPDX-License-Identifier: MIT
describe('ypy-select', function() {

    beforeEach(() => {
        setupTest()
    })

    afterEach(() => {
        cleanupTest()
    })

    it('selects content from response', async function () {
        mockResponse('GET', '/test', '<div><div id="content">Selected</div><div id="other">Not selected</div></div>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-select="#content" ypy-swap="innerHTML">Old</div>');
        div.click()
        await forRequest()
        assert.equal(div.innerHTML, '<div id="content">Selected</div>')
    })

    it('selects nested content from response', async function () {
        mockResponse('GET', '/test', '<html><body><nav>Nav</nav><main id="main">Main content</main><footer>Footer</footer></body></html>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-select="#main" ypy-swap="innerHTML">Old</div>');
        div.click()
        await forRequest()
        assert.equal(div.innerHTML, '<main id="main">Main content</main>')
    })

    it('does not affect OOB swaps', async function () {
        mockResponse('GET', '/test', '<div><div id="content">Selected</div><div id="oob" ypy-swap-oob="true">OOB content</div></div>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-select="#content" ypy-swap="innerHTML">Old</div><div id="oob">Old OOB</div>');
        div.click()
        await forRequest()
        assert.equal(div.innerHTML, '<div id="content">Selected</div>')
        assert.equal(document.getElementById('oob').innerHTML, 'OOB content')
    })

    it('returns empty string if selector not found', async function () {
        mockResponse('GET', '/test', '<div><div id="content">Content</div></div>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-select="#notfound" ypy-swap="innerHTML">Old</div>');
        div.click()
        await forRequest()
        assert.equal(div.innerHTML, '')
    })

    it('works with class selectors', async function () {
        mockResponse('GET', '/test', '<div><div class="selected">Selected</div><div class="other">Not selected</div></div>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-select=".selected" ypy-swap="innerHTML">Old</div>');
        div.click()
        await forRequest()
        assert.equal(div.innerHTML, '<div class="selected">Selected</div>')
    })

    it('works with complex selectors', async function () {
        mockResponse('GET', '/test', '<div><table><tbody><tr><td>Cell</td></tr></tbody></table></div>')
        let table = createProcessedHTML('<table ypy-get="/test" ypy-select="table tbody" ypy-swap="innerHTML"><tbody><tr><td>Old</td></tr></tbody></table>');
        table.click()
        await forRequest()
        assert.include(table.innerHTML, '<tr><td>Cell</td></tr>')
    })
})
