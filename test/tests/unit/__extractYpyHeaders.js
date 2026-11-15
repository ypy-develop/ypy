// SPDX-License-Identifier: MIT
describe('__extractYpyHeaders unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('extracts YPY headers from response', function () {
        let ctx = {
            response: {
                raw: {
                    headers: new Headers({
                        'YPY-Trigger': 'myEvent',
                        'YPY-Redirect': '/new-page',
                        'Content-Type': 'text/html'
                    })
                }
            }
        }

        ypy.__extractYpyHeaders(ctx)

        assert.equal(ctx.ypy.trigger, 'myEvent')
        assert.equal(ctx.ypy.redirect, '/new-page')
        assert.isUndefined(ctx.ypy.contenttype)
    })

    it('converts header names to lowercase and removes hyphens', function () {
        let ctx = {
            response: {
                raw: {
                    headers: new Headers({
                        'YPY-Push-Url': '/new-url',
                        'YPY-Replace-Url': '/replace-url',
                        'YPY-Re-Swap': 'outerHTML'
                    })
                }
            }
        }

        ypy.__extractYpyHeaders(ctx)

        assert.equal(ctx.ypy.pushurl, '/new-url')
        assert.equal(ctx.ypy.replaceurl, '/replace-url')
        assert.equal(ctx.ypy.reswap, 'outerHTML')
    })

    it('handles empty headers', function () {
        let ctx = {
            response: {
                raw: {
                    headers: new Headers()
                }
            }
        }

        ypy.__extractYpyHeaders(ctx)

        assert.deepEqual(ctx.ypy, {})
    })

    it('only extracts headers that start with YPY-', function () {
        let ctx = {
            response: {
                raw: {
                    headers: new Headers({
                        'YPY-Trigger': 'myEvent',
                        'X-Custom-Header': 'value',
                        'Content-Type': 'text/html',
                        'YPY-Refresh': 'true'
                    })
                }
            }
        }

        ypy.__extractYpyHeaders(ctx)

        assert.equal(ctx.ypy.trigger, 'myEvent')
        assert.equal(ctx.ypy.refresh, 'true')
        assert.isUndefined(ctx.ypy.customheader)
        assert.isUndefined(ctx.ypy.contenttype)
    })

    it('handles case-insensitive YPY- prefix', function () {
        let ctx = {
            response: {
                raw: {
                    headers: new Headers({
                        'ypy-trigger': 'lowercase',
                        'Ypy-Redirect': 'mixedcase',
                        'YPY-REFRESH': 'uppercase'
                    })
                }
            }
        }

        ypy.__extractYpyHeaders(ctx)

        assert.equal(ctx.ypy.trigger, 'lowercase')
        assert.equal(ctx.ypy.redirect, 'mixedcase')
        assert.equal(ctx.ypy.refresh, 'uppercase')
    })

    it('overwrites existing ctx.ypy object', function () {
        let ctx = {
            ypy: {
                oldValue: 'should be removed'
            },
            response: {
                raw: {
                    headers: new Headers({
                        'YPY-Trigger': 'newEvent'
                    })
                }
            }
        }

        ypy.__extractYpyHeaders(ctx)

        assert.equal(ctx.ypy.trigger, 'newEvent')
        assert.isUndefined(ctx.ypy.oldValue)
    })

});
