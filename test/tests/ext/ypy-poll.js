// SPDX-License-Identifier: MIT
describe('ypy-poll extension', function() {

    let extBackup;
    let hidden = false;

    // Pretends the tab is hidden or shown, and tells the page about it.
    function setHidden(value) {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
    }

    let polls = () => fetchMock.calls.length;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-poll.js';
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
        hidden = false;
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
        ypy.config.poll = {min: 10};
    })

    afterEach(() => {
        delete document.hidden;
        delete ypy.config.poll;
        cleanupTest(this.currentTest)
    })

    it('polls at the interval of the every trigger', async function () {
        mockResponse('GET', '/poll', 'ok')
        let div = createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(250)
        assert.isAtLeast(polls(), 3)
        assert.isAtMost(polls(), 7)
        assert.equal(div.textContent, 'ok')
    })

    it('polls 4 times slower in a hidden tab', async function () {
        mockResponse('GET', '/poll', 'ok')
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(250)
        // 160 ms apart: one poll in 250 ms, where a visible tab makes five or six
        assert.isAtLeast(polls(), 1)
        assert.isAtMost(polls(), 2)
    })

    it('takes the factor from ypy-poll', async function () {
        mockResponse('GET', '/poll', 'ok')
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms" ypy-poll="hidden:2">start</div>');
        await ypy.timeout(250)
        // 80 ms apart
        assert.isAtLeast(polls(), 2)
        assert.isAtMost(polls(), 4)
    })

    it('takes the factor from ypy.config.poll', async function () {
        mockResponse('GET', '/poll', 'ok')
        ypy.config.poll = {min: 10, hidden: 100};
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(200)
        assert.equal(polls(), 0)
    })

    it('does not poll in a hidden tab with hidden:pause', async function () {
        mockResponse('GET', '/poll', 'ok')
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms" ypy-poll="hidden:pause">start</div>');
        await ypy.timeout(250)
        assert.equal(polls(), 0)
    })

    it('polls at once when the tab is shown and a poll is due', async function () {
        mockResponse('GET', '/poll', 'ok')
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms" ypy-poll="hidden:pause">start</div>');
        await ypy.timeout(100)
        assert.equal(polls(), 0)
        setHidden(false);
        await ypy.timeout(20)
        assert.equal(polls(), 1)
    })

    it('goes back to the normal rate when the tab is shown', async function () {
        mockResponse('GET', '/poll', 'ok')
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(60)
        assert.equal(polls(), 0)
        setHidden(false);
        await ypy.timeout(200)
        assert.isAtLeast(polls(), 3)
    })

    it('slows down when the tab goes to the background', async function () {
        mockResponse('GET', '/poll', 'ok')
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(100)
        setHidden(true);
        let before = polls();
        await ypy.timeout(100)
        assert.isAtMost(polls() - before, 1)
    })

    it('leaves the element to the core with ypy-poll="false"', async function () {
        mockResponse('GET', '/poll', 'ok')
        setHidden(true);
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms" ypy-poll="false">start</div>');
        await ypy.timeout(250)
        assert.isAtLeast(polls(), 4)
    })

    it('takes the interval from the YPY-Poll-Interval header in ms', async function () {
        mockResponse('GET', '/poll', 'ok', {headers: {'YPY-Poll-Interval': '400'}})
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms">start</div>');
        await ypy.timeout(300)
        // the first poll comes at 30 ms, the next only 400 ms after it
        assert.equal(polls(), 1)
    })

    it('takes the interval from the YPY-Poll-Interval header as a time', async function () {
        mockResponse('GET', '/poll', 'ok', {headers: {'YPY-Poll-Interval': '1s'}})
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms">start</div>');
        await ypy.timeout(300)
        assert.equal(polls(), 1)
    })

    it('can make the interval shorter than the markup one', async function () {
        mockResponse('GET', '/poll', 'ok', {headers: {'YPY-Poll-Interval': '30ms'}})
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 200ms">start</div>');
        await ypy.timeout(450)
        // 200 ms for the first, then every 30 ms
        assert.isAtLeast(polls(), 5)
    })

    it('ignores a YPY-Poll-Interval that is not an interval', async function () {
        mockResponse('GET', '/poll', 'ok', {headers: {'YPY-Poll-Interval': 'soon'}})
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(250)
        assert.isAtLeast(polls(), 3)
    })

    it('does not let a server ask for less than the minimum interval', async function () {
        ypy.config.poll = {min: 100};
        mockResponse('GET', '/poll', 'ok', {headers: {'YPY-Poll-Interval': '1'}})
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms">start</div>');
        await ypy.timeout(400)
        // 30 ms, then 100 ms apart
        assert.isAtMost(polls(), 5)
    })

    it('applies the server interval in a hidden tab too', async function () {
        mockResponse('GET', '/poll', 'ok', {headers: {'YPY-Poll-Interval': '50'}})
        let div = createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms" ypy-poll="hidden:2">start</div>');
        await ypy.timeout(60)
        assert.equal(polls(), 1)
        setHidden(true);
        let before = polls();
        await ypy.timeout(350)
        // 100 ms apart now
        assert.isAtLeast(polls() - before, 2)
        assert.isAtMost(polls() - before, 4)
    })

    it('stops on 286, swaps the content and fires ypy:poll:stop', async function () {
        mockResponse('GET', '/poll', 'last', {status: 286})
        let stops = [];
        let div = createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms">start</div>');
        div.addEventListener('ypy:poll:stop', evt => stops.push(evt.detail));
        await ypy.timeout(250)
        assert.equal(polls(), 1)
        assert.equal(div.textContent, 'last')
        assert.equal(stops.length, 1)
        assert.equal(stops[0].status, 286)
        assert.equal(stops[0].ctx.response.status, 286)
    })

    it('stops only the element that got the 286', async function () {
        mockResponse('GET', '/done', 'done', {status: 286})
        mockResponse('GET', '/live', 'live')
        let wrap = createProcessedHTML(
            '<div><div id="a" ypy-get="/done" ypy-trigger="every 30ms">a</div>' +
            '<div id="b" ypy-get="/live" ypy-trigger="every 30ms">b</div></div>');
        await ypy.timeout(250)
        let urls = fetchMock.calls.map(c => c.url);
        assert.equal(urls.filter(u => u.includes('/done')).length, 1)
        assert.isAtLeast(urls.filter(u => u.includes('/live')).length, 4)
    })

    it('stops on 286 an element left to the core', async function () {
        mockResponse('GET', '/poll', 'last', {status: 286})
        let div = createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms" ypy-poll="false">start</div>');
        await ypy.timeout(250)
        assert.equal(polls(), 1)
    })

    it('stops polling an element that left the page', async function () {
        mockResponse('GET', '/poll', 'ok')
        let div = createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms">start</div>');
        await ypy.timeout(100)
        div.remove()
        await ypy.timeout(50)
        let after = polls();
        await ypy.timeout(150)
        assert.equal(polls(), after)
    })

    it('does not poll while the tab is hidden and the element is gone', async function () {
        mockResponse('GET', '/poll', 'ok')
        let div = createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 30ms" ypy-poll="hidden:pause">start</div>');
        await ypy.timeout(50)
        setHidden(true);
        div.remove()
        setHidden(false);
        await ypy.timeout(100)
        let after = polls();
        await ypy.timeout(100)
        assert.equal(polls(), after)
    })

    it('keeps polling after a request that fails', async function () {
        mockFailure('GET', '/poll')
        createProcessedHTML('<div ypy-get="/poll" ypy-trigger="every 40ms">start</div>');
        await ypy.timeout(250)
        assert.isAtLeast(polls(), 3)
    })
})
