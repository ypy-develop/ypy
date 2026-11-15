// SPDX-License-Identifier: MIT
describe('ypy-confirm attribute', function() {

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('blocks request when window.confirm returns false', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => false

        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Are you sure?">Click</button>')
        btn.click()
        await forRequest()

        btn.innerText.should.equal('Click')
        window.confirm = originalConfirm
    })

    it('allows request when window.confirm returns true', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => true

        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Are you sure?">Click</button>')
        btn.click()
        await forRequest()

        playground().innerText.should.equal('Success')
        window.confirm = originalConfirm
    })

    it('fires ypy:confirm event', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => true

        mockResponse('GET', '/test', 'Success')
        let confirmFired = false
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Delete this?">Click</button>')
        btn.addEventListener('ypy:confirm', () => confirmFired = true)
        btn.click()
        await forRequest()

        assert.isTrue(confirmFired)
        window.confirm = originalConfirm
    })

    it('provides ctx in ypy:confirm event detail', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => true

        mockResponse('GET', '/test', 'Success')
        let capturedCtx = null
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Proceed?">Click</button>')
        btn.addEventListener('ypy:confirm', (e) => capturedCtx = e.detail.ctx)
        btn.click()
        await forRequest()

        assert.isNotNull(capturedCtx)
        assert.equal(capturedCtx.confirm, 'Proceed?')
        window.confirm = originalConfirm
    })

    it('provides issueRequest callback in event detail', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => true

        mockResponse('GET', '/test', 'Success')
        let issueRequestCallback = null
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Continue?">Click</button>')
        btn.addEventListener('ypy:confirm', (e) => issueRequestCallback = e.detail.issueRequest)
        btn.click()
        await forRequest()

        assert.isFunction(issueRequestCallback)
        window.confirm = originalConfirm
    })

    it('allows custom confirmation UI with issueRequest callback', async function () {
        mockResponse('GET', '/test', 'Custom confirmed')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Custom?">Click</button>')
        
        btn.addEventListener('ypy:confirm', (e) => {
            e.preventDefault()
            setTimeout(() => e.detail.issueRequest(), 10)
        })
        
        btn.click()
        await forRequest()

        playground().innerText.should.equal('Custom confirmed')
    })

    it('cancels request when issueRequest called with false', async function () {
        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Cancel?">Click</button>')
        
        btn.addEventListener('ypy:confirm', (e) => {
            e.preventDefault()
            e.detail.dropRequest()
        })
        
        btn.click()
        await forRequest()

        btn.innerText.should.equal('Click')
    })

    it('supports js: expressions', async function () {
        mockResponse('GET', '/test', 'JS confirmed')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="js:true">Click</button>')
        btn.click()
        await forRequest()

        playground().innerText.should.equal('JS confirmed')
    })

    it('blocks request with js: returning false', async function () {
        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="js:false">Click</button>')
        btn.click()
        await forRequest()

        btn.innerText.should.equal('Click')
    })

    it('can modify ctx.confirm in ypy:config:request', async function () {
        let originalConfirm = window.confirm
        window.confirm = (msg) => {
            assert.equal(msg, 'Modified message')
            return true
        }

        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Original">Click</button>')
        btn.addEventListener('ypy:config:request', (e) => {
            e.detail.ctx.confirm = 'Modified message'
        })
        btn.click()
        await forRequest()

        playground().innerText.should.equal('Success')
        window.confirm = originalConfirm
    })

    it('can disable confirmation by setting ctx.confirm to null', async function () {
        mockResponse('GET', '/test', 'No confirm')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Should not see">Click</button>')
        
        let confirmFired = false
        btn.addEventListener('ypy:confirm', () => confirmFired = true)
        btn.addEventListener('ypy:config:request', (e) => {
            e.detail.ctx.confirm = null
        })
        
        btn.click()
        await forRequest()

        assert.isFalse(confirmFired)
        playground().innerText.should.equal('No confirm')
    })

    it('works with forms', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => true

        mockResponse('POST', '/submit', 'Form submitted')
        let form = createProcessedHTML('<form ypy-post="/submit" ypy-confirm="Submit form?"><button>Submit</button></form>')
        form.requestSubmit()
        await forRequest()

        playground().innerText.should.equal('Form submitted')
        window.confirm = originalConfirm
    })

    it('cleans up indicators when confirmation cancelled', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => false

        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Cancel?" ypy-indicator="#ind">Click</button>')
        createProcessedHTML('<div id="ind" class="ypy-indicator">Loading...</div>')
        
        btn.click()
        await forRequest()

        let indicator = find('#ind')
        assert.isFalse(indicator.classList.contains('ypy-request'))
        window.confirm = originalConfirm
    })

    it('re-enables disabled elements when confirmation cancelled', async function () {
        let originalConfirm = window.confirm
        window.confirm = () => false

        mockResponse('GET', '/test', 'Success')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-confirm="Cancel?" ypy-disable>Click</button>')
        
        btn.click()
        await forRequest()

        assert.isFalse(btn.disabled)
        window.confirm = originalConfirm
    })
})
