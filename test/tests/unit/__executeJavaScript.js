// SPDX-License-Identifier: MIT
describe('__executeJavaScript', function() {

    // These tests run author code (ypy-on, js: values, [filter]), which config.callbacks must allow
    beforeEach(function() { ypy.config.callbacks = 'all' })
    afterEach(function() { delete ypy.config.callbacks })

    it('returns the evaluated value by default', function() {
        let elt = document.createElement('div');
        ypy.__executeJavaScript(elt, { value: 41 }, 'value + 1', true, false).should.equal(42);
    });

    it('returns a reusable function when compile is true', function() {
        let elt = document.createElement('div');
        let run = ypy.__executeJavaScript(elt, { value: 41 }, 'value + 1', true, false, true);
        assert.isFunction(run);
        run().should.equal(42);
        run().should.equal(42);
    });

    it('lets extensions rewrite code before compilation', function() {
        let extensions = backupExtensions();
        clearExtensions();
        ypy.registerExtension('rewrite-test', {
            ypy_scope: (_, detail) => detail.code = 'value * 2'
        });
        try {
            let elt = document.createElement('div');
            ypy.__executeJavaScript(elt, { value: 21 }, 'value + 1', true, false).should.equal(42);
        } finally {
            restoreExtensions(extensions);
        }
    });

    it('applies nonce to inline scripts when config.inlineScriptNonce is set', async function () {
        mockResponse('GET', '/test', '<div id="result"><script id="test-script">window.nonceTestRan = true;</script></div>');
        ypy.config.inlineScriptNonce = 'test-nonce-123';
        try {
            createProcessedHTML('<button id="btn" ypy-get="/test" ypy-target="#target">Click</button><div id="target"></div>');
            find('#btn').click();
            await forRequest();
            await ypy.timeout(10);
            let script = find('#test-script');
            assert.equal(script.nonce, 'test-nonce-123');
        } finally {
            ypy.config.inlineScriptNonce = null;
        }
    });

});
