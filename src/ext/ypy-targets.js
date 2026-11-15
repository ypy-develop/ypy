// SPDX-License-Identifier: MIT
//==========================================================
// ypy-targets.js
//
// An extension that adds an 'ypy-targets' attribute to target
// multiple elements with the same swap content.
//
// Usage:
//   <button ypy-get="/api" ypy-targets=".card">Click</button>
//
// The response will be swapped into all elements matching
// the selector. The ypy-targets attribute is inherited.
//==========================================================
(() => {
    let api;

    ypy.registerExtension('ypy-targets', {
        init: (internalAPI) => {
            api = internalAPI;
        },
        ypy_before_swap: (elt, detail) => {
            let {ctx, tasks} = detail;
            let selector = api.attributeValue(ctx.sourceElement, 'ypy-targets');
            if (!selector) return;

            let targets = ypy.findAll(ctx.sourceElement, selector);
            if (!targets.length) {
                console.warn(`ypy: '${selector}' on ypy-targets did not match any elements`, { selector });
                return;
            }

            // Replace main task with one task per target
            let mainIndex = tasks.findIndex(t => t.type === 'main');
            if (mainIndex === -1) return;

            let mainTask = tasks[mainIndex];
            let newTasks = Array.from(targets).map(target => ({
                ...mainTask,
                fragment: mainTask.fragment.cloneNode(true),
                target
            }));

            tasks.splice(mainIndex, 1, ...newTasks);
        }
    });
})();
