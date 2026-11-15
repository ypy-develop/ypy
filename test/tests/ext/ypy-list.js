// SPDX-License-Identifier: MIT
describe('ypy-list extension', function() {

    let extBackup;

    let ids = list => [...list.children].map(el => el.id);

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-list.js';
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

    async function load(swap, items, html = '<li id="a">a</li><li id="b">b</li><li id="c">c</li>') {
        mockResponse('GET', '/test', items)
        let list = createProcessedHTML(`<ul ypy-get="/test" ypy-swap="${swap}">${html}</ul>`);
        list.click()
        await ypy.timeout(30)
        return list
    }

    describe('limit', function() {
        it('keeps an append list at its limit by removing the oldest', async function () {
            let list = await load('append limit:4', '<li id="d">d</li><li id="e">e</li>')
            assert.deepEqual(ids(list), ['b', 'c', 'd', 'e'])
        })

        it('keeps a prepend list at its limit by removing the last ones', async function () {
            let list = await load('prepend limit:4', '<li id="d">d</li><li id="e">e</li>')
            assert.deepEqual(ids(list), ['d', 'e', 'a', 'b'])
        })

        it('leaves a list under its limit alone', async function () {
            let list = await load('append limit:10', '<li id="d">d</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c', 'd'])
        })

        it('keeps only the newest items when the response alone is over the limit', async function () {
            let list = await load('append limit:2', '<li id="d">d</li><li id="e">e</li><li id="f">f</li>')
            assert.deepEqual(ids(list), ['e', 'f'])
        })

        it('works with the spelling beforeend and afterbegin', async function () {
            let list = await load('beforeend limit:3', '<li id="d">d</li>')
            assert.deepEqual(ids(list), ['b', 'c', 'd'])
        })

        it('does nothing without the modifier', async function () {
            let list = await load('append', '<li id="d">d</li><li id="e">e</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c', 'd', 'e'])
        })

        it('ignores a limit that is not a number', async function () {
            let list = await load('append limit:many', '<li id="d">d</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c', 'd'])
        })

        it('does not touch other swap styles', async function () {
            let list = await load('innerHTML limit:1', '<li id="d">d</li><li id="e">e</li>')
            assert.deepEqual(ids(list), ['d', 'e'])
        })

        it('fires ypy:list:pruned on the list with the removed items', async function () {
            mockResponse('GET', '/test', '<li id="d">d</li><li id="e">e</li>')
            let list = createProcessedHTML('<ul ypy-get="/test" ypy-swap="append limit:3"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul>');
            let details = [];
            list.addEventListener('ypy:list:pruned', evt => details.push(evt.detail));
            list.click()
            await ypy.timeout(30)
            assert.equal(details.length, 1)
            assert.deepEqual(details[0].removed.map(el => el.id), ['a', 'b'])
            assert.equal(details[0].limit, 3)
            assert.isFalse(details[0].removed[0].isConnected)
        })

        it('does not fire ypy:list:pruned when nothing was removed', async function () {
            mockResponse('GET', '/test', '<li id="d">d</li>')
            let list = createProcessedHTML('<ul ypy-get="/test" ypy-swap="append limit:9"><li id="a">a</li></ul>');
            let fired = 0;
            list.addEventListener('ypy:list:pruned', () => fired++);
            list.click()
            await ypy.timeout(30)
            assert.equal(fired, 0)
        })

        it('works for an out-of-band swap', async function () {
            mockResponse('GET', '/test', '<div>ok</div><div ypy-swap-oob="beforeend target:#list limit:3"><li id="d">d</li></div>')
            let wrap = createProcessedHTML('<div><button ypy-get="/test">go</button><ul id="list"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul></div>');
            wrap.querySelector('button').click()
            await ypy.timeout(30)
            assert.deepEqual(ids(wrap.querySelector('#list')), ['b', 'c', 'd'])
        })

        it('works for a partial', async function () {
            mockResponse('GET', '/test', '<ypy-partial ypy-target="#list" ypy-swap="prepend limit:3"><li id="d">d</li></ypy-partial>')
            let wrap = createProcessedHTML('<div><button ypy-get="/test" ypy-swap="none">go</button><ul id="list"><li id="a">a</li><li id="b">b</li><li id="c">c</li></ul></div>');
            wrap.querySelector('button').click()
            await ypy.timeout(30)
            assert.deepEqual(ids(wrap.querySelector('#list')), ['d', 'a', 'b'])
        })

        it('stops the timers of a removed item', async function () {
            mockResponse('GET', '/tick', 'tick')
            mockResponse('GET', '/test', '<li id="d">d</li>')
            let list = createProcessedHTML('<ul ypy-get="/test" ypy-swap="append limit:1"><li id="a" ypy-get="/tick" ypy-trigger="every 20ms">a</li></ul>');
            await ypy.timeout(50)
            list.click()
            await ypy.timeout(30)
            assert.deepEqual(ids(list), ['d'])
            let after = fetchMock.calls.filter(c => c.url.includes('/tick')).length;
            await ypy.timeout(100)
            assert.equal(fetchMock.calls.filter(c => c.url.includes('/tick')).length, after)
        })
    })

    describe('key', function() {
        it('replaces the item that has the same key where it stands', async function () {
            let list = await load('append key:id', '<li id="b">B</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c'])
            assert.equal(list.children[1].textContent, 'B')
        })

        it('adds an item with a new key at the end', async function () {
            let list = await load('append key:id', '<li id="b">B</li><li id="d">d</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c', 'd'])
        })

        it('adds an item with a new key at the start for prepend', async function () {
            let list = await load('prepend key:id', '<li id="b">B</li><li id="d">d</li>')
            assert.deepEqual(ids(list), ['d', 'a', 'b', 'c'])
            assert.equal(list.children[2].textContent, 'B')
        })

        it('reads the key from any attribute', async function () {
            let list = await load('append key:data-uid', '<li data-uid="2">two!</li><li data-uid="9">nine</li>',
                '<li data-uid="1">one</li><li data-uid="2">two</li>')
            assert.deepEqual([...list.children].map(el => el.textContent), ['one', 'two!', 'nine'])
        })

        it('takes the id for a bare key', async function () {
            let list = await load('append key', '<li id="b">B</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c'])
            assert.equal(list.children[1].textContent, 'B')
        })

        it('keeps an item that has no key attribute', async function () {
            let list = await load('append key:data-uid', '<li>x</li><li>y</li>', '<li>a</li>')
            assert.deepEqual([...list.children].map(el => el.textContent), ['a', 'x', 'y'])
        })

        it('keeps the last of two items with one key in the same response', async function () {
            let list = await load('append key:id', '<li id="d">1</li><li id="d">2</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c', 'd'])
            assert.equal(list.children[3].textContent, '2')
        })

        it('the replacement is live and can start a request', async function () {
            mockResponse('GET', '/test', '<li id="b"><button ypy-get="/inner" ypy-target="closest li">go</button></li>')
            mockResponse('GET', '/inner', 'clicked')
            let wrap = createProcessedHTML('<div><button id="load" ypy-get="/test" ypy-target="#list" ypy-swap="append key:id">load</button>' +
                '<ul id="list"><li id="a">a</li><li id="b">b</li></ul></div>');
            wrap.querySelector('#load').click()
            await ypy.timeout(30)
            wrap.querySelector('#list button').click()
            await ypy.timeout(30)
            assert.equal(wrap.querySelector('#list').children[1].textContent, 'clicked')
        })

        it('is not used by other swap styles', async function () {
            let list = await load('innerHTML key:id', '<li id="b">B</li>')
            assert.deepEqual(ids(list), ['b'])
        })
    })

    describe('key and limit together', function() {
        it('replaces first, then prunes the oldest', async function () {
            let list = await load('append key:id limit:3', '<li id="b">B</li><li id="d">d</li>')
            // a, B, c, d is 4 items: the oldest, a, goes
            assert.deepEqual(ids(list), ['b', 'c', 'd'])
            assert.equal(list.children[0].textContent, 'B')
        })

        it('does not grow a list that only gets updates', async function () {
            let list = await load('append key:id limit:3', '<li id="a">A</li><li id="b">B</li><li id="c">C</li>')
            assert.deepEqual(ids(list), ['a', 'b', 'c'])
            assert.deepEqual([...list.children].map(el => el.textContent), ['A', 'B', 'C'])
        })
    })

    describe('polling', function() {
        it('keeps a polled feed bounded and without duplicates', async function () {
            let n = 0;
            fetchMock.mockResponse('GET', '/feed', () => {
                n++;
                return new MockResponse(`<li id="e${n % 3}">e${n}</li><li id="n${n}">n${n}</li>`)
            })
            let list = createProcessedHTML('<ul ypy-get="/feed" ypy-trigger="every 30ms" ypy-swap="append key:id limit:5"></ul>');
            await ypy.timeout(300)
            assert.isAtMost(list.children.length, 5)
            let found = ids(list);
            assert.equal(new Set(found).size, found.length)
        })
    })
})
