// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Attack cases: attacker markup arrives in a response (or sits in the page) and must not become
// behavior. The nonce gate (ypy-csp) is on for the first group; the second group shows what the
// gate protects against, and the last one runs under a real script CSP.
describe('HTML and attribute injection', function() {

    const NONCE = 'test-nonce'
    let extBackup
    let nonceScript

    before(async function() {
        extBackup = backupExtensions()
        clearExtensions()
        ypy.config.extensions = 'ypy-csp'

        nonceScript = document.createElement('script')
        nonceScript.setAttribute('nonce', NONCE)
        nonceScript.nonce = NONCE
        nonceScript.type = 'application/json'
        nonceScript.textContent = '{}'
        document.head.appendChild(nonceScript)

        let script = document.createElement('script')
        script.nonce = NONCE
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

    let strips
    let violations
    const onStrip = e => strips.push(e.detail)
    const onViolation = e => violations.push(e.detail.reason)

    beforeEach(function() {
        strips = []
        violations = []
        window.pwned = 0
        document.addEventListener('ypy:security:strip', onStrip)
        document.addEventListener('ypy:security:violation', onViolation)
    })

    afterEach(function() {
        document.removeEventListener('ypy:security:strip', onStrip)
        document.removeEventListener('ypy:security:violation', onViolation)
        delete ypy.config.callbacks
        delete window.pwned
        cleanupTest()
    })

    // loads the legit button, which swaps `html` into #out
    async function swapIn(html) {
        mockResponse('GET', '/inject', html)
        let button = createProcessedHTML(`<button id="load" ypy-get="/inject" ypy-target="#out" ypy-nonce="${NONCE}">Load</button><div id="out"></div>`)
        button.click()
        await forRequest()
        await ypy.timeout(20)
        return find('#out')
    }

    describe('with the gate', function() {

        beforeEach(function() {
            setupTest(this)
            ypy.config.callbacks = 'all'   // the worst case: code is allowed, the gate must still hold
        })

        for (let spelling of ['ypy-get', 'data-ypy-get']) {
            it(`an injected ${spelling} is stripped and sends no request`, async function() {
                let out = await swapIn(`<button id="evil" ${spelling}="/evil">x</button>`)
                let evil = out.querySelector('#evil')
                assert.deepEqual(evil.getAttributeNames(), ['id'])
                let before = fetchMock.calls.length
                evil.click()
                await ypy.timeout(30)
                assert.equal(fetchMock.calls.length, before)
                assert.equal(strips.length, 1)
                assert.equal(strips[0].reason, 'missing-nonce')
            })
        }

        it('an injected ypy-on handler is stripped and never runs, even with callbacks "all"', async function() {
            let out = await swapIn('<button id="evil" ypy-on:click="window.pwned++" ypy-on="click -> window.pwned++">x</button>')
            let evil = out.querySelector('#evil')
            evil.click()
            await ypy.timeout(30)
            assert.equal(window.pwned, 0)
            assert.isFalse(evil.hasAttribute('ypy-on:click'))
            assert.isFalse(evil.hasAttribute('ypy-on'))
        })

        it('ypy-vals, ypy-headers, ypy-boost and ypy-swap-oob attributes injected on plain elements are stripped', async function() {
            let out = await swapIn('<a id="a" href="/x" ypy-boost="true" ypy-vals="js:{a: window.pwned++}">a</a><form id="f" ypy-post="/p" ypy-headers="js:{X: window.pwned++}"></form>')
            assert.deepEqual(out.querySelector('#a').getAttributeNames(), ['id', 'href'])
            assert.deepEqual(out.querySelector('#f').getAttributeNames(), ['id'])
            assert.equal(window.pwned, 0)
        })

        it('an attribute with a nonce that was stolen from the page is scrubbed from the response', async function() {
            let out = await swapIn(`<button id="evil" ypy-get="/evil" ypy-nonce="${NONCE}">x</button><script nonce="${NONCE}" type="application/json">{}</script>`)
            let evil = out.querySelector('#evil')
            assert.isFalse(evil.hasAttribute('ypy-nonce'))
            assert.isFalse(evil.hasAttribute('ypy-get'))
            assert.isFalse(out.querySelector('script').hasAttribute('nonce'))
        })

        it('a wrong nonce is reported as a mismatch', async function() {
            await swapIn('<button id="evil" ypy-get="/evil" ypy-nonce="guess">x</button>')
            assert.equal(strips.length, 1)
            assert.equal(strips[0].reason, 'nonce-mismatch')
        })

        it('a ypy-config meta tag in a response does not reconfigure anything', async function() {
            let mode = ypy.config.mode
            await swapIn('<meta name="ypy-config" content=\'mode:"cors",callbacks:"all",extensions:""\'><p>x</p>')
            assert.equal(ypy.config.mode, mode)
            assert.equal(ypy.config.extensions, 'ypy-csp')
        })

        it('an injected element inside the response of a nonced element stays inert next to a legit one', async function() {
            let out = await swapIn(`<button id="legit" ypy-get="/x" ypy-nonce="other">a</button><button id="evil" ypy-get="/x">b</button>`)
            assert.equal(out.querySelectorAll('[ypy-get]').length, 0)
        })

        it('a nonced element with a javascript: action is blocked', async function() {
            let button = createProcessedHTML(`<button ypy-get="javascript:window.pwned++" ypy-nonce="${NONCE}">x</button>`)
            button.click()
            await ypy.timeout(30)
            assert.equal(window.pwned, 0)
            assert.include(violations, 'javascript-url')
        })

        it('a nonced element with a js: action is blocked', async function() {
            let button = createProcessedHTML(`<button ypy-get="js:window.pwned++" ypy-nonce="${NONCE}">x</button>`)
            button.click()
            await ypy.timeout(30)
            assert.equal(window.pwned, 0)
            assert.include(violations, 'javascript-url')
        })

        it('a javascript: link is never boosted: ypy leaves it to the browser and the CSP', async function() {
            let link = createProcessedHTML(`<a href="javascript:window.pwned++" ypy-boost="true" ypy-nonce="${NONCE}">x</a>`)
            assert.isNotOk(link._ypy?.boosted)
            assert.equal(fetchMock.calls.length, 0)
        })

        it('a boosted link to another origin is never boosted either', async function() {
            let link = createProcessedHTML(`<a href="https://other.example/x" ypy-boost="true" ypy-nonce="${NONCE}">x</a>`)
            assert.isNotOk(link._ypy?.boosted)
        })

        it('a boosted form cannot be redirected by an unnonced submitter formaction', async function() {
            mockResponse('POST', '/evil', 'x')
            mockResponse('POST', '/safe', 'x')
            let form = createProcessedHTML(`<form ypy-boost="true" ypy-nonce="${NONCE}" action="/safe" method="post" ypy-target="#t"><button id="s" formaction="/evil">go</button></form><div id="t"></div>`)
            form.requestSubmit(form.querySelector('#s'))
            await ypy.timeout(40)
            assert.equal(fetchMock.calls.length, 0)
            assert.include(violations, 'unnonced-submitter')
        })

        it('a boosted form submitter with the nonce may set formaction', async function() {
            mockResponse('POST', '/other', 'x')
            let form = createProcessedHTML(`<form ypy-boost="true" ypy-nonce="${NONCE}" action="/safe" method="post" ypy-target="#t"><button id="s" formaction="/other" ypy-nonce="${NONCE}">go</button></form><div id="t"></div>`)
            form.requestSubmit(form.querySelector('#s'))
            await forRequest()
            assert.equal(fetchMock.calls.length, 1)
            assert.include(fetchMock.calls[0].url, '/other')
        })
    })

    describe('without the gate (what the gate is for)', function() {

        let page
        afterEach(function() { page?.close(); page = null })

        it('an injected attribute in a response becomes behavior', async function() {
            page = await openPage({body: '<button id="load" ypy-get="/inject" ypy-target="#out">Load</button><div id="out"></div>'})
            let requested = []
            page.win.fetch = async (url) => {
                requested.push(new URL(url).pathname)
                return new page.win.Response(new URL(url).pathname === '/inject' ? '<button id="evil" ypy-get="/evil">x</button>' : 'x')
            }
            page.win.ypy.process(page.doc.body)
            let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
            page.doc.getElementById('load').click()
            await done
            await new Promise(resolve => page.win.setTimeout(resolve, 20))
            page.doc.getElementById('evil').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 40))
            assert.deepEqual(requested, ['/inject', '/evil'])
        })
    })

    describe('under a real script CSP (nonce only)', function() {

        const N = 'csp-nonce'
        let page

        beforeEach(async function() {
            page = await openPage({
                head: `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${N}'">` +
                      `<meta name="ypy-config" content='nonce:true,extensions:"ypy-csp",callbacks:"nonce"'>`,
                body: `<button id="load" ypy-get="/inject" ypy-target="#out" ypy-nonce="${N}">Load</button><div id="out"></div>`,
                nonce: N,
                scripts: ['/src/ypy.js', '/src/ext/ypy-csp.js']
            })
        })

        afterEach(function() { page?.close(); page = null })

        async function load(html) {
            page.win.fetch = async () => new page.win.Response(html, {status: 200, headers: {'Content-Type': 'text/html'}})
            let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
            page.doc.getElementById('load').click()
            await done
            await new Promise(resolve => page.win.setTimeout(resolve, 30))
            return page.doc.getElementById('out')
        }

        it('a script in the response without a nonce does not run', async function() {
            let out = await load('<script>window.__pwn = 1</script><p>x</p>')
            assert.isUndefined(page.win.__pwn)
            assert.equal(out.querySelector('p').textContent, 'x')
        })

        it('a script that copies the page nonce does not run, the response nonce is scrubbed', async function() {
            let out = await load(`<script nonce="${N}">window.__pwn = 2</script>`)
            assert.isUndefined(page.win.__pwn)
            assert.isFalse(out.querySelector('script').hasAttribute('nonce'))
        })

        it('an inline event handler attribute does not run', async function() {
            let out = await load('<img id="i" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__pwn = 3"><b id="b" onclick="window.__pwn = 4">b</b>')
            out.querySelector('#b').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 30))
            assert.isUndefined(page.win.__pwn)
        })

        it('an element with ypy-on and no nonce is stripped', async function() {
            let out = await load('<b id="b" ypy-on:click="window.__pwn = 5">b</b>')
            out.querySelector('#b').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 30))
            assert.isUndefined(page.win.__pwn)
        })

        it('a javascript: link is not followed by ypy', async function() {
            let out = await load(`<a id="a" href="javascript:window.__pwn = 6" ypy-boost="true">a</a>`)
            assert.isFalse(out.querySelector('#a').hasAttribute('ypy-boost'))
        })
    })
})
