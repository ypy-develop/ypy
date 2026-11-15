// SPDX-License-Identifier: MIT
describe('ypy-progress extension', function () {

    let extBackup;
    const bar = () => document.querySelector('ypy-progress-bar');
    const inner = () => bar()?.shadowRoot.firstElementChild;
    const boosted = (attrs = '') => `<a id="go" href="/page" ypy-boost="true" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false" ${attrs}>go</a><div id="out"></div>`;

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-progress.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        ypy.config.progress = {delay: 20};
    });

    afterEach(() => {
        delete ypy.config.progress;
        bar()?.remove();
        document.documentElement.style.removeProperty('--ypy-progress-height');
        document.documentElement.style.removeProperty('--ypy-progress-color');
        cleanupTest();
    });

    it('shows nothing when the answer comes before the delay', async function () {
        ypy.config.progress.delay = 300;
        mockResponse('GET', '/page', 'Fast');
        createProcessedHTML(boosted());
        find('#go').click();
        await forRequest();
        assert.isNull(bar());
        await ypy.timeout(350);
        assert.isNull(bar());
    });

    it('shows the bar after the delay and fills it when the request ends', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        assert.isNull(bar());
        await ypy.timeout(60);
        assert.isNotNull(bar());
        inner().dataset.ypyState.should.equal('run');
        await held.next();
        await forRequest();
        inner().dataset.ypyState.should.equal('done');
        await ypy.timeout(700);
        assert.isNull(bar());
    });

    it('is a progressbar with a label, outside the body', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(60);
        bar().parentElement.should.equal(document.documentElement);
        inner().getAttribute('role').should.equal('progressbar');
        inner().getAttribute('aria-label').should.equal('Loading');
        await held.next();
        await forRequest();
    });

    it('uses the configured label', async function () {
        ypy.config.progress.label = 'Chargement';
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(60);
        inner().getAttribute('aria-label').should.equal('Chargement');
        await held.next();
        await forRequest();
    });

    it('stays out of the way of the swap: the body can be replaced while it shows', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(60);
        assert.isNotNull(bar());
        await held.next();
        await forRequest();
        assert.isNotNull(bar());
        find('#out').textContent.should.equal('Slow');
    });

    it('does not show for a request that is not a navigation', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML('<button id="b" ypy-get="/page" ypy-target="#out" ypy-swap="innerHTML">go</button><div id="out"></div>');
        find('#b').click();
        await ypy.timeout(60);
        assert.isNull(bar());
        await held.next();
        await forRequest();
    });

    it('shows for any request of an element that carries ypy-progress', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML('<button id="b" ypy-get="/page" ypy-progress ypy-target="#out" ypy-swap="innerHTML">go</button><div id="out"></div>');
        find('#b').click();
        await ypy.timeout(60);
        assert.isNotNull(bar());
        await held.next();
        await forRequest();
    });

    it('shows for the requests of a region that carries ypy-progress', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML('<div ypy-progress><button id="b" ypy-get="/page" ypy-target="#out" ypy-swap="innerHTML">go</button></div><div id="out"></div>');
        find('#b').click();
        await ypy.timeout(60);
        assert.isNotNull(bar());
        await held.next();
        await forRequest();
    });

    it('is turned off for a navigation by ypy-progress="false"', async function () {
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted('ypy-progress="false"'));
        find('#go').click();
        await ypy.timeout(60);
        assert.isNull(bar());
        await held.next();
        await forRequest();
    });

    it('shows for every request with config.progress.all', async function () {
        ypy.config.progress.all = true;
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML('<button id="b" ypy-get="/page" ypy-target="#out" ypy-swap="innerHTML">go</button><div id="out"></div>');
        find('#b').click();
        await ypy.timeout(60);
        assert.isNotNull(bar());
        await held.next();
        await forRequest();
    });

    it('is one bar for overlapping requests, and goes when the last one ends', async function () {
        ypy.config.progress.all = true;
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML('<button id="b1" ypy-get="/page" ypy-sync="this:replace" ypy-target="#o1" ypy-swap="innerHTML">1</button><button id="b2" ypy-get="/page" ypy-target="#o2" ypy-swap="innerHTML">2</button><div id="o1"></div><div id="o2"></div>');
        find('#b1').click();
        find('#b2').click();
        await ypy.timeout(60);
        document.querySelectorAll('ypy-progress-bar').length.should.equal(1);
        await held.next();
        await ypy.timeout(30);
        inner().dataset.ypyState.should.equal('run');
        await held.next();
        await forRequest();
        await ypy.timeout(30);
        inner().dataset.ypyState.should.equal('done');
    });

    it('needs no CSS of the page: the bar has its own stylesheet and no style attribute', async function () {
        let styles = document.querySelectorAll('style').length;
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(60);
        bar().shadowRoot.adoptedStyleSheets.length.should.equal(1);
        bar().hasAttribute('style').should.equal(false);
        inner().hasAttribute('style').should.equal(false);
        document.querySelectorAll('style').length.should.equal(styles);
        let box = bar().getBoundingClientRect();
        box.height.should.equal(3);
        box.top.should.equal(0);
        getComputedStyle(bar()).position.should.equal('fixed');
        await held.next();
        await forRequest();
    });

    it('is themed by --ypy-progress-* variables', async function () {
        document.documentElement.style.setProperty('--ypy-progress-height', '7px');
        document.documentElement.style.setProperty('--ypy-progress-color', 'rgb(1, 2, 3)');
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(60);
        bar().getBoundingClientRect().height.should.equal(7);
        getComputedStyle(inner()).backgroundColor.should.equal('rgb(1, 2, 3)');
        await held.next();
        await forRequest();
    });

    it('is not affected by a style of the page that targets div', async function () {
        let sheet = document.createElement('style');
        sheet.textContent = 'div{background:rgb(9,9,9) !important;height:50px !important}';
        document.head.append(sheet);
        let held = mockSequentialResponses('GET', '/page', 'Slow');
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(60);
        bar().getBoundingClientRect().height.should.equal(3);
        getComputedStyle(inner()).backgroundColor.should.not.equal('rgb(9, 9, 9)');
        await held.next();
        await forRequest();
        sheet.remove();
    });

    it('shows nothing for a request that fails fast', async function () {
        ypy.config.progress.delay = 300;
        mockFailure('GET', '/page');
        createProcessedHTML(boosted());
        find('#go').click();
        await forRequest();
        assert.isNull(bar());
    });

    it('is removed after a failed slow request', async function () {
        let failing = new Promise((_, reject) => setTimeout(reject, 80, new Error('down')));
        mockResponse('GET', '/page', () => failing);
        createProcessedHTML(boosted());
        find('#go').click();
        await ypy.timeout(50);
        assert.isNotNull(bar());
        await forRequest(500);
        await ypy.timeout(700);
        assert.isNull(bar());
    });
});
