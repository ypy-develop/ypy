// SPDX-License-Identifier: MIT
describe('ypy-lazy extension', function () {

    let extBackup, mount;
    const find2 = selector => document.querySelector(selector);
    const calls = () => fetchMock.getCalls();
    const settle = () => ypy.timeout(80);

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-lazy.js';
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
        // fixed at the top of the window: in view as soon as it is processed
        mount = document.createElement('div');
        mount.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#fff';
        document.body.append(mount);
    });

    afterEach(() => {
        mount.remove();
        cleanupTest();
    });

    const render = html => { mount.innerHTML = html; ypy.process(mount); return mount };

    it('loads a region that is in view and replaces it with the response', async function () {
        mockResponse('GET', '/panel', '<section id="panel">Loaded</section>');
        render('<div id="lz" ypy-lazy="/panel">Loading</div>');
        await settle();
        calls().length.should.equal(1);
        calls()[0].url.should.equal('/panel');
        assert.isNull(find2('#lz'));
        find2('#panel').textContent.should.equal('Loaded');
    });

    it('asks with GET, the mode of the page and the core headers', async function () {
        mockResponse('GET', '/panel', 'x');
        render('<div ypy-lazy="/panel">Loading</div>');
        await settle();
        let {request} = calls()[0];
        request.method.should.equal('GET');
        request.mode.should.equal('same-origin');
        request.headers['YPY-Request'].should.equal('true');
    });

    it('reads data-ypy-lazy too', async function () {
        mockResponse('GET', '/panel', 'Loaded');
        render('<div data-ypy-lazy="/panel">Loading</div>');
        await settle();
        calls().length.should.equal(1);
    });

    it('waits until the region is about to be seen', async function () {
        mockResponse('GET', '/far', '<p id="far">Far</p>');
        let spacer = document.createElement('div');
        spacer.style.height = '6000px';
        let far = document.createElement('div');
        far.id = 'lz';
        far.setAttribute('ypy-lazy', '/far');
        far.textContent = 'Loading';
        document.body.append(spacer, far);
        try {
            ypy.process(far);
            await settle();
            calls().length.should.equal(0);
            far.scrollIntoView();
            await settle();
            calls().length.should.equal(1);
            find2('#far').textContent.should.equal('Far');
        } finally {
            spacer.remove();
            far.remove();
            find2('#far')?.remove();
            window.scrollTo(0, 0);
        }
    });

    it('loads once, however often the content is processed', async function () {
        mockResponse('GET', '/panel', 'Loaded');
        render('<div ypy-lazy="/panel">Loading</div>');
        ypy.process(mount);
        ypy.process(mount);
        await settle();
        calls().length.should.equal(1);
    });

    it('works on a table row, which a Custom Element cannot be', async function () {
        mockResponse('GET', '/rows', '<tr><td>Row 1</td></tr><tr><td>Row 2</td></tr>');
        render('<table><tbody id="tb"><tr id="lz" ypy-lazy="/rows"><td>Loading</td></tr></tbody></table>');
        await settle();
        let rows = [...find2('#tb').rows].map(r => r.textContent);
        rows.should.deep.equal(['Row 1', 'Row 2']);
    });

    it('works on a table body', async function () {
        mockResponse('GET', '/body', '<tbody><tr><td>A</td></tr></tbody>');
        render('<table><tbody id="lz" ypy-lazy="/body"><tr><td>Loading</td></tr></tbody></table>');
        await settle();
        mount.querySelector('table').textContent.should.equal('A');
    });

    it('works on a list item and a definition', async function () {
        mockResponse('GET', '/li', '<li>Item</li>');
        mockResponse('GET', '/dd', '<dd>Meaning</dd>');
        render('<ul><li ypy-lazy="/li">Loading</li></ul><dl><dd ypy-lazy="/dd">Loading</dd></dl>');
        await settle();
        mount.querySelector('ul').textContent.should.equal('Item');
        mount.querySelector('dl').textContent.should.equal('Meaning');
    });

    it('keeps its children as the placeholder until it loads', async function () {
        let held = mockSequentialResponses('GET', '/panel', 'Loaded');
        render('<div id="lz" ypy-lazy="/panel"><a href="/panel">Open the panel</a></div>');
        await ypy.timeout(40);
        find2('#lz').textContent.should.equal('Open the panel');
        find2('#lz').getAttribute('aria-busy').should.equal('true');
        await held.next();
        await settle();
        mount.textContent.should.equal('Loaded');
    });

    it('swaps a skeleton in for the children with ypy-lazy-placeholder', async function () {
        let held = mockSequentialResponses('GET', '/panel', 'Loaded');
        render('<template id="sk"><i>skeleton</i></template><div id="lz" ypy-lazy="/panel" ypy-lazy-placeholder="#sk"><a href="/panel">Open</a></div>');
        await ypy.timeout(40);
        find2('#lz').innerHTML.should.equal('<i>skeleton</i>');
        await held.next();
        await settle();
    });

    it('follows ypy-swap on the element', async function () {
        mockResponse('GET', '/panel', 'Inside');
        render('<div id="lz" ypy-lazy="/panel" ypy-swap="innerHTML">Loading</div>');
        await settle();
        find2('#lz').textContent.should.equal('Inside');
    });

    it('marks an error: state, event and the error content', async function () {
        mockResponse('GET', '/panel', 'Oops', {status: 500});
        let seen = waitForEvent('ypy:lazy:error', 300);
        render('<template id="er"><b>Could not load</b> <button ypy-lazy-retry>Retry</button></template><div id="lz" ypy-lazy="/panel" ypy-lazy-error="#er">Loading</div>');
        let evt = await seen;
        evt.should.not.equal(null);
        evt.target.id.should.equal('lz');
        await settle();
        find2('#lz').dataset.ypyState.should.contain('error');
        find2('#lz').textContent.should.contain('Could not load');
    });

    it('swaps the error body in when ypy-error-swap asks for it', async function () {
        mockResponse('GET', '/panel', '<p id="err">Server says no</p>', {status: 500});
        render('<div id="lz" ypy-lazy="/panel" ypy-error-swap="outerHTML">Loading</div>');
        await settle();
        find2('#err').textContent.should.equal('Server says no');
    });

    it('marks an error when the connection fails', async function () {
        mockFailure('GET', '/panel');
        let seen = waitForEvent('ypy:lazy:error', 300);
        render('<div id="lz" ypy-lazy="/panel">Loading</div>');
        (await seen).should.not.equal(null);
        find2('#lz').dataset.ypyState.should.contain('error');
    });

    it('loads again when a ypy-lazy-retry element of the region is clicked', async function () {
        mockResponse('GET', '/panel', 'Oops', {status: 500});
        let seen = waitForEvent('ypy:lazy:error', 300);
        render('<template id="er"><button id="retry" ypy-lazy-retry>Retry</button></template><div id="lz" ypy-lazy="/panel" ypy-lazy-error="#er">Loading</div>');
        await seen;
        await settle();
        mockResponse('GET', '/panel', '<p id="ok">Back</p>');
        find2('#retry').click();
        await settle();
        calls().length.should.equal(2);
        find2('#ok').textContent.should.equal('Back');
    });

    it('does not retry on a click while the region is not in error', async function () {
        let held = mockSequentialResponses('GET', '/panel', 'Loaded');
        render('<div id="lz" ypy-lazy="/panel"><button id="retry" ypy-lazy-retry>Retry</button></div>');
        await ypy.timeout(40);
        find2('#retry').click();
        await ypy.timeout(20);
        calls().length.should.equal(1);
        await held.next();
        await settle();
    });

    it('does nothing for an empty value, inside ypy-ignore, or when ypy:before:init is cancelled', async function () {
        let veto = evt => evt.preventDefault();
        document.addEventListener('ypy:before:init', veto);
        try {
            render('<div ypy-lazy="">a</div><div ypy-ignore><div ypy-lazy="/ignored">b</div></div><div ypy-lazy="/vetoed">c</div>');
            await settle();
            calls().length.should.equal(0);
        } finally {
            document.removeEventListener('ypy:before:init', veto);
        }
    });

    it('processes a lazy region that arrives in a response', async function () {
        mockResponse('GET', '/outer', '<div id="inner" ypy-lazy="/inner">Loading</div>');
        mockResponse('GET', '/inner', '<p id="done">Done</p>');
        render('<button id="b" ypy-get="/outer" ypy-target="#out" ypy-swap="innerHTML">go</button><div id="out"></div>');
        find2('#b').click();
        await ypy.timeout(150);
        calls().map(c => c.url).should.deep.equal(['/outer', '/inner']);
        find2('#done').textContent.should.equal('Done');
    });

    it('loads a lazy region nested in a lazy response one after the other', async function () {
        mockResponse('GET', '/one', '<div ypy-lazy="/two">Two</div>');
        mockResponse('GET', '/two', '<p id="end">End</p>');
        render('<div ypy-lazy="/one">One</div>');
        await ypy.timeout(150);
        calls().map(c => c.url).should.deep.equal(['/one', '/two']);
        find2('#end').textContent.should.equal('End');
    });

    it('does not load a region that was removed before it came into view', async function () {
        mockResponse('GET', '/far', 'Far');
        let spacer = document.createElement('div');
        spacer.style.height = '6000px';
        let far = document.createElement('div');
        far.setAttribute('ypy-lazy', '/far');
        document.body.append(spacer, far);
        try {
            ypy.process(far);
            ypy.__cleanup?.(far, true);
            far.remove();
            await settle();
            calls().length.should.equal(0);
        } finally {
            spacer.remove();
            window.scrollTo(0, 0);
        }
    });

    describe('ypy-lazy-group', function () {
        const groupSettle = () => ypy.timeout(160);
        const partials = '<ypy-partial id="a"><p id="pa">A done</p></ypy-partial><ypy-partial id="b"><p id="pb">B done</p></ypy-partial>';

        it('loads regions of one group that are in view together with a single request', async function () {
            mockResponse('GET', '/reports', partials);
            render('<div id="a" ypy-lazy="/reports/a" ypy-lazy-group="r">A</div><div id="b" ypy-lazy="/reports/b" ypy-lazy-group="r">B</div>');
            await groupSettle();
            calls().length.should.equal(1);
            calls()[0].url.should.equal('/reports/a?group=r&id=a&id=b');
            calls()[0].request.headers['YPY-Lazy-Group'].should.equal('r');
            find2('#pa').textContent.should.equal('A done');
            find2('#pb').textContent.should.equal('B done');
            assert.isNull(find2('#a'));
        });

        it('uses ypy-lazy-group-url when a region has one', async function () {
            mockResponse('GET', '/batch', partials);
            render('<div id="a" ypy-lazy="/reports/a" ypy-lazy-group="r" ypy-lazy-group-url="/batch">A</div><div id="b" ypy-lazy="/reports/b" ypy-lazy-group="r">B</div>');
            await groupSettle();
            calls().map(c => c.url).should.deep.equal(['/batch?group=r&id=a&id=b']);
        });

        it('fires ypy:lazy:group with the ids', async function () {
            mockResponse('GET', '/reports', partials);
            let seen = waitForEvent('ypy:lazy:group', 300);
            render('<div id="a" ypy-lazy="/reports" ypy-lazy-group="r">A</div><div id="b" ypy-lazy="/reports" ypy-lazy-group="r">B</div>');
            let evt = await seen;
            evt.detail.group.should.equal('r');
            evt.detail.ids.should.deep.equal(['a', 'b']);
            await groupSettle();
        });

        it('keeps groups apart: one request per group', async function () {
            mockResponse('GET', '/g1', '<ypy-partial id="a"><i id="pa">1</i></ypy-partial><ypy-partial id="b"><i id="pb">1</i></ypy-partial>');
            mockResponse('GET', '/g2', '<ypy-partial id="c"><i id="pc">2</i></ypy-partial><ypy-partial id="d"><i id="pd">2</i></ypy-partial>');
            render('<div id="a" ypy-lazy="/g1" ypy-lazy-group="one">A</div><div id="c" ypy-lazy="/g2" ypy-lazy-group="two">C</div>' +
                '<div id="b" ypy-lazy="/g1" ypy-lazy-group="one">B</div><div id="d" ypy-lazy="/g2" ypy-lazy-group="two">D</div>');
            await groupSettle();
            calls().map(c => c.url).sort().should.deep.equal(['/g1?group=one&id=a&id=b', '/g2?group=two&id=c&id=d']);
            mount.textContent.should.equal('1212');
        });

        it('loads a region alone in its window with its own url, as without a group', async function () {
            mockResponse('GET', '/reports/a', '<p id="solo">Solo</p>');
            render('<div id="a" ypy-lazy="/reports/a" ypy-lazy-group="r">A</div>');
            await groupSettle();
            calls().map(c => c.url).should.deep.equal(['/reports/a']);
            find2('#solo').textContent.should.equal('Solo');
        });

        it('loads a grouped region with no id on its own', async function () {
            mockResponse('GET', '/x', '<p>X</p>');
            mockResponse('GET', '/y', '<p>Y</p>');
            render('<div ypy-lazy="/x" ypy-lazy-group="r">A</div><div ypy-lazy="/y" ypy-lazy-group="r">B</div>');
            await groupSettle();
            calls().map(c => c.url).sort().should.deep.equal(['/x', '/y']);
        });

        it('does not group regions that come into view far apart in time', async function () {
            mockResponse('GET', '/reports/a', '<p>A</p>');
            mockResponse('GET', '/reports/b', '<p>B</p>');
            render('<div id="a" ypy-lazy="/reports/a" ypy-lazy-group="r">A</div>');
            await groupSettle();
            let other = document.createElement('div');
            other.id = 'b';
            other.setAttribute('ypy-lazy', '/reports/b');
            other.setAttribute('ypy-lazy-group', 'r');
            mount.append(other);
            ypy.process(other);
            await groupSettle();
            calls().map(c => c.url).should.deep.equal(['/reports/a', '/reports/b']);
        });

        it('a partial that names a swap keeps the region', async function () {
            mockResponse('GET', '/reports', '<ypy-partial id="a" ypy-swap="innerHTML"><b>in</b></ypy-partial><ypy-partial id="b"><p id="pb">B</p></ypy-partial>');
            render('<div id="a" ypy-lazy="/reports" ypy-lazy-group="r">A</div><div id="b" ypy-lazy="/reports" ypy-lazy-group="r">B</div>');
            await groupSettle();
            find2('#a').innerHTML.should.equal('<b>in</b>');
            find2('#pb').textContent.should.equal('B');
        });

        it('marks a region the answer left out as an error and loads the others', async function () {
            mockResponse('GET', '/reports', '<ypy-partial id="a"><p id="pa">A done</p></ypy-partial>');
            let errors = [];
            let onError = evt => errors.push(evt.target.id);
            document.addEventListener('ypy:lazy:error', onError);
            try {
                render('<div id="a" ypy-lazy="/reports" ypy-lazy-group="r">A</div><div id="b" ypy-lazy="/reports" ypy-lazy-group="r">B</div>');
                await groupSettle();
            } finally {
                document.removeEventListener('ypy:lazy:error', onError);
            }
            errors.should.deep.equal(['b']);
            find2('#pa').textContent.should.equal('A done');
            find2('#b').dataset.ypyState.should.contain('error');
        });

        it('marks every region of the group as an error when the request fails', async function () {
            mockResponse('GET', '/reports', 'Oops', {status: 500});
            render('<template id="er"><b>Failed</b></template><div id="a" ypy-lazy="/reports" ypy-lazy-group="r" ypy-lazy-error="#er">A</div><div id="b" ypy-lazy="/reports" ypy-lazy-group="r" ypy-lazy-error="#er">B</div>');
            await groupSettle();
            for (let id of ['#a', '#b']) {
                find2(id).dataset.ypyState.should.contain('error');
                find2(id).textContent.should.equal('Failed');
            }
        });

        it('marks every region of the group as an error when the connection fails', async function () {
            mockFailure('GET', '/reports');
            render('<div id="a" ypy-lazy="/reports" ypy-lazy-group="r">A</div><div id="b" ypy-lazy="/reports" ypy-lazy-group="r">B</div>');
            await groupSettle();
            find2('#a').dataset.ypyState.should.contain('error');
            find2('#b').dataset.ypyState.should.contain('error');
        });

        it('does not request a region that was removed while it waited for the group', async function () {
            mockResponse('GET', '/reports/b', '<p id="solo">B</p>');
            render('<div id="a" ypy-lazy="/reports/a" ypy-lazy-group="r">A</div><div id="b" ypy-lazy="/reports/b" ypy-lazy-group="r">B</div>');
            find2('#a').remove();
            await groupSettle();
            calls().map(c => c.url).should.deep.equal(['/reports/b']);
        });

        it('honours config.lazy.window', async function () {
            mockResponse('GET', '/reports', partials);
            ypy.config.lazy = {window: 250};
            try {
                render('<div id="a" ypy-lazy="/reports" ypy-lazy-group="r">A</div>');
                await ypy.timeout(100);
                let other = document.createElement('div');
                other.id = 'b';
                other.setAttribute('ypy-lazy', '/reports');
                other.setAttribute('ypy-lazy-group', 'r');
                mount.append(other);
                ypy.process(other);
                await ypy.timeout(300);
                calls().map(c => c.url).should.deep.equal(['/reports?group=r&id=a&id=b']);
            } finally {
                delete ypy.config.lazy;
            }
        });
    });
});
