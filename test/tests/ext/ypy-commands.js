// SPDX-License-Identifier: MIT
describe('ypy-commands extension', function () {

    let extBackup, warnings, originalWarn;

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-commands.js';
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
        warnings = [];
        originalWarn = console.warn;
        console.warn = (...args) => { warnings.push(args.join(' ')) };
    });

    afterEach(() => {
        console.warn = originalWarn;
        cleanupTest();
    });

    const mine = () => warnings.filter(w => w.includes('ypy-commands'));

    // a button that asks for /go; the response carries the commands
    async function run(commands, body = '<i id="body">ok</i>', extra = '') {
        let header = typeof commands == 'string' ? commands : JSON.stringify(commands);
        mockResponse('GET', '/go', body, {headers: {'YPY-Commands': header}});
        createProcessedHTML('<div id="box"><button id="b" ypy-get="/go" ypy-target="#out">go</button><div id="out"></div>' +
            '<p id="a" class="x">A</p><p id="c" class="x">C</p><input id="in">' + extra + '</div>');
        find('#b').click();
        await forRequest();
        await ypy.timeout(10);
    }

    it('addClass and removeClass act on every match', async function () {
        await run([{type: 'addClass', target: '.x', class: 'one two'}, {type: 'removeClass', target: '#a', class: 'x two'}]);
        find('#a').className.should.equal('one');
        find('#c').className.should.equal('x one two');
    });

    it('toggleClass toggles, and force sets', async function () {
        await run([{type: 'toggleClass', target: '#a', class: 'x'}, {type: 'toggleClass', target: '#c', class: 'x', force: true},
            {type: 'toggleClass', target: '#c', class: 'y', force: false}]);
        find('#a').className.should.equal('');
        find('#c').className.should.equal('x');
    });

    it('setAttribute and removeAttribute', async function () {
        await run([{type: 'setAttribute', target: '#a', name: 'title', value: 'Saved'}, {type: 'setAttribute', target: '#a', name: 'data-n', value: 3},
            {type: 'removeAttribute', target: '#c', name: 'class'}]);
        find('#a').getAttribute('title').should.equal('Saved');
        find('#a').getAttribute('data-n').should.equal('3');
        find('#c').hasAttribute('class').should.equal(false);
    });

    it('focus moves the focus', async function () {
        await run([{type: 'focus', target: '#in'}]);
        document.activeElement.should.equal(find('#in'));
    });

    it('scrollIntoView scrolls the target into the window', async function () {
        let tall = '<div id="tall" style="height:3000px"></div><p id="far">far</p>';
        await run([{type: 'scrollIntoView', target: '#far', block: 'start'}], '<i></i>', tall);
        try {
            // a scroll may finish a frame or two later (a page whose CSS says scroll-behavior: smooth, or Safari)
            for (let i = 0; i < 30 && window.scrollY <= 500; i++) await new Promise(r => requestAnimationFrame(r));
            window.scrollY.should.be.above(500);
        } finally {
            window.scrollTo(0, 0);
        }
    });

    it('remove takes the element out', async function () {
        await run([{type: 'remove', target: '#a'}]);
        assert.notExists(find('#a'));
        assert.exists(find('#c'));
    });

    it('remove cleans up what YPY started on the element', async function () {
        let seen = [];
        let spy = evt => seen.push(evt.target.id);
        document.addEventListener('ypy:before:cleanup', spy, true);
        try {
            await run([{type: 'remove', target: '#p'}], '<i></i>', '<p id="p" ypy-get="/other">p</p>');
        } finally {
            document.removeEventListener('ypy:before:cleanup', spy, true);
        }
        seen.should.include('p');
        assert.notExists(find('#p'));
    });

    it('dispatch fires an event with detail, on the target or on the document', async function () {
        let got = [];
        let onSaved = evt => got.push([evt.target.id || evt.target.nodeName, evt.detail]);
        document.addEventListener('saved', onSaved);
        document.addEventListener('page', onSaved);
        try {
            await run([{type: 'dispatch', target: '#a', event: 'saved', detail: {id: 7}}, {type: 'dispatch', event: 'page', detail: 'x'}]);
        } finally {
            document.removeEventListener('saved', onSaved);
            document.removeEventListener('page', onSaved);
        }
        got.should.deep.equal([['a', {id: 7}], ['#document', 'x']]);
    });

    it('show and hide use the hidden attribute', async function () {
        await run([{type: 'hide', target: '.x'}, {type: 'show', target: '#c'}]);
        find('#a').hidden.should.equal(true);
        find('#c').hidden.should.equal(false);
    });

    it('runs after the response was swapped, so a target can come with it', async function () {
        await run([{type: 'addClass', target: '#body', class: 'new'}]);
        find('#body').className.should.equal('new');
    });

    it('runs the commands of a response that is not swapped', async function () {
        mockResponse('GET', '/go', '', {status: 204, headers: {'YPY-Commands': JSON.stringify([{type: 'addClass', target: '#a', class: 'done'}])}});
        createProcessedHTML('<button id="b" ypy-get="/go">go</button><p id="a">A</p>');
        find('#b').click();
        await forRequest();
        find('#a').className.should.equal('done');
    });

    it('warns and ignores an unknown command, and runs the next one', async function () {
        let ignored = [];
        let spy = evt => ignored.push(evt.detail);
        document.addEventListener('ypy:commands:ignored', spy);
        try {
            await run([{type: 'explode', target: '#a'}, {type: 'eval', code: 'alert(1)'}, 'text', {type: 'addClass', target: '#a', class: 'ok'}]);
        } finally {
            document.removeEventListener('ypy:commands:ignored', spy);
        }
        find('#a').className.should.equal('x ok');
        mine().length.should.equal(3);
        ignored.map(d => d.reason).should.deep.equal(['unknown command', 'unknown command', 'unknown command']);
        ignored[0].command.type.should.equal('explode');
    });

    it('does not take a command of Object.prototype for a command', async function () {
        await run([{type: 'constructor', target: '#a'}, {type: 'toString', target: '#a'}, {type: '__proto__', target: '#a'}]);
        mine().length.should.equal(3);
    });

    it('ignores a command with a missing or invalid field', async function () {
        await run([{type: 'addClass', target: '#a'}, {type: 'setAttribute', target: '#a', value: 'x'}, {type: 'focus'},
            {type: 'addClass', target: '[', class: 'k'}, {type: 'dispatch', target: '#a'}, {type: 'toggleClass', target: '#a', class: 'k', force: 'yes'},
            {type: 'scrollIntoView', target: '#a', block: 3}]);
        mine().length.should.equal(7);
        find('#a').className.should.equal('x');
    });

    it('does not warn for a command whose selector matches nothing', async function () {
        await run([{type: 'addClass', target: '#nope', class: 'k'}]);
        mine().length.should.equal(0);
    });

    it('ignores a header that is not valid JSON, or not a list', async function () {
        await run('{not json');
        await run('{"type":"remove","target":"#a"}');
        mine().length.should.equal(2);
        assert.exists(find('#a'));
    });

    it('ignores a list longer than config.commands.max', async function () {
        ypy.config.commands = {max: 2};
        try {
            await run([{type: 'hide', target: '#a'}, {type: 'hide', target: '#c'}, {type: 'hide', target: '#in'}]);
        } finally {
            delete ypy.config.commands;
        }
        mine().length.should.equal(1);
        find('#a').hidden.should.equal(false);
    });

    describe('setAttribute cannot write code', function () {
        const blocked = [
            ['onclick', 'alert(1)'], ['onerror', 'x'], ['ONLOAD', 'x'], ['style', 'color:red'], ['srcdoc', '<p>'],
            ['ypy-on:click', 'js:alert(1)'], ['data-ypy-on:click', 'x'], ['ypy-get', '/x'],
            ['href', 'javascript:alert(1)'], ['href', ' JaVa\nScRiPt:alert(1)'], ['src', 'data:text/html,<p>']
        ];
        for (let [name, value] of blocked) {
            it(`blocks ${name}="${value.replace('\n', '\\n')}"`, async function () {
                await run([{type: 'setAttribute', target: '#a', name, value}]);
                mine().length.should.equal(1);
                mine()[0].should.contain('not allowed');
                find('#a').attributes.length.should.equal(2); // id and class only
            });
        }

        it('still sets an ordinary href and a data attribute', async function () {
            await run([{type: 'setAttribute', target: '#a', name: 'href', value: '/ok'}, {type: 'setAttribute', target: '#a', name: 'aria-live', value: 'polite'}]);
            find('#a').getAttribute('href').should.equal('/ok');
            find('#a').getAttribute('aria-live').should.equal('polite');
        });

        it('rejects an attribute name that is not a name', async function () {
            await run([{type: 'setAttribute', target: '#a', name: 'a b', value: '1'}, {type: 'setAttribute', target: '#a', name: 'x"y', value: '1'}]);
            mine().length.should.equal(2);
        });
    });

    it('ypy:before:command can skip a command', async function () {
        let veto = evt => { if (evt.detail.command.type == 'hide') evt.preventDefault() };
        document.addEventListener('ypy:before:command', veto);
        try {
            await run([{type: 'hide', target: '#a'}, {type: 'addClass', target: '#a', class: 'k'}]);
        } finally {
            document.removeEventListener('ypy:before:command', veto);
        }
        find('#a').hidden.should.equal(false);
        find('#a').className.should.equal('x k');
    });

    it('ypy.commands.run runs a list or a JSON string', function () {
        createProcessedHTML('<p id="a">A</p>');
        ypy.commands.run([{type: 'addClass', target: '#a', class: 'one'}]);
        ypy.commands.run('[{"type":"addClass","target":"#a","class":"two"}]');
        find('#a').className.should.equal('one two');
    });

    it('does nothing for a response without the header', async function () {
        mockResponse('GET', '/go', '<i>ok</i>');
        createProcessedHTML('<button id="b" ypy-get="/go">go</button><p id="a">A</p>');
        find('#b').click();
        await forRequest();
        mine().length.should.equal(0);
        find('#a').hasAttribute('class').should.equal(false);
    });
});
