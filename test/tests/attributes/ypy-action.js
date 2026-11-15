// SPDX-License-Identifier: MIT
describe('ypy-action attribute', function() {

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('ypy-action alone defaults to GET', async function() {
        mockResponse('GET', '/test', 'Clicked!')
        let btn = createProcessedHTML('<button ypy-action="/test">Click Me!</button>')
        btn.click()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('GET')
        btn.innerHTML.should.equal('Clicked!')
    })

    it('ypy-action with ypy-method uses specified method', async function() {
        mockResponse('POST', '/test', 'Posted!')
        let btn = createProcessedHTML('<button ypy-action="/test" ypy-method="post">Click Me!</button>')
        btn.click()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('POST')
        btn.innerHTML.should.equal('Posted!')
    })

    it('ypy-action on form picks up native method attribute', async function() {
        mockResponse('POST', '/test', 'Posted!')
        let form = createProcessedHTML('<form ypy-action="/test" ypy-swap="outerHTML" method="post"><button>Submit</button></form>')
        form.requestSubmit()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('POST')
        playground().innerHTML.should.equal('Posted!')
    })

    it('ypy-action on form with submitter formmethod uses formmethod', async function() {
        mockResponse('POST', '/test', 'Posted!')
        let form = createProcessedHTML('<form ypy-action="/test" ypy-swap="outerHTML" method="get"><button id="b1" formmethod="post">Submit</button></form>')
        find('#b1').click()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('POST')
        playground().innerHTML.should.equal('Posted!')
    })

    it('ypy-action with ypy-method takes priority over native method attribute', async function() {
        mockResponse('PUT', '/test', 'Put!')
        let form = createProcessedHTML('<form ypy-action="/test" ypy-method="put" ypy-swap="outerHTML" method="post"><button>Submit</button></form>')
        form.requestSubmit()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('PUT')
        playground().innerHTML.should.equal('Put!')
    })

    it('ypy-action with ypy-method QUERY issues a QUERY request', async function() {
        mockResponse('QUERY', '/test', 'Queried!')
        let btn = createProcessedHTML('<button ypy-action="/test" ypy-method="QUERY">Click Me!</button>')
        btn.click()
        await forRequest()
        fetchMock.calls[0].request.method.should.equal('QUERY')
        btn.innerHTML.should.equal('Queried!')
    })

})
