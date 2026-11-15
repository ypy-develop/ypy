// SPDX-License-Identifier: MIT
// A model answer streamed into fragments (ADR-0018): the stream client merges patches and stops on ypy:abort, and
// ypy-model keeps what a model wrote harmless, announces the answer without flooding and follows it.
describe('ypy-model extension', function () {

    let extBackup, listeners = [];

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
        await load('../src/ext/ypy-model.js');
    });
    after(() => { restoreExtensions(extBackup) });
    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => {
        for (let [name, fn] of listeners) document.removeEventListener(name, fn);
        listeners = [];
        document.querySelectorAll('[data-ypy-live]').forEach(e => { e.textContent = '' });
        cleanupTest();
    });

    const enc = new TextEncoder();
    const on = (name, fn) => { document.addEventListener(name, fn); listeners.push([name, fn]) };
    const until = async (fn, ms = 1500) => {
        let t = Date.now();
        while (Date.now() - t < ms) { let v = fn(); if (v) return v; await ypy.timeout(5) }
        throw new Error('timed out waiting for ' + fn);
    };
    const html = sel => find(sel).innerHTML;

    // one connection the test writes to
    async function open(markup, url = '/gen') {
        let c = {cancelled: false};
        fetchMock.mockResponse('GET', new RegExp('^' + url), () => {
            let body = new ReadableStream({start(ctrl) { c.ctrl = ctrl }, cancel() { c.cancelled = true }});
            return new Response(body, {headers: {'content-type': 'text/event-stream'}});
        });
        c.send = raw => c.ctrl.enqueue(enc.encode(raw));
        c.patch = (k, elements) => c.send('event: ypy-patch-elements\n' + Object.entries(k).map(([a, b]) => `data: ${a} ${b}\n`).join('')
            + (elements == null ? '' : elements.split('\n').map(l => `data: elements ${l}\n`).join('')) + '\n');
        let opened = new Promise(resolve => on('ypy:stream:open', resolve));
        createProcessedHTML(markup);
        await opened;
        return c;
    }

    const BOX = (extra = '') => `<article id="a1" ypy-untrusted ${extra} aria-busy="true"><div id="a1-done"></div><div id="a1-tail"></div></article>`;
    const room = (cfg = '') => `<div id="room" ypy-stream="/gen" ${cfg}><section id="chat"></section></div>`;

    // ---- the stream client ---------------------------------------------------------------------

    describe('merging patches', function () {
        it('merges consecutive patches of one selector while the browser is busy: the last inner wins, appends join', async function () {
            let c = await open(room(`ypy-config='{"stream":{"frame":true}}'`));
            c.patch({mode: 'append', selector: '#chat'}, BOX());
            await until(() => find('#a1'));
            let applied = 0;
            on('ypy:after:swap', () => applied++);
            for (let i = 0; i < 20; i++) c.patch({mode: 'inner', selector: '#a1-tail'}, `<p>${i}</p>`);
            for (let i = 0; i < 20; i++) c.patch({mode: 'append', selector: '#a1-done'}, `<i>${i}</i>`);
            await until(() => html('#a1-done').endsWith('<i>19</i>'));
            assert.equal(html('#a1-tail'), '<p>19</p>');
            assert.equal(html('#a1-done'), Array.from({length: 20}, (_, i) => `<i>${i}</i>`).join(''));
            assert.isBelow(applied, 20, 'fewer swaps than patches');
        });

        it('does not merge another mode, a selector, a key or a limit', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, '<ul id="l"></ul>');
            await until(() => find('#l'));
            c.patch({mode: 'append', selector: '#l', key: 'id'}, '<li id="x">1</li>');
            c.patch({mode: 'append', selector: '#l', key: 'id'}, '<li id="x">2</li>');
            c.patch({mode: 'prepend', selector: '#l'}, '<li id="p">p</li>');
            c.patch({mode: 'prepend', selector: '#l'}, '<li id="q">q</li>');
            await until(() => html('#l').includes('q'));
            assert.equal(html('#l'), '<li id="q">q</li><li id="p">p</li><li id="x">2</li>');
        });

        it('can be turned off', async function () {
            let c = await open(room(`ypy-config='{"stream":{"merge":false}}'`));
            c.patch({mode: 'append', selector: '#chat'}, '<div id="o"></div>');
            await until(() => find('#o'));
            let applied = 0;
            on('ypy:after:swap', () => applied++);
            for (let i = 0; i < 5; i++) c.patch({mode: 'append', selector: '#o'}, `<i>${i}</i>`);
            await until(() => applied >= 5);
            assert.equal(applied, 5);
        });
    });

    describe('stop', function () {
        it('ypy:abort on the element of the stream closes it', async function () {
            let c = await open(room());
            let closed = new Promise(resolve => on('ypy:stream:close', resolve));
            find('#room').dispatchEvent(new CustomEvent('ypy:abort'));
            assert.equal((await closed).detail.reason, 'abort');
            await until(() => c.cancelled);
        });

        it('ypy-stop sends ypy:abort to the elements it names; the open answer is closed as stopped and announced', async function () {
            ypy.config.announce = {messages: {answerStopped: 'Answer stopped'}};
            let c = await open(room() + `<button id="stop" ypy-stop="#room">Stop</button>`);
            ypy.process(find('#stop'));
            c.patch({mode: 'append', selector: '#chat'}, BOX());
            await until(() => find('#a1'));
            find('#stop').click();
            await until(() => find('#a1').getAttribute('data-ypy-answer') == 'stopped');
            assert.isFalse(find('#a1').hasAttribute('aria-busy'));
            await until(() => document.querySelector('[data-ypy-live=assertive]')?.textContent == 'Answer stopped');
            delete ypy.config.announce;
        });
    });

    // ---- the wall ------------------------------------------------------------------------------

    describe('ypy-untrusted', function () {
        const evil = '<p onclick="x()" style="top:0" ypy-post="/pwn" data-ypy-get="/p" ypy-native-x="1" x-data="{}" @click="a" id="k">ok'
            + '<script>window.__pwn = 1</script><iframe src="/f"></iframe><form action="/x"><input name="n"><button>go</button></form>'
            + '<img src="https://attacker.example/?q=1"><svg><circle/></svg>'
            + '<a href="javascript:alert(1)" target="_blank">j</a><a href="https:\n//ok.example/">h</a><a href="data:text/html,x">d</a></p>';

        it('strips scripts, ypy-* attributes, handlers, forms, media and bad addresses from what enters', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX());
            await until(() => find('#a1'));
            c.patch({mode: 'append', selector: '#a1-done'}, evil);
            await until(() => find('#a1-done p'));
            let box = find('#a1-done');
            assert.equal(box.querySelectorAll('script,iframe,form,input,button,img,svg').length, 0);
            let p = box.querySelector('p');
            for (let a of ['onclick', 'style', 'ypy-post', 'data-ypy-get', 'ypy-native-x', 'x-data', '@click']) assert.isFalse(p.hasAttribute(a), a);
            assert.equal(p.id, 'k');
            let links = [...box.querySelectorAll('a')];
            assert.isFalse(links[0].hasAttribute('href'), 'javascript:');
            assert.isFalse(links[0].hasAttribute('target'));
            assert.isTrue(links[1].hasAttribute('href'), 'a good address stays');
            assert.equal(links[1].getAttribute('rel'), 'noopener noreferrer nofollow');
            assert.isFalse(links[2].hasAttribute('href'), 'data:');
            assert.isUndefined(window.__pwn);
            assert.equal(box.querySelectorAll('[ypy-post],[data-ypy-get]').length, 0);
        });

        it('keeps the container of an outer patch and cleans what is inside it', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX('ypy-follow'));
            await until(() => find('#a1'));
            c.patch({selector: '#a1'}, `<article id="a1" ypy-untrusted ypy-follow data-ypy-answer="done">${evil}</article>`);
            await until(() => find('#a1').getAttribute('data-ypy-answer') == 'done');
            let a = find('#a1');
            assert.isTrue(a.hasAttribute('ypy-untrusted'));
            assert.isTrue(a.hasAttribute('ypy-follow'));
            assert.equal(a.querySelectorAll('script,iframe,form,img,[ypy-post]').length, 0);
        });

        it('cleans an outer patch of a region inside the container, root included', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX());
            await until(() => find('#a1'));
            c.patch({selector: '#a1-tail'}, '<div id="a1-tail" ypy-post="/pwn" onclick="x()">t</div>');
            await until(() => html('#a1-tail') == 't');
            assert.isFalse(find('#a1-tail').hasAttribute('ypy-post'));
            assert.isFalse(find('#a1-tail').hasAttribute('onclick'));
        });

        it('leaves content outside an untrusted container alone', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, '<p id="t" ypy-get="/ok">trusted</p>');
            await until(() => find('#t'));
            assert.isTrue(find('#t').hasAttribute('ypy-get'));
        });

        it('images are allowed with ypy-untrusted="images"', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, `<article id="g" ypy-untrusted="images" aria-busy="true"></article>`);
            await until(() => find('#g'));
            c.patch({mode: 'append', selector: '#g'}, '<img id="im" src="/pic.png" onerror="x()">');
            await until(() => find('#im'));
            assert.isFalse(find('#im').hasAttribute('onerror'));
        });
    });

    // ---- announcements ---------------------------------------------------------------------------

    describe('announcements', function () {
        const live = () => document.querySelector('[data-ypy-live=polite]');

        it('says one message at the start and one at the end, nothing in between', async function () {
            ypy.config.announce = {messages: {answerStart: 'Answer started', answerReady: 'Answer ready'}, clearAfter: 5000};
            let said = [];
            on('ypy:announce', e => said.push(e.detail.message));
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX());
            await until(() => said.length == 1);
            for (let i = 0; i < 5; i++) { c.patch({mode: 'append', selector: '#a1-done'}, `<p>${i}</p>`); await ypy.timeout(5) }
            c.patch({selector: '#a1'}, '<article id="a1" ypy-untrusted data-ypy-answer="done"><p>x</p></article>');
            await until(() => said.length == 2);
            assert.deepEqual(said, ['Answer started', 'Answer ready']);
            await until(() => live().textContent == 'Answer ready');
            delete ypy.config.announce;
        });

        it('the attributes of the container win over the messages; a failure is assertive', async function () {
            let said = [];
            on('ypy:announce', e => said.push([e.detail.message, e.detail.politeness]));
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX(`ypy-announce-start="Começou" ypy-announce-error="Falhou"`));
            await until(() => said.length == 1);
            c.patch({selector: '#a1'}, '<article id="a1" ypy-untrusted ypy-announce-error="Falhou" data-ypy-answer="failed"><p>x</p></article>');
            await until(() => said.length == 2);
            assert.deepEqual(said, [['Começou', 'polite'], ['Falhou', 'assertive']]);
        });

        it('announce.stream "blocks" says each closed block, at most once every 3 seconds', async function () {
            ypy.config.announce = {stream: 'blocks', messages: {}};
            let said = [];
            on('ypy:announce', e => said.push(e.detail.message));
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX());
            await ypy.timeout(30);
            c.patch({mode: 'append', selector: '#a1-done'}, '<p>First block</p>');
            await until(() => said.length == 1);
            c.patch({mode: 'append', selector: '#a1-done'}, '<p>Second block</p>');
            await ypy.timeout(80);
            assert.deepEqual(said, ['First block']);
            delete ypy.config.announce;
        });

        it('says nothing when announcements are off', async function () {
            ypy.config.announce = false;
            let said = [];
            on('ypy:announce', e => said.push(e.detail.message));
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX(`ypy-announce-start="x"`));
            await until(() => find('#a1'));
            await ypy.timeout(60);
            assert.deepEqual(said, []);
            delete ypy.config.announce;
        });
    });

    // ---- following ---------------------------------------------------------------------------------

    describe('ypy-follow', function () {
        it('scrolls down with the answer when the reader is at the bottom, and not otherwise', async function () {
            let c = await open(room());
            c.patch({mode: 'append', selector: '#chat'}, BOX('ypy-follow'));
            await until(() => find('#a1'));
            let spacer = document.createElement('div');
            spacer.style.height = '3000px';
            spacer.id = 'spacer';
            document.body.appendChild(spacer);
            try {
                scrollTo(0, document.documentElement.scrollHeight);
                c.patch({mode: 'append', selector: '#a1-done'}, '<p style="">' + 'x'.repeat(10) + '</p>');
                await until(() => html('#a1-done').includes('xxxx'));
                if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
                    assert.isAtLeast(scrollY + innerHeight, document.documentElement.scrollHeight - 30, 'followed');
                scrollTo(0, 0);
                c.patch({mode: 'append', selector: '#a1-done'}, '<p>more</p>');
                await until(() => html('#a1-done').includes('more'));
                assert.equal(scrollY, 0, 'a reader who scrolled up is left alone');
            } finally { spacer.remove(); scrollTo(0, 0) }
        });
    });
});
