// SPDX-License-Identifier: MIT
//==========================================================
// ypy-test.js
//
// "Has the page settled?" for end-to-end tests, so a test waits for the page instead of sleeping.
//
//   await ypy.idle()                      resolves when nothing is left to wait for
//   await ypy.idle({timeout: 3000})       rejects with an Error after 3 s, naming what is still busy
//   await ypy.idle({quiet: 0})            no grace period after the last piece of work
//
// The page is busy while any of these is pending:
//   request   a request is in flight (from ypy:before:request to ypy:finally:request)
//   queued    a request waits its turn in an ypy-sync queue
//   swap      a response is being put into the page (ypy:before:swap to ypy:finally:swap)
//   settle    new content is settling (ypy:before:settle to ypy:after:settle), also for the
//             content that a stream or a server-sent event inserts
// A request that turned into a server-sent event stream is not counted: it stays open for as long
// as the page lives. A WebSocket is not counted either. Polling counts only while a poll runs.
//
// While there is pending work, <html> carries data-ypy-busy="request swap" (the kinds of work, space
// separated) and loses it when the work ends, so a test can also wait for the DOM:
//   await page.waitForSelector('html:not([data-ypy-busy])')
//
// After the last piece of work ends, ypy.idle waits a short quiet period (default 50 ms) and
// checks again, because the content that was just swapped in may start the next request (a load
// trigger). Once it resolves it fires ypy:test:idle on the document with {waited}.
//
// Playwright:
//   await page.click('#save');
//   await page.evaluate(() => ypy.idle());
//   await expect(page.locator('#flash')).toHaveText('Saved');
//
// Configuration (ypy.config.test): timeout (ms, default 5000, 0 waits for ever), quiet (ms, default 50).
// Both accept a time such as "2s" and can be overridden in the call.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {

    let api;
    const work = {request: new Set, queued: new Set, swap: new Set, settle: new Map};
    const waiters = new Set;
    const cfg = () => ypy.config.test || {};

    // Reflects the pending work on <html> and arms the quiet timer of every waiting idle().
    function sync() {
        let kinds = Object.keys(work).filter(k => work[k].size).join(' '),
            html = document.documentElement;
        if (html.getAttribute('data-ypy-busy') !== (kinds || null)) {
            kinds ? html.setAttribute('data-ypy-busy', kinds) : html.removeAttribute('data-ypy-busy');
        }
        for (let w of waiters) {
            clearTimeout(w.quiet);
            if (!kinds) w.quiet = setTimeout(() => w.end(), w.wait);
        }
    }

    const forget = (kind, key) => { work[kind].delete(key); sync() };

    function idle(options = {}) {
        let time = (name, fallback) => ypy.parseInterval(options[name] ?? cfg()[name] ?? fallback),
            timeout = time('timeout', 5000), started = Date.now();
        return new Promise((resolve, reject) => {
            let w = {wait: time('quiet', 50)};
            w.end = error => {
                clearTimeout(w.quiet);
                clearTimeout(w.limit);
                waiters.delete(w);
                if (error) return reject(new Error(`ypy.idle: still busy (${Object.keys(work).filter(k => work[k].size).join(', ')}) after ${timeout} ms`));
                resolve();
                api.triggerEvent(document, 'ypy:test:idle', {waited: Date.now() - started});
            };
            if (timeout > 0) w.limit = setTimeout(() => w.end(true), timeout);
            waiters.add(w);
            sync();
        });
    }

    ypy.registerExtension('ypy-test', {
        init: a => {
            api = a;
            ypy.idle = idle;
        },

        ypy_request_queued: (elt, {ctx}) => { work.queued.add(ctx); sync() },
        ypy_request_dropped: (elt, {ctx}) => forget('queued', ctx),

        ypy_before_request: (elt, {ctx}) => {
            work.queued.delete(ctx);
            work.request.add(ctx);
            // an event stream keeps its request open for ever: it is not work to wait for
            let fetch = ctx.fetch;
            ctx.fetch = async (...args) => {
                let response = await fetch(...args);
                let h = response.headers;   // a Headers object, or a Map with the name as the server wrote it
                if (/event-stream/i.test(h?.get('content-type') ?? h?.get('Content-Type'))) forget('request', ctx);
                return response;
            };
            sync();
        },

        // finally:request fires for every admitted request, a cancelled or denied one included
        ypy_finally_request: (elt, {ctx}) => { work.queued.delete(ctx); forget('request', ctx) },

        ypy_before_swap: (elt, {ctx}) => { work.swap.add(ctx); sync() },
        ypy_finally_swap: (elt, {ctx}) => forget('swap', ctx),

        // a settle that never ends (a throwing settle task) must not keep the page busy for ever
        ypy_before_settle: (elt, {task}) => {
            work.settle.set(task, setTimeout(() => forget('settle', task), 10000));
            sync();
        },
        ypy_after_settle: (elt, {task}) => {
            clearTimeout(work.settle.get(task));
            forget('settle', task);
        }
    });

})();
