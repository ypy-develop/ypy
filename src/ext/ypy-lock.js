// SPDX-License-Identifier: MIT
//==========================================================
// ypy-lock.js
//
// Configuration lock for ypy.
//
// Freezes the security settings (mode, callbacks, extensions, nonce, inlineScriptNonce, scripts, and
// and the config object itself: a later assignment is ignored with a console warning,
// and the properties cannot be redefined or deleted. The lock cannot be undone.
//
// Two ways to turn it on:
//   - locked:true in the first ypy-config <meta> tag of <head>; the lock closes when this
//     extension starts, so load it right after the core, before any other script;
//   - ypy.config.lock(), called by the page at run time.
//
// Usage:
//   <meta name="ypy-config" content='locked:true,callbacks:"none"'>
//   <script src="ypy.min.js"></script>
//   <script src="ypy-lock.js"></script>
//
// When config.extensions is set, list this extension in it ("ypy-csp,ypy-lock"), or it is
// not registered and nothing is locked. ypy.max already includes it.
//==========================================================
(() => {

    let locked = false;

    function lock() {
        if (locked) return;
        locked = true;
        let freeze = (obj, key, value) => Object.defineProperty(obj, key, {
            enumerable: true,
            configurable: false,
            get: () => value,
            set: v => { if (v !== value) console.warn(`ypy: ${key} is locked`) }
        });
        let config = ypy.config;
        for (let key of ['mode', 'callbacks', 'extensions', 'nonce', 'inlineScriptNonce', 'scripts']) freeze(config, key, config[key]);
        freeze(config, 'locked', true);
        // the built core keeps the approved list private, out of reach; the source build exposes it
        if ('__approvedExt' in ypy) freeze(ypy, '__approvedExt', ypy.__approvedExt);
        freeze(ypy, 'config', config);
    }

    let registered = ypy.registerExtension('ypy-lock', {
        init: () => {
            Object.defineProperty(ypy.config, 'lock', {value: lock});
            if (ypy.config.locked === true) lock();
        }
    });
    // the page asked for the lock but config.extensions does not list this extension: nothing is locked, say so
    if (registered === false && ypy.config.locked === true && !locked) {
        console.error('ypy: locked:true is set, but ypy-lock is not in config.extensions: the configuration is NOT locked');
    }

})();
