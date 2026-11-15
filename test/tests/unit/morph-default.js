// SPDX-License-Identifier: MIT
// TASK-007: morph is the default swap; the live state of an element (an open details or
// dialog) survives a morph.
describe('Morph as the default swap', function() {

    afterEach(function() {
        cleanupTest();
    });

    // a swap through the document body would replace the page of the test runner, so a
    // playground element stands in for it while one synchronous call runs
    function asBody(elt, fn) {
        Object.defineProperty(document, 'body', {configurable: true, get: () => elt});
        try {
            return fn();
        } finally {
            delete document.body;
        }
    }

    function fragmentOf(html) {
        let template = document.createElement('template');
        template.innerHTML = html;
        return template.content;
    }

    describe('the style that nobody wrote', function() {
        beforeEach(function() { setupTest(this); });

        it('is innerMorph, marked as the default', function() {
            let spec = ypy.__parseSwapSpec('');
            assert.equal(spec.style, 'innerMorph');
            assert.equal(spec.default, true);
            assert.equal(ypy.__parseSwapSpec(ypy.config.defaultSwap).style, 'innerMorph');
        });

        it('keeps modifiers when only modifiers are written', function() {
            let spec = ypy.__parseSwapSpec('swap:100ms');
            assert.equal(spec.style, 'innerMorph');
            assert.equal(spec.swap, '100ms');
            assert.equal(spec.default, true);
        });

        it('is not the default when a style is written', function() {
            for (let style of ['innerHTML', 'outerHTML', 'outerSync', 'innerMorph', 'outerMorph', 'beforeend']) {
                let spec = ypy.__parseSwapSpec(style);
                assert.equal(spec.style, style);
                assert.isUndefined(spec.default, style);
            }
        });

        it('reads "morph" as innerMorph', function() {
            assert.equal(ypy.__parseSwapSpec('morph').style, 'innerMorph');
            assert.equal(ypy.__parseSwapSpec('morph swap:10ms').swap, '10ms');
        });

        it('gives way to a configured default', function() {
            ypy.config.defaultSwap = 'innerHTML';
            let spec = ypy.__parseSwapSpec('');
            assert.equal(spec.style, 'innerHTML');
            assert.isUndefined(spec.default);
            ypy.config.defaultSwap = DEFAULT_SWAP;
            assert.equal(ypy.__parseSwapSpec('').style, 'innerMorph');
        });

        it('gives way to a default assigned with Object.assign, as the config meta tag does', function() {
            Object.assign(ypy.config, {defaultSwap: 'outerHTML'});
            assert.equal(ypy.config.defaultSwap, 'outerHTML');
            assert.equal(ypy.__parseSwapSpec('').style, 'outerHTML');
        });

        it('makes an out of band element morph its twin', function() {
            assert.equal(ypy.__parseSwapSpec(ypy.__defaultOOBSwap()).style, 'outerMorph');
            assert.equal(ypy.__parseSwapSpec(ypy.__defaultOOBSwap()).default, true);
        });

        it('reaches the main swap of a request', async function() {
            mockResponse('GET', '/t', '<p id="keep" class="new">new</p>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box">go</button><div id="box"><p id="keep">old</p></div></div>');
            let kept = find('#keep');
            find('#b').click();
            await forRequest();
            assert.equal(find('#keep'), kept, 'the node with the id is reused');
            assert.equal(kept.className, 'new');
            assert.equal(kept.textContent, 'new');
        });

        it('reaches a partial that gives no style', async function() {
            mockResponse('GET', '/t', '<ypy-partial ypy-target="#box"><p id="keep" class="new">new</p></ypy-partial>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box2">go</button><div id="box2"></div><div id="box"><p id="keep">old</p></div></div>');
            let kept = find('#keep');
            find('#b').click();
            await forRequest();
            assert.equal(find('#keep'), kept);
            assert.equal(kept.className, 'new');
        });

        it('keeps an element written with innerHTML raw', async function() {
            mockResponse('GET', '/t', '<p id="keep">new</p>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box" ypy-swap="innerHTML">go</button><div id="box"><p id="keep">old</p></div></div>');
            let old = find('#keep');
            find('#b').click();
            await forRequest();
            assert.notEqual(find('#keep'), old, 'the node was replaced');
            assert.equal(find('#keep').textContent, 'new');
        });

        it('keeps an element written with outerHTML raw', async function() {
            mockResponse('GET', '/t', '<div id="box"><p id="keep">new</p></div>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box" ypy-swap="outerHTML">go</button><div id="box"><p id="keep">old</p></div></div>');
            let old = find('#keep');
            find('#b').click();
            await forRequest();
            assert.notEqual(find('#keep'), old);
        });

        it('keeps the ypy-swap spelling raw too', async function() {
            mockResponse('GET', '/t', '<p id="keep">new</p>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box" ypy-swap="innerHTML">go</button><div id="box"><p id="keep">old</p></div></div>');
            let old = find('#keep');
            find('#b').click();
            await forRequest();
            assert.notEqual(find('#keep'), old);
        });

        it('replaces the page when the default style meets the body', function() {
            let pg = createProcessedHTML('<div id="page"><input id="field" value="a"></div>');
            let field = find('#field');
            field.value = 'typed on the old page';
            asBody(pg, () => ypy.__applySwapStyle(pg, 'innerMorph', {style: 'innerMorph', default: true},
                fragmentOf('<input id="field" value="a">'), pg.parentNode));
            assert.notEqual(find('#field'), field, 'a new page does not reuse the old fields');
            assert.equal(find('#field').value, 'a');
        });

        it('morphs the body when the style was written', function() {
            let pg = createProcessedHTML('<div id="page"><input id="field" value="a"></div>');
            let field = find('#field');
            field.value = 'typed';
            asBody(pg, () => ypy.__applySwapStyle(pg, 'innerMorph', {style: 'innerMorph'},
                fragmentOf('<input id="field" value="a" class="x">'), pg.parentNode));
            assert.equal(find('#field'), field);
            assert.equal(field.value, 'typed');
        });

        it('restores the focus after the page was replaced', function() {
            let pg = createProcessedHTML('<div id="page"><input id="field" value="a"></div>');
            find('#field').focus();
            asBody(pg, () => ypy.__applySwapStyle(pg, 'innerMorph', {style: 'innerMorph', default: true},
                fragmentOf('<input id="field" value="b">'), pg.parentNode));
            // __insertContent captures and restores around the style; the style does it itself here
            assert.equal(document.activeElement, find('#field'));
        });
    });

    describe('the focus across a morph', function() {
        beforeEach(function() { setupTest(this); });

        it('is captured for the morph styles', function() {
            createProcessedHTML('<div id="box"><input id="field"></div>');
            find('#field').focus();
            assert.equal(ypy.__captureFocus('innerMorph', playground()).elt, find('#field'));
            assert.equal(ypy.__captureFocus('outerMorph', playground()).elt, find('#field'));
        });

        it('is given back when the node lost it', async function() {
            createProcessedHTML('<div id="box"><input id="field" value="abc"></div>');
            let input = find('#field');
            input.focus();
            input.setSelectionRange(1, 2);
            let info = ypy.__captureFocus('innerMorph', playground());
            input.blur();
            ypy.__restoreFocus(info, {});
            assert.equal(document.activeElement, input);
            assert.equal(input.selectionStart, 1);
            assert.equal(input.selectionEnd, 2);
        });
    });

    describe('live state', function() {
        beforeEach(function() { setupTest(this); });

        async function morph(html) {
            await ypy.swap({target: '#box', text: html, swap: 'innerMorph'});
        }

        it('keeps a details open that the response draws closed', async function() {
            createProcessedHTML('<div id="box"><details id="d"><summary>s</summary>text</details></div>');
            let d = find('#d');
            d.open = true;
            await morph('<details id="d"><summary>s</summary>text changed</details>');
            assert.equal(find('#d'), d);
            assert.isTrue(d.open);
            assert.include(d.textContent, 'text changed');
        });

        it('keeps a details closed that the response draws open', async function() {
            createProcessedHTML('<div id="box"><details id="d" open><summary>s</summary>text</details></div>');
            let d = find('#d');
            d.open = false;
            await morph('<details id="d" open><summary>s</summary>text</details>');
            assert.isFalse(d.open);
        });

        it('keeps a details without an id open', async function() {
            createProcessedHTML('<div id="box"><details><summary>s</summary>text</details></div>');
            let d = find('details');
            d.open = true;
            await morph('<details><summary>s</summary>other</details>');
            assert.equal(find('details'), d);
            assert.isTrue(d.open);
        });

        it('keeps a dialog open', async function() {
            createProcessedHTML('<div id="box"><dialog id="dlg"><p>hi</p></dialog></div>');
            let dlg = find('#dlg');
            dlg.show();
            await morph('<dialog id="dlg"><p>hi there</p></dialog>');
            assert.isTrue(dlg.open);
            assert.include(dlg.textContent, 'hi there');
        });

        it('keeps a modal dialog modal', async function() {
            createProcessedHTML('<div id="box"><dialog id="dlg"><p>hi</p></dialog></div>');
            let dlg = find('#dlg');
            dlg.showModal();
            try {
                await morph('<dialog id="dlg"><p>hi again</p></dialog>');
                assert.isTrue(dlg.matches(':modal'));
            } finally {
                dlg.close();
            }
        });

        it('applies the response when it marks the element with ypy-morph-force', async function() {
            createProcessedHTML('<div id="box"><details id="d" open><summary>s</summary>text</details></div>');
            let d = find('#d');
            await morph('<details id="d" ypy-morph-force><summary>s</summary>text</details>');
            assert.isFalse(d.open);
            await morph('<details id="d" ypy-morph-force open><summary>s</summary>text</details>');
            assert.isTrue(d.open);
        });

        it('understands the other spellings of ypy-morph-force', async function() {
            for (let attr of ['ypy-morph-force', 'data-ypy-morph-force']) {
                createProcessedHTML('<div id="box"><details id="d" open><summary>s</summary>text</details></div>');
                let d = find('#d');
                await morph(`<details id="d" ${attr}><summary>s</summary>text</details>`);
                assert.isFalse(d.open, attr);
            }
        });

        it('lets a forced field take the value of the response while it has the focus', async function() {
            createProcessedHTML('<div id="box"><input id="f" value="old"></div>');
            let input = find('#f');
            input.focus();
            input.value = 'typed';
            await morph('<input id="f" value="new">');
            assert.equal(input.value, 'typed', 'the focused field keeps what is typed');
            await morph('<input id="f" value="newer" ypy-morph-force>');
            assert.equal(input.value, 'newer');
        });

        it('opens the details that the response adds', async function() {
            createProcessedHTML('<div id="box"><p>a</p></div>');
            await morph('<p>a</p><details id="new" open><summary>s</summary>x</details>');
            assert.isTrue(find('#new').open);
        });

        it('opens a details created in place of another element', async function() {
            createProcessedHTML('<div id="box"><div id="a"><details id="in" open></details></div></div>');
            await morph('<div id="b"><details id="in" open><summary>s</summary></details></div>');
            assert.isTrue(find('#in').open);
        });

        it('still copies every other attribute', async function() {
            createProcessedHTML('<div id="box"><details id="d" class="a" data-x="1"><summary>s</summary></details></div>');
            let d = find('#d');
            d.open = true;
            await morph('<details id="d" class="b"><summary>s</summary></details>');
            assert.equal(d.className, 'b');
            assert.isFalse(d.hasAttribute('data-x'));
            assert.isTrue(d.open);
        });
    });

    describe('the raw styles written by the author', function() {
        beforeEach(function() { setupTest(this); });

        it('replaces the page the same way when an explicit innerHTML meets the body', function() {
            let pg = createProcessedHTML('<div id="page"><input id="field" value="a"></div>');
            let field = find('#field');
            asBody(pg, () => ypy.__applySwapStyle(pg, 'innerHTML', {style: 'innerHTML'},
                fragmentOf('<input id="field" value="a">'), pg.parentNode));
            assert.notEqual(find('#field'), field);
        });
    });

    describe('out of band content', function() {
        // The out of band tasks are built by __createOOBTask (TASK-012), which has to ask
        // __defaultOOBSwap for the style of ypy-swap-oob="true". These run once it does.
        beforeEach(function() {
            setupTest(this);
            if (!ypy.__createOOBTask.toString().includes('__defaultOOBSwap')) this.skip();
        });

        it('morphs the twin of ypy-swap-oob="true"', async function() {
            mockResponse('GET', '/t', '<p>main</p><div id="twin" class="new" ypy-swap-oob="true"><span id="in">new</span></div>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box">go</button><div id="box"></div><div id="twin"><span id="in">old</span></div></div>');
            let twin = find('#twin'), inner = find('#in');
            find('#b').click();
            await forRequest();
            assert.equal(find('#twin'), twin);
            assert.equal(find('#in'), inner);
            assert.equal(twin.className, 'new');
        });

        it('morphs the target of ypy-select-oob', async function() {
            mockResponse('GET', '/t', '<div id="main">m</div><div id="twin" class="new"><span id="in">new</span></div>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box" ypy-select="#main" ypy-select-oob="#twin">go</button><div id="box"></div><div id="twin"><span id="in">old</span></div></div>');
            let twin = find('#twin');
            find('#b').click();
            await forRequest();
            assert.equal(find('#twin'), twin);
            assert.equal(twin.className, 'new');
        });

        it('keeps outerHTML raw when it is written', async function() {
            mockResponse('GET', '/t', '<p>main</p><div id="twin" ypy-swap-oob="outerHTML"><span id="in">new</span></div>');
            createProcessedHTML('<div><button id="b" ypy-get="/t" ypy-target="#box">go</button><div id="box"></div><div id="twin"><span id="in">old</span></div></div>');
            let twin = find('#twin');
            find('#b').click();
            await forRequest();
            assert.notEqual(find('#twin'), twin);
        });
    });
});
