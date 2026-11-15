// SPDX-License-Identifier: MIT

// Security audit 2026-11-15 (TASK-044): checks that came out CORRECT. They pass, and they must keep passing:
// each one is an attack that does not work.
describe('audit: verified safe', function() {

    let HCON
    before(function() { ypy.registerExtension('audit-safe', {init: api => { HCON = api.HCON }}) })
    beforeEach(function() { setupTest(this, {authorCode: false}); window.__pwn = 0 })
    afterEach(function() { delete window.__pwn; cleanupTest() })

    const KEYS = ['__proto__', 'constructor', 'prototype']
    const clean = () => {
        for (let k of ['polluted', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) assert.isUndefined({}[k], 'Object.prototype.' + k)
    }

    describe('prototype pollution', function() {

        it('the HCON parser and merge never write __proto__, constructor or prototype', function() {
            for (let text of [
                '__proto__.p1:1', 'a.__proto__.p2:1', 'constructor.prototype.p3:1', '"__proto__":{"p4":1}',
                '{"__proto__":{"p5":1}}', '{"constructor":{"prototype":{"p6":1}}}', 'a:<__proto__.p7:1/>', "'__proto__.polluted':1"]) {
                let target = {a: {b: 1}}
                HCON.merge(text, target)
                HCON.merge(HCON.parse(text), {})
                clean()
                for (let k of KEYS) assert.isFalse(Object.prototype.hasOwnProperty.call(target, k) && target[k] !== Object.prototype, text)
            }
        })

        it('attributes that carry these keys do not pollute through vals, config, swap, trigger or headers', async function() {
            mockResponse('GET', '/x', '<i>ok</i>')
            let button = createProcessedHTML(
                `<button ypy-get="/x" ypy-vals='{"__proto__":{"p1":1},"constructor":{"prototype":{"p2":1}}}' ` +
                `ypy-config='__proto__.p3:1 constructor.prototype.p4:1' ` +
                `ypy-swap="innerHTML __proto__.p5:1" ypy-trigger="click __proto__.p6:1" ` +
                `ypy-headers='{"__proto__":{"p7":1}}'>x</button>`)
            button.click()
            await forRequest()
            await ypy.timeout(20)
            clean()
        })

        it('the options of ypy.ajax cannot reach Object.prototype either', async function() {
            mockResponse('GET', '/x', '<i>ok</i>')
            let options = JSON.parse('{"request":{"__proto__":{"polluted":1}},"headers":{"__proto__":{"p1":1}},"__proto__":{"p2":1}}')
            let target = playground().appendChild(document.createElement('div'))
            await ypy.ajax('GET', '/x', {...options, target})
            clean()
        })
    })

    describe('configuration', function() {

        it('a meta tag swapped into the body is not read as configuration', function() {
            let before = ypy.config.mode
            createProcessedHTML('<meta name="ypy-config" content=\'mode:"cors",callbacks:"all"\'>')
            assert.equal(ypy.config.mode, before)
        })

        itSource('an unknown callbacks value counts as none', function() {
            for (let value of ['yes', true, 1, 'ALL', ' all', 'nonce ', null]) {
                ypy.config.callbacks = value
                assert.equal(ypy.__callbacksPolicy(), 'none', String(value))
            }
            delete ypy.config.callbacks
        })
    })

    describe('swap content', function() {

        async function swap(html) {
            mockResponse('GET', '/x', html)
            let button = createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">go</button>')
            playground().insertAdjacentHTML('beforeend', '<div id="out"></div>')
            button.click()
            await forRequest()
            await ypy.timeout(20)
            return find('#out')
        }

        it('with callbacks "none" an injected ypy-on and a js: value compile nothing and fire ypy:security:blocked', async function() {
            let blocked = 0
            let count = () => blocked++
            document.addEventListener('ypy:security:blocked', count)
            try {
                let out = await swap('<b id="b" ypy-on:click="window.__pwn = 1">b</b><i id="i" ypy-get="/y" ypy-vals="js:{a: window.__pwn = 2}">i</i>')
                out.querySelector('#b').click()
                out.querySelector('#i').click()
                await ypy.timeout(40)
                assert.equal(window.__pwn, 0)
                assert.isAtLeast(blocked, 2)
            } finally { document.removeEventListener('ypy:security:blocked', count) }
        })

        it('SVG, MathML, template and srcdoc content is inserted as plain markup: nothing runs without an event or a navigation', async function() {
            let out = await swap(
                '<svg><a href="javascript:window.__pwn=3"><text>x</text></a></svg>' +
                '<math href="javascript:window.__pwn=4"></math><template id="t"><script>window.__pwn=5</script></template>' +
                '<iframe id="f" srcdoc="&lt;script&gt;parent.__pwn=6&lt;/script&gt;" sandbox></iframe>' +
                '<a id="a" href="data:text/html,x">a</a>')
            await ypy.timeout(60)
            assert.equal(window.__pwn, 0)
            assert.isNotNull(out.querySelector('template#t'))
        })
    })

    describe('requests', function() {

        it('every request carries same-origin mode, whatever a boost value, ypy-config or the options of ajax say', async function() {
            mockResponse('GET', '/x', 'ok')
            mockResponse('POST', '/x', 'ok')
            let boosted = createProcessedHTML(`<form ypy-boost='request.mode:"no-cors"' ypy-target="this" action="/x" method="post"><button>go</button></form>`)
            boosted.requestSubmit()
            await forRequest()
            let configured = createProcessedHTML(`<button ypy-get="/x" ypy-config='mode:"no-cors"'>x</button>`)
            configured.click()
            await forRequest()
            let target = playground().appendChild(document.createElement('div'))
            await ypy.ajax('GET', '/x', {target, request: {mode: 'no-cors'}})
            assert.isAtLeast(fetchMock.calls.length, 3)
            for (let call of fetchMock.calls) assert.equal(call.request.mode, 'same-origin', call.url)
        })
    })

    describe('leaks', function() {

        it('a swap that replaces an element removes the document listeners of its triggers', async function() {
            let adds = 0, removes = 0
            let add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document)
            document.addEventListener = (name, ...rest) => { if (name === 'audit-custom') adds++; return add(name, ...rest) }
            document.removeEventListener = (name, ...rest) => { if (name === 'audit-custom') removes++; return remove(name, ...rest) }
            try {
                let html = '<button id="b" ypy-get="/x" ypy-trigger="audit-custom from:document" ypy-target="#box" ypy-swap="innerHTML">x</button>'
                playground().innerHTML = `<div id="box">${html}</div>`
                ypy.process(playground())
                mockResponse('GET', '/x', html)
                for (let i = 0; i < 10; i++) {
                    document.dispatchEvent(new CustomEvent('audit-custom'))
                    await forRequest(100)
                    await ypy.timeout(5)
                }
            } finally { document.addEventListener = add; document.removeEventListener = remove }
            assert.equal(adds - removes, 1, `${adds} added, ${removes} removed: only the live element keeps one`)
        })
    })

    describe('history', function() {

        it('pushState with a URL of another origin is refused by the browser, not by the library', function() {
            assert.throws(() => history.pushState({ypy: true}, '', 'https://other.example/x'))
        })
    })
})
