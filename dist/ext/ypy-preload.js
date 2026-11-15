// SPDX-License-Identifier: MIT
(()=>{
    let api;

    function initializePreload(elt) {
        let preloadSpec = api.attributeValue(elt, "ypy-preload");
        if (preloadSpec == undefined && !elt._ypy?.boosted) return;

        let preloadEvents = []
        let timeout = 5000;
        if (preloadSpec) {
            let specs = api.parseTriggerSpecs(preloadSpec);
            if (specs.length === 0) return;
            for (const spec of specs) {
                preloadEvents.push(spec.name)
                if (spec.timeout) {
                    timeout = ypy.parseInterval(spec.timeout)
                }
            }
        } else {
            let isBoostedAnchor = elt._ypy?.boosted && elt.tagName === "A";
            let isYpyGet = api.attributeValue(elt, "ypy-get") != null;
            if (!isBoostedAnchor && !isYpyGet) return;
            if (isBoostedAnchor && ypy.config?.preload?.autoBoost === false) return;
            if (ypy.config?.preload?.boostTimeout) {
                timeout = ypy.parseInterval(ypy.config.preload.boostTimeout)
            }
            preloadEvents.push(ypy.config?.preload?.boostEvent || "mousedown");
            preloadEvents.push("touchstart");
        }

        let preloadListener = async (evt) => {
            let {method} = api.determineMethodAndAction(elt, evt);
            if (method !== 'GET') return;

            if (elt._ypy?.preload) return;

            let ctx = api.createRequestContext(elt, evt);
            ctx.request.mode = ypy.config.mode;   // the pin of a normal request (ypy:config:request never fires here): a boost value cannot lift it
            let form = elt.form || elt.closest("form");
            let body = api.collectFormData(elt, form, evt.submitter);
            let valsResult = api.getAttributeObject(elt, 'ypy-vals', obj => {
                for (let key in obj) body.set(key, obj[key]);
            });
            if (valsResult) await valsResult;

            ctx.request.headers["YPY-Request-Type"] = (ctx.target === document.body || ctx.select) ? "full" : "partial";

            let action = ctx.request.action.replace?.(/#.*$/, '');

            let params = new URLSearchParams(body);
            if (params.size) action += (/\?/.test(action) ? "&" : "?") + params;

            let url = new URL(action, location.href);
            elt._ypy.preload = {
                prefetch: fetch(action, ctx.request),
                action: url.origin === location.origin ? url.pathname + url.search : url.href,
                expiresAt: Date.now() + timeout
            };

            try {
                await elt._ypy.preload.prefetch;
            } catch (error) {
                delete elt._ypy.preload;
            }
        };
        for (let eventName of preloadEvents) {
            elt.addEventListener(eventName, preloadListener, { passive: true });
        }
        elt._ypy.preloadListener = preloadListener;
        elt._ypy.preloadEvents = preloadEvents;
    }

    ypy.registerExtension('ypy-preload', {
        init: (internalAPI) => {
            api = internalAPI;
        },

        ypy_after_init: (elt) => {
            initializePreload(elt);
        },

        ypy_before_request: (elt, detail) => {
            let {ctx} = detail;
            if (elt._ypy?.preload &&
                elt._ypy.preload.action === ctx.request.action &&
                Date.now() < elt._ypy.preload.expiresAt) {
                let prefetch = elt._ypy.preload.prefetch;
                ctx.fetch = () => prefetch;
                delete elt._ypy.preload;
            } else {
                if (elt._ypy) delete elt._ypy.preload;
            }
        },

        ypy_before_cleanup: (elt) => {
            if (elt._ypy?.preloadListener) {
                for (let eventName of elt._ypy.preloadEvents) {
                    elt.removeEventListener(eventName, elt._ypy.preloadListener);
                }
            }
        }
    });
})();
