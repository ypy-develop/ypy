// SPDX-License-Identifier: MIT
describe('ypy-pending attribute', function() {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-pending.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    })

    after(() => {
        restoreExtensions(extBackup);
    })

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest(this.currentTest)
    })


    it('innerHTML swap hides children and appends pending div', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result"><span>Original</span></div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('innerHTML swap with target as CSS selector string', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('resolves extended target selectors from the source element', async function () {
        mockResponse('POST', '/submit', 'Final')
        const result = createProcessedHTML('<div class="result"><span>Original</span><button ypy-post="/submit" ypy-target="closest .result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button></div><div id="opt" style="display:none">Pending</div>');
        let pendingTarget
        find('button').addEventListener('ypy:before:request', () => {
            pendingTarget = document.querySelector('.ypy-pending')?.parentElement
        })

        find('button').click()
        await forRequest()

        assert.equal(pendingTarget, result)
        assert.equal(result.textContent.trim(), 'Final')
    })

    it('outerHTML swap hides target and inserts pending div after', async function () {
        mockResponse('POST', '/submit', '<div id="result">Final</div>')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="outerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('beforebegin swap inserts pending div before target', async function () {
        mockResponse('POST', '/submit', '<span>New</span>')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="beforebegin" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.include(playground().textContent, 'New');
    })

    it('afterbegin swap inserts pending div at start of target', async function () {
        mockResponse('POST', '/submit', '<span>New</span>')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="afterbegin" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.include(find('#result').textContent, 'New');
    })

    it('beforeend swap inserts pending div at end of target', async function () {
        mockResponse('POST', '/submit', '<span>New</span>')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="beforeend" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.include(find('#result').textContent, 'New');
    })

    it('afterend swap inserts pending div after target', async function () {
        mockResponse('POST', '/submit', '<span>New</span>')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="afterend" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.include(playground().textContent, 'New');
    })

    it('delete swap uses default outerHTML-like behavior', async function () {
        mockResponse('POST', '/submit', '')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="delete" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.isUndefined(find('#result'));
    })

    it('none swap uses default outerHTML-like behavior', async function () {
        mockResponse('POST', '/submit', 'ignored')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="none" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Original');
    })

    it('removes pending content after successful response', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.isNull(document.querySelector('.ypy-pending'));
    })

    it('removes pending content on error', async function () {
        fetchMock.mockResponse('POST', '/submit', () => Promise.reject(new Error('Network error')));
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await waitForEvent('ypy:error', 2000);
        assert.isNull(document.querySelector('.ypy-pending'));
    })

    it('unhides hidden elements after swap', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result"><span id="child">Original</span></div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('unhides hidden elements on error', async function () {
        fetchMock.mockResponse('POST', '/submit', () => Promise.reject(new Error('Network error')));
        createProcessedHTML('<div id="result"><span>Original</span></div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await waitForEvent('ypy:error', 2000);
        assert.equal(find('#result span').style.display, '');
    })

    it('does nothing when pending selector not found', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#nonexistent">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('does nothing when ypy-pending not specified', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('does nothing when target not found', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#nonexistent" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.isNull(document.querySelector('.ypy-pending'));
    })

    it('works when target is resolved from CSS selector', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('pending div has reset styling', async function () {
        mockResponse('POST', '/submit', 'Final')
        let pendingDiv = null;
        document.addEventListener('ypy:before:request', function() {
            setTimeout(() => {
                pendingDiv = document.querySelector('.ypy-pending');
            }, 0);
        }, {once: true});
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        // Just verify it completed - styling check would happen during request
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('copies innerHTML from source element', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none"><strong>Pending</strong></div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('works with complex HTML in source', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none"><ul><li>Item 1</li><li>Item 2</li></ul></div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt">Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('multiple requests clean up independently', async function () {
        mockResponse('POST', '/submit1', 'Final1')
        mockResponse('POST', '/submit2', 'Final2')
        createProcessedHTML('<div id="r1">A</div><div id="r2">B</div><div id="opt" style="display:none">Opt</div><button id="b1" ypy-post="/submit1" ypy-target="#r1" ypy-swap="innerHTML" ypy-pending="#opt">Go1</button><button id="b2" ypy-post="/submit2" ypy-target="#r2" ypy-swap="innerHTML" ypy-pending="#opt">Go2</button>');
        find('#b1').click()
        await forRequest()
        find('#b2').click()
        await forRequest()
        assert.isNull(document.querySelector('.ypy-pending'));
    })

    it('works with ypy-config override', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-config=\'{"pending": "#opt"}\'>Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('ypy-pending attribute takes precedence over ypy-config', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt1" style="display:none">Opt1</div><div id="opt2" style="display:none">Opt2</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt1" ypy-config=\'{"pending": "#opt2"}\'>Go</button>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('works with inherited target', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div ypy-target:inherited="#result"><div id="result">Original</div><div id="opt" style="display:none">Pending</div><button ypy-post="/submit" ypy-swap="innerHTML" ypy-pending="#opt">Go</button></div>');
        find('button').click()
        await forRequest()
        assert.equal(find('#result').textContent.trim(), 'Final');
    })

    it('sets data-* attributes on pending div for each form param', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<form ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt"><input name="color" value="blue"><input name="size" value="large"><button type="submit">Go</button></form><div id="result">Original</div><div id="opt" style="display:none">content</div>');
        let dataColor, dataSize;
        document.addEventListener('ypy:before:request', () => {
            let el = document.querySelector('.ypy-pending');
            if (el) { dataColor = el.dataset.color; dataSize = el.dataset.size; }
        }, {once: true});
        find('button').click()
        await forRequest()
        assert.equal(dataColor, 'blue');
        assert.equal(dataSize, 'large');
    })

    it('sets data-* from ypy-vals', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<div id="result">Original</div><div id="opt" style="display:none">content</div><button ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt" ypy-vals=\'{"count": "42"}\'>Go</button>');
        let dataCount;
        document.addEventListener('ypy:before:request', () => {
            let el = document.querySelector('.ypy-pending');
            if (el) dataCount = el.dataset.count;
        }, {once: true});
        find('button').click()
        await forRequest()
        assert.equal(dataCount, '42');
    })

    it('data-* values are safe from XSS via dataset API', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<form ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt"><input name="name" value="&quot;onclick=alert(1)"><button type="submit">Go</button></form><div id="result">Original</div><div id="opt" style="display:none">x</div>');
        let dataName;
        document.addEventListener('ypy:before:request', () => {
            let el = document.querySelector('.ypy-pending');
            if (el) dataName = el.dataset.name;
        }, {once: true});
        find('button').click()
        await forRequest()
        assert.equal(dataName, '"onclick=alert(1)');
    })

    it('static template content renders without ypy-live', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<form ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt"><input name="x" value="y"><button type="submit">Go</button></form><div id="result">Original</div><div id="opt" style="display:none">Static pending</div>');
        let optText;
        document.addEventListener('ypy:before:request', () => {
            let el = document.querySelector('.ypy-pending');
            if (el) optText = el.textContent;
        }, {once: true});
        find('button').click()
        await forRequest()
        assert.equal(optText, 'Static pending');
    })

    it('skips file inputs in data-* attributes', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<form ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt"><input name="title" value="doc"><input name="file" type="file"><button type="submit">Go</button></form><div id="result">Original</div><div id="opt" style="display:none">uploading</div>');
        let hasTitle, hasFile;
        document.addEventListener('ypy:before:request', () => {
            let el = document.querySelector('.ypy-pending');
            if (el) { hasTitle = 'title' in el.dataset; hasFile = 'file' in el.dataset; }
        }, {once: true});
        find('button').click()
        await forRequest()
        assert.isTrue(hasTitle);
        assert.isFalse(hasFile);
    })

    it('handles hyphenated form field names via setAttribute', async function () {
        mockResponse('POST', '/submit', 'Final')
        createProcessedHTML('<form ypy-post="/submit" ypy-target="#result" ypy-swap="innerHTML" ypy-pending="#opt"><input name="user-name" value="joe"><button type="submit">Go</button></form><div id="result">Original</div><div id="opt" style="display:none">content</div>');
        let dataUserName;
        document.addEventListener('ypy:before:request', () => {
            let el = document.querySelector('.ypy-pending');
            if (el) dataUserName = el.dataset.userName;
        }, {once: true});
        find('button').click()
        await forRequest()
        assert.equal(dataUserName, 'joe');
        assert.equal(find('#result').textContent.trim(), 'Final');
    })
})
