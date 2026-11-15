// SPDX-License-Identifier: MIT
//==========================================================
// ypy-poll.js
//
// Smart polling for `every` triggers:
//   - in a background tab the poll slows down (4 times by default) or pauses,
//     and when the tab is shown again it refreshes at once if a poll is due
//   - the server sets the interval with the response header
//     YPY-Poll-Interval: <ms | 2s | 500ms | 1m>
//   - the status 286 stops the polling of that element (ypy:poll:stop)
//
// Usage:
//   <div ypy-get="/news" ypy-trigger="every 5s">...</div>
//   <div ypy-get="/news" ypy-trigger="every 5s" ypy-poll="hidden:pause">...</div>
//
// Options (attribute value or ypy.config.poll):
//   hidden:<n>      factor applied to the interval while the tab is hidden (default 4)
//   hidden:pause    no polling while the tab is hidden
//   min:<time>      shortest interval a server may ask for (default 100ms)
// ypy-poll="false" leaves the element to the core.
//==========================================================
(() => {
    let api;
    let entries = new Set();   // one per `every` spec that this extension drives

    let now = () => performance.now();

    // The options of an element: the defaults, ypy.config.poll, then the attribute.
    function options(elt) {
        let attr = api.attributeValue(elt, 'ypy-poll');
        return {hidden: 4, min: 100, ...ypy.config.poll, ...(attr == 'false' ? {} : api.HCON.parse(attr))};
    }

    // How many times slower the poll runs now: 1 in a visible tab, Infinity when it pauses.
    function factor(e) {
        if (!document.hidden) return 1;
        let h = options(e.elt).hidden;
        return h === 'pause' || h === false || h == 0 ? Infinity : h >= 1 ? +h : 4;
    }

    function stop(e) {
        clearTimeout(e.timer);
        e.stopped = true;
        entries.delete(e);
    }

    // Plans the next poll from the moment of the last one, so a change of interval or of
    // visibility never makes a poll come earlier than it is due, nor later.
    function schedule(e) {
        clearTimeout(e.timer);
        let f = factor(e);
        if (e.stopped || f === Infinity) return;
        e.timer = setTimeout(tick, Math.max(0, e.ms * f - (now() - e.last)), e);
    }

    function tick(e) {
        if (!e.elt.isConnected) return stop(e);
        e.last = now();
        api.triggerEvent(e.elt, 'every', {}, false);
        schedule(e);
    }

    // The interval a server asks for, in ms, or undefined when the header is missing or invalid.
    function serverInterval(elt, value) {
        let ms = ypy.parseInterval(String(value ?? '').trim());
        return ms > 0 ? Math.max(ms, ypy.parseInterval(options(elt).min) || 0) : undefined;
    }

    ypy.registerExtension('ypy-poll', {
        init(internalAPI) {
            api = internalAPI;
            document.addEventListener('visibilitychange', () => entries.forEach(schedule));
        },

        // The core starts a setInterval for each `every`: this takes it over.
        ypy_after_init(elt) {
            if (api.attributeValue(elt, 'ypy-poll') == 'false') return;
            let polls = [];
            for (let spec of api.ypyProp(elt).triggerSpecs) {
                let ms = spec.name === 'every' && spec.interval && ypy.parseInterval(Object.keys(spec).find(k => k !== 'name'));
                if (!(ms > 0)) continue;
                clearInterval(spec.interval);
                let e = {elt, spec, ms, last: now()};
                entries.add(e);
                polls.push(e);
                schedule(e);
            }
            if (polls.length) api.ypyProp(elt).poll = polls;
        },

        ypy_before_cleanup(elt) {
            elt._ypy?.poll?.forEach(stop);
            if (elt._ypy) elt._ypy.poll = null;
        },

        ypy_after_request(elt, {ctx}) {
            let res = ctx.response, polls = elt._ypy?.poll;
            if (res?.status === 286) {
                polls?.forEach(stop);
                // an element left to the core, or driven by the core, stops too
                for (let spec of elt._ypy?.triggerSpecs || []) if (spec.name === 'every') clearInterval(spec.interval);
                api.triggerEvent(elt, 'ypy:poll:stop', {ctx, status: 286});
                return;
            }
            let ms = polls && serverInterval(elt, res?.headers?.get?.('YPY-Poll-Interval'));
            if (ms) for (let e of polls) { e.ms = ms; schedule(e) }
        }
    });
})();
