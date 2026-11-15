// SPDX-License-Identifier: MIT
//==========================================================
// ypy-ptag.js
//
// An extension for per-element polling tags (ptags) that
// allow servers to skip swaps when content hasn't changed.
//
// Usage:
//   <div ypy-get="/news" ypy-trigger="every 3s" ypy-ptag="initial-value">
//     Latest News...
//   </div>
//
// The server responds with an YPY-PTag header. On subsequent
// requests, the stored ptag is sent as an YPY-PTag request
// header. If nothing changed, the server returns 304.
//==========================================================
(() => {
    let api;
    ypy.registerExtension('ypy-ptag', {
        init(internalAPI) { api = internalAPI },

        ypy_after_init(elt) {
            let ptag = api.attributeValue(elt, "ypy-ptag");
            if (ptag) api.ypyProp(elt).ptag = ptag;
        },

        ypy_config_request(elt, {ctx}) {
            let ptag = elt._ypy?.ptag;
            if (ptag) ctx.request.headers["YPY-PTag"] = ptag;
        },

        ypy_after_request(elt, {ctx}) {
            let ptag = ctx.response?.headers?.get?.("YPY-PTag");
            if (ptag) api.ypyProp(elt).ptag = ptag;
        }
    });
})();
