// SPDX-License-Identifier: MIT
describe('ypy-csrf extension', function () {

    let extBackup, warnings, originalWarn;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-csrf.js';
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
        warnings = [];
        originalWarn = console.warn;
        console.warn = (...args) => { warnings.push(args.join(' ')) };
    });

    afterEach(async () => {
        console.warn = originalWarn;
        document.head.querySelectorAll('meta[name="ypy-csrf"]').forEach(m => m.remove());
        cleanupTest();
        await ypy.timeout(10);
    });

    const csrfWarnings = () => warnings.filter(w => w.includes('ypy-csrf'));

    function meta(token, header) {
        let m = document.createElement('meta');
        m.name = 'ypy-csrf';
        m.content = token;
        if (header) m.setAttribute('data-header', header);
        document.head.appendChild(m);
        return m;
    }

    async function send(html, selector = 'button') {
        createProcessedHTML(html);
        find(selector).click();
        await forRequest();
    }

    // -------------------------------------------------------------------------
    // The token on the request
    // -------------------------------------------------------------------------

    it('sends the token of the meta tag on a same-origin POST, in X-CSRF-Token', async function () {
        meta('tok-1');
        mockResponse('POST', '/save', 'saved');
        await send('<button ypy-post="/save">Save</button>');
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'tok-1');
    });

    it('sends it on PUT, PATCH and DELETE too', async function () {
        meta('tok-2');
        for (let method of ['put', 'patch', 'delete']) {
            mockResponse(method, '/item', 'ok');
            await send(`<button ypy-${method}="/item">Go</button>`);
            assert.equal(lastFetch().request.method, method.toUpperCase());
            assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'tok-2', method);
        }
    });

    it('does not send it on a GET', async function () {
        meta('tok-3');
        mockResponse('GET', '/list', 'items');
        await send('<button ypy-get="/list">Load</button>');
        assert.isUndefined(lastFetch().request.headers['X-CSRF-Token']);
        assert.lengthOf(csrfWarnings(), 0);
    });

    it('uses the header named by data-header', async function () {
        meta('tok-4', 'X-XSRF-Token');
        mockResponse('POST', '/save', 'saved');
        await send('<button ypy-post="/save">Save</button>');
        assert.equal(lastFetch().request.headers['X-XSRF-Token'], 'tok-4');
        assert.isUndefined(lastFetch().request.headers['X-CSRF-Token']);
    });

    it('sends it from a form submit, with no inheritance on the element', async function () {
        meta('tok-5');
        mockResponse('POST', '/form', 'ok');
        createProcessedHTML('<div><form ypy-post="/form"><input name="a" value="1"><button>Go</button></form></div>');
        find('form button').click();
        await forRequest();
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'tok-5');
        assert.equal(lastFetch().request.body.get('a'), '1');
    });

    it('follows a change of the meta tag between two requests', async function () {
        let m = meta('old');
        mockResponse('POST', '/save', 'saved');
        createProcessedHTML('<button ypy-post="/save">Save</button>');
        find('button').click();
        await forRequest();
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'old');
        m.setAttribute('content', 'new');
        find('button').click();
        await forRequest();
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'new');
    });

    it('replaces a stale token that the element inherited', async function () {
        meta('fresh');
        mockResponse('POST', '/save', 'saved');
        await send('<div ypy-headers=\'{"X-CSRF-Token": "stale"}\'><button ypy-post="/save">Save</button></div>');
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'fresh');
    });

    // -------------------------------------------------------------------------
    // Other origins
    // -------------------------------------------------------------------------

    it('never sends the token to another origin', async function () {
        meta('secret');
        mockResponse('POST', 'other.example/save', 'saved');
        await send('<button ypy-post="https://other.example/save">Save</button>');
        assert.equal(lastFetch().url, 'https://other.example/save');
        assert.isUndefined(lastFetch().request.headers['X-CSRF-Token']);
        assert.lengthOf(csrfWarnings(), 0, 'a cross-origin request is not the page\'s own');
    });

    it('removes a token that an element inherited from a request to another origin', async function () {
        meta('secret');
        mockResponse('POST', 'other.example/save', 'saved');
        await send('<div ypy-headers=\'{"x-csrf-token": "inherited"}\'><button ypy-post="https://other.example/save">Save</button></div>');
        let names = Object.keys(lastFetch().request.headers).map(k => k.toLowerCase());
        assert.notInclude(names, 'x-csrf-token');
    });

    it('treats an absolute URL of the page\'s own origin as same-origin', async function () {
        meta('tok-6');
        mockResponse('POST', '/abs', 'ok');
        await send(`<button ypy-post="${location.origin}/abs">Go</button>`);
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'tok-6');
    });

    // -------------------------------------------------------------------------
    // Renewal
    // -------------------------------------------------------------------------

    it('updates the meta tag from the YPY-CSRF response header, and the next request uses it', async function () {
        let m = meta('first');
        mockResponse('POST', '/save', 'saved', {headers: {'YPY-CSRF': 'second'}});
        createProcessedHTML('<button ypy-post="/save">Save</button>');
        find('button').click();
        await forRequest();
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'first');
        assert.equal(m.getAttribute('content'), 'second');
        find('button').click();
        await forRequest();
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'second');
    });

    it('renews on a GET response and on an error response as well', async function () {
        let m = meta('a');
        mockResponse('GET', '/ping', 'pong', {headers: {'YPY-CSRF': 'b'}});
        await send('<button ypy-get="/ping">Ping</button>');
        assert.equal(m.getAttribute('content'), 'b');
        mockResponse('POST', '/denied', 'no', {status: 403, headers: {'YPY-CSRF': 'c'}});
        await send('<button ypy-post="/denied">Go</button>');
        assert.equal(m.getAttribute('content'), 'c');
    });

    it('creates the meta tag when the first token arrives by header', async function () {
        mockResponse('GET', '/session', 'hi', {headers: {'YPY-CSRF': 'born'}});
        await send('<button ypy-get="/session">Go</button>');
        assert.equal(document.head.querySelector('meta[name="ypy-csrf"]')?.content, 'born');
        mockResponse('POST', '/save', 'saved');
        await send('<button ypy-post="/save">Save</button>');
        assert.equal(lastFetch().request.headers['X-CSRF-Token'], 'born');
    });

    it('ignores a YPY-CSRF header from another origin', async function () {
        let m = meta('mine');
        mockResponse('GET', 'other.example/x', 'x', {headers: {'YPY-CSRF': 'hostile'}});
        await send('<button ypy-get="https://other.example/x">Go</button>');
        assert.equal(m.getAttribute('content'), 'mine');
    });

    // -------------------------------------------------------------------------
    // A missing token
    // -------------------------------------------------------------------------

    it('fires ypy:csrf:missing and warns when an unsafe request leaves without a token', async function () {
        mockResponse('POST', '/save', 'saved');
        createProcessedHTML('<button ypy-post="/save">Save</button>');
        let detail;
        find('button').addEventListener('ypy:csrf:missing', e => { detail = e.detail });
        find('button').click();
        await forRequest();
        assert.equal(detail.header, 'X-CSRF-Token');
        assert.equal(detail.ctx.request.method, 'POST');
        assert.lengthOf(csrfWarnings(), 1);
        assert.include(csrfWarnings()[0], '/save');
        assert.isUndefined(lastFetch().request.headers['X-CSRF-Token'], 'the request still goes out');
    });

    it('treats an empty meta tag as no token and names the configured header', async function () {
        meta('', 'X-XSRF-Token');
        mockResponse('POST', '/save', 'saved');
        createProcessedHTML('<button ypy-post="/save">Save</button>');
        let detail;
        find('button').addEventListener('ypy:csrf:missing', e => { detail = e.detail });
        find('button').click();
        await forRequest();
        assert.equal(detail.header, 'X-XSRF-Token');
    });

    it('warns once per URL, but fires the event every time', async function () {
        mockResponse('POST', '/once', 'ok');
        createProcessedHTML('<button ypy-post="/once">Go</button>');
        let count = 0;
        find('button').addEventListener('ypy:csrf:missing', () => { count++ });
        for (let i = 0; i < 3; i++) {
            find('button').click();
            await forRequest();
        }
        assert.equal(count, 3);
        assert.lengthOf(csrfWarnings(), 1);
    });

    it('stays quiet when the event is canceled', async function () {
        mockResponse('POST', '/quiet', 'ok');
        createProcessedHTML('<button ypy-post="/quiet">Go</button>');
        find('button').addEventListener('ypy:csrf:missing', e => e.preventDefault());
        find('button').click();
        await forRequest();
        assert.lengthOf(csrfWarnings(), 0);
    });

    it('does not fire ypy:csrf:missing for a GET or for another origin', async function () {
        let fired = 0, count = () => { fired++ };
        document.addEventListener('ypy:csrf:missing', count);
        mockResponse('GET', '/list', 'items');
        await send('<button ypy-get="/list">Load</button>');
        mockResponse('POST', 'other.example/save', 'ok');
        await send('<button ypy-post="https://other.example/save">Save</button>');
        document.removeEventListener('ypy:csrf:missing', count);
        assert.equal(fired, 0);
    });
});
