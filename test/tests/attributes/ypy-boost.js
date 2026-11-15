// SPDX-License-Identifier: MIT
describe('ypy-boost attribute', async function() {

    beforeEach(() => {
        setupTest(this.currentTest)
    })

    afterEach(() => {
        cleanupTest()
    })

    it('handles basic anchor properly', async function () {
        mockResponse('GET', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><a id="a1" href="/test">Foo</a></div>')
        find('#a1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    for (let key of ['ctrlKey', 'metaKey', 'shiftKey']) {
        it(`leaves a ${key} click on a boosted link to the browser`, async function () {
            mockResponse('GET', '/test', 'Boosted')
            createProcessedHTML('<div ypy-target:inherited="this" ypy-boost:inherited="true"><a id="a1" href="/test">Foo</a></div>')
            let prevented = null
            let last = (e) => { prevented = e.defaultPrevented; e.preventDefault() } // keeps the test page from navigating
            document.addEventListener('click', last)
            try {
                find('#a1').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, [key]: true}))
                await new Promise(r => setTimeout(r, 20))
            } finally {
                document.removeEventListener('click', last)
            }
            prevented.should.equal(false)
            playground().innerHTML.should.not.include('Boosted')
        })
    }

    it('handles basic form post properly', async function () {
        mockResponse('POST', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><form id="f1" action="/test" method="post"><button id="b1">Submit</button></form></div>')
        find('#b1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('handles basic form post with button formaction properly', async function () {
        mockResponse('POST', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><form id="f1" action="/bad" method="post"><button id="b1" formaction="/test">Submit</button></form></div>')
        find('#b1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('handles basic form post with button formmethod properly', async function() {
        mockResponse('POST', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><form id="f1" action="/test" method="get"><button id="b1" formmethod="post">Submit</button></form></div>')
        find('#b1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('handles basic form post with button formmethod & formaction properly', async function() {
        mockResponse('POST', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><form id="f1" action="/bad" method="get"><button id="b1" formmethod="post" formaction="/test">Submit</button></form></div>')
        find('#b1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('handles basic form post properly w/ explicit action', async function() {
        mockResponse('POST', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML"><form id="f1" action="/test" method="post"  ypy-boost="true"></form></div>')
        find('#f1').requestSubmit()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('handles basic form get properly', async function() {
        debug(this)
        mockResponse('GET', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><form id="f1" action="/test" method="get"><button id="b1">Submit</button></form></div>')
        find('#b1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('handles basic form with no explicit method property', async function() {
        mockResponse('GET', '/test', 'Boosted')
        createProcessedHTML('<div ypy-target:inherited="this" ypy-swap:inherited="outerHTML" ypy-boost:inherited="true"><form id="f1" action="/test"><button id="b1">Submit</button></form></div>')
        find("#f1").getAttribute("data-ypy-powered").should.equal('true')
        find('#b1').click()
        await forRequest()
        playground().innerHTML.should.equal('Boosted')
    })

    it('does not boost forms with method="dialog"', async function() {
        mockResponse('GET', '/test', 'Boosted')
        createProcessedHTML('<div ypy-boost:inherited="true"><form id="f1" action="/test" method="dialog"><button id="b1">close</button></form></div>')
        find('#b1').click()
        fetchMock.calls.length.should.equal(0)
    })

    it('does not boost forms with buttons with formmethod="dialog"', async function() {
        mockResponse('GET', '/test', 'Boosted')
        createProcessedHTML('<div ypy-boost:inherited="true"><form id="f1" action="/test" method="get"><button formmethod="dialog" id="b1">close</button></form></div>')
        find('#b1').click()
        fetchMock.calls.length.should.equal(0)
    })

    it('ypy-boost with advanced syntax applies swap config', async function() {
        mockResponse('GET', '/test', 'Clicked')
        createProcessedHTML('<a ypy-boost="swap:outerHTML" ypy-target="this" id="a1" href="/test">Click Me</a>')
        find('#a1').click()
        await forRequest()
        should.equal(document.querySelector('#a1'), null)
    })

    it('ypy-boost with advanced syntax applies target config', async function() {
        mockResponse('GET', '/test', 'New Content')
        createProcessedHTML('<div id="target">Old</div><a ypy-boost="target:#target" id="a1" href="/test">Click</a>')
        find('#a1').click()
        await forRequest()
        find('#target').innerHTML.should.equal('New Content')
    })

    it('ypy-boost with advanced syntax applies select config', async function() {
        mockResponse('GET', '/test', '<div><span id="keep">Keep</span><span>Ignore</span></div>')
        createProcessedHTML('<div id="result"></div><a ypy-boost="select:#keep" ypy-target="#result" id="a1" href="/test">Click</a>')
        find('#a1').click()
        await forRequest()
        find('#result').innerHTML.should.contain('Keep')
        find('#result').innerHTML.should.not.contain('Ignore')
    })

    it('ypy-boost with multiple advanced configs', async function() {
        mockResponse('GET', '/test', '<div id="main"><span id="result">Success</span></div>')
        createProcessedHTML('<div id="main">Old</div><a ypy-boost="swap:outerHTML target:#main select:#result" id="a1" href="/test">Click</a>')
        find('#a1').click()
        await forRequest()
        should.equal(document.querySelector('#main'), null)
        find('#result').innerHTML.should.equal('Success')
    })

    it('boost config overrides explicit attributes', async function() {
        mockResponse('GET', '/test', 'Clicked')
        createProcessedHTML('<a ypy-boost="swap:outerHTML" ypy-swap="innerHTML" ypy-target="this" id="a1" href="/test">Click</a>')
        find('#a1').click()
        await forRequest()
        should.equal(document.querySelector('#a1'), null)
    })

    it('ypy-boost true still works as before', async function() {
        mockResponse('GET', '/test', 'Clicked')
        createProcessedHTML('<div id="result"></div><a ypy-boost="true" ypy-target="#result" id="a1" href="/test">Click Me</a>')
        find('#a1').click()
        await forRequest()
        find('#result').innerHTML.should.equal('Clicked')
    })

    it('ypy-boost with ypy-push-url=false does not push history', async function() {
        let pushCount = 0
        let originalPushState = history.pushState.bind(history)
        history.pushState = (...args) => { pushCount++; originalPushState(...args) }
        try {
            mockResponse('GET', '/test', 'Clicked')
            createProcessedHTML('<div id="result"></div><a ypy-boost="true" ypy-push-url="false" ypy-target="#result" id="a1" href="/test">Click Me</a>')
            find('#a1').click()
            await forRequest()
            pushCount.should.equal(0)
        } finally {
            history.pushState = originalPushState
        }
    })

    it('boosted link should be triggered by custom event', async function() {
        mockResponse('GET', '/test', 'Boosted')
        createProcessedHTML('<div id="result"></div><a ypy-boost="true" ypy-trigger="foo" ypy-target="#result" id="a1" href="/test">Click Me</a>')
        ypy.trigger(find('#a1'), 'foo')
        await forRequest()
        find('#result').innerHTML.should.equal('Boosted')
    })

    it('boosted form should be triggered by custom event', async function () {
        mockResponse('POST', '/test', 'Boosted')
        createProcessedHTML('<div id="result"></div><form ypy-boost="true" ypy-trigger="foo" ypy-target="#result" id="f1" action="/test" method="post"></form>')
        ypy.trigger(find('#f1'), 'foo')
        await forRequest()
        find('#result').innerHTML.should.equal('Boosted')
    })

    it('boosted link returning only ypy-partial does not blank body', async function () {
        createProcessedHTML('<div id="sidebar">Original</div><a id="a1" ypy-boost="true" href="/partial">Click</a>')
        mockResponse('GET', '/partial', "<ypy-partial ypy-target='#sidebar'>Updated</ypy-partial>")
        find('#a1').click()
        await forRequest()
        await ypy.timeout(10)
        find('#sidebar').innerText.should.equal('Updated')
        assert.isNotNull(find('#a1'), 'body should not be blanked')
    })

    // // it('overriding default swap style does not effect boosting', async function() {
    // //     ypy.config.defaultSwapStyle = 'afterend'
    // //     try {
    // //         mockResponse('GET', '/test', 'Boosted')
    // //         var a = make('<a ypy-target:inherited="this" ypy-boost="true" id="a1" href="/test">Foo</a>')
    // //         a.click()
    // //         this.server.respond()
    // //         a.innerHTML.should.equal('Boosted')
    // //     } finally {
    // //         ypy.config.defaultSwapStyle = 'innerHTML'
    // //     }
    // // })
    //
    // it('anchors w/ explicit targets are not boosted', async function() {
    //     mockResponse('GET', '/test', 'Boosted')
    //     initHTML('<a ypy-target="this" ypy-boost="true" id="a1" href="/test" target="_blank">Foo</a>')
    //     find('#a1').click()
    //     fetchMock.calls.length.should.equal(0)
    // })

    // it('includes an YPY-Boosted Header', async function() {
    //     mockResponse('GET', '/test', "Boosted!")
    //     createProcessedHTML('<a ypy-boost="true" ypy-target="this" ypy-swap="outerHTML" href="/test">Click Me!</a>')
    //     find("a").click()
        await forRequest()
    //     fetchMock.getLastCall().request.headers["YPY-Boosted"].should.equal("true")
    //     fetchMock.getLastCall().request.headers["YPY-Request"].should.equal("true")
    //     playground().innerHTML.should.equal('Boosted!')
    // })

    // it('form get w/ search params in action property excludes search params', async function() {
    //     mockResponse('GET', /\/test.*/, async function(xhr) {
    //         should.equal(undefined, getParameters(xhr).foo)
    //         xhr.respond(200, {}, 'Boosted!')
    //     })
    //
    //     initHTML('<div ypy-target:inherited="this" ypy-boost="true"><form id="f1" action="/test?foo=bar" method="get"><button id="b1">Submit</button></form></div>')
    //      find('#b1').click()
        await forRequest()
    //     playground().innerHTML.should.equal('Boosted!')
    // })
    //
    // it('form post w/ query params in action property uses full url', async function() {
    //     mockResponse('POST', /\/test.*/, async function(xhr) {
    //         should.equal(undefined, getParameters(xhr).foo)
    //         xhr.respond(200, {}, 'Boosted!')
    //     })
    //     initHTML('<div ypy-target:inherited="this" ypy-boost="true"><form id="f1" action="/test?foo=bar" method="post"><button id="b1">Submit</button></form></div>')
    //      find('#b1').click()
        await forRequest()
    //     playground().innerHTML.should.equal('Boosted!')
    // })
    //
    // it('form get with an unset action properly submits', async function() {
    //     mockResponse('GET', /\/*/, async function(xhr) {
    //         xhr.respond(200, {}, 'Boosted!')
    //     })
    //
    //     initHTML('<div ypy-target:inherited="this" ypy-boost="true"><form id="f1" method="get"><button id="b1">Submit</button></form></div>')
    //      find('#b1').click()
        await forRequest()
    //     playground().innerHTML.should.equal('Boosted!')
    // })
    //
    // it('form get with no action properly clears existing parameters on submit', async function() {
    //     /// add a foo=bar to the current url
    //     var path = location.href
    //     if (!path.includes('foo=bar')) {
    //         if (!path.includes('?')) {
    //             path += '?foo=bar'
    //         } else {
    //             path += '&foo=bar'
    //         }
    //     }
    //     history.replaceState({ ypy: true }, '', path)
    //
    //     mockResponse('GET', /\/*/, async function(xhr) {
    //         // foo should not be present because the form is a get with no action
    //         should.equal(undefined, getParameters(xhr).foo)
    //         xhr.respond(200, {}, 'Boosted!')
    //     })
    //
    //     initHTML('<div ypy-target:inherited="this" ypy-boost="true"><form id="f1" method="get"><button id="b1">Submit</button></form></div>')
    //      find('#b1').click()
        await forRequest()
    //     playground().innerHTML.should.equal('Boosted!')
    // })
    //
    // it('form get with an empty action properly clears existing parameters on submit', async function() {
    //     /// add a foo=bar to the current url
    //     var path = location.href
    //     if (!path.includes('foo=bar')) {
    //         if (!path.includes('?')) {
    //             path += '?foo=bar'
    //         } else {
    //             path += '&foo=bar'
    //         }
    //     }
    //     history.replaceState({ ypy: true }, '', path)
    //
    //     mockResponse('GET', /\/*/, async function(xhr) {
    //         // foo should not be present because the form is a get with no action
    //         should.equal(undefined, getParameters(xhr).foo)
    //         xhr.respond(200, {}, 'Boosted!')
    //     })
    //
    //     initHTML('<div ypy-target:inherited="this" ypy-boost="true"><form id="f1" action="" method="get"><button id="b1">Submit</button></form></div>')
    //      find('#b1').click()
        await forRequest()
    //     playground().innerHTML.should.equal('Boosted!')
    // })
    //
    // if (/headlesschrome/i.test(navigator.userAgent)) {
    //     it('ctrlKey mouse click does not boost', async function() {
    //         // Test only works well in playwright with chome for code coverage as otherwise it opens a new tab breaking things
    //         mockResponse('GET', '/test', 'Boosted')
    //         initHTML('<div ypy-target:inherited="this" ypy-boost="true"><a id="a1" href="/test">Foo</a></div>')
    //         var a = byId('a1')
    //         var evt = new MouseEvent('click', { ctrlKey: true })
    //         a.dispatchEvent(evt)
    //         this.server.respond()
    //         playground().innerHTML.should.not.equal('Boosted')
    //     })
    // }

})
