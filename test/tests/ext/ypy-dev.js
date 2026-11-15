// SPDX-License-Identifier: MIT
// TASK-051: the ypy-dev extension (development mode): error messages with context, the latency and
// offline simulators, warnings for incorrect and for legacy use, and the reload of templates.
describe('ypy-dev extension', function () {

    let consoleCalls = [], saved = {};

    before(async () => {
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-dev.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
        assert.isObject(ypy.dev, 'ypy-dev registered');
    });

    beforeEach(function () {
        setupTest(this.currentTest, {authorCode: false});
        ypy.dev.clear();
        consoleCalls = [];
        // the messages go to the console as well; keep the runner log quiet and check them
        for (let level of ['info', 'warn', 'error']) {
            saved[level] = console[level];
            console[level] = (...args) => consoleCalls.push({level, args});
        }
    });

    afterEach(function () {
        for (let level in saved) console[level] = saved[level];
        ypy.dev.latency(0);
        ypy.dev.offline(false);
        delete ypy.config.callbacks;
        delete ypy.config.dev;
        cleanupTest();
    });

    const codes = () => ypy.dev.messages.map(m => m.code);
    const find1 = code => ypy.dev.messages.find(m => m.code === code);

    async function send(elt) {
        elt.click();
        await forRequest();
    }

    describe('messages', function () {

        it('are logged as "ypy-dev: ...", kept in ypy.dev.messages and fired as ypy:dev:message', async function () {
            let events = [];
            let on = e => events.push(e.detail);
            document.addEventListener('ypy:dev:message', on);
            mockResponse('GET', '/empty', '');
            createProcessedHTML('<button ypy-get="/empty" ypy-target="#out">Go</button><div id="out"></div>');
            await send(find('button'));
            document.removeEventListener('ypy:dev:message', on);
            let m = find1('empty-response');
            assert.exists(m);
            assert.equal(m.level, 'warn');
            assert.equal(events.at(-1).code, 'empty-response');
            let logged = consoleCalls.find(c => /^ypy-dev: /.test(c.args[0]));
            assert.equal(logged.level, 'warn');
            assert.include(logged.args[0], 'GET /empty (from ');
            assert.include(logged.args[0], ') answered 200 with an empty body');
            assert.include(logged.args[0], '(from <button ypy-get="/empty" ypy-target="#out">)');
            assert.include(logged.args[0], 'nothing to swap into <div#out>');
        });

        it('stay out of the console with ypy.config.dev.log = false, and are still recorded', async function () {
            ypy.config.dev = {log: false};
            mockResponse('GET', '/empty', '');
            createProcessedHTML('<button ypy-get="/empty" ypy-target="#out">Go</button><div id="out"></div>');
            await send(find('button'));
            assert.equal(codes().includes('empty-response'), true);
            assert.equal(consoleCalls.filter(c => /^ypy-dev: /.test(c.args[0])).length, 0);
        });

        it('are off with ypy.config.dev = false', async function () {
            ypy.config.dev = false;
            mockResponse('GET', '/empty', '');
            createProcessedHTML('<button ypy-get="/empty" ypy-target="#out">Go</button><div id="out"></div>');
            await send(find('button'));
            assert.deepEqual(codes(), []);
        });

        it('a 404 names the request, the target, the swap and the start of the response', async function () {
            mockResponse('GET', '/gone', '<h1>Not   here\n at all</h1>', {status: 404});
            createProcessedHTML('<button ypy-get="/gone" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            await send(find('button'));
            let m = find1('status-404');
            assert.equal(m.level, 'warn');
            assert.include(m.text, 'GET /gone (from <button');
            assert.include(m.text, ') answered 404');
            assert.include(m.text, 'target <div#out>');
            assert.include(m.text, 'swap innerHTML');
            assert.include(m.text, 'check the URL and the route');
            assert.include(m.text, 'Response starts: "<h1>Not here at all</h1>"');
        });

        it('a 500 is an error and a 422 explains where a rejected form goes', async function () {
            mockResponse('POST', '/boom', 'oops', {status: 500});
            mockResponse('POST', '/form', '<p>bad</p>', {status: 422});
            createProcessedHTML('<form><button ypy-post="/boom" ypy-target="#out">A</button><button ypy-post="/form" ypy-target="#out">B</button></form><div id="out"></div>');
            await send(find('button'));
            await send(find('button:nth-of-type(2)'));
            assert.equal(find1('status-500').level, 'error');
            assert.include(find1('status-500').text, 'the server failed');
            assert.include(find1('status-422').text, 'closest form');
        });

        it('an empty 204 is not reported', async function () {
            mockResponse('GET', '/none', '', {status: 204});
            createProcessedHTML('<button ypy-get="/none" ypy-target="#out">Go</button><div id="out"></div>');
            await send(find('button'));
            assert.notInclude(codes(), 'empty-response');
        });

        it('a missing target of an out-of-band element says who asked and what the response started with', async function () {
            mockResponse('GET', '/oob', '<div id="nowhere" ypy-swap-oob="true">x</div><p>main</p>');
            createProcessedHTML('<button ypy-get="/oob" ypy-target="#out">Go</button><div id="out"></div>');
            await send(find('button'));
            let m = find1('target-missing');
            assert.exists(m);
            assert.equal(m.selector, '#nowhere');
            assert.equal(m.type, 'oob');
            assert.include(m.text, 'no element matches "#nowhere", asked by an out-of-band element of the response');
            assert.include(m.text, '(GET /oob answered 200)');
            assert.include(m.text, 'Response starts: "<div id=\\"nowhere\\"');
        });

        it('a missing main target says it is the ypy-target of the source element', async function () {
            mockResponse('GET', '/x', '<p>hi</p>');
            createProcessedHTML('<button ypy-get="/x" ypy-target="#absent">Go</button>');
            await send(find('button'));
            let m = find1('target-missing');
            assert.exists(m);
            assert.include(m.text, 'no element matches "#absent", asked by ypy-target of <button');
        });

        it('an unknown swap style is named with a suggestion', async function () {
            mockResponse('GET', '/x', '<p>hi</p>');
            createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="beforeEnd2">Go</button><div id="out"></div>');
            await send(find('button'));
            let m = find1('unknown-swap');
            assert.exists(m, 'unknown-swap in ' + codes());
            assert.equal(m.style, 'beforeEnd2');
            assert.equal(m.suggestion, 'beforeend');
            assert.include(m.text, 'did you mean "beforeend"?');
            // reported once, not once for the swap and again for the request
            assert.equal(codes().filter(c => c === 'unknown-swap').length, 1);
        });

        it('a timeout names the limit', async function () {
            fetchMock.mockResponse('GET', '/slow', () => new Promise(() => {}));
            createProcessedHTML('<button ypy-get="/slow" ypy-config="timeout:30">Go</button>');
            await send(find('button'));
            let m = find1('timeout');
            assert.exists(m);
            assert.include(m.text, 'GET /slow timed out after 30 ms');
            assert.include(m.text, 'config.defaultTimeout');
        });

        it('a network failure is told apart from an error response', async function () {
            mockFailure('GET', '/down', 'boom');
            createProcessedHTML('<button ypy-get="/down">Go</button>');
            await send(find('button'));
            let m = find1('network');
            assert.exists(m);
            assert.include(m.text, 'GET /down could not reach the server (boom)');
        });

        it('author code that the policy blocks says which element and what code', async function () {
            // a js: confirm is author code; config.callbacks is "none" by default
            mockResponse('GET', '/x', 'x');
            createProcessedHTML('<button ypy-get="/x" ypy-confirm="js:true">Go</button>');
            find('button').click();
            await ypy.timeout(30);
            let m = find1('blocked');
            assert.exists(m);
            assert.equal(m.reason, 'callbacks-none');
            assert.include(m.text, 'author code on <button ypy-get="/x"> did not run (callbacks-none): true');
            assert.equal(m.source, 'true');
        });
    });

    describe('simulator', function () {

        it('latency(ms) delays every request', async function () {
            ypy.dev.latency(120);
            mockResponse('GET', '/x', 'done');
            createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            let t = performance.now();
            find('button').click();
            await forRequest(1000);
            assert.isAtLeast(performance.now() - t, 100);
            assert.equal(find('#out').textContent, 'done');
        });

        it('latency(min, max) picks a delay inside the range', async function () {
            ypy.dev.latency(60, 90);
            assert.deepInclude(ypy.dev.simulation, {min: 60, max: 90});
            mockResponse('GET', '/x', 'done');
            createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            let t = performance.now();
            find('button').click();
            await forRequest(1000);
            assert.isAtLeast(performance.now() - t, 50);
        });

        it('latency(0) turns the delay off', async function () {
            ypy.dev.latency(500);
            ypy.dev.latency(0);
            mockResponse('GET', '/x', 'done');
            createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            find('button').click();
            await forRequest(200);
            assert.equal(find('#out').textContent, 'done');
        });

        it('a request that times out during the delay is a timeout', async function () {
            ypy.dev.latency(300);
            mockResponse('GET', '/x', 'done');
            createProcessedHTML('<button ypy-get="/x" ypy-config="timeout:40">Go</button>');
            await send(find('button'));
            assert.exists(find1('timeout'));
        });

        it('offline(true) fails the requests as an offline failure and puts the page offline', async function () {
            let events = [];
            let on = e => events.push(e.type);
            document.addEventListener('ypy:offline', on);
            document.addEventListener('ypy:online', on);
            ypy.dev.offline(true);
            assert.equal(navigator.onLine, false);
            assert.isTrue(document.documentElement.classList.contains('ypy-offline'));
            mockResponse('GET', '/x', 'done');
            createProcessedHTML('<button ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out">old</div>');
            find('button').click();
            await forRequest(300);
            assert.equal(fetchMock.getLastCall(), undefined, 'the request never reached fetch');
            assert.equal(find('#out').textContent, 'old');
            let m = find1('offline');
            assert.exists(m);
            assert.include(m.text, 'the browser is offline (simulated by ypy.dev.offline)');
            ypy.dev.offline(false);
            await ypy.timeout(5);
            document.removeEventListener('ypy:offline', on);
            document.removeEventListener('ypy:online', on);
            assert.equal(navigator.onLine, true);
            assert.deepEqual(events, ['ypy:offline', 'ypy:online']);
            assert.isFalse(document.documentElement.classList.contains('ypy-offline'));
        });

        it('offline(true) twice is the same as once', function () {
            ypy.dev.offline(true);
            ypy.dev.offline(true);
            assert.isTrue(ypy.dev.simulation.offline);
            ypy.dev.offline(false);
            assert.isFalse(ypy.dev.simulation.offline);
        });

        it('works with ypy-retry: each attempt goes through the simulator', async function () {
            let script = document.createElement('script');
            script.src = '../src/ext/ypy-retry.js';
            await new Promise(resolve => { script.onload = resolve; document.head.appendChild(script) });
            ypy.dev.offline(true);
            mockResponse('GET', '/x', 'done');
            createProcessedHTML('<button ypy-get="/x" ypy-retry="attempts:2 delay:10ms">Go</button>');
            let retries = 0;
            document.addEventListener('ypy:request:retry', () => retries++);
            find('button').click();
            await forRequest(1000);
            assert.equal(retries, 2);
            assert.equal(fetchMock.getLastCall(), undefined);
        });
    });

    describe('warnings for incorrect use', function () {

        it('an unknown attribute suggests the closest one', function () {
            createProcessedHTML('<button ypy-gett="/x" ypy-targt="#out" data-ypy-swpa="innerHTML">Go</button>');
            let found = ypy.dev.messages.filter(m => m.code === 'unknown-attribute');
            assert.deepEqual(found.map(m => m.suggestion).sort(), ['data-ypy-swap', 'ypy-get', 'ypy-target']);
            assert.include(found.find(m => m.attribute === 'ypy-gett').text, 'did you mean "ypy-get"?');
        });

        it('a known attribute, a modifier and an unrelated name are not reported', function () {
            createProcessedHTML('<div ypy-target:inherited="#o" ypy-signals.local="a:1" ypy-status:404="target:#o" ypy-error-target="#o" ypy-zzzzzzzz="1" id="o"><button ypy-post="/x">Go</button></div>');
            assert.deepEqual(ypy.dev.messages.filter(m => m.code === 'unknown-attribute'), []);
        });

        it('a typo is reported once per element, not again at the next process', function () {
            let pg = createProcessedHTML('<button ypy-gett="/x">Go</button>').parentElement;
            ypy.process(pg);
            assert.equal(codes().filter(c => c === 'unknown-attribute').length, 1);
        });

        it('a container attribute that is not inherited is explained', function () {
            createProcessedHTML('<div id="box" ypy-target="#out"><button ypy-get="/x">A</button><button ypy-get="/y" ypy-target="#o2">B</button></div><div id="out"></div>');
            let m = find1('implicit-inheritance');
            assert.exists(m);
            assert.equal(m.descendants, 1);
            assert.include(m.text, '"ypy-target" on <div#box ypy-target="#out"> does not reach <button ypy-get="/x">');
            assert.include(m.text, 'ypy-target:inherited');
        });

        it('an inherited attribute and an element that sends the request itself are fine', function () {
            createProcessedHTML('<div ypy-target:inherited="#out"><button ypy-get="/x">A</button></div><button ypy-get="/y" ypy-target="#out">B</button><div id="out"></div>');
            assert.notInclude(codes(), 'implicit-inheritance');
        });

        it('a ypy-target that matches nothing is reported, one that matches is not', function () {
            createProcessedHTML('<button ypy-get="/x" ypy-target="#nope">A</button><button ypy-get="/x" ypy-target="#here">B</button><button ypy-get="/x" ypy-target="closest div">C</button><div id="here"></div>');
            let found = ypy.dev.messages.filter(m => m.code === 'target-no-match');
            assert.deepEqual(found.map(m => m.selector), ['#nope']);
        });

        it('a ypy-target that is not a selector is reported', function () {
            createProcessedHTML('<button ypy-get="/x" ypy-target="#a b ((">A</button>');
            assert.exists(find1('target-invalid'));
        });

        it('ypy-on while config.callbacks is "none" says it will not run', function () {
            createProcessedHTML('<button ypy-on:click="alert(1)">Go</button>');
            let m = find1('callbacks-none');
            assert.exists(m);
            assert.include(m.text, '"ypy-on:click" on <button ypy-on:click="alert(1)"> will not run: config.callbacks is "none"');
        });

        it('ypy-on is fine when callbacks is "all"', function () {
            ypy.config.callbacks = 'all';
            createProcessedHTML('<button ypy-on:click="void 0">Go</button>');
            assert.notInclude(codes(), 'callbacks-none');
        });

        it('a ypy- and a data-ypy- spelling with different values is a conflict', function () {
            createProcessedHTML('<button ypy-get="/a" data-ypy-get="/b">A</button><button ypy-get="/c" data-ypy-get="/c">B</button>');
            let found = ypy.dev.messages.filter(m => m.code === 'prefix-conflict');
            assert.equal(found.length, 1);
            assert.include(found[0].text, '"ypy-get" and "data-ypy-get" with different values; "ypy-get" wins');
        });

        it('nothing is reported under ypy-ignore', function () {
            createProcessedHTML('<div ypy-ignore><button ypy-gett="/x">Go</button></div>');
            assert.deepEqual(codes(), []);
        });

        it('ypy.config.dev.lint = false turns the markup warnings off', function () {
            ypy.config.dev = {lint: false};
            createProcessedHTML('<button ypy-gett="/x">Go</button>');
            assert.deepEqual(codes(), []);
        });

        it('ypy.dev.known(name) adds an attribute of an extension that is not loaded', function () {
            createProcessedHTML('<button ypy-layr="/x">Go</button>');
            assert.exists(find1('unknown-attribute'));
            ypy.dev.clear();
            ypy.dev.known('layr');
            createProcessedHTML('<button ypy-layr="/x">Go</button>');
            assert.deepEqual(codes(), []);
        });
    });

    describe('warnings for attributes and events of the earlier lines', function () {

        it('an attribute that is no longer read names the fix and the page of the guide', function () {
            createProcessedHTML('<button ypy-get="/x" ypy-vars="a:1" ypy-disabled-elt="this">Go</button>');
            assert.notInclude(codes(), 'legacy-attribute');
            let found = ypy.dev.messages.filter(m => m.code === 'removed-attribute');
            assert.deepEqual(found.map(m => m.attribute).sort(), ['ypy-disabled-elt', 'ypy-vars']);
            let vars = found.find(m => m.attribute === 'ypy-vars');
            assert.include(vars.text, 'ypy does not read "ypy-vars"');
            assert.include(vars.text, 'ypy-vals with the js: prefix');
            assert.equal(vars.guide, 'https://ypy.dev/docs/guides/upgrade-check#attributes');
        });

        it('the guide base is configurable', function () {
            ypy.config.dev = {docs: 'http://localhost:4000/upgrade'};
            createProcessedHTML('<button ypy-get="/x" ypy-request="timeout:5">Go</button>');
            assert.equal(find1('removed-attribute').guide, 'http://localhost:4000/upgrade#attributes');
        });

        it('the spelling of an extension attribute is fine, the old spelling is reported', function () {
            createProcessedHTML('<div ypy-sse:connect="/a"></div><div ypy-sse-connect="/b"></div><div ypy-ws:send></div>');
            let found = ypy.dev.messages.filter(m => m.code === 'removed-attribute');
            assert.deepEqual(found.map(m => m.attribute), ['ypy-sse-connect']);
            assert.include(found[0].guide, '#extension-attributes-swap-styles-and-event-sources');
        });

        it('an event written in kebab-case is reported as one that never fires, with the events table', function () {
            createProcessedHTML('<div ypy-on::after-swap="x()" ypy-on:ypy:before-request="y()" ypy-on::after:swap="z()" ypy-on:my-event="w()"></div>');
            let found = ypy.dev.messages.filter(m => m.code === 'legacy-event');
            assert.deepEqual(found.map(m => m.attribute), ['ypy-on::after-swap', 'ypy-on:ypy:before-request']);
            assert.equal(found[0].guide, 'https://ypy.dev/docs/guides/upgrade-check#events');
            assert.include(found[0].text, '"ypy-on::after-swap" waits for "after-swap", which never fires: write "after:swap" (ypy-on::after:swap)');
        });
    });

    describe('reload of templates', function () {

        let sources, realSource, realAjax, ajaxCalls;

        class FakeSource {
            constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this) }
            addEventListener(name, fn) { this.listeners[name] = fn }
            emit(name) { this.listeners[name]?.({type: name}) }
            close() { this.closed = true }
        }

        beforeEach(() => {
            sources = [];
            ajaxCalls = [];
            realSource = window.EventSource;
            realAjax = ypy.ajax;
            window.EventSource = FakeSource;
            // a stand-in for the request: it reports a swap like a real one
            ypy.ajax = (...args) => {
                ajaxCalls.push(args);
                document.dispatchEvent(new Event('ypy:after:swap'));
                return Promise.resolve();
            };
        });

        afterEach(() => {
            ypy.dev.reload(false);
            window.EventSource = realSource;
            ypy.ajax = realAjax;
        });

        it('reload(true) listens on the default endpoint', function () {
            ypy.dev.reload(true);
            assert.equal(sources.length, 1);
            assert.equal(sources[0].url, '/__ypy/reload');
        });

        it('reload(url) listens on that endpoint and reload(false) closes it', function () {
            ypy.dev.reload('/dev/events');
            assert.equal(sources[0].url, '/dev/events');
            ypy.dev.reload(false);
            assert.isTrue(sources[0].closed);
        });

        it('a "templates" event fetches the current page again and morphs it into the body', async function () {
            ypy.dev.reload(true);
            sources[0].emit('templates');
            await ypy.timeout(120);
            assert.equal(ajaxCalls.length, 1);
            let [verb, path, options] = ajaxCalls[0];
            assert.equal(verb, 'GET');
            assert.equal(path, location.pathname + location.search);
            assert.deepEqual(options, {target: 'body', swap: 'innerMorph'});
            assert.exists(find1('reload'));
        });

        it('events that come together refresh once', async function () {
            ypy.dev.reload(true);
            for (let i = 0; i < 4; i++) sources[0].emit('templates');
            await ypy.timeout(150);
            assert.equal(ajaxCalls.length, 1);
        });

        it('a connection that dropped and came back refreshes the page (the dev server restarted)', async function () {
            ypy.dev.reload(true);
            sources[0].onopen();
            assert.equal(ajaxCalls.length, 0, 'the first connection is not a restart');
            sources[0].onerror();
            sources[0].onopen();
            await ypy.timeout(10);
            assert.equal(ajaxCalls.length, 1);
        });
    });
});
