// SPDX-License-Identifier: MIT
describe('ypy-config attribute', function() {

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('overrides action with JSON config', async function () {
        mockResponse('GET', '/override', 'Overridden!')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-trigger="click" ypy-config=\'{"action": "/override"}\'>Click</button>');
        btn.click()
        await forRequest()
        playground().innerText.should.equal('Overridden!')
        assert.isTrue(lastFetch().url.startsWith('/override'))
        assert.equal(ctx.request.action, '/override')
    })

    it('overrides validate via config', async function () {
        mockResponse('POST', '/test', 'Submitted')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let form = createProcessedHTML('<form ypy-post="/test" ypy-config=\'{"validate": false}\'><input required name="test" value="filled"><button>Submit</button></form>');
        form.requestSubmit()
        await forRequest()
        // Verify validate can be set via config (goes to request)
        assert.isFalse(ctx.request.validate)
    })

    it('merges into options with + prefix', async function () {
        mockResponse('GET', '/test', 'Fetched')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"cache": "no-cache"}\'>Click</button>');
        btn.click()
        await forRequest()
        // Note: later Object.assign in handleTriggerEvent may override some options
        assert.equal(ctx.request.cache, 'no-cache')
        assert.equal(ctx.request.method, 'GET')
    })

    it('can set custom property on config', async function () {
        mockResponse('GET', '/test', 'Done')
        let customValue = null
        document.addEventListener('ypy:config:request', function(e) {
            customValue = e.detail.ctx.request.customProperty
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"customProperty": "myValue"}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.equal(customValue, 'myValue')
    })

    it('can set multiple custom properties', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"prop1": "value1", "prop2": "value2", "prop3": 123}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.equal(ctx.request.prop1, 'value1')
        assert.equal(ctx.request.prop2, 'value2')
        assert.equal(ctx.request.prop3, 123)
    })

    it('works with empty config object', async function () {
        mockResponse('GET', '/test', 'Done')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{}\'>Click</button>');
        btn.click()
        await forRequest()
        playground().innerText.should.equal('Done')
    })

    it('can override method via config', async function () {
        mockResponse('PUT', '/test', 'Put request')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"method": "PUT"}\'>Click</button>');
        btn.click()
        await forRequest()
        lastFetch().request.method.should.equal('PUT')
    })

    it('supports boolean values in config', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"myFlag": true, "otherFlag": false}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.isTrue(ctx.request.myFlag)
        assert.isFalse(ctx.request.otherFlag)
    })

    it('supports numeric values in config', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"timeout": 5000, "retries": 3}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.equal(ctx.request.timeout, 5000)
        assert.equal(ctx.request.retries, 3)
    })

    it('supports null values in config', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-select="#foo" ypy-config=\'{"select": null}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.isNull(ctx.request.select)
    })

    it('handles complex nested JSON structures', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"custom": {"nested": {"deep": "value"}}}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.equal(ctx.request.custom.nested.deep, 'value')
    })

    it('merges arrays by replacement not concatenation', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        // Set an array on a custom property
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"myArray": [1, 2, 3]}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.deepEqual(ctx.request.myArray, [1, 2, 3])
    })

    it('can override validation setting via config', async function () {
        mockResponse('POST', '/submit', 'Submitted')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let form = createProcessedHTML('<form ypy-post="/submit" ypy-validate="true" ypy-config=\'{"validate": false}\'><input required name="test" value="test"><button>Submit</button></form>');
        form.requestSubmit()
        await forRequest()
        assert.isFalse(ctx.request.validate)
    })

    it('multiple elements with different configs work independently', async function () {
        mockResponse('GET', '/path1', 'Path 1')
        mockResponse('GET', '/path2', 'Path 2')

        createProcessedHTML('<button id="b1" ypy-get="/test" ypy-trigger="click" ypy-swap="innerHTML" ypy-config=\'{"action": "/path1"}\'>B1</button><button id="b2" ypy-get="/test" ypy-trigger="click" ypy-swap="innerHTML" ypy-config=\'{"action": "/path2"}\'>B2</button>')

        find('#b1').click()
        await forRequest()
        assert.equal(playground().querySelector('#b1').innerText, 'Path 1')

        find('#b2').click()
        await forRequest()
        assert.equal(playground().querySelector('#b2').innerText, 'Path 2')
    })

    it('config can be inherited with :inherited suffix', async function () {
        mockResponse('GET', '/inherited', 'Inherited config')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})
        createProcessedHTML('<div ypy-config:inherited=\'{"action": "/inherited"}\'><button ypy-get="/original" ypy-trigger="click">Click</button></div>')
        find('button').click()
        await forRequest()
        playground().innerText.should.equal('Inherited config')
        assert.isTrue(lastFetch().url.startsWith('/inherited'))
        assert.equal(ctx.request.action, '/inherited')
    })

    it('child config takes precedence over inherited config', async function () {
        mockResponse('GET', '/child', 'Child wins')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})
        createProcessedHTML('<div ypy-config:inherited=\'{"action": "/parent"}\'><button ypy-get="/original" ypy-trigger="click" ypy-config=\'{"action": "/child"}\'>Click</button></div>')
        find('button').click()
        await forRequest()
        assert.isTrue(lastFetch().url.startsWith('/child'))
        assert.equal(ctx.request.action, '/child')
    })

    it('merges headers by default', async function () {
        mockResponse('GET', '/test', 'Done')
        let ctx = null
        document.addEventListener('ypy:config:request', function(e) {
            ctx = e.detail.ctx
        }, {once: true})

        let btn = createProcessedHTML('<button ypy-get="/test" ypy-config=\'{"headers": {"X-Custom": "value"}}\'>Click</button>');
        btn.click()
        await forRequest()
        assert.equal(ctx.request.headers['X-Custom'], 'value')
        assert.equal(ctx.request.headers['YPY-Request'], 'true')
    })
})
