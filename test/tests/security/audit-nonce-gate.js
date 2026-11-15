// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Security audit 2026-11-15 (TASK-044), fixed in TASK-046: the nonce gate. A test titled "SEC-NN (fixed)"
// asserts the safe behaviour that replaced the vulnerable one the audit proved; tests titled "safe:" assert
// behaviour that was always correct. See docs/security/audit-2026-11-15.md.
//
// The pages are srcdoc iframes whose origin is opaque ("null"), so a response URL of `about:srcdoc`
// stands in for "same origin" where the extension checks it.
describe('audit: nonce gate (csp extension)', function() {

    const N = 'page-nonce'
    const CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${N}'">`
    let page
    afterEach(function() { page?.close(); page = null })

    // the extension file and name depend on the naming contract in force; find the one that exists
    function extName(name) {
        let custom = (ypy.config.prefix || '').replace(/^data-/, '')
        for (let base of ['ypy-', custom]) {
            if (!base) continue
            let xhr = new XMLHttpRequest()
            xhr.open('HEAD', `/src/ext/${base}${name}.js`, false)
            xhr.send()
            if (xhr.status === 200) return `${base}${name}`
        }
        throw new Error('extension not found: ' + name)
    }

    async function gatePage(body, extra = '') {
        let csp = extName('csp')
        page = await openPage({
            head: `${CSP}<meta name="ypy-config" content='nonce:true,extensions:"${csp}",callbacks:"nonce"${extra}'>`,
            body, nonce: N, scripts: ['/src/ypy.js', `/src/ext/${csp}.js`]
        })
        return csp
    }

    const LOAD = `<button id="load" ypy-get="/frag" ypy-target="#out" ypy-nonce="${N}">Load</button><div id="out"></div>`

    // the next click on #load gets this response; `sameOrigin` gives it a URL the extension accepts
    async function load(html, {headers = {}, sameOrigin = true} = {}) {
        page.win.fetch = async () => {
            let r = new page.win.Response(html, {status: 200, headers: {'Content-Type': 'text/html', ...headers}})
            if (sameOrigin) Object.defineProperty(r, 'url', {value: page.win.location.origin === 'null' ? page.win.location.href : page.win.location.origin + '/frag'})
            return r
        }
        let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
        page.doc.getElementById('load').click()
        await done
        await new Promise(resolve => page.win.setTimeout(resolve, 30))
        return page.doc.getElementById('out')
    }

    const powered = elt => !!elt && elt.hasAttribute('data-ypy-powered')

    describe('nonce promotion', function() {

        const INJECTED = `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-EVIL'">` +
            `<button id="evil" ypy-get="/evil" ypy-nonce="EVIL">x</button><script nonce="EVIL">window.__pwn = 1</script>`

        // SEC-01. The "response nonce" used to be read from a <meta http-equiv="Content-Security-Policy"> found in
        // the response body when the header had no nonce. The body is attacker-controlled markup, so the injected
        // nonce was rewritten to the page nonce: the injected element passed the gate and the injected <script>
        // ran under the page CSP. Fixed: the response nonce comes from the header only.
        it('SEC-01 (fixed): an injected CSP meta promotes nothing (no header)', async function() {
            await gatePage(LOAD)
            let out = await load(INJECTED)
            assert.isFalse(powered(out.querySelector('#evil')), 'the injected element is stripped')
            assert.notEqual(out.querySelector('script')?.getAttribute('nonce'), N)
            assert.isUndefined(page.win.__pwn, 'the injected script did not run')
        })

        it('SEC-01 (fixed): the same when the response has a CSP header that carries no nonce', async function() {
            await gatePage(LOAD)
            let out = await load(INJECTED, {headers: {'Content-Security-Policy': "default-src 'self'"}})
            assert.isFalse(powered(out.querySelector('#evil')))
            assert.isUndefined(page.win.__pwn)
        })

        it('safe: a nonce in the response header is still promoted to the page nonce', async function() {
            await gatePage(LOAD)
            let out = await load(`<button id="ok" ypy-get="/ok" ypy-nonce="RESP">x</button>`, {headers: {'Content-Security-Policy': "script-src 'nonce-RESP'"}})
            assert.isTrue(powered(out.querySelector('#ok')))
            assert.equal(out.querySelector('#ok').getAttribute('ypy-nonce'), N)
        })

        it('safe: when the response header carries a nonce, a meta in the body is not used', async function() {
            await gatePage(LOAD)
            let out = await load(INJECTED, {headers: {'Content-Security-Policy': "script-src 'nonce-RESP'"}})
            assert.isFalse(powered(out.querySelector('#evil')))
            assert.isUndefined(page.win.__pwn)
        })

        it('safe: a response whose URL is not verified as same-origin is scrubbed but never promoted', async function() {
            await gatePage(LOAD)
            let out = await load(INJECTED, {sameOrigin: false})
            assert.isFalse(powered(out.querySelector('#evil')))
            assert.isUndefined(page.win.__pwn)
        })
    })

    describe('scrub of a copied page nonce', function() {

        // SEC-02. The scrub reads raw text, so HTML spellings the parser reads as the same attribute escaped it:
        // whitespace around "=" and a character reference inside the value. Fixed: what the text scrub leaves is
        // checked on the parsed markup, and a response that still carries the page nonce is refused whole.
        it('SEC-02 (fixed): a page nonce written as `ypy-nonce = "..."` is not honoured: the response is refused', async function() {
            await gatePage(LOAD)
            let refused = 0
            page.doc.addEventListener('ypy:security:violation', e => { if (e.detail.reason === 'page-nonce-in-response') refused++ })
            let out = await load(`<button id="a" ypy-get="/a" ypy-nonce = "${N}">x</button>`)
            assert.isFalse(powered(out.querySelector('#a')))
            assert.equal(refused, 1)
        })

        it('SEC-02 (fixed): the same with a character reference inside the value', async function() {
            await gatePage(LOAD)
            let out = await load(`<button id="b" ypy-get="/b" ypy-nonce="page&#45;nonce">x</button>`)
            assert.isFalse(powered(out.querySelector('#b')))
            assert.isNull(out.querySelector('#b'), 'the response was refused')
        })

        it('SEC-02 (fixed): a copy of the page nonce inside <template> content is caught as well', async function() {
            await gatePage(LOAD)
            let out = await load(`<template><button ypy-get="/c" ypy-nonce = "${N}">x</button></template>`)
            assert.isNull(out.querySelector('template'))
        })

        it('safe: the plain spelling of the page nonce is scrubbed', async function() {
            await gatePage(LOAD)
            let out = await load(`<button id="a" ypy-get="/a" ypy-nonce="${N}">x</button>`)
            assert.isFalse(powered(out.querySelector('#a')))
        })
    })

    describe('what the gate does not see', function() {

        // SEC-03. The gate runs when an element is initialised (ypy:before:init). An out-of-band element and a
        // partial are consumed while the response is swapped, before anything is initialised, so unnonced markup
        // in one swap could rewrite any element of the page by id. Fixed: the core asks the extensions
        // (ypy:before:oob) before it takes such an element out of the response, and the gate vetoes one that lacks
        // the nonce: an out-of-band element stays ordinary content with its ypy attributes stripped, a partial is dropped.
        it('SEC-03 (fixed): an unnonced out-of-band element does not replace an element elsewhere in the page', async function() {
            await gatePage(LOAD + '<p id="victim">original</p>')
            await load('<i>main</i><div id="victim" ypy-swap-oob="true">REPLACED</div>')
            // the vetoed element is ordinary content of #out (a second element with that id), the page's own <p> is untouched
            assert.equal(page.doc.querySelector('p#victim').textContent, 'original')
            assert.isFalse(powered(page.doc.querySelector('#out #victim')))
        })

        it('SEC-03 (fixed): an unnonced partial does not either', async function() {
            await gatePage(LOAD + '<p id="victim">original</p>')
            await load('<i>main</i><ypy-partial id="victim">REPLACED</ypy-partial>')
            assert.equal(page.doc.getElementById('victim').textContent, 'original')
            assert.equal(page.doc.querySelectorAll('#victim').length, 1)
        })

        it('safe: a nonced out-of-band element and a nonced partial still swap', async function() {
            await gatePage(LOAD + '<p id="v1">original</p><p id="v2">original</p>')
            let headers = {'Content-Security-Policy': "script-src 'nonce-RESP'"}
            await load('<i>main</i><p id="v1" ypy-swap-oob="true" ypy-nonce="RESP">one</p><ypy-partial id="v2" ypy-nonce="RESP">two</ypy-partial>', {headers})
            assert.equal(page.doc.getElementById('v1').textContent, 'one')
            assert.equal(page.doc.getElementById('v2').textContent, 'two')
        })

        it('safe: attributes of the same unnonced elements that start behaviour are stripped', async function() {
            await gatePage(LOAD)
            let out = await load('<button id="evil" ypy-get="/evil">x</button>')
            assert.deepEqual(out.querySelector('#evil').getAttributeNames(), ['id'])
        })

        it('safe: a morph does not carry unnonced request attributes onto an element that already passed the gate', async function() {
            await gatePage(`<button id="load" ypy-get="/frag" ypy-target="#out" ypy-nonce="${N}">Load</button><div id="out"><button id="legit" ypy-post="/safe" ypy-nonce="${N}">legit</button></div>`)
            await load('<button id="legit" ypy-post="/evil">legit</button>')
            let seen = []
            page.win.fetch = async url => { seen.push(url); return new page.win.Response('') }
            page.doc.getElementById('legit').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 60))
            assert.notInclude(seen, '/evil')
        })
    })

    describe('safeEval', function() {

        // SEC-04 (latent). With config.safeEval the extension builds the source text
        // `window.fn = function(<parameter names>) { <body> }` and runs it in a nonced script. The parameter names
        // are the keys of the variables an extension hands to executeJavaScript, so a key that is not an identifier
        // used to become code in a script that carries the page nonce. In the core every caller passes fixed names, so
        // there was no way in from markup, but any extension that passed data-derived keys inherited the hole.
        // Fixed: a key that is not an identifier is refused with a SyntaxError, as the Function constructor does.
        const HOSTILE = {'a){}; window.__pwn = 1; var z = function(': 1}

        it('SEC-04 (fixed, latent): a data-derived variable name is refused instead of becoming code in the nonced script', async function() {
            let csp = extName('csp')
            page = await openPage({
                head: `${CSP}<meta name="ypy-config" content='nonce:true,extensions:"${csp},audit-probe",callbacks:"nonce",safeEval:true'>`,
                body: `<button id="go" ypy-get="/x" ypy-nonce="${N}">go</button>`, nonce: N, scripts: ['/src/ypy.js', `/src/ext/${csp}.js`]
            })
            let api
            page.win.ypy.registerExtension('audit-probe', {init: a => { api = a }})
            let error
            try { await api.executeJavaScript(page.doc.getElementById('go'), HOSTILE, 'void 0', false) } catch (e) { error = e }
            assert.instanceOf(error, page.win.SyntaxError)
            assert.isUndefined(page.win.__pwn)
        })

        it('safe: without safeEval the same variable name is refused by the Function constructor and nothing runs', async function() {
            let csp = extName('csp')
            page = await openPage({
                head: `<meta name="ypy-config" content='nonce:true,extensions:"${csp},audit-probe",callbacks:"nonce"'>`,
                body: `<button id="go" ypy-get="/x" ypy-nonce="${N}">go</button>`, nonce: N, scripts: ['/src/ypy.js', `/src/ext/${csp}.js`]
            })
            let api
            page.win.ypy.registerExtension('audit-probe', {init: a => { api = a }})
            let error
            try { await api.executeJavaScript(page.doc.getElementById('go'), HOSTILE, 'void 0', false) } catch (e) { error = e }
            assert.instanceOf(error, page.win.SyntaxError)
            assert.isUndefined(page.win.__pwn)
        })

        it('safe: a js: action is cancelled by the extension, so field names never reach the compiler', async function() {
            await gatePage(
                `<form id="f"><input name="a){}; window.__pwn = 1; var z = function(" value="1">` +
                `<button id="go" ypy-post="js:void 0" ypy-nonce="${N}">go</button></form>`, ',safeEval:true')
            page.doc.getElementById('go').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 80))
            assert.isUndefined(page.win.__pwn)
        })
    })
})
