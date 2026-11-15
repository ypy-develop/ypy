// SPDX-License-Identifier: MIT
//==========================================================
// ypy-transitions.js
//
// View transitions for the swaps that ask for one (the `transition:true` swap modifier, or
// config.transitions). The core hands the tasks of such a swap to the extension through the
// handle_transition hook; the extension runs them inside document.startViewTransition(), one
// request after the other (a second one waits for the first to finish), and fires
// ypy:before:viewTransition (detail.task may be replaced) and ypy:after:viewTransition.
//
// Without the extension the same tasks run at once, with no animation: the same as a browser
// without view transitions, or a visitor who prefers reduced motion (those never animate, with or
// without the extension). A transition the browser skips is not an error.
//
// Usage:
//   <script src="ypy.js"></script>
//   <script src="ext/ypy-transitions.js"></script>
//   <a ypy-get="/next" ypy-swap="innerHTML transition:true">Next</a>
//==========================================================
(() => {
    let api;
    let queue = [], busy = false;

    // runs the next waiting task, once the one that runs now is done
    async function next() {
        if (busy || !queue.length) return;
        busy = true;
        let {task, resolve, ctx} = queue.shift();
        try {
            // a skipped transition (hidden tab, another one started) rejects `ready`: handled here
            if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
                let detail = {task, ctx};
                api.triggerEvent(ctx.sourceElement, 'ypy:before:viewTransition', detail);
                let transition = document.startViewTransition(detail.task);
                transition.ready.catch(() => {});
                await transition.finished;
                api.triggerEvent(ctx.sourceElement, 'ypy:after:viewTransition', detail);
            } else {
                await task();
            }
        } catch (e) {
            // transitions can be skipped or aborted: this is normal
        } finally {
            busy = false;
            resolve();
            next();
        }
    }

    ypy.registerExtension('ypy-transitions', {
        init(internalAPI) {
            api = internalAPI;
        },
        handle_transition: (task, ctx) => new Promise(resolve => {
            queue.push({task, resolve, ctx});
            next();
        })
    });
})();
