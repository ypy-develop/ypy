// SPDX-License-Identifier: MIT
// The conformance vectors shared with the Go SDK (spec/PROTOCOL.md section 11 of the SDK repository).
// test/fixtures/stream/vectors/ is a copy of spec/vectors/ there: each file is a stream the SDK writes, the
// page before it and the page after it. Here the bytes go through ypy-stream, whole and one byte at a time,
// and the page, the signals, the events and the requests are checked against the file.
describe('ypy-stream conformance vectors', function () {

    // Every vector the SDK has, in the order of its index.txt. A vector added there is added here.
    const NAMES = [
        'elements-by-id', 'elements-modes', 'elements-svg', 'event', 'list-append-limit', 'list-key',
        'list-key-limit', 'list-prepend-limit', 'model-answer', 'model-merge', 'model-plain-text', 'model-stopped', 'refresh-debounce', 'refresh-jitter', 'refresh-page',
        'refresh-selector', 'signals', 'unknown-things'
    ];
    const DIR = '/test/fixtures/stream/vectors/';
    const enc = new TextEncoder();

    let extBackup, vectors = {}, listeners = [];

    const text = path => new Promise((resolve, reject) => {
        let xhr = new XMLHttpRequest();
        xhr.open('GET', path);
        xhr.onload = () => xhr.status == 200 ? resolve(xhr.responseText) : reject(new Error(path + ': ' + xhr.status));
        xhr.onerror = () => reject(new Error(path + ' failed'));
        xhr.send();
    });

    // "=== name" opens a section; input keeps its text exactly, the others lose the last line feed
    function parse(raw) {
        let secs = {}, cur = null;
        for (let line of raw.split(/(?<=\n)/)) {
            let m = /^=== (\w+)\n$/.exec(line);
            if (m) secs[cur = m[1]] = '';
            else secs[cur] += line;
        }
        for (let n in secs) if (n != 'input') secs[n] = secs[n].replace(/\n$/, '');
        let lines = n => (secs[n] ?? '').split('\n').filter(Boolean);
        return {
            ...secs,
            signals: lines('signals').map(l => JSON.parse(l)),
            events: lines('events'),
            respond: lines('respond').map(l => l.split(' => ')),
            requests: lines('requests')
        };
    }

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
        for (let n of NAMES) vectors[n] = parse(await text(DIR + n + '.txt'));
    });
    after(() => { restoreExtensions(extBackup) });

    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => {
        for (let [name, fn] of listeners) document.removeEventListener(name, fn);
        listeners = [];
        cleanupTest();
    });

    const on = (name, fn) => { document.addEventListener(name, fn); listeners.push([name, fn]) };
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const until = async (fn, ms = 1500) => {
        let t = Date.now();
        while (Date.now() - t < ms) { if (fn()) return true; await ypy.timeout(5) }
        return false;
    };
    // the attributes the client adds to what it processes (data-ypy-powered) are not part of a vector
    const dom = room => room.innerHTML.replace(/ data-ypy-[\w-]+(?:="[^"]*")?/g, '');
    const page = () => location.pathname + location.search;
    const html = body => new Response(body, {headers: {'content-type': 'text/html'}});

    // Plays a vector: the page, the server that answers its requests, the stream. feed(send) writes the
    // bytes of the input; the result is what the page did.
    async function play(v, feed) {
        let conns = [], got = {signals: [], events: [], requests: []};
        fetchMock.mockResponse('GET', /^\/room/, () => {
            let c = {};
            let body = new ReadableStream({start(ctrl) { c.ctrl = ctrl }});
            c.send = bytes => c.ctrl.enqueue(bytes);
            conns.push(c);
            return new Response(body, {headers: {'content-type': 'text/event-stream'}});
        });
        for (let [url, body] of v.respond) {
            let at = url == '@page' ? page() : url;
            fetchMock.mockResponse('GET', new RegExp('^' + esc(at) + '$'), () => html(body));
        }
        let opened = new Promise(resolve => on('ypy:stream:open', resolve));
        createProcessedHTML(`<div id="room" ypy-stream="/room" ypy-history-elt>${v.page ?? ''}</div>`);
        await opened;

        on('ypy:stream:signals', e => got.signals.push({patch: e.detail.patch, onlyIfMissing: e.detail.onlyIfMissing}));
        on('ypy:target:missing', e => e.preventDefault());
        for (let line of v.events) {
            let [name] = line.split(' ');
            on(name, e => got.events.push(Object.keys(e.detail ?? {}).length ? name + ' ' + JSON.stringify(e.detail) : name));
        }
        let room = find('#room');
        feed(conns[0].send);

        let want = {
            signals: v.signals.length, events: v.events.length,
            requests: v.requests.map(r => r.replace('@page', page()))
        };
        let done = () => got.signals.length >= want.signals && got.events.length >= want.events
            && requests().length >= want.requests.length && (v.dom == null || dom(room) == v.dom);
        const requests = () => fetchMock.getCalls()
            .filter(c => !/^\/room/.test(c.url))
            .map(c => { let u = new URL(c.url, location.href); return (c.request?.method ?? 'GET') + ' ' + u.pathname + u.search });
        await until(done);
        await ypy.timeout(v.requests.length ? 150 : 20);   // a request that should not be there has had its time
        got.requests = requests();
        return {got, want, room};
    }

    const check = (v, {got, want, room}) => {
        if (v.dom != null) assert.equal(dom(room), v.dom, 'the page');
        assert.deepEqual(got.signals, v.signals, 'the signals');
        assert.deepEqual(got.events, v.events.map(l => { let [n, ...d] = l.split(' '); return d.length ? n + ' ' + JSON.stringify(JSON.parse(d.join(' '))) : n }), 'the events');
        assert.deepEqual(got.requests, want.requests, 'the requests');
    };

    it('lists every vector of the SDK', async function () {
        let index = (await text(DIR + 'index.txt')).split('\n').filter(Boolean);
        assert.deepEqual([...NAMES].sort(), index);
    });

    for (let name of NAMES) {
        describe(name, function () {
            it('whole', async function () {
                let v = vectors[name];
                check(v, await play(v, send => send(enc.encode(v.input))));
            });
            it('one byte at a time', async function () {
                let v = vectors[name];
                check(v, await play(v, send => { for (let b of enc.encode(v.input)) send(new Uint8Array([b])) }));
            });
        });
    }
});
