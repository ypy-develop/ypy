// SPDX-License-Identifier: MIT
//
// Runs one test file with mocha and reports the outcome to the runner:
//   /__ypy__/runner.js?file=/test/tests/x.js&timeout=2000&grep=re
// Mocha (bdd) is loaded before this module as window.mocha.

const params = new URL(import.meta.url).searchParams
const file = params.get('file')
const timeout = Number(params.get('timeout')) || 2000
const grep = params.get('grep')

function plainError (err) {
    if (err && typeof err === 'object') {
        return {
            name: String(err.name || 'Error'),
            message: String(err.message !== undefined ? err.message : err),
            stack: err.stack ? String(err.stack) : ''
        }
    }
    return { name: 'Error', message: String(err), stack: '' }
}

const failures = new Map()
const hookErrors = []

function Collector (runner) {
    runner.on('fail', (test, err) => {
        if (test.type === 'hook') hookErrors.push({ title: test.titlePath ? test.titlePath() : [test.title], error: plainError(err) })
        else failures.set(test, plainError(err))
    })
}

function walk (suite, out) {
    for (const test of suite.tests) {
        let status = null
        if (test.isPending()) status = 'skipped'
        else if (test.state === 'passed') status = 'passed'
        else if (test.state === 'failed') status = 'failed'
        if (!status) continue
        out.push({
            path: test.titlePath(),
            status,
            duration: test.duration || 0,
            error: status === 'failed' ? (failures.get(test) || { name: 'Error', message: 'failed', stack: '' }) : null
        })
    }
    for (const child of suite.suites) walk(child, out)
}

async function main () {
    mocha.setup({ ui: 'bdd', reporter: Collector, timeout, allowUncaught: false })
    if (grep) mocha.grep(new RegExp(grep))
    try {
        await import(file)
    } catch (err) {
        await window.__ypyReport({ importError: plainError(err) })
        return
    }
    mocha.run(() => {
        setTimeout(() => {
            const tests = []
            walk(mocha.suite, tests)
            // a report that cannot be sent must not leave the page silent
            window.__ypyReport({ tests, hookErrors }).then(res => {
                if (!res.ok) throw new Error('the runner answered ' + res.status)
            }).catch(err => window.__ypyReport({ importError: plainError(new Error('could not send the results: ' + err.message)) }))
        })
    })
}

main().catch(err => window.__ypyReport({ importError: plainError(err) }))
