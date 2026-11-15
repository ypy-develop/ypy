// SPDX-License-Identifier: MIT
// delay, throttle and every must not fire once the element is gone, whether it was removed by a swap
// (the core cleans it up) or taken out of the page by a script (nothing cleans it up).
describe('trigger timers and the life of the element', function () {

    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => { cleanupTest(this.currentTest) });

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const count = url => fetchMock.getCalls().filter(c => c.url === url).length;

    // Replaces the whole region, as a response that swaps the element out does.
    async function swapOut() {
        mockResponse('GET', '/swap', '<p id="gone">new</p>');
        find('#swapper').click();
        await forRequest();
    }

    describe('delay', function () {

        it('does not fire after the element was taken out of the page', async function () {
            mockResponse('GET', '/d', 'x');
            createProcessedHTML(`<div id="box"><button id="b" ypy-get="/d" ypy-trigger="click delay:80ms">d</button></div>`);
            find('#b').click();
            find('#b').remove();
            await wait(200);
            count('/d').should.equal(0);
        });

        it('does not fire after a swap replaced the element', async function () {
            mockResponse('GET', '/d', 'x');
            createProcessedHTML(`<div id="box"><button id="swapper" ypy-get="/swap" ypy-target="#box" ypy-swap="innerHTML"></button><button id="b" ypy-get="/d" ypy-trigger="click delay:150ms">d</button></div>`);
            find('#b').click();
            await swapOut();
            await wait(250);
            count('/d').should.equal(0);
            assert.notExists(find('#b'));
        });

        it('still fires when the element stays (the test is not vacuous)', async function () {
            mockResponse('GET', '/d', 'x');
            createProcessedHTML(`<button id="b" ypy-get="/d" ypy-trigger="click delay:30ms">d</button>`);
            find('#b').click();
            await wait(150);
            count('/d').should.equal(1);
        });

        it('a load trigger with a delay does not fire for an element removed meanwhile', async function () {
            mockResponse('GET', '/l', 'x');
            createProcessedHTML(`<div id="box"><div id="b" ypy-get="/l" ypy-trigger="load delay:80ms"></div></div>`);
            find('#b').remove();
            await wait(200);
            count('/l').should.equal(0);
        });
    });

    describe('throttle', function () {

        it('does not fire its trailing event after the element was taken out of the page', async function () {
            mockResponse('GET', '/t', 'x');
            createProcessedHTML(`<button id="b" ypy-get="/t" ypy-trigger="click throttle:100ms">t</button>`);
            let b = find('#b');
            b.click();
            b.click();
            await wait(20);
            b.remove();
            await wait(250);
            count('/t').should.equal(1);
        });

        it('does not fire its trailing event after a swap replaced the element', async function () {
            mockResponse('GET', '/t', 'x');
            createProcessedHTML(`<div id="box"><button id="swapper" ypy-get="/swap" ypy-target="#box" ypy-swap="innerHTML"></button><button id="b" ypy-get="/t" ypy-trigger="click throttle:150ms">t</button></div>`);
            find('#b').click();
            find('#b').click();
            await swapOut();
            await wait(300);
            count('/t').should.equal(1);
        });

        it('fires its trailing event when the element stays (the test is not vacuous)', async function () {
            mockResponse('GET', '/t', 'x');
            createProcessedHTML(`<button id="b" ypy-get="/t" ypy-trigger="click throttle:60ms">t</button>`);
            find('#b').click();
            find('#b').click();
            await wait(250);
            count('/t').should.equal(2);
        });
    });

    describe('every', function () {

        it('stops once the element was taken out of the page', async function () {
            mockResponse('GET', '/e', 'x');
            createProcessedHTML(`<div id="b" ypy-get="/e" ypy-trigger="every 30ms" ypy-swap="none"></div>`);
            await wait(120);
            let seen = count('/e');
            seen.should.be.above(0);
            find('#b').remove();
            await wait(60);   // a request that was already on its way
            let after = count('/e');
            await wait(200);
            count('/e').should.equal(after);
        });

        it('stops once a swap replaced the element', async function () {
            mockResponse('GET', '/e', 'x');
            createProcessedHTML(`<div id="box"><button id="swapper" ypy-get="/swap" ypy-target="#box" ypy-swap="innerHTML"></button><div id="b" ypy-get="/e" ypy-trigger="every 30ms" ypy-swap="none"></div></div>`);
            await wait(100);
            count('/e').should.be.above(0);
            await swapOut();
            await wait(60);
            let after = count('/e');
            await wait(200);
            count('/e').should.equal(after);
        });
    });
});
