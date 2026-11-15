// SPDX-License-Identifier: MIT
//==========================================================
// ypy-boot.js
//
// The start-up pieces that did not fit the 18 kB core. Load it first, before the other extensions
// (the order of the <script> tags is the order of the checks).
//
//   <script src="ypy.min.js"></script>
//   <script src="ext/ypy-boot.min.js"></script>
//   <script src="ext/ypy-signals.min.js"></script>
//
// 1. Extension dependencies. registerExtension() reads three more keys of the object it is given:
//      version   "1.2.0"; the extension is known as "name@1" (1 when it says nothing)
//      requires  ["ypy-signals@1"]; a feature that has to be registered already. When one is
//                missing the extension is refused with a console warning and registerExtension()
//                returns false
//      provides  ["expr@1"]; features the extension adds under a name of its own
//    ypy.supports("ypy-signals"), ypy.supports("ypy-signals@1") or ypy.supports("expr@1") says
//    whether a feature is there. Only the extensions registered after this one are known.
// 2. ypy:ready. Fires on document.body once, after the first process() has finished.
// 3. ypy-ignore on a live element. Setting the attribute on an element that was already
//    processed tears it and its descendants down; removing it processes the element again.
// 4. The focus of a #fragment. A request to "/page#section" scrolls to the revealed element
//    after its swap (the core does that); this also moves the focus there, unless the request has
//    an ypy-focus of its own. An element that cannot take the focus gets tabindex="-1" until it
//    loses it, and the focus never scrolls.
//==========================================================
(() => {
    let api, ready = false;
    const features = new Set();
    const register = ypy.registerExtension.bind(ypy);

    ypy.registerExtension = (name, extension) => {
        let {requires = [], provides = [], version = 1} = extension;
        let missing = requires.find(feature => !features.has(feature));
        if (missing) {
            console.warn(`ypy: ${name} needs ${missing}, which is not registered`);
            return false;
        }
        let result = register(name, extension);
        if (result !== false) for (let feature of [name, `${name}@${parseInt(version) || 1}`, ...provides]) features.add(feature);
        return result;
    };

    /**
     * Whether a feature is available: an extension by name or by name and major version
     * ("ypy-signals@1"), or something an extension provides ("expr@1").
     * @param {string} feature
     * @returns {boolean}
     */
    ypy.supports = feature => features.has(feature);

    const names = () => ['ypy-ignore', 'data-ypy-ignore', ...(ypy.config.prefix ? [ypy.config.prefix + 'ignore'] : [])];

    function watchIgnore() {
        let filter = names();
        new MutationObserver(records => {
            for (let target of new Set(records.map(r => r.target))) {
                if (!target.isConnected) continue;
                // tearing down an ignored element is process(elt, true), which stops at the ignore; without it, it starts it again
                ypy.process(target, filter.some(name => target.hasAttribute(name)));
            }
        }).observe(document, {attributes: true, subtree: true, attributeFilter: filter});
    }

    register('ypy-boot', {
        init(internalAPI) {
            api = internalAPI;
            features.add('ypy-boot').add('ypy-boot@1').add('core@1');
            watchIgnore();
        },
        ypy_after_process() {
            if (ready) return;
            ready = true;
            api.triggerEvent(document.body, 'ypy:ready');
        },
        ypy_after_swap(elt, {ctx}) {
            let id = ctx.request?.anchor;
            if (!id) return;
            // after the core scrolled and moved the focus of its own
            queueMicrotask(() => {
                let target = document.getElementById(id), source = ctx.sourceElement;
                if (!target || ctx.focus != null || (source && api.attributeValue(source, 'ypy-focus') != null)) return;
                if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
                    target.tabIndex = -1;
                    target.addEventListener('blur', () => target.removeAttribute('tabindex'), {once: true});
                }
                target.focus({preventScroll: true});
            });
        }
    });
})();
