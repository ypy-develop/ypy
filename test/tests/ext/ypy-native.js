// SPDX-License-Identifier: MIT
describe('ypy-native extension', function () {

    let extBackup, host;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        await loadExtension('../src/ext/ypy-native.js');
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest(this.currentTest);
        host = fakeHost();
    });

    afterEach(() => {
        ypy.native.disconnect();
        delete ypy.config.native;
        delete ypy.layers;
        document.title = 'ypy tests';
        cleanupTest();
    });

    // The channel a shell gives the page: strings out, 'message' events in
    function fakeHost() {
        let h = {
            sent: [],
            listeners: [],
            postMessage(text) { this.sent.push(JSON.parse(text)) },
            addEventListener(type, fn) { this.listeners.push(fn) },
            removeEventListener(type, fn) { this.listeners = this.listeners.filter(f => f !== fn) },
            emit(message) {
                let data = typeof message == 'string' ? message : JSON.stringify(message);
                for (let fn of [...this.listeners]) fn({data});
            },
            of(type) { return this.sent.filter(m => m.type == type) }
        };
        return h;
    }

    const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
    const swapsOnlyOnce = () => document.addEventListener('ypy:before:swap', e => e.preventDefault(), {once: true});
    const pageCalls = () => fetchMock.getCalls().filter(c => !String(c.url).includes('.well-known'));
    const abs = path => new URL(path, location.href).href;

    // The handshake a shell does
    async function connectApp({platform = 'ios', v = 1, caps = [], announce, nonce = 'n-1'} = {}) {
        assert.isTrue(ypy.native.connect(host));
        host.emit({type: 'hello', v, platform, caps, nonce, announce});
        await tick();
    }

    function pathConfig(doc) {
        mockResponse('GET', '/\\.well-known/ypy-native\\.json', JSON.stringify(doc), {headers: {'Content-Type': 'application/json'}});
    }

    describe('the handshake', function () {

        it('asks for it with a load message, and answers hello with ready and the same nonce', async function () {
            ypy.native.connect(host);
            assert.deepEqual(host.sent, [{type: 'load', v: 1}]);
            host.emit({type: 'hello', v: 1, platform: 'ios', caps: ['menu'], nonce: 'abc'});
            assert.deepEqual(host.of('ready'), [{type: 'ready', v: 1, nonce: 'abc'}]);
            assert.isTrue(ypy.native.ready);
            assert.equal(ypy.native.platform, 'ios');
            assert.deepEqual(ypy.native.caps, ['menu']);
        });

        it('sets data-ypy-native on the root element and removes it on disconnect', async function () {
            await connectApp({platform: 'android'});
            assert.equal(document.documentElement.getAttribute('data-ypy-native'), 'android');
            ypy.native.disconnect();
            assert.isFalse(document.documentElement.hasAttribute('data-ypy-native'));
            assert.isFalse(ypy.native.ready);
        });

        it('hears nothing but hello before the handshake', async function () {
            ypy.native.connect(host);
            host.emit({type: 'reload'});
            host.emit({type: 'component:event', id: 1, name: 'action'});
            await tick();
            assert.lengthOf(pageCalls(), 0);
            assert.isFalse(ypy.native.ready);
        });

        for (let [label, hello] of [
            ['no nonce', {type: 'hello', v: 1, platform: 'ios'}],
            ['an empty nonce', {type: 'hello', v: 1, platform: 'ios', nonce: ''}],
            ['a nonce that is not text', {type: 'hello', v: 1, platform: 'ios', nonce: 5}],
            ['an upper-case platform', {type: 'hello', v: 1, platform: 'iOS', nonce: 'n'}],
            ['a platform with a space', {type: 'hello', v: 1, platform: 'i os', nonce: 'n'}],
            ['version 0', {type: 'hello', v: 0, platform: 'ios', nonce: 'n'}],
            ['a version that is text', {type: 'hello', v: '1', platform: 'ios', nonce: 'n'}],
        ]) {
            it('ignores a hello with ' + label, function () {
                ypy.native.connect(host);
                host.emit(hello);
                assert.isFalse(ypy.native.ready);
                assert.lengthOf(host.of('ready'), 0);
            });
        }

        it('ignores text that is not JSON, JSON that is not an object, and a type that is not text', function () {
            ypy.native.connect(host);
            for (let m of ['hello', '[]', 'null', '{"type":5}', '{"nope":1}', JSON.stringify({type: 'hello', v: 1, platform: 'ios', nonce: 'x'.repeat(70000)})]) host.emit(m);
            assert.isFalse(ypy.native.ready);
        });

        it('keeps only valid capability tokens', async function () {
            await connectApp({caps: ['menu', 'bad name', 'x'.repeat(65), 5, 'date-picker', 'a,b']});
            assert.deepEqual(ypy.native.caps, ['menu', 'date-picker']);
        });

        it('does not look a message type up on the prototype', async function () {
            await connectApp();
            host.emit({type: 'constructor'});
            host.emit({type: '__proto__'});
            host.emit({type: 'toString'});
            assert.isTrue(ypy.native.ready);
        });

        it('a second hello starts the handshake again: components are disconnected and sent anew', async function () {
            await connectApp({caps: ['menu']});
            createProcessedHTML('<div ypy-native-component="menu" ypy-native-props=\'{"a":1}\'></div>');
            await tick();
            assert.lengthOf(host.of('component:connect'), 1);
            host.emit({type: 'hello', v: 1, platform: 'ios', caps: ['menu'], nonce: 'n-2'});
            await tick();
            assert.lengthOf(host.of('component:disconnect'), 1);
            assert.lengthOf(host.of('component:connect'), 2);
            assert.equal(host.of('ready').at(-1).nonce, 'n-2');
        });
    });

    describe('the YPY-Native header', function () {

        it('is not sent without the app', async function () {
            mockResponse('GET', '/x', 'x');
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="this">go</button>');
            find('#b').click();
            await forRequest();
            assert.isUndefined(lastFetch().request.headers['YPY-Native']);
        });

        it('carries the platform, the version and the capabilities after the handshake', async function () {
            await connectApp({caps: ['menu', 'share']});
            mockResponse('GET', '/x', 'x');
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="this">go</button>');
            find('#b').click();
            await forRequest();
            assert.equal(lastFetch().request.headers['YPY-Native'], 'ios; v=1; caps=menu,share');
        });

        it('leaves caps out when the build knows no component', async function () {
            await connectApp({platform: 'desktop', v: 2});
            mockResponse('GET', '/x', 'x');
            createProcessedHTML('<button id="b" ypy-get="/x" ypy-target="this">go</button>');
            find('#b').click();
            await forRequest();
            assert.equal(lastFetch().request.headers['YPY-Native'], 'desktop; v=2');
        });

        it('is not sent to another origin', async function () {
            await connectApp({caps: ['menu']});
            mockResponse('GET', 'https://other.example/x', 'x');
            createProcessedHTML('<button id="b" ypy-get="https://other.example/x" ypy-target="this">go</button>');
            find('#b').click();
            await forRequest();
            assert.isUndefined(lastFetch().request.headers['YPY-Native']);
        });
    });

    describe('visits', function () {

        beforeEach(async () => {
            await connectApp({caps: []});
        });

        it('a boosted link is a visit: the shell is told, no request is made', async function () {
            createProcessedHTML('<a id="a" href="/orders/1" ypy-boost="true">order</a>');
            find('#a').click();
            await tick();
            assert.deepEqual(host.of('visit'), [{type: 'visit', url: abs('/orders/1'), action: 'advance', source: 'boost'}]);
            assert.lengthOf(pageCalls(), 0);
        });

        it('a boosted GET form is a visit with its query string', async function () {
            createProcessedHTML('<form id="f" action="/search" method="get" ypy-boost="true"><input name="q" value="a b"><button>go</button></form>');
            find('#f').requestSubmit();
            await tick();
            let [v] = host.of('visit');
            assert.equal(v.url, abs('/search?q=a+b'));
            assert.equal(v.source, 'form');
            assert.lengthOf(pageCalls(), 0);
        });

        it('ypy-replace-url makes it a replace', async function () {
            createProcessedHTML('<a id="a" href="/orders/1" ypy-boost="true" ypy-replace-url="true">order</a>');
            find('#a').click();
            await tick();
            assert.equal(host.of('visit')[0].action, 'replace');
        });

        it('YPY-Location to the main target is a visit', async function () {
            mockResponse('GET', '/start', '', {headers: {'YPY-Location': '/orders'}});
            createProcessedHTML('<button id="b" ypy-get="/start" ypy-target="this">go</button>');
            find('#b').click();
            await tick(80);
            let [v] = host.of('visit');
            assert.equal(v.url, abs('/orders'));
            assert.equal(v.source, 'location');
        });

        it('a post that ends in a redirect is a visit to the page it ended on, and nothing is swapped', async function () {
            let done = new MockResponse('<h1>Done</h1>', {url: abs('/orders/9')});
            done.redirected = true;
            mockResponse('POST', '/orders', done);
            createProcessedHTML('<div id="out">before</div><form id="f" action="/orders" method="post" ypy-boost="true"><button>save</button></form>');
            let swapped = false;
            let spy = () => { swapped = true };
            document.addEventListener('ypy:before:swap', spy);
            try {
                find('#f').requestSubmit();
                await tick(80);
            } finally { document.removeEventListener('ypy:before:swap', spy) }
            let [v] = host.of('visit');
            assert.deepEqual(v, {type: 'visit', url: abs('/orders/9'), action: 'advance', source: 'redirect'});
            assert.isFalse(swapped);
            assert.equal(find('#out').textContent, 'before');
        });

        it('a post answered with a page and no redirect stays in the page (a form with errors)', async function () {
            mockResponse('POST', '/orders', '<p id="errors">invalid</p>', {status: 422});
            createProcessedHTML('<form id="f" action="/orders" method="post" ypy-boost="true" ypy-target="#out"><button>save</button></form><div id="out"></div>');
            find('#f').requestSubmit();
            await forRequest();
            assert.lengthOf(host.of('visit'), 0);
        });

        it('a request to a fragment target is not a visit', async function () {
            mockResponse('GET', '/frag', '<p>frag</p>');
            createProcessedHTML('<a id="a" href="/frag" ypy-boost="true" ypy-target="#out">x</a><div id="out"></div>');
            find('#a').click();
            await forRequest();
            assert.lengthOf(host.of('visit'), 0);
            assert.equal(find('#out').textContent, 'frag');
        });

        it('a request that is not a GET to the main target with no redirect is not a visit', async function () {
            mockResponse('DELETE', '/orders/1', '<p>gone</p>');
            createProcessedHTML('<button id="b" ypy-delete="/orders/1" ypy-target="#out">x</button><div id="out"></div>');
            find('#b').click();
            await forRequest();
            assert.lengthOf(host.of('visit'), 0);
        });

        it('an app that cancels ypy:native:before:visit keeps the navigation in the page', async function () {
            mockResponse('GET', '/orders/2', 'x');
            let off = e => e.preventDefault();
            document.addEventListener('ypy:native:before:visit', off, {once: true});
            swapsOnlyOnce();
            createProcessedHTML('<a id="a" href="/orders/2" ypy-boost="true">order</a>');
            find('#a').click();
            await forRequest();
            assert.lengthOf(host.of('visit'), 0);
            assert.lengthOf(pageCalls(), 1);
        });

        it('ypy:native:before:visit tells the url, the action and the source', async function () {
            let seen;
            let listen = e => { seen = e.detail };
            document.addEventListener('ypy:native:before:visit', listen, {once: true});
            createProcessedHTML('<a id="a" href="/orders/3" ypy-boost="true">order</a>');
            find('#a').click();
            await tick();
            assert.equal(seen.url, abs('/orders/3'));
            assert.equal(seen.action, 'advance');
            assert.equal(seen.source, 'boost');
        });

        it('a modifier-key click is left to the browser', async function () {
            createProcessedHTML('<a id="a" href="/orders/4" ypy-boost="true">order</a>');
            let guard = e => e.preventDefault();
            document.addEventListener('click', guard);
            try {
                find('#a').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, ctrlKey: true}));
                await tick();
            } finally { document.removeEventListener('click', guard) }
            assert.lengthOf(host.of('visit'), 0);
        });
    });

    describe('the server steers the app', function () {

        it('ypy:native:navigate is a visit with the given action', async function () {
            await connectApp();
            ypy.trigger(document.body, 'ypy:native:navigate', {url: '/orders', action: 'replace'});
            assert.deepEqual(host.of('visit'), [{type: 'visit', url: abs('/orders'), action: 'replace', source: 'event'}]);
        });

        it('an unknown action is an advance', async function () {
            await connectApp();
            ypy.trigger(document.body, 'ypy:native:navigate', {url: '/orders', action: 'sideways'});
            assert.equal(host.of('visit')[0].action, 'advance');
        });

        it('YPY-Trigger reaches the same listener', async function () {
            await connectApp();
            mockResponse('POST', '/go', 'ok', {headers: {'YPY-Trigger': JSON.stringify({'ypy:native:navigate': {url: '/orders', action: 'replace'}})}});
            createProcessedHTML('<button id="b" ypy-post="/go" ypy-target="this">go</button>');
            find('#b').click();
            await forRequest();
            assert.equal(host.of('visit')[0].url, abs('/orders'));
        });

        it('another origin is ignored', async function () {
            await connectApp();
            ypy.trigger(document.body, 'ypy:native:navigate', {url: 'https://other.example/x'});
            ypy.trigger(document.body, 'ypy:native:navigate', {url: 5});
            assert.lengthOf(host.of('visit'), 0);
        });

        it('a browser does the navigation in the page', async function () {
            mockResponse('GET', '/orders', 'x');
            swapsOnlyOnce();
            ypy.trigger(document.body, 'ypy:native:navigate', {url: '/orders'});
            await forRequest();
            assert.equal(lastFetch().url, '/orders');
        });

        it('ypy.native.visit does the same from code', async function () {
            await connectApp();
            assert.isTrue(ypy.native.visit('/orders/1'));
            assert.isFalse(ypy.native.visit('https://other.example/'));
            assert.lengthOf(host.of('visit'), 1);
        });
    });

    describe('the path configuration', function () {

        const doc = {version: 1, rules: [
            {patterns: ['^/orders/\\d+$'], properties: {presentation: 'push', pull_to_refresh: true}},
            {patterns: ['^/orders/new$', '^/orders/\\d+/edit$'], properties: {context: 'modal', modal_style: 'large'}},
            {patterns: ['^/orders/7$'], properties: {presentation: 'none', pull_to_refresh: false}},
            {patterns: ['(['], properties: {context: 'modal'}},
        ]};

        it('gives a URL the properties of every matching rule, the later one winning', async function () {
            pathConfig(doc);
            await connectApp();
            assert.deepEqual(ypy.native.properties('/orders/5'), {presentation: 'push', pull_to_refresh: true});
            assert.deepEqual(ypy.native.properties('/orders/7'), {presentation: 'none', pull_to_refresh: false});
            assert.deepEqual(ypy.native.properties('/orders/7/edit'), {context: 'modal', modal_style: 'large'});
            assert.deepEqual(ypy.native.properties('/other'), {});
        });

        it('a route whose presentation is none stays in the page', async function () {
            pathConfig(doc);
            await connectApp();
            mockResponse('GET', '/orders/7', 'x');
            swapsOnlyOnce();
            createProcessedHTML('<a id="a" href="/orders/7" ypy-boost="true">order</a>');
            find('#a').click();
            await forRequest();
            assert.lengthOf(host.of('visit'), 0);
            assert.equal(pageCalls()[0].url, '/orders/7');
        });

        it('another route is still a visit', async function () {
            pathConfig(doc);
            await connectApp();
            createProcessedHTML('<a id="a" href="/orders/8" ypy-boost="true">order</a>');
            find('#a').click();
            await tick();
            assert.lengthOf(host.of('visit'), 1);
        });

        it('is not required: without the document every visit goes to the shell', async function () {
            await connectApp();
            createProcessedHTML('<a id="a" href="/orders/7" ypy-boost="true">order</a>');
            find('#a').click();
            await tick();
            assert.lengthOf(host.of('visit'), 1);
        });

        it('config.native.path: false does not load it', async function () {
            ypy.config.native = {path: false};
            pathConfig(doc);
            await connectApp();
            assert.deepEqual(ypy.native.properties('/orders/7'), {});
        });

        it('outside the app, config.native.web opens a modal route as a layer', async function () {
            pathConfig(doc);
            ypy.config.native = {web: true};
            let opened = [];
            ypy.layers = {open: (url, options) => opened.push({url, options})};
            await ypy.native.load();
            createProcessedHTML('<a id="a" href="/orders/new" ypy-boost="true">new</a>');
            find('#a').click();
            await tick();
            assert.deepEqual(opened, [{url: abs('/orders/new'), options: {mode: 'modal'}}]);
            assert.lengthOf(pageCalls(), 0);
        });

        it('a drawer style opens a drawer, and a route that is not modal is an ordinary request', async function () {
            pathConfig({version: 1, rules: [{patterns: ['^/tools$'], properties: {context: 'modal', modal_style: 'drawer'}}]});
            ypy.config.native = {web: true};
            let opened = [];
            ypy.layers = {open: (url, options) => opened.push(options)};
            await ypy.native.load();
            createProcessedHTML('<a id="a" href="/tools" ypy-boost="true">t</a>');
            find('#a').click();
            await tick();
            assert.deepEqual(opened, [{mode: 'drawer'}]);
            mockResponse('GET', '/other', 'x');
            swapsOnlyOnce();
            createProcessedHTML('<a id="b" href="/other" ypy-boost="true">o</a>');
            find('#b').click();
            await forRequest();
            assert.equal(pageCalls()[0].url, '/other');
        });

        it('without config.native.web a browser leaves a modal route alone', async function () {
            pathConfig(doc);
            ypy.layers = {open: () => assert.fail('no layer expected')};
            await ypy.native.load();
            mockResponse('GET', '/orders/new', 'x');
            swapsOnlyOnce();
            createProcessedHTML('<a id="a" href="/orders/new" ypy-boost="true">new</a>');
            find('#a').click();
            await forRequest();
            assert.equal(pageCalls()[0].url, '/orders/new');
        });
    });

    describe('the shell owns the history', function () {

        it('a swap in the app writes no history entry', async function () {
            await connectApp();
            mockResponse('GET', '/frag', '<p>frag</p>');
            createProcessedHTML('<a id="a" href="/frag" ypy-boost="true" ypy-target="#out" ypy-push-url="/pushed">x</a><div id="out"></div>');
            let before = location.pathname;
            find('#a').click();
            await forRequest();
            assert.equal(find('#out').textContent, 'frag');
            assert.equal(location.pathname, before);
        });

        it('in a browser the entry is written as usual', async function () {
            mockResponse('GET', '/frag', '<p>frag</p>');
            createProcessedHTML('<a id="a" href="/frag" ypy-boost="true" ypy-target="#out" ypy-push-url="/pushed">x</a><div id="out"></div>');
            find('#a').click();
            await forRequest();
            assert.equal(location.pathname, '/pushed');
        });
    });

    describe('native components', function () {

        beforeEach(async () => {
            await connectApp({caps: ['menu', 'date-picker']});
        });

        it('connects an element the build knows, with its props', async function () {
            let elt = createProcessedHTML('<nav id="n" ypy-native-component="menu" ypy-native-props=\'{"items":["a","b"]}\'></nav>');
            await tick();
            let [m] = host.of('component:connect');
            assert.equal(m.name, 'menu');
            assert.deepEqual(m.props, {items: ['a', 'b']});
            assert.isNumber(m.id);
            assert.isNotNull(elt);
        });

        it('connects with empty props when there are none', async function () {
            createProcessedHTML('<nav ypy-native-component="menu"></nav>');
            await tick();
            assert.deepEqual(host.of('component:connect')[0].props, {});
        });

        it('leaves a component the build does not know to the markup', async function () {
            createProcessedHTML('<nav ypy-native-component="map"></nav>');
            await tick();
            assert.lengthOf(host.of('component:connect'), 0);
        });

        for (let [label, props] of [
            ['props that are not JSON', 'not json'],
            ['props that are an array', '[1]'],
            ['props that are null', 'null'],
            ['props over 2 KiB', JSON.stringify({a: 'x'.repeat(2100)})],
        ]) {
            it('sends nothing for ' + label, async function () {
                let quiet = console.warn;
                console.warn = () => {};
                try {
                    let div = document.createElement('div');
                    div.setAttribute('ypy-native-component', 'menu');
                    div.setAttribute('ypy-native-props', props);
                    playground().append(div);
                    ypy.process(playground());
                    await tick();
                } finally { console.warn = quiet }
                assert.lengthOf(host.of('component:connect'), 0);
            });
        }

        it('sends an update when the props change', async function () {
            let elt = createProcessedHTML('<nav ypy-native-component="menu" ypy-native-props=\'{"n":1}\'></nav>');
            await tick();
            let id = host.of('component:connect')[0].id;
            elt.setAttribute('ypy-native-props', '{"n":2}');
            await tick();
            assert.deepEqual(host.of('component:update'), [{type: 'component:update', id, props: {n: 2}}]);
            assert.lengthOf(host.of('component:connect'), 1);
        });

        it('disconnects an element that left the page', async function () {
            let elt = createProcessedHTML('<nav ypy-native-component="menu"></nav>');
            await tick();
            let id = host.of('component:connect')[0].id;
            elt.remove();
            await tick();
            assert.deepEqual(host.of('component:disconnect'), [{type: 'component:disconnect', id}]);
        });

        it('connects the components a swap brought', async function () {
            mockResponse('GET', '/frag', '<div ypy-native-component="date-picker" ypy-native-props=\'{"v":"2026-11-15"}\'></div>');
            createProcessedHTML('<button id="b" ypy-get="/frag" ypy-target="#out">x</button><div id="out"></div>');
            find('#b').click();
            await forRequest();
            await tick();
            assert.equal(host.of('component:connect')[0].name, 'date-picker');
        });

        it('an event of the shell fires ypy:native:event on the element', async function () {
            let elt = createProcessedHTML('<nav ypy-native-component="menu"></nav>');
            await tick();
            let id = host.of('component:connect')[0].id;
            let seen = [];
            elt.addEventListener('ypy:native:event', e => seen.push(e.detail));
            host.emit({type: 'component:event', id, name: 'select', detail: {index: 2}});
            assert.deepEqual(seen, [{id, name: 'select', detail: {index: 2}}]);
        });

        it('an action clicks an element with ypy-native-click', async function () {
            let elt = createProcessedHTML('<button ypy-native-component="menu" ypy-native-click>menu</button>');
            await tick();
            let id = host.of('component:connect')[0].id;
            let clicks = 0;
            elt.addEventListener('click', () => clicks++);
            host.emit({type: 'component:event', id, name: 'action'});
            host.emit({type: 'component:event', id, name: 'other'});
            assert.equal(clicks, 1);
        });

        it('an action does not click an element without ypy-native-click', async function () {
            let elt = createProcessedHTML('<button ypy-native-component="menu">menu</button>');
            await tick();
            let id = host.of('component:connect')[0].id;
            let clicks = 0;
            elt.addEventListener('click', () => clicks++);
            host.emit({type: 'component:event', id, name: 'action'});
            assert.equal(clicks, 0);
        });

        it('a listener that cancels ypy:native:event stops the click', async function () {
            let elt = createProcessedHTML('<button ypy-native-component="menu" ypy-native-click>menu</button>');
            await tick();
            let id = host.of('component:connect')[0].id;
            let clicks = 0;
            elt.addEventListener('click', () => clicks++);
            elt.addEventListener('ypy:native:event', e => e.preventDefault());
            host.emit({type: 'component:event', id, name: 'action'});
            assert.equal(clicks, 0);
        });

        it('ignores an event for an id it never gave', async function () {
            createProcessedHTML('<nav ypy-native-component="menu"></nav>');
            await tick();
            host.emit({type: 'component:event', id: 99999, name: 'action'});
            host.emit({type: 'component:event', id: 'x', name: 'action'});
            host.emit({type: 'component:event', id: 1, name: 5});
        });

        it('an element the init gate refuses (the nonce extension) asks for nothing', async function () {
            let gate = e => { if (e.detail?.native) e.preventDefault() };
            document.addEventListener('ypy:before:init', gate);
            try {
                createProcessedHTML('<nav ypy-native-component="menu"></nav>');
                await tick();
            } finally { document.removeEventListener('ypy:before:init', gate) }
            assert.lengthOf(host.of('component:connect'), 0);
        });

        it('markup under ypy-ignore asks for nothing', async function () {
            createProcessedHTML('<div ypy-ignore><nav ypy-native-component="menu"></nav></div>');
            await tick();
            assert.lengthOf(host.of('component:connect'), 0);
        });

        it('the data- spelling works', async function () {
            createProcessedHTML('<nav data-ypy-native-component="menu" data-ypy-native-props=\'{"a":1}\'></nav>');
            await tick();
            assert.deepEqual(host.of('component:connect')[0].props, {a: 1});
        });
    });

    describe('hiding and showing', function () {

        const hidden = elt => getComputedStyle(elt).display == 'none';

        it('in a browser: ypy-native-only is hidden and inert, ypy-native-hide stays', async function () {
            createProcessedHTML('<div><header id="h" ypy-native-hide>web header</header><p id="o" ypy-native-only>app only</p></div>');
            assert.isFalse(hidden(find('#h')));
            assert.isFalse(find('#h').inert);
            assert.isTrue(hidden(find('#o')));
            assert.isTrue(find('#o').inert);
        });

        it('in the app: ypy-native-hide is hidden and inert, ypy-native-only shows', async function () {
            await connectApp();
            createProcessedHTML('<div><header id="h" ypy-native-hide>web header</header><p id="o" ypy-native-only>app only</p></div>');
            assert.isTrue(hidden(find('#h')));
            assert.isTrue(find('#h').inert);
            assert.isFalse(hidden(find('#o')));
            assert.isFalse(find('#o').inert);
        });

        it('elements already on the page follow the handshake', async function () {
            createProcessedHTML('<div><header id="h" ypy-native-hide>web header</header><p id="o" ypy-native-only>app only</p></div>');
            await connectApp();
            assert.isTrue(hidden(find('#h')));
            assert.isFalse(hidden(find('#o')));
            assert.isFalse(find('#o').inert);
        });

        it('markup the init gate refuses is not hidden', async function () {
            await connectApp();
            let gate = e => { if (e.detail?.native) e.preventDefault() };
            document.addEventListener('ypy:before:init', gate);
            try {
                createProcessedHTML('<div><header id="h" ypy-native-hide>web header</header></div>');
            } finally { document.removeEventListener('ypy:before:init', gate) }
            assert.isFalse(find('#h').inert);
        });
    });

    describe('what the page tells the shell', function () {

        it('sends the address and the title after the handshake and when the title changes', async function () {
            document.title = 'Orders';
            await connectApp();
            assert.deepEqual(host.of('page:update'), [{type: 'page:update', url: location.href, title: 'Orders'}]);
            document.title = 'Order 1';
            await tick();
            assert.equal(host.of('page:update').at(-1).title, 'Order 1');
            assert.lengthOf(host.of('page:update'), 2);
        });

        it('mirrors ypy:announce only when the shell asked for it', async function () {
            await connectApp();
            document.dispatchEvent(new CustomEvent('ypy:announce', {detail: {message: 'Saved', politeness: 'polite'}}));
            assert.lengthOf(host.of('announce'), 0);
            host.emit({type: 'hello', v: 1, platform: 'ios', caps: [], nonce: 'n-2', announce: true});
            document.dispatchEvent(new CustomEvent('ypy:announce', {detail: {message: 'Saved', politeness: 'polite'}}));
            assert.deepEqual(host.of('announce'), [{type: 'announce', message: 'Saved', politeness: 'polite'}]);
        });
    });

    describe('reload', function () {

        it('loads the current screen again with a full response and is not a visit', async function () {
            await connectApp();
            mockResponse('GET', location.pathname, '<p>again</p>');
            swapsOnlyOnce();
            host.emit({type: 'reload'});
            await forRequest(500);
            let call = pageCalls().at(-1);
            assert.equal(call.request.headers['YPY-Boosted'], 'true');
            assert.equal(call.request.headers['YPY-Request-Type'], 'full');
            assert.lengthOf(host.of('visit'), 0);
        });
    });

    describe('disconnect', function () {

        it('stops the header, the visits and the components', async function () {
            await connectApp({caps: ['menu']});
            let elt = createProcessedHTML('<nav ypy-native-component="menu"></nav>');
            await tick();
            ypy.native.disconnect();
            assert.lengthOf(host.of('component:disconnect'), 1);
            mockResponse('GET', '/x', 'x');
            swapsOnlyOnce();
            createProcessedHTML('<a id="a" href="/x" ypy-boost="true">x</a>');
            find('#a').click();
            await forRequest();
            assert.isUndefined(lastFetch().request.headers['YPY-Native']);
            assert.lengthOf(host.of('visit'), 0);
            assert.isNotNull(elt);
        });

        it('ypy.native.send says whether there is a channel', async function () {
            assert.isFalse(ypy.native.send('x'));
            ypy.native.connect(host);
            assert.isTrue(ypy.native.send('custom', {a: 1}));
            assert.deepEqual(host.of('custom'), [{type: 'custom', a: 1}]);
        });

        it('connect refuses something that is not a channel', function () {
            assert.isFalse(ypy.native.connect({}));
            assert.isFalse(ypy.native.connect(null));
        });
    });
});
