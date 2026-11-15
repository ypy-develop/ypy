// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Nonce gating: config.nonce makes the core fail closed, and the ypy-csp extension does the
// checking. Each case loads a fresh core (and the extension) into an iframe.
describe('nonce gating', function() {

    const N = 'page-nonce'
    const META = (content) => `<meta name="ypy-config" content='${content}'>`
    const CSP_EXT = ['/src/ypy.js', '/src/ext/ypy-csp.js']
    let page
    afterEach(function() { page?.close(); page = null })

    const powered = (selector) => page.doc.querySelector(selector).hasAttribute('data-ypy-powered')

    async function clickAndWait(selector) {
        let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
        page.doc.querySelector(selector).click()
        await Promise.race([done, new Promise(resolve => page.win.setTimeout(resolve, 100))])
    }

    const BODY = `
        <button id="ok" ypy-get="/x" ypy-nonce="${N}">ok</button>
        <button id="none" ypy-get="/x">none</button>
        <button id="wrong" ypy-get="/x" ypy-nonce="other">wrong</button>`

    describe('config.nonce is true and the extension is missing (fail closed)', function() {

        it('processes nothing, not even an element with the right nonce', async function() {
            page = await openPage({head: META('nonce:true'), body: BODY, nonce: N})
            assert.isFalse(powered('#ok'))
            assert.isFalse(powered('#none'))
            assert.isFalse(powered('#wrong'))
            assert.isTrue(page.logs.some(l => l.includes('config.nonce is set but ypy-csp did not start')), page.logs.join('\n'))
        })

        it('sends no request', async function() {
            page = await openPage({head: META('nonce:true'), body: BODY, nonce: N})
            let sent = 0
            page.win.fetch = async () => { sent++; return new page.win.Response('x') }
            page.win.ypy.process(page.doc.body)
            await clickAndWait('#ok')
            assert.equal(sent, 0)
        })

        it('also stops a programmatic request', async function() {
            page = await openPage({head: META('nonce:true'), body: '', nonce: N})
            let sent = 0
            page.win.fetch = async () => { sent++; return new page.win.Response('x') }
            await page.win.ypy.ajax('GET', '/z', {target: page.doc.body})
            assert.equal(sent, 0)
        })

        it('stays closed when the extension is not in config.extensions', async function() {
            page = await openPage({head: META('nonce:true,extensions:"ypy-head"'), body: BODY, nonce: N, scripts: CSP_EXT})
            assert.isFalse(powered('#ok'))
            if (SOURCE_BUILD) assert.isFalse(page.win.ypy.__registeredExt.has('ypy-csp'))
        })

        it('stays closed when the page has no nonce for the extension to use', async function() {
            page = await openPage({head: META('nonce:true,extensions:"ypy-csp"'), body: BODY, scripts: CSP_EXT})
            assert.isFalse(powered('#ok'))
            assert.isTrue(page.logs.some(l => l.includes('no page nonce found')), page.logs.join('\n'))
        })

        it('stays closed when the CSP blocks the Trusted Types policy', async function() {
            page = await openPage({
                head: META('nonce:true,extensions:"ypy-csp"') + `<meta http-equiv="Content-Security-Policy" content="trusted-types other">`,
                body: BODY, nonce: N, scripts: CSP_EXT
            })
            assert.isFalse(powered('#ok'))
        })
    })

    describe('with the extension started', function() {

        beforeEach(async function() {
            page = await openPage({head: META('nonce:true,extensions:"ypy-csp",callbacks:"nonce"'), body: BODY, nonce: N, scripts: CSP_EXT})
        })

        it('processes the element with the page nonce and only that one', function() {
            assert.isTrue(powered('#ok'))
            assert.isFalse(powered('#none'))
            assert.isFalse(powered('#wrong'))
        })

        it('strips the ypy attributes of the others', function() {
            assert.isFalse(page.doc.querySelector('#none').hasAttribute('ypy-get'))
            assert.isFalse(page.doc.querySelector('#wrong').hasAttribute('ypy-get'))
            assert.isTrue(page.doc.querySelector('#ok').hasAttribute('ypy-get'))
        })

        it('fires ypy:security:strip with the reason', function() {
            let reasons = []
            page.doc.addEventListener('ypy:security:strip', e => reasons.push(e.detail.reason))
            page.doc.body.insertAdjacentHTML('beforeend', '<i id="a" ypy-get="/x"></i><i id="b" ypy-get="/x" ypy-nonce="nope"></i>')
            page.win.ypy.process(page.doc.body)
            assert.deepEqual(reasons, ['missing-nonce', 'nonce-mismatch'])
        })

        it('does not let a nonce on a container vouch for the elements inside it', function() {
            page.doc.body.insertAdjacentHTML('beforeend', `<div ypy-nonce="${N}"><button id="child" ypy-get="/x">c</button></div>`)
            page.win.ypy.process(page.doc.body)
            assert.isFalse(powered('#child'))
            assert.isFalse(page.doc.querySelector('#child').hasAttribute('ypy-get'))
        })

        it('does not let an inheritable nonce vouch for the elements inside it either', function() {
            page.doc.body.insertAdjacentHTML('beforeend', `<div ypy-nonce:inherited="${N}"><button id="child" ypy-get="/x">c</button></div>`)
            page.win.ypy.process(page.doc.body)
            assert.isFalse(powered('#child'))
        })

        it('still sends the request of a nonced element', async function() {
            let sent = []
            page.win.fetch = async (url) => { sent.push(String(url)); return new page.win.Response('x') }
            await clickAndWait('#ok')
            assert.equal(sent.length, 1)
        })

        it('never sends the request of a stripped element', async function() {
            let sent = 0
            page.win.fetch = async () => { sent++; return new page.win.Response('x') }
            await clickAndWait('#none')
            await clickAndWait('#wrong')
            assert.equal(sent, 0)
        })
    })

    describe('callbacks "nonce"', function() {

        beforeEach(async function() {
            page = await openPage({
                head: META('nonce:true,extensions:"ypy-csp",callbacks:"nonce"'),
                body: `<button id="ok" ypy-nonce="${N}" ypy-on:click="window.__ran = (window.__ran || 0) + 1">ok</button>
                       <button id="bare" ypy-on:click="window.__ran = 99">bare</button>`,
                nonce: N, scripts: CSP_EXT
            })
        })

        it('runs the code of an element with the page nonce', async function() {
            page.doc.querySelector('#ok').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 20))
            assert.equal(page.win.__ran, 1)
        })

        it('never runs the code of an element without it (its ypy-on is stripped)', async function() {
            page.doc.querySelector('#bare').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 20))
            assert.isUndefined(page.win.__ran)
            assert.isFalse(page.doc.querySelector('#bare').hasAttribute('ypy-on:click'))
        })

        it('re-checks the nonce when the code runs: an element that lost it does not run code', async function() {
            let violations = []
            page.doc.addEventListener('ypy:security:violation', e => violations.push(e.detail.reason))
            let ok = page.doc.querySelector('#ok')
            ok.setAttribute('ypy-nonce', 'swapped-later')
            ok.click()
            await new Promise(resolve => page.win.setTimeout(resolve, 20))
            assert.isUndefined(page.win.__ran)
            assert.deepEqual(violations, ['nonce-mismatch-at-eval'])
        })

        itSource('code from an element whose nonce was never checked is blocked as well', function() {
            let loose = page.doc.createElement('div')
            page.doc.body.append(loose)
            let result = page.win.ypy.__executeJavaScript(loose, {}, 'window.__ran = 5', false, false)
            assert.isUndefined(page.win.__ran)
            assert.isUndefined(result)
        })
    })

    describe('callbacks "nonce" without the extension', function() {

        it('blocks all author code', async function() {
            page = await openPage({head: META('callbacks:"nonce"'), body: '<button id="b" ypy-on:click="window.__ran = 1">b</button>'})
            page.doc.querySelector('#b').click()
            assert.isUndefined(page.win.__ran)
        })
    })

    describe('ypy-ignore under gating', function() {

        beforeEach(async function() {
            page = await openPage({
                head: META('nonce:true,extensions:"ypy-csp"'),
                body: `<div id="plain" ypy-ignore><button id="inside-plain" ypy-get="/x" ypy-nonce="${N}">a</button></div>
                       <div id="signed" ypy-ignore ypy-nonce="${N}"><button id="inside-signed" ypy-get="/x" ypy-nonce="${N}">b</button></div>`,
                nonce: N, scripts: CSP_EXT
            })
        })

        it('an ignore marker without the nonce is not honored: it protects nothing', function() {
            assert.isTrue(powered('#inside-plain'))
        })

        it('an ignore marker with the nonce is honored', function() {
            assert.isTrue(page.doc.querySelector('#signed').hasAttribute('ypy-ignore'))
            assert.isFalse(powered('#inside-signed'))
        })

        it('a nonced marker nested inside an unnonced one still counts', function() {
            page.doc.body.insertAdjacentHTML('beforeend', `<div ypy-ignore><div ypy-ignore ypy-nonce="${N}"><button id="deep" ypy-get="/x" ypy-nonce="${N}">c</button></div></div>`)
            page.win.ypy.process(page.doc.body)
            assert.isFalse(powered('#deep'))
        })
    })
})
