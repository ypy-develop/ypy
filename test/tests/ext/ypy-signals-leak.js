// SPDX-License-Identifier: MIT
// What the extension sets up for an element goes away with the element: 500 swaps leave nothing behind.
describe('ypy-signals cleanup', function () {

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
        ypy.signals.register('hit', () => hits++);
    });

    let hits = 0;
    after(() => { restoreExtensions(extBackup) });
    beforeEach(() => { setupTest(this.currentTest) });
    afterEach(() => { cleanupTest(); try { localStorage.clear() } catch {} });

    const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() };

    // every kind of attribute, a window listener and a debounced binding
    const CONTENT = `<div class="row" ypy-computed:twice="$n * 2">
        <input ypy-bind.debounce.50ms="n"><b ypy-text="$twice"></b><i ypy-show="$n > 0" ypy-class:on="$n > 1" ypy-attr:title="$n"></i>
        <button ypy-on:click="$n++" ypy-on:sig-resize.window="hit()">go</button>
    </div>`;

    for (let style of ['innerHTML', 'innerMorph', 'outerHTML']) {
        it(`500 swaps (${style}) leave the same number of reactive nodes and no listener`, async function () {
            this.timeout(30000);
            mockResponse('GET', '/row', style == 'outerHTML' ? `<div id="box" ypy-signals="n:1">${CONTENT}</div>` : CONTENT);
            createProcessedHTML(`<div id="host" ypy-signals="n:1"><div id="box">${style == 'outerHTML' ? '' : CONTENT}</div><button id="swap" ypy-get="/row" ypy-target="#box" ypy-swap="${style}">swap</button></div>`);
            if (style == 'outerHTML') {
                find('#box').outerHTML = `<div id="box" ypy-signals="n:1">${CONTENT}</div>`;
                ypy.process(playground());
            }
            {
                await tick();
                let baseline = ypy.signals.stats();
                baseline.nodes.should.be.above(5);
                for (let i = 0; i < 500; i++) {
                    find('#swap').click();
                    await forRequest(1000);
                }
                await tick();
                let after = ypy.signals.stats();
                after.nodes.should.equal(baseline.nodes);
                after.pending.should.equal(0);
                hits = 0;
                window.dispatchEvent(new Event('sig-resize'));
                hits.should.equal(1);                                // one live listener, not 500
                find('#box b').textContent.should.equal('2');       // and the content still works
            }
        });
    }

    it('nodes of an element that leaves the page without a cleanup die at their next run', async function () {
        createProcessedHTML(`<div ypy-signals="n:1"><b id="x" ypy-text="$n"></b></div>`);
        let before = ypy.signals.stats().nodes;
        before.should.be.above(0);
        let scope = playground().firstElementChild;
        let x = find('#x');
        x.remove();                                      // nobody told the core
        ypy.signals.patch({n: 2}, scope);
        await tick();
        ypy.signals.stats().nodes.should.be.below(before);
    });

    it('a pending debounced binding is dropped with its element', async function () {
        createProcessedHTML(`<div ypy-signals="n:''"><input id="i" ypy-bind.debounce.5s="n"></div>`);
        find('#i').value = 'x';
        find('#i').dispatchEvent(new Event('input', {bubbles: true}));
        ypy.signals.stats().pending.should.equal(1);
        ypy.process(playground(), true);
        ypy.signals.stats().pending.should.equal(0);
    });
});
