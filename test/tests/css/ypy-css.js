// SPDX-License-Identifier: MIT
// TASK-054: the optional stylesheet src/css/ypy.css (dist/ypy.css): indicators, progress bar, the two
// opt-in transitions, and the custom properties that theme them. Run against a page with no other CSS.
import {loadSheets, mount, cs, rect, rgb, transitionsDone} from '/test/fixtures/css/lib.js';

describe('ypy.css', function () {

    let unload;
    const html = document.documentElement;

    before(async function () {
        unload = await loadSheets(['/src/css/ypy.css']);
    });

    after(function () {
        unload();
    });

    beforeEach(function () {
        setupTest(this);
    });

    afterEach(function () {
        cleanupTest();
        html.style.removeProperty('--ypy-duration');
        html.style.removeProperty('--ypy-progress-color');
    });

    describe('indicator', function () {

        it('is hidden, takes its room, and appears with the request state of the element or of an ancestor', async function () {
            mount(`<div id="box"><span id="spin" class="ypy-indicator">...</span></div>`);
            const spin = find('#spin');
            assert.equal(cs(spin).opacity, '0');
            assert.equal(cs(spin).visibility, 'hidden');
            assert.isAbove(rect(spin).width, 0, 'a hidden indicator keeps its room');

            spin.classList.add('ypy-request');
            assert.equal(cs(spin).visibility, 'visible', 'class on the indicator');
            spin.classList.remove('ypy-request');
            find('#box').dataset.ypyState = 'request';
            assert.equal(cs(spin).visibility, 'visible', 'attribute on an ancestor');
            find('#box').dataset.ypyState = 'error';
            await transitionsDone();
            assert.equal(cs(spin).visibility, 'hidden', 'another state');
        });

        it('fades in and out around a real request', async function () {
            let release;
            mockResponse('GET', '/slow', () => new Promise(resolve => { release = () => resolve(new MockResponse('Done')); }));
            mount(`<button id="go" ypy-get="/slow" ypy-target="#out">Go <span id="spin" class="ypy-indicator">...</span></button><div id="out"></div>`);
            const spin = find('#spin');
            find('#go').click();
            await ypy.timeout(20);
            await transitionsDone();
            assert.equal(cs(spin).opacity, '1');
            release();
            assert.isNotNull(await forRequest(1000));
            await transitionsDone();
            assert.equal(cs(spin).opacity, '0');
            assert.equal(cs(spin).visibility, 'hidden');
        });
    });

    describe('custom properties', function () {

        it('--ypy-duration themes every transition, on the page or on one element', function () {
            mount(`<span id="a" class="ypy-indicator">a</span><div id="scope"><span id="b" class="ypy-indicator">b</span></div>`);
            assert.equal(cs(find('#a')).transitionDuration.split(',')[0].trim(), '0.2s');
            html.style.setProperty('--ypy-duration', '1s');
            assert.equal(cs(find('#a')).transitionDuration.split(',')[0].trim(), '1s');
            find('#scope').style.setProperty('--ypy-duration', '50ms');
            assert.equal(cs(find('#b')).transitionDuration.split(',')[0].trim(), '0.05s');
        });

        it('--ypy-progress-color paints the progress bar', function () {
            mount('<div id="bar" class="ypy-progress"></div>');
            const bar = find('#bar');
            assert.isAbove(rgb(cs(bar).backgroundColor)[3], 0, 'the bar has a colour by default');
            html.style.setProperty('--ypy-progress-color', 'rgb(255, 0, 0)');
            assert.deepEqual(rgb(cs(bar).backgroundColor), [255, 0, 0, 255]);
        });
    });

    describe('progress bar', function () {

        it('is a fixed, hidden bar that runs while it has the request state', function () {
            mount('<div id="bar" class="ypy-progress" role="progressbar"></div>');
            const bar = find('#bar');
            assert.equal(cs(bar).position, 'fixed');
            assert.equal(cs(bar).opacity, '0');
            assert.equal(cs(bar).pointerEvents, 'none', 'the bar must not catch clicks');
            assert.equal(cs(bar).height, '3px');
            assert.closeTo(rect(bar).width, document.documentElement.clientWidth, 1);

            bar.classList.add('ypy-request');
            assert.equal(cs(bar).opacity, '1');
            assert.equal(cs(bar).animationName, 'ypy-progress');
            bar.classList.remove('ypy-request');
            bar.dataset.ypyState = 'request';
            assert.equal(cs(bar).animationName, 'ypy-progress', 'attribute');
        });
    });

    describe('transitions', function () {

        it('ypy-fade: the target fades out while it is swapping, and comes back', async function () {
            let release;
            mockResponse('GET', '/more', () => new Promise(resolve => { release = () => resolve(new MockResponse('<p>New</p>')); }));
            mount(`<button id="go" ypy-get="/more" ypy-target="#out" ypy-swap="innerHTML swap:300ms">Go</button><div id="out" class="ypy-fade"><p>Old</p></div>`);
            const out = find('#out');
            assert.equal(cs(out).opacity, '1');
            find('#go').click();
            await ypy.timeout(20);
            release();
            await ypy.timeout(150);
            assert.isBelow(Number(cs(out).opacity), 1, 'the target does not fade while swapping');
            assert.isNotNull(await forRequest(1000));
            await transitionsDone();
            assert.equal(out.textContent, 'New');
            assert.equal(cs(out).opacity, '1');
        });

        it('ypy-fade-in: new content starts transparent and fades in', async function () {
            mockResponse('GET', '/more', '<li id="n" class="ypy-fade-in">New</li>');
            mount(`<button id="go" ypy-get="/more" ypy-target="#items" ypy-swap="beforeend">Go</button><ul id="items"><li>Old</li></ul>`);
            // opacity on each frame from the click: the item is not there at first, then it fades
            const samples = [];
            let running = true;
            const sample = () => {
                const n = find('#n');
                if (n) samples.push(Number(cs(n).opacity));
                if (running) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            find('#go').click();
            assert.isNotNull(await forRequest(1000));
            await transitionsDone();
            await ypy.timeout(50);
            running = false;
            assert.equal(cs(find('#n')).opacity, '1');
            assert.isBelow(Math.min(...samples), 1, 'the item never was transparent: ' + samples.join(','));
        });
    });

    describe('what it does not do', function () {

        it('styles only its own classes, never an element of the page', function () {
            const sheet = [...document.styleSheets].find(s => s.href && new URL(s.href).pathname === '/src/css/ypy.css');
            assert.ok(sheet);
            const selectors = [];
            const walk = rules => {
                for (const rule of rules) {
                    if (rule.selectorText) selectors.push(rule.selectorText);
                    if (rule.cssRules) walk(rule.cssRules);
                }
            };
            walk(sheet.cssRules);
            assert.isAbove(selectors.length, 5);
            for (const selector of selectors) {
                // the class of a YPY element (a state selector may come first), or :root for the properties
                assert.match(selector, /\.ypy-(indicator|progress|fade|fade-in)\b|^:root$/, 'a selector that is not a YPY class: ' + selector);
            }
        });
    });
});
