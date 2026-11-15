// SPDX-License-Identifier: MIT
import {openPage} from '../../lib/security-frame.js'

// Each test opens a fresh page: the extension replaces registerExtension and starts an observer, and
// ypy:ready fires once per page.
describe('ypy-boot extension', function () {

    const BOOT = ['/src/ypy.js', '/src/ext/ypy-boot.js'];
    let page;
    afterEach(function () { page?.close(); page = null });

    const q = selector => page.doc.querySelector(selector);
    const tick = (ms = 30) => new Promise(resolve => page.win.setTimeout(resolve, ms));
    async function open(body = '', scripts = BOOT) {
        page = await openPage({body, scripts});
        return page;
    }
    const respond = html => { page.win.fetch = async () => new page.win.Response(html, {status: 200, headers: {'Content-Type': 'text/html'}}) };

    describe('dependencies', function () {
        it('supports the extension by name, by name@major and what it provides', async function () {
            await open();
            let ypy = page.win.ypy;
            ypy.registerExtension('one', {version: '2.1.0', provides: ['expr@1', 'other@3']});
            ypy.registerExtension('plain', {});
            ypy.supports('one').should.equal(true);
            ypy.supports('one@2').should.equal(true);
            ypy.supports('one@1').should.equal(false);
            ypy.supports('expr@1').should.equal(true);
            ypy.supports('other@3').should.equal(true);
            ypy.supports('plain@1').should.equal(true);
            ypy.supports('nope').should.equal(false);
            ypy.supports('expr@2').should.equal(false);
            ypy.supports('ypy-boot').should.equal(true);
            ypy.supports('core@1').should.equal(true);
        });

        it('refuses an extension whose requirement is missing, with a warning, and takes it when it arrives', async function () {
            await open();
            let ypy = page.win.ypy, hooked = 0, inits = 0;
            let ext = {requires: ['base@1'], init() { inits++ }, ypy_after_process() { hooked++ }};
            ypy.registerExtension('needy', ext).should.equal(false);
            ypy.supports('needy').should.equal(false);
            inits.should.equal(0);
            assert.isTrue(page.logs.some(l => /needy needs base@1/.test(l)), page.logs.join('|'));
            ypy.registerExtension('base', {version: 1});
            assert.notStrictEqual(ypy.registerExtension('needy', ext), false);
            inits.should.equal(1);
            ypy.supports('needy').should.equal(true);
            ypy.process(page.doc.body, true);
            hooked.should.equal(1);
        });

        it('a requirement by version: a major that is not there is missing', async function () {
            await open();
            let ypy = page.win.ypy;
            ypy.registerExtension('base', {version: '2.0.0'});
            ypy.registerExtension('old', {requires: ['base@1']}).should.equal(false);
            assert.notStrictEqual(ypy.registerExtension('new', {requires: ['base@2']}), false);
        });

        it('an extension that was already registered stays refused as a duplicate', async function () {
            await open();
            let ypy = page.win.ypy;
            assert.notStrictEqual(ypy.registerExtension('once', {}), false);
            ypy.registerExtension('once', {}).should.equal(false);
        });

        it('works with a real extension: ypy-expr requires and provides', async function () {
            await open('', [...BOOT, '/src/ext/ypy-targets.js', '/src/ext/ypy-expr.js']);
            let ypy = page.win.ypy;
            ypy.supports('ypy-targets').should.equal(true);
            ypy.supports('expr@1').should.equal(true);
            ypy.supports('ypy-expr@1').should.equal(true);
        });
    });

    describe('ypy:ready', function () {
        const LISTEN = `<script>window.__ready = 0; document.addEventListener('ypy:ready', e => { window.__ready++; window.__readyBody = document.body.dataset.ypyPowered })</script>`;

        it('fires once, after the first process', async function () {
            await open(LISTEN + '<button id="b" ypy-get="/x">go</button>');
            page.win.__ready.should.equal(1);
            assert.isDefined(q('#b')._ypy, 'the page was processed before the event');
            page.win.ypy.process(page.doc.body, true);
            page.win.ypy.process(q('#b'));
            page.win.__ready.should.equal(1);
        });

        it('does not fire without the extension', async function () {
            await open(LISTEN, ['/src/ypy.js']);
            page.win.__ready.should.equal(0);
        });
    });

    describe('ypy-ignore on a live element', function () {
        it('tears the element down when the attribute is set and starts it again when it is removed', async function () {
            await open('<button id="b" ypy-get="/x">go</button>');
            let requests = 0;
            q('#b').addEventListener('ypy:before:request', () => { requests++; return false });
            q('#b').click();
            requests.should.equal(1);
            q('#b').setAttribute('ypy-ignore', '');
            await tick();
            q('#b').click();
            requests.should.equal(1);
            q('#b').removeAttribute('ypy-ignore');
            await tick();
            q('#b').click();
            requests.should.equal(2);
        });

        it('covers the descendants and the data- spelling', async function () {
            await open('<div id="w"><button id="b" ypy-get="/x">go</button></div>');
            let requests = 0;
            q('#b').addEventListener('ypy:before:request', () => { requests++; return false });
            q('#w').setAttribute('data-ypy-ignore', '');
            await tick();
            q('#b').click();
            requests.should.equal(0);
        });

        it('without the extension the attribute does not undo what was processed', async function () {
            await open('<button id="b" ypy-get="/x">go</button>', ['/src/ypy.js']);
            let requests = 0;
            q('#b').addEventListener('ypy:before:request', () => { requests++; return false });
            q('#b').setAttribute('ypy-ignore', '');
            await tick();
            q('#b').click();
            requests.should.equal(1);
        });
    });

    describe('the focus of a #fragment', function () {
        const PAGE = '<button id="b" ypy-get="/page#sec" ypy-target="#out" ypy-swap="innerHTML">go</button><div id="out"></div>';

        it('moves to the revealed element, which gets a tabindex while it has the focus', async function () {
            await open(PAGE);
            respond('<h2 id="sec">Section</h2><p>text</p>');
            q('#b').click();
            await tick(80);
            page.doc.activeElement.id.should.equal('sec');
            q('#sec').getAttribute('tabindex').should.equal('-1');
            q('#b').focus();
            await tick();
            assert.isFalse(q('#sec').hasAttribute('tabindex'));
        });

        it('leaves the focus alone when the request has an ypy-focus', async function () {
            await open(PAGE.replace('ypy-swap', 'ypy-focus="none" ypy-swap'));
            respond('<h2 id="sec">Section</h2>');
            q('#b').focus();
            q('#b').click();
            await tick(80);
            page.doc.activeElement.id.should.equal('b');
        });

        it('does nothing for a request without a fragment', async function () {
            await open(PAGE.replace('/page#sec', '/page'));
            respond('<h2 id="sec">Section</h2>');
            q('#b').focus();
            q('#b').click();
            await tick(80);
            page.doc.activeElement.id.should.equal('b');
        });

        it('without the extension the element is revealed but not focused', async function () {
            await open(PAGE, ['/src/ypy.js']);
            respond('<h2 id="sec">Section</h2>');
            q('#b').focus();
            q('#b').click();
            await tick(80);
            page.doc.activeElement.id.should.equal('b');
        });
    });
});
