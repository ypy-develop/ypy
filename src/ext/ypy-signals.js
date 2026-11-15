// SPDX-License-Identifier: MIT
//==========================================================
// ypy-signals.js
//
// Client state for ypy: signals, computed values and bindings, with an expression language of
// its own. No eval, no new Function: the expressions are parsed here into closures, so the
// extension works with callbacks:"none" and a strict CSP. Full reference: https://ypy.dev/docs/reference/signals.
//
// Attributes (also as data-ypy-*):
//   ypy-signals="count:0, name:'x'"   declares signals; the element is the scope of its descendants
//   ypy-signals.server="plan:'free'"  read-only for the client; only the server (a patch) changes them
//   ypy-signals.local="_theme:'dark'" persisted in localStorage (.session: sessionStorage); needs an id
//   ypy-computed:total="$price * $qty"  derived, read-only signal
//   ypy-bind="name"  ypy-bind:name      two-way with input, select, textarea, contenteditable
//   ypy-text  ypy-show  ypy-class[:name]  ypy-attr[:name]   one-way, re-run when a signal they read changes
//   ypy-on:click="$count++; save($event.key)"   handlers; inside a scope they replace the core ypy-on
// Modifiers: bind .live .blur .debounce.300ms .throttle.300ms; on .prevent .stop .once .window
// .debounce.Nms .throttle.Nms.
//
// Expressions: $name.path, literals, [list], {object}, ! - + * / % < > <= >= == != === !== && || ??,
// a ? b : c, calls of functions given to ypy.signals.register(name, fn). Handlers also take
// statements separated by ";", assignments (= += -= *= /= %= ??=) and ++ --. Nothing else.
//
// Wire format (the Go SDK follows this, spec/PROTOCOL.md 3.2): a request from an element with
// signals in reach carries the signals (computed ones and every key starting with "_" left out, at
// any depth) as one JSON object in the form field "ypy-signals": the core puts the fields of a GET
// or DELETE in the query string and those of the other verbs in the urlencoded or multipart body.
// Opt-in: nothing is sent unless asked. ypy-signals-send on the element, or ypy-signals-send:inherited on an
// ancestor (the nearest value wins; "false" turns it off again), or ypy.config.signals.send = true for the
// whole page. A response of type application/json is a JSON Merge Patch (RFC 7396) applied to the signals; it
// is not swapped. Only the public API and the extension API are used.
//==========================================================
(() => {
    let api;

    const FIELD = 'ypy-signals';
    const BAD = /^(?:constructor|prototype|__proto__)$/;
    const KINDS = ['signals', 'computed', 'bind', 'text', 'show', 'class', 'attr', 'on'];
    const ATTR = new RegExp(`^(?:data-)?ypy-(${KINDS.join('|')})(?::([^.]+))?((?:\\.[^.]+)*)$`);
    const xp = kinds => '(self::*|.//*)[@*[' + kinds.flatMap(k => ['ypy-', 'data-ypy-'].map(p => `starts-with(name(),"${p}${k}")`)).join(' or ') + ']]';
    const IGNORE = '[ypy-ignore],[data-ypy-ignore]';
    const fns = new Map(), scopes = new WeakMap(), recs = new WeakMap(), pending = new Set(), queue = new Set();
    let active = null, live = 0, scheduled = false;

    //============================================================================================
    // Reactivity: a node is a signal (no fn), a computed (fn, lazy) or an effect (fn, runs in a batch)
    //============================================================================================

    const E = m => Error('ypy: signals: ' + m);
    const deny = k => { if (BAD.test(k)) throw E('reserved name ' + k) };
    const fail = (elt, error) => api.triggerEvent(elt, 'ypy:signals:error', {error});
    const poke = n => { for (let s of [...n.subs]) s.dirty() };

    class Node {
        subs = new Set(); deps = new Set(); stale = false; dead = false; ro = false;
        constructor(fn, elt, eff, v) {
            Object.assign(this, {fn, elt, eff, v, stale: !!fn});
            if (fn) live++;
        }
        get() {
            if (active && !this.dead) { this.subs.add(active); active.deps.add(this) }
            if (this.stale) this.run();
            return this.v;
        }
        set(v) { if (v !== this.v) { this.v = v; poke(this) } }
        run() {
            if (this.dead) return;
            if (this.eff && !this.elt.isConnected) return this.kill();   // left the page without a cleanup
            for (let d of this.deps) d.subs.delete(this);
            this.deps.clear();
            let prev = active;
            active = this;
            this.stale = false;
            try { this.v = this.fn() } catch (e) { fail(this.elt, e) } finally { active = prev }
        }
        dirty() {
            if (this.dead || this.stale) return;
            this.stale = true;
            if (!this.eff) return poke(this);
            queue.add(this);
            if (!scheduled) { scheduled = true; queueMicrotask(flush) }
        }
        kill() {
            if (this.dead) return;
            this.dead = true;
            if (this.fn) live--;
            for (let d of this.deps) d.subs.delete(this);
            this.deps.clear();
            queue.delete(this);
            poke(this);
            this.subs.clear();
        }
    }

    // Runs the queued effects until none is left; effects that keep waking each other stop at 100 rounds
    function flush() {
        for (let i = 0; queue.size; i++) {
            if (i > 99) { queue.clear(); console.error('ypy: signals: effects loop'); break }
            let batch = [...queue];
            queue.clear();
            batch.forEach(n => n.run());
        }
        scheduled = false;
    }

    //============================================================================================
    // Scopes and paths. A signal is one node per top-level key; a nested write replaces the
    // value along the path (copy on write), so a change is always a new identity.
    //============================================================================================

    function scopeOf(elt) {
        let s = scopes.get(elt);
        if (!s) {
            scopes.set(elt, s = {elt, cells: new Map(), base: {}, shape: new Node(null, elt, 0, 0)});
            add(s, '_dirty', false, true);
        }
        return s;
    }

    function add(s, k, v, ro) {
        deny(k);
        let n = new Node(null, s.elt, 0, v);
        n.ro = ro;
        s.cells.set(k, n);
        s.base[k] = JSON.stringify(v);
        s.shape.set(s.shape.v + 1);
        return n;
    }

    // The scopes around an element, innermost first
    function up(elt) {
        let out = [];
        for (let p = elt; p; p = p.parentElement) { let s = scopes.get(p); if (s) out.push(s) }
        return out;
    }

    // Same, but an element outside every scope speaks for the top-level scopes of the page (the first
    // in document order is the outermost: where a signal nobody declared is created)
    function chainOf(elt) {
        let out = up(elt);
        if (!out.length) {
            let r = document.evaluate(xp(['signals']), document, null, 7);
            for (let i = 0; i < r.snapshotLength; i++) {
                let e = r.snapshotItem(i), s = scopes.get(e);
                if (s && !up(e.parentElement).length) out.unshift(s);
            }
        }
        return out;
    }

    const own = (v, k) => v != null && typeof v != 'function' && !BAD.test(k) && Object.hasOwn(Object(v), k) ? v[k] : undefined;
    const find = (ch, k) => ch.find(s => s.cells.has(k));

    function read(ch, name, keys) {
        let s = find(ch, name), v;
        if (s) v = s.cells.get(name).get();
        else ch.forEach(c => c.shape.get());   // a signal that does not exist yet: wake when one is declared
        for (let k of keys) v = own(v, k);
        return v;
    }

    function setIn(o, [k, ...rest], v) {
        deny(k);
        let c = o && typeof o == 'object' ? (Array.isArray(o) ? [...o] : {...o}) : {};
        if (Array.isArray(c) && !(/^\d+$/.test(k) && k <= c.length)) throw E('array index');
        c[k] = rest.length ? setIn(own(c, k), rest, v) : v;
        return c;
    }

    // false when the signal is read-only for the client
    function write(ch, name, keys, v, elt) {
        let s = find(ch, name), n = s?.cells.get(name);
        if (n?.ro) return api.triggerEvent(elt, 'ypy:signals:readonly', {name, warn: name + ' is read-only'}), false;
        if (!n) {
            if (!(s = ch.at(-1))) return false;
            n = add(s, name);
        }
        n.set(keys.length ? setIn(n.v, keys, v) : v);
        return true;
    }

    const rebase = (s, k) => {
        for (let [key, n] of k ? [[k, s.cells.get(k)]] : s.cells) if (n) s.base[key] = JSON.stringify(n.v);
        s.shape.set(s.shape.v + 1);   // wakes the unsaved-state effect
    };

    // JSON Merge Patch (RFC 7396) of a value
    const merge = (t, p) => p && typeof p == 'object' && !Array.isArray(p)
        ? Object.entries(p).reduce((o, [k, v]) => (BAD.test(k) || (v === null ? delete o[k] : o[k] = merge(own(o, k), v)), o),
            t && typeof t == 'object' && !Array.isArray(t) ? {...t} : {})
        : p;

    // Applies a merge patch to the signals in reach of elt. A key goes to the nearest scope that has it, a
    // new one to the outermost; null removes it. Computed signals ignore it; server ones accept it.
    function patch(ch, p, elt, missing) {
        if (!api.triggerEvent(elt, 'ypy:signals:patch', {patch: p})) return;
        for (let k of Object.keys(p)) {
            let s = find(ch, k), n = s?.cells.get(k), v = p[k];
            if (BAD.test(k) || n?.fn || (missing && n)) continue;
            if (v === null) {
                if (n) { n.kill(); s.cells.delete(k); delete s.base[k]; s.shape.set(s.shape.v + 1) }
            } else if (n) {
                n.set(merge(n.v, v));
                rebase(s, k);
            } else if ((s = ch.at(-1))) {
                add(s, k, merge(undefined, v));
            }
        }
    }

    //============================================================================================
    // The expression language: a parser that builds closures. Nothing is compiled, nothing global
    // is reachable: a name is a signal ($name), a literal or a registered function.
    //============================================================================================

    const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\$?[A-Za-z_]\w*)|(\?\?=|===|!==|\?\?|\?\.|==|!=|<=|>=|&&|\|\||\+\+|--|[-+*\/%]=|[-+*\/%<>=!?:.,;()[\]{}]))/y;
    const LEVELS = [['||', '??'], ['&&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    const OPS = {
        '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
        '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
        '==': (a, b) => a == b, '!=': (a, b) => a != b, '===': (a, b) => a === b, '!==': (a, b) => a !== b,
        '??': (a, b) => a ?? b
    };
    const LITERALS = new Map([['true', true], ['false', false], ['null', null], ['undefined', undefined]]);
    const MAX_DEPTH = 32, MAX_LENGTH = 1000, MAX_DECLARATION = 20000;
    const cache = new Map();

    const unquote = s => JSON.parse(s[0] == '"' ? s : '"' + s.slice(1, -1).replace(/\\.|"/g, m => m == "\\'" ? "'" : m == '"' ? '\\"' : m) + '"');

    // mode 0: one expression; 1: statements (a handler); 2: the literal of a declaration
    function compile(src, mode) {
        let id = mode + src, hit = cache.get(id);
        if (hit) return hit;
        src = src.trim();
        if (src.length > (mode == 2 ? MAX_DECLARATION : MAX_LENGTH)) throw E('too long');
        let t = [], i = 0, depth = 0, m;
        TOKEN.lastIndex = 0;
        while (TOKEN.lastIndex < src.length) {
            if (!(m = TOKEN.exec(src))) throw E('unexpected character');
            t.push(m[1] ? [1, m[1]] : m[2] ? [2, m[2]] : m[3] ? [3, m[3]] : [4, m[4]]);
        }
        const bad = () => { throw E('unexpected ' + (t[i]?.[1] ?? 'end')) };
        const at = p => t[i]?.[1] === p;
        const eat = p => at(p) && ++i;
        const need = p => eat(p) || bad();
        const take = () => t[i++] || bad();
        const wrong = () => { i--; bad() };
        const deeper = () => { if (++depth > MAX_DEPTH) throw E('too deep') };
        const lhs = (x, ref) => ref.keys.map(k => k(x));
        const assign = (x, ref, v) => write(x.ch, ref.name, lhs(x, ref), v, x.el);

        function expr() {
            deeper();
            let c = binary(0);
            if (eat('?')) { let a = expr(), b = (need(':'), expr()), q = c; c = x => q(x) ? a(x) : b(x) }
            depth--;
            return c;
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

        // ++ and -- change a signal: handlers only
        function step(a, o, before) {
            if (mode != 1 || !a.ref) bad();
            let d = o == '++' ? 1 : -1;
            return x => { let old = a(x), v = old + d; assign(x, a.ref, v); return before ? v : old };
        }

        function unary() {
            deeper();
            let o = ['!', '-', '+', '++', '--'].find(at), c;
            if (o) {
                i++;
                let a = unary();
                c = o == '!' ? x => !a(x) : o == '-' ? x => -a(x) : o == '+' ? x => +a(x) : step(a, o, 1);
            } else {
                c = primary();
                if (c.ref && (o = ['++', '--'].find(at))) { i++; c = step(c, o, 0) }
            }
            depth--;
            return c;
        }

        function primary() {
            let [type, text] = take();
            if (type == 1) return () => +text;
            if (type == 2) { let s = unquote(text); return () => s }
            if (type == 3 && text[0] == '$') {
                let name = text.slice(1), keys = [], c;
                for (;;) {
                    if (eat('.') || eat('?.')) {
                        let [kt, k] = take();
                        if (kt != 3 || k[0] == '$') wrong();
                        keys.push(() => k);
                    } else if (eat('[')) { keys.push(expr()); need(']') } else break;
                }
                if (at('(')) bad();   // only registered functions are called
                c = x => name == 'event' && x.ev ? keys.reduce((v, k) => own(v, k(x)), x.ev) : read(x.ch, name, keys.map(k => k(x)));
                c.ref = {name, keys};
                return c;
            }
            if (type == 3 && LITERALS.has(text)) { let v = LITERALS.get(text); return () => v }
            if (type == 3 && eat('(')) {
                let args = [];
                if (!eat(')')) { do args.push(expr()); while (eat(',')); need(')') }
                return x => {
                    let f = fns.get(text);
                    if (!f) throw E('no function ' + text);
                    return f(...args.map(a => a(x)));
                };
            }
            if (text == '(') { let c = expr(); need(')'); return c }
            if (text == '[') {
                let items = [];
                if (!eat(']')) { do { if (at(']')) break; items.push(expr()) } while (eat(',')); need(']') }
                return x => items.map(a => a(x));
            }
            if (text == '{') {
                let props = [];
                if (!eat('}')) {
                    do {
                        if (at('}')) break;
                        let [kt, k] = take();
                        if (kt == 2) k = unquote(k); else if (kt == 4 || (kt == 3 && k[0] == '$')) wrong();
                        deny(k);
                        need(':');
                        props.push([k, expr()]);
                    } while (eat(','));
                    need('}');
                }
                return x => { let o = {}; for (let [k, v] of props) o[k] = v(x); return o };
            }
            wrong();
        }

        function statement() {
            let c = expr(), o = ['=', '+=', '-=', '*=', '/=', '%=', '??='].find(at);
            if (!o) return c;
            if (!c.ref) bad();
            i++;
            let r = expr(), f = OPS[o.slice(0, -1)];
            return x => { let v = r(x); assign(x, c.ref, o == '=' ? v : f(c(x), v)) };
        }

        let prog;
        if (mode == 1) {
            let list = [];
            do { if (i < t.length && !at(';')) list.push(statement()) } while (eat(';'));
            prog = x => { for (let s of list) s(x) };
        } else prog = expr();
        if (i < t.length) bad();
        if (cache.size > 255) cache.clear();
        cache.set(id, prog);
        return prog;
    }

    //============================================================================================
    // Attributes
    //============================================================================================

    const ctx = elt => ({ch: chainOf(elt), el: elt});
    const camel = k => k.replace(/-./g, m => m[1].toUpperCase());
    const str = v => v == null ? '' : typeof v == 'object' ? JSON.stringify(v) : String(v);
    // ".debounce.300ms": the time after the modifier, 300 ms when it has none
    const delay = (mods, name) => {
        let i = mods.indexOf(name);
        if (i >= 0) return /^\d+m?s$/.test(mods[i + 1]) ? ypy.parseInterval(mods[i + 1]) : 300;
    };

    // An effect: runs now and again, in a batch, when a signal it read changes
    function fx(rec, elt, fn) {
        let n = new Node(fn, elt, 1);
        rec.nodes.push(n);
        n.run();
        return n;
    }

    function setAttr(elt, name, v) {
        let url = /^(?:href|src|action|formaction|xlink:href|poster)$/i.test(name) && /^[\s\x00-\x20]*(?:javascript|vbscript):/i.test(String(v));
        if (/^(?:on|srcdoc$|(?:data-)?ypy-)/i.test(name) || url) throw E('blocked attribute ' + name);
        v === false || v == null ? elt.removeAttribute(name) : elt.setAttribute(name, v === true ? '' : v);
    }

    // ypy-class and ypy-attr: "name" is in the attribute (ypy-class:name="$on") or the value is an object
    function pairs(rec, elt, k, src, apply) {
        let f = compile(src, 0);
        fx(rec, elt, () => {
            let x = f(ctx(elt));
            if (k) apply(k, x);
            else for (let [a, b] of Object.entries(x && typeof x == 'object' ? x : {})) apply(a, b);
        });
    }

    function declare(rec, elt, text, mods) {
        let s = scopeOf(elt), srv = mods.includes('server'), kind = mods.find(m => /^(?:local|session)$/.test(m)), store, stored = {};
        let id = elt.id, key = FIELD + ':' + id;
        rec.scope = s;
        let obj = compile(/^\s*\{/.test(text) ? text : `{${text}}`, 2)({ch: [s], el: elt});
        if (kind) {
            if (!id) console.warn('ypy: signals: persisting needs an id');
            else try { store = window[kind + 'Storage']; stored = JSON.parse(store.getItem(key)) || {} } catch { store = null }
        }
        let keys = Object.keys(obj);
        for (let k of keys) {
            let n = s.cells.get(k);
            if (!n) { n = add(s, k, obj[k], srv); if (!srv && Object.hasOwn(stored, k)) n.set(stored[k]) }
            else if (srv) { n.ro = true; n.set(obj[k]); rebase(s, k) }   // the server is the authority over its keys
        }
        if (store && !srv) fx(rec, elt, () => {
            let o = {};
            for (let k of keys) o[k] = s.cells.get(k)?.get();
            try { store.setItem(key, JSON.stringify(o)) } catch {}
        });
    }

    function bind(rec, elt, path, mods) {
        let [name, ...keys] = path.replace(/^\$/, '').split('.');
        let type = elt.type, check = type == 'checkbox', radio = type == 'radio', multi = elt.multiple, edit = elt.isContentEditable && !('value' in elt);
        let prop = edit ? 'textContent' : 'value', cur = () => read(chainOf(elt), name, keys), timer = 0;
        let dom = () => check ? elt.checked : radio ? elt.value : multi ? [...elt.selectedOptions].map(o => o.value) : elt[prop];
        let commit = () => {
            clearTimeout(timer);
            timer = 0;
            pending.delete(commit);
            if (radio && !elt.checked) return;
            let v = dom();
            if (typeof cur() == 'number' && !check && !multi) v = Number(v);
            if (!write(chainOf(elt), name, keys, v, elt)) paint.run();   // read-only: show the signal again
        };
        let paint = fx(rec, elt, () => {
            let v = cur();
            if (check) elt.checked = !!v;
            else if (radio) elt.checked = v == elt.value;
            else if (multi) for (let o of elt.options) o.selected = Array.isArray(v) && v.includes(o.value);
            else if (elt[prop] != (v ?? '')) elt[prop] = v ?? '';
        });
        let listen = (ev, f) => elt.addEventListener(ev, f, {signal: rec.ac.signal});
        let wait = delay(mods, 'debounce') ?? delay(mods, 'throttle'), debounce = mods.includes('debounce');
        listen('input', () => {
            pending.add(commit);
            if (mods.includes('live')) commit();
            else if (wait != null) { if (debounce) clearTimeout(timer); if (debounce || !timer) timer = setTimeout(commit, wait) }
        });
        listen(mods.includes('blur') ? 'blur' : 'change', commit);
        rec.ends.push(() => { clearTimeout(timer); pending.delete(commit) });
    }

    function on(rec, elt, event, mods, src) {
        if (!event) throw E('ypy-on needs :event');
        let f = compile(src, 1), debounce = delay(mods, 'debounce'), throttle = delay(mods, 'throttle'), timer = 0;
        let go = e => {
            let t = e.target;
            try {
                f({ch: chainOf(elt), el: elt, ev: {type: e.type, key: e.key, code: e.code, detail: e.detail, value: t?.value, checked: t?.checked,
                    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey}});
            } catch (error) { fail(elt, error) }
        };
        let h = e => {
            if (!elt.isConnected) return rec.ac.abort();   // a window listener of an element that left without a cleanup
            if (mods.includes('prevent')) e.preventDefault();
            if (mods.includes('stop')) e.stopPropagation();
            if (debounce != null) { clearTimeout(timer); timer = setTimeout(go, debounce, e) }
            else if (throttle != null) { if (!timer) { go(e); timer = setTimeout(() => timer = 0, throttle) } }
            else go(e);
        };
        // capture: on the element itself it runs before the request the same element may start
        (mods.includes('window') ? window : elt).addEventListener(event[0] == ':' ? 'ypy' + event : event, h,
            {signal: rec.ac.signal, once: mods.includes('once'), capture: true});
        rec.ends.push(() => clearTimeout(timer));
    }

    const HANDLERS = {
        signals: (rec, elt, k, mods, v) => declare(rec, elt, v, mods),
        computed: (rec, elt, k, mods, v) => {
            let s = up(elt)[0], f = compile(v, 0), name = camel(k || '');
            if (!s) throw E('no scope');
            if (s.cells.has(name)) throw E('duplicate ' + name);
            let n = add(s, name, undefined, true);
            n.fn = () => f(ctx(elt));
            n.stale = true;
            live++;
            n.home = [s, name];
            rec.nodes.push(n);
        },
        bind: (rec, elt, k, mods, v) => bind(rec, elt, k ? camel(k) : v.trim(), mods),
        text: (rec, elt, k, mods, v) => { let f = compile(v, 0); fx(rec, elt, () => { let s = str(f(ctx(elt))); if (elt.textContent !== s) elt.textContent = s }) },
        show: (rec, elt, k, mods, v) => { let f = compile(v, 0); fx(rec, elt, () => { elt.style.display = f(ctx(elt)) ? '' : 'none' }) },
        class: (rec, elt, k, mods, v) => pairs(rec, elt, k, v, (c, on) => elt.classList.toggle(c, !!on)),
        attr: (rec, elt, k, mods, v) => pairs(rec, elt, k, v, (n, x) => setAttr(elt, n, x)),
        on
    };

    function off(rec) {
        rec.ac.abort();
        rec.ends.forEach(f => f());
        for (let n of rec.nodes) {
            n.kill();
            if (n.home && n.home[0].cells.get(n.home[1]) === n) { n.home[0].cells.delete(n.home[1]); n.home[0].shape.set(n.home[0].shape.v + 1) }
        }
    }

    // Reads the signal attributes of an element and sets up what they say. The element keeps its
    // record while its attributes stay the same, so a morph that leaves them alone only repaints.
    function wire(elt) {
        if (elt.closest(IGNORE)) return;
        let list = [];
        for (let a of elt.attributes) {
            let m = ATTR.exec(a.name);
            if (m) list.push([m[1], m[2], m[3].split('.').slice(1), a.value]);
        }
        let key = JSON.stringify(list), rec = recs.get(elt);
        if (rec?.key == key) return rec.nodes.forEach(n => n.eff && (n.stale = true, n.run()));
        if (rec) { off(rec); recs.delete(elt) }
        if (!list.length) return;
        recs.set(elt, rec = {key, ac: new AbortController(), nodes: [], ends: [], scope: null});
        api.ypyProp(elt);
        list.sort((a, b) => Math.min(KINDS.indexOf(a[0]), 2) - Math.min(KINDS.indexOf(b[0]), 2));
        for (let [kind, k, mods, v] of list) {
            try { HANDLERS[kind](rec, elt, k, mods, v) } catch (e) { fail(elt, e) }
        }
        let s = rec.scope;
        if (s) fx(rec, elt, () => {   // unsaved state: any client-owned signal that differs from what was last saved
            let dirty = false;
            s.shape.get();
            for (let [k, n] of s.cells) if (!n.ro && k[0] != '_' && JSON.stringify(n.get()) != s.base[k]) { dirty = true; break }
            s.cells.get('_dirty').set(dirty);
            for (let c of (ypy.config.classes?.dirty || 'ypy-dirty').split(/\s+/)) elt.classList.toggle(c, dirty);
            // data-ypy-state holds a list of states (the core's convention); the morph leaves it alone
            let states = (elt.dataset.ypyState || '').split(' ').filter(x => x && x != 'dirty');
            if (dirty) states.push('dirty');
            states[0] ? elt.dataset.ypyState = states.join(' ') : delete elt.dataset.ypyState;
        });
    }

    function scan(root) {
        let r = document.evaluate(xp(KINDS), root, null, 7);
        for (let i = 0; i < r.snapshotLength; i++) wire(r.snapshotItem(i));
    }

    const hasAttr = (elt, re) => elt.getAttributeNames().some(n => re.test(n));
    // Is the element inside a scope that is declared in the markup (it may not be wired yet)?
    const inScope = elt => { for (let p = elt; p; p = p.parentElement) if (hasAttr(p, /^(?:data-)?ypy-signals(?:\.|$)/)) return true };

    //============================================================================================
    // Public API: ypy.signals
    //============================================================================================

    const path = p => p.replace(/^\$/, '').split('.');
    ypy.signals = {
        /** Makes fn callable from expressions as name(...). */
        register(name, fn) {
            if (!/^[A-Za-z_]\w*$/.test(name) || typeof fn != 'function') throw new TypeError('register(name, fn)');
            fns.set(name, fn);
        },
        /** The value at a path such as "user.name", seen from elt (default: the page). */
        get(p, elt = document.body) { let [n, ...k] = path(p); return read(chainOf(elt), n, k) },
        /** Applies a JSON Merge Patch the way a server response does; onlyIfMissing skips signals that exist. */
        patch(p, elt = document.body, onlyIfMissing) { patch(chainOf(elt), p, elt, onlyIfMissing) },
        /** Live reactive nodes and uncommitted bindings, for leak tests and tooling. */
        stats: () => ({nodes: live, pending: pending.size})
    };

    ypy.registerExtension('ypy-signals', {
        init(internalApi) { api = internalApi },

        ypy_after_process(root) { scan(root) },

        // Inside a scope, ypy-on takes expressions, not JavaScript: the extension runs them, the core does not
        ypy_before_on_init(elt) {
            if (hasAttr(elt, /^(?:data-)?ypy-on(?:[:.]|$)/) && inScope(elt)) return false;
        },

        ypy_before_cleanup(elt) {
            let rec = recs.get(elt);
            if (rec) { off(rec); recs.delete(elt) }
        },

        // The signals go with a same-origin request only when asked: ypy-signals-send (nearest wins) or config signals.send
        ypy_config_request(elt, {ctx}) {
            let r = ctx.request, v = api.attributeValue(elt, 'ypy-signals-send') ?? ypy.config.signals?.send;
            if (v == null || v === false || v == 'false') return;
            try { if (new URL(r.action, document.baseURI).origin != origin) return } catch { return }
            [...pending].forEach(commit => commit());
            let o = {};
            for (let s of chainOf(elt).reverse()) for (let [k, n] of s.cells) if (!n.fn && k[0] != '_') o[k] = n.v;
            if (!Object.keys(o).length) return;
            try { r.body?.set?.(FIELD, JSON.stringify(o, (k, v) => k[0] == '_' ? undefined : v)) } catch (e) { return fail(elt, e), false }
        },

        // JSON is a patch, not markup; a saved form (2xx to anything but a GET) is not "unsaved" any more
        ypy_after_request(elt, {ctx}) {
            let res = ctx.response, json = /^application\/(?:[^;]*\+)?json/i.test(res.headers?.get?.('Content-Type') ?? ''), ch = chainOf(elt);
            if (json) {
                try {
                    let p = JSON.parse(ctx.text);
                    if (!p || typeof p != 'object' || Array.isArray(p)) throw E('patch must be an object');
                    patch(ch, p, elt);
                } catch (e) { fail(elt, e) }
            }
            if (res.status >= 200 && res.status < 300 && !/^GET$/i.test(ctx.request.method)) ch.forEach(s => rebase(s));
            if (json) return false;
        }
    });

    if (document.readyState != 'loading' && document.body) queueMicrotask(() => scan(document.body));
})();
