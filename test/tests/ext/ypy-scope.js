// SPDX-License-Identifier: MIT
describe('ypy-scope extension', function() {

    let extBackup, realLayers;

    before(async () => {
        extBackup = backupExtensions();
        clearExtensions();
        let script = document.createElement('script');
        script.src = '../src/ext/ypy-scope.js';
        await new Promise(resolve => {
            script.onload = resolve;
            document.head.appendChild(script);
        });
        realLayers = ypy.layers;
    })

    after(() => {
        restoreExtensions(extBackup);
        ypy.layers = realLayers;
    })

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        ypy.layers = realLayers;
        cleanupTest(this.currentTest)
    })

    describe('the core hook', function() {

        // one probe for the whole file: in dist/ an extension cannot be unregistered
        let probe;
        before(() => {
            ypy.registerExtension('ypy-scope-probe', {ypy_resolve_target: (elt, selector) => probe?.(elt, selector)});
        })
        afterEach(() => { probe = null })

        it('is asked before a selector falls to querySelectorAll, with the context element and the selector', function() {
            let div = createProcessedHTML('<div id="a"><p class="x">x</p></div>');
            let calls = [];
            probe = (elt, selector) => { calls.push([elt, selector]) };
            assert.equal(ypy.findAll(div, '.x').length, 1)
            assert.deepEqual(calls.map(c => c[1]), ['.x'])
            assert.strictEqual(calls[0][0], div)
        })

        it('is not asked for a keyword the core knows', function() {
            let div = createProcessedHTML('<div id="a"><p class="x">x</p></div>');
            let calls = 0;
            probe = () => { calls++ };
            ypy.findAll(div, 'self, parent, find .x')
            assert.equal(calls, 0)
        })

        it('accepts an element, an array, a NodeList, null (nothing) and undefined (not mine)', function() {
            let div = createProcessedHTML('<div id="a"><p class="x">x</p><p class="y">y</p></div>');
            let answers = {
                'one-elt': div.firstElementChild,
                'many-arr': [div.firstElementChild, div.lastElementChild],
                'many-list': div.querySelectorAll('p'),
                'none': null
            };
            probe = (elt, selector) => Object.hasOwn(answers, selector) ? answers[selector] : undefined;
            assert.equal(ypy.findAll(div, 'one-elt').length, 1)
            assert.equal(ypy.findAll(div, 'many-arr').length, 2)
            assert.equal(ypy.findAll(div, 'many-list').length, 2)
            assert.equal(ypy.findAll(div, 'none').length, 0)
            assert.equal(ypy.findAll(div, '.x').length, 1)
        })
    })

    describe('scope', function() {

        it('swaps into the closest ypy-scope element', async function() {
            mockResponse('GET', '/s', 'Saved')
            let section = createProcessedHTML('<section ypy-scope id="s"><div><button ypy-get="/s" ypy-target="scope" ypy-swap="innerHTML">Go</button></div></section>');
            section.querySelector('button').click()
            await forRequest()
            assert.equal(section.textContent, 'Saved')
        })

        it('is the element itself when it carries the attribute, and the data- spelling counts', function() {
            let section = createProcessedHTML('<div data-ypy-scope id="s"><button id="b">x</button></div>');
            assert.strictEqual(ypy.find(section, 'scope'), section)
            assert.strictEqual(ypy.find(section.querySelector('#b'), 'scope'), section)
        })

        it('takes the closest of nested scopes', function() {
            let outer = createProcessedHTML('<div ypy-scope id="o"><div ypy-scope id="i"><b id="b">x</b></div></div>');
            assert.equal(ypy.find(outer.querySelector('#b'), 'scope').id, 'i')
        })

        it('finds nothing, and does not fall to a tag selector, without a scope', function() {
            let div = createProcessedHTML('<div><b id="b">x</b></div>');
            assert.equal(ypy.findAll(div.firstElementChild, 'scope').length, 0)
        })

        it('`scope <selector>` searches inside the scope', function() {
            let section = createProcessedHTML('<section ypy-scope><i class="hint">1</i><div><button id="b">x</button></div></section><i class="hint">outside</i>');
            let found = ypy.findAll(section.querySelector('#b'), 'scope .hint')
            assert.equal(found.length, 1)
            assert.equal(found[0].textContent, '1')
        })

        it('goes on from the host when the element sits in a shadow root', function() {
            let host = createProcessedHTML('<div ypy-scope id="h"><div id="inner"></div></div>').querySelector('#inner');
            let root = host.attachShadow({mode: 'open'});
            root.innerHTML = '<p id="deep">x</p>';
            assert.equal(ypy.find(root.querySelector('#deep'), 'scope').id, 'h')
        })

        it('works as a selector of ypy-indicator and next to ordinary selectors', function() {
            let section = createProcessedHTML('<section ypy-scope id="s"><button id="b">x</button><i class="k">k</i></section>');
            let found = ypy.findAll(section.querySelector('#b'), 'scope, .k')
            assert.sameMembers(found.map(e => e.localName), ['section', 'i'])
        })
    })

    describe('layer', function() {

        it('is the element of the topmost layer of ypy-layers', function() {
            let dialog = document.createElement('div');
            dialog.innerHTML = '<span class="in">x</span>';
            ypy.layers = {top: () => ({element: dialog})};
            let div = createProcessedHTML('<div id="d"></div>');
            assert.strictEqual(ypy.find(div, 'layer'), dialog)
            assert.equal(ypy.findAll(div, 'layer .in').length, 1)
        })

        it('finds nothing when no layer is open or ypy-layers is not loaded', function() {
            let div = createProcessedHTML('<div id="d"></div>');
            ypy.layers = undefined;
            assert.equal(ypy.findAll(div, 'layer').length, 0)
            ypy.layers = {top: () => undefined};
            assert.equal(ypy.findAll(div, 'layer').length, 0)
            assert.equal(ypy.findAll(div, 'layer .in').length, 0)
        })
    })

    describe('shadow:', function() {

        function build() {
            let host = createProcessedHTML(
                '<div id="host"><b class="t" id="slotted" slot="a">slotted</b><b class="t" id="unslotted" slot="nowhere">unslotted</b><b class="t" id="light">light</b></div>');
            let root = host.attachShadow({mode: 'open'});
            root.innerHTML = '<b class="t" id="s1">s1</b><slot name="a"></slot><div id="wrap"><i class="t" id="s2">s2</i><slot><b class="t" id="fallback">fb</b></slot></div><section id="inner-host"></section>';
            let nested = root.querySelector('#inner-host').attachShadow({mode: 'open'});
            nested.innerHTML = '<b class="t" id="n1">n1</b>';
            let closedHost = document.createElement('div');
            closedHost.attachShadow({mode: 'closed'}).innerHTML = '<b class="t" id="hidden">h</b>';
            root.append(closedHost);
            return host;
        }

        it('enters the open shadow roots, nested ones too', function() {
            let ids = ypy.findAll(build(), 'shadow:.t').map(e => e.id)
            assert.includeMembers(ids, ['s1', 's2', 'n1'])
        })

        it('respects the slots: what a slot shows is found, what none shows is not', function() {
            let ids = ypy.findAll(build(), 'shadow:.t').map(e => e.id)
            assert.include(ids, 'slotted')
            assert.include(ids, 'light')            // the default slot shows it
            assert.notInclude(ids, 'unslotted')     // slot="nowhere": no slot, not rendered
            assert.notInclude(ids, 'fallback')      // the default slot has content assigned, so its own is not shown
        })

        it('shows the content of a slot with nothing assigned', function() {
            let host = createProcessedHTML('<div id="host"></div>');
            host.attachShadow({mode: 'open'}).innerHTML = '<slot><b class="t" id="fallback">fb</b></slot>';
            assert.deepEqual(ypy.findAll(host, 'shadow:.t').map(e => e.id), ['fallback'])
        })

        it('does not enter a closed shadow root and does not match the element itself', function() {
            let host = build();
            host.classList.add('t')
            let ids = ypy.findAll(host, 'shadow:.t').map(e => e.id)
            assert.notInclude(ids, 'hidden')
            assert.notInclude(ids, 'host')
        })

        it('works from the document and in ypy-target', async function() {
            mockResponse('GET', '/s', 'Done')
            let host = createProcessedHTML('<div id="host"><button id="b" ypy-get="/s" ypy-target="shadow:#n1" ypy-swap="innerHTML">Go</button></div>');
            host.attachShadow({mode: 'open'}).innerHTML = '<p id="n1">old</p>';
            host.querySelector('#b').click()
            // the button is in the light DOM of the host and no slot shows it: the search starts from the button itself
            assert.equal(ypy.findAll(host.querySelector('#b'), 'shadow:#n1').length, 0)
            assert.equal(ypy.findAll(host, 'shadow:#n1').length, 1)
            assert.equal(ypy.findAll(document, 'shadow:#n1').length, 1)
            await ypy.timeout(30)
        })
    })

    it('leaves selectors it does not know to the core', function() {
        let div = createProcessedHTML('<div id="d"><scoped class="x">a</scoped><p id="p">b</p></div>');
        assert.equal(ypy.findAll(div, '#p').length, 1)
        assert.equal(ypy.findAll(div, 'scoped').length, 1)
        assert.equal(ypy.findAll(div, '.x, #p').length, 2)
    })
})
