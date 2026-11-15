// SPDX-License-Identifier: MIT
describe('__resolveHistoryAction unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('returns null when no push or replace', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div }
        assert.isNull(ypy.__resolveHistoryAction(ctx))
    })

    it('returns push with path from ypy-push-url attribute', function() {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-push-url="/pushed"></div>')
        let ctx = { sourceElement: div, push: '/pushed' }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'push')
        assert.equal(action.path, '/pushed')
    })

    it('returns replace with path from ypy-replace-url attribute', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, replace: '/replaced' }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'replace')
        assert.equal(action.path, '/replaced')
    })

    it('server YPY-Push-Url header overrides attribute', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, push: '/from-attr', ypy: { pushurl: '/from-header' } }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'push')
        assert.equal(action.path, '/from-header')
    })

    it('server YPY-Replace-Url header overrides attribute', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, replace: '/from-attr', ypy: { replaceurl: '/from-header' } }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'replace')
        assert.equal(action.path, '/from-header')
    })

    it('push "false" returns null', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, push: 'false' }
        assert.isNull(ypy.__resolveHistoryAction(ctx))
    })

    it('replace "false" returns null', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, replace: 'false' }
        assert.isNull(ypy.__resolveHistoryAction(ctx))
    })

    it('YPY-Push-Url: false does not block YPY-Replace-Url', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, ypy: { pushurl: 'false', replaceurl: '/new-path' } }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'replace')
        assert.equal(action.path, '/new-path')
    })

    it('YPY-Replace-Url: false does not block YPY-Push-Url', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, ypy: { pushurl: '/new-path', replaceurl: 'false' } }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'push')
        assert.equal(action.path, '/new-path')
    })

    it('push "true" resolves path from response URL', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = {
            sourceElement: div,
            push: 'true',
            response: { raw: { url: 'http://localhost/resolved' } },
            request: { action: '/fallback' }
        }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'push')
        assert.equal(action.path, '/resolved')
    })

    it('push "true" falls back to request action', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = {
            sourceElement: div,
            push: 'true',
            response: { raw: {} },
            request: { action: '/fallback' }
        }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'push')
        assert.equal(action.path, '/fallback')
    })

    it('push takes precedence over replace', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = { sourceElement: div, push: '/push-path', replace: '/replace-path' }
        let action = ypy.__resolveHistoryAction(ctx)
        assert.equal(action.type, 'push')
        assert.equal(action.path, '/push-path')
    })

})
