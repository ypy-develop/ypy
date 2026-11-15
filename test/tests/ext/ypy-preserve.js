// SPDX-License-Identifier: MIT
// TASK-084: the ypy-preserve extension. The modes value, selection, focus and scroll keep one state
// of an element through a morph and through a raw swap, and a swap waits for an IME composition.
describe('ypy-preserve extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-preserve.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(function () {
        setupTest(this.currentTest);
    });

    afterEach(function () {
        delete ypy.config.compositionTimeout;
        cleanupTest();
        if (document.activeElement !== document.body) document.activeElement.blur();
    });

    // a button outside #box asks for the response and swaps it into #box
    function mount(inner, response, swap = 'innerMorph') {
        mockResponse('GET', '/t', response);
        createProcessedHTML('<div><button id="go" ypy-get="/t" ypy-target="#box" ypy-swap="' + swap + '">go</button>' +
            '<div id="box">' + inner + '</div></div>');
    }

    async function run() {
        find('#go').click();
        await forRequest();
    }

    for (let swap of ['innerMorph', 'innerHTML']) {
        describe('in a ' + swap + ' swap', function () {

            it('value keeps what the visitor typed, whatever the response says', async function () {
                mount('<input id="f" ypy-preserve="value" value="a">', '<input id="f" ypy-preserve="value" value="server">', swap);
                find('#f').value = 'typed';
                await run();
                assert.equal(find('#f').value, 'typed');
            });

            it('value lets the response change a field the visitor did not touch', async function () {
                mount('<input id="f" ypy-preserve="value" value="a">', '<input id="f" ypy-preserve="value" value="server">', swap);
                await run();
                assert.equal(find('#f').value, 'server');
            });

            it('value keeps a textarea, a select and a checkbox', async function () {
                mount('<form id="form" ypy-preserve="value"><textarea id="t">one</textarea>' +
                    '<select id="s"><option>x</option><option>y</option></select><input id="c" type="checkbox"></form>',
                    '<form id="form" ypy-preserve="value"><textarea id="t">server</textarea>' +
                    '<select id="s"><option>x</option><option>y</option></select><input id="c" type="checkbox"></form>', swap);
                find('#t').value = 'typed';
                find('#s').value = 'y';
                find('#c').checked = true;
                await run();
                assert.equal(find('#t').value, 'typed');
                assert.equal(find('#s').value, 'y');
                assert.isTrue(find('#c').checked);
            });

            it('without the mode the response wins, as before', async function () {
                mount('<input id="f" value="a">', '<input id="f" value="server">', swap);
                find('#f').value = 'typed';
                await run();
                assert.equal(find('#f').value, 'server');
            });

            it('a response that marks the element with ypy-morph-force wins', async function () {
                mount('<input id="f" ypy-preserve="value" value="a">',
                    '<input id="f" ypy-preserve="value" ypy-morph-force value="server">', swap);
                find('#f').value = 'typed';
                await run();
                assert.equal(find('#f').value, 'server');
            });

            it('selection keeps the caret and the selected text', async function () {
                mount('<textarea id="t" ypy-preserve="selection">hello world</textarea>',
                    '<textarea id="t" ypy-preserve="selection">hello world</textarea><p>more</p>', swap);
                find('#t').setSelectionRange(2, 7);
                await run();
                assert.equal(find('#t').selectionStart, 2);
                assert.equal(find('#t').selectionEnd, 7);
            });

            it('words combine: value and selection, with focus', async function () {
                mount('<input id="f" ypy-preserve="value selection focus" value="a">',
                    '<input id="f" ypy-preserve="value selection focus" value="b">', swap);
                let f = find('#f');
                f.focus();
                f.value = 'typed here';
                f.setSelectionRange(3, 5);
                await run();
                assert.equal(document.activeElement, find('#f'));
                assert.equal(find('#f').value, 'typed here');
                assert.equal(find('#f').selectionStart, 3);
                assert.equal(find('#f').selectionEnd, 5);
            });

            it('focus gives the focus back to a button', async function () {
                mount('<div ypy-preserve="focus"><button id="k">k</button></div>',
                    '<div ypy-preserve="focus"><button id="k">k</button><p>new</p></div>', swap);
                find('#k').focus();
                await run();
                assert.equal(document.activeElement.id, 'k');
            });

            it('scroll keeps the scroll position of the element', async function () {
                let list = '<div id="list" ypy-preserve="scroll" style="height:40px;overflow:auto">' +
                    '<div style="height:400px">tall</div></div>';
                mount(list, list.replace('tall', 'taller'), swap);
                find('#list').scrollTop = 120;
                await run();
                assert.equal(find('#list').scrollTop, 120);
                assert.include(find('#list').textContent, 'taller');
            });

            it('is read in the other spelling, data-ypy-preserve', async function () {
                mount('<input id="f" data-ypy-preserve="value" value="a">', '<input id="f" data-ypy-preserve="value" value="s">', swap);
                find('#f').value = 'typed';
                await run();
                assert.equal(find('#f').value, 'typed');
            });
        });
    }

    describe('with the other values of ypy-preserve', function () {
        it('a mode word does not keep the node itself in a raw swap', async function () {
            mount('<input id="f" ypy-preserve="value" value="a" title="old">', '<input id="f" ypy-preserve="value" value="a" title="new">', 'innerHTML');
            let node = find('#f');
            await run();
            assert.notStrictEqual(find('#f'), node);
            assert.equal(find('#f').title, 'new');
        });

        it('true still keeps the node', async function () {
            mount('<input id="f" ypy-preserve value="a" title="old">', '<input id="f" ypy-preserve value="a" title="new">', 'innerHTML');
            let node = find('#f');
            await run();
            assert.strictEqual(find('#f'), node);
        });
    });

    describe('IME composition', function () {
        const compose = (type, elt) => elt.dispatchEvent(new CompositionEvent(type, {bubbles: true, data: 'に'}));

        function page() {
            mount('<input id="f" value="a"><p id="p">old</p>', '<input id="f" value="a"><p id="p">new</p>');
        }

        it('swaps at once when nothing is being composed', async function () {
            page();
            find('#f').focus();
            await run();
            assert.equal(find('#p').textContent, 'new');
        });

        it('waits for compositionend when the target holds the field being composed', async function () {
            page();
            let f = find('#f');
            f.focus();
            f.value = 'に';
            compose('compositionstart', f);
            let done = forRequest(2000);
            find('#go').click();
            await ypy.timeout(150);
            assert.equal(find('#p').textContent, 'old', 'the swap is held');
            assert.equal(find('#f').value, 'に');
            compose('compositionend', f);
            await done;
            assert.equal(find('#p').textContent, 'new');
            assert.equal(find('#f').value, 'に', 'the text the visitor typed stays');
        });

        it('does not hold a swap whose target does not contain the field', async function () {
            mockResponse('GET', '/t', '<p id="p">new</p>');
            createProcessedHTML('<button id="go" ypy-get="/t" ypy-target="#box" ypy-swap="innerMorph">go</button>' +
                '<input id="other"><div id="box"><p id="p">old</p></div>');
            let other = find('#other');
            other.focus();
            compose('compositionstart', other);
            try {
                await run();
                assert.equal(find('#p').textContent, 'new');
            } finally {
                compose('compositionend', other);
            }
        });

        it('swaps after config.compositionTimeout when the composition never ends', async function () {
            ypy.config.compositionTimeout = 80;
            page();
            let f = find('#f');
            f.focus();
            compose('compositionstart', f);
            let done = forRequest(2000);
            find('#go').click();
            await done;
            assert.equal(find('#p').textContent, 'new');
            compose('compositionend', f);
        });

        it('swaps at once after the composition ended', async function () {
            page();
            let f = find('#f');
            f.focus();
            compose('compositionstart', f);
            compose('compositionend', f);
            await ypy.timeout(20);
            await run();
            assert.equal(find('#p').textContent, 'new');
        });
    });
});
