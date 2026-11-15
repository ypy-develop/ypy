// SPDX-License-Identifier: MIT
describe('ypy-csp extension', function() {

    let extBackup
    let nonceScript

    before(async function() {
        extBackup = backupExtensions()
        clearExtensions()
        ypy.config.extensions = 'ypy-csp'

        nonceScript = document.createElement('script')
        nonceScript.setAttribute('nonce', 'test-nonce')
        nonceScript.nonce = 'test-nonce'
        nonceScript.type = 'application/json'
        nonceScript.textContent = '{}'
        document.head.appendChild(nonceScript)

        let script = document.createElement('script')
        script.nonce = 'test-nonce'
        script.src = '../src/ext/ypy-csp.js'
        await new Promise(resolve => {
            script.onload = resolve
            document.head.appendChild(script)
        })
    })

    after(function() {
        nonceScript.remove()
        restoreExtensions(extBackup)
    })

    beforeEach(function() {
        setupTest()
    })

    afterEach(function() {
        cleanupTest()
    })

    // CSP rewrites response text before core builds the swap fragment.
    it('scrubs the page nonce from ctx.text', async function() {
        mockResponse('GET', '/test', '<script type="application/json" nonce="test-nonce">{}</script>')
        let button = createProcessedHTML('<button ypy-get="/test" ypy-target="#target" ypy-nonce="test-nonce">Load</button><div id="target"></div>')
        let responseText
        button.addEventListener('ypy:after:request', event => {
            responseText = event.detail.ctx.text
        })

        button.click()
        await forRequest()

        assert.notInclude(responseText, 'test-nonce')
        assert.isFalse(find('#target script').hasAttribute('nonce'))
    })

    it('strips ypy-* and data-ypy-* attributes from elements without a valid nonce', function() {
        let strips = []
        let handler = event => strips.push(event.detail.stripped)
        document.addEventListener('ypy:security:strip', handler)
        try {
            let pg = playground()
            pg.innerHTML = '<button id="a" ypy-get="/test" ypy-target="#t">A</button>' +
                '<button id="b" data-ypy-get="/test">B</button>' +
                '<button id="c" ypy-get="/test" ypy-nonce="wrong">C</button>' +
                '<button id="d" ypy-get="/test" ypy-nonce="test-nonce">D</button>'
            ypy.process(pg)
            assert.deepEqual([...find('#a').getAttributeNames()], ['id'])
            assert.deepEqual([...find('#b').getAttributeNames()], ['id'])
            assert.deepEqual([...find('#c').getAttributeNames()], ['id'])
            assert.isTrue(find('#d').hasAttribute('ypy-get'), 'a valid ypy-nonce keeps the attributes')
            assert.equal(strips.length, 3)
        } finally {
            document.removeEventListener('ypy:security:strip', handler)
        }
    })

    it('gets the Trusted Types policy from the core API instead of creating its own', function() {
        // this page lists no approved extensions, so a probe may register
        let api
        ypy.registerExtension('ypy-csp-probe', {init: a => { api = a }})
        ypy.__registeredExt?.delete('ypy-csp-probe')
        let policy = api.ttPolicy()
        assert.isFunction(policy.createHTML)
        assert.isFunction(policy.createScript)
    })

    it('safeEval runs ypy-on through a nonced script and compiles each expression once', async function() {
        ypy.config.callbacks = 'all'
        ypy.config.safeEval = true
        window.safeRuns = 0
        try {
            let scriptsBefore = document.head.querySelectorAll('script').length
            let button = createProcessedHTML('<button ypy-on:click="window.safeRuns++" ypy-nonce="test-nonce">Go</button>')
            button.click()
            button.click()
            await ypy.timeout(30)
            assert.equal(window.safeRuns, 2)
            assert.equal(document.head.querySelectorAll('script').length, scriptsBefore, 'the helper scripts remove themselves')
        } finally {
            delete ypy.config.safeEval
            delete window.safeRuns
            delete ypy.config.callbacks
        }
    })

    it('an element that lost its nonce after processing does not run code', async function() {
        ypy.config.callbacks = 'all'
        let violations = []
        let handler = event => violations.push(event.detail.reason)
        document.addEventListener('ypy:security:violation', handler)
        window.lateRun = 0
        try {
            let button = createProcessedHTML('<button ypy-on:click="window.lateRun++" ypy-nonce="test-nonce">Go</button>')
            button.setAttribute('ypy-nonce', 'tampered')
            button.click()
            await ypy.timeout(30)
            assert.equal(window.lateRun, 0)
            assert.deepEqual(violations, ['nonce-mismatch-at-eval'])
        } finally {
            document.removeEventListener('ypy:security:violation', handler)
            delete ypy.config.callbacks
            delete window.lateRun
        }
    })

    it('obeys metaCharacter when creating events', function() {
        let oldMetaCharacter = ypy.config.metaCharacter
        ypy.config.metaCharacter = '-'

        // Check one event and assume the rest are consistent with it
        let eventName
        let handler = event => eventName = event.type
        document.addEventListener('ypy:security:strip', handler)
        document.addEventListener('ypy-security-strip', handler)
        try {
            createProcessedHTML('<button ypy-get="/test">Load</button>')
            assert.equal(eventName, 'ypy-security-strip', 'fired event uses metaCharacter')
        } finally {
            ypy.config.metaCharacter = oldMetaCharacter
            document.removeEventListener('ypy:security:strip', handler)
            document.removeEventListener('ypy-security-strip', handler)
        }
    })
})
