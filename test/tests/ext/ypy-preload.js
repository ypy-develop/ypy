// SPDX-License-Identifier: MIT
describe('ypy-preload attribute', function() {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-preload.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    })

    after(() => {
        restoreExtensions(extBackup);
    })

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })

    it('preloads on mousedown with bare attribute on ypy-get element', async function () {
        mockResponse('GET', '/test', 'Preloaded')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload>Click</button>');
        btn.dispatchEvent(new Event('mousedown'))
        await ypy.timeout(20)
        assert.isDefined(btn._ypy.preload)
    })

    it('preloads on mousedown with bare attribute on boosted anchor', async function () {
        mockResponse('GET', '/test', 'Preloaded')
        let div = createProcessedHTML('<div ypy-boost:inherited="true"><a id="a1" href="/test" ypy-preload>Link</a></div>');
        let a = div.querySelector('#a1')
        a.dispatchEvent(new Event('mousedown'))
        await ypy.timeout(20)
        assert.isDefined(a._ypy.preload)
    })

    it('does not preload with bare attribute on non-ypy-get element', async function () {
        mockResponse('POST', '/test', 'Posted')
        let btn = createProcessedHTML('<button ypy-post="/test" ypy-preload>Click</button>');
        btn.dispatchEvent(new Event('mousedown'))
        await ypy.timeout(20)
        assert.isUndefined(btn._ypy?.preload)
    })

    it('preloads on specified event', async function () {
        mockResponse('GET', '/test', 'Preloaded')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.isDefined(btn._ypy.preload)
    })

    it('does not preload POST requests', async function () {
        mockResponse('POST', '/test', 'Posted')
        let btn = createProcessedHTML('<button ypy-post="/test" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.isUndefined(btn._ypy.preload)
    })

    it('uses default 5s timeout', async function () {
        mockResponse('GET', '/test', 'Response')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.isTrue(btn._ypy.preload.expiresAt > Date.now() + 4000)
    })

    it('respects custom timeout', async function () {
        mockResponse('GET', '/test', 'Response')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="mouseenter timeout:100ms">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.isTrue(btn._ypy.preload.expiresAt < Date.now() + 200)
    })

    it('skips duplicate preload events', async function () {
        mockResponse('GET', '/test', 'Response')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(10)
        let firstPreload = btn._ypy.preload
        btn.dispatchEvent(new Event('mouseenter'))
        assert.equal(btn._ypy.preload, firstPreload)
    })

    it('works with different event types', async function () {
        mockResponse('GET', '/test', 'Response')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="focus">Click</button>');
        btn.dispatchEvent(new Event('focus'))
        await ypy.timeout(20)
        assert.isDefined(btn._ypy.preload)
    })

    it('works with multiple event types', async function () {
        mockResponse('GET', '/test', 'Response')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="focus, foo">Click</button>');
        btn.dispatchEvent(new Event('foo'))
        await ypy.timeout(20)
        assert.isDefined(btn._ypy.preload)
    })

    it('auto-preloads boosted anchors by default', async function () {
        mockResponse('GET', '/test', 'Preloaded')
        let div = createProcessedHTML('<div ypy-boost:inherited="true"><a id="a1" href="/test">Link</a></div>');
        let a = div.querySelector('#a1')
        a.dispatchEvent(new Event('mousedown'))
        await ypy.timeout(20)
        assert.isDefined(a._ypy.preload)
    })

    it('does not auto-preload boosted anchors when autoBoost is false', async function () {
        ypy.config.preload = { autoBoost: false }
        try {
            mockResponse('GET', '/test', 'Preloaded')
            let div = createProcessedHTML('<div ypy-boost:inherited="true"><a id="a1" href="/test">Link</a></div>');
            let a = div.querySelector('#a1')
            a.dispatchEvent(new Event('mousedown'))
            await ypy.timeout(20)
            assert.isUndefined(a._ypy?.preload)
        } finally {
            delete ypy.config.preload
        }
    })

    it('builds URL with form params', async function () {
        mockResponse('GET', /\/test\?name=test/, 'Response')
        let form = createProcessedHTML('<form><input name="name" value="test"><button ypy-get="/test" ypy-preload="mouseenter">Click</button></form>');
        let btn = form.querySelector('button')
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.isTrue(btn._ypy.preload.action.endsWith('/test?name=test'))
    })

    it('reuses preload with relative URL', async function () {
        let fetchCount = 0;
        mockResponse('GET', 'test', () => { fetchCount++; return 'Response'; })
        let btn = createProcessedHTML('<button ypy-get="test" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.equal(fetchCount, 1, 'preload should fetch')
        btn.click()
        await ypy.timeout(20)
        assert.equal(fetchCount, 1, 'click should reuse preload, not fetch again')
    })

    it('includes YPY-Request-Type header in preload fetch', async function () {
        mockResponse('GET', '/test', 'Response')
        let btn = createProcessedHTML('<button ypy-get="/test" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.equal(lastFetch().request.headers['YPY-Request-Type'], 'partial')
    })

    it('reuses preload with URL containing fragment', async function () {
        let fetchCount = 0;
        mockResponse('GET', '/test', () => { fetchCount++; return 'Response'; })
        let btn = createProcessedHTML('<button ypy-get="/test#section" ypy-preload="mouseenter">Click</button>');
        btn.dispatchEvent(new Event('mouseenter'))
        await ypy.timeout(20)
        assert.equal(fetchCount, 1, 'preload should fetch')
        btn.click()
        await ypy.timeout(20)
        assert.equal(fetchCount, 1, 'click should reuse preload, not fetch again')
    })
})
