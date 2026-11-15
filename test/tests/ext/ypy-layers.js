// SPDX-License-Identifier: MIT
describe('ypy-layers extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-layers.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
    });

    after(() => {
        restoreExtensions(extBackup);
    });

    beforeEach(() => { setupTest(this.currentTest); });
    afterEach(() => {
        for (let layer of [...ypy.layers.stack].reverse()) layer.dismiss();
        document.querySelectorAll('dialog[data-ypy-layer-kind]').forEach(d => d.remove());
        document.documentElement.removeAttribute('data-ypy-layer-lock');
        delete ypy.config.layers;
        cleanupTest();
    });

    const dialogs = () => [...document.querySelectorAll('dialog[data-ypy-layer-kind]')];
    const dialog = () => dialogs().at(-1);
    const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

    // Runs fn and waits until a layer is shown
    async function opening(fn) {
        let opened = waitForEvent('ypy:layer:opened', 1500);
        let result = fn();
        assert.isNotNull(await opened, 'a layer should have opened');
        // not the promise itself: awaiting it would wait for the layer to close
        return {layer: result?.layer, result};
    }
    const openLayer = (spec, opts) => opening(() => ypy.layers.open(spec, opts));

    // Records the events of one name until the test ends
    function record(name) {
        let seen = [];
        let handler = e => seen.push(e.detail);
        document.addEventListener(name, handler);
        after_each_cleanup.push(() => document.removeEventListener(name, handler));
        return seen;
    }
    let after_each_cleanup = [];
    afterEach(() => { after_each_cleanup.splice(0).forEach(fn => fn()) });

    // A click that tells whether a layer took it over (the page never navigates in a test)
    function clickAndWatch(elt) {
        let intercepted;
        let guard = e => { intercepted = e.defaultPrevented; e.preventDefault() };
        document.addEventListener('click', guard, {once: true});
        elt.click();
        document.removeEventListener('click', guard);
        return intercepted;
    }

    describe('the API', function () {

        it('opens a modal on a native dialog with the content it was given', async function () {
            let promise = await openLayer('<h2>Hello</h2><p id="in">text</p>');
            let d = dialog();
            assert.equal(d.tagName, 'DIALOG');
            assert.isTrue(d.open);
            assert.isTrue(d.matches(':modal'));
            assert.equal(d.getAttribute('data-ypy-layer-kind'), 'modal');
            assert.equal(d.querySelector('#in').textContent, 'text');
            assert.equal(ypy.layers.stack.length, 1);
            assert.equal(ypy.layers.top(), promise.layer);
            assert.equal(promise.layer.element, d);
        });

        it('a string that does not start with "<" is a URL', async function () {
            mockResponse('GET', '/panel', '<p id="remote">from the server</p>');
            await openLayer('/panel');
            assert.equal(lastFetch().url, '/panel');
            assert.equal(dialog().querySelector('#remote').textContent, 'from the server');
        });

        it('takes an options object with html or url', async function () {
            await openLayer({html: '<p id="x">x</p>', mode: 'drawer'});
            assert.equal(dialog().getAttribute('data-ypy-layer-kind'), 'drawer');
            assert.isNotNull(dialog().querySelector('#x'));
        });

        it('sends the layer mode to the server in the YPY-Layer header', async function () {
            mockResponse('GET', '/panel', '<p>x</p>');
            await openLayer('/panel', {mode: 'drawer'});
            assert.equal(lastFetch().request.headers['YPY-Layer'], 'drawer');
            assert.equal(lastFetch().request.headers['YPY-Request'], 'true');
        });

        it('passes select and values on to the request', async function () {
            mockResponse('GET', '/page', '<main id="m">only this</main><footer>not this</footer>');
            await openLayer('/page', {select: '#m', values: {q: 'a b'}});
            assert.include(lastFetch().url, 'q=a+b');
            assert.isNull(dialog().querySelector('footer'));
            assert.equal(dialog().querySelector('#m').textContent, 'only this');
        });

        it('a request that cannot reach the server leaves no dialog and dismisses with the reason "error"', async function () {
            mockFailure('GET', '/down');
            let dismissed = record('ypy:layer:dismissed');
            let quiet = console.error;
            console.error = () => {};
            let result;
            try { result = await ypy.layers.open('/down') } finally { console.error = quiet }
            assert.deepEqual(result, {accepted: false, reason: 'error'});
            assert.equal(dialogs().length, 0);
            assert.equal(ypy.layers.stack.length, 0);
            assert.equal(dismissed.length, 1);
        });

        it('an error response is shown in the layer like any response; ypy-status can say otherwise', async function () {
            mockResponse('GET', '/missing', '<p id="nf">not found</p>', {status: 404});
            await openLayer('/missing');
            assert.equal(dialog().querySelector('#nf').textContent, 'not found');
        });

        it('a response answered with a swap of none leaves the layer without content and it is dismissed', async function () {
            mockResponse('GET', '/empty', '', {status: 204});
            let result = await ypy.layers.open('/empty');
            assert.deepEqual(result, {accepted: false, reason: 'error'});
            assert.equal(dialogs().length, 0);
        });

        it('opening twice from one opener while the first request runs drops the second layer', async function () {
            mockResponse('GET', '/slow', '<p>x</p>');
            createProcessedHTML('<a id="o" href="/slow" ypy-layer ypy-sync="drop">x</a>');
            let dismissed = record('ypy:layer:dismissed');
            let opened = waitForEvent('ypy:layer:opened', 1500);
            find('#o').click();
            find('#o').click();
            await opened;
            await tick(60);
            assert.equal(dialogs().length, 1);
            assert.equal(dismissed.length, 1);
            assert.equal(dismissed[0].reason, 'dropped');
        });

        it('ypy:layer:before:open can cancel', async function () {
            let cancel = e => e.preventDefault();
            document.addEventListener('ypy:layer:before:open', cancel);
            try {
                let result = await ypy.layers.open('<p>x</p>');
                assert.deepEqual(result, {accepted: false, reason: 'cancelled'});
                assert.equal(dialogs().length, 0);
            } finally { document.removeEventListener('ypy:layer:before:open', cancel) }
        });

        it('layer content is processed like any swapped content', async function () {
            mockResponse('GET', '/inner', 'inner');
            await openLayer('<button id="b" ypy-get="/inner" ypy-target="#t">go</button><div id="t">old</div>');
            dialog().querySelector('#b').click();
            await forRequest();
            assert.equal(dialog().querySelector('#t').textContent, 'inner');
        });
    });

    describe('accept and dismiss', function () {

        it('the promise resolves with the value of an accept', async function () {
            let promise = await openLayer('<p>x</p>');
            promise.layer.accept({id: 7});
            assert.deepEqual(await promise.result, {accepted: true, value: {id: 7}});
            assert.equal(dialogs().length, 0);
            assert.equal(ypy.layers.stack.length, 0);
        });

        it('the promise resolves with the reason of a dismissal, "dismissed" by default', async function () {
            let promise = await openLayer('<p>x</p>');
            ypy.layers.dismiss();
            assert.deepEqual(await promise.result, {accepted: false, reason: 'dismissed'});
            let second = await openLayer('<p>y</p>');
            second.layer.dismiss('nope');
            assert.deepEqual(await second.result, {accepted: false, reason: 'nope'});
        });

        it('fires ypy:layer:accepted on the layer, with the value, before it leaves the page', async function () {
            let inPage;
            let handler = e => { inPage = e.target.isConnected && e.target.matches('dialog'); };
            document.addEventListener('ypy:layer:accepted', handler);
            let accepted = record('ypy:layer:accepted');
            let promise = await openLayer('<p>x</p>');
            ypy.layers.accept('ok');
            await promise.result;
            document.removeEventListener('ypy:layer:accepted', handler);
            assert.isTrue(inPage);
            assert.equal(accepted[0].value, 'ok');
            assert.isTrue(accepted[0].accepted);
            assert.equal(accepted[0].layer, promise.layer);
        });

        it('fires ypy:layer:dismissed with the reason', async function () {
            let dismissed = record('ypy:layer:dismissed');
            let promise = await openLayer('<p>x</p>');
            promise.layer.dismiss('later');
            await promise.result;
            assert.equal(dismissed.length, 1);
            assert.equal(dismissed[0].reason, 'later');
            assert.isFalse(dismissed[0].accepted);
        });

        it('ypy:layer:before:close can keep the layer open', async function () {
            let promise = await openLayer('<p>x</p>');
            let veto = e => e.preventDefault();
            document.addEventListener('ypy:layer:before:close', veto);
            assert.isFalse(promise.layer.dismiss());
            assert.isTrue(promise.layer.element.isConnected);
            assert.equal(ypy.layers.stack.length, 1);
            document.removeEventListener('ypy:layer:before:close', veto);
            assert.isTrue(promise.layer.dismiss());
            await promise.result;
            assert.equal(dialogs().length, 0);
        });

        it('buttons with ypy-layer-accept and ypy-layer-dismiss close the layer', async function () {
            let a = await openLayer('<button id="a" ypy-layer-accept=\'{"n":1}\'>ok</button>');
            dialog().querySelector('#a').click();
            assert.deepEqual(await a.result, {accepted: true, value: {n: 1}});
            let b = await openLayer('<button id="b" ypy-layer-dismiss="cancelled">no</button>');
            dialog().querySelector('#b').click();
            assert.deepEqual(await b.result, {accepted: false, reason: 'cancelled'});
            let c = await openLayer('<button id="c" ypy-layer-accept>ok</button>');
            dialog().querySelector('#c').click();
            assert.deepEqual(await c.result, {accepted: true, value: undefined});
        });

        it('the native close of a dialog form closes the layer', async function () {
            let promise = await openLayer('<form method="dialog"><button id="c" value="done">close</button></form>');
            dialog().querySelector('form').requestSubmit(dialog().querySelector('#c'));
            let result = await promise.result;
            assert.deepEqual(result, {accepted: false, reason: 'done'});
        });
    });

    describe('closing from the outside', function () {

        it('Esc dismisses a modal; the cancel event is the browser telling it', async function () {
            let promise = await openLayer('<p>x</p>');
            let cancel = new Event('cancel', {cancelable: true});
            dialog().dispatchEvent(cancel);
            assert.isTrue(cancel.defaultPrevented, 'the browser must not close it by itself');
            assert.deepEqual(await promise.result, {accepted: false, reason: 'escape'});
        });

        it('escape:false keeps the layer open', async function () {
            let promise = await openLayer('<p>x</p>', {escape: false});
            dialog().dispatchEvent(new Event('cancel', {cancelable: true}));
            await tick();
            assert.equal(ypy.layers.stack.length, 1);
            promise.layer.dismiss();
        });

        function pointer(target, type, x = 1, y = 1) {
            target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y}));
        }

        it('a click on the backdrop dismisses a modal', async function () {
            let promise = await openLayer('<p>x</p>');
            pointer(dialog(), 'pointerdown');
            pointer(dialog(), 'click');
            assert.deepEqual(await promise.result, {accepted: false, reason: 'outside'});
        });

        it('a click inside the dialog does not close it, even on its padding', async function () {
            let promise = await openLayer('<p id="p">x</p>');
            let r = dialog().getBoundingClientRect();
            pointer(dialog().querySelector('#p'), 'pointerdown', r.left + 5, r.top + 5);
            pointer(dialog().querySelector('#p'), 'click', r.left + 5, r.top + 5);
            pointer(dialog(), 'pointerdown', r.left + 2, r.top + 2);
            pointer(dialog(), 'click', r.left + 2, r.top + 2);
            await tick();
            assert.equal(ypy.layers.stack.length, 1);
            promise.layer.dismiss();
        });

        it('a drag that starts inside and ends on the backdrop does not close it', async function () {
            let promise = await openLayer('<p id="p">x</p>');
            let r = dialog().getBoundingClientRect();
            pointer(dialog().querySelector('#p'), 'pointerdown', r.left + 5, r.top + 5);
            pointer(dialog(), 'click');
            await tick();
            assert.equal(ypy.layers.stack.length, 1);
            promise.layer.dismiss();
        });

        it('outside:false keeps a modal open on a backdrop click', async function () {
            let promise = await openLayer('<p>x</p>', {outside: false});
            pointer(dialog(), 'pointerdown');
            pointer(dialog(), 'click');
            await tick();
            assert.equal(ypy.layers.stack.length, 1);
            promise.layer.dismiss();
        });

        it('config.layers sets the defaults for escape and outside', async function () {
            ypy.config.layers = {escape: false, outside: false};
            let promise = await openLayer('<p>x</p>');
            dialog().dispatchEvent(new Event('cancel', {cancelable: true}));
            pointer(dialog(), 'pointerdown');
            pointer(dialog(), 'click');
            await tick();
            assert.equal(ypy.layers.stack.length, 1);
            promise.layer.dismiss();
        });

        it('closeOn closes when an event of that name comes from inside the layer, and hands over its detail', async function () {
            let promise = await openLayer('<p id="p">x</p>', {closeOn: 'saved, cancelled'});
            ypy.trigger(dialog().querySelector('#p'), 'saved', {id: 3});
            assert.deepEqual(await promise.result, {accepted: true, value: {id: 3}});
        });

        it('closeOn also takes an event fired on the page, for the top layer only', async function () {
            let lower = await openLayer('<p>low</p>', {closeOn: 'saved'});
            let upper = await openLayer('<p>up</p>', {closeOn: 'saved'});
            ypy.trigger(document.body, 'saved', {});
            assert.isTrue((await upper.result).accepted);
            assert.isFalse(lower.layer.closed);
            lower.layer.dismiss();
        });

        it('closeOn: an event of a layer that is not the top one closes it and the layers above', async function () {
            let lower = await openLayer('<p id="low">low</p>', {closeOn: 'saved'});
            let upper = await openLayer('<p>up</p>');
            ypy.trigger(lower.layer.element.querySelector('#low'), 'saved', {});
            assert.deepEqual(await upper.result, {accepted: false, reason: 'parent'});
            assert.isTrue((await lower.result).accepted);
        });

        it('a YPY-Trigger header from a form in the layer closes it (ypy-layer-close-on)', async function () {
            mockResponse('GET', '/new', '<form action="/save" method="post"><input name="n" value="1"><button>Save</button></form>');
            mockResponse('POST', '/save', '<p>saved</p>', {headers: {'YPY-Trigger': '{"saved":{"id":7}}'}});
            createProcessedHTML('<a id="o" href="/new" ypy-layer="modal" ypy-layer-close-on="saved">New</a>');
            let promise;
            await opening(() => { promise = new Promise(resolve => document.addEventListener('ypy:layer:accepted', e => resolve(e.detail), {once: true})); find('#o').click() });
            dialog().querySelector('form').requestSubmit();
            let detail = await promise;
            assert.deepEqual(detail.value, {id: 7});
            assert.equal(dialogs().length, 0);
        });

        it('closeOnUrl closes when the layer navigates to a matching URL, and does not swap that page in', async function () {
            mockResponse('GET', '/new', '<form id="f" action="/save" method="post"><button>Save</button></form>');
            mockResponse('POST', '/save', '<h1>the whole list page</h1>', {url: '/items/3'});
            let promise = await openLayer('/new', {closeOnUrl: '/items/*'});
            dialog().querySelector('#f').requestSubmit();
            assert.deepEqual(await promise.result, {accepted: true, value: '/items/3'});
        });

        it('closeOnUrl on the first response closes the layer before it is shown', async function () {
            mockResponse('GET', '/old', '<p>x</p>', {url: '/done'});
            let opened = record('ypy:layer:opened');
            let result = await ypy.layers.open('/old', {closeOnUrl: '/done'});
            assert.deepEqual(result, {accepted: true, value: '/done'});
            assert.equal(opened.length, 0);
        });

        it('closeOnFragment closes when the response holds that fragment, with its ypy-layer-value', async function () {
            mockResponse('GET', '/new', '<form id="f" action="/save" method="post"><button>Save</button></form>');
            mockResponse('POST', '/save', '<div id="saved" ypy-layer-value=\'{"id":9}\'>Saved</div>');
            let promise = await openLayer('/new', {closeOnFragment: '#saved'});
            dialog().querySelector('#f').requestSubmit();
            assert.deepEqual(await promise.result, {accepted: true, value: {id: 9}});
        });

        it('ypy-layer-close-on-url and ypy-layer-close-on-fragment on the opener', async function () {
            mockResponse('GET', '/a', '<a id="n" href="/b">next</a>');
            mockResponse('GET', '/b', '<p>b</p>', {url: '/b'});
            createProcessedHTML('<a id="o" href="/a" ypy-layer ypy-layer-close-on-url="/b">A</a>');
            let accepted;
            await opening(() => { accepted = new Promise(resolve => document.addEventListener('ypy:layer:accepted', e => resolve(e.detail), {once: true})); find('#o').click() });
            dialog().querySelector('#n').click();
            assert.equal((await accepted).value, '/b');
        });
    });

    describe('the stack', function () {

        it('layers stack: depth, order and the top one', async function () {
            let first = await openLayer('<p>one</p>');
            let second = await openLayer('<p>two</p>', {mode: 'drawer'});
            assert.deepEqual(ypy.layers.stack, [first.layer, second.layer]);
            assert.equal(ypy.layers.top(), second.layer);
            assert.equal(first.layer.element.getAttribute('data-ypy-layer-depth'), '1');
            assert.equal(second.layer.element.getAttribute('data-ypy-layer-depth'), '2');
            assert.isTrue(second.layer.element.matches(':modal'));
        });

        it('dismissing the top layer leaves the one below', async function () {
            let first = await openLayer('<p>one</p>');
            let second = await openLayer('<p>two</p>');
            ypy.layers.dismiss();
            await second.result;
            assert.deepEqual(ypy.layers.stack, [first.layer]);
            assert.isTrue(first.layer.element.isConnected);
        });

        it('closing a layer dismisses the layers above it first, with the reason "parent"', async function () {
            let order = [];
            document.addEventListener('ypy:layer:dismissed', e => order.push(e.detail.reason), {once: false});
            let first = await openLayer('<p>one</p>');
            let second = await openLayer('<p>two</p>');
            let third = await openLayer('<p>three</p>');
            first.layer.dismiss('bye');
            assert.deepEqual(await second.result, {accepted: false, reason: 'parent'});
            assert.deepEqual(await third.result, {accepted: false, reason: 'parent'});
            assert.equal(ypy.layers.stack.length, 0);
            assert.deepEqual(order.slice(-3), ['parent', 'parent', 'bye']);
        });

        it('a layer above that refuses to close keeps the one below open', async function () {
            let first = await openLayer('<p>one</p>');
            let second = await openLayer('<p>two</p>');
            let veto = e => { if (e.detail.layer === second.layer) e.preventDefault() };
            document.addEventListener('ypy:layer:before:close', veto);
            assert.isFalse(first.layer.dismiss());
            assert.equal(ypy.layers.stack.length, 2);
            document.removeEventListener('ypy:layer:before:close', veto);
            assert.isTrue(ypy.layers.closeAll());
            assert.equal(ypy.layers.stack.length, 0);
        });

        it('Esc closes the top layer only', async function () {
            let first = await openLayer('<p>one</p>');
            let second = await openLayer('<p>two</p>');
            second.layer.element.dispatchEvent(new Event('cancel', {cancelable: true}));
            assert.equal((await second.result).reason, 'escape');
            assert.isFalse(first.layer.closed);
        });

        it('the page does not scroll while a modal or a drawer is open, until the last one closes', async function () {
            let lock = () => document.documentElement.hasAttribute('data-ypy-layer-lock');
            assert.isFalse(lock());
            let first = await openLayer('<p>one</p>');
            let second = await openLayer('<p>two</p>', {mode: 'drawer'});
            assert.isTrue(lock());
            second.layer.dismiss();
            assert.isTrue(lock(), 'the modal is still open');
            first.layer.dismiss();
            assert.isFalse(lock());
        });

        it('a popup does not lock the page', async function () {
            let popup = await openLayer('<p>x</p>', {mode: 'popup'});
            assert.isFalse(document.documentElement.hasAttribute('data-ypy-layer-lock'));
            popup.layer.dismiss();
        });

        it('config.layers.scrollLock:false leaves the page scrolling', async function () {
            ypy.config.layers = {scrollLock: false};
            let promise = await openLayer('<p>x</p>');
            assert.isFalse(document.documentElement.hasAttribute('data-ypy-layer-lock'));
            promise.layer.dismiss();
        });

        it('a popup over a modal lives inside it, where the page is not inert', async function () {
            let modal = await openLayer('<p>m</p>');
            let popup = await openLayer('<button id="in">in popup</button>', {mode: 'popup'});
            assert.equal(popup.layer.element.parentElement, modal.layer.element);
            assert.isFalse(popup.layer.element.matches(':modal'));
            popup.layer.element.querySelector('#in').focus();
            assert.equal(document.activeElement.id, 'in');
            popup.layer.dismiss();
            modal.layer.dismiss();
        });

        it('navigating the layer closes the popup that lives inside it', async function () {
            mockResponse('GET', '/next', '<p id="n">next</p>');
            let modal = await openLayer('<a id="l" href="/next">next</a>');
            let popup = await openLayer('<p>pop</p>', {mode: 'popup'});
            assert.equal(popup.layer.element.parentElement, modal.layer.element);
            modal.layer.element.querySelector('#l').click();
            assert.deepEqual(await popup.result, {accepted: false, reason: 'navigate'});
            await forRequest();
            assert.isNotNull(modal.layer.element.querySelector('#n'));
        });

        it('closeAll dismisses everything, the top one first', async function () {
            let a = await openLayer('<p>a</p>');
            let b = await openLayer('<p>b</p>');
            let order = [];
            [a, b].forEach((h, i) => h.result.then(() => order.push(i)));
            assert.isTrue(ypy.layers.closeAll('all'));
            await tick();
            assert.deepEqual(order, [1, 0]);
        });
    });

    describe('accessibility', function () {

        it('a modal says it is modal; a popup does not', async function () {
            let modal = await openLayer('<p>m</p>');
            assert.equal(modal.layer.element.getAttribute('aria-modal'), 'true');
            let drawer = await openLayer('<p>d</p>', {mode: 'drawer'});
            assert.equal(drawer.layer.element.getAttribute('aria-modal'), 'true');
            let popup = await openLayer('<p>p</p>', {mode: 'popup'});
            assert.isFalse(popup.layer.element.hasAttribute('aria-modal'));
            ypy.layers.closeAll();
        });

        it('the name of the layer is its first heading (aria-labelledby)', async function () {
            await openLayer('<div><h2>New item</h2><p>x</p></div>');
            let d = dialog();
            let id = d.getAttribute('aria-labelledby');
            assert.isNotEmpty(id);
            assert.equal(document.getElementById(id).textContent, 'New item');
        });

        it('keeps the heading id it has, and follows the content when the layer navigates', async function () {
            mockResponse('GET', '/next', '<h1 id="mine">Second</h1>');
            await openLayer('<h2>First</h2><a id="l" href="/next">next</a>');
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(dialog().getAttribute('aria-labelledby'), 'mine');
        });

        it('the label option names the layer with aria-label and no heading is looked for', async function () {
            await openLayer('<h2>Heading</h2>', {label: 'Edit item'});
            assert.equal(dialog().getAttribute('aria-label'), 'Edit item');
            assert.isFalse(dialog().hasAttribute('aria-labelledby'));
        });

        it('moves the focus into the layer, on the first control', async function () {
            let opener = createProcessedHTML('<button id="op">open</button>');
            opener.focus();
            await openLayer('<p>x</p><button id="first">1</button><button>2</button>');
            assert.equal(document.activeElement.id, 'first');
        });

        it('autofocus picks the control that gets the focus', async function () {
            await openLayer('<button>1</button><input id="auto" autofocus>');
            assert.equal(document.activeElement.id, 'auto');
        });

        it('a layer without controls takes the focus itself', async function () {
            await openLayer('<p>nothing to click</p>');
            assert.equal(document.activeElement, dialog());
        });

        it('returns the focus to the opener when it closes', async function () {
            let opener = createProcessedHTML('<button id="op">open</button>');
            opener.focus();
            let promise = await openLayer('<button id="in">x</button>');
            assert.notEqual(document.activeElement, opener);
            promise.layer.dismiss();
            assert.equal(document.activeElement, opener);
        });

        it('returns the focus to the element that opened it from inside the layer below', async function () {
            let first = await openLayer('<button id="first">x</button>');
            let second;
            first.layer.element.querySelector('#first').focus();
            second = await openLayer('<button id="second">y</button>');
            assert.equal(document.activeElement.id, 'second');
            second.layer.dismiss();
            assert.equal(document.activeElement.id, 'first');
        });

        it('a modal traps the focus: the page behind cannot take it', async function () {
            createProcessedHTML('<button id="behind">behind</button>');
            await openLayer('<button id="in">x</button>');
            find('#behind').focus();
            assert.isTrue(dialog().contains(document.activeElement), 'the focus must stay in the layer');
        });

        it('a modal can be the only thing in the tab order: Tab wraps inside it', async function () {
            // The browser does the wrapping for a modal dialog; this checks nothing outside the layer is focusable
            createProcessedHTML('<button id="behind">behind</button><a href="#x" id="link">link</a>');
            await openLayer('<button id="a">a</button><button id="b">b</button>');
            for (let id of ['behind', 'link']) {
                find('#' + id).focus();
                assert.isTrue(dialog().contains(document.activeElement), id + ' must not take the focus');
            }
        });

        it('keeps the focus inside when a swap removes the focused control', async function () {
            mockResponse('GET', '/next', '<p>no controls now</p>');
            await openLayer('<a id="l" href="/next">next</a>');
            dialog().querySelector('#l').focus();
            dialog().querySelector('#l').click();
            await forRequest();
            assert.isTrue(dialog().contains(document.activeElement));
        });
    });

    describe('openers: links, forms and buttons with ypy-layer', function () {

        it('a link opens the layer with the response; the page does not navigate', async function () {
            mockResponse('GET', '/items/new', '<h2>New</h2><p id="c">form here</p>');
            createProcessedHTML('<a id="o" href="/items/new" ypy-layer="modal">New</a>');
            await opening(() => find('#o').click());
            assert.equal(lastFetch().url, '/items/new');
            assert.equal(dialog().querySelector('#c').textContent, 'form here');
            assert.equal(location.pathname, new URL(savedUrl).pathname);
        });

        it('sends YPY-Layer, and YPY-Request, with the request of the opener', async function () {
            mockResponse('GET', '/items/new', '<p>x</p>');
            createProcessedHTML('<a id="o" href="/items/new" ypy-layer="drawer">New</a>');
            await opening(() => find('#o').click());
            assert.equal(lastFetch().request.headers['YPY-Layer'], 'drawer');
        });

        it('the value of ypy-layer picks the mode; anything else is a modal', async function () {
            mockResponse('GET', '/x', '<p>x</p>');
            createProcessedHTML('<a id="d" href="/x" ypy-layer="drawer">d</a><a id="p" href="/x" ypy-layer="popup">p</a><a id="m" href="/x" ypy-layer>m</a>');
            for (let [id, kind] of [['d', 'drawer'], ['p', 'popup'], ['m', 'modal']]) {
                await opening(() => find('#' + id).click());
                assert.equal(dialog().getAttribute('data-ypy-layer-kind'), kind);
                ypy.layers.closeAll();
            }
        });

        it('a drawer carries its side for the style, end by default', async function () {
            await openLayer('<p>x</p>', {mode: 'drawer'});
            assert.equal(dialog().getAttribute('data-ypy-layer-side'), 'end');
            ypy.layers.closeAll();
            await openLayer('<p>x</p>', {mode: 'drawer', side: 'start'});
            assert.equal(dialog().getAttribute('data-ypy-layer-side'), 'start');
        });

        it('a GET form sends its fields in the query string', async function () {
            mockResponse('GET', '/search', '<p id="r">found</p>');
            createProcessedHTML('<form id="f" action="/search" ypy-layer="drawer"><input name="q" value="ada"><button>Go</button></form>');
            await opening(() => find('#f').requestSubmit());
            assert.equal(lastFetch().url, '/search?q=ada');
            assert.equal(dialog().getAttribute('data-ypy-layer-kind'), 'drawer');
            assert.equal(dialog().querySelector('#r').textContent, 'found');
        });

        it('a POST form sends its body', async function () {
            mockResponse('POST', '/items', '<p id="r">created</p>');
            createProcessedHTML('<form id="f" action="/items" method="post" ypy-layer="modal"><input name="name" value="Ada"><button>Go</button></form>');
            await opening(() => find('#f').requestSubmit());
            assert.equal(lastFetch().request.method, 'POST');
            assert.equal(String(lastFetch().request.body), 'name=Ada');
        });

        it('a form that is not valid does not open a layer', async function () {
            mockResponse('POST', '/items', '<p>x</p>');
            createProcessedHTML('<form id="f" action="/items" method="post" ypy-layer="modal"><input name="name" required><button>Go</button></form>');
            let opened = record('ypy:layer:opened');
            find('#f').requestSubmit();
            await tick(80);
            assert.equal(opened.length, 0);
            assert.equal(dialogs().length, 0);
        });

        it('a button with ypy-get opens the layer from that request', async function () {
            mockResponse('GET', '/menu', '<ul><li>one</li></ul>');
            createProcessedHTML('<button id="b" ypy-get="/menu" ypy-layer="popup">Menu</button>');
            await opening(() => find('#b').click());
            assert.equal(lastFetch().url, '/menu');
            assert.equal(dialog().getAttribute('data-ypy-layer-kind'), 'popup');
        });

        it('ypy-select picks part of the response', async function () {
            mockResponse('GET', '/full', '<header>nav</header><main id="c">content</main>');
            createProcessedHTML('<a id="o" href="/full" ypy-layer ypy-select="#c">x</a>');
            await opening(() => find('#o').click());
            assert.isNull(dialog().querySelector('header'));
            assert.equal(dialog().querySelector('#c').textContent, 'content');
        });

        it('ypy-trigger sets the event that opens it', async function () {
            mockResponse('GET', '/x', '<p>x</p>');
            createProcessedHTML('<a id="o" href="/x" ypy-layer ypy-trigger="mouseenter">x</a>');
            await opening(() => find('#o').dispatchEvent(new MouseEvent('mouseenter')));
            assert.equal(dialogs().length, 1);
        });

        it('a click with a modifier key is left to the browser (a new tab), and opens no layer', async function () {
            mockResponse('GET', '/x', '<p>x</p>');
            // a link that goes nowhere, so a click that the browser keeps cannot leave the test page
            createProcessedHTML('<a id="o" href="javascript:void(0)" ypy-layer>x</a>');
            let click = new MouseEvent('click', {bubbles: true, cancelable: true, ctrlKey: true});
            find('#o').dispatchEvent(click);
            await tick(40);
            assert.isFalse(click.defaultPrevented);
            assert.equal(dialogs().length, 0);
            assert.equal(fetchMock.getCalls().length, 0);
        });

        it('an opener inside ypy-ignore is not wired', async function () {
            mockResponse('GET', '/x', '<p>x</p>');
            createProcessedHTML('<div ypy-ignore><a id="o" href="/x" ypy-layer>x</a></div>');
            clickAndWatch(find('#o'));
            await tick(40);
            assert.equal(dialogs().length, 0);
        });

        it('openers that arrive in a swap work', async function () {
            mockResponse('GET', '/list', '<a id="o" href="/x" ypy-layer="drawer">x</a>');
            mockResponse('GET', '/x', '<p>x</p>');
            createProcessedHTML('<div id="t" ypy-get="/list" ypy-trigger="click">load</div>');
            find('#t').click();
            await forRequest();
            await opening(() => find('#o').click());
            assert.equal(dialog().getAttribute('data-ypy-layer-kind'), 'drawer');
        });

        it('the opener does not also make the core request (a button with ypy-get and ypy-layer asks once)', async function () {
            mockResponse('GET', '/menu', '<p>x</p>');
            createProcessedHTML('<button id="b" ypy-get="/menu" ypy-layer="popup">Menu</button>');
            await opening(() => find('#b').click());
            assert.equal(fetchMock.getCalls().length, 1);
        });

        it('a second click on the opener of a popup closes it', async function () {
            mockResponse('GET', '/menu', '<p>x</p>');
            createProcessedHTML('<button id="b" ypy-get="/menu" ypy-layer="popup">Menu</button>');
            await opening(() => find('#b').click());
            let closed = record('ypy:layer:dismissed');
            find('#b').click();
            await tick();
            assert.equal(closed[0].reason, 'toggle');
            assert.equal(dialogs().length, 0);
        });

        it('a popup marks its opener with a class for anchoring, and takes it away', async function () {
            mockResponse('GET', '/menu', '<p>x</p>');
            createProcessedHTML('<button id="b" ypy-get="/menu" ypy-layer="popup">Menu</button>');
            await opening(() => find('#b').click());
            assert.isTrue(find('#b').classList.contains('ypy-layer-opener'));
            assert.isTrue(dialog().hasAttribute('data-ypy-layer-anchored'));
            ypy.layers.dismiss();
            assert.isFalse(find('#b').classList.contains('ypy-layer-opener'));
        });

        it('ypy-layer-outside="false" and ypy-layer-escape="false" read from the opener', async function () {
            mockResponse('GET', '/x', '<p>x</p>');
            createProcessedHTML('<a id="o" href="/x" ypy-layer ypy-layer-outside="false" ypy-layer-escape="false" ypy-layer-label="Pick" ypy-layer-class="mine">x</a>');
            await opening(() => find('#o').click());
            let layer = ypy.layers.top();
            assert.isFalse(layer.outside);
            assert.isFalse(layer.escape);
            assert.equal(dialog().getAttribute('aria-label'), 'Pick');
            assert.isTrue(dialog().classList.contains('mine'));
        });

        it('data- prefixed attributes work too', async function () {
            mockResponse('GET', '/x', '<p>x</p>');
            createProcessedHTML('<a id="o" href="/x" data-ypy-layer="drawer">x</a>');
            await opening(() => find('#o').click());
            assert.equal(dialog().getAttribute('data-ypy-layer-kind'), 'drawer');
        });
    });

    describe('navigation stays in the layer', function () {

        it('a link in the layer loads into the layer, not into the page', async function () {
            mockResponse('GET', '/next', '<p id="n">next page</p>');
            createProcessedHTML('<div id="page">page</div>');
            await openLayer('<a id="l" href="/next">next</a>');
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(lastFetch().url, '/next');
            assert.equal(dialog().querySelector('#n').textContent, 'next page');
            assert.equal(find('#page').textContent, 'page');
            assert.equal(ypy.layers.stack.length, 1);
        });

        it('a form in the layer submits into the layer', async function () {
            mockResponse('POST', '/save', '<p id="done">saved</p>');
            await openLayer('<form id="f" action="/save" method="post"><input name="a" value="1"><button>Save</button></form>');
            dialog().querySelector('#f').requestSubmit();
            await forRequest();
            assert.equal(String(lastFetch().request.body), 'a=1');
            assert.equal(dialog().querySelector('#done').textContent, 'saved');
        });

        it('a GET form in the layer sends its fields in the query string', async function () {
            mockResponse('GET', '/find', '<p id="r">results</p>');
            await openLayer('<form id="f" action="/find"><input name="q" value="x"><button>Go</button></form>');
            dialog().querySelector('#f').requestSubmit();
            await forRequest();
            assert.equal(lastFetch().url, '/find?q=x');
            assert.isNotNull(dialog().querySelector('#r'));
        });

        it('an invalid form in the layer is not sent', async function () {
            await openLayer('<form id="f" action="/save" method="post"><input name="a" required><button>Save</button></form>');
            dialog().querySelector('#f').requestSubmit();
            await tick(60);
            assert.equal(fetchMock.getCalls().length, 0);
        });

        it('requests from inside the layer carry YPY-Layer', async function () {
            mockResponse('GET', '/next', '<p>n</p>');
            mockResponse('GET', '/inner', 'inner');
            await openLayer('<a id="l" href="/next">next</a><button id="b" ypy-get="/inner" ypy-target="this">b</button>', {mode: 'drawer'});
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(lastFetch().request.headers['YPY-Layer'], 'drawer');
        });

        it('a validation error (422) renders inside the layer and keeps it open', async function () {
            mockResponse('POST', '/save', '<input name="a" aria-invalid="true"><p id="err">fix this</p><button>Save</button>', {status: 422});
            await openLayer('<form id="f" action="/save" method="post"><input name="a"><button>Save</button></form>');
            dialog().querySelector('#f').requestSubmit();
            await forRequest();
            assert.equal(ypy.layers.stack.length, 1);
            assert.equal(dialog().querySelector('#err')?.textContent, 'fix this');
        });

        it('a link with its own request attributes keeps them', async function () {
            mockResponse('GET', '/part', 'part');
            await openLayer('<a id="l" href="/other" ypy-get="/part" ypy-target="#t">x</a><div id="t">old</div>');
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(lastFetch().url, '/part');
            assert.equal(dialog().querySelector('#t').textContent, 'part');
            assert.isNotNull(dialog().querySelector('#l'), 'the link was not replaced');
        });

        it('an ypy-target on a plain link wins over the layer', async function () {
            mockResponse('GET', '/part', 'part');
            await openLayer('<a id="l" href="/part" ypy-target="#t">x</a><div id="t">old</div>');
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(dialog().querySelector('#t').textContent, 'part');
            assert.isNotNull(dialog().querySelector('#l'), 'the link was not replaced');
        });

        it('links the layer must leave alone: target, download, hash, other origin, ypy-boost="false", modifier keys', async function () {
            await openLayer([
                '<a id="blank" href="/x" target="_blank">1</a>',
                '<a id="dl" href="/x" download>2</a>',
                '<a id="hash" href="#top">3</a>',
                '<a id="far" href="https://other.example/x">4</a>',
                '<a id="off" href="/x" ypy-boost="false">5</a>'
            ].join(''));
            for (let id of ['blank', 'dl', 'hash', 'far', 'off']) {
                assert.isFalse(clickAndWatch(dialog().querySelector('#' + id)), id + ' must be left to the browser');
            }
            assert.equal(fetchMock.getCalls().length, 0);
        });

        it('a modified click on a plain link in the layer goes to the browser', async function () {
            await openLayer('<a id="l" href="/x">x</a>');
            let seen;
            let guard = e => { seen = e.defaultPrevented; e.preventDefault() };
            document.addEventListener('click', guard, {once: true});
            dialog().querySelector('#l').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, metaKey: true}));
            assert.isFalse(seen);
        });

        it('a form that targets another window, or posts to another origin, is left alone', async function () {
            await openLayer('<form id="a" action="/x" target="_blank"><button>1</button></form><form id="b" action="https://other.example/x"><button>2</button></form>');
            let sent = [];
            let guard = e => { sent.push(e.defaultPrevented); e.preventDefault() };
            document.addEventListener('submit', guard);
            dialog().querySelector('#a').requestSubmit();
            dialog().querySelector('#b').requestSubmit();
            document.removeEventListener('submit', guard);
            assert.deepEqual(sent, [false, false]);
            assert.equal(fetchMock.getCalls().length, 0);
        });

        it('an error response replaces the content of the layer and the layer stays open', async function () {
            mockResponse('GET', '/boom', '<p id="oops">server error</p>', {status: 500});
            await openLayer('<a id="l" href="/boom">x</a>');
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(ypy.layers.stack.length, 1);
            assert.isNotNull(dialog().querySelector('#oops'));
        });

        it('ypy-status:500="swap:none" on the link leaves the content as it was', async function () {
            mockResponse('GET', '/boom', 'server error', {status: 500});
            await openLayer('<a id="l" href="/boom" ypy-status:500="swap:none">x</a><p id="keep">keep</p>');
            dialog().querySelector('#l').click();
            await forRequest();
            assert.isNotNull(dialog().querySelector('#keep'));
        });
    });

    describe('the server opens layers (YPY-Open-Layer)', function () {

        it('a JSON header with html opens the layer and the response is not swapped', async function () {
            mockResponse('POST', '/do', '<p>swapped</p>', {headers: {'YPY-Open-Layer': '{"html":"<h2>From the server</h2>","mode":"drawer"}'}});
            createProcessedHTML('<button id="b" ypy-post="/do" ypy-target="#out">go</button><div id="out">untouched</div>');
            await opening(() => find('#b').click());
            assert.equal(dialog().getAttribute('data-ypy-layer-kind'), 'drawer');
            assert.equal(dialog().querySelector('h2').textContent, 'From the server');
            assert.equal(find('#out').textContent, 'untouched');
        });

        it('a JSON header with a url fetches it into the layer, with its options', async function () {
            mockResponse('POST', '/do', '', {headers: {'YPY-Open-Layer': '{"url":"/items/new","mode":"modal","closeOn":"saved","label":"New item","escape":false}'}});
            mockResponse('GET', '/items/new', '<p id="c">form</p>');
            createProcessedHTML('<button id="b" ypy-post="/do">go</button>');
            await opening(() => find('#b').click());
            assert.equal(lastFetch().url, '/items/new');
            assert.equal(dialog().querySelector('#c').textContent, 'form');
            assert.equal(dialog().getAttribute('aria-label'), 'New item');
            assert.isFalse(ypy.layers.top().escape);
            ypy.trigger(dialog().querySelector('#c'), 'saved', {});
            await tick();
            assert.equal(dialogs().length, 0);
        });

        it('a header that is not JSON is a URL', async function () {
            mockResponse('POST', '/do', '', {headers: {'YPY-Open-Layer': '/panel'}});
            mockResponse('GET', '/panel', '<p id="c">panel</p>');
            createProcessedHTML('<button id="b" ypy-post="/do">go</button>');
            await opening(() => find('#b').click());
            assert.equal(dialog().querySelector('#c').textContent, 'panel');
        });

        it('opens from a request made inside a layer, on top of it', async function () {
            mockResponse('POST', '/ask', '', {headers: {'YPY-Open-Layer': '{"html":"<p id=\\"sure\\">Sure?</p>"}'}});
            let first = await openLayer('<form id="f" action="/ask" method="post"><button>Delete</button></form>');
            let second;
            let opened = waitForEvent('ypy:layer:opened', 1500);
            first.layer.element.querySelector('#f').requestSubmit();
            assert.isNotNull(await opened);
            assert.equal(ypy.layers.stack.length, 2);
            assert.isNotNull(ypy.layers.top().element.querySelector('#sure'));
            assert.isNotNull(first.layer.element.querySelector('#f'), 'the first layer keeps its content');
        });

        it('only the known keys of the header are used', async function () {
            mockResponse('POST', '/do', '', {headers: {'YPY-Open-Layer': '{"html":"<p>x</p>","source":"body","event":1,"target":"#x","options":{}}'}});
            createProcessedHTML('<button id="b" ypy-post="/do">go</button>');
            await opening(() => find('#b').click());
            assert.equal(ypy.layers.top().options.target, undefined);
            assert.equal(ypy.layers.top().source, find('#b'));
        });

        it('a header that cannot be parsed warns and opens nothing', async function () {
            mockResponse('POST', '/do', 'body', {headers: {'YPY-Open-Layer': '{broken'}});
            createProcessedHTML('<button id="b" ypy-post="/do" ypy-target="#out">go</button><div id="out"></div>');
            let warn = console.warn, warned = 0;
            console.warn = () => warned++;
            try {
                find('#b').click();
                await forRequest();
            } finally { console.warn = warn }
            assert.equal(dialogs().length, 0);
            assert.equal(warned, 1);
        });
    });

    describe('history (optional)', function () {

        it('does nothing to the address bar by default', async function () {
            mockResponse('GET', '/h/page', '<p>x</p>');
            let before = location.pathname;
            await openLayer('/h/page');
            assert.equal(location.pathname, before);
        });

        it('history:true shows the layer URL while it is open, and restores it when it closes', async function () {
            mockResponse('GET', '/h/page', '<p>x</p>');
            let before = location.pathname + location.search;
            let promise = await openLayer('/h/page', {history: true});
            assert.equal(location.pathname, '/h/page');
            assert.equal(history.state.ypyLayer, promise.layer.element.id);
            promise.layer.dismiss();
            await ypy.timeout(150);
            assert.equal(location.pathname + location.search, before);
        });

        it('history:true follows the navigation inside the layer, with no new entry', async function () {
            mockResponse('GET', '/h/one', '<a id="l" href="/h/two">two</a>');
            mockResponse('GET', '/h/two', '<p id="n">two</p>');
            let promise = await openLayer('/h/one', {history: true});
            let length = history.length;
            dialog().querySelector('#l').click();
            await forRequest();
            assert.equal(location.pathname, '/h/two');
            assert.equal(history.length, length);
            promise.layer.dismiss();
            await ypy.timeout(150);
        });

        it('the Back button closes the layer and the page behind it is not reloaded', async function () {
            mockResponse('GET', '/h/page', '<p>x</p>');
            let before = location.pathname + location.search;
            let calls = () => fetchMock.getCalls().length;
            let promise = await openLayer('/h/page', {history: true});
            let n = calls();
            history.back();
            let result = await promise.result;
            assert.deepEqual(result, {accepted: false, reason: 'history'});
            await ypy.timeout(150);
            assert.equal(location.pathname + location.search, before);
            assert.equal(calls(), n, 'no request to restore the page');
        });

        it('ypy-layer-history on the opener turns it on', async function () {
            mockResponse('GET', '/h/page', '<p>x</p>');
            createProcessedHTML('<a id="o" href="/h/page" ypy-layer ypy-layer-history>x</a>');
            await opening(() => find('#o').click());
            assert.equal(location.pathname, '/h/page');
            ypy.layers.closeAll();
            await ypy.timeout(150);
        });

        it('a server header cannot push a URL for a layer that did not ask for history', async function () {
            let before = location.pathname + location.search;
            mockResponse('GET', '/h/page', '<p>x</p>', {headers: {'YPY-Push-Url': '/h/pushed'}});
            await openLayer('/h/page');
            assert.equal(location.pathname + location.search, before);
        });
    });

    describe('style and classes', function () {

        it('adds the classes of the configuration and of the call', async function () {
            ypy.config.layers = {classes: {modal: 'rounded-xl p-6 backdrop:bg-black/50', drawer: 'drawer'}};
            await openLayer('<p>x</p>', {class: 'wide'});
            assert.isTrue(dialog().classList.contains('rounded-xl'));
            assert.isTrue(dialog().classList.contains('backdrop:bg-black/50'));
            assert.isTrue(dialog().classList.contains('wide'));
            assert.isFalse(dialog().classList.contains('drawer'));
        });

        it('never writes a style attribute', async function () {
            await openLayer('<p>x</p>');
            await openLayer('<p>y</p>', {mode: 'drawer'});
            await openLayer('<p>z</p>', {mode: 'popup'});
            assert.isEmpty(dialogs().filter(d => d.hasAttribute('style')));
            assert.isFalse(document.documentElement.hasAttribute('style'));
        });

        it('the default style has no specificity and is built with variables', async function () {
            await openLayer('<p>x</p>');
            let rules = [...document.adoptedStyleSheets].flatMap(s => [...s.cssRules]).map(r => r.cssText).join('\n');
            assert.include(rules, '--ypy-layer-bg');
            assert.include(rules, '--ypy-layer-backdrop');
            assert.include(rules, '--ypy-layer-radius');
            assert.include(rules, ':where(dialog[data-ypy-layer-kind');
        });

        it('a page that sets a variable gets it', async function () {
            document.documentElement.style.setProperty('--ypy-layer-padding', '37px');
            try {
                await openLayer('<p>x</p>');
                assert.equal(getComputedStyle(dialog()).paddingTop, '37px');
            } finally { document.documentElement.style.removeProperty('--ypy-layer-padding') }
        });

        it('a page class beats the default style', async function () {
            let sheet = new CSSStyleSheet();
            sheet.replaceSync('.fat{padding:55px}');
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            try {
                await openLayer('<p>x</p>', {class: 'fat'});
                assert.equal(getComputedStyle(dialog()).paddingTop, '55px');
            } finally { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== sheet) }
        });
    });
});
