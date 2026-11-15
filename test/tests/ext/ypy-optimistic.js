// SPDX-License-Identifier: MIT
describe('ypy-optimistic extension', function () {

    let extBackup;
    let log;
    const names = ['applied', 'confirmed', 'rolledback'];
    const record = e => log.push([e.type.slice('ypy:optimistic:'.length), e.detail]);

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-optimistic.js';
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
        log = [];
        for (let n of names) document.addEventListener('ypy:optimistic:' + n, record);
    });

    afterEach(async () => {
        cleanupTest();
        // a request the test left in flight is aborted by the cleanup and settles a moment later
        await wait(10);
        for (let n of names) document.removeEventListener('ypy:optimistic:' + n, record);
    });

    const wait = ms => ypy.timeout(ms);
    const kinds = () => log.map(([k]) => k);
    const box = () => find('#box');

    // a panel with a field in it, a template and a button that updates the panel
    function panel(attrs = '') {
        createProcessedHTML(
            '<div><template id="tpl"><i id="shown">Saving</i></template>' +
            '<div id="box"><input id="field"><b id="old">Old</b></div>' +
            `<button id="go" ypy-post="/save" ypy-target="#box" ypy-swap="innerHTML" ypy-optimistic="#tpl" ${attrs}>Save</button></div>`);
    }

    async function start(selector = '#go') {
        find(selector).click();
        await wait(15);
    }

    // -------------------------------------------------------------------------
    // The change and what ends it
    // -------------------------------------------------------------------------

    it('shows the template at once and marks it', async function () {
        panel();
        let held = mockSequentialResponses('POST', '/save', 'Server');
        await start();
        assert.equal(box().textContent, 'Saving');
        assert.isTrue(find('#shown').classList.contains('ypy-optimistic'));
        assert.deepEqual(kinds(), ['applied']);
        assert.equal(log[0][1].target, box());
        await held.next();
        await forRequest();
    });

    it('lets the server content replace the optimistic one on success', async function () {
        panel();
        mockResponse('POST', '/save', '<p id="real">Saved</p>');
        await start();
        await wait(15);
        assert.equal(box().innerHTML, '<p id="real">Saved</p>');
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
        assert.equal(log[1][1].status, 200);
        assert.notExists(find('.ypy-optimistic'));
    });

    it('puts the original nodes back, not copies, when the server fails', async function () {
        panel('ypy-status:5xx="swap:none"');
        let field = find('#field'), old = find('#old');
        field.value = 'typed';
        let held = mockSequentialResponses('POST', '/save', new MockResponse('boom', {status: 500}));
        await start();
        assert.equal(box().textContent, 'Saving');
        assert.notEqual(field.parentNode, box(), 'the original nodes are out of the page meanwhile');
        await held.next();
        await forRequest();
        assert.equal(find('#field'), field);
        assert.equal(find('#old'), old);
        assert.equal(field.value, 'typed', 'what the user typed survived');
        assert.notExists(find('#shown'));
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
        assert.equal(log[1][1].reason, 'status');
        assert.equal(log[1][1].status, 500);
    });

    it('puts everything back when the network fails', async function () {
        panel();
        let old = find('#old');
        mockFailure('POST', '/save');
        await start();
        await wait(15);
        assert.equal(find('#old'), old);
        assert.equal(box().children.length, 2);
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
        assert.equal(log[1][1].reason, 'error');
        assert.equal(log[1][1].kind, 'network');
    });

    it('puts everything back when the request is aborted', async function () {
        panel();
        let old = find('#old');
        mockSequentialResponses('POST', '/save', 'never');
        await start();
        assert.equal(box().textContent, 'Saving');
        ypy.trigger(find('#go'), 'ypy:abort');
        await wait(30);
        assert.equal(find('#old'), old);
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
        assert.equal(log[1][1].reason, 'aborted');
    });

    it('rolls back at once, before a late error body is swapped in', async function () {
        panel('ypy-status:4xx="swap:none"');
        let held = mockSequentialResponses('POST', '/save', new MockResponse('nope', {status: 403}));
        await start();
        await held.next();
        await forRequest();
        assert.equal(find('#old').textContent, 'Old');
        assert.equal(log[1][1].status, 403);
    });

    it('keeps the optimistic content as the final state when nothing is swapped there', async function () {
        createProcessedHTML(
            '<div><template id="tpl"><a id="link" ypy-get="/x">Done</a></template><div id="box"><b>Pending</b></div>' +
            '<button id="go" ypy-post="/save" ypy-swap="none" ypy-optimistic="#tpl" ypy-optimistic-target="#box">Go</button></div>');
        mockResponse('POST', '/save', '');
        await start();
        await wait(15);
        assert.equal(box().textContent, 'Done');
        assert.isFalse(find('#link').classList.contains('ypy-optimistic'));
        assert.isNotNull(find('#link')._ypy, 'the kept content is processed');
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
    });

    it('keeps it too when the server answers 204', async function () {
        panel();
        mockResponse('POST', '/save', '', {status: 204});
        await start();
        await wait(15);
        assert.equal(box().textContent, 'Saving');
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
    });

    // -------------------------------------------------------------------------
    // Swap styles and the morph
    // -------------------------------------------------------------------------

    it('applies an outer swap by hiding the target, and a morph then keeps the same element', async function () {
        createProcessedHTML(
            '<div><template id="liked"><button id="like" disabled>Liked</button></template>' +
            '<button id="like" ypy-post="/like" ypy-target="this" ypy-swap="outerMorph" ypy-optimistic="#liked">Like</button></div>');
        let like = find('#like');
        let held = mockSequentialResponses('POST', '/like', '<button id="like" ypy-post="/like" ypy-target="this" ypy-swap="outerMorph" ypy-optimistic="#liked">Unlike</button>');
        like.click();
        await wait(15);
        assert.isTrue(like.isConnected, 'the source stays in the page');
        assert.equal(like.style.display, 'none');
        let shown = find('.ypy-optimistic');
        assert.equal(shown.textContent, 'Liked');
        await held.next();
        await forRequest();
        await wait(15);
        assert.notExists(find('.ypy-optimistic'));
        assert.equal(find('#like'), like, 'the morph kept the original element');
        assert.equal(like.textContent, 'Unlike');
        assert.notEqual(like.style.display, 'none');
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
    });

    it('works where the default swap is a morph', async function () {
        createProcessedHTML(
            '<div><template id="tpl"><i id="shown">Saving</i></template><div id="box"><input id="field"><b id="old">Old</b></div>' +
            '<button id="go" ypy-post="/save" ypy-target="#box" ypy-optimistic="#tpl">Save</button></div>');
        let held = mockSequentialResponses('POST', '/save', '<input id="field"><b id="old">New</b>');
        let old = find('#old'), field = find('#field');
        field.value = 'typed';
        await start();
        assert.equal(box().textContent, 'Saving');
        await held.next();
        await wait(30);
        assert.equal(box().textContent, 'New');
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
        assert.equal(find('#old'), old, 'the morph reused the original node');
        assert.equal(find('#field'), field);
        assert.equal(field.value, 'typed');
    });

    it('restores an outer target on failure', async function () {
        createProcessedHTML(
            '<div><template id="liked"><button disabled>Liked</button></template>' +
            '<button id="like" style="display:inline-block" ypy-post="/like" ypy-target="this" ypy-swap="outerHTML" ypy-optimistic="#liked" ypy-status:5xx="swap:none">Like</button></div>');
        let like = find('#like');
        mockResponse('POST', '/like', 'boom', {status: 500});
        like.click();
        await wait(30);
        assert.equal(find('#like'), like);
        assert.equal(like.style.display, 'inline-block', 'its own style value is back');
        assert.equal(playground().querySelectorAll('button').length, 1);
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
    });

    it('removes a target at once with remove and the delete swap, and brings it back on failure', async function () {
        createProcessedHTML(
            '<ul id="list"><li id="a">A</li><li id="b">B <button id="del" ypy-delete="/i/b" ypy-target="closest li" ypy-swap="delete" ypy-optimistic="remove" ypy-status:5xx="swap:none">x</button></li></ul>');
        let held = mockSequentialResponses('DELETE', '/i/b', new MockResponse('', {status: 500}));
        find('#del').click();
        await wait(15);
        assert.equal(find('#b').style.display, 'none');
        await held.next();
        await forRequest();
        await wait(10);
        assert.notEqual(find('#b').style.display, 'none');
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
    });

    it('removes for good when the server confirms the delete', async function () {
        createProcessedHTML(
            '<ul id="list"><li id="a">A</li><li id="b">B <button id="del" ypy-delete="/i/b" ypy-target="closest li" ypy-swap="delete" ypy-optimistic="remove">x</button></li></ul>');
        mockResponse('DELETE', '/i/b', '');
        find('#del').click();
        await forRequest();
        await wait(10);
        assert.notExists(find('#b'));
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
    });

    it('adds a row at once with an insertion swap, replaces it with the real one, removes it on failure', async function () {
        createProcessedHTML(
            '<div><template id="row"><li class="tmp">Sending</li></template><ul id="list"><li>One</li></ul>' +
            '<button id="add" ypy-post="/add" ypy-target="#list" ypy-swap="beforeend" ypy-optimistic="#row" ypy-status:5xx="swap:none">Add</button></div>');
        mockResponse('POST', '/add', '<li>Two</li>');
        await start('#add');
        await wait(15);
        assert.deepEqual([...find('#list').children].map(n => n.textContent), ['One', 'Two']);

        find('#list').innerHTML = '<li>One</li>';
        let held = mockSequentialResponses('POST', '/add', new MockResponse('boom', {status: 500}));
        await start('#add');
        assert.deepEqual([...find('#list').children].map(n => n.textContent), ['One', 'Sending']);
        await held.next();
        await forRequest();
        assert.deepEqual([...find('#list').children].map(n => n.textContent), ['One']);
    });

    it('uses ypy-optimistic-swap and ypy-optimistic-target for a place of its own', async function () {
        createProcessedHTML(
            '<div><template id="n"><span class="badge">1</span></template><p id="count">Items</p><div id="main"></div>' +
            '<button id="go" ypy-post="/x" ypy-target="#main" ypy-optimistic="#n" ypy-optimistic-target="#count" ypy-optimistic-swap="beforeend">Go</button></div>');
        let held = mockSequentialResponses('POST', '/x', 'body');
        await start();
        assert.equal(find('#count').textContent, 'Items1');
        await held.next();
        await forRequest();
        assert.equal(find('#main').textContent, 'body');
        assert.equal(find('#count').textContent, 'Items1', 'the other place keeps the change: the response did not touch it');
    });

    // -------------------------------------------------------------------------
    // Functions
    // -------------------------------------------------------------------------

    it('builds the content with a registered function from the request values', async function () {
        ypy.optimistic.register('echo', ({values, source, target}) => {
            assert.equal(source.id, 'form');
            assert.equal(target.id, 'list');
            let li = document.createElement('li');
            li.textContent = values.title;
            return li;
        });
        createProcessedHTML(
            '<div><ul id="list"><li>One</li></ul><form id="form" ypy-post="/add" ypy-target="#list" ypy-swap="beforeend" ypy-optimistic="echo">' +
            '<input name="title" value="<b>Two</b>"><button>Add</button></form></div>');
        let held = mockSequentialResponses('POST', '/add', '<li>Two</li>');
        find('button').click();
        await wait(15);
        assert.equal(find('#list').lastElementChild.textContent, '<b>Two</b>', 'the value is text, not markup');
        assert.equal(find('#list').children.length, 2);
        await held.next();
        await forRequest();
        assert.equal(find('#list').children.length, 2);
        assert.equal(find('#list').lastElementChild.textContent, 'Two');
    });

    it('accepts HTML from a function, built inert', async function () {
        ypy.optimistic.register('html', () => '<li class="h">Hi<script>window.__ran = 1</script></li>');
        createProcessedHTML('<div><ul id="list"></ul><button ypy-post="/a" ypy-target="#list" ypy-swap="beforeend" ypy-optimistic="html">Go</button></div>');
        mockSequentialResponses('POST', '/a', 'x');
        find('button').click();
        await wait(15);
        assert.equal(find('.h').firstChild.textContent, 'Hi');
        assert.isUndefined(window.__ran);
    });

    it('lets a function make its own change and give the way back', async function () {
        let undone = 0;
        ypy.optimistic.register('toggle', ({source}) => {
            source.classList.add('on');
            return () => { source.classList.remove('on'); undone++ };
        });
        createProcessedHTML('<button id="t" ypy-post="/t" ypy-swap="none" ypy-optimistic="toggle" ypy-status:5xx="swap:none">T</button>');
        let held = mockSequentialResponses('POST', '/t', new MockResponse('', {status: 500}));
        find('#t').click();
        await wait(15);
        assert.isTrue(find('#t').classList.contains('on'));
        await held.next();
        await forRequest();
        assert.isFalse(find('#t').classList.contains('on'));
        assert.equal(undone, 1);
        assert.deepEqual(kinds(), ['applied', 'rolledback']);

        log.length = 0;
        mockResponse('POST', '/t', '');
        find('#t').click();
        await forRequest();
        assert.isTrue(find('#t').classList.contains('on'), 'confirmed: the change stays');
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
        assert.equal(undone, 1);
    });

    it('does nothing for a function that returns nothing', async function () {
        ypy.optimistic.register('none', () => undefined);
        createProcessedHTML('<div id="box">Same</div><button ypy-post="/a" ypy-target="#box" ypy-optimistic="none">Go</button>');
        mockResponse('POST', '/a', 'New');
        find('button').click();
        await forRequest();
        assert.equal(box().textContent, 'New');
        assert.deepEqual(kinds(), []);
    });

    // -------------------------------------------------------------------------
    // The request queue and concurrency
    // -------------------------------------------------------------------------

    it('does not apply anything for a request that is queued, only when it is issued', async function () {
        panel();
        let held = mockSequentialResponses('POST', '/save', '<p>Saved</p>');
        find('#go').click();
        await wait(15);
        find('#go').click();
        await wait(15);
        assert.deepEqual(kinds(), ['applied'], 'the second click waits in the queue');
        await held.next();
        await wait(30);
        assert.deepEqual(kinds(), ['applied', 'confirmed', 'applied'], 'its change is made when its turn comes');
        await held.next();
        await wait(30);
        assert.deepEqual(kinds(), ['applied', 'confirmed', 'applied', 'confirmed']);
        assert.equal(box().innerHTML, '<p>Saved</p>');
    });

    it('does not apply anything for a request the queue drops', async function () {
        panel('ypy-sync="this:drop"');
        let held = mockSequentialResponses('POST', '/save', '<p>Saved</p>');
        find('#go').click();
        await wait(15);
        find('#go').click();
        await wait(15);
        assert.deepEqual(kinds(), ['applied']);
        await held.next();
        await wait(30);
        assert.deepEqual(kinds(), ['applied', 'confirmed']);
    });

    it('does not apply anything when the user declines the confirmation', async function () {
        panel('ypy-confirm="Sure?"');
        let confirm = window.confirm;
        window.confirm = () => false;
        try {
            await start();
            await wait(15);
        } finally {
            window.confirm = confirm;
        }
        assert.isNotNull(find('#old'));
        assert.notExists(find('#shown'));
        assert.deepEqual(kinds(), []);
    });

    it('rolls back, after applying, a request that a listener cancels', async function () {
        panel();
        let old = find('#old');
        find('#go').addEventListener('ypy:before:request', e => e.preventDefault());
        await start();
        assert.equal(find('#old'), old);
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
        assert.equal(log[1][1].reason, 'cancelled');
    });

    it('rolls back at once when a listener cancels the applied event', async function () {
        panel();
        let old = find('#old');
        document.addEventListener('ypy:optimistic:applied', e => e.preventDefault(), {once: true});
        mockSequentialResponses('POST', '/save', 'x');
        await start();
        assert.equal(find('#old'), old);
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
        assert.equal(log[1][1].reason, 'cancelled');
    });

    it('keeps the overlay of a request that a newer one replaces, until the newer one ends', async function () {
        panel('ypy-sync="this:replace" ypy-status:5xx="swap:none"');
        let old = find('#old');
        let held = mockSequentialResponses('POST', '/save', new MockResponse('', {status: 500}));
        find('#go').click();
        await wait(15);
        find('#go').click();
        await wait(30);
        assert.equal(box().textContent, 'Saving', 'the page still shows the change');
        assert.equal(box().querySelectorAll('i').length, 1);
        assert.deepEqual(kinds().filter(k => k === 'applied').length, 2);
        assert.equal(log.find(([k]) => k === 'rolledback')[1].reason, 'aborted');
        await held.next();   // the aborted request's own slot in the mock
        await held.next();
        await forRequest();
        await wait(15);
        assert.equal(find('#old'), old, 'the last request failed: the original is back');
        assert.equal(box().children.length, 2);
        assert.equal(kinds().filter(k => k === 'rolledback').length, 2);
    });

    it('shares one overlay between two elements that change the same place', async function () {
        createProcessedHTML(
            '<div><template id="ta"><i>A</i></template><template id="tb"><i>B</i></template><div id="box"><b id="old">Old</b></div>' +
            '<button id="a" ypy-post="/a" ypy-target="#box" ypy-optimistic="#ta" ypy-status:5xx="swap:none">A</button>' +
            '<button id="b" ypy-post="/b" ypy-target="#box" ypy-optimistic="#tb" ypy-status:5xx="swap:none">B</button></div>');
        let old = find('#old');
        let a = mockSequentialResponses('POST', '/a', new MockResponse('', {status: 500}));
        let b = mockSequentialResponses('POST', '/b', new MockResponse('', {status: 500}));
        find('#a').click();
        await wait(15);
        find('#b').click();
        await wait(15);
        assert.equal(box().textContent, 'B', 'the second change replaced the first');
        await a.next();
        await wait(30);
        assert.equal(box().textContent, 'B', 'A failed, B is still wanted');
        await b.next();
        await wait(30);
        assert.equal(box().textContent, 'Old');
        assert.equal(find('#old'), old);
        assert.deepEqual(kinds(), ['applied', 'applied', 'rolledback', 'rolledback']);
    });

    it('ends the overlay with the first success: a later failure of another request does not touch the page', async function () {
        createProcessedHTML(
            '<div><template id="ta"><i>A</i></template><template id="tb"><i>B</i></template><div id="box"><b id="old">Old</b></div>' +
            '<button id="a" ypy-post="/a" ypy-target="#box" ypy-optimistic="#ta" ypy-status:5xx="swap:none">A</button>' +
            '<button id="b" ypy-post="/b" ypy-target="#box" ypy-optimistic="#tb" ypy-status:5xx="swap:none">B</button></div>');
        let a = mockSequentialResponses('POST', '/a', '<p>from A</p>');
        let b = mockSequentialResponses('POST', '/b', new MockResponse('', {status: 500}));
        find('#a').click();
        await wait(15);
        find('#b').click();
        await wait(15);
        await a.next();
        await wait(30);
        assert.equal(box().innerHTML, '<p>from A</p>');
        await b.next();
        await wait(30);
        assert.equal(box().innerHTML, '<p>from A</p>', 'the page keeps what the server sent');
        assert.deepEqual(kinds(), ['applied', 'applied', 'confirmed', 'rolledback']);
    });

    it('does not put the original back over content that something else swapped in', async function () {
        panel('ypy-status:5xx="swap:none"');
        let held = mockSequentialResponses('POST', '/save', new MockResponse('', {status: 500}));
        await start();
        box().innerHTML = '<p>other</p>';   // another swap took the place meanwhile
        await held.next();
        await forRequest();
        assert.equal(box().innerHTML, '<p>other</p>');
        assert.deepEqual(kinds(), ['applied', 'rolledback']);
    });

    it('leaves elements without the attribute alone, and ypy-optimistic="false" too', async function () {
        createProcessedHTML('<div id="box">Same</div><button id="a" ypy-post="/a" ypy-target="#box">A</button>' +
            '<button id="b" ypy-post="/a" ypy-target="#box" ypy-optimistic="false">B</button>');
        mockResponse('POST', '/a', 'New');
        find('#a').click();
        await forRequest();
        find('#b').click();
        await forRequest();
        assert.deepEqual(kinds(), []);
    });

    it('reads ypy-optimistic from a container with :inherited', async function () {
        createProcessedHTML('<div ypy-optimistic:inherited="#tpl"><template id="tpl"><i>T</i></template><div id="box">Old</div>' +
            '<button ypy-post="/a" ypy-target="#box">A</button></div>');
        let held = mockSequentialResponses('POST', '/a', 'New');
        find('button').click();
        await wait(15);
        assert.equal(box().textContent, 'T');
        await held.next();
        await forRequest();
    });
});
