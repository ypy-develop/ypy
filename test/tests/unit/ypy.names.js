// SPDX-License-Identifier: MIT
// The ypy names: attributes, events, classes and the config meta tag.
describe('ypy names', function () {

    let savedConfig;

    beforeEach(function () {
        setupTest(this);
        savedConfig = {
            classes: {...ypy.config.classes},
        };
    });

    afterEach(function () {
        Object.assign(ypy.config, savedConfig, {classes: savedConfig.classes});
        cleanupTest();
    });

    //==========================================================================
    // attributes
    //==========================================================================

    describe('attributes', function () {

        it('ypy-get issues a request', async function () {
            mockResponse('GET', '/native', 'Native');
            createProcessedHTML('<button ypy-get="/native" ypy-target="#out">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest();
            assert.equal(lastFetch().url, '/native');
            assertTextContentIs('#out', 'Native');
        });

        it('data-ypy-get issues a request', async function () {
            mockResponse('GET', '/data-native', 'Data native');
            createProcessedHTML('<button data-ypy-get="/data-native" data-ypy-target="#out">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest();
            assert.equal(lastFetch().url, '/data-native');
            assertTextContentIs('#out', 'Data native');
        });

        it('ypy-* wins over data-ypy-* when an element has both', function () {
            let elt = createDisconnectedHTML('<div data-ypy-target="#b" ypy-target="#c"></div>');
            assert.equal(ypy.__attributeValue(elt, 'ypy-target'), '#c');
            elt.removeAttribute('ypy-target');
            assert.equal(ypy.__attributeValue(elt, 'ypy-target'), '#b');
        });

        it('falls back to data-ypy-* for the attributes ypy-* does not set', async function () {
            mockResponse('GET', '/mixed', 'Mixed');
            createProcessedHTML('<button ypy-get="/mixed" data-ypy-target="#out">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest();
            assertTextContentIs('#out', 'Mixed');
        });

        it('explicit inheritance works with ypy-*:inherited', async function () {
            mockResponse('GET', '/inherit', 'Inherited');
            createProcessedHTML('<div ypy-target:inherited="#out"><button ypy-get="/inherit">Go</button></div><div id="out"></div>');
            find('button').click();
            await forRequest();
            assertTextContentIs('#out', 'Inherited');
        });

        it('explicit inheritance sees ypy-* ancestors', function () {
            let div = createProcessedHTML('<div ypy-target:inherited="#out"><button ypy-get="/x">Go</button></div>');
            assert.equal(ypy.__attributeValue(div.firstElementChild, 'ypy-target'), '#out');
        });

        it('ypy-trigger, ypy-vals and ypy-headers are read', async function () {
            mockResponse('POST', '/vals', 'ok');
            let div = createProcessedHTML(`<div ypy-post="/vals" ypy-trigger="custom" ypy-vals='{"a":"1"}' ypy-headers='{"X-Test":"yes"}'>Go</div>`);
            ypy.trigger(div, 'custom');
            await forRequest();
            let call = lastFetch();
            assert.equal(call.request.headers['X-Test'], 'yes');
            assert.equal(call.request.body.get('a'), '1');
        });

        it('ypy-swap and ypy-select are read', async function () {
            mockResponse('GET', '/sel', '<p id="keep">Keep</p><p id="drop">Drop</p>');
            createProcessedHTML('<button ypy-get="/sel" ypy-target="#out" ypy-swap="innerHTML" ypy-select="#keep">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest();
            assert.exists(find('#out #keep'));
            assert.notExists(find('#out #drop'));
        });

        it('ypy-ignore blocks processing of a subtree', function () {
            createProcessedHTML('<div ypy-ignore="true"><button ypy-get="/x">Go</button></div>');
            assert.isUndefined(find('button')._ypy);
        });

        it('ypy-boost boosts links', function () {
            createProcessedHTML('<div ypy-boost:inherited="true"><a href="/page">Link</a></div>');
            assert.isTrue(!!find('a')._ypy?.boosted);
        });

        it('ypy-on:<event> attaches a handler', function () {
            createProcessedHTML('<button ypy-on:click="window.ypyClicked = (window.ypyClicked || 0) + 1">x</button>');
            find('button').click();
            assert.equal(window.ypyClicked, 1);
            delete window.ypyClicked;
        });

        it('data-ypy-on:<event> attaches a handler', function () {
            createProcessedHTML('<button data-ypy-on:click="window.ypyClicked = (window.ypyClicked || 0) + 1">x</button>');
            find('button').click();
            assert.equal(window.ypyClicked, 1);
            delete window.ypyClicked;
        });

        it('ypy-on::<event> listens to ypy:<event> and fires once per trigger', function () {
            createProcessedHTML('<button ypy-on::my-event="window.ypyCount = (window.ypyCount || 0) + 1">x</button>');
            ypy.trigger(find('button'), 'ypy:my-event');
            assert.equal(window.ypyCount, 1);
            delete window.ypyCount;
        });

        it('ypy-swap-oob in a response swaps out of band', async function () {
            mockResponse('GET', '/oob', '<div>Main</div><div id="side" ypy-swap-oob="true">Side</div>');
            createProcessedHTML('<button ypy-get="/oob">Go</button><div id="side">Old</div>');
            find('button').click();
            await forRequest();
            assertTextContentIs('#side', 'Side');
        });

        it('data-ypy-swap-oob in a response swaps out of band', async function () {
            mockResponse('GET', '/oob', '<div>Main</div><div id="side" data-ypy-swap-oob="true">Side</div>');
            createProcessedHTML('<button ypy-get="/oob">Go</button><div id="side">Old</div>');
            find('button').click();
            await forRequest();
            assertTextContentIs('#side', 'Side');
        });

        it('ypy-preserve keeps an element through a swap', async function () {
            mockResponse('GET', '/pres', '<input id="inp" ypy-preserve="true" value="server">');
            createProcessedHTML('<div id="host"><button ypy-get="/pres" ypy-target="#host" ypy-swap="innerHTML">Go</button><input id="inp" ypy-preserve="true" value="client"></div>');
            let input = find('#inp');
            input.value = 'typed';
            find('button').click();
            await forRequest();
            assert.strictEqual(find('#inp'), input);
            assert.equal(find('#inp').value, 'typed');
        });

        it('morph reinitialises an element whose ypy-* attribute changed', function () {
            let div = createProcessedHTML('<div ypy-get="/a">x</div>');
            let source = createDisconnectedHTML('<div ypy-get="/b">x</div>');
            ypy.__copyAttributes(div, source);
            assert.equal(div.getAttribute('ypy-get'), '/b');
            assert.isUndefined(div._ypy);
        });
    });

    //==========================================================================
    // partials
    //==========================================================================

    describe('partials', function () {

        it('<ypy-partial> swaps into its target', async function () {
            mockResponse('GET', '/partial', '<div>Main</div><ypy-partial ypy-target="#side">Partial</ypy-partial>');
            createProcessedHTML('<button ypy-get="/partial" ypy-target="#main">Go</button><div id="main"></div><div id="side"></div>');
            find('button').click();
            await forRequest();
            assertTextContentIs('#side', 'Partial');
            assertTextContentIs('#main', 'Main');
        });

        it('<ypy-partial> accepts data-ypy-target', async function () {
            mockResponse('GET', '/partial', '<ypy-partial data-ypy-target="#a">A</ypy-partial>');
            createProcessedHTML('<button ypy-get="/partial" ypy-target="#main">Go</button><div id="main"></div><div id="a"></div>');
            find('button').click();
            await forRequest();
            assertTextContentIs('#a', 'A');
        });
    });

    //==========================================================================
    // events
    //==========================================================================

    describe('events', function () {

        it('dispatches ypy:* events for the lifecycle points', async function () {
            let seen = [];
            let onBefore = () => seen.push('before');
            let onAfter = () => seen.push('after');
            document.addEventListener('ypy:before:request', onBefore);
            document.addEventListener('ypy:after:swap', onAfter);
            try {
                mockResponse('GET', '/ev', 'ok');
                createProcessedHTML('<button ypy-get="/ev">Go</button>');
                find('button').click();
                await forRequest();
            } finally {
                document.removeEventListener('ypy:before:request', onBefore);
                document.removeEventListener('ypy:after:swap', onAfter);
            }
            assert.deepEqual(seen, ['before', 'after']);
        });

        it('a listener fires once per event', async function () {
            let count = 0;
            let onSwap = () => count++;
            document.addEventListener('ypy:after:swap', onSwap);
            try {
                mockResponse('GET', '/ev', 'ok');
                createProcessedHTML('<button ypy-get="/ev">Go</button>');
                find('button').click();
                await forRequest();
            } finally {
                document.removeEventListener('ypy:after:swap', onSwap);
            }
            assert.equal(count, 1);
        });

        it('ypy.on listens to a ypy:* event', async function () {
            let count = 0;
            let h = ypy.on('ypy:after:request', () => count++);
            try {
                mockResponse('GET', '/ev', 'ok');
                createProcessedHTML('<button ypy-get="/ev">Go</button>');
                find('button').click();
                await forRequest();
            } finally {
                document.removeEventListener('ypy:after:request', h);
            }
            assert.equal(count, 1);
        });

        it('cancelling ypy:config:request cancels the request', async function () {
            let h = e => e.preventDefault();
            document.addEventListener('ypy:config:request', h);
            try {
                mockResponse('GET', '/cancel', 'ok');
                createProcessedHTML('<button ypy-get="/cancel">Go</button>');
                find('button').click();
                await ypy.timeout(50);
                assert.notExists(fetchMock.getLastCall());
            } finally {
                document.removeEventListener('ypy:config:request', h);
            }
        });

        it('trigger dispatches the event under the name it is given only', function () {
            let seen = [];
            let h1 = () => seen.push('first');
            let h2 = () => seen.push('second');
            document.addEventListener('ypy:custom-evt', h1);
            document.addEventListener('ypy:other-evt', h2);
            try {
                ypy.trigger(document.body, 'ypy:custom-evt');
                assert.deepEqual(seen, ['first']);
            } finally {
                document.removeEventListener('ypy:custom-evt', h1);
                document.removeEventListener('ypy:other-evt', h2);
            }
        });

        it('trigger leaves names outside the ypy family alone', function () {
            let count = 0;
            let h = () => count++;
            document.addEventListener('plain-evt', h);
            try {
                ypy.trigger(document.body, 'plain-evt');
            } finally {
                document.removeEventListener('plain-evt', h);
            }
            assert.equal(count, 1);
        });

        it('ypy:abort aborts an in-flight request', async function () {
            let div = createProcessedHTML('<div ypy-get="/test" ypy-swap="none"></div>');
            let ctx = ypy.__createRequestContext(div, new Event('click'));
            ctx.fetch = (url, opts) => new Promise((_, reject) => {
                setTimeout(() => ypy.trigger(div, 'ypy:abort'), 10);
                opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            });
            await ypy.__issueRequest(ctx);
            assert.isTrue(ctx.request.signal.aborted);
        });

        it('extension hooks named ypy_* run', async function () {
            let calls = [];
            let backup = backupExtensions();
            clearExtensions();
            try {
                ypy.registerExtension('names-test', {
                    ypy_before_request: () => calls.push('ypy_'),
                });
                mockResponse('GET', '/ext', 'ok');
                createProcessedHTML('<button ypy-get="/ext">Go</button>');
                find('button').click();
                await forRequest();
            } finally {
                restoreExtensions(backup);
            }
            assert.deepEqual(calls, ['ypy_']);
        });
    });

    //==========================================================================
    // classes
    //==========================================================================

    describe('state classes', function () {

        it('applies the request class by default', async function () {
            let during;
            let h = e => { during = [...e.target.classList]; };
            document.addEventListener('ypy:before:request', h);
            try {
                mockResponse('GET', '/cls', 'ok');
                createProcessedHTML('<button ypy-get="/cls">Go</button>');
                find('button').click();
                await forRequest();
            } finally {
                document.removeEventListener('ypy:before:request', h);
            }
            assert.include(during, 'ypy-request');
            assert.isFalse(find('button').classList.contains('ypy-request'));
        });

        it('applies the swapping, settling, added and request classes', function () {
            let elt = createDisconnectedHTML('<div></div>');
            for (let state of ['swapping', 'settling', 'added', 'request']) {
                ypy.__addClass(elt, state);
                assert.isTrue(elt.classList.contains('ypy-' + state), state);
                ypy.__removeClass(elt, state);
                assert.equal(elt.classList.length, 0);
            }
        });

        it('config.classes replaces the class names for one state', async function () {
            ypy.config.classes.request = 'is-loading';
            let during;
            let h = e => { during = [...e.target.classList]; };
            document.addEventListener('ypy:before:request', h);
            try {
                mockResponse('GET', '/cls', 'ok');
                createProcessedHTML('<button ypy-get="/cls">Go</button>');
                find('button').click();
                await forRequest();
            } finally {
                document.removeEventListener('ypy:before:request', h);
            }
            assert.deepEqual(during, ['is-loading']);
            assert.equal(find('button').classList.length, 0);
        });

        it('config.classes accepts several space separated names and an empty value', function () {
            let elt = createDisconnectedHTML('<div></div>');
            ypy.config.classes.added = 'one two';
            ypy.__addClass(elt, 'added');
            assert.deepEqual([...elt.classList], ['one', 'two']);
            ypy.__removeClass(elt, 'added');
            ypy.config.classes.added = '';
            ypy.__addClass(elt, 'added');
            assert.equal(elt.classList.length, 0);
        });

        it('the indicator stylesheet covers every configured class', function () {
            ypy.config.classes.request = 'busy';
            ypy.config.classes.indicator = 'spinner';
            let previous = ypy.indicatorStyleSheet;
            ypy.__initRequestIndicatorCss();
            let css = [...ypy.indicatorStyleSheet.cssRules].map(r => r.cssText).join(' ');
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== ypy.indicatorStyleSheet);
            ypy.indicatorStyleSheet = previous;
            assert.include(css, '.spinner');
            assert.include(css, '.busy');
        });

        it('the default indicator stylesheet shows the indicator class during a request', function () {
            let css = [...ypy.indicatorStyleSheet.cssRules].map(r => r.cssText).join(' ');
            assert.include(css, '.ypy-indicator');
            assert.include(css, '.ypy-request');
        });
    });

    //==========================================================================
    // config meta
    //==========================================================================

    describe('config meta', function () {

        it('the ypy-config meta tag is read by a fresh instance', function () {
            let Ctor = Object.getPrototypeOf(ypy).constructor;
            let meta = document.createElement('meta');
            meta.name = 'ypy-config';
            meta.content = '{"defaultTimeout":1234}';
            document.head.prepend(meta);   // the config is read from the first meta of that name
            try {
                let instance = new Ctor();
                assert.equal(instance.config.defaultTimeout, 1234);
            } finally {
                meta.remove();
            }
        });
    });
});
