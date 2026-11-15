// SPDX-License-Identifier: MIT
// Locks the caches and shortcuts of the core (TASK-035): attribute records, trigger specs,
// the ypy-ignore scope of process(), the same-origin shortcut, CSS transitions and filters.
describe('core performance caches', function () {

    beforeEach(function () {
        setupTest(this);
    });

    afterEach(function () {
        cleanupTest();
        ypy.config.prefix = 'data-ypy-';
        ypy.config.metaCharacter = null;
        ypy.config.implicitInheritance = false;
    });

    describe('attribute records', function () {

        it('sees an attribute that changes after the first read', function () {
            let btn = createDisconnectedHTML('<button ypy-get="/a"></button>');
            assert.equal(ypy.__attributeValue(btn, 'ypy-get'), '/a');
            btn.setAttribute('ypy-get', '/b');
            assert.equal(ypy.__attributeValue(btn, 'ypy-get'), '/b');
            btn.removeAttribute('ypy-get');
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-get'));
            btn.setAttribute('ypy-get', '/c');
            assert.equal(ypy.__attributeValue(btn, 'ypy-get'), '/c');
        });

        it('sees an inherited attribute that is added, changed and removed on an ancestor', function () {
            let root = createDisconnectedHTML('<div><p><button></button></p></div>');
            let btn = root.querySelector('button');
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-target'));
            root.setAttribute('ypy-target:inherited', '#a');
            assert.equal(ypy.__attributeValue(btn, 'ypy-target'), '#a');
            root.setAttribute('ypy-target:inherited', '#b');
            assert.equal(ypy.__attributeValue(btn, 'ypy-target'), '#b');
            root.removeAttribute('ypy-target:inherited');
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-target'));
        });

        it('does not inherit from an ancestor the element was removed from', function () {
            let root = createDisconnectedHTML('<div ypy-target:inherited="#a"><button></button></div>');
            let btn = root.querySelector('button');
            assert.equal(ypy.__attributeValue(btn, 'ypy-target'), '#a');
            btn.remove();
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-target'));
            let other = createDisconnectedHTML('<div ypy-target:inherited="#z"></div>');
            other.append(btn);
            assert.equal(ypy.__attributeValue(btn, 'ypy-target'), '#z');
        });

        it('follows config.prefix when it changes after a first read', function () {
            let btn = createDisconnectedHTML('<button foo-get="/foo"></button>');
            ypy.config.prefix = '';
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-get'));
            ypy.config.prefix = 'foo-';
            assert.equal(ypy.__attributeValue(btn, 'ypy-get'), '/foo');
            assert.equal(ypy.__attr(btn, 'ypy-get'), '/foo');
            ypy.config.prefix = '';
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-get'));
        });

        it('follows config.prefix for the inheritance selectors', function () {
            let root = createDisconnectedHTML('<div foo-target:inherited="#a"><button></button></div>');
            let btn = root.querySelector('button');
            ypy.config.prefix = 'data-ypy-';
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-target'));
            ypy.config.prefix = 'foo-';
            assert.equal(ypy.__attributeValue(btn, 'ypy-target'), '#a');
        });

        it('follows config.metaCharacter when it changes after a first read', function () {
            let root = createDisconnectedHTML('<div ypy-target-inherited="#a" ypy-vals-inherited=\'"a":1\'><button ypy-vals-append=\'"b":2\'></button></div>');
            let btn = root.querySelector('button');
            ypy.config.metaCharacter = null;
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-target'));
            ypy.config.metaCharacter = '-';
            assert.equal(ypy.__attributeValue(btn, 'ypy-target'), '#a');
            assert.equal(ypy.__attributeValue(btn, 'ypy-vals'), '"a":1,"b":2');
            ypy.config.metaCharacter = null;
            assert.isUndefined(ypy.__attributeValue(btn, 'ypy-target'));
        });

        it('keeps extension hooks working for repeated events', function () {
            let backup = backupExtensions();
            try {
                let seen = [];
                ypy.registerExtension('perf-hook', {ypy_perf_hook: (elt, detail) => { seen.push(detail.n) }});
                let div = createProcessedHTML('<div></div>');
                ypy.__trigger(div, 'ypy:perf:hook', {n: 1});
                ypy.__trigger(div, 'ypy:perf:hook', {n: 2});
                ypy.__triggerNative(div, 'ypy:perf:hook', {n: 3});
                assert.deepEqual(seen, [1, 2, 3]);
            } finally {
                restoreExtensions(backup);
            }
        });
    });

    describe('trigger spec cache', function () {

        it('returns a fresh spec every time', function () {
            let a = ypy.__parseTriggerSpecs('click delay:300ms');
            a[0].listeners = ['x'];
            a[0].timeout = 5;
            a[0].extra = true;
            a.push({name: 'other'});
            let b = ypy.__parseTriggerSpecs('click delay:300ms');
            assert.notStrictEqual(a[0], b[0]);
            assert.deepEqual(b, [{name: 'click', delay: '300ms'}]);
        });

        it('does not share nested values between callers', function () {
            let a = ypy.__parseTriggerSpecs('click opts:{"deep":{"n":1}}');
            a[0].opts.deep.n = 2;
            let b = ypy.__parseTriggerSpecs('click opts:{"deep":{"n":1}}');
            assert.equal(b[0].opts.deep.n, 1);
        });

        it('does not cache a parse that throws', function () {
            assert.throws(() => ypy.__parseTriggerSpecs('click[ctrlKey'));
            assert.throws(() => ypy.__parseTriggerSpecs('click[ctrlKey'));
        });

        it('wires two elements with the same trigger without sharing state', function () {
            createProcessedHTML('<div><button id="a" ypy-get="/x" ypy-trigger="click delay:50ms"></button>' +
                '<button id="b" ypy-get="/x" ypy-trigger="click delay:50ms"></button></div>');
            let a = find('#a')._ypy, b = find('#b')._ypy;
            assert.notStrictEqual(a.triggerSpecs[0], b.triggerSpecs[0]);
            assert.notStrictEqual(a.triggerSpecs[0].listeners, b.triggerSpecs[0].listeners);
            assert.notStrictEqual(a.triggerSpecs[0].handler, b.triggerSpecs[0].handler);
            assert.equal(a.listeners.length, 1);
            assert.equal(b.listeners.length, 1);
        });

        it('serves a changed ypy-trigger after a forced process', function () {
            let btn = createProcessedHTML('<button ypy-get="/x" ypy-trigger="click">go</button>');
            assert.equal(btn._ypy.triggerSpecs[0].name, 'click');
            btn.setAttribute('ypy-trigger', 'dblclick');
            ypy.process(btn, true);
            assert.equal(btn._ypy.triggerSpecs[0].name, 'dblclick');
        });
    });

    describe('ypy-ignore scope of process()', function () {

        it('skips an ignored subtree inside the root', function () {
            createProcessedHTML('<div><button id="in" ypy-get="/a"></button>' +
                '<section ypy-ignore><button id="out" ypy-get="/b"></button></section></div>');
            assert.isTrue(find('#in').hasAttribute('data-ypy-powered'));
            assert.isFalse(find('#out').hasAttribute('data-ypy-powered'));
        });

        it('skips a root that sits inside an ignored ancestor', function () {
            let outer = createDisconnectedHTML('<div ypy-ignore><div id="r"><button id="b" ypy-get="/a"></button></div></div>');
            playground().append(outer);
            ypy.process(outer.querySelector('#r'));
            assert.isFalse(outer.querySelector('#b').hasAttribute('data-ypy-powered'));
        });

        it('honors ypy-ignore added by a ypy:before:process listener', function () {
            let pg = playground();
            let listener = evt => { evt.target.querySelector('section')?.setAttribute('ypy-ignore', '') };
            pg.addEventListener('ypy:before:process', listener, {once: true});
            pg.innerHTML = '<div id="r"><section><button id="b" ypy-get="/a"></button></section></div>';
            ypy.process(pg);
            pg.removeEventListener('ypy:before:process', listener);
            assert.isFalse(find('#b').hasAttribute('data-ypy-powered'));
        });

        it('does not leak the scope into a later process call', function () {
            let root = createProcessedHTML('<div id="r"><button id="first" ypy-get="/a"></button></div>');
            assert.isTrue(find('#first').hasAttribute('data-ypy-powered'));
            root.insertAdjacentHTML('beforeend', '<section ypy-ignore><button id="second" ypy-get="/b"></button></section>');
            ypy.process(root);
            assert.isFalse(find('#second').hasAttribute('data-ypy-powered'));
        });

        it('restores the scope after a nested process call', function () {
            let pg = playground();
            pg.innerHTML = '<div id="a"><button id="a1" ypy-get="/a"></button></div>' +
                '<div id="b"><section ypy-ignore><button id="b1" ypy-get="/b"></button></section><button id="b2" ypy-get="/c"></button></div>';
            let listener = evt => {
                if (evt.target.id === 'a') ypy.process(find('#b'));
            };
            pg.addEventListener('ypy:after:process', listener);
            ypy.process(find('#a'));
            pg.removeEventListener('ypy:after:process', listener);
            assert.isFalse(find('#b1').hasAttribute('data-ypy-powered'));
            assert.isTrue(find('#b2').hasAttribute('data-ypy-powered'));
        });

        it('keeps ignoring ypy-on under ypy-ignore', function () {
            createProcessedHTML('<div><button id="ok" ypy-on:click="this.setAttribute(\'x\',\'1\')"></button>' +
                '<div ypy-ignore><button id="no" ypy-on:click="this.setAttribute(\'x\',\'1\')"></button></div></div>');
            find('#ok').click();
            find('#no').click();
            assert.equal(find('#ok').getAttribute('x'), '1');
            assert.isNull(find('#no').getAttribute('x'));
        });

        it('honors every attribute spelling of ypy-ignore', function () {
            createProcessedHTML('<div><i ypy-ignore><b id="a" ypy-get="/a"></b></i>' +
                '<i data-ypy-ignore><b id="b" ypy-get="/b"></b></i><i data-ypy-ignore><b id="c" ypy-get="/c"></b></i></div>');
            for (let id of ['a', 'b', 'c']) assert.isFalse(find('#' + id).hasAttribute('data-ypy-powered'), id);
        });
    });

    describe('same-origin check', function () {

        it('accepts what shares the origin', function () {
            let origin = location.origin;
            assert.isTrue(ypy.__isSameOrigin('/x'));
            assert.isTrue(ypy.__isSameOrigin('x/y'));
            assert.isTrue(ypy.__isSameOrigin('?q=1'));
            assert.isTrue(ypy.__isSameOrigin(origin + '/x'));
            assert.isTrue(ypy.__isSameOrigin(origin));
        });

        it('refuses what leaves the origin', function () {
            let origin = location.origin;
            assert.isFalse(ypy.__isSameOrigin('//evil.example/x'));
            assert.isFalse(ypy.__isSameOrigin('https://evil.example/x'));
            assert.isFalse(ypy.__isSameOrigin(origin + '.evil.example/x'));
            assert.isFalse(ypy.__isSameOrigin(origin + '0/x'));
            assert.isFalse(ypy.__isSameOrigin(origin.replace('//', '//user@evil.example/') + '/x'));
            assert.isFalse(ypy.__isSameOrigin(origin.replace('//', '//evil.example#@') + '/x'));
            assert.isFalse(ypy.__isSameOrigin('javascript:alert(1)'));
            assert.isFalse(ypy.__isSameOrigin('data:text/html,x'));
        });
    });

    describe('CSS transitions', function () {

        it('has nothing to restore when the fragment has no ids', function () {
            let root = createDisconnectedHTML('<div><p id="a" class="x"></p></div>');
            let fragment = document.createRange().createContextualFragment('<p class="y"></p>');
            assert.deepEqual(ypy.__startCSSTransitions(fragment, root), []);
        });

        it('keeps the old css attributes until the restore task runs', function () {
            let root = createDisconnectedHTML('<div><p id="a" class="old" style="color:red"></p></div>');
            let fragment = document.createRange().createContextualFragment('<p id="a" class="new" title="t"></p><p id="b" class="b"></p>');
            let tasks = ypy.__startCSSTransitions(fragment, root);
            assert.equal(tasks.length, 1);
            let p = fragment.querySelector('#a');
            assert.equal(p.getAttribute('class'), 'old');
            assert.equal(p.getAttribute('style'), 'color:red');
            tasks[0]();
            assert.equal(p.getAttribute('class'), 'new');
        });

        it('ignores an element with the same id and another tag', function () {
            let root = createDisconnectedHTML('<div><p id="a" class="old"></p></div>');
            let fragment = document.createRange().createContextualFragment('<span id="a" class="new"></span>');
            assert.deepEqual(ypy.__startCSSTransitions(fragment, root), []);
        });
    });

    describe('trigger filters', function () {

        function click(elt, init) {
            elt.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, ...init}));
        }

        it('evaluates the filter on every event with the event properties', async function () {
            mockResponse('GET', '/f', 'ok');
            let btn = createProcessedHTML('<button ypy-get="/f" ypy-trigger="click[ctrlKey]">go</button>');
            let count = 0;
            btn.addEventListener('ypy:before:request', () => { count++ });
            click(btn, {ctrlKey: false});
            await forRequest();
            assert.equal(count, 0);
            click(btn, {ctrlKey: true});
            await forRequest();
            assert.equal(count, 1);
            click(btn, {ctrlKey: false});
            await forRequest();
            assert.equal(count, 1);
        });

        it('compiles the filter once for many events', function () {
            let backup = backupExtensions(), api;
            ypy.registerExtension('perf-count', {init(a) { api = a }});
            let AsyncFunction = (async () => {}).constructor, built = 0;
            api.initSecurity(null, function (...args) { built++; return new Function(...args) }, AsyncFunction);
            try {
                let btn = createProcessedHTML('<button ypy-get="/f" ypy-trigger="click[shiftKey && target === this]">go</button>');
                for (let i = 0; i < 5; i++) click(btn, {shiftKey: false});
                assert.equal(built, 1);
            } finally {
                api.initSecurity(null, Function, AsyncFunction);
                restoreExtensions(backup);
            }
        });

        it('still reads the element and the API from a filter', async function () {
            mockResponse('GET', '/f', 'ok');
            let btn = createProcessedHTML('<button class="on" ypy-get="/f" ypy-trigger="click[this.classList.contains(\'on\') && find(\'body\') === document.body]">go</button>');
            let fired = 0;
            btn.addEventListener('ypy:before:request', () => { fired++ });
            click(btn);
            await forRequest();
            assert.equal(fired, 1);
        });
    });

    describe('author JavaScript', function () {

        let run = (obj, code, ...rest) => ypy.__executeJavaScript(document.createElement('div'), obj, code, true, false, ...rest);

        it('reads new values on every call of the same code', function () {
            assert.equal(run({value: 1}, 'value + 1'), 2);
            assert.equal(run({value: 10}, 'value + 1'), 11);
            assert.equal(run({value: 'a', other: 5}, 'value + 1'), 'a1');
        });

        it('keeps the API in scope by name', function () {
            assert.equal(run({}, 'typeof find + typeof trigger + typeof parseInterval'), 'functionfunctionfunction');
            assert.equal(run({}, 'parseInterval("2s")'), 2000);
        });

        it('keeps every name in scope when the code uses eval', function () {
            assert.equal(run({value: 7}, 'eval("value + typeof find")'), '7function');
        });

        it('keeps every name in scope when an identifier is escaped', function () {
            assert.equal(run({value: 7}, 'v\\u0061lue + 1'), 8);
        });

        it('lets an event property shadow an API method, as before', function () {
            assert.equal(run({find: 'x'}, 'find'), 'x');
        });

        it('compiles through a replaced constructor', function () {
            let backup = backupExtensions(), api;
            ypy.registerExtension('perf-swap', {init(a) { api = a }});
            let AsyncFunction = (async () => {}).constructor, built = 0;
            run({}, '40 + 2');
            api.initSecurity(null, function (...args) { built++; return new Function(...args) }, AsyncFunction);
            try {
                assert.equal(run({}, '40 + 2'), 42);
                assert.equal(run({}, '40 + 2'), 42);
                assert.equal(built, 1);
            } finally {
                api.initSecurity(null, Function, AsyncFunction);
                restoreExtensions(backup);
            }
        });

        it('lets extensions add scope names and rewrite the code on every call', function () {
            let backup = backupExtensions();
            let n = 0;
            ypy.registerExtension('perf-scope', {ypy_scope: (_, detail) => { detail.scope.extra = ++n; detail.code = detail.code.replace('EXTRA', 'extra') }});
            try {
                assert.equal(run({}, 'EXTRA'), 1);
                assert.equal(run({}, 'EXTRA'), 2);
            } finally {
                restoreExtensions(backup);
            }
        });

        it('returns a reusable function that keeps its values when compile is true', function () {
            let f = run({value: 3}, 'value * 2', true);
            run({value: 100}, 'value * 2');
            assert.equal(f(), 6);
            assert.equal(f(), 6);
        });
    });
});
