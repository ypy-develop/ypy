// SPDX-License-Identifier: MIT
//==========================================================
// ypy-csp.js
//
// CSP enforcement extension for ypy.
//
// Provides three layers of Content Security Policy integration:
//
// 1. Nonce gating: gates YPY attribute processing behind CSP
//    nonces to prevent HTML injection attacks. Every YPY element
//    must carry an ypy-nonce attribute matching the page nonce or
//    its YPY attributes are stripped. Fail closed if no page
//    nonce is found. Also re-checks nonce presence before internal eval
//    to also cover extension eval use like ypy-live.
//    Nonce source: script[nonce].nonce property on page load.
//    A ypy-ignore marker only counts when it carries the nonce too.
//    With nonce:true in the ypy-config meta tag the core processes
//    nothing until this extension has started (fail closed).
//
// 2. Trusted Types: uses the 'ypy' TT policy the core creates
//    (passthrough; trust established by the nonce gate). Add
//    trusted-types ypy to your CSP to enforce that only YPY touches DOM
//    sinks. Fail closed if the policy is blocked by CSP.
//
// 3. Safe eval: set config.safeEval:true to replace YPY's
//    Function/AsyncFunction with nonce-based script injection,
//    enabling ypy-on:/ypy-vals js:/ypy-confirm js: without
//    unsafe-eval in your CSP.
//
// Usage:
//   <meta name="ypy-config" content='extensions:"ypy-csp",nonce:true,callbacks:"nonce"'>
//   <meta name="ypy-config" content='extensions:"ypy-csp",nonce:true,callbacks:"nonce",safeEval:true'>
//   <script src="ypy-csp.js"></script>
//
//   Server stamps ypy-nonce (or ypy-nonce) on every YPY element:
//   <button ypy-post="/save" ypy-nonce="<csp-nonce>">Save</button>
//==========================================================
(() => {

    let pageNonce = null;
    let ttPolicy = null;
    let internalApi = null;

    // The element's own nonce attribute. Never an inherited one: a
    // nonce on a container would otherwise vouch for markup injected inside it.
    function getNonce(elt) {
        return internalApi && elt?.getAttribute ? internalApi.attr(elt, 'ypy-nonce') : undefined;
    }

    function checkNonce(elt) {
        if (!pageNonce) return false;
        let eltNonce = getNonce(elt);
        if (eltNonce !== pageNonce && stripYpyAttributes(elt, eltNonce)) return false;
    }

    // Anchors to script-src/default-src to avoid matching nonces in other CSP directives
    function extractNonceFromCSP(csp) {
        return csp?.match(/(?:script-src|default-src)[^;]*'nonce-([^']+)'/i)?.[1] ?? null;
    }

    // True when a parsed attribute that ends in "nonce" (ypy-nonce, data-ypy-nonce, a script's nonce, the
    // custom prefix) holds the page nonce, whatever way the markup spelled it: `ypy-nonce = "N"`, a
    // character reference inside the value. Looks inside <template> content too. Only the attribute NAME
    // is matched on raw text (names cannot be written with references), so a response that does not
    // contain "nonce" at all is never parsed.
    function carriesPageNonce(root) {
        return [...root.querySelectorAll('*')].some(elt =>
            (elt.content && carriesPageNonce(elt.content)) ||
            [...elt.attributes].some(attr => /nonce$/i.test(attr.name) && attr.value === pageNonce));
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Rewrites responseNonce -> replacement in raw HTML before DOM parsing,
    // covering ypy-nonce and script nonce attributes in one pass.
    // Pass replacement='' to strip nonce attributes entirely (stolen-nonce scrub).
    function rewriteNoncesInText(text, responseNonce, replacement = pageNonce) {
        let escaped = escapeRegex(responseNonce);
        return text.replace(
            new RegExp(`(nonce=)(["']?)${escaped}\\2`, 'gi'),
            (_, attr, quote) => replacement ? `${attr}${quote}${replacement}${quote}` : ''
        );
    }

    // Strips all ypy- and data-ypy- attributes (and the custom prefix), fires ypy:security:strip, returns true if anything stripped.
    function stripYpyAttributes(elt, eltNonce) {
        let stripped = [];
        for (let attr of [...elt.attributes]) {
            if (['ypy-', 'data-ypy-', ypy.config.prefix].some(p => p && attr.name.startsWith(p))) {
                stripped.push(attr.name);
                elt.removeAttribute(attr.name);
            }
        }
        if (!stripped.length) return false;
        let tag = elt.tagName?.toLowerCase();
        let id = elt.id ? `#${elt.id}` : '';
        let reason = eltNonce == null ? 'missing-nonce' : 'nonce-mismatch';
        console.error(`ypy: [ypy-csp] blocked <${tag}${id}>: ${eltNonce == null ? 'no ypy-nonce attribute' : 'nonce mismatch (possible injection)'}`, { elt, reason });
        internalApi.triggerEvent(elt, 'ypy:security:strip', { reason, stripped });
        return true;
    }

    ypy.registerExtension('ypy-csp', {

        init: (api) => {
            internalApi = api;

            // .nonce property stays readable after browsers blank the attribute
            // to prevent CSS exfiltration attacks.
            pageNonce = document.querySelector('script[nonce]')?.nonce || null;

            if (!pageNonce) {
                console.error('ypy: [ypy-csp] no page nonce found, blocking all ypy. Add a nonce to your script tags.');
                return;
            }

            // The core owns the 'ypy' Trusted Types policy (passthrough; trust established by the
            // nonce gate). It is null when the CSP forbids it: fail closed.
            ttPolicy = api.ttPolicy();
            if (!ttPolicy) {
                console.error("ypy: [ypy-csp] TrustedTypes policy 'ypy' blocked, add 'ypy' to trusted-types CSP directive. Blocking all ypy.");
                pageNonce = null;
                return;
            }

            // An ignore marker only protects when it carries a valid nonce: injected markup cannot
            // switch off the processing (or the stripping) of an element it does not own.
            let ignore = elt => {
                if (!elt.closest) return true;
                let selector = api.prefixSelector('[ypy-ignore]');
                for (let marker = elt.closest(selector); marker; marker = marker.parentElement?.closest(selector)) {
                    if (getNonce(marker) === pageNonce) return true;
                }
                return false;
            };

            let counter = 0;
            let NativeFunction = Function;
            let NativeAsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            // Cache compiled script-injected functions by "keys|body" so each unique
            // expression is only injected once (critical for ypy-live which re-evaluates
            // the same expressions on every DOM/input tick.
            let safeEvalCache = new Map();

            function makeGatedConstructor(isAsync) {
                return function(...keys) {
                    let body = keys.pop();
                    return {
                        call: (thisArg, ...values) => {
                            if (getNonce(thisArg) !== pageNonce) {
                                let tag = thisArg?.tagName?.toLowerCase();
                                let id = thisArg?.id ? `#${thisArg.id}` : '';
                                console.error(`ypy: [ypy-csp] blocked eval on <${tag}${id}>: nonce mismatch`, { elt: thisArg });
                                internalApi.triggerEvent(thisArg, 'ypy:security:violation', { reason: 'nonce-mismatch-at-eval' });
                                return;
                            }
                            if (ypy.config.safeEval) {
                                // the names become source text in a nonced script: only identifiers may
                                if (!keys.every(key => /^[a-z_$][\w$]*$/i.test(key))) throw new SyntaxError('ypy: [ypy-csp] invalid parameter name');
                                let cacheKey = keys.join(',') + '|' + body;
                                let compiled = safeEvalCache.get(cacheKey);
                                if (!compiled) {
                                    let fn = `__ypy_eval_${++counter}`;
                                    let script = document.createElement('script');
                                    script.nonce = pageNonce;
                                    script.textContent = ttPolicy.createScript(`window.${fn} = ${isAsync ? 'async ' : ''}function(${keys.join(',')}) { ${body} }`);
                                    document.head.appendChild(script);
                                    script.remove();
                                    compiled = window[fn];
                                    delete window[fn];
                                    safeEvalCache.set(cacheKey, compiled);
                                }
                                return compiled.call(thisArg, ...values);
                            }
                            let Ctor = isAsync ? NativeAsyncFunction : NativeFunction;
                            return new Ctor(...keys, body).call(thisArg, ...values);
                        }
                    };
                };
            }

            api.initSecurity(ttPolicy, makeGatedConstructor(false), makeGatedConstructor(true), ignore);
        },

        ypy_before_init: checkNonce,

        ypy_before_on_init: checkNonce,

        // Rewrites response nonces to pageNonce in raw HTML before fragment parsing.
        // Always scrubs stolen pageNonce. Only promotes response nonce for verified same-origin.
        ypy_after_request: (elt, detail) => {
            if (!pageNonce) return false;
            let ctx = detail.ctx;

            // Always scrub stolen pageNonce from any response. The server cannot know the
            // page nonce, so its presence indicates a stolen-nonce injection attempt.
            ctx.text = rewriteNoncesInText(ctx.text, pageNonce, '');

            // The scrub above reads raw text, which HTML can spell in ways it misses (whitespace around "=",
            // a character reference in the value). What is left is checked on the parsed markup, and a
            // response that still carries the page nonce is refused whole.
            if (/nonce/i.test(ctx.text) && carriesPageNonce(Document.parseHTMLUnsafe(ttPolicy.createHTML(ctx.text)))) {
                console.error('ypy: [ypy-csp] refused a response that carries the page nonce');
                internalApi.triggerEvent(elt, 'ypy:security:violation', { reason: 'page-nonce-in-response' });
                return false;
            }

            // Only promote response nonce for verified same-origin responses
            let responseURL = ctx?.response?.raw?.url;
            if (!responseURL) return;  // can't verify origin; scrub only, no promotion
            try { if (new URL(responseURL).origin !== location.origin) return; }
            catch (_) { return; }

            // The response nonce comes from the response HEADER only. A <meta http-equiv> inside the body is
            // attacker-controlled markup when the page has an injection, so it is never read: a response
            // with no nonce in its header promotes nothing.
            let responseNonce = extractNonceFromCSP(ctx?.response?.headers?.get('Content-Security-Policy'));
            if (responseNonce && responseNonce !== pageNonce) {
                ctx.text = rewriteNoncesInText(ctx.text, responseNonce);
            }
        },

        // An out-of-band element or a partial acts on the page when the response is swapped, before any
        // element is initialised, so the init gate cannot see it. Without the page nonce it is vetoed: an
        // out-of-band element keeps no ypy attribute and stays ordinary content, a partial is dropped.
        ypy_before_oob: elt => {
            let eltNonce = getNonce(elt);
            if (!pageNonce || eltNonce !== pageNonce) {
                stripYpyAttributes(elt, eltNonce);
                return false;
            }
        },

        // Blocks boosted form submissions where an unnonced submitter overrides formaction.
        // Also blocks js:/javascript: action URLs (entity encoding doesn't neutralise these
        // so they may survive template rendering and execute unexpectedly.
        ypy_config_request: (elt, detail) => {
            if (!pageNonce) return false;
            let action = detail.ctx?.request?.action;
            if (action && /^(js|javascript):/i.test(action)) {
                console.error(`ypy: [ypy-csp] blocked js:/javascript: action URL on <${elt.tagName.toLowerCase()}${elt.id ? '#'+elt.id : ''}>`, { elt });
                internalApi.triggerEvent(elt, 'ypy:security:violation', { reason: 'javascript-url', action, ctx: detail.ctx });
                detail.cancelled = true;
                return false;
            }
            let submitter = detail.ctx?.sourceEvent?.submitter;
            if (!elt._ypy?.boosted || !submitter?.getAttribute('formaction')) return;
            if (getNonce(submitter) !== pageNonce) {
                let id = submitter?.id ? `#${submitter.id}` : '';
                console.error(`ypy: [ypy-csp] blocked boosted form: unnonced submitter${id} overrode formaction`);
                internalApi.triggerEvent(elt, 'ypy:security:violation', { reason: 'unnonced-submitter', submitter, ctx: detail.ctx });
                detail.cancelled = true;
                return false;
            }
        }
    });

})();
