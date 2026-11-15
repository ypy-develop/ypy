// SPDX-License-Identifier: MIT
describe('__findAllExt parent and self targets', function() {
    beforeEach(function() { setupTest(this.currentTest) })
    afterEach(function() { cleanupTest() })

    itSource('parent is the parent element', function() {
        let outer = createProcessedHTML('<div id="outer"><p id="inner"></p></div>')
        let results = ypy.__findAllExt(find('#inner'), 'parent')
        assert.deepEqual(results, [outer])
    })

    itSource('parent of a root with no parent element finds nothing', function() {
        let results = ypy.__findAllExt(document.documentElement, 'parent')
        assert.deepEqual(results, [])
    })

    itSource('self is the element itself', function() {
        createProcessedHTML('<div id="outer"><p id="inner"></p></div>')
        let inner = find('#inner')
        assert.deepEqual(ypy.__findAllExt(inner, 'self'), [inner])
    })

    itSource('they combine with other targets and plain selectors', function() {
        createProcessedHTML('<div id="outer"><p id="inner"></p><span id="other"></span></div>')
        let results = ypy.__findAllExt(find('#inner'), 'parent, self, #other')
        assert.sameMembers(results.map(e => e.id), ['outer', 'inner', 'other'])
    })

    it('ypy-target="parent" swaps into the parent', async function() {
        mockResponse('GET', '/test', '<b>New</b>')
        createProcessedHTML('<div id="box"><button ypy-get="/test" ypy-target="parent" ypy-swap="innerHTML">Go</button></div>')
        find('button').click()
        await forRequest()
        find('#box').innerHTML.should.equal('<b>New</b>')
    })

    it('ypy-target="self" swaps into the element', async function() {
        mockResponse('GET', '/test', 'New')
        createProcessedHTML('<div id="box"><button ypy-get="/test" ypy-target="self" ypy-swap="innerHTML">Go</button></div>')
        find('button').click()
        await forRequest()
        find('button').innerHTML.should.equal('New')
    })
})
