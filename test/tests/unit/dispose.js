// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// ypy.dispose(): takes down the document and window listeners the core installed, the timers, queues and
// listeners of every processed element, and leaves the object inert.
describe('ypy.dispose()', function() {

    let page
    afterEach(function() { page?.close(); page = null })

    // counts the listeners on window, document and navigation, before the core loads
    const COUNTER = `<script>
        window.__live = new Map()
        let key = (t, type) => (t === window ? 'window' : t === document ? 'document' : t === window.navigation ? 'navigation' : null) + ':' + type
        let add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
        EventTarget.prototype.addEventListener = function(type, fn, options) {
            let k = key(this, type)
            if (!k.startsWith('null') && fn) {
                let set = window.__live.get(k) || new Set()
                set.add(fn); window.__live.set(k, set)
            }
            return add.call(this, type, fn, options)
        }
        EventTarget.prototype.removeEventListener = function(type, fn, options) {
            window.__live.get(key(this, type))?.delete(fn)
            return remove.call(this, type, fn, options)
        }
    </script>`

    let listeners = win => [...win.__live].flatMap(([k, set]) => set.size ? [k + ' x' + set.size] : []).sort()

    async function openCounted(body = '') {
        page = await openPage({head: COUNTER, body})
        return page.win
    }

    it('removes every document and window listener the core installed', async function() {
        let win = await openCounted()
        let before = listeners(win)
        assert.isAbove(before.length, 2, 'the core installed listeners: ' + before)
        assert.isTrue(before.some(l => l.startsWith('window:offline')))
        assert.isTrue(before.some(l => l.startsWith('document:ypy:before:swap')))
        assert.isTrue(before.some(l => /^(navigation:navigate|window:popstate)/.test(l)))
        win.ypy.dispose()
        assert.deepEqual(listeners(win), [])
    })

    it('removes the start-up listener too (the core loaded while the document was loading)', async function() {
        let win = await openCounted()
        assert.isTrue(listeners(win).some(l => l.startsWith('document:DOMContentLoaded')), 'it is still there: ' + listeners(win))
        win.ypy.dispose()
        assert.isFalse(listeners(win).some(l => l.startsWith('document:DOMContentLoaded')))
    })

    it('tears down the listeners, timers and queues of the processed elements', async function() {
        let win = await openCounted('<div id="poll" ypy-get="/p" ypy-trigger="every 20ms">p</div><button id="b" ypy-get="/b" ypy-sync="queue all">b</button>')
        let hits = 0
        win.fetch = async () => { hits++; return new win.Response('ok', {headers: {'Content-Type': 'text/html'}}) }
        await new Promise(resolve => win.setTimeout(resolve, 80))
        assert.isAbove(hits, 0, 'the interval ran before dispose')
        let poll = page.doc.querySelector('#poll'), b = page.doc.querySelector('#b')
        assert.isTrue(!!b._ypy)
        win.ypy.dispose()
        let after = hits
        await new Promise(resolve => win.setTimeout(resolve, 100))
        assert.equal(hits, after, 'the interval stopped')
        assert.isUndefined(poll._ypy)
        assert.isUndefined(b._ypy)
        assert.isFalse(poll.hasAttribute('data-ypy-powered'))
        b.click()
        await new Promise(resolve => win.setTimeout(resolve, 20))
        assert.equal(hits, after, 'a click no longer starts a request')
    })

    it('aborts a request in flight and drops the waiting ones', async function() {
        let win = await openCounted('<button id="b" ypy-get="/b" ypy-target="#out" ypy-sync="queue all">b</button><div id="out">old</div>')
        let started = 0, signals = []
        win.fetch = (url, init) => { started++; signals.push(init.signal); return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))) }
        let b = page.doc.querySelector('#b')
        b.click(); b.click(); b.click()
        await new Promise(resolve => win.setTimeout(resolve, 20))
        assert.equal(started, 1, 'one in flight, the others wait')
        win.ypy.dispose()
        await new Promise(resolve => win.setTimeout(resolve, 20))
        assert.isTrue(signals[0].aborted)
        assert.equal(started, 1, 'the waiting requests never started')
        assert.equal(page.doc.querySelector('#out').textContent, 'old')
    })

    it('reaches the elements processed inside open shadow roots', async function() {
        let win = await openCounted('<div id="host"></div>')
        let root = page.doc.querySelector('#host').attachShadow({mode: 'open'})
        let button = page.doc.createElement('button')
        button.setAttribute('ypy-get', '/s')
        root.append(button)
        win.ypy.process(root)
        assert.isTrue(!!button._ypy)
        win.ypy.dispose()
        assert.isUndefined(button._ypy)
    })

    it('leaves the object inert: process, initialize and ajax do nothing', async function() {
        let win = await openCounted('<div id="late"></div>')
        let hits = 0
        win.fetch = async () => { hits++; return new win.Response('x', {headers: {'Content-Type': 'text/html'}}) }
        win.ypy.dispose()
        let late = page.doc.querySelector('#late')
        late.setAttribute('ypy-get', '/late')
        win.ypy.process(late)
        win.ypy.initialize()
        await win.ypy.ajax('GET', '/x', {target: '#late'})
        assert.isUndefined(late._ypy)
        assert.equal(hits, 0)
        assert.deepEqual(listeners(win), [], 'initialize did not install the listeners again')
    })

    it('tells the extensions through the ypy_dispose hook, once', async function() {
        let win = await openCounted()
        let calls = 0
        win.ypy.registerExtension('ypy-test-dispose', {ypy_dispose: () => { calls++ }})
        win.ypy.dispose()
        win.ypy.dispose()
        assert.equal(calls, 1)
    })

    it('can be called twice', async function() {
        let win = await openCounted('<button ypy-get="/x">x</button>')
        win.ypy.dispose()
        assert.doesNotThrow(() => win.ypy.dispose())
    })
})
