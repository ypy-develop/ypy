// SPDX-License-Identifier: MIT
describe('ypy.config.metaCharacter functionality', function() {

    beforeEach(function() {
        setupTest(this);
        ypy.config.metaCharacter = "-";
    });

    afterEach(function() {
        cleanupTest();
        ypy.config.metaCharacter = null;
    });

    it('works with inherited modifier using custom meta character', async function() {
        mockResponse('GET', '/test', 'Success');
        createProcessedHTML('<div ypy-target-inherited="#output"><button ypy-get="/test" id="btn">Click</button><output id="output"></output></div>');
        find('#btn').click()
        await forRequest();
        var output = find("#output");
        output.innerText.should.equal("Success")
    });

    it('works with append modifier using custom meta character', function() {
        const container = createDisconnectedHTML(
            '<div ypy-vals-inherited=\'"a":1\'>' +
            '  <button ypy-vals-append=\'"b":2\'>Test</button>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-vals');
        assert.equal(result, '"a":1,"b":2');
    });

    it('works with inherited-append modifier using custom meta character', function() {
        const container = createDisconnectedHTML(
            '<div ypy-vals-inherited=\'"a":1\'>' +
            '  <div ypy-vals-inherited-append=\'"b":2\'>' +
            '    <button ypy-vals-append=\'"c":3\'>Test</button>' +
            '  </div>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-vals');
        assert.equal(result, '"a":1,"b":2,"c":3');
    });

    it('normalizes attribute names using custom meta character', function() {
        const div = createDisconnectedHTML(
            '<div ypy-ws-connect="/ws" ypy-ws-send></div>'
        );

        assert.equal(ypy.__attributeValue(div, 'ypy-ws:connect'), '/ws');
        assert.equal(ypy.__attributeValue(div, 'ypy-ws:send'), '');
    });

    it('onLoad works with custom meta character', function() {
        let fired = false;
        ypy.onLoad(() => fired = true);
        createProcessedHTML('<div ypy-get="/test">Test</div>');
        assert.isTrue(fired);
    });

    it('works with ypy-on events using custom meta character', async function() {
        let eventFired = false;
        createProcessedHTML('<button id="btn" ypy-on-click="window.testEvent = true">Click</button>');

        find('#btn').click();
        await ypy.timeout(50);

        assert.equal(window.testEvent, true);
        delete window.testEvent;
    });

});
