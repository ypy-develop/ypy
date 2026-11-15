// SPDX-License-Identifier: MIT
// ypy-focus: a boosted link that sits inside what the swap replaces. The source element is gone after
// the swap (the core moves it to the swap target, which was not boosted itself), and the focus still
// goes to the heading of the new page, as it does for any boosted navigation.
describe('ypy-focus when the boosted link is replaced by the swap', function () {

    beforeEach(function () { setupTest(this.currentTest); });

    afterEach(function () {
        cleanupTest();
        if (document.activeElement !== document.body) document.activeElement.blur();
    });

    it('focuses the h1 of the new main', async function () {
        mockResponse('GET', '/next', '<main><h1>Next page</h1></main><a id="b" href="/next">again</a>');
        createProcessedHTML('<div id="box"><main><h1>Old page</h1></main>' +
            '<a id="a" href="/next" ypy-boost="true" ypy-target="#box" ypy-swap="innerHTML" ypy-push-url="false">Go</a></div>');
        find('#a').click();
        await forRequest();
        assert.isNull(document.getElementById('a'), 'the link was replaced');
        assert.equal(document.activeElement.tagName, 'H1');
        assert.equal(document.activeElement.textContent, 'Next page');
    });
});
