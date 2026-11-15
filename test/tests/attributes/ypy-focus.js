// SPDX-License-Identifier: MIT
// TASK-014: ypy-focus. After a boosted request the focus goes to the main heading of the new
// content (ypy-focus="auto", the default). Other swaps
// leave the focus where the swap left it. Values: auto, none, first-heading, a selector.
describe('ypy-focus', function () {

    const NEXT = '<main><h1>Next page</h1><p>text</p></main>';

    afterEach(function () {
        cleanupTest();
        if (document.activeElement !== document.body) document.activeElement.blur();
    });

    // A page with a <main> inside a region the boosted link swaps. `attrs` go on the link.
    function page(attrs = '', before = '') {
        return createProcessedHTML(`<div id="box">${before}<main id="m"><h1 id="old">Old page</h1></main></div>` +
            `<a id="a" href="/next" ypy-boost="true" ypy-target="#box" ypy-push-url="false" ${attrs}>Go</a>`);
    }

    async function go(selector = '#a') {
        find(selector).click();
        await forRequest();
    }

    function active() {
        return document.activeElement;
    }

    describe('after a swap', function () {
        beforeEach(function () { setupTest(this.currentTest); });

        it('a boosted navigation focuses the h1 of the new main', async function () {
            mockResponse('GET', '/next', NEXT);
            page();
            await go();
            assert.equal(active().tagName, 'H1');
            assert.equal(active().textContent, 'Next page');
        });

        it('ypy-focus="auto" asks for the default', async function () {
            mockResponse('GET', '/next', NEXT);
            page('ypy-focus="auto"');
            await go();
            assert.equal(active().tagName, 'H1');
        });

        it('the temporary tabindex is there while the heading has the focus and gone after it blurs', async function () {
            mockResponse('GET', '/next', NEXT);
            page();
            await go();
            assert.equal(active().getAttribute('tabindex'), '-1');
            let h1 = active();
            h1.blur();
            assert.isFalse(h1.hasAttribute('tabindex'));
        });

        it('a tabindex the author wrote is kept', async function () {
            mockResponse('GET', '/next', '<main><h1 tabindex="-1">Next page</h1></main>');
            page();
            await go();
            let h1 = active();
            assert.equal(h1.tagName, 'H1');
            h1.blur();
            assert.equal(h1.getAttribute('tabindex'), '-1');
        });

        it('focuses the main itself when it holds no h1', async function () {
            mockResponse('GET', '/next', '<main id="nm"><p>text</p></main>');
            page();
            await go();
            assert.equal(active().id, 'nm');
            assert.equal(active().getAttribute('tabindex'), '-1');
        });

        it('prefers [ypy-main] over <main>', async function () {
            mockResponse('GET', '/next', '<section ypy-main><h1>In the marked region</h1></section>');
            createProcessedHTML('<div id="box"><section id="s" ypy-main><h1>Old</h1></section></div>' +
                '<a id="a" href="/next" ypy-boost="true" ypy-target="#box" ypy-push-url="false">Go</a>');
            await go();
            assert.equal(active().textContent, 'In the marked region');
        });

        it('focuses the swap target when the page has no main', async function () {
            mockResponse('GET', '/next', '<p>no main here</p>');
            createProcessedHTML('<div id="box"><p>old</p></div>' +
                '<a id="a" href="/next" ypy-boost="true" ypy-target="#box" ypy-push-url="false">Go</a>');
            await go();
            assert.equal(active().id, 'box');
            assert.equal(active().getAttribute('tabindex'), '-1');
            active().blur();
            assert.isFalse(find('#box').hasAttribute('tabindex'));
        });

        itSource('does not touch a focus that is already on the heading', async function () {
            mockResponse('GET', '/next', '<main><h1 id="same">Next page</h1></main>');
            page();
            await go();
            let h1 = active();
            assert.equal(h1.tagName, 'H1');
            let ctx = {sourceElement: find('#a')};
            ypy.__applyFocus(ctx, find('#box'));
            assert.equal(active(), h1);
            assert.isUndefined(ctx.focused, 'nothing moved, so nothing replaces the announcement');
        });

        it('a swap that is not a navigation leaves the focus alone', async function () {
            mockResponse('GET', '/part', '<main><h1>Part</h1></main>');
            createProcessedHTML('<div id="t"><main><h1>Old</h1></main></div><button id="b" ypy-get="/part" ypy-target="#t">Go</button>');
            find('#b').focus();
            await go('#b');
            assert.equal(active().id, 'b');
        });

        it('ypy-focus="none" keeps the focus out of a boosted navigation', async function () {
            mockResponse('GET', '/next', NEXT);
            page('ypy-focus="none"');
            await go();
            assert.equal(active(), document.body);
        });

        it('ypy-focus="none" is inherited with :inherited', async function () {
            mockResponse('GET', '/next', NEXT);
            createProcessedHTML('<nav ypy-focus:inherited="none"><a id="a" href="/next" ypy-boost="true" ypy-target="#box" ypy-push-url="false">Go</a></nav>' +
                '<div id="box"><main><h1>Old</h1></main></div>');
            await go();
            assert.equal(active(), document.body);
        });

        it('does not take the focus from an [autofocus] field that asks for it with ypy-focus', async function () {
            mockResponse('GET', '/next', '<main><h1>Sign in</h1><input id="user" autofocus ypy-focus></main>');
            page();
            await go();
            assert.equal(active().id, 'user');
            assert.isFalse(active().hasAttribute('tabindex'));
        });

        it('does not focus an [autofocus] field of the new content by itself: the heading gets the focus', async function () {
            mockResponse('GET', '/next', '<main><h1>Sign in</h1><input id="user" autofocus></main>');
            page();
            await go();
            assert.equal(active().tagName, 'H1');
        });

        it('config.autofocus focuses the [autofocus] field', async function () {
            ypy.config.autofocus = true;
            try {
                mockResponse('GET', '/next', '<main><h1>Sign in</h1><input id="user" autofocus></main>');
                page();
                await go();
                assert.equal(active().id, 'user');
            } finally {
                delete ypy.config.autofocus;
            }
        });

        it('ypy-focus="none" on an [autofocus] field leaves it alone', async function () {
            mockResponse('GET', '/part', '<input id="user" autofocus ypy-focus="none">');
            createProcessedHTML('<div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t">Go</button>');
            await go('#b');
            assert.notEqual(active().id, 'user');
        });

        it('a selector focuses that element on any swap, with a temporary tabindex', async function () {
            mockResponse('GET', '/part', '<p>updated</p><div id="msg">Saved</div>');
            createProcessedHTML('<div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="#msg">Go</button>');
            await go('#b');
            assert.equal(active().id, 'msg');
            assert.equal(active().getAttribute('tabindex'), '-1');
            active().blur();
            assert.isNull(find('#msg').getAttribute('tabindex'));
        });

        it('a selector of a field focuses the field without touching its tabindex', async function () {
            mockResponse('GET', '/part', '<input id="f">');
            createProcessedHTML('<div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="#f">Go</button>');
            await go('#b');
            assert.equal(active().id, 'f');
            assert.isFalse(active().hasAttribute('tabindex'));
        });

        it('a selector can use the extended syntax, relative to the source element', async function () {
            mockResponse('GET', '/part', '<p>updated</p>');
            createProcessedHTML('<section><div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="closest section">Go</button></section>');
            await go('#b');
            assert.equal(active().tagName, 'SECTION');
        });

        it('a selector that matches nothing does nothing', async function () {
            mockResponse('GET', '/part', '<p>updated</p>');
            createProcessedHTML('<div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="#nope">Go</button>');
            find('#b').focus();
            await go('#b');
            assert.equal(active().id, 'b');
        });

        it('first-heading focuses the first heading of the swap target', async function () {
            mockResponse('GET', '/part', '<p>intro</p><h3 id="h">Section</h3><h2>Later</h2>');
            createProcessedHTML('<h1 id="top">Page</h1><div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="first-heading">Go</button>');
            await go('#b');
            assert.equal(active().id, 'h');
        });

        it('first-heading finds nothing in a target without headings', async function () {
            mockResponse('GET', '/part', '<p>no heading</p>');
            createProcessedHTML('<h1>Page</h1><div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="first-heading">Go</button>');
            find('#b').focus();
            await go('#b');
            assert.equal(active().id, 'b');
        });

        it('first-heading is the main heading after a navigation too', async function () {
            mockResponse('GET', '/next', '<main><p>x</p><h2 id="h2">Two</h2></main>');
            page('ypy-focus="first-heading"');
            await go();
            assert.equal(active().id, 'h2');
        });

        it('ctx.focus from the request wins over the attribute', async function () {
            mockResponse('GET', '/part', '<p>updated</p><div id="msg">Saved</div>');
            createProcessedHTML('<div id="t"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="none">Go</button>');
            let set = e => { e.detail.ctx.focus = '#msg'; };
            document.addEventListener('ypy:before:swap', set);
            try { await go('#b'); } finally { document.removeEventListener('ypy:before:swap', set); }
            assert.equal(active().id, 'msg');
        });

        it('ctx.focus = false leaves the focus alone on a boosted navigation', async function () {
            mockResponse('GET', '/next', NEXT);
            page();
            let set = e => { e.detail.ctx.focus = false; };
            document.addEventListener('ypy:before:swap', set);
            try { await go(); } finally { document.removeEventListener('ypy:before:swap', set); }
            assert.equal(active(), document.body);
        });

        it('ypy.ajax accepts focus as an option', async function () {
            mockResponse('GET', '/part', '<p>updated</p><div id="msg">Saved</div>');
            createProcessedHTML('<div id="t"></div>');
            await ypy.ajax('GET', '/part', {target: '#t', focus: '#msg'});
            assert.equal(active().id, 'msg');
        });

        it('the focus never scrolls the page', async function () {
            mockResponse('GET', '/part', '<div id="msg">Saved</div>');
            createProcessedHTML('<div id="t"></div><div id="spacer" style="height:3000px"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-focus="#msg">Go</button>');
            let y = scrollY;
            await go('#b');
            assert.equal(active().id, 'msg');
            assert.equal(scrollY, y);
        });

        it('the focus given back by the swap is kept for a swap that is not a navigation', async function () {
            mockResponse('GET', '/part', '<input id="i" value="hello world">');
            createProcessedHTML('<div id="t"><input id="i" value="hello world"></div><button id="b" ypy-get="/part" ypy-target="#t" ypy-swap="innerHTML">Go</button>');
            let input = find('#i');
            input.focus();
            input.setSelectionRange(2, 7);
            await go('#b');
            assert.equal(active().id, 'i');
            assert.equal(active().selectionStart, 2);
            assert.equal(active().selectionEnd, 7);
        });

        it('a boosted navigation moves the focus after the swap gave it back', async function () {
            mockResponse('GET', '/next', '<main><h1>Next page</h1><input id="i"></main>');
            createProcessedHTML('<div id="box"><main><input id="i"></main></div><a id="a" href="/next" ypy-boost="true" ypy-target="#box" ypy-push-url="false">Go</a>');
            find('#i').focus();
            await go();
            assert.equal(active().tagName, 'H1');
        });
    });
});
