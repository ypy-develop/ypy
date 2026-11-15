// SPDX-License-Identifier: MIT
// TASK-054: where the core puts each state, class and attribute (MISSION section 7, "States are also
// exposed as attributes"). The tests of the first group state what is true today; the tests whose
// title starts with "hook:" state what docs/reference/styling.md asks the core to add. They skip,
// with the reason, until the core does it, and then they start to assert.
describe('styling states', function () {

    const html = document.documentElement;
    const states = elt => (elt.dataset.ypyState || '').split(' ').filter(Boolean);
    let release;

    beforeEach(function () {
        setupTest(this);
        mockResponse('GET', '/slow', () => new Promise(resolve => {
            release = () => resolve(new MockResponse('<p id="new">Done</p>'));
        }));
    });

    afterEach(function () {
        ypy.config.classes.request = 'ypy-request';
        delete ypy.config.classes.error;
        cleanupTest();
        html.classList.remove('ypy-offline');
        delete html.dataset.ypyState;
    });

    // skips the test when what the hook adds is not in the core yet (the hook is named in the call)
    function needs(test, present, hook) {
        if (!present) {
            test.skip();
        }
    }

    describe('request', function () {

        it('is the class ypy-request on the element that sends the request', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out">Go</button><div id="out"></div>');
            const go = find('button');
            go.click();
            await ypy.timeout(20);
            assert.isTrue(go.classList.contains('ypy-request'));
            release();
            await forRequest(1000);
            assert.isFalse(go.classList.contains('ypy-request'));
        });

        it('moves to the elements of ypy-indicator, all of them', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out" ypy-indicator="#a, #b">Go</button><i id="a"></i><i id="b"></i><div id="out"></div>');
            find('button').click();
            await ypy.timeout(20);
            assert.isFalse(find('button').classList.contains('ypy-request'));
            assert.isTrue(find('#a').classList.contains('ypy-request') && find('#b').classList.contains('ypy-request'));
            release();
            await forRequest(1000);
        });

        it('has the name of config.classes.request', async function () {
            ypy.config.classes.request = 'is-loading';
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out">Go</button><div id="out"></div>');
            find('button').click();
            await ypy.timeout(20);
            assert.isTrue(find('button').classList.contains('is-loading'));
            assert.isFalse(find('button').classList.contains('ypy-request'));
            release();
            await forRequest(1000);
        });

        it('hook: is also data-ypy-state="request"', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out">Go</button><div id="out"></div>');
            find('button').click();
            await ypy.timeout(20);
            const present = states(find('button')).includes('request');
            release();
            await forRequest(1000);
            needs(this, present, '__showIndicators uses __setState');
            assert.deepEqual(states(find('button')), []);
        });
    });

    describe('swapping', function () {

        it('is the class ypy-swapping on the target, for the swap delay (ypy-swap="... swap:200ms")', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out" ypy-swap="innerHTML swap:200ms">Go</button><div id="out">Old</div>');
            find('button').click();
            await ypy.timeout(20);
            release();
            await ypy.timeout(100);
            assert.isTrue(find('#out').classList.contains('ypy-swapping'));
            await forRequest(1000);
            assert.isFalse(find('#out').classList.contains('ypy-swapping'));
            assert.equal(find('#out').textContent, 'Done');
        });

        it('hook: is also data-ypy-state="swapping"', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out" ypy-swap="innerHTML swap:200ms">Go</button><div id="out">Old</div>');
            find('button').click();
            await ypy.timeout(20);
            release();
            await ypy.timeout(100);
            const present = states(find('#out')).includes('swapping');
            await forRequest(1000);
            needs(this, present, '__insertContent uses __setState');
            assert.deepEqual(states(find('#out')), []);
        });
    });

    describe('settling and added', function () {

        it('added is the class ypy-added on the new content, from ypy:before:settle to the end of ypy:after:settle', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out" ypy-swap="beforeend">Go</button><div id="out"></div>');
            let during;
            document.addEventListener('ypy:after:settle', () => { during = find('#new')?.classList.contains('ypy-added'); }, {once: true});
            find('button').click();
            await ypy.timeout(20);
            release();
            await forRequest(1000);
            assert.isTrue(during);
            assert.isFalse(find('#new').classList.contains('ypy-added'));
        });

        it('hook: added lasts until the browser has painted, so a CSS transition can start from it', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out" ypy-swap="beforeend">Go</button><div id="out"></div>');
            let painted;
            document.addEventListener('ypy:before:settle', () => {
                requestAnimationFrame(() => { painted = find('#new')?.classList.contains('ypy-added'); });
            }, {once: true});
            find('button').click();
            await ypy.timeout(20);
            release();
            await forRequest(1000);
            await ypy.timeout(60);
            needs(this, painted, '__afterInsert waits a frame while "added" is set');
            assert.isTrue(painted);
        });

        it('settling is the class ypy-settling on the target while an element with the same id settles', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out" ypy-swap="innerHTML settle:200ms">Go</button><div id="out"><p id="new" class="a">Old</p></div>');
            find('button').click();
            await ypy.timeout(20);
            release();
            await ypy.timeout(100);
            const seen = find('#out').classList.contains('ypy-settling');
            await forRequest(1000);
            // the response has an element with the id of the old one: its attributes settle
            assert.isTrue(seen, 'the target is not marked settling');
            assert.isFalse(find('#out').classList.contains('ypy-settling'));
        });
    });

    describe('error', function () {

        it('is data-ypy-state="error" on the target of an error response, cleared by the next request', async function () {
            mockResponse('GET', '/boom', '<b>x</b>', {status: 500});
            createProcessedHTML('<button ypy-get="/boom" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest(1000);
            assert.deepEqual(states(find('#out')), ['error']);
            mockResponse('GET', '/boom', '<b>fine</b>');
            find('button').click();
            await forRequest(1000);
            assert.deepEqual(states(find('#out')), []);
        });

        it('is also a class once config.classes.error names one', async function () {
            ypy.config.classes.error = 'is-error';
            mockResponse('GET', '/boom', '<b>x</b>', {status: 500});
            createProcessedHTML('<button ypy-get="/boom" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest(1000);
            assert.isTrue(find('#out').classList.contains('is-error'));
        });

        it('hook: config.classes.error is "ypy-error" by default', async function () {
            needs(this, ypy.config.classes.error === 'ypy-error', 'config.classes.error in __initConfig');
            mockResponse('GET', '/boom', '<b>x</b>', {status: 500});
            createProcessedHTML('<button ypy-get="/boom" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest(1000);
            assert.isTrue(find('#out').classList.contains('ypy-error'));
        });
    });

    describe('offline', function () {

        it('is the class ypy-offline and data-ypy-state="offline" on <html>', function () {
            window.dispatchEvent(new Event('offline'));
            assert.isTrue(html.classList.contains('ypy-offline'));
            assert.deepEqual(states(html), ['offline']);
            window.dispatchEvent(new Event('online'));
            assert.isFalse(html.classList.contains('ypy-offline'));
            assert.deepEqual(states(html), []);
        });
    });

    describe('busy', function () {

        it('is aria-busy="true" on the target, not a class and not data-ypy-state', async function () {
            createProcessedHTML('<button ypy-get="/slow" ypy-target="#out">Go</button><div id="out"></div>');
            find('button').click();
            await ypy.timeout(20);
            assert.equal(find('#out').getAttribute('aria-busy'), 'true');
            assert.deepEqual(states(find('#out')), []);
            release();
            await forRequest(1000);
            assert.isNull(find('#out').getAttribute('aria-busy'));
        });
    });
    describe('dirty (extension ypy-signals)', function () {

        before(async function () {
            const script = document.createElement('script');
            script.src = '/src/ext/ypy-signals.js';
            await new Promise(resolve => {
                script.onload = resolve;
                document.head.appendChild(script);
            });
        });

        it('is the class ypy-dirty and data-ypy-state="dirty" on a scope with unsaved changes', async function () {
            createProcessedHTML(`<form ypy-signals="name:'a'"><input ypy-bind.live="name"></form>`);
            const form = find('form'), input = find('input');
            const tick = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
            await tick();
            assert.isFalse(form.classList.contains('ypy-dirty'));
            input.value = 'b';
            input.dispatchEvent(new Event('input', {bubbles: true}));
            await tick();
            assert.isTrue(form.classList.contains('ypy-dirty'));
            assert.deepEqual(states(form), ['dirty']);
            input.value = 'a';
            input.dispatchEvent(new Event('input', {bubbles: true}));
            await tick();
            assert.isFalse(form.classList.contains('ypy-dirty'));
            assert.deepEqual(states(form), []);
        });
    });
});
