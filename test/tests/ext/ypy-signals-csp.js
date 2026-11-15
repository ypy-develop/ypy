// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// The extension on a page that forbids eval, inline script and inline style, with Trusted Types
// enforced and callbacks:"none": nothing in it compiles code, so it all works.
describe('ypy-signals under a strict CSP and callbacks "none"', function () {

    const N = 'page-nonce';
    const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'nonce-${N}'; style-src 'self'; require-trusted-types-for 'script'; trusted-types ypy">`;
    const CONFIG = `<meta name="ypy-config" content='callbacks:"none"'>`;
    const SCRIPTS = ['/src/ypy.js', '/src/ext/ypy-signals.js'];
    let page;
    afterEach(function () { page?.close(); page = null });

    const tick = () => new Promise(resolve => page.win.setTimeout(resolve, 20));
    const q = selector => page.doc.querySelector(selector);

    async function open(body) {
        page = await openPage({head: CSP + CONFIG, body, nonce: N, scripts: SCRIPTS});
        return page;
    }

    it('the page really forbids eval and new Function', async function () {
        await open('');
        assert.throws(() => page.win.eval('1'));
        assert.throws(() => new page.win.Function('return 1'));
        page.win.ypy.config.callbacks.should.equal('none');
    });

    it('declares, computes, shows, classes, attributes and binds', async function () {
        await open(`<div ypy-signals="n:2, name:'Ana', on:true" ypy-computed:sq="$n * $n">
            <b id="t" ypy-text="$name + ' ' + $sq"></b>
            <i id="s" ypy-show="!$on"></i>
            <u id="c" ypy-class:hot="$n > 1" ypy-attr:title="$name"></u>
            <input id="in" ypy-bind.live="name">
            <button id="b" ypy-on:click="$n++; $name = $name + '!'">go</button>
        </div>`);
        q('#t').textContent.should.equal('Ana 4');
        q('#s').style.display.should.equal('none');
        q('#c').classList.contains('hot').should.equal(true);
        q('#c').getAttribute('title').should.equal('Ana');
        q('#in').value.should.equal('Ana');
        q('#b').click();
        await tick();
        q('#t').textContent.should.equal('Ana! 9');
        q('#in').value.should.equal('Ana!');
        q('#in').value = 'Bo';
        q('#in').dispatchEvent(new page.win.Event('input', {bubbles: true}));
        await tick();
        q('#t').textContent.should.equal('Bo 9');
        assert.deepEqual(page.logs.filter(l => !/did not match/.test(l)), []);
    });

    it('ypy-on is not compiled as JavaScript and nothing is reported as blocked code', async function () {
        let blocked = 0;
        page = await openPage({head: CSP + CONFIG, body: '', nonce: N, scripts: SCRIPTS});
        page.doc.addEventListener('ypy:security:blocked', () => blocked++);
        let scope = page.doc.createElement('div');
        scope.setAttribute('ypy-signals', 'n:0');
        let button = page.doc.createElement('button');
        button.setAttribute('ypy-on:click', '$n = $n + 1');
        let out = page.doc.createElement('b');
        out.setAttribute('ypy-text', '$n');
        scope.append(button, out);
        page.doc.body.append(scope);
        page.win.ypy.process(page.doc.body);
        button.click();
        await tick();
        out.textContent.should.equal('1');
        blocked.should.equal(0);
    });

    it('sends the signals and applies a JSON patch, with a real Response', async function () {
        await open(`<div ypy-signals="a:1, _local:9, user:{name:'x'}">
            <button id="g" ypy-get="/g">g</button><button id="p" ypy-post="/p">p</button>
            <b id="t" ypy-text="$a + ':' + $user.name"></b>
        </div>`);
        let calls = [];
        page.win.fetch = async (url, options) => {
            calls.push({url, options});
            return new page.win.Response('{"a":2,"user":{"name":"y"}}', {headers: {'Content-Type': 'application/json'}});
        };
        let done = () => new Promise(resolve => page.doc.addEventListener('ypy:finally:request', resolve, {once: true}));
        let wait = done();
        q('#g').click();
        await wait;
        await tick();
        JSON.parse(new page.win.URL(calls[0].url, page.win.location.href).searchParams.get('ypy-signals')).should.deep.equal({a: 1, user: {name: 'x'}});
        q('#t').textContent.should.equal('2:y');
        wait = done();
        q('#p').click();
        await wait;
        JSON.parse(calls[1].options.body.get('ypy-signals')).should.deep.equal({a: 2, user: {name: 'y'}});
    });

    it('persists to localStorage without eval', async function () {
        await open(`<div id="persist" ypy-signals.session="n:1"><button id="b" ypy-on:click="$n++">+</button></div>`);
        q('#b').click();
        await tick();
        JSON.parse(page.win.sessionStorage.getItem('ypy-signals:persist')).n.should.equal(2);
    });

    it('also works when callbacks is "all" is not needed: the setting does not matter to the extension', async function () {
        page = await openPage({head: CSP + `<meta name="ypy-config" content='callbacks:"nonce"'>`, body: `<div ypy-signals="n:3"><b id="t" ypy-text="$n * 2"></b></div>`, nonce: N, scripts: SCRIPTS});
        q('#t').textContent.should.equal('6');
    });
});
