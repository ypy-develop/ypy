// SPDX-License-Identifier: MIT
// ypy-list: the focus moves to the first item a swap brought.
describe('ypy-list extension: focus', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-list.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => { document.activeElement?.blur?.(); cleanupTest(this.currentTest) });

    async function load(swap, items, {attrs = '', before = '', html = '<li id="a">a</li><li id="b">b</li>'} = {}) {
        mockResponse('GET', '/test', items);
        let list = createProcessedHTML(`${before}<ul ypy-get="/test" ypy-swap="${swap}" ${attrs}>${html}</ul>`);
        if (before) list = find('ul');
        list.click();
        await forRequest();
        await ypy.timeout(30);
        return list;
    }

    it('with the focus modifier, the first appended item takes the focus and gets tabindex -1', async function () {
        let list = await load('append focus', '<li id="c">c</li><li id="d">d</li>');
        document.activeElement.should.equal(find('#c'));
        find('#c').getAttribute('tabindex').should.equal('-1');
        assert.isNull(find('#d').getAttribute('tabindex'));
        list.children.length.should.equal(4);
    });

    it('does nothing without it', async function () {
        await load('append', '<li id="c">c</li>');
        document.activeElement.should.not.equal(find('#c'));
        assert.isNull(find('#c').getAttribute('tabindex'));
    });

    it('prepend focuses the first item of the response, which is the first of the list', async function () {
        await load('prepend focus', '<li id="c">c</li><li id="d">d</li>');
        document.activeElement.should.equal(find('#c'));
    });

    it('an item with no way to take focus on its own is the one that gets it, not what is inside', async function () {
        await load('append focus', '<li id="c"><a id="x" href="#x">x</a></li>');
        document.activeElement.should.equal(find('#c'));
    });

    it('an item that can take focus by itself gets no tabindex', async function () {
        mockResponse('GET', '/test', '<button id="e">e</button>');
        let list = createProcessedHTML(`<div ypy-get="/test" ypy-swap="append focus"></div>`);
        list.click();
        await forRequest();
        await ypy.timeout(30);
        document.activeElement.should.equal(find('#e'));
        assert.isNull(find('#e').getAttribute('tabindex'));
    });

    it('the ypy-list-focus attribute asks for it too, and false turns it off', async function () {
        await load('append', '<li id="c">c</li>', {attrs: 'ypy-list-focus'});
        document.activeElement.should.equal(find('#c'));
        cleanupTest(); setupTest(this.test);
        await load('append', '<li id="c">c</li>', {attrs: 'ypy-list-focus="false"'});
        document.activeElement.should.not.equal(find('#c'));
    });

    it('ypy-list-focus:inherited on a container covers the list inside it', async function () {
        mockResponse('GET', '/test', '<li id="c">c</li>');
        createProcessedHTML(`<div ypy-list-focus:inherited="true"><ul id="l" ypy-get="/test" ypy-swap="append"><li>a</li></ul></div>`);
        find('#l').click();
        await forRequest();
        await ypy.timeout(30);
        document.activeElement.should.equal(find('#c'));
    });

    it('never takes the focus from a field the user is typing in', async function () {
        let list = await (async () => {
            mockResponse('GET', '/test', '<li id="c">c</li>');
            let l = createProcessedHTML(`<div><input id="typing"><ul ypy-get="/test" ypy-swap="append focus"><li>a</li></ul></div>`);
            find('#typing').focus();
            find('ul').click();
            await forRequest();
            await ypy.timeout(30);
            return l;
        })();
        document.activeElement.should.equal(find('#typing'));
        list.querySelectorAll('li').length.should.equal(2);
    });

    it('takes the focus from a button, which is not typing', async function () {
        mockResponse('GET', '/test', '<li id="c">c</li>');
        createProcessedHTML(`<div><button id="more" ypy-get="/test" ypy-target="#l" ypy-swap="append focus">more</button><ul id="l"><li>a</li></ul></div>`);
        find('#more').focus();
        find('#more').click();
        await forRequest();
        await ypy.timeout(30);
        document.activeElement.should.equal(find('#c'));
    });

    it('does not scroll to the item unless the swap asks for it', async function () {
        let calls = [], orig = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (o) { calls.push([this.id, o]); return orig.call(this, o) };
        try {
            await load('append focus', '<li id="c">c</li>');
            cleanupTest(); setupTest(this.test);
            await load('append focus focusScroll:true', '<li id="d">d</li>');
        } finally { HTMLElement.prototype.focus = orig }
        calls.should.deep.equal([['c', {preventScroll: true}], ['d', {preventScroll: false}]]);
    });

    it('an item replaced by its key is the first new item', async function () {
        await load('append key focus', '<li id="a">a2</li><li id="c">c</li>');
        find('#a').textContent.should.equal('a2');
        document.activeElement.should.equal(find('#a'));
    });

    it('an empty response moves nothing', async function () {
        mockResponse('GET', '/test', '');
        createProcessedHTML(`<div><button id="b">b</button><ul id="l" ypy-get="/test" ypy-swap="append focus"><li>a</li></ul></div>`);
        find('#b').focus();
        find('#l').click();
        await forRequest();
        await ypy.timeout(30);
        document.activeElement.should.equal(find('#b'));
    });
});
