// SPDX-License-Identifier: MIT
describe('__showIndicators / __hideIndicators unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    function makeCtx(elt) {
        return { sourceElement: elt, indicators: [], disabledElements: [] };
    }

    it('shows indicator by adding request class', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        ypy.__showIndicators(makeCtx(container))

        assert.isTrue(span.classList.contains('ypy-request'))
    })

    it('hides indicator by removing request class', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        let ctx = makeCtx(container)
        ypy.__showIndicators(ctx)
        ypy.__hideIndicators(ctx.indicators)

        assert.isFalse(span.classList.contains('ypy-request'))
    })

    it('increments counter on multiple shows', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        ypy.__showIndicators(makeCtx(container))
        ypy.__showIndicators(makeCtx(container))

        assert.equal(ypy.__ypyState(span).rc, 2)
        assert.isTrue(span.classList.contains('ypy-request'))
    })

    it('decrements counter on hide', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        let ctx1 = makeCtx(container)
        let ctx2 = makeCtx(container)
        ypy.__showIndicators(ctx1)
        ypy.__showIndicators(ctx2)
        ypy.__hideIndicators(ctx1.indicators)

        assert.equal(ypy.__ypyState(span).rc, 1)
        assert.isTrue(span.classList.contains('ypy-request'))
    })

    it('removes class only when counter reaches zero', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        let ctx1 = makeCtx(container)
        let ctx2 = makeCtx(container)
        ypy.__showIndicators(ctx1)
        ypy.__showIndicators(ctx2)
        ypy.__hideIndicators(ctx1.indicators)
        ypy.__hideIndicators(ctx2.indicators)

        assert.isFalse(span.classList.contains('ypy-request'))
        assert.isUndefined(ypy.__ypyState(span).rc)
    })

    it('handles multiple indicators', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span><div class="indicator"></div></div>')
        let span = container.querySelector('span')
        let div = container.querySelector('div')

        ypy.__showIndicators(makeCtx(container))

        assert.isTrue(span.classList.contains('ypy-request'))
        assert.isTrue(div.classList.contains('ypy-request'))
    })

    it('does nothing when selector is null', function () {
        let container = createProcessedHTML('<div><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        ypy.__showIndicators(makeCtx(container))

        assert.isFalse(span.classList.contains('ypy-request'))
    })

    it('returns empty array and adds no class when elt is document.body', function () {
        let span = createProcessedHTML('<span class="ypy-indicator"></span>')
        document.body.appendChild(span)

        let ctx = makeCtx(document.body)
        ypy.__showIndicators(ctx)

        assert.deepEqual(ctx.indicators, [])
        assert.isFalse(document.body.classList.contains('ypy-request'))
        assert.isFalse(span.classList.contains('ypy-request'))

        span.remove()
    })

    it('includes element itself in indicators', function () {
        let div = createProcessedHTML('<div ypy-indicator=".indicator" class="indicator"></div>')

        ypy.__showIndicators(makeCtx(div))

        assert.isTrue(div.classList.contains('ypy-request'))
    })

    it('handles hide without prior show gracefully', function () {
        let container = createProcessedHTML('<div><span class="indicator"></span></div>')
        let span = container.querySelector('span')

        ypy.__hideIndicators([span])

        assert.isFalse(span.classList.contains('ypy-request'))
        assert.isUndefined(ypy.__ypyState(span).rc)
    })

    it('works with nested indicators', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator" class="indicator"><span class="indicator"></span></div>')
        let outer = container
        let inner = container.querySelector('span')

        let ctx = makeCtx(container)
        ypy.__showIndicators(ctx)

        assert.isTrue(outer.classList.contains('ypy-request'))
        assert.isTrue(inner.classList.contains('ypy-request'))

        ypy.__hideIndicators(ctx.indicators)

        assert.isFalse(outer.classList.contains('ypy-request'))
        assert.isFalse(inner.classList.contains('ypy-request'))
    })

    it('maintains separate counts for separate indicators', function () {
        let container = createProcessedHTML('<div ypy-indicator=".indicator"><span class="indicator"></span><div class="indicator"></div></div>')
        let span = container.querySelector('span')
        let div = container.querySelector('div')

        ypy.__showIndicators(makeCtx(container))
        container.setAttribute('ypy-indicator', 'span.indicator')
        ypy.__showIndicators(makeCtx(container))

        assert.equal(ypy.__ypyState(span).rc, 2)
        assert.equal(ypy.__ypyState(div).rc, 1)
    })

    it('resolves this selector for indicators', function () {
        let container = createProcessedHTML('<div ypy-indicator="this"><button ypy-get="/test" ypy-indicator="this"></button></div>');
        let button = container.querySelector('button');

        let ctx = makeCtx(button)
        ypy.__showIndicators(ctx);

        assert.isTrue(button.classList.contains('ypy-request'));
        assert.equal(ctx.indicators.length, 1);
        assert.equal(ctx.indicators[0], button);
    })

    it('resolves this selector with inherited indicator', function () {
        let outer = createProcessedHTML('<div ypy-indicator:inherited="this"><button ypy-get="/test"></button></div>');
        let button = outer.querySelector('button');

        let ctx = makeCtx(button)
        ypy.__showIndicators(ctx);

        assert.isTrue(outer.classList.contains('ypy-request'));
        assert.equal(ctx.indicators.length, 1);
        assert.equal(ctx.indicators[0], outer);
    })

    it('resolves this selector respecting indicator override', function () {
        let html = '<div ypy-indicator="this"><button ypy-get="/test" ypy-indicator=".other" class="other"></button></div>';
        let outer = createProcessedHTML(html);
        let button = outer.querySelector('button');

        let ctx = makeCtx(button)
        ypy.__showIndicators(ctx);

        assert.isFalse(outer.classList.contains('ypy-request'));
        assert.isTrue(button.classList.contains('ypy-request'));
    })

    it('resolves this selector with append for indicators', function () {
        let html = '<div ypy-indicator:inherited="this"><button ypy-get="/test" ypy-indicator:append="this"></button></div>';
        let outer = createProcessedHTML(html);
        let button = outer.querySelector('button');

        let ctx = makeCtx(button)
        ypy.__showIndicators(ctx);

        assert.isTrue(outer.classList.contains('ypy-request'));
        assert.isTrue(button.classList.contains('ypy-request'));
        assert.equal(ctx.indicators.length, 2);
    })

    it('resolves this selector with comma-separated indicator values', function () {
        let html = '<div class="other"><button ypy-get="/test" ypy-indicator="this, .other"></button></div>';
        let container = createProcessedHTML(html);
        let button = container.querySelector('button');

        let ctx = makeCtx(button)
        ypy.__showIndicators(ctx);

        assert.isTrue(button.classList.contains('ypy-request'));
        assert.isTrue(container.classList.contains('ypy-request'));
        assert.equal(ctx.indicators.length, 2);
    })

    it('indicators are carried through an ypy-location chain', async function() {
        mockResponse('GET', '/first', '', { headers: { 'YPY-Location': '{"path":"/second","target":"#dest"}' } })
        mockResponse('GET', '/second', 'Done')
        createProcessedHTML(
            '<div id="indicator" class="ypy-indicator">Loading...</div>' +
            '<div id="dest"></div>' +
            '<button id="btn" ypy-get="/first" ypy-indicator="#indicator" ypy-target="#dest">Click</button>'
        )
        find('#btn').click()
        await forRequest()  // /first
        assert.isTrue(find('#indicator').classList.contains('ypy-request'), 'indicator should still be active during chain')
        await forRequest()  // /second
        await ypy.timeout(10)
        assert.isFalse(find('#indicator').classList.contains('ypy-request'), 'indicator should be hidden after chain completes')
        assert.equal(find('#dest').textContent, 'Done')
    })

    it('keeps indicators visible when YPY-Redirect is received', async function() {
        let originalLocation = ypy._loc;
        let redirectUrl = null;
        ypy._loc = {
            get href() { return window.location.href; },
            set href(val) { redirectUrl = val; }
        };
        try {
            mockResponse('GET', '/test', '', { headers: { 'YPY-Redirect': '/other-page' } });
            createProcessedHTML(
                '<div id="indicator" class="ypy-indicator">Loading...</div>' +
                '<button id="btn" ypy-get="/test" ypy-indicator="#indicator">Click</button>'
            );
            find('#btn').click();
            await forRequest();
            await ypy.timeout(10);
            assert.equal(redirectUrl, location.origin + '/other-page');   // the validated, resolved URL is what is assigned
            assert.isTrue(find('#indicator').classList.contains('ypy-request'));
        } finally {
            ypy._loc = originalLocation;
        }
    })

});
