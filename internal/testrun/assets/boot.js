// SPDX-License-Identifier: MIT
//
// First script of every test page. It keeps private references to what the
// page needs to talk to the runner, because tests replace window.fetch.
(function () {
    'use strict'
    var realFetch = window.fetch.bind(window)
    var session = new URL(location.href).searchParams.get('ypy-session')
    window.__ypyReport = function (payload) {
        return realFetch('/__ypy__/result?session=' + encodeURIComponent(session), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
    }
})()
