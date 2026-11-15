// SPDX-License-Identifier: MIT
// TASK-054: the visual matrix of MISSION section 7. The same five scenarios (form, list, modal,
// indicator, error and offline) run against Tailwind v4, Bootstrap 5, Bulma 1, Pico CSS 2 and plain
// CSS. Each framework brings its sheet and its markup (test/fixtures/css/<name>/fixture.js); the
// assertions are layout and computed style, so a state that breaks the look of a framework fails
// here. The sheets are local files: nothing is fetched from a CDN.
import {loadSheets, mount, cs, rect, visible, rgb, isRed, marked, signature, transitionsDone, box} from '/test/fixtures/css/lib.js';

const NAMES = ['tailwind', 'bootstrap', 'bulma', 'pico', 'plain'];
const fixtures = await Promise.all(NAMES.map(async name => (await import(`/test/fixtures/css/${name}/fixture.js`)).default));

for (const fx of fixtures) {
    describe(`CSS matrix: ${fx.name}`, function () {

        let unload;
        const onLoadCalls = [];

        before(async function () {
            this.timeout(10000);
            unload = await loadSheets(fx.sheets);
            ypy.onLoad(fx.modal.selector, el => onLoadCalls.push(el));
        });

        after(function () {
            unload();
        });

        beforeEach(function () {
            setupTest(this);
            onLoadCalls.length = 0;
        });

        afterEach(function () {
            cleanupTest();
            delete navigator.onLine;
            window.dispatchEvent(new Event('online'));
            document.documentElement.classList.remove('ypy-offline');
            delete document.documentElement.dataset.ypyState;
        });

        it('loads its style sheets', function () {
            for (const href of fx.sheets) {
                const sheet = [...document.styleSheets].find(s => s.href && new URL(s.href).pathname === href);
                assert.ok(sheet, `${href} is not on the page`);
                assert.isAbove(sheet.cssRules.length, 0, `${href} has no rules`);
            }
        });

        // ---------------------------------------------------------------------------------------
        // Form: a 422 renders the errors inside the form the look survives
        // ---------------------------------------------------------------------------------------
        describe('form', function () {

            async function submit() {
                const form = find('#signup');
                form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
                assert.isNotNull(await forRequest(1000), 'the form sent no request');
            }

            it('shows the error with the framework style and keeps the layout', async function () {
                mount(fx.form.html);
                const field = find('#email'), form = find('#signup');
                const before = {color: rgb(cs(field).borderTopColor), field: rect(field), form: rect(form)};
                assert.isFalse(isRed(before.color), 'the field starts red');
                mockResponse('POST', '/signup', fx.form.invalid, {status: 422});
                await submit();
                await transitionsDone();

                const now = find('#email');
                assert.isTrue(isRed(rgb(cs(now).borderTopColor)), 'the invalid field is not drawn as invalid: ' + cs(now).borderTopColor);
                const after = {field: rect(now), form: rect(find('#signup'))};
                // the page can grow a scroll bar with the message, so compare the field with its form
                assert.closeTo(after.form.width - after.field.width, before.form.width - before.field.width, 1, 'the field no longer fills the form as before');
                assert.closeTo(after.field.left, before.field.left, 1, 'the field moved sideways');

                const message = find('#email-error');
                assert.ok(message, 'the error message is missing');
                assert.isTrue(visible(message), 'the error message is not visible');
                assert.include(message.textContent, 'valid email');
                assert.isAtLeast(rect(message).top, after.field.bottom - 1, 'the message is not below the field');
            });

            it('leaves no state behind on the form or the button', async function () {
                mount(fx.form.html);
                mockResponse('POST', '/signup', fx.form.invalid, {status: 422});
                await submit();
                for (const elt of [find('#signup'), find('button[type=submit]')]) {
                    assert.isFalse(marked(elt, 'request'), elt.outerHTML.slice(0, 60) + ' is still marked request');
                }
                assert.isNull(find('#signup').getAttribute('aria-busy'));
            });
        });

        // ---------------------------------------------------------------------------------------
        // List: appended items look like the items the page came with
        // ---------------------------------------------------------------------------------------
        describe('list', function () {

            it('appends items that match the style of the others', async function () {
                mount(fx.list.html);
                mockResponse('GET', '/more', fx.list.more);
                find('#more').click();
                assert.isNotNull(await forRequest(1000));

                const kids = [...find('#items').children];
                assert.equal(kids.length, 4);
                // items 2 and 3 are both in the middle of the list now: same style, no first/last rule
                assert.deepEqual(signature(kids[2]), signature(kids[1]), 'a new item is styled differently from an old one');
                for (let i = 1; i < kids.length; i++) {
                    assert.isAbove(rect(kids[i]).top, rect(kids[i - 1]).top, `item ${i} is not below item ${i - 1}`);
                    assert.closeTo(rect(kids[i]).left, rect(kids[0]).left, 1, `item ${i} is not aligned`);
                    assert.closeTo(rect(kids[i]).width, rect(kids[0]).width, 1, `item ${i} has another width`);
                }
            });

            it('adds no class, attribute or state of its own to the new items', async function () {
                mount(fx.list.html);
                mockResponse('GET', '/more', fx.list.more);
                find('#more').click();
                assert.isNotNull(await forRequest(1000));

                const sent = document.createElement('template');
                sent.innerHTML = fx.list.more;
                const kids = [...find('#items').children].slice(2);
                kids.forEach((kid, i) => {
                    assert.equal(kid.className, sent.content.children[i].className, 'the classes of the item changed');
                    assert.isUndefined(kid.dataset.ypyState, 'the item keeps a state');
                    assert.isFalse(kid.hasAttribute('style'), 'the item got an inline style');
                });
            });
        });

        // ---------------------------------------------------------------------------------------
        // Modal: a component the page script opens survives a morph, and starts once
        // ---------------------------------------------------------------------------------------
        describe('modal', function () {

            async function load(button) {
                find(button).click();
                assert.isNotNull(await forRequest(1000));
            }

            it('is closed when it arrives and opens as a full-screen layer', async function () {
                mount(fx.modal.html);
                mockResponse('GET', '/modal', fx.modal.fragment);
                await load('#open-modal');

                const modal = find(fx.modal.selector);
                assert.equal(cs(modal).display, 'none', 'the modal is visible before it is opened');
                fx.modal.open(modal);
                await transitionsDone();

                assert.isTrue(fx.modal.isOpen(modal));
                assert.notEqual(cs(modal).display, 'none');
                assert.equal(cs(modal).position, 'fixed');
                assert.equal(cs(modal).opacity, '1');
                assert.isAbove(Number(cs(modal).zIndex) || 0, 0, 'the layer has no z-index');
                const r = rect(modal);
                assert.isAtMost(r.left, 1);
                assert.isAtMost(r.top, 1);
                assert.isAtLeast(r.width, window.innerWidth - 1);
                assert.isAtLeast(r.height, window.innerHeight - 1);
            });

            it('stays open when a morph brings it again (ypy-preserve-attrs)', async function () {
                mount(fx.modal.html);
                mockResponse('GET', '/modal', fx.modal.fragment);
                await load('#open-modal');
                const modal = find(fx.modal.selector);
                fx.modal.open(modal);
                await transitionsDone();

                await load('#refresh-modal');
                assert.strictEqual(find(fx.modal.selector), modal, 'the morph replaced the modal');
                await transitionsDone();
                assert.isTrue(fx.modal.isOpen(modal), 'the morph closed the modal');
                assert.notEqual(cs(modal).display, 'none');
                assert.equal(cs(modal).opacity, '1');
            });

            it('starts the component once with ypy.onLoad, not again for the same node', async function () {
                mount(fx.modal.html);
                mockResponse('GET', '/modal', fx.modal.fragment);
                await load('#open-modal');
                assert.deepEqual(onLoadCalls, [find(fx.modal.selector)]);

                await load('#refresh-modal');
                assert.equal(onLoadCalls.length, 1, 'the morph started the component again');

                await load('#open-modal');   // innerHTML: a new node, so a new component
                assert.equal(onLoadCalls.length, 2);
                assert.strictEqual(onLoadCalls[1], find(fx.modal.selector));
            });
        });

        // ---------------------------------------------------------------------------------------
        // Indicator: shown while the request runs, hidden after, with no layout shift
        // ---------------------------------------------------------------------------------------
        describe('indicator', function () {

            let release;

            beforeEach(function () {
                mockResponse('GET', '/slow', () => new Promise(resolve => {
                    release = () => resolve(new MockResponse('Done'));
                }));
            });

            it('fades in during the request and out after it, without moving anything', async function () {
                mount(fx.indicator.html);
                const go = find('#go'), spin = find('#spin'), plain = find('#plain'), out = find('#out');
                assert.equal(cs(spin).opacity, '0', 'the indicator is visible before the request');
                const idle = [go, spin, plain].map(box);

                go.click();
                await ypy.timeout(30);
                await transitionsDone();
                assert.isTrue(marked(spin, 'request'), 'the indicator is not marked request');
                assert.isFalse(marked(go, 'request'), 'ypy-indicator moves the state off the button');
                assert.equal(cs(spin).opacity, '1');
                if (fx.indicator.visibility !== false) assert.equal(cs(spin).visibility, 'visible');
                assert.equal(out.getAttribute('aria-busy'), 'true', 'the target is not aria-busy');
                [go, spin, plain].forEach((elt, i) => {
                    const now = box(elt);
                    for (const k of ['left', 'top', 'width', 'height']) {
                        assert.closeTo(now[k], idle[i][k], 0.5, `${elt.id} moved (${k}) during the request`);
                    }
                });

                release();
                assert.isNotNull(await forRequest(1000));
                assert.equal(out.textContent, 'Done');
                assert.isFalse(marked(spin, 'request'));
                assert.isNull(out.getAttribute('aria-busy'));
                await transitionsDone();
                assert.equal(cs(spin).opacity, '0', 'the indicator stays visible after the request');
                if (fx.indicator.visibility !== false) assert.equal(cs(spin).visibility, 'hidden');
            });

            it('marks the button itself when there is no ypy-indicator', async function () {
                mount(fx.indicator.html);
                const plain = find('#plain'), before = box(plain);
                plain.click();
                await ypy.timeout(50);
                assert.isTrue(marked(plain, 'request'));
                const now = box(plain);
                assert.closeTo(now.width, before.width, 0.5, 'the button changed its width');
                assert.closeTo(now.height, before.height, 0.5, 'the button changed its height');
                release();
                assert.isNotNull(await forRequest(1000));
                assert.isFalse(marked(plain, 'request'));
                assert.deepEqual([...plain.classList].filter(c => /^ypy-(request|swapping|settling|added)$/.test(c)), [], 'the button keeps a state class');
            });

            it('marks the target while the swap delay runs, then lets go', async function () {
                mount(fx.indicator.html);
                const go = find('#go'), out = find('#out');
                go.setAttribute('ypy-swap', 'innerHTML swap:200ms');
                go.click();
                await ypy.timeout(30);
                release();
                await ypy.timeout(100);
                assert.isTrue(marked(out, 'swapping'), 'the target is not marked swapping');
                assert.isNotNull(await forRequest(1000));
                assert.isFalse(marked(out, 'swapping'));
                assert.equal(out.textContent, 'Done');
            });
        });

        // ---------------------------------------------------------------------------------------
        // Error and offline: the page styles the states through the attribute
        // ---------------------------------------------------------------------------------------
        describe('error and offline', function () {

            const border = elt => {
                const s = cs(elt);
                return {red: isRed(rgb(s.borderTopColor)), width: parseFloat(s.borderTopWidth), style: s.borderTopStyle};
            };

            it('draws the target of an error, then clears it with the next request', async function () {
                mount(fx.error.html);
                const panel = find('#panel');
                assert.isFalse(border(panel).red && border(panel).width > 0, 'the panel starts as an error');

                mockResponse('GET', '/boom', fx.error.response, {status: 500});
                find('#boom').click();
                assert.isNotNull(await forRequest(1000));
                await transitionsDone();
                assert.include((panel.dataset.ypyState || '').split(' '), 'error');
                const b = border(panel);
                assert.isTrue(b.red && b.width > 0 && b.style !== 'none', 'the error state is not drawn: ' + JSON.stringify(b));
                const text = panel.firstElementChild;
                assert.isTrue(visible(text), 'the error text is not visible');
                assert.include(text.textContent, 'Something');

                mockResponse('GET', '/boom', '<p>Fine</p>');
                find('#boom').click();
                assert.isNotNull(await forRequest(1000));
                await transitionsDone();
                assert.notInclude((panel.dataset.ypyState || '').split(' '), 'error');
                assert.isFalse(border(panel).red && border(panel).width > 0, 'the error state is still drawn');
            });

            it('shows the offline banner only while the page is offline', async function () {
                mount(fx.error.html);
                const banner = find(fx.error.banner);
                assert.equal(cs(banner).display, 'none');

                window.dispatchEvent(new Event('offline'));
                assert.include((document.documentElement.dataset.ypyState || '').split(' '), 'offline');
                assert.isTrue(visible(banner), 'the banner is hidden while offline');

                window.dispatchEvent(new Event('online'));
                assert.equal(cs(banner).display, 'none', 'the banner stays after the page is back online');
            });
        });
    });
}
