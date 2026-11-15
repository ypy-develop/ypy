// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// The extension on a page that forbids eval and new Function: filters, ypy-on and `js:` values run
// without compiling anything. Each test opens a fresh page, because the evaluator is per page.
describe('ypy-expr extension under a CSP without unsafe-eval', function () {

    const N = 'page-nonce';
    const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'nonce-${N}'; style-src 'self'">`;
    const ALL = `<meta name="ypy-config" content='callbacks:"all"'>`;
    const NONE = `<meta name="ypy-config" content='callbacks:"none"'>`;
    const WITH = ['/src/ypy.js', '/src/ext/ypy-expr.js'];
    let page;
    afterEach(function () { page?.close(); page = null });

    const q = selector => page.doc.querySelector(selector);
    const tick = (ms = 20) => new Promise(resolve => page.win.setTimeout(resolve, ms));
    async function open(body, {config = ALL, scripts = WITH} = {}) {
        page = await openPage({head: CSP + config, body, nonce: N, scripts});
        return page;
    }
    // Runs a piece of author code the way a page does, in a ypy-on handler, and gives back its value
    // as JSON; an error of the code is thrown here. Only the public surface is used, so it also runs on dist/.
    async function run(code, vars = {}, statements = false) {
        let elt = page.doc.createElement('div'), error;
        elt.setAttribute('ypy-on:go', statements ? code : `this.dataset.out = JSON.stringify(${code})`);
        page.doc.body.append(elt);
        page.win.ypy.process(elt);
        let listener = event => { error ??= event.detail.error };
        page.doc.addEventListener('ypy:error', listener);
        elt.dispatchEvent(new page.win.CustomEvent('go', {detail: vars}));
        await tick(5);
        page.doc.removeEventListener('ypy:error', listener);
        elt.remove();
        if (error) throw error;
        let out = elt.dataset.out;
        return out === undefined || out === 'undefined' ? undefined : JSON.parse(out);
    }
    const stmts = (code, vars) => run(code, vars, true);
    async function fails(code, pattern, vars) {
        try { await run(code, vars) } catch (e) { assert.match(String(e.message ?? e), pattern); return }
        assert.fail('did not throw: ' + code);
    }
    const fire = (elt, name, props = {}) => {
        let evt = new page.win.CustomEvent(name, {bubbles: true});
        Object.assign(evt, props);
        elt.dispatchEvent(evt);
    };

    it('the page really forbids eval and new Function', async function () {
        await open('');
        assert.throws(() => page.win.eval('1'));
        assert.throws(() => new page.win.Function('return 1'));
    });

    it('without the extension a filter cannot compile under this CSP', async function () {
        await open('<div id="d" ypy-get="/x" ypy-trigger="evt[ok]"></div>', {scripts: ['/src/ypy.js']});
        let errors = [];
        page.win.addEventListener('error', e => errors.push(e.message));
        page.win.ypy.process(page.doc.body);
        let evt = new page.win.CustomEvent('evt');
        evt.ok = true;
        try { q('#d').dispatchEvent(evt) } catch (e) { errors.push(String(e)) }
        await tick();
        assert.isAbove(errors.concat(page.logs).filter(m => /eval|unsafe|EvalError|Content Security/i.test(m)).length, 0);
    });

    describe('trigger filters', function () {
        it('a property of the event decides', async function () {
            await open('<div id="d" ypy-get="/x" ypy-trigger="evt[ok]"></div>');
            let calls = 0;
            q('#d').addEventListener('ypy:before:request', () => { calls++; return false });
            fire(q('#d'), 'evt', {ok: false});
            fire(q('#d'), 'evt', {ok: true});
            calls.should.equal(1);
        });

        it('click[a[0]]: nested brackets', async function () {
            await open(`<div id="d" ypy-get="/x" ypy-trigger="evt[foo[0]]"></div>`);
            let calls = 0;
            q('#d').addEventListener('ypy:before:request', () => { calls++; return false });
            fire(q('#d'), 'evt', {foo: [false]});
            fire(q('#d'), 'evt', {foo: [true]});
            calls.should.equal(1);
        });

        it("keyup[key=='[']: a bracket inside a string", async function () {
            let field = `<input ypy-get="/x" ypy-trigger="keyup[key=='[' || key == ']']">`;
            await open(field + field + field);
            let calls = 0;
            // a cancelled request leaves the element busy, so each key goes to its own field
            page.doc.querySelectorAll('input').forEach(input => input.addEventListener('ypy:before:request', () => { calls++; return false }));
            ['a', '[', ']'].forEach((key, n) => fire(page.doc.querySelectorAll('input')[n], 'keyup', {key}));
            calls.should.equal(2);
        });

        it('compares, negates, calls a method and reads the target', async function () {
            await open(`<div id="d" class="go" ypy-get="/x" ypy-trigger="evt[!target.classList.contains('stop') && target.id === 'd' && (n > 1 ? true : false)]"></div>`);
            let calls = 0;
            q('#d').addEventListener('ypy:before:request', () => { calls++; return false });
            fire(q('#d'), 'evt', {n: 1});
            fire(q('#d'), 'evt', {n: 2});
            q('#d').classList.add('stop');
            fire(q('#d'), 'evt', {n: 2});
            calls.should.equal(1);
        });

        it('every 20ms [cond]: the condition after the interval', async function () {
            await open(`<div id="d" ypy-get="/x" ypy-trigger="every 20ms [this.dataset.go]"></div>`);
            let calls = 0;
            q('#d').addEventListener('ypy:before:request', () => { calls++; return false });
            await tick(80);
            calls.should.equal(0);
            q('#d').dataset.go = 'true';
            await tick(80);
            assert.isAbove(calls, 0);
        });
    });

    describe('ypy-on and js: values', function () {
        it('ypy-on:click runs statements with this, assignment and a method call', async function () {
            await open(`<button id="b" ypy-on:click="this.dataset.n = 1 + 2; this.classList.add('on'); this.textContent += '!'">go</button>`);
            q('#b').click();
            await tick();
            q('#b').dataset.n.should.equal('3');
            assert.isTrue(q('#b').classList.contains('on'));
            q('#b').textContent.should.equal('go!');
            assert.deepEqual(page.logs.filter(l => /error/.test(l)), []);
        });

        it('ypy-on reads the detail of the event through with', async function () {
            await open(`<div id="d" ypy-on:greet="this.dataset.who = name + '?'"></div>`);
            fire(q('#d'), 'greet', {});
            let evt = new page.win.CustomEvent('greet', {detail: {name: 'Ana'}});
            q('#d').dispatchEvent(evt);
            await tick();
            q('#d').dataset.who.should.equal('Ana?');
        });

        it('ypy-on: if, let and ++', async function () {
            await open(`<div id="d" ypy-on:go="let k = 1; k++; if (k == 2) this.dataset.k = k; else this.dataset.k = 'no'"></div>`);
            fire(q('#d'), 'go');
            await tick();
            q('#d').dataset.k.should.equal('2');
        });

        it('a js: value is an object literal', async function () {
            await open(`<button id="d" ypy-get="/x" ypy-vals="js:a: 1 + 1, b: this.id, c: [1, 'x'].length">go</button>`);
            let urls = [];
            page.win.fetch = async url => { urls.push(String(url)); return new page.win.Response('', {status: 204}) };
            q('#d').click();
            await tick(60);
            assert.lengthOf(urls, 1);
            assert.include(urls[0], 'a=2');
            assert.include(urls[0], 'b=d');
            assert.include(urls[0], 'c=2');
        });

        it('a js: confirm runs through it too', async function () {
            await open(`<button id="b" ypy-get="/x" ypy-confirm="js:1 > 2">go</button>`);
            let requests = 0;
            q('#b').addEventListener('ypy:before:request', () => { requests++ });
            q('#b').click();
            await tick();
            requests.should.equal(0);
        });
    });

    describe('the language', function () {
        beforeEach(async function () { await open('') });

        it('arithmetic, precedence and strings', async function () {
            (await run('1 + 2 * 3 - 4 / 2 % 3')).should.equal(5);
            (await run('2 ** 3 ** 2')).should.equal(64);
            (await run("'a' + 'b' + 1")).should.equal('ab1');
            (await run('(1 + 2) * 3')).should.equal(9);
            (await run('-a + +b', {a: 1, b: '2'})).should.equal(1);
        });

        it('logic, nullish and the ternary short-circuit', async function () {
            (await run('a && b', {a: 0, b: 1})).should.equal(0);
            (await run('a || b', {a: 0, b: 1})).should.equal(1);
            (await run('a ?? b', {a: null, b: 2})).should.equal(2);
            (await run('a ?? b', {a: 0, b: 2})).should.equal(0);
            (await run('a ? b : c', {a: true, b: 'y', c: 'n'})).should.equal('y');
            (await run('a ? b.x : 1', {a: false, b: null})).should.equal(1);
        });

        it('comparison, in, instanceof, typeof, void', async function () {
            (await run("'a' in o && [] instanceof Array && typeof o === 'object'", {o: {a: 1}})).should.equal(true);
            (await run('typeof nope')).should.equal('undefined');
            assert.isUndefined(await run('void 1'));
            (await run('1 < 2 && 2 <= 2 && 3 > 2 && 3 >= 3 && 1 != 2 && 1 !== "1" && 1 == "1"')).should.equal(true);
        });

        it('lists, objects, shorthand and computed keys, members', async function () {
            assert.deepEqual(await run("[1, 'a', [2]]"), [1, 'a', [2]]);
            assert.deepEqual(JSON.parse(JSON.stringify(await run("{a: 1, 'b c': 2, d, [k]: 3}", {d: 4, k: 'e'}))), {a: 1, 'b c': 2, d: 4, e: 3});
            (await run('o.a.b[k][0]', {o: {a: {b: {z: [7]}}}, k: 'z'})).should.equal(7);
            assert.isUndefined(await run('a?.b', {a: null}));
            (await run("a?.['b']", {a: {b: 3}})).should.equal(3);
            assert.isUndefined(await run('f?.()', {f: null}));
        });

        it('calls keep this on a method and work on globals', async function () {
            (await run("'abc'.toUpperCase()")).should.equal('ABC');
            (await run('Math.max(1, 3, 2)')).should.equal(3);
            (await run('o.get()', {o: {n: 5, get() { return this.n }}})).should.equal(5);
            (await run('document.body.tagName')).should.equal('BODY');
            (await run('new Date(0).getTime()')).should.equal(0);
            (await run('JSON.stringify({a: [1]})')).should.equal('{"a":[1]}');
        });

        it('statements: block, var, with, compound assignment', async function () {
            let o = {a: 1};
            await stmts('var n = 1; n += 2; n *= 3; { o.a = n } ; o.b ??= 4', {o});
            assert.deepEqual(o, {a: 9, b: 4});
            await stmts('with (o) { a = 5 }', {o});
            o.a.should.equal(5);
        });

        it('reports a name that is not defined, like JavaScript', async function () {
            await fails('nope + 1', /nope is not defined/);
            await fails('null.x', /Cannot read properties of null/);
            await fails('f()', /not a function/, {f: 1});
        });

        it('a syntax error reports the token', async function () {
            await fails('1 +', /ypy: expr: unexpected \)/);
            await fails('1 2', /unexpected 2/);
            await fails('a = ', /ypy: expr: unexpected \)/);
            await fails('(1', /ypy: expr: unexpected/);
            await fails('1 = 2', /cannot assign/);
        });

        it('says what it does not support', async function () {
            await fails('x => x', /unexpected/);
            await fails('`a${1}`', /unexpected character/);
            await fails('await f()', /await is not supported/);
            await fails('function () {}', /function is not supported/);
        });
    });

    describe('what it refuses', function () {
        beforeEach(async function () { await open('') });

        it('eval, Function and the constructor chain', async function () {
            await fails("eval('1')", /refused|is not defined/);
            await fails("Function('return 1')()", /refused|is not defined/);
            await fails("window.eval('1')", /refused name eval/);
            await fails("this.constructor.constructor('return 1')()", /refused name constructor/);
            await fails("o['__proto__']", /refused name __proto__/, {o: {}});
            await fails("o['con' + 'structor']", /refused name constructor/, {o: {}});
        });

        it('a string handed to setTimeout', async function () {
            await fails("setTimeout('1', 1)", /string cannot run as code/);
            assert.isAbove(await run('setTimeout(f, 1)', {f() {}}), 0);
        });

        it('assignment to a refused name', async function () {
            await fails("o.constructor = 1", /refused name constructor/, {o: {}});
            await fails("({constructor: 1})", /refused name constructor/);
        });
    });

    describe('the core policy still decides', function () {
        it('callbacks "none" blocks the code, with the extension loaded', async function () {
            await open('<div id="d" ypy-get="/x" ypy-trigger="evt[ok]"></div>', {config: NONE});
            let blocked = 0, calls = 0;
            page.doc.addEventListener('ypy:security:blocked', () => blocked++);
            q('#d').addEventListener('ypy:before:request', () => { calls++; return false });
            fire(q('#d'), 'evt', {ok: true});
            blocked.should.equal(1);
            calls.should.equal(0);
        });
    });
});
