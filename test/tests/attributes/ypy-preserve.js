// SPDX-License-Identifier: MIT
// TASK-017: ypy-preserve keeps what a script other than YPY wrote into an element. The forms: no
// value (the node itself), attrs, children, all, and the list in ypy-preserve-attrs.
describe('ypy-preserve attribute', function() {

    afterEach(function() {
        cleanupTest();
    });

    // a request that morphs the response into #box, which is the content of a button's parent
    async function morph(response, box) {
        mockResponse('GET', '/test', response);
        createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerMorph">Go</button>' + box + '</div>');
        return find('button');
    }

    async function run(button) {
        button.click();
        await forRequest();
    }

    describe('without a value: the node itself', function() {
        beforeEach(function() { setupTest(this); });

        it('keeps the node and what a script wrote into it', async function() {
            let button = await morph('<div id="p" ypy-preserve>server</div>',
                '<div id="box"><div id="p" ypy-preserve>page</div></div>');
            let node = find('#p');
            node.classList.add('show');
            node.expando = 'kept';
            await run(button);
            assert.strictEqual(find('#p'), node);
            assert.equal(node.textContent, 'page');
            assert.isTrue(node.classList.contains('show'));
            assert.equal(node.expando, 'kept');
        });

        it('reads ypy-preserve="true" like the bare attribute', async function() {
            let button = await morph('<div id="p" ypy-preserve="true">server</div>',
                '<div id="box"><div id="p" ypy-preserve="true">page</div></div>');
            await run(button);
            assert.equal(find('#p').textContent, 'page');
        });

        it('needs an id: without one a raw swap replaces the element', async function() {
            mockResponse('GET', '/test', '<div ypy-preserve>server</div>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerHTML">Go</button>' +
                '<div id="box"><div ypy-preserve>page</div></div></div>');
            await run(find('button'));
            assert.equal(find('#box').textContent, 'server');
        });

        it('keeps the node in a raw swap too', async function() {
            mockResponse('GET', '/test', '<div id="p" ypy-preserve>server</div><p>new</p>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerHTML">Go</button>' +
                '<div id="box"><div id="p" ypy-preserve>page</div></div></div>');
            let node = find('#p');
            await run(find('button'));
            assert.strictEqual(find('#p'), node);
            assert.equal(node.textContent, 'page');
            assert.equal(find('#box p').textContent, 'new');
        });
    });

    describe('attrs', function() {
        beforeEach(function() { setupTest(this); });

        it('keeps the classes and attributes a script added, children still morph', async function() {
            let button = await morph('<div id="n" class="collapse" ypy-preserve="attrs"><a href="/b">B</a></div>',
                '<div id="box"><div id="n" class="collapse" ypy-preserve="attrs"><a href="/a">A</a></div></div>');
            let node = find('#n');
            node.classList.add('show');
            node.setAttribute('aria-expanded', 'true');
            node.setAttribute('data-bs-toggle', 'collapse');
            await run(button);
            assert.strictEqual(find('#n'), node);
            assert.equal(node.className, 'collapse show');
            assert.equal(node.getAttribute('aria-expanded'), 'true');
            assert.equal(node.getAttribute('data-bs-toggle'), 'collapse');
            assert.equal(node.querySelector('a').getAttribute('href'), '/b');
            assert.equal(node.textContent, 'B');
        });

        it('does not let the response change an attribute either', async function() {
            let button = await morph('<div id="n" title="new" class="other" ypy-preserve="attrs">x</div>',
                '<div id="box"><div id="n" title="old" class="mine" ypy-preserve="attrs">x</div></div>');
            await run(button);
            assert.equal(find('#n').title, 'old');
            assert.equal(find('#n').className, 'mine');
        });

        it('works without an id', async function() {
            let button = await morph('<p class="a" ypy-preserve="attrs">two</p>',
                '<div id="box"><p class="a b" ypy-preserve="attrs">one</p></div>');
            await run(button);
            assert.equal(find('#box p').className, 'a b');
            assert.equal(find('#box p').textContent, 'two');
        });

        it('does nothing to the node of a raw swap, which is replaced', async function() {
            mockResponse('GET', '/test', '<div id="n" class="collapse" ypy-preserve="attrs">server</div>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerHTML">Go</button>' +
                '<div id="box"><div id="n" class="collapse show" ypy-preserve="attrs">page</div></div></div>');
            await run(find('button'));
            assert.equal(find('#n').className, 'collapse');
            assert.equal(find('#n').textContent, 'server');
        });

        it('applies to a morph', async function() {
            setupTest(this);
            let button = await morph('<div class="collapse" ypy-preserve="attrs">x</div>',
                '<div id="box"><div class="collapse show" ypy-preserve="attrs">x</div></div>');
            await run(button);
            assert.equal(find('#box div').className, 'collapse show');
        });

        it('is read in the other spellings', async function() {
            for (let name of ['ypy-preserve', 'data-ypy-preserve']) {
                let button = await morph('<div class="a" ' + name + '="attrs">x</div>',
                    '<div id="box"><div class="a b" ' + name + '="attrs">x</div></div>');
                await run(button);
                assert.equal(find('#box div').className, 'a b', name);
                cleanupTest();
                setupTest(this);
            }
        });
    });

    describe('children', function() {
        beforeEach(function() { setupTest(this); });

        it('updates the attributes and keeps the children a script drew', async function() {
            let button = await morph('<div id="c" class="card new" data-x="2" ypy-preserve="children"><p>server</p></div>',
                '<div id="box"><div id="c" class="card" data-x="1" ypy-preserve="children"></div></div>');
            let drawn = document.createElement('span');
            drawn.textContent = 'drawn';
            find('#c').append(drawn);
            await run(button);
            assert.equal(find('#c').className, 'card new');
            assert.equal(find('#c').dataset.x, '2');
            assert.equal(find('#c').textContent, 'drawn');
            assert.strictEqual(find('#c span'), drawn);
        });
    });

    describe('all', function() {
        beforeEach(function() { setupTest(this); });

        it('leaves the element alone, with no id', async function() {
            let button = await morph('<div class="x" ypy-preserve="all"><p>server</p></div>',
                '<div id="box"><div class="x y" ypy-preserve="all"><p>page</p></div></div>');
            let node = find('#box div');
            await run(button);
            assert.strictEqual(find('#box div'), node);
            assert.equal(node.className, 'x y');
            assert.equal(node.textContent, 'page');
        });

        it('keeps the node of a raw swap when it has an id', async function() {
            mockResponse('GET', '/test', '<div id="p" ypy-preserve="all"><p>server</p></div>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerHTML">Go</button>' +
                '<div id="box"><div id="p" ypy-preserve="all"><p>page</p></div></div></div>');
            let node = find('#p');
            await run(find('button'));
            assert.strictEqual(find('#p'), node);
            assert.equal(node.textContent, 'page');
        });

        it('lets a sibling update', async function() {
            let button = await morph('<div class="x" ypy-preserve="all">server</div><p>two</p>',
                '<div id="box"><div class="x" ypy-preserve="all">page</div><p>one</p></div>');
            await run(button);
            assert.equal(find('#box p').textContent, 'two');
            assert.equal(find('#box div').textContent, 'page');
        });
    });

    describe('false', function() {
        beforeEach(function() { setupTest(this); });

        it('is not kept: the response wins', async function() {
            let button = await morph('<div id="p" ypy-preserve="false" class="b">server</div>',
                '<div id="box"><div id="p" ypy-preserve="false" class="a">page</div></div>');
            await run(button);
            assert.equal(find('#p').textContent, 'server');
            assert.equal(find('#p').className, 'b');
        });

        it('does not keep the node of a raw swap', async function() {
            mockResponse('GET', '/test', '<div id="p" ypy-preserve="false">server</div>');
            createProcessedHTML('<div><button ypy-get="/test" ypy-target="#box" ypy-swap="innerHTML">Go</button>' +
                '<div id="box"><div id="p" ypy-preserve="false">page</div></div></div>');
            await run(find('button'));
            assert.equal(find('#p').textContent, 'server');
        });
    });

    describe('ypy-preserve-attrs', function() {
        beforeEach(function() { setupTest(this); });

        const box = '<div id="box"><div id="m" class="modal" style="display:block" aria-modal="true" data-bs-backdrop="static" title="old" ypy-preserve-attrs="class,style,aria-*,data-bs-*"><p>one</p></div></div>';

        it('keeps only the attributes of the list', async function() {
            let button = await morph('<div id="m" class="modal fade" title="new" ypy-preserve-attrs="class,style,aria-*,data-bs-*"><p>two</p></div>', box);
            let node = find('#m');
            node.classList.add('show');
            await run(button);
            assert.strictEqual(find('#m'), node);
            assert.equal(node.className, 'modal show');
            assert.equal(node.getAttribute('style'), 'display:block');
            assert.equal(node.getAttribute('aria-modal'), 'true');
            assert.equal(node.getAttribute('data-bs-backdrop'), 'static');
            assert.equal(node.title, 'new');
            assert.equal(node.textContent, 'two');
        });

        it('also keeps an attribute of the list that the response adds or drops', async function() {
            let button = await morph('<div id="m" aria-hidden="true" ypy-preserve-attrs="class,style,aria-*,data-bs-*"><p>one</p></div>', box);
            let node = find('#m');
            await run(button);
            assert.isFalse(node.hasAttribute('aria-hidden'));
            assert.equal(node.className, 'modal');
            assert.isFalse(node.hasAttribute('title'));
        });

        it('accepts spaces in the list', async function() {
            let button = await morph('<div id="m" class="x" title="new" ypy-preserve-attrs=" class , aria-* ">x</div>',
                '<div id="box"><div id="m" class="a" title="old" ypy-preserve-attrs=" class , aria-* ">x</div></div>');
            await run(button);
            assert.equal(find('#m').className, 'a');
            assert.equal(find('#m').title, 'new');
        });

        it('with an empty value keeps nothing', async function() {
            let button = await morph('<div id="m" class="b" ypy-preserve-attrs="">x</div>',
                '<div id="box"><div id="m" class="a" ypy-preserve-attrs="">x</div></div>');
            await run(button);
            assert.equal(find('#m').className, 'b');
        });
    });

    describe('a node whose state a script keeps', function() {
        beforeEach(function() { setupTest(this); });

        it('loses the script classes without the marker, keeps them with it', async function() {
            let button = await morph('<div id="a" class="tab"></div><div id="b" class="tab" ypy-preserve="attrs"></div>',
                '<div id="box"><div id="a" class="tab"></div><div id="b" class="tab" ypy-preserve="attrs"></div></div>');
            for (let id of ['#a', '#b']) {
                find(id).classList.add('is-active');
                find(id).setAttribute('aria-selected', 'true');
            }
            await run(button);
            assert.equal(find('#a').className, 'tab');
            assert.isFalse(find('#a').hasAttribute('aria-selected'));
            assert.equal(find('#b').className, 'tab is-active');
            assert.equal(find('#b').getAttribute('aria-selected'), 'true');
        });
    });

    describe('a bare ypy-preserve in a plain swap', function() {
        beforeEach(function() { setupTest(this); });

        it('preserves element with ypy-preserve during swap', async function () {
            mockResponse('GET', '/test', '<div id="preserved" ypy-preserve>Preserved</div><div>New</div>')
            let div = createProcessedHTML('<div ypy-get="/test"><div id="preserved" ypy-preserve>Original</div></div>');
            div.click()
            await forRequest()
            assertTextContentIs('#preserved', 'Original')
        })

        it('preserves element state during swap', async function () {
            mockResponse('GET', '/test', '<input id="inp" ypy-preserve value="new"/>')
            let div = createProcessedHTML('<div ypy-get="/test"><input id="inp" ypy-preserve value="old"/></div>');
            find('#inp').value = 'modified';
            div.click()
            await forRequest()
            assert.equal(find('#inp').value, 'modified')
        })

        it('handles ypy-preserve when element does not exist in current page', async function () {
            mockResponse('GET', '/test', '<div id="new-preserved" ypy-preserve>New Preserved</div><div>Content</div>')
            let div = createProcessedHTML('<div ypy-get="/test"><div>Original Content</div></div>');
            div.click()
            await forRequest()
            assertTextContentIs('#new-preserved', 'New Preserved')
        })

        it('preserves multiple ypy-preserve elements without skipping any', async function () {
            mockResponse('GET', '/test',
                '<div id="p1" ypy-preserve>New1</div>' +
                '<div id="p2" ypy-preserve>New2</div>' +
                '<div id="p3" ypy-preserve>New3</div>' +
                '<div>Other</div>')
            let div = createProcessedHTML(
                '<div ypy-get="/test">' +
                '<div id="p1" ypy-preserve>Original1</div>' +
                '<div id="p2" ypy-preserve>Original2</div>' +
                '<div id="p3" ypy-preserve>Original3</div>' +
                '</div>');
            div.click()
            await forRequest()
            // All three should retain original content — bug causes p2 to be lost
            assertTextContentIs('#p1', 'Original1')
            assertTextContentIs('#p2', 'Original2')
            assertTextContentIs('#p3', 'Original3')
        })
    });
});
