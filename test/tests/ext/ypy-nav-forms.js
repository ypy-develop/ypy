// SPDX-License-Identifier: MIT
// ypy-nav: a navigation does not lose the edit in progress, and a page from outside the app is loaded in full.
describe('ypy-nav extension: edits and pages from outside the app', function () {

    let extBackup, mount, loc, seen;
    const find2 = selector => document.querySelector(selector);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const calls = () => fetchMock.getCalls();
    const urls = () => calls().map(c => c.url);
    const click = elt => elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    const render = html => { mount.innerHTML = html; ypy.process(mount); return mount };
    const guardClick = evt => { if (!evt.defaultPrevented) evt.preventDefault() };
    const unload = () => { let e = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(e); return e.defaultPrevented };
    // blur what is still focused (its request starts now, not during the next test) and answer everything
    const finish = async hold => { document.activeElement?.blur?.(); await wait(20); hold.next(); hold.next(); await wait(40) };
    const type = (elt, value) => { elt.value = value; elt.dispatchEvent(new Event('input', {bubbles: true})) };

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-nav.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
        window.addEventListener('click', guardClick);
    });

    after(() => {
        window.removeEventListener('click', guardClick);
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        ypy.config.nav = {boost: true};
        mount = document.createElement('div');
        document.body.append(mount);
        loc = ypy._loc;
        seen = [];
        ypy._loc = {set href(v) { seen.push(v) }, reload() {}};
    });

    afterEach(() => {
        ypy._loc = loc;
        delete ypy.config.nav;
        mount.remove();   // a field removed while focused fires no blur, so no request starts after the test
        cleanupTest();
    });

    const PAGE = `<form id="f"><input id="i" name="a" ypy-post="/save" ypy-trigger="blur" ypy-swap="none"></form>
        <a id="a" href="/page" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>`;

    describe('a navigation while a field is being edited', function () {

        it('blurs the field first, so its request goes out before the navigation', async function () {
            mockResponse('POST', '/save', 'saved');
            mockResponse('GET', '/page', 'Next');
            render(PAGE);
            find2('#i').focus();
            click(find2('#a'));
            await wait(150);
            urls().should.deep.equal(['/save', '/page']);
            find2('#out').textContent.should.equal('Next');
        });

        it('waits for the request the blur started, up to nav.settle', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            mockResponse('GET', '/page', 'Next');
            render(PAGE);
            find2('#i').focus();
            click(find2('#a'));
            await wait(100);
            urls().should.deep.equal(['/save']);
            hold.next();
            await wait(100);
            urls().should.deep.equal(['/save', '/page']);
        });

        it('does not wait longer than the limit', async function () {
            ypy.config.nav.settle = 60;
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            mockResponse('GET', '/page', 'Next');
            render(PAGE);
            find2('#i').focus();
            click(find2('#a'));
            await wait(30);
            urls().should.deep.equal(['/save']);
            await wait(150);
            urls().should.deep.equal(['/save', '/page']);
            hold.next();
            await wait(30);
        });

        it('waits for the change of a field too, not only for a blur trigger', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            mockResponse('GET', '/page', 'Next');
            render(PAGE.replace('ypy-trigger="blur"', 'ypy-trigger="change"'));
            let i = find2('#i');
            i.focus();
            i.dispatchEvent(new Event('change', {bubbles: true}));   // the change a blur would have fired
            click(find2('#a'));
            await wait(100);
            urls().should.deep.equal(['/save']);
            hold.next();
            await wait(100);
            urls().should.deep.equal(['/save', '/page']);
        });

        it('does not wait with nav.settle 0, and still blurs nothing', async function () {
            ypy.config.nav.settle = 0;
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            mockResponse('GET', '/page', 'Next');
            render(PAGE);
            find2('#i').focus();
            click(find2('#a'));
            await wait(100);
            urls().should.deep.equal(['/page']);
            await finish(hold);
        });

        it('a navigation with no field in focus goes out at once', async function () {
            mockResponse('GET', '/page', 'Next');
            render(PAGE);
            click(find2('#a'));
            await forRequest();
            urls().should.deep.equal(['/page']);
        });

        it('never cancels mousedown, which is what makes the browser blur the field', function () {
            render(PAGE);
            let e = new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0});
            find2('#a').dispatchEvent(e);
            e.defaultPrevented.should.equal(false);
        });

        it('does not wait for the requests of another form', async function () {
            let hold = mockSequentialResponses('POST', '/save', 'saved');
            mockResponse('GET', '/page', 'Next');
            render(PAGE + `<input id="j" ypy-post="/save" ypy-trigger="blur" ypy-swap="none">`);
            find2('#j').focus();
            find2('#j').blur();
            await wait(20);
            find2('#j').focus();
            // #j is the field being edited and its own request is the pending one: the navigation waits
            click(find2('#a'));
            await wait(80);
            urls().should.deep.equal(['/save']);
            await finish(hold);
        });
    });

    describe('nav.confirmLeave', function () {

        const FORM = `<form id="f" ypy-post="/save" ypy-swap="none"><input id="i" name="a" value="x"></form>`;

        it('is off by default', function () {
            render(FORM);
            type(find2('#i'), 'changed');
            unload().should.equal(false);
        });

        it('asks the browser to confirm while a form has changes nobody saved', function () {
            ypy.config.nav.confirmLeave = true;
            render(FORM);
            unload().should.equal(false);
            type(find2('#i'), 'changed');
            unload().should.equal(true);
        });

        it('stops asking once a request of the form was answered with 2xx', async function () {
            ypy.config.nav.confirmLeave = true;
            mockResponse('POST', '/save', 'saved');
            render(FORM);
            type(find2('#i'), 'changed');
            find2('#f').requestSubmit();
            await forRequest();
            unload().should.equal(false);
        });

        it('keeps asking when the save failed', async function () {
            ypy.config.nav.confirmLeave = true;
            mockResponse('POST', '/save', 'no', {status: 500});
            render(FORM);
            type(find2('#i'), 'changed');
            find2('#f').requestSubmit();
            await forRequest();
            unload().should.equal(true);
        });

        it('a GET does not count as a save', async function () {
            ypy.config.nav.confirmLeave = true;
            mockResponse('GET', '/search', 'r');
            render(`<form id="f"><input id="i" name="q" ypy-get="/search" ypy-trigger="change" ypy-swap="none"></form>`);
            type(find2('#i'), 'changed');
            find2('#i').dispatchEvent(new Event('change', {bubbles: true}));
            await forRequest();
            unload().should.equal(true);
        });

        it('a reset clears the changes', function () {
            ypy.config.nav.confirmLeave = true;
            render(FORM);
            type(find2('#i'), 'changed');
            find2('#f').reset();
            unload().should.equal(false);
        });

        it('a field that left the page does not count', function () {
            ypy.config.nav.confirmLeave = true;
            render(FORM);
            type(find2('#i'), 'changed');
            find2('#f').remove();
            unload().should.equal(false);
        });
    });

    describe('a page from outside the app', function () {

        const LINK = `<a id="a" href="/page" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>`;
        const APP = `<!doctype html><html><body><main ypy-history-elt>App</main></body></html>`;
        const OTHER = `<!doctype html><html><body><form>Sign in</form></body></html>`;
        const redirected = (body, url) => { let r = new MockResponse(body, {url}); r.redirected = true; return r };

        it('a redirect to another origin loads the final URL in full, with no swap', async function () {
            mockResponse('GET', '/page', redirected(APP, 'https://sso.example.test/login?next=1'));
            render(LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal(['https://sso.example.test/login?next=1']);
            find2('#out').textContent.should.equal('');
        });

        it('a whole page without the app root loads in full when the page has one', async function () {
            mount.innerHTML = '<div ypy-history-elt></div>';
            mockResponse('GET', '/page', redirected(OTHER, location.origin + '/login'));
            render(`<div ypy-history-elt>x</div>` + LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal([location.origin + '/login']);
            find2('#out').textContent.should.equal('');
        });

        it('a whole page that has the app root is swapped', async function () {
            mockResponse('GET', '/page', redirected(APP, location.origin + '/page'));
            render(`<div ypy-history-elt>x</div>` + LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal([]);
            find2('#out').textContent.should.contain('App');
        });

        it('a fragment is swapped: only a whole page can be a page from outside', async function () {
            mockResponse('GET', '/page', '<b>part</b>');
            render(`<div ypy-history-elt>x</div>` + LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal([]);
            find2('#out').textContent.should.equal('part');
        });

        it('nav.root names the mark of the app when the page has no ypy-history-elt', async function () {
            ypy.config.nav.root = 'main[data-app]';
            mockResponse('GET', '/page', redirected(OTHER, location.origin + '/login'));
            render(LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal([location.origin + '/login']);
        });

        it('with no mark to look for, a same-origin page is swapped', async function () {
            mockResponse('GET', '/page', OTHER);
            render(LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal([]);
            find2('#out').textContent.should.contain('Sign in');
        });

        it('an error page is left to the core', async function () {
            mockResponse('GET', '/page', OTHER, {status: 502});
            render(`<div ypy-history-elt>x</div>` + LINK);
            click(find2('#a'));
            await forRequest();
            seen.should.deep.equal([]);
        });
    });
});
