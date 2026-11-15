// SPDX-License-Identifier: MIT
// TASK-014: ypy-scroll="keep|top|restore|<px>" and __applyScrollPolicy. The policy is applied
// when the swap ends, after the scroll and show modifiers, so it wins over them. It is explicit, and the history restore (TASK-016) calls
// __applyScrollPolicy(ctx, "restore") with ctx.scrollPosition.
describe('ypy-scroll', function () {

    let realMatchMedia = window.matchMedia, realScrollTo = window.scrollTo, calls;

    beforeEach(function () {
        setupTest(this.currentTest);
        calls = [];
        scrollTo(0, 0);
    });

    afterEach(function () {
        window.matchMedia = realMatchMedia;
        window.scrollTo = realScrollTo;
        cleanupTest();
        scrollTo(0, 0);
    });

    // A long page: a scrollable box (#t, the swap target) and a spacer that makes the window scroll
    function page(attrs = '', box = true) {
        return createProcessedHTML('<div id="top" style="height:200px">top</div>' +
            '<div id="t" style="height:100px;overflow:auto"><div style="height:1000px" id="inner">old</div></div>' +
            '<div style="height:3000px">spacer</div>' +
            `<button id="b" ypy-get="/x" ypy-target="#t" ${attrs}>Go</button>`);
    }

    async function go() {
        find('#b').click();
        await forRequest();
    }

    function spyScrollTo() {
        window.scrollTo = options => calls.push(options);
    }

    function reducedMotion(on) {
        window.matchMedia = query => ({matches: on && /reduced-motion/.test(query), media: query, addEventListener() {}, removeEventListener() {}});
    }

    describe('keep', function () {
        it('puts back the window position a show modifier moved (raw swap)', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML show:top" ypy-scroll="keep"');
            scrollTo(0, 700);
            await go();
            assert.equal(scrollY, 700);
        });

        it('without keep the same swap moves the window', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML show:top"');
            scrollTo(0, 700);
            await go();
            assert.notEqual(scrollY, 700);
        });

        it('keeps the scroll of a target an outerHTML swap replaced', async function () {
            mockResponse('GET', '/x', '<div id="t" style="height:100px;overflow:auto"><div style="height:1000px">new</div></div>');
            page('ypy-swap="outerHTML" ypy-scroll="keep"');
            find('#t').scrollTo(0, 250);
            let old = find('#t');
            await go();
            assert.notStrictEqual(find('#t'), old);
            assert.equal(find('#t').scrollTop, 250);
            assert.include(find('#t').textContent, 'new');
        });

        it('without keep a replaced target starts at the top', async function () {
            mockResponse('GET', '/x', '<div id="t" style="height:100px;overflow:auto"><div style="height:1000px">new</div></div>');
            page('ypy-swap="outerHTML"');
            find('#t').scrollTo(0, 250);
            await go();
            assert.equal(find('#t').scrollTop, 0);
        });

        it('keeps scrollLeft too', async function () {
            mockResponse('GET', '/x', '<div id="t" style="width:100px;overflow:auto"><div style="width:1000px">new</div></div>');
            createProcessedHTML('<div id="t" style="width:100px;overflow:auto"><div style="width:1000px">old</div></div>' +
                '<button id="b" ypy-get="/x" ypy-target="#t" ypy-swap="outerHTML" ypy-scroll="keep">Go</button>');
            find('#t').scrollTo(300, 0);
            await go();
            assert.equal(find('#t').scrollLeft, 300);
        });

        it('keeps the position through a morph (the default swap)', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px" id="inner">changed</div>');
            page('ypy-swap="morph show:top" ypy-scroll="keep"');
            scrollTo(0, 650);
            find('#t').scrollTo(0, 120);
            await go();
            assert.equal(find('#inner').textContent, 'changed');
            assert.equal(scrollY, 650);
            assert.equal(find('#t').scrollTop, 120);
        });

        it('notes the position just before the swap, not when the request started', async function () {
            let release;
            mockResponse('GET', '/x', () => new Promise(resolve => { release = () => resolve('<div style="height:1000px">new</div>'); }));
            page('ypy-swap="innerHTML show:top" ypy-scroll="keep"');
            find('#b').click();
            await ypy.timeout(20);
            scrollTo(0, 500);   // the visitor scrolls while the request is in flight
            release();
            await forRequest();
            assert.equal(scrollY, 500);
        });

        it('wins over the scroll modifier of the swap', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML scroll:bottom" ypy-scroll="keep"');
            find('#t').scrollTo(0, 40);
            await go();
            assert.equal(find('#t').scrollTop, 40);
        });
    });

    describe('top', function () {
        it('scrolls the window and the target to the top', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML" ypy-scroll="top"');
            scrollTo(0, 800);
            find('#t').scrollTo(0, 300);
            await go();
            assert.equal(scrollY, 0);
            assert.equal(find('#t').scrollTop, 0);
        });
    });

    describe('<px>', function () {
        it('scrolls the window to the offset', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML" ypy-scroll="250"');
            await go();
            assert.equal(scrollY, 250);
        });

        it('accepts a px unit', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML" ypy-scroll="120px"');
            await go();
            assert.equal(scrollY, 120);
        });

        it('0 is the top', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML" ypy-scroll="0"');
            scrollTo(0, 500);
            await go();
            assert.equal(scrollY, 0);
        });
    });

    describe('a value that means nothing', function () {
        for (let value of ['', 'sideways', 'restore']) {
            it(`ypy-scroll="${value}" does not scroll`, async function () {
                mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
                page(`ypy-swap="innerHTML" ypy-scroll="${value}"`);
                scrollTo(0, 400);
                await go();
                assert.equal(scrollY, 400);
            });
        }
    });

    describe('restore', function () {
        it('__applyScrollPolicy moves the window to ctx.scrollPosition', function () {
            createProcessedHTML('<div style="height:3000px">spacer</div>');
            ypy.__applyScrollPolicy({scrollPosition: [0, 640]}, 'restore');
            assert.equal(scrollY, 640);
        });

        it('does nothing without a position', function () {
            createProcessedHTML('<div style="height:3000px">spacer</div>');
            scrollTo(0, 300);
            ypy.__applyScrollPolicy({}, 'restore');
            assert.equal(scrollY, 300);
        });

        it('ypy-scroll="restore" on a request without a position does nothing', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML" ypy-scroll="restore"');
            scrollTo(0, 300);
            await go();
            assert.equal(scrollY, 300);
        });

        it('ypy.ajax with scroll: "restore" and scrollPosition (as the history restore does)', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page();
            await ypy.ajax('GET', '/x', {target: '#t', swap: 'innerHTML', scroll: 'restore', scrollPosition: [0, 520]});
            assert.equal(scrollY, 520);
        });
    });

    describe('where the policy comes from', function () {
        it('ctx.scroll wins over the attribute', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML" ypy-scroll="100"');
            await ypy.ajax('GET', '/x', {source: '#b', target: '#t', swap: 'innerHTML', scroll: '300'});
            assert.equal(scrollY, 300);
        });

        it('is inherited with :inherited', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            createProcessedHTML('<section ypy-scroll:inherited="180"><div id="t"></div><div style="height:3000px"></div>' +
                '<button id="b" ypy-get="/x" ypy-target="#t" ypy-swap="innerHTML">Go</button></section>');
            await go();
            assert.equal(scrollY, 180);
        });

        it('is not inherited without :inherited', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            createProcessedHTML('<section ypy-scroll="180"><div id="t"></div><div style="height:3000px"></div>' +
                '<button id="b" ypy-get="/x" ypy-target="#t" ypy-swap="innerHTML">Go</button></section>');
            await go();
            assert.equal(scrollY, 0);
        });

        it('a swap without a policy does not touch the scroll', async function () {
            mockResponse('GET', '/x', '<div style="height:1000px">new</div>');
            page('ypy-swap="innerHTML"');
            scrollTo(0, 333);
            await go();
            assert.equal(scrollY, 333);
        });
    });

    describe('prefers-reduced-motion', function () {
        it('top and <px> scroll at once when the visitor asks for less motion', function () {
            reducedMotion(true);
            spyScrollTo();
            ypy.__applyScrollPolicy({}, 'top');
            ypy.__applyScrollPolicy({}, '90');
            assert.deepEqual(calls, [{top: 0, behavior: 'instant'}, {top: 90, behavior: 'instant'}]);
        });

        it('top and <px> follow the CSS scroll-behavior otherwise', function () {
            reducedMotion(false);
            spyScrollTo();
            ypy.__applyScrollPolicy({}, 'top');
            ypy.__applyScrollPolicy({}, '90');
            assert.deepEqual(calls, [{top: 0, behavior: 'auto'}, {top: 90, behavior: 'auto'}]);
        });

        it('keep and restore never animate', function () {
            reducedMotion(false);
            spyScrollTo();
            ypy.__applyScrollPolicy({scrollPosition: [5, 60]}, 'restore');
            ypy.__applyScrollPolicy({scrollKept: [{left: 1, top: 2}]}, 'keep');
            assert.deepEqual(calls, [{left: 5, top: 60, behavior: 'instant'}, {left: 1, top: 2, behavior: 'instant'}]);
        });

        it('the matchMedia query is not read when there is nothing to scroll', function () {
            let asked = 0;
            window.matchMedia = q => { asked++; return {matches: false}; };
            ypy.__applyScrollPolicy({}, undefined);
            ypy.__applyScrollPolicy({}, 'keep');
            ypy.__applyScrollPolicy({}, 'nonsense');
            assert.equal(asked, 0);
        });
    });
});
