// SPDX-License-Identifier: MIT
// Progressive enhancement: none of the navigation extensions is loaded in this page, so every
// link, form and attribute must stay what the HTML says it is.
describe('navigation without the extensions', function () {

    let mount, seen = [];
    const find2 = selector => document.querySelector(selector);
    // the click or submit reaches the window uncancelled: the browser would have navigated
    const guard = evt => { seen.push({type: evt.type, cancelled: evt.defaultPrevented}); evt.preventDefault() };

    before(() => {
        window.addEventListener('click', guard);
        window.addEventListener('submit', guard);
    });

    after(() => {
        window.removeEventListener('click', guard);
        window.removeEventListener('submit', guard);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        seen = [];
        mount = document.createElement('div');
        document.body.append(mount);
    });

    afterEach(() => {
        delete ypy.config.nav;
        delete ypy.config.progress;
        mount.remove();
        cleanupTest();
    });

    const render = html => { mount.innerHTML = html; ypy.process(mount); return mount };
    const click = elt => elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));

    it('leaves a link to the browser, even with nav.boost configured', async function () {
        ypy.config.nav = {boost: true, prefetch: 'hover visible'};
        render('<a id="a" href="/page">go</a>');
        click(find2('#a'));
        await ypy.timeout(30);
        seen.should.deep.equal([{type: 'click', cancelled: false}]);
        fetchMock.getCalls().length.should.equal(0);
    });

    it('leaves a form to the browser, even with nav.boost configured', async function () {
        ypy.config.nav = {boost: true};
        render('<form id="f" action="/save" method="post"><button id="b">go</button></form>');
        find2('#f').requestSubmit(find2('#b'));
        await ypy.timeout(30);
        seen.should.deep.equal([{type: 'submit', cancelled: false}]);
        fetchMock.getCalls().length.should.equal(0);
    });

    it('does not prefetch on hover', async function () {
        ypy.config.nav = {prefetch: 'hover'};
        render('<a id="a" href="/page" ypy-prefetch>go</a>');
        find2('#a').dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
        await ypy.timeout(120);
        fetchMock.getCalls().length.should.equal(0);
    });

    it('keeps the content of a lazy region as it is: a working link', async function () {
        render('<div id="lz" ypy-lazy="/panel"><a id="a" href="/panel">Open the panel</a></div>');
        await ypy.timeout(80);
        fetchMock.getCalls().length.should.equal(0);
        find2('#lz').textContent.should.equal('Open the panel');
        find2('#lz').hasAttribute('data-ypy-powered').should.equal(false);
        click(find2('#a'));
        seen.should.deep.equal([{type: 'click', cancelled: false}]);
    });

    it('leaves a ypy-lazy table row in place', async function () {
        render('<table><tbody><tr id="lz" ypy-lazy="/rows"><td><a href="/rows">Show the rows</a></td></tr></tbody></table>');
        await ypy.timeout(80);
        fetchMock.getCalls().length.should.equal(0);
        find2('#lz').textContent.should.equal('Show the rows');
    });

    it('leaves ypy-persist and ypy-track as plain attributes', async function () {
        mockResponse('GET', '/next', '<input id="q"><p id="new">two</p>');
        render('<div id="area" ypy-boost:inherited="true" ypy-target:inherited="#area" ypy-swap:inherited="innerHTML" ypy-push-url:inherited="false"><a id="go" href="/next">go</a><input id="q" ypy-persist></div>');
        let old = find2('#q');
        click(find2('#go'));
        await forRequest();
        find2('#new').textContent.should.equal('two');
        find2('#q').should.not.equal(old);
    });

    it('shows no progress bar', async function () {
        ypy.config.progress = {delay: 10, all: true};
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        render('<button id="b" ypy-get="/page" ypy-progress ypy-target="#out" ypy-swap="innerHTML">go</button><div id="out"></div>');
        find2('#b').click();
        await ypy.timeout(80);
        assert.isNull(document.querySelector('ypy-progress-bar'));
        await held.next();
        await forRequest();
    });

    it('still boosts what the core boosts', async function () {
        mockResponse('GET', '/page', 'Core boost');
        render('<a id="a" href="/page" ypy-boost="true" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>');
        click(find2('#a'));
        await forRequest();
        find2('#out').textContent.should.equal('Core boost');
    });
});
