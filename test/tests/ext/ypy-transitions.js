// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

describe('ypy-transitions extension', function() {

    let page
    afterEach(function() { page?.close(); page = null })

    const BODY = '<button id="b" ypy-get="/r" ypy-target="#out" ypy-swap="innerHTML transition:true">go</button><div id="out">old</div>'

    async function click(page) {
        page.win.fetch = async () => new page.win.Response('new', {status: 200, headers: {'Content-Type': 'text/html'}})
        let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
        page.doc.querySelector('#b').click()
        await done
        await new Promise(resolve => page.win.setTimeout(resolve, 30))
    }

    it('runs the swap inside document.startViewTransition and fires the events', async function() {
        page = await openPage({body: BODY, scripts: ['/src/ypy.js', '/src/ext/ypy-transitions.js']})
        let started = 0, events = []
        let real = page.doc.startViewTransition
        if (!real) this.skip()
        page.doc.startViewTransition = update => { started++; return real.call(page.doc, update) }
        for (let name of ['before', 'after']) page.doc.addEventListener(`ypy:${name}:viewTransition`, () => events.push(name))
        await click(page)
        assert.equal(page.doc.querySelector('#out').textContent, 'new')
        assert.equal(started, 1)
        assert.deepEqual(events, ['before', 'after'])
    })

    it('swaps without a transition when the browser prefers reduced motion', async function() {
        page = await openPage({body: BODY, scripts: ['/src/ypy.js', '/src/ext/ypy-transitions.js']})
        let started = 0
        page.doc.startViewTransition = () => { started++ }
        page.win.matchMedia = query => ({matches: /reduce/.test(query)})
        await click(page)
        assert.equal(page.doc.querySelector('#out').textContent, 'new')
        assert.equal(started, 0)
    })

    it('without the extension the swap still happens, at once and with no transition', async function() {
        page = await openPage({body: BODY})
        let started = 0
        page.doc.startViewTransition = () => { started++ }
        await click(page)
        assert.equal(page.doc.querySelector('#out').textContent, 'new')
        assert.equal(started, 0)
    })

    it('a task that throws does not stop the queue', async function() {
        page = await openPage({body: BODY, scripts: ['/src/ypy.js', '/src/ext/ypy-transitions.js']})
        page.doc.addEventListener('ypy:before:viewTransition', e => { e.detail.task = async () => { throw new Error('aborted') } }, {once: true})
        await click(page)
        await click(page)
        assert.equal(page.doc.querySelector('#out').textContent, 'new')
    })
})
