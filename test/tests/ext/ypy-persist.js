// SPDX-License-Identifier: MIT
describe('ypy-persist extension', function () {

    let extBackup, metas = [];

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-persist.js';
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
    });

    afterEach(() => {
        for (let meta of metas) meta.remove();
        metas = [];
        cleanupTest();
    });

    const page = (head, body) => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
    // a boosted navigation into #area; the link and the field live inside it
    const area = inner => `<div id="area" ypy-boost:inherited="true" ypy-target:inherited="#area" ypy-swap:inherited="innerHTML" ypy-push-url:inherited="false">${inner}</div>`;
    const track = (name, value) => {
        let meta = document.createElement('meta');
        meta.name = name;
        meta.content = value;
        meta.setAttribute('ypy-track', 'reload');
        document.head.append(meta);
        metas.push(meta);
        return meta;
    };

    describe('ypy-persist', function () {

        it('keeps the live element, with its state, when the response has the same id', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><input id="q" placeholder="new copy"><p id="new">page two</p>');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q" ypy-persist>'));
            let live = find('#q');
            live.value = 'typed text';
            find('#go').click();
            await forRequest();
            find('#new').textContent.should.equal('page two');
            find('#q').should.equal(live);
            find('#q').value.should.equal('typed text');
            assert.isNull(find('#q').getAttribute('placeholder'));
            playground().querySelectorAll('#q').length.should.equal(1);
        });

        it('does not need the attribute on the copy in the response', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><input id="q" value="from server">');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q" ypy-persist>'));
            let live = find('#q');
            live.value = 'mine';
            find('#go').click();
            await forRequest();
            find('#q').should.equal(live);
            find('#q').value.should.equal('mine');
        });

        it('places the live element where the copy was', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><section><h2>Title</h2><input id="q"><footer>end</footer></section>');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q" ypy-persist>'));
            let live = find('#q');
            find('#go').click();
            await forRequest();
            live.parentElement.tagName.should.equal('SECTION');
            live.previousElementSibling.tagName.should.equal('H2');
            live.nextElementSibling.tagName.should.equal('FOOTER');
        });

        it('removes the element when the response does not have the id', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><p>no field here</p>');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q" ypy-persist>'));
            find('#go').click();
            await forRequest();
            assert.notOk(find('#q'));
        });

        it('replaces an element without ypy-persist as usual', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><input id="q">');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q">'));
            let old = find('#q');
            find('#go').click();
            await forRequest();
            find('#q').should.not.equal(old);
        });

        it('does not keep it when ypy-persist is "false"', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><input id="q">');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q" ypy-persist="false">'));
            let old = find('#q');
            find('#go').click();
            await forRequest();
            find('#q').should.not.equal(old);
        });

        it('keeps several elements, and ignores one the response lacks', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><i id="b"></i><i id="a"></i>');
            createProcessedHTML(area('<a id="go" href="/next">go</a><i id="a" ypy-persist></i><i id="b" ypy-persist></i><i id="c" ypy-persist></i>'));
            let [a, b] = [find('#a'), find('#b')];
            find('#go').click();
            await forRequest();
            find('#a').should.equal(a);
            find('#b').should.equal(b);
            assert.notOk(find('#c'));
        });

        it('reads data-ypy-persist', async function () {
            mockResponse('GET', '/next', '<a id="go" href="/next">again</a><input id="q">');
            createProcessedHTML(area('<a id="go" href="/next">go</a><input id="q" data-ypy-persist>'));
            let live = find('#q');
            find('#go').click();
            await forRequest();
            find('#q').should.equal(live);
        });

        itSource('keeps the element when the history is restored (back and forward)', async function () {
            createProcessedHTML('<main ypy-history-elt><input id="q" ypy-persist><p id="page">old</p></main>');
            let live = find('#q');
            live.value = 'typed';
            mockResponse('GET', '/restored', '<html><head><title>t</title></head><body><main ypy-history-elt><input id="q"><p id="page">restored</p></main></body></html>');
            await restoreHistory({ypy: true}, '/restored');
            find('#page').textContent.should.equal('restored');
            find('#q').should.equal(live);
            find('#q').value.should.equal('typed');
        });

        it('keeps nothing in a swap that is not a navigation', async function () {
            mockResponse('GET', '/part', '<input id="q">');
            createProcessedHTML('<div id="area"><button id="b" ypy-get="/part" ypy-target="#area" ypy-swap="innerHTML">load</button><input id="q" ypy-persist></div>');
            let old = find('#q');
            find('#b').click();
            await forRequest();
            find('#q').should.not.equal(old);
        });

        it('does not touch the element when the navigation swaps somewhere else', async function () {
            mockResponse('GET', '/next', '<p id="new">page two</p>');
            createProcessedHTML('<input id="q" ypy-persist><div ypy-boost:inherited="true" ypy-target:inherited="#out" ypy-swap:inherited="innerHTML" ypy-push-url:inherited="false"><a id="go" href="/next">go</a></div><div id="out"></div>');
            let live = find('#q');
            find('#go').click();
            await forRequest();
            find('#q').should.equal(live);
            find('#new').textContent.should.equal('page two');
        });
    });

    describe('ypy-track', function () {

        const tracking = () => {
            let fired = [], handler = evt => { fired.push(evt.detail); evt.preventDefault() };
            document.addEventListener('ypy:track:reload', handler);
            return {fired, stop: () => document.removeEventListener('ypy:track:reload', handler)};
        };

        it('fires ypy:track:reload when a page response carries another value', async function () {
            track('app-version', 'v1');
            mockResponse('GET', '/next', page('<meta name="app-version" content="v2" ypy-track="reload">', '<main id="m">new</main>'));
            createProcessedHTML(area('<a id="go" href="/next">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(1);
            t.fired[0].url.should.contain('/next');
            t.fired[0].from.join().should.contain('v1');
            t.fired[0].to.join().should.contain('v2');
        });

        it('reloads the page, and swaps nothing, when the event is not cancelled', async function () {
            if (!window.navigation) this.skip();
            track('app-version', 'v1');
            mockResponse('GET', '/next', page('<meta name="app-version" content="v2" ypy-track="reload">', '<p id="new">new</p>'));
            createProcessedHTML(area('<a id="go" href="/next">go</a>'));
            let urls = [], handler = evt => { urls.push(evt.destination.url); evt.preventDefault() };
            navigation.addEventListener('navigate', handler);
            try {
                find('#go').click();
                await forRequest();
            } finally {
                navigation.removeEventListener('navigate', handler);
            }
            urls.length.should.equal(1);
            urls[0].should.contain('/next');
            assert.notOk(find('#new'));
        });

        it('swaps the response when a listener cancels the reload', async function () {
            track('app-version', 'v1');
            mockResponse('GET', '/next', page('<meta name="app-version" content="v2" ypy-track="reload">', '<div id="area"><p id="new">new</p></div>'));
            createProcessedHTML(area('<a id="go" href="/next">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(1);
            find('#new').textContent.should.equal('new');
        });

        it('does nothing when the value is the same', async function () {
            track('app-version', 'v1');
            mockResponse('GET', '/next', page('<meta name="app-version" content="v1" ypy-track="reload">', '<div id="area"><p id="new">new</p></div>'));
            createProcessedHTML(area('<a id="go" href="/next">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(0);
            find('#new').textContent.should.equal('new');
        });

        it('compares a script or a stylesheet by its address', async function () {
            let link = document.createElement('link');
            link.rel = 'x-asset';
            link.href = '/assets/app-aaa.css';
            link.setAttribute('ypy-track', 'reload');
            document.head.append(link);
            metas.push(link);
            mockResponse('GET', '/same', page('<link rel="x-asset" href="/assets/app-aaa.css" ypy-track="reload">', '<div id="area">same</div>'));
            mockResponse('GET', '/other', page('<link rel="x-asset" href="/assets/app-bbb.css" ypy-track="reload">', '<div id="area">other</div>'));
            createProcessedHTML(area('<a id="same" href="/same">s</a><a id="other" href="/other">o</a>'));
            let t = tracking();
            find('#same').click();
            await forRequest();
            t.fired.length.should.equal(0);
            createProcessedHTML(area('<a id="other" href="/other">o</a>'));
            find('#other').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(1);
        });

        it('fires when a tracked element is gone from the page, or new', async function () {
            track('app-version', 'v1');
            mockResponse('GET', '/gone', page('<title>t</title>', '<p>none</p>'));
            createProcessedHTML(area('<a id="go" href="/gone">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.fired.length.should.equal(1);
            metas.pop().remove();
            mockResponse('GET', '/added', page('<meta name="app-version" content="v9" ypy-track="reload">', '<p>new</p>'));
            createProcessedHTML(area('<a id="go" href="/added">go</a>'));
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(2);
        });

        it('ignores a response that is a fragment', async function () {
            track('app-version', 'v1');
            mockResponse('GET', '/frag', '<p id="new">fragment</p>');
            createProcessedHTML(area('<a id="go" href="/frag">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(0);
            find('#new').textContent.should.equal('fragment');
        });

        it('ignores an error response', async function () {
            track('app-version', 'v1');
            mockResponse('GET', '/err', page('<meta name="app-version" content="v2" ypy-track="reload">', '<p>oops</p>'), {status: 500});
            createProcessedHTML(area('<a id="go" href="/err">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(0);
        });

        it('ignores the answer to a request that is not a GET', async function () {
            track('app-version', 'v1');
            mockResponse('POST', '/save', page('<meta name="app-version" content="v2" ypy-track="reload">', '<div id="area"><p id="new">saved</p></div>'));
            createProcessedHTML(area('<form id="f" action="/save" method="post"><button id="b">save</button></form>'));
            let t = tracking();
            find('#b').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(0);
        });

        it('fires when a page that tracked nothing meets a response that tracks', async function () {
            mockResponse('GET', '/next', page('<meta name="app-version" content="v2" ypy-track="reload">', '<div id="area"><p id="new">new</p></div>'));
            createProcessedHTML(area('<a id="go" href="/next">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.should.have.length(1);
        });

        it('does nothing when neither side tracks anything', async function () {
            mockResponse('GET', '/next', page('<title>t</title>', '<div id="area"><p id="new">new</p></div>'));
            createProcessedHTML(area('<a id="go" href="/next">go</a>'));
            let t = tracking();
            find('#go').click();
            await forRequest();
            t.stop();
            t.fired.length.should.equal(0);
            find('#new').textContent.should.equal('new');
        });
    });
});
