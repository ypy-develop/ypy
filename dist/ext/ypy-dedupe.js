// SPDX-License-Identifier: MIT
//==========================================================
// ypy-dedupe.js
//
// One request for identical GETs that are in flight together.
//
// Two elements (a poll and a click, the regions of a page that ask for the same fragment, a double
// click on a link) that send a GET with the same URL and the same relevant headers while the first
// one has not answered make a single request on the network. Every one of them gets the answer
// and swaps it into its own target, as if each had asked. The requests that join it fire
// ypy:dedupe:joined on their source element with {ctx, url, waiters}.
//
// Relevant headers are all the request headers except the ones that only say who asked
// (config.dedupe.ignore, a list of names, YPY-Source by default): YPY-Target and
// YPY-Request-Type decide what the server renders, so two requests that differ in them are two
// requests. A request that is not a GET is never shared.
//
// Each request keeps its own abort: the shared request is only aborted when every request that
// waits for it was aborted, so one element that is replaced does not cancel what the others wait
// for. An element opts out with ypy-dedupe="false" (a container does it for
// everything inside with ypy-dedupe:inherited="false").
//
// The extension wraps ctx.fetch, the way ypy-retry does; load it before ypy-retry to have each
// request retried on its own, after it to retry the shared one. Only the extension API is used.
//==========================================================
(() => {

    let api;
    const flights = new Map();   // key -> {promise, controller, waiters}

    const keyOf = (url, init) => {
        let ignore = (ypy.config.dedupe?.ignore ?? ['YPY-Source']).map(n => n.toLowerCase());
        let headers = Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])
            .filter(([k]) => !ignore.includes(k)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        return JSON.stringify([new URL(url, document.baseURI).href, init.credentials, init.cache, init.mode, headers]);
    };

    // the answer of the shared request, for one of the requests that wait for it
    const wait = (flight, signal) => new Promise((resolve, reject) => {
        flight.waiters++;
        let abort = () => {
            flight.waiters--;
            if (!flight.waiters) flight.controller.abort();
            reject(signal.reason);
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, {once: true});
        flight.promise.then(response => resolve(response.clone()), reject).finally(() => signal?.removeEventListener('abort', abort));
    });

    ypy.registerExtension('ypy-dedupe', {
        init: a => { api = a },

        ypy_before_request: (elt, {ctx}) => {
            let inner = ctx.fetch;
            if (!inner || ctx.request.method != 'GET' || api.attributeValue(ctx.sourceElement, 'ypy-dedupe') == 'false') return;
            ctx.fetch = (url, init) => {
                let key = keyOf(url, init), flight = flights.get(key);
                if (flight && !flight.controller.signal.aborted) {
                    api.triggerEvent(ctx.sourceElement, 'ypy:dedupe:joined', {ctx, url, waiters: flight.waiters + 1});
                } else {
                    let controller = new AbortController();
                    flight = {controller, waiters: 0, promise: inner(url, {...init, signal: controller.signal})};
                    flights.set(key, flight);
                    let end = () => { if (flights.get(key) === flight) flights.delete(key) };
                    flight.promise.then(end, end);
                }
                return wait(flight, init.signal);
            };
        }
    });

})();
