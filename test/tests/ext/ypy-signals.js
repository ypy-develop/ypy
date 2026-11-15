// SPDX-License-Identifier: MIT
describe('ypy-signals extension', function () {

    let extBackup;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-signals.js';
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
        cleanupTest();
        try { localStorage.clear(); sessionStorage.clear() } catch {}
    });

    // effects run in a microtask batch: two ticks cover a computed behind an effect
    const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() };
    const text = selector => find(selector).textContent;
    const fire = (elt, type) => elt.dispatchEvent(new Event(type, {bubbles: true}));
    const quiet = async fn => {
        let e = console.error, w = console.warn;
        console.error = console.warn = () => {};
        try { return await fn() } finally { console.error = e; console.warn = w }
    };

    describe('declaration and one-way attributes', function () {

        it('declares signals as an object without braces, with single quotes', async function () {
            createProcessedHTML(`<div ypy-signals="count:0, name:'Ana'"><b id="a" ypy-text="$name"></b><i id="b" ypy-text="$count + 1"></i></div>`);
            text('#a').should.equal('Ana');
            text('#b').should.equal('1');
        });

        it('declares signals as JSON, with nested values', async function () {
            createProcessedHTML(`<div ypy-signals='{"user":{"name":"Zé","tags":["a","b"]}}'><b id="a" ypy-text="$user.name + $user.tags[1]"></b></div>`);
            text('#a').should.equal('Zéb');
        });

        it('also takes the data- prefix', async function () {
            createProcessedHTML(`<div data-ypy-signals="n:2"><b id="a" data-ypy-text="$n * 3"></b></div>`);
            text('#a').should.equal('6');
        });

        it('ypy-show hides with display and shows again', async function () {
            createProcessedHTML(`<div ypy-signals="on:false"><b id="a" ypy-show="$on">x</b></div>`);
            find('#a').style.display.should.equal('none');
            ypy.signals.patch({on: true}, find('#a'));
            await tick();
            find('#a').style.display.should.equal('');
        });

        it('ypy-class toggles one class, or takes an object', async function () {
            createProcessedHTML(`<div ypy-signals="a:true,b:false"><b id="x" ypy-class:on="$a" ypy-class="{red: $b, blue: !$b}"></b></div>`);
            find('#x').className.should.equal('on blue');
            ypy.signals.patch({a: false, b: true}, find('#x'));
            await tick();
            find('#x').className.should.equal('red');
        });

        it('ypy-attr sets, and removes on false or null', async function () {
            createProcessedHTML(`<div ypy-signals="t:'hi', d:true"><b id="x" ypy-attr:title="$t" ypy-attr:hidden="$d" ypy-attr="{'data-k': $t}"></b></div>`);
            find('#x').getAttribute('title').should.equal('hi');
            find('#x').getAttribute('hidden').should.equal('');
            find('#x').getAttribute('data-k').should.equal('hi');
            ypy.signals.patch({t: null, d: false}, find('#x'));
            await tick();
            assert.isNull(find('#x').getAttribute('title'));
            assert.isNull(find('#x').getAttribute('hidden'));
        });

        it('ypy-text writes text, never markup', async function () {
            createProcessedHTML(`<div ypy-signals="h:'<img src=x onerror=alert(1)>'"><b id="x" ypy-text="$h"></b></div>`);
            text('#x').should.equal('<img src=x onerror=alert(1)>');
            assert.notExists(find('#x img'));
        });

        it('an object value is shown as JSON', async function () {
            createProcessedHTML(`<div ypy-signals="o:{a:1}"><b id="x" ypy-text="$o"></b></div>`);
            text('#x').should.equal('{"a":1}');
        });

        it('a signal that does not exist reads as undefined and shows up when declared later', async function () {
            createProcessedHTML(`<div ypy-signals="a:1"><b id="x" ypy-text="$later ?? 'none'"></b></div>`);
            text('#x').should.equal('none');
            ypy.signals.patch({later: 'here'}, find('#x'));
            await tick();
            text('#x').should.equal('here');
        });

        it('scopes nest: the nearest scope that has the name answers', async function () {
            createProcessedHTML(`<div ypy-signals="n:'outer', o:'only outer'"><div ypy-signals="n:'inner'"><b id="x" ypy-text="$n + '/' + $o"></b></div></div>`);
            text('#x').should.equal('inner/only outer');
        });

        it('a bad expression is reported and the rest keeps working', async function () {
            let errors = [];
            let h = e => errors.push(e.detail.error.message);
            document.addEventListener('ypy:signals:error', h);
            try {
                await quiet(async () => {
                    createProcessedHTML(`<div ypy-signals="a:1"><b id="bad" ypy-text="(("></b><b id="ok" ypy-text="$a"></b></div>`);
                });
            } finally { document.removeEventListener('ypy:signals:error', h) }
            errors.length.should.equal(1);
            text('#ok').should.equal('1');
        });
    });

    describe('computed and batching', function () {

        it('a computed follows its dependencies, also through another computed', async function () {
            createProcessedHTML(`<div ypy-signals="p:2,q:3" ypy-computed:total="$p * $q" ypy-computed:double-total="$total * 2"><b id="x" ypy-text="$total + ':' + $doubleTotal"></b></div>`);
            text('#x').should.equal('6:12');
            ypy.signals.patch({p: 10}, find('#x'));
            await tick();
            text('#x').should.equal('30:60');
        });

        it('a computed is read-only and is not sent to the server', async function () {
            mockResponse('POST', '/c', 'ok');
            createProcessedHTML(`<div ypy-signals="p:2" ypy-computed:t="$p * 2"><button ypy-signals-send ypy-post="/c" ypy-on:click="$t = 5">go</button></div>`);
            find('button').click();
            await forRequest();
            JSON.parse(lastFetch().request.body.get('ypy-signals')).should.deep.equal({p: 2});
        });

        it('several writes in one handler run an effect once', async function () {
            let runs = 0;
            ypy.signals.register('probe', v => { runs++; return v });
            createProcessedHTML(`<div ypy-signals="a:1,b:1,c:1"><b id="x" ypy-text="probe($a + $b + $c)"></b><button ypy-on:click="$a = 2; $b = 2; $c = 2">go</button></div>`);
            runs.should.equal(1);
            find('button').click();
            await tick();
            runs.should.equal(2);
            text('#x').should.equal('6');
        });

        it('an effect only re-runs for the signals it read', async function () {
            let runs = 0;
            ypy.signals.register('probe2', v => { runs++; return v });
            createProcessedHTML(`<div ypy-signals="a:1,b:1"><b id="x" ypy-text="probe2($a)"></b></div>`);
            ypy.signals.patch({b: 5}, find('#x'));
            await tick();
            runs.should.equal(1);
            ypy.signals.patch({a: 5}, find('#x'));
            await tick();
            runs.should.equal(2);
        });

        it('effects that keep waking each other stop instead of hanging the page', async function () {
            let errors = 0, original = console.error;
            console.error = () => errors++;
            try {
                ypy.signals.register('pingB', () => { ypy.signals.patch({b: Math.random()}, find('#x')); return 1 });
                ypy.signals.register('pingA', () => { ypy.signals.patch({a: Math.random()}, find('#x')); return 1 });
                createProcessedHTML(`<div ypy-signals="a:0,b:0"><i id="x" ypy-text="$a + pingB()"></i><u ypy-text="$b + pingA()"></u></div>`);
                await tick();
                await new Promise(r => setTimeout(r, 20));
                errors.should.be.above(0);
            } finally { console.error = original }
        });
    });

    describe('registered functions', function () {

        it('calls a registered function with evaluated arguments', async function () {
            ypy.signals.register('upper', s => String(s).toUpperCase());
            createProcessedHTML(`<div ypy-signals="n:'ana'"><b id="x" ypy-text="upper($n) + upper('!')"></b></div>`);
            text('#x').should.equal('ANA!');
        });

        it('a function registered after the page was parsed is found when it runs', async function () {
            createProcessedHTML(`<div ypy-signals="n:1"><button ypy-on:click="late($n)"></button></div>`);
            let got;
            ypy.signals.register('late', v => { got = v });
            find('button').click();
            got.should.equal(1);
        });

        it('refuses a name that is not a plain identifier', async function () {
            assert.throws(() => ypy.signals.register('a.b', () => 1));
            assert.throws(() => ypy.signals.register('$a', () => 1));
            assert.throws(() => ypy.signals.register('ok', 5));
        });
    });

    describe('ypy-bind', function () {

        it('text input: the signal fills the field, change writes back (the default cadence)', async function () {
            createProcessedHTML(`<div ypy-signals="name:'a'"><input id="i" ypy-bind="name"><b id="x" ypy-text="$name"></b></div>`);
            find('#i').value.should.equal('a');
            find('#i').value = 'bb';
            fire(find('#i'), 'input');
            await tick();
            text('#x').should.equal('a');       // typed, not committed yet
            fire(find('#i'), 'change');
            await tick();
            text('#x').should.equal('bb');
        });

        it('ypy-bind:name takes the name from the attribute', async function () {
            createProcessedHTML(`<div ypy-signals="userName:'a'"><input id="i" ypy-bind:user-name><b id="x" ypy-text="$userName"></b></div>`);
            find('#i').value.should.equal('a');
        });

        it('.live writes on every input', async function () {
            createProcessedHTML(`<div ypy-signals="name:''"><input id="i" ypy-bind.live="name"><b id="x" ypy-text="$name"></b></div>`);
            find('#i').value = 'k';
            fire(find('#i'), 'input');
            await tick();
            text('#x').should.equal('k');
        });

        it('.blur writes on blur, not on change', async function () {
            createProcessedHTML(`<div ypy-signals="name:''"><input id="i" ypy-bind.blur="name"><b id="x" ypy-text="$name"></b></div>`);
            find('#i').value = 'k';
            fire(find('#i'), 'input');
            fire(find('#i'), 'change');
            await tick();
            text('#x').should.equal('');
            find('#i').dispatchEvent(new Event('blur'));
            await tick();
            text('#x').should.equal('k');
        });

        it('.debounce waits for the pause, and a change commits at once', async function () {
            createProcessedHTML(`<div ypy-signals="name:''"><input id="i" ypy-bind.debounce.40ms="name"><b id="x" ypy-text="$name"></b></div>`);
            let i = find('#i');
            i.value = 'a'; fire(i, 'input');
            await new Promise(r => setTimeout(r, 15));
            i.value = 'ab'; fire(i, 'input');
            await new Promise(r => setTimeout(r, 25));
            text('#x').should.equal('');                // the second input restarted the wait
            await new Promise(r => setTimeout(r, 40));
            text('#x').should.equal('ab');
            i.value = 'abc'; fire(i, 'input'); fire(i, 'change');
            await tick();
            text('#x').should.equal('abc');
        });

        it('.throttle writes at most once per interval, with the last value', async function () {
            createProcessedHTML(`<div ypy-signals="name:''"><input id="i" ypy-bind.throttle.40ms="name"><b id="x" ypy-text="$name"></b></div>`);
            let i = find('#i');
            i.value = 'a'; fire(i, 'input');
            i.value = 'ab'; fire(i, 'input');
            i.value = 'abc'; fire(i, 'input');
            await tick();
            text('#x').should.equal('');
            await new Promise(r => setTimeout(r, 70));
            text('#x').should.equal('abc');
        });

        it('a pending value is committed before a request, so the server sees what the user typed', async function () {
            mockResponse('POST', '/s', 'ok');
            createProcessedHTML(`<div ypy-signals="name:''"><input id="i" ypy-bind.debounce.5s="name"><button ypy-signals-send ypy-post="/s">go</button></div>`);
            find('#i').value = 'typed';
            fire(find('#i'), 'input');
            find('button').click();
            await forRequest();
            JSON.parse(lastFetch().request.body.get('ypy-signals')).name.should.equal('typed');
            ypy.signals.stats().pending.should.equal(0);
        });

        it('checkbox is a boolean', async function () {
            createProcessedHTML(`<div ypy-signals="on:true"><input id="c" type="checkbox" ypy-bind="on"><b id="x" ypy-text="$on"></b></div>`);
            find('#c').checked.should.equal(true);
            find('#c').checked = false;
            fire(find('#c'), 'change');
            await tick();
            text('#x').should.equal('false');
        });

        it('radio group holds the value of the checked one', async function () {
            createProcessedHTML(`<div ypy-signals="size:'m'"><input type="radio" name="s" value="s" ypy-bind="size"><input type="radio" name="s" value="m" ypy-bind="size"><input type="radio" name="s" value="l" ypy-bind="size"><b id="x" ypy-text="$size"></b></div>`);
            let radios = [...playground().querySelectorAll('input')];
            radios.map(r => r.checked).should.deep.equal([false, true, false]);
            radios[2].checked = true;
            fire(radios[2], 'change');
            await tick();
            text('#x').should.equal('l');
            radios.map(r => r.checked).should.deep.equal([false, false, true]);
        });

        it('select and textarea', async function () {
            createProcessedHTML(`<div ypy-signals="c:'b', t:'hello'"><select id="s" ypy-bind="c"><option value="a">a</option><option value="b">b</option></select><textarea id="t" ypy-bind="t"></textarea></div>`);
            find('#s').value.should.equal('b');
            find('#t').value.should.equal('hello');
            find('#s').value = 'a';
            fire(find('#s'), 'change');
            find('#t').value = 'bye';
            fire(find('#t'), 'change');
            await tick();
            ypy.signals.get('c', find('#s')).should.equal('a');
            ypy.signals.get('t', find('#s')).should.equal('bye');
        });

        it('select multiple is an array', async function () {
            createProcessedHTML(`<div ypy-signals="m:['b']"><select id="s" multiple ypy-bind="m"><option value="a">a</option><option value="b">b</option><option value="c">c</option></select></div>`);
            [...find('#s').selectedOptions].map(o => o.value).should.deep.equal(['b']);
            find('#s').options[2].selected = true;
            fire(find('#s'), 'change');
            ypy.signals.get('m', find('#s')).should.deep.equal(['b', 'c']);
        });

        it('a number signal stays a number', async function () {
            createProcessedHTML(`<div ypy-signals="n:2"><input id="i" type="number" ypy-bind.live="n"><b id="x" ypy-text="$n + 1"></b></div>`);
            find('#i').value = '41';
            fire(find('#i'), 'input');
            await tick();
            text('#x').should.equal('42');
        });

        it('clearing a number field does not write "0" back into it', async function () {
            createProcessedHTML(`<div ypy-signals="n:2"><input id="i" type="number" ypy-bind.live="n"></div>`);
            find('#i').value = '';
            fire(find('#i'), 'input');
            await tick();
            find('#i').value.should.equal('');
        });

        it('contenteditable works through textContent', async function () {
            createProcessedHTML(`<div ypy-signals="s:'one'"><p id="p" contenteditable ypy-bind.live="s"></p><b id="x" ypy-text="$s"></b></div>`);
            text('#p').should.equal('one');
            find('#p').textContent = 'two';
            fire(find('#p'), 'input');
            await tick();
            text('#x').should.equal('two');
        });

        it('binds a path inside an object signal', async function () {
            createProcessedHTML(`<div ypy-signals="u:{name:'a', age:3}"><input id="i" ypy-bind.live="u.name"><b id="x" ypy-text="$u.name + $u.age"></b></div>`);
            find('#i').value = 'bo';
            fire(find('#i'), 'input');
            await tick();
            text('#x').should.equal('bo3');
        });

        it('a signal nobody declared is created by the binding, in the outermost scope', async function () {
            createProcessedHTML(`<div ypy-signals="a:1"><div ypy-signals="b:2"><input id="i" ypy-bind.live="made"></div></div>`);
            find('#i').value = 'v';
            fire(find('#i'), 'input');
            await tick();
            ypy.signals.get('made', find('#i')).should.equal('v');
            ypy.signals.get('made', playground().firstElementChild).should.equal('v');   // the outer scope, not the inner one sees it
        });
    });

    describe('ypy-on', function () {

        it('runs statements, assignments and ++ on signals', async function () {
            createProcessedHTML(`<div ypy-signals="n:1,s:'a'"><button ypy-on:click="$n++; $n += 10; $s = $s + 'b'">go</button><b id="x" ypy-text="$n + $s"></b></div>`);
            find('button').click();
            await tick();
            text('#x').should.equal('12ab');
        });

        it('has $event with a few safe fields', async function () {
            createProcessedHTML(`<div ypy-signals="k:'', t:''"><input id="i" ypy-on:keydown="$k = $event.key; $t = $event.type"></div>`);
            find('#i').dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
            await tick();
            ypy.signals.get('k', find('#i')).should.equal('Enter');
            ypy.signals.get('t', find('#i')).should.equal('keydown');
        });

        it('.once runs the handler one time', async function () {
            createProcessedHTML(`<div ypy-signals="n:0"><button ypy-on:click.once="$n++">go</button></div>`);
            find('button').click();
            find('button').click();
            ypy.signals.get('n', find('button')).should.equal(1);
        });

        it('.prevent and .stop', async function () {
            createProcessedHTML(`<div ypy-signals="n:0"><a id="a" href="#x" ypy-on:click.prevent.stop="$n++">go</a></div>`);
            let outer = 0;
            playground().addEventListener('click', () => outer++);
            let evt = new MouseEvent('click', {bubbles: true, cancelable: true});
            find('#a').dispatchEvent(evt);
            evt.defaultPrevented.should.equal(true);
            outer.should.equal(0);
        });

        it('.debounce and .throttle pace the handler', async function () {
            createProcessedHTML(`<div ypy-signals="d:0,t:0"><button id="d" ypy-on:click.debounce.30ms="$d++">d</button><button id="t" ypy-on:click.throttle.50ms="$t++">t</button></div>`);
            for (let i = 0; i < 3; i++) { find('#d').click(); find('#t').click() }
            ypy.signals.get('t', find('#d')).should.equal(1);
            ypy.signals.get('d', find('#d')).should.equal(0);
            await new Promise(r => setTimeout(r, 70));
            ypy.signals.get('d', find('#d')).should.equal(1);
            find('#t').click();
            ypy.signals.get('t', find('#d')).should.equal(2);
        });

        it('.window listens on the window and goes away with the element', async function () {
            createProcessedHTML(`<div ypy-signals="n:0"><i id="e" ypy-on:resize.window="$n++"></i></div>`);
            let scope = find('#e').parentElement;
            window.dispatchEvent(new Event('resize'));
            ypy.signals.get('n', scope).should.equal(1);
            ypy.process(playground(), true);       // tear down and wire again: still one listener
            window.dispatchEvent(new Event('resize'));
            ypy.signals.get('n', scope).should.equal(2);
            ypy.__cleanup?.(playground());
            playground().innerHTML = '';
            window.dispatchEvent(new Event('resize'));
        });

        it('the handler runs before the request of the same element, so the request sees the new value', async function () {
            mockResponse('POST', '/s', 'ok');
            createProcessedHTML(`<div ypy-signals="status:'draft'"><button ypy-signals-send ypy-post="/s" ypy-on:click="$status = 'sent'">go</button></div>`);
            find('button').click();
            await forRequest();
            JSON.parse(lastFetch().request.body.get('ypy-signals')).status.should.equal('sent');
        });

        it('inside a scope ypy-on is not JavaScript: nothing is compiled', async function () {
            let was = ypy.config.callbacks;
            ypy.config.callbacks = 'all';
            window.__signalsProbe = 0;
            try {
                createProcessedHTML(`<div ypy-signals="n:0"><button ypy-on:click="window.__signalsProbe = 1">go</button></div>`);
                await quiet(async () => { find('button').click() });
                window.__signalsProbe.should.equal(0);
            } finally { ypy.config.callbacks = was; delete window.__signalsProbe }
        });

        it('outside a scope the core ypy-on is left alone', async function () {
            let was = ypy.config.callbacks;
            ypy.config.callbacks = 'all';
            window.__signalsProbe = 0;
            try {
                createProcessedHTML(`<button ypy-on:click="window.__signalsProbe = 1">go</button>`);
                find('button').click();
                await tick();
                window.__signalsProbe.should.equal(1);
            } finally { ypy.config.callbacks = was; delete window.__signalsProbe }
        });
    });

    describe('sending signals', function () {

        const sent = () => JSON.parse(lastFetch().request.body.get('ypy-signals'));
        const query = () => new URL(lastFetch().url, location.href).searchParams.get('ypy-signals');

        it('POST carries the signals in the form field ypy-signals; the form fields stay', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<form ypy-signals-send ypy-signals="a:1,b:'x'" ypy-post="/p"><input name="f" value="v"><button>go</button></form>`);
            find('button').click();
            await forRequest();
            sent().should.deep.equal({a: 1, b: 'x'});
            lastFetch().request.body.get('f').should.equal('v');
        });

        it('GET carries them in the query parameter ypy-signals', async function () {
            mockResponse('GET', '/g', 'ok');
            createProcessedHTML(`<div ypy-signals="a:1,q:'x'"><button ypy-signals-send ypy-get="/g">go</button></div>`);
            find('button').click();
            await forRequest();
            JSON.parse(query()).should.deep.equal({a: 1, q: 'x'});
            lastFetch().url.startsWith('/g?ypy-signals=').should.equal(true);
        });

        it('DELETE is sent like GET', async function () {
            mockResponse('DELETE', '/d', 'ok');
            createProcessedHTML(`<div ypy-signals="a:1"><button ypy-signals-send ypy-delete="/d">go</button></div>`);
            find('button').click();
            await forRequest();
            JSON.parse(query()).should.deep.equal({a: 1});
        });

        it('non-ASCII text travels URL-encoded and reads back the same', async function () {
            mockResponse('GET', '/g', 'ok');
            createProcessedHTML(`<div ypy-signals="n:'José 日本 😀'"><button ypy-signals-send ypy-get="/g">go</button></div>`);
            find('button').click();
            await forRequest();
            JSON.parse(query()).n.should.equal('José 日本 😀');
        });

        it('signals that start with _ are local: never sent, at any depth', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<div ypy-signals="a:1,_open:true,o:{k:1,_hidden:2}"><button ypy-signals-send ypy-post="/p">go</button></div>`);
            find('button').click();
            await forRequest();
            sent().should.deep.equal({a: 1, o: {k: 1}});
        });

        it('sends the signals of every scope around the element, the inner one winning', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<div ypy-signals="a:'outer',b:1"><div ypy-signals="a:'inner',c:2"><button ypy-signals-send ypy-post="/p">go</button></div></div>`);
            find('button').click();
            await forRequest();
            sent().should.deep.equal({a: 'inner', b: 1, c: 2});
        });

        it('an element outside every scope speaks for the top-level scopes', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<div><div ypy-signals="a:1"><div ypy-signals="inner:1"></div></div><button ypy-signals-send ypy-post="/p">go</button></div>`);
            find('button').click();
            await forRequest();
            sent().should.deep.equal({a: 1});
        });

        it('a page without signals sends nothing extra', async function () {
            mockResponse('POST', '/p', 'ok');
            mockResponse('GET', '/g', 'ok');
            createProcessedHTML(`<button id="p" ypy-post="/p">go</button><button id="g" ypy-get="/g">go</button>`);
            find('#p').click();
            await forRequest();
            assert.isNull(lastFetch().request.body.get('ypy-signals'));
            find('#g').click();
            await forRequest();
            assert.isNull(query());
        });

        it('is not sent to another origin', async function () {
            mockResponse('POST', 'other.test', 'ok');
            mockResponse('GET', 'other.test', 'ok');
            createProcessedHTML(`<div ypy-signals="secret:1"><button id="p" ypy-post="http://other.test/p">go</button><button id="g" ypy-get="http://other.test/g">go</button></div>`);
            find('#p').click();
            await forRequest();
            assert.isNull(lastFetch().request.body.get('ypy-signals'));
            find('#g').click();
            await forRequest();
            assert.isNull(query());
        });

        it('sends nothing by default, even inside a scope with signals', async function () {
            mockResponse('POST', '/p', 'ok');
            mockResponse('GET', '/g', 'ok');
            createProcessedHTML(`<div ypy-signals="a:1"><button id="p" ypy-post="/p">p</button><button id="g" ypy-get="/g">g</button></div>`);
            find('#p').click();
            await forRequest();
            assert.isNull(lastFetch().request.body.get('ypy-signals'));
            find('#g').click();
            await forRequest();
            assert.isNull(query());
        });

        it('ypy-signals-send on the element asks for them; a bare ancestor attribute does not reach the children', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<div ypy-signals="a:1" ypy-signals-send><button id="own" ypy-signals-send ypy-post="/p">p</button><button id="child" ypy-post="/p">c</button></div>`);
            find('#own').click();
            await forRequest();
            sent().should.deep.equal({a: 1});
            find('#child').click();
            await forRequest();
            assert.isNull(lastFetch().request.body.get('ypy-signals'));
        });

        it('ypy-signals-send:inherited on a container covers what is inside it, and the nearest value wins', async function () {
            mockResponse('POST', '/p', 'ok');
            mockResponse('GET', '/g', 'ok');
            createProcessedHTML(`<div ypy-signals="a:1" ypy-signals-send:inherited="true"><button id="p" ypy-post="/p">p</button><div ypy-signals-send:inherited="false"><button id="g" ypy-get="/g">g</button></div></div>`);
            find('#p').click();
            await forRequest();
            sent().should.deep.equal({a: 1});
            find('#g').click();
            await forRequest();
            assert.isNull(query());
        });

        it('ypy-signals-send="false" on the element keeps them out even when the page asks for them', async function () {
            mockResponse('POST', '/p', 'ok');
            mockResponse('POST', '/q', 'ok');
            ypy.config.signals = {send: true};
            try {
                createProcessedHTML(`<div ypy-signals="a:1"><button id="p" ypy-post="/p" ypy-signals-send="false">p</button><button id="q" ypy-post="/q">q</button></div>`);
                find('#p').click();
                await forRequest();
                assert.isNull(lastFetch().request.body.get('ypy-signals'));
                find('#q').click();
                await forRequest();
                sent().should.deep.equal({a: 1});
            } finally { delete ypy.config.signals }
        });

        it('signals.send in the config sends them on every same-origin request, and false is the default', async function () {
            mockResponse('POST', '/p', 'ok');
            mockResponse('POST', 'other.test', 'ok');
            ypy.config.signals = {send: false};
            try {
                createProcessedHTML(`<div ypy-signals="a:1"><button id="p" ypy-post="/p">p</button><button id="o" ypy-post="http://other.test/p">o</button></div>`);
                find('#p').click();
                await forRequest();
                assert.isNull(lastFetch().request.body.get('ypy-signals'));
                ypy.config.signals.send = true;
                find('#p').click();
                await forRequest();
                sent().should.deep.equal({a: 1});
                find('#o').click();
                await forRequest();
                assert.isNull(lastFetch().request.body.get('ypy-signals'));
            } finally { delete ypy.config.signals }
        });

        it('a POST of the same size goes out', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<div ypy-signals="big:'${'x'.repeat(8000)}'"><button ypy-signals-send ypy-post="/p">go</button></div>`);
            find('button').click();
            await forRequest();
            sent().big.length.should.equal(8000);
        });

        it('multipart bodies carry the field too', async function () {
            mockResponse('POST', '/m', 'ok');
            createProcessedHTML(`<form ypy-signals-send ypy-signals="a:1" ypy-post="/m" enctype="multipart/form-data"><button>go</button></form>`);
            find('button').click();
            await forRequest();
            JSON.parse(lastFetch().request.body.get('ypy-signals')).should.deep.equal({a: 1});
        });
    });

    describe('updating from the server', function () {

        const json = (body, status = 200) => ({status, headers: {'Content-Type': 'application/json'}});

        it('a JSON response is a merge patch and is not swapped', async function () {
            mockResponse('POST', '/p', '{"count":5,"user":{"name":"Bo"}}', json());
            createProcessedHTML(`<div ypy-signals="count:0, user:{name:'a', age:3}"><button id="b" ypy-post="/p" ypy-target="#out">go</button><i id="out">keep</i><b id="x" ypy-text="$count + ':' + $user.name + $user.age"></b></div>`);
            find('#b').click();
            await forRequest();
            await tick();
            text('#x').should.equal('5:Bo3');
            text('#out').should.equal('keep');
        });

        it('null removes a member, an array replaces, and a new signal is created', async function () {
            mockResponse('POST', '/p', '{"user":{"age":null},"list":[3],"fresh":"yes"}', json());
            createProcessedHTML(`<div ypy-signals="user:{name:'a', age:3}, list:[1,2]"><button ypy-post="/p">go</button><b id="x" ypy-text="JSON_({u: $user, l: $list, f: $fresh})"></b></div>`);
            ypy.signals.register('JSON_', v => JSON.stringify(v));
            ypy.process(playground(), true);
            find('button').click();
            await forRequest();
            await tick();
            JSON.parse(text('#x')).should.deep.equal({u: {name: 'a'}, l: [3], f: 'yes'});
        });

        it('null on a top-level key removes the signal', async function () {
            mockResponse('POST', '/p', '{"gone":null}', json());
            createProcessedHTML(`<div ypy-signals="gone:1,keep:2"><button ypy-post="/p">go</button><b id="x" ypy-text="($gone ?? 'none') + $keep"></b></div>`);
            find('button').click();
            await forRequest();
            await tick();
            text('#x').should.equal('none2');
        });

        it('the patch goes to the scope that has the key', async function () {
            mockResponse('POST', '/p', '{"a":"changed"}', json());
            createProcessedHTML(`<div id="o" ypy-signals="a:'outer'"><div id="i" ypy-signals="a:'inner'"><button ypy-post="/p">go</button></div></div>`);
            find('button').click();
            await forRequest();
            ypy.signals.get('a', find('#i')).should.equal('changed');
            ypy.signals.get('a', find('#o')).should.equal('outer');
        });

        it('a patch listener may cancel it, and sees the patch', async function () {
            mockResponse('POST', '/p', '{"a":2}', json());
            createProcessedHTML(`<div ypy-signals="a:1"><button ypy-post="/p">go</button></div>`);
            let seen;
            document.addEventListener('ypy:signals:patch', e => { seen = e.detail.patch; e.preventDefault() }, {once: true});
            find('button').click();
            await forRequest();
            seen.should.deep.equal({a: 2});
            ypy.signals.get('a', find('button')).should.equal(1);
        });

        it('JSON that is not an object, or is not JSON, is an error and changes nothing', async function () {
            mockResponse('POST', '/arr', '[1]', json());
            mockResponse('POST', '/bad', '{nope', json());
            createProcessedHTML(`<div ypy-signals="a:1"><button id="x" ypy-post="/arr">go</button><button id="y" ypy-post="/bad">go</button></div>`);
            let errors = 0;
            let h = () => errors++;
            document.addEventListener('ypy:signals:error', h);
            try {
                await quiet(async () => {
                    find('#x').click(); await forRequest();
                    find('#y').click(); await forRequest();
                });
            } finally { document.removeEventListener('ypy:signals:error', h) }
            errors.should.equal(2);
            ypy.signals.get('a', find('#x')).should.equal(1);
        });

        it('onlyIfMissing skips the signals that exist', async function () {
            createProcessedHTML(`<div ypy-signals="a:1"><i id="e"></i></div>`);
            ypy.signals.patch({a: 2, b: 3}, find('#e'), true);
            ypy.signals.get('a', find('#e')).should.equal(1);
            ypy.signals.get('b', find('#e')).should.equal(3);
        });

        it('a patch is not allowed to reach the prototype chain', async function () {
            mockResponse('POST', '/p', '{"__proto__":{"polluted":1},"constructor":{"x":1},"o":{"__proto__":{"polluted":2}}}', json());
            createProcessedHTML(`<div ypy-signals="o:{}"><button ypy-post="/p">go</button></div>`);
            find('button').click();
            await forRequest();
            assert.isUndefined({}.polluted);
            assert.isUndefined(ypy.signals.get('o.polluted', find('button')));
        });

        it('an HTML response is swapped as usual', async function () {
            mockResponse('POST', '/p', '<b>new</b>');
            createProcessedHTML(`<div ypy-signals="a:1"><button ypy-post="/p" ypy-target="#out">go</button><i id="out">old</i></div>`);
            find('button').click();
            await forRequest();
            text('#out').should.equal('new');
        });

        it('the JSON patch also works for a GET and for an error status', async function () {
            mockResponse('GET', '/g', '{"a":"from get"}', json());
            mockResponse('POST', '/e', '{"err":"bad email"}', json(null, 422));
            createProcessedHTML(`<div ypy-signals="a:1"><button id="g" ypy-get="/g">g</button><button id="e" ypy-post="/e">e</button></div>`);
            find('#g').click();
            await forRequest();
            find('#e').click();
            await forRequest();
            ypy.signals.get('a', find('#g')).should.equal('from get');
            ypy.signals.get('err', find('#g')).should.equal('bad email');
        });
    });

    describe('server-owned (read-only) signals', function () {

        it('are readable, and the client cannot write them from an expression', async function () {
            createProcessedHTML(`<div ypy-signals.server="plan:'free'"><button ypy-on:click="$plan = 'pro'">go</button><b id="x" ypy-text="$plan"></b></div>`);
            let warned = [];
            let h = e => warned.push(e.detail.name);
            document.addEventListener('ypy:signals:readonly', h);
            try { await quiet(async () => find('button').click()) } finally { document.removeEventListener('ypy:signals:readonly', h) }
            await tick();
            text('#x').should.equal('free');
            warned.should.deep.equal(['plan']);
        });

        it('a binding cannot change them, and the field is put back', async function () {
            createProcessedHTML(`<div ypy-signals.server="plan:'free'"><input id="i" ypy-bind.live="plan"></div>`);
            find('#i').value = 'pro';
            await quiet(async () => { fire(find('#i'), 'input'); await tick() });
            ypy.signals.get('plan', find('#i')).should.equal('free');
            find('#i').value.should.equal('free');
        });

        it('are sent back like the others, so the server can check its signature', async function () {
            mockResponse('POST', '/p', 'ok');
            createProcessedHTML(`<div ypy-signals.server="plan:'free', planSig:'abc'" ypy-signals="note:''"><button ypy-signals-send ypy-post="/p">go</button></div>`);
            find('button').click();
            await forRequest();
            JSON.parse(lastFetch().request.body.get('ypy-signals')).should.deep.equal({plan: 'free', planSig: 'abc', note: ''});
        });

        it('only the server changes them: a patch does, and so does a new rendering of the markup', async function () {
            mockResponse('POST', '/p', '{"plan":"pro"}', {status: 200, headers: {'Content-Type': 'application/json'}});
            createProcessedHTML(`<div id="s" ypy-signals.server="plan:'free'" ypy-signals="note:'mine'"><button ypy-post="/p">go</button></div>`);
            find('button').click();
            await forRequest();
            ypy.signals.get('plan', find('#s')).should.equal('pro');
            // the server renders the scope again: its keys are overwritten, the client's are not
            find('#s').setAttribute('ypy-signals.server', "plan:'enterprise'");
            ypy.process(playground(), true);
            await tick();
            ypy.signals.get('plan', find('#s')).should.equal('enterprise');
            ypy.signals.get('note', find('#s')).should.equal('mine');
        });
    });

    describe('unsaved state (ypy-dirty)', function () {

        it('the scope is dirty while a client-owned signal differs from the saved one', async function () {
            createProcessedHTML(`<form id="f" ypy-signals="name:'a'" ypy-post="/save"><input id="i" ypy-bind.live="name"><b id="d" ypy-show="$_dirty">unsaved</b></form>`);
            let f = find('#f');
            f.classList.contains('ypy-dirty').should.equal(false);
            find('#d').style.display.should.equal('none');
            find('#i').value = 'b';
            fire(find('#i'), 'input');
            await tick();
            f.classList.contains('ypy-dirty').should.equal(true);
            f.dataset.ypyState.should.equal('dirty');
            find('#d').style.display.should.equal('');
            find('#i').value = 'a';
            fire(find('#i'), 'input');
            await tick();
            f.classList.contains('ypy-dirty').should.equal(false);
            assert.isUndefined(f.dataset.ypyState);
        });

        it('a successful POST makes the current values the saved ones', async function () {
            mockResponse('POST', '/save', 'saved');
            createProcessedHTML(`<form id="f" ypy-signals="name:'a'" ypy-post="/save" ypy-target="#out"><input id="i" ypy-bind.live="name"><button>save</button></form><i id="out"></i>`);
            find('#i').value = 'b';
            fire(find('#i'), 'input');
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(true);
            find('button').click();
            await forRequest();
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(false);
            find('#i').value = 'c';
            fire(find('#i'), 'input');
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(true);
        });

        it('a GET or an error response does not mark it saved', async function () {
            mockResponse('GET', '/search', 'r');
            mockResponse('POST', '/fail', 'no', {status: 500});
            createProcessedHTML(`<div id="f" ypy-signals="name:'a'"><input id="i" ypy-bind.live="name"><button id="g" ypy-get="/search" ypy-target="#out">g</button><button id="p" ypy-post="/fail" ypy-target="#out">p</button><i id="out"></i></div>`);
            find('#i').value = 'b';
            fire(find('#i'), 'input');
            await tick();
            find('#g').click();
            await forRequest();
            find('#p').click();
            await forRequest();
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(true);
        });

        it('values the server patches count as saved', async function () {
            createProcessedHTML(`<div id="f" ypy-signals="name:'a', n:1"><input id="i" ypy-bind.live="name"></div>`);
            find('#i').value = 'b';
            fire(find('#i'), 'input');
            ypy.signals.patch({n: 2}, find('#f'));
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(true);
            ypy.signals.patch({name: 'b'}, find('#f'));
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(false);
        });

        it('a local signal never makes it dirty', async function () {
            createProcessedHTML(`<div id="f" ypy-signals="_open:false"><button ypy-on:click="$_open = true">o</button></div>`);
            find('button').click();
            await tick();
            find('#f').classList.contains('ypy-dirty').should.equal(false);
        });

        it('uses the class from config.classes.dirty', async function () {
            ypy.config.classes.dirty = 'is-unsaved';
            try {
                createProcessedHTML(`<div id="f" ypy-signals="a:1"><button ypy-on:click="$a = 2">o</button></div>`);
                find('button').click();
                await tick();
                find('#f').classList.contains('is-unsaved').should.equal(true);
            } finally { delete ypy.config.classes.dirty }
        });
    });

    describe('persistence', function () {

        it('.local keeps the values in localStorage and restores them', async function () {
            createProcessedHTML(`<div id="form" ypy-signals.local="draft:'start', _theme:'light'"><input id="i" ypy-bind.live="draft"></div>`);
            find('#i').value = 'half-typed';
            fire(find('#i'), 'input');
            await tick();
            JSON.parse(localStorage.getItem('ypy-signals:form')).should.deep.equal({draft: 'half-typed', _theme: 'light'});
            // a new page: the same markup, the stored value wins over the default
            playground().innerHTML = '';
            createProcessedHTML(`<div id="form" ypy-signals.local="draft:'start', _theme:'light'"><input id="i" ypy-bind.live="draft"></div>`);
            find('#i').value.should.equal('half-typed');
        });

        it('.session uses sessionStorage', async function () {
            createProcessedHTML(`<div id="s1" ypy-signals.session="n:1"><button ypy-on:click="$n++">+</button></div>`);
            find('button').click();
            await tick();
            JSON.parse(sessionStorage.getItem('ypy-signals:s1')).n.should.equal(2);
            assert.isNull(localStorage.getItem('ypy-signals:s1'));
        });

        it('a restored draft is unsaved', async function () {
            localStorage.setItem('ypy-signals:form', '{"draft":"old draft"}');
            createProcessedHTML(`<div id="form" ypy-signals.local="draft:''"></div>`);
            await tick();
            find('#form').classList.contains('ypy-dirty').should.equal(true);
        });

        it('stored keys that the markup does not declare are ignored', async function () {
            localStorage.setItem('ypy-signals:form', '{"draft":"ok","evil":"x","__proto__":{"p":1}}');
            createProcessedHTML(`<div id="form" ypy-signals.local="draft:''"><b id="x" ypy-text="($evil ?? '-') + $draft"></b></div>`);
            text('#x').should.equal('-ok');
        });

        it('broken stored data falls back to the declared values', async function () {
            localStorage.setItem('ypy-signals:form', '{not json');
            createProcessedHTML(`<div id="form" ypy-signals.local="draft:'fine'"><b id="x" ypy-text="$draft"></b></div>`);
            text('#x').should.equal('fine');
        });

        it('server-owned signals are never persisted', async function () {
            createProcessedHTML(`<div id="form" ypy-signals.server.local="plan:'free'"></div>`);
            await tick();
            assert.isNull(localStorage.getItem('ypy-signals:form'));
        });

        it('without an id it warns and keeps the values in memory only', async function () {
            let warned = 0, w = console.warn;
            console.warn = () => warned++;
            try { createProcessedHTML(`<div ypy-signals.local="a:1"><b id="x" ypy-text="$a"></b></div>`) } finally { console.warn = w }
            warned.should.equal(1);
            text('#x').should.equal('1');
        });
    });

    describe('swaps and morphs', function () {

        it('the scope and its values survive a morph of the content inside it', async function () {
            mockResponse('GET', '/list', '<b id="x" ypy-text="$n"></b><i>new</i>');
            createProcessedHTML(`<div ypy-signals="n:7"><div id="box"><b id="x" ypy-text="$n"></b></div><button ypy-get="/list" ypy-target="#box" ypy-swap="innerMorph">go</button></div>`);
            text('#x').should.equal('7');
            ypy.signals.patch({n: 8}, find('#x'));
            find('button').click();
            await forRequest();
            await tick();
            text('#x').should.equal('8');
            find('#box i').textContent.should.equal('new');
            ypy.signals.patch({n: 9}, find('#x'));
            await tick();
            text('#x').should.equal('9');       // the binding of the new content is live
        });

        it('bindings of swapped-in content are wired and the old ones are gone', async function () {
            mockResponse('GET', '/f', '<input id="i2" ypy-bind.live="name"><u ypy-text="$name"></u>');
            createProcessedHTML(`<div ypy-signals="name:'x'"><div id="box"><input id="i1" ypy-bind.live="name"></div><button ypy-get="/f" ypy-target="#box" ypy-swap="innerHTML">go</button></div>`);
            let nodes = ypy.signals.stats().nodes;
            find('button').click();
            await forRequest();
            await tick();
            find('#i2').value.should.equal('x');
            find('#i2').value = 'typed';
            fire(find('#i2'), 'input');
            await tick();
            text('u').should.equal('typed');
            ypy.signals.stats().nodes.should.be.at.most(nodes + 1);
        });

        it('morph that rewrites a bound text puts the signal value back', async function () {
            mockResponse('GET', '/t', '<span id="x" ypy-text="$n">server text</span>');
            createProcessedHTML(`<div ypy-signals="n:'live'"><div id="box"><span id="x" ypy-text="$n"></span></div><button ypy-get="/t" ypy-target="#box" ypy-swap="innerMorph">go</button></div>`);
            find('button').click();
            await forRequest();
            await tick();
            text('#x').should.equal('live');
        });

        it('a morph that keeps the scope element keeps the state, even when it restyles it', async function () {
            mockResponse('GET', '/s', '<div id="scope" class="new-class" ypy-signals="n:0"><b id="x" ypy-text="$n"></b></div>');
            createProcessedHTML(`<section id="wrap"><div id="scope" ypy-signals="n:0"><b id="x" ypy-text="$n"></b></div></section><button ypy-get="/s" ypy-target="#wrap" ypy-swap="innerMorph">go</button>`);
            ypy.signals.patch({n: 5}, find('#x'));
            await tick();
            let scope = find('#scope');
            find('button').click();
            await forRequest();
            await tick();
            find('#scope').should.equal(scope);
            scope.className.should.equal('new-class');
            text('#x').should.equal('5');
        });

        it('replacing the scope element starts again from the declared values', async function () {
            mockResponse('GET', '/s', '<div id="scope2" ypy-signals="n:0"><b id="x" ypy-text="$n"></b></div>');
            createProcessedHTML(`<section id="wrap"><div id="scope1" ypy-signals="n:0"><b id="x" ypy-text="$n"></b></div></section><button ypy-get="/s" ypy-target="#wrap" ypy-swap="innerHTML">go</button>`);
            ypy.signals.patch({n: 5}, find('#x'));
            await tick();
            find('button').click();
            await forRequest();
            await tick();
            text('#x').should.equal('0');
        });

        it('ypy-ignore keeps the attributes inert', async function () {
            createProcessedHTML(`<div ypy-signals="n:1"><div ypy-ignore><b id="x" ypy-text="$n">untouched</b></div></div>`);
            text('#x').should.equal('untouched');
        });

        it('wiring twice does not stack effects or listeners', async function () {
            createProcessedHTML(`<div ypy-signals="n:0"><button ypy-on:click="$n++">+</button><b id="x" ypy-text="$n"></b></div>`);
            let nodes = ypy.signals.stats().nodes;
            for (let i = 0; i < 5; i++) ypy.process(playground());
            ypy.signals.stats().nodes.should.equal(nodes);
            find('button').click();
            await tick();
            text('#x').should.equal('1');
        });
    });

    describe('public API', function () {

        it('get reads a path from where an element stands; patch writes like the server', async function () {
            createProcessedHTML(`<div ypy-signals="u:{a:{b:1}}"><i id="e"></i></div>`);
            ypy.signals.get('u.a.b', find('#e')).should.equal(1);
            ypy.signals.get('$u.a.b', find('#e')).should.equal(1);
            assert.isUndefined(ypy.signals.get('u.zz.b', find('#e')));
            ypy.signals.patch({u: {a: {c: 2}}}, find('#e'));
            ypy.signals.get('u.a.b', find('#e')).should.equal(1);
            ypy.signals.get('u.a.c', find('#e')).should.equal(2);
        });

        it('with no element it looks at the top-level scopes of the page', async function () {
            createProcessedHTML(`<div ypy-signals="g:5"></div>`);
            ypy.signals.get('g').should.equal(5);
        });
    });
});
