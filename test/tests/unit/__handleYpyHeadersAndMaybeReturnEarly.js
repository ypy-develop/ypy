// SPDX-License-Identifier: MIT
describe('__handleYpyHeadersAndMaybeReturnEarly unit tests', function() {

    let originalLocation;

    beforeEach(function() {
        setupTest();
        // Save original location reference
        originalLocation = ypy._loc;
    });

    afterEach(function() {
        // Restore original location
        ypy._loc = originalLocation;
        cleanupTest();
    });

    it('returns false when no headers to handle', function () {
        let ctx = {
            ypy: {},
            sourceElement: createProcessedHTML('<div></div>')
        }

        let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx)

        assert.isNotOk(result)
    })

    it('returns false when only ypy-trigger is present', function () {
        let container = createProcessedHTML('<div></div>')

        let ctx = {
            ypy: {
                trigger: 'someEvent'
            },
            sourceElement: container
        }

        let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx)

        assert.isNotOk(result)
    })

    it('keeps commas in plain YPY-Location paths', function() {
        let originalAjax = ypy.ajax
        let request
        ypy.ajax = (...args) => request = args

        try {
            let result = ypy.__handleHeadersAndMaybeReturnEarly({ypy: {location: '/files/a,b'}})

            assert.isTrue(result)
            assert.equal(request[0], 'GET')
            assert.equal(request[1], '/files/a,b')
            assert.equal(request[2].push, 'true')
        } finally {
            ypy.ajax = originalAjax
        }
    })

    it('parses an HCON YPY-Location value', function() {
        let originalAjax = ypy.ajax
        let request
        ypy.ajax = (...args) => request = args

        try {
            let result = ypy.__handleHeadersAndMaybeReturnEarly({ypy: {location: 'path:/search'}})

            assert.isTrue(result)
            assert.equal(request[0], 'GET')
            assert.equal(request[1], '/search')
            assert.equal(request[2].push, 'true')
        } finally {
            ypy.ajax = originalAjax
        }
    })

    it('honors YPY-Location replace without pushing', async function() {
        mockResponse('GET', '/test', 'ignored', {
            headers: {
                'YPY-Location': '{"path":"/location-replaced","target":"#destination","replace":"/location-replaced"}'
            }
        })
        mockResponse('GET', '/location-replaced', 'Located')
        let source = createProcessedHTML('<div><div id="destination"></div><button id="source" ypy-get="/test">Go</button></div>')
            .querySelector('#source')
        let requestFinished = new Promise(resolve => {
            document.addEventListener('ypy:finally:request', function handler(evt) {
                if (evt.detail?.ctx?.request?.action === '/location-replaced') {
                    document.removeEventListener('ypy:finally:request', handler)
                    resolve()
                }
            })
        })

        // Seed a tagged entry so the stamp-on-swap replaceState doesn't fire during the test
        history.replaceState({ypy: true}, '', location.href)

        let originalPushState = history.pushState
        let originalReplaceState = history.replaceState
        let pushes = 0
        let replaces = 0

        history.pushState = function(...args) {
            pushes++
            return originalPushState.apply(history, args)
        }
        history.replaceState = function(...args) {
            replaces++
            return originalReplaceState.apply(history, args)
        }

        try {
            source.click()
            await requestFinished

            assert.equal(find('#destination').textContent, 'Located')
            assert.equal(pushes, 0)
            assert.equal(replaces, 1)
        } finally {
            history.pushState = originalPushState
            history.replaceState = originalReplaceState
        }
    })

    // YPY-Refresh header tests
    it('calls location.reload() on YPY-Refresh: true', function () {
        let reloadCalled = false;
        ypy._loc = { reload: function() { reloadCalled = true; } };

        let ctx = {
            ypy: { refresh: 'true' },
            sourceElement: createProcessedHTML('<div></div>')
        };

        let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx);

        assert.isTrue(result);
        assert.isTrue(reloadCalled);
    })

    it('does not reload on YPY-Refresh: false', function () {
        let reloadCalled = false;
        ypy._loc = { reload: function() { reloadCalled = true; } };

        let ctx = {
            ypy: { refresh: 'false' },
            sourceElement: createProcessedHTML('<div></div>')
        };

        let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx);

        assert.isNotOk(result);
        assert.isFalse(reloadCalled);
    })

    // YPY-Redirect header tests
    it('sets location.href on YPY-Redirect', function () {
        let redirectUrl = null;
        ypy._loc = { 
            get href() { return window.location.href; },
            set href(val) { redirectUrl = val; }
        };

        let ctx = {
            ypy: { redirect: location.origin + '/new-page' },
            sourceElement: createProcessedHTML('<div></div>')
        };

        let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx);

        assert.isTrue(result);
        assert.equal(redirectUrl, location.origin + '/new-page');
    })

    // YPY-Location header tests
    it('calls ajax on YPY-Location with simple path', function () {
        let ajaxCalled = false;
        let ajaxArgs = null;
        const originalAjax = ypy.ajax;
        ypy.ajax = function(method, path, opts) {
            ajaxCalled = true;
            ajaxArgs = { method, path, opts };
        };

        try {
            let ctx = {
                ypy: { location: '/new-path' },
                sourceElement: createProcessedHTML('<div></div>')
            };

            let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx);

            assert.isTrue(result);
            assert.isTrue(ajaxCalled);
            assert.equal(ajaxArgs.method, 'GET');
            assert.equal(ajaxArgs.path, '/new-path');
            assert.equal(ajaxArgs.opts.push, 'true');
        } finally {
            ypy.ajax = originalAjax;
        }
    })

    it('calls ajax on YPY-Location with JSON config', function () {
        let ajaxCalled = false;
        let ajaxArgs = null;
        const originalAjax = ypy.ajax;
        ypy.ajax = function(method, path, opts) {
            ajaxCalled = true;
            ajaxArgs = { method, path, opts };
        };

        try {
            let ctx = {
                ypy: { location: '{"path":"/test", "target":"#result"}' },
                sourceElement: createProcessedHTML('<div></div>')
            };

            let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx);

            assert.isTrue(result);
            assert.isTrue(ajaxCalled);
            assert.equal(ajaxArgs.method, 'GET');
            assert.equal(ajaxArgs.path, '/test');
            assert.equal(ajaxArgs.opts.target, '#result');
            assert.equal(ajaxArgs.opts.push, 'true');
        } finally {
            ypy.ajax = originalAjax;
        }
    })

    it('calls ajax on YPY-Location with HCON config', function () {
        let ajaxCalled = false;
        let ajaxArgs = null;
        const originalAjax = ypy.ajax;
        ypy.ajax = function(method, path, opts) {
            ajaxCalled = true;
            ajaxArgs = { method, path, opts };
        };

        try {
            let ctx = {
                ypy: { location: 'path:/test target:#result' },
                sourceElement: createProcessedHTML('<div></div>')
            };

            let result = ypy.__handleHeadersAndMaybeReturnEarly(ctx);

            assert.isTrue(result);
            assert.isTrue(ajaxCalled);
            assert.equal(ajaxArgs.method, 'GET');
            assert.equal(ajaxArgs.path, '/test');
            assert.equal(ajaxArgs.opts.target, '#result');
        } finally {
            ypy.ajax = originalAjax;
        }
    })

    it('respects push:false in YPY-Location', function () {
        let ajaxArgs = null;
        const originalAjax = ypy.ajax;
        ypy.ajax = function(method, path, opts) {
            ajaxArgs = { method, path, opts };
        };

        try {
            let ctx = {
                ypy: { location: '{"path":"/test", "push":"false"}' },
                sourceElement: createProcessedHTML('<div></div>')
            };

            ypy.__handleHeadersAndMaybeReturnEarly(ctx);

            assert.equal(ajaxArgs.opts.push, 'false');
        } finally {
            ypy.ajax = originalAjax;
        }
    })

});
