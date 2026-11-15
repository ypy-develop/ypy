// SPDX-License-Identifier: MIT
describe('ypy-patch attribute', function() {

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('issues a PATCH request', async function() {
        mockResponse('PATCH', '/test', 'Patched!')
        let btn = createProcessedHTML('<button ypy-patch="/test">Click Me!</button>')
        btn.click()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('PATCH');
        btn.innerHTML.should.equal('Patched!')
    })

})