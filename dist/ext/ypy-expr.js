// SPDX-License-Identifier: MIT
//==========================================================
// ypy-expr.js
//
// Runs the author code of a page without eval and without new Function: trigger filters
// (click[ctrlKey && key == 'a']), ypy-on handlers and `js:` values. The code is parsed here into
// closures, so it works under a strict CSP that forbids 'unsafe-eval'. The core still decides
// whether author code may run at all: config.callbacks stays "none" until the page sets it, and
// this extension changes how the code runs, not whether it may.
//
//   <script src="ypy.min.js"></script>
//   <script src="ext/ypy-expr.min.js"></script>
//   <meta name="ypy-config" content='callbacks:"all"'>
//   <input ypy-get="/search" ypy-trigger="keyup[key == 'Enter' || key == '[']">
//   <button ypy-on:click="this.classList.toggle('on'); count = count + 1">
//
// What it understands: numbers, strings, [list], {object}, this, names (a name the core hands to the
// code, else a global), . ?. [] and calls (a method keeps its object as `this`), new, unary
// ! - + typeof void, the binary operators of JavaScript (also ** in instanceof), a ? b : c,
// assignments (= += -= *= /= %= ??=) and ++ --, and the statements `;`, { }, let/const/var,
// if/else, return and with (what a ypy-on handler is wrapped in). Not supported, with an error:
// arrow functions, template strings, await, loops, regular expression literals. Names that reach
// the compiler (eval, Function, constructor, prototype, __proto__) are refused, and a string handed
// to setTimeout or setInterval is not run.
//
// Provides expr@1 (see ypy.supports).
//==========================================================
(() => {
    const BAD = /^(?:eval|Function|constructor|prototype|__proto__|__(?:define|lookup)[GS]etter__)$/;
    const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_$][\w$]*)|(\?\?=|\*\*|===|!==|\?\?|\?\.(?!\d)|==|!=|<=|>=|&&|\|\||\+\+|--|[-+*\/%]=|[-+*\/%<>=!?:.,;()[\]{}]))/y;
    const LEVELS = [['??'], ['||'], ['&&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>=', 'in', 'instanceof'], ['+', '-'], ['*', '/', '%'], ['**']];
    const OPS = {
        '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b, '**': (a, b) => a ** b,
        '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
        '==': (a, b) => a == b, '!=': (a, b) => a != b, '===': (a, b) => a === b, '!==': (a, b) => a !== b,
        in: (a, b) => a in b, instanceof: (a, b) => a instanceof b
    };
    const LITERALS = new Map([['true', true], ['false', false], ['null', null], ['undefined', undefined]]);
    const ASSIGN = ['=', '+=', '-=', '*=', '/=', '%=', '??='];
    const MAX_DEPTH = 40;
    const cache = new Map();

    const E = message => Error('ypy: expr: ' + message);
    const unquote = s => JSON.parse(s[0] == '"' ? s : '"' + s.slice(1, -1).replace(/\\.|"/g, m => m == "\\'" ? "'" : m == '"' ? '\\"' : m) + '"');
    const key = k => { if (BAD.test(k)) throw E('refused name ' + k); return k };
    
    // The value of a name: a `with` object, then what the core passed, then a global
    function lookup(x, name) {
        for (let o of x.w) if (name in o) return o[name];
        if (name in x.v) return x.v[name];
        if (name in globalThis && !BAD.test(name)) return globalThis[name];
        throw ReferenceError(name + ' is not defined');
    }

    // `=` gives back what it stored
    function store(x, name, value) {
        for (let o of x.w) if (name in o) return o[name] = value;
        return x.v[name] = value;
    }

    // mode: an expression (the value of a filter or `js:`) or statements (a handler)
    function compile(src, expression) {
        let id = +expression + src, hit = cache.get(id);
        if (hit) return hit;
        let t = [], i = 0, depth = 0, m;
        src = src.trim();
        TOKEN.lastIndex = 0;
        while (TOKEN.lastIndex < src.length) {
            if (!(m = TOKEN.exec(src))) throw E('unexpected character ' + JSON.stringify(src[TOKEN.lastIndex]));
            t.push(m[1] ? [1, m[1]] : m[2] ? [2, m[2]] : m[3] ? [3, m[3]] : [4, m[4]]);
        }
        const bad = () => { throw E('unexpected ' + (t[i]?.[1] ?? 'end of the code')) };
        const at = p => t[i]?.[1] === p && t[i][0] > 2;
        const eat = p => at(p) && ++i;
        const need2 = p => eat(p) || bad();
        const take = () => t[i++] || bad();
        const deeper = () => { if (++depth > MAX_DEPTH) throw E('too deep') };

        function args() {
            let list = [];
            if (!eat(')')) { do list.push(expr()); while (eat(',')); need2(')') }
            return x => list.map(a => a(x));
        }

        function primary() {
            let [type, text] = take(), c;
            if (type == 1) { c = () => +text }
            else if (type == 2) { let s = unquote(text); c = () => s }
            else if (type == 3 && LITERALS.has(text)) { let v = LITERALS.get(text); c = () => v }
            else if (type == 3 && text == 'this') c = x => x.self;
            else if (type == 3 && ['function', 'async', 'await', 'class', 'yield', 'import', 'delete'].includes(text)) throw E(text + ' is not supported');
            else if (type == 3 && text == 'new') {
                let callee = member(primary(), true), list = eat('(') ? args() : () => [];
                c = x => Reflect.construct(callee(x), list(x));
            }
            else if (type == 3) { c = x => lookup(x, text); c.id = text }
            else if (text == '(') { c = expr(); need2(')') }
            else if (text == '[') {
                let items = [];
                if (!eat(']')) { do { if (at(']')) break; items.push(expr()) } while (eat(',')); need2(']') }
                c = x => items.map(a => a(x));
            } else if (text == '{') {
                let props = [];
                if (!eat('}')) {
                    do {
                        if (at('}')) break;
                        let [kt, k] = take(), v, computed;
                        if (kt == 4 && k == '[') { computed = expr(); need2(']') } else if (kt == 2) k = unquote(k); else if (kt == 4) { i--; bad() }
                        if (eat(':')) v = expr(); else if (kt == 3) v = x => lookup(x, k); else bad();
                        props.push([computed || (() => k), v]);
                    } while (eat(','));
                    need2('}');
                }
                c = x => { let o = {}; for (let [k, v] of props) o[key(k(x))] = v(x); return o };
            } else { i--; bad() }
            return c;
        }

        // . ?. [] and calls after a primary. A link that names a property keeps `ref(x)`, [object, name], to assign to it and to call
        // a method with the right `this`. `?.` guards its own link only.
        function member(c, noCall) {
            for (;;) {
                let base = c, opt = !!eat('?.'), k, ref;
                if (!noCall && eat('(')) {
                    let list = args();
                    c = x => {
                        let [o, n] = base.ref ? base.ref(x) : [],
                            f = base.ref ? (o == null ? undefined : o[n]) : base(x);
                        return f == null && opt ? undefined : call(f, o, list(x));
                    };
                    continue;
                }
                if (eat('[')) { k = expr(); need2(']') }
                else if (opt || eat('.')) { let [kt, name] = take(); if (kt != 3) { i--; bad() } k = () => name }
                else return c;
                ref = x => {
                    let o = base(x), n = key(k(x));
                    if (o == null && !opt) throw TypeError(`Cannot read properties of ${o} (reading '${n}')`);
                    return [o, n];
                };
                c = x => { let [o, n] = ref(x); return o == null ? undefined : o[n] };
                c.ref = ref;
            }
        }

        function call(f, self, a) {
            if (typeof f != 'function') throw TypeError('not a function');
            if ((f === setTimeout || f === setInterval) && typeof a[0] == 'string') throw E('a string cannot run as code');
            return f.apply(self, a);
        }

        function unary() {
            deeper();
            let c, o = ['!', '-', '+', 'typeof', 'void', '++', '--'].find(at);
            if (o) {
                i++;
                let a = unary();
                if (o == 'typeof') c = a.id ? x => { try { return typeof a(x) } catch (e) { if (e instanceof ReferenceError) return 'undefined'; throw e } } : x => typeof a(x);
                else if (o == '++' || o == '--') c = update(a, o == '++' ? 1 : -1, true);
                else c = o == '!' ? x => !a(x) : o == '-' ? x => -a(x) : o == '+' ? x => +a(x) : x => (a(x), undefined);
            } else {
                c = member(primary());
                let p = ['++', '--'].find(at);
                if (p) { i++; c = update(c, p == '++' ? 1 : -1, false) }
            }
            depth--;
            return c;
        }

        // The setter of something that can be assigned to
        function target(c) {
            if (c.id) return (x, v) => store(x, c.id, v);
            if (c.ref) return (x, v) => { let [o, n] = c.ref(x); if (o == null) throw TypeError(`Cannot set properties of ${o} (setting '${n}')`); return o[n] = v };
            throw E('cannot assign to this');
        }

        function update(a, d, before) {
            let set = target(a);
            return x => { let old = +a(x), v = old + d; set(x, v); return before ? v : old };
        }

        function binary(l) {
            if (l == LEVELS.length) return unary();
            let c = binary(l + 1), o;
            while ((o = LEVELS[l].find(at))) {
                i++;
                let a = c, b = binary(l + 1), f = OPS[o];
                c = o == '&&' ? x => a(x) && b(x) : o == '||' ? x => a(x) || b(x) : o == '??' ? x => a(x) ?? b(x) : x => f(a(x), b(x));
            }
            return c;
        }

        function expr() {
            deeper();
            let c = binary(0), o;
            if (eat('?')) { let a = expr(), b = (need2(':'), expr()), q = c; c = x => q(x) ? a(x) : b(x) }
            else if ((o = ASSIGN.find(at))) {
                i++;
                let set = target(c), r = expr(), get = c, f = OPS[o.slice(0, -1)];
                c = o == '=' ? x => set(x, r(x)) : o == '??=' ? x => get(x) ?? set(x, r(x)) : x => set(x, f(get(x), r(x)));
            }
            depth--;
            return c;
        }

        function body() {
            let list = [];
            while (i < t.length && !at('}')) { if (!eat(';')) list.push(statement()) }
            return x => { let r; for (let s of list) { r = s(x); if (x.done) break } return r };
        }

        function statement() {
            deeper();
            let c;
            if (eat('{')) { c = body(); need2('}') }
            else if (eat('with')) {
                need2('(');
                let o = expr(), b;
                need2(')');
                b = statement();
                c = x => { x.w.unshift(Object(o(x))); try { return b(x) } finally { x.w.shift() } };
            } else if (eat('if')) {
                need2('(');
                let q = expr(), a, b;
                need2(')');
                a = statement();
                b = eat('else') ? statement() : () => {};
                c = x => q(x) ? a(x) : b(x);
            } else if (eat('return')) {
                let v = i < t.length && !at(';') && !at('}') ? expr() : () => {};
                c = x => { x.ret = v(x); x.done = true };
            } else if (['let', 'const', 'var'].some(eat)) {
                let [type, name] = take(), v = eat('=') ? expr() : () => {};
                if (type != 3) { i--; bad() }
                c = x => { x.v[name] = v(x) };
            } else c = expr();
            eat(';');
            depth--;
            return c;
        }

        let prog;
        if (expression) {
            let e = expr();
            prog = x => (x.ret = e(x));
        } else prog = body();
        if (i < t.length) bad();
        if (cache.size > 255) cache.clear();
        cache.set(id, prog);
        return prog;
    }

    ypy.registerExtension('ypy-expr', {
        version: '1.0.0',
        provides: ['expr@1'],
        init(api) {
            // the core calls the function with `this` as the element and the values of `keys`
            api.initEvaluator((keys, code, expression, isAsync) => {
                let prog = compile(code, expression);
                let run = function (...values) {
                    let x = {self: this, v: Object.create(null), w: [], ret: undefined, done: false};
                    keys.forEach((k, n) => x.v[k] = values[n]);
                    prog(x);
                    return x.ret;
                };
                return isAsync ? async function (...values) { return run.apply(this, values) } : run;
            });
        }
    });
})();
