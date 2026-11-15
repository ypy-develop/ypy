// SPDX-License-Identifier: MIT
// The client of the streaming protocol (spec/PROTOCOL.md). The server is a fake: a mocked fetch whose
// answers are streams the test writes to, one per connection.
describe('ypy-stream extension', function () {

    let extBackup, wire;

    const load = src => new Promise(resolve => {
        let script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        document.head.appendChild(script);
    });

    // bytes the Go SDK wrote (test/fixtures/stream/sdk-wire.txt)
    const fixture = path => new Promise((resolve, reject) => {
        let xhr = new XMLHttpRequest();
        xhr.open('GET', path);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => xhr.status == 200 ? resolve(new Uint8Array(xhr.response)) : reject(new Error('fixture ' + xhr.status));
        xhr.onerror = () => reject(new Error('fixture failed'));
        xhr.send();
    });

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        await load('../src/ext/ypy-stream.js');
        wire = await fixture('/test/fixtures/stream/sdk-wire.txt');
    });
    after(() => { restoreExtensions(extBackup) });

    let saved = {};
    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => {
        for (let [k, v] of Object.entries(saved)) v === undefined ? delete ypy[k] : (ypy[k] = v);
        saved = {};
        for (let [name, fn] of listeners) document.removeEventListener(name, fn);
        listeners = [];
        try { delete navigator.onLine } catch {}
        delete document.startViewTransition;
        cleanupTest();
    });

    // ---- helpers ------------------------------------------------------------------------------

    const enc = new TextEncoder();
    const until = async (fn, ms = 1000) => {
        let t = Date.now();
        while (Date.now() - t < ms) { let v = fn(); if (v) return v; await ypy.timeout(2) }
        throw new Error('timed out waiting for ' + fn);
    };
    const once = (name, ms = 1000) => new Promise((resolve, reject) => {
        let id = setTimeout(() => reject(new Error('no ' + name)), ms);
        document.addEventListener(name, e => { clearTimeout(id); resolve(e) }, {once: true});
    });
    let listeners = [];
    const on = (name, fn) => { document.addEventListener(name, fn); listeners.push([name, fn]) };
    // a navigation swaps the whole body, which would take the test page with it
    const keepPage = () => on('ypy:before:swap', e => e.detail.tasks.forEach(t => { if (t.target === document.body) t.target = playground() }));
    const quiet = async fn => {
        let e = console.error, w = console.warn;
        console.error = console.warn = () => {};
        try { return await fn() } finally { console.error = e; console.warn = w }
    };

    // A fake server for one URL pattern. Each fetch is one connection, taken from plan (a {fail},
    // {status, body, type} answer) or, by default, a new event stream the test writes to.
    function server(pattern, method = 'GET') {
        let s = {conns: [], plan: [], calls: () => fetchMock.getCalls().filter(c => pattern.test(c.url))};
        s.delay = 0;   // ms before the next answer arrives
        const respond = () => {
            let p = s.plan.shift() ?? {};
            if (p.fail) return Promise.reject(new TypeError('Failed to fetch'));
            // real Response objects: real Headers (case-insensitive) and a real body stream
            if (p.status || p.type) return new Response(p.status == 204 ? null : p.body ?? '', {status: p.status ?? 200, headers: {'content-type': p.type ?? 'text/html'}});
            let c = {cancelled: false, closed: false};
            let body = new ReadableStream({start(ctrl) { c.ctrl = ctrl }, cancel() { c.cancelled = true }});
            c.send = raw => { try { c.ctrl.enqueue(typeof raw == 'string' ? enc.encode(raw) : raw) } catch {} };
            c.end = () => { c.closed = true; try { c.ctrl.close() } catch {} };
            c.event = (name, ...lines) => c.send(`event: ${name}\n` + lines.map(l => `data: ${l}\n`).join('') + '\n');
            c.patch = (k, html) => c.event('ypy-patch-elements',
                ...Object.entries(k).map(([a, b]) => a + ' ' + b), ...(html == null ? [] : html.split('\n').map(l => 'elements ' + l)));
            // returns once every event sent before it was applied
            c.flush = async () => { let p = once('t:flush'); c.event('ypy-event', 'name t:flush'); await p };
            s.conns.push(c);
            return new Response(body, {headers: {'content-type': 'text/event-stream; charset=utf-8'}});
        };
        fetchMock.mockResponse(method, pattern, () => s.delay ? new Promise(r => { let d = s.delay; s.delay = 0; setTimeout(() => r(respond()), d) }) : respond());
        return s;
    }

    // a page with a streaming element; resolves with the first connection
    async function openRoom(html, url = '/room') {
        let srv = server(new RegExp('^' + url)), opened = once('ypy:stream:open');
        createProcessedHTML(html);
        await opened;
        return [srv, srv.conns[0]];
    }
    const html = sel => find(sel).innerHTML;
    const LIST = '<ul id="l"><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>';

    // ---- the wire -----------------------------------------------------------------------------

    describe('the bytes of the Go SDK', function () {

        it('every event, fed one byte at a time, with the multi-byte characters split', async function () {
            this.timeout(5000);
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><ul id="messages"><li>old</li></ul><svg id="chart"></svg><p id="typing">...</p></div>`);
            let got = {signals: null, event: null};
            on('ypy:stream:signals', e => got.signals = e.detail);
            on('message:new', e => got.event = e.detail);
            keepPage();
            let nav = once('ypy:before:request');   // the redirect goes through the client
            mockResponse('GET', '/rooms', '<p>rooms</p>');
            for (let b of wire) c.send(new Uint8Array([b]));
            let req = await nav;
            assert.equal(req.detail.ctx.request.action, '/rooms');
            // the first event morphed #messages by id (it had <li>old</li>); the append added the second
            assert.deepEqual([...find('#messages').children].map(li => li.textContent), ['héllo', 'how are you?']);
            assert.deepEqual(got.signals.patch, {name: 'Ana', online: 3});
            assert.deepEqual(got.event, {id: 42});
            assert.equal(find('#chart').innerHTML, '<circle cx="10" cy="10" r="4"></circle>');
            assert.equal(find('#chart').firstChild.namespaceURI, 'http://www.w3.org/2000/svg');
            assert.notExists(find('#typing'));
            assert.equal(c.cancelled, true, 'a redirect closes the stream');
        });

        it('the SDK retry field sets the first reconnection delay', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 40\n\n');
            let delays = [];
            on('ypy:stream:reconnect', e => delays.push(e.detail.delay));
            await c.flush();
            c.end();
            await until(() => srv.conns.length == 2);
            assert.isAtMost(delays[0], 40);
            assert.isAtLeast(delays[0], 30);
        });
    });

    describe('framing', function () {

        // the same frame in every spelling of the line ends, in two chunks cut at every position
        for (let [name, nl] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
            it(`${name}: a frame split at any byte`, async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
                let frame = `: a comment${nl}event: ypy-patch-elements${nl}data: selector #x${nl}data: mode inner${nl}data: elements <b>é</b>${nl}${nl}`;
                let bytes = enc.encode(frame);
                for (let cut = 1; cut < bytes.length; cut++) {
                    find('#x').textContent = '0';
                    c.send(bytes.slice(0, cut));
                    c.send(bytes.slice(cut));
                    await c.flush();
                    assert.equal(html('#x'), '<b>é</b>', `cut at ${cut}`);
                }
            });
        }

        it('ignores comments, unknown fields, unknown events and keys; reads fields without a space', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            c.send(': keepalive\n\nfoo: bar\nevent:unknown\ndata:whatever\n\n');
            c.send('event:ypy-patch-elements\ndata:selector #x\ndata:mode inner\ndata:colour red\ndata:elements ok\n\n');
            await c.flush();
            assert.equal(html('#x'), 'ok');
        });

        it('drops a leading BOM and ignores a last frame that has no blank line', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            c.send(new Uint8Array([0xEF, 0xBB, 0xBF, ...enc.encode('event: ypy-patch-elements\ndata: selector #x\ndata: mode inner\ndata: elements bom\n\n')]));
            await c.flush();
            assert.equal(html('#x'), 'bom');
            c.send('event: ypy-patch-elements\ndata: selector #x\ndata: mode inner\ndata: elements unfinished\n');
            await ypy.timeout(20);
            assert.equal(html('#x'), 'bom');
        });

        it('joins a repeated key with a line feed and keeps the leading spaces of a value', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><pre id="x"></pre></div>`);
            c.send('event: ypy-patch-elements\ndata: selector #x\ndata: mode inner\ndata: elements   a\ndata: elements b\ndata: elements \ndata: elements c\n\n');
            await c.flush();
            assert.equal(find('#x').textContent, '  a\nb\n\nc');
        });
    });

    // ---- ypy-patch-elements -------------------------------------------------------------------

    describe('ypy-patch-elements', function () {

        const CASES = [
            ['outer', '#b', '<li id="b" class="x">B2</li>', '<li id="a">A</li><li id="b" class="x">B2</li><li id="c">C</li>'],
            ['inner', '#b', '<i>B2</i>', '<li id="a">A</li><li id="b"><i>B2</i></li><li id="c">C</li>'],
            ['replace', '#b', '<li id="z">Z</li><li id="y">Y</li>', '<li id="a">A</li><li id="z">Z</li><li id="y">Y</li><li id="c">C</li>'],
            ['append', '#l', '<li id="d">D</li>', '<li id="a">A</li><li id="b">B</li><li id="c">C</li><li id="d">D</li>'],
            ['prepend', '#l', '<li id="d">D</li>', '<li id="d">D</li><li id="a">A</li><li id="b">B</li><li id="c">C</li>'],
            ['before', '#b', '<li id="d">D</li>', '<li id="a">A</li><li id="d">D</li><li id="b">B</li><li id="c">C</li>'],
            ['after', '#b', '<li id="d">D</li>', '<li id="a">A</li><li id="b">B</li><li id="d">D</li><li id="c">C</li>'],
            ['remove', '#b', null, '<li id="a">A</li><li id="c">C</li>']
        ];
        for (let [mode, selector, elements, expected] of CASES) {
            it(`mode ${mode} with a selector`, async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room">${LIST}</div>`);
                c.patch({mode, selector}, elements);
                await c.flush();
                assert.equal(html('#l'), expected);
            });
        }

        it('the default mode is outer, and it morphs: focus, selection and typed text survive', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><form id="f"><input id="i" value="a"><span id="n">1</span></form></div>`);
            let input = find('#i');
            input.focus();
            input.value = 'typed here';
            input.setSelectionRange(2, 5);
            c.patch({selector: '#f'}, '<form id="f"><input id="i" value="a"><span id="n">2</span></form>');
            await c.flush();
            assert.equal(html('#n'), '2');
            assert.strictEqual(find('#i'), input, 'the same input node');
            assert.equal(document.activeElement, input);
            assert.equal(input.value, 'typed here');
            assert.equal(input.selectionStart, 2);
            assert.equal(input.selectionEnd, 5);
        });

        it('a selector that matches several elements patches each of them', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room">${LIST}</div>`);
            c.patch({mode: 'append', selector: '#l li'}, '<b>!</b>');
            await c.flush();
            assert.equal(html('#l'), '<li id="a">A<b>!</b></li><li id="b">B<b>!</b></li><li id="c">C<b>!</b></li>');
        });

        it('takes the extended selectors of YPY', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">x</p></div>`);
            c.patch({mode: 'inner', selector: 'this'}, '<i>self</i>');
            await c.flush();
            assert.equal(html('#room'), '<i>self</i>');
        });

        describe('without a selector the top-level ids place the elements', function () {
            it('outer: each element morphs the page element with its id', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room">${LIST}<p id="p">p</p></div>`);
                c.patch({}, '<li id="a">A2</li>\n<p id="p" class="k">p2</p>');
                await c.flush();
                assert.equal(html('#a'), 'A2');
                assert.equal(find('#p').outerHTML, '<p id="p" class="k">p2</p>');
            });
            it('replace and remove take the element itself', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room">${LIST}</div>`);
                c.patch({mode: 'replace'}, '<li id="a"><b>A</b></li>');
                await c.flush();
                assert.equal(html('#a'), '<b>A</b>');
                c.patch({mode: 'remove'}, '<li id="b"></li>');
                await c.flush();
                assert.notExists(find('#b'));
            });
            it('inner and append take the children of the element', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room">${LIST}</div>`);
                c.patch({mode: 'inner'}, '<li id="a"><i>1</i></li>');
                c.patch({mode: 'append'}, '<li id="b"><i>2</i></li>');
                await c.flush();
                assert.equal(html('#a'), '<i>1</i>');
                assert.equal(html('#b'), 'B<i>2</i>');
            });
            it('an element with no id, or an id not on the page, is reported and the others go on', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room">${LIST}</div>`);
                let misses = [];
                on('ypy:target:missing', e => { e.preventDefault(); misses.push([e.detail.type, e.detail.selector]) });
                c.patch({}, '<li>no id</li><li id="ghost">g</li><li id="a">A2</li>');
                await c.flush();
                assert.deepEqual(misses, [['stream', ''], ['stream', '#ghost']]);
                assert.equal(html('#a'), 'A2');
            });
        });

        describe('a target that is not there', function () {
            it('fires ypy:target:missing with type "stream" and the selector, then goes on', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
                let seen = [];
                on('ypy:target:missing', e => { e.preventDefault(); seen.push(e.detail) });
                c.patch({selector: '#nope', mode: 'inner'}, 'x');
                c.patch({selector: '#x', mode: 'inner'}, 'next');
                await c.flush();
                assert.equal(seen.length, 1);
                assert.equal(seen[0].type, 'stream');
                assert.equal(seen[0].selector, '#nope');
                assert.equal(html('#x'), 'next');
            });
            it('warns in the console unless a listener cancels the event', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
                let warns = [], w = console.warn;
                console.warn = (...a) => warns.push(a[0]);
                try {
                    c.patch({selector: '#nope'}, '<i></i>');
                    await c.flush();
                } finally { console.warn = w }
                assert.isTrue(warns.some(m => /#nope/.test(m)), 'warned');
            });
        });

        describe('namespaces', function () {
            it('svg: a fragment such as <circle> becomes an SVG element', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><svg id="s"><g id="g"></g></svg></div>`);
                c.patch({mode: 'append', selector: '#g', namespace: 'svg'}, '<circle r="4"/><rect width="2" height="2"/>');
                await c.flush();
                let kids = [...find('#g').children];
                assert.deepEqual(kids.map(k => k.localName), ['circle', 'rect']);
                assert.isTrue(kids.every(k => k.namespaceURI == 'http://www.w3.org/2000/svg'));
            });
            it('svg: outer morph of an element and an empty inner patch', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><svg id="s"><g id="g"><circle r="1"/></g></svg></div>`);
                c.patch({selector: '#g', namespace: 'svg'}, '<g id="g" class="on"><circle r="9"/></g>');
                await c.flush();
                assert.equal(find('#g').getAttribute('class'), 'on');
                assert.equal(find('#g circle').getAttribute('r'), '9');
                c.patch({mode: 'inner', selector: '#g', namespace: 'svg'}, '');
                await c.flush();
                assert.equal(find('#g').children.length, 0);
            });
            it('svg without a selector matches by id', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><svg id="s"><circle id="k" r="1"/></svg></div>`);
                c.patch({namespace: 'svg'}, '<circle id="k" r="7"/>');
                await c.flush();
                assert.equal(find('#k').getAttribute('r'), '7');
                assert.equal(find('#k').namespaceURI, 'http://www.w3.org/2000/svg');
            });
            it('mathml', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><math id="m"></math></div>`);
                c.patch({mode: 'append', selector: '#m', namespace: 'mathml'}, '<mi>x</mi>');
                await c.flush();
                assert.equal(find('#m').firstChild.namespaceURI, 'http://www.w3.org/1998/Math/MathML');
            });
            it('an unknown namespace or mode is reported as an error and the stream goes on', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
                let errors = [];
                on('ypy:stream:error', e => errors.push(e.detail.error.message));
                await quiet(async () => {
                    c.patch({selector: '#x', namespace: 'xml'}, '<i/>');
                    c.patch({selector: '#x', mode: 'nonsense'}, '<i/>');
                    c.patch({selector: '#x', mode: 'inner'}, 'fine');
                    await c.flush();
                });
                assert.equal(errors.length, 2);
                assert.match(errors[0], /namespace/);
                assert.match(errors[1], /mode/);
                assert.equal(html('#x'), 'fine');
            });
        });

        describe('view transitions', function () {
            it('useViewTransition true applies the patch inside document.startViewTransition', async function () {
                let calls = 0;
                document.startViewTransition = fn => { calls++; let done = Promise.resolve(fn()); return {finished: done, ready: done, updateCallbackDone: done} };
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
                c.patch({selector: '#x', mode: 'inner', useViewTransition: 'true'}, 'vt');
                await c.flush();
                assert.equal(html('#x'), 'vt');
                assert.equal(calls, 1);
                c.patch({selector: '#x', mode: 'inner'}, 'plain');
                await c.flush();
                assert.equal(html('#x'), 'plain');
                assert.equal(calls, 1, 'off by default');
            });
            it('without View Transitions in the browser the patch is applied all the same', async function () {
                delete document.startViewTransition;
                Object.defineProperty(document, 'startViewTransition', {value: undefined, configurable: true});
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
                c.patch({selector: '#x', mode: 'inner', useViewTransition: 'true'}, 'ok');
                await c.flush();
                assert.equal(html('#x'), 'ok');
            });
        });

        describe('the swap pipeline', function () {
            it('a script in a patch is re-created by the swap, as in a response (so nonce gating and Trusted Types apply)', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="x"></div></div>`);
                delete window.__streamScript;
                c.patch({selector: '#x', mode: 'inner'}, '<b>b</b><script>window.__streamScript = 1</script>');
                await c.flush();
                assert.equal(find('#x b').textContent, 'b');
                assert.equal(window.__streamScript, 1);
                delete window.__streamScript;
            });
            it('out-of-band elements in a patch go to their own targets', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="x"></div><p id="oob">old</p></div>`);
                c.patch({selector: '#x', mode: 'inner'}, 'main<p id="oob" ypy-swap-oob="true">new</p>');
                await c.flush();
                assert.equal(html('#oob'), 'new');
                assert.equal(html('#x'), 'main');
            });
            it('fires the swap events on the streaming element', async function () {
                let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
                let seen = [];
                find('#room').addEventListener('ypy:after:swap', e => seen.push(e.detail.ctx.target.id));
                c.patch({selector: '#x', mode: 'inner'}, 'a');
                await c.flush();
                assert.deepEqual(seen, ['x']);
            });
        });
    });

    // ---- ypy-patch-signals --------------------------------------------------------------------

    describe('ypy-patch-signals without the signals extension', function () {
        it('fires ypy:stream:signals with the patch and onlyIfMissing', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let seen = [];
            on('ypy:stream:signals', e => seen.push(e.detail));
            c.event('ypy-patch-signals', 'signals {"a":1,"b":{"c":null}}');
            c.event('ypy-patch-signals', 'onlyIfMissing true', 'signals {"a":2}');
            await c.flush();
            assert.deepEqual(seen, [{patch: {a: 1, b: {c: null}}, onlyIfMissing: false}, {patch: {a: 2}, onlyIfMissing: true}]);
        });
        it('a signals value that is not a JSON object is an error; the stream goes on', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            let errors = [];
            on('ypy:stream:error', e => errors.push(e.detail.error));
            await quiet(async () => {
                c.event('ypy-patch-signals', 'signals [1,2]');
                c.event('ypy-patch-signals', 'signals {nope');
                c.event('ypy-patch-signals', 'signals');
                c.patch({selector: '#x', mode: 'inner'}, 'after');
                await c.flush();
            });
            assert.equal(errors.length, 3);
            assert.equal(html('#x'), 'after');
        });
    });

    // ---- ypy-redirect -------------------------------------------------------------------------

    describe('ypy-redirect', function () {
        it('navigate goes through the client and pushes the URL; the stream closes and does not reconnect', async function () {
            keepPage();
            mockResponse('GET', '/next', '<p>next page</p>');
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.event('ypy-redirect', 'url /next');
            await until(() => location.pathname == '/next');
            assert.isTrue(c.cancelled);
            await ypy.timeout(60);
            assert.equal(srv.conns.length, 1, 'no reconnection');
            assert.equal(ypy.stream.stats().open, 0);
        });
        it('replace replaces the history entry', async function () {
            keepPage();
            mockResponse('GET', '/rep', '<p>r</p>');
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let len = history.length;
            c.event('ypy-redirect', 'url /rep', 'mode replace');
            await until(() => location.pathname == '/rep');
            assert.equal(history.length, len);
        });
        it('hard loads the page: it does not use the client', async function () {
            saved._loc = ypy._loc;
            let loc = ypy._loc = {href: 'before', reload() {}};
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.event('ypy-redirect', 'url /away', 'mode hard');
            await until(() => loc.href != 'before');
            assert.equal(new URL(loc.href).pathname, '/away');
            assert.equal(srv.calls().length, 1);
            assert.isTrue(c.cancelled);
        });
        it('refuses another origin (selfRequestsOnly) and a URL that is not http(s); the stream stays', async function () {
            saved._loc = ypy._loc;
            let loc = ypy._loc = {href: 'before'};
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let errors = [];
            on('ypy:stream:error', e => errors.push(e.detail.error.message));
            await quiet(async () => {
                c.event('ypy-redirect', 'url https://elsewhere.example/x', 'mode hard');
                c.event('ypy-redirect', 'url //elsewhere.example/x');
                c.event('ypy-redirect', 'url javascript:alert(1)', 'mode hard');
                c.event('ypy-redirect', 'url /ok', 'mode sideways');
                c.event('ypy-redirect', 'mode hard');
                await c.flush();
            });
            assert.equal(errors.length, 5);
            assert.equal(loc.href, 'before');
            assert.isFalse(c.cancelled);
            assert.equal(location.pathname, new URL(savedUrl).pathname);
        });
    });

    // ---- ypy-event ----------------------------------------------------------------------------

    describe('ypy-event', function () {
        it('fires a CustomEvent on the document with the detail, bubbling and cancelable', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let seen;
            on('msg:new', e => { seen = e; e.preventDefault() });
            c.event('ypy-event', 'name msg:new', 'detail {"id":42,"tags":["a"]}');
            await c.flush();
            assert.deepEqual(seen.detail, {id: 42, tags: ['a']});
            assert.isTrue(seen.bubbles);
            assert.isTrue(seen.cancelable);
            assert.equal(seen.target, document);
        });
        it('with a selector it fires on the first match; the name has no prefix', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><i id="a"></i><i id="b"></i></div>`);
            let targets = [];
            on('ping', e => targets.push(e.target.id));
            c.event('ypy-event', 'name ping', 'selector #room i');
            await c.flush();
            assert.deepEqual(targets, ['a']);
        });
        it('without detail the detail is empty; a missing selector target is reported like a patch', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let seen = [], misses = [];
            on('bare', e => seen.push(e.detail));
            on('ypy:target:missing', e => { e.preventDefault(); misses.push(e.detail) });
            c.event('ypy-event', 'name bare');
            c.event('ypy-event', 'name bare', 'selector #nowhere');
            await c.flush();
            assert.equal(seen.length, 1);
            assert.equal(misses[0].type, 'stream');
            assert.equal(misses[0].selector, '#nowhere');
        });
    });

    // ---- opening a stream ---------------------------------------------------------------------

    describe('ypy-stream attribute', function () {
        it('opens on load, with the YPY headers and an Accept for event streams', async function () {
            let [srv] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let h = srv.calls()[0].request.headers;
            assert.equal(h['YPY-Request'], 'true');
            assert.equal(h['YPY-Source'], 'div#room');
            assert.equal(h.Accept, 'text/event-stream');
            assert.isUndefined(h['Last-Event-ID']);
            assert.equal(srv.calls()[0].request.method, 'GET');
        });
        it('also takes the data- prefix', async function () {
            let srv = server(/^\/dp/);
            createProcessedHTML(`<div data-ypy-stream="/dp"></div>`);
            await until(() => srv.conns.length);
        });
        it('opens on the trigger it names, once', async function () {
            let srv = server(/^\/click/);
            createProcessedHTML(`<button ypy-stream="/click" ypy-trigger="click">go</button>`);
            await ypy.timeout(20);
            assert.equal(srv.conns.length, 0);
            find('button').click();
            await until(() => srv.conns.length == 1);
            find('button').click();
            await ypy.timeout(30);
            assert.equal(srv.conns.length, 1, 'a live stream is not opened twice');
        });
        for (let verb of ['post', 'put', 'patch', 'delete']) {
            it(`ypy-stream.${verb} opens with that method`, async function () {
                let srv = server(new RegExp('^/v-' + verb), verb.toUpperCase());
                createProcessedHTML(`<div ypy-stream.${verb}="/v-${verb}"></div>`);
                await until(() => srv.conns.length);
                assert.equal(fetchMock.getCalls().find(c => c.url.startsWith('/v-' + verb)).request.method, verb.toUpperCase());
            });
        }
        it('a POST stream sends the values of its form', async function () {
            let srv = server(/^\/job/, 'POST');
            createProcessedHTML(`<form ypy-stream.post="/job" ypy-trigger="submit"><input name="n" value="7"></form>`);
            find('form').requestSubmit();
            await until(() => srv.conns.length);
            assert.equal(String(srv.calls()[0].request.body), 'n=7');
        });
        it('streams in swapped-in content open too', async function () {
            let srv = server(/^\/late/);
            createProcessedHTML(`<div id="host"></div>`);
            ypy.process(playground());
            find('#host').innerHTML = '<div ypy-stream="/late"></div>';
            ypy.process(find('#host'));
            await until(() => srv.conns.length);
        });
        it('an element under ypy-ignore does not open', async function () {
            let srv = server(/^\/ign/);
            createProcessedHTML(`<div ypy-ignore><div ypy-stream="/ign"></div></div>`);
            await ypy.timeout(40);
            assert.equal(srv.conns.length, 0);
        });
        it('ypy-headers and ypy-vals travel with every connection', async function () {
            let srv = server(/^\/hv/);
            createProcessedHTML(`<div ypy-stream="/hv" ypy-headers='{"X-Room":"7"}' ypy-vals='{"room":"7"}'></div>`);
            await until(() => srv.conns.length);
            assert.equal(srv.calls()[0].request.headers['X-Room'], '7');
            assert.include(srv.calls()[0].url, 'room=7');
            srv.conns[0].end();
            await until(() => srv.conns.length == 2);
            assert.equal(srv.calls()[1].request.headers['X-Room'], '7');
            assert.include(srv.calls()[1].url, 'room=7');
        });
    });

    describe('routing by Content-Type', function () {
        it('a normal request whose answer is an event stream is read as a stream', async function () {
            let srv = server(/^\/btn/);
            createProcessedHTML(`<button id="b" ypy-get="/btn">go</button><p id="x">0</p>`);
            find('#b').click();
            await until(() => srv.conns.length);
            srv.conns[0].patch({selector: '#x', mode: 'inner'}, 'streamed');
            await srv.conns[0].flush();
            assert.equal(html('#x'), 'streamed');
            assert.equal(find('#b').textContent, 'go', 'the stream is not swapped into the button');
        });
        it('the stream does not hold the request queue of its element', async function () {
            let srv = server(/^\/btn/);
            mockResponse('GET', '/other', 'other');
            createProcessedHTML(`<button id="b" ypy-get="/btn">go</button>`);
            find('#b').click();
            await until(() => srv.conns.length);
            ypy.ajax('GET', '/other', {source: find('#b'), target: find('#b')});
            await until(() => fetchMock.getCalls().some(c => c.url == '/other'));
            assert.equal(find('#b').textContent, 'other');
        });
        it('opening again from the same element replaces the stream', async function () {
            let srv = server(/^\/btn/);
            createProcessedHTML(`<button id="b" ypy-get="/btn">go</button>`);
            find('#b').click();
            await until(() => srv.conns.length == 1);
            find('#b').click();
            await until(() => srv.conns.length == 2);
            assert.isTrue(srv.conns[0].cancelled);
            assert.equal(ypy.stream.stats().open, 1);
            await ypy.timeout(60);
            assert.equal(srv.conns.length, 2, 'the replaced stream does not reconnect');
        });
        it('a status other than 200 is not a stream, even with the event-stream type', async function () {
            let srv = server(/^\/btn/);
            srv.plan.push({status: 503, type: 'text/event-stream', body: 'event: ypy-event\ndata: name never\n\n'});
            createProcessedHTML(`<button id="b" ypy-get="/btn">go</button>`);
            let fired = false;
            on('never', () => fired = true);
            await quiet(async () => { find('#b').click(); await forRequest(); });
            await ypy.timeout(30);
            assert.isFalse(fired);
            assert.equal(ypy.stream.stats().open, 0);
        });
        it('text/html and application/json answers are left to the core', async function () {
            mockResponse('GET', '/html', '<b>html</b>');
            createProcessedHTML(`<button id="b" ypy-get="/html" ypy-swap="innerHTML">go</button>`);
            find('#b').click();
            await forRequest();
            assert.equal(find('#b').innerHTML, '<b>html</b>');
            assert.equal(ypy.stream.stats().open, 0);
        });
    });

    // ---- reconnection -------------------------------------------------------------------------

    describe('reconnection', function () {

        it('reconnects when the server closes the stream, with Last-Event-ID and the same request', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            c.send('retry: 10\n\n');
            c.send('id: 42\nevent: ypy-event\ndata: name t:id\n\n');
            c.patch({selector: '#x', mode: 'inner'}, 'first');
            await c.flush();
            c.end();
            await until(() => srv.conns.length == 2);
            let h = srv.calls()[1].request.headers;
            assert.equal(h['Last-Event-ID'], '42');
            assert.equal(h['YPY-Request'], 'true');
            assert.equal(srv.calls()[1].request.method, 'GET');
            // the fat morph: the server repeats the state and the page ends right
            srv.conns[1].patch({selector: '#x', mode: 'inner'}, 'again');
            await srv.conns[1].flush();
            assert.equal(html('#x'), 'again');
        });

        it('an id sent without data is remembered, and an empty id clears it', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 10\n\nid: 9\n\n');
            await c.flush();
            c.end();
            await until(() => srv.conns.length == 2);
            assert.equal(srv.calls()[1].request.headers['Last-Event-ID'], '9');
            srv.conns[1].send('id\n\n');
            await srv.conns[1].flush();
            srv.conns[1].end();
            await until(() => srv.conns.length == 3);
            assert.notOk(srv.calls()[2].request.headers['Last-Event-ID']);
        });

        it('the delay doubles on each failed attempt from the retry value, with jitter, and starts over', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 20\n\n');
            await c.flush();
            let delays = [];
            on('ypy:stream:reconnect', e => delays.push(e.detail.delay));
            srv.plan.push({fail: true}, {fail: true}, {fail: true});
            await quiet(async () => {
                c.end();
                await until(() => srv.conns.length == 2, 3000);
            });
            let bases = [20, 20, 40, 80];
            assert.equal(delays.length, 4);
            delays.forEach((d, i) => {
                assert.isAtMost(d, bases[i], 'delay ' + i);
                assert.isAtLeast(d, bases[i] * 0.75, 'delay ' + i);
            });
            // the connection delivered an event: the next outage starts again at the retry value
            srv.conns[1].event('ypy-event', 'name t:alive');
            await srv.conns[1].flush();
            delays.length = 0;
            srv.conns[1].end();
            await until(() => srv.conns.length == 3);
            assert.equal(delays.length, 1);
            assert.isAtMost(delays[0], 20);
        });

        it('the delay never passes 30 seconds', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let st = find('#room')._ypy.stream;
            st.att = 40;
            let delays = [];
            on('ypy:stream:reconnect', e => delays.push(e.detail.delay));
            c.end();
            await until(() => delays.length);
            assert.isAtMost(delays[0], 30000);
            assert.isAtLeast(delays[0], 22500);
            ypy.stream.close(find('#room'));
        });

        it('a 204 on reconnection stops the stream for good', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 10\n\n');
            await c.flush();
            srv.plan.push({status: 204});
            let closed = once('ypy:stream:close');
            c.end();
            let e = await closed;
            assert.equal(e.detail.reason, 'status 204');
            await ypy.timeout(60);
            assert.equal(srv.calls().length, 2);
            assert.equal(ypy.stream.stats().open, 0);
        });

        it('another status on reconnection is an error answer: handled by the core, not retried', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 10\n\n');
            await c.flush();
            srv.plan.push({status: 500, body: 'oops'});
            let closed = once('ypy:stream:close');
            await quiet(async () => { c.end(); await closed });
            await ypy.timeout(60);
            assert.equal(srv.calls().length, 2);
        });

        it('a page that is not a stream on reconnection stops it', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 10\n\n');
            await c.flush();
            srv.plan.push({status: 200, type: 'text/html', body: '<p>login</p>'});
            let closed = once('ypy:stream:close');
            c.end();
            assert.equal((await closed).detail.reason, 'status 200');
        });

        it('a network error while reading reconnects', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 10\n\n');
            await c.flush();
            let errs = [];
            on('ypy:stream:error', e => errs.push(e));
            await quiet(async () => {
                c.ctrl.error(new TypeError('network error'));
                await until(() => srv.conns.length == 2);
            });
            assert.equal(errs.length, 1);
        });

        it('while the browser is offline it waits for the online event, without counting attempts', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 10\n\n');
            await c.flush();
            Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => false});
            let delays = [];
            on('ypy:stream:reconnect', e => delays.push(e));
            c.end();
            await ypy.timeout(120);
            assert.equal(srv.calls().length, 1, 'no request while offline');
            assert.equal(delays.length, 0);
            delete navigator.onLine;
            window.dispatchEvent(new Event('online'));
            await until(() => srv.conns.length == 2);
        });

        it('the signals sent are the current ones at every attempt', async function () {
            await load('../src/ext/ypy-signals.js');
            let [srv, c] = await openRoom(`<div ypy-signals="n:1"><div id="room" ypy-stream="/sig"></div></div>`, '/sig');
            assert.include(decodeURIComponent(srv.calls()[0].url), '"n":1');
            c.send('retry: 10\n\n');
            c.event('ypy-patch-signals', 'signals {"n":2,"fresh":true}');
            await c.flush();
            c.end();
            await until(() => srv.conns.length == 2);
            let url = decodeURIComponent(srv.calls()[1].url);
            assert.include(url, '"n":2');
            assert.include(url, '"fresh":true');
        });
    });

    // ---- closing ------------------------------------------------------------------------------

    describe('closing', function () {
        it('ypy.stream.close ends the stream and does not reconnect', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            let closed = once('ypy:stream:close');
            ypy.stream.close(find('#room'));
            assert.equal((await closed).detail.reason, 'api');
            assert.isTrue(c.cancelled);
            await ypy.timeout(60);
            assert.equal(srv.conns.length, 1);
            assert.isUndefined(find('#room')._ypy.stream);
        });
        it('removing the element closes the stream', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            find('#room').remove();
            await until(() => c.cancelled);
            await ypy.timeout(40);
            assert.equal(srv.conns.length, 1);
            assert.equal(ypy.stream.stats().open, 0);
        });
        it('a swap that removes the element closes it, through the core cleanup', async function () {
            let [, c] = await openRoom(`<div id="host"><div id="room" ypy-stream="/room"></div></div><div id="tail"></div>`);
            ypy.swap({sourceElement: find('#host'), target: find('#host'), swap: 'innerHTML', text: '<p>gone</p>'});
            await until(() => c.cancelled);
            assert.equal(ypy.stream.stats().open, 0);
        });
        it('a morph of the streaming element itself, or of its ancestors, keeps the stream', async function () {
            let [srv, c] = await openRoom(`<div id="host"><div id="room" ypy-stream="/room" class="a"><p id="x">0</p></div></div>`);
            c.patch({selector: '#room'}, '<div id="room" ypy-stream="/room" class="b"><p id="x">1</p></div>');
            await c.flush();
            assert.equal(find('#room').className, 'b');
            c.patch({selector: '#host', mode: 'inner'}, '<div id="room" ypy-stream="/room" class="c"><p id="x">2</p></div>');
            await c.flush();
            assert.equal(find('#room').className, 'c');
            assert.isFalse(c.cancelled);
            assert.equal(ypy.stream.stats().open, 1);
            c.patch({selector: '#x', mode: 'inner'}, 'still here');
            await c.flush();
            assert.equal(html('#x'), 'still here');
            assert.equal(srv.conns.length, 1);
        });
        it('a patch of mode remove on the streaming element ends it', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.patch({mode: 'remove', selector: '#room'});
            await until(() => c.cancelled);
            await ypy.timeout(40);
            assert.equal(srv.conns.length, 1);
        });
        it('an element removed before the answer arrives never becomes a stream', async function () {
            let srv = server(/^\/slow/);
            srv.delay = 60;
            createProcessedHTML(`<div id="room" ypy-stream="/slow"></div>`);
            await ypy.timeout(10);
            find('#room').remove();
            await ypy.timeout(150);
            assert.equal(ypy.stream.stats().open, 0);
            assert.isAtMost(srv.conns.length, 1, 'no reconnection');
        });
        it('a stream whose element left while it waited to reconnect does not reconnect', async function () {
            let [srv, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            c.send('retry: 80\n\n');
            await c.flush();
            c.end();
            await ypy.timeout(5);
            find('#room').remove();
            await ypy.timeout(150);
            assert.equal(srv.conns.length, 1);
            assert.equal(ypy.stream.stats().open, 0);
        });
        it('an event applied after the element is gone does nothing and does not throw', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            let room = find('#room');
            room.remove();
            c.patch({selector: '#x'}, '<p id="x">1</p>');
            await ypy.timeout(30);
            assert.isTrue(c.cancelled);
        });
        it('200 streams opened and closed leave nothing behind', async function () {
            this.timeout(10000);
            let srv = server(/^\/leak/);
            let elts = [];
            for (let i = 0; i < 200; i++) {
                let el = document.createElement('div');
                el.setAttribute('ypy-stream', '/leak?' + i);
                playground().append(el);
                ypy.process(el);
                elts.push(el);
            }
            await until(() => srv.conns.length == 200, 5000);
            assert.equal(ypy.stream.stats().open, 200);
            for (let i = 0; i < 200; i++) {
                if (i % 3 == 0) ypy.stream.close(elts[i]);
                else if (i % 3 == 1) elts[i].remove();
                else srv.conns[i].end();   // the server ends it: it reconnects ...
            }
            await until(() => srv.conns.filter(c => c.cancelled).length >= 134, 3000);
            // ... and the ones that reconnected are closed too
            await until(() => srv.conns.length > 200, 4000);
            for (let el of elts) ypy.stream.close(el);
            await until(() => ypy.stream.stats().open == 0, 3000);
            await until(() => srv.conns.every(c => c.cancelled || c.closed), 3000);
            let total = srv.conns.length;
            await ypy.timeout(150);
            assert.equal(srv.conns.length, total, 'nothing reconnects after the close');
            assert.equal(ypy.stream.stats().open, 0);
            assert.isTrue(elts.every(el => !el._ypy?.stream));
        });
    });

    // ---- errors -------------------------------------------------------------------------------

    describe('errors', function () {
        it('an event that fails fires ypy:stream:error and the stream goes on with the next one', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            let errors = [];
            on('ypy:stream:error', e => errors.push(e.detail.error));
            await quiet(async () => {
                c.event('ypy-event', 'name t:x', 'detail {broken');
                c.patch({selector: '#x', mode: 'inner'}, 'ok');
                await c.flush();
            });
            assert.equal(errors.length, 1);
            assert.instanceOf(errors[0], SyntaxError);
            assert.equal(html('#x'), 'ok');
        });
        it('an invalid selector is an error, not a crash', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            let errors = [];
            on('ypy:stream:error', e => errors.push(e));
            await quiet(async () => {
                c.patch({selector: '#x[', mode: 'inner'}, 'a');
                c.patch({selector: '#x', mode: 'inner'}, 'b');
                await c.flush();
            });
            assert.equal(errors.length, 1);
            assert.equal(html('#x'), 'b');
        });
        it('prototype-looking keys are plain data', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            c.patch({selector: '#x', mode: 'inner', constructor: 'y', toString: 'z'}, 'fine');
            c.event('ypy-patch-elements', '__proto__ polluted', 'selector #x', 'mode inner', 'elements fine2');
            await c.flush();
            assert.equal(html('#x'), 'fine2');
            assert.isUndefined({}.polluted);
        });
        it('the unknown frames of a stream with no event name are ignored', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p id="x">0</p></div>`);
            c.send('data: just text\n\ndata: selector #x\n\n');
            await c.flush();
            assert.equal(html('#x'), '0');
        });
    });

    // ---- with the other extensions ------------------------------------------------------------

    describe('ypy-patch-signals with the signals extension', function () {
        before(async () => { if (!ypy.signals) await load('../src/ext/ypy-signals.js') });

        it('applies a merge patch in reach of the streaming element', async function () {
            let [, c] = await openRoom(`<div ypy-signals="count:1, name:'a'"><div id="room" ypy-stream="/room"><b id="v" ypy-text="$count"></b><i id="n" ypy-text="$name"></i></div></div>`);
            c.event('ypy-patch-signals', 'signals {"count":5}');
            await c.flush();
            await until(() => find('#v').textContent == '5');
            assert.equal(ypy.signals.get('count', find('#room')), 5);
        });
        it('null deletes, objects merge', async function () {
            let [, c] = await openRoom(`<div ypy-signals='{"user":{"name":"a","age":1},"gone":1}'><div id="room" ypy-stream="/room"></div></div>`);
            c.event('ypy-patch-signals', 'signals {"user":{"age":null,"city":"x"},"gone":null}');
            await c.flush();
            assert.deepEqual(ypy.signals.get('user', find('#room')), {name: 'a', city: 'x'});
            assert.isUndefined(ypy.signals.get('gone', find('#room')));
        });
        it('onlyIfMissing keeps what exists, at every level, and sets the rest', async function () {
            let [, c] = await openRoom(`<div ypy-signals="theme:'dark'"><div id="room" ypy-stream="/room"></div></div>`);
            c.event('ypy-patch-signals', 'onlyIfMissing true', 'signals {"theme":"light","page":1}');
            await c.flush();
            assert.equal(ypy.signals.get('theme', find('#room')), 'dark');
            assert.equal(ypy.signals.get('page', find('#room')), 1);
        });
        it('does not fire ypy:stream:signals when the extension applied the patch', async function () {
            let [, c] = await openRoom(`<div ypy-signals="a:1"><div id="room" ypy-stream="/room"></div></div>`);
            let fired = false;
            on('ypy:stream:signals', () => fired = true);
            c.event('ypy-patch-signals', 'signals {"a":2}');
            await c.flush();
            assert.isFalse(fired);
        });
        it('a signals patch can name a local signal', async function () {
            let [, c] = await openRoom(`<div ypy-signals="_open:false"><div id="room" ypy-stream="/room"></div></div>`);
            c.event('ypy-patch-signals', 'signals {"_open":true}');
            await c.flush();
            assert.isTrue(ypy.signals.get('_open', find('#room')));
        });
    });

    describe('next to ypy-sse', function () {
        before(async () => { await load('../src/ext/ypy-sse.js') });

        it('an element that names ypy-sse:connect stays with it; the others are read by the protocol', async function () {
            let sse = mockStreamResponse('/old');
            let srv = server(/^\/new/);
            createProcessedHTML(`<div id="o" ypy-sse:connect="/old" ypy-swap="innerHTML"></div><div id="n" ypy-stream="/new"><p id="x">0</p></div>`);
            await until(() => srv.conns.length);
            sse.send('plain message');
            await until(() => find('#o').textContent == 'plain message');
            srv.conns[0].patch({selector: '#x', mode: 'inner'}, 'protocol');
            await srv.conns[0].flush();
            assert.equal(html('#x'), 'protocol');
            assert.equal(ypy.stream.stats().open, 1, 'only the protocol element is a stream here');
            sse.close();
        });
    });
});
