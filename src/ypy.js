// SPDX-License-Identifier: MIT
var ypy = (() => {

    /**
     * HCON, YPY's mini config language. Mirrors the JSON API.
     *
     * Used by ypy-trigger, ypy-swap, ypy-vals, and other YPY config attributes.
     *
     */
    const HCON = {
        /**
         * Parses an HCON string into an object.
         *
         * @example
         * HCON.parse('foo:1 bar:true');     // {foo: 1, bar: true}
         * HCON.parse('sse.mode:once');      // {sse: {mode: 'once'}}
         * HCON.parse('{"foo": 1}');         // {foo: 1}
         */
        parse(string) {
            if (!string) return {};
            if (string.startsWith('{')) return JSON.parse(string);
            let pattern = /(?:"([^"]+)"|'([^']+)'|([^\s,:]+))(?:\s*:\s*(?:"([^"]*)"|'([^']*)'|<((?:[^/]|\/(?!>))+)\/>|([^\s,]+)))?(?=\s|,|$)/g;
            let result = {};
            for (let match of string.matchAll(pattern)) {
                let [,
                    doubleQuotedKey,    // "key"
                    singleQuotedKey,    // 'key'
                    bareKey,            //  key
                    doubleQuotedValue,  // "value"
                    singleQuotedValue,  // 'value'
                    bracketedValue,     // <value/>
                    bareValue,          //  value
                ] = match;

                // pick this match's key and value forms
                let key = doubleQuotedKey ?? singleQuotedKey ?? bareKey;
                let value = (doubleQuotedValue ?? singleQuotedValue ?? bracketedValue ?? bareValue ?? 'true').trim();

                // JSON-parse if possible (e.g. "5" -> 5; "abc" stays string)
                try { value = JSON.parse(value); } catch {}

                // bare a.b -> {a:{b:...}}; quoted "a.b" -> {"a.b":...}
                let isDottedPath = bareKey?.includes('.');
                let pair = isDottedPath
                    ? key.split('.').reduceRight((acc, segment) => ({[segment]: acc}), value)
                    : {[key]: value};
                HCON.merge(pair, result);
            }
            return result;
        },

        /**
         * Splits an HCON-aware string at top-level commas.
         * Commas inside [], (), <.../>, "...", '...' are preserved.
         *
         * @example
         * HCON.split('a:1, b:2');                // ['a:1', ' b:2']
         * HCON.split('from:".a, .b", click');    // ['from:".a, .b"', ' click']
         */
        split(string) {
            // linear: the regex consumes each protected span ("...", '...', [...], (...), <.../>) whole, so only
            // a top-level comma reaches the capture group; every scan is bounded by the next bracket or quote
            let parts = [], start = 0;
            string.replace(/"[^"]*"|'[^']*'|\[[^\[\]]*\]|\([^()]*\)|<[^<]*?\/>|(,)/g, (m, comma, at) => comma && (parts.push(string.slice(start, at)), start = at + 1));
            return [...parts, string.slice(start)];
        },

        /**
         * Deep-merges a source (HCON string or object) into a target.
         *
         * @example
         * HCON.merge({a: {b: 1}}, {a: {c: 2}});   // {a: {b: 1, c: 2}}
         * HCON.merge('a.b:1', {a: {c: 2}});       // {a: {b: 1, c: 2}}
         */
        merge(source, target) {
            if (typeof source === 'string') source = HCON.parse(source);

            for (let [key, val] of Object.entries(source)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;

                let sourceIsObject = val?.constructor === Object;
                let targetIsObject = target[key]?.constructor === Object;

                if (sourceIsObject && targetIsObject) {
                    HCON.merge(val, target[key]);
                } else {
                    target[key] = val;
                }
            }
            return target;
        },
    };

    // The 'ypy' Trusted Types policy. It passes strings through: trust comes from the same-origin
    // rule and, when enabled, the nonce gate. Without Trusted Types support the plain object does
    // the same job. null means the CSP forbids the policy, and YPY fails closed.
    const TT_PASS = { createHTML: s => s, createScript: s => s };
    function makeTrustedTypesPolicy() {
        try {
            return typeof trustedTypes === 'undefined' ? TT_PASS : trustedTypes.createPolicy('ypy', TT_PASS);
        } catch {
            return null;
        }
    }

    /**
     * The concurrency policy of one sync element: one request in flight plus a waiting line.
     * It lives in Ypy.__requestQueues, never on the element. Every request it refuses, waits
     * for, replaces or aborts is reported through `emit(name, ctx, reason)` so that no
     * cancellation is silent (ypy:request:queued, ypy:request:dropped, ypy:request:aborted).
     * A request admitted without a ctx (a direct call) is not reported.
     */
    class RequestQueue {
        #current = null
        #queue = []
        #emit

        constructor(emit) {
            this.#emit = emit
        }

        /** Requests running or waiting; 0 means the queue holds nothing */
        get pending() {
            return this.#queue.length + !!this.#current
        }

        /** Returns "run", "queued", or "dropped" */
        admit(strategy, runRequest, abortRequest, ctx) {
            let current = this.#current
            if (!current) {
                this.#current = {strategy, abort: abortRequest}
                return "run"
            }
            if (strategy === "replace" || (strategy !== "abort" && current.strategy === "abort")) {
                let why = strategy === "replace" ? strategy : "abort"
                this.clear(why)
                current.abort?.(why)
                this.#current = {strategy, abort: abortRequest}
                return "run"
            }
            let result = "queued"
            if (strategy === "queue all") {
                this.#queue.push({run: runRequest, ctx})
            } else if (strategy === "queue last") {
                this.clear("queue-overflow")
                this.#queue = [{run: runRequest, ctx}]
            } else if (strategy !== "abort" && strategy !== "drop" && this.#queue.length === 0) {
                // default queue first
                this.#queue.push({run: runRequest, ctx})
            } else {
                result = "dropped"
            }
            if (ctx) this.#emit(result, ctx, result === "queued" ? "queue"
                : strategy === "abort" || strategy === "drop" ? strategy : "queue-overflow")
            return result
        }

        continue(abortRequest) {
            if (this.#current?.abort !== abortRequest) return
            this.#current = null    // free current slot
            this.#queue.shift()?.run() // run next request
        }

        abort(reason) {
            this.#current?.abort?.(reason)
        }

        /**
         * Drops every waiting request, reporting each one with `reason`. The request in flight
         * keeps its slot, except for "cleanup": the element is gone or restarted, so the slot is
         * released and the queue starts empty for whatever the node holds next.
         */
        clear(reason) {
            for (let {ctx} of this.#queue.splice(0)) if (ctx) this.#emit("dropped", ctx, reason)
            if (reason === "cleanup") this.#current = null
        }
    }

    class Ypy {

        __extMethods = new Map();
        __approvedExt = '';
        __registeredExt = new Set();
        _loc = window.location;  // mockable for testing
        #internalAPI;
        #Function = Function;
        #AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        #ttPolicy = makeTrustedTypesPolicy();
        #gated = false          // an extension enforces nonces on every code compilation
        #blockedWarned = false
        #fnCache = new Map()    // compiled author code, by call shape and source
        #actionSelector
        #boostSelector = "a,form";
        #verbs = ["get", "post", "put", "patch", "delete", "query"];
        #ypyOnQuery
        #pfxKey
        #pfxList
        #specCache = new Map()   // trigger string -> parsed specs
        #pfxNames = new Map()   // attribute name -> its spelling per prefix, cached per prefix list
        #pfxSelectors = new Map()   // selector -> the selector per prefix, cached per prefix list
        #transitionQueue
        #historyAbort
        #historyInitialized
        #historyPaths = new Set()
        #processingTransition

        //============================================================================================
        // SECTION config: construction, configuration and the extension registry
        //============================================================================================

        constructor() {
            this.__initConfig();
            this.#actionSelector = this.__prefixSelector(['action', ...this.#verbs].map(verb => `[ypy-${verb}]`).join());
            this.#ypyOnQuery = new XPathEvaluator().createExpression(`.//*[@*[${this.__prefixes("ypy-on").map(p => `starts-with(name(), "${p}")`).join(' or ')}]]`);
            this.__initRequestIndicatorCss();
            this.#internalAPI = {
                HCON,
                attributeValue: this.__attributeValue.bind(this),
                parseTriggerSpecs: this.__parseTriggerSpecs.bind(this),
                determineMethodAndAction: this.__determineMethodAndAction.bind(this),
                createRequestContext: this.__createRequestContext.bind(this),
                collectFormData: this.__collectFormData.bind(this),
                getAttributeObject: this.__getAttributeObject.bind(this),
                insertContent: this.__insertContent.bind(this),
                morph: this.__morph.bind(this),
                isSoftMatch: this.__isSoftMatch.bind(this),
                attr: this.__attr.bind(this),
                prefixSelector: this.__prefixSelector.bind(this),
                initSecurity: (ttPolicy, syncFn, asyncFn, ignoreFn) => {
                    if (ignoreFn) this.__ignore = ignoreFn;
                    if (ttPolicy) this.#ttPolicy = ttPolicy;
                    if (syncFn) this.#Function = syncFn;
                    if (asyncFn) this.#AsyncFunction = asyncFn;
                    if (syncFn || asyncFn) this.#gated = true;
                    this.#fnCache.clear();
                },
                ttPolicy: () => this.#ttPolicy,
                onTrigger: this.__onTrigger.bind(this),
                ypyProp: this.__ypyProp.bind(this),
                triggerEvent: this.__trigger.bind(this),
                executeJavaScript: this.__executeJavaScript.bind(this)
            };
            let init = () => this.initialize();
            if (document.readyState === 'loading') {
                document.addEventListener("DOMContentLoaded", init)
            } else {
                setTimeout(init)
            }
        }

        __initConfig() {
            this.version = '0.1.0-dev'
            this.config = {
                logAll: false,
                prefix: "",   // extra custom prefix; ypy- and data-ypy- always work
                transitions: false,
                history: true,
                mode: 'same-origin',
                // "default:true" marks a swap style nobody wrote, see __parseSwapSpec
                defaultSwap: 'innerMorph default:true',
                defaultFocusScroll: false,
                // State classes, space separated.
                classes: {
                    request: "ypy-request",
                    swapping: "ypy-swapping",
                    settling: "ypy-settling",
                    added: "ypy-added",
                    indicator: "ypy-indicator"
                },
                includeIndicatorCSS: true,
                defaultTimeout: 60000, /* 60 second default timeout */
                extensions: '',
                morphIgnore: ["data-ypy-powered", "data-ypy-state"],
                morphSkip: '[ypy-morph-skip],[data-ypy-morph-skip]',
                morphSkipChildren: '[ypy-morph-skip-children],[data-ypy-morph-skip-children]',
                morphThirdParty: '[data-reactroot],[data-v-app],[x-data]',
                morphScanLimit: 10,
                noSwap: [204, 304],
                defaultSettleDelay: 1,
                allowEmptySwapAfterOOB: false
            }
            // Only the first <meta> of <head> counts: one injected into the body is ignored.
            let metaConfig = document.head?.querySelector('meta[name="ypy-config"]');
            if (metaConfig) HCON.merge(metaConfig.content, this.config);
            let cfg = this.config;
            this.__approvedExt = cfg.extensions;
            // selfRequestsOnly is an alias of mode: true is same-origin, false is cors
            let sro = cfg.selfRequestsOnly;
            Object.defineProperty(cfg, 'selfRequestsOnly', {
                configurable: true,
                get: () => cfg.mode === 'same-origin',
                set: v => { cfg.mode = v ? 'same-origin' : 'cors' }
            });
            if (sro !== undefined) cfg.selfRequestsOnly = sro;
            // An element can write into the request context (ypy-boost, ypy-config, ajax options): pin
            // the fetch mode before any page listener runs, so no attribute can lift selfRequestsOnly
            this.__extMethods.set('ypy_config_request', [(elt, {ctx}) => { if (ctx?.request) ctx.request.mode = cfg.mode }]);
            // fail closed: with config.nonce set, nothing is processed until the nonce extension
            // has started (it calls initSecurity)
            if (cfg.nonce) {
                let warned;
                let gate = () => this.#gated || (warned ||= console.error('ypy: config.nonce is set but ypy-csp did not start') || 1, false);
                for (let key of ['ypy_before_init', 'ypy_before_on_init', 'ypy_config_request', 'ypy_before_oob']) {
                    this.__extMethods.set(key, [...(this.__extMethods.get(key) ?? []), gate]);
                }
            }
        }

        __initRequestIndicatorCss() {
            if (this.config.includeIndicatorCSS !== false) {
                let sel = name => ':is(' + this.__classNames(name).map(c => '.' + CSS.escape(c)).join(',') + ')';
                let indicator = sel('indicator');
                let request = sel('request');
                this.indicatorStyleSheet = this.__sheet(
                    `${indicator}{opacity:0;visibility:hidden} ` +
                    `${request} ${indicator},${request}${indicator}{opacity:1;visibility:visible;transition:opacity 200ms ease-in}`
                );
            }
        }

        /** Adopts a style sheet (no inline style, no CSP exception); undefined when the browser refuses. */
        __sheet(css) {
            try {
                let sheet = new CSSStyleSheet();
                sheet.replaceSync(css);
                document.adoptedStyleSheets.push(sheet);
                return sheet;
            } catch {}
        }

        /**
         * Registers an extension: an object whose keys are hooks (ypy_<event> for a ypy:<event>
         * event, handle_swap, init...) and whose values are
         * functions. Calls extension.init with the internal API first.
         *
         * @param {string} name the extension name; must be in config.extensions when that list is set
         * @param {object} extension
         * @returns {false | undefined} false when the name is not approved or already registered
         */
        registerExtension(name, extension) {
            if (this.__approvedExt && !this.__approvedExt.split(/,\s*/).includes(name)) return false;
            if (this.__registeredExt.has(name)) return false;
            this.__registeredExt.add(name);
            if (extension.init) extension.init(this.#internalAPI);
            Object.entries(extension).forEach(([key, value]) => {
                if(!this.__extMethods.get(key)?.push(value)) this.__extMethods.set(key, [value]);
            });
        }

        //============================================================================================
        // SECTION attributes: attribute names, prefixes, inheritance and swap-style names
        //============================================================================================

        /**
         * Attribute prefixes in precedence order. A ypy-* attribute wins over data-ypy-* when an
         * element carries both. config.prefix adds one more custom prefix at the end.
         * @returns {string[]}
         */
        __prefixList() {
            let p = this.config.prefix;
            if (this.#pfxKey !== p || !this.#pfxList) {
                this.#pfxKey = p;
                this.#pfxList = ['ypy-', 'data-ypy-', ...(p ? [p] : [])];
                this.#pfxNames.clear();
                this.#pfxSelectors.clear();
            }
            return this.#pfxList;
        }

        /** The spellings of a ypy-* attribute name, one per prefix, in precedence order. */
        __attrNames(name) {
            let list = this.__prefixList();
            let names = this.#pfxNames.get(name);
            if (!names) this.#pfxNames.set(name, names = list.map(p => name.replace('ypy-', p)));
            return names;
        }

        // an extension may replace it (see initSecurity)
        __ignore = elt => !elt.closest || elt.closest(this.__prefixSelector('[ypy-ignore]')) != null;

        __attr(elt, name) {
            if (!elt.hasAttributes?.()) return null;   // most lookups hit elements with no attribute at all
            for (let n of this.__attrNames(name)) {
                let val = elt.getAttribute(n);
                if (val != null) return val;
            }
            return null;
        }

        __attrName(elt, name) {
            if (!elt.hasAttributes?.()) return null;
            for (let n of this.__attrNames(name)) {
                if (elt.hasAttribute(n)) return n;
            }
            return null;
        }

        __prefixSelector(s) {
            this.__prefixList();
            let sel = this.#pfxSelectors.get(s);
            if (sel === undefined) this.#pfxSelectors.set(s, sel = this.__prefixes(s).join(','));
            return sel;
        }

        __prefixes(s) {
            return this.__prefixList().map(p => s.replaceAll('ypy-', p));
        }

        /**
         * The classes configured for a state (config.classes), as an array.
         * @param {"request"|"swapping"|"settling"|"added"|"indicator"} state
         * @returns {string[]}
         */
        __classNames(state) {
            return (this.config.classes?.[state] ?? '').split(/\s+/).filter(Boolean);
        }

        __queryEltAndDescendants(elt, selector) {
            let results = [...(elt.querySelectorAll?.(selector) ?? [])];
            if (elt.matches?.(selector)) {
                results.unshift(elt);
            }
            return results;
        }

        __normalizeSwapStyle(style) {
            return style === 'before' ? 'beforebegin' :
                   style === 'after' ? 'afterend' :
                   style === 'prepend' ? 'afterbegin' :
                   style === 'append' ? 'beforeend' : style;
        }

        __findThisElements(elt, attrName) {
            let result = [];
            this.__attributeValue(elt, attrName, undefined, (val, elt) => {
                if (val?.split(/\s*[,:]\s*/).includes('this')) result.push(elt);
            });
            return result;
        }

        /**
         * The value of an attribute, read from the element or inherited from an ancestor.
         *
         * Inheritance is explicit: an ancestor passes a value down only when it is written
         * `ypy-x:inherited="..."` (or `:inherited:append`); a bare `ypy-x` on an ancestor stays on
         * the ancestor. `:append` on the element adds its value after the inherited chain.
         *
         * @param {Element} elt
         * @param {string} name the attribute as ypy-<name>
         * @param {*} [defaultVal] returned when neither the element nor an ancestor has it
         * @param {function(string, Element): *} [eltCollector] called with the value found on each element
         *        of the chain instead of returning it (see __findThisElements)
         */
        __attributeValue(elt, name, defaultVal, eltCollector) {
            // the names and selectors of one attribute are cached with the prefix selectors (a key
            // starting with the name, never with "["), so they go away together when config.prefix changes
            this.__prefixList();
            let names = this.#pfxSelectors.get(name), meta = this.config.metaCharacter;
            if (!names || names[4] !== meta) {
                let a = s => this.__maybeAdjustMetaCharacter(name + s), inherited = a(":inherited"), both = a(":inherited:append");
                this.#pfxSelectors.set(name, names = [a(""), inherited, a(":append"), both, meta, this.__prefixSelector(`[${CSS.escape(inherited)}],[${CSS.escape(both)}]`)]);
            }

            let val = this.__attr(elt, names[0]) ?? this.__attr(elt, names[1]);
            if (val != null) return eltCollector ? eltCollector(val, elt) : val;

            let appendValue = this.__attr(elt, names[2]) ?? this.__attr(elt, names[3]);
            let parent = elt.parentNode?.closest?.(names[5]);
            if (appendValue != null) eltCollector?.(appendValue, elt);
            val = parent && this.__attributeValue(parent, name, undefined, eltCollector);
            if (appendValue != null) return val ? (val + "," + appendValue).replace(/[{}]/g, '') : appendValue;
            return parent ? val : defaultVal;
        }

        /** The specs of a trigger string. The same few strings are parsed again for every element, so a
         *  flat parse is kept and every caller gets its own copy (a spec is written to when it is wired). */
        __parseTriggerSpecs(spec) {
            let specs = this.#specCache.get(spec);
            if (!specs) {
                specs = HCON.split(spec).flatMap(s => {
                    // support `every 1s [cond]` by moving it next to `every`
                    s = s.replace(/^\s*every\s+(\S+?)\s*(\[[^\]]*\])/, 'every$2 $1');
                    let [,name,rest] = s.match(/^\s*(\S+\[[^\]]*\]|\S+)\s*(.*?)\s*$/) ?? [];
                    if (!name) return [];  // skip empty/whitespace-only tokens
                    if (/\[[^\]]*$/.test(name)) throw "unterminated:" + name;  // e.g. click[ctrlKey
                    return [{name, ...HCON.parse(rest)}];  // spread modifiers (delay, throttle, etc.) onto result
                });
                // nested values (a JSON modifier, a dotted path) would be shared by the copies: do not keep them
                if (specs.some(s => Object.values(s).some(v => v && typeof v == 'object'))) return specs;
                if (this.#specCache.size > 500) this.#specCache.clear();
                this.#specCache.set(spec, specs);
            }
            return specs.map(s => ({...s}));
        }

        __determineMethodAndAction(elt, evt) {
            let method = this.__attributeValue(elt, "ypy-method");
            let action = this.__attributeValue(elt, "ypy-action");
            if (!action) {
                for (let verb of this.#verbs) {
                    let verbAction = this.__attributeValue(elt, "ypy-" + verb);
                    if (verbAction != null) {
                        action = verbAction;
                        method = verb;
                        break;
                    }
                }
            }
            // the submit button of the form that sent the event decides, as it does for the browser,
            // boosted or not (a formmethod of "dialog" makes the method DIALOG: no request is made)
            method = evt.submitter?.getAttribute?.("formmethod") || method;
            action = evt.submitter?.getAttribute?.("formaction") || action;
            if (this.__isBoosted(elt)) {
                action ||= elt.getAttribute(elt.matches("a") ? "href" : "action");
            }
            method ||= elt.getAttribute("method") || "GET";
            return {action, method: method.toUpperCase()};
        }

        //============================================================================================
        // SECTION processing: element state and initialization
        //============================================================================================

        __ypyProp(elt) {
            if (!elt._ypy) {
                elt._ypy = { listeners: [], triggerSpecs: [] };
                elt.setAttribute('data-ypy-powered', 'true');
            }
            return elt._ypy;
        }

        __ypyState(elt) {
            return elt._ypy_state ||= {};
        }

        /** Request queues by sync element. Outside the element, so a node that morph reuses is
         *  cleaned from here (__cleanup) and the registry never keeps a removed element alive. */
        __requestQueues = new WeakMap()

        /** How a RequestQueue reports: ypy:request:<name> on the element the request started from */
        #queueEvent = (name, ctx, reason) =>
            this.__triggerNative(ctx.sourceElement, "ypy:request:" + name, {ctx, reason})

        __initializeElement(elt, boosted) {
            if ((boosted || this.__shouldInitialize(elt)) && this.__trigger(elt, "ypy:before:init")) {
                let ypyProp = this.__ypyProp(elt);
                ypyProp.initialized = true;
                ypyProp.eventHandler = this.__createEventHandler(elt);
                if (boosted) ypyProp.boosted = boosted;
                this.__initializeTriggers(elt);
                this.__trigger(elt, "ypy:after:init")
            }
        }

        __createEventHandler(elt) {
            return async (evt) => {
                try {
                    let ctx = this.__createRequestContext(elt, evt);
                    await this.__handleTriggerEvent(ctx);
                } catch (e) {
                    this.__trigger(elt, 'ypy:error', { error: e });
                }
            };
        }

        //============================================================================================
        // SECTION request: the request context and the request phases
        //============================================================================================

        __createRequestContext(sourceElement, sourceEvent) {
            let {action, method} = this.__determineMethodAndAction(sourceElement, sourceEvent);
            let [fullAction, anchor] = (action || '').split('#');
            let ac = new AbortController();
            let ctx = {
                sourceElement,
                sourceEvent,
                status: "created",
                select: this.__attributeValue(sourceElement, "ypy-select"),
                selectOOB: this.__attributeValue(sourceElement, "ypy-select-oob"),
                target: this.__attributeValue(sourceElement, "ypy-target"),
                swap: this.__attributeValue(sourceElement, "ypy-swap") ?? this.config.defaultSwap,
                push: this.__attributeValue(sourceElement, "ypy-push-url"),
                replace: this.__attributeValue(sourceElement, "ypy-replace-url"),
                transition: this.config.transitions,
                confirm: this.__attributeValue(sourceElement, "ypy-confirm"),
                request: {
                    validate: "true" === this.__attributeValue(sourceElement, "ypy-validate", sourceElement.matches('form') && !sourceElement.noValidate && !sourceEvent.submitter?.formNoValidate ? "true" : "false"),
                    action: fullAction,
                    anchor,
                    method,
                    headers: {
                        "YPY-Request": "true",
                        "YPY-Source": this.__buildIdentifier(sourceElement),
                        "YPY-Current-URL": location.href,
                        "Accept": "text/html",
                        ...(this.__isBoosted(sourceElement) && {"YPY-Boosted": "true"})
                    },
                    abort: ac.abort.bind(ac),
                    credentials: "same-origin",
                    signal: ac.signal,
                    mode: this.config.mode
                }
            };
            // Apply boost config overrides
            if (sourceElement._ypy?.boosted) {
                HCON.merge(sourceElement._ypy.boosted, ctx);
            }
            // a selector that matches nothing is kept for the swap, which may fall back to the main
            // target (see __fallbackMode)
            let selector = ctx.target;
            ctx.target = this.__resolveTarget(sourceElement, selector, true);
            if (!ctx.target && typeof selector === 'string') ctx.targetSelector = selector;
            if (ctx.target) {
                ctx.request.headers["YPY-Target"] = this.__buildIdentifier(ctx.target);
            }

            // Apply ypy-config overrides
            let ypyConfig = this.__attributeValue(sourceElement, "ypy-config");
            if (ypyConfig) {
                HCON.merge(ypyConfig, ctx.request);
                ctx.request.mode = this.config.mode;  // mode is security-sensitive, never allow per-element override
            }
            return ctx;
        }

        __buildIdentifier(elt) {
            return `${elt.tagName.toLowerCase()}${elt.id ? '#' + encodeURI(elt.id) : ''}`;
        }

        __handleYpyHeaders(elt, ctx) {
            return this.__getAttributeObject(elt, "ypy-headers", obj => {
                for (let key in obj) ctx.request.headers[key] = String(obj[key]);
            }, {ctx});
        }

        /**
         * The element a response is swapped into. An element is returned as it is, a selector is
         * looked up from `elt`, no selector means the source element (the body for a boosted one).
         *
         * @param {Element} elt the element the selector is relative to
         * @param {Element | string | null | undefined} selector
         * @param {boolean} [quiet] do not warn when the selector matches nothing (the caller
         *     reports it once the fallback chain ended, see __fallbackMain)
         * @returns {Element | undefined} undefined when the selector matches nothing
         */
        __resolveTarget(elt, selector, quiet) {
            if (selector instanceof Element) {
                return selector;
            } else if (selector != null) {
                return this.__findOrWarn(elt, selector, "ypy-target", quiet);
            } else if (this.__isBoosted(elt)) {
                return document.body
            } else {
                return elt;
            }
        }

        __isBoosted(elt) {
            return elt?._ypy?.boosted;
        }

        async __handleTriggerEvent(ctx) {
            let elt = ctx.sourceElement
            let evt = ctx.sourceEvent
            if (!elt.isConnected) return

            // the default action was already cancelled by the trigger's handler (__onTrigger)
            if (this.__isModifierKeyClick(evt)) return

            // determine if request uses query params
            let usesQueryParams = /GET|DELETE/.test(ctx.request.method);

            // Only include *enclosing* form info for request types that do not use
            // query parameters (can still be included explicitly with ypy-include)
            let form = usesQueryParams
                ? (elt.matches('form') ? elt : null)
                : (elt.form || elt.closest("form"))

            // Build request body
            let body = this.__collectFormData(elt, form, evt.submitter, ctx.request.validate, usesQueryParams)
            if (!body) return  // Validation failed
            let valsResult = this.__getAttributeObject(elt, "ypy-vals", obj => {
                ctx.vals = obj; // make available for json extensions
                for (let key in obj) body.set(key, obj[key]);
            }, {ctx});
            if (valsResult) await valsResult; // Only await if it returned a promise
            if (ctx.values) {
                for (let k in ctx.values) {
                    body.delete(k);
                    body.append(k, ctx.values[k]);
                }
            }

            // Handle dynamic headers
            let headersResult = this.__handleYpyHeaders(elt, ctx)
            if (headersResult) await headersResult  // Only await if it returned a promise

            // Setup event-dependent request details
            Object.assign(ctx.request, {
                form,
                submitter: evt.submitter,
                body
            })

            if (!this.__trigger(elt, "ypy:config:request", {ctx: ctx})) return
            if (ctx.request.method === 'DIALOG') return

            let javascriptContent = this.__extractJavascriptContent(ctx.request.action);
            if (javascriptContent != null) {
                await this.__executeJavaScript(ctx.sourceElement, Object.fromEntries(ctx.request.body), javascriptContent, false);
                return
            } else if (usesQueryParams) {
                let url = new URL(ctx.request.action, document.baseURI);

                for (let key of ctx.request.body.keys()) {
                    url.searchParams.delete(key);
                }
                for (let [key, value] of ctx.request.body) {
                    url.searchParams.append(key, value);
                }

                // Keep relative if same origin, otherwise use full URL
                if (url.origin === location.origin) {
                    ctx.request.action = url.pathname + url.search;
                } else {
                    ctx.request.action = url.href;
                }
                ctx.request.body = null;
            } else if ((this.__attributeValue(elt, "ypy-encoding") ?? form?.enctype) !== "multipart/form-data") {
                ctx.request.body = new URLSearchParams(ctx.request.body);
            }

            await this.__issueRequest(ctx);
        }

        /**
         * Runs one request from admission to the end of the swap. This function only orders the
         * phases below; it owns no logic of its own and its event order is fixed
         * (test/tests/unit/__phases.js records it).
         *
         *   __admitRequest    queue: run, wait or drop
         *   __confirmRequest  ypy:confirm and window.confirm (only when ctx.confirm is set)
         *   __beginRequest    timeout, indicators, disabled elements, busy marks
         *   __sendRequest     ypy:before:request, final headers, fetch
         *   __receiveResponse ypy:before:response ... status codes; says whether to swap
         *   swap              the swap phases (see swap)
         *   __failRequest     catch: status, ypy:error
         *   __endRequest      finally: ypy:finally:request, indicators, busy marks, queue slot
         *
         * A phase that wants to stop the request returns false. An exception in any phase is
         * handled by __failRequest, and __endRequest always runs once the request was admitted.
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<void>}
         */
        async __issueRequest(ctx) {
            let elt = ctx.sourceElement  // the swap may replace ctx.sourceElement; request events keep this one
            let release = this.__admitRequest(ctx);
            if (!release) return

            try {
                if (ctx.confirm && !await this.__confirmRequest(ctx)) return;
                this.__beginRequest(ctx);
                if (!await this.__sendRequest(ctx)) return;
                if (await this.__receiveResponse(ctx)) {
                    await this.swap(ctx);
                    ctx.status = "swapped";
                }
            } catch (error) {
                this.__failRequest(ctx, error, elt);
            } finally {
                await this.__endRequest(ctx, release, elt);
            }
        }

        /**
         * Phase 1 of a request: asks the request queue of the sync element (the element itself,
         * the one named by ypy-sync, or the request target with `target`) whether the request
         * runs now, waits for its turn or is dropped. A request that has to wait is issued again
         * by the queue when its turn comes. Every refusal, wait and abort fires a
         * ypy:request:queued, ypy:request:dropped or ypy:request:aborted event with a reason.
         *
         * @param {YpyRequestCtx} ctx
         * @returns {(() => void) | null} a function that gives the queue slot back, or null when the
         *     request was queued or dropped and must stop here
         */
        __admitRequest(ctx) {
            let elt = ctx.sourceElement
            let syncStrategy = this.__determineSyncStrategy(elt);
            let requestQueue = this.__getRequestQueue(elt, ctx);
            this.__initializeAbortListener(elt, requestQueue);

            let abortRequest = reason => ctx.request.abort(reason)

            if (requestQueue.admit(
                syncStrategy,
                () => this.__issueRequest(ctx), // run when ready
                abortRequest,                 // abort if replaced
                ctx
            ) !== "run") return null

            // Every abort of this request, the timeout and a direct ctx.request.abort() included,
            // is reported once. Only the timeout reaches fetch with a reason: any other reason
            // would make fetch reject without an AbortError, and an abort has to stay silent.
            let abort = ctx.request.abort
            ctx.request.abort = (reason = "user") => {
                if (ctx.status === "issuing" && !ctx.request.signal.aborted) {
                    this.__triggerNative(elt, "ypy:request:aborted", {ctx, reason})
                }
                abort(reason === "timeout" ? reason : undefined)
            }
            ctx.status = "issuing"
            ctx.indicators ??= [];
            ctx.disabledElements ??= [];
            return () => requestQueue.continue(abortRequest)
        }

        /**
         * Phase 2 (only when ctx.confirm is set): fires ypy:confirm, then asks the user, or runs
         * the js: expression, or lets a ypy:confirm listener answer through issueRequest() or
         * dropRequest().
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<boolean>} false when the request was not confirmed
         */
        __confirmRequest(ctx) {
            let elt = ctx.sourceElement
            return new Promise(resolve => {
                let detail = {ctx, issueRequest: () => resolve(true), dropRequest: () => resolve(false)};
                if (this.__trigger(elt, "ypy:confirm", detail)) {
                    let js = this.__extractJavascriptContent(ctx.confirm);
                    resolve(js ? this.__executeJavaScript(elt, {ctx}, js, true) : window.confirm(ctx.confirm));
                }
            });
        }

        /**
         * Phase 3: everything that must be undone when the request ends. Starts the timeout,
         * shows the indicators, disables the elements named by ypy-disable and marks the
         * request as busy (see __markBusy). Runs after the confirmation, so a denied request
         * leaves no trace.
         *
         * @param {YpyRequestCtx} ctx
         */
        __beginRequest(ctx) {
            this.__initTimeout(ctx);
            this.__showIndicators(ctx);
            this.__disableElements(ctx);
            this.__markBusy(ctx);
        }

        /**
         * Phase 4: sets the final headers, fires ypy:before:request (cancelable) and calls
         * ctx.fetch, which is window.fetch unless an extension or a test put its own there.
         * Sets ctx.response with the raw response, its status and headers. The body is not read
         * yet.
         *
         * A rejected fetch is a network failure: ctx.errorKind becomes "offline" when the browser
         * reports no connection (navigator.onLine is false) and "network" otherwise. The call goes
         * through ctx.fetch, so the ypy-retry extension can repeat it by wrapping that function
         * (from its ypy_before_request hook): the request then keeps its queue slot and its
         * indicators while it waits, and the events fire once.
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<boolean>} false when a ypy:before:request listener cancelled the request
         */
        async __sendRequest(ctx) {
            let elt = ctx.sourceElement
            ctx.fetch ||= window.fetch.bind(window)
            // Set YPY-Request-Type based on final target/select (after all modifications)
            ctx.request.headers["YPY-Request-Type"] = (ctx.target === document.body || ctx.select) ? "full" : "partial";
            if (!this.__trigger(elt, "ypy:before:request", {ctx})) return false;

            try {
                let response = await ctx.fetch(ctx.request.action, ctx.request);
                ctx.response = {
                    raw: response,
                    status: response.status,
                    headers: response.headers,
                }
                // a response proves the connection, whatever navigator.onLine said
                if (this.#offline) this.__setOffline(false);
                return true
            } catch (error) {
                // an abort (timeout included) is not a network failure
                if (!ctx.request.signal.aborted) ctx.errorKind = navigator.onLine ? 'network' : 'offline';
                throw error;
            }
        }

        /**
         * Phase 5: reads the body and decides what happens to the response. Extracts the YPY-*
         * headers into ctx.ypy, fires ypy:before:response, ypy:after:request and, from status 400,
         * ypy:response:error, lets a header that takes over (YPY-Refresh, YPY-Redirect,
         * YPY-Location) end the request, applies YPY-Retarget, YPY-Reswap and YPY-Reselect, and
         * resolves the status code rules (noSwap, ypy-status:*).
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<boolean>} true when the response must be swapped (ctx.status is then
         *     "response received"); false when a listener cancelled, a header took over, or the
         *     target is gone
         */
        async __receiveResponse(ctx) {
            let elt = ctx.sourceElement
            this.__extractYpyHeaders(ctx);
            if (!this.__trigger(elt, "ypy:before:response", {ctx})) return false;
            ctx.text = await ctx.response.raw.text();
            ctx.redirected = !!ctx.response.raw.redirected;
            if (!this.__trigger(elt, "ypy:after:request", {ctx})) return false;

            if (ctx.response.status >= 400) {
                this.__errorDefaults(ctx);
                this.__trigger(elt, "ypy:response:error", {ctx})
            }

            if(this.__handleHeadersAndMaybeReturnEarly(ctx)){
                ctx.keepIndicators = true;
                return false
            }

            if (ctx.status === "issuing") {
                if (ctx.ypy.retarget) ctx.target = ctx.ypy.retarget;   // YPY-Retarget
                if (ctx.ypy.reswap) ctx.swap = ctx.ypy.reswap;       // YPY-Reswap
                if (ctx.ypy.reselect) ctx.select = ctx.ypy.reselect; // YPY-Reselect
                if (ctx.target?.isConnected === false) return false; // prevent swap and side effects if target just got removed
                ctx.status = "response received";
                this.__handleStatusCodes(ctx);
                return true
            }
            return false
        }

        /**
         * Phase 6a, the catch of the request: records the error in ctx.status and fires
         * ypy:error. An abort is silent unless it came from the timeout, which also sets
         * ctx.errorKind to "timeout" (a failed fetch was classified by __sendRequest).
         *
         * @param {YpyRequestCtx} ctx
         * @param {any} error whatever a phase threw, usually an Error or an AbortError
         * @param {Element} elt the element the request started from; ctx.sourceElement may have
         *     been replaced by the swap, and request events keep firing on the original element
         */
        __failRequest(ctx, error, elt) {
            ctx.status = "error: " + error;
            let timedOut = ctx.request.signal.reason === 'timeout';
            if (timedOut) ctx.errorKind = 'timeout';
            if (error?.name !== 'AbortError' || timedOut) this.__trigger(elt, "ypy:error", {ctx, error})
        }

        /**
         * Phase 6b, the finally of the request: waits for an extension that took over the
         * response, clears the timeout, runs the YPY-Trigger header, fires ypy:finally:request,
         * hides the indicators (unless they were handed to a follow-up request, ctx.keepIndicators),
         * removes the busy marks, announces the outcome (see __announce) and gives the queue slot
         * back so the next request can run.
         *
         * @param {YpyRequestCtx} ctx
         * @param {() => void} release the function __admitRequest returned
         * @param {Element} elt the element the request started from (see __failRequest)
         * @returns {Promise<void>}
         */
        async __endRequest(ctx, release, elt) {
            // An extension that took over the response reports when it has
            // finished delivering. Undefined for a normal request.
            await ctx.extensionPromise?.catch(() => {});
            clearTimeout(ctx.requestTimeout);
            if (ctx.ypy?.trigger) { // YPY-Trigger
                this.__handleTriggerHeader(ctx.ypy.trigger, ctx.sourceElement);
            }
            this.__trigger(elt, "ypy:finally:request", {ctx})
            if (!ctx.keepIndicators) {
                this.__hideIndicators(ctx.indicators);
                this.__enableElements(ctx.disabledElements);
            }
            this.__unmarkBusy(ctx);
            this.__announce(ctx);

            release()
        }

        // Extract YPY-* response headers into ctx.ypy
        // Maps: YPY-Trigger -> ctx.ypy.trigger, YPY-Push-Url -> ctx.ypy.pushurl, etc.
        __extractYpyHeaders(ctx) {
            ctx.ypy = {}
            for (let [k, v] of ctx.response.raw.headers) {
                if (k.toLowerCase().startsWith('ypy-')) {
                    ctx.ypy[k.slice(4).toLowerCase().replace(/-/g, '')] = v
                }
            }
        }

        // Handle response headers that abort normal swap processing.
        // Returns true if the response was fully handled by a header.
        __handleHeadersAndMaybeReturnEarly(ctx) {
            if (ctx.ypy.refresh === 'true') { // YPY-Refresh
                this._loc.reload();
                return true
            }
            if (ctx.ypy.redirect) { // YPY-Redirect
                // only http(s) (an unparsable value throws: ypy:error) and the page's origin, unless mode is "cors"
                let url = new URL(ctx.ypy.redirect, document.baseURI);
                if (url.origin !== 'null' && (url.origin === location.origin || this.config.mode === 'cors')) this._loc.href = url.href;
                else this.__triggerNative(ctx.sourceElement, 'ypy:security:blocked', {reason: 'redirect'});
                return true
            }
            if (ctx.ypy.location) { // YPY-Location
                let path = ctx.ypy.location, opts = {};
                let parsed = HCON.parse(path);
                if (path[0] === '{' || parsed.path != null) {
                    opts = parsed;
                    path = opts.path;
                    delete opts.path;
                }
                if (opts.push == null && opts.replace == null) opts.push = 'true';
                opts.indicators = ctx.indicators;
                opts.disabledElements = ctx.disabledElements;
                this.ajax('GET', path, opts);
                return true
            }
        }

        __initTimeout(ctx) {
            let timeout = ctx.request.timeout != null
                ? this.parseInterval(ctx.request.timeout)
                : this.config.defaultTimeout;
            if (timeout) {
                ctx.requestTimeout = setTimeout(() => ctx.request?.abort?.('timeout'), timeout);
            }
        }

        __determineSyncStrategy(elt) {
            let ypySync = this.__attributeValue(elt, "ypy-sync");
            if (!ypySync) return "queue first";
            let strategy = ypySync.split(":").pop().trim();
            return /^(drop|abort|replace|queue)/.test(strategy) ? strategy : "queue first";
        }

        /**
         * The queue that serializes the requests of elt: the one of its ypy-sync element. With
         * `target` the key is the request target, so two buttons that
         * update the same panel wait for each other.
         *
         * @param {Element} elt
         * @param {YpyRequestCtx} [ctx] the request, needed for `target`
         * @returns {RequestQueue}
         */
        __getRequestQueue(elt, ctx) {
            let ypySync = this.__attributeValue(elt, "ypy-sync")
            let syncElt = elt
            if (ypySync) {
                let selector = ypySync.includes(":")
                    ? ypySync.slice(0, ypySync.lastIndexOf(":")).trim()
                    : (/^(drop|abort|replace|queue)/.test(ypySync) ? null : ypySync);
                if (selector === "target") {
                    syncElt = ctx?.target?.matches ? ctx.target : elt
                } else if (selector) {
                    syncElt = this.__findOrWarn(elt, selector, "ypy-sync") || elt;
                }
            }
            let queue = this.__requestQueues.get(syncElt)
            if (!queue) this.__requestQueues.set(syncElt, queue = new RequestQueue(this.#queueEvent))
            return queue
        }

        //============================================================================================
        // SECTION events: trigger specifications and event listeners
        //============================================================================================

        __isModifierKeyClick(evt) {
            return evt.type === 'click' && (evt.ctrlKey || evt.metaKey || evt.shiftKey)
                && !!evt.currentTarget?.closest?.('a[href]')
        }

        __shouldCancel(evt) {
            let elt = evt.currentTarget
            let isSubmit = evt.type === 'submit' && elt?.tagName === 'FORM'
            if (isSubmit) return true

            let isClick = evt.type === 'click' && evt.button === 0
            if (!isClick) return false

            let btn = elt?.closest?.('button, input[type="submit"], input[type="image"]')
            let form = btn?.form || btn?.closest('form')
            let isSubmitButton = btn && !btn.disabled && form &&
                (btn.type === 'submit' || btn.type === 'image' || (!btn.type && btn.tagName === 'BUTTON'))
            if (isSubmitButton) return true

            let link = elt?.closest?.('a')
            // a Ctrl/Meta/Shift-click opens the link the browser's way (new tab, window)
            if (!link || !link.href || this.__isModifierKeyClick(evt)) return false

            let href = link.getAttribute('href')
            let isFragmentOnly = href && href.startsWith('#') && href.length > 1
            return !isFragmentOnly
        }

        __initializeTriggers(elt, initialHandler = elt._ypy.eventHandler) {
            let ypyTrigger = this.__attributeValue(elt, "ypy-trigger");
            let trigger = ypyTrigger || (elt.matches("form") ? "submit" :
                elt.matches("input:not([type=button]):not([type=submit]),select,textarea") ? "change" :
                    "click");
            this.__onTrigger(elt, trigger, initialHandler)
        }

        // Wire up event listeners with full modifier support (once, prevent, stop,
        // delay, throttle, changed, capture, passive, from, filter, etc.)
        __onTrigger(elt, specString, handler) {
            let specs = this.__parseTriggerSpecs(specString)
            this.__ypyProp(elt).triggerSpecs.push(...specs)

            for (let spec of specs) {
                spec.listeners = []

                let [eventName, filter] = this.__extractFilter(spec.name);
                let filterNames = filter && this.__identifiers(filter);   // only these event properties can be read

                // Resolve from: elements (self listens on elt but filters by event.target in guard)
                let fromElts = [elt];
                if (spec.from === 'outside') fromElts = [document];
                else if (spec.from && spec.from !== 'self') fromElts = this.__findAllExt(elt, spec.from);

                // Inner: runs after delay/throttle resolves
                let inner = (evt) => {
                    if (spec.halt || spec.prevent) evt.preventDefault();
                    if (spec.halt || spec.stop || spec.consume) evt.stopPropagation();
                    if (spec.changed) {
                        let values = this.__ypyState(elt).changedValues ??= new WeakMap();
                        let target = evt.target;
                        if (!['checkbox', 'radio'].includes(target?.type)) {
                            let value = target?.value;
                            if (values.has(target) && values.get(target) === value) return;
                            values.set(target, value);
                        }
                    }
                    if (spec.once) {
                        for (let info of spec.listeners) info.fromElt.removeEventListener(info.eventName, info.handler, info);
                    }
                    handler(evt);
                };

                // Wrap inner with delay/throttle if needed
                let timed = inner;
                if (spec.delay) {
                    timed = evt => {
                        clearTimeout(spec.timeout);
                        spec.timeout = setTimeout(() => inner(evt), this.parseInterval(spec.delay));
                    };
                } else if (spec.throttle) {
                    timed = evt => {
                        if (spec.throttled) {
                            spec.throttledEvent = evt;
                        } else {
                            spec.throttled = true;
                            inner(evt);
                            spec.throttleTimeout = setTimeout(() => {
                                spec.throttled = false;
                                let e = spec.throttledEvent;
                                spec.throttledEvent = null;
                                if (e) timed(e);
                            }, this.parseInterval(spec.throttle));
                        }
                    };
                }

                // Guarded: pre-timing checks that determine if event should proceed
                spec.handler = (evt) => {
                    if (this.__shouldCancel(evt)) evt.preventDefault();
                    if (spec.from === 'self' && evt.target !== elt) return;
                    if (spec.from === 'outside' && elt.contains(evt.target)) return;
                    if (spec.target && !evt.target?.matches?.(spec.target)) return;
                    if (filter) {
                        let evtArgs = {}; for (let k in evt) if ((!filterNames || filterNames.has(k)) && /^[a-z]+$/i.test(k)) evtArgs[k] = evt[k];
                        if (!this.__executeJavaScript(elt, evtArgs, filter, true, false)) return;
                    }
                    // a new trigger replaces any pending delayed or throttled trigger on this element
                    if (eventName !== 'every') {
                        for (let other of this.__ypyProp(elt).triggerSpecs) {
                            clearTimeout(other.timeout);
                            other.throttledEvent = null;
                        }
                    }
                    timed(evt);
                };

                // Intersect/revealed: set up observer
                if (eventName === 'intersect' || eventName === 'revealed') {
                    let observerOptions = {rootMargin: spec.rootMargin};
                    if (spec.root) observerOptions.root = this.__findOrWarn(elt, spec.root);
                    if (spec.threshold) observerOptions.threshold = parseFloat(spec.threshold);
                    let isRevealed = eventName === 'revealed';
                    spec.observer = new IntersectionObserver((entries) => {
                        let hit = entries.find(entry => entry.isIntersecting);
                        if (hit) {
                            this.trigger(hit.target, 'intersect', {}, false);
                            if (isRevealed) spec.observer.disconnect();
                        }
                    }, observerOptions);
                    eventName = 'intersect';
                    for (let fromElt of fromElts) spec.observer.observe(fromElt);
                }

                // Every: set up interval
                if (eventName === "every") {
                    spec.interval = setInterval(() => elt.isConnected ? this.__trigger(elt, 'every', {}, false) : clearInterval(spec.interval),
                        this.parseInterval(Object.keys(spec).find(k => k !== 'name')));
                }

                // Load: fire immediately, no listener needed
                if (eventName === 'load') {
                    spec.handler(new CustomEvent('load'));
                    continue;
                }

                // Register listeners
                for (let fromElt of fromElts) {
                    let listenerInfo = {fromElt, eventName, handler: spec.handler,
                        capture: !!spec.capture, passive: !!spec.passive};
                    elt._ypy.listeners.push(listenerInfo);
                    spec.listeners.push(listenerInfo);
                    fromElt.addEventListener(eventName, spec.handler, listenerInfo);
                }
            }
        }

        __extractFilter(str) {
            let match = str.match(/^([^\[]*)\[([^\]]*)]/);
            if (!match) return [str, null];
            return [match[1], match[2]];
        }

        __handleTriggerHeader(value, elt) {
            if (value[0] === '{') {
                let triggers = HCON.parse(value);
                for (let name in triggers) {
                    let detail = triggers[name];
                    this.trigger(detail?.target ? this.find(detail.target) : elt, name, typeof detail === 'object' ? detail : {value: detail});
                }
            } else {
                value.split(',').forEach(name => this.trigger(elt, name.trim(), {}));
            }
        }

        //============================================================================================
        // SECTION security: running author JavaScript
        //============================================================================================

        /** The API methods named in `used` (all of them when it is null), bound for author JavaScript. */
        __apiMethods(thisArg, used) {
            let proto = Object.getPrototypeOf(this), api = {};
            for (let name of used ?? Object.getOwnPropertyNames(proto)) {
                if (name !== 'constructor' && Object.hasOwn(proto, name) && typeof this[name] === 'function') api[name] = this[name].bind(this);
            }
            // find and findAll default their first argument to the element the code runs on
            for (let name of ['find', 'findAll']) {
                if (api[name]) api[name] = (arg1, arg2) => arg2 === undefined ? this[name](thisArg, arg1) : this[name](arg1, arg2);
            }
            return api;
        }

        /** The identifiers a piece of author JavaScript names, or null when it could reach a name some other
         *  way (a direct eval, an escape inside an identifier): then every name has to stay in scope. */
        __identifiers(code) {
            return /\beval\b|\\/.test(code) ? null : new Set(code.match(/[\p{ID_Continue}$]+/gu));
        }

        /**
         * What config.callbacks means now: "none" (author code never compiles), "nonce" (it runs
         * only through the nonce extension, which checks the element) or "all". Unset, it is
         * "none". Any other value counts as "none".
         *
         * @returns {"none" | "nonce" | "all"}
         */
        __callbacksPolicy() {
            let policy = this.config.callbacks ?? 'none';
            return policy === 'all' || policy === 'nonce' ? policy : 'none';
        }

        /**
         * Runs author code: ypy-on, `js:` values, `[filter]` triggers. The one place that compiles
         * code, so config.callbacks is decided here. When the policy blocks it, nothing compiles,
         * a warning is logged once and `ypy:security:blocked` fires; the result is as empty as a
         * promise (async), a function (compile) or undefined (a filter is false, a confirm is denied).
         *
         * @param {Element} thisArg the element, `this` for the code
         * @param {object} obj extra variables for the code
         * @param {string} code
         * @param {boolean} expression wrap the code in `return (...)`
         * @param {boolean} isAsync compile as an async function
         * @param {boolean} compile return a function that runs the code instead of running it
         */
        __executeJavaScript(thisArg, obj, code, expression = true, isAsync = true, compile = false) {
            let policy = this.__callbacksPolicy();
            if (policy === 'none' || (policy === 'nonce' && !this.#gated)) {
                if (!this.#blockedWarned) {
                    this.#blockedWarned = true;
                    console.warn(`ypy: author code is off (config.callbacks is "${policy}")`);
                }
                this.__triggerNative(thisArg, 'ypy:security:blocked', {reason: 'callbacks-' + policy, code});
                return compile ? () => {} : isAsync ? Promise.resolve() : undefined;
            }
            let scope = {};
            let detail = { scope, code };
            this.__triggerExtensions(thisArg, "ypy:scope", detail);
            code = detail.code;
            // only the API methods the code mentions become parameters, so the function is not built over
            // the whole API for every call; the key holds the parameters and the source, so equal keys compile equally
            let args = Object.assign(this.__apiMethods(thisArg, this.__identifiers(code)), scope, obj);
            let keys = Object.keys(args);
            let values = Object.values(args);
            // Compiling is the expensive part: keep the function per parameter list and source.
            let key = `${+isAsync}${+expression}${keys}|${code}`;
            let func = this.#fnCache.get(key);
            if (!func) {
                func = new (isAsync ? this.#AsyncFunction : this.#Function)(...keys, expression ? `return (${code})` : code);
                if (this.#fnCache.size > 255) this.#fnCache.clear();
                this.#fnCache.set(key, func);
            }
            return compile ? () => func.call(thisArg, ...values) : func.call(thisArg, ...values);
        }

        //============================================================================================
        // SECTION processing (cont.): processing and cleaning up elements, boosting, preserved elements
        //============================================================================================

        /**
         * Initialize YPY attributes on root and all its descendants. When force is true, root
         * and every powered descendant are first torn down and re-wired from their current
         * attributes - use this after mutating ypy-* attributes on an already-processed element.
         * @param {Element | ShadowRoot} root
         * @param {boolean} [force]
         */
        process(root, force) {
            if (!root?.isConnected) return;
            if (!(root instanceof Element)) { // ShadowRoot
                for (let elt of root.children || []) this.process(elt, force);
                return;
            }
            if (force) this.__cleanup(root, true);
            if (this.__ignore(root)) return;
            if (!this.__trigger(root, "ypy:before:process")) return
            let ypyOnNodes = [root];
            let iter = this.#ypyOnQuery.evaluate(root)
            let node = null
            while (node = iter.iterateNext()) ypyOnNodes.push(node)
            for (let ypyOnNode of ypyOnNodes) {
                if (!this.__ignore(ypyOnNode) && this.__trigger(ypyOnNode, "ypy:before:on:init", {}, true)) {
                    this.__handleYpyOnAttributes(ypyOnNode);
                }
            }
            for (let elt of this.__queryEltAndDescendants(root, this.#actionSelector)) {
                this.__initializeElement(elt);
            }
            for (let elt of this.__queryEltAndDescendants(root, this.#boostSelector)) {
                this.__maybeBoost(elt);
            }
            this.__trigger(root, "ypy:after:process");
        }

        __maybeBoost(elt) {
            let ypyBoost = this.__attributeValue(elt, "ypy-boost");
            if (ypyBoost && ypyBoost !== "false" && this.__shouldBoost(elt)) this.__initializeElement(elt, ypyBoost);
        }

        __shouldBoost(elt) {
            if (this.__shouldInitialize(elt)) {
                if (elt.tagName === "A") {
                    if (elt.target === '' || elt.target === '_self') {
                        return !elt.hasAttribute('download') && !elt.getAttribute('href')?.startsWith?.("#") && this.__isSameOrigin(elt.href)
                    }
                } else if (elt.tagName === "FORM") {
                    return elt.method !== 'dialog' &&  this.__isSameOrigin(elt.action);
                }
            }
        }

        __isSameOrigin(url) {
            try {
                // URL constructor handles both relative and absolute URLs; a failure is "not same-origin"
                return new URL(url, location.href).origin === location.origin;
            } catch {
                return false;
            }
        }

        __shouldInitialize(elt) {
            return !elt._ypy?.initialized && !this.__ignore(elt);
        }

        /**
         * Remove listeners, timers, and observers from elt and all its powered descendants.
         * When force is true, also delete their YPY state so a re-process fully re-initializes them.
         * @param {Element} elt
         * @param {boolean} [force]
         */
        __cleanup(elt, force) {
            let elts = [elt, ...elt.querySelectorAll?.('[data-ypy-powered]') ?? []];
            for (let e of elts) {
                // a restarted or removed node does not hand its queue to what it holds next
                let queue = this.__requestQueues.get(e)
                if (queue) {
                    queue.clear("cleanup")
                    this.__requestQueues.delete(e)
                }
                if (!e._ypy) continue;
                this.__trigger(e, "ypy:before:cleanup")
                for (let spec of e._ypy.triggerSpecs || []) {
                    clearInterval(spec.interval);
                    clearTimeout(spec.timeout);
                    clearTimeout(spec.throttleTimeout);
                    spec.observer?.disconnect()
                }
                for (let info of e._ypy.listeners || []) {
                    info.fromElt.removeEventListener(info.eventName, info.handler, info);
                }
                e.removeAttribute('data-ypy-powered');
                this.__trigger(e, "ypy:after:cleanup")
                if (force) delete e._ypy;
            }
        }

        __handlePreservedElements(fragment) {
            let pantry = document.createElement('div');
            pantry.hidden = true;
            document.body.insertAdjacentElement('afterend', pantry);
            let newPreservedElts = fragment.querySelectorAll?.(this.__prefixSelector('[ypy-preserve]')) || [];
            for (let preservedElt of newPreservedElts) {
                let currentElt = document.getElementById(preservedElt.id);
                // attrs, children and false act in a morph (__morphNode), not on the identity of the node
                if (currentElt && !/^(attrs|children|false)$/.test(this.__attr(preservedElt, 'ypy-preserve'))) {
                    this.__moveBefore(pantry, currentElt, null);
                }
            }
            return pantry
        }

        __restorePreservedElements(pantry) {
            for (let preservedElt of [...pantry.children]) {
                let newElt = document.getElementById(preservedElt.id);
                if (newElt) {
                    this.__moveBefore(newElt.parentNode, preservedElt, newElt);
                    this.__cleanup(newElt)
                    newElt.remove()
                }
            }
            pantry.remove();
        }

        //============================================================================================
        // SECTION swap: parsing a response and building swap tasks (parsing is owned by security)
        //============================================================================================

        __parseHTML(resp) {
            // fail closed: a CSP that forbids the 'ypy' policy means no response is parsed
            if (!this.#ttPolicy) throw new Error("ypy: Trusted Types policy 'ypy' is blocked by the CSP");
            let trusted = this.#ttPolicy.createHTML(resp);
            // {} works around Chrome 150-156 dropping comments :/
            return Document.parseHTMLUnsafe?.(trusted, {}) || new DOMParser().parseFromString(trusted, 'text/html');
        }

        __makeFragment(text) {
            // Convert <ypy-*> tags (e.g. <ypy-partial>) to <template ypy type="*">,
            // opening and closing tags in one pass; a name with a second hyphen is left alone
            let response = text.replace(/<(\/?)ypy-([a-z]+)(?=[\s>])/gi, (_, close, type) => close ? '</template' : `<template ypy type="${type.toLowerCase()}"`);
            let title = '';
            // the first <head>...</head>, found with two linear searches (a lazy regex restarts at every opener)
            let at = response.search(/<head[\s>]/i), len = response.slice(at).search(/<\/head>/i) + 7;
            if (at >= 0 && len > 6) {
                title = this.__parseHTML(response.slice(at, at + len)).title;
                response = response.slice(0, at) + response.slice(at + len);
            }
            let startTag = response.match(/<([a-z][^\/>\x20\t\r\n\f]*)/i)?.[1]?.toLowerCase();

            let doc, fragment;
            if (startTag === 'html' || startTag === 'body') {
                doc = this.__parseHTML(response);
                fragment = document.createDocumentFragment();
                fragment.append(doc.body);
            } else {
                doc = this.__parseHTML(`<template>${response}</template>`);
                fragment = doc.querySelector('template').content;
            }

            if (!title) {
                let titleElt = fragment.querySelector('title:not(svg title)');
                if (titleElt) {
                    title = titleElt.textContent;
                    titleElt.remove();
                }
            }

            this.__processScripts(fragment);

            return {
                fragment,
                title
            };
        }

        /**
         * Builds the swap tasks of one out-of-band element: one task per element the target
         * selector finds, each with its own copy of the content, and takes the element out of
         * the response. A missing target fires ypy:target:missing and the element is dropped;
         * the other tasks go on.
         *
         * @param {YpySwapTask[]} tasks receives the new tasks
         * @param {Element} elt the out-of-band element
         * @param {string} oobValue its ypy-swap-oob (or ypy-select-oob) value: `true`, a swap
         *     style, or `style:selector`
         * @param {Element} [sourceElement] element the request started from
         * @param {YpyRequestCtx} [ctx]
         */
        __createOOBTask(tasks, elt, oobValue, sourceElement, ctx) {
            let targetSelector = elt.id ? '#' + CSS.escape(elt.id) : null;
            // if oobValue is in "swapStyle:selector" form (no space before colon), split it; otherwise treat as HCON
            let [, style, sel] = oobValue.match(/^(\S+):(.+)/) ?? [];
            if (style) [oobValue, targetSelector] = [style, sel || targetSelector];
            if (oobValue === 'true' || !oobValue) oobValue = this.__defaultOOBSwap();

            let swapSpec = this.__parseSwapSpec(oobValue);
            targetSelector = swapSpec.target || targetSelector;
            swapSpec.strip ??= !swapSpec.style.startsWith('outer');
            if (!targetSelector) return this.__reportMissingTarget(ctx, '', 'oob');
            let targets = this.__findAllExt(sourceElement, targetSelector);
            if (!targets.length) this.__reportMissingTarget(ctx, targetSelector, 'oob');
            for (let target of targets) {
                let fragment = document.createDocumentFragment();
                fragment.append(elt.cloneNode(true));
                tasks.push({type: 'oob', fragment, target, swapSpec, sourceElement});
            }
            elt.remove();
        }

        /**
         * Collects the out-of-band tasks of a response: first the elements ypy-select-oob picks, then
         * the elements with ypy-swap-oob, each group in document order. The elements leave the
         * fragment, so what is left is the main content.
         *
         * @param {DocumentFragment} fragment the response
         * @param {Element} [sourceElement] element the request started from
         * @param {string} [selectOOB] the ypy-select-oob value
         * @param {YpyRequestCtx} [ctx] only given to the missing-target event
         * @returns {YpySwapTask[]} tasks of type `oob`
         */
        __processOOB(fragment, sourceElement, selectOOB, ctx) {
            let tasks = [];

            // Process ypy-select-oob first (select elements from response)
            if (selectOOB) {
                for (let spec of selectOOB.split(',')) {
                    let [selector, oobValue = 'true'] = spec.split(/:(.*)/);
                    for (let elt of fragment.querySelectorAll(selector)) {
                        this.__createOOBTask(tasks, elt, oobValue, sourceElement, ctx);
                    }
                }
            }

            // Process elements with ypy-swap-oob attribute
            for (let oobElt of fragment.querySelectorAll(this.__prefixSelector('[ypy-swap-oob]'))) {
                if (!this.__triggerExtensions(oobElt, 'ypy:before:oob')) continue;   // an extension vetoes: it stays ordinary content
                let oobAttr = this.__attrName(oobElt, 'ypy-swap-oob');
                let oobValue = oobElt.getAttribute(oobAttr);
                oobElt.removeAttribute(oobAttr);
                this.__createOOBTask(tasks, oobElt, oobValue, sourceElement, ctx);
            }
            return tasks;
        }

        // moves the whole fragment in one DOM call: no spread of childNodes, so no argument limit
        __insertNodes(parent, before, fragment) {
            parent.insertBefore(fragment, before || null);
        }

        /**
         * Parses a swap specification: a style, then modifiers. Without a style the default one
         * is used, with its modifiers; that is innerMorph marked
         * `default: true`, which tells a style nobody wrote from one somebody did (an explicit
         * `innerHTML` is never turned into a morph).
         *
         * @param {string} swapStr for example `innerHTML swap:100ms`, `swap:100ms` or ``
         * @returns {YpySwapSpec}
         */
        __parseSwapSpec(swapStr) {
            swapStr = swapStr.trim();
            if (!swapStr || /^\S*:/.test(swapStr)) swapStr = this.config.defaultSwap + ' ' + swapStr;
            let m = swapStr.match(/^(\S+)\s*(.*)$/);
            let style = m[1];
            swapStr = m[2];
            let spec = {style: this.__normalizeSwapStyle(style), ...HCON.parse(swapStr)};
            // "morph" reads as innerMorph
            if (spec.style === 'morph') spec.style = 'innerMorph';
            return spec;
        }

        /**
         * The swap style of an out-of-band element that gives none (`ypy-swap-oob="true"`): the
         * element replaces its twin, by morphing it.
         *
         * @returns {"outerMorph default:true"}
         */
        __defaultOOBSwap() {
            return 'outerMorph default:true';
        }

        /**
         * Collects the tasks of the partials of a response: `<ypy-partial>`
         * (it reaches this method as `<template ypy type="partial">`, see __makeFragment), in
         * document order. The target is the ypy-target attribute, or the id of the
         * partial; the swap style is ypy-swap, then config.defaultSwap. A selector that
         * matches several elements gives one task each. A target that matches
         * nothing, or a partial with no target, fires ypy:target:missing and gives no task.
         * Other types are handed to the extensions (ypy:process:<type>). Every partial leaves
         * the fragment.
         *
         * @param {DocumentFragment} fragment the response, after the out-of-band elements left it
         * @param {YpyRequestCtx} ctx ctx.title is cleared by the ignoreTitle modifier
         * @returns {YpySwapTask[]} tasks of type `partial`
         */
        __processPartials(fragment, ctx) {
            let tasks = [];

            for (let templateElt of fragment.querySelectorAll('template[ypy]')) {
                let type = templateElt.getAttribute('type');
                if (!this.__triggerExtensions(templateElt, 'ypy:before:oob')) {
                    // vetoed (see ypy-csp): dropped with the removal below
                } else if (type === 'partial') {
                    let targetSelector = this.__attr(templateElt, 'ypy-target') || (templateElt.id ? '#' + CSS.escape(templateElt.id) : null);
                    if (targetSelector) {
                        this.__processScripts(templateElt.content);
                        let swapSpec = this.__parseSwapSpec(this.__attr(templateElt, 'ypy-swap') || this.config.defaultSwap);
                        if (swapSpec.ignoreTitle) ctx.title = null;
                        let targets = this.__findAllExt(ctx.sourceElement, targetSelector);
                        let silent = !targets.length && !this.__reportMissingTarget(ctx, targetSelector, 'partial');
                        for (let target of silent ? [null] : targets) {
                            tasks.push({
                                type: 'partial',
                                fragment: templateElt.content.cloneNode(true),
                                target,
                                swapSpec,
                                sourceElement: ctx.sourceElement
                            });
                        }
                    } else {
                        this.__reportMissingTarget(ctx, '', 'partial');
                    }
                } else {
                    this.__triggerExtensions(templateElt, 'ypy:process:' + type, { ctx, tasks });
                }
                templateElt.remove();
            }

            return tasks;
        }

        /**
         * Reports an out-of-band element or partial that has no element to swap into. It
         * also lists the miss in ctx.missingTargets, so __buildSwapTasks knows the response did have
         * partials or out-of-band content and does not swap an empty main content over the target.
         *
         * @param {YpyRequestCtx | undefined} ctx the request; nothing is reported without one. The
         *     event fires on ctx.sourceElement
         * @param {string} selector what was looked up; empty when the element names no target at all
         * @param {'oob' | 'partial'} type
         * @returns {boolean} true when the event fired
         */
        __reportMissingTarget(ctx, selector, type) {
            if (!ctx) return false;
            (ctx.missingTargets ??= []).push({type, selector});
            this.__triggerNative(ctx.sourceElement, 'ypy:target:missing', {ctx, selector, type});
            return true;
        }

        //============================================================================================
        // SECTION a11y: focus and scroll helpers
        //============================================================================================

        __setFocus(elt, options, start, end) {
            try {
                if (start != null && elt.setSelectionRange) {
                    elt.setSelectionRange(start, end);
                }
                elt.focus(options);
            } catch (e) {
                // setSelectionRange or Web component focus may fail so ignore
            }
        }

        __handleAutoFocus(elt) {
            let autofocus = this.__queryEltAndDescendants(elt, '[autofocus]')[0];
            if (autofocus) {
                this.__setFocus(autofocus);
            }
        }

        // window and document have no scrollTop or scrollIntoView, so use the document's scrolling element
        __normalizeScrollTarget(target) {
            return target === window || target === document ? document.scrollingElement : target;
        }

        __handleScroll(swapSpec, target) {
            if (swapSpec.scroll) {
                let scrollTarget = swapSpec.scrollTarget ? this.__normalizeScrollTarget(this.find(target, swapSpec.scrollTarget)) : target;
                if (scrollTarget) {
                    if (swapSpec.scroll === 'top') {
                        scrollTarget.scrollTop = 0;
                    } else if (swapSpec.scroll === 'bottom'){
                        scrollTarget.scrollTop = scrollTarget.scrollHeight;
                    }
                }
            }
            if (swapSpec.show === 'top' || swapSpec.show === 'bottom') {
                let showTarget = swapSpec.showTarget ? this.__normalizeScrollTarget(this.find(target, swapSpec.showTarget)) : target;
                showTarget?.scrollIntoView?.(swapSpec.show === 'top')
            }
        }

        /**
         * Applies a scroll policy. Called by __finishSwap with ctx.scroll (the swap is done and
         * the title and anchor are handled, so the policy wins over the `scroll` and `show`
         * swap modifiers), and by TASK-016 with "restore" once a history entry came back.
         *
         * The policy comes from ctx.scroll, else from `ypy-scroll` on the source element
         * (inheritable with `:inherited`); the ypy:before:swap listener resolves it:
         *  - "keep": the window and the target scroll back to where they were before the swap
         *    (ctx.scrollKept, taken by the listener);
         *  - "top": the window and the target scroll to the top;
         *  - "restore": the window goes to ctx.scrollPosition, `[x, y]`; nothing when it is unset;
         *  - a number, "120" or "120px": the window scrolls to that vertical offset.
         * Anything else does nothing. Keep and restore move at once. The others move at once
         * too when the visitor prefers reduced motion, else as the CSS `scroll-behavior` says.
         *
         * @param {YpyRequestCtx} ctx
         * @param {string | number | boolean | null | undefined} policy what the author asked for
         * @param {Element | string} [box] the swap target after the swap (an outerHTML swap made
         *     a new element): the element that scrolls besides the window
         */
        __applyScrollPolicy(ctx, policy, box) {
            let p = policy + '', n = p === 'top' ? 0 : parseFloat(p), pos = ctx.scrollPosition,
                // "k"eep and "r"estore never animate
                go = (elt, to) => to && elt?.scrollTo?.({...to, behavior: /^[kr]/.test(p) || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'auto'}),
                [win, sub] = p === 'keep' ? ctx.scrollKept || [] : p === 'restore' ? [pos && {left: pos[0], top: pos[1]}] : [n >= 0 && {top: n}, p === 'top' && {top: 0}];
            go(window, win);
            go(box, sub);
        }

        /**
         * Moves the focus to the new content, once per swap, after the focus of the swap itself was
         * given back (__restoreFocus) and before the scroll policy. Called by __finishSwap, which
         * is also the place for an error target to ask for it: set ctx.focus (a selector, or false)
         * before the swap ends. The place comes from ctx.focus, else from `ypy-focus` on the source
         * element (inheritable with `:inherited`), else "auto":
         *  - "auto": after a boosted request, the first `h1` of `[ypy-main]` (else of `<main>`), or
         *    that main itself; nothing for any other request, nothing without a main, and nothing
         *    when an `[autofocus]` element has the focus;
         *  - "none" (or false): leaves the focus alone;
         *  - "first-heading": the first heading of the swap target;
         *  - "first-invalid": the first `[aria-invalid="true"]` or invalid field of the swap target
         *    (what a 422 asks for, see __errorDefaults);
         *  - anything else is a selector (extended syntax, relative to the source element).
         * An element that cannot take the focus gets `tabindex="-1"`, removed again when it loses it.
         * The focus never scrolls the page: scrolling is the job of the scroll policy.
         *
         * @param {YpyRequestCtx} ctx
         * @param {Element | string | undefined} [box] the swap target, after the swap
         */
        __applyFocus(ctx, box) {
            let src = ctx.sourceElement, elt,
                s = ctx.focus ?? (src && this.__attributeValue(src, 'ypy-focus')) ?? 'auto';
            if (s === 'auto') {
                let main = this.__isBoosted(src) && !document.activeElement.autofocus &&
                    (document.querySelector(this.__prefixSelector('[ypy-main]')) || document.querySelector('main'));
                if (main) elt = main.querySelector('h1') || main;
            } else if (s === 'first-heading' || s === 'first-invalid') {
                elt = box?.querySelector?.(s[6] === 'h' ? 'h1,h2,h3,h4,h5,h6' : '[aria-invalid="true"],:is(input,select,textarea):invalid');
            } else if (s && s !== 'none') {
                elt = this.find(src, s);
            }
            if (elt) {
                if (elt.tabIndex < 0 && !elt.hasAttribute('tabindex')) {
                    elt.tabIndex = -1;
                    elt.addEventListener('blur', () => elt.removeAttribute('tabindex'), {once: true});
                }
                this.__setFocus(elt, {preventScroll: true});
            }
        }

        //============================================================================================
        // SECTION security (cont.): re-creating script elements so they run
        //============================================================================================

        __processScripts(container) {
            // without the 'ypy' policy the scripts stay as parsed, which never run
            if (!this.#ttPolicy) return;
            let scripts = this.__queryEltAndDescendants(container, 'script');
            for (let oldScript of scripts) {
                let newScript = document.createElement('script');
                for (let attr of oldScript.attributes) {
                    newScript.setAttribute(attr.name, attr.value);
                }
                if (this.config.inlineScriptNonce) {
                    newScript.nonce = this.config.inlineScriptNonce;
                }
                newScript.textContent = this.#ttPolicy.createScript(oldScript.textContent);
                oldScript.replaceWith(newScript);
            }
        }

        //============================================================================================
        // Public JS API
        //============================================================================================

        /**
         * Sets up history handling and processes document.body. Runs by itself on
         * DOMContentLoaded (or on the next tick when the document is already loaded); safe to call
         * again, the document-level listeners are only registered once. Call it by hand when YPY
         * is loaded late or a streamed response delivered the whole page.
         *
         * Start-up work lives in the __init* methods, so it has one owner each: __initHistory,
         * __initOffline and __initA11y.
         */
        initialize() {
            this.__initHistory();
            this.__initOffline();
            this.__initA11y();
            this.process(document.body);
        }

        //============================================================================================
        // SECTION swap (cont.): the swap phases
        //============================================================================================

        /**
         * Swaps the response of a request (ctx.text) into the page. Only orders the phases:
         *
         *   __buildSwapTasks  parses ctx.text into tasks: out-of-band, partials, main
         *   ypy:before:swap   cancelable
         *   __runSwapTasks    inserts every task, in a view transition when asked
         *   __handleHistoryUpdate  URL, history entry (not when a task failed)
         *   __finishSwap      ypy:after:swap, document title, anchor, focus and scroll policy
         *
         * ypy:finally:swap always fires, also when a phase throws. Used by ypy.ajax() and by
         * extensions that deliver their own response; most code should call ypy.ajax().
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<void>}
         */
        async swap(ctx) {
            try {
                let [tasks, mainSwap] = this.__buildSwapTasks(ctx);

                if(!this.__trigger(ctx.sourceElement, "ypy:before:swap", {ctx, tasks})){
                    return
                }

                ctx.scrollFrom = [scrollX, scrollY];   // the page being left, before the swap moves it

                let errors = await this.__runSwapTasks(ctx, tasks, mainSwap);
                if (!errors[0]) this.__handleHistoryUpdate(ctx);   // the URL changes only once the page did
                this.__finishSwap(ctx, mainSwap);
            } finally {
                this.__trigger(ctx.sourceElement, "ypy:finally:swap", {ctx});
            }
        }

        /**
         * Swap phase 1: parses ctx.text and builds the list of tasks to run. Sets ctx.title.
         *
         * Order of the list, which is also the order the tasks start (a task that does not
         * wait finishes its DOM work before the next one starts):
         *   1. the main swap, when there is one (skipped when the response had nothing left for it,
         *      see __processMainSwap); it is also the second value returned
         *   2. out-of-band elements picked by ypy-select-oob, in the order of the spec
         *   3. out-of-band elements with ypy-swap-oob, in document order
         *   4. partials, in document order
         * A task has `type` ("main", "oob", "partial" or an extension type), `fragment`, `target`,
         * `swapSpec` and `sourceElement`; see YpySwapTask. That shape is the internal contract
         * that extensions (ypy:before:swap lists the tasks, ypy:process:<type> adds some) and
         * the streaming patches of a later phase build on.
         *
         * @param {YpyRequestCtx} ctx
         * @returns {[tasks: YpySwapTask[], mainSwap: YpySwapTask | undefined]} mainSwap is also tasks[0]
         */
        __buildSwapTasks(ctx) {
            let {fragment, title} = this.__makeFragment(ctx.text);
            ctx.title = title;
            delete ctx.missingTargets;

            // Process OOB and partials
            let oobTasks = this.__processOOB(fragment, ctx.sourceElement, ctx.selectOOB, ctx);
            let partialTasks = this.__processPartials(fragment, ctx);
            let tasks = [...oobTasks, ...partialTasks];

            // Determine if empty swap should be prevented
            // partials always prevent; oob prevents by default unless config.allowEmptySwapAfterOOB is true;
            // so does a partial or oob element whose target was missing
            let hasPartials = partialTasks.length || ctx.missingTargets || (oobTasks.length && !this.config.allowEmptySwapAfterOOB);

            // Process main swap
            let mainSwap = this.__processMainSwap(ctx, fragment, hasPartials);
            if (mainSwap) {
                tasks.unshift(mainSwap);
            }
            return [tasks, mainSwap];
        }

        /**
         * Swap phase 2: runs every task through __insertContent. Tasks that ask for a view
         * transition (swap modifier, main swap, or ctx.transition) run one after the other
         * inside the transition queue; the others run at once. Resolves when all of them finished.
         *
         * One failing task does not stop the others: every task runs to the end, each failure
         * fires ypy:swap:error ({ctx, task, error}) on the element the request started from, then
         * ypy:error fires once with the first error. The swap goes on, so ypy:after:swap and
         * ypy:finally:swap still fire.
         *
         * @param {YpyRequestCtx} ctx
         * @param {YpySwapTask[]} tasks
         * @param {YpySwapTask} [mainSwap] the main task, when there is one
         * @returns {Promise<Array<[YpySwapTask, any]>>} the failures, [task, error] each; empty when all went well
         */
        async __runSwapTasks(ctx, tasks, mainSwap) {
            let errors = [];
            let insert = async (task, cssTransition) => {
                try { await this.__insertContent(task, cssTransition) } catch (error) { errors.push([task, error]) }
            };
            let swapPromises = [];
            let transitionTasks = [];
            for (let task of tasks) {
                if (ctx.busy) this.__markBusy(ctx, task.target);   // only inside a request that marked its target: __endRequest clears them
                if (task.swapSpec?.transition ?? mainSwap?.transition ?? ctx.transition) {
                    transitionTasks.push(task);
                } else {
                    swapPromises.push(insert(task));
                }
            }

            // submit all transition tasks in the transition queue w/no CSS transitions
            if (transitionTasks.length > 0) {
                let tasksWrapper = async ()=> {
                    for (let task of transitionTasks) {
                        await insert(task, false)
                    }
                }
                swapPromises.push(this.__submitTransitionTask(tasksWrapper, ctx));
            }

            await Promise.all(swapPromises);

            for (let [task, error] of errors) this.__triggerNative(ctx.sourceElement, 'ypy:swap:error', {ctx, task, error});
            if (errors[0]) this.__trigger(ctx.sourceElement, 'ypy:error', {ctx, error: errors[0][1]});
            return errors;
        }

        /**
         * Swap phase 3: after every task ran. Moves ctx.sourceElement to the main target when the
         * swap replaced the source element, fires ypy:after:swap, sets the document title
         * (unless the swap is "none"), scrolls to the URL anchor, moves the focus (__applyFocus) and
         * applies the scroll policy (__applyScrollPolicy).
         *
         * @param {YpyRequestCtx} ctx
         * @param {YpySwapTask} [mainSwap] the main task, when there is one
         */
        __finishSwap(ctx, mainSwap) {
            if (!ctx.sourceElement?.isConnected && mainSwap?.target?.isConnected) {
                ctx.sourceElement = mainSwap.target;
            }

            this.__trigger(ctx.sourceElement, "ypy:after:swap", {ctx});
            if (ctx.title && ctx.swap !== 'none') document.title = ctx.title;
            if (ctx.request?.anchor) document.getElementById(ctx.request.anchor)?.scrollIntoView();
            let box = mainSwap?.target ?? ctx.target;
            this.__applyFocus(ctx, box);
            this.__applyScrollPolicy(ctx, ctx.scroll, box);
        }

        /**
         * Builds the main swap task from what is left of the response after the out-of-band
         * elements and partials were taken out of it. Applies ctx.select, resolves the target
         * (swap spec target, then ctx.target) and sets ctx.title to null for ignoreTitle.
         *
         * @param {YpyRequestCtx} ctx
         * @param {DocumentFragment} fragment the response, after OOB and partials were removed
         * @param {boolean | number} hasPartials true when there were partials, or OOB content that
         *     prevents an empty main swap
         * @returns {YpySwapTask | undefined} undefined when nothing is left to swap
         */
        __processMainSwap(ctx, fragment, hasPartials) {
            // Create main task if needed
            let swapSpec = this.__parseSwapSpec(ctx.swap || this.config.defaultSwap);
            if (swapSpec.ignoreTitle) ctx.title = null;
            // skip main swap if fragment is empty after partial/oob removal
            // swapEmpty modifier can override; default: skip if hasPartials
            if (
                swapSpec.style === 'delete' ||    // delete always runs regardless of content
                (fragment.querySelector('body') || fragment).childElementCount > 0 || // or fragment has elements
                fragment.textContent.trim() ||    // or fragment has text
                (swapSpec.swapEmpty ?? !hasPartials)
            ) {
                let source = ctx.sourceElement || document.body;
                // ctx.targetSelector: the ypy-target that matched nothing when the request was made
                let selector = swapSpec.target || ctx.target || ctx.targetSelector;
                let target = this.__resolveTarget(source, selector, true);
                if (!target && typeof selector === 'string') {
                    [target, fragment] = this.__fallbackMain(ctx, swapSpec, fragment, selector, this.__fallbackMode(source));
                }
                if (ctx.select) {
                    let selected = fragment.querySelectorAll(ctx.select);
                    fragment = document.createDocumentFragment();
                    fragment.append(...selected);
                }
                if (this.__isBoosted(ctx.sourceElement)) {
                    swapSpec.show ||= 'top';
                }
                let mainSwap = {
                    type: 'main',
                    fragment,
                    target,
                    swapSpec,
                    sourceElement: ctx.sourceElement,
                    transition: ctx.transition && swapSpec.transition !== false
                };
                return mainSwap;
            }
        }

        /**
         * Inserts the content of one swap task. Only orders the phases:
         *
         *   __resolveSwapTarget  finds the element to swap into
         *   (swap style, body strip, "swapping" class, swap delay, "delete" and "none" here)
         *   __captureFocus       remembers the focused element of an in-place swap
         *   __applySwapStyle     does the DOM work of the swap style
         *   __restoreFocus       puts the focus back
         *   __afterInsert        settle events and classes, process, autofocus, scroll modifiers
         *
         * Returns early, without events, when the target is missing or the style is "none";
         * a "delete" swap removes the target and stops before the focus and settle phases.
         *
         * @param {YpySwapTask} task
         * @param {boolean} [cssTransition] false inside a view transition: no swap/settle delays
         * @returns {Promise<void>}
         */
        async __insertContent(task, cssTransition = true) {
            let {swapSpec, fragment} = task;
            let target = this.__resolveSwapTarget(task);
            if (!target) return;
            if (typeof swapSpec === 'string') {
                swapSpec = this.__parseSwapSpec(swapSpec);
            }
            let swapStyle = swapSpec.style;
            if (swapStyle === 'none') return;
            // Body fragment: strip wrapper unless outer* swap on document.body
            if (fragment.firstElementChild?.tagName === 'BODY') {
                const keepBody = target === document.body && swapStyle.startsWith('outer')
                if (keepBody && swapStyle === 'outerHTML') swapStyle = 'outerSync'
                swapSpec.strip ??= !keepBody
            }
            if (swapSpec.strip && fragment.firstElementChild) {
                fragment = document.createDocumentFragment();
                fragment.append(...(task.fragment.firstElementChild.content || task.fragment.firstElementChild).childNodes);
            }

            this.__addClass(target, "swapping")
            if (cssTransition && task.swapSpec?.swap) {
                await this.timeout(task.swapSpec?.swap)
            }

            if (swapStyle === 'delete') {
                if (target.parentNode) {
                    this.__cleanup(target);
                    target.parentNode.removeChild(target);
                }
                return;
            }

            // innerHTML/outerHTML swaps backup focus and handle CSS transitions
            let settleTasks = []
            let settleDelay = swapSpec.settle ?? this.config.defaultSettleDelay;
            let parentNode = target.parentNode;
            let focusInfo = this.__captureFocus(swapStyle, parentNode);
            if (swapStyle === 'innerHTML' || (swapStyle === 'outerHTML' && parentNode)) {
                settleTasks = cssTransition && settleDelay ? this.__startCSSTransitions(fragment, target) : []
            }

            let pantry = this.__handlePreservedElements(fragment);
            let newContent;
            [target, newContent] = this.__applySwapStyle(target, swapStyle, swapSpec, fragment, parentNode);
            task.target = target;
            this.__restorePreservedElements(pantry);
            this.__restoreFocus(focusInfo, swapSpec);

            await this.__afterInsert(task, target, swapSpec, newContent, settleTasks, settleDelay, cssTransition);
        }

        /**
         * Insert phase 1: the element a task swaps into. A string target is a selector looked up
         * in the document.
         *
         * @param {YpySwapTask} task
         * @returns {Element | null | undefined} falsy when there is nothing to swap into
         */
        __resolveSwapTarget(task) {
            let target = task.target;
            if (typeof target === 'string') {
                target = document.querySelector(target);
            }
            // an out-of-band element or partial without a target never falls back (ambiguous)
            if (!target && task.type !== 'main') {
                let source = task.sourceElement || document.body;
                this.__targetMissing(source, {selector: task.selector ?? task.target ?? '', ctx: task.ctx, task});
            }
            return target;
        }

        /**
         * How a request treats a target selector that matches nothing. Read from `ypy-fallback`
         * on the source element (inheritable with `:inherited`), then `config.targetFallback`
         * (true, false or "always"), then on.
         *
         * @param {Element} elt the element the request started from
         * @returns {string} `"false"`: no fallback, the target is reported missing; `"always"`:
         *     fall back also for a fragment; any other string: fall back when the response is a
         *     whole page or holds a main
         */
        __fallbackMode(elt) {
            return String(this.__attributeValue(elt, 'ypy-fallback') ?? this.config.targetFallback ?? true) || 'true';
        }

        /**
         * The target chain for a main swap whose selector matched nothing: the current page's
         * `[ypy-main]`, then its `<main>`. It is used when the policy allows it and the swap is
         * safe: the response is a whole page or holds a main (so a small fragment never wipes
         * the page); `always` skips that check. Unless `ypy-select` picks the content, the
         * response's own main replaces the current one (its children, for an inner style; the
         * element, for an outer one) and the whole response goes in when it has none.
         * Fires `ypy:target:fallback` and sets `ctx.fallback` to the selector used; when nothing
         * serves, fires `ypy:target:missing`, warns, and the main swap is skipped.
         *
         * @param {YpyRequestCtx} ctx
         * @param {YpySwapSpec} swapSpec
         * @param {DocumentFragment} fragment the response, after OOB and partials were removed
         * @param {string} selector the selector that matched nothing
         * @param {string} mode from __fallbackMode: "false" (never), "always", or any other value
         * @returns {[target: Element | undefined, fragment: DocumentFragment]}
         */
        __fallbackMain(ctx, swapSpec, fragment, selector, mode) {
            let source = ctx.sourceElement || document.body, used;
            let find = root => {
                used = '[ypy-main]';
                return root.querySelector(this.__prefixSelector('[ypy-main]')) || root.querySelector(used = 'main');
            };
            let incoming = find(fragment), current = find(document);
            let outer = swapSpec.style.startsWith('outer');
            if (current && mode !== 'false' && (mode === 'always' || incoming || fragment.querySelector('body') && !outer)) {
                ctx.fallback = used;
                this.__triggerNative(source, 'ypy:target:fallback', {selector, used, ctx});
                if (incoming && !ctx.select) {
                    fragment = document.createDocumentFragment();
                    fragment.append(...(outer ? [incoming] : incoming.childNodes));
                }
                return [current, fragment];
            }
            this.__targetMissing(source, {selector, ctx});
            return [undefined, fragment];
        }

        /**
         * Reports a target that nothing could serve: `ypy:target:missing` (cancelable; cancel it
         * to keep the console quiet), then a `console.warn` with the context.
         *
         * @param {Element} elt the element that gets the event
         * @param {{selector: string, ctx?: YpyRequestCtx, task?: YpySwapTask}} detail
         */
        __targetMissing(elt, detail) {
            if (this.__triggerNative(elt, 'ypy:target:missing', detail)) {
                console.warn(`ypy: no element for '${detail.selector}'`, {elt, ...detail});
            }
        }

        /**
         * Insert phase 2: remembers the focused element (by id) with its selection, for the
         * swap styles that replace the content in place (innerHTML, outerHTML with a parent) and,
         * for the morph styles: a morph keeps the focused node, but a
         * browser without moveBefore blurs a node it has to move.
         *
         * @param {string} swapStyle normalized swap style
         * @param {Node | null} parentNode parent of the target
         * @returns {{elt: Element, start?: number, end?: number} | undefined} what __restoreFocus
         *     needs; undefined when the style keeps the focus alone or nothing with an id has it
         */
        __captureFocus(swapStyle, parentNode) {
            if (swapStyle === 'innerHTML' || (swapStyle === 'outerHTML' && parentNode) ||
                /Morph$/.test(swapStyle)) {
                let activeElt = document.activeElement;
                if (activeElt?.id) {
                    let start, end;
                    try { start = activeElt.selectionStart; end = activeElt.selectionEnd; } catch (e) {}
                    return { elt: activeElt, start, end };
                }
            }
        }

        /**
         * Insert phase 3: does the DOM work of one swap style (innerHTML, outerHTML, outerSync,
         * innerMorph, outerMorph, textContent, beforebegin, afterbegin, beforeend, afterend, or a
         * style an extension handles through handle_swap). Removes the "swapping" class from the
         * target when done, also when it throws. Throws for an unknown style.
         *
         * @param {Element} target
         * @param {string} swapStyle normalized swap style
         * @param {YpySwapSpec} swapSpec
         * @param {DocumentFragment} fragment the content, after the body strip and the preserved elements
         * @param {Node | null} parentNode parent of the target before the swap
         * @returns {[target: Element | Node, newContent: Node[]]} the target to report in the settle
         *     events (the new element after an outerHTML swap) and the nodes that were inserted
         */
        __applySwapStyle(target, swapStyle, swapSpec, fragment, parentNode) {
            let newContent = [...fragment.childNodes]
            try {
                if (swapStyle === 'innerHTML') {
                    for (const child of target.children) {
                        this.__cleanup(child)
                    }
                    target.replaceChildren(...fragment.childNodes);
                } else if (swapStyle === 'textContent') {
                    for (const child of target.querySelectorAll('[data-ypy-powered]')) {
                        this.__cleanup(child)
                    }
                    target.textContent = fragment.textContent;
                } else if (swapStyle === 'outerHTML') {
                    if (parentNode) {
                        this.__insertNodes(parentNode, target, fragment);
                        this.__cleanup(target)
                        parentNode.removeChild(target);
                        target = newContent.find(node => node.nodeType === 1) || parentNode
                    }
                } else if (swapStyle === 'outerSync') {
                    this.__copyAttributes(target, fragment.firstElementChild);
                    for (const child of target.children) {
                        this.__cleanup(child)
                    }
                    target.replaceChildren(...fragment.firstElementChild.childNodes);
                    newContent = [target];
                } else if (swapStyle === 'innerMorph') {
                    if (swapSpec.default && target === document.body) {
                        // The default style on the whole page is a page change, not a refresh: nothing
                        // the user typed on the old page may leak into the new one. Replace it.
                        let focusInfo = this.__captureFocus('innerHTML', parentNode);
                        for (const child of target.children) {
                            this.__cleanup(child)
                        }
                        target.replaceChildren(...fragment.childNodes);
                        this.__restoreFocus(focusInfo, swapSpec);
                    } else {
                        this.__morph(target, fragment, true);
                    }
                    newContent = [...target.childNodes];
                } else if (swapStyle === 'outerMorph') {
                    this.__morph(target, fragment, false);
                    newContent.push(target);
                } else if (swapStyle === 'beforebegin') {
                    if (parentNode) {
                        this.__insertNodes(parentNode, target, fragment);
                    }
                } else if (swapStyle === 'afterbegin') {
                    this.__insertNodes(target, target.firstChild, fragment);
                } else if (swapStyle === 'beforeend') {
                    this.__insertNodes(target, null, fragment);
                } else if (swapStyle === 'afterend') {
                    if (parentNode) {
                        this.__insertNodes(parentNode, target.nextSibling, fragment);
                    }
                } else {
                    let result;
                    for (const method of this.__extMethods.get('handle_swap') || []) {
                        if (result = method(swapStyle, target, fragment, swapSpec)) break;
                    }
                    if (!result) throw new Error(`Unknown swap style: ${swapStyle}`);
                    if (Array.isArray(result)) newContent = result;
                }
            } finally {
                this.__removeClass(target, "swapping")
            }
            return [target, newContent];
        }

        /**
         * Insert phase 4: gives the focus back to the element __captureFocus remembered, found
         * again by id, with its selection. Does nothing when it still has the focus. Does not
         * scroll unless swapSpec.focusScroll (or config.defaultFocusScroll) asks for it.
         *
         * @param {{elt: Element, start?: number, end?: number} | undefined} focusInfo
         * @param {YpySwapSpec} swapSpec
         */
        __restoreFocus(focusInfo, swapSpec) {
            if (focusInfo && !focusInfo.elt.matches(':focus')) {
                let newElt = document.getElementById(focusInfo.elt.id);
                if (newElt) {
                    let focusOptions = { preventScroll: swapSpec.focusScroll !== undefined ? !swapSpec.focusScroll : !this.config.defaultFocusScroll };
                    this.__setFocus(newElt, focusOptions, focusInfo.start, focusInfo.end);
                }
            }
        }

        /**
         * Insert phase 5: settling. Fires ypy:before:settle, adds the "added" classes, waits the
         * settle delay and runs the CSS transition restore tasks (with the "settling" class),
         * fires ypy:after:settle, then for every new node removes the "added" class, processes it,
         * focuses its [autofocus] element, and finally applies the scroll and show modifiers.
         *
         * @param {YpySwapTask} task
         * @param {Element | Node} target
         * @param {YpySwapSpec} swapSpec
         * @param {Node[]} newContent nodes the swap inserted
         * @param {Function[]} settleTasks CSS transition restore tasks of __startCSSTransitions
         * @param {number} settleDelay milliseconds to wait before running them
         * @param {boolean} cssTransition false inside a view transition: no settle delay
         * @returns {Promise<void>}
         */
        async __afterInsert(task, target, swapSpec, newContent, settleTasks, settleDelay, cssTransition) {
            this.__trigger(target, "ypy:before:settle", {task, newContent, settleTasks})

            for (const elt of newContent) {
                this.__addClass(elt, "added")
            }

            if (cssTransition && settleTasks.length > 0) {
                this.__addClass(target, "settling")
                await this.timeout(settleDelay);
                // invoke settle tasks
                for (let settleTask of settleTasks) {
                    settleTask()
                }
                this.__removeClass(target, "settling")
            }

            this.__trigger(target, "ypy:after:settle", {task, newContent, settleTasks})

            for (const elt of newContent) {
                this.__removeClass(elt, "added")
                this.process(elt);
                this.__handleAutoFocus(elt);
            }

            this.__handleScroll(swapSpec, target);
        }

        //============================================================================================
        // SECTION events (cont.): firing events
        //============================================================================================

        __trigger(on, eventName, detail = {}, bubbles = true) {
            // Convention: events with detail.error log at error level, detail.warn at warn level,
            // otherwise at event level (gated by config.logAll). One emit per event.
            if (detail.error) {
                let prefix = `ypy: ${eventName}: ${detail.error.message ?? detail.error}`;
                if (detail.error instanceof Error) console.error(prefix, detail.error, { elt: on, detail });
                else console.error(prefix, { elt: on, detail });
            } else if (detail.warn) {
                console.warn(`ypy: ${eventName}: ${detail.warn}`, { elt: on, detail });
            } else if (this.config.logAll) {
                console.log(`ypy: ${eventName}`, { elt: on, detail });
            }
            on = this.__normalizeElement(on)
            this.__triggerExtensions(on, eventName, detail);
            return this.trigger(on, this.__maybeAdjustMetaCharacter(eventName), detail, bubbles);
        }

        __triggerExtensions(elt, eventName, detail = {}) {
            // extension hooks are named ypy_<event>
            let methods = this.__extMethods.get(eventName.replace(/:/g, '_'));
            if (methods?.length) {
                methods = [...methods];
                detail.cancelled = false;
                for (const fn of methods) {
                    if (fn(elt, detail) === false || detail.cancelled) {
                        detail.cancelled = true;
                        return false;
                    }
                }
            }
            return true;
        }

        /**
         * A promise that resolves after the interval, or undefined when it is not positive.
         *
         * @param {number | string} time milliseconds, or an interval such as "2s", "500ms", "1m"
         * @returns {Promise<void> | undefined}
         */
        timeout(time) {
            time = this.parseInterval(time);
            if (time > 0) {
                return new Promise(resolve => setTimeout(resolve, time));
            }
        }

        /**
         * Calls the callback for every element YPY finishes processing (ypy:after:process). With a
         * selector first, calls callback(elt) once for each element that matches it in the content
         * YPY processes, which re-initialises the components of a third-party script.
         *
         * @param {string | ((elt: Element) => void)} selector
         * @param {(elt: Element) => void} [callback]
         */
        onLoad(selector, callback) {
            let seen = new WeakSet;
            this.on(this.__maybeAdjustMetaCharacter("ypy:after:process"), (evt) => {
                if (!callback) return selector(evt.target);
                for (let elt of this.__queryEltAndDescendants(evt.target, selector)) {
                    if (!seen.has(elt)) callback(elt, seen.add(elt));
                }
            })
        }

        /**
         * Adds an event listener, on document or on one element. Forms: on(event, callback) and
         * on(elementOrSelector, event, callback).
         *
         * @param {Element | string} eventOrElt the element (or selector), or the event name
         * @param {string | Function} eventOrCallback the event name, or the callback
         * @param {Function} [callback]
         * @returns {Function} the callback, to pass to removeEventListener
         */
        on(eventOrElt, eventOrCallback, callback) {
            let event;
            let elt = document;
            if (callback === undefined) {
                event = eventOrElt;
                callback =  eventOrCallback
            } else {
                elt = this.__normalizeElement(eventOrElt);
                event = eventOrCallback;
            }
            elt.addEventListener(event, callback);
            return callback;
        }

        /**
         * The first element matching the selector, in the document or under an element. The
         * selector may use the extended forms (closest, find, next, previous, this...).
         *
         * @param {Element | string} selectorOrElt the selector, or the element to search under
         * @param {string} [selector]
         * @returns {Element | null}
         */
        find(selectorOrElt, selector) {
            return this.__findAllExt(selectorOrElt, selector)[0]
        }

        /**
         * Every element matching the selector, in the document or under an element.
         *
         * @param {Element | string} selectorOrElt the selector, or the element to search under
         * @param {string} [selector]
         * @returns {Element[]}
         */
        findAll(selectorOrElt, selector) {
            return this.__findAllExt(selectorOrElt, selector)
        }

        /**
         * Parses an interval into milliseconds.
         *
         * @param {number | string} str a number (returned as is) or a string with ms, s or m
         * @returns {number | undefined} undefined when it cannot be parsed
         */
        parseInterval(str) {
            if (typeof str === 'number') return str;
            let [, n, u] = str?.match(/^([\d.]+)(ms|s|m)?$/) || [];
            let v = parseFloat(n) * ({s: 1000, m: 60000}[u] || 1);
            return isNaN(v) ? undefined : v;
        }

        /**
         * Fires an event on an element, cancelable and composed.
         *
         * @param {Element | string} on element, or selector of one; a disconnected one fires on document
         * @param {string} eventName
         * @param {object} [detail]
         * @param {boolean} [bubbles]
         * @returns {boolean} false when a listener cancelled the event
         */
        trigger(on, eventName, detail = {}, bubbles = true) {
            return this.__dispatch(this.__normalizeElement(on), eventName, detail, bubbles);
        }

        __dispatch(on, eventName, detail, bubbles) {
            let evt = new CustomEvent(eventName, {
                detail,
                cancelable: true,
                bubbles,
                composed: true
            });
            let target = on?.isConnected ? on : document;
            let result = !detail?.cancelled && target.dispatchEvent(evt);
            return result
        }
        //============================================================================================
        // SECTION request (cont.): programmatic requests
        //============================================================================================

        /**
         * Issues a request from code and swaps the response like an attribute-driven one.
         * Builds a request context for the source element, applies the options on it and runs
         * the request phases (see __issueRequest).
         *
         * @param {string} verb GET, POST, PUT, PATCH, DELETE or QUERY
         * @param {string} path
         * @param {Element | string | YpyAjaxOptions} [options] a target, or the options
         * @returns {Promise<void>} resolves when the request ended; rejects when the source or
         *     the target is not found
         */
        ajax(verb, path, options) {
            // Normalize options to object
            if (!options || options instanceof Element || typeof options === 'string') {
                options = {target: options};
            }

            let sourceElt = typeof options.source === 'string' ?
                document.querySelector(options.source) : options.source;

            // If source selector was provided but didn't match, reject
            if (typeof options.source === 'string' && !sourceElt) {
                return Promise.reject(new Error('Source not found'));
            }

            sourceElt ||= document.body;

            let ctx = this.__createRequestContext(sourceElt, options.event || {});
            let req = ctx.request;
            Object.assign(ctx, options);
            // options.request is merged into the request the factory built, never put in its
            // place: the replacement used to drop the core headers, mode, credentials, abort
            // and validate. A passed signal is combined with the request's own, so both abort it.
            ctx.request = req;
            let {headers, signal, ...init} = options.request || {};
            Object.assign(req, init, {action: path, method: verb.toUpperCase()});
            if (signal) req.signal = AbortSignal.any([req.signal, signal]);
            if (options.target) {
                ctx.target = this.__resolveTarget(document.body, options.target);
                if (!ctx.target) return Promise.reject(new Error('Target not found'));
            }
            // A header set to null or undefined is removed from the request
            for (let h of [headers, options.headers]) {
                for (let name in h) h[name] == null ? delete req.headers[name] : req.headers[name] = h[name];
            }

            return this.__handleTriggerEvent(ctx);
        }

        //============================================================================================
        // SECTION history: history entries, restoration and the start-up listeners
        //============================================================================================

        /**
         * Registers the document-level history listeners (navigation traversal or popstate),
         * once. Owner: history (TASK-016).
         */
        __initHistory() {
            if (this.config.history && !this.#historyInitialized) {
                this.#historyInitialized = true;
                if (window.navigation && !/firefox/i.test(navigator.userAgent)) {
                    navigation.addEventListener('navigate', (event) => {
                        if (event.navigationType === 'traverse' && event.canIntercept && !event.hashChange)
                            event.intercept({handler: () => this.__restoreHistory()});
                    });
                /* c8 ignore next 3 */
                } else {
                    window.addEventListener('popstate', (event) => this.__restoreHistory(event.state));
                }
            }
        }

        /**
         * Remembers the path of the current entry as one of ours: an entry whose state another
         * script replaced is still restored (see __restoreHistory).
         */
        __markHistoryPath() {
            this.#historyPaths.add(location.pathname + location.search);
        }

        __pushUrlIntoHistory(path, scroll = [scrollX, scrollY]) {
            if (!this.config.history) return;
            // remember where the page being left was scrolled to (read by __restoreHistory); other
            // keys of the entry's state are kept, and an entry that another router owns is left alone
            if (history.state?.ypy) history.replaceState({...history.state, scroll}, '', location.href);
            history.pushState({ypy: true}, '', path);
            this.__trigger(document, "ypy:after:history:push", {path});
        }

        __replaceUrlInHistory(path) {
            if (!this.config.history) return;
            history.replaceState({ypy: true}, '', path);
            this.__trigger(document, "ypy:after:history:replace", {path});
        }

        /**
         * Restores the page of the entry the user went back or forward to, by asking the server
         * for it again: no copy of the page is kept, so it is never stale. The request is an
         * ordinary GET from the document (same headers as any request, plus
         * YPY-History-Restore-Request and YPY-Request-Type: full) with YPY-Request left out, so the
         * server answers with a whole page. A second traversal aborts the first one.
         *
         *   - config.historyRestore.cache is the fetch cache mode, "no-cache" unless set, so an
         *     intermediate or browser cache that kept a fragment under this URL is revalidated
         *   - config.historyRestore.fragment: when the response is not a whole page, the page is
         *     reloaded instead and ypy:history:restore:fragment fires first; set it to false to
         *     swap the fragment anyway
         *   - the scroll position saved by __pushUrlIntoHistory is restored through
         *     __applyScrollPolicy(ctx, "restore"), with the position in ctx.scrollPosition
         *
         * @param {{ypy?: boolean, scroll?: [number, number]}} [state] state of the entry; defaults
         *     to history.state
         * @param {string} [path] defaults to the current path and query
         * @returns {Promise<void> | undefined}
         */
        async __restoreHistory(state, path) {
            await this.timeout(1);
            state ??= history.state;
            path = path || location.pathname + location.search;
            // an entry whose state another script replaced is ours while its path is one we wrote
            if (!state?.ypy && !this.#historyPaths.has(path)) return;
            this.#historyAbort?.abort();
            let historyElt = document.querySelector(this.__prefixSelector('[ypy-history-elt]')) || document.body;
            if (this.__trigger(document, "ypy:before:history:restore", {path, cacheMiss: true})) {
                if (this.config.history === "reload") {
                    this._loc.reload();
                } else {
                    let {cache = 'no-cache', fragment = true} = this.config.historyRestore || {};
                    let abort = this.#historyAbort = new AbortController();
                    // Not a whole page (no doctype, html or body tag): the server answered a
                    // fragment, or a cache did. Reload so the browser asks for the page itself.
                    let guard = (e) => {
                        let ctx = e.detail.ctx;
                        if (ctx.request.headers['YPY-History-Restore-Request'] && !/<(!doc|html|body)/i.test(ctx.text)) {
                            this.__triggerNative(document, 'ypy:history:restore:fragment', {ctx});
                            e.preventDefault();
                            this._loc.reload();
                        }
                    };
                    if (fragment) document.addEventListener('ypy:before:swap', guard);
                    await this.ajax('GET', path, {
                        target: historyElt,
                        swap: 'outerSync',
                        select: historyElt !== document.body ? this.__prefixSelector('[ypy-history-elt]') : undefined,
                        ...(state?.scroll && {scroll: 'restore', scrollPosition: state.scroll}),
                        request: {
                            headers: {'YPY-History-Restore-Request': 'true', 'YPY-Request': null},
                            signal: abort.signal,
                            cache
                        }
                    });
                    document.removeEventListener('ypy:before:swap', guard);
                }
            }
        }

        __resolveHistoryAction(ctx) {
            let {sourceElement, push, replace, ypy, response} = ctx;

            // allow response headers to override history action
            if (ypy?.pushurl || ypy?.replaceurl) { // YPY-Push-Url, YPY-Replace-Url
                push = ypy.pushurl;
                replace = ypy.replaceurl;
            }

            // a boosted element pushes by default, a GET or a redirect to the page it ends on; the
            // answer of a POST, PUT, PATCH or DELETE is not a page that can be loaded again
            if (push == null && replace == null && this.__isBoosted(sourceElement) && (ctx.request.method == 'GET' || ctx.redirected)) {
                push = 'true';
            }
            
            // normalize "false" to null
            if (push === 'false' || push === false) push = null;
            if (replace === 'false' || replace === false) replace = null;

            if (!push && !replace) return null;

            let path = push || replace;
            // if the path is simply "true" normalize to the current path
            if (path === 'true') {
                let finalUrl = response?.raw?.url || ctx.request.action;
                let url = new URL(finalUrl, location.href);
                path = url.pathname + url.search + (ctx.request.anchor ? '#' + ctx.request.anchor : '');
            }

            let type = push ? 'push' : 'replace';
            return {type, path};
        }

        __handleHistoryUpdate(ctx) {
            if (!this.config.history) return;
            // Stamp the current entry on the first YPY swap after a fresh page load (or after another
            // script replaced its state), so back traversals to this page are interceptable.
            if (!history.state?.ypy) {
                history.replaceState({...history.state, ypy: true}, '', location.href);
                this.__markHistoryPath();
            }
            let action = this.__resolveHistoryAction(ctx);
            if (!action) return;

            let historyDetail = {
                history: action,
                sourceElement: ctx.sourceElement,
                response: ctx.response
            };
            if (!this.__trigger(document, "ypy:before:history:update", historyDetail)) return;
            if (action.type === 'push') {
                this.__pushUrlIntoHistory(action.path, ctx.scrollFrom);
            } else {
                this.__replaceUrlInHistory(action.path);
            }
            this.__markHistoryPath();
            this.__trigger(document, "ypy:after:history:update", historyDetail);
        }

        //============================================================================================
        // SECTION events (cont.): ypy-on attributes
        //============================================================================================

        // ypy-on:<event> binds to <event> directly
        // ypy-on::<event> is shorthand for ypy-on:ypy:<event> (YPY events)
        __handleYpyOnAttributes(node) {
            if (node._ypy?.onInitialized) return;
            let ypyOnNames = this.__prefixes("ypy-on");
            let mc = this.config.metaCharacter || ':';
            let handler = (code) => async (evt) => {
                try {
                    await this.__executeJavaScript(node, { event: evt },
                        `with(event?.detail||{}){${code}}`, false);
                } catch (e) {
                    if (typeof e !== 'symbol') this.__trigger(node, 'ypy:error', { error: e });
                }
            };
            for (let attr of node.getAttributeNames()) {
                let prefix = ypyOnNames.find(p => attr.startsWith(p));
                if (!prefix) continue;
                this.__ypyProp(node).onInitialized = true;
                let rest = attr.substring(prefix.length);
                let value = node.getAttribute(attr);
                // ypy-on="click once -> doA(); blur -> doB()"
                if (!rest) {
                    for (let part of value.split(/;(?=[^;]*->)/)) {
                        let idx = part.indexOf('->');
                        if (idx !== -1) this.__onTrigger(node, part.substring(0, idx).trim(), handler(part.substring(idx + 2).trim()));
                    }
                    continue;
                }
                // ypy-on:click="code" or ypy-on::before:request="code"
                if (rest[0] !== mc) continue;
                let eventName = rest.substring(1);
                if (eventName.startsWith(mc)) eventName = 'ypy' + mc + eventName.substring(1);
                this.__onTrigger(node, eventName, handler(value));
            }
        }

        //============================================================================================
        // SECTION request (cont.): indicators, disabled elements, form values
        //============================================================================================

        __showIndicators(ctx) {
            let elt = ctx.sourceElement;
            let ypyIndicator = this.__attributeValue(elt, "ypy-indicator");
            let indicatorElements;
            if (!ypyIndicator) {
                if (elt === document.body) return;
                indicatorElements = [elt];
            } else {
                indicatorElements = this.__findAllExt(elt, ypyIndicator, "ypy-indicator");
            }
            for (const indicator of indicatorElements) {
                ctx.indicators.push(indicator);
                let s = this.__ypyState(indicator);
                s.rc = (s.rc || 0) + 1;
                this.__setState(indicator, 'request', true);
            }
        }

        __hideIndicators(indicatorElements) {
            for (let indicator of indicatorElements) {
                let s = this.__ypyState(indicator);
                if (s.rc && --s.rc <= 0) {
                    this.__setState(indicator, 'request', false);
                    delete s.rc;
                }
            }
        }

        /**
         * Holds back the elements named by ypy-disable (disabled) and, when ypy-inert (or
         * config.inert, off by default) is "true", the target of the request (inert). Both go in
         * ctx.disabledElements, released together by __enableElements.
         */
        __disableElements(ctx) {
            let elt = ctx.sourceElement;
            let hold = (list, property) => {
                for (let el of list) {
                    ctx.disabledElements.push(el);
                    let s = this.__ypyState(el);
                    s.dc = (s.dc || 0) + 1;
                    el[property] = true;
                }
            };
            let ypyDisable = this.__attributeValue(elt, "ypy-disable");
            if (ypyDisable) hold(this.__findAllExt(elt, ypyDisable, "ypy-disable"), 'disabled');
            if (/true/.test(this.__attributeValue(elt, "ypy-inert", this.config.inert)) && ctx.target?.nodeType) hold([ctx.target], 'inert');
        }

        __enableElements(disabledElements) {
            for (const indicator of disabledElements) {
                let s = this.__ypyState(indicator);
                if (s.dc && --s.dc <= 0) {
                    indicator.disabled = indicator.inert = false
                    delete s.dc;
                }
            }
        }

        __collectFormData(elt, form, submitter, validate, isGet) {
            if (validate && form && !form.reportValidity()) return

            // treat a submit button that owns ypy-post as its own submitter; FormData adds its
            // name and value (nothing when it has no name), and throws for a button of another form
            submitter ??= (form && elt.type === 'submit') ? elt : null;
            if (submitter?.form !== form) submitter = null;

            let formData = form ? new FormData(form, submitter) : new FormData()
            let included = form ? new Set(form.elements) : new Set()
            if (!form) {
                if (validate && elt.reportValidity && !elt.reportValidity()) return
                this.__addInputValues(elt, included, formData, isGet);
            }
            if (submitter) included.add(submitter);
            let ypyInclude = this.__attributeValue(elt, "ypy-include");
            if (ypyInclude) {
                for (let node of this.__findAllExt(elt, ypyInclude)) {
                    if (validate && node.reportValidity && !node.reportValidity()) return
                    this.__addInputValues(node, included, formData);
                }
            }
            return formData
        }

        __addInputValues(elt, included, formData, isGet) {
            let tag = elt.tagName;
            let inputs = [];
            if (tag === 'BUTTON' || tag.includes('-')) {
                inputs = [elt]; // send own value only, never collect children
            } else if (['INPUT', 'SELECT', 'TEXTAREA', 'FIELDSET'].includes(tag) || (!isGet && elt !== document.body)) {
                inputs = this.__queryEltAndDescendants(elt, '[name]:not(button)');
            }
            // GET on non-form-control containers sends nothing; POST on body sends nothing; use ypy-include for explicit inclusion

            for (let input of inputs) {
                let name = input.name || input.getAttribute?.('name');
                if (!name || input.matches(':disabled') || included.has(input)) continue;
                included.add(input);

                let type = input.type;
                if (type === 'checkbox' || type === 'radio' || (input.tagName !== 'INPUT' && 'checked' in input)) {
                    // Only add if checked
                    if (input.checked) {
                        formData.append(name, input.value);
                    }
                } else if (type === 'file') {
                    // Add all selected files
                    for (let file of input.files) {
                        formData.append(name, file);
                    }
                } else if (type === 'select-multiple') {
                    // Add all selected options
                    for (let option of input.selectedOptions) {
                        formData.append(name, option.value);
                    }
                } else if (Array.isArray(input.value)) {
                    // Add all array values (e.g. custom elements)
                    for (let v of input.value) {
                        formData.append(name, v);
                    }
                } else {
                    formData.append(name, input.value);
                }
            }
        }

        //============================================================================================
        // SECTION attributes (cont.): attribute objects and element queries
        //============================================================================================

        __getAttributeObject(elt, attrName, callback, scope = {}) {
            let ypyAttr = this.__attributeValue(elt, attrName);
            if (!ypyAttr) return null;

            let javascriptContent = this.__extractJavascriptContent(ypyAttr);
            if (javascriptContent) {
                // Wrap in braces if not already wrapped
                if (!javascriptContent.startsWith('{')) javascriptContent = '{' + javascriptContent + '}';
                // Return promise for async evaluation
                return this.__executeJavaScript(elt, scope, javascriptContent, true).then(callback);
            } else {
                // Synchronous path - return the parsed object directly
                callback(HCON.parse(ypyAttr));
            }
        }

        __findAllExt(eltOrSelector, maybeSelector, thisAttr, global) {
            let selector = maybeSelector ?? eltOrSelector;
            let elt = maybeSelector ? (this.__normalizeElement(eltOrSelector) || document.body) : document;
            if (selector.startsWith('global ')) {
                return this.__findAllExt(elt, selector.slice(7), thisAttr, true);
            }
            let parts = selector ? HCON.split(selector) : [];
            let result = []
            let unprocessedParts = []
            for (const part of parts) {
                let selector = part.trim()
                if (selector.startsWith('<') && selector.endsWith('/>')) selector = selector.slice(1, -2)
                let item
                if (selector.startsWith('closest ')) {
                    item = elt.closest(selector.slice(8))
                } else if (selector.startsWith('find ')) {
                    item = elt.querySelector(selector.slice(5))
                } else if (selector.startsWith('findAll ')) {
                    result.push(...elt.querySelectorAll(selector.slice(8)))
                } else if (selector === 'next' || selector === 'nextElementSibling') {
                    item = elt.nextElementSibling
                } else if (selector.startsWith('next ')) {
                    item = this.__scanQuery(elt, selector.slice(5), !!global)
                } else if (selector === 'previous' || selector === 'previousElementSibling') {
                    item = elt.previousElementSibling
                } else if (selector.startsWith('previous ')) {
                    item = this.__scanQuery(elt, selector.slice(9), !!global, true)
                } else if (selector === 'document') {
                    item = document
                } else if (selector === 'window') {
                    item = window
                } else if (selector === 'body') {
                    item = document.body
                } else if (selector === 'host') {
                    item = (elt.getRootNode()).host
                } else if (selector === 'this') {
                    if (thisAttr) {
                        result.push(...this.__findThisElements(elt, thisAttr));
                        continue;
                    }
                    item = elt
                } else {
                    unprocessedParts.push(selector)
                }

                if (item) {
                    result.push(item)
                }
            }

            if (unprocessedParts.length > 0) {
                let standardSelector = unprocessedParts.join(',')
                let rootNode = this.__getRootNode(elt, !!global)
                result.push(...rootNode.querySelectorAll(standardSelector))
            }

            return [...new Set(result)]
        }

        __scanQuery(start, match, global, backwards) {
            let results = [...this.__getRootNode(start, global).querySelectorAll(match)];
            if (backwards) results.reverse();
            let comparison = backwards ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
            return results.find(elt => elt.compareDocumentPosition(start) === comparison);
        }

        __getRootNode(elt, global) {
            if (elt.isConnected && elt.getRootNode) {
                return elt.getRootNode?.({composed: global})
            } else {
                return document
            }
        }

        __findOrWarn(elt, selector, thisAttr, quiet) {
            let result = this.__findAllExt(elt, selector, thisAttr)[0]
            if (!result && !quiet) {
                console.warn(`ypy: '${selector}' on ${thisAttr} did not match any element`,
                    { elt, selector, attr: thisAttr });
            }
            return result
        }

        __extractJavascriptContent(string) {
            return string?.match(/^(?:js|javascript):(.*)/s)?.[1];
        }

        //============================================================================================
        // SECTION request (cont.): aborting
        //============================================================================================

        /**
         * Makes elt answer ypy:abort by aborting the request in flight in its queue. The queue is
         * the one the last request of elt used, which is not elt's own when ypy-sync names
         * another element or `target`.
         *
         * @param {Element} elt
         * @param {RequestQueue} queue the queue of the request that is being admitted
         */
        __initializeAbortListener(elt, queue) {
            let ypyProp = this.__ypyProp(elt);
            ypyProp.queue = queue;
            if (ypyProp.abortInitialized) return;
            ypyProp.abortInitialized = true;
            let handler = () => ypyProp.queue?.abort();
            elt.addEventListener("ypy:abort", handler);
            ypyProp.listeners.push({fromElt: elt, eventName: "ypy:abort", handler});
        }

        //============================================================================================
        // SECTION morph: the morphing algorithm
        //============================================================================================

        __morph(oldNode, fragment, innerHTML) {
            let {persistentIds, idMap} = this.__createIdMaps(oldNode, fragment);
            let pantry = document.createElement("div");
            pantry.hidden = true;
            document.body.after( pantry);
            // live: the state the user gave an element wins over the response, except where the
            // response marks the element with ypy-morph-force
            let live = this.__prefixSelector('[ypy-morph-force]');
            // keep: the elements that carry ypy-preserve
            let ctx = {target: oldNode, idMap, persistentIds, pantry, futureMatches: new WeakSet(), live,
                keep: this.__prefixSelector('[ypy-preserve],[ypy-preserve-attrs]')};

            if (innerHTML) {
                this.__morphChildren(ctx, oldNode, fragment);
            } else {
                this.__morphChildren(ctx, oldNode.parentNode, fragment, oldNode, oldNode.nextSibling);
            }
            this.__cleanup(pantry)
            pantry.remove();
        }

        __morphChildren(ctx, oldParent, newParent, insertionPoint = null, endPoint = null) {
            if (oldParent instanceof HTMLTemplateElement && newParent instanceof HTMLTemplateElement) {
                oldParent = oldParent.content;
                newParent = newParent.content;
            }
            insertionPoint ||= oldParent.firstChild;

            let newChild = newParent.firstChild;
            while (newChild) {
                let matchedNode;
                if (insertionPoint && insertionPoint != endPoint) {
                    matchedNode = this.__findBestMatch(ctx, newChild, insertionPoint, endPoint);
                    // nodes before the match are removed, unless they match upcoming content: those move to the end for later use
                    for (let cursor = insertionPoint; matchedNode && cursor && cursor !== matchedNode;) {
                        let tempNode = cursor;
                        cursor = cursor.nextSibling;
                        if (tempNode instanceof Element && (ctx.idMap.has(tempNode) || this.__matchesUpcomingSibling(ctx, tempNode, newChild))) {
                            this.__moveBefore(oldParent, tempNode, endPoint);
                        } else {
                            this.__removeNode(ctx, tempNode);
                        }
                    }
                }

                if (!matchedNode && newChild instanceof Element && ctx.persistentIds.has(newChild.id)) {
                    let escapedId = CSS.escape(newChild.id);
                    matchedNode = (ctx.target.id === newChild.id && ctx.target) ||
                        ctx.target.querySelector(`[id="${escapedId}"]`) ||
                        ctx.pantry.querySelector(`[id="${escapedId}"]`);
                    let element = matchedNode;
                    while ((element = element.parentNode)) {
                        let idSet = ctx.idMap.get(element);
                        if (idSet) {
                            idSet.delete(matchedNode.id);
                            if (!idSet.size) ctx.idMap.delete(element);
                        }
                    }
                    this.__moveBefore(oldParent, matchedNode, insertionPoint);
                }

                if (matchedNode) {
                    this.__morphNode(matchedNode, newChild, ctx);
                    insertionPoint = matchedNode.nextSibling;
                    newChild = newChild.nextSibling;
                    continue;
                }

                let nextNewChild = newChild.nextSibling;
                if (ctx.idMap.has(newChild)) {
                    let placeholder = document.createElement(newChild.tagName);
                    oldParent.insertBefore(placeholder, insertionPoint);
                    this.__morphNode(placeholder, newChild, ctx, true);
                    this.process(placeholder);
                    insertionPoint = placeholder.nextSibling;
                } else {
                    oldParent.insertBefore(newChild, insertionPoint);
                    insertionPoint = newChild.nextSibling;
                }
                newChild = nextNewChild;
            }

            while (insertionPoint && insertionPoint != endPoint) {
                let tempNode = insertionPoint;
                insertionPoint = insertionPoint.nextSibling;
                this.__removeNode(ctx, tempNode);
            }
        }

        __matchesUpcomingSibling(ctx, oldElt, startNode) {
            if (ctx.futureMatches.has(oldElt)) return true;
            for (let sibling = startNode.nextSibling, i = 0; sibling && i < this.config.morphScanLimit; sibling = sibling.nextSibling, i++) {
                if (sibling instanceof Element && oldElt.isEqualNode(sibling)) {
                    ctx.futureMatches.add(oldElt);
                    return true;
                }
            }
            return false;
        }

        __findBestMatch(ctx, node, startPoint, endPoint) {
            // text nodes match positionally (patch in place via __morphNode), 3 = TEXT_NODE
            if (node.nodeType === 3) return startPoint?.nodeType === 3 ? startPoint : null;
            if (!(node instanceof Element)) return null;
            let softMatch = null, displaceMatchCount = 0, scanLimit = this.config.morphScanLimit;
            let newSet = ctx.idMap.get(node), nodeMatchCount = newSet?.size || 0;
            // If node has a non-persistent ID, insert instead of soft matching
            if (node.id && !newSet) return null;
            let cursor = startPoint;
            while (cursor && cursor != endPoint) {
                let oldSet = ctx.idMap.get(cursor);
                if (this.#internalAPI.isSoftMatch(cursor, node)) {
                    // Hard match: matching IDs found in both nodes
                    if (oldSet && newSet && [...oldSet].some(id => newSet.has(id))) return cursor;
                    if (!oldSet) {
                        // Exact match: nodes are identical
                        if (scanLimit > 0 && cursor.isEqualNode(node)) return cursor;
                        // Soft match: same tag/type, save as fallback
                        if (!softMatch) softMatch = cursor;
                    }
                }
                // Stop if too many ID elements would be displaced
                displaceMatchCount += oldSet?.size || 0;
                if (displaceMatchCount > nodeMatchCount) break;
                // Don't move elements containing a focused typeable input
                if (document.activeElement?.selectionStart != null && cursor.contains(document.activeElement)) break;
                // Stop scanning if limit reached and no IDs to match
                if (--scanLimit < 1 && nodeMatchCount === 0) break;
                cursor = cursor.nextSibling;
            }
            // Only return fallback softMatch if it does not match upcoming content
            if (softMatch && this.__matchesUpcomingSibling(ctx, softMatch, node)) return null;
            return softMatch;
        }

        __isSoftMatch(oldNode, newNode) {
            if (!(oldNode instanceof Element) || oldNode.tagName !== newNode.tagName) {
                return false;
            }
            // Script tags must be identical to match - never patch a script with different content
            if (oldNode.tagName === 'SCRIPT' && !oldNode.isEqualNode(newNode)) return false;
            return !oldNode.id || oldNode.id === newNode.id;
        }

        __removeNode(ctx, node) {
            if (ctx.idMap.has(node)) {
                this.__moveBefore(ctx.pantry, node, null);
            } else {
                this.__cleanup(node)
                node.remove();
            }
        }

        __moveBefore(parentNode, element, after) {
            if (parentNode.moveBefore) {
                try {
                    parentNode.moveBefore(element, after);
                    return
                } catch (e) {
                    // ignore and insertBefore instead
                }
            }
            parentNode.insertBefore(element, after);
        }

        __morphNode(oldNode, newNode, ctx, fresh) {
            if (oldNode.nodeType === 3) { // text node
                if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
                return;
            }
            // ypy-preserve says how much of the element a script other than YPY owns
            let mode, list;
            if (oldNode.matches(ctx.keep)) {
                mode = this.__attr(oldNode, 'ypy-preserve');
                list = this.__attr(oldNode, 'ypy-preserve-attrs');
            }
            if (mode == 'all' || (this.config.morphSkip && oldNode.matches(this.config.morphSkip))) return;

            // Trigger extension hook - if returns false, skip morphing this node
            if (!this.__triggerExtensions(oldNode, "ypy:before:morph:node", {oldNode, newNode})) return;

            // an element created for this morph has no state of its own to keep
            let live = !fresh && ctx.live;
            if (mode != 'attrs') this.__copyAttributes(oldNode, newNode, live, list);
            if (oldNode instanceof HTMLTextAreaElement && (document.activeElement !== oldNode || (live && newNode.matches(live))) && oldNode.defaultValue != newNode.defaultValue) {
                oldNode.value = newNode.value;
            }
            // a custom element or a root of a script's own that the response gives empty draws its own
            // children: they stay, unless ypy-preserve="false".
            let skipChildren = mode == 'children' || (this.config.morphSkipChildren && oldNode.matches?.(this.config.morphSkipChildren)) ||
                (ctx.live && oldNode.firstChild && !newNode.firstElementChild && !newNode.textContent.trim() && mode != 'false' &&
                    (oldNode.localName.includes('-') || oldNode.matches(this.config.morphThirdParty)));
            // isEqualNode does not detect template content diff so always morph templates
            if (!skipChildren && (!oldNode.isEqualNode(newNode) || newNode.tagName === 'TEMPLATE' || newNode.querySelector?.('template'))) {
                this.__morphChildren(ctx, oldNode, newNode);
            }
        }

        /**
         * Makes the attributes of destination those of source.
         *
         * @param {Element} destination
         * @param {Element} source
         * @param {string} [live] a selector of the elements the response forces; passing it asks
         *     to keep what the user did to the element: an open or closed details or dialog (a
         *     live state that the attribute mirrors) stays as it is, and a focused field keeps its
         *     text, unless source matches the selector
         * @param {string} [keep] the value of ypy-preserve-attrs: attribute name prefixes (a trailing
         *     `*` is allowed) that the copy neither sets nor removes
         */
        __copyAttributes(destination, source, live, keep) {
            let attributesToIgnore = this.config.morphIgnore || [];
            if (keep) attributesToIgnore = [...attributesToIgnore, ...keep.match(/[^\s,*]+/g) || []];
            let keepOpen = live && /^(DETAILS|DIALOG)$/.test(destination.tagName) && !source.matches(live);
            let needsReinit = false;
            let ypyPrefixes;
            let isYpyAttr = name => (ypyPrefixes ??= this.__prefixes('ypy-')).some(p => name.startsWith(p));
            let ignored = name => keepOpen && name === 'open' || attributesToIgnore.some(p => name.startsWith(p));
            for (const attr of source.attributes) {
                // the cheap test first: most attributes of a morphed element did not change
                if (destination.getAttribute(attr.name) !== attr.value && !ignored(attr.name)) {
                    if (isYpyAttr(attr.name)) needsReinit = true;
                    if (!this.__triggerExtensions(destination, 'ypy:before:morph:attr', { attrName: attr.name, newValue: attr.value })) continue;
                    destination.setAttribute(attr.name, attr.value);
                    if (attr.name === "value" && destination instanceof HTMLInputElement && destination.type !== "file" && (document.activeElement !== destination || (live && source.matches(live)))) {
                            destination.value = attr.value;
                    }
                }
            }
            for (let i = destination.attributes.length - 1; i >= 0; i--) {
                let attr = destination.attributes[i];
                if (attr && !source.hasAttribute(attr.name) && !ignored(attr.name)) {
                    if (isYpyAttr(attr.name)) needsReinit = true;
                    if (!this.__triggerExtensions(destination, 'ypy:before:morph:attr', { attrName: attr.name, newValue: null })) continue;
                    destination.removeAttribute(attr.name);
                }
            }
            if (needsReinit) this.__cleanup(destination, true);
        }

        __populateIdMapWithTree(idMap, persistentIds, root, elements) {
            for (const elt of elements) {
                if (persistentIds.has(elt.id)) {
                    let current = elt;
                    while (current && current !== root) {
                        let idSet = idMap.get(current);
                        if (idSet == null) {
                            idSet = new Set();
                            idMap.set(current, idSet);
                        }
                        idSet.add(elt.id);
                        current = current.parentElement;
                    }
                }
            }
        }

        __createIdMaps(oldNode, newContent) {
            let oldIdElements = this.__queryEltAndDescendants(oldNode, "[id]");
            let newIdElements = newContent.querySelectorAll("[id]");
            let persistentIds = this.__createPersistentIds(oldIdElements, newIdElements);
            let idMap = new Map();
            this.__populateIdMapWithTree(idMap, persistentIds, oldNode.parentElement, oldIdElements);
            this.__populateIdMapWithTree(idMap, persistentIds, newContent, newIdElements);
            return {persistentIds, idMap};
        }

        __createPersistentIds(oldIdElements, newIdElements) {
            let duplicateIds = new Set(), oldIdTagNameMap = new Map();
            for (const {id, tagName} of oldIdElements) {
                if (oldIdTagNameMap.has(id)) duplicateIds.add(id);
                else if (id) oldIdTagNameMap.set(id, tagName);
            }
            let persistentIds = new Set();
            for (const {id, tagName} of newIdElements) {
                if (persistentIds.has(id)) duplicateIds.add(id);
                else if (oldIdTagNameMap.get(id) === tagName) persistentIds.add(id);
            }
            for (const id of duplicateIds) persistentIds.delete(id);
            return persistentIds;
        }

        //============================================================================================
        // SECTION request (cont.): status code rules
        //============================================================================================

        __handleStatusCodes(ctx) {
            let status = ctx.response.raw.status;
            let noSwapStrings = this.config.noSwap.map(x => x + "");
            let str = status + ""
            for (let pattern of [str, str.slice(0, 2) + 'x', str[0] + 'xx']) {
                if (noSwapStrings.includes(pattern)) {
                    ctx.swap = "none";
                    return
                }
                let statusValue = this.__attributeValue(ctx.sourceElement, "ypy-status:" + pattern);
                if (statusValue) {
                    HCON.merge(statusValue, ctx);
                    return;
                }
            }
        }

        /**
         * Error destination of a response with status 400 or more: sets ctx.errorKind
         * ("validation" for 422, "client" for the other 4xx, "server" for 5xx) and the target, swap
         * and focus the author wrote for errors (ypy-error-target, ypy-error-swap, ypy-error-focus,
         * inheritable). A 422 also goes, by default, into the form of the
         * source element with the default swap (morph), and focuses the first invalid
         * field. When the request already swaps into its form (ypy-target="this"), or the element
         * is boosted (the response is a page), the target and the swap stay as the author wrote
         * them and only the focus is the default. A 422 of a form that is not boosted leaves the
         * history alone (ypy-push-url and ypy-replace-url are for the success); the server can still
         * send YPY-Push-Url or YPY-Replace-Url.
         *
         * Runs before ypy:response:error, so a listener can still change ctx. Precedence, last
         * wins: default, ypy-error-*, YPY-Retarget and YPY-Reswap, ypy-status:<code>
         * (__handleStatusCodes runs after this). A target that matches nothing goes through the
         * same chain as any other (quiet lookup, then __fallbackMode and __fallbackMain in
         * __processMainSwap).
         *
         * @param {YpyRequestCtx} ctx
         */
        __errorDefaults(ctx) {
            let elt = ctx.sourceElement, status = ctx.response.status, validation = status === 422,
                own = ['target', 'swap', 'focus'].map(name => this.__attributeValue(elt, 'ypy-error-' + name));
            ctx.errorKind = validation ? 'validation' : status < 500 ? 'client' : 'server';
            if (validation) {
                ctx.focus = 'first-invalid';
                if (!this.__isBoosted(elt)) {   // a boosted form is a navigation: its 422 is a page like any other
                    let form = elt.form || elt.closest('form');
                    if (form && form !== ctx.target) {   // a form that already swaps into itself keeps its swap
                        ctx.target = form;
                        ctx.swap = this.config.defaultSwap;
                    }
                    ctx.push = ctx.replace = null;   // an invalid form is not a new page
                }
            }
            ctx.target = own[0] || ctx.target;
            ctx.swap = own[1] || ctx.swap;
            ctx.focus = own[2] ?? ctx.focus;
            if (ctx.focus === 'false') ctx.focus = false;
            this.__watchError(ctx);
        }

        /**
         * Makes the error visible when the request ends, which is after the swap: the target of the
         * error gets data-ypy-state="error" (and config.classes.error), cleared when the source
         * element sends its next request. The focus is not here: ctx.focus is applied by
         * __applyFocus at the end of the swap ("first-invalid" is one of its values). Nothing
         * happens when the response was not swapped (a header took over, the swap is "none").
         * Registered by __errorDefaults, it waits for the
         * ypy:finally:request of this context on the document: the event is always fired once, and
         * reaches the document even when the swap removed the element it started from.
         *
         * @param {YpyRequestCtx} ctx
         */
        __watchError(ctx) {
            let done = e => {
                if (e.detail.ctx !== ctx) return;
                document.removeEventListener('ypy:finally:request', done);
                if (ctx.status !== 'swapped' || ctx.swap === 'none') return;
                let source = ctx.sourceElement, target = this.__resolveTarget(source, ctx.target, true);
                if (!target?.isConnected) target = source;
                this.__setState(target, 'error', true);
                source.addEventListener('ypy:before:request', () => this.__setState(target, 'error', false), {once: true});
            };
            document.addEventListener('ypy:finally:request', done);
        }

        //============================================================================================
        // SECTION swap (cont.): view transitions and CSS transitions
        //============================================================================================

        __submitTransitionTask(task, ctx) {
            return new Promise((resolve) => {
                this.#transitionQueue ||= [];
                this.#transitionQueue.push({ task, resolve, ctx });
                if (!this.#processingTransition) {
                    this.__processTransitionQueue();
                }
            });
        }

        async __processTransitionQueue() {
            if (this.#transitionQueue.length === 0 || this.#processingTransition) {
                return;
            }

            this.#processingTransition = true;
            let { task, resolve, ctx } = this.#transitionQueue.shift();

            try {
                if (document.startViewTransition) {
                    let detail = {task, ctx};
                    this.__trigger(ctx.sourceElement, "ypy:before:viewTransition", detail)
                    await document.startViewTransition(detail.task).finished;
                    this.__trigger(ctx.sourceElement, "ypy:after:viewTransition", detail)
                } else {
                    await task();
                }
            } catch (e) {
                // Transitions can be skipped/aborted - this is normal
            } finally {
                this.#processingTransition = false;
                resolve();
                this.__processTransitionQueue();
            }
        }

        __startCSSTransitions(fragment, root) {
            let cssAttrs = ['class', 'style', 'width', 'height'];
            let newElementsWithIds = fragment.querySelectorAll("[id]");
            let restoreTasks = []
            if (!newElementsWithIds.length) return restoreTasks;   // nothing to carry over: skip scanning the old content
            let existingElementsById = new Map();
            for (let e of root.querySelectorAll("[id]")) existingElementsById.set(e.id, e);
            for (let elt of newElementsWithIds) {
                let existing = existingElementsById.get(elt.id);
                if (existing?.tagName === elt.tagName) {
                    let clone = elt.cloneNode(false); // shallow clone node
                    for (let a of cssAttrs) existing.hasAttribute(a) ? elt.setAttribute(a, existing.getAttribute(a)) : elt.removeAttribute(a);
                    // the restore leaves `open` alone: a listener may have set it after the swap
                    restoreTasks.push(()=>{
                        this.__copyAttributes(elt, clone, 0, 'open')
                    })
                }
            }
            return restoreTasks;
        }

        //============================================================================================
        // SECTION processing (cont.): state classes and small DOM helpers
        //============================================================================================

        /** @param {Element} elt @param {string} state name of an entry of config.classes */
        __addClass(elt, state) {
            elt?.classList?.add?.(...this.__classNames(state));
        }

        __removeClass(elt, state) {
            elt?.classList?.remove?.(...this.__classNames(state));
            if (elt?.classList?.length === 0) elt.removeAttribute('class');
        }

        __normalizeElement(cssOrElement) {
            if (typeof cssOrElement === "string") {
                return this.find(cssOrElement);
            } else {
                return cssOrElement
            }
        }

        __maybeAdjustMetaCharacter(string) {
            if (this.config.metaCharacter) {
                return string.replace(/:/g, this.config.metaCharacter);
            } else {
                return string;
            }
        }

        //============================================================================================
        // SECTION a11y (cont.): hooks owned by TASK-013, called by the request phases; empty until then
        //============================================================================================

        __liveSheet;   // the adopted style sheet that hides the live regions, created with the first one

        /**
         * Start-up hook for accessibility support: creates the polite live region ahead of the
         * first announcement (a region that exists before its text changes is announced
         * reliably). Called by initialize(); may be called more than once, so it is idempotent
         * (the region is looked up, never duplicated). Does nothing when config.announce is false.
         */
        /**
         * Listener of ypy:before:swap (added by __initA11y): resolves the scroll policy of the
         * request into ctx.scroll and, for "keep", notes where the window and the target are.
         */
        #beforeSwap = e => {
            let ctx = e.detail.ctx, t = ctx.target;
            if ((ctx.scroll ??= ctx.sourceElement && this.__attributeValue(ctx.sourceElement, 'ypy-scroll')) === 'keep') {
                ctx.scrollKept = [{left: scrollX, top: scrollY}, t && {left: t.scrollLeft, top: t.scrollTop}];
            }
        }

        __initA11y() {
            document.addEventListener('ypy:before:swap', this.#beforeSwap);
            if (this.config.announce ?? true) this.__liveRegion('polite');
        }

        /**
         * Whether an automatic accessibility behavior is on: the config value when the author
         * set one (true or false), else on (decision R-6).
         *
         * @param {boolean | object | undefined} setting config.ariaBusy or config.announce
         * @returns {boolean}
         */
        __a11yOn(setting) {
            return !!(setting ?? true);
        }

        /**
         * The live region for a politeness level, created on first use and again if a swap of
         * the body removed it: a visually hidden div (styled by an adopted style sheet, so no
         * inline style and no CSP exception) marked data-ypy-live.
         *
         * @param {"polite" | "assertive"} level
         * @returns {HTMLElement}
         */
        __liveRegion(level) {
            let live = document.querySelector('[data-ypy-live=' + level + ']');
            if (!live) {
                this.__liveSheet ||= this.__sheet('[data-ypy-live]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
                live = document.createElement('div');
                live.setAttribute('data-ypy-live', level);
                live.setAttribute('role', level === 'polite' ? 'status' : 'alert');
                live.setAttribute('aria-live', level);
                document.body.append(live);
            }
            return live;
        }

        /**
         * Puts a message in a live region, in two steps (empty, then the text a moment later) so a
         * screen reader says it again even when it equals the previous one, and empties the
         * region after config.announce.clearAfter milliseconds (5000 by default). A newer message
         * replaces one that was not written yet. Fires the cancelable ypy:announce event first;
         * a listener may change detail.message and detail.politeness.
         *
         * @param {YpyRequestCtx} ctx
         * @param {string | undefined} message nothing happens when it is empty
         * @param {"polite" | "assertive"} level
         */
        __say(ctx, message, level) {
            if (!message) return;
            let detail = {ctx, message, politeness: level};
            if (!this.__triggerNative(ctx.sourceElement?.isConnected ? ctx.sourceElement : document.body, 'ypy:announce', detail) || !detail.message) return;
            let live = this.__liveRegion(detail.politeness);
            let s = this.__ypyState(live);
            clearTimeout(s.t);
            live.textContent = '';
            s.t = setTimeout(() => {
                live.textContent = detail.message;
                s.t = setTimeout(() => live.textContent = '', this.config.announce?.clearAfter ?? 5000);
            }, 50);
        }

        /**
         * Marks the target of a request as busy (aria-busy="true") until the request ends, when
         * it is on (config.ariaBusy; ypy-busy="false" on the target or on the
         * element that sends the request opts out). Concurrent requests to one target are
         * counted, and the value the author had put on the element is restored when the last one
         * ends. Called by __beginRequest after the indicators are shown, once per request;
         * __endRequest always calls __unmarkBusy afterwards. Also says the "loading" message
         * when config.announce.messages has one.
         *
         * @param {YpyRequestCtx} ctx
         */
        __markBusy(ctx, elt = ctx.target) {
            // also called for each swap target (OOB, <ypy-partial>) once the response names it
            if (!this.__a11yOn(this.config.ariaBusy) || !(elt instanceof Element) || ctx.busy?.includes(elt)) return;
            if ((this.__attributeValue(elt, 'ypy-busy') ?? this.__attributeValue(ctx.sourceElement, 'ypy-busy')) === 'false') return;
            let s = this.__ypyState(elt);
            if (!s.bc) s.bv = elt.getAttribute('aria-busy');
            s.bc = (s.bc || 0) + 1;
            elt.setAttribute('aria-busy', 'true');
            (ctx.busy ??= []).push(elt);
            if (elt == ctx.target) this.__say(ctx, this.config.announce?.messages?.loading, 'polite');
        }

        /**
         * Undoes __markBusy: the last request to leave an element puts back the aria-busy value the
         * author had there, or removes the attribute. Called by __endRequest for every admitted
         * request, so it runs without a __markBusy before it (confirmation denied, opt-out) and does nothing then; calling it twice does nothing the second time.
         *
         * @param {YpyRequestCtx} ctx
         */
        __unmarkBusy(ctx) {
            for (let elt of ctx.busy || []) {
                let s = this.__ypyState(elt);
                if (!(--s.bc > 0)) {
                    s.bv == null ? elt.removeAttribute('aria-busy') : elt.setAttribute('aria-busy', s.bv);
                    delete s.bc;
                    delete s.bv;
                }
            }
            ctx.busy = null;
        }

        /**
         * Announces the outcome of a request in a live region, when announcements are on
         * (config.announce). Called by __endRequest after the busy marks are gone,
         * for every admitted request. What is said, in order:
         *
         *  - a failure (ctx.errorKind, a status of 400 or more, or a request that threw; a silent
         *    abort is not one): ctx.announce, else the "offline" message (network, offline) or
         *    the "error" message of config.announce.messages, politeness assertive;
         *  - a success: ctx.announce or the ypy-announce attribute of the source element, then
         *    of the target: literal text, "title" (the new document title) or "none";
         *    when there is none, the new title after a boosted navigation, else the "done"
         *    message of config.announce.messages;
         *  - ctx.announce === false is silence.
         *
         * Without configured messages nothing is said by default except the title of a boosted
         * navigation: the core carries no text of its own.
         *
         * @param {YpyRequestCtx} ctx
         */
        __announce(ctx) {
            let cfg = this.config.announce;
            if (ctx.announce === false || !this.__a11yOn(cfg)) return;
            let m = cfg?.messages || {};
            let status = ctx.status + '';
            let kind = ctx.errorKind || (ctx.response?.status >= 400 ? 'server' : /^error: (?!AbortError)/.test(status) && 'network');
            let spec = typeof ctx.announce === 'string' ? ctx.announce : null;
            if (kind) {
                // network and offline are the two lost-connection kinds
                spec ??= m[/net|off/.test(kind) ? 'offline' : 'error'];
            } else if (status === 'swapped') {
                let target = ctx.target;
                spec ??= this.__attributeValue(ctx.sourceElement, 'ypy-announce')
                    ?? (target instanceof Element ? this.__attributeValue(target, 'ypy-announce') : null)
                    ?? (this.__isBoosted(ctx.sourceElement) && ctx.swap !== 'none' ? 'title' : m.done);
            }
            if (spec === 'title') spec = ctx.title || document.title;
            if (spec !== 'none') this.__say(ctx, spec, kind ? 'assertive' : 'polite');
        }

        //============================================================================================
        // SECTION offline: connection state and failure kinds (owner: TASK-010); retry is the ypy-retry extension
        //============================================================================================

        #offline = false
        #onNetworkChange = event => this.__setOffline(event.type === 'offline')

        /**
         * Start-up hook for offline detection. Listens to the window "online" and "offline"
         * events and reads the state at load. Called by initialize() and idempotent: the listener
         * is one function, so adding it again does nothing.
         *
         * navigator.onLine is only a hint: false means there is no network interface, true does
         * not mean the server is reachable (VPN, captive portal, and Chromium and WebKit disagree).
         * That is why a request that gets a response clears the offline state.
         */
        __initOffline() {
            window.addEventListener('offline', this.#onNetworkChange);
            window.addEventListener('online', this.#onNetworkChange);
            if (!navigator.onLine) this.__setOffline(true);
        }

        /**
         * Turns the page offline state on or off: the offline class
         * (config.classes.offline, "ypy-offline" unless the author set it) and data-ypy-state="offline" on <html>, then ypy:offline or
         * ypy:online on the document. Does nothing when the state does not change.
         *
         * @param {boolean} on
         */
        __setOffline(on) {
            if (on === this.#offline) return;
            this.#offline = on;
            this.config.classes.offline ??= 'ypy-offline';   // the default lives here until __initConfig (task 002) holds it
            this.__setState(document.documentElement, 'offline', on);
            this.__triggerNative(document, on ? 'ypy:offline' : 'ypy:online');
        }

        //============================================================================================
        // Shared utilities (owner: TASK-006). Used by the Phase 1 tasks; nobody else edits them.
        //============================================================================================

        /**
         * Turns a named state of an element on or off in the two ways an author can style it: the
         * configured class names of that state (config.classes, see __classNames) and a
         * data-ypy-state attribute holding the active states, space separated. The attribute is
         * removed when the last state goes. Use it for every new state (busy, error, offline...);
         * the existing request, swapping, settling and added classes keep their own code. A state
         * with no configured class only gets the attribute (and an empty class attribute, if the
         * element had none).
         *
         * @param {Element} elt
         * @param {string} state a key of config.classes, also the token written to data-ypy-state
         * @param {boolean} on
         */
        __setState(elt, state, on) {
            if (!elt?.dataset) return;
            on ? this.__addClass(elt, state) : this.__removeClass(elt, state);
            let states = (elt.dataset.ypyState || '').split(' ').filter(x => x && x !== state);
            if (on) states.push(state);
            states[0] ? elt.dataset.ypyState = states.join(' ') : delete elt.dataset.ypyState;
        }

        /**
         * Fires a ypy:<noun>:<verb> event, for example ypy:target:missing. Like __trigger it runs the
         * extension hooks (ypy_<noun>_<verb>) first, honors config.metaCharacter and logs events with
         * detail.error (error), detail.warn (warn) or, with config.logAll, every event; and like
         * it returns false when a listener or an extension cancelled the event.
         *
         * @param {Element | string} on element, or selector of one, the event is dispatched on
         * @param {string} name event name starting with "ypy:"
         * @param {object} [detail]
         * @returns {boolean} false when cancelled (the event always bubbles)
         */
        __triggerNative(on, name, detail = {}) {
            on = this.__normalizeElement(on);
            let level = detail.error ? 'error' : detail.warn ? 'warn' : this.config.logAll && 'log';
            if (level) console[level]('ypy: ' + name, { elt: on, detail });
            this.__triggerExtensions(on, name, detail);
            return this.__dispatch(on, this.__maybeAdjustMetaCharacter(name), detail, true);
        }

    }

    return new Ypy()
})()

;
