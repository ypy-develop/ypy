// SPDX-License-Identifier: MIT
//==========================================================
// ypy-disable.js
//
// Holds elements back while a request runs:
//
//   ypy-disable  a selector (or an extended selector) of the elements that are `disabled` until the
//                request ends. Several requests may name the same element: it is enabled again when
//                the last of them ends.
//   ypy-inert    `true` makes the target of the request `inert` for the same time; `false` turns it
//                off for one element when ypy.config.inert is on.
//
// Usage:
//   <form ypy-post="/save" ypy-disable="find button">...</form>
//   <button ypy-get="/panel" ypy-target="#panel" ypy-inert="true">Refresh</button>
//
// The elements go in ctx.disabledElements. A request that hands its indicators to a follow-up
// (the YPY-Location header) hands these over too, and the follow-up releases them.
//==========================================================
(() => {
    let api;
    // how many requests hold each element
    let holds = new WeakMap();

    ypy.registerExtension('ypy-disable', {
        init(internalAPI) {
            api = internalAPI;
        },
        ypy_before_request(elt, {ctx}) {
            let list = ctx.disabledElements ??= [];
            let hold = (found, property) => {
                for (let el of found) {
                    list.push(el);
                    holds.set(el, (holds.get(el) || 0) + 1);
                    el[property] = true;
                }
            };
            let disable = api.attributeValue(ctx.sourceElement, 'ypy-disable');
            if (disable) hold(api.findAll(ctx.sourceElement, disable, 'ypy-disable'), 'disabled');
            if (/true/.test(api.attributeValue(ctx.sourceElement, 'ypy-inert', ypy.config.inert)) && ctx.target?.nodeType) hold([ctx.target], 'inert');
        },
        ypy_finally_request(elt, {ctx}) {
            if (ctx.keepIndicators) return;
            for (let el of ctx.disabledElements ?? []) {
                let left = (holds.get(el) || 0) - 1;
                if (left > 0) holds.set(el, left);
                else {
                    holds.delete(el);
                    el.disabled = el.inert = false;
                }
            }
            ctx.disabledElements = [];
        }
    });
})();
