// SPDX-License-Identifier: MIT
describe('ypy-nav extension: prefetch', function () {

    let extBackup, mount, natives = [];
    const find2 = selector => document.querySelector(selector);
    // a path of its own for every test: what one prefetches is not there for the next
    let n = 0;
    const u = id => '/t' + n + '/' + id;
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
        ypy.config.nav = {boost: true, prefetch: 'hover', prefetchDelay: 5};
        // fixed at the top of the window, so an IntersectionObserver sees it
        mount = document.createElement('div');
        mount.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff';
        document.body.append(mount);
    });

    afterEach(() => {
        delete ypy.config.nav;
        mount.remove();
        try { Object.defineProperty(navigator, 'connection', {value: undefined, configurable: true}) } catch {}
        cleanupTest();
    });

    const render = html => { mount.innerHTML = html; ypy.process(mount); return mount };
    const calls = () => fetchMock.getCalls();
    const hover = elt => elt.dispatchEvent(new MouseEvent('mouseover', {bubbles: true, relatedTarget: document.body}));
    const leave = elt => elt.dispatchEvent(new MouseEvent('mouseout', {bubbles: true, relatedTarget: document.body}));
    const click = elt => elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0}));
    const link = (id, extra = '') => `<a id="${id}" href="${u(id)}" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false" ${extra}>${id}</a>`;
    const OUT = '<div id="out"></div>';

    describe('on hover and touch', function () {

        it('requests the page after the delay, with the purpose headers, same-origin and no body', async function () {
            mockResponse('GET', u('one'), 'One');
            render(link('one') + OUT);
            hover(find2('#one'));
            calls().length.should.equal(0);
            await ypy.timeout(60);
            calls().length.should.equal(1);
            let {url, request} = calls()[0];
            url.should.equal(u('one'));
            request.method.should.equal('GET');
            request.mode.should.equal('same-origin');
            request.credentials.should.equal('same-origin');
            assert.isUndefined(request.body);
            request.headers['Sec-Purpose'].should.equal('prefetch');
            request.headers['Purpose'].should.equal('prefetch');
            request.headers['YPY-Purpose'].should.equal('prefetch');
            request.headers['YPY-Boosted'].should.equal('true');
            request.headers['YPY-Request'].should.equal('true');
            request.headers['YPY-Request-Type'].should.equal('partial');
        });

        it('uses the response for the click: one request in all', async function () {
            mockResponse('GET', u('one'), 'Prefetched');
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(60);
            click(find2('#one'));
            await forRequest();
            find2('#out').textContent.should.equal('Prefetched');
            calls().length.should.equal(1);
            natives.should.deep.equal([]);
        });

        it('uses a response that is still on its way', async function () {
            let held = mockSequentialResponses('GET', u('one'), 'Slow');
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(30);
            click(find2('#one'));
            await ypy.timeout(10);
            await held.next();
            await forRequest();
            find2('#out').textContent.should.equal('Slow');
            calls().length.should.equal(1);
        });

        it('does not send the purpose headers on the click when there was no prefetch', async function () {
            mockResponse('GET', u('one'), 'Plain');
            render(link('one') + OUT);
            click(find2('#one'));
            await forRequest();
            calls().length.should.equal(1);
            assert.isUndefined(calls()[0].request.headers['Sec-Purpose']);
        });

        it('prefetches at once on touchstart', async function () {
            mockResponse('GET', u('one'), 'Touched');
            render(link('one') + OUT);
            find2('#one').dispatchEvent(new Event('touchstart', {bubbles: true}));
            calls().length.should.equal(1);
        });

        it('asks once for a link that is hovered again', async function () {
            mockResponse('GET', u('one'), 'One');
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            leave(find2('#one'));
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
        });

        it('is cancelled by leaving the link before the delay', async function () {
            mockResponse('GET', u('one'), 'One');
            ypy.config.nav.prefetchDelay = 80;
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(20);
            leave(find2('#one'));
            await ypy.timeout(100);
            calls().length.should.equal(0);
        });

        it('aborts a request that is still on its way when the hover ends', async function () {
            mockSequentialResponses('GET', u('one'), 'Never');
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
            let signal = calls()[0].request.signal;
            signal.aborted.should.equal(false);
            leave(find2('#one'));
            signal.aborted.should.equal(true);
        });

        it('keeps a finished response when the hover ends', async function () {
            mockResponse('GET', u('one'), 'Done');
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(60);
            leave(find2('#one'));
            click(find2('#one'));
            await forRequest();
            find2('#out').textContent.should.equal('Done');
            calls().length.should.equal(1);
        });

        it('ignores a move between the children of a link', async function () {
            mockResponse('GET', u('one'), 'One');
            render('<a id="one" href="/one" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false"><b id="in">x</b></a>' + OUT);
            find2('#one').dispatchEvent(new MouseEvent('mouseover', {bubbles: true, relatedTarget: find2('#in')}));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });
    });

    describe('what is and is not prefetched', function () {

        it('does nothing unless prefetch is configured', async function () {
            delete ypy.config.nav.prefetch;
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('is turned on for a link by ypy-prefetch', async function () {
            delete ypy.config.nav.prefetch;
            mockResponse('GET', u('one'), 'One');
            render(link('one', 'ypy-prefetch') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
        });

        it('is turned off for a region by ypy-prefetch="false"', async function () {
            render('<div ypy-prefetch="false">' + link('one') + '</div>' + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('does not prefetch what the browser opens: another target, another origin, a download, a fragment', async function () {
            render('<a id="a" href="/a" target="_blank">a</a><a id="b" href="https://other.example/b">b</a>' +
                '<a id="c" href="/c" download>c</a><a id="d" href="#d">d</a>');
            for (let id of ['a', 'b', 'c', 'd']) hover(find2('#' + id));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('does not prefetch a link YPY would not navigate', async function () {
            ypy.config.nav.boost = false;
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('prefetches a link of the core ypy-boost without global boost', async function () {
            ypy.config.nav.boost = false;
            mockResponse('GET', u('one'), 'Core');
            render('<div ypy-boost:inherited="true">' + link('one') + '</div>' + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
            click(find2('#one'));
            await forRequest();
            find2('#out').textContent.should.equal('Core');
            calls().length.should.equal(1);
        });

        it('never prefetches a form or what a form submits', async function () {
            render('<form id="f" action="/f"><input name="q" value="secret"><button id="b">go</button></form>');
            hover(find2('#f'));
            hover(find2('#b'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('sends no form data for a link that sits inside a form (SEC-07)', async function () {
            mockResponse('GET', u('next'), 'Next');
            render('<form action="/f"><input name="secret" value="s3cret">' + link('next') + '</form>' + OUT);
            hover(find2('#next'));
            await ypy.timeout(40);
            calls().length.should.equal(1);
            calls()[0].url.should.equal(u('next'));
            assert.isUndefined(calls()[0].request.body);
        });

        it('keeps the fetch mode and the origin of the page, whatever the boost value says (SEC-07)', async function () {
            ypy.config.nav.boost = false;
            mockResponse('GET', u('next'), 'Next');
            render('<form action="/f"><input name="secret" value="s3cret">' +
                `<a id="evil" href="${u('next')}" ypy-boost='request.mode:"cors",request.action:"https://other.example/collect"'>x</a>` +
                `<a id="mode" href="${u('next')}" ypy-boost='request.mode:"cors"' ypy-target="#out">y</a></form>` + OUT);
            hover(find2('#evil'));
            hover(find2('#mode'));
            await ypy.timeout(40);
            for (let call of calls()) {
                String(call.url).should.not.contain('other.example');
                String(call.url).should.not.contain('secret');
                call.request.mode.should.equal('same-origin');
            }
            calls().length.should.equal(1);
        });

        it('asks nothing when the browser asks to save data', async function () {
            Object.defineProperty(navigator, 'connection', {value: {saveData: true}, configurable: true});
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            calls().length.should.equal(0);
        });

        it('does not keep an error response: the click asks again', async function () {
            mockResponse('GET', u('one'), 'Broken', {status: 500});
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            mockResponse('GET', u('one'), 'Fixed');
            click(find2('#one'));
            await forRequest();
            calls().length.should.equal(2);
            find2('#out').textContent.should.equal('Fixed');
        });

        it('does not use the response for a click that is a different request', async function () {
            mockResponse('GET', u('one'), 'Different');
            render(link('one', 'ypy-headers=\'{"X-Extra":"1"}\'') + OUT);
            hover(find2('#one'));
            await ypy.timeout(40);
            click(find2('#one'));
            await forRequest();
            calls().length.should.equal(2);
            calls()[1].request.headers['X-Extra'].should.equal('1');
        });

        it('does not use the response after its time is up', async function () {
            ypy.config.nav.prefetchTtl = 30;
            mockResponse('GET', u('one'), 'Stale');
            render(link('one') + OUT);
            hover(find2('#one'));
            await ypy.timeout(80);
            click(find2('#one'));
            await forRequest();
            calls().length.should.equal(2);
        });
    });

    describe('budget', function () {

        it('keeps at most prefetchMax responses, dropping the oldest', async function () {
            ypy.config.nav.prefetchMax = 2;
            mockSequentialResponses('GET', u('a'), 'A');
            mockSequentialResponses('GET', u('b'), 'B');
            mockSequentialResponses('GET', u('c'), 'C');
            render(link('a') + link('b') + link('c') + OUT);
            for (let id of ['a', 'b', 'c']) { hover(find2('#' + id)); await ypy.timeout(20) }
            calls().length.should.equal(3);
            calls()[0].request.signal.aborted.should.equal(true);
            calls()[1].request.signal.aborted.should.equal(false);
            calls()[2].request.signal.aborted.should.equal(false);
        });

        it('prefetches the links that become visible, prefetchParallel at a time', async function () {
            ypy.config.nav = {boost: true, prefetch: 'visible', prefetchParallel: 1};
            let held = ['a', 'b', 'c'].map(id => mockSequentialResponses('GET', u(id), id.toUpperCase()));
            render(link('a') + link('b') + link('c') + OUT);
            await ypy.timeout(150);
            calls().length.should.equal(1);
            await held[0].next();
            await ypy.timeout(30);
            calls().length.should.equal(2);
            await held[1].next();
            await ypy.timeout(30);
            calls().length.should.equal(3);
            await held[2].next();
        });

        it('does not prefetch on visibility when only hover is asked', async function () {
            render(link('a') + OUT);
            await ypy.timeout(100);
            calls().length.should.equal(0);
        });

        it('prefetches one link on visibility with ypy-prefetch="visible"', async function () {
            mockResponse('GET', u('a'), 'A');
            render(link('a', 'ypy-prefetch="visible"') + link('b') + OUT);
            await ypy.timeout(100);
            calls().length.should.equal(1);
            calls()[0].url.should.equal(u('a'));
        });

        it('forgets what it has after a navigation', async function () {
            mockResponse('GET', u('a'), 'A');
            mockResponse('GET', u('b'), 'B');
            render(link('a') + link('b') + OUT);
            hover(find2('#a'));
            await ypy.timeout(40);
            click(find2('#b'));
            await forRequest();
            calls().length.should.equal(2);
            click(find2('#a'));
            await forRequest();
            calls().length.should.equal(3);
        });
    });
});
