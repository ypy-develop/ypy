// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Security audit 2026-11-15 (TASK-044), fixed in TASK-046: extensions that touch the document head and browser
// storage. "SEC-NN (fixed)" tests assert the safe behaviour; "safe:" tests assert behaviour that was always correct.
describe('audit: head merge and history cache', function() {

    const N = 'page-nonce'
    let page
    afterEach(function() { page?.close(); page = null })

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

    describe('head merge (extension head), with the nonce gate and a script CSP on', function() {

        // SEC-13. The head extension took every <head>...</head> it found in the RAW text of any response (it wraps
        // Response.text before the core parses it, so before the nonce gate looks at anything) and merged it into
        // document.head: a <base>, <link>, <meta> and <script> from a fragment that was swapped into the body.
        // Under the recommended CSP an unnonced script is still blocked, but <base href> (no base-uri in the
        // CSP the docs recommend for pages that cannot add one), <link rel=stylesheet>, and the removal of the
        // current head (merge strategy when the target is the body) were not.
        // Fixed: only a response that is a full document (it starts with a doctype or <html>) has its head merged;
        // the <head> of a fragment is ignored.
        async function headPage(responseText) {
            let csp = extName('csp'), head = extName('head')
            page = await openPage({
                head: `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${N}'">` +
                      `<meta name="ypy-config" content='nonce:true,extensions:"${csp},${head}",callbacks:"nonce"'>`,
                body: `<button id="go" ypy-post="/x" ypy-target="#out" ypy-nonce="${N}">go</button><div id="out"></div>`,
                nonce: N, scripts: ['/src/ypy.js', `/src/ext/${csp}.js`, `/src/ext/${head}.js`]
            })
            page.win.fetch = async () => new page.win.Response(responseText, {status: 200, headers: {'Content-Type': 'text/html'}})
            let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
            page.doc.getElementById('go').click()
            await done
            await new Promise(resolve => page.win.setTimeout(resolve, 60))
        }

        const HEAD = '<head><base href="https://other.example/"><link rel="author" href="https://other.example/me"><script>window.__pwn = 1</script></head>'

        it('SEC-13 (fixed): a <head> inside a fragment adds nothing to the document head', async function() {
            await headPage('<p>x</p>' + HEAD)
            assert.isNull(page.doc.head.querySelector('base'))
            assert.isNull(page.doc.head.querySelector('link[rel=author][href^="https://other.example"]'))
            assert.isUndefined(page.win.__pwn)
        })

        it('safe: the head of a full document is still merged', async function() {
            await headPage('<!DOCTYPE html><html>' + HEAD.replace('<script>window.__pwn = 1</script>', '') + '<body><p>x</p></body></html>')
            assert.equal(page.doc.head.querySelector('base')?.getAttribute('href'), 'https://other.example/')
        })
    })

    describe('history cache (extension history-cache)', function() {

        let extBackup
        before(async function() {
            extBackup = backupExtensions()
            clearExtensions()
            ypy.config.extensions = 'ypy-history-cache'
            ypy.__approvedExt = 'ypy-history-cache'
            let script = document.createElement('script')
            script.src = `../src/ext/${extName('history-cache')}.js`
            await new Promise(resolve => { script.onload = resolve; document.head.appendChild(script) })
        })
        after(function() { restoreExtensions(extBackup) })
        beforeEach(function() {
            setupTest(this)
            sessionStorage.clear()
            ypy.config.historyCache = {size: 10, refreshOnMiss: false, disable: false, swapStyle: 'outerSync'}
        })
        afterEach(function() { cleanupTest(); sessionStorage.clear() })

        async function leavePage(inner, typed) {
            let saved = null
            document.addEventListener('ypy:history:cache:after:save', e => { saved = e.detail }, {once: true})
            mockResponse('GET', '/page2', '<p>page 2</p>')
            playground().innerHTML = `<div ypy-history-elt>${inner}</div><button id="go" ypy-get="/page2" ypy-push-url="/page2">go</button>`
            ypy.process(playground())
            typed?.()
            find('#go').click()
            await forRequest()
            await ypy.timeout(30)
            return {saved, stored: Object.keys(sessionStorage).map(k => sessionStorage.getItem(k)).join('\n')}
        }

        // SEC-14. Leaving a page snapshots the history element into sessionStorage in clear text: the value of every
        // field except password and file, including type=hidden (CSRF tokens, ids), fields marked
        // autocomplete="off" or with an autocomplete token for a card or a one-time code, and the whole rendered
        // private content. Nothing purged the snapshots on logout. Any same-origin script (and anyone with the tab)
        // can read them.
        // Fixed: a field the browser is told not to remember (password, autocomplete off, cc-*, one-time-code) is not
        // stored, neither what was typed nor the value the server rendered; ypy.history.clear() forgets every
        // snapshot (for sign-out). Hidden fields stay (decision in the audit report: no secret from a script of
        // the page, and a restored form without its token could not be submitted).
        it('SEC-14 (fixed): autocomplete="off", card and one-time-code fields are not stored, typed or rendered', async function() {
            let {stored} = await leavePage(
                '<input type="hidden" name="csrf" value="tok-123">' +
                '<input name="card" autocomplete="off" value="4111111111111111">' +
                '<input name="otp" autocomplete="one-time-code" value="987654">' +
                '<input name="typed" autocomplete="cc-number"><textarea name="note" autocomplete="off">private note</textarea>' +
                '<input name="visible" value="v-ok">',
                () => { find('[name=typed]').value = '5500000000000004' })
            assert.notInclude(stored, '4111111111111111')
            assert.notInclude(stored, '987654')
            assert.notInclude(stored, '5500000000000004')
            assert.notInclude(stored, 'private note')
            assert.include(stored, 'v-ok')
            assert.include(stored, 'tok-123', 'hidden fields are kept so a restored form can be submitted')
        })

        it('SEC-14 (fixed): ypy.history.clear() forgets every snapshot', async function() {
            let {stored} = await leavePage('<input name="visible" value="v-ok">')
            assert.include(stored, 'v-ok')
            ypy.history.clear()
            assert.equal(Object.keys(sessionStorage).filter(k => k.startsWith('ypy-history')).length, 0)
        })

        it('safe: password and file fields are not stored', async function() {
            let {stored} = await leavePage('<input type="password" name="pw" value="rendered-pw"><input name="visible" value="v-ok">', () => { find('[name=pw]').value = 'hunter2-pw' })
            assert.notInclude(stored, 'hunter2-pw')
            assert.notInclude(stored, 'rendered-pw')
            assert.include(stored, 'v-ok')
        })

        it('safe: with history="false" on the page nothing is stored', async function() {
            ypy.config.historyCache.disable = true
            let {stored} = await leavePage('<input name="visible" value="v-ok">')
            assert.notInclude(stored, 'v-ok')
        })
    })
})
