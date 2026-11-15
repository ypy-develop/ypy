// SPDX-License-Identifier: MIT
// Own assertions on the ARIA attributes the core writes (TASK-013). axe-core is not a
// dependency of the project; its scenarios stay pending (see the task report).
describe('ARIA attributes written by the core', function() {
    const BUSY_VALUES = ['true', 'false']
    const LIVE_VALUES = ['polite', 'assertive', 'off']
    // roles that imply a live politeness, and the value they imply
    const IMPLIED = {status: 'polite', alert: 'assertive'}

    beforeEach(function() {
        setupTest(this.currentTest)
        ypy.config.announce = {messages: {done: 'Finished', error: 'Failed'}}
    })

    afterEach(function() {
        cleanupTest()
        delete ypy.config.announce
        document.querySelectorAll('[data-ypy-live]').forEach(r => r.remove())
    })

    function audit(scope) {
        let problems = []
        for (let e of scope.querySelectorAll('[aria-busy]')) {
            if (!BUSY_VALUES.includes(e.getAttribute('aria-busy'))) problems.push('invalid aria-busy on ' + e.tagName)
        }
        for (let e of scope.querySelectorAll('[aria-live]')) {
            if (!LIVE_VALUES.includes(e.getAttribute('aria-live'))) problems.push('invalid aria-live')
            let role = e.getAttribute('role')
            if (role in IMPLIED && IMPLIED[role] !== e.getAttribute('aria-live')) problems.push('role ' + role + ' contradicts aria-live')
            if (e.closest('[aria-hidden=true],[hidden],[inert]')) problems.push('live region is hidden from assistive technology')
            if (e.hasAttribute('style')) problems.push('inline style on a live region')
        }
        return problems
    }

    function liveRegions() {
        return [...document.querySelectorAll('[data-ypy-live]')]
    }

    it('the normal, busy and error states are valid ARIA', async function() {
        let releases = []
        mockResponse('GET', '/slow', () => new Promise(resolve => releases.push(() => resolve('ok'))))
        mockResponse('GET', '/bad', 'bad', {status: 500})
        createProcessedHTML('<button id="b" ypy-get="/slow" ypy-target="#t">Go</button><button id="e" ypy-get="/bad" ypy-target="#t">Fail</button><div id="t"></div>')
        ypy.__initA11y()
        assert.deepEqual(audit(document.body), [], 'normal')

        find('#b').click()
        await ypy.timeout(20)
        assert.equal(find('#t').getAttribute('aria-busy'), 'true')
        assert.deepEqual(audit(document.body), [], 'busy')
        releases.shift()()
        await forRequest()
        await ypy.timeout(120)
        assert.deepEqual(audit(document.body), [], 'after the swap')

        find('#e').click()
        await forRequest()
        await ypy.timeout(120)
        assert.deepEqual(audit(document.body), [], 'error')
        assert.equal(document.querySelector('[data-ypy-live=assertive]').textContent, 'Failed')
    })

    it('every live region has a role that matches its politeness and no id', async function() {
        ypy.__liveRegion('polite')
        ypy.__liveRegion('assertive')
        let regions = liveRegions()
        assert.equal(regions.length, 2)
        for (let r of regions) {
            assert.isFalse(r.hasAttribute('id'))
            assert.equal(IMPLIED[r.getAttribute('role')], r.getAttribute('aria-live'))
            assert.equal(r.tagName, 'DIV')
        }
    })

    it('a live region is not focusable and holds no interactive content', async function() {
        ypy.config.announce = {messages: {done: '<button>x</button>'}}
        mockResponse('GET', '/x', 'ok')
        createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
        find('#b').click()
        await forRequest()
        await ypy.timeout(120)
        for (let r of liveRegions()) {
            assert.isFalse(r.hasAttribute('tabindex'))
            assert.equal(r.querySelectorAll('button,a,input,[tabindex]').length, 0)
        }
    })

    it('the live regions are left in place and empty once the messages are cleared', async function() {
        ypy.config.announce = {clearAfter: 40, messages: {done: 'Finished'}}
        mockResponse('GET', '/x', 'ok')
        createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="#t">Go</button><div id="t"></div>')
        find('#b').click()
        await forRequest()
        await ypy.timeout(250)
        assert.isTrue(liveRegions().length >= 1)
        assert.isTrue(liveRegions().every(r => r.textContent === ''))
    })
})
