// SPDX-License-Identifier: MIT
describe('__normalizeSwapStyle unit tests', function() {

    it('normalizes before to beforebegin', function () {
        assert.equal(ypy.__normalizeSwapStyle('before'), 'beforebegin')
    })

    it('normalizes after to afterend', function () {
        assert.equal(ypy.__normalizeSwapStyle('after'), 'afterend')
    })

    it('normalizes prepend to afterbegin', function () {
        assert.equal(ypy.__normalizeSwapStyle('prepend'), 'afterbegin')
    })

    it('normalizes append to beforeend', function () {
        assert.equal(ypy.__normalizeSwapStyle('append'), 'beforeend')
    })

    it('passes through innerHTML unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('innerHTML'), 'innerHTML')
    })

    it('passes through outerHTML unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('outerHTML'), 'outerHTML')
    })

    it('passes through beforebegin unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('beforebegin'), 'beforebegin')
    })

    it('passes through afterbegin unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('afterbegin'), 'afterbegin')
    })

    it('passes through beforeend unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('beforeend'), 'beforeend')
    })

    it('passes through afterend unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('afterend'), 'afterend')
    })

    it('passes through delete unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('delete'), 'delete')
    })

    it('passes through none unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('none'), 'none')
    })

    it('passes through innerMorph unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('innerMorph'), 'innerMorph')
    })

    it('passes through outerMorph unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('outerMorph'), 'outerMorph')
    })

    it('passes through unknown values unchanged', function () {
        assert.equal(ypy.__normalizeSwapStyle('unknown'), 'unknown')
        assert.equal(ypy.__normalizeSwapStyle('custom'), 'custom')
    })

});