// SPDX-License-Identifier: MIT
describe('ypy-sort extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-sort.js';
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
    });

    afterEach(() => {
        cleanupTest();
    });

    const calls = () => fetchMock.getCalls();
    const order = () => [...find('#l').children].map(x => x.id).join('');
    const make = (attrs = 'ypy-sort ypy-sort-url="/order"') => createProcessedHTML(
        `<ul id="l" ${attrs}><li id="a">A</li><li id="b">B</li><li id="c">C</li></ul>`);

    // a drag by hand: the browser's own drag cannot be started from a script
    const fire = (el, type, init = {}) => {
        let evt = new DragEvent(type, {bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), ...init});
        el.dispatchEvent(evt);
        return evt;
    };
    const lowerHalf = el => { let r = el.getBoundingClientRect(); return {clientX: r.left + 5, clientY: r.top + r.height * 0.75} };
    const upperHalf = el => { let r = el.getBoundingClientRect(); return {clientX: r.left + 5, clientY: r.top + r.height * 0.25} };

    function drag(from, over, half) {
        let dataTransfer = new DataTransfer();
        fire(find(from), 'dragstart', {dataTransfer});
        fire(find(over), 'dragover', {dataTransfer, ...half(find(over))});
        fire(find(over), 'drop', {dataTransfer});
        fire(find(from), 'dragend', {dataTransfer});
    }

    const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true}));
    const bodyIds = () => calls()[0].request.body.getAll('id');

    it('makes the items with an id draggable and focusable', function () {
        createProcessedHTML('<ul id="l" ypy-sort><h3>Title</h3><li id="a">A</li><li>no id</li><li id="b" tabindex="-1" draggable="false">B</li></ul>');
        find('#a').getAttribute('draggable').should.equal('true');
        find('#a').getAttribute('tabindex').should.equal('0');
        find('#l h3').hasAttribute('draggable').should.equal(false);
        find('#l li:nth-child(3)').hasAttribute('draggable').should.equal(false);
        find('#b').getAttribute('tabindex').should.equal('-1');
        find('#b').getAttribute('draggable').should.equal('false');
    });

    it('tags the items a later swap brings', async function () {
        make();
        find('#l').insertAdjacentHTML('beforeend', '<li id="d">D</li>');
        await ypy.timeout(10);
        find('#d').getAttribute('draggable').should.equal('true');
    });

    it('does nothing with ypy-sort="false" or inside ypy-ignore', function () {
        createProcessedHTML('<ul id="l" ypy-sort="false"><li id="a">A</li></ul><div ypy-ignore><ul id="m" ypy-sort><li id="x">X</li></ul></div>');
        find('#a').hasAttribute('draggable').should.equal(false);
        find('#x').hasAttribute('draggable').should.equal(false);
    });

    it('drops an item after another and posts the ids in the new order', async function () {
        mockResponse('POST', '/order', '');
        make();
        drag('#a', '#b', lowerHalf);
        order().should.equal('bac');
        await forRequest();
        calls().length.should.equal(1);
        calls()[0].url.should.equal('/order');
        calls()[0].request.method.should.equal('POST');
        bodyIds().should.deep.equal(['b', 'a', 'c']);
    });

    it('drops an item before another', async function () {
        mockResponse('POST', '/order', '');
        make();
        drag('#c', '#a', upperHalf);
        order().should.equal('cab');
        await forRequest();
        bodyIds().should.deep.equal(['c', 'a', 'b']);
    });

    it('moves the list while the item is dragged and marks it', function () {
        make();
        let dataTransfer = new DataTransfer();
        fire(find('#a'), 'dragstart', {dataTransfer});
        find('#a').dataset.ypyState.should.contain('dragging');
        fire(find('#c'), 'dragover', {dataTransfer, ...lowerHalf(find('#c'))});
        order().should.equal('bca');
        fire(find('#a'), 'dragend', {dataTransfer});
        // no drop happened: everything goes back
        order().should.equal('abc');
        assert.isUndefined(find('#a').dataset.ypyState);
    });

    it('does not post when the order did not change', async function () {
        make();
        drag('#a', '#b', upperHalf);
        await ypy.timeout(30);
        order().should.equal('abc');
        calls().length.should.equal(0);
    });

    it('fires ypy:sort:change with the ids, and a cancelled change puts the list back', async function () {
        make();
        let seen;
        let veto = evt => { seen = evt.detail; evt.preventDefault() };
        document.addEventListener('ypy:sort:change', veto);
        let reverted = waitForEvent('ypy:sort:revert', 100);
        try {
            drag('#a', '#c', lowerHalf);
        } finally {
            document.removeEventListener('ypy:sort:change', veto);
        }
        seen.ids.should.deep.equal(['b', 'c', 'a']);
        seen.item.id.should.equal('a');
        (await reverted).detail.reason.should.equal('cancelled');
        order().should.equal('abc');
        calls().length.should.equal(0);
    });

    it('puts the list back when the server answers with an error', async function () {
        mockResponse('POST', '/order', 'no', {status: 500});
        make();
        let reverted = waitForEvent('ypy:sort:revert', 300);
        drag('#a', '#b', lowerHalf);
        order().should.equal('bac');
        let evt = await reverted;
        evt.detail.reason.should.equal('failed');
        evt.detail.ids.should.deep.equal(['a', 'b', 'c']);
        order().should.equal('abc');
    });

    it('puts the list back when the connection fails', async function () {
        mockFailure('POST', '/order');
        make();
        let reverted = waitForEvent('ypy:sort:revert', 300);
        drag('#c', '#a', upperHalf);
        await reverted;
        order().should.equal('abc');
    });

    it('keeps the new order when the server accepts it', async function () {
        mockResponse('POST', '/order', '<i>ok</i>');
        make();
        drag('#a', '#c', lowerHalf);
        await forRequest();
        await ypy.timeout(20);
        order().should.equal('bca');
        find('#l').textContent.should.equal('BCA');
    });

    it('keeps the fields of ypy-vals', async function () {
        mockResponse('POST', '/order', '');
        make('ypy-sort ypy-sort-url="/order" ypy-vals=\'{"list":"todo"}\'');
        drag('#a', '#b', lowerHalf);
        await forRequest();
        calls()[0].request.body.get('list').should.equal('todo');
    });

    it('only reorders and fires the event without ypy-sort-url', async function () {
        make('ypy-sort');
        let got;
        let spy = evt => { got = evt.detail.ids };
        document.addEventListener('ypy:sort:change', spy);
        try {
            drag('#a', '#b', lowerHalf);
        } finally {
            document.removeEventListener('ypy:sort:change', spy);
        }
        await ypy.timeout(20);
        got.should.deep.equal(['b', 'a', 'c']);
        calls().length.should.equal(0);
        order().should.equal('bac');
    });

    describe('keyboard', function () {

        it('arrows move the focus between the items when nothing is picked up', function () {
            make();
            find('#a').focus();
            key(find('#a'), 'ArrowDown');
            document.activeElement.id.should.equal('b');
            key(find('#b'), 'ArrowRight');
            document.activeElement.id.should.equal('c');
            key(find('#c'), 'ArrowDown');
            document.activeElement.id.should.equal('c');
            key(find('#c'), 'ArrowUp');
            document.activeElement.id.should.equal('b');
        });

        it('space picks an item up, arrows move it, space puts it down and posts', async function () {
            mockResponse('POST', '/order', '');
            make();
            let a = find('#a');
            a.focus();
            key(a, ' ');
            a.dataset.ypyState.should.contain('grabbed');
            key(a, 'ArrowDown');
            key(a, 'ArrowDown');
            order().should.equal('bca');
            document.activeElement.should.equal(a);
            key(a, 'ArrowDown');   // already last
            order().should.equal('bca');
            key(a, 'ArrowUp');
            order().should.equal('bac');
            calls().length.should.equal(0);   // nothing is sent until it is put down
            key(a, ' ');
            assert.isUndefined(a.dataset.ypyState);
            await forRequest();
            bodyIds().should.deep.equal(['b', 'a', 'c']);
        });

        it('escape puts everything back and posts nothing', async function () {
            make();
            let c = find('#c');
            c.focus();
            key(c, ' ');
            key(c, 'ArrowUp');
            key(c, 'ArrowUp');
            order().should.equal('cab');
            key(c, 'Escape');
            order().should.equal('abc');
            document.activeElement.should.equal(c);
            assert.isUndefined(c.dataset.ypyState);
            await ypy.timeout(20);
            calls().length.should.equal(0);
        });

        it('puts the list back when the server refuses what the keyboard sent', async function () {
            mockResponse('POST', '/order', 'no', {status: 422});
            make();
            let reverted = waitForEvent('ypy:sort:revert', 300);
            let a = find('#a');
            a.focus();
            key(a, ' ');
            key(a, 'ArrowDown');
            key(a, ' ');
            order().should.equal('bac');
            await reverted;
            order().should.equal('abc');
            document.activeElement.should.equal(a);
        });

        it('does not take the keys of a field inside an item', function () {
            createProcessedHTML('<ul id="l" ypy-sort><li id="a"><input id="in"></li><li id="b">B</li></ul>');
            find('#in').focus();
            let evt = new KeyboardEvent('keydown', {key: ' ', bubbles: true, cancelable: true});
            find('#in').dispatchEvent(evt);
            evt.defaultPrevented.should.equal(false);
            assert.isUndefined(find('#a').dataset.ypyState);
        });

        it('says what happened in a live region when config.sort.messages is set', function () {
            ypy.config.sort = {messages: {grab: 'Picked up, place {position} of {total}', move: 'Place {position} of {total}'}};
            try {
                make();
                let a = find('#a');
                a.focus();
                key(a, ' ');
                let live = document.querySelector('[data-ypy-sort-live]');
                live.getAttribute('role').should.equal('status');
                live.textContent.should.equal('Picked up, place 1 of 3');
                key(a, 'ArrowDown');
                live.textContent.should.equal('Place 2 of 3');
            } finally {
                delete ypy.config.sort;
                document.querySelector('[data-ypy-sort-live]')?.remove();
            }
        });

        it('says nothing without messages', function () {
            make();
            find('#a').focus();
            key(find('#a'), ' ');
            assert.isNull(document.querySelector('[data-ypy-sort-live]'));
        });
    });
});
