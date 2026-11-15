// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// TASK-051: the ypy-inspector extension. Requests, swaps, events with their origin and destination,
// signals and stream events, the filter, pause, clear, export, the keyboard shortcut and switching off.
describe('ypy-inspector extension', function () {

    let page;

    before(async () => {
        for (let name of ['ypy-signals', 'ypy-inspector']) {
            let script = document.createElement('script');
            script.src = `../src/ext/${name}.js`;
            await new Promise(resolve => {
                script.onload = resolve;
                document.head.appendChild(script);
            });
        }
        assert.isObject(ypy.inspector, 'ypy-inspector registered');
    });

    beforeEach(function () {
        setupTest(this.currentTest);
        ypy.inspector.clear();
        ypy.inspector.filter('');
        ypy.inspector.pause(false);
    });

    afterEach(function () {
        ypy.inspector.close();
        page?.close();
        page = null;
        cleanupTest();
    });

    const data = () => ypy.inspector.data();
    const host = () => document.getElementById('ypy-inspector');
    const shadow = () => host().shadowRoot;
    const rowsOf = () => [...shadow().querySelectorAll('.row')].map(r => r.textContent);
    const settle = () => ypy.timeout(80);

    async function send(elt) {
        elt.click();
        await forRequest();
    }

    describe('the panel', function () {

        it('lives on <html>, outside <body>, ignored by ypy, and starts closed', function () {
            assert.equal(host().parentElement, document.documentElement);
            assert.isTrue(host().hasAttribute('ypy-ignore'));
            assert.isTrue(shadow().querySelector('.panel').hidden);
            assert.isFalse(shadow().querySelector('.fab').hidden);
        });

        it('has no inline style and no markup built from page data', function () {
            ypy.inspector.open();
            assert.equal(shadow().querySelectorAll('[style]').length, 0);
            assert.equal(shadow().adoptedStyleSheets.length, 1);
            assert.equal(host().getAttribute('style'), null);
        });

        it('open(), close() and toggle() show and hide it', function () {
            ypy.inspector.open();
            assert.isFalse(shadow().querySelector('.panel').hidden);
            assert.isTrue(shadow().querySelector('.fab').hidden);
            ypy.inspector.close();
            assert.isTrue(shadow().querySelector('.panel').hidden);
            ypy.inspector.toggle();
            assert.isFalse(shadow().querySelector('.panel').hidden);
            ypy.inspector.toggle();
            assert.isTrue(shadow().querySelector('.panel').hidden);
        });

        it('the launcher button opens it', function () {
            shadow().querySelector('.fab').click();
            assert.isFalse(shadow().querySelector('.panel').hidden);
        });

        it('Alt+Shift+Y opens and closes it; other keys do nothing', function () {
            let press = init => document.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}));
            press({key: 'y', code: 'KeyY'});
            assert.isTrue(shadow().querySelector('.panel').hidden);
            press({key: 'Y', code: 'KeyY', altKey: true, shiftKey: true});
            assert.isFalse(shadow().querySelector('.panel').hidden);
            press({key: 'Y', code: 'KeyY', altKey: true, shiftKey: true});
            assert.isTrue(shadow().querySelector('.panel').hidden);
        });

        it('Escape closes it when the focus is inside the panel, not when it is elsewhere', function () {
            ypy.inspector.open();
            document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}));
            assert.isFalse(shadow().querySelector('.panel').hidden, 'Escape outside the panel is left alone');
            shadow().querySelector('input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, composed: true}));
            assert.isTrue(shadow().querySelector('.panel').hidden);
        });

        it('has labelled controls', function () {
            ypy.inspector.open();
            assert.equal(shadow().querySelector('section').getAttribute('aria-label'), 'YPY inspector');
            assert.equal(shadow().querySelector('input').getAttribute('aria-label'), 'Filter');
            let names = [...shadow().querySelectorAll('button')].map(b => b.textContent);
            for (let n of ['Pause', 'Clear', 'Export', 'Close']) assert.include(names, n);
        });
    });

    describe('requests', function () {

        it('records method, URL, status, time, size and the YPY-* headers of both sides', async function () {
            mockResponse('GET', '/items', '<p>ten</p>', {headers: {'YPY-Trigger': 'saved', 'X-Other': '1'}});
            createProcessedHTML('<button id="go" ypy-get="/items" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            await send(find('#go'));
            let r = data().requests.at(-1);
            assert.equal(r.method, 'GET');
            assert.equal(r.url, '/items');
            assert.equal(r.status, 200);
            assert.equal(r.state, 'done');
            assert.equal(r.size, '<p>ten</p>'.length);
            assert.isAtLeast(r.ms, 0);
            assert.equal(r.source, 'button#go');
            assert.equal(r.target, 'div#out');
            assert.equal(r.swap, 'innerHTML');
            assert.equal(r.requestHeaders['YPY-Request'], 'true');
            assert.equal(r.requestHeaders['YPY-Source'], 'button#go');
            assert.equal(r.requestHeaders['YPY-Request-Type'], 'partial');
            assert.deepEqual(r.responseHeaders, {'YPY-Trigger': 'saved'});
        });

        it('an error status is recorded as a response, and a network failure as an error', async function () {
            mockResponse('POST', '/bad', 'no', {status: 422});
            mockFailure('GET', '/down', 'boom');
            createProcessedHTML('<form><button id="a" ypy-post="/bad" ypy-target="#out">A</button></form><button id="b" ypy-get="/down">B</button><div id="out"></div>');
            await send(find('#a'));
            await send(find('#b'));
            let [a, b] = data().requests.slice(-2);
            assert.equal(a.status, 422);
            assert.equal(a.state, 'done');
            assert.equal(b.state, 'error');
            assert.equal(b.kind, 'network');
            assert.equal(b.error, 'boom');
        });

        it('a dropped request has a row of its own, and an aborted one says why', async function () {
            let slow = mockSequentialResponses('GET', '/s', 'ok');
            createProcessedHTML('<button id="a" ypy-get="/s" ypy-sync="this:drop">A</button>');
            find('#a').click();
            find('#a').click();
            await ypy.timeout(10);
            await slow.next();
            await forRequest();
            let states = data().requests.map(r => r.state);
            assert.include(states, 'dropped');
            assert.equal(data().requests.find(r => r.state === 'dropped').reason, 'drop');
        });

        it('the Requests tab shows a row per request', async function () {
            mockResponse('GET', '/items', 'x');
            createProcessedHTML('<button id="go" ypy-get="/items" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            ypy.inspector.open('requests');
            await send(find('#go'));
            await settle();
            let [row] = rowsOf();
            assert.match(row, /GET.*\/items.*200.*ms.*1 B/);
        });
    });

    describe('swaps', function () {

        it('records the target, the style, the size and the state of every swap of a request', async function () {
            mockResponse('GET', '/mix', '<p id="main">main</p><div id="side" ypy-swap-oob="innerHTML">side</div>');
            createProcessedHTML('<button id="go" ypy-get="/mix" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div><div id="side"></div>');
            await send(find('#go'));
            let swaps = data().swaps;
            assert.equal(swaps.length, 2);
            let main = swaps.find(s => s.type === 'main'), oob = swaps.find(s => s.type === 'oob');
            assert.equal(main.target, 'div#out');
            assert.equal(main.style, 'innerHTML');
            assert.equal(main.size, '<p id="main">main</p>'.length);
            assert.equal(main.state, 'done');
            assert.equal(oob.target, 'div#side');
            assert.equal(oob.size, '<div id="side">side</div>'.length);
            assert.equal(main.request, data().requests.at(-1).id);
        });

        it('a swap that fails is marked with its error', async function () {
            mockResponse('GET', '/x', '<p>hi</p>');
            createProcessedHTML('<button id="go" ypy-get="/x" ypy-target="#out" ypy-swap="bogus">Go</button><div id="out"></div>');
            await send(find('#go'));
            let s = data().swaps.at(-1);
            assert.equal(s.state, 'error');
            assert.include(s.error, 'Unknown swap style: bogus');
        });

        it('the Swaps tab shows them', async function () {
            mockResponse('GET', '/x', '<p>hi</p>');
            createProcessedHTML('<button id="go" ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            ypy.inspector.open('swaps');
            await send(find('#go'));
            await settle();
            let [row] = rowsOf();
            assert.match(row, /div#out.*innerHTML.*done/);
        });
    });

    describe('events', function () {

        it('every ypy:* event has an origin and a destination', async function () {
            mockResponse('GET', '/x', 'x');
            createProcessedHTML('<button id="go" ypy-get="/x" ypy-target="#out" ypy-swap="innerHTML">Go</button><div id="out"></div>');
            await send(find('#go'));
            let ev = n => data().events.find(e => e.name === n);
            assert.equal(ev('ypy:before:request').from, 'button#go');
            assert.equal(ev('ypy:before:request').to, 'div#out');
            assert.equal(ev('ypy:before:request').info.ctx, 'GET /x');
            assert.equal(ev('ypy:after:swap').from, 'button#go');
            assert.equal(ev('ypy:before:swap').to, 'div#out');
            assert.equal(ev('ypy:finally:request').name, 'ypy:finally:request');
        });

        it('events that the core fires without ypy.trigger are recorded too, with their destination', async function () {
            mockResponse('GET', '/oob', '<div id="nowhere" ypy-swap-oob="true">x</div><p>main</p>');
            createProcessedHTML('<button id="go" ypy-get="/oob" ypy-target="#out">Go</button><div id="out"></div>');
            await send(find('#go'));
            let e = data().events.find(x => x.name === 'ypy:target:missing');
            assert.exists(e);
            assert.equal(e.from, 'button#go');
            assert.equal(e.to, '#nowhere');
        });

        it('an event that a listener cancels is marked', async function () {
            mockResponse('GET', '/x', 'x');
            createProcessedHTML('<button id="go" ypy-get="/x">Go</button>');
            let stop = e => e.preventDefault();
            document.addEventListener('ypy:before:request', stop);
            find('#go').click();
            await ypy.timeout(30);
            document.removeEventListener('ypy:before:request', stop);
            let e = data().events.find(x => x.name === 'ypy:before:request');
            assert.isTrue(e.cancelled);
        });

        it('an event that nobody listed (an extension\'s) is picked up on its first use', function () {
            ypy.trigger(document.body, 'ypy:acme:ping', {n: 1, el: document.body, ctx: {request: {method: 'GET', action: '/z'}}});
            ypy.trigger(document.body, 'ypy:acme:ping', {n: 2});
            let found = data().events.filter(e => e.name === 'ypy:acme:ping');
            assert.equal(found.length, 2, 'once each, not twice');
            assert.deepEqual(found[0].info, {n: 1, el: 'body', ctx: 'GET /z'});
        });

        it('ypy.inspector.watch(name) records an event that ypy.trigger did not send', function () {
            ypy.inspector.watch('ypy:acme:direct');
            document.body.dispatchEvent(new CustomEvent('ypy:acme:direct', {bubbles: true, detail: {x: 1}}));
            assert.equal(data().events.filter(e => e.name === 'ypy:acme:direct').length, 1);
        });

        it('a row opens to show the elements that listen for the event', async function () {
            createProcessedHTML('<div id="l1" ypy-on::after:swap="void 0"></div><div id="l2" ypy-trigger="ypy:after:swap from:body"></div><div id="l3" ypy-on:click="void 0"></div>');
            ypy.trigger(document.body, 'ypy:after:swap', {});
            ypy.inspector.open('events');
            ypy.inspector.filter('after:swap');
            let row = shadow().querySelector('.row');
            row.click();
            let pre = shadow().querySelector('pre').textContent;
            assert.include(pre, 'div#l1 (ypy-on::after:swap)');
            assert.include(pre, 'div#l2 (ypy-trigger)');
            assert.notInclude(pre, 'l3');
        });

        it('the detail of a row is plain text, never markup from the page', async function () {
            ypy.trigger(document.body, 'ypy:acme:note', {text: '<img src=x onerror=alert(1)>'});
            ypy.inspector.open('events');
            ypy.inspector.filter('acme:note');
            shadow().querySelector('.row').click();
            assert.equal(shadow().querySelectorAll('img').length, 0);
            assert.include(shadow().querySelector('pre').textContent, '<img src=x onerror=alert(1)>');
        });

        it('the list keeps at most config.inspector.max rows', function () {
            ypy.config.inspector = {max: 5};
            for (let i = 0; i < 12; i++) ypy.trigger(document.body, 'ypy:acme:tick', {i});
            delete ypy.config.inspector;
            assert.equal(data().events.filter(e => e.name === 'ypy:acme:tick').length, 5);
            assert.equal(data().events.at(-1).info.i, 11);
        });
    });

    describe('signals and stream', function () {

        it('shows the signals of the page now and every patch', async function () {
            let box = createProcessedHTML('<div id="box" ypy-signals="count:2, name:\'x\'"></div>');
            let now = data().signalsNow;
            assert.deepEqual(now.map(s => [s.scope, s.name, s.value]), [['div#box', '$count', 2], ['div#box', '$name', 'x']]);
            ypy.signals.patch({count: 5}, box);
            assert.equal(data().signals.at(-1).name, 'ypy:signals:patch');
            assert.equal(data().signals.at(-1).info.patch, '{"count":5}');
            assert.equal(data().signalsNow[0].value, 5);
            ypy.inspector.open('signals');
            let rows = rowsOf();
            assert.match(rows[0], /div#box.*\$count.*5/);
        });

        it('hides the Signals tab until there is something to show', function () {
            ypy.inspector.open();
            let tab = [...shadow().querySelectorAll('[role=tab]')].find(t => /^Signals/.test(t.textContent));
            assert.isFalse(tab.hidden, 'the extension is loaded, so the tab is there');
        });

        it('the Stream tab appears with the first stream event', function () {
            ypy.inspector.open();
            let tab = () => [...shadow().querySelectorAll('[role=tab]')].find(t => /^Stream/.test(t.textContent));
            assert.isTrue(tab().hidden);
            ypy.trigger(document.body, 'ypy:sse:after:message', {data: 'tick'});
            ypy.trigger(document.body, 'ypy:stream:patch', {data: 'p'});
            assert.equal(data().streams.length, 2);
            return settle().then(() => {
                assert.isFalse(tab().hidden);
                assert.equal(tab().textContent, 'Stream 2');
            });
        });
    });

    describe('filter, pause, clear and export', function () {

        async function two() {
            mockResponse('GET', '/one', 'a');
            mockResponse('GET', '/two', 'b', {status: 404});
            createProcessedHTML('<button id="a" ypy-get="/one">A</button><button id="b" ypy-get="/two">B</button>');
            await send(find('#a'));
            await send(find('#b'));
        }

        it('filter(words) keeps the rows that contain every word', async function () {
            await two();
            ypy.inspector.open('requests');
            assert.equal(rowsOf().length, 2);
            ypy.inspector.filter('404');
            assert.equal(rowsOf().length, 1);
            ypy.inspector.filter('GET /one');
            assert.equal(rowsOf().length, 1);
            assert.match(rowsOf()[0], /\/one/);
            ypy.inspector.filter('/one 404');
            assert.equal(rowsOf().length, 0);
            assert.equal(shadow().querySelector('.empty').textContent, 'No row matches the filter.');
        });

        it('the filter box does the same', async function () {
            await two();
            ypy.inspector.open('requests');
            let input = shadow().querySelector('input');
            input.value = '/two';
            input.dispatchEvent(new Event('input'));
            assert.equal(rowsOf().length, 1);
        });

        it('pause() stops the recording and pause(false) resumes it', async function () {
            mockResponse('GET', '/one', 'a');
            createProcessedHTML('<button id="a" ypy-get="/one">A</button>');
            ypy.inspector.clear();
            ypy.inspector.pause();
            await send(find('#a'));
            assert.equal(data().requests.length, 0);
            assert.equal(data().events.length, 0);
            ypy.inspector.pause(false);
            await send(find('#a'));
            assert.equal(data().requests.length, 1);
        });

        it('the Pause button toggles and shows its state', function () {
            ypy.inspector.open();
            let btn = [...shadow().querySelectorAll('button')].find(b => b.textContent === 'Pause');
            btn.click();
            assert.equal(btn.getAttribute('aria-pressed'), 'true');
            btn.click();
            assert.equal(btn.getAttribute('aria-pressed'), 'false');
        });

        it('clear() empties every list', async function () {
            await two();
            assert.isAbove(data().requests.length, 0);
            ypy.inspector.clear();
            let d = data();
            assert.deepEqual([d.requests, d.swaps, d.events, d.signals, d.streams], [[], [], [], [], []]);
        });

        it('export() is JSON with every list', async function () {
            await two();
            let out = JSON.parse(ypy.inspector.export());
            assert.equal(out.version, 1);
            assert.equal(out.url, location.href);
            assert.match(out.at, /^\d{4}-\d\d-\d\dT/);
            assert.equal(out.requests.length, 2);
            for (let k of ['swaps', 'events', 'signals', 'streams', 'signalsNow']) assert.isArray(out[k]);
            assert.equal(out.requests[1].status, 404);
        });

        it('the Export button saves a .json file', async function () {
            await two();
            ypy.inspector.open();
            let saved = {}, create = URL.createObjectURL, click = HTMLAnchorElement.prototype.click;
            URL.createObjectURL = blob => { saved.blob = blob; return 'blob:test' };
            HTMLAnchorElement.prototype.click = function () { saved.name = this.download; saved.href = this.href };
            try {
                [...shadow().querySelectorAll('button')].find(b => b.textContent === 'Export').click();
            } finally {
                URL.createObjectURL = create;
                HTMLAnchorElement.prototype.click = click;
            }
            assert.match(saved.name, /^ypy-inspector-.*\.json$/);
            assert.equal(saved.href, 'blob:test');
            assert.equal(saved.blob.type, 'application/json');
            assert.equal(JSON.parse(await saved.blob.text()).requests.length, 2);
        });

        it('Clear in the panel empties the lists', async function () {
            await two();
            ypy.inspector.open('requests');
            [...shadow().querySelectorAll('button')].find(b => b.textContent === 'Clear').click();
            assert.equal(data().requests.length, 0);
            assert.equal(shadow().querySelector('.empty').textContent, 'Nothing recorded yet.');
        });
    });

    describe('switching off', function () {

        afterEach(() => ypy.inspector.enable());

        it('disable() removes the panel, stops the recording and restores ypy.trigger', function () {
            let wrapped = ypy.trigger;
            ypy.inspector.disable();
            assert.isNull(host());
            assert.notEqual(ypy.trigger, wrapped);
            assert.isUndefined(ypy.trigger.inspector);
            let before = data().events.length;
            ypy.trigger(document.body, 'ypy:acme:off', {});
            assert.equal(data().events.length, before);
            document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Y', code: 'KeyY', altKey: true, shiftKey: true}));
            assert.isNull(host());
        });

        it('enable() brings it back, and twice is the same as once', function () {
            ypy.inspector.disable();
            ypy.inspector.enable();
            ypy.inspector.enable();
            assert.equal(document.querySelectorAll('#ypy-inspector').length, 1);
            ypy.trigger(document.body, 'ypy:acme:on', {});
            assert.equal(data().events.filter(e => e.name === 'ypy:acme:on').length, 1);
        });

        it('open() on a disabled inspector does nothing', function () {
            ypy.inspector.disable();
            ypy.inspector.open();
            assert.isNull(host());
        });
    });

    describe('start-up options', function () {

        it('inspector:false in the config tag leaves the page alone', async function () {
            page = await openPage({
                head: '<meta name="ypy-config" content="inspector:false">',
                scripts: ['/src/ypy.js', '/src/ext/ypy-inspector.js']
            });
            assert.isNull(page.doc.getElementById('ypy-inspector'));
            assert.isFunction(page.win.ypy.inspector.enable, 'it can still be enabled by hand');
            assert.equal(page.win.ypy.trigger.inspector, undefined);
        });

        it('inspector.open:true shows the panel at start, and a key can be configured', async function () {
            page = await openPage({
                head: '<meta name="ypy-config" content=\'inspector.open:true,inspector.key:"Ctrl+Alt+K"\'>',
                scripts: ['/src/ypy.js', '/src/ext/ypy-inspector.js']
            });
            let panel = page.doc.getElementById('ypy-inspector').shadowRoot.querySelector('.panel');
            assert.isFalse(panel.hidden);
            let press = init => page.doc.dispatchEvent(new page.win.KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}));
            press({key: 'Y', code: 'KeyY', altKey: true, shiftKey: true});
            assert.isFalse(panel.hidden, 'the default shortcut no longer works');
            press({key: 'k', code: 'KeyK', ctrlKey: true, altKey: true});
            assert.isTrue(panel.hidden);
        });

        it('works under a strict CSP: no inline style, no unsafe-inline, Trusted Types enforced', async function () {
            let N = 'n0nce';
            page = await openPage({
                nonce: N,
                head: `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${N}'; style-src 'self'; require-trusted-types-for 'script'; trusted-types ypy">` +
                      '<meta name="ypy-config" content=\'inspector.open:true\'>',
                scripts: ['/src/ypy.js', '/src/ext/ypy-inspector.js']
            });
            let root = page.doc.getElementById('ypy-inspector').shadowRoot;
            let panel = root.querySelector('.panel');
            assert.isFalse(panel.hidden);
            page.win.ypy.inspector.open('events');
            assert.equal(page.win.getComputedStyle(panel).position, 'fixed', 'the adopted style sheet applied');
            assert.equal(root.querySelectorAll('[style]').length, 0);
            page.win.ypy.trigger(page.doc.body, 'ypy:acme:csp', {});
            await new Promise(resolve => page.win.setTimeout(resolve, 80));
            assert.include(root.textContent, 'ypy:acme:csp');
            assert.deepEqual(page.logs.filter(l => /Content Security Policy|Trusted Type/i.test(l)), []);
        });
    });
});
