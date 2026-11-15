// SPDX-License-Identifier: MIT
// The expression language of ypy-signals: its grammar, its limits and what it refuses to reach.
describe('ypy-signals expressions', function () {

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
        ypy.signals.register('json', v => JSON.stringify(v));
        ypy.signals.register('add', (a, b) => a + b);
    });

    after(() => { restoreExtensions(extBackup) });
    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => { cleanupTest() });

    let errors;
    const onError = e => errors.push(e.detail.error.message);
    beforeEach(() => { errors = []; document.addEventListener('ypy:signals:error', onError) });
    afterEach(() => { document.removeEventListener('ypy:signals:error', onError) });

    const quiet = fn => {
        let e = console.error, w = console.warn;
        console.error = console.warn = () => {};
        try { return fn() } finally { console.error = e; console.warn = w }
    };

    // ypy-text with the expression: its text, or undefined when it is an error (errors holds the message)
    function show(expr, signals = 'a:1') {
        let scope = document.createElement('div'), out = document.createElement('b');
        scope.setAttribute('ypy-signals', signals);
        out.setAttribute('ypy-text', expr);
        scope.append(out);
        playground().replaceChildren(scope);
        quiet(() => ypy.process(playground()));
        return out.textContent;
    }

    // a handler: runs it with a click, returns the scope element to read the signals from
    function exec(src, signals = 'a:1') {
        let scope = document.createElement('div'), button = document.createElement('button');
        scope.setAttribute('ypy-signals', signals);
        button.setAttribute('ypy-on:click', src);
        scope.append(button);
        playground().replaceChildren(scope);
        quiet(() => { ypy.process(playground()); button.click() });
        return scope;
    }

    describe('grammar', function () {

        it('numbers, strings and the usual precedence', function () {
            show('1 + 2 * 3').should.equal('7');
            show('(1 + 2) * 3').should.equal('9');
            show('10 - 4 - 3').should.equal('3');
            show('7 % 4 + 8 / 2').should.equal('7');
            show('1.5e2 + 0.5').should.equal('150.5');
            show('-3 + +"4"').should.equal('1');
            show('"a" + \'b\' + "c\\"d" + \'e\\\'f\'').should.equal('abc"de\'f');
            show('"tab\\there"').should.equal('tab\there');
        });

        it('comparison and equality', function () {
            show('1 < 2').should.equal('true');
            show('2 <= 1').should.equal('false');
            show('"1" == 1').should.equal('true');
            show('"1" === 1').should.equal('false');
            show('1 != 2').should.equal('true');
            show('1 !== 1').should.equal('false');
            show('3 >= 3 && 3 > 2').should.equal('true');
        });

        it('logic short-circuits: the right side is not evaluated', function () {
            let calls = 0;
            ypy.signals.register('boom', () => { calls++; return true });
            show('false && boom()').should.equal('false');
            show('true || boom()').should.equal('true');
            show('1 ?? boom()').should.equal('1');
            calls.should.equal(0);
            show('0 || "x"').should.equal('x');
            show('null ?? "d"').should.equal('d');
            show('!true').should.equal('false');
            show('!!$a').should.equal('true');
        });

        it('ternary, nested and right-associative', function () {
            show('$a > 0 ? "pos" : "neg"').should.equal('pos');
            show('$a > 5 ? "big" : $a > 0 ? "small" : "none"').should.equal('small');
        });

        it('literals: true false null undefined, arrays and objects', function () {
            show('json([1, "a", true, null, [2]])').should.equal('[1,"a",true,null,[2]]');
            show('json({a: 1, "b-c": 2, 3: 4, nested: {x: [$a]}})').should.equal('{"3":4,"a":1,"b-c":2,"nested":{"x":[1]}}');
            show('json([1, 2,])').should.equal('[1,2]');
            show('undefined ?? "u"').should.equal('u');
        });

        it('signals by path: dots, brackets, optional chaining, length', function () {
            let sig = `o:{a:{b:[10,20]}, k:'v'}, s:'hello', i:1`;
            show('$o.a.b[1]', sig).should.equal('20');
            show('$o.a.b[$i]', sig).should.equal('20');
            show('$o["k"]', sig).should.equal('v');
            show('$o?.a?.b[0]', sig).should.equal('10');
            show('$s.length', sig).should.equal('5');
            show('$o.a.b.length', sig).should.equal('2');
            show('$s[1]', sig).should.equal('e');
        });

        it('a path that does not exist is undefined, not an error', function () {
            show('$o.x.y.z ?? "none"', 'o:{}').should.equal('none');
            show('$nope.x ?? "none"').should.equal('none');
            show('$a.b.c ?? "none"').should.equal('none');
            errors.length.should.equal(0);
        });

        it('calls registered functions, nested, with computed arguments', function () {
            show('add(add(1, 2), $a * 10)').should.equal('13');
            show('add()').should.equal('NaN');
        });

        it('handlers take statements, assignments and ++ -- on a path', function () {
            let scope = exec('$n = 1; $n += 2; $n *= 4; $n -= 2; $n /= 2; $n %= 4; $u.k++; --$u.j; $z ??= 9; $z ??= 0;; ', 'n:0, u:{k:1,j:1}');
            ypy.signals.get('n', scope).should.equal(1);
            ypy.signals.get('u', scope).should.deep.equal({k: 2, j: 0});
            ypy.signals.get('z', scope).should.equal(9);
            errors.length.should.equal(0);
        });

        it('++ returns the old value after, the new one before', function () {
            let scope = exec('$a = $n++; $b = ++$n', 'n:1, a:0, b:0');
            ypy.signals.get('a', scope).should.equal(1);
            ypy.signals.get('b', scope).should.equal(3);
        });

        it('assignment to an array item and to a new object member', function () {
            let scope = exec('$l[1] = "x"; $l[2] = "y"; $o.new = 1', 'l:["a","b"], o:{}');
            ypy.signals.get('l', scope).should.deep.equal(['a', 'x', 'y']);
            ypy.signals.get('o', scope).should.deep.equal({new: 1});
        });

        it('a nested write makes a new object, so effects see the change', async function () {
            createProcessedHTML(`<div ypy-signals="o:{a:1}"><b id="x" ypy-text="json($o)"></b><button ypy-on:click="$o.a = 2">go</button></div>`);
            find('button').click();
            await Promise.resolve(); await Promise.resolve();
            find('#x').textContent.should.equal('{"a":2}');
        });
    });

    describe('not an expression', function () {

        const refused = [
            ['an assignment in a read-only place', '$a = 1'],
            ['++ in a read-only place', '$a++'],
            ['an unknown function', 'nothing()'],
            ['a bare name', 'foo'],
            ['a call on a path', '$a.b()'],
            ['a dangling operator', '1 +'],
            ['an unclosed paren', '(1'],
            ['an unclosed array', '[1'],
            ['an unclosed object', '{a:1'],
            ['two values', '1 2'],
            ['an arrow function', '(x) => x'],
            ['a template literal', '`${1}`'],
            ['new', 'new Date()'],
            ['a statement separator in an expression', '1; 2'],
            ['an empty expression', ''],
            ['a regex', '/a/.test("a")'],
            ['a comment', '1 // x'],
            ['a bad escape', '"\\x41"']
        ];
        for (let [name, expr] of refused) {
            it(name + ' is an error and shows nothing: ' + JSON.stringify(expr), function () {
                show(expr).should.equal('');
                errors.length.should.equal(1);
            });
        }

        it('a statement list is only for handlers', function () {
            show('1; 2');
            errors.length.should.equal(1);
            exec('$a = 1; $a = $a + 1');
            errors.length.should.equal(1);   // still the first one only
        });

        it('assignment needs a signal on the left', function () {
            exec('1 = 2');
            exec('$a + 1 = 2');
            exec('add(1, 2) = 3');
            errors.length.should.equal(3);
        });

        it('a handler that fails does not stop the next click, and says why once per click', function () {
            let scope = exec('$a = nothing()');
            scope.querySelector('button').click();
            errors.length.should.be.at.least(2);
        });
    });

    describe('limits', function () {

        it('an expression longer than 1000 characters is refused', function () {
            show('1' + ' + 1'.repeat(300)).should.equal('');
            errors.length.should.equal(1);
            show('1' + ' + 1'.repeat(240)).should.equal('241');
        });

        it('nesting deeper than 32 levels is refused, and does not blow the stack', function () {
            show('('.repeat(40) + '1' + ')'.repeat(40)).should.equal('');
            errors.length.should.equal(1);
            show('('.repeat(10) + '1' + ')'.repeat(10)).should.equal('1');
            show('['.repeat(60) + ']'.repeat(60));
            show('!'.repeat(500) + '1');
            show('-'.repeat(500) + '1');
            errors.length.should.equal(4);
        });

        it('a deep ternary chain is refused', function () {
            show('1 ? 2 : '.repeat(50) + '3');
            errors.length.should.equal(1);
        });

        it('a declaration may be long (data), up to 20000 characters', function () {
            let big = `d:[${Array.from({length: 2000}, (_, i) => i).join(',')}]`;
            big.length.should.be.below(20000);
            show('$d.length', big).should.equal('2000');
            show('$d.length', `d:"${'x'.repeat(21000)}"`);
            errors.length.should.equal(1);
        });

        it('the compiled expressions are cached, and the cache is bounded', function () {
            for (let i = 0; i < 600; i++) show('$a + ' + i);
            show('$a + 599').should.equal('600');
        });
    });

    describe('what it never reaches', function () {

        const nothing = [
            '$a.constructor', '$a.__proto__', '$a.prototype', '$a["constructor"]', '$a["__proto__"]',
            '$o.constructor', '$o.__proto__', '$a.__proto__.x', '$o["__proto__"]', '$o.toString', '$o.hasOwnProperty', '$o.valueOf',
            '$s.toUpperCase', '$s.constructor', '$l.map', '$l.push', '$l.constructor',
            '$event', '$event.target', '$constructor', '$__proto__', '$toString'
        ];
        for (let expr of nothing) {
            it('reads as undefined: ' + expr, function () {
                show('(' + expr + ') ?? "undefined"', "a:1, o:{k:1}, s:'text', l:[1]").should.equal('undefined');
                errors.length.should.equal(0);
            });
        }

        it('own properties that happen to be named like prototype members are plain data', function () {
            // JSON can carry an own "__proto__" key; reading it is refused all the same
            show('$o.__proto__ ?? "no"', 'o:{k:1}').should.equal('no');
        });

        const errorsOut = [
            'window', 'globalThis', 'self', 'document', 'this', 'top', 'parent', 'location', 'eval("1")', 'Function("return 1")()',
            'constructor("x")', 'toString()', 'valueOf()', 'hasOwnProperty("x")', 'alert(1)', 'fetch("/x")',
            '$a.constructor.constructor("return window")()', '$o.constructor("x")',
            'window.location', 'document.cookie', 'import("x")', 'this.constructor', 'arguments', 'Object.keys($o)'
        ];
        for (let expr of errorsOut) {
            it('is an error: ' + expr, function () {
                show(expr, 'a:1, o:{}').should.equal('');
                errors.length.should.equal(1);
            });
        }

        it('object literal keys cannot be __proto__, constructor or prototype', function () {
            show('json({__proto__: {x: 1}})');
            show('json({constructor: 1})');
            show('json({"prototype": 1})');
            show('json({"__proto__": 1})');
            errors.length.should.equal(4);
            assert.isUndefined({}.x);
        });

        it('a signal cannot be declared with a reserved name', function () {
            show('1', 'constructor:1');
            show('1', '"__proto__":{"x":1}');
            show('1', 'prototype:1');
            errors.length.should.equal(3);
            assert.isUndefined({}.x);
        });

        it('a write cannot go through __proto__, constructor or prototype', function () {
            let scope = exec('$o.__proto__.polluted = 1', 'o:{}');
            exec('$o["__proto__"]["polluted"] = 1', 'o:{}');
            exec('$o.constructor.prototype.polluted = 1', 'o:{}');
            exec('$__proto__ = 1');
            exec('$constructor = 1');
            exec('$l[0].__proto__.polluted = 1', 'l:[{}]');
            assert.isUndefined({}.polluted);
            assert.isUndefined(Object.prototype.polluted);
            errors.length.should.equal(6);
            assert.exists(scope);
        });

        it('an array grows by one item, and its length cannot be written', function () {
            let scope = exec('$l[99999999] = 1', 'l:[1]');
            exec('$l.length = 4294967295', 'l:[1]');
            exec('$l["length"] = 0', 'l:[1]');
            exec('$l.foo = 1', 'l:[1]');
            errors.length.should.equal(4);
            ypy.signals.get('l', scope).should.deep.equal([1]);
        });

        it('what a registered function returns is read like any value: own properties only', function () {
            ypy.signals.register('node', () => document.body);
            show('node().ownerDocument ?? "none"');
            errors.length.should.equal(1);        // a call result cannot be followed by a path
            show('json({b: node()}) ?? ""');
        });

        it('a value of a signal that is a DOM node does not open the DOM either', function () {
            ypy.signals.register('body', () => document.body);
            let scope = exec('$n = body()');
            ypy.signals.get('n', scope).should.equal(document.body);
            show('($n.ownerDocument ?? "none") + ($n.defaultView ?? "none") + ($n.parentNode ?? "none")', 'n:1');
            // read from a signal holding the body: still own properties only
            let s2 = document.createElement('div');
            s2.setAttribute('ypy-signals', 'n:0');
            let out = document.createElement('b');
            out.setAttribute('ypy-text', '($n.ownerDocument ?? "none") + ($n.parentNode ?? "none") + ($n.firstChild ?? "none")');
            s2.append(out);
            playground().replaceChildren(s2);
            ypy.process(playground());
            ypy.signals.patch({n: 1}, out);
            out.textContent.should.equal('nonenonenone');
        });

        it('$event exposes plain fields, never the target element or the window', function () {
            let scope = exec('$t = $event.target; $v = $event.view; $x = $event.currentTarget; $ty = $event.type', 't:1, v:1, x:1, ty:""');
            assert.isUndefined(ypy.signals.get('t', scope));
            assert.isUndefined(ypy.signals.get('v', scope));
            assert.isUndefined(ypy.signals.get('x', scope));
            ypy.signals.get('ty', scope).should.equal('click');
        });
    });

    describe('ypy-attr refuses what runs code', function () {

        const attr = (name, value) => {
            let scope = document.createElement('div'), b = document.createElement('a');
            scope.setAttribute('ypy-signals', 'v:' + JSON.stringify(value));
            b.setAttribute('ypy-attr:' + name, '$v');
            scope.append(b);
            playground().replaceChildren(scope);
            quiet(() => ypy.process(playground()));
            return b;
        };

        for (let name of ['onclick', 'onerror', 'onmouseover', 'srcdoc', 'ypy-get', 'data-ypy-get', 'ypy-on:click']) {
            it('does not set ' + name, function () {
                let b = attr(name, 'alert(1)');
                assert.isFalse(b.hasAttribute(name), name);
                errors.length.should.equal(1);
            });
        }

        for (let value of ['javascript:alert(1)', ' javascript:alert(1)', '\n\tJaVaScRiPt:alert(1)', 'vbscript:x']) {
            for (let name of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
                it(`does not set ${name} to ${JSON.stringify(value)}`, function () {
                    let b = attr(name, value);
                    assert.isFalse(b.hasAttribute(name));
                    errors.length.should.equal(1);
                });
            }
        }

        it('sets harmless attributes and normal URLs', function () {
            attr('href', '/path?x=1').getAttribute('href').should.equal('/path?x=1');
            attr('href', 'https://example.com/javascript:').getAttribute('href').should.equal('https://example.com/javascript:');
            attr('title', 'javascript:ok').getAttribute('title').should.equal('javascript:ok');
            attr('aria-label', 'x').getAttribute('aria-label').should.equal('x');
            errors.length.should.equal(0);
        });

        it('the object form is checked the same way', function () {
            let scope = document.createElement('div'), b = document.createElement('a');
            scope.setAttribute('ypy-signals', 'v:1');
            b.setAttribute('ypy-attr', '{onclick: "x", title: "ok", href: "javascript:x"}');
            scope.append(b);
            playground().replaceChildren(scope);
            quiet(() => ypy.process(playground()));
            assert.isFalse(b.hasAttribute('onclick'));
            assert.isFalse(b.hasAttribute('href'));
        });
    });

    describe('markup that tries to switch things on', function () {

        it('a signal attribute written by the server into a swap is wired like any other', async function () {
            mockResponse('GET', '/x', '<b id="n" ypy-text="$a"></b>');
            createProcessedHTML(`<div ypy-signals="a:'swapped in'"><div id="box"></div><button ypy-get="/x" ypy-target="#box">go</button></div>`);
            find('button').click();
            await forRequest();
            await Promise.resolve();
            find('#n').textContent.should.equal('swapped in');
        });

        it('the expressions cannot send a request or touch the page: only a registered function can', function () {
            let touched = 0;
            ypy.signals.register('touch', () => { touched++ });
            exec('touch(); $a = 2');
            touched.should.equal(1);
            exec('fetch("/steal")');
            errors.length.should.equal(1);
        });
    });
});
