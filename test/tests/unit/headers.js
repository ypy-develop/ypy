// SPDX-License-Identifier: MIT
describe('Request Headers', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    describe('YPY-Source header', function() {

        it('formats element with id', function() {
            let btn = createProcessedHTML('<button id="test-btn" ypy-get="/test"></button>');
            let ctx = ypy.__createRequestContext(btn, new Event('click'));
            ctx.request.headers['YPY-Source'].should.equal('button#test-btn');
        });

        it('formats element with neither id nor name', function() {
            let btn = createProcessedHTML('<button ypy-get="/test"></button>');
            let ctx = ypy.__createRequestContext(btn, new Event('click'));
            ctx.request.headers['YPY-Source'].should.equal('button');
        });

        it('formats div element', function() {
            let div = createProcessedHTML('<div id="content" ypy-get="/test"></div>');
            let ctx = ypy.__createRequestContext(div, new Event('click'));
            ctx.request.headers['YPY-Source'].should.equal('div#content');
        });

        it('formats form element', function() {
            let form = createProcessedHTML('<form id="my-form" name="contact" ypy-post="/test"></form>');
            let ctx = ypy.__createRequestContext(form, new Event('submit'));
            ctx.request.headers['YPY-Source'].should.equal('form#my-form');
        });

    });

    describe('YPY-Target header', function() {

        it('formats target element with id', async function() {
            createProcessedHTML('<div id="result"></div><button ypy-get="js:" ypy-target="#result"></button>');
            let btn = document.querySelector('button');
            let ctx = ypy.__createRequestContext(btn, new Event('click'));
            await ypy.__handleTriggerEvent(ctx);
            ctx.request.headers['YPY-Target'].should.equal('div#result');
        });

        it('formats target when targeting self', async function() {
            let btn = createProcessedHTML('<button id="self-btn" ypy-get="js:"></button>');
            let ctx = ypy.__createRequestContext(btn, new Event('click'));
            await ypy.__handleTriggerEvent(ctx);
            ctx.request.headers['YPY-Target'].should.equal('button#self-btn');
        });

        it('formats body target', async function() {
            let btn = createProcessedHTML('<button ypy-get="js:" ypy-target="body"></button>');
            let ctx = ypy.__createRequestContext(btn, new Event('click'));
            await ypy.__handleTriggerEvent(ctx);
            ctx.request.headers['YPY-Target'].should.equal('body');
        });

    });

    describe('YPY-Request-Type header', function() {

        it('sets to partial for regular element target', async function() {
            mockResponse('GET', '/test', 'ok');
            createProcessedHTML('<div id="result"></div><button ypy-get="/test" ypy-target="#result"></button>');
            let btn = document.querySelector('button');
            btn.click();
            await forRequest();
            lastFetch().request.headers['YPY-Request-Type'].should.equal('partial');
        });

        it('sets to partial when targeting self', async function() {
            mockResponse('GET', '/test', 'ok');
            let btn = createProcessedHTML('<button ypy-get="/test"></button>');
            btn.click();
            await forRequest();
            lastFetch().request.headers['YPY-Request-Type'].should.equal('partial');
        });

        it('sets to full when targeting body', async function() {
            mockResponse('GET', '/test', 'ok');
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-target="body" ypy-swap="none"></button>');
            btn.click();
            await forRequest();
            lastFetch().request.headers['YPY-Request-Type'].should.equal('full');
        });

        it('sets to full when ypy-select is present', async function() {
            mockResponse('GET', '/test', '<div id="content">ok</div>');
            createProcessedHTML('<div id="result"></div><button ypy-get="/test" ypy-target="#result" ypy-select="#content"></button>');
            let btn = document.querySelector('button');
            btn.click();
            await forRequest();
            lastFetch().request.headers['YPY-Request-Type'].should.equal('full');
        });

        it('sets to full when ypy-select and body target both present', async function() {
            mockResponse('GET', '/test', '<div id="content">ok</div>');
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-target="body" ypy-select="#content" ypy-swap="none"></button>');
            btn.click();
            await forRequest();
            lastFetch().request.headers['YPY-Request-Type'].should.equal('full');
        });

    });

    describe('__buildIdentifier method', function() {

        it('builds identifier with id only', function() {
            let div = document.createElement('div');
            div.id = 'test';
            ypy.__buildIdentifier(div).should.equal('div#test');
        });

        it('builds identifier with neither id nor name', function() {
            let span = document.createElement('span');
            ypy.__buildIdentifier(span).should.equal('span');
        });

        it('handles body element', function() {
            ypy.__buildIdentifier(document.body).should.equal('body');
        });

        it('encodes unicode characters in id for safe header usage', function() {
            let div = document.createElement('div');
            div.id = '🚀';
            ypy.__buildIdentifier(div).should.equal('div#%F0%9F%9A%80');
        });

    });

});
