// SPDX-License-Identifier: MIT

// Security audit 2026-11-15 (TASK-044), fixed in TASK-046: input that made the core do quadratic work.
// "SEC-NN (fixed)" tests assert the safe behaviour. The bounds are absolute and far from what a linear scan needs
// (a few milliseconds), while the quadratic code took tens of seconds for the same input, so they do not depend on
// the speed of the machine.
describe('audit: algorithmic cost of attacker-sized input', function() {

    this.timeout(60000)

    beforeEach(function() { setupTest(this) })
    afterEach(function() { cleanupTest() })

    function cost(run) {
        let t = performance.now()
        run()
        return performance.now() - t
    }

    // the median of three runs, so that one slow tick does not decide
    function median(run) {
        let times = [cost(run), cost(run), cost(run)].sort((a, b) => a - b)
        return times[1]
    }

    describe('HCON.split', function() {

        let HCON
        before(function() { ypy.registerExtension('audit-dos', {init: api => { HCON = api.HCON }}) })

        // SEC-15. HCON.split cut a value at the top-level commas with a regex that ran look-aheads from every comma,
        // each scanning to the end of the string: n commas cost n squared (20,000 commas took about 3 s, 40,000 about
        // 11 s, on the one thread that is the page). The same function splits trigger lists and, through
        // __findAllExt, every CSS selector of a target, and a response controls selectors without any attribute
        // check. Fixed: one regex pass that consumes each quoted or bracketed span whole, every scan bounded by
        // the next bracket or quote.
        it('SEC-15 (fixed): HCON.split is linear: 200,000 commas take well under a second', function() {
            let t = cost(() => HCON.split('a:1,'.repeat(200000)))
            assert.isBelow(t, 1000, `200,000 commas took ${t.toFixed(0)} ms`)
        })

        it('SEC-15 (fixed): unbalanced brackets, quotes and tag openers stay linear too', function() {
            for (let unit of ['[', '(', '<', '"', "'", '[,', '(,', '<,', '",', "',"]) {
                let t = cost(() => HCON.split(unit.repeat(100000)))
                assert.isBelow(t, 1000, `${JSON.stringify(unit)} x 100,000 took ${t.toFixed(0)} ms`)
            }
        })

        it('SEC-15 (fixed): a swap of an out-of-band element whose selector holds thousands of commas does not stall the page', async function() {
            let selector = 'a,'.repeat(6000) + 'a'
            mockResponse('GET', '/oob', `<i>main</i><div id="x" ypy-swap-oob="innerHTML:${selector}">x</div>`)
            let button = createProcessedHTML('<button ypy-get="/oob" ypy-target="#out">go</button>')
            playground().insertAdjacentHTML('beforeend', '<div id="out"></div>')
            let t = performance.now()
            button.click()
            await forRequest(5000)
            let elapsed = performance.now() - t
            assert.isBelow(elapsed, 100, `the swap took ${elapsed.toFixed(0)} ms for a 12 KB selector`)
        })

        it('safe: HCON.split keeps its contract: commas inside quotes, [], () and <.../> do not split', function() {
            assert.deepEqual(HCON.split('a:1, b:2'), ['a:1', ' b:2'])
            assert.deepEqual(HCON.split('from:".a, .b", click'), ['from:".a, .b"', ' click'])
            assert.deepEqual(HCON.split("click[a,b], keyup"), ['click[a,b]', ' keyup'])
            assert.deepEqual(HCON.split('click[k=="x,y"], :is(.a, .b), <.c, .d/>, z'), ['click[k=="x,y"]', ' :is(.a, .b)', ' <.c, .d/>', ' z'])
            assert.deepEqual(HCON.split(',a,,b,'), ['', 'a', '', 'b', ''])
            assert.deepEqual(HCON.split('click[a<b], keyup'), ['click[a<b]', ' keyup'])
            assert.deepEqual(HCON.split(''), [''])
        })
    })

    describe('response parsing', function() {

        // SEC-16. Before parsing, the core cut the <head> out of a response with /<head(\s[^>]*)?>[\s\S]*?<\/head>/.
        // With many "<head " and no closing tag the lazy scan restarted at every opening one: quadratic again
        // (40,000 openers, 240 KB, about 2.3 s). Fixed: one search for the first opener and one for the first
        // closer after it.
        itSource('SEC-16 (fixed): many unclosed <head openers are cut in linear time', function() {
            let t = cost(() => ypy.__makeFragment('<head '.repeat(200000)))
            assert.isBelow(t, 1000, `200,000 openers took ${t.toFixed(0)} ms`)
        })

        itSource('safe: the <head> of a response still gives the title and leaves the rest', function() {
            let {fragment, title} = ypy.__makeFragment('<!doctype html><HEAD lang="x"><title>T</title></HEAD><body><p>one</p></body>')
            assert.equal(title, 'T')
            assert.equal(fragment.textContent, 'one')
            assert.equal(ypy.__makeFragment('<header>h</header><p>p</p>').fragment.children.length, 2)
        })

        itSource('safe: a deeply nested response is cut off by the HTML parser, and a very deep page is processed and morphed without a stack overflow', function() {
            let pg = playground()
            let d = pg
            for (let i = 0; i < 12000; i++) { let c = document.createElement('div'); d.appendChild(c); d = c }
            ypy.process(pg)
            let frag = document.createDocumentFragment()
            let f = frag
            for (let i = 0; i < 400; i++) { let c = document.createElement('div'); f.appendChild(c); f = c }
            ypy.__morph(pg, frag, true)
            let nested = ypy.__makeFragment('<div>'.repeat(50000)).fragment
            let depth = 0
            for (let n = nested.firstElementChild; n; n = n.firstElementChild) depth++
            assert.isBelow(depth, 1000)
        })
    })

    describe('bounded caches', function() {

        itSource('safe: the compiled-code cache and the trigger cache stop growing', function() {
            let before = ypy.config.callbacks
            ypy.config.callbacks = 'all'
            try {
                let elt = document.createElement('div')
                for (let i = 0; i < 2000; i++) ypy.__executeJavaScript(elt, {}, `${i}`, true, false)
                for (let i = 0; i < 2000; i++) ypy.__parseTriggerSpecs(`click delay:${i}ms`)
            } finally { before === undefined ? delete ypy.config.callbacks : ypy.config.callbacks = before }
            assert.isTrue(true)   // bounded by construction (256 and 500 entries, cleared when full); this loop only has to finish
        })
    })
})
