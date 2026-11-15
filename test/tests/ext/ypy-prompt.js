// SPDX-License-Identifier: MIT
describe('ypy-prompt extension', function() {

    let extBackup;
    let originalPrompt;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        ypy.config.extensions = 'ypy-prompt';

        let script = document.createElement('script');
        script.src = '../src/ext/ypy-prompt.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => {
        setupTest();
        originalPrompt = window.prompt;
    });

    afterEach(() => {
        cleanupTest();
        window.prompt = originalPrompt;
        delete window.ypyPrompt;
    });

    it('sends prompt response as YPY-Prompt header', async function() {
        window.prompt = () => 'because';
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Reason for deletion?">Delete</button>');
        btn.click();
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Prompt'], 'because');
    });

    it('URI-encodes unicode prompt responses for fetch headers', async function() {
        window.prompt = () => '中文 reason';

        let fetchCalled = false;
        let encodedHeader;
        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Reason for deletion?">Delete</button>');
        btn.addEventListener('ypy:before:request', (e) => {
            e.detail.ctx.fetch = async (action, request) => {
                fetchCalled = true;
                encodedHeader = request.headers['YPY-Prompt'];
                new Request(new URL(action, location.href), request);
                return new Response('ok');
            };
        });

        btn.click();
        await forRequest();

        assert.isTrue(fetchCalled);
        assert.equal(encodedHeader, encodeURI('中文 reason'));
    });

    it('aborts the request when the user cancels', async function() {
        window.prompt = () => null;
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Reason for deletion?">Delete</button>');
        btn.click();
        await forRequest();

        assert.isUndefined(fetchMock.getLastCall());
    });

    it('accepts an empty string as a valid answer', async function() {
        window.prompt = () => '';
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Reason for deletion?">Delete</button>');
        btn.click();
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Prompt'], '');
    });

    it('does nothing when ypy-prompt is absent', async function() {
        let prompted = false;
        window.prompt = () => { prompted = true; return 'x'; };
        mockResponse('GET', '/items/1', 'ok');

        let btn = createProcessedHTML('<button ypy-get="/items/1">Go</button>');
        btn.click();
        await forRequest();

        assert.isFalse(prompted);
        assert.isUndefined(lastFetch().request.headers['YPY-Prompt']);
    });

    it('inherits via :inherited from a container', async function() {
        window.prompt = () => 'inherited';
        mockResponse('DELETE', '/items/1', 'ok');

        createProcessedHTML(`
            <div ypy-prompt:inherited="Reason?">
                <button ypy-delete="/items/1">Delete</button>
                <button ypy-delete="/items/2">Delete</button>
            </div>
        `);
        find('button').click();
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Prompt'], 'inherited');
    });

    it('composes with ypy-confirm (both pass)', async function() {
        window.prompt = () => 'a reason';
        let originalConfirm = window.confirm;
        window.confirm = () => true;
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML(
            '<button ypy-delete="/items/1" ypy-prompt="Reason?" ypy-confirm="Are you sure?">Delete</button>'
        );
        btn.click();
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Prompt'], 'a%20reason');
        window.confirm = originalConfirm;
    });

    it('cancelling ypy-prompt skips ypy-confirm and the request', async function() {
        window.prompt = () => null;
        let confirmShown = false;
        let originalConfirm = window.confirm;
        window.confirm = () => { confirmShown = true; return true; };
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML(
            '<button ypy-delete="/items/1" ypy-prompt="Reason?" ypy-confirm="Are you sure?">Delete</button>'
        );
        btn.click();
        await forRequest();

        assert.isFalse(confirmShown);
        assert.isUndefined(fetchMock.getLastCall());
        window.confirm = originalConfirm;
    });

    it('exposes prompt and target on the ypy:prompt event detail', async function() {
        window.prompt = () => 'hello';
        mockResponse('DELETE', '/items/1', 'ok');

        let captured = null;
        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Q?">Delete</button>');
        btn.addEventListener('ypy:prompt', (e) => captured = e.detail);
        btn.click();
        await forRequest();

        assert.equal(captured.prompt, 'hello');
        assert.equal(captured.target, btn);
    });

    it('ypy-on::prompt can preventDefault to abort the request', async function() {
        mockResponse('DELETE', '/items/1', 'ok');
        let btn = createProcessedHTML(
            '<button ypy-delete="/items/1" ypy-prompt="Reason?" ypy-on::prompt="if (prompt.length < 3) event.preventDefault()">Delete</button>'
        );

        window.prompt = () => 'no';
        btn.click();
        await forRequest();
        assert.isUndefined(fetchMock.getLastCall());

        window.prompt = () => 'long enough';
        btn.click();
        await forRequest();
        assert.equal(lastFetch().request.headers['YPY-Prompt'], 'long%20enough');
    });

    it('uses window.ypyPrompt when defined', async function() {
        window.ypyPrompt = (question) => 'answered: ' + question;
        window.prompt = () => { throw new Error('window.prompt should not be called'); };
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Q?">Delete</button>');
        btn.click();
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Prompt'], 'answered:%20Q?');
    });

    it('null from window.ypyPrompt aborts the request', async function() {
        window.ypyPrompt = () => null;
        mockResponse('DELETE', '/items/1', 'ok');

        let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Q?">Delete</button>');
        btn.click();
        await forRequest();

        assert.isUndefined(fetchMock.getLastCall());
    });

    it('obeys metaCharacter when creating events', async function() {
        let oldMetaCharacter = ypy.config.metaCharacter
        ypy.config.metaCharacter = '-'
        try {
            window.prompt = () => 'because';
            mockResponse('DELETE', '/items/1', 'ok');

            let btn = createProcessedHTML('<button ypy-delete="/items/1" ypy-prompt="Q?">Delete</button>');
            let eventName;
            btn.addEventListener('ypy:prompt', (e) => eventName = e.type);
            btn.addEventListener('ypy-prompt', (e) => eventName = e.type);

            btn.click();
            await forRequest();

            assert.equal(eventName, 'ypy-prompt', 'fired event uses metaCharacter')
        } finally {
            ypy.config.metaCharacter = oldMetaCharacter
        }
    })

    describe('ypy-on recipe (no extension needed)', () => {
        const recipe = "ctx.request.headers['YPY-Prompt'] = prompt('Reason?') ?? event.preventDefault()";

        it('sends YPY-Prompt with the answer', async function() {
            window.prompt = () => 'a reason';
            mockResponse('DELETE', '/items/1', 'ok');

            let btn = createProcessedHTML(`<button ypy-delete="/items/1" ypy-on::config:request="${recipe}">Delete</button>`);
            btn.click();
            await forRequest();

            assert.equal(lastFetch().request.headers['YPY-Prompt'], 'a reason');
        });

        it('aborts the request on cancel', async function() {
            window.prompt = () => null;
            mockResponse('DELETE', '/items/1', 'ok');

            let btn = createProcessedHTML(`<button ypy-delete="/items/1" ypy-on::config:request="${recipe}">Delete</button>`);
            btn.click();
            await forRequest();

            assert.isUndefined(fetchMock.getLastCall());
        });
    });
});
