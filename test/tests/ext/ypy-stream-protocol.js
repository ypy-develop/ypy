// SPDX-License-Identifier: MIT
// ypy-stream: the lists of ypy-patch-elements (key and limit), the ypy-refresh event and the pause of a
// stream while the tab is in the background (spec/PROTOCOL.md of the Go SDK, sections 5.3, 5.7 and 6.4).
// The server is a fake: a mocked fetch whose answers are streams the test writes to.
describe('ypy-stream lists, refresh and pause', function () {

    let extBackup, saved = [], listeners = [], hidden = false;

    const load = src => new Promise(resolve => {
        let script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        document.head.appendChild(script);
    });

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        await load('../src/ext/ypy-stream.js');
    });
    after(() => { restoreExtensions(extBackup) });

    beforeEach(() => {
        setupTest(this.currentTest);
        hidden = false;
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
    });
    afterEach(() => {
        for (let [name, fn] of listeners) document.removeEventListener(name, fn);
        listeners = [];
        delete document.hidden;
        cleanupTest();
    });

    const enc = new TextEncoder();
    const until = async (fn, ms = 1500) => {
        let t = Date.now();
        while (Date.now() - t < ms) { let v = fn(); if (v) return v; await ypy.timeout(2) }
        throw new Error('timed out waiting for ' + fn);
    };
    const once = (name, ms = 1000) => new Promise((resolve, reject) => {
        let id = setTimeout(() => reject(new Error('no ' + name)), ms);
        document.addEventListener(name, e => { clearTimeout(id); resolve(e) }, {once: true});
    });
    const on = (name, fn) => { document.addEventListener(name, fn); listeners.push([name, fn]) };
    const html = sel => find(sel).innerHTML;
    const setHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')) };

    // The stream of /room, one connection per fetch, and the plain pages for the other URLs.
    function server() {
        let s = {conns: [], calls: () => fetchMock.getCalls().filter(c => /^\/room/.test(c.url))};
        fetchMock.mockResponse('GET', /^\/room/, () => {
            let c = {cancelled: false};
            let body = new ReadableStream({start(ctrl) { c.ctrl = ctrl }, cancel() { c.cancelled = true }});
            c.send = raw => { try { c.ctrl.enqueue(typeof raw == 'string' ? enc.encode(raw) : raw) } catch {} };
            c.end = () => { try { c.ctrl.close() } catch {} };
            c.event = (name, ...lines) => c.send(`event: ${name}\n` + lines.map(l => `data: ${l}\n`).join('') + '\n');
            c.patch = (k, h) => c.event('ypy-patch-elements',
                ...Object.entries(k).map(([a, b]) => a + ' ' + b), ...(h == null ? [] : h.split('\n').map(l => 'elements ' + l)));
            c.flush = async () => { let p = once('t:flush'); c.event('ypy-event', 'name t:flush'); await p };
            s.conns.push(c);
            return new Response(body, {headers: {'content-type': 'text/event-stream'}});
        });
        return s;
    }
    const answer = (url, body) => fetchMock.mockResponse('GET', new RegExp('^' + url + '$'), () => new Response(body, {headers: {'content-type': 'text/html'}}));
    const others = () => fetchMock.getCalls().filter(c => !/^\/room/.test(c.url)).map(c => c.url);

    async function openRoom(markup) {
        let srv = server(), opened = once('ypy:stream:open');
        createProcessedHTML(markup);
        await opened;
        return [srv, srv.conns[0]];
    }
    const errors = () => { let list = []; on('ypy:stream:error', e => list.push(e.detail.error.message)); return list };

    // ---- key and limit --------------------------------------------------------------------------

    describe('lists: key and limit on append and prepend', function () {
        const LOG = n => `<div id="room" ypy-stream="/room"><ul id="log">${[...Array(n)].map((_, i) => `<li>${i + 1}</li>`).join('')}</ul></div>`;
        const items = () => [...find('#log').children].map(li => li.textContent).join(',');

        it('append with limit: the first items go', async function () {
            let [, c] = await openRoom(LOG(3));
            c.patch({mode: 'append', selector: '#log', limit: 4}, '<li>4</li>\n<li>5</li>');
            await c.flush();
            assert.equal(items(), '2,3,4,5');
        });

        it('prepend with limit: the last items go, and the new ones keep their order', async function () {
            let [, c] = await openRoom(LOG(3));
            c.patch({mode: 'prepend', selector: '#log', limit: 4}, '<li>a</li><li>b</li>');
            await c.flush();
            assert.equal(items(), 'a,b,1,2');
        });

        it('a patch bigger than the limit leaves the newest ones', async function () {
            let [, c] = await openRoom(LOG(1));
            c.patch({mode: 'append', selector: '#log', limit: 2}, '<li>a</li><li>b</li><li>c</li>');
            await c.flush();
            assert.equal(items(), 'b,c');
        });

        it('key replaces an item where it stands and adds a new one at the end', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><ul id="u"><li data-id="1">a</li><li data-id="2">b</li><li data-id="3">c</li></ul></div>`);
            c.patch({mode: 'append', selector: '#u', key: 'data-id'}, '<li data-id="2">B</li><li data-id="4">d</li><li>no key</li>');
            await c.flush();
            assert.equal(html('#u'), '<li data-id="1">a</li><li data-id="2">B</li><li data-id="3">c</li><li data-id="4">d</li><li>no key</li>');
        });

        it('key alone means the id; the same key twice in one patch keeps the last', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><ul id="u"><li id="a">a</li></ul></div>`);
            c.event('ypy-patch-elements', 'mode prepend', 'selector #u', 'key', 'elements <li id="b">1</li><li id="b">2</li><li id="a">A</li>');
            await c.flush();
            assert.equal(html('#u'), '<li id="b">2</li><li id="a">A</li>');
        });

        it('the key is applied before the limit: a replaced item pushes nothing out', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><ul id="u"><li id="a">a</li><li id="b">b</li></ul></div>`);
            c.patch({mode: 'append', selector: '#u', key: 'id', limit: 2}, '<li id="a">A</li>');
            await c.flush();
            assert.equal(html('#u'), '<li id="a">A</li><li id="b">b</li>');
        });

        it('without a selector the list is the page element with the id of the top-level element', async function () {
            let [, c] = await openRoom(LOG(3));
            c.patch({mode: 'append', limit: 3}, '<ul id="log"><li>4</li></ul>');
            await c.flush();
            assert.equal(items(), '2,3,4');
        });

        it('every list a selector matches is bounded', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><ul class="l"><li>1</li><li>2</li></ul><ul class="l"><li>3</li><li>4</li></ul></div>`);
            c.patch({mode: 'append', selector: '.l', limit: 2}, '<li>x</li>');
            await c.flush();
            assert.deepEqual([...document.querySelectorAll('#test-playground .l')].map(l => l.textContent), ['2x', '4x']);
        });

        it('a list in the svg namespace', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><svg><g id="g"><circle id="c1" r="1"/><circle id="c2" r="2"/></g></svg></div>`);
            c.patch({mode: 'append', selector: '#g', namespace: 'svg', limit: 2, key: 'id'}, '<circle id="c2" r="9"/><circle id="c3" r="3"/>');
            await c.flush();
            assert.deepEqual([...find('#g').children].map(e => e.id + ':' + e.getAttribute('r')), ['c2:9', 'c3:3']);
            assert.equal(find('#g').firstChild.namespaceURI, 'http://www.w3.org/2000/svg');
        });

        it('what leaves the list is cleaned up like anything a swap removes', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><ul id="u"><li id="a"><button ypy-get="/x">a</button></li></ul></div>`);
            let gone = once('ypy:before:cleanup');
            c.patch({mode: 'append', selector: '#u', limit: 1}, '<li id="b">b</li>');
            await c.flush();
            assert.equal(html('#u'), '<li id="b">b</li>');
            await gone;
        });

        it('key and limit are ignored in the other modes', async function () {
            let [, c] = await openRoom(LOG(3));
            c.patch({mode: 'inner', selector: '#log', limit: 1, key: 'id'}, '<li>x</li><li>y</li>');
            await c.flush();
            assert.equal(items(), 'x,y');
        });

        for (let [what, k] of [['limit zero', {limit: '0'}], ['limit not a number', {limit: 'many'}], ['limit negative', {limit: '-2'}],
                               ['key with a space', {key: 'data id'}], ['key with a colon', {key: 'a:b'}]]) {
            it(`${what}: reported, and the patch is not applied`, async function () {
                let [, c] = await openRoom(LOG(2));
                let seen = errors();
                c.patch({mode: 'append', selector: '#log', ...k}, '<li>x</li>');
                await c.flush();
                assert.equal(items(), '1,2');
                assert.equal(seen.length, 1);
                assert.match(seen[0], /ypy: stream: (limit|invalid key)/);
            });
        }
    });

    // ---- refresh --------------------------------------------------------------------------------

    describe('ypy-refresh', function () {

        it('fetches the elements of the selector again and morphs: the element, not the page, changes', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="cart" ypy-get="/cart"><input id="q" value="a"><b>0</b></div><p id="other">same</p></div>`);
            answer('/cart', '<input id="q" value="a"><b>3</b>');
            let input = find('#q');
            input.focus();
            input.value = 'typed';
            c.event('ypy-refresh', 'selector #cart', 'debounce 0');
            await until(() => html('#cart').includes('<b>3</b>'));
            assert.strictEqual(find('#q'), input, 'morphed, not replaced');
            assert.equal(input.value, 'typed');
            assert.equal(document.activeElement, input);
            assert.equal(html('#other'), 'same');
            assert.deepEqual(others(), ['/cart']);
        });

        it('a request that carries the YPY headers, with the stream element as its source', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="cart" ypy-get="/cart">0</div></div>`);
            answer('/cart', '1');
            c.event('ypy-refresh', 'selector #cart', 'debounce 0');
            await until(() => html('#cart') == '1');
            let h = fetchMock.getCalls().find(x => x.url == '/cart').request.headers;
            assert.equal(h['YPY-Request'], 'true');
            assert.equal(h['YPY-Source'], 'div#cart');
        });

        it('without a selector it fetches its own page and morphs it into the element of the history', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room" ypy-history-elt><p id="n">1</p><input id="q"></div>`);
            let url = location.pathname + location.search;
            fetchMock.mockResponse('GET', new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), () =>
                new Response('<!doctype html><title>t</title><div id="room" ypy-stream="/room" ypy-history-elt><p id="n">2</p><input id="q"></div>', {headers: {'content-type': 'text/html'}}));
            let input = find('#q');
            input.focus();
            input.value = 'typed';
            c.event('ypy-refresh', 'debounce 0');
            await until(() => html('#n') == '2');
            assert.strictEqual(find('#q'), input);
            assert.equal(input.value, 'typed');
            assert.equal(others().length, 1);
        });

        it('events with the same selector inside the window make one request; each selector has its own window', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div><div id="b" ypy-get="/b">0</div></div>`);
            answer('/a', 'A');
            answer('/b', 'B');
            for (let i = 0; i < 4; i++) c.event('ypy-refresh', 'selector #a', 'debounce 80');
            c.event('ypy-refresh', 'selector #b', 'debounce 80');
            c.event('ypy-refresh', 'selector #a', 'debounce 80');
            await c.flush();
            assert.deepEqual(others(), [], 'nothing before the window ends');
            await until(() => html('#a') == 'A' && html('#b') == 'B');
            await ypy.timeout(150);
            assert.deepEqual(others(), ['/a', '/b']);
        });

        it('an event after the request started opens a new window and a second request', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div></div>`);
            let n = 0;
            fetchMock.mockResponse('GET', /^\/a$/, () => new Response(String(++n), {headers: {'content-type': 'text/html'}}));
            c.event('ypy-refresh', 'selector #a', 'debounce 10');
            await until(() => html('#a') == '1');
            c.event('ypy-refresh', 'selector #a', 'debounce 10');
            await until(() => html('#a') == '2');
            assert.equal(others().length, 2);
        });

        it('waits the debounce, and the jitter on top of it', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div></div>`);
            answer('/a', '1');
            let t0 = Date.now();
            c.event('ypy-refresh', 'selector #a', 'debounce 60', 'jitter 40');
            await until(() => html('#a') == '1');
            let took = Date.now() - t0;
            assert.isAtLeast(took, 55);
            assert.isBelow(took, 400);
        });

        it('the debounce defaults to 250 ms and is capped at 60 s; a value that is not a number is the default', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div></div>`);
            answer('/a', '1');
            let t0 = Date.now();
            c.event('ypy-refresh', 'selector #a', 'debounce soon');
            await until(() => html('#a') == '1');
            assert.isAtLeast(Date.now() - t0, 240);
            // the cap: the timer is set with it (read from the timers by a spy)
            let delays = [], st = window.setTimeout;
            window.setTimeout = (fn, ms, ...a) => { delays.push(ms); return st(fn, ms, ...a) };
            try {
                c.event('ypy-refresh', 'selector #a', 'debounce 99999999');
                await c.flush();
            } finally { window.setTimeout = st }
            assert.isTrue(delays.some(d => d >= 60000 && d < 60001), 'capped at 60000: ' + delays);
        });

        it('fires the cancelable ypy:stream:refresh before the request; preventDefault cancels it', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div></div>`);
            answer('/a', '1');
            let seen = [];
            on('ypy:stream:refresh', e => { seen.push(e.detail.selector); if (seen.length == 1) e.preventDefault() });
            c.event('ypy-refresh', 'selector #a', 'debounce 0');
            await until(() => seen.length == 1);
            await ypy.timeout(30);
            assert.deepEqual(others(), []);
            c.event('ypy-refresh', 'selector #a', 'debounce 0');
            await until(() => html('#a') == '1');
            assert.deepEqual(seen, ['#a', '#a']);
        });

        it('an element with no ypy-get is reported and the others are fetched', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><p class="r">none</p><div class="r" ypy-get="/a">0</div></div>`);
            answer('/a', '1');
            let seen = errors();
            c.event('ypy-refresh', 'selector .r', 'debounce 0');
            await until(() => html('div.r') == '1');
            assert.equal(seen.length, 1);
            assert.match(seen[0], /has no ypy-get/);
        });

        it('a selector that matches nothing fires ypy:target:missing with type "stream"', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"></div>`);
            on('ypy:target:missing', e => e.preventDefault());
            let missing = once('ypy:target:missing');
            c.event('ypy-refresh', 'selector #nope', 'debounce 0');
            let e = await missing;
            assert.equal(e.detail.type, 'stream');
            assert.equal(e.detail.selector, '#nope');
        });

        it('a refresh that is still waiting when the stream closes is dropped', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div></div>`);
            answer('/a', '1');
            c.event('ypy-refresh', 'selector #a', 'debounce 80');
            await c.flush();
            ypy.stream.close(find('#room'));
            await ypy.timeout(150);
            assert.deepEqual(others(), []);
            assert.equal(html('#a'), '0');
        });

        it('a failed request is reported on the stream and the stream goes on', async function () {
            let [, c] = await openRoom(`<div id="room" ypy-stream="/room"><div id="a" ypy-get="/a">0</div></div>`);
            fetchMock.mockResponse('GET', /^\/a$/, () => Promise.reject(new TypeError('Failed to fetch')));
            c.event('ypy-refresh', 'selector #a', 'debounce 0');
            await until(() => others().length == 1);
            await c.flush();
            assert.equal(ypy.stream.stats().open, 1);
        });
    });

    // ---- the tab in the background ------------------------------------------------------------

    describe('pauseOnBackground', function () {
        const ROOM = (cfg = `ypy-config='{"stream":{"pauseOnBackground":true}}'`) => `<div id="room" ypy-stream="/room" ${cfg}><p id="x">0</p></div>`;

        it('closes the connection when the tab is hidden, without a reconnection, and opens it again when it is shown, at once, with Last-Event-ID', async function () {
            let [srv, c] = await openRoom(ROOM());
            c.send('retry: 5000\nid: 12\nevent: ypy-event\ndata: name t:id\n\n');
            await c.flush();
            let events = [];
            for (let n of ['ypy:stream:pause', 'ypy:stream:resume', 'ypy:stream:reconnect', 'ypy:stream:close']) on(n, () => events.push(n));
            setHidden(true);
            await until(() => c.cancelled);
            await ypy.timeout(80);
            assert.equal(srv.conns.length, 1, 'no connection while hidden');
            assert.deepEqual(events, ['ypy:stream:pause']);
            let t0 = Date.now();
            setHidden(false);
            await until(() => srv.conns.length == 2);
            assert.isBelow(Date.now() - t0, 500, 'no backoff: retry says 5 s');
            assert.equal(srv.calls()[1].request.headers['Last-Event-ID'], '12');
            assert.deepEqual(events, ['ypy:stream:pause', 'ypy:stream:resume']);
            // the new connection is a connection like any other
            srv.conns[1].patch({selector: '#x', mode: 'inner'}, 'back');
            await srv.conns[1].flush();
            assert.equal(html('#x'), 'back');
        });

        it('the attempts start over after a pause: a failure right after still waits the retry delay of the first', async function () {
            let [srv, c] = await openRoom(ROOM());
            c.send('retry: 30\n\n');
            await c.flush();
            setHidden(true);
            await until(() => c.cancelled);
            setHidden(false);
            await until(() => srv.conns.length == 2);
            let delays = [];
            on('ypy:stream:reconnect', e => delays.push(e.detail.delay));
            await srv.conns[1].flush();
            srv.conns[1].end();
            await until(() => srv.conns.length == 3);
            assert.isAtMost(delays[0], 30);
        });

        it('a hide and show before the connection was closed leaves one live stream', async function () {
            let [srv, c] = await openRoom(ROOM());
            setHidden(true);
            setHidden(false);
            await until(() => srv.conns.length == 2);
            await ypy.timeout(60);
            assert.equal(srv.conns.length, 2);
            assert.equal(ypy.stream.stats().open, 1);
            assert.isTrue(c.cancelled);
        });

        it('hidden during a reconnection delay: the next connection waits for the tab', async function () {
            let [srv, c] = await openRoom(ROOM());
            c.send('retry: 30\n\n');
            await c.flush();
            c.end();
            await once('ypy:stream:reconnect');
            setHidden(true);
            await ypy.timeout(150);
            assert.equal(srv.conns.length, 1, 'no connection while hidden');
            setHidden(false);
            await until(() => srv.conns.length == 2);
        });

        it('a connection whose answer arrives while the tab is hidden is closed and waits for the tab', async function () {
            let srv = server(), resolve, base = fetchMock.responses[fetchMock.responses.length - 1];
            let real = base.response;
            base.response = () => new Promise(r => { resolve = () => r(real()) });
            setHidden(true);
            createProcessedHTML(ROOM());
            await until(() => resolve);
            resolve();
            base.response = real;   // the next connection is answered at once
            await until(() => srv.conns.length == 1);
            await until(() => srv.conns[0].cancelled);
            await ypy.timeout(60);
            assert.equal(srv.conns.length, 1);
            setHidden(false);
            await until(() => srv.conns.length == 2);
        });

        it('a stream that is closed while paused stays closed', async function () {
            let [srv, c] = await openRoom(ROOM());
            setHidden(true);
            await until(() => c.cancelled);
            let closed = once('ypy:stream:close');
            ypy.stream.close(find('#room'));
            assert.equal((await closed).detail.reason, 'api');
            setHidden(false);
            await ypy.timeout(80);
            assert.equal(srv.conns.length, 1);
            assert.equal(ypy.stream.stats().open, 0);
        });

        it('an element that leaves the page while paused ends the stream', async function () {
            let [srv, c] = await openRoom(ROOM());
            setHidden(true);
            await until(() => c.cancelled);
            let closed = once('ypy:stream:close');
            find('#room').remove();
            assert.equal((await closed).detail.reason, 'removed');
            assert.equal(ypy.stream.stats().open, 0);
        });

        it('is off by default: a hidden tab keeps its connection', async function () {
            let [srv, c] = await openRoom(ROOM(''));
            setHidden(true);
            await ypy.timeout(100);
            assert.isFalse(c.cancelled);
            assert.equal(srv.conns.length, 1);
            c.patch({selector: '#x', mode: 'inner'}, 'still here');
            await c.flush();
            assert.equal(html('#x'), 'still here');
        });

        it('ypy.config.stream.pauseOnBackground turns it on for every stream, and an element can turn it off', async function () {
            ypy.config.stream = {pauseOnBackground: true};
            try {
                let [srv, c] = await openRoom(ROOM(''));
                setHidden(true);
                await until(() => c.cancelled);
                setHidden(false);
                await until(() => srv.conns.length == 2);
                let off = ROOM(`ypy-config='{"stream":{"pauseOnBackground":false}}'`).replace('id="room"', 'id="room2"').replace('/room"', '/room"');
                ypy.stream.close(find('#room'));
                createProcessedHTML(off);
                await until(() => srv.conns.length == 3);
                setHidden(true);
                await ypy.timeout(100);
                assert.isFalse(srv.conns[2].cancelled);
            } finally { delete ypy.config.stream }
        });

        it('removes its listener when the last stream that pauses is gone', async function () {
            let added = 0, removed = 0, add = document.addEventListener, rem = document.removeEventListener;
            document.addEventListener = function (n, ...a) { if (n == 'visibilitychange') added++; return add.call(this, n, ...a) };
            document.removeEventListener = function (n, ...a) { if (n == 'visibilitychange') removed++; return rem.call(this, n, ...a) };
            try {
                let [srv] = await openRoom(ROOM());
                assert.equal(added, 1);
                ypy.stream.close(find('#room'));
                assert.equal(removed, 1);
            } finally { document.addEventListener = add; document.removeEventListener = rem }
        });
    });
});
