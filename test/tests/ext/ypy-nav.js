// SPDX-License-Identifier: MIT
describe('ypy-nav extension: global boost', function () {

    let extBackup, mount, natives = [];
    // the container is not the playground: look in the whole document
    const find2 = selector => document.querySelector(selector);

    // A click or submit that reaches the window uncancelled is one the browser would have
    // navigated: it is recorded and cancelled so the test page stays where it is.
    const guardClick = evt => { if (!evt.defaultPrevented) { natives.push('click'); evt.preventDefault() } };
    const guardSubmit = evt => { if (!evt.defaultPrevented) { natives.push('submit'); evt.preventDefault() } };

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-nav.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
        window.addEventListener('click', guardClick);
        window.addEventListener('submit', guardSubmit);
    });

    after(() => {
        window.removeEventListener('click', guardClick);
        window.removeEventListener('submit', guardSubmit);
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        natives = [];
        ypy.config.nav = {boost: true};
        // outside the playground, whose own listeners cancel every click
        mount = document.createElement('div');
        document.body.append(mount);
    });

    afterEach(() => {
        delete ypy.config.nav;
        delete ypy.config.nonce;
        mount.remove();
        cleanupTest();
    });

    const render = html => { mount.innerHTML = html; ypy.process(mount); return mount };
    const calls = () => fetchMock.getCalls();
    const click = (elt, init = {}) => elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, ...init}));

    describe('links', function () {

        it('navigates a plain link with a request and a swap', async function () {
            mockResponse('GET', '/page', 'Loaded');
            render('<a id="a" href="/page" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>');
            click(find2('#a'));
            await forRequest();
            find2('#out').textContent.should.equal('Loaded');
            natives.should.deep.equal([]);
            calls().length.should.equal(1);
            calls()[0].request.method.should.equal('GET');
            calls()[0].request.headers['YPY-Boosted'].should.equal('true');
            calls()[0].request.mode.should.equal('same-origin');
        });

        it('pushes the URL, as a boosted link does', async function () {
            mockResponse('GET', '/pushed', 'Loaded');
            render('<a id="a" href="/pushed" ypy-target="#out" ypy-swap="innerHTML">go</a><div id="out"></div>');
            click(find2('#a'));
            await forRequest();
            location.pathname.should.equal('/pushed');
        });

        it('is off unless nav.boost is set', async function () {
            delete ypy.config.nav;
            render('<a id="a" href="/page">go</a>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('covers a link added without processing', async function () {
            mockResponse('GET', '/late', 'Late');
            render('<div id="out"></div>');
            mount.insertAdjacentHTML('beforeend', '<a id="a" href="/late" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a>');
            click(find2('#a'));
            await forRequest();
            find2('#out').textContent.should.equal('Late');
        });

        it('boosts a click on an element inside the link', async function () {
            mockResponse('GET', '/page', 'Inner');
            render('<a id="a" href="/page" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false"><b id="b">go</b></a><div id="out"></div>');
            click(find2('#b'));
            await forRequest();
            find2('#out').textContent.should.equal('Inner');
        });

        it('leaves a link with another target to the browser', function () {
            render('<a id="a" href="/page" target="_blank">go</a>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('boosts a link whose target is _self', async function () {
            mockResponse('GET', '/page', 'Self');
            render('<a id="a" href="/page" target="_self" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>');
            click(find2('#a'));
            await forRequest();
            find2('#out').textContent.should.equal('Self');
        });

        it('leaves a download to the browser', function () {
            render('<a id="a" href="/file.pdf" download>go</a>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('leaves a link to another origin to the browser', function () {
            render('<a id="a" href="https://other.example/page">go</a>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('leaves a mailto: and a javascript: link to the browser', function () {
            render('<a id="a" href="mailto:a@example.org">m</a><a id="b" href="javascript:void(0)">j</a>');
            click(find2('#a'));
            click(find2('#b'));
            natives.should.deep.equal(['click', 'click']);
            calls().length.should.equal(0);
        });

        it('leaves a fragment of the same page to the browser', function () {
            render('<a id="a" href="#section">go</a><a id="b" href="' + location.pathname + location.search + '#top">top</a>');
            click(find2('#a'));
            click(find2('#b'));
            natives.should.deep.equal(['click', 'click']);
            calls().length.should.equal(0);
        });

        it('leaves a link without href to the browser', function () {
            render('<a id="a">go</a>');
            click(find2('#a'));
            calls().length.should.equal(0);
        });

        for (let modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
            it('leaves a click with ' + modifier + ' to the browser', function () {
                render('<a id="a" href="/page">go</a>');
                click(find2('#a'), {[modifier]: true});
                natives.should.deep.equal(['click']);
                calls().length.should.equal(0);
            });
        }

        it('leaves a click of another button to the browser', function () {
            render('<a id="a" href="/page">go</a>');
            click(find2('#a'), {button: 1});
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('leaves a click another listener cancelled', function () {
            render('<a id="a" href="/page">go</a>');
            find2('#a').addEventListener('click', evt => evt.preventDefault());
            click(find2('#a'));
            natives.should.deep.equal([]);
            calls().length.should.equal(0);
        });

        it('is turned off for a link by ypy-boost="false"', function () {
            render('<a id="a" href="/page" ypy-boost="false">go</a>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('is turned off for a region by ypy-boost="false"', function () {
            render('<div ypy-boost="false"><section><a id="a" href="/page">go</a></section></div>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('is turned off for a region by ypy-boost:inherited="false"', function () {
            render('<div ypy-boost:inherited="false"><a id="a" href="/page">go</a></div>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
        });

        it('is turned off inside ypy-ignore', function () {
            render('<div ypy-ignore><a id="a" href="/page">go</a></div>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
        });

        it('reads data-ypy-boost too', function () {
            render('<div data-ypy-boost="false"><a id="a" href="/page">go</a></div>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
        });

        it('does not boost a region again outside it', async function () {
            mockResponse('GET', '/page', 'Out');
            render('<div ypy-boost="false"><a id="a" href="/page">no</a></div><a id="b" href="/page" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">yes</a><div id="out"></div>');
            click(find2('#b'));
            await forRequest();
            find2('#out').textContent.should.equal('Out');
        });

        it('leaves an element the core already runs to the core', async function () {
            mockResponse('GET', '/core', 'Core');
            render('<a id="a" href="/page" ypy-get="/core" ypy-target="#out" ypy-swap="innerHTML">go</a><div id="out"></div>');
            click(find2('#a'));
            await forRequest();
            find2('#out').textContent.should.equal('Core');
            calls().length.should.equal(1);
            calls()[0].url.should.equal('/core');
        });

        it('does not run a link the core boosts twice', async function () {
            mockResponse('GET', '/page', 'Once');
            render('<a id="a" href="/page" ypy-boost="true" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>');
            click(find2('#a'));
            await forRequest();
            calls().length.should.equal(1);
        });

        it('is off with config.nonce set, which gates attributes', function () {
            ypy.config.nonce = 'abc';
            render('<a id="a" href="/page">go</a>');
            click(find2('#a'));
            natives.should.deep.equal(['click']);
            calls().length.should.equal(0);
        });

        it('keeps the fetch mode of the page', async function () {
            mockResponse('GET', '/page', 'Mode');
            render('<a id="a" href="/page" ypy-boost="request.mode:\'cors\'" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>');
            click(find2('#a'));
            await forRequest();
            calls()[0].request.mode.should.equal('same-origin');
        });

        it('reports an error of the request on the link', async function () {
            mockResponse('GET', '/missing', '', {status: 500});
            render('<a id="a" href="/missing" ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false">go</a><div id="out"></div>');
            let seen = waitForEvent('ypy:response:error');
            click(find2('#a'));
            let evt = await seen;
            evt.should.not.equal(null);
            evt.target.id.should.equal('a');
            await forRequest();
            calls().length.should.equal(1);
        });
    });

    describe('forms', function () {

        const form = (attrs, inner = '') =>
            `<form id="f" ${attrs} ypy-target="#out" ypy-swap="innerHTML" ypy-push-url="false"><input name="q" value="x">${inner}<button id="b">go</button></form><div id="out"></div>`;
        const submit = (selector = '#b') => find2('#f').requestSubmit(find2(selector));

        it('submits a GET form with a request and puts the fields in the query', async function () {
            mockResponse('GET', '/search', 'Found');
            render(form('action="/search"'));
            submit();
            await forRequest();
            find2('#out').textContent.should.equal('Found');
            calls()[0].url.should.equal('/search?q=x');
            natives.should.deep.equal([]);
        });

        it('submits a POST form with the fields as the body', async function () {
            mockResponse('POST', '/save', 'Saved');
            render(form('action="/save" method="post"'));
            submit();
            await forRequest();
            calls()[0].request.method.should.equal('POST');
            String(calls()[0].request.body).should.equal('q=x');
        });

        it('takes put, patch and delete as method values', async function () {
            for (let verb of ['put', 'patch', 'delete']) {
                mockResponse(verb, '/item', verb);
                render(form(`action="/item" method="${verb}"`));
                submit();
                await forRequest();
                calls().at(-1).request.method.should.equal(verb.toUpperCase());
                find2('#out').textContent.should.equal(verb);
            }
        });

        it('takes formmethod and formaction of the submitter over those of the form', async function () {
            mockResponse('POST', '/other', 'Other');
            render(form('action="/bad" method="get"').replace('<button id="b">', '<button id="b" formmethod="post" formaction="/other">'));
            submit();
            await forRequest();
            calls()[0].url.should.equal('/other');
            calls()[0].request.method.should.equal('POST');
        });

        it('submits to the current page when there is no action', async function () {
            mockResponse('GET', location.pathname, 'Here');
            render(form(''));
            submit();
            await forRequest();
            calls()[0].url.should.contain(location.pathname);
        });

        it('leaves method="dialog" to the browser', function () {
            render(form('action="/x" method="dialog"'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('leaves formmethod="dialog" to the browser', function () {
            render(form('action="/x" method="post"').replace('<button id="b">', '<button id="b" formmethod="dialog">'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('leaves a form with another target to the browser', function () {
            render(form('action="/x" target="_blank"'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('leaves a submitter with another formtarget to the browser', function () {
            render(form('action="/x"').replace('<button id="b">', '<button id="b" formtarget="_blank">'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('leaves a form to another origin to the browser', function () {
            render(form('action="https://other.example/x" method="post"'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('leaves a submitter whose formaction is on another origin to the browser', function () {
            render(form('action="/x" method="post"').replace('<button id="b">', '<button id="b" formaction="https://other.example/x">'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('leaves an unknown method to the browser, which treats it as GET', function () {
            render(form('action="/x" method="bogus"'));
            submit();
            natives.should.deep.equal(['submit']);
            calls().length.should.equal(0);
        });

        it('is turned off for a form by ypy-boost="false" and for its region', function () {
            render(form('action="/x" ypy-boost="false"'));
            submit();
            render('<div ypy-boost="false">' + form('action="/x"') + '</div>');
            submit();
            natives.should.deep.equal(['submit', 'submit']);
            calls().length.should.equal(0);
        });

        it('leaves a form the core already runs to the core', async function () {
            mockResponse('POST', '/core', 'Core');
            render(form('action="/save" ypy-post="/core"'));
            submit();
            await forRequest();
            calls().length.should.equal(1);
            calls()[0].url.should.equal('/core');
        });

        it('does not submit an invalid form', async function () {
            render(form('action="/x"', '<input name="need" required>'));
            submit();
            await ypy.timeout(30);
            calls().length.should.equal(0);
            natives.should.deep.equal([]);
        });
    });
});
