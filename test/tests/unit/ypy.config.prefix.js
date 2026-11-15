// SPDX-License-Identifier: MIT
describe('ypy.config.prefix functionality', function() {

    beforeEach(function() {
        setupTest(this);
    });

    afterEach(function() {
        cleanupTest();
    });

    it('default prefix (empty string) works normally', async function() {
        ypy.config.prefix = "";
        mockResponse('GET', '/test', 'Success');

        createProcessedHTML('<button id="btn" ypy-get="/test">Click</button>');
        find('#btn').click()
        await forRequest();

        let lastCall = lastFetch();
        assert.equal(lastCall.url, '/test');
    });

    it('custom prefix replaces ypy- in attributes', function() {
        ypy.config.prefix = "data-ypy-";

        let btn = createDisconnectedHTML('<button data-ypy-get="/custom"></button>');
        assert.equal(ypy.__attr(btn, "ypy-get"), "/custom");
        assert.equal(ypy.__attr(btn, "ypy-target"), null);

        ypy.config.prefix = "";
    });

    it('custom prefix is used in __attributeValue', function() {
        ypy.config.prefix = "data-ypy-";

        let btn = createDisconnectedHTML('<button data-ypy-get="/custom" data-ypy-target="#result">Click</button>');

        let getValue = ypy.__attributeValue(btn, "ypy-get");
        assert.equal(getValue, "/custom");

        let targetValue = ypy.__attributeValue(btn, "ypy-target");
        assert.equal(targetValue, "#result");

        ypy.config.prefix = "";
    });

    it('custom prefix works with trigger attribute', function() {
        ypy.config.prefix = "data-ypy-";

        let called = 0;
        let btn = createDisconnectedHTML('<button>Click</button>');
        btn.setAttribute('data-ypy-trigger', 'click');
        ypy.__ypyProp(btn);
        ypy.__initializeTriggers(btn, () => called++);

        btn.click();
        assert.equal(called, 1);

        ypy.config.prefix = "";
    });

    it('empty prefix disables secondary prefix', function() {
        ypy.config.prefix = "";

        let btn = createDisconnectedHTML('<button ypy-get="/primary"></button>');
        assert.equal(ypy.__attr(btn, "ypy-get"), "/primary");
    });

    it('ypy- always works regardless of prefix setting', function() {
        ypy.config.prefix = "data-ypy-";

        let btn = createDisconnectedHTML('<button ypy-get="/primary"></button>');
        assert.equal(ypy.__attributeValue(btn, "ypy-get"), "/primary");

        ypy.config.prefix = "";
    });

    it('secondary prefix found when ypy- is absent', function() {
        ypy.config.prefix = "data-ypy-";

        let btn = createDisconnectedHTML('<button data-ypy-get="/secondary"></button>');
        assert.equal(ypy.__attributeValue(btn, "ypy-get"), "/secondary");

        ypy.config.prefix = "";
    });

    it('ypy- wins over secondary prefix when both present', function() {
        ypy.config.prefix = "data-ypy-";

        let btn = createDisconnectedHTML('<button ypy-get="/first" data-ypy-get="/second"></button>');
        assert.equal(ypy.__attributeValue(btn, "ypy-get"), "/first");

        ypy.config.prefix = "";
    });

    it('inheritance works with secondary prefix on parent', function() {
        ypy.config.prefix = "data-ypy-";

        let container = createDisconnectedHTML(
            '<div data-ypy-target:inherited="#output">' +
            '  <button ypy-get="/test"></button>' +
            '</div>'
        );
        let button = container.querySelector('button');
        assert.equal(ypy.__attributeValue(button, "ypy-target"), "#output");

        ypy.config.prefix = "";
    });

    it('custom prefix works with attribute inheritance', function() {
        ypy.config.prefix = "data-ypy-";

        let container = createDisconnectedHTML(
            '<div data-ypy-target:inherited="#output">' +
            '  <button data-ypy-get="/test">Click</button>' +
            '</div>'
        );
        let button = container.querySelector('button');
        let targetValue = ypy.__attributeValue(button, "ypy-target");
        assert.equal(targetValue, "#output");

        ypy.config.prefix = "";
    });
});
