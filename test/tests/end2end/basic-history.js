// SPDX-License-Identifier: MIT
describe('ypy-push-url and ypy-replace-url attributes', function() {
    
    beforeEach(() => {
        setupTest(this.currentTest)
        // Clear any existing history state
        if (history.state && history.state.ypy) {
            history.replaceState(null, '', location.pathname);
        }
    })
    
    afterEach(() => {
        cleanupTest()
    })
    
    it('should push URL to history with ypy-push-url="true"', async function() {
        mockResponse('GET', '/test', 'Test Response');
        
        let historyEventFired = false;
        let eventPath = null;
        
        // Listen for the history event
        const handler = (event) => {
            historyEventFired = true;
            eventPath = event.detail.path;
        };
        
        document.addEventListener('ypy:after:history:push', handler);
        
        try {
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-push-url="true">Click me</button>');
            btn.click()
        await forRequest();
            
            playground().textContent.should.equal('Test Response');
            historyEventFired.should.equal(true);
            eventPath.should.equal('/test');
        } finally {
            document.removeEventListener('ypy:after:history:push', handler);
        }
    });
    
    it('should replace URL in history with ypy-replace-url="true"', async function() {
        mockResponse('GET', '/test', 'Test Response');
        
        let historyEventFired = false;
        let eventPath = null;
        
        // Listen for the history event
        const handler = (event) => {
            historyEventFired = true;
            eventPath = event.detail.path;
        };
        
        document.addEventListener('ypy:after:history:replace', handler);
        
        try {
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-replace-url="true">Click me</button>');
            btn.click()
        await forRequest();
            
            playground().textContent.should.equal('Test Response');
            historyEventFired.should.equal(true);
            eventPath.should.equal('/test');
        } finally {
            document.removeEventListener('ypy:after:history:replace', handler);
        }
    });
    
    it('should handle custom URL with ypy-push-url="/custom"', async function() {
        mockResponse('GET', '/test', 'Test Response');
        
        let historyEventFired = false;
        let eventPath = null;
        
        // Listen for the history event
        const handler = (event) => {
            historyEventFired = true;
            eventPath = event.detail.path;
        };
        
        document.addEventListener('ypy:after:history:push', handler);
        
        try {
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-push-url="/custom">Click me</button>');
            btn.click()
        await forRequest();
            
            playground().textContent.should.equal('Test Response');
            historyEventFired.should.equal(true);
            eventPath.should.equal('/custom');
        } finally {
            document.removeEventListener('ypy:after:history:push', handler);
        }
    });
    
    it('should not push to history when ypy-push-url="false"', async function() {
        mockResponse('GET', '/test', 'Test Response');
        
        let historyEventFired = false;
        
        // Listen for the history event (should not fire)
        const handler = (event) => {
            historyEventFired = true;
        };
        
        document.addEventListener('ypy:after:history:push', handler);
        
        try {
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-push-url="false">Click me</button>');
            btn.click()
        await forRequest();
            
            playground().textContent.should.equal('Test Response');
            historyEventFired.should.equal(false);
        } finally {
            document.removeEventListener('ypy:after:history:push', handler);
        }
    });
    
    it('should fire ypy:before:history:update event', async function() {
        mockResponse('GET', '/test', 'Test Response');
        
        let beforeEventFired = false;
        let eventDetails = null;
        
        // Listen for the before history update event
        const handler = (event) => {
            beforeEventFired = true;
            eventDetails = event.detail;
        };
        
        document.addEventListener('ypy:before:history:update', handler);
        
        try {
            let btn = createProcessedHTML('<button ypy-get="/test" ypy-push-url="true">Click me</button>');
            btn.click()
        await forRequest();
            
            playground().textContent.should.equal('Test Response');
            beforeEventFired.should.equal(true);
            eventDetails.history.type.should.equal('push');
            eventDetails.history.path.should.equal('/test');
        } finally {
            document.removeEventListener('ypy:before:history:update', handler);
        }
    });
    
    // this test replaces body innerHTML, so we skip it to avoid breaking other tests, but it can be run manually to verify the behavior
    it.skip('should use innerHTML swap when restoring history even if default swap is none', async function() {
        let originalSwap = ypy.config.defaultSwap;
        ypy.config.defaultSwap = 'none';
        
        try {
            mockResponse('GET', '/restore-test', '<div id="restored">Restored Content</div>');
            
            ypy.__restoreHistory({ypy: true}, '/restore-test');
            await forRequest();
            
            document.body.innerHTML.should.include('Restored Content');
        } finally {
            ypy.config.defaultSwap = originalSwap;
        }
    });
});


describe('outerSync swap into document.body', function() {
    let savedAttrs;
    let savedChildren;

    beforeEach(() => {
        setupTest(this.currentTest);
        savedAttrs = [...document.body.attributes].map(a => ({ name: a.name, value: a.value }));
        savedChildren = [...document.body.childNodes];
    });

    afterEach(() => {
        for (let a of [...document.body.attributes]) document.body.removeAttribute(a.name);
        for (let a of savedAttrs) document.body.setAttribute(a.name, a.value);
        document.body.replaceChildren(...savedChildren);
        cleanupTest();
    });

    it('syncs body attributes from response and replaces children', async function() {
        document.body.setAttribute('data-original', 'yes');
        await ypy.swap({
            target: document.body,
            swap: 'outerSync',
            text: '<html><body class="injected" data-test-x="1"><div id="bodyswap-marker"></div></body></html>',
            sourceElement: document.body
        });
        document.body.classList.contains('injected').should.equal(true);
        document.body.getAttribute('data-test-x').should.equal('1');
        (document.body.getAttribute('data-original') === null).should.equal(true);
        document.getElementById('bodyswap-marker').should.not.equal(null);
    });

    it('outerHTML on body auto-upgrades to outerSync and syncs attributes', async function() {
        document.body.setAttribute('data-original', 'yes');
        await ypy.swap({
            target: document.body,
            swap: 'outerHTML',
            text: '<html><body class="injected" data-test-x="1"><div id="bodyswap-marker"></div></body></html>',
            sourceElement: document.body
        });
        document.body.classList.contains('injected').should.equal(true);
        document.body.getAttribute('data-test-x').should.equal('1');
        (document.body.getAttribute('data-original') === null).should.equal(true);
        document.getElementById('bodyswap-marker').should.not.equal(null);
    });
});

describe('full-page response strip auto-upgrade', function() {

    beforeEach(() => { setupTest(this.currentTest); });
    afterEach(() => { cleanupTest(); });

    it('innerHTML on full-page response strips body wrapper', async function() {
        playground().innerHTML = '<div id="target">old</div>';
        await ypy.swap({
            target: '#target',
            swap: 'innerHTML',
            text: '<html><body><span id="new-child">new</span></body></html>',
            sourceElement: playground()
        });
        let target = playground().querySelector('#target');
        target.should.not.equal(null);
        (target.querySelector('body') === null).should.equal(true);
        target.querySelector('#new-child').should.not.equal(null);
        target.querySelector('#new-child').textContent.should.equal('new');
    });

    it('innerMorph on full-page response strips body wrapper', async function() {
        playground().innerHTML = '<div id="target"><span id="orig">old</span></div>';
        await ypy.swap({
            target: '#target',
            swap: 'innerMorph',
            text: '<html><body><span id="new-child">new</span></body></html>',
            sourceElement: playground()
        });
        let target = playground().querySelector('#target');
        target.should.not.equal(null);
        (target.querySelector('body') === null).should.equal(true);
        target.querySelector('#new-child').should.not.equal(null);
    });

    it('beforeend on full-page response strips body wrapper', async function() {
        playground().innerHTML = '<div id="target"><span id="orig">old</span></div>';
        await ypy.swap({
            target: '#target',
            swap: 'beforeend',
            text: '<html><body><span id="appended">added</span></body></html>',
            sourceElement: playground()
        });
        let target = playground().querySelector('#target');
        (target.querySelector('body') === null).should.equal(true);
        target.querySelector('#orig').should.not.equal(null);
        target.querySelector('#appended').should.not.equal(null);
    });

    it('partial response is unaffected by strip auto-upgrade', async function() {
        playground().innerHTML = '<div id="target">old</div>';
        await ypy.swap({
            target: '#target',
            swap: 'innerHTML',
            text: '<span id="partial-child">partial</span>',
            sourceElement: playground()
        });
        let target = playground().querySelector('#target');
        target.querySelector('#partial-child').should.not.equal(null);
        target.querySelector('#partial-child').textContent.should.equal('partial');
    });
});

describe('outerSync processes inserted nodes correctly', function() {

    beforeEach(() => { setupTest(this.currentTest); });
    afterEach(() => { cleanupTest(); });

    it('processes ypy-trigger="load" elements after outerSync swap', async function() {
        // Simulate the history restore scenario: outerSync into a target with a full-page response
        // containing an element with ypy-trigger="load". The load trigger must fire on the
        // live DOM node, not on the detached <body> fragment.
        mockResponse('GET', '/load-target', 'loaded by ypy-trigger="load"');

        let target = createProcessedHTML('<div id="sync-target"><p>old content</p></div>');

        await ypy.swap({
            target: '#sync-target',
            swap: 'outerSync',
            text: '<html><body><div id="sync-target"><span id="load-elt" ypy-get="/load-target" ypy-trigger="load" ypy-swap="innerHTML">loading...</span></div></body></html>',
            sourceElement: target
        });

        // The load trigger should have fired and issued a request
        await forRequest();

        let elt = document.getElementById('load-elt');
        elt.should.not.equal(null);
        elt.textContent.should.equal('loaded by ypy-trigger="load"');
    });

    it('initializes ypy attributes on nodes inserted via outerSync', async function() {
        let target = createProcessedHTML('<div id="sync-target"><p>old</p></div>');

        await ypy.swap({
            target: '#sync-target',
            swap: 'outerSync',
            text: '<html><body><div id="sync-target"><button id="btn" ypy-get="/test" ypy-swap="innerHTML">click</button></div></body></html>',
            sourceElement: target
        });

        let btn = document.getElementById('btn');
        btn.should.not.equal(null);
        assert.isNotNull(btn._ypy, 'button should be initialized by ypy');
    });
});

describe('ypy-history-elt scopes history restore', function() {

    beforeEach(() => { setupTest(this.currentTest); });
    afterEach(() => { cleanupTest(); });

    it('restoring history with ypy-history-elt swaps only that element and leaves siblings intact', async function() {
        playground().innerHTML = `
            <div id="sentinel">untouched</div>
            <main ypy-history-elt><p id="orig">old</p></main>
            <div id="sentinel-after">also untouched</div>
        `;
        ypy.process(playground());

        let response = `<html><head><title>x</title></head><body>
            <header>HEADER LEAK</header>
            <main ypy-history-elt><p id="new">new</p></main>
            <footer>FOOTER LEAK</footer>
        </body></html>`;
        mockResponse('GET', '/restore-test', response);

        ypy.__restoreHistory({ypy: true}, '/restore-test');
        await forRequest();

        document.getElementById('sentinel').should.not.equal(null);
        document.getElementById('sentinel').textContent.should.equal('untouched');
        document.getElementById('sentinel-after').should.not.equal(null);
        document.getElementById('sentinel-after').textContent.should.equal('also untouched');

        let elt = playground().querySelector('[ypy-history-elt]');
        elt.should.not.equal(null);
        elt.querySelector('#new').should.not.equal(null);
        (elt.querySelector('#orig') === null).should.equal(true);

        document.body.textContent.should.not.include('HEADER LEAK');
        document.body.textContent.should.not.include('FOOTER LEAK');
    });
});



describe('scroll restoration on history traversal', function() {

    const hasNavigationAPI = typeof Navigation === 'function' && !/Firefox\//.test(navigator.userAgent);

    beforeEach(() => { setupTest(this.currentTest); });

    afterEach(() => {
        window.scrollTo(0, 0);
        cleanupTest();
    });

    async function untilScrollY(y, timeout = 1500) {
        let start = performance.now();
        while (window.scrollY !== y && performance.now() - start < timeout) {
            await new Promise(r => requestAnimationFrame(r));
        }
    }

    it('boosted back restores content, then the browser restores scroll', async function() {
        if (!hasNavigationAPI) this.skip();
        playground().innerHTML = '<main ypy-history-elt><div style="height:3000px">page A</div></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/scroll-page-a');
        window.scrollTo(0, 500);
        await new Promise(r => setTimeout(r, 20));

        ypy.__pushUrlIntoHistory('/scroll-page-b');
        playground().innerHTML = '<main ypy-history-elt><p>page B</p></main>';
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 20));

        mockResponse('GET', '/scroll-page-a', () => new Promise(resolve =>
            setTimeout(() => resolve(new MockResponse(
                '<html><body><main ypy-history-elt><div style="height:3000px">page A restored</div></main></body></html>'
            )), 100)));

        history.back();
        await new Promise(r => setTimeout(r, 20));
        await forRequest(400);
        await untilScrollY(500);

        playground().textContent.should.include('page A restored');
        assert.equal(window.scrollY, 500);
    });

    it('back returns to the position saved when the page was left by a push, not to a later one', async function() {
        if (!hasNavigationAPI) this.skip();
        this.timeout(5000);
        playground().innerHTML = '<main ypy-history-elt><div style="height:3000px">page A</div></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/scroll-page-a');
        window.scrollTo(0, 500);
        await new Promise(r => setTimeout(r, 10));
        ypy.__pushUrlIntoHistory('/scroll-page-b');
        playground().innerHTML = '<main ypy-history-elt><div style="height:3000px">page B</div></main>';
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 10));
        mockResponse('GET', '/scroll-page-a',
            '<html><body><main ypy-history-elt><div style="height:3000px">page A</div></main></body></html>');
        mockResponse('GET', '/scroll-page-b',
            '<html><body><main ypy-history-elt><div style="height:3000px">page B</div></main></body></html>');

        history.back();
        await forRequest();
        await untilScrollY(500);
        await new Promise(r => setTimeout(r, 10));
        window.scrollTo(0, 800);
        await new Promise(r => setTimeout(r, 10));
        history.forward();
        await forRequest();
        await untilScrollY(0);
        await new Promise(r => setTimeout(r, 10));
        history.back();
        await forRequest();
        await untilScrollY(500);

        assert.equal(window.scrollY, 500);
    });

    it('back to an entry created by an anchor jump still restores content', async function() {
        if (!hasNavigationAPI) this.skip();
        playground().innerHTML = '<main ypy-history-elt><div style="height:3000px">reference page</div></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/scroll-ref');

        location.hash = '#events';
        assert.isNull(history.state);
        // Simulate what a real ypy swap does before pushing: stamp the anchor-jump entry
        // so back traversals to it are interceptable by the Navigation API.
        history.replaceState({ypy: true}, '', location.href);
        window.scrollTo(0, 500);
        await new Promise(r => setTimeout(r, 20));

        ypy.__pushUrlIntoHistory('/scroll-ypyget');
        playground().innerHTML = '<main ypy-history-elt><p>ypy-get page</p></main>';
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 20));

        mockResponse('GET', '/scroll-ref', () => new Promise(resolve =>
            setTimeout(() => resolve(new MockResponse(
                '<html><body><main ypy-history-elt><div style="height:3000px">reference restored</div></main></body></html>'
            )), 100)));

        history.back();
        await forRequest(400);
        await untilScrollY(500);

        playground().textContent.should.include('reference restored');
        assert.equal(location.hash, '#events');
        assert.equal(window.scrollY, 500);
    });

    it('restores horizontal scroll as well', async function() {
        if (!hasNavigationAPI) this.skip();
        playground().innerHTML = '<main ypy-history-elt><div style="height:3000px;width:3000px">wide page</div></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/scroll-wide');
        window.scrollTo(300, 500);

        ypy.__pushUrlIntoHistory('/scroll-narrow');
        playground().innerHTML = '<main ypy-history-elt><p>narrow page</p></main>';
        window.scrollTo(0, 0);

        mockResponse('GET', '/scroll-wide', () => new Promise(resolve =>
            setTimeout(() => resolve(new MockResponse(
                '<html><body><main ypy-history-elt><div style="height:3000px;width:3000px">wide restored</div></main></body></html>'
            )), 100)));

        history.back();
        await forRequest(400);
        await untilScrollY(500);

        assert.equal(window.scrollY, 500);
        assert.equal(window.scrollX, 300);
    });

    it('ignores traversal to non-ypy history entries', async function() {
        history.replaceState({foreign: true}, '', '/foreign-page');
        history.pushState({ypy: true}, '', '/scroll-page-b');

        history.back();
        let evt = await forRequest(150);

        assert.isNull(evt);
    });
    it('ignores hash-only traversal', async function() {
        if (!hasNavigationAPI) this.skip();
        history.replaceState({ypy: true}, '', location.pathname + '#a');
        history.pushState({ypy: true}, '', location.pathname + '#b');

        history.back();
        let evt = await forRequest(150);

        assert.isNull(evt);
        assert.equal(location.hash, '#a');
    });
});

describe('YPY-Request-Type header in history restore', function() {

    beforeEach(function() { setupTest(); });
    afterEach(function() { cleanupTest(); });

    it('sends YPY-Request-Type: full for history restore to body', async function() {
        mockResponse('GET', '/restore-test', '<html><body><div>restored</div></body></html>', { headers: { 'YPY-Reswap': 'none' } });

        ypy.__restoreHistory({ypy: true}, '/restore-test');
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Request-Type'], 'full');
    });

    it('sends YPY-Request-Type: full for history restore with ypy-history-elt', async function() {
        playground().innerHTML = '<main ypy-history-elt><p>old</p></main>';
        ypy.process(playground());

        mockResponse('GET', '/restore-test', '<html><body><main ypy-history-elt><p>new</p></main></body></html>', { headers: { 'YPY-Reswap': 'none' } });

        ypy.__restoreHistory({ypy: true}, '/restore-test');
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-Request-Type'], 'full');
    });

    it('sends YPY-History-Restore-Request: true for history restore', async function() {
        mockResponse('GET', '/restore-test', '<html><body><div>restored</div></body></html>', { headers: { 'YPY-Reswap': 'none' } });

        ypy.__restoreHistory({ypy: true}, '/restore-test');
        await forRequest();

        assert.equal(lastFetch().request.headers['YPY-History-Restore-Request'], 'true');
    });

    it('does not send YPY-Request header for history restore (so servers return full pages)', async function() {
        mockResponse('GET', '/restore-test', '<html><body><div>restored</div></body></html>', { headers: { 'YPY-Reswap': 'none' } });

        ypy.__restoreHistory({ypy: true}, '/restore-test');
        await forRequest();

        // YPY-Request is intentionally omitted so servers return full pages
        assert.isUndefined(lastFetch().request.headers['YPY-Request']);
    });
});

describe('history restore edge cases', function() {

    beforeEach(function() { setupTest(); });
    afterEach(function() { cleanupTest(); });

    it('a second back aborts the in-flight restore', async function() {
        this.timeout(5000);
        playground().innerHTML = '<main ypy-history-elt><p>page C</p></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/edge-a');
        ypy.__pushUrlIntoHistory('/edge-b');
        ypy.__pushUrlIntoHistory('/edge-c');

        mockResponse('GET', '/edge-a',
            '<html><body><main ypy-history-elt><p>page A</p></main></body></html>');
        mockResponse('GET', '/edge-b', () => new Promise(resolve =>
            setTimeout(() => resolve(new MockResponse(
                '<html><body><main ypy-history-elt><p>page B</p></main></body></html>'
            )), 150)));

        history.back();
        await new Promise(r => setTimeout(r, 50));
        history.back();
        await new Promise(r => setTimeout(r, 500));

        assert.equal(location.pathname, '/edge-a');
        playground().textContent.should.include('page A');
    });

    it('restores the replaced URL after a replace', async function() {
        playground().innerHTML = '<main ypy-history-elt><p>replaced page</p></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/edge-orig');
        ypy.__pushUrlIntoHistory('/edge-next');
        ypy.__replaceUrlInHistory('/edge-replaced');

        mockResponse('GET', '/edge-orig',
            '<html><body><main ypy-history-elt><p>original restored</p></main></body></html>');
        mockResponse('GET', '/edge-replaced',
            '<html><body><main ypy-history-elt><p>replaced restored</p></main></body></html>');

        history.back();
        await forRequest();
        playground().textContent.should.include('original restored');
        assert.equal(location.pathname, '/edge-orig');
        await new Promise(r => setTimeout(r, 50));

        history.forward();
        await forRequest();
        playground().textContent.should.include('replaced restored');
        assert.equal(location.pathname, '/edge-replaced');
    });

    it('skips a foreign entry but restores the ypy entry behind it', async function() {
        playground().innerHTML = '<main ypy-history-elt><p>after page</p></main>';
        ypy.process(playground());
        history.replaceState({ypy: true}, '', '/edge-mine');
        history.pushState({vue: true}, '', '/edge-foreign');
        ypy.__pushUrlIntoHistory('/edge-after');

        mockResponse('GET', '/edge-mine',
            '<html><body><main ypy-history-elt><p>mine restored</p></main></body></html>');

        history.back();
        let evt = await forRequest(150);
        assert.isNull(evt);
        playground().textContent.should.include('after page');
        assert.equal(location.pathname, '/edge-foreign');

        history.back();
        await forRequest();
        playground().textContent.should.include('mine restored');
        assert.equal(location.pathname, '/edge-mine');
    });
});

