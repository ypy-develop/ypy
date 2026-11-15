// SPDX-License-Identifier: MIT
// TASK-009: ypy-error-target, ypy-error-swap and ypy-error-focus, ctx.errorKind, ctx.focus and
// data-ypy-state="error". The form conventions (422 and 303) are in end2end/form-422-303.js.
describe('ypy-error attributes', function () {

    const KINDS = {400: 'client', 401: 'client', 403: 'client', 404: 'client', 409: 'client', 422: 'validation',
        429: 'client', 500: 'server', 503: 'server'}
    const state = elt => elt.dataset.ypyState

    // Clicks the source element and resolves with the context of the request that ended
    async function send(elt) {
        let ctx
        document.addEventListener('ypy:finally:request', e => ctx = e.detail.ctx, {once: true})
        // a form starts its request on submit
        elt.matches('form') ? elt.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})) : elt.click()
        await forRequest()
        return ctx
    }

    function failing(status, body = '<b>failed</b>', headers) {
        mockResponse('GET', '/e', body, {status: Number(status), headers})
    }

    beforeEach(function () {
        setupTest(this.currentTest)
    })

    afterEach(function () {
        delete ypy.config.classes.error
        cleanupTest()
    })

    // ---------------------------------------------------------------------------------------
    // Criterion 1: the three attributes work and respect the precedence
    // ---------------------------------------------------------------------------------------
    describe('ypy-error-target and ypy-error-swap', function () {

        for (let [code, kind] of Object.entries(KINDS)) {
            it(`${code}: the response goes to the error target, errorKind is ${kind}`, async function () {
                failing(code)
                let btn = createProcessedHTML(`<div>
                    <button ypy-get="/e" ypy-target="#ok" ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button>
                    <div id="ok">fine</div><div id="err">old</div></div>`).querySelector('button')
                let ctx = await send(btn)
                assert.equal(find('#err').innerHTML, '<b>failed</b>')
                assert.equal(find('#ok').textContent, 'fine')
                assert.equal(ctx.errorKind, kind)
                assert.equal(state(find('#err')), 'error')
            })
        }

        it('without the attributes a non-422 error goes where the request goes', async function () {
            failing(500)
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-target="#ok" ypy-swap="innerHTML">Go</button>
                <div id="ok">fine</div></div>`).querySelector('button')
            let ctx = await send(btn)
            assert.equal(find('#ok').innerHTML, '<b>failed</b>')
            assert.equal(ctx.errorKind, 'server')
            assert.equal(ctx.focus, undefined)
        })

        it('the error target takes the same selector syntax as ypy-target', async function () {
            failing(404, '<i>none</i>')
            createProcessedHTML(`<section id="s"><button ypy-get="/e" ypy-error-target="closest section"
                ypy-error-swap="innerHTML">Go</button></section>`)
            await send(find('button'))
            assert.equal(find('#s').innerHTML, '<i>none</i>')
        })

        it('ypy-error-swap alone changes the swap, not the target', async function () {
            failing(403, '<i>no</i>')
            let btn = createProcessedHTML(`<div id="t"><button ypy-get="/e" ypy-target="#t" ypy-swap="innerHTML"
                ypy-error-swap="beforeend">Go</button></div>`).querySelector('button')
            await send(btn)
            assert.equal(find('#t').lastElementChild.outerHTML, '<i>no</i>')
            assert.equal(find('#t button').textContent, 'Go')
        })

        it('ypy-error-swap replaces a swap that carries its own target: the error goes to the error target', async function () {
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-swap="innerHTML target:#list"
                ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button><div id="list">l</div><div id="err">old</div></div>`)
                .querySelector('button')
            await send(btn)
            assert.equal(find('#err').textContent, 'x')
            assert.equal(find('#list').textContent, 'l')
        })

        it('a success is never sent to the error target', async function () {
            mockResponse('GET', '/e', '<b>fine</b>')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-target="#ok" ypy-swap="innerHTML"
                ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button><div id="ok"></div><div id="err">old</div></div>`)
                .querySelector('button')
            let ctx = await send(btn)
            assert.equal(find('#ok').innerHTML, '<b>fine</b>')
            assert.equal(find('#err').textContent, 'old')
            assert.isUndefined(ctx.errorKind)
            assert.isUndefined(state(find('#err')))
        })

        it('204 and 304 swap nothing and are not errors', async function () {
            for (let status of [204, 304]) {
                mockResponse('GET', '/e', '', {status})
                let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err">Go</button>
                    <div id="err">old</div></div>`).querySelector('button')
                let ctx = await send(btn)
                assert.equal(find('#err').textContent, 'old')
                assert.isUndefined(ctx.errorKind)
            }
        })

        it('all the spellings of the attribute work', async function () {
            for (let name of ['ypy-error-target', 'data-ypy-error-target']) {
                failing(500, 'x')
                let btn = createProcessedHTML(`<div><button ypy-get="/e" ${name}="#err" ypy-error-swap="innerHTML">Go</button>
                    <div id="err">old</div></div>`).querySelector('button')
                await send(btn)
                assert.equal(find('#err').textContent, 'x', name)
            }
        })

        it('a target that matches nothing warns and swaps nothing', async function () {
            failing(500, 'x')
            let warn = console.warn, warned = []
            console.warn = (...args) => warned.push(args[0])
            try {
                let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-target="#ok" ypy-swap="innerHTML"
                    ypy-error-target="#nope">Go</button><div id="ok">fine</div></div>`).querySelector('button')
                await send(btn)
            } finally {
                console.warn = warn
            }
            assert.equal(find('#ok').textContent, 'fine')
            assert.isTrue(warned.some(w => /#nope/.test(w)), warned.join('|'))
        })

        it('a missing error target falls back to the main target for a whole page, as any other target', async function () {
            failing(500, '<html><body><main><p>sorry</p></main></body></html>')
            let outer = createProcessedHTML(`<div><main id="m">page</main><button ypy-get="/e"
                ypy-error-target="#nope" ypy-error-swap="innerHTML">Go</button></div>`)
            let seen = []
            document.addEventListener('ypy:target:fallback', e => seen.push(e.detail.selector), {once: true})
            await send(outer.querySelector('button'))
            assert.equal(find('#m').innerHTML, '<p>sorry</p>')
            assert.deepEqual(seen, ['#nope'])
        })
    })

    // ---------------------------------------------------------------------------------------
    // Precedence: default < ypy-error-* < YPY-Retarget < ypy-status
    // ---------------------------------------------------------------------------------------
    describe('precedence', function () {

        it('ypy-status:<code> beats ypy-error-target', async function () {
            failing(404, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#a" ypy-error-swap="innerHTML"
                ypy-status:404="target:#b swap:innerHTML">Go</button><div id="a">a</div><div id="b">b</div></div>`)
                .querySelector('button')
            await send(btn)
            assert.equal(find('#a').textContent, 'a')
            assert.equal(find('#b').textContent, 'x')
        })

        it('ypy-status:4xx beats ypy-error-target for the keys it sets, the rest still applies', async function () {
            failing(409, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#a" ypy-error-swap="beforeend"
                ypy-status:4xx="target:#b">Go</button><div id="a">a</div><div id="b">b</div></div>`).querySelector('button')
            await send(btn)
            assert.equal(find('#a').textContent, 'a')
            assert.equal(find('#b').textContent, 'bx')   // swap came from ypy-error-swap
        })

        it('an exact ypy-status wins over a range when both exist', async function () {
            failing(422, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-swap="innerHTML"
                ypy-status:422="target:#exact" ypy-status:4xx="target:#range">Go</button>
                <div id="exact"></div><div id="range"></div></div>`).querySelector('button')
            await send(btn)
            assert.equal(find('#exact').textContent, 'x')
            assert.equal(find('#range').textContent, '')
        })

        it('the server wins over the attribute: YPY-Retarget and YPY-Reswap', async function () {
            failing(500, 'x', {'YPY-Retarget': '#srv', 'YPY-Reswap': 'innerHTML'})
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#attr" ypy-error-swap="beforeend">Go</button>
                <div id="attr">a</div><div id="srv">s</div></div>`).querySelector('button')
            await send(btn)
            assert.equal(find('#attr').textContent, 'a')
            assert.equal(find('#srv').textContent, 'x')
        })

        it('the attribute beats the default for a 422', async function () {
            failing(422, 'x')
            createProcessedHTML(`<form id="f"><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button></form>
                <div id="err"></div>`)
            await send(find('button'))
            assert.equal(find('#err').textContent, 'x')
            assert.equal(find('#f button').textContent, 'Go')
        })

        it('a ypy:response:error listener can still change the destination', async function () {
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#a" ypy-error-swap="innerHTML">Go</button>
                <div id="a">a</div><div id="b">b</div></div>`).querySelector('button')
            let kinds = []
            btn.addEventListener('ypy:response:error', e => { kinds.push(e.detail.ctx.errorKind); e.detail.ctx.target = '#b' }, {once: true})
            await send(btn)
            assert.deepEqual(kinds, ['server'])
            assert.equal(find('#b').textContent, 'x')
            assert.equal(find('#a').textContent, 'a')
        })
    })

    // ---------------------------------------------------------------------------------------
    // Inheritance
    // ---------------------------------------------------------------------------------------
    describe('inheritance', function () {

        it(':inherited reaches descendants', async function () {
            failing(500, 'x')
            createProcessedHTML(`<div ypy-error-target:inherited="#err" ypy-error-swap:inherited="innerHTML">
                <button ypy-get="/e" ypy-target="#ok">Go</button><div id="ok">fine</div><div id="err"></div></div>`)
            await send(find('button'))
            assert.equal(find('#err').textContent, 'x')
            assert.equal(find('#ok').textContent, 'fine')
        })

        it('a bare attribute on an ancestor is not inherited', async function () {
            failing(500, 'x')
            createProcessedHTML(`<div ypy-error-target="#err" ypy-error-swap="innerHTML">
                <button ypy-get="/e" ypy-target="#ok" ypy-swap="innerHTML">Go</button><div id="ok">fine</div><div id="err">old</div></div>`)
            await send(find('button'))
            assert.equal(find('#ok').textContent, 'x')
            assert.equal(find('#err').textContent, 'old')
        })

        it('the element value beats the inherited one', async function () {
            failing(500, 'x')
            createProcessedHTML(`<div ypy-error-target:inherited="#a" ypy-error-swap:inherited="innerHTML">
                <button ypy-get="/e" ypy-error-target="#b">Go</button><div id="a">a</div><div id="b">b</div></div>`)
            await send(find('button'))
            assert.equal(find('#a').textContent, 'a')
            assert.equal(find('#b').textContent, 'x')
        })
    })

    // ---------------------------------------------------------------------------------------
    // Criterion 3: ctx.errorKind, ctx.focus and data-ypy-state="error"
    // ---------------------------------------------------------------------------------------
    describe('error state', function () {

        it('data-ypy-state="error" is set on the error target and cleared by the next request of the source', async function () {
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button>
                <div id="err"></div></div>`).querySelector('button')
            await send(btn)
            assert.equal(state(find('#err')), 'error')
            mockResponse('GET', '/e', 'fine')
            let seen
            btn.addEventListener('ypy:before:request', () => seen = state(find('#err')), {once: true})
            await send(btn)
            assert.isUndefined(seen, 'the state is gone when the next request starts')
            assert.isUndefined(state(find('#err')))
            assert.equal(find('#err').textContent, 'x', 'the success did not touch the error target')
        })

        it('keeps the other states of the element and adds config.classes.error when set', async function () {
            ypy.config.classes.error = 'is-bad'
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button>
                <div id="err" data-ypy-state="other"></div></div>`).querySelector('button')
            await send(btn)
            assert.equal(state(find('#err')), 'other error')
            assert.isTrue(find('#err').classList.contains('is-bad'))
            mockResponse('GET', '/e', 'fine')
            await send(btn)
            assert.equal(state(find('#err')), 'other')
            assert.isFalse(find('#err').classList.contains('is-bad'))
        })

        it('survives a morph of the target and is not copied from the response', async function () {
            failing(500, '<div id="err" data-ypy-state="fake"><p>x</p></div>')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="outerMorph">Go</button>
                <div id="err"><p>old</p></div></div>`).querySelector('button')
            let err = find('#err')
            await send(btn)
            assert.equal(find('#err'), err, 'morphed in place')
            assert.equal(err.textContent, 'x')
            assert.equal(state(err), 'error')
        })

        it('without a swap (swap none) nothing is marked', async function () {
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="none">Go</button>
                <div id="err">old</div></div>`).querySelector('button')
            let ctx = await send(btn)
            assert.equal(ctx.errorKind, 'server')
            assert.isUndefined(state(find('#err')))
        })

        it('a header that takes over the response marks nothing', async function () {
            failing(500, 'x', {'YPY-Location': '{"path":"/elsewhere","target":"#land","swap":"innerHTML"}'})
            mockResponse('GET', '/elsewhere', 'landed')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button>
                <div id="err">old</div><div id="land"></div></div>`).querySelector('button')
            await send(btn)
            await ypy.timeout(30)
            assert.equal(find('#land').textContent, 'landed')
            assert.equal(find('#err').textContent, 'old')
            assert.isUndefined(state(find('#err')))
        })

        it('with no error target the target of the request is marked ', async function () {
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-target="#ok" ypy-swap="innerHTML">Go</button>
                <div id="ok"></div></div>`).querySelector('button')
            await send(btn)
            assert.equal(state(find('#ok')), 'error')
        })

        it('an error whose swap is cancelled still ends cleanly', async function () {
            failing(500, 'x')
            let btn = createProcessedHTML(`<div><button ypy-get="/e" ypy-error-target="#err" ypy-error-swap="innerHTML">Go</button>
                <div id="err">old</div></div>`).querySelector('button')
            btn.addEventListener('ypy:before:swap', e => e.preventDefault(), {once: true})
            let ctx = await send(btn)
            assert.equal(find('#err').textContent, 'old')
            assert.equal(ctx.errorKind, 'server')
        })
    })

    describe('ypy-error-focus', function () {

        const form = attrs => `<form ypy-get="/e" ${attrs}><input name="a" id="a"><input name="b" id="b">
            <button type="button" id="other">x</button></form>`

        it('a selector gives the focus to that element after the swap', async function () {
            failing(500, '<input name="a" id="a"><input name="b" id="b">')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-focus="#b"'))
            let ctx = await send(find('form'))
            assert.equal(ctx.focus, '#b')
            assert.equal(document.activeElement, find('#b'))
        })

        it('a selector can be relative to the error target', async function () {
            failing(500, '<input name="a" id="a"><input name="b" id="b">')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-focus="find #a"'))
            await send(find('form'))
            assert.equal(document.activeElement, find('#a'))
        })

        it('first-invalid focuses the first aria-invalid field', async function () {
            failing(422, '<input name="a" id="a"><input name="b" id="b" aria-invalid="true"><input name="c" id="c" aria-invalid="true">')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-swap="innerHTML" ypy-error-focus="first-invalid"'))
            await send(find('form'))
            assert.equal(document.activeElement, find('#b'))
        })

        it('first-invalid falls back to a field the browser calls invalid', async function () {
            failing(500, '<input name="a" id="a"><input name="b" id="b" required>')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-swap="innerHTML" ypy-error-focus="first-invalid"'))
            await send(find('form'))
            assert.equal(document.activeElement, find('#b'))
        })

        it('false keeps the focus where it is, and ctx.focus is false', async function () {
            failing(422, '<input name="a" id="a" aria-invalid="true">')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-swap="innerHTML" ypy-error-focus="false"'))
            find('#other').focus()
            let ctx = await send(find('form'))
            assert.isFalse(ctx.focus)
            assert.notEqual(document.activeElement, find('#a'))
        })

        it('a selector that matches nothing does nothing', async function () {
            failing(500, 'x')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-swap="innerHTML" ypy-error-focus="#nope"'))
            await send(find('form'))
            assert.equal(document.activeElement, document.body)
        })

        it('there is no focus without the attribute for an error other than 422', async function () {
            failing(500, '<input id="a">')
            createProcessedHTML(form('ypy-error-target="closest form" ypy-error-swap="innerHTML"'))
            await send(find('form'))
            assert.equal(document.activeElement, document.body)
        })
    })

    it('ctx.redirected is false for a response that was not redirected, and unset errorKind on success', async function () {
        mockResponse('GET', '/e', 'fine')
        let btn = createProcessedHTML('<button ypy-get="/e" ypy-swap="none">Go</button>')
        let ctx = await send(btn)
        assert.isFalse(ctx.redirected)
        assert.isUndefined(ctx.errorKind)
    })
})
