// SPDX-License-Identifier: MIT
describe('loading YPY twice', function() {
    it('a second script keeps the first instance and warns', async function() {
        let first = [...document.scripts].find(s => /\/ypy(\.min)?\.js(\?|$)/.test(s.src))
        assert.ok(first, 'the page loads ypy as a classic script')
        let before = window.ypy, warnings = [], warn = console.warn
        console.warn = (...args) => { warnings.push(args.join(' ')) }
        try {
            await new Promise((resolve, reject) => {
                let again = document.createElement('script')
                again.src = first.src
                again.onload = resolve
                again.onerror = reject
                document.head.appendChild(again)
            })
        } finally {
            console.warn = warn
        }
        assert.strictEqual(window.ypy, before)
        assert.isTrue(warnings.some(w => w.includes('loaded twice')), 'it warns')
    })

    it('the first instance still works afterwards', async function() {
        setupTest(this.test)
        mockResponse('GET', '/test', 'Clicked!')
        createProcessedHTML('<button ypy-get="/test">Go</button>')
        find('button').click()
        await forRequest()
        playground().innerText.should.equal('Clicked!')
        cleanupTest()
    })
})
