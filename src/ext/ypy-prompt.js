// SPDX-License-Identifier: MIT
//==========================================================
// ypy-prompt.js
//
// Restores the `ypy-prompt` attribute. Prompts the user
// before the request, sends the answer as `YPY-Prompt` header,
// aborts on cancel. Override `window.ypyPrompt` for a custom (sync) dialog.
//==========================================================
(() => {
    let api;
    ypy.registerExtension('ypy-prompt', {
        init(internalAPI) { api = internalAPI },

        ypy_config_request(elt, {ctx}) {
            let question = api.attributeValue(ctx.sourceElement, 'ypy-prompt');
            if (question == null) return;
            let answer = (window.ypyPrompt || window.prompt)(question);
            if (answer === null) return false;
            if (!api.triggerEvent(ctx.sourceElement, 'ypy:prompt', { prompt: answer, target: ctx.target })) return false;
            ctx.request.headers['YPY-Prompt'] = encodeURI(answer);
        }
    });
})();
