// SPDX-License-Identifier: MIT
// TASK-054: the Tailwind v4 variants of src/css/ypy-tailwind.css, checked against the CSS that
// Tailwind itself generated from them (test/fixtures/css/tailwind/tailwind.css). Each variant is
// asked the same question: is the element underlined? It must be when the state is on, by the
// class or by the data-ypy-state attribute, and not when it is off.
import {loadSheets, mount, cs, transitionsDone} from '/test/fixtures/css/lib.js';
import fx from '/test/fixtures/css/tailwind/fixture.js';

describe('Tailwind v4 variants', function () {

    let unload;
    const html = document.documentElement;
    const underlined = elt => cs(elt).textDecorationLine === 'underline';

    before(async function () {
        unload = await loadSheets(fx.sheets);
    });

    after(function () {
        unload();
    });

    beforeEach(function () {
        setupTest(this);
    });

    afterEach(function () {
        cleanupTest();
        html.classList.remove('ypy-offline');
        delete html.dataset.ypyState;
    });

    // ---------------------------------------------------------------------------------------
    // Element states: the class, the attribute, a list of states in the attribute
    // ---------------------------------------------------------------------------------------
    for (const state of ['request', 'swapping', 'settling', 'added', 'error', 'dirty']) {
        describe('ypy-' + state + ':', function () {

            it('is off without the state', function () {
                mount(fx.variants[state]);
                assert.isFalse(underlined(find('#v')));
            });

            it('matches the class ypy-' + state, function () {
                mount(fx.variants[state]);
                find('#v').classList.add('ypy-' + state);
                assert.isTrue(underlined(find('#v')));
            });

            it('matches data-ypy-state, alone or in a list', function () {
                mount(fx.variants[state]);
                const v = find('#v');
                v.dataset.ypyState = state;
                assert.isTrue(underlined(v), 'alone');
                v.dataset.ypyState = 'dirty ' + state + ' error';
                assert.isTrue(underlined(v), 'in a list');
            });

            it('does not match another state, nor a longer word', function () {
                mount(fx.variants[state]);
                const v = find('#v');
                v.dataset.ypyState = state === 'request' ? 'error' : 'request';
                assert.isFalse(underlined(v), 'another state');
                v.dataset.ypyState = state + 'ed';
                assert.isFalse(underlined(v), 'a longer word');
            });
        });
    }

    describe('ypy-busy:', function () {
        it('follows aria-busy="true"', function () {
            mount(fx.variants.busy);
            const v = find('#v');
            assert.isFalse(underlined(v));
            v.setAttribute('aria-busy', 'true');
            assert.isTrue(underlined(v));
            v.setAttribute('aria-busy', 'false');
            assert.isFalse(underlined(v));
        });
    });

    describe('ypy-offline:', function () {
        it('matches an element under <html> that is offline, by class or by attribute', function () {
            mount(fx.variants.offline);
            const v = find('#v');
            assert.isFalse(underlined(v));
            html.classList.add('ypy-offline');
            assert.isTrue(underlined(v), 'class');
            html.classList.remove('ypy-offline');
            assert.isFalse(underlined(v));
            html.dataset.ypyState = 'offline';
            assert.isTrue(underlined(v), 'attribute');
        });

        it('follows the real offline event of the page', function () {
            mount(fx.variants.offline);
            const v = find('#v');
            window.dispatchEvent(new Event('offline'));
            assert.isTrue(underlined(v));
            window.dispatchEvent(new Event('online'));
            assert.isFalse(underlined(v));
        });
    });

    // ---------------------------------------------------------------------------------------
    // Composition with the built-in variants of Tailwind
    // ---------------------------------------------------------------------------------------
    describe('with group-, in-, not- and breakpoints', function () {

        it('group-ypy-request: reads the state of the parent marked "group"', function () {
            mount(fx.variants.group);
            assert.isFalse(underlined(find('#v')));
            find('#g').classList.add('ypy-request');
            assert.isTrue(underlined(find('#v')));
        });

        it('in-ypy-error: reads the state of any ancestor', function () {
            mount(fx.variants.inside);
            assert.isFalse(underlined(find('#v')));
            find('#g').dataset.ypyState = 'error';
            assert.isTrue(underlined(find('#v')));
        });

        it('not-ypy-error: is the opposite', function () {
            mount(fx.variants.not);
            assert.isTrue(underlined(find('#v')));
            find('#v').dataset.ypyState = 'error';
            assert.isFalse(underlined(find('#v')));
        });

        it('sm:ypy-request: works inside a breakpoint', function () {
            mount(fx.variants.responsive);
            find('#v').classList.add('ypy-request');
            assert.equal(underlined(find('#v')), window.matchMedia('(min-width: 40rem)').matches);
        });
    });

    // ---------------------------------------------------------------------------------------
    // The states YPY really sets
    // ---------------------------------------------------------------------------------------
    describe('with a real request', function () {

        let release;

        beforeEach(function () {
            mockResponse('GET', '/slow', () => new Promise(resolve => {
                release = () => resolve(new MockResponse('Done'));
            }));
        });

        it('ypy-request: on the element that sends the request, ypy-busy: on the target', async function () {
            mount(`<button id="go" ypy-get="/slow" ypy-target="#out" class="ypy-request:underline">Go</button>
                <div id="out" class="ypy-busy:underline">Idle</div>`);
            const go = find('#go'), out = find('#out');
            assert.isFalse(underlined(go));
            assert.isFalse(underlined(out));
            go.click();
            await ypy.timeout(20);
            assert.isTrue(underlined(go), 'ypy-request: while the request runs');
            assert.isTrue(underlined(out), 'ypy-busy: while the request runs');
            release();
            assert.isNotNull(await forRequest(1000));
            await transitionsDone();
            assert.isFalse(underlined(go), 'ypy-request: after the request');
            assert.isFalse(underlined(out), 'ypy-busy: after the request');
        });

        it('ypy-swapping: on the target during the swap delay', async function () {
            mount(`<button id="go" ypy-get="/slow" ypy-target="#out" ypy-swap="innerHTML swap:200ms">Go</button>
                <div id="out" class="ypy-swapping:underline">Idle</div>`);
            find('#go').click();
            await ypy.timeout(20);
            release();
            await ypy.timeout(100);
            assert.isTrue(underlined(find('#out')));
            assert.isNotNull(await forRequest(1000));
            assert.isFalse(underlined(find('#out')));
        });
    });
});
