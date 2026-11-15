// SPDX-License-Identifier: MIT
// <ypy-partial> and <ypy-partial> are the same tag: the same targets, swap styles, scripts and
// title rules, with every spelling of the attributes.
describe('ypy-partial', function () {

    // [tag, target attribute, swap attribute]
    const FORMS = [
        ['ypy-partial', 'ypy-target', 'ypy-swap'],
        ['ypy-partial', 'ypy-target', 'ypy-swap'],
        ['ypy-partial', 'ypy-target', 'ypy-swap'],
        ['ypy-partial', 'ypy-target', 'ypy-swap'],
        ['ypy-partial', 'data-ypy-target', 'data-ypy-swap'],
        ['ypy-partial', 'data-ypy-target', 'data-ypy-swap'],
        ['YPY-PARTIAL', 'ypy-target', 'ypy-swap'],
    ]

    let savedTitle = document.title

    afterEach(function () {
        cleanupTest()
        delete window.__partialRan
        document.title = savedTitle
    })

    for (let [tag, targetAttr, swapAttr] of FORMS) {
        describe(`<${tag} ${targetAttr}>`, function () {

            beforeEach(function () {
                setupTest(this)
            })

            // a partial for a target, as a response text
            let partial = (target, content, swap) =>
                `<${tag} ${targetAttr}="${target}"${swap ? ` ${swapAttr}="${swap}"` : ''}>${content}</${tag}>`

            it('swaps into the target with the default style', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'>Old</div>")
                await ypy.swap({target: '#main', text: partial('#d1', 'New')})
                find('#d1').textContent.should.equal('New')
                find('#main').textContent.should.equal('Main')
            })

            it('uses the swap style of the partial', async function () {
                createProcessedHTML("<div id='d1'>Old</div>")
                await ypy.swap({target: '#d1', text: partial('#d1', ' New', 'beforeend')})
                find('#d1').textContent.should.equal('Old New')
            })

            it('takes the target from its id when it has no target attribute', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'>Old</div>")
                await ypy.swap({target: '#main', text: `<${tag} id="d1">By id</${tag}>`})
                find('#d1').textContent.should.equal('By id')
            })

            it('swaps into every element a selector matches', async function () {
                createProcessedHTML("<div id='main'>Main</div><p class='t'>1</p><p class='t'>2</p><p class='t'>3</p>")
                await ypy.swap({target: '#main', text: partial('.t', 'X')})
                ;[...playground().querySelectorAll('.t')].map(e => e.textContent).should.deep.equal(['X', 'X', 'X'])
            })

            it('follows config.defaultSwap when it names no swap style', async function () {
                let saved = ypy.config.defaultSwap
                ypy.config.defaultSwap = 'beforeend'
                try {
                    createProcessedHTML("<div id='main'>Main</div><div id='d1'>Old</div>")
                    await ypy.swap({target: '#main', text: partial('#d1', ' New')})
                    find('#d1').textContent.should.equal('Old New')
                } finally {
                    ypy.config.defaultSwap = saved
                }
            })

            it('does not swap the main target when the response is only partials', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'>Old</div>")
                await ypy.swap({target: '#main', text: '\n  ' + partial('#d1', 'New') + '\n'})
                find('#main').textContent.should.equal('Main')
                find('#d1').textContent.should.equal('New')
            })

            it('swaps the main content and the partial of one response', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'>Old</div>")
                await ypy.swap({target: '#main', text: '<b>Hello</b>' + partial('#d1', 'New')})
                find('#main').innerHTML.should.contain('<b>Hello</b>')
                find('#d1').textContent.should.equal('New')
            })

            it('fills a table body with rows', async function () {
                createProcessedHTML("<div id='main'>Main</div><table><tbody id='rows'><tr><td>old</td></tr></tbody></table>")
                await ypy.swap({target: '#main', text: partial('#rows', '<tr><td>a</td></tr><tr><td>b</td></tr>', 'beforeend')})
                ;[...find('#rows').rows].map(r => r.textContent).should.deep.equal(['old', 'a', 'b'])
            })

            it('replaces a whole row', async function () {
                createProcessedHTML("<div id='main'>Main</div><table><tbody><tr id='r1'><td>old</td></tr></tbody></table>")
                await ypy.swap({target: '#main', text: partial('#r1', '<tr id="r1"><td>new</td></tr>', 'outerHTML')})
                find('#r1').textContent.should.equal('new')
            })

            it('fills a select with options', async function () {
                createProcessedHTML("<div id='main'>Main</div><select id='sel'><option>old</option></select>")
                await ypy.swap({target: '#main', text: partial('#sel', '<option>a</option><option>b</option>')})
                ;[...find('#sel').options].map(o => o.text).should.deep.equal(['a', 'b'])
            })

            it('keeps a plain <template> inside its content', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'></div>")
                await ypy.swap({target: '#main', text: partial('#d1', '<template id="keep"><i>x</i></template>')})
                assert.exists(find('#d1 #keep'))
                find('#keep').content.firstElementChild.tagName.should.equal('I')
            })

            it('executes the scripts of the partial', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'></div>")
                await ypy.swap({target: '#main', text: partial('#d1', '<script>window.__partialRan = 12</script>')})
                window.__partialRan.should.equal(12)
            })

            it('sets the title from the response', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'></div>")
                await ypy.swap({target: '#main', text: '<title>Partial Title</title>' + partial('#d1', 'x')})
                document.title.should.equal('Partial Title')
            })

            it('ignores the title with ignoreTitle', async function () {
                createProcessedHTML("<div id='main'>Main</div><div id='d1'></div>")
                await ypy.swap({target: '#main', text: '<title>Partial Title</title>' + partial('#d1', 'x', 'innerHTML ignoreTitle:true')})
                document.title.should.not.equal('Partial Title')
            })

            it('resolves an extended selector against the source element', async function () {
                let list = createProcessedHTML("<ul><li id='li1'><button id='b'>b</button> old</li></ul>")
                await ypy.swap({sourceElement: find('#b'), target: '#li1', text: partial('closest li', 'closed')})
                find('#li1').textContent.should.equal('closed')
            })
        })
    }

    describe('the tag rewrite of the response', function () {

        it('turns the two tags into the same template', function () {
            let a = ypy.__makeFragment('<ypy-partial ypy-target="#a">x</ypy-partial>').fragment.firstElementChild
            let b = ypy.__makeFragment('<ypy-partial ypy-target="#a">x</ypy-partial>').fragment.firstElementChild
            a.outerHTML.should.equal(b.outerHTML)
        })

        it('lowercases the type, so the tag name case does not matter', function () {
            let t = ypy.__makeFragment('<YPY-PARTIAL ypy-target="#a">x</YPY-PARTIAL>').fragment.firstElementChild
            t.getAttribute('type').should.equal('partial')
        })

        it('accepts a line break and a tab after the tag name', function () {
            let {fragment} = ypy.__makeFragment('<ypy-partial\n\tid="a">x</ypy-partial >')
            fragment.firstElementChild.tagName.should.equal('TEMPLATE')
            fragment.firstElementChild.id.should.equal('a')
            fragment.childElementCount.should.equal(1)
        })

        it('leaves an element whose name has a second hyphen alone', function () {
            let {fragment} = ypy.__makeFragment('<ypy-my-card id="c">x</ypy-my-card><ypy-other-thing>y</ypy-other-thing>')
            fragment.children[0].tagName.should.equal('YPY-MY-CARD')
            fragment.children[1].tagName.should.equal('YPY-OTHER-THING')
            fragment.children[0].textContent.should.equal('x')
        })

        it('gives any other single-word name its own type, left to the extensions', function () {
            let {fragment} = ypy.__makeFragment('<ypy-custom id="c">x</ypy-custom>')
            fragment.firstElementChild.tagName.should.equal('TEMPLATE')
            fragment.firstElementChild.getAttribute('type').should.equal('custom')
        })

        it('does not change an ordinary response', function () {
            let {fragment} = ypy.__makeFragment('<div class="a-b"><p>ypy-partial in text</p></div>')
            fragment.firstElementChild.outerHTML.should.equal('<div class="a-b"><p>ypy-partial in text</p></div>')
        })
    })
})
