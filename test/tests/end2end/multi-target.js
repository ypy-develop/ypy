// SPDX-License-Identifier: MIT
// One response, several targets: the main swap, ypy-select-oob, ypy-swap-oob and partials.
describe('multiple targets in one response', function () {

    const PAGE = `
        <button id="btn" ypy-get="/multi" ypy-target="#main" ypy-select-oob="#sel1:innerHTML">Go</button>
        <div id="main">Main</div>
        <div id="sel1">sel1 old</div>
        <div id="oob1">oob1 old</div>
        <div id="p1">p1 old</div><div id="p2">p2 old</div><div id="p3">p3 old</div>`

    const RESPONSE = `
        <span>Main new</span>
        <div id="sel1">sel1 new</div>
        <div id="oob1" ypy-swap-oob="innerHTML">oob1 new</div>
        <ypy-partial ypy-target="#p1">p1 new</ypy-partial>
        <ypy-partial ypy-target="#p2">p2 new</ypy-partial>
        <ypy-partial id="p3">p3 new</ypy-partial>`

    // records the events of one request, and the elements the DOM changed, in order
    function record() {
        let events = [], effects = []
        let names = ['ypy:before:swap', 'ypy:after:swap', 'ypy:finally:swap', 'ypy:finally:request',
            'ypy:error', 'ypy:swap:error', 'ypy:target:missing']
        let detail = {}
        let handlers = names.map(n => {
            let h = e => { events.push(n); (detail[n] ??= []).push(e.detail) }
            document.addEventListener(n, h)
            return [n, h]
        })
        // the element that owns each change: morph swaps change text nodes in place
        const owner = r => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.id
        let mo = new MutationObserver(records => records.forEach(r => effects.push(owner(r))))
        mo.observe(playground(), {childList: true, characterData: true, subtree: true})
        return {
            events, effects, detail,
            stop() {
                effects.push(...mo.takeRecords().map(owner))
                mo.disconnect()
                handlers.forEach(([n, h]) => document.removeEventListener(n, h))
            }
        }
    }

    async function run(response, page = PAGE) {
        setupTest(null)
        mockResponse('GET', '/multi', response)
        createProcessedHTML(page)
        let rec = record()
        find('#btn').click()
        await forRequest(2000)   // a view transition can take longer than the default wait
        await ypy.timeout(20)
        rec.stop()
        return rec
    }

    afterEach(function () {
        cleanupTest()
    })

    describe('several items in one response', function () {

        it('swaps the main content, ypy-select-oob, ypy-swap-oob and three partials', async function () {
            let rec = await run(RESPONSE)
            find('#main').textContent.trim().should.equal('Main new')
            find('#sel1').textContent.should.equal('sel1 new')
            find('#oob1').textContent.should.equal('oob1 new')
            find('#p1').textContent.should.equal('p1 new')
            find('#p2').textContent.should.equal('p2 new')
            find('#p3').textContent.should.equal('p3 new')
            rec.events.should.deep.equal(['ypy:before:swap', 'ypy:after:swap', 'ypy:finally:swap', 'ypy:finally:request'])
        })

        it('lists the tasks: main, ypy-select-oob, ypy-swap-oob, then partials in document order', async function () {
            let rec = await run(RESPONSE)
            let tasks = rec.detail['ypy:before:swap'][0].tasks
            tasks.map(t => t.type).should.deep.equal(['main', 'oob', 'oob', 'partial', 'partial', 'partial'])
            tasks.map(t => t.target.id).should.deep.equal(['main', 'sel1', 'oob1', 'p1', 'p2', 'p3'])
        })

        it('gives every task the documented shape', async function () {
            let rec = await run(RESPONSE)
            for (let task of rec.detail['ypy:before:swap'][0].tasks) {
                task.fragment.nodeType.should.equal(11)
                task.swapSpec.style.should.be.a('string')
                task.sourceElement.should.equal(find('#btn'))
                assert.exists(task.target)
            }
        })

        it('changes the DOM in the order of the list', async function () {
            let rec = await run(RESPONSE)
            // one entry per element, in order (a morph records several changes per element)
            rec.effects.filter(id => id).filter((id, i, a) => id !== a[i - 1]).should.deep.equal(['main', 'sel1', 'oob1', 'p1', 'p2', 'p3'])
        })

        it('does not drop the main swap when only one partial is in the response', async function () {
            await run('<ypy-partial ypy-target="#p1">only</ypy-partial>')
            find('#p1').textContent.should.equal('only')
            find('#main').textContent.should.equal('Main')
        })

        it('swaps the same partial into several targets', async function () {
            await run('<ypy-partial ypy-target=".many">x</ypy-partial>',
                '<button id="btn" ypy-get="/multi">Go</button><p class="many">1</p><p class="many">2</p>')
            ;[...playground().querySelectorAll('.many')].map(e => e.textContent).should.deep.equal(['x', 'x'])
        })
    })

    describe('a target that is missing', function () {

        it('fires ypy:target:missing for the partial and swaps the other items', async function () {
            let rec = await run(`<span>Main new</span>
                <ypy-partial ypy-target="#nope">lost</ypy-partial>
                <ypy-partial ypy-target="#p2">p2 new</ypy-partial>`)
            let missing = rec.detail['ypy:target:missing']
            missing.length.should.equal(1)
            missing[0].selector.should.equal('#nope')
            missing[0].type.should.equal('partial')
            missing[0].ctx.should.exist
            find('#main').textContent.trim().should.equal('Main new')
            find('#p2').textContent.should.equal('p2 new')
            rec.events.should.include('ypy:after:swap')
            rec.events.should.include('ypy:finally:request')
            rec.events.should.not.include('ypy:swap:error')
        })

        it('fires ypy:target:missing for an out-of-band element', async function () {
            let rec = await run(`<span>Main new</span>
                <div id="ghost" ypy-swap-oob="innerHTML">lost</div>
                <div id="oob1" ypy-swap-oob="innerHTML">oob1 new</div>`)
            rec.detail['ypy:target:missing'].map(d => [d.type, d.selector]).should.deep.equal([['oob', '#ghost']])
            find('#oob1').textContent.should.equal('oob1 new')
            find('#main').textContent.trim().should.equal('Main new')
        })

        it('fires it once per partial and per item, in document order, with a selector for an out-of-band target', async function () {
            let rec = await run(`
                <ypy-partial ypy-target="#a">1</ypy-partial>
                <div ypy-swap-oob="innerHTML:#b">2</div>
                <ypy-partial ypy-target=".c">3</ypy-partial>
                <ypy-partial>no target at all</ypy-partial>`)
            rec.detail['ypy:target:missing'].map(d => d.selector).should.deep.equal(['#b', '#a', '.c', ''])
        })

        it('does not swap an empty main content over the target when the only partial misses', async function () {
            let rec = await run('<ypy-partial ypy-target="#nope">lost</ypy-partial>')
            find('#main').textContent.should.equal('Main')
            rec.detail['ypy:target:missing'].length.should.equal(1)
        })

        it('keeps the main content when a lone out-of-band element misses, even with allowEmptySwapAfterOOB', async function () {
            let saved = ypy.config.allowEmptySwapAfterOOB
            ypy.config.allowEmptySwapAfterOOB = true
            try {
                await run('<div id="ghost" ypy-swap-oob="innerHTML">lost</div>')
                find('#main').textContent.should.equal('Main')
            } finally {
                ypy.config.allowEmptySwapAfterOOB = saved
            }
        })

        it('lists the misses in ctx.missingTargets', async function () {
            let rec = await run('<ypy-partial ypy-target="#nope">lost</ypy-partial>')
            rec.detail['ypy:before:swap'][0].ctx.missingTargets.should.deep.equal([{type: 'partial', selector: '#nope'}])
        })

        it('fires on the element the request started from', async function () {
            setupTest(null)
            mockResponse('GET', '/multi', '<ypy-partial ypy-target="#nope">lost</ypy-partial>')
            createProcessedHTML(PAGE)
            let onButton = 0
            find('#btn').addEventListener('ypy:target:missing', () => onButton++)
            find('#btn').click()
            await forRequest()
            onButton.should.equal(1)
        })
    })

    describe('an item that fails', function () {

        const FAILING = `<span>Main new</span>
            <ypy-partial ypy-target="#p1" ypy-swap="nonsense">boom</ypy-partial>
            <ypy-partial ypy-target="#p2">p2 new</ypy-partial>
            <div id="oob1" ypy-swap-oob="innerHTML">oob1 new</div>
            <ypy-partial ypy-target="#p3">p3 new</ypy-partial>`

        it('lets the other items finish', async function () {
            await run(FAILING)
            find('#main').textContent.trim().should.equal('Main new')
            find('#oob1').textContent.should.equal('oob1 new')
            find('#p2').textContent.should.equal('p2 new')
            find('#p3').textContent.should.equal('p3 new')
            find('#p1').textContent.should.equal('p1 old')
        })

        it('fires ypy:swap:error with the task and the error, then the final events', async function () {
            let rec = await run(FAILING)
            let errors = rec.detail['ypy:swap:error']
            errors.length.should.equal(1)
            errors[0].task.type.should.equal('partial')
            errors[0].task.target.should.equal(find('#p1'))
            errors[0].error.message.should.contain('Unknown swap style')
            errors[0].ctx.should.exist
            rec.events.should.deep.equal(['ypy:before:swap', 'ypy:swap:error', 'ypy:error', 'ypy:after:swap', 'ypy:finally:swap', 'ypy:finally:request'])
        })

        it('still fires ypy:error, once, with the first error', async function () {
            let rec = await run(FAILING.replace('ypy-target="#p3"', 'ypy-target="#p3" ypy-swap="other"'))
            rec.detail['ypy:swap:error'].length.should.equal(2)
            rec.detail['ypy:error'].length.should.equal(1)
            rec.detail['ypy:error'][0].error.should.equal(rec.detail['ypy:swap:error'][0].error)
        })

        it('keeps going when the failing item is inside a view transition', async function () {
            let rec = await run(`<span>Main new</span>
                <ypy-partial ypy-target="#p1" ypy-swap="nonsense transition:true">boom</ypy-partial>
                <ypy-partial ypy-target="#p2" ypy-swap="innerHTML transition:true">p2 new</ypy-partial>
                <ypy-partial ypy-target="#p3">p3 new</ypy-partial>`)
            rec.detail['ypy:swap:error'].length.should.equal(1)
            find('#p2').textContent.should.equal('p2 new')
            find('#p3').textContent.should.equal('p3 new')
            rec.events.should.include('ypy:after:swap')
        })

        it('marks the main swap failure the same way', async function () {
            let rec = await run('<span>x</span><ypy-partial ypy-target="#p1">p1 new</ypy-partial>',
                PAGE.replace('ypy-target="#main"', 'ypy-target="#main" ypy-swap="nonsense"'))
            rec.detail['ypy:swap:error'][0].task.type.should.equal('main')
            find('#p1').textContent.should.equal('p1 new')
            rec.events.should.include('ypy:after:swap')
        })

        it('leaves the "swapping" class off the elements that were swapped', async function () {
            await run(FAILING)
            playground().querySelectorAll('.ypy-swapping').length.should.equal(0)
        })
    })
})
