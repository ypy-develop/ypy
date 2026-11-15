// SPDX-License-Identifier: MIT
describe('__atributeValue() unit tests', function() {

    it(':append modifier appends to inherited value', function () {
        const container = createDisconnectedHTML(
            '<div ypy-include:inherited=".parent">' +
            '  <button ypy-include:append=".child">Test</button>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-include');
        assert.equal(result, '.parent,.child');
    });

    it(':append modifier works without inherited value', function () {
        const button = createDisconnectedHTML('<button ypy-include:append=".child">Test</button>');
        const result = ypy.__attributeValue(button, 'ypy-include');
        assert.equal(result, '.child');
    });

    it(':append modifier works with multiple inheritance levels', function () {
        const container = createDisconnectedHTML(
            '<div ypy-vals:inherited=\'{"a":1}\'>' +
            '  <div>' +
            '    <button ypy-vals:append=\'{"b":2}\'>Test</button>' +
            '  </div>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-vals');
        assert.equal(result, '"a":1,"b":2');
    });

    it(':inherited still works normally', function () {
        const container = createDisconnectedHTML(
            '<div ypy-include:inherited=".parent">' +
            '  <button>Test</button>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-include');
        assert.equal(result, '.parent');
    });

    it('direct attribute takes precedence over :append', function () {
        const container = createDisconnectedHTML(
            '<div ypy-include:inherited=".parent">' +
            '  <button ypy-include=".direct" ypy-include:append=".child">Test</button>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-include');
        assert.equal(result, '.direct');
    });

    it(':inherited:append modifier works', function () {
        const container = createDisconnectedHTML(
            '<div ypy-include:inherited=".grandparent">' +
            '  <div ypy-include:inherited:append=".parent">' +
            '    <button ypy-include:append=".child">Test</button>' +
            '  </div>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-include');
        assert.equal(result, '.grandparent,.parent,.child');
    });

    it(':inherited:append can be inherited by descendants', function () {
        const container = createDisconnectedHTML(
            '<div ypy-include:inherited:append=".parent">' +
            '  <button>Test</button>' +
            '</div>'
        );
        const button = container.querySelector('button');
        const result = ypy.__attributeValue(button, 'ypy-include');
        assert.equal(result, '.parent');
    });

});
