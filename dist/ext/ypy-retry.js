// SPDX-License-Identifier: MIT
//==========================================================
// ypy-retry.js
//
// Automatic retry of failed requests for ypy.
//
// A request that fails is repeated with an exponential backoff. Retry is off unless config.retry
// or the ypy-retry attribute (inherited with ypy-retry:inherited) sets attempts.
//
// Options (attribute value or config.retry): attempts (default 3 for a bare attribute, else 0),
// delay (1s), max (30s), backoff (2: each wait is that many times longer), jitter (see below),
// on (what counts as a failure, see below), methods (a string or array of upper-case names,
// narrows the safe ones) and unsafe (false: GET, HEAD and QUERY only, because the server may have
// run any other method). ypy-retry="false" turns it off.
//
// on: "network" (the default) repeats only a fetch that rejected (no connection, server
// unreachable); "error" also repeats a response with status 500 or more; "always" also repeats
// any response with status 400 or more; "never" turns it off. The last attempt is not repeated:
// its response goes through the normal flow, so the page shows the error as without retry.
//
// jitter: a fraction (0.2) or a percentage ("20%") by which each wait varies at random, up and
// down, so that many clients do not come back at the same moment. 0 (the default of this
// version) keeps the waits exact.
//
// Retry-After: a 503 or 429 that is repeated is awaited at least as long as its Retry-After
// header says (seconds or an HTTP date, never made shorter by jitter). When the header asks for
// more than max, the request is not repeated: the answer is given to the page as it is.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// How it hooks in: the core calls ctx.fetch once per request. From ypy_before_request this
// extension wraps ctx.fetch with the loop, so the request keeps its queue slot and its
// indicators while it waits and the request events fire once. Each repeat fires the cancelable
// ypy:request:retry event on the source element with {attempt, delay, ctx, status}, where status
// is the response status that is repeated (undefined after a network failure). The wait ends at the
// delay or when the window reports "online", whichever comes first, and a request that is
// aborted (timeout included) or whose element is cleaned up is never repeated. The request
// timeout is the deadline of all the attempts together.
//
// Usage:
//   <script src="ypy-retry.js"></script>
//   <button ypy-get="/feed" ypy-retry="attempts:3 delay:1s">Load</button>
//==========================================================
(() => {

    let api;

    // What each mode repeats, besides a fetch that rejected
    const MODES = {network: () => false, error: status => status >= 500, always: status => status >= 400, never: () => false};
    const JITTER = 0;

    // Retry-After in ms: a number of seconds or an HTTP date; undefined when absent or not valid
    function retryAfter(value) {
        if (value == null) return;
        let ms = /^\s*\d+\s*$/.test(value) ? value * 1000 : Date.parse(value) - Date.now();
        if (ms >= 0) return ms;
    }

    // A fraction, or a percentage written "20%", kept between 0 and 1
    function fraction(v) {
        let n = typeof v == 'string' ? parseFloat(v) / (v.trim().endsWith('%') ? 100 : 1) : +v;
        return n > 0 ? Math.min(1, n) : 0;
    }

    // How long to wait before repeating a failed request, or undefined when it must not be repeated.
    // `response` is the answer that failed; it is absent after a network failure.
    function retryDelay(ctx, attempt, response) {
        let method = ctx.request.method, attr = api.attributeValue(ctx.sourceElement, 'ypy-retry');
        let o = {attempts: attr == null ? 0 : 3, delay: 1000, max: 30000, backoff: 2, jitter: JITTER, on: 'network', ...ypy.config.retry, ...api.HCON.parse(attr)};
        let mode = MODES[o.on] ? o.on : 'network', status = response?.status;
        if (attr === 'false' || mode == 'never' || attempt > o.attempts || response && !MODES[mode](status)
            || !(o.unsafe || /^(GET|HEAD|QUERY)$/.test(method) && (o.methods || method).includes(method))) return;
        let max = ypy.parseInterval(o.max), jitter = fraction(o.jitter);
        let wait = ypy.parseInterval(o.delay) * o.backoff ** (attempt - 1) * (1 + jitter * (2 * Math.random() - 1));
        let after = status == 503 || status == 429 ? retryAfter(response.headers.get('Retry-After')) : undefined;
        if (after > max) return;
        return Math.min(max, Math.max(wait, after ?? 0));
    }

    // Waits for the next attempt: until the delay has passed or the window reports "online".
    // Rejects with the abort reason when the request is aborted, and aborts it when its element
    // is cleaned up, so no timer or listener outlives the request.
    function retryWait(ctx, delay) {
        let {signal} = ctx.request, off = new AbortController(), on = {signal: off.signal}, timer;
        return new Promise((resolve, reject) => {
            let end = ok => { clearTimeout(timer); off.abort(); ok ? resolve() : reject(signal.reason) };
            timer = setTimeout(end, delay, true);
            window.addEventListener('online', () => end(true), on);
            signal.addEventListener('abort', () => end(), on);
            ctx.sourceElement.addEventListener('ypy:before:cleanup', () => ctx.request.abort(), on);
        });
    }

    ypy.registerExtension('ypy-retry', {

        init: (internalApi) => { api = internalApi },

        ypy_before_request: (elt, {ctx}) => {
            let inner = ctx.fetch;
            // An accessor, so a listener that replaces ctx.fetch later still runs inside the loop
            Object.defineProperty(ctx, 'fetch', {
                configurable: true,
                get: () => async (action, request) => {
                    for (let attempt = 1; ; attempt++) {
                        let response, failure;
                        try {
                            response = await inner(action, request);
                        } catch (error) {
                            failure = error;
                        }
                        let delay = request.signal.aborted ? null : retryDelay(ctx, attempt, response);
                        if (delay == null || !api.triggerEvent(elt, 'ypy:request:retry', {attempt, delay, ctx, status: response?.status})) {
                            if (failure) throw failure;
                            return response;
                        }
                        // the answer that is repeated is not read: let go of its connection
                        response?.body?.cancel?.()?.catch(() => {});
                        await retryWait(ctx, delay);
                    }
                },
                set: fn => { inner = fn }
            });
        }
    });

})();
