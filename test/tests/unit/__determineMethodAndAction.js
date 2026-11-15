// SPDX-License-Identifier: MIT
describe('__determineMethodAndAction unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('boosted form with lowercase method="get" returns uppercase GET', function() {
        let form = createProcessedHTML('<form ypy-boost="true" action="/test" method="get"></form>')
        let result = ypy.__determineMethodAndAction(form, new Event('submit'))
        assert.equal(result.method, 'GET')
    })

    it('boosted form with lowercase method="post" returns uppercase POST', function() {
        let form = createProcessedHTML('<form ypy-boost="true" action="/test" method="post"></form>')
        let result = ypy.__determineMethodAndAction(form, new Event('submit'))
        assert.equal(result.method, 'POST')
    })

    it('boosted form with no method defaults to GET', function() {
        let form = createProcessedHTML('<form ypy-boost="true" action="/test"></form>')
        let result = ypy.__determineMethodAndAction(form, new Event('submit'))
        assert.equal(result.method, 'GET')
    })

    it('boosted anchor returns GET', function() {
        let a = createProcessedHTML('<a ypy-boost="true" href="/test">Link</a>')
        let result = ypy.__determineMethodAndAction(a, new Event('click'))
        assert.equal(result.method, 'GET')
        assert.equal(result.action, '/test')
    })

    it('non-boosted element with ypy-get returns GET', function() {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let result = ypy.__determineMethodAndAction(div, new Event('click'))
        assert.equal(result.method, 'GET')
        assert.equal(result.action, '/test')
    })

    it('non-boosted element with ypy-post returns POST', function() {
        let div = createProcessedHTML('<div ypy-post="/test"></div>')
        let result = ypy.__determineMethodAndAction(div, new Event('click'))
        assert.equal(result.method, 'POST')
        assert.equal(result.action, '/test')
    })

    it('ypy-method:inherited on parent changes method of child ypy-action', function() {
        let html = createProcessedHTML('<div ypy-method:inherited="delete"><button ypy-action="/test"></button></div>')
        let btn = html.querySelector('button')
        let result = ypy.__determineMethodAndAction(btn, new Event('click'))
        assert.equal(result.method, 'DELETE')
        assert.equal(result.action, '/test')
    })

    it('ypy-method:inherited on parent does not change method of child ypy-verb', function() {
        let html = createProcessedHTML('<div ypy-method:inherited="delete"><button ypy-post="/test"></button></div>')
        let btn = html.querySelector('button')
        let result = ypy.__determineMethodAndAction(btn, new Event('click'))
        assert.equal(result.method, 'POST')
        assert.equal(result.action, '/test')
    })

})
