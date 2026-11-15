// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// config.scripts: what happens to the <script> elements of a response. "auto" (the default) lets them
// run, "block" leaves them inert and "nonce" runs only those that carry the nonce of the page.
describe('config.scripts', function() {

    let page
    afterEach(function() { page?.close(); page = null })

    const RESPONSE = `<p id="r">ok</p>` +
        `<script>window.__ran = (window.__ran || []).concat(['plain'])</script>` +
        `<script nonce="page-nonce">window.__ran = (window.__ran || []).concat(['page'])</script>` +
        `<script nonce="other">window.__ran = (window.__ran || []).concat(['other'])</script>`
    const BODY = '<button id="b" ypy-get="/r" ypy-target="#out">go</button><div id="out"></div>'

    async function open(config, extra = {}) {
        page = await openPage({head: config === undefined ? '' : `<meta name="ypy-config" content='${config}'>`, body: BODY, ...extra})
        page.win.fetch = async () => new page.win.Response(RESPONSE, {status: 200, headers: {'Content-Type': 'text/html'}})
        let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
        page.doc.querySelector('#b').click()
        await done
        await new Promise(resolve => page.win.setTimeout(resolve, 20))
        return page.win.__ran ?? []
    }

    it('"auto" is the default: every script of the response runs', async function() {
        assert.sameMembers(await open(), ['plain', 'page', 'other'])
    })

    it('"auto" written out does the same', async function() {
        assert.sameMembers(await open('scripts:"auto"'), ['plain', 'page', 'other'])
    })

    it('"block" runs no script and takes them out, and the markup is still swapped in', async function() {
        assert.deepEqual(await open('scripts:"block"'), [])
        assert.equal(page.doc.querySelector('#out #r').textContent, 'ok')
        assert.equal(page.doc.querySelectorAll('#out script').length, 0)
    })

    it('a value it does not know blocks too (it fails closed)', async function() {
        assert.deepEqual(await open('scripts:"yes"'), [])
    })

    it('"nonce" runs only the scripts that carry the nonce of the page', async function() {
        assert.deepEqual(await open('scripts:"nonce"', {nonce: 'page-nonce'}), ['page'])
        assert.equal(page.doc.querySelectorAll('#out script').length, 1)
    })

    it('"nonce" runs nothing when the page has no nonce', async function() {
        assert.deepEqual(await open('scripts:"nonce"'), [])
    })

    it('"nonce" takes config.inlineScriptNonce as the nonce of the page when it is set', async function() {
        assert.deepEqual(await open('scripts:"nonce",inlineScriptNonce:"other"'), ['other'])
    })

    it('can be changed at run time', async function() {
        page = await openPage({body: BODY})
        page.win.ypy.config.scripts = 'block'
        page.win.fetch = async () => new page.win.Response(RESPONSE, {status: 200, headers: {'Content-Type': 'text/html'}})
        let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
        page.doc.querySelector('#b').click()
        await done
        await new Promise(resolve => page.win.setTimeout(resolve, 20))
        assert.isUndefined(page.win.__ran)
    })
})
