// SPDX-License-Identifier: MIT
describe('__handleStatusCodes unit tests', function() {

    beforeEach(function() {
        setupTest();
    });

    afterEach(function() {
        cleanupTest();
    });

    it('sets swap to none for 204 status', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 204 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'none')
    })

    it('sets swap to none for 304 status', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 304 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'none')
    })

    it('does not change swap for 200 status', function () {
        let div = createProcessedHTML('<div ypy-get="/test"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 200 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'innerHTML')
    })

    it('applies ypy-status:404 override', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:404="swap:outerHTML"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 404 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'outerHTML')
    })

    it('applies ypy-status:4xx pattern match', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:4xx="swap:delete"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 403 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'delete')
    })

    it('applies ypy-status:5xx pattern match', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:5xx="swap:none"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 500 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'none')
    })

    it('prefers exact match over pattern match', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:404="swap:outerHTML" ypy-status:4xx="swap:delete"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            response: {
                raw: { status: 404 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'outerHTML')
    })

    it('parses target modifier in ypy-status value', function () {
        createProcessedHTML('<div id="error-target"></div>')
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:4xx="swap:innerHTML target:#error-target"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'outerHTML',
            target: div,
            response: {
                raw: { status: 404 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        // Object.assign sets both swap and target on ctx
        assert.equal(ctx.swap, 'innerHTML')
        assert.equal(ctx.target, '#error-target')
    })

    it('can set multiple ctx properties with ypy-status', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:500="swap:none select:#error push:false"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            select: null,
            push: 'true',
            response: {
                raw: { status: 500 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.swap, 'none')
        assert.equal(ctx.select, '#error')
        assert.equal(ctx.push, false)
    })

    it('ypy-status can override any ctx property', function () {
        let div = createProcessedHTML('<div ypy-get="/test" ypy-status:404="target:#alt swap:outerHTML transition:false"></div>')
        let ctx = {
            sourceElement: div,
            swap: 'innerHTML',
            target: '#main',
            transition: true,
            response: {
                raw: { status: 404 }
            }
        }

        ypy.__handleStatusCodes(ctx)

        assert.equal(ctx.target, '#alt')
        assert.equal(ctx.swap, 'outerHTML')
        assert.equal(ctx.transition, false)
    })

});
