// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Trusted Types: the core creates the 'ypy' policy and every string it turns into DOM goes
// through it. Each case loads the core into an iframe whose CSP (a meta tag) sets the rules.
describe('Trusted Types', function() {

    let page
    afterEach(function() { page?.close(); page = null })

    const ENFORCE = (names) => `<meta http-equiv="Content-Security-Policy" content="require-trusted-types-for 'script'; trusted-types ${names}">`
    const ALLOW_ONLY = (names) => `<meta http-equiv="Content-Security-Policy" content="trusted-types ${names}">`

    function stubFetch(win, bodyFor) {
        win.fetch = async (url) => new win.Response(bodyFor(new URL(url, win.location.href).pathname), {status: 200, headers: {'Content-Type': 'text/html'}})
    }

    // Under enforcement a test cannot assign a string to a sink either. The markup is parsed in this
    // window, which has no CSP, and its nodes are imported into the page: no string reaches a sink there.
    function inject(page, html) {
        let body = new DOMParser().parseFromString(html, 'text/html').body
        page.doc.body.prepend(...[...body.childNodes].map(node => page.doc.importNode(node, true)))
    }

    function element(page, tag, attrs = {}, text = '') {
        let elt = page.doc.createElement(tag)
        for (let [k, v] of Object.entries(attrs)) elt.setAttribute(k, v)
        elt.textContent = text
        page.doc.body.append(elt)
        return elt
    }

    async function clickAndWait(page, selector) {
        let done = new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}))
        page.doc.querySelector(selector).click()
        await done
        await new Promise(resolve => page.win.setTimeout(resolve, 20))
    }

    describe('CSP "trusted-types ypy" with require-trusted-types-for', function() {

        beforeEach(async function() {
            page = await openPage({head: ENFORCE('ypy')})
        })

        it('creates the ypy policy: a second one with that name is refused', function() {
            assert.throws(() => page.win.trustedTypes.createPolicy('ypy', {createHTML: s => s}))
        })

        itSource('parses a response through the policy', function() {
            let doc = page.win.ypy.__parseHTML('<title>t</title><p id="p">hi</p>')
            assert.equal(doc.querySelector('#p').textContent, 'hi')
            assert.equal(doc.title, 't')
        })

        itSource('builds a fragment from a partial response and from a whole page', function() {
            let ypy = page.win.ypy
            assert.equal(ypy.__makeFragment('<b>a</b>').fragment.querySelector('b').textContent, 'a')
            assert.equal(ypy.__makeFragment('<html><head><title>T</title></head><body><i>x</i></body></html>').title, 'T')
        })

        itSource('runs a script that arrives in a response (it is re-created through the policy)', function() {
            let ypy = page.win.ypy
            let {fragment} = ypy.__makeFragment('<script>window.__ran = (window.__ran || 0) + 1</script>')
            page.doc.body.append(fragment)
            assert.equal(page.win.__ran, 1)
        })

        it('the browser refuses a plain string at an HTML sink, which is what the policy is for', function() {
            assert.throws(() => { page.doc.body.innerHTML = '<b>x</b>' })
            assert.throws(() => page.doc.createElement('div').insertAdjacentHTML('beforeend', '<b>x</b>'))
        })

        it('completes whole swaps with no sink violation', async function() {
            inject(page,
                '<button id="a" ypy-get="/a" ypy-target="#t">a</button>' +
                '<button id="b" ypy-get="/b" ypy-target="#t" ypy-swap="beforeend">b</button>' +
                '<button id="c" ypy-get="/c" ypy-target="#t" ypy-swap="outerHTML">c</button>' +
                '<button id="d" ypy-get="/d" ypy-target="#t" ypy-swap="innerMorph">d</button>' +
                '<div id="t">old</div>')
            let ypy = page.win.ypy
            stubFetch(page.win, url => ({'/a': '<p>A</p>', '/b': '<p>B</p>', '/c': '<section id="t">C</section>', '/d': '<p>M</p>'})[url] ?? '')
            ypy.process(page.doc.body)
            await clickAndWait(page, '#a')
            assert.equal(page.doc.querySelector('#t').innerHTML, '<p>A</p>')
            await clickAndWait(page, '#b')
            assert.equal(page.doc.querySelector('#t').innerHTML, '<p>A</p><p>B</p>')
            await clickAndWait(page, '#c')
            assert.equal(page.doc.querySelector('#t').outerHTML, '<section id="t">C</section>')
            await clickAndWait(page, '#d')
            assert.equal(page.doc.querySelector('#t').innerHTML, '<p>M</p>')
            assert.isFalse(page.logs.some(l => /TrustedHTML|Trusted Type/i.test(l)), page.logs.join('\n'))
        })
    })

    describe('CSP that does not list ypy (the policy is blocked)', function() {

        for (let [label, csp] of [
            ['trusted-types with other names', ENFORCE('other')],
            ['trusted-types with other names, no require-trusted-types-for', ALLOW_ONLY('other')],
            ['trusted-types none', ENFORCE("'none'")],
        ]) {
            describe(label, function() {

                beforeEach(async function() {
                    page = await openPage({head: csp})
                })

                itSource('fails closed: no response is parsed', function() {
                    assert.throws(() => page.win.ypy.__parseHTML('<b>x</b>'), /blocked by the CSP/)
                    assert.throws(() => page.win.ypy.__makeFragment('<b>x</b>'), /blocked by the CSP/)
                })

                it('a request still ends in ypy:error, and nothing is swapped in', async function() {
                    element(page, 'button', {id: 'a', 'ypy-get': '/a', 'ypy-target': '#t'}, 'a')
                    element(page, 'div', {id: 't'}, 'old')
                    stubFetch(page.win, () => '<p>NEW</p>')
                    page.win.ypy.process(page.doc.body)
                    let failed = new Promise(resolve => page.doc.addEventListener('ypy:error', resolve, {once: true}))
                    page.doc.querySelector('#a').click()
                    await failed
                    assert.equal(page.doc.querySelector('#t').textContent, 'old')
                })

                itSource('never re-creates a script, so one that was parsed stays inert', function() {
                    let script = page.doc.createElement('script')
                    let container = page.doc.createElement('div')
                    container.appendChild(script)
                    page.win.ypy.__processScripts(container)
                    assert.strictEqual(container.firstChild, script)
                })
            })
        }
    })

    describe('no Trusted Types support in the browser', function() {

        beforeEach(async function() {
            page = await openPage({head: '<script>Object.defineProperty(window, "trustedTypes", {value: undefined, configurable: true})</script>'})
        })

        itSource('uses a plain passthrough and keeps working', function() {
            assert.isUndefined(page.win.trustedTypes)
            assert.equal(page.win.ypy.__parseHTML('<p id="p">ok</p>').querySelector('#p').textContent, 'ok')
            assert.isFalse(page.logs.some(l => l.includes('Trusted Types')))
        })
    })

    describe('no CSP at all', function() {

        itSource('creates the policy without a warning and parses normally', async function() {
            page = await openPage()
            assert.equal(page.win.ypy.__parseHTML('<p id="p">ok</p>').querySelector('#p').textContent, 'ok')
            assert.isFalse(page.logs.some(l => l.includes('Trusted Types')))
        })
    })
})
