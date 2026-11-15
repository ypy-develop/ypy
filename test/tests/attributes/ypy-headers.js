// SPDX-License-Identifier: MIT
describe('ypy-headers attribute', function() {

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('basic ypy-headers works', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        let div = createProcessedHTML("<div ypy-post='/vars' ypy-headers='\"i1\":\"test\"'></div>")
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('test');
        div.innerHTML.should.equal('Clicked!')
    })

    it('basic ypy-headers works with braces', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        let div = createProcessedHTML('<div ypy-post="/vars" ypy-headers=\'{"i1":"test"}\'></div>')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('test');
        div.innerHTML.should.equal('Clicked!')
    })

    it('multiple ypy-headers works', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        let div = createProcessedHTML('<div ypy-post="/vars" ypy-headers=\'{"v1":"test", "v2":"42"}\'></div>')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.v1.should.equal('test');
        fetchMock.calls[0].request.headers.v2.should.equal('42');
        div.innerHTML.should.equal('Clicked!')
    })

    it('ypy-headers can be inherited from parents', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        createProcessedHTML("<div ypy-headers:inherited='\"i1\":\"test\"'><div id='d1' ypy-post='/vars'></div></div>")
        let div = find('#d1')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('test');
        div.innerHTML.should.equal('Clicked!')
    })

    it('child ypy-headers can override parent', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        createProcessedHTML("<div ypy-headers:inherited='\"i1\":\"test\"'><div id='d1' ypy-headers='\"i1\":\"best\"' ypy-post='/vars'></div></div>")
        let div = find('#d1')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('best');
        div.innerHTML.should.equal('Clicked!')
    })

    it('basic ypy-headers javascript: works', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        let div = createProcessedHTML('<div ypy-post="/vars" ypy-headers="javascript:i1:\'test\'"></div>')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('test');
        div.innerHTML.should.equal('Clicked!')
    })

    it('ypy-headers works with braces and javascript:', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        let div = createProcessedHTML('<div ypy-post="/vars" ypy-headers="javascript:{i1:\'test\'}"></div>')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('test');
        div.innerHTML.should.equal('Clicked!')
    })

    it('multiple ypy-headers works with javascript', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        let div = createProcessedHTML('<div ypy-post="/vars" ypy-headers="javascript:v1:\'test\', v2:42"></div>')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.v1.should.equal('test');
        fetchMock.calls[0].request.headers.v2.should.equal('42');
        div.innerHTML.should.equal('Clicked!')
    })

    it('ypy-headers can be inherited from parents with javascript', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        createProcessedHTML('<div ypy-headers:inherited="javascript:i1:\'test\'"><div id="d1" ypy-post="/vars"></div></div>')
        let div = find('#d1')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('test');
        div.innerHTML.should.equal('Clicked!')
    })

    it('child ypy-headers can override parent with javascript', async function() {
        mockResponse('POST', '/vars', 'Clicked!')
        createProcessedHTML('<div ypy-headers:inherited="javascript:i1:\'test\'"><div id="d1" ypy-headers="javascript:i1:\'best\'" ypy-post="/vars"></div></div>')
        let div = find('#d1')
        div.click()
        await forRequest()
        fetchMock.calls[0].request.headers.i1.should.equal('best');
        div.innerHTML.should.equal('Clicked!')
    })

})
