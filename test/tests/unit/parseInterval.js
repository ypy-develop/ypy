// SPDX-License-Identifier: MIT
describe('parseInterval unit tests', function() {

    it('parses milliseconds', function () {
        assert.equal(ypy.parseInterval('100ms'), 100)
        assert.equal(ypy.parseInterval('1ms'), 1)
        assert.equal(ypy.parseInterval('5000ms'), 5000)
    })

    it('parses seconds', function () {
        assert.equal(ypy.parseInterval('1s'), 1000)
        assert.equal(ypy.parseInterval('2s'), 2000)
        assert.equal(ypy.parseInterval('10s'), 10000)
    })

    it('parses minutes', function () {
        assert.equal(ypy.parseInterval('1m'), 60000)
        assert.equal(ypy.parseInterval('2m'), 120000)
        assert.equal(ypy.parseInterval('5m'), 300000)
    })

    it('parses decimal values', function () {
        assert.equal(ypy.parseInterval('1.5s'), 1500)
        assert.equal(ypy.parseInterval('0.5s'), 500)
        assert.equal(ypy.parseInterval('2.5m'), 150000)
    })

    it('defaults to milliseconds when no unit specified', function () {
        assert.equal(ypy.parseInterval('100'), 100)
        assert.equal(ypy.parseInterval('1000'), 1000)
        assert.equal(ypy.parseInterval('5'), 5)
    })

    it('handles decimal without unit', function () {
        assert.equal(ypy.parseInterval('1.5'), 1.5)
        assert.equal(ypy.parseInterval('100.25'), 100.25)
    })

    it('returns undefined for invalid input', function () {
        assert.equal(ypy.parseInterval('abc'), undefined)
        assert.equal(ypy.parseInterval('invalid'), undefined)
        assert.equal(ypy.parseInterval(''), undefined)
    })

    it('returns undefined for null', function () {
        assert.equal(ypy.parseInterval(null), undefined)
    })

    it('returns undefined for undefined', function () {
        assert.equal(ypy.parseInterval(undefined), undefined)
    })

    it('returns undefined for invalid unit', function () {
        assert.equal(ypy.parseInterval('100h'), undefined)
        assert.equal(ypy.parseInterval('50d'), undefined)
    })

    it('returns undefined for negative values', function () {
        assert.equal(ypy.parseInterval('-100ms'), undefined)
        assert.equal(ypy.parseInterval('-1s'), undefined)
    })

    it('handles zero', function () {
        assert.equal(ypy.parseInterval('0'), 0)
        assert.equal(ypy.parseInterval('0ms'), 0)
        assert.equal(ypy.parseInterval('0s'), 0)
    })

    it('handles very large numbers', function () {
        assert.equal(ypy.parseInterval('999999ms'), 999999)
        assert.equal(ypy.parseInterval('1000s'), 1000000)
    })

    it('returns undefined for strings with spaces', function () {
        assert.equal(ypy.parseInterval('100 ms'), undefined)
        assert.equal(ypy.parseInterval(' 100ms'), undefined)
        assert.equal(ypy.parseInterval('100ms '), undefined)
    })

});