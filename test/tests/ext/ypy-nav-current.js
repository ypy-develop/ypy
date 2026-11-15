// SPDX-License-Identifier: MIT
// ypy-nav: prefetch on keyboard focus, the current link (aria-current) and ypy-once.
describe('ypy-nav extension: focus, current link and ypy-once', function () {

    let extBackup, mount, natives = [];
    const find2 = selector => document.querySelector(selector);
    let n = 0;
    const u = id => '/f' + n + '/' + id;
    const guardClick = evt => { if (!evt.defaultPrevented) { natives.push('click'); evt.preventDefault() } };

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
        natives = [];
        n++;
        // the last input before a test was not a pointer
        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab'}));
        ypy.config.nav = {boost: true, prefetch: 'hover', prefetchDelay: 5};
        mount = document.createElement('div');
        mount.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff';
        document.body.append(mount);
    });

    afterEach(() => {
        delete ypy.config.nav;
        mount.remove();
        cleanupTest();
    });

    const render = html => { mount.innerHTML = html; ypy.process(mount); return mount };
    const calls = () => fetchMock.getCalls();
    const focus = elt => elt.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
    const blur = elt => elt.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
    const click = elt => elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    const link = (id, extra = '') => `<a id="${id}" href="${u(id)}" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false" ${extra}>${id}</a>`;
    const OUT = '<div id="out"></div>';

    describe('prefetch on focus', function () {

        it('requests the page of a link that gets keyboard focus, after the delay', async function () {
            mockResponse('GET', u('one'), 'One');
            render(link('one') + OUT);
            focus(find2('#one'));
            calls().length.should.equal(0);
            await ypy.timeout(40);
            calls().length.should.equal(1);
            calls()[0].url.should.equal(u('one'));
            calls()[0].request.headers['YPY-Purpose'].should.equal('prefetch');
        });

        it('uses the response for the click: one request in all', async function () {
            mockResponse('GET', u('one'), 'Prefetched');
            render(link('one') + OUT);
            focus(find2('#one'));
            await ypy.timeout(40);
            click(find2('#one'));
            await forRequest();
            find2('#out').textContent.should.equal('Prefetched');
            calls().length.should.equal(1);
        });

        it('does not request when the focus leaves before the delay', async function () {
            mockResponse('GET', u('one'), 'One');
            render(link('one') + OUT);
            focus(find2('#one'));
            blur(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('cancels a request still on its way when the focus leaves', async function () {
            mockSequentialResponses('GET', u('one'), 'Slow');
            render(link('one') + OUT);
            focus(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
            blur(find2('#one'));
            calls()[0].request.signal.aborted.should.equal(true);
        });

        it('leaves a focus that the pointer caused to the hover and the touch', async function () {
            mockResponse('GET', u('one'), 'One');
            render(link('one') + OUT);
            document.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
            focus(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab'}));
            focus(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
        });

        it('does nothing for a link that is not prefetched (mode off, or ypy-prefetch="false")', async function () {
            mockResponse('GET', u('one'), 'One');
            ypy.config.nav = {boost: true};
            render(link('one') + OUT);
            focus(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
            ypy.config.nav = {boost: true, prefetch: 'hover'};
            render(link('one', 'ypy-prefetch="false"') + OUT);
            focus(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });
    });

    describe('the current link', function () {

        const here = () => location.pathname + location.search;
        // the tests push URLs: put the page's own URL back, so a later popstate never lands on a
        // URL ypy wrote (it would restore it, which reloads the test page)
        let original;
        before(function () { original = location.href; });
        afterEach(function () { history.replaceState(history.state, '', original); });
        const nav = () => render(`<nav id="nav">
            <a id="here" href="${here()}">here</a>
            <a id="other" href="/elsewhere">other</a>
            <a id="hash" href="${here()}#part">hash</a>
            <a id="away" href="https://example.com${here()}">away</a>
            <a id="blank" href="${here()}" target="_blank">blank</a>
        </nav>`);

        it('marks the link to the current URL with aria-current="page" and ypy-current', function () {
            nav();
            let a = find2('#here');
            a.getAttribute('aria-current').should.equal('page');
            a.classList.contains('ypy-current').should.equal(true);
        });

        it('leaves the other links alone: another path, a fragment, another origin, another window', function () {
            nav();
            for (let id of ['other', 'hash', 'away', 'blank']) {
                assert.isFalse(find2('#' + id).hasAttribute('aria-current'), id);
                assert.isFalse(find2('#' + id).classList.contains('ypy-current'), id);
            }
        });

        it('moves the mark on every navigation, including the links outside the swap', async function () {
            mockResponse('GET', '/cur-b', '<p>B</p>');
            render(`<nav><a id="a" href="${here()}">a</a><a id="b" href="/cur-b" ypy-boost ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="true">b</a></nav>${OUT}`);
            find2('#a').getAttribute('aria-current').should.equal('page');
            click(find2('#b'));
            await forRequest();
            location.pathname.should.equal('/cur-b');
            assert.isFalse(find2('#a').hasAttribute('aria-current'));
            assert.isFalse(find2('#a').classList.contains('ypy-current'));
            find2('#b').getAttribute('aria-current').should.equal('page');
        });

        it('marks the links that arrive in swapped content', async function () {
            mockResponse('GET', '/cur-c', `<a id="inner" href="/cur-c">c</a><a id="inner2" href="/else">e</a>`);
            render(`<a id="go" href="/cur-c" ypy-boost ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="true">go</a>${OUT}`);
            click(find2('#go'));
            await forRequest();
            find2('#inner').getAttribute('aria-current').should.equal('page');
            assert.isFalse(find2('#inner2').hasAttribute('aria-current'));
        });

        it('follows back and forward', async function () {
            render(`<a id="a" href="${here()}">a</a><a id="b" href="/cur-d">b</a>`);
            let start = here();
            history.pushState({}, '', '/cur-d');
            window.dispatchEvent(new PopStateEvent('popstate', {state: null}));
            find2('#b').getAttribute('aria-current').should.equal('page');
            assert.isFalse(find2('#a').hasAttribute('aria-current'));
            history.replaceState(null, '', start);
            window.dispatchEvent(new PopStateEvent('popstate', {state: null}));
            find2('#a').getAttribute('aria-current').should.equal('page');
            assert.isFalse(find2('#b').hasAttribute('aria-current'));
        });

        it('moves an aria-current="page" the server wrote, and keeps other values alone', function () {
            render(`<a id="old" href="/else" aria-current="page">old</a><a id="step" href="/else2" aria-current="step">step</a><a id="now" href="${here()}">now</a>`);
            assert.isFalse(find2('#old').hasAttribute('aria-current'));
            find2('#step').getAttribute('aria-current').should.equal('step');
            find2('#now').getAttribute('aria-current').should.equal('page');
        });

        it('is off with nav.current: false', function () {
            ypy.config.nav = {current: false};
            nav();
            assert.isFalse(find2('#here').hasAttribute('aria-current'));
        });
    });

    describe('ypy-once', function () {

        const key = () => '__once' + n;
        const body = id => `<div><script ypy-once${id ? `="${id}"` : ''}>window.${key()} = (window.${key()} || 0) + 1;</script>content</div>`;
        const go = async () => { click(find2('#go')); await forRequest() };
        const page = () => render(`<a id="go" href="/once/${n}" ypy-boost ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a>${OUT}`);
        afterEach(() => { delete window['__once' + n] });

        it('runs a script of swapped content once, however often the content comes', async function () {
            mockResponse('GET', `/once/${n}`, body());
            page();
            await go();
            await go();
            await go();
            window[key()].should.equal(1);
            find2('#out').textContent.should.equal('content');
        });

        it('runs a script without ypy-once every time', async function () {
            mockResponse('GET', `/once/${n}`, `<div><script>window.${key()} = (window.${key()} || 0) + 1;</script>x</div>`);
            page();
            await go();
            await go();
            window[key()].should.equal(2);
        });

        it('names the script by the value of ypy-once, so changed text is still the same script', async function () {
            mockResponse('GET', `/once/${n}`, `<script ypy-once="setup">window.${key()} = 1</script>a`);
            page();
            await go();
            mockResponse('GET', `/once/${n}`, `<script ypy-once="setup">window.${key()} = 2</script>b`);
            await go();
            window[key()].should.equal(1);
            find2('#out').textContent.should.equal('b');
        });

        it('treats different scripts as different, and a script of the page as already run', async function () {
            page();
            let early = document.createElement('script');
            early.setAttribute('ypy-once', 'early');
            early.textContent = `window.${key()} = 'page'`;
            mount.append(early);
            ypy.process(mount);
            mockResponse('GET', `/once/${n}`, `<script ypy-once="early">window.${key()} = 'swap'</script><script ypy-once="late">window.${key()}_late = true</script>x`);
            await go();
            window[key()].should.equal('page');
            window[key() + '_late'].should.equal(true);
            delete window[key() + '_late'];
        });
    });
});
