// SPDX-License-Identifier: MIT
// TASK-011: when a target selector matches nothing, fall back to the main target
// ([ypy-main], then <main>).
describe('ypy-main target fallback', function () {

    const PAGE = '<html><head><title>Next</title></head><body><header>new head</header>' +
        '<main><p id="new">new content</p></main></body></html>';
    let warnings, seen, listeners;

    function listen(name) {
        let handler = e => seen.push({name, detail: e.detail, cancel: handler.cancel && e.preventDefault()});
        listeners.push([name, handler]);
        document.addEventListener(name, handler);
        return handler;
    }

    function setup() {
        setupTest(this.currentTest);
        warnings = [];
        seen = [];
        listeners = [];
        this._warn = console.warn;
        console.warn = (...args) => warnings.push(args);
    }

    function teardown() {
        console.warn = this._warn;
        for (let [name, handler] of listeners) document.removeEventListener(name, handler);
        delete ypy.config.targetFallback;
        cleanupTest();
    }

    // the page: a button that asks for `/p` with a target that does not exist, and a main
    function page(attrs = '', mainAttr = '', before = '') {
        return createProcessedHTML(`<div>${before}<button id="b" ypy-get="/p" ${attrs}>go</button>` +
            `<main ${mainAttr} id="m"><i>old</i></main></div>`);
    }

    async function go() {
        find('#b').click();
        await forRequest();
    }

    function main() {
        return find('#m');
    }

    function missingWarnings() {
        return warnings.filter(w => String(w[0]).includes('did not match') || String(w[0]).includes('no element for'));
    }

    describe('a target that matches nothing', function () {
        beforeEach(function () { setup.call(this); });
        afterEach(function () { teardown.call(this); });

        it('falls back to <main> when the response is a whole page', async function () {
            mockResponse('GET', '/p', PAGE);
            let fallback = listen('ypy:target:fallback');
            page('ypy-target="#nope"');
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');
            assert.equal(find('header'), null, 'only the main of the response is used');
            assert.equal(seen.length, 1);
            assert.equal(seen[0].detail.selector, '#nope');
            assert.equal(seen[0].detail.used, 'main');
            assert.equal(seen[0].detail.ctx.fallback, 'main');
            assert.equal(missingWarnings().length, 0, 'no warning when the fallback served');
        });

        it('prefers [ypy-main] over <main> on the current page', async function () {
            mockResponse('GET', '/p', PAGE);
            listen('ypy:target:fallback');
            let root = page('ypy-target="#nope"', '', '');
            root.insertAdjacentHTML('afterbegin', '<section id="s" ypy-main><b>old s</b></section>');
            // a second <main> comes first in document order; [ypy-main] still wins
            await go();
            assert.equal(find('#s').innerHTML, '<p id="new">new content</p>');
            assert.equal(main().innerHTML, '<i>old</i>');
            assert.equal(seen[0].detail.used, '[ypy-main]');
        });

        it('accepts data-ypy-main and ypy-main as the marker', async function () {
            mockResponse('GET', '/p', PAGE);
            let root = page('ypy-target="#nope"');
            main().remove();
            root.insertAdjacentHTML('beforeend', '<div id="m" data-ypy-main>old</div>');
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');

            mockResponse('GET', '/p', PAGE);
            main().innerHTML = 'old';
            main().removeAttribute('data-ypy-main');
            main().setAttribute('ypy-main', '');
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');
        });

        it('prefers the [ypy-main] of the response over its <main>', async function () {
            mockResponse('GET', '/p', '<html><body><main>wrong</main><div ypy-main>right</div></body></html>');
            page('ypy-target="#nope"');
            await go();
            assert.equal(main().innerHTML, 'right');
        });

        it('swaps the body of a whole page that has no main into the current main', async function () {
            mockResponse('GET', '/p', '<html><body><p id="only">body only</p></body></html>');
            page('ypy-target="#nope"');
            await go();
            assert.equal(main().innerHTML, '<p id="only">body only</p>');
        });

        it('falls back for a fragment that holds a <main>', async function () {
            mockResponse('GET', '/p', '<h1>x</h1><main>from main</main>');
            page('ypy-target="#nope"');
            await go();
            assert.equal(main().innerHTML, 'from main');
        });

        it('never swaps a plain fragment over the main, and reports the target missing', async function () {
            mockResponse('GET', '/p', '<p id="small">small</p>');
            listen('ypy:target:fallback');
            listen('ypy:target:missing');
            let btn = page('ypy-target="#nope"').querySelector('#b');
            await go();
            assert.equal(main().innerHTML, '<i>old</i>');
            assert.equal(btn.innerHTML, 'go', 'the source element is not swapped either');
            assert.deepEqual(seen.map(s => s.name), ['ypy:target:missing']);
            assert.equal(seen[0].detail.selector, '#nope');
            assert.equal(seen[0].detail.ctx.sourceElement, btn);
            assert.equal(missingWarnings().length, 1);
            assert.include(String(missingWarnings()[0][0]), '#nope');
            assert.equal(missingWarnings()[0][1].ctx, seen[0].detail.ctx, 'the warning carries the context');
        });

        it('a listener can cancel ypy:target:missing to silence the warning', async function () {
            mockResponse('GET', '/p', '<p>small</p>');
            listen('ypy:target:missing').cancel = true;
            page('ypy-target="#nope"');
            await go();
            assert.equal(missingWarnings().length, 0);
        });

        it('reports missing when the page has no main at all', async function () {
            mockResponse('GET', '/p', PAGE);
            listen('ypy:target:missing');
            let root = page('ypy-target="#nope"');
            main().remove();
            await go();
            assert.equal(seen.length, 1);
            assert.equal(root.querySelector('p#new'), null);
        });

        it('ypy-fallback="always" also swaps a fragment into the main', async function () {
            mockResponse('GET', '/p', '<p id="small">small</p>');
            listen('ypy:target:fallback');
            page('ypy-target="#nope" ypy-fallback="always"');
            await go();
            assert.equal(main().innerHTML, '<p id="small">small</p>');
            assert.equal(seen.length, 1);
        });

        it('ypy-fallback="false" turns the fallback off, also for a whole page', async function () {
            mockResponse('GET', '/p', PAGE);
            listen('ypy:target:fallback');
            listen('ypy:target:missing');
            page('ypy-target="#nope" ypy-fallback="false"');
            await go();
            assert.equal(main().innerHTML, '<i>old</i>');
            assert.deepEqual(seen.map(s => s.name), ['ypy:target:missing']);
        });

        it('ypy-fallback="true" is the default (whole pages only)', async function () {
            mockResponse('GET', '/p', '<p>small</p>');
            page('ypy-target="#nope" ypy-fallback="true"');
            await go();
            assert.equal(main().innerHTML, '<i>old</i>');
        });

        it('works with the data-ypy- and ypy- spellings of the attribute', async function () {
            mockResponse('GET', '/p', '<p id="small">small</p>');
            page('ypy-target="#nope" data-ypy-fallback="always"');
            await go();
            assert.equal(main().innerHTML, '<p id="small">small</p>');
            main().innerHTML = '<i>old</i>';
            find('#b').removeAttribute('data-ypy-fallback');
            find('#b').setAttribute('ypy-fallback', 'always');
            mockResponse('GET', '/p', '<p id="small2">small</p>');
            await go();
            assert.equal(main().innerHTML, '<p id="small2">small</p>');
        });

        it('config.targetFallback turns it off, or on for fragments', async function () {
            mockResponse('GET', '/p', PAGE);
            listen('ypy:target:missing');
            ypy.config.targetFallback = false;
            page('ypy-target="#nope"');
            await go();
            assert.equal(main().innerHTML, '<i>old</i>');
            assert.equal(seen.length, 1);

            ypy.config.targetFallback = 'always';
            mockResponse('GET', '/p', '<p id="frag">f</p>');
            await go();
            assert.equal(main().innerHTML, '<p id="frag">f</p>');
        });

        it('the attribute overrides the config', async function () {
            ypy.config.targetFallback = false;
            mockResponse('GET', '/p', PAGE);
            page('ypy-target="#nope" ypy-fallback="true"');
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');
        });

        it('uses the main selector of ypy-swap target: too', async function () {
            mockResponse('GET', '/p', PAGE);
            page('ypy-swap="innerHTML target:#nope"');
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');
        });

        it('applies to the target of YPY-Retarget', async function () {
            mockResponse('GET', '/p', PAGE, {headers: {'YPY-Retarget': '#gone'}});
            page();
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');
        });

        it('follows an inherited ypy-target', async function () {
            mockResponse('GET', '/p', PAGE);
            createProcessedHTML('<div ypy-target:inherited="#nope"><button id="b" ypy-get="/p">go</button>' +
                '<main id="m"><i>old</i></main></div>');
            await go();
            assert.equal(main().innerHTML, '<p id="new">new content</p>');
        });

        it('follows an inherited ypy-fallback', async function () {
            mockResponse('GET', '/p', '<p id="small">small</p>');
            createProcessedHTML('<div ypy-fallback:inherited="always"><button id="b" ypy-get="/p" ypy-target="#nope">go</button>' +
                '<main id="m"><i>old</i></main></div>');
            await go();
            assert.equal(main().innerHTML, '<p id="small">small</p>');
        });

        it('swaps the main element itself for an outer style', async function () {
            mockResponse('GET', '/p', '<html><body><main class="fresh" id="m">new</main></body></html>');
            page('ypy-target="#nope" ypy-swap="outerHTML"');
            await go();
            assert.equal(document.querySelectorAll('main').length, 1);
            assert.equal(main().className, 'fresh');
            assert.equal(main().textContent, 'new');
        });

        it('does not turn a whole page without main into an outer swap of the main', async function () {
            mockResponse('GET', '/p', '<html><body><p>body only</p></body></html>');
            listen('ypy:target:missing');
            page('ypy-target="#nope" ypy-swap="outerHTML"');
            await go();
            assert.equal(main().innerHTML, '<i>old</i>');
            assert.equal(seen.length, 1);
        });

        it('keeps ypy-select: the selected content goes into the main', async function () {
            mockResponse('GET', '/p', '<html><body><div id="part">selected</div><main>other</main></body></html>');
            page('ypy-target="#nope" ypy-select="#part"');
            await go();
            assert.equal(main().innerHTML, '<div id="part">selected</div>');
        });

        it('keeps the swap style and the morph of an inner swap', async function () {
            mockResponse('GET', '/p', '<html><body><main><p id="new">m</p></main></body></html>');
            page('ypy-target="#nope" ypy-swap="beforeend"');
            await go();
            assert.equal(main().innerHTML, '<i>old</i><p id="new">m</p>');
        });

        it('does not warn at request time when the fallback serves', async function () {
            let mock = mockSequentialResponses('GET', '/p', PAGE);
            page('ypy-target="#nope"');
            find('#b').click();
            await ypy.timeout(20);
            assert.equal(missingWarnings().length, 0);
            await mock.next();
            await forRequest();
            assert.equal(missingWarnings().length, 0);
        });

        it('sets ctx.targetSelector, ctx.target stays undefined', async function () {
            mockResponse('GET', '/p', PAGE);
            page('ypy-target="#nope"');
            let ctx;
            document.addEventListener('ypy:before:request', e => ctx = e.detail.ctx, {once: true});
            await go();
            assert.equal(ctx.target, undefined);
            assert.equal(ctx.targetSelector, '#nope');
            assert.notInclude(Object.keys(lastFetch().request.headers), 'YPY-Target');
        });

        it('a request without target selector is unchanged', async function () {
            mockResponse('GET', '/p', '<p>x</p>');
            listen('ypy:target:fallback');
            listen('ypy:target:missing');
            page('ypy-target="#m"');
            await go();
            assert.equal(main().innerHTML, '<p>x</p>');
            assert.equal(seen.length, 0);
        });

        it('an out-of-band task without a target is reported and never falls back', function () {
            listen('ypy:target:missing');
            let root = page();
            let fragment = document.createDocumentFragment();
            fragment.append('oob text');
            let ctx = {};
            ypy.__insertContent({type: 'oob', fragment, target: '#nowhere', ctx, swapSpec: {style: 'innerHTML'},
                sourceElement: find('#b')});
            assert.equal(main().innerHTML, '<i>old</i>');
            assert.equal(seen.length, 1);
            assert.equal(seen[0].detail.selector, '#nowhere');
            assert.equal(seen[0].detail.ctx, ctx);
            assert.equal(seen[0].detail.task.type, 'oob');
            assert.equal(missingWarnings().length, 1);
        });

        it('a task can name its selector when the target is null', function () {
            listen('ypy:target:missing');
            page();
            ypy.__insertContent({type: 'partial', fragment: document.createDocumentFragment(), target: null,
                selector: '#p1', swapSpec: {style: 'innerHTML'}, sourceElement: find('#b')});
            assert.equal(seen[0].detail.selector, '#p1');
        });

        it('a partial whose target is missing is reported and does not touch the main', async function () {
            mockResponse('GET', '/p', '<ypy-partial ypy-target="#lost">lost</ypy-partial>');
            listen('ypy:target:missing');
            page('ypy-target="#m"');
            await go();
            assert.equal(main().innerHTML, '<i>old</i>');
            // Reported once, while the swap tasks are built (TASK-012 contract:
            // detail {ctx, selector, type}); no task is created for the lost item.
            assert.equal(seen.length, 1);
            assert.equal(seen[0].detail.type, 'partial');
            assert.equal(seen[0].detail.selector, '#lost');
        });

        it('ajax() still rejects a missing target', async function () {
            mockResponse('GET', '/p', PAGE);
            page();
            try {
                await ypy.ajax('GET', '/p', '#nope');
                assert.fail('should have rejected');
            } catch (e) {
                assert.include(e.message, 'Target not found');
            }
        });
    });

    describe('fallback mode', function () {
        beforeEach(function () { setup.call(this); });
        afterEach(function () { teardown.call(this); });

        it('is on, unless set', function () {
            let elt = createProcessedHTML('<div></div>');
            assert.equal(ypy.__fallbackMode(elt), 'true');
            ypy.config.targetFallback = 'always';
            assert.equal(ypy.__fallbackMode(elt), 'always');
            ypy.config.targetFallback = true;
            assert.equal(ypy.__fallbackMode(elt), 'true');
            ypy.config.targetFallback = false;
            assert.equal(ypy.__fallbackMode(elt), 'false', 'with the fallback off the target is still managed');
        });

        it('a bare ypy-fallback attribute means on', function () {
            let elt = createProcessedHTML('<div ypy-fallback></div>');
            assert.equal(ypy.__fallbackMode(elt), 'true');
        });
    });
});
