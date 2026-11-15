// SPDX-License-Identifier: MIT
import {openPage as openFrame} from '../../lib/security-frame.js'

// The lock is the ypy-lock extension: every page of this file loads it right after the core
const openPage = (options = {}) => openFrame({scripts: ['/src/ypy.js', '/src/ext/ypy-lock.js'], ...options})

// The ypy-config meta tag and its lock. Each case loads a fresh core into an iframe, because the
// core reads the tag when it is constructed.
describe('ypy-config meta tag and config lock', function() {

    let page
    afterEach(function() { page?.close(); page = null })

    function meta(content) { return `<meta name="ypy-config" content='${content}'>` }

    describe('which meta tag counts', function() {

        it('reads the tag in <head>', async function() {
            page = await openPage({head: meta('callbacks:"all",logAll:true')})
            assert.equal(page.win.ypy.config.callbacks, 'all')
            assert.isTrue(page.win.ypy.config.logAll)
        })

        itSource('ignores a tag that was injected into <body>', async function() {
            page = await openPage({
                body: meta('callbacks:"all",mode:"cors",nonce:false,locked:false'),
            })
            let config = page.win.ypy.config
            assert.isUndefined(config.callbacks)
            assert.equal(config.mode, 'same-origin')
            assert.equal(page.win.ypy.__callbacksPolicy(), 'none')
        })

        it('ignores a tag that is only in <body> even when the head has none', async function() {
            page = await openPage({body: meta('extensions:"evil"')})
            assert.equal(page.win.ypy.config.extensions, '')
        })

        it('the first tag of <head> wins over a later one', async function() {
            page = await openPage({head: meta('callbacks:"nonce"') + meta('callbacks:"all"')})
            assert.equal(page.win.ypy.config.callbacks, 'nonce')
        })

        it('a tag added after the core started changes nothing', async function() {
            page = await openPage({head: meta('callbacks:"none"')})
            page.doc.head.insertAdjacentHTML('afterbegin', meta('callbacks:"all"'))
            page.doc.body.insertAdjacentHTML('afterbegin', meta('callbacks:"all"'))
            assert.equal(page.win.ypy.config.callbacks, 'none')
        })
    })

    describe('locked:true in the meta tag', function() {

        beforeEach(async function() {
            page = await openPage({head: meta('locked:true,callbacks:"none",mode:"same-origin",extensions:"ypy-csp,ypy-lock",nonce:true,inlineScriptNonce:"abc"')})
        })

        it('reports itself as locked', function() {
            assert.isTrue(page.win.ypy.config.locked)
        })

        for (let [key, attempt] of [['mode', 'cors'], ['callbacks', 'all'], ['extensions', ''], ['nonce', false], ['inlineScriptNonce', 'evil']]) {
            it(`ignores an assignment to config.${key} and warns`, function() {
                let config = page.win.ypy.config
                let before = config[key]
                config[key] = attempt
                assert.strictEqual(config[key], before)
                assert.isTrue(page.logs.some(l => l.includes(`ypy: ${key} is locked`)), page.logs.join('\n'))
            })
        }

        it('SEC-18 (fixed): says so when locked:true is set but ypy-lock is not in config.extensions', async function() {
            page.close()
            page = await openPage({head: meta('locked:true,extensions:"ypy-csp"')})
            assert.isTrue(page.logs.some(l => l.includes('NOT locked')), page.logs.join('\n'))
            assert.isUndefined(page.win.ypy.config.lock)
        })

        it('does not warn when the assigned value is the one already set', function() {
            let before = page.logs.length
            page.win.ypy.config.mode = 'same-origin'
            assert.equal(page.logs.length, before)
        })

        it('cannot be undone with Object.defineProperty or delete', function() {
            let config = page.win.ypy.config
            assert.throws(() => Object.defineProperty(config, 'callbacks', {value: 'all'}))
            assert.throws(() => { 'use strict'; delete config.callbacks })
            assert.equal(config.callbacks, 'none')
        })

        it('cannot clear the locked flag', function() {
            let config = page.win.ypy.config
            config.locked = false
            assert.isTrue(config.locked)
        })

        it('freezes ypy.config itself', function() {
            let original = page.win.ypy.config
            page.win.ypy.config = {callbacks: 'all'}
            assert.strictEqual(page.win.ypy.config, original)
        })

        it('freezes the approved extension list', function() {
            let ypy = page.win.ypy
            if (SOURCE_BUILD) {   // the list is a private field in dist/: the refusal below is what shows it
                ypy.__approvedExt = ''
                assert.equal(ypy.__approvedExt, 'ypy-csp,ypy-lock')
            }
            assert.isFalse(ypy.registerExtension('evil', {}))
        })

        it('keeps the settings that are not security settings writable', function() {
            let config = page.win.ypy.config
            config.logAll = true
            assert.isTrue(config.logAll)
        })

        it('lock() on a locked config does nothing and does not throw', function() {
            page.win.ypy.config.lock()
            assert.isTrue(page.win.ypy.config.locked)
        })
    })

    describe('ypy.config.lock()', function() {

        it('locks at run time what the page had set until then', async function() {
            page = await openPage({head: meta('callbacks:"nonce"')})
            let ypy = page.win.ypy
            assert.isUndefined(ypy.config.locked)
            ypy.config.callbacks = 'all'   // still free
            ypy.config.callbacks = 'nonce'
            ypy.config.lock()
            ypy.config.callbacks = 'all'
            assert.equal(ypy.config.callbacks, 'nonce')
            assert.isTrue(ypy.config.locked)
        })

        it('is not an enumerable key, so config merges and key scans do not see it', async function() {
            page = await openPage()
            assert.notInclude(Object.keys(page.win.ypy.config), 'lock')
            assert.notInclude(Object.keys(page.win.ypy.config), 'selfRequestsOnly')
        })

        itSource('keeps author code off on a native page that was locked with no callbacks setting', async function() {
            page = await openPage({head: meta('locked:true'), body: '<button id="b" ypy-on:click="window.__pwn = 1">x</button>'})
            page.win.ypy.config.callbacks = 'all'
            page.win.ypy.process(page.doc.body)
            page.doc.getElementById('b').click()
            assert.isUndefined(page.win.__pwn)
            assert.equal(page.win.ypy.__callbacksPolicy(), 'none')
        })
    })

    describe('selfRequestsOnly is an alias of mode', function() {

        it('is true by default and means same-origin', async function() {
            page = await openPage()
            assert.isTrue(page.win.ypy.config.selfRequestsOnly)
            assert.equal(page.win.ypy.config.mode, 'same-origin')
        })

        it('false in the meta tag means cors', async function() {
            page = await openPage({head: meta('selfRequestsOnly:false')})
            assert.equal(page.win.ypy.config.mode, 'cors')
            assert.isFalse(page.win.ypy.config.selfRequestsOnly)
        })

        it('true in the meta tag means same-origin, even over an explicit mode', async function() {
            page = await openPage({head: meta('mode:"cors",selfRequestsOnly:true')})
            assert.equal(page.win.ypy.config.mode, 'same-origin')
        })

        it('writes go both ways', async function() {
            page = await openPage()
            let config = page.win.ypy.config
            config.selfRequestsOnly = false
            assert.equal(config.mode, 'cors')
            config.mode = 'same-origin'
            assert.isTrue(config.selfRequestsOnly)
        })

        it('is frozen with mode once the config is locked', async function() {
            page = await openPage({head: meta('locked:true')})
            page.win.ypy.config.selfRequestsOnly = false
            assert.equal(page.win.ypy.config.mode, 'same-origin')
            assert.isTrue(page.win.ypy.config.selfRequestsOnly)
        })
    })
})
