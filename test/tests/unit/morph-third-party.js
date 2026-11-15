// SPDX-License-Identifier: MIT
// TASK-017: the morph does not touch what a script other than YPY manages: custom elements that draw
// into themselves, roots of React, Vue and Alpine, components of Bootstrap and Bulma; and
// ypy.onLoad(selector, fn) starts a script's components once per element.
describe('Morph and third-party elements', function() {

    // a Custom Element that changes its own DOM (no shadow root), like a chart or an editor
    if (!customElements.get('t017-draw')) {
        customElements.define('t017-draw', class extends HTMLElement {
            connectedCallback() {
                if (!this.querySelector('.drawn')) {
                    this.innerHTML = '<span class="drawn">drawn</span>';
                }
            }
        });
    }

    let saved;
    beforeEach(function() { saved = ypy.config.morphThirdParty; });
    afterEach(function() {
        ypy.config.morphThirdParty = saved;
        cleanupTest();
    });

    async function morph(response, box, {style = 'innerMorph'} = {}) {
        mockResponse('GET', '/test', response);
        createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="' + style + '">Go</button>' + box + '</div>');
        find('button').click();
        await forRequest();
    }

    describe('custom elements and third-party roots', function() {
        beforeEach(function() { setupTest(this); });

        it('keeps what a custom element drew when the response gives it empty', async function() {
            let box = '<div id="box"><t017-draw id="w" label="a"></t017-draw></div>';
            mockResponse('GET', '/test', '<t017-draw id="w" label="b"></t017-draw>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerMorph">Go</button>' + box + '</div>');
            let drawn = find('#w .drawn');
            assert.exists(drawn);
            find('button').click();
            await forRequest();
            assert.strictEqual(find('#w .drawn'), drawn);
            assert.equal(find('#w').getAttribute('label'), 'b', 'the attributes still follow the response');
        });

        it('keeps it with whitespace as the whole content', async function() {
            await morph('<t017-draw id="w">\n  </t017-draw>', '<div id="box"><t017-draw id="w"></t017-draw></div>');
            assert.equal(find('#w').textContent, 'drawn');
        });

        it('keeps it in an out-of-band swap', async function() {
            mockResponse('GET', '/test', '<p>x</p><t017-draw id="w" ypy-swap-oob="true"></t017-draw>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box">Go</button><div id="box"></div>' +
                '<t017-draw id="w"></t017-draw></div>');
            find('button').click();
            await forRequest();
            assert.equal(find('#w').textContent, 'drawn');
        });

        it('morphs the children of a custom element when the response has content', async function() {
            await morph('<t017-draw id="w"><b>server</b></t017-draw>', '<div id="box"><t017-draw id="w"></t017-draw></div>');
            assert.equal(find('#w').innerHTML, '<b>server</b>');
        });

        it('morphs a custom element whose response has only an empty element as content', async function() {
            await morph('<t017-draw id="w"><i></i></t017-draw>', '<div id="box"><t017-draw id="w"></t017-draw></div>');
            assert.equal(find('#w').innerHTML, '<i></i>');
        });

        it('leaves an ordinary element alone: an empty response empties it', async function() {
            await morph('<div id="d"></div>', '<div id="box"><div id="d"><p>page</p></div></div>');
            assert.equal(find('#d').innerHTML, '');
        });

        it('keeps the children of a React root', async function() {
            await morph('<div id="root" data-reactroot></div>',
                '<div id="box"><div id="root" data-reactroot><div class="app"><p>react</p></div></div></div>');
            assert.equal(find('#root .app p').textContent, 'react');
        });

        it('keeps the children of a Vue root', async function() {
            await morph('<div id="app" data-v-app></div>',
                '<div id="box"><div id="app" data-v-app><h1>vue</h1></div></div>');
            assert.equal(find('#app h1').textContent, 'vue');
        });

        it('keeps the children of an Alpine root that the response gives empty', async function() {
            await morph('<div id="a" x-data="{}"></div>',
                '<div id="box"><div id="a" x-data="{}"><span>alpine</span></div></div>');
            assert.equal(find('#a span').textContent, 'alpine');
        });

        it('morphs an Alpine root whose response has content, as before', async function() {
            await morph('<div id="a" x-data="{}"><span>server</span></div>',
                '<div id="box"><div id="a" x-data="{}"><span>alpine</span></div></div>');
            assert.equal(find('#a span').textContent, 'server');
        });

        it('opts out with ypy-preserve="false"', async function() {
            await morph('<t017-draw id="w" ypy-preserve="false"></t017-draw>',
                '<div id="box"><t017-draw id="w" ypy-preserve="false"></t017-draw></div>');
            assert.equal(find('#w').textContent, '');
        });

        it('follows config.morphThirdParty', async function() {
            ypy.config.morphThirdParty = '[data-widget]';
            await morph('<div id="d" data-widget></div><div id="e" data-reactroot></div>',
                '<div id="box"><div id="d" data-widget><p>w</p></div><div id="e" data-reactroot><p>r</p></div></div>');
            assert.equal(find('#d').textContent, 'w');
            assert.equal(find('#e').textContent, '', 'the default list is replaced');
        });

        it('does not stop a morph of the whole region around the element', async function() {
            await morph('<h2>New title</h2><t017-draw id="w"></t017-draw><p>New text</p>',
                '<div id="box"><h2>Title</h2><t017-draw id="w"></t017-draw><p>Text</p></div>');
            assert.equal(find('#box h2').textContent, 'New title');
            assert.equal(find('#box p').textContent, 'New text');
            assert.equal(find('#w').textContent, 'drawn');
        });

        it('keeps the children of an ordinary element with ypy-preserve="children"', async function() {
            await morph('<div id="d" class="new" ypy-preserve="children"></div>',
                '<div id="box"><div id="d" class="old" ypy-preserve="children"><p>kept</p></div></div>');
            assert.equal(find('#d').className, 'new');
            assert.equal(find('#d p').textContent, 'kept');
        });
    });

    // The components below are a stand-in for what Bootstrap 5 and Bulma 1 write into the page: the
    // classes and attributes the real scripts add after the load.
    describe('Bootstrap and Bulma fixtures', function() {
        beforeEach(function() { setupTest(this); });

        it('Bootstrap: an open collapse and a shown modal keep their classes and attributes', async function() {
            let nav = '<nav id="nav" class="collapse navbar-collapse" ypy-preserve-attrs="class,style,aria-*">';
            let modal = '<div id="m" class="modal fade" tabindex="-1" ypy-preserve-attrs="class,style,aria-*,role">';
            await morph(nav + '<a href="/x">X</a></nav>' + modal + '<p>new</p></div>',
                '<div id="box">' + nav + '<a href="/a">A</a></nav>' + modal + '<p>old</p></div></div>');
            // run again, after the "script" worked on the page
            let n = find('#nav'), m = find('#m');
            n.classList.add('show');
            n.setAttribute('aria-expanded', 'true');
            m.classList.add('show');
            m.setAttribute('style', 'display: block;');
            m.setAttribute('aria-modal', 'true');
            m.setAttribute('role', 'dialog');
            mockResponse('GET', '/test', nav + '<a href="/y">Y</a></nav>' + modal + '<p>newer</p></div>');
            find('button').click();
            await forRequest();
            assert.strictEqual(find('#nav'), n);
            assert.equal(n.className, 'collapse navbar-collapse show');
            assert.equal(n.getAttribute('aria-expanded'), 'true');
            assert.equal(n.querySelector('a').getAttribute('href'), '/y');
            assert.equal(m.className, 'modal fade show');
            assert.equal(m.getAttribute('style'), 'display: block;');
            assert.equal(m.getAttribute('aria-modal'), 'true');
            assert.equal(m.getAttribute('role'), 'dialog');
            assert.equal(m.textContent, 'newer');
        });

        it('Bulma: an active dropdown, a burger and a modal keep is-active', async function() {
            let page = '<div id="dd" class="dropdown" ypy-preserve="attrs"><a>Menu</a></div>' +
                '<a id="burger" class="navbar-burger" ypy-preserve="attrs"></a>' +
                '<div id="bm" class="modal" ypy-preserve="attrs"><div class="modal-card">old</div></div>';
            await morph(page, '<div id="box">' + page + '</div>');
            for (let id of ['#dd', '#burger', '#bm']) find(id).classList.add('is-active');
            find('#burger').setAttribute('aria-expanded', 'true');
            mockResponse('GET', '/test', page.replace('old', 'new'));
            find('button').click();
            await forRequest();
            for (let id of ['#dd', '#burger', '#bm']) {
                assert.isTrue(find(id).classList.contains('is-active'), id);
            }
            assert.equal(find('#burger').getAttribute('aria-expanded'), 'true');
            assert.equal(find('#bm .modal-card').textContent, 'new');
        });

        it('a modal whose component is started by onLoad survives a refresh of its region', async function() {
            let started = [];
            ypy.onLoad('.modal', elt => started.push(elt));
            let modal = '<div id="m" class="modal" ypy-preserve-attrs="class,style"><p>a</p></div>';
            await morph(modal, '<div id="box">' + modal + '</div>');
            let m = find('#m');
            assert.isTrue(started.includes(m));
            m.classList.add('show');
            mockResponse('GET', '/test', modal.replace('>a<', '>b<'));
            find('button').click();
            await forRequest();
            assert.strictEqual(find('#m'), m);
            assert.equal(m.className, 'modal show');
            assert.equal(started.filter(e => e === m).length, 1, 'the component starts once');
        });
    });

    describe('ypy.onLoad(selector, fn)', function() {
        beforeEach(function() { setupTest(this); });

        it('calls fn once for each match in the processed content, the root included', function() {
            let seen = [];
            ypy.onLoad('.start', elt => seen.push(elt.id));
            let root = createProcessedHTML('<div id="r" class="start"><span id="a" class="start"></span><span id="b"></span></div>');
            assert.deepEqual(seen, ['r', 'a']);
            ypy.process(root);
            assert.deepEqual(seen, ['r', 'a'], 'a second process() does not call it again');
        });

        it('calls fn for the content of a swap, once for each new element', async function() {
            let seen = [];
            ypy.onLoad('[data-bs-toggle]', elt => seen.push(elt.id));
            mockResponse('GET', '/test', '<a id="t1" data-bs-toggle="tooltip">1</a><a id="t2" data-bs-toggle="tooltip">2</a>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box">Go</button><div id="box"></div></div>');
            find('button').click();
            await forRequest();
            assert.deepEqual(seen, ['t1', 't2']);
        });

        it('does not call fn again for a node the morph keeps', async function() {
            let seen = [];
            ypy.onLoad('.item', elt => seen.push(elt.id));
            mockResponse('GET', '/test', '<p id="i1" class="item">1</p><p id="i2" class="item">2</p><p id="i3" class="item">3</p>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box">Go</button><div id="box"><p id="i1" class="item">1</p><p id="i2" class="item">0</p></div></div>');
            assert.deepEqual(seen, ['i1', 'i2']);
            find('button').click();
            await forRequest();
            assert.deepEqual(seen, ['i1', 'i2', 'i3']);
        });

        it('calls fn for an out-of-band element, once', async function() {
            let seen = [];
            ypy.onLoad('.oob', elt => seen.push(elt.id));
            mockResponse('GET', '/test', '<p>main</p><div id="o" class="oob" ypy-swap-oob="true">oob</div>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box">Go</button><div id="box"></div><div id="o" class="oob">first</div></div>');
            assert.deepEqual(seen, ['o']);
            let first = find('#o');
            find('button').click();
            await forRequest();
            assert.strictEqual(find('#o'), first, 'the outer morph keeps the node, so no second call');
            assert.equal(find('#o').textContent, 'oob');
            assert.deepEqual(seen, ['o']);

            mockResponse('GET', '/test', '<p>main</p><div id="o2" class="oob" ypy-swap-oob="outerHTML:#o">new</div>');
            find('button').click();
            await forRequest();
            assert.deepEqual(seen, ['o', 'o2']);
        });

        it('two registrations count on their own', function() {
            let a = [], b = [];
            ypy.onLoad('.same', elt => a.push(elt));
            ypy.onLoad('.same', elt => b.push(elt));
            createProcessedHTML('<div class="same"></div>');
            assert.equal(a.length, 1);
            assert.equal(b.length, 1);
        });

        it('keeps the form with a callback only: it is called for every processed root', function() {
            let roots = [];
            ypy.onLoad(elt => roots.push(elt));
            let root = createProcessedHTML('<div id="r"><span></span></div>');
            assert.isTrue(roots.includes(playground()));
            let n = roots.length;
            ypy.process(root);
            assert.equal(roots.length, n + 1, 'no once-only rule on the old form');
        });
    });
});
