// SPDX-License-Identifier: MIT
var ypy = (() => {
    // a second <script> keeps the first instance
    if (globalThis.ypy) return console.warn('ypy: loaded twice'), globalThis.ypy;

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
     * It lives in Ypy.#requestQueues, never on the element. Every request it refuses, waits
     * for, replaces or aborts is reported through `emit(name, ctx, reason)` so that no
     * cancellation is silent (ypy:request:queued, ypy:request:dropped, ypy:request:aborted).
     * A request admitted without a ctx (a direct call) is not reported.
     */
    let SYNC_STRATEGY = /^(drop|abort|replace|queue|latest|parallel)/;

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

        /**
         * Returns "run", "queued", or "dropped". `parallel` takes no slot, so nothing waits for it
         * and it aborts nothing. `latest` takes the slot at once and marks the request that held
         * it as superseded (ctx.superseded): its response is discarded when it arrives.
         */
        admit(strategy, runRequest, abortRequest, ctx) {
            let current = this.#current
            if (strategy === "parallel") return "run"
            if (strategy === "latest" && current?.ctx) current.ctx.superseded = true
            if (!current || strategy === "latest") {
                this.#current = {strategy, abort: abortRequest, ctx}
                return "run"
            }
            if (strategy === "replace" || (strategy !== "abort" && current.strategy === "abort")) {
                let why = strategy === "replace" ? strategy : "abort"
                this.clear(why)
                current.abort?.(why)
                this.#current = {strategy, abort: abortRequest, ctx}
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

        #extMethods = new Map();
        #approvedExt = '';
        #registeredExt = new Set();
        _loc = window.location;  // mockable for testing
        #internalAPI;
        #Function = Function;
        #AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        #ttPolicy = makeTrustedTypesPolicy();
        #gated = false          // an extension enforces nonces on every code compilation
        #evaluator              // an extension that runs author code without eval (ypy-expr)
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
        #historyAbort
        #historyInitialized
        #historyPaths = new Set()
        #requestSeq = 0         // ctx.id of the last request context
        #disposed = false
        #init = () => this.initialize()

        //============================================================================================
        // SECTION config: construction, configuration and the extension registry
        //============================================================================================

        constructor() {
            this.#initConfig();
            this.#actionSelector = this.#prefixSelector(['action', ...this.#verbs].map(verb => `[ypy-${verb}]`).join());
            this.#ypyOnQuery = new XPathEvaluator().createExpression(`.//*[@*[${this.#prefixes("ypy-on").map(p => `starts-with(name(), "${p}")`).join(' or ')}]]`);
            this.#initRequestIndicatorCss();
            this.#internalAPI = {
                HCON,
                attributeValue: this.#attributeValue.bind(this),
                parseTriggerSpecs: this.#parseTriggerSpecs.bind(this),
                determineMethodAndAction: this.#determineMethodAndAction.bind(this),
                createRequestContext: this.#createRequestContext.bind(this),
                collectFormData: this.#collectFormData.bind(this),
                getAttributeObject: this.#getAttributeObject.bind(this),
                findAll: this.#findAllExt.bind(this),
                insertContent: this.#insertContent.bind(this),
                morph: this.#morph.bind(this),
                isSoftMatch: this.#isSoftMatch.bind(this),
                attr: this.#attr.bind(this),
                prefixSelector: this.#prefixSelector.bind(this),
                initSecurity: (ttPolicy, syncFn, asyncFn, ignoreFn) => {
                    if (ignoreFn) this.#ignore = ignoreFn;
                    if (ttPolicy) this.#ttPolicy = ttPolicy;
                    if (syncFn) this.#Function = syncFn;
                    if (asyncFn) this.#AsyncFunction = asyncFn;
                    if (syncFn || asyncFn) this.#gated = true;
                    this.#fnCache.clear();
                },
                ttPolicy: () => this.#ttPolicy,
                initEvaluator: fn => this.#evaluator = fn,
                onTrigger: this.#onTrigger.bind(this),
                ypyProp: this.#ypyProp.bind(this),
                triggerEvent: this.#trigger.bind(this),
                executeJavaScript: this.#executeJavaScript.bind(this)
            };
            if (document.readyState === 'loading') {
                document.addEventListener("DOMContentLoaded", this.#init)
            } else {
                setTimeout(this.#init)
            }
        }

        #initConfig() {
            this.version = '0.1.0-dev'
            this.config = {
                logAll: false,
                prefix: "",   // extra custom prefix; ypy- and data-ypy- always work
                transitions: false,
                history: true,
                mode: 'same-origin',
                // "default:true" marks a swap style nobody wrote, see #parseSwapSpec
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
            this.#approvedExt = cfg.extensions;
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
            this.#extMethods.set('ypy_config_request', [(elt, {ctx}) => { if (ctx?.request) ctx.request.mode = cfg.mode }]);
            // fail closed: with config.nonce set, nothing is processed until the nonce extension
            // has started (it calls initSecurity)
            if (cfg.nonce) {
                let warned;
                let gate = () => this.#gated || (warned ||= console.error('ypy: config.nonce is set but ypy-csp did not start') || 1, false);
                for (let key of ['ypy_before_init', 'ypy_before_on_init', 'ypy_config_request', 'ypy_before_oob']) {
                    this.#extMethods.set(key, [...(this.#extMethods.get(key) ?? []), gate]);
                }
            }
        }

        #initRequestIndicatorCss() {
            if (this.config.includeIndicatorCSS !== false) {
                let sel = name => ':is(' + this.#classNames(name).map(c => '.' + CSS.escape(c)).join(',') + ')';
                let indicator = sel('indicator');
                let request = sel('request');
                this.indicatorStyleSheet = this.#sheet(
                    `${indicator}{opacity:0;visibility:hidden} ` +
                    `${request} ${indicator},${request}${indicator}{opacity:1;visibility:visible;transition:opacity 200ms ease-in}`
                );
            }
        }

        /** Adopts a style sheet (no inline style, no CSP exception); undefined when the browser refuses. */
        #sheet(css) {
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
            if (this.#approvedExt && !this.#approvedExt.split(/,\s*/).includes(name)) return false;
            if (this.#registeredExt.has(name)) return false;
            this.#registeredExt.add(name);
            if (extension.init) extension.init(this.#internalAPI);
            Object.entries(extension).forEach(([key, value]) => {
                if(!this.#extMethods.get(key)?.push(value)) this.#extMethods.set(key, [value]);
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
        #prefixList() {
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
        #attrNames(name) {
            let list = this.#prefixList();
            let names = this.#pfxNames.get(name);
            if (!names) this.#pfxNames.set(name, names = list.map(p => name.replace('ypy-', p)));
            return names;
        }

        // an extension may replace it (see initSecurity)
        #ignore = elt => !elt.closest || elt.closest(this.#prefixSelector('[ypy-ignore]')) != null;

        #attr(elt, name) {
            if (!elt.hasAttributes?.()) return null;   // most lookups hit elements with no attribute at all
            for (let n of this.#attrNames(name)) {
                let val = elt.getAttribute(n);
                if (val != null) return val;
            }
            return null;
        }

        #attrName(elt, name) {
            if (!elt.hasAttributes?.()) return null;
            for (let n of this.#attrNames(name)) {
                if (elt.hasAttribute(n)) return n;
            }
            return null;
        }

        #prefixSelector(s) {
            this.#prefixList();
            let sel = this.#pfxSelectors.get(s);
            if (sel === undefined) this.#pfxSelectors.set(s, sel = this.#prefixes(s).join(','));
            return sel;
        }

        #prefixes(s) {
            return this.#prefixList().map(p => s.replaceAll('ypy-', p));
        }

        /**
         * The classes configured for a state (config.classes), as an array.
         * @param {"request"|"swapping"|"settling"|"added"|"indicator"} state
         * @returns {string[]}
         */
        #classNames(state) {
            return (this.config.classes?.[state] ?? '').split(/\s+/).filter(Boolean);
        }

        #queryEltAndDescendants(elt, selector) {
            let results = [...(elt.querySelectorAll?.(selector) ?? [])];
            if (elt.matches?.(selector)) {
                results.unshift(elt);
            }
            return results;
        }

        #normalizeSwapStyle(style) {
            return style === 'before' ? 'beforebegin' :
                   style === 'after' ? 'afterend' :
                   style === 'prepend' ? 'afterbegin' :
                   style === 'append' ? 'beforeend' : style;
        }

        #findThisElements(elt, attrName) {
            let result = [];
            this.#attributeValue(elt, attrName, undefined, (val, elt) => {
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
         *        of the chain instead of returning it (see #findThisElements)
         */
        #attributeValue(elt, name, defaultVal, eltCollector) {
            // the names and selectors of one attribute are cached with the prefix selectors (a key
            // starting with the name, never with "["), so they go away together when config.prefix changes
            this.#prefixList();
            let names = this.#pfxSelectors.get(name), meta = this.config.metaCharacter;
            if (!names || names[4] !== meta) {
                let a = s => this.#maybeAdjustMetaCharacter(name + s), inherited = a(":inherited"), both = a(":inherited:append");
                this.#pfxSelectors.set(name, names = [a(""), inherited, a(":append"), both, meta, this.#prefixSelector(`[${CSS.escape(inherited)}],[${CSS.escape(both)}]`)]);
            }

            let val = this.#attr(elt, names[0]) ?? this.#attr(elt, names[1]);
            if (val != null) return eltCollector ? eltCollector(val, elt) : val;

            let appendValue = this.#attr(elt, names[2]) ?? this.#attr(elt, names[3]);
            let parent = elt.parentNode?.closest?.(names[5]);
            if (appendValue != null) eltCollector?.(appendValue, elt);
            val = parent && this.#attributeValue(parent, name, undefined, eltCollector);
            if (appendValue != null) return val ? (val + "," + appendValue).replace(/[{}]/g, '') : appendValue;
            return parent ? val : defaultVal;
        }

        /** The specs of a trigger string. The same few strings are parsed again for every element, so a
         *  flat parse is kept and every caller gets its own copy (a spec is written to when it is wired). */
        #parseTriggerSpecs(spec) {
            let specs = this.#specCache.get(spec);
            if (!specs) {
                specs = HCON.split(spec).flatMap(s => {
                    let [head, inner, tail] = this.#extractFilter(s), filter = '';
                    // a bracket after the event name (or after `every 1s`) is a filter; later it is part of a modifier
                    if (/^\s*(every\s+\S+?\s*)?[^\s\[]*\[/.test(s)) {
                        if (inner == null) throw "unterminated:" + s;   // e.g. click[ctrlKey
                        filter = `[${inner}]`;
                        s = head + ' ' + tail;
                    }
                    let [, name, rest] = s.match(/^\s*(\S*)\s*(.*?)\s*$/) ?? [];
                    return name ? [{name: name + filter, ...HCON.parse(rest)}] : [];  // spread modifiers (delay, throttle, etc.) onto result
                });
                // nested values (a JSON modifier, a dotted path) would be shared by the copies: do not keep them
                if (specs.some(s => Object.values(s).some(v => v && typeof v == 'object'))) return specs;
                if (this.#specCache.size > 500) this.#specCache.clear();
                this.#specCache.set(spec, specs);
            }
            return specs.map(s => ({...s}));
        }

        #determineMethodAndAction(elt, evt) {
            let method = this.#attributeValue(elt, "ypy-method");
            let action = this.#attributeValue(elt, "ypy-action");
            if (!action) {
                for (let verb of this.#verbs) {
                    let verbAction = this.#attributeValue(elt, "ypy-" + verb);
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
            if (this.#isBoosted(elt)) {
                action ||= elt.getAttribute(elt.matches("a") ? "href" : "action");
            }
            method ||= elt.getAttribute("method") || "GET";
            return {action, method: method.toUpperCase()};
        }

        //============================================================================================
        // SECTION processing: element state and initialization
        //============================================================================================

        #ypyProp(elt) {
            if (!elt._ypy) {
                elt._ypy = { listeners: [], triggerSpecs: [] };
                elt.setAttribute('data-ypy-powered', 'true');
            }
            return elt._ypy;
        }

        #ypyState(elt) {
            return elt._ypy_state ||= {};
        }

        /** Request queues by sync element. Outside the element, so a node that morph reuses is
         *  cleaned from here (#cleanup) and the registry never keeps a removed element alive. */
        #requestQueues = new WeakMap()

        /** How a RequestQueue reports: ypy:request:<name> on the element the request started from */
        #queueEvent = (name, ctx, reason) =>
            this.#triggerNative(ctx.sourceElement, "ypy:request:" + name, {ctx, reason})

        #initializeElement(elt, boosted) {
            if ((boosted || this.#shouldInitialize(elt)) && this.#trigger(elt, "ypy:before:init")) {
                let ypyProp = this.#ypyProp(elt);
                ypyProp.initialized = true;
                ypyProp.eventHandler = async (evt) => {
                    try {
                        let ctx = this.#createRequestContext(elt, evt);
                        await this.#handleTriggerEvent(ctx);
                    } catch (e) {
                        this.#trigger(elt, 'ypy:error', { error: e });
                    }
                };
                if (boosted) ypyProp.boosted = boosted;
                this.#initializeTriggers(elt);
                this.#trigger(elt, "ypy:after:init")
            }
        }

        //============================================================================================
        // SECTION request: the request context and the request phases
        //============================================================================================

        #createRequestContext(sourceElement, sourceEvent) {
            let {action, method} = this.#determineMethodAndAction(sourceElement, sourceEvent);
            let [fullAction, anchor] = (action || '').split('#');
            let ac = new AbortController();
            let ctx = {
                id: ++this.#requestSeq,
                timing: {start: performance.now()},
                sourceElement,
                sourceEvent,
                status: "created",
                select: this.#attributeValue(sourceElement, "ypy-select"),
                selectOOB: this.#attributeValue(sourceElement, "ypy-select-oob"),
                target: this.#attributeValue(sourceElement, "ypy-target"),
                swap: this.#attributeValue(sourceElement, "ypy-swap") ?? this.config.defaultSwap,
                push: this.#attributeValue(sourceElement, "ypy-push-url"),
                replace: this.#attributeValue(sourceElement, "ypy-replace-url"),
                transition: this.config.transitions,
                confirm: this.#attributeValue(sourceElement, "ypy-confirm"),
                request: {
                    validate: "true" === this.#attributeValue(sourceElement, "ypy-validate", sourceElement.matches('form') && !sourceElement.noValidate && !sourceEvent.submitter?.formNoValidate ? "true" : "false"),
                    action: fullAction,
                    anchor,
                    method,
                    headers: {
                        "YPY-Request": "true",
                        "YPY-Source": this.#buildIdentifier(sourceElement),
                        "YPY-Current-URL": location.href,
                        "Accept": "text/html",
                        ...(this.#isBoosted(sourceElement) && {"YPY-Boosted": "true"})
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
            // target (see #fallbackMode)
            let selector = ctx.target;
            ctx.target = this.#resolveTarget(sourceElement, selector, true);
            if (!ctx.target && typeof selector === 'string') ctx.targetSelector = selector;
            if (ctx.target) {
                ctx.request.headers["YPY-Target"] = this.#buildIdentifier(ctx.target);
            }

            // Apply ypy-config overrides
            let ypyConfig = this.#attributeValue(sourceElement, "ypy-config");
            if (ypyConfig) {
                HCON.merge(ypyConfig, ctx.request);
                ctx.request.mode = this.config.mode;  // mode is security-sensitive, never allow per-element override
            }
            return ctx;
        }

        #buildIdentifier(elt) {
            return `${elt.tagName.toLowerCase()}${elt.id ? '#' + encodeURI(elt.id) : ''}`;
        }

        /**
         * The element a response is swapped into. An element is returned as it is, a selector is
         * looked up from `elt`, no selector means the source element (the body for a boosted one).
         *
         * @param {Element} elt the element the selector is relative to
         * @param {Element | string | null | undefined} selector
         * @param {boolean} [quiet] do not warn when the selector matches nothing (the caller
         *     reports it once the fallback chain ended, see #fallbackMain)
         * @returns {Element | undefined} undefined when the selector matches nothing
         */
        #resolveTarget(elt, selector, quiet) {
            if (selector instanceof Element) {
                return selector;
            } else if (selector != null) {
                return this.#findOrWarn(elt, selector, "ypy-target", quiet);
            } else if (this.#isBoosted(elt)) {
                return document.body
            } else {
                return elt;
            }
        }

        #isBoosted(elt) {
            return elt?._ypy?.boosted;
        }

        async #handleTriggerEvent(ctx) {
            let elt = ctx.sourceElement
            let evt = ctx.sourceEvent
            if (!elt.isConnected) return

            // the default action was already cancelled by the trigger's handler (#onTrigger)
            if (this.#isModifierKeyClick(evt)) return

            // determine if request uses query params
            let usesQueryParams = /GET|DELETE/.test(ctx.request.method);

            // Only include *enclosing* form info for request types that do not use
            // query parameters (can still be included explicitly with ypy-include)
            let form = usesQueryParams
                ? (elt.matches('form') ? elt : null)
                : (elt.form || elt.closest("form"))

            // Build request body
            let body = this.#collectFormData(elt, form, evt.submitter, ctx.request.validate, usesQueryParams)
            if (!body) return  // Validation failed
            let valsResult = this.#getAttributeObject(elt, "ypy-vals", obj => {
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
            let headersResult = this.#getAttributeObject(elt, "ypy-headers", obj => {
                for (let key in obj) ctx.request.headers[key] = String(obj[key]);
            }, {ctx})
            if (headersResult) await headersResult  // Only await if it returned a promise

            // Setup event-dependent request details
            Object.assign(ctx.request, {
                form,
                submitter: evt.submitter,
                body
            })

            if (!this.#trigger(elt, "ypy:config:request", {ctx: ctx})) return
            if (ctx.request.method === 'DIALOG') return

            let javascriptContent = this.#extractJavascriptContent(ctx.request.action);
            if (javascriptContent != null) {
                await this.#executeJavaScript(ctx.sourceElement, Object.fromEntries(ctx.request.body), javascriptContent, false);
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
            } else if ((this.#attributeValue(elt, "ypy-encoding") ?? form?.enctype) !== "multipart/form-data") {
                ctx.request.body = new URLSearchParams(ctx.request.body);
            }

            await this.#issueRequest(ctx);
        }

        /**
         * Runs one request from admission to the end of the swap. This function only orders the
         * phases below; it owns no logic of its own and its event order is fixed
         * (test/tests/unit/#phases.js records it).
         *
         *   #admitRequest    queue: run, wait or drop
         *   #confirmRequest  ypy:confirm and window.confirm (only when ctx.confirm is set)
         *   #beginRequest    timeout, indicators, busy marks
         *   #sendRequest     ypy:before:request, final headers, fetch
         *   #receiveResponse ypy:before:response ... status codes; says whether to swap
         *   swap              the swap phases (see swap)
         *   #failRequest     catch: status, ypy:error
         *   #endRequest      finally: ypy:finally:request, indicators, busy marks, queue slot
         *
         * A phase that wants to stop the request returns false. An exception in any phase is
         * handled by #failRequest, and #endRequest always runs once the request was admitted.
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<void>}
         */
        async #issueRequest(ctx) {
            let elt = ctx.sourceElement  // the swap may replace ctx.sourceElement; request events keep this one
            let release = !this.#disposed && this.#admitRequest(ctx);
            if (!release) return

            try {
                if (ctx.confirm && !await this.#confirmRequest(ctx)) return;
                this.#beginRequest(ctx);
                if (!await this.#sendRequest(ctx)) return;
                if (await this.#receiveResponse(ctx)) {
                    await this.swap(ctx);
                    ctx.status = "swapped";
                }
            } catch (error) {
                this.#failRequest(ctx, error, elt);
            } finally {
                await this.#endRequest(ctx, release, elt);
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
        #admitRequest(ctx) {
            let elt = ctx.sourceElement
            let syncStrategy = this.#determineSyncStrategy(elt);
            let requestQueue = this.#getRequestQueue(elt, ctx);
            let ypyProp = this.#ypyProp(elt);
            ypyProp.queue = requestQueue;
            if (!ypyProp.abortInitialized) {
                ypyProp.abortInitialized = true;
                let handler = () => ypyProp.queue?.abort();
                elt.addEventListener("ypy:abort", handler);
                ypyProp.listeners.push({fromElt: elt, eventName: "ypy:abort", handler});
            }

            let abortRequest = reason => ctx.request.abort(reason)

            if (requestQueue.admit(
                syncStrategy,
                () => this.#issueRequest(ctx), // run when ready
                abortRequest,                 // abort if replaced
                ctx
            ) !== "run") return null

            // Every abort of this request, the timeout and a direct ctx.request.abort() included,
            // is reported once. Only the timeout reaches fetch with a reason: any other reason
            // would make fetch reject without an AbortError, and an abort has to stay silent.
            let abort = ctx.request.abort
            ctx.request.abort = (reason = "user") => {
                if (ctx.status === "issuing" && !ctx.request.signal.aborted) {
                    this.#triggerNative(elt, "ypy:request:aborted", {ctx, reason})
                }
                abort(reason === "timeout" ? reason : undefined)
            }
            ctx.status = "issuing"
            ctx.indicators ??= [];
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
        #confirmRequest(ctx) {
            let elt = ctx.sourceElement
            return new Promise(resolve => {
                let detail = {ctx, issueRequest: () => resolve(true), dropRequest: () => resolve(false)};
                if (this.#trigger(elt, "ypy:confirm", detail)) {
                    let js = this.#extractJavascriptContent(ctx.confirm);
                    resolve(js ? this.#executeJavaScript(elt, {ctx}, js, true) : window.confirm(ctx.confirm));
                }
            });
        }

        /**
         * Phase 3: everything that must be undone when the request ends. Starts the timeout,
         * shows the indicators and marks the
         * request as busy (see #markBusy). Runs after the confirmation, so a denied request
         * leaves no trace.
         *
         * @param {YpyRequestCtx} ctx
         */
        #beginRequest(ctx) {
            let timeout = ctx.request.timeout != null
                ? this.parseInterval(ctx.request.timeout)
                : this.config.defaultTimeout;
            if (timeout) {
                ctx.requestTimeout = setTimeout(() => ctx.request?.abort?.('timeout'), timeout);
            }
            this.#showIndicators(ctx);
            this.#markBusy(ctx);
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
        async #sendRequest(ctx) {
            let elt = ctx.sourceElement
            ctx.fetch ||= window.fetch.bind(window)
            // Set YPY-Request-Type based on final target/select (after all modifications)
            ctx.request.headers["YPY-Request-Type"] = (ctx.target === document.body || ctx.select) ? "full" : "partial";
            if (!this.#trigger(elt, "ypy:before:request", {ctx})) return false;

            try {
                ctx.timing.sent = performance.now();
                let response = await ctx.fetch(ctx.request.action, ctx.request);
                ctx.timing.response = performance.now();
                ctx.response = {
                    raw: response,
                    status: response.status,
                    headers: response.headers,
                }
                // a response proves the connection, whatever navigator.onLine said
                if (this.#offline) this.#setOffline(false);
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
        async #receiveResponse(ctx) {
            let elt = ctx.sourceElement
            this.#extractYpyHeaders(ctx);
            if (!this.#trigger(elt, "ypy:before:response", {ctx})) return false;
            ctx.text = await ctx.response.raw.text();
            ctx.redirected = !!ctx.response.raw.redirected;
            if (!this.#trigger(elt, "ypy:after:request", {ctx})) return false;

            if (ctx.response.status >= 400) {
                this.#errorDefaults(ctx);
                this.#trigger(elt, "ypy:response:error", {ctx})
            }

            if(this.#handleHeadersAndMaybeReturnEarly(ctx)){
                ctx.keepIndicators = true;
                return false
            }

            if (ctx.status === "issuing" && !ctx.superseded) {   // a superseded response (ypy-sync="latest") is discarded
                if (ctx.ypy.retarget) ctx.target = ctx.ypy.retarget;   // YPY-Retarget
                if (ctx.ypy.reswap) ctx.swap = ctx.ypy.reswap;       // YPY-Reswap
                if (ctx.ypy.reselect) ctx.select = ctx.ypy.reselect; // YPY-Reselect
                if (ctx.target?.isConnected === false) return false; // prevent swap and side effects if target just got removed
                ctx.status = "response received";
                this.#handleStatusCodes(ctx);
                return true
            }
            return false
        }

        /**
         * Phase 6a, the catch of the request: records the error in ctx.status and fires
         * ypy:error. An abort is silent unless it came from the timeout, which also sets
         * ctx.errorKind to "timeout" (a failed fetch was classified by #sendRequest).
         *
         * @param {YpyRequestCtx} ctx
         * @param {any} error whatever a phase threw, usually an Error or an AbortError
         * @param {Element} elt the element the request started from; ctx.sourceElement may have
         *     been replaced by the swap, and request events keep firing on the original element
         */
        #failRequest(ctx, error, elt) {
            ctx.status = "error: " + error;
            let timedOut = ctx.request.signal.reason === 'timeout';
            if (timedOut) ctx.errorKind = 'timeout';
            if (error?.name !== 'AbortError' || timedOut) this.#trigger(elt, "ypy:error", {ctx, error})
        }

        /**
         * Phase 6b, the finally of the request: waits for an extension that took over the
         * response, clears the timeout, runs the YPY-Trigger header, fires ypy:finally:request,
         * hides the indicators (unless they were handed to a follow-up request, ctx.keepIndicators),
         * removes the busy marks, announces the outcome (see #announce) and gives the queue slot
         * back so the next request can run.
         *
         * @param {YpyRequestCtx} ctx
         * @param {() => void} release the function #admitRequest returned
         * @param {Element} elt the element the request started from (see #failRequest)
         * @returns {Promise<void>}
         */
        async #endRequest(ctx, release, elt) {
            // An extension that took over the response reports when it has
            // finished delivering. Undefined for a normal request.
            await ctx.extensionPromise?.catch(() => {});
            ctx.timing.settled = performance.now();
            clearTimeout(ctx.requestTimeout);
            if (ctx.ypy?.trigger) { // YPY-Trigger
                this.#handleTriggerHeader(ctx.ypy.trigger, ctx.sourceElement);
            }
            this.#trigger(elt, "ypy:finally:request", {ctx})
            if (!ctx.keepIndicators) {
                this.#hideIndicators(ctx.indicators);
            }
            this.#unmarkBusy(ctx);
            this.#announce(ctx);

            release()
        }

        // Extract YPY-* response headers into ctx.ypy
        // Maps: YPY-Trigger -> ctx.ypy.trigger, YPY-Push-Url -> ctx.ypy.pushurl, etc.
        #extractYpyHeaders(ctx) {
            ctx.ypy = {}
            for (let [k, v] of ctx.response.raw.headers) {
                if (k.toLowerCase().startsWith('ypy-')) {
                    ctx.ypy[k.slice(4).toLowerCase().replace(/-/g, '')] = v
                }
            }
        }

        // Handle response headers that abort normal swap processing.
        // Returns true if the response was fully handled by a header.
        #handleHeadersAndMaybeReturnEarly(ctx) {
            if (ctx.ypy.refresh === 'true') { // YPY-Refresh
                this._loc.reload();
                return true
            }
            if (ctx.ypy.redirect) { // YPY-Redirect
                // only http(s) (an unparsable value throws: ypy:error) and the page's origin, unless mode is "cors"
                let url = new URL(ctx.ypy.redirect, document.baseURI);
                if (url.origin !== 'null' && (url.origin === location.origin || this.config.mode === 'cors')) this._loc.href = url.href;
                else this.#triggerNative(ctx.sourceElement, 'ypy:security:blocked', {reason: 'redirect'});
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

        #determineSyncStrategy(elt) {
            let strategy = (this.#attributeValue(elt, "ypy-sync") || "").split(":").pop().trim();
            return SYNC_STRATEGY.test(strategy) ? strategy : "queue first";
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
        #getRequestQueue(elt, ctx) {
            let ypySync = this.#attributeValue(elt, "ypy-sync")
            let syncElt = elt
            if (ypySync) {
                let colon = ypySync.lastIndexOf(":");
                let selector = colon < 0 ? (SYNC_STRATEGY.test(ypySync) ? null : ypySync) : ypySync.slice(0, colon).trim();
                if (selector === "target") {
                    syncElt = ctx?.target?.matches ? ctx.target : elt
                } else if (selector) {
                    syncElt = this.#findOrWarn(elt, selector, "ypy-sync") || elt;
                }
            }
            let queue = this.#requestQueues.get(syncElt)
            if (!queue) this.#requestQueues.set(syncElt, queue = new RequestQueue(this.#queueEvent))
            return queue
        }

        //============================================================================================
        // SECTION events: trigger specifications and event listeners
        //============================================================================================

        #isModifierKeyClick(evt) {
            return evt.type === 'click' && (evt.ctrlKey || evt.metaKey || evt.shiftKey)
                && !!evt.currentTarget?.closest?.('a[href]')
        }

        #shouldCancel(evt) {
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
            if (!link || !link.href || this.#isModifierKeyClick(evt)) return false

            let href = link.getAttribute('href')
            let isFragmentOnly = href && href.startsWith('#') && href.length > 1
            return !isFragmentOnly
        }

        #initializeTriggers(elt, initialHandler = elt._ypy.eventHandler) {
            let ypyTrigger = this.#attributeValue(elt, "ypy-trigger");
            let trigger = ypyTrigger || (elt.matches("form") ? "submit" :
                elt.matches("input:not([type=button]):not([type=submit]),select,textarea") ? "change" :
                    "click");
            this.#onTrigger(elt, trigger, initialHandler)
        }

        // Wire up event listeners with full modifier support (once, prevent, stop,
        // delay, throttle, changed, capture, passive, from, filter, etc.)
        #onTrigger(elt, specString, handler) {
            let specs = this.#parseTriggerSpecs(specString)
            this.#ypyProp(elt).triggerSpecs.push(...specs)

            for (let spec of specs) {
                spec.listeners = []

                let [eventName, filter] = this.#extractFilter(spec.name);
                let filterNames = filter && this.#identifiers(filter);   // only these event properties can be read

                // Resolve from: elements (self listens on elt but filters by event.target in guard)
                let fromElts = [elt];
                if (spec.from === 'outside') fromElts = [document];
                else if (spec.from && spec.from !== 'self') fromElts = this.#findAllExt(elt, spec.from);

                // Inner: runs after delay/throttle resolves
                let inner = (evt) => {
                    if (spec.halt || spec.prevent) evt.preventDefault();
                    if (spec.halt || spec.stop || spec.consume) evt.stopPropagation();
                    if (spec.changed) {
                        let values = this.#ypyState(elt).changedValues ??= new WeakMap();
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
                    if (this.#shouldCancel(evt)) evt.preventDefault();
                    if (spec.from === 'self' && evt.target !== elt) return;
                    if (spec.from === 'outside' && elt.contains(evt.target)) return;
                    if (spec.target && !evt.target?.matches?.(spec.target)) return;
                    if (filter) {
                        let evtArgs = {}; for (let k in evt) if ((!filterNames || filterNames.has(k)) && /^[a-z]+$/i.test(k)) evtArgs[k] = evt[k];
                        if (!this.#executeJavaScript(elt, evtArgs, filter, true, false)) return;
                    }
                    // a new trigger replaces any pending delayed or throttled trigger on this element
                    if (eventName !== 'every') {
                        for (let other of this.#ypyProp(elt).triggerSpecs) {
                            clearTimeout(other.timeout);
                            other.throttledEvent = null;
                        }
                    }
                    timed(evt);
                };

                // Intersect/revealed: set up observer
                if (eventName === 'intersect' || eventName === 'revealed') {
                    let observerOptions = {rootMargin: spec.rootMargin};
                    if (spec.root) observerOptions.root = this.#findOrWarn(elt, spec.root);
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
                    spec.interval = setInterval(() => elt.isConnected ? this.#trigger(elt, 'every', {}, false) : clearInterval(spec.interval),
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

        #extractFilter(str) {
            // the first `[...]`, with brackets nested up to four deep and quoted text skipped: [index of the `[`, index after its `]` (0 when unclosed)]
            let open = str.indexOf('['), m = str.slice(open).match(/^\[(?:[^\[\]'"]|'[^']*'|"[^"]*"|\[(?:[^\[\]'"]|'[^']*'|"[^"]*"|\[(?:[^\[\]'"]|'[^']*'|"[^"]*"|\[[^\[\]]*\])*\])*\])*\]/);
            let end = m ? open + m[0].length : 0;
            return end ? [str.slice(0, open), str.slice(open + 1, end - 1), str.slice(end)] : [str, null];
        }

        #handleTriggerHeader(value, elt) {
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
        #apiMethods(thisArg, used) {
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
        #identifiers(code) {
            return /\beval\b|\\/.test(code) ? null : new Set(code.match(/[\p{ID_Continue}$]+/gu));
        }

        /**
         * What config.callbacks means now: "none" (author code never compiles), "nonce" (it runs
         * only through the nonce extension, which checks the element) or "all". Unset, it is
         * "none". Any other value counts as "none".
         *
         * @returns {"none" | "nonce" | "all"}
         */
        #callbacksPolicy() {
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
        #executeJavaScript(thisArg, obj, code, expression = true, isAsync = true, compile = false) {
            let policy = this.#callbacksPolicy();
            if (policy === 'none' || (policy === 'nonce' && !this.#gated)) {
                if (!this.#blockedWarned) {
                    this.#blockedWarned = true;
                    console.warn(`ypy: author code is off (config.callbacks is "${policy}")`);
                }
                this.#triggerNative(thisArg, 'ypy:security:blocked', {reason: 'callbacks-' + policy, code});
                return compile ? () => {} : isAsync ? Promise.resolve() : undefined;
            }
            let scope = {};
            let detail = { scope, code };
            this.#triggerExtensions(thisArg, "ypy:scope", detail);
            code = detail.code;
            // only the API methods the code mentions become parameters, so the function is not built over
            // the whole API for every call; the key holds the parameters and the source, so equal keys compile equally
            let args = Object.assign(this.#apiMethods(thisArg, this.#identifiers(code)), scope, obj);
            let keys = Object.keys(args);
            let values = Object.values(args);
            // Compiling is the expensive part: keep the function per parameter list and source.
            let key = `${+isAsync}${+expression}${keys}|${code}`;
            let func = this.#fnCache.get(key);
            if (!func) {
                // a nonce gate (ypy-csp) compiles the code itself and checks the element each time it runs
                func = (!this.#gated && this.#evaluator?.(keys, code, expression, isAsync)) ||
                    new (isAsync ? this.#AsyncFunction : this.#Function)(...keys, expression ? `return (${code})` : code);
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
            if (this.#disposed || !root?.isConnected) return;
            if (!(root instanceof Element)) { // ShadowRoot
                for (let elt of root.children || []) this.process(elt, force);
                return;
            }
            if (force) this.#cleanup(root, true);
            if (this.#ignore(root)) return;
            if (!this.#trigger(root, "ypy:before:process")) return
            let ypyOnNodes = [root];
            let iter = this.#ypyOnQuery.evaluate(root)
            let node = null
            while (node = iter.iterateNext()) ypyOnNodes.push(node)
            for (let ypyOnNode of ypyOnNodes) {
                if (!this.#ignore(ypyOnNode) && this.#trigger(ypyOnNode, "ypy:before:on:init", {}, true)) {
                    this.#handleYpyOnAttributes(ypyOnNode);
                }
            }
            for (let elt of this.#queryEltAndDescendants(root, this.#actionSelector)) {
                this.#initializeElement(elt);
            }
            for (let elt of this.#queryEltAndDescendants(root, this.#boostSelector)) {
                this.#maybeBoost(elt);
            }
            this.#trigger(root, "ypy:after:process");
        }

        #maybeBoost(elt) {
            let ypyBoost = this.#attributeValue(elt, "ypy-boost");
            if (ypyBoost && ypyBoost !== "false" && this.#shouldBoost(elt)) this.#initializeElement(elt, ypyBoost);
        }

        #shouldBoost(elt) {
            if (this.#shouldInitialize(elt)) {
                if (elt.tagName === "A") {
                    if (elt.target === '' || elt.target === '_self') {
                        return !elt.hasAttribute('download') && !elt.getAttribute('href')?.startsWith?.("#") && this.#isSameOrigin(elt.href)
                    }
                } else if (elt.tagName === "FORM") {
                    return elt.method !== 'dialog' &&  this.#isSameOrigin(elt.action);
                }
            }
        }

        #isSameOrigin(url) {
            try {
                // URL constructor handles both relative and absolute URLs; a failure is "not same-origin"
                return new URL(url, location.href).origin === location.origin;
            } catch {
                return false;
            }
        }

        #shouldInitialize(elt) {
            return !elt._ypy?.initialized && !this.#ignore(elt);
        }

        /**
         * Remove listeners, timers, and observers from elt and all its powered descendants.
         * When force is true, also delete their YPY state so a re-process fully re-initializes them.
         * @param {Element} elt
         * @param {boolean} [force]
         */
        #cleanup(elt, force) {
            let elts = [elt, ...elt.querySelectorAll?.('[data-ypy-powered]') ?? []];
            for (let e of elts) {
                // a restarted or removed node does not hand its queue to what it holds next
                let queue = this.#requestQueues.get(e)
                if (queue) {
                    queue.clear("cleanup")
                    this.#requestQueues.delete(e)
                }
                if (!e._ypy) continue;
                this.#trigger(e, "ypy:before:cleanup")
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
                this.#trigger(e, "ypy:after:cleanup")
                if (force) delete e._ypy;
            }
        }

        #handlePreservedElements(fragment) {
            let pantry = document.createElement('div');
            pantry.hidden = true;
            document.body.insertAdjacentElement('afterend', pantry);
            let newPreservedElts = fragment.querySelectorAll?.(this.#prefixSelector('[ypy-preserve]')) || [];
            for (let preservedElt of newPreservedElts) {
                let currentElt = document.getElementById(preservedElt.id);
                // attrs, children, false and the modes of ypy-preserve.js act in a morph (#morphNode) or
                // after the swap, not on the identity of the node
                if (currentElt && !/^(attrs|children|false|value|selection|focus|scroll)\b/.test(this.#attr(preservedElt, 'ypy-preserve'))) {
                    this.#moveBefore(pantry, currentElt, null);
                }
            }
            return pantry
        }

        #restorePreservedElements(pantry) {
            for (let preservedElt of [...pantry.children]) {
                let newElt = document.getElementById(preservedElt.id);
                if (newElt) {
                    this.#moveBefore(newElt.parentNode, preservedElt, newElt);
                    this.#cleanup(newElt)
                    newElt.remove()
                }
            }
            pantry.remove();
        }

        //============================================================================================
        // SECTION swap: parsing a response and building swap tasks (parsing is owned by security)
        //============================================================================================

        #parseHTML(resp) {
            // fail closed: a CSP that forbids the 'ypy' policy means no response is parsed
            if (!this.#ttPolicy) throw new Error("ypy: Trusted Types policy 'ypy' is blocked by the CSP");
            let trusted = this.#ttPolicy.createHTML(resp);
            // {} works around Chrome 150-156 dropping comments :/
            return Document.parseHTMLUnsafe?.(trusted, {}) || new DOMParser().parseFromString(trusted, 'text/html');
        }

        #makeFragment(text) {
            // Convert <ypy-*> tags (e.g. <ypy-partial>) to <template ypy type="*">,
            // opening and closing tags in one pass; a name with a second hyphen is left alone
            let response = text.replace(/<(\/?)ypy-([a-z]+)(?=[\s>])/gi, (_, close, type) => close ? '</template' : `<template ypy type="${type.toLowerCase()}"`);
            let title = '';
            // the first <head>...</head>, found with two linear searches (a lazy regex restarts at every opener)
            let at = response.search(/<head[\s>]/i), len = response.slice(at).search(/<\/head>/i) + 7;
            if (at >= 0 && len > 6) {
                title = this.#parseHTML(response.slice(at, at + len)).title;
                response = response.slice(0, at) + response.slice(at + len);
            }
            let startTag = response.match(/<([a-z][^\/>\x20\t\r\n\f]*)/i)?.[1]?.toLowerCase();

            let doc, fragment;
            if (startTag === 'html' || startTag === 'body') {
                doc = this.#parseHTML(response);
                fragment = document.createDocumentFragment();
                fragment.append(doc.body);
            } else {
                doc = this.#parseHTML(`<template>${response}</template>`);
                fragment = doc.querySelector('template').content;
            }

            if (!title) {
                let titleElt = fragment.querySelector('title:not(svg title)');
                if (titleElt) {
                    title = titleElt.textContent;
                    titleElt.remove();
                }
            }

            this.#processScripts(fragment);

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
        #createOOBTask(tasks, elt, oobValue, sourceElement, ctx) {
            let targetSelector = elt.id ? '#' + CSS.escape(elt.id) : null;
            // if oobValue is in "swapStyle:selector" form (no space before colon), split it; otherwise treat as HCON
            let [, style, sel] = oobValue.match(/^(\S+):(.+)/) ?? [];
            if (style) [oobValue, targetSelector] = [style, sel || targetSelector];
            if (oobValue === 'true' || !oobValue) oobValue = this.#defaultOOBSwap();

            let swapSpec = this.#parseSwapSpec(oobValue);
            targetSelector = swapSpec.target || targetSelector;
            swapSpec.strip ??= !swapSpec.style.startsWith('outer');
            if (!targetSelector) return this.#reportMissingTarget(ctx, '', 'oob');
            let targets = this.#findAllExt(sourceElement, targetSelector);
            if (!targets.length) this.#reportMissingTarget(ctx, targetSelector, 'oob');
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
        #processOOB(fragment, sourceElement, selectOOB, ctx) {
            let tasks = [];

            // Process ypy-select-oob first (select elements from response)
            if (selectOOB) {
                for (let spec of selectOOB.split(',')) {
                    let [selector, oobValue = 'true'] = spec.split(/:(.*)/);
                    for (let elt of fragment.querySelectorAll(selector)) {
                        this.#createOOBTask(tasks, elt, oobValue, sourceElement, ctx);
                    }
                }
            }

            // Process elements with ypy-swap-oob attribute
            for (let oobElt of fragment.querySelectorAll(this.#prefixSelector('[ypy-swap-oob]'))) {
                if (!this.#triggerExtensions(oobElt, 'ypy:before:oob')) continue;   // an extension vetoes: it stays ordinary content
                let oobAttr = this.#attrName(oobElt, 'ypy-swap-oob');
                let oobValue = oobElt.getAttribute(oobAttr);
                oobElt.removeAttribute(oobAttr);
                this.#createOOBTask(tasks, oobElt, oobValue, sourceElement, ctx);
            }
            return tasks;
        }

        // moves the whole fragment in one DOM call: no spread of childNodes, so no argument limit
        #insertNodes(parent, before, fragment) {
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
        #parseSwapSpec(swapStr) {
            swapStr = swapStr.trim();
            if (!swapStr || /^\S*:/.test(swapStr)) swapStr = this.config.defaultSwap + ' ' + swapStr;
            let m = swapStr.match(/^(\S+)\s*(.*)$/);
            let style = m[1];
            swapStr = m[2];
            let spec = {style: this.#normalizeSwapStyle(style), ...HCON.parse(swapStr)};
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
        #defaultOOBSwap() {
            return 'outerMorph default:true';
        }

        /**
         * Collects the tasks of the partials of a response: `<ypy-partial>`
         * (it reaches this method as `<template ypy type="partial">`, see #makeFragment), in
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
        #processPartials(fragment, ctx) {
            let tasks = [];

            for (let templateElt of fragment.querySelectorAll('template[ypy]')) {
                let type = templateElt.getAttribute('type');
                if (!this.#triggerExtensions(templateElt, 'ypy:before:oob')) {
                    // vetoed (see ypy-csp): dropped with the removal below
                } else if (type === 'partial') {
                    let targetSelector = this.#attr(templateElt, 'ypy-target') || (templateElt.id ? '#' + CSS.escape(templateElt.id) : null);
                    if (targetSelector) {
                        this.#processScripts(templateElt.content);
                        let swapSpec = this.#parseSwapSpec(this.#attr(templateElt, 'ypy-swap') || this.config.defaultSwap);
                        if (swapSpec.ignoreTitle) ctx.title = null;
                        let targets = this.#findAllExt(ctx.sourceElement, targetSelector);
                        let silent = !targets.length && !this.#reportMissingTarget(ctx, targetSelector, 'partial');
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
                        this.#reportMissingTarget(ctx, '', 'partial');
                    }
                } else {
                    this.#triggerExtensions(templateElt, 'ypy:process:' + type, { ctx, tasks });
                }
                templateElt.remove();
            }

            return tasks;
        }

        /**
         * Reports an out-of-band element or partial that has no element to swap into. It
         * also lists the miss in ctx.missingTargets, so #buildSwapTasks knows the response did have
         * partials or out-of-band content and does not swap an empty main content over the target.
         *
         * @param {YpyRequestCtx | undefined} ctx the request; nothing is reported without one. The
         *     event fires on ctx.sourceElement
         * @param {string} selector what was looked up; empty when the element names no target at all
         * @param {'oob' | 'partial'} type
         * @returns {boolean} true when the event fired
         */
        #reportMissingTarget(ctx, selector, type) {
            if (!ctx) return false;
            (ctx.missingTargets ??= []).push({type, selector});
            this.#triggerNative(ctx.sourceElement, 'ypy:target:missing', {ctx, selector, type});
            return true;
        }

        //============================================================================================
        // SECTION a11y: focus and scroll helpers
        //============================================================================================

        #setFocus(elt, options, start, end) {
            try {
                if (start != null && elt.setSelectionRange) {
                    elt.setSelectionRange(start, end);
                }
                elt.focus(options);
            } catch (e) {
                // setSelectionRange or Web component focus may fail so ignore
            }
        }

        #handleAutoFocus(elt) {
            // swapped content focuses its [autofocus] only when it asks (any ypy-focus but "none") or config.autofocus does:
            // a component of its own manages the focus of its parts
            let autofocus = this.#queryEltAndDescendants(elt, '[autofocus]').find(e => this.config.autofocus || (this.#attr(e, 'ypy-focus') ?? 'none') != 'none');
            if (autofocus) {
                this.#setFocus(autofocus);
            }
        }

        // window and document have no scrollTop or scrollIntoView, so use the document's scrolling element
        #normalizeScrollTarget(target) {
            return target === window || target === document ? document.scrollingElement : target;
        }

        #handleScroll(swapSpec, target) {
            if (swapSpec.scroll) {
                let scrollTarget = swapSpec.scrollTarget ? this.#normalizeScrollTarget(this.find(target, swapSpec.scrollTarget)) : target;
                if (scrollTarget) {
                    if (swapSpec.scroll === 'top') {
                        scrollTarget.scrollTop = 0;
                    } else if (swapSpec.scroll === 'bottom'){
                        scrollTarget.scrollTop = scrollTarget.scrollHeight;
                    }
                }
            }
            if (swapSpec.show === 'top' || swapSpec.show === 'bottom') {
                let showTarget = swapSpec.showTarget ? this.#normalizeScrollTarget(this.find(target, swapSpec.showTarget)) : target;
                showTarget?.scrollIntoView?.(swapSpec.show === 'top')
            }
        }

        /**
         * Applies a scroll policy. Called by #finishSwap with ctx.scroll (the swap is done and
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
        #applyScrollPolicy(ctx, policy, box) {
            let p = policy + '', n = p === 'top' ? 0 : parseFloat(p), pos = ctx.scrollPosition,
                // "k"eep and "r"estore never animate
                go = (elt, to) => to && elt?.scrollTo?.({...to, behavior: /^[kr]/.test(p) || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'auto'}),
                [win, sub] = p === 'keep' ? ctx.scrollKept || [] : p === 'restore' ? [pos && {left: pos[0], top: pos[1]}] : [n >= 0 && {top: n}, p === 'top' && {top: 0}];
            go(window, win);
            go(box, sub);
        }

        /**
         * Moves the focus to the new content, once per swap, after the focus of the swap itself was
         * given back (#restoreFocus) and before the scroll policy. Called by #finishSwap, which
         * is also the place for an error target to ask for it: set ctx.focus (a selector, or false)
         * before the swap ends. The place comes from ctx.focus, else from `ypy-focus` on the source
         * element (inheritable with `:inherited`), else "auto":
         *  - "auto": after a boosted request, the first `h1` of `[ypy-main]` (else of `<main>`, else of
         *    the swap target), or that element itself; nothing for any other request, and nothing
         *    when an `[autofocus]` element has the focus. It sets ctx.focused, which keeps
         *    #announce from saying the title a second time;
         *  - "none" (or false): leaves the focus alone;
         *  - "first-heading": the first heading of the swap target;
         *  - "first-invalid": the first `[aria-invalid="true"]` or invalid field of the swap target
         *    (what a 422 asks for, see #errorDefaults);
         *  - anything else is a selector (extended syntax, relative to the source element).
         * An element that cannot take the focus gets `tabindex="-1"`, removed again when it loses it.
         * The focus never scrolls the page: scrolling is the job of the scroll policy.
         *
         * @param {YpyRequestCtx} ctx
         * @param {Element | string | undefined} [box] the swap target, after the swap
         */
        #applyFocus(ctx, box) {
            let src = ctx.sourceElement, elt,
                s = ctx.focus ?? (src && this.#attributeValue(src, 'ypy-focus')) ?? 'auto';
            if (s === 'auto') {
                let main = (this.#isBoosted(src) || ctx.request?.headers?.['YPY-Boosted']) && !document.activeElement.autofocus &&
                    (document.querySelector(this.#prefixSelector('[ypy-main]')) || document.querySelector('main') || box?.focus && box);
                if (main) elt = main.querySelector('h1') || main;
            } else if (s === 'first-heading' || s === 'first-invalid') {
                elt = box?.querySelector?.(s[6] === 'h' ? 'h1,h2,h3,h4,h5,h6' : '[aria-invalid="true"],:is(input,select,textarea):invalid');
            } else if (s && s !== 'none') {
                elt = this.find(src, s);
            }
            if (elt && elt !== document.activeElement) {
                // a screen reader reads a heading or a main that gets the focus: the live region need not say the title too
                if (s === 'auto' && elt !== box) ctx.focused = elt;
                if (elt.tabIndex < 0 && !elt.hasAttribute('tabindex')) {
                    elt.tabIndex = -1;
                    elt.addEventListener('blur', () => elt.removeAttribute('tabindex'), {once: true});
                }
                this.#setFocus(elt, {preventScroll: true});
            }
        }

        //============================================================================================
        // SECTION security (cont.): re-creating script elements so they run
        //============================================================================================

        /**
         * Applies config.scripts to the <script> elements of a response: "auto" (the default)
         * re-creates all of them so they run, "nonce" re-creates only those that carry the nonce of
         * the page (config.inlineScriptNonce, else the one of the first <script nonce>), and "block",
         * or any other value, none. The others are taken out of the response: a script parsed inside
         * a <template> would run when it is inserted, so leaving it as parsed is not inert.
         */
        #processScripts(container) {
            let mode = this.config.scripts ?? 'auto', nonce = this.config.inlineScriptNonce || document.querySelector('script[nonce]')?.nonce;
            // without the 'ypy' policy no response is parsed
            if (!this.#ttPolicy) return;
            let scripts = this.#queryEltAndDescendants(container, 'script');
            for (let oldScript of scripts) {
                if (mode !== 'auto' && (mode !== 'nonce' || !nonce || oldScript.nonce !== nonce)) {
                    oldScript.remove();
                    continue;
                }
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
         * Start-up work lives in the #init* methods, so it has one owner each: #initHistory,
         * #initOffline and #initA11y.
         */
        initialize() {
            if (this.#disposed) return;
            this.#initHistory();
            this.#initOffline();
            this.#initA11y();
            this.process(document.body);
        }

        /**
         * Takes YPY apart, for a test or an application that unmounts: tells the extensions (the
         * `ypy_dispose` hook, so they remove what they installed), aborts the requests in flight,
         * drops the waiting ones, tears down every processed element of the document and of its
         * open shadow roots (listeners, timers, observers, queues), removes the document and
         * window listeners the core added (history, connection state, start-up) and leaves the
         * object inert: process, initialize and requests do nothing. It cannot be undone.
         */
        dispose() {
            if (this.#disposed) return;
            this.#triggerExtensions(document, 'ypy:dispose');
            this.#disposed = true;
            this.#historyAbort?.abort();
            let roots = [document.documentElement];
            for (let root of roots) {
                for (let elt of root.querySelectorAll('*')) if (elt.shadowRoot) roots.push(elt.shadowRoot);
            }
            for (let root of roots) {
                for (let elt of root.querySelectorAll('[data-ypy-powered]')) elt._ypy?.queue?.abort();
                this.#cleanup(root, true);
            }
            document.removeEventListener('DOMContentLoaded', this.#init);
            document.removeEventListener('ypy:before:swap', this.#beforeSwap);
            window.removeEventListener('popstate', this.#onPopState);
            window.removeEventListener('offline', this.#onNetworkChange);
            window.removeEventListener('online', this.#onNetworkChange);
            window.navigation?.removeEventListener('navigate', this.#onNavigate);
        }

        //============================================================================================
        // SECTION swap (cont.): the swap phases
        //============================================================================================

        /**
         * Swaps the response of a request (ctx.text) into the page. Only orders the phases:
         *
         *   #buildSwapTasks  parses ctx.text into tasks: out-of-band, partials, main
         *   ypy:before:swap   cancelable
         *   #runSwapTasks    inserts every task, in a view transition when asked
         *   #handleHistoryUpdate  URL, history entry (not when a task failed)
         *   #finishSwap      ypy:after:swap, document title, anchor, focus and scroll policy
         *
         * ypy:finally:swap always fires, also when a phase throws. Used by ypy.ajax() and by
         * extensions that deliver their own response; most code should call ypy.ajax().
         *
         * @param {YpyRequestCtx} ctx
         * @returns {Promise<void>}
         */
        async swap(ctx) {
            try {
                let [tasks, mainSwap] = this.#buildSwapTasks(ctx);
                ctx.tasks = tasks;

                if(!this.#trigger(ctx.sourceElement, "ypy:before:swap", {ctx, tasks}) ||
                    // `YPY-Group: atomic`: all or nothing. A task without a target (already reported by
                    // ypy:target:missing, also an out-of-band element or partial) stops every task and the history update. A task that throws
                    // while it inserts is not undone: the guarantee is about targets.
                    ctx.ypy?.group === 'atomic' && (ctx.missingTargets || tasks.some(task => !this.#resolveSwapTarget(task)))){
                    return
                }

                ctx.scrollFrom = [scrollX, scrollY];   // the page being left, before the swap moves it

                let errors = await this.#runSwapTasks(ctx, tasks, mainSwap);
                (ctx.timing ??= {}).swapped = performance.now();   // ctx of ypy.swap() calls has no timing yet
                // the URL changes only once the page did: not after a failed task or an abort during the swap
                if (!errors[0] && !ctx.request?.signal?.aborted) this.#handleHistoryUpdate(ctx);
                this.#finishSwap(ctx, mainSwap);
            } finally {
                this.#trigger(ctx.sourceElement, "ypy:finally:swap", {ctx});
            }
        }

        /**
         * Swap phase 1: parses ctx.text and builds the list of tasks to run. Sets ctx.title.
         *
         * Order of the list, which is also the order the tasks start (a task that does not
         * wait finishes its DOM work before the next one starts):
         *   1. the main swap, when there is one (skipped when the response had nothing left for it,
         *      see #processMainSwap); it is also the second value returned
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
        #buildSwapTasks(ctx) {
            let {fragment, title} = this.#makeFragment(ctx.text);
            ctx.title = title;
            delete ctx.missingTargets;

            // Process OOB and partials
            let oobTasks = this.#processOOB(fragment, ctx.sourceElement, ctx.selectOOB, ctx);
            let partialTasks = this.#processPartials(fragment, ctx);
            let tasks = [...oobTasks, ...partialTasks];

            // Determine if empty swap should be prevented
            // partials always prevent; oob prevents by default unless config.allowEmptySwapAfterOOB is true;
            // so does a partial or oob element whose target was missing
            let hasPartials = partialTasks.length || ctx.missingTargets || (oobTasks.length && !this.config.allowEmptySwapAfterOOB);

            // Process main swap
            let mainSwap = this.#processMainSwap(ctx, fragment, hasPartials);
            if (mainSwap) {
                tasks.unshift(mainSwap);
            }
            return [tasks, mainSwap];
        }

        /**
         * Swap phase 2: runs every task through #insertContent. Tasks that ask for a view
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
        async #runSwapTasks(ctx, tasks, mainSwap) {
            let errors = [];
            let insert = async (task, cssTransition) => {
                try { await this.#insertContent(task, cssTransition) } catch (error) { errors.push([task, error]) }
            };
            let swapPromises = [];
            let transitionTasks = [];
            for (let task of tasks) {
                task.ctx ??= ctx;   // #insertContent drops the task of a response that was superseded or aborted
                if (ctx.busy) this.#markBusy(ctx, task.target);   // only inside a request that marked its target: #endRequest clears them
                if (task.swapSpec?.transition ?? mainSwap?.transition ?? ctx.transition) {
                    transitionTasks.push(task);
                } else {
                    swapPromises.push(insert(task));
                }
            }

            // the transition tasks run one after the other, w/no CSS transitions, inside the view transition
            // queue of the ypy-transitions extension (handle_transition); without it they run at once
            if (transitionTasks.length) {
                let run = async () => { for (let task of transitionTasks) await insert(task, false) };
                swapPromises.push(this.#extMethods.get('handle_transition')?.[0]?.(run, ctx) ?? run());
            }

            await Promise.all(swapPromises);

            for (let [task, error] of errors) this.#triggerNative(ctx.sourceElement, 'ypy:swap:error', {ctx, task, error});
            if (errors[0]) this.#trigger(ctx.sourceElement, 'ypy:error', {ctx, error: errors[0][1]});
            return errors;
        }

        /**
         * Swap phase 3: after every task ran. Moves ctx.sourceElement to the main target when the
         * swap replaced the source element, fires ypy:after:swap, sets the document title
         * (unless the swap is "none"), scrolls to the URL anchor, moves the focus (#applyFocus) and
         * applies the scroll policy (#applyScrollPolicy).
         *
         * @param {YpyRequestCtx} ctx
         * @param {YpySwapTask} [mainSwap] the main task, when there is one
         */
        #finishSwap(ctx, mainSwap) {
            if (!ctx.sourceElement?.isConnected && mainSwap?.target?.isConnected) {
                ctx.sourceElement = mainSwap.target;
            }

            this.#trigger(ctx.sourceElement, "ypy:after:swap", {ctx});
            if (ctx.title && ctx.swap !== 'none') document.title = ctx.title;
            if (ctx.request?.anchor) document.getElementById(ctx.request.anchor)?.scrollIntoView();
            let box = mainSwap?.target ?? ctx.target;
            this.#applyFocus(ctx, box);
            this.#applyScrollPolicy(ctx, ctx.scroll, box);
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
        #processMainSwap(ctx, fragment, hasPartials) {
            // Create main task if needed
            let swapSpec = this.#parseSwapSpec(ctx.swap || this.config.defaultSwap);
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
                let target = this.#resolveTarget(source, selector, true);
                if (!target && typeof selector === 'string') {
                    [target, fragment] = this.#fallbackMain(ctx, swapSpec, fragment, selector, this.#fallbackMode(source));
                }
                if (ctx.select) {
                    let selected = fragment.querySelectorAll(ctx.select);
                    fragment = document.createDocumentFragment();
                    fragment.append(...selected);
                }
                if (this.#isBoosted(ctx.sourceElement)) {
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
         *   #resolveSwapTarget  finds the element to swap into
         *   (swap style, body strip, "swapping" class, swap delay, "delete" and "none" here)
         *   #captureFocus       remembers the focused element of an in-place swap
         *   #applySwapStyle     does the DOM work of the swap style
         *   #restoreFocus       puts the focus back
         *   #afterInsert        settle events and classes, process, autofocus, scroll modifiers
         *
         * Returns early, without events, when the target is missing or the style is "none";
         * a "delete" swap removes the target and stops before the focus and settle phases.
         *
         * @param {YpySwapTask} task
         * @param {boolean} [cssTransition] false inside a view transition: no swap/settle delays
         * @returns {Promise<void>}
         */
        async #insertContent(task, cssTransition = true) {
            let {swapSpec, fragment} = task;
            let target = this.#resolveSwapTarget(task);
            if (!target) return;
            if (typeof swapSpec === 'string') {
                swapSpec = this.#parseSwapSpec(swapSpec);
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

            this.#addClass(target, "swapping")
            if (cssTransition && task.swapSpec?.swap) {
                await this.timeout(task.swapSpec?.swap)
            }
            if (task.ctx?.hold) await task.ctx.hold;   // set by an extension that has to wait (ypy-preserve: IME composition)
            // the response must not be applied any more when its request was aborted (also during the
            // swap) or superseded (ypy-sync="latest"), or when a newer response already overwrote this
            // target (two queues on one target). Styles that only add content are never stale.
            let ctx = task.ctx, overwrites = ctx && swapStyle > 'c';  // false for afterbegin, afterend, beforebegin, beforeend
            if (ctx && (ctx.superseded || ctx.request?.signal?.aborted || overwrites && target._swapId > ctx.id)) {
                return this.#removeClass(target, "swapping");
            }

            if (swapStyle === 'delete') {
                if (target.parentNode) {
                    this.#cleanup(target);
                    target.parentNode.removeChild(target);
                }
                return;
            }

            // innerHTML/outerHTML swaps backup focus and handle CSS transitions
            let settleTasks = []
            let settleDelay = swapSpec.settle ?? this.config.defaultSettleDelay;
            let parentNode = target.parentNode;
            let focusInfo = this.#captureFocus(swapStyle, parentNode);
            if (swapStyle === 'innerHTML' || (swapStyle === 'outerHTML' && parentNode)) {
                settleTasks = cssTransition && settleDelay ? this.#startCSSTransitions(fragment, target) : []
            }

            let pantry = this.#handlePreservedElements(fragment);
            let newContent;
            [target, newContent] = this.#applySwapStyle(target, swapStyle, swapSpec, fragment, parentNode);
            task.target = target;
            if (overwrites) target._swapId = ctx.id;   // the newest response that overwrote this target
            this.#restorePreservedElements(pantry);
            this.#restoreFocus(focusInfo, swapSpec);

            await this.#afterInsert(task, target, swapSpec, newContent, settleTasks, settleDelay, cssTransition);
        }

        /**
         * Insert phase 1: the element a task swaps into. A string target is a selector looked up
         * in the document.
         *
         * @param {YpySwapTask} task
         * @returns {Element | null | undefined} falsy when there is nothing to swap into
         */
        #resolveSwapTarget(task) {
            let target = task.target;
            if (typeof target === 'string') {
                target = document.querySelector(target);
            }
            // an out-of-band element or partial without a target never falls back (ambiguous)
            if (!target && task.type !== 'main') {
                let source = task.sourceElement || document.body;
                this.#targetMissing(source, {selector: task.selector ?? task.target ?? '', ctx: task.ctx, task});
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
        #fallbackMode(elt) {
            return String(this.#attributeValue(elt, 'ypy-fallback') ?? this.config.targetFallback ?? true) || 'true';
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
         * @param {string} mode from #fallbackMode: "false" (never), "always", or any other value
         * @returns {[target: Element | undefined, fragment: DocumentFragment]}
         */
        #fallbackMain(ctx, swapSpec, fragment, selector, mode) {
            let source = ctx.sourceElement || document.body, used;
            let find = root => {
                used = '[ypy-main]';
                return root.querySelector(this.#prefixSelector('[ypy-main]')) || root.querySelector(used = 'main');
            };
            let incoming = find(fragment), current = find(document);
            let outer = swapSpec.style.startsWith('outer');
            if (current && mode !== 'false' && (mode === 'always' || incoming || fragment.querySelector('body') && !outer)) {
                ctx.fallback = used;
                this.#triggerNative(source, 'ypy:target:fallback', {selector, used, ctx});
                if (incoming && !ctx.select) {
                    fragment = document.createDocumentFragment();
                    fragment.append(...(outer ? [incoming] : incoming.childNodes));
                }
                return [current, fragment];
            }
            this.#targetMissing(source, {selector, ctx});
            return [undefined, fragment];
        }

        /**
         * Reports a target that nothing could serve: `ypy:target:missing` (cancelable; cancel it
         * to keep the console quiet), then a `console.warn` with the context.
         *
         * @param {Element} elt the element that gets the event
         * @param {{selector: string, ctx?: YpyRequestCtx, task?: YpySwapTask}} detail
         */
        #targetMissing(elt, detail) {
            if (this.#triggerNative(elt, 'ypy:target:missing', detail)) {
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
         * @returns {{elt: Element, start?: number, end?: number} | undefined} what #restoreFocus
         *     needs; undefined when the style keeps the focus alone or nothing with an id has it
         */
        #captureFocus(swapStyle, parentNode) {
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
        #applySwapStyle(target, swapStyle, swapSpec, fragment, parentNode) {
            let newContent = [...fragment.childNodes]
            try {
                if (swapStyle === 'innerHTML') {
                    for (const child of target.children) {
                        this.#cleanup(child)
                    }
                    target.replaceChildren(...fragment.childNodes);
                } else if (swapStyle === 'textContent') {
                    for (const child of target.querySelectorAll('[data-ypy-powered]')) {
                        this.#cleanup(child)
                    }
                    target.textContent = fragment.textContent;
                } else if (swapStyle === 'outerHTML') {
                    if (parentNode) {
                        this.#insertNodes(parentNode, target, fragment);
                        this.#cleanup(target)
                        parentNode.removeChild(target);
                        target = newContent.find(node => node.nodeType === 1) || parentNode
                    }
                } else if (swapStyle === 'outerSync') {
                    this.#copyAttributes(target, fragment.firstElementChild);
                    for (const child of target.children) {
                        this.#cleanup(child)
                    }
                    target.replaceChildren(...fragment.firstElementChild.childNodes);
                    newContent = [target];
                } else if (swapStyle === 'innerMorph') {
                    if (swapSpec.default && target === document.body) {
                        // The default style on the whole page is a page change, not a refresh: nothing
                        // the user typed on the old page may leak into the new one. Replace it.
                        let focusInfo = this.#captureFocus('innerHTML', parentNode);
                        for (const child of target.children) {
                            this.#cleanup(child)
                        }
                        target.replaceChildren(...fragment.childNodes);
                        this.#restoreFocus(focusInfo, swapSpec);
                    } else {
                        this.#morph(target, fragment, true);
                    }
                    newContent = [...target.childNodes];
                } else if (swapStyle === 'outerMorph') {
                    this.#morph(target, fragment, false);
                    newContent.push(target);
                } else if (swapStyle === 'beforebegin') {
                    if (parentNode) {
                        this.#insertNodes(parentNode, target, fragment);
                    }
                } else if (swapStyle === 'afterbegin') {
                    this.#insertNodes(target, target.firstChild, fragment);
                } else if (swapStyle === 'beforeend') {
                    this.#insertNodes(target, null, fragment);
                } else if (swapStyle === 'afterend') {
                    if (parentNode) {
                        this.#insertNodes(parentNode, target.nextSibling, fragment);
                    }
                } else {
                    let result;
                    for (const method of this.#extMethods.get('handle_swap') || []) {
                        if (result = method(swapStyle, target, fragment, swapSpec)) break;
                    }
                    if (!result) throw new Error(`Unknown swap style: ${swapStyle}`);
                    if (Array.isArray(result)) newContent = result;
                }
            } finally {
                this.#removeClass(target, "swapping")
            }
            return [target, newContent];
        }

        /**
         * Insert phase 4: gives the focus back to the element #captureFocus remembered, found
         * again by id, with its selection. Does nothing when it still has the focus. Does not
         * scroll unless swapSpec.focusScroll (or config.defaultFocusScroll) asks for it.
         *
         * @param {{elt: Element, start?: number, end?: number} | undefined} focusInfo
         * @param {YpySwapSpec} swapSpec
         */
        #restoreFocus(focusInfo, swapSpec) {
            if (focusInfo && !focusInfo.elt.matches(':focus')) {
                let newElt = document.getElementById(focusInfo.elt.id);
                if (newElt) {
                    let focusOptions = { preventScroll: swapSpec.focusScroll !== undefined ? !swapSpec.focusScroll : !this.config.defaultFocusScroll };
                    this.#setFocus(newElt, focusOptions, focusInfo.start, focusInfo.end);
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
         * @param {Function[]} settleTasks CSS transition restore tasks of #startCSSTransitions
         * @param {number} settleDelay milliseconds to wait before running them
         * @param {boolean} cssTransition false inside a view transition: no settle delay
         * @returns {Promise<void>}
         */
        async #afterInsert(task, target, swapSpec, newContent, settleTasks, settleDelay, cssTransition) {
            this.#trigger(target, "ypy:before:settle", {task, newContent, settleTasks})

            for (const elt of newContent) {
                this.#addClass(elt, "added")
            }

            if (cssTransition && settleTasks.length > 0) {
                this.#addClass(target, "settling")
                await this.timeout(settleDelay);
                // invoke settle tasks
                for (let settleTask of settleTasks) {
                    settleTask()
                }
                this.#removeClass(target, "settling")
            }

            this.#trigger(target, "ypy:after:settle", {task, newContent, settleTasks})

            for (const elt of newContent) {
                this.#removeClass(elt, "added")
                this.process(elt);
                this.#handleAutoFocus(elt);
            }

            this.#handleScroll(swapSpec, target);
        }

        //============================================================================================
        // SECTION events (cont.): firing events
        //============================================================================================

        #trigger(on, eventName, detail = {}, bubbles = true) {
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
            on = this.#normalizeElement(on)
            this.#triggerExtensions(on, eventName, detail);
            return this.trigger(on, this.#maybeAdjustMetaCharacter(eventName), detail, bubbles);
        }

        #triggerExtensions(elt, eventName, detail = {}) {
            // extension hooks are named ypy_<event>
            let methods = this.#extMethods.get(eventName.replace(/:/g, '_'));
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
            this.on(this.#maybeAdjustMetaCharacter("ypy:after:process"), (evt) => {
                if (!callback) return selector(evt.target);
                for (let elt of this.#queryEltAndDescendants(evt.target, selector)) {
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
                elt = this.#normalizeElement(eventOrElt);
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
            return this.#findAllExt(selectorOrElt, selector)[0]
        }

        /**
         * Every element matching the selector, in the document or under an element.
         *
         * @param {Element | string} selectorOrElt the selector, or the element to search under
         * @param {string} [selector]
         * @returns {Element[]}
         */
        findAll(selectorOrElt, selector) {
            return this.#findAllExt(selectorOrElt, selector)
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
            return this.#dispatch(this.#normalizeElement(on), eventName, detail, bubbles);
        }

        #dispatch(on, eventName, detail, bubbles) {
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
         * the request phases (see #issueRequest).
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

            let ctx = this.#createRequestContext(sourceElt, options.event || {});
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
                ctx.target = this.#resolveTarget(document.body, options.target);
                if (!ctx.target) return Promise.reject(new Error('Target not found'));
            }
            // A header set to null or undefined is removed from the request
            for (let h of [headers, options.headers]) {
                for (let name in h) h[name] == null ? delete req.headers[name] : req.headers[name] = h[name];
            }

            return this.#handleTriggerEvent(ctx);
        }

        //============================================================================================
        // SECTION history: history entries, restoration and the start-up listeners
        //============================================================================================

        /**
         * Registers the document-level history listeners (navigation traversal or popstate),
         * once. Owner: history (TASK-016).
         */
        #initHistory() {
            if (this.config.history && !this.#historyInitialized) {
                this.#historyInitialized = true;
                if (window.navigation && !/firefox/i.test(navigator.userAgent)) {
                    navigation.addEventListener('navigate', this.#onNavigate);
                /* c8 ignore next 3 */
                } else {
                    window.addEventListener('popstate', this.#onPopState);
                }
            }
        }

        #onNavigate = event => {
            if (event.navigationType === 'traverse' && event.canIntercept && !event.hashChange)
                event.intercept({handler: () => this.#restoreHistory()});
        }
        #onPopState = event => this.#restoreHistory(event.state)

        /**
         * Remembers the path of the current entry as one of ours: an entry whose state another
         * script replaced is still restored (see #restoreHistory).
         */
        #markHistoryPath() {
            this.#historyPaths.add(location.pathname + location.search);
        }

        /**
         * Writes the history. A browser may refuse (Safari allows 100 writes per 10 seconds and
         * throws a SecurityError past that): the page is already swapped, so a refused write is
         * dropped and the URL stays as it was.
         */
        #writeHistory(method, state, path) {
            try { history[method](state, '', path); return true } catch {}
        }

        #pushUrlIntoHistory(path, scroll = [scrollX, scrollY]) {
            if (!this.config.history) return;
            // remember where the page being left was scrolled to (read by #restoreHistory); other
            // keys of the entry's state are kept, and an entry that another router owns is left alone
            if (history.state?.ypy) this.#writeHistory('replaceState', {...history.state, scroll}, location.href);
            this.#writeHistory('pushState', {ypy: true}, path) && this.#trigger(document, "ypy:after:history:push", {path});
        }

        #replaceUrlInHistory(path) {
            if (!this.config.history) return;
            this.#writeHistory('replaceState', {ypy: true}, path) && this.#trigger(document, "ypy:after:history:replace", {path});
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
         *   - the scroll position saved by #pushUrlIntoHistory is restored through
         *     #applyScrollPolicy(ctx, "restore"), with the position in ctx.scrollPosition
         *
         * @param {{ypy?: boolean, scroll?: [number, number]}} [state] state of the entry; defaults
         *     to history.state
         * @param {string} [path] defaults to the current path and query
         * @returns {Promise<void> | undefined}
         */
        async #restoreHistory(state, path) {
            await this.timeout(1);
            state ??= history.state;
            path = path || location.pathname + location.search;
            // an entry whose state another script replaced is ours while its path is one we wrote
            if (!state?.ypy && !this.#historyPaths.has(path)) return;
            this.#historyAbort?.abort();
            let historyElt = document.querySelector(this.#prefixSelector('[ypy-history-elt]')) || document.body;
            if (this.#trigger(document, "ypy:before:history:restore", {path, cacheMiss: true})) {
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
                            this.#triggerNative(document, 'ypy:history:restore:fragment', {ctx});
                            e.preventDefault();
                            this._loc.reload();
                        }
                    };
                    if (fragment) document.addEventListener('ypy:before:swap', guard);
                    await this.ajax('GET', path, {
                        target: historyElt,
                        swap: 'outerSync',
                        select: historyElt !== document.body ? this.#prefixSelector('[ypy-history-elt]') : undefined,
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

        #resolveHistoryAction(ctx) {
            let {sourceElement, push, replace, ypy, response} = ctx;

            // allow response headers to override history action
            if (ypy?.pushurl || ypy?.replaceurl) { // YPY-Push-Url, YPY-Replace-Url
                push = ypy.pushurl;
                replace = ypy.replaceurl;
            }

            // a boosted element pushes by default, a GET or a redirect to the page it ends on; the
            // answer of a POST, PUT, PATCH or DELETE is not a page that can be loaded again
            if (push == null && replace == null && this.#isBoosted(sourceElement) && (ctx.request.method == 'GET' || ctx.redirected)) {
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

        #handleHistoryUpdate(ctx) {
            if (!this.config.history) return;
            // Stamp the current entry on the first YPY swap after a fresh page load (or after another
            // script replaced its state), so back traversals to this page are interceptable.
            if (!history.state?.ypy) {
                this.#writeHistory('replaceState', {...history.state, ypy: true}, location.href);
                this.#markHistoryPath();
            }
            let action = this.#resolveHistoryAction(ctx);
            if (!action) return;

            let historyDetail = {
                history: action,
                sourceElement: ctx.sourceElement,
                response: ctx.response
            };
            if (!this.#trigger(document, "ypy:before:history:update", historyDetail)) return;
            if (action.type === 'push') {
                this.#pushUrlIntoHistory(action.path, ctx.scrollFrom);
            } else {
                this.#replaceUrlInHistory(action.path);
            }
            this.#markHistoryPath();
            this.#trigger(document, "ypy:after:history:update", historyDetail);
        }

        //============================================================================================
        // SECTION events (cont.): ypy-on attributes
        //============================================================================================

        // ypy-on:<event> binds to <event> directly
        // ypy-on::<event> is shorthand for ypy-on:ypy:<event> (YPY events)
        #handleYpyOnAttributes(node) {
            if (node._ypy?.onInitialized) return;
            let ypyOnNames = this.#prefixes("ypy-on");
            let mc = this.config.metaCharacter || ':';
            let handler = (code) => async (evt) => {
                try {
                    await this.#executeJavaScript(node, { event: evt },
                        `with(event?.detail||{}){${code}}`, false);
                } catch (e) {
                    if (typeof e !== 'symbol') this.#trigger(node, 'ypy:error', { error: e });
                }
            };
            for (let attr of node.getAttributeNames()) {
                let prefix = ypyOnNames.find(p => attr.startsWith(p));
                if (!prefix) continue;
                this.#ypyProp(node).onInitialized = true;
                let rest = attr.substring(prefix.length);
                let value = node.getAttribute(attr);
                // ypy-on="click once -> doA(); blur -> doB()"
                if (!rest) {
                    for (let part of value.split(/;(?=[^;]*->)/)) {
                        let idx = part.indexOf('->');
                        if (idx !== -1) this.#onTrigger(node, part.substring(0, idx).trim(), handler(part.substring(idx + 2).trim()));
                    }
                    continue;
                }
                // ypy-on:click="code" or ypy-on::before:request="code"
                if (rest[0] !== mc) continue;
                let eventName = rest.substring(1);
                if (eventName.startsWith(mc)) eventName = 'ypy' + mc + eventName.substring(1);
                this.#onTrigger(node, eventName, handler(value));
            }
        }

        //============================================================================================
        // SECTION request (cont.): indicators, form values
        //============================================================================================

        #showIndicators(ctx) {
            let elt = ctx.sourceElement;
            let ypyIndicator = this.#attributeValue(elt, "ypy-indicator");
            let indicatorElements;
            if (!ypyIndicator) {
                if (elt === document.body) return;
                indicatorElements = [elt];
            } else {
                indicatorElements = this.#findAllExt(elt, ypyIndicator, "ypy-indicator");
            }
            for (const indicator of indicatorElements) {
                ctx.indicators.push(indicator);
                let s = this.#ypyState(indicator);
                s.rc = (s.rc || 0) + 1;
                this.#setState(indicator, 'request', true);
            }
        }

        #hideIndicators(indicatorElements) {
            for (let indicator of indicatorElements) {
                let s = this.#ypyState(indicator);
                if (s.rc && --s.rc <= 0) {
                    this.#setState(indicator, 'request', false);
                    delete s.rc;
                }
            }
        }

        #collectFormData(elt, form, submitter, validate, isGet) {
            if (validate && form && !form.reportValidity()) return

            // treat a submit button that owns ypy-post as its own submitter; FormData adds its
            // name and value (nothing when it has no name), and throws for a button of another form
            submitter ??= (form && elt.type === 'submit') ? elt : null;
            if (submitter?.form !== form) submitter = null;

            let formData = form ? new FormData(form, submitter) : new FormData()
            let included = form ? new Set(form.elements) : new Set()
            if (!form) {
                if (validate && elt.reportValidity && !elt.reportValidity()) return
                this.#addInputValues(elt, included, formData, isGet);
            }
            if (submitter) included.add(submitter);
            let ypyInclude = this.#attributeValue(elt, "ypy-include");
            if (ypyInclude) {
                for (let node of this.#findAllExt(elt, ypyInclude)) {
                    if (validate && node.reportValidity && !node.reportValidity()) return
                    this.#addInputValues(node, included, formData);
                }
            }
            return formData
        }

        #addInputValues(elt, included, formData, isGet) {
            let tag = elt.tagName;
            let inputs = [];
            if (tag === 'BUTTON' || tag.includes('-')) {
                inputs = [elt]; // send own value only, never collect children
            } else if (['INPUT', 'SELECT', 'TEXTAREA', 'FIELDSET'].includes(tag) || (!isGet && elt !== document.body)) {
                inputs = this.#queryEltAndDescendants(elt, '[name]:not(button)');
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

        #getAttributeObject(elt, attrName, callback, scope = {}) {
            let ypyAttr = this.#attributeValue(elt, attrName);
            if (!ypyAttr) return null;

            let javascriptContent = this.#extractJavascriptContent(ypyAttr);
            if (javascriptContent) {
                // Wrap in braces if not already wrapped
                if (!javascriptContent.startsWith('{')) javascriptContent = '{' + javascriptContent + '}';
                // Return promise for async evaluation
                return this.#executeJavaScript(elt, scope, javascriptContent, true).then(callback);
            } else {
                // Synchronous path - return the parsed object directly
                callback(HCON.parse(ypyAttr));
            }
        }

        #findAllExt(eltOrSelector, maybeSelector, thisAttr, global) {
            let selector = maybeSelector ?? eltOrSelector;
            let elt = maybeSelector ? (this.#normalizeElement(eltOrSelector) || document.body) : document;
            if (selector.startsWith('global ')) {
                return this.#findAllExt(elt, selector.slice(7), thisAttr, true);
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
                    item = this.#scanQuery(elt, selector.slice(5), !!global)
                } else if (selector === 'previous' || selector === 'previousElementSibling') {
                    item = elt.previousElementSibling
                } else if (selector.startsWith('previous ')) {
                    item = this.#scanQuery(elt, selector.slice(9), !!global, true)
                } else if (selector === 'document') {
                    item = document
                } else if (selector === 'window') {
                    item = window
                } else if (selector === 'body') {
                    item = document.body
                } else if (selector === 'host') {
                    item = (elt.getRootNode()).host
                } else if (selector === 'parent') {
                    item = elt.parentElement
                } else if (selector === 'self') {
                    item = elt
                } else if (selector === 'this') {
                    if (thisAttr) {
                        result.push(...this.#findThisElements(elt, thisAttr));
                        continue;
                    }
                    item = elt
                } else {
                    // an extension may know this target (hook ypy:resolve:target, written ypy_resolve_target(elt, selector)): an element, an
                    // array or NodeList of them, null for none, undefined for "not mine"
                    let found;
                    for (let fn of this.#extMethods.get('ypy_resolve_target') ?? []) if ((found = fn(elt, selector)) !== undefined) break;
                    if (found === undefined) unprocessedParts.push(selector);
                    else if (found) result.push(...(found.nodeType ? [found] : found));
                }

                if (item) {
                    result.push(item)
                }
            }

            if (unprocessedParts.length > 0) {
                let standardSelector = unprocessedParts.join(',')
                let rootNode = this.#getRootNode(elt, !!global)
                result.push(...rootNode.querySelectorAll(standardSelector))
            }

            return [...new Set(result)]
        }

        #scanQuery(start, match, global, backwards) {
            let results = [...this.#getRootNode(start, global).querySelectorAll(match)];
            if (backwards) results.reverse();
            let comparison = backwards ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
            return results.find(elt => elt.compareDocumentPosition(start) === comparison);
        }

        #getRootNode(elt, global) {
            return elt.isConnected && elt.getRootNode ? elt.getRootNode({composed: global}) : document
        }

        #findOrWarn(elt, selector, thisAttr, quiet) {
            let result = this.#findAllExt(elt, selector, thisAttr)[0]
            if (!result && !quiet) {
                console.warn(`ypy: '${selector}' on ${thisAttr} did not match any element`,
                    { elt, selector, attr: thisAttr });
            }
            return result
        }

        #extractJavascriptContent(string) {
            return string?.match(/^(?:js|javascript):(.*)/s)?.[1];
        }

        //============================================================================================
        // SECTION request (cont.): aborting
        //============================================================================================

        //============================================================================================
        // SECTION morph: the morphing algorithm
        //============================================================================================

        #morph(oldNode, fragment, innerHTML) {
            let {persistentIds, idMap} = this.#createIdMaps(oldNode, fragment);
            let pantry = document.createElement("div");
            pantry.hidden = true;
            document.body.after( pantry);
            // live: the state the user gave an element wins over the response, except where the
            // response marks the element with ypy-morph-force
            let live = this.#prefixSelector('[ypy-morph-force]');
            // keep: the elements that carry ypy-preserve
            let ctx = {target: oldNode, idMap, persistentIds, pantry, futureMatches: new WeakSet(), live,
                keep: this.#prefixSelector('[ypy-preserve],[ypy-preserve-attrs]')};

            if (innerHTML) {
                this.#morphChildren(ctx, oldNode, fragment);
            } else {
                this.#morphChildren(ctx, oldNode.parentNode, fragment, oldNode, oldNode.nextSibling);
            }
            this.#cleanup(pantry)
            pantry.remove();
        }

        #morphChildren(ctx, oldParent, newParent, insertionPoint = null, endPoint = null) {
            if (oldParent instanceof HTMLTemplateElement && newParent instanceof HTMLTemplateElement) {
                oldParent = oldParent.content;
                newParent = newParent.content;
            }
            insertionPoint ||= oldParent.firstChild;

            let newChild = newParent.firstChild;
            while (newChild) {
                let matchedNode;
                if (insertionPoint && insertionPoint != endPoint) {
                    matchedNode = this.#findBestMatch(ctx, newChild, insertionPoint, endPoint);
                    // nodes before the match are removed, unless they match upcoming content: those move to the end for later use
                    for (let cursor = insertionPoint; matchedNode && cursor && cursor !== matchedNode;) {
                        let tempNode = cursor;
                        cursor = cursor.nextSibling;
                        if (tempNode instanceof Element && (ctx.idMap.has(tempNode) || this.#matchesUpcomingSibling(ctx, tempNode, newChild))) {
                            this.#moveBefore(oldParent, tempNode, endPoint);
                        } else {
                            this.#removeNode(ctx, tempNode);
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
                    this.#moveBefore(oldParent, matchedNode, insertionPoint);
                }

                if (matchedNode) {
                    this.#morphNode(matchedNode, newChild, ctx);
                    insertionPoint = matchedNode.nextSibling;
                    newChild = newChild.nextSibling;
                    continue;
                }

                let nextNewChild = newChild.nextSibling;
                if (ctx.idMap.has(newChild)) {
                    let placeholder = document.createElement(newChild.tagName);
                    oldParent.insertBefore(placeholder, insertionPoint);
                    this.#morphNode(placeholder, newChild, ctx, true);
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
                this.#removeNode(ctx, tempNode);
            }
        }

        #matchesUpcomingSibling(ctx, oldElt, startNode) {
            if (ctx.futureMatches.has(oldElt)) return true;
            for (let sibling = startNode.nextSibling, i = 0; sibling && i < this.config.morphScanLimit; sibling = sibling.nextSibling, i++) {
                if (sibling instanceof Element && oldElt.isEqualNode(sibling)) {
                    ctx.futureMatches.add(oldElt);
                    return true;
                }
            }
            return false;
        }

        #findBestMatch(ctx, node, startPoint, endPoint) {
            // text nodes match positionally (patch in place via #morphNode), 3 = TEXT_NODE
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
            if (softMatch && this.#matchesUpcomingSibling(ctx, softMatch, node)) return null;
            return softMatch;
        }

        #isSoftMatch(oldNode, newNode) {
            if (!(oldNode instanceof Element) || oldNode.tagName !== newNode.tagName) {
                return false;
            }
            // Script tags must be identical to match - never patch a script with different content
            if (oldNode.tagName === 'SCRIPT' && !oldNode.isEqualNode(newNode)) return false;
            return !oldNode.id || oldNode.id === newNode.id;
        }

        #removeNode(ctx, node) {
            if (ctx.idMap.has(node)) {
                this.#moveBefore(ctx.pantry, node, null);
            } else {
                this.#cleanup(node)
                node.remove();
            }
        }

        #moveBefore(parentNode, element, after) {
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

        #morphNode(oldNode, newNode, ctx, fresh) {
            if (oldNode.nodeType === 3) { // text node
                if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
                return;
            }
            // ypy-preserve says how much of the element a script other than YPY owns
            let mode, list;
            if (oldNode.matches(ctx.keep)) {
                mode = this.#attr(oldNode, 'ypy-preserve');
                list = this.#attr(oldNode, 'ypy-preserve-attrs');
            }
            if (mode == 'all' || (this.config.morphSkip && oldNode.matches(this.config.morphSkip))) return;

            // Trigger extension hook - if returns false, skip morphing this node
            if (!this.#triggerExtensions(oldNode, "ypy:before:morph:node", {oldNode, newNode})) return;

            // an element created for this morph has no state of its own to keep
            let live = !fresh && ctx.live;
            if (mode != 'attrs') this.#copyAttributes(oldNode, newNode, live, list);
            if (oldNode instanceof HTMLTextAreaElement && (document.activeElement !== oldNode || (live && newNode.matches(live))) && oldNode.defaultValue != newNode.defaultValue) {
                oldNode.value = newNode.value;
            }
            // a custom element that is defined draws its own children: they stay (the attributes follow),
            // and so do those of a root of a script's own that the response gives empty. The response
            // wins with ypy-morph-force on the element, ypy-preserve="false" turns it off here.
            let skipChildren = mode == 'children' || (this.config.morphSkipChildren && oldNode.matches?.(this.config.morphSkipChildren)) ||
                (live && mode != 'false' && !newNode.matches(live) && (customElements.get(oldNode.localName) ||
                    oldNode.firstChild && !newNode.firstElementChild && !newNode.textContent.trim() &&
                    (oldNode.localName.includes('-') || oldNode.matches(this.config.morphThirdParty))));
            // isEqualNode does not detect template content diff so always morph templates
            if (!skipChildren && (!oldNode.isEqualNode(newNode) || newNode.tagName === 'TEMPLATE' || newNode.querySelector?.('template'))) {
                this.#morphChildren(ctx, oldNode, newNode);
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
        #copyAttributes(destination, source, live, keep) {
            let attributesToIgnore = this.config.morphIgnore || [];
            if (keep) attributesToIgnore = [...attributesToIgnore, ...keep.match(/[^\s,*]+/g) || []];
            let keepOpen = live && /^(DETAILS|DIALOG)$/.test(destination.tagName) && !source.matches(live);
            let needsReinit = false;
            let ypyPrefixes;
            let isYpyAttr = name => (ypyPrefixes ??= this.#prefixes('ypy-')).some(p => name.startsWith(p));
            let ignored = name => keepOpen && name === 'open' || attributesToIgnore.some(p => name.startsWith(p));
            for (const attr of source.attributes) {
                // the cheap test first: most attributes of a morphed element did not change
                if (destination.getAttribute(attr.name) !== attr.value && !ignored(attr.name)) {
                    if (isYpyAttr(attr.name)) needsReinit = true;
                    if (!this.#triggerExtensions(destination, 'ypy:before:morph:attr', { attrName: attr.name, newValue: attr.value })) continue;
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
                    if (!this.#triggerExtensions(destination, 'ypy:before:morph:attr', { attrName: attr.name, newValue: null })) continue;
                    destination.removeAttribute(attr.name);
                }
            }
            if (needsReinit) this.#cleanup(destination, true);
        }

        #populateIdMapWithTree(idMap, persistentIds, root, elements) {
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

        #createIdMaps(oldNode, newContent) {
            let oldIdElements = this.#queryEltAndDescendants(oldNode, "[id]");
            let newIdElements = newContent.querySelectorAll("[id]");
            let persistentIds = this.#createPersistentIds(oldIdElements, newIdElements);
            let idMap = new Map();
            this.#populateIdMapWithTree(idMap, persistentIds, oldNode.parentElement, oldIdElements);
            this.#populateIdMapWithTree(idMap, persistentIds, newContent, newIdElements);
            return {persistentIds, idMap};
        }

        #createPersistentIds(oldIdElements, newIdElements) {
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

        #handleStatusCodes(ctx) {
            let status = ctx.response.raw.status;
            let noSwapStrings = this.config.noSwap.map(x => x + "");
            let str = status + ""
            for (let pattern of [str, str.slice(0, 2) + 'x', str[0] + 'xx']) {
                if (noSwapStrings.includes(pattern)) {
                    ctx.swap = "none";
                    return
                }
                let statusValue = this.#attributeValue(ctx.sourceElement, "ypy-status:" + pattern);
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
         * (#handleStatusCodes runs after this). A target that matches nothing goes through the
         * same chain as any other (quiet lookup, then #fallbackMode and #fallbackMain in
         * #processMainSwap).
         *
         * @param {YpyRequestCtx} ctx
         */
        #errorDefaults(ctx) {
            let elt = ctx.sourceElement, status = ctx.response.status, validation = status === 422,
                own = ['target', 'swap', 'focus'].map(name => this.#attributeValue(elt, 'ypy-error-' + name));
            ctx.errorKind = validation ? 'validation' : status < 500 ? 'client' : 'server';
            if (validation) {
                ctx.focus = 'first-invalid';
                if (!this.#isBoosted(elt)) {   // a boosted form is a navigation: its 422 is a page like any other
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
            let done = e => {
                if (e.detail.ctx !== ctx) return;
                document.removeEventListener('ypy:finally:request', done);
                if (ctx.status !== 'swapped' || ctx.swap === 'none') return;
                let source = ctx.sourceElement, target = this.#resolveTarget(source, ctx.target, true);
                if (!target?.isConnected) target = source;
                this.#setState(target, 'error', true);
                source.addEventListener('ypy:before:request', () => this.#setState(target, 'error', false), {once: true});
            };
            document.addEventListener('ypy:finally:request', done);
        }

        //============================================================================================
        // SECTION swap (cont.): view transitions and CSS transitions
        //============================================================================================

        #startCSSTransitions(fragment, root) {
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
                        this.#copyAttributes(elt, clone, 0, 'open')
                    })
                }
            }
            return restoreTasks;
        }

        //============================================================================================
        // SECTION processing (cont.): state classes and small DOM helpers
        //============================================================================================

        /** @param {Element} elt @param {string} state name of an entry of config.classes */
        #addClass(elt, state) {
            elt?.classList?.add?.(...this.#classNames(state));
        }

        #removeClass(elt, state) {
            elt?.classList?.remove?.(...this.#classNames(state));
            if (elt?.classList?.length === 0) elt.removeAttribute('class');
        }

        #normalizeElement(cssOrElement) {
            if (typeof cssOrElement === "string") {
                return this.find(cssOrElement);
            } else {
                return cssOrElement
            }
        }

        #maybeAdjustMetaCharacter(string) {
            if (this.config.metaCharacter) {
                return string.replace(/:/g, this.config.metaCharacter);
            } else {
                return string;
            }
        }

        //============================================================================================
        // SECTION a11y (cont.): hooks owned by TASK-013, called by the request phases; empty until then
        //============================================================================================

        #liveSheet;   // the adopted style sheet that hides the live regions, created with the first one

        /**
         * Start-up hook for accessibility support: creates the polite live region ahead of the
         * first announcement (a region that exists before its text changes is announced
         * reliably). Called by initialize(); may be called more than once, so it is idempotent
         * (the region is looked up, never duplicated). Does nothing when config.announce is false.
         */
        /**
         * Listener of ypy:before:swap (added by #initA11y): resolves the scroll policy of the
         * request into ctx.scroll and, for "keep", notes where the window and the target are.
         */
        #beforeSwap = e => {
            let ctx = e.detail.ctx, t = ctx.target;
            if ((ctx.scroll ??= ctx.sourceElement && this.#attributeValue(ctx.sourceElement, 'ypy-scroll')) === 'keep') {
                ctx.scrollKept = [{left: scrollX, top: scrollY}, t && {left: t.scrollLeft, top: t.scrollTop}];
            }
        }

        #initA11y() {
            document.addEventListener('ypy:before:swap', this.#beforeSwap);
            if (this.config.announce ?? true) this.#liveRegion('polite');
        }

        /**
         * The live region for a politeness level, created on first use and again if a swap of
         * the body removed it: a visually hidden div (styled by an adopted style sheet, so no
         * inline style and no CSP exception) marked data-ypy-live.
         *
         * @param {"polite" | "assertive"} level
         * @returns {HTMLElement}
         */
        #liveRegion(level) {
            let live = document.querySelector('[data-ypy-live=' + level + ']');
            if (!live) {
                this.#liveSheet ||= this.#sheet('[data-ypy-live]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
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
        #say(ctx, message, level) {
            if (!message) return;
            let detail = {ctx, message, politeness: level};
            if (!this.#triggerNative(ctx.sourceElement?.isConnected ? ctx.sourceElement : document.body, 'ypy:announce', detail) || !detail.message) return;
            let live = this.#liveRegion(detail.politeness);
            let s = this.#ypyState(live);
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
         * ends. Called by #beginRequest after the indicators are shown, once per request;
         * #endRequest always calls #unmarkBusy afterwards. Also says the "loading" message
         * when config.announce.messages has one.
         *
         * @param {YpyRequestCtx} ctx
         */
        #markBusy(ctx, elt = ctx.target) {
            // also called for each swap target (OOB, <ypy-partial>) once the response names it
            if (!(this.config.ariaBusy ?? true) || !(elt instanceof Element) || ctx.busy?.includes(elt)) return;
            if ((this.#attributeValue(elt, 'ypy-busy') ?? this.#attributeValue(ctx.sourceElement, 'ypy-busy')) === 'false') return;
            let s = this.#ypyState(elt);
            if (!s.bc) s.bv = elt.getAttribute('aria-busy');
            s.bc = (s.bc || 0) + 1;
            elt.setAttribute('aria-busy', 'true');
            (ctx.busy ??= []).push(elt);
            if (elt == ctx.target) this.#say(ctx, this.config.announce?.messages?.loading, 'polite');
        }

        /**
         * Undoes #markBusy: the last request to leave an element puts back the aria-busy value the
         * author had there, or removes the attribute. Called by #endRequest for every admitted
         * request, so it runs without a #markBusy before it (confirmation denied, opt-out) and does nothing then; calling it twice does nothing the second time.
         *
         * @param {YpyRequestCtx} ctx
         */
        #unmarkBusy(ctx) {
            for (let elt of ctx.busy || []) {
                let s = this.#ypyState(elt);
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
         * (config.announce). Called by #endRequest after the busy marks are gone,
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
        #announce(ctx) {
            let cfg = this.config.announce;
            if (ctx.announce === false || !(cfg ?? true)) return;
            let m = cfg?.messages || {};
            let status = ctx.status + '';
            let kind = ctx.errorKind || (ctx.response?.status >= 400 ? 'server' : /^error: (?!AbortError)/.test(status) && 'network');
            let spec = typeof ctx.announce === 'string' ? ctx.announce : null;
            if (kind) {
                // network and offline are the two lost-connection kinds
                spec ??= m[/net|off/.test(kind) ? 'offline' : 'error'];
            } else if (status === 'swapped') {
                let target = ctx.target;
                spec ??= this.#attributeValue(ctx.sourceElement, 'ypy-announce')
                    ?? (target instanceof Element ? this.#attributeValue(target, 'ypy-announce') : null)
                    ?? ((this.#isBoosted(ctx.sourceElement) || ctx.request?.headers?.['YPY-Boosted']) && ctx.swap !== 'none' && !ctx.focused ? 'title' : m.done);
            }
            if (spec === 'title') spec = ctx.title || document.title;
            if (spec !== 'none') this.#say(ctx, spec, kind ? 'assertive' : 'polite');
        }

        //============================================================================================
        // SECTION offline: connection state and failure kinds (owner: TASK-010); retry is the ypy-retry extension
        //============================================================================================

        #offline = false
        #onNetworkChange = event => this.#setOffline(event.type === 'offline')

        /**
         * Start-up hook for offline detection. Listens to the window "online" and "offline"
         * events and reads the state at load. Called by initialize() and idempotent: the listener
         * is one function, so adding it again does nothing.
         *
         * navigator.onLine is only a hint: false means there is no network interface, true does
         * not mean the server is reachable (VPN, captive portal, and Chromium and WebKit disagree).
         * That is why a request that gets a response clears the offline state.
         */
        #initOffline() {
            window.addEventListener('offline', this.#onNetworkChange);
            window.addEventListener('online', this.#onNetworkChange);
            if (!navigator.onLine) this.#setOffline(true);
        }

        /**
         * Turns the page offline state on or off: the offline class
         * (config.classes.offline, "ypy-offline" unless the author set it) and data-ypy-state="offline" on <html>, then ypy:offline or
         * ypy:online on the document. Does nothing when the state does not change.
         *
         * @param {boolean} on
         */
        #setOffline(on) {
            if (on === this.#offline) return;
            this.#offline = on;
            this.config.classes.offline ??= 'ypy-offline';   // the default lives here until #initConfig (task 002) holds it
            this.#setState(document.documentElement, 'offline', on);
            this.#triggerNative(document, on ? 'ypy:offline' : 'ypy:online');
        }

        //============================================================================================
        // Shared utilities (owner: TASK-006). Used by the Phase 1 tasks; nobody else edits them.
        //============================================================================================

        /**
         * Turns a named state of an element on or off in the two ways an author can style it: the
         * configured class names of that state (config.classes, see #classNames) and a
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
        #setState(elt, state, on) {
            if (!elt?.dataset) return;
            on ? this.#addClass(elt, state) : this.#removeClass(elt, state);
            let states = (elt.dataset.ypyState || '').split(' ').filter(x => x && x !== state);
            if (on) states.push(state);
            states[0] ? elt.dataset.ypyState = states.join(' ') : delete elt.dataset.ypyState;
        }

        /**
         * Fires a ypy:<noun>:<verb> event, for example ypy:target:missing. Like #trigger it runs the
         * extension hooks (ypy_<noun>_<verb>) first, honors config.metaCharacter and logs events with
         * detail.error (error), detail.warn (warn) or, with config.logAll, every event; and like
         * it returns false when a listener or an extension cancelled the event.
         *
         * @param {Element | string} on element, or selector of one, the event is dispatched on
         * @param {string} name event name starting with "ypy:"
         * @param {object} [detail]
         * @returns {boolean} false when cancelled (the event always bubbles)
         */
        #triggerNative(on, name, detail = {}) {
            on = this.#normalizeElement(on);
            let level = detail.error ? 'error' : detail.warn ? 'warn' : this.config.logAll && 'log';
            if (level) console[level]('ypy: ' + name, { elt: on, detail });
            this.#triggerExtensions(on, name, detail);
            return this.#dispatch(on, this.#maybeAdjustMetaCharacter(name), detail, true);
        }

    }

    return new Ypy()
})()

;

ypy.version += "-max";
ypy.config.historyCache ??= { disable: true };
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-stream.js
//
// The client of the YPY streaming protocol (spec/PROTOCOL.md): a response of type
// text/event-stream is read as it arrives, and each event changes the page.
//
//   <div id="room" ypy-stream="/room/events"></div>           open on load
//   <div ypy-stream.post="/jobs/7/run" ypy-trigger="click">   other verbs: .post .put .patch .delete
//
// Events: ypy-patch-elements (with key and limit for append and prepend lists), ypy-patch-signals,
// ypy-redirect, ypy-event, ypy-refresh (fetch the page, or the elements of a selector, again).
// Reconnects with backoff and jitter; the server answers with the full state (the fat morph).
// pauseOnBackground (ypy.config.stream, or ypy-config='{"stream":{"pauseOnBackground":true}}') closes the
// connection while the tab is hidden and opens it again, with Last-Event-ID, when it is visible.
// useViewTransition=true asks for a view transition, which the ypy-transitions extension runs.
// Events are queued and applied in order; with config.stream.frame (off by default; a model answer turns it on) the events of one
// network read are applied together, one animation frame after the last read.
// Consecutive patches of one selector are merged (config.stream.merge, on by default): inner and outer
// keep the last one, append concatenates, so a model answer of many tokens costs few DOM operations.
// ypy:abort on the element of the stream closes it (the Stop button of a model answer).
// Uses only the public API and the extension API. Load it before ypy-sse: an element with
// ypy-sse:connect stays with that extension.
//==========================================================
(() => {
    let api, sel, mo, vl;
    const open = new Set();
    const E = m => Error('ypy: stream: ' + m);
    const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
    const STYLE = {outer: 'outerMorph', inner: 'innerMorph', replace: 'outerHTML', append: 'beforeend',
        prepend: 'afterbegin', before: 'beforebegin', after: 'afterend', remove: 'delete'};
    const TAG = {html: '', svg: 'svg', mathml: 'math'};

    const fail = (st, error) => api.triggerEvent(st.elt, 'ypy:stream:error', {error, stream: st});

    //============================================================================================
    // The SSE framing (WHATWG): lines end in LF, CRLF or CR, a field is "name: value", a blank line
    // ends a frame. feed(text) returns the frames the text completed. The BOM is dropped by
    // TextDecoder; a CR at the end of a chunk is not followed by a phantom blank line.
    //============================================================================================
    function decoder(st) {
        let buf = '', ev = '', data = [], lid = st.id, cr = false;
        return text => {
            let frames = [];
            if (cr && text[0] == '\n') text = text.slice(1);
            if (text) cr = text.endsWith('\r');
            let lines = (buf + text).split(/\r\n|\r|\n/);
            buf = lines.pop();
            for (let l of lines) {
                if (!l) {
                    st.id = lid;
                    if (data.length) frames.push({event: ev, data: data.join('\n')});
                    ev = ''; data = [];
                } else if (l[0] != ':') {
                    let i = l.indexOf(':'), f = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1).replace(/^ /, '');
                    if (f == 'data') data.push(v);
                    else if (f == 'event') ev = v;
                    else if (f == 'id') v.includes('\0') || (lid = v);
                    else if (f == 'retry' && /^\d+$/.test(v)) st.retry = +v;
                }
            }
            return frames;
        };
    }

    //============================================================================================
    // The events
    //============================================================================================
    function missing(st, selector) {
        if (api.triggerEvent(st.elt, 'ypy:target:missing', {selector, type: 'stream', stream: st}))
            console.warn(`ypy: stream: '${selector}' did not match any element`);
    }

    // The top-level elements of html, parsed into an inert template (nothing runs or loads)
    function top(html, ns) {
        let tt = api.ttPolicy(), t = document.createElement('template'), tag = TAG[ns];
        if (tag == null) throw E('unknown namespace ' + ns);
        if (!tt) throw E("Trusted Types policy 'ypy' is blocked by the CSP");
        t.innerHTML = tt.createHTML(tag ? `<${tag}>${html}</${tag}>` : html);
        return [...(tag ? t.content.firstChild : t.content).children];
    }

    // the same swap, morph, focus and security as a response; svg and math are parsed inside their own
    // element, which ctx.select then unwraps
    const put = (st, k, target, style, html) => {
        let tag = TAG[k.namespace || 'html'];
        if (tag == null) throw E('unknown namespace ' + k.namespace);
        return ypy.swap({
            sourceElement: st.elt, target, status: 'stream', focus: 'none',
            swap: style + ' swapEmpty:true',
            text: style == 'delete' ? '' : tag ? `<${tag} data-ypy-ns>${html}</${tag}>` : html,
            select: tag ? '[data-ypy-ns]>*' : undefined,
            transition: k.useViewTransition == 'true',
            request: {method: 'GET', action: st.url, headers: {}}, ypy: {}
        });
    };

    // An append or prepend list (key and limit, the rules of ypy-list): an item whose key attribute has
    // the value of one in the list replaces it where it stands, the same key twice in a patch keeps the
    // last, and afterwards the list keeps at most limit items, the oldest going.
    async function fillList(st, k, target, html) {
        let append = k.mode == 'append', key = k.key == null ? '' : k.key || 'id', limit = k.limit;
        let val = e => key ? e.getAttribute(key) : null, items = top(html, k.namespace || 'html'), old = new Map(), last = new Map();
        for (let e of items) val(e) != null && last.set(val(e), e);
        for (let c of key ? target.children : []) val(c) != null && !old.has(val(c)) && old.set(val(c), c);
        let rest = [];
        for (let e of items) {
            if (val(e) != null && last.get(val(e)) !== e) continue;
            let was = val(e) != null && old.get(val(e));
            was ? await put(st, k, was, 'outerHTML', e.outerHTML) : rest.push(e);
        }
        if (rest.length) await put(st, k, target, STYLE[k.mode], rest.map(e => e.outerHTML).join(''));
        let kids = [...target.children], extra = limit ? kids.length - limit : 0;
        if (extra > 0) for (let c of append ? kids.slice(0, extra) : kids.slice(-extra)) await put(st, k, c, 'delete');
    }

    async function patchElements(st, k) {
        let mode = k.mode || 'outer', ns = k.namespace || 'html', style = STYLE[mode], jobs = [], html = k.elements ?? '';
        if (!style) throw E('unknown mode ' + mode);
        if (TAG[ns] == null) throw E('unknown namespace ' + ns);
        // key and limit mean something for append and prepend only, and are ignored in the other modes
        let list = /^(?:append|prepend)$/.test(mode) && (k.key != null || k.limit != null);
        if (list) {
            if (k.key && !/^[A-Za-z_][\w.-]*$/.test(k.key)) throw E('invalid key attribute ' + k.key);
            if (k.limit != null && !/^[1-9]\d*$/.test(k.limit)) throw E('limit must be a whole number of 1 or more');
            k = {...k, mode, limit: k.limit && +k.limit};
        }
        if (k.selector) {
            let found = ypy.findAll(st.elt, k.selector);
            if (!found.length) return missing(st, k.selector);
            jobs = found.map(t => [t, html]);
        } else {
            // no selector: a top-level element goes to the page element with the same id. outer, replace
            // and remove take the element itself, the other modes its children
            for (let e of top(html, ns)) {
                let t = e.id && document.getElementById(e.id);
                if (t) jobs.push([t, /^(?:outer|replace|remove)$/.test(mode) ? e.outerHTML : e.innerHTML]);
                else missing(st, e.id ? '#' + CSS.escape(e.id) : '');
            }
        }
        for (let [target, h] of jobs) await (list ? fillList(st, k, target, h) : put(st, k, target, style, mode == 'remove' ? '' : h));
    }

    function patchSignals(st, k) {
        let patch = JSON.parse(k.signals), missingOnly = k.onlyIfMissing == 'true';
        if (!patch || typeof patch != 'object' || Array.isArray(patch)) throw E('signals must be a JSON object');
        if (ypy.signals) ypy.signals.patch(patch, st.elt, missingOnly);
        else api.triggerEvent(st.elt, 'ypy:stream:signals', {patch, onlyIfMissing: missingOnly});
    }

    function redirect(st, k) {
        if (!k.url) throw E('ypy-redirect needs a url');
        let mode = k.mode || 'navigate', u = new URL(k.url, location.href);
        if (!/^https?:$/.test(u.protocol) || (u.origin != location.origin && ypy.config.mode == 'same-origin'))
            throw E('redirect to another origin refused: ' + k.url);
        if (!/^(?:navigate|replace|hard)$/.test(mode)) throw E('unknown redirect mode ' + mode);
        close(st, 'redirect');
        if (mode == 'hard') (ypy._loc || location).href = u.href;
        else ypy.ajax('GET', u.origin == location.origin ? u.pathname + u.search + u.hash : u.href, {push: mode == 'navigate' ? 'true' : undefined, replace: mode == 'replace' ? 'true' : undefined});
    }

    function fire(st, k) {
        if (!k.name) throw E('ypy-event needs a name');
        let target = document;
        if (k.selector && !(target = ypy.findAll(st.elt, k.selector)[0])) return missing(st, k.selector);
        ypy.trigger(target, k.name, k.detail ? JSON.parse(k.detail) : undefined);
    }

    // ypy-refresh: the server says "something changed", this client fetches its own copy. Events with the
    // same selector (the page is one) that come within debounce ms of the first make one request, after
    // that window and up to jitter ms more; the next event after the request starts a new window.
    const delay = (v, def) => /^\d+$/.test(v ?? '') ? Math.min(60000, +v) : def;

    function refresh(st, k) {
        let sel = k.selector || '', rf = st.rf ??= new Map();
        if (rf.has(sel)) return;
        rf.set(sel, setTimeout(() => { rf.delete(sel); fetchAgain(st, sel) }, delay(k.debounce, 250) + Math.random() * delay(k.jitter, 0)));
    }

    async function fetchAgain(st, sel) {
        if (st.stop || !api.triggerEvent(st.elt, 'ypy:stream:refresh', {stream: st, selector: sel})) return;
        try {
            if (!sel) {
                // the page: the element that holds it for the history, or the body, like a history restore
                let page = document.querySelector(api.prefixSelector('[ypy-history-elt]')) || document.body;
                await ypy.ajax('GET', location.pathname + location.search, {
                    source: st.elt, target: page, swap: 'outerMorph',
                    select: page != document.body ? api.prefixSelector('[ypy-history-elt]') : undefined
                });
                return;
            }
            let found = ypy.findAll(st.elt, sel);
            if (!found.length) return missing(st, sel);
            for (let elt of found) {
                let url = api.attr(elt, 'ypy-get');
                if (url) await ypy.ajax('GET', url, {source: elt, target: elt, swap: 'innerMorph'});
                else fail(st, E(`refresh: '${sel}' has no ypy-get`));
            }
        } catch (e) { fail(st, e) }
    }

    const EVENTS = {'ypy-patch-elements': patchElements, 'ypy-patch-signals': patchSignals, 'ypy-redirect': redirect, 'ypy-event': fire, 'ypy-refresh': refresh};

    // data lines are "key value"; a repeated key joins its values with a line feed. An unknown event is ignored.
    // The events of a stream wait in st.q and run one at a time. A patch that follows another one of the same
    // mode and selector is merged into it (the optional rule of protocol 5.3), so a slow browser catches up
    // with the work of one patch, not of all of them.
    const ONE = ['key', 'limit', 'useViewTransition'];

    function merge(a, b) {
        let m = b.k.mode || 'outer', x = a.k, y = b.k;
        if (a.ev != 'ypy-patch-elements' || b.ev != a.ev || !y.selector || y.selector != x.selector || m != (x.mode || 'outer')
            || (y.namespace || 'html') != (x.namespace || 'html') || !/^(?:inner|outer|append)$/.test(m) || ONE.some(n => n in x || n in y)) return;
        x.elements = m == 'append' ? (x.elements ?? '') + (y.elements ?? '') : y.elements;
        return true;
    }

    function push(st, f) {
        let fn = EVENTS[f.event];
        if (!fn) return;
        let k = Object.create(null);
        for (let l of f.data.split('\n')) {
            let i = l.indexOf(' '), n = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1);
            k[n] = n in k ? k[n] + '\n' + v : v;
        }
        let q = st.q ??= [], item = {fn, ev: f.event, k, g: st.g};
        if (st.merge && q.length && merge(q[q.length - 1], item)) return;
        q.push(item);
        if (!st.busy) { st.busy = true; st.dp = drain(st) }
    }

    // one animation frame; a hidden tab has none, so it waits 100 ms at most
    const frame = () => new Promise(resolve => { let t = setTimeout(resolve, 100); requestAnimationFrame(() => { clearTimeout(t); resolve() }) });

    // With frame, one animation frame per network read: the events a server wrote in one flush (the closed
    // block that goes to the done region and the tail that is emptied) are applied together, so no frame
    // shows the text twice.
    async function drain(st) {
        let group;
        while (st.q.length && !st.stop) {
            if (st.frame && st.q[0].g !== group) await frame();
            let item = st.q.shift();
            if (st.stop || !item) break;
            group = item.g;
            try { await item.fn(st, item.k) } catch (e) { fail(st, e) }
        }
        st.busy = false;
    }

    //============================================================================================
    // Connections
    //============================================================================================
    function make(elt, m, url) {
        let cfg = {...ypy.config.stream, ...api.HCON.parse(api.attributeValue(elt, 'ypy-config')).stream};
        let st = {elt, m, url, id: '', retry: 1000, att: 0, ac: new AbortController(), pause: !!cfg.pauseOnBackground,
            merge: cfg.merge !== false, frame: cfg.frame === true, q: [], abort: () => close(st, 'abort')};
        elt.addEventListener('ypy:abort', st.abort);
        api.ypyProp(elt).stream = st;
        open.add(st);
        (mo ??= new MutationObserver(() => open.forEach(s => s.elt.isConnected || close(s, 'removed')))).observe(document, {childList: true, subtree: true});
        if (st.pause && !vl) document.addEventListener('visibilitychange', vl = () => open.forEach(s => s.pause && (document.hidden ? hide(s) : s.paused && s.wake?.())));
        return st;
    }

    // The tab went to the background: close the connection, without counting it as a failure. again() waits
    // for the tab, and opens the next one at once
    function hide(st) {
        if (!st.rd || st.paused) return;
        st.paused = true;
        api.triggerEvent(st.elt, 'ypy:stream:pause', {stream: st});
        st.ac.abort();
        st.rd.cancel().catch(() => {});
    }

    function close(st, reason) {
        if (st.stop) return;
        st.stop = true;
        open.delete(st);
        if (!open.size) mo?.disconnect();
        if (vl && ![...open].some(s => s.pause)) document.removeEventListener('visibilitychange', vl), vl = null;
        st.rf?.forEach(clearTimeout);
        st.elt.removeEventListener('ypy:abort', st.abort);
        st.q = [];
        if (st.elt._ypy?.stream === st) delete st.elt._ypy.stream;
        st.ac.abort();
        st.rd?.cancel().catch(() => {});
        st.wake?.();
        api.triggerEvent(st.elt, 'ypy:stream:close', {stream: st, reason});
    }

    // waits ms, or without ms until the browser is online; close() ends the wait
    const sleep = (st, ms) => new Promise(resolve => {
        let t = ms == null ? 0 : setTimeout(done, ms);
        function done() { clearTimeout(t); removeEventListener('online', done); st.wake = null; resolve() }
        if (ms == null) addEventListener('online', done);
        st.wake = done;
    });

    // Reads one connection until it ends, then reconnects unless a stop condition holds
    async function run(st, res) {
        let rd = st.rd = res.body.getReader(), dec = new TextDecoder(), feed = decoder(st);
        if (st.stop) return rd.cancel();   // closed while the answer was on its way
        if (st.pause && document.hidden) { st.rd = null; rd.cancel().catch(() => {}); return again(st) }   // hidden while it was on its way
        api.triggerEvent(st.elt, 'ypy:stream:open', {stream: st});
        try {
            for (let r; !st.stop && !(r = await rd.read()).done;) {
                st.g = (st.g || 0) + 1;
                for (let f of feed(dec.decode(r.value, {stream: true}))) {
                    if (st.stop) break;
                    st.att = 0;
                    push(st, f);
                }
            }
            await st.dp;   // what has arrived is applied before the next connection
        } catch (e) {
            if (!st.stop && e.name != 'AbortError') fail(st, e);
        }
        st.rd = null;
        if (st.stop) return;
        if (!st.elt.isConnected) return close(st, 'removed');
        again(st);
    }

    // One attempt through the whole request pipeline (the current signals, headers and values travel).
    // true: the answer was a stream, or something else that ends the stream; false: no answer, try again
    async function connect(st) {
        st.res = null; st.claimed = false; st.att++;
        if (st.ac.signal.aborted && !st.stop) st.ac = new AbortController();   // the last one ended with a pause
        try {
            await ypy.ajax(st.m, st.url, {
                source: st.elt, stream: st, request: {signal: st.ac.signal},
                headers: {Accept: 'text/event-stream', 'Last-Event-ID': st.id || null}
            });
        } catch (e) { fail(st, e); close(st, 'error'); return true }
        if (st.claimed) return true;
        if (st.res) return close(st, 'status ' + st.res.status), true;   // 204, an error or a page: handled, not retried
        return false;
    }

    async function again(st) {
        while (!st.stop) {
            if (!st.elt.isConnected) return close(st, 'removed');
            if (st.pause && document.hidden) {
                // wait for the tab; hide() has already said so when it closed a connection
                if (!st.paused) { st.paused = true; api.triggerEvent(st.elt, 'ypy:stream:pause', {stream: st}) }
                await new Promise(resolve => st.wake = () => { st.wake = null; resolve() });
                continue;
            }
            if (st.paused) {   // the tab is back: no wait, no backoff
                st.paused = false; st.att = 0;
                api.triggerEvent(st.elt, 'ypy:stream:resume', {stream: st});
            } else if (navigator.onLine) {
                let delay = Math.min(30000, Math.max(10, st.retry) * 2 ** Math.max(0, st.att - 1)) * (1 - Math.random() * .25);
                api.triggerEvent(st.elt, 'ypy:stream:reconnect', {stream: st, delay});
                await sleep(st, delay);
            } else await sleep(st);
            if (st.pause && document.hidden) continue;
            if (st.stop || await connect(st)) return;
        }
    }

    function start(elt, m, url) {
        if (elt._ypy?.stream) return;
        let st = make(elt, m, url);
        connect(st).then(done => done || again(st));
    }

    //============================================================================================
    // Elements with ypy-stream
    //============================================================================================
    function scan(root) {
        if (!root.querySelectorAll) return;
        for (let elt of [root, ...root.querySelectorAll(sel)]) {
            if (!elt.matches(sel) || elt.closest(api.prefixSelector('[ypy-ignore]')) || api.ypyProp(elt).streamBound) continue;
            api.ypyProp(elt).streamBound = true;
            for (let m of METHODS) {
                let name = 'ypy-stream' + (m == 'get' ? '' : '.' + m);
                if (api.attr(elt, name)) {
                    // a microtask later: every extension has seen the element (the signals are wired) when the
                    // first request is built
                    api.onTrigger(elt, api.attributeValue(elt, 'ypy-trigger', undefined, undefined, false) || 'load',
                        () => queueMicrotask(() => start(elt, m.toUpperCase(), api.attr(elt, name))));
                    break;
                }
            }
        }
    }

    ypy.stream = {
        /** Closes the stream of an element; it does not reconnect. */
        close(elt) { let st = elt?._ypy?.stream; st && close(st, 'api') },
        /** {open}: the streams that are open, for leak tests and tooling. */
        stats: () => ({open: open.size})
    };

    ypy.registerExtension('ypy-stream', {
        init(internalApi) {
            api = internalApi;
            sel = api.prefixSelector(METHODS.map(m => '[ypy-stream' + (m == 'get' ? '' : '\\.' + m) + ']').join(','));
        },

        ypy_after_process(root) { scan(root) },

        // The routing by Content-Type: an event stream is read here. The request is over at once, it does
        // not hold the queue of its element. ypy-sse keeps the elements that name it.
        ypy_before_response(elt, {ctx}) {
            let res = ctx.response.raw, st = ctx.stream;
            if (st) st.res = res;
            if (res.status != 200 || !/^text\/event-stream/i.test(res.headers.get('Content-Type') ?? '')) return;
            if (!st) {
                if (api.attributeValue(elt, 'ypy-sse:connect') != null || elt.hasAttribute('ypy-sse-connect')) return;
                let prev = elt._ypy?.stream;
                prev && close(prev, 'replaced');
                st = make(elt, ctx.request.method, ctx.request.action);
            }
            st.claimed = true;
            clearTimeout(ctx.requestTimeout);
            run(st, res);
            return false;
        },

        ypy_before_cleanup(elt) {
            let st = elt._ypy?.stream;
            st && close(st, 'removed');
        }
    });
})();
// SPDX-License-Identifier: MIT
(() => {
    let api;
    let warnedLegacyAttributes = new Set();
    // Connections that are open now: the resume listeners at the end of the file wake them.
    const liveConnections = new Set();

    // ========================================
    // HELPERS
    // ========================================

    function getConfig(element) {
        let hasYpySseConnect = api.attributeValue(element, 'ypy-sse:connect') != null;
        let ypyConfig = api.HCON.parse(api.attributeValue(element, 'ypy-config')).sse || {};

        return {
            reconnect: hasYpySseConnect,
            reconnectDelay: 500,
            reconnectMaxDelay: 60000,
            reconnectMaxAttempts: Infinity,
            reconnectJitter: 0.3,
            connectTimeout: ypy.config.defaultTimeout,
            pauseOnBackground: hasYpySseConnect,
            heartbeat: 0,
            releaseOn: hasYpySseConnect ? 'immediate' : 'end',
            ...ypy.config.sse,
            ...ypyConfig
        };
    }

    // Ends the response of a connection that is being restarted: cancels the reader, then aborts the
    // request of that connection (each attempt has its own controller, so a later one is not touched).
    // Firefox keeps the request open when only the reader is cancelled and the next one never leaves.
    // The abort comes second so that the pending read ends with done, as it does in the other browsers.
    // Cancelling a reader that was released is not an error here.
    function cancelReader(connection) {
        try {
            connection.reader?.cancel()?.catch?.(() => {});
        } catch (e) {
            // The reader is already gone
        }
        try {
            if (connection.reader) connection.abortController?.abort();
        } catch (e) {
            // Nothing left to abort
        }
    }

    function clearLastEventIdHeader(headers) {
        for (let name of Object.keys(headers)) {
            if (name.toLowerCase() === 'last-event-id') delete headers[name];
        }
    }

    // ========================================
    // SSE PARSER
    // ========================================

    async function* parseSSE(connection, touch) {
        let reader = connection.reader;
        let lastEventId = connection.lastEventId;
        let decoder = new TextDecoder();
        let buffer = '';
        let hasData = false;
        let hasId = false;
        let message = {data: '', event: '', retry: null};
        let firstChunk = true;

        try {
            while (true) {
                let {done, value} = await reader.read();
                if (done) break;
                touch();

                let chunk = decoder.decode(value, {stream: true});
                // Strip leading BOM (U+FEFF) per SSE spec
                if (firstChunk) {
                    if (chunk.charCodeAt(0) === 0xFEFF) chunk = chunk.slice(1);
                    firstChunk = false;
                }
                buffer += chunk;

                // Split on \r\n, \r, or \n (SSE spec allows all three)
                let lines = buffer.split(/\r\n|\r|\n/);
                buffer = lines.pop() || '';

                for (let line of lines) {
                    if (!line) {
                        if (hasData || hasId || message.event) {
                            yield {...message, id: lastEventId, hasData, hasId};
                        }
                        hasData = false;
                        hasId = false;
                        message = {data: '', event: '', retry: null};
                        continue;
                    }

                    let colonIndex = line.indexOf(':');
                    if (colonIndex === 0) continue; // comment line

                    let field, value;
                    if (colonIndex < 0) {
                        // No colon: entire line is field name, value is empty string
                        field = line;
                        value = '';
                    } else {
                        field = line.slice(0, colonIndex);
                        value = line.slice(colonIndex + 1);
                        if (value[0] === ' ') value = value.slice(1);
                    }

                    if (field === 'data') {
                        message.data += (hasData ? '\n' : '') + value;
                        hasData = true;
                    } else if (field === 'event') {
                        message.event = value;
                    } else if (field === 'id') {
                        if (!value.includes('\0')) {
                            lastEventId = value;
                            hasId = true;
                        }
                    } else if (field === 'retry') {
                        let retryValue = parseInt(value, 10);
                        if (!isNaN(retryValue)) message.retry = retryValue;
                    }
                }
            }
        } finally {
            reader.releaseLock();
            // On the same tick as releaseLock(), so cleanup() or visibilityHandler 
            // calling connection.reader?.cancel() can't hit a released reader.
            connection.reader = null;
        }
    }

    // ========================================
    // STREAMING LOOP
    // ========================================

    // Starts streaming from a response. Handles reconnection by re-fetching
    // with the saved request context (no full pipeline re-run).
    async function handleSSEResponse(ctx, releaseRequest) {
        let element = ctx.sourceElement;
        let config = getConfig(element);
        let reconnectRequested = false;
        let closeReason = null;

        function release() {
            if (releaseRequest) {
                releaseRequest();
                releaseRequest = null;
            }
        }

        if (config.releaseOn === 'immediate') release();

        let connection = {
            url: ctx.request.action,
            config: config,
            abortController: { abort: ctx.request.abort, signal: ctx.request.signal },
            reader: null,
            lastEventId: '',
            delayCanceller: null,
            visibilityHandler: null,
            heartbeatTimer: null,
            lastActivity: Date.now(),
            wake: null,
            attempt: 0,
            cancelled: false,
            status: null
        };
        api.ypyProp(element).sse = connection;
        liveConnections.add(connection);

        let reconnect = () => {
            if (!element.isConnected || reconnectRequested) return;
            reconnectRequested = true;
            if (connection.delayCanceller) connection.delayCanceller();
            cancelReader(connection);
        };

        let paused = false;
        let unpauseResolver = null;
        let reconnectNow = false;

        // Heartbeat: a connection that gets no byte for config.heartbeat is closed and opened again.
        // A phone that slept leaves a stream that neither fails nor ends, so nothing else would notice.
        let heartbeatMs = () => ypy.parseInterval(config.heartbeat) || 0;
        let restart = () => {
            if (config.reconnect) reconnect();
            else cancelReader(connection);
        };
        let stall = () => {
            connection.heartbeatTimer = null;
            if (!element.isConnected || paused || !connection.reader) return;
            restart();
        };
        let touch = () => {
            connection.lastActivity = Date.now();
            clearTimeout(connection.heartbeatTimer);
            connection.heartbeatTimer = null;
            let ms = heartbeatMs();
            if (ms > 0) connection.heartbeatTimer = setTimeout(stall, ms);
        };

        // Called when the page comes back (shown again, visible, online). A wait for the next attempt
        // is skipped; a stream that has been silent for the heartbeat, or that `force` doubts, is
        // opened again at once. It never opens a second connection: it restarts this one.
        connection.wake = force => {
            if (!element.isConnected) return;
            if (config.pauseOnBackground && document.hidden) return;
            if (connection.delayCanceller) {
                connection.delayCanceller();
                return;
            }
            if (!connection.reader || reconnectRequested || !config.reconnect) return;
            let ms = heartbeatMs();
            if (!force && !(ms > 0 && Date.now() - connection.lastActivity >= ms)) return;
            reconnectNow = true;
            reconnect();
        };

        if (config.pauseOnBackground) {
            let visibilityHandler = () => {
                if (document.hidden) {
                    paused = true;
                    connection.reader?.cancel();
                } else if (paused) {
                    paused = false;
                    if (unpauseResolver) unpauseResolver();
                }
            };
            document.addEventListener('visibilitychange', visibilityHandler);
            connection.visibilityHandler = visibilityHandler;
        }

        connection.cancelled = false;
        if (!api.triggerEvent(element, 'ypy:sse:before:connection', {connection}) || connection.cancelled) {
            cleanup(element, 'cancelled');
            return;
        }

        connection.status = ctx.response.status;
        api.triggerEvent(element, 'ypy:sse:after:connection', {connection});

        let currentResponse = ctx.response.raw;

        try {
            while (element.isConnected) {
                // Reconnection (not on first iteration, we already have the response)
                if (connection.attempt > 0) {
                    // Wait while paused (tab backgrounded with pauseOnBackground)
                    if (paused) {
                        await new Promise(r => { unpauseResolver = r; });
                        unpauseResolver = null;
                        if (!element.isConnected) break;
                        connection.attempt = 1; // reset so delay doesn't escalate from pauses
                        reconnectRequested = true; // bypass maxAttempts check
                    }

                    if (!reconnectRequested) {
                        if (!config.reconnect || connection.attempt > config.reconnectMaxAttempts) break;
                    }

                    let baseDelay = ypy.parseInterval(config.reconnectDelay) ?? config.reconnectDelay;
                    let maxDelay = ypy.parseInterval(config.reconnectMaxDelay) ?? config.reconnectMaxDelay;
                    let delay = Math.min(
                        baseDelay * Math.pow(2, connection.attempt - 1),
                        maxDelay
                    );
                    if (config.reconnectJitter > 0 && !reconnectNow) {
                        let jitterRange = delay * config.reconnectJitter;
                        delay = Math.max(0, delay + (Math.random() * 2 - 1) * jitterRange);
                    }
                    if (reconnectNow) delay = 0;
                    reconnectNow = false;

                    connection.cancelled = false;
                    if (!api.triggerEvent(element, 'ypy:sse:before:connection', {connection}) || connection.cancelled) break;

                    await new Promise(r => {
                        connection.delayCanceller = r;
                        setTimeout(r, delay);
                    });
                    connection.delayCanceller = null;
                    if (!element.isConnected) break;

                    // Re-fetch using saved request context (no full pipeline re-run)
                    let ac = new AbortController();
                    connection.abortController = ac;
                    // The swap drops the content of a request whose signal is aborted, and the signal of
                    // the previous request now is: the context follows the request that is alive.
                    ctx.request.signal = ac.signal;
                    ctx.request.abort = () => ac.abort();
                    let timedOut = false;
                    let connectTimeout = ypy.parseInterval(config.connectTimeout) ?? config.connectTimeout;
                    let timeoutId = connectTimeout > 0 ? setTimeout(() => { timedOut = true; ac.abort(); }, connectTimeout) : null;
                    try {
                        clearLastEventIdHeader(ctx.request.headers);
                        if (connection.lastEventId) ctx.request.headers['Last-Event-ID'] = connection.lastEventId;
                        currentResponse = await fetch(ctx.request.action, {
                            ...ctx.request,
                            signal: ac.signal
                        });
                        clearTimeout(timeoutId);
                    } catch (e) {
                        clearTimeout(timeoutId);
                        if (ac.signal.aborted && !timedOut) break;
                        api.triggerEvent(element, 'ypy:sse:error', {connection, error: e});
                        reconnectRequested = false;
                        connection.attempt++;
                        continue;
                    }

                    if (!currentResponse.ok) {
                        api.triggerEvent(element, 'ypy:sse:error', {
                            connection,
                            error: new Error(`SSE reconnect failed with status ${currentResponse.status}`),
                            status: currentResponse.status
                        });
                        reconnectRequested = false;
                        connection.attempt++;
                        continue;
                    }

                    connection.status = currentResponse.status;
                    api.triggerEvent(element, 'ypy:sse:after:connection', {connection});
                    connection.attempt = 0;
                }

                // Stream messages
                reconnectRequested = false;

                try {
                    connection.reader = currentResponse.body.getReader();
                    touch();

                    for await (let msg of parseSSE(connection, touch)) {
                        if (!element.isConnected || reconnectRequested) break;

                        if (msg.hasId) {
                            connection.lastEventId = msg.id;
                            if (!msg.id) clearLastEventIdHeader(ctx.request.headers);
                        }

                        if (!msg.hasData && !msg.event) continue;

                        let pendingWork = [];
                        let detail = {
                            connection,
                            message: {data: msg.data, event: msg.event, id: msg.id},
                            cancelled: false,
                            waitUntil: promise => pendingWork.push(Promise.resolve(promise))
                        };
                        let shouldProcess = api.triggerEvent(element, 'ypy:sse:before:message', detail);

                        await Promise.all(pendingWork);
                        if (!shouldProcess || detail.cancelled) continue;

                        if (msg.retry != null) config.reconnectDelay = msg.retry;

                        if (detail.message.event) {
                            // ypy:release triggers early release
                            if (detail.message.event === 'ypy:release') release();

                            ypy.trigger(element, detail.message.event, {data: detail.message.data, id: detail.message.id});
                            api.triggerEvent(element, 'ypy:sse:after:message', {connection, message: detail.message});

                            // ypy-sse:close="eventname": close connection on matching event
                            let closeEvent = api.attributeValue(element, 'ypy-sse:close');
                            if (closeEvent && detail.message.event === closeEvent) {
                                closeReason = 'message';
                                connection.reader?.cancel();
                                return; // finally block calls cleanup
                            }
                            continue;
                        }

                        // Swap content using the ctx from core (target/swap already resolved)
                        ctx.text = detail.message.data;
                        // Always prevent empty swap for SSE - protects against empty data and
                        // ensures OOB-only messages don't clear target (regardless of allowEmptySwapAfterOOB)
                        if (!ctx.swap.includes('swapEmpty')) ctx.swap += ' swapEmpty:false';
                        await ypy.swap(ctx);
                        if (config.releaseOn === 'first') release();
                        api.triggerEvent(element, 'ypy:sse:after:message', {connection, message: detail.message});
                    }
                } catch (e) {
                    // core aborts its own controller, so check the error too
                    if (!connection.abortController?.signal?.aborted && e.name !== 'AbortError') {
                        api.triggerEvent(element, 'ypy:sse:error', {connection, error: e});
                    }
                }

                clearTimeout(connection.heartbeatTimer);
                connection.heartbeatTimer = null;
                if (!element.isConnected) break;

                connection.attempt++;
            }
        } finally {
            release();  // Always release when stream ends
            cleanup(element, closeReason ?? (element.isConnected ? 'ended' : 'removed'));
        }
    }

    // ========================================
    // ELEMENT PROCESSING
    // ========================================

    function processElement(element) {
        let connectUrl = api.attributeValue(element, 'ypy-sse:connect');
        if (!connectUrl) return;
        if (element._ypy?.sse) return; // already set up

        let ypyTrigger = api.attributeValue(element, 'ypy-trigger') || 'load';
        api.onTrigger(element, ypyTrigger, () => {
            if (element._ypy?.sse) return; // prevent duplicate connections
            ypy.ajax('GET', connectUrl, {source: element, timeout: getConfig(element).connectTimeout});
        });
    }

    // ========================================
    // CLEANUP
    // ========================================

    function cleanup(element, reason) {
        let connection = element?._ypy?.sse;
        if (!connection) return;

        connection.reader?.cancel?.();
        connection.abortController?.abort();
        clearTimeout(connection.heartbeatTimer);
        liveConnections.delete(connection);
        if (connection.delayCanceller) connection.delayCanceller();
        if (connection.visibilityHandler) {
            document.removeEventListener('visibilitychange', connection.visibilityHandler);
        }
        api.triggerEvent(element, 'ypy:sse:close', {connection, reason: reason || 'cleanup'});
        delete element._ypy.sse;
    }

    // ========================================
    // BACKWARD COMPATIBILITY
    // ========================================

    function checkLegacyAttributes(element) {
        for (let attribute of ['ypy-sse-connect', 'ypy-sse-close', 'ypy-sse-swap']) {
            if (!element.hasAttribute(attribute) || warnedLegacyAttributes.has(attribute)) continue;

            if (attribute === 'ypy-sse-swap') {
                console.warn('ypy: [ypy-sse] ypy-sse-swap is no longer supported. Unnamed SSE messages are swapped automatically. Named events are dispatched as DOM events.');
            } else {
                console.warn(`ypy: [ypy-sse] legacy attribute ${attribute} is deprecated; use ypy-sse:${attribute.slice(8)} instead`);
            }
            warnedLegacyAttributes.add(attribute);
        }
    }

    // ========================================
    // RESUME
    // ========================================

    // One set of listeners for the page, so a connection is never woken twice. `pageshow` also fires
    // when the page returns from the back/forward cache, where a stream may have died without a sound.
    function resume(event) {
        if (event.type === 'visibilitychange' && document.hidden) return;
        let force = event.type === 'online' || (event.type === 'pageshow' && event.persisted === true);
        for (let connection of [...liveConnections]) connection.wake?.(force);
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('pageshow', resume);
        window.addEventListener('online', resume);
        document.addEventListener('visibilitychange', resume);
    }

    // ========================================
    // EXTENSION REGISTRATION
    // ========================================

    ypy.registerExtension('ypy-sse', {
        init: (internalAPI) => {
            api = internalAPI;
        },

        ypy_config_request: (element, {ctx}) => {
            ctx.request.headers.Accept =
                `${ctx.request.headers.Accept ?? ctx.request.headers.accept ?? 'text/html'}, text/event-stream`;
            if (ctx.timeout != null) ctx.request.timeout = ctx.timeout;
        },

        // Intercept SSE responses before core consumes the body
        ypy_before_response: (element, detail) => {
            let ctx = detail.ctx;
            let contentType = ctx.response.raw.headers.get('Content-Type');
            if (!contentType?.includes('text/event-stream')) return;

            // Take over streaming; use extensionPromise to hold the request open
            clearTimeout(ctx.requestTimeout);
            let releaseRequest;
            ctx.extensionPromise = new Promise(resolve => releaseRequest = resolve);
            handleSSEResponse(ctx, releaseRequest).catch(e => {
                // an aborted stream is a normal end, not an error
                if (e.name !== 'AbortError') {
                    api.triggerEvent(element, 'ypy:sse:error', {error: e, url: ctx.request.action});
                }
            });
            return false;
        },

        ypy_after_process: (element) => {
            let mc = ypy.config.metaCharacter || ':';
            let processSSEElement = (element) => {
                checkLegacyAttributes(element);
                for (let name of ['connect', 'close']) {
                    let legacyAttr = `ypy-sse-${name}`;
                    if (!element.hasAttribute(legacyAttr)) continue;

                    let attr = (ypy.config.prefix || 'ypy-') + 'sse' + mc + name;
                    if (!element.hasAttribute(attr)) element.setAttribute(attr, element.getAttribute(legacyAttr));
                }
                processElement(element);
            };

            processSSEElement(element);
            let sseAttr = CSS.escape('ypy-sse' + mc + 'connect');
            let sseSelector = `[${sseAttr}]`;
            if (ypy.config.prefix) sseSelector += `,[${CSS.escape(ypy.config.prefix + 'sse' + mc + 'connect')}]`;
            element.querySelectorAll(`${sseSelector},[ypy-sse-connect],[ypy-sse-close],[ypy-sse-swap]`).forEach(processSSEElement);
        },

        ypy_before_cleanup: (element) => {
            cleanup(element);
        }
    });
})();
// SPDX-License-Identifier: MIT
(() => {
    let api;
    
    // Build a CSS selector for querySelectorAll, respecting prefix + metaCharacter
    function wsSelector(suffix) {
        let mc = ypy.config.metaCharacter || ':';
        let sel = `[${CSS.escape('ypy-ws' + mc + suffix)}]`;
        if (ypy.config.prefix) sel += `,[${CSS.escape(ypy.config.prefix + 'ws' + mc + suffix)}]`;
        return sel;
    }


    // ========================================
    // CONFIGURATION
    // ========================================
    
    function getConfig(element) {
        let ypyConfig = api.HCON.parse(api.attributeValue(element, 'ypy-config')).ws || {};

        return {
            reconnect: true,
            reconnectCodes: [
                1001, // Going Away
                1005, // No Status Received
                1006, // Abnormal Closure
                1011, // Internal Error
                1012, // Service Restart
                1013, // Try Again Later
                1014  // Bad Gateway
            ],
            reconnectDelay: 500,
            reconnectMaxDelay: 60000,
            reconnectMaxAttempts: Infinity,
            reconnectJitter: 0.3,
            pauseOnBackground: true,
            heartbeat: 0,
            maxOutgoingMessagesQueueSize: 100,
            ...ypy.config.ws, // global defaults
            ...ypyConfig // ypy-config overrides
        };
    }
    
    // ========================================
    // URL NORMALIZATION
    // ========================================
    
    function normalizeWebSocketUrl(url) {
        // Already a WebSocket URL
        if (url.startsWith('ws://') || url.startsWith('wss://')) {
            return url;
        }

        // Convert http(s):// to ws(s)://
        if (url.startsWith('http://')) {
            return 'ws://' + url.slice(7);
        }
        if (url.startsWith('https://')) {
            return 'wss://' + url.slice(8);
        }

        // Relative URL - build absolute ws(s):// URL
        let protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let host = window.location.host;
        
        if (url.startsWith('//')) {
            // Protocol-relative URL
            return protocol + url;
        }
        
        if (url.startsWith('/')) {
            // Absolute path
            return protocol + '//' + host + url;
        }
        
        // Relative path - resolve against current location
        let basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
        return protocol + '//' + host + basePath + url;
    }
    
    // ========================================
    // CONNECTIONS
    // ========================================
    
    const connections = new Set();
    // The element that owns each connection, for the listeners that wake them all
    const owners = new Map();
    // Elements whose socket pagehide closed on the way into the back/forward cache
    const parked = new Set();
    
    // The same pin as the one on fetch (config.mode): sockets stay on the page's own
    // origin unless config.mode is "cors". An unparsable URL is refused.
    function allowedOrigin(url) {
        if (ypy.config.mode === 'cors') return true;
        try { return new URL(url.replace(/^ws/, 'http')).origin === location.origin; } catch { return false; }
    }

    function getOrCreateConnection(url, element) {
        if (element._ypy.ws.connection) return element._ypy.ws.connection;
        element._ypy.ws.connectUrl = url;
        let normalizedUrl = normalizeWebSocketUrl(url);
        if (!allowedOrigin(normalizedUrl)) {
            api.triggerEvent(element, 'ypy:security:blocked', {reason: 'websocket-origin', url: normalizedUrl});
            return null;
        }

        let connection = {
            url: normalizedUrl,
            config: getConfig(element),
            socket: null,
            attempt: 0,
            timer: null,
            watchdog: null,
            lastActivity: Date.now(),
            queue: [],
            receiving: Promise.resolve(),
            sending: Promise.resolve(),
            abortController: null,
            visibilityHandler: null,
            cancelled: false
        };

        if (!api.triggerEvent(element, 'ypy:ws:before:connection', {connection}) || connection.cancelled) {
            api.triggerEvent(element, 'ypy:ws:close', {
                connection, reason: 'cancelled', code: null
            });
            return null;
        }

        element._ypy.ws.connection = connection;
        connections.add(connection);
        owners.set(connection, element);
        createWebSocket(element, connection);

        let config = connection.config;
        if (config.pauseOnBackground) {
            connection.visibilityHandler = () => {
                if (document.hidden) {
                    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
                        connection.socket.close();
                    }
                } else if (!connection.socket || connection.socket.readyState === WebSocket.CLOSED) {
                    connection.attempt = 0;
                    createWebSocket(element, connection);
                }
            };
            document.addEventListener('visibilitychange', connection.visibilityHandler);
        }

        return connection;
    }
    
    function cleanupConnection(element, connection) {
        if (connection.timer) clearTimeout(connection.timer);
        clearTimeout(connection.watchdog);
        connection.watchdog = null;
        owners.delete(connection);
        if (connection.visibilityHandler) {
            document.removeEventListener('visibilitychange', connection.visibilityHandler);
        }
        if (connection.abortController) {
            connection.abortController.abort();
        }
        connection.queue.length = 0;
        if (connection.socket) {
            try {
                if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
                    connection.socket.close();
                }
            } catch (e) {
                // Socket may already be in an invalid state
            }
        }
        if (element._ypy?.ws?.connection === connection) delete element._ypy.ws.connection;
        connections.delete(connection);
    }

    // Abort the old socket's listeners and close it, so it can neither report nor reconnect
    function discardSocket(connection) {
        if (connection.abortController) {
            connection.abortController.abort();
        }
        if (connection.socket) {
            let oldSocket = connection.socket;
            connection.socket = null;
            try {
                if (oldSocket.readyState === WebSocket.OPEN || oldSocket.readyState === WebSocket.CONNECTING) {
                    oldSocket.close();
                }
            } catch (e) {
                // Socket may already be in an invalid state
            }
        }
    }

    // Heartbeat: a socket that gets no message for config.heartbeat is closed and opened again. A phone
    // that slept leaves a socket that neither fails nor closes, so the reconnect would never run. The
    // timer starts with the socket, so a handshake that never finishes is caught as well.
    function watch(element, connection) {
        connection.lastActivity = Date.now();
        clearTimeout(connection.watchdog);
        connection.watchdog = null;
        let ms = ypy.parseInterval(connection.config.heartbeat) || 0;
        if (ms > 0) connection.watchdog = setTimeout(() => stale(element, connection), ms);
    }

    function stale(element, connection) {
        connection.watchdog = null;
        if (!connections.has(connection) || !connection.socket) return;
        if (!element.isConnected) {
            cleanupConnection(element, connection);
            return;
        }
        discardSocket(connection);
        api.triggerEvent(element, 'ypy:ws:close', {connection, reason: 'closed', code: null});
        if (connection.config.reconnect) {
            scheduleReconnect(element, connection);
        } else {
            cleanupConnection(element, connection);
        }
    }

    // The page came back (shown again, visible, online): open again at once whatever waits or hangs.
    // `force` is for the events that say the socket cannot be trusted (online, back/forward cache);
    // a visible tab only reopens a socket that has been silent for longer than the heartbeat.
    // It replaces the socket of a connection, it never adds a second one.
    function wake(force) {
        for (let connection of [...connections]) {
            let element = owners.get(connection);
            if (!element?.isConnected) continue;
            let config = connection.config;
            if (config.pauseOnBackground && document.hidden) continue;

            let socket = connection.socket;
            if (!socket || socket.readyState === WebSocket.CLOSED) {
                clearTimeout(connection.timer);
                connection.timer = null;
                connection.attempt = 0;
                createWebSocket(element, connection);
            } else if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
                let ms = ypy.parseInterval(config.heartbeat) || 0;
                let silent = ms > 0 && Date.now() - connection.lastActivity >= ms;
                if (!config.reconnect || !(force || silent)) continue;
                reopen(element, connection);
            }
        }
    }

    // Replace the socket of a connection with a new one, at once and with the backoff reset
    function reopen(element, connection) {
        let state = connection.socket?.readyState;
        discardSocket(connection);
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
            api.triggerEvent(element, 'ypy:ws:close', {connection, reason: 'closed', code: null});
        }
        connection.attempt = 0;
        clearTimeout(connection.timer);
        connection.timer = null;
        createWebSocket(element, connection);
    }

    // pagehide closed the sockets of a page that went into the back/forward cache: open them again.
    // The close event of such a socket may still be queued behind pageshow, so a connection that is
    // still closing is replaced without waiting for it.
    function restoreParked() {
        for (let element of [...parked]) {
            let url = element._ypy?.ws?.connectUrl;
            if (!element.isConnected || !url) {
                parked.delete(element);
                continue;
            }
            if (document.hidden && getConfig(element).pauseOnBackground) continue; // a visible tab brings it back
            parked.delete(element);
            let connection = element._ypy.ws.connection;
            if (!connection) getOrCreateConnection(url, element);
            else if (connection.socket?.readyState === WebSocket.CLOSING) reopen(element, connection);
        }
    }

    function createWebSocket(element, connection) {
        let url = connection.url;
        discardSocket(connection);

        try {
            connection.socket = new WebSocket(url, connection.config?.protocols);
            watch(element, connection);
            let ac = new AbortController();
            connection.abortController = ac;
            let opts = { signal: ac.signal };

            connection.socket.addEventListener('open', () => {
                watch(element, connection);
                if (element.isConnected) {
                    api.triggerEvent(element, 'ypy:ws:after:connection', {connection});
                } else {
                    cleanupConnection(element, connection);
                    return;
                }
                connection.attempt = 0;
                flushQueue(connection);
            }, opts);

            connection.socket.addEventListener('message', (event) => {
                watch(element, connection);
                connection.receiving = connection.receiving
                    .then(() => handleMessage(element, connection, event))
                    .catch(error => {
                        if (element.isConnected) api.triggerEvent(element, 'ypy:ws:error', {connection, error});
                    });
            }, opts);

            connection.socket.addEventListener('close', (event) => {
                if (event.target !== connection.socket) return;

                clearTimeout(connection.watchdog);
                connection.watchdog = null;
                if (element.isConnected) api.triggerEvent(element, 'ypy:ws:close', {
                    connection, reason: 'closed', code: event.code
                });

                if (!connections.has(connection)) return;

                let config = connection.config;
                if (config.pauseOnBackground && document.hidden) return;

                if (config.reconnect && config.reconnectCodes.includes(event.code) && element.isConnected) {
                    scheduleReconnect(element, connection);
                } else {
                    cleanupConnection(element, connection);
                }
            }, opts);

            connection.socket.addEventListener('error', (error) => {
                if (element.isConnected) api.triggerEvent(element, 'ypy:ws:error', {connection, error});
            }, opts);

        } catch (error) {
            if (element.isConnected) api.triggerEvent(element, 'ypy:ws:error', {connection, error});
        }
    }
    
    function scheduleReconnect(element, connection) {
        let config = connection.config;

        connection.attempt++;
        let attempt = connection.attempt;

        if (!config.reconnect || attempt > config.reconnectMaxAttempts) {
            cleanupConnection(element, connection);
            return;
        }

        let baseDelay = ypy.parseInterval(config.reconnectDelay) ?? config.reconnectDelay;
        let maxDelay = ypy.parseInterval(config.reconnectMaxDelay) ?? config.reconnectMaxDelay;

        let delay = Math.min(
            baseDelay * Math.pow(2, attempt - 1),
            maxDelay
        );

        if (config.reconnectJitter > 0) {
            let jitterRange = delay * config.reconnectJitter;
            delay = Math.max(0, delay + (Math.random() * 2 - 1) * jitterRange);
        }

        if (element.isConnected) {
            connection.cancelled = false;
            if (!api.triggerEvent(element, 'ypy:ws:before:connection', {connection}) || connection.cancelled) {
                api.triggerEvent(element, 'ypy:ws:close', {
                    connection, reason: 'cancelled', code: null
                });
                cleanupConnection(element, connection);
                return;
            }
        } else {
            cleanupConnection(element, connection);
            return;
        }

        connection.timer = setTimeout(() => {
            if (element.isConnected) {
                createWebSocket(element, connection);
            } else {
                cleanupConnection(element, connection);
            }
        }, delay);
    }
    
    // ========================================
    // MESSAGES
    // ========================================

    function transmitMessage(connection, element, message) {
        try {
            connection.socket.send(message.data);
            api.triggerEvent(element, 'ypy:ws:after:message:outgoing', {connection, message});
        } catch (error) {
            api.triggerEvent(element, 'ypy:ws:error', {connection, error});
        }
    }

    function flushQueue(connection) {
        while (connection.queue.length && connection.socket?.readyState === WebSocket.OPEN) {
            let queuedMessage = connection.queue.shift();
            transmitMessage(connection, queuedMessage.element, queuedMessage.message);
        }
    }

    async function sendMessage(element, event) {
        let owner = element.closest(wsSelector('connect'));
        let url = owner && api.attributeValue(owner, 'ypy-ws:connect');

        if (!url) {
            api.triggerEvent(element, 'ypy:ws:error', {
                url: null, error: 'No WebSocket connection found for element'
            });
            return;
        }

        let normalizedUrl = normalizeWebSocketUrl(url);
        let connection = owner._ypy?.ws?.connection;

        if (!connection) {
            api.triggerEvent(element, 'ypy:ws:error', { url: normalizedUrl, error: 'Connection not open' });
            return;
        }

        // Build headers using core's request context (same as HTTP requests)
        let ctx = api.createRequestContext(element, event);
        let headers = {...ctx.request.headers};
        delete headers['Accept'];

        // Build outgoing values from form data.
        let form = element.form || element.closest('form');
        let formData = api.collectFormData(element, form, event.submitter);

        // Preserve multi-value form fields (checkboxes, multi-selects)
        let values = {};
        for (let [key, value] of formData) {
            if (key in values) {
                values[key] = [].concat(values[key], value);
            } else {
                values[key] = value;
            }
        }

        // Merge ypy-vals after serialization to preserve JS types (numbers, booleans)
        let ypyValsResult = api.getAttributeObject(element, 'ypy-vals', obj => Object.assign(values, obj));

        let outgoingMessage = connection.sending.then(async () => {
            if (ypyValsResult) await ypyValsResult;
            delete values.headers;

            let pendingWork = [];
            let message = {
                headers,
                values,
                data: undefined
            };
            let detail = {
                connection,
                message,
                cancelled: false,
                waitUntil(promise) {
                    pendingWork.push(Promise.resolve(promise));
                }
            };
            let shouldSend = api.triggerEvent(element, 'ypy:ws:before:message:outgoing', detail);

            try {
                await Promise.all(pendingWork);
                if (!shouldSend || detail.cancelled) return;

                message.data ??= JSON.stringify({ ...message.values, headers: message.headers });
                if (!connections.has(connection)) {
                    api.triggerEvent(element, 'ypy:ws:error', {connection, error: 'Connection closed'});
                    return;
                }

                if (connection.socket?.readyState === WebSocket.OPEN) {
                    transmitMessage(connection, element, message);
                } else if (connection.queue.length >= connection.config.maxOutgoingMessagesQueueSize) {
                    api.triggerEvent(element, 'ypy:ws:error', {
                        connection,
                        error: 'Outgoing messages queue is full'
                    });
                } else {
                    connection.queue.push({element, message});
                }
            } catch (error) {
                api.triggerEvent(element, 'ypy:ws:error', {connection, error});
            }
        });
        connection.sending = outgoingMessage.catch(() => {});
        await outgoingMessage;
    }
    
    // ========================================
    // MESSAGE RECEIVING & ROUTING
    // ========================================
    
    async function handleMessage(element, connection, event) {
        let pendingWork = [];
        let message = {
            data: event.data,
            text() {
                let data = message.data;
                return typeof data === 'string'
                    ? Promise.resolve(data)
                    : data instanceof Blob
                        ? data.text()
                        : Promise.resolve(new TextDecoder().decode(data));
            },
            json() {
                return message.text().then(JSON.parse);
            }
        };

        if (!element.isConnected) {
            cleanupConnection(element, connection);
            return;
        }

        let detail = {
            connection,
            message,
            cancelled: false,
            waitUntil(promise) {
                pendingWork.push(Promise.resolve(promise));
            }
        };
        let shouldProcess = api.triggerEvent(element, 'ypy:ws:before:message:incoming', detail);

        await Promise.all(pendingWork);
        if (!shouldProcess || detail.cancelled) return;

        let json = null;
        let html;
        if (typeof message.data === 'string') {
            try {
                json = await message.json();
            } catch (e) {
                html = await message.text();
            }
        }

        // JSON with 'content' or 'payload' field: swap the HTML
        // Raw (non-JSON) string: swap the entire string as HTML
        // JSON without 'content'/'payload': data-only message, no swap (handle via events)
        if (json) {
            if (json.content !== undefined) {
                html = json.content;
            } else if (json.payload !== undefined) {
                html = json.payload; // backwards compat
                // Warn once per connection (not on every message)
                if (!connection._payloadWarnFired) {
                    console.warn('ypy: [ypy-ws] json.payload is deprecated; use json.content instead');
                    connection._payloadWarnFired = true;
                }
            }
        }
        if (html != null) {
            let target = json?.target || api.attributeValue(element, 'ypy-target');
            let swap = json?.swap || api.attributeValue(element, 'ypy-swap') || ypy.config.defaultSwap;
            if (!/(?:^|\s)swapEmpty(?::(?:true|false))?(?=\s|$)/.test(swap)) swap += ' swapEmpty:false';

            await ypy.swap({
                sourceElement: element,
                target: target || element,
                swap,
                select: json?.select ?? api.attributeValue(element, 'ypy-select'),
                selectOOB: api.attributeValue(element, 'ypy-select-oob'),
                text: html,
                transition: false
            });
        }

        api.triggerEvent(element, 'ypy:ws:after:message:incoming', {connection, message});
    }
    
    // ========================================
    // ELEMENT LIFECYCLE
    // ========================================
    
    function initializeElement(element) {
        api.ypyProp(element).ws ??= {};
        if (element._ypy.ws.initialized) return;

        let connectUrl = api.attributeValue(element, 'ypy-ws:connect');
        if (!connectUrl) return;

        let specString = api.attributeValue(element, 'ypy-trigger') || 'load';
        api.onTrigger(element, specString, () => {
            getOrCreateConnection(connectUrl, element);
        });
        element._ypy.ws.initialized = true;
    }
    
    function initializeSendElement(element) {
        api.ypyProp(element).ws ??= {};
        if (element._ypy.ws.sendInitialized) return;

        let specString = api.attributeValue(element, 'ypy-trigger');
        if (!specString) {
            specString = element.matches('form') ? 'submit' :
                         element.matches('input:not([type=button]):not([type=submit]),select,textarea') ? 'change' :
                         'click';
        }

        api.onTrigger(element, specString, async (evt) => {
            if (element.matches('form') && evt.type === 'submit') {
                evt.preventDefault();
            }
            await sendMessage(element, evt);
        });
        element._ypy.ws.sendInitialized = true;
    }
    
    function cleanupElement(element) {
        parked.delete(element);
        let connection = element._ypy?.ws?.connection;
        if (!connection) return;
        api.triggerEvent(element, 'ypy:ws:close', {
            connection, reason: 'removed', code: null
        });
        cleanupConnection(element, connection);
    }
    
    // ========================================
    // BACKWARD COMPATIBILITY
    // ========================================
    
    function checkLegacyAttributes(element) {
        if (element.hasAttribute('ypy-ws-connect') || element.hasAttribute('ypy-ws-send')) {
            console.warn('ypy: [ypy-ws] legacy attributes ypy-ws-connect and ypy-ws-send are deprecated; use ypy-ws:connect and ypy-ws:send instead');

            if (element.hasAttribute('ypy-ws-connect')) {
                let url = element.getAttribute('ypy-ws-connect');
                let mc = ypy.config.metaCharacter || ':';
                let attr = (ypy.config.prefix || 'ypy-') + 'ws' + mc + 'connect';
                if (!element.hasAttribute(attr)) {
                    element.setAttribute(attr, url);
                }
            }

            if (element.hasAttribute('ypy-ws-send')) {
                let mc = ypy.config.metaCharacter || ':';
                let attr = (ypy.config.prefix || 'ypy-') + 'ws' + mc + 'send';
                if (!element.hasAttribute(attr)) {
                    element.setAttribute(attr, '');
                }
            }
        }
    }
    
    // ========================================
    // EXTENSION REGISTRATION
    // ========================================
    
    ypy.registerExtension('ypy-ws', {
        init: (internalAPI) => {
            api = internalAPI;
            
            // Initialize default config if not set
            if (!ypy.config.ws) {
                ypy.config.ws = {};
            }
        },
        
        ypy_after_process: (element) => {
            const processNode = (node) => {
                checkLegacyAttributes(node);

                let send = api.attributeValue(node, 'ypy-ws:send');
                if (api.attributeValue(node, 'ypy-ws:connect') != null) {
                    initializeElement(node);
                }

                if (send != null) {
                    initializeSendElement(node);
                }
            };

            processNode(element);

            let sel = wsSelector('connect') + ',' + wsSelector('send') + ',[ypy-ws-connect],[ypy-ws-send]';
            element.querySelectorAll(sel).forEach(processNode);
        },
        
        ypy_before_cleanup: (element) => {
            cleanupElement(element);
        }
    });
    
    if (typeof window !== 'undefined' && window.ypy) {
        // Clean up all WS connections on page navigation to prevent browser errors
        window.addEventListener('pagehide', (event) => {
            connections.forEach((connection) => {
                // a page that goes into the back/forward cache comes back with no socket: remember whose
                if (event.persisted && owners.has(connection)) parked.add(owners.get(connection));
                if (connection.socket) {
                    connection.socket.close(1000, 'page navigating away');
                }
            });
        });

        // pageshow also fires when the page returns from the back/forward cache (`persisted`)
        window.addEventListener('pageshow', (event) => {
            wake(event.persisted === true);
            if (event.persisted) restoreParked();
        });
        window.addEventListener('online', () => wake(true));
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return;
            wake(false);
            restoreParked();
        });

    }
})();
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
// SPDX-License-Identifier: MIT
(() => {

    if (typeof navigation === 'undefined') return;

    let api;
    let activeCount = 0;
    let activeAborts = new Set();

    let cleanupNavigation = null;

    function shouldShowIndicator(elt) {
        let val = api.attributeValue(elt, 'ypy-browser-indicator');
        if (val != null && val !== 'false') return true;
        if (ypy.config.boostBrowserIndicator && elt._ypy?.boosted) return true;
        return false;
    }

    function listenForNavigate() {
        navigation.addEventListener('navigate', (event) => {
            if (!event.canIntercept) return;

            // save state before intercept (navigation.navigate() with {history:'replace'} wipes it)
            let savedState = history.state;

            let hideBrowserIndicator;
            event.intercept({
                handler: () => new Promise(r => { hideBrowserIndicator = r }),
                scroll: 'manual',
                focusReset: 'manual'
            });

            event.signal.addEventListener('abort', () => {
                if (activeCount > 0) {
                    activeAborts.forEach(abort => abort());
                    activeAborts.clear();
                    activeCount = 0;
                }
                cleanupNavigation = null;
            });

            cleanupNavigation = () => {
                hideBrowserIndicator();
                // restore after resolving (replaceState during a pending intercept aborts the signal early)
                try { history.replaceState(savedState, ''); } catch {}   // a browser may refuse the write (Safari: 100 per 10 seconds)
            };
        }, {once: true});
    }

    function startIndicator() {
        listenForNavigate();
        navigation.navigate(location.href, { history: 'replace' });
    }

    function stopIndicator() {
        if (cleanupNavigation) {
            cleanupNavigation();
            cleanupNavigation = null;
        }
    }

    ypy.registerExtension('ypy-browser-indicator', {
        init: (internalAPI) => {
            api = internalAPI;
        },

        ypy_before_history_update: () => {
            // stop indicator before YPY pushState fires a navigate event that would abort it
            stopIndicator();
        },

        ypy_before_request: (elt, detail) => {
            if (!shouldShowIndicator(elt)) return;
            detail.ctx._browserIndicator = true;
            activeCount++;
            if (activeCount === 1) startIndicator();
            // add abort after startIndicator() so it isn't present when navigate fires during navigation.navigate()
            if (detail.ctx.request?.abort) activeAborts.add(detail.ctx.request.abort);
        },

        ypy_finally_request: (elt, detail) => {
            if (!detail.ctx._browserIndicator) return;
            if (detail.ctx.request?.abort) activeAborts.delete(detail.ctx.request.abort);
            if (activeCount === 0) return;
            activeCount--;
            if (activeCount === 0) stopIndicator();
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-download.js
//
// An extension that triggers a file download instead of a
// DOM swap, with streaming progress events for progress bars.
//
// Activates when:
//   - ypy-swap="download" is set on the element
//   - server responds with Content-Disposition: attachment
//   - server responds with YPY-Download: <url> (fetches that
//     url as the download, useful when the backend cannot
//     stream the file directly as the YPY response)
//
// Usage:
//   <button ypy-get="/file.pdf" ypy-swap="download"
//           ypy-ext="download">Download</button>
//
// Events:
//   ypy:download:start    {total, ctx}
//   ypy:download:progress {loaded, total, percent, ctx}
//   ypy:download:complete {filename, size, ctx}
//==========================================================
(() => {
    let api;

    ypy.registerExtension('ypy-download', {
        init: (internalAPI) => {
            api = internalAPI;
        },
        ypy_before_response: (elt, {ctx}) => {
            let downloadUrl = ctx.response.headers.get('YPY-Download');
            if (downloadUrl) {
                // same pin as every request (config.mode: a URL on another origin is refused by the browser); a
                // failure is reported as ypy:error instead of an unhandled rejection
                (async () => streamDownload(ctx, await fetch(downloadUrl, {mode: ypy.config.mode, credentials: 'same-origin'}), downloadUrl))()
                    .catch(error => api.triggerEvent(elt, 'ypy:error', {ctx, error}));
                return;
            }
            let cd = ctx.response.headers.get('Content-Disposition');
            if (ctx.swap !== 'download' && !cd?.includes('attachment')) return;
            // a download has no fixed duration, so drop the request timeout and
            // hand core a promise so it holds the request until we finish
            clearTimeout(ctx.requestTimeout);
            ctx.extensionPromise = streamDownload(ctx, ctx.response.raw, ctx.request.action);
            return false;
        }
    });

    function streamDownload(ctx, response, url) {
        let sourceElement = ctx.sourceElement;
        return (async () => {
            let total = +response.headers.get('Content-Length') || null;
            api.triggerEvent(sourceElement, 'ypy:download:start', {total, ctx});
            let reader = response.body.getReader();
            let chunks = [], loaded = 0;
            while (true) {
                let {done, value} = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
                api.triggerEvent(sourceElement, 'ypy:download:progress', {
                    loaded, total, ctx,
                    percent: total ? Math.round(loaded / total * 100) : null
                });
            }
            let blob = new Blob(chunks, {
                type: response.headers.get('Content-Type') || 'application/octet-stream'
            });
            let filename = parseFilename(response.headers, url);
            let blobUrl = URL.createObjectURL(blob);
            Object.assign(document.createElement('a'), {href: blobUrl, download: filename}).click();
            URL.revokeObjectURL(blobUrl);
            api.triggerEvent(sourceElement, 'ypy:download:complete', {filename, size: blob.size, ctx});
        })();
    }

    function parseFilename(headers, url) {
        let cd = headers.get('Content-Disposition');
        if (cd) {
            // RFC 6266 / 5987: filename*=UTF-8''... takes precedence over filename=
            let star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
            if (star) {
                let raw = star[1].trim().replace(/^["']|["']$/g, '');
                try { return decodeURIComponent(raw); } catch { /* fall through */ }
            }
            let ascii = cd.match(/filename\s*=\s*(?:UTF-8'')?(?:"([^"]+)"|([^;]+))/i);
            if (ascii) return (ascii[1] || ascii[2]).trim();
        }
        return url.split('/').pop().split('?')[0] || 'download';
    }
})();
// SPDX-License-Identifier: MIT
(() =>{

    function normalizeSwapStyle(style) {
        return style === 'before' ? 'beforebegin' :
            style === 'after' ? 'afterend' :
                style === 'prepend' ? 'afterbegin' :
                    style === 'append' ? 'beforeend' : style;
    }

    let api;

    function insertPendingContent(ctx) {
        ctx.pending = api.attributeValue(ctx.sourceElement, "ypy-pending");
        if (!ctx.pending) {
            return
        }

        let sourceElt = document.querySelector(ctx.pending);
        if (!sourceElt) return;

        let target = ctx.target;

        if (typeof target === 'string') {
            target = document.querySelector(target);
        }
        if (!target) return;

        // Create pending div with reset styling
        let pendingDiv = document.createElement('div');
        pendingDiv.style.cssText = 'all: initial';
        pendingDiv.classList.add('ypy-pending');
        let sourceNodes = sourceElt instanceof HTMLTemplateElement ? sourceElt.content.childNodes : sourceElt.childNodes;
        for (let child of sourceNodes) pendingDiv.appendChild(child.cloneNode(true));

        // Set data-* for each request param
        if (ctx.pendingBody) {
            let keys = new Set(ctx.pendingBody.keys());
            for (let k of keys) {
                let values = ctx.pendingBody.getAll(k).filter(v => typeof v === 'string');
                if (!values.length) continue;
                let val = values.length === 1 ? values[0] : JSON.stringify(values);
                try {
                    pendingDiv.dataset[k] = val;
                } catch (e) {
                    try {
                        pendingDiv.setAttribute('data-' + k, val);
                    } catch (e2) { /* truly invalid name, skip */ }
                }
            }
        }

        let swapStyle = normalizeSwapStyle(ctx.swap);
        ctx.pendingHidden = [];

        if (swapStyle === 'innerHTML') {
            // Hide children of target
            for (let child of target.children) {
                child.style.display = 'none';
                ctx.pendingHidden.push(child);
            }
            target.appendChild(pendingDiv);
        } else if (['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(swapStyle)) {
            target.insertAdjacentElement(swapStyle, pendingDiv);
        } else {
            // Assume outerHTML-like behavior, Hide target and insert div after it
            target.style.display = 'none';
            ctx.pendingHidden.push(target);
            target.after(pendingDiv);
        }
        ctx.pendingDiv = pendingDiv;
        ypy.process(pendingDiv);
    }

    function removePendingContent(ctx) {
        if (!ctx.pendingDiv) return;

        // Remove pending div
        ctx.pendingDiv.remove();

        // Unhide any hidden elements
        for (let elt of ctx.pendingHidden) {
            elt.style.display = '';
        }
    }

    ypy.registerExtension('ypy-pending', {
        init: (internalAPI) => { api = internalAPI; },
        ypy_config_request: (elt, detail) => {
            let body = detail.ctx.request.body;
            if (body?.entries) detail.ctx.pendingBody = body;
        },
        ypy_before_request: (elt, detail) => {
            insertPendingContent(detail.ctx);
        },
        ypy_error : (elt, detail) => {
            removePendingContent(detail.ctx)
        },
        ypy_before_swap : (elt, detail) => {
            removePendingContent(detail.ctx)
        }
    });
})();
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
// SPDX-License-Identifier: MIT
// ypy-live extension: reactive live expressions + q() proxy + scope helpers.
// Hooks:
//   ypy:after:process  find new [ypy-live] elements and register them
//   ypy:before:swap    increment swap depth (defer recomputes)
//   ypy:finally:swap   decrement, fire one consolidated recompute
//   ypy:scope          inject q, wait, trigger, debounce into JS expression scopes
(() => {
    let api;
    let fns = new Set();
    let pending = false;
    let dbSym = Symbol();
    let observer = null;
    let recomputeBound = null;
    let inputBound = null;
    let swaps = 0;
    let warned = false;

    const OBSERVE_OPTIONS = { childList: true, subtree: true, attributes: true, characterData: true };

    let inputDebounceId = null;

    function ensureActive() {
        if (observer) return;
        recomputeBound = () => schedule();
        let inputDelay = ypy.parseInterval(ypy.config.live?.inputDebounce ?? 100) ?? 100;
        inputBound = () => {
            clearTimeout(inputDebounceId);
            inputDebounceId = setTimeout(schedule, inputDelay);
        };
        document.addEventListener('input', inputBound, true);
        document.addEventListener('change', recomputeBound, true);
        observer = new MutationObserver(recomputeBound);
        observer.observe(document.documentElement, OBSERVE_OPTIONS);
    }

    function deactivate() {
        if (!observer) return;
        clearTimeout(inputDebounceId);
        inputDebounceId = null;
        document.removeEventListener('input', inputBound, true);
        inputBound = null;
        document.removeEventListener('change', recomputeBound, true);
        observer.disconnect();
        observer = null;
        recomputeBound = null;
        warned = false;
    }

    function schedule() {
        if (pending) return;
        if (swaps > 0) return;
        pending = true;
        queueMicrotask(() => {
            // Detach observer while writing so our own writes don't queue records.
            observer?.disconnect();
            let startedAt = performance.now();
            fns.forEach(f => f());
            let elapsed = performance.now() - startedAt;
            if (!warned && elapsed > 16) {
                console.warn(`ypy: ypy-live expressions took ${elapsed.toFixed(1)}ms.`);
                warned = true;
            }
            if (fns.size === 0) {
                deactivate();
            } else {
                observer.observe(document.documentElement, OBSERVE_OPTIONS);
            }
            pending = false;
        });
    }

    let BOOLEAN_ATTRS = new Set('disabled required readonly open inert multiple autofocus novalidate default reversed loop muted controls autoplay playsinline formnovalidate async defer ismap typemustmatch allowfullscreen itemscope nomodule alpha headingreset'.split(' '));
    let PROPERTY_BINDING_ATTRS = new Set('checked value selected hidden'.split(' '));
    let STRING_BOOLEAN_ATTRS = new Set('contenteditable draggable spellcheck writingsuggestions'.split(' '));
    let NUMERIC_ATTRS = new Set('tabindex colspan rowspan maxlength minlength size span start rows cols width height min max step low high optimum'.split(' '));

    function normalizeAttrName(elt, name) {
        return elt instanceof HTMLElement ? name.toLowerCase() : name;
    }

    function readAttr(element, name) {
        name = normalizeAttrName(element, name);
        if (name.startsWith('aria-')) return readAria(element, name.slice(5));
        if (name.startsWith('data-')) return readData(element, name);
        if (name === 'value' && (element.type === 'number' || element.type === 'range')) {
            return element.value === '' ? null : element.valueAsNumber;
        }
        if (PROPERTY_BINDING_ATTRS.has(name)) return element[name];
        if (BOOLEAN_ATTRS.has(name) || name.startsWith('shadowroot') && name !== 'shadowrootmode' && name !== 'shadowrootslotassignment') return element.hasAttribute(name);
        let value = element.getAttribute(name);
        if (value != null && STRING_BOOLEAN_ATTRS.has(name)) try { return JSON.parse(value.toLowerCase()); } catch {}
        if (NUMERIC_ATTRS.has(name) && value?.trim() && isFinite(value)) return +value;
        return value;
    }

    function writeAttr(element, name, value) {
        name = normalizeAttrName(element, name);
        if (typeof value === 'function') {
            value = value(readAttr(element, name));
            if (typeof value?.then === 'function') throw new TypeError('ypy-live: assignment returned a promise');
        }
        if (name.startsWith('aria-')) {
            writeAria(element, name.slice(5), value);
        } else if (name.startsWith('data-')) {
            writeData(element, name, value);
        } else if (PROPERTY_BINDING_ATTRS.has(name)) {
            applyPropertyBinding(element, name, value);
        } else if (BOOLEAN_ATTRS.has(name) || name.startsWith('shadowroot') && name !== 'shadowrootmode' && name !== 'shadowrootslotassignment') {
            element.toggleAttribute(name, !!value);
        } else if (value == null) {
            element.removeAttribute(name);
        } else {
            element.setAttribute(name, String(value));
        }
    }

    function writeTargets(elts, target) {
        return target ? new Set(elts.map(target)) : elts;
    }

    function attrName(state, prop) {
        let prefix = state.prefix;
        return prefix + (prefix === 'data-' ? camelToKebab(prop) : prefix ? prop.toLowerCase() : prop);
    }

    function targetFor(state, elt, name) {
        if (!state.cascades) return state.prefix ? elt.hasAttribute(name) && elt : elt;
        while (elt && !elt.hasAttribute(name)) elt = elt.parentElement;
        return elt;
    }

    function writeProxy(state, prop, value, remove) {
        if (typeof prop !== 'string') return false;
        let name = attrName(state, prop);
        writeTargets(state.elts, state.cascades && (elt => targetFor(state, elt, name) || !remove && elt))
            .forEach(elt => elt && writeAttr(elt, name, value));
        return true;
    }

    let attrHandler = {
        get: (state, prop) => {
            if (!state.prefix && prop === 'class') return state.scope.class;
            if (typeof prop !== 'string') return undefined;
            let name = attrName(state, prop);
            let target = state.elts[0] && targetFor(state, state.elts[0], name);
            return target ? readAttr(target, name) : undefined;
        },
        set: (state, prop, value) => writeProxy(state, prop, value),
        deleteProperty: (state, prop) => writeProxy(state, prop, undefined, true),
        has: (state, prop) => state.prefix === 'data-' && typeof prop === 'string' &&
            !!state.elts[0] && !!targetFor(state, state.elts[0], attrName(state, prop)),
        ownKeys: state => {
            if (state.prefix !== 'data-') return [];
            let result = [], seen = new Set();
            for (let node = state.elts[0]; node; node = state.cascades ? node.parentElement : null) {
                for (let key of Object.keys(node.dataset)) if (key !== 'ypyPowered' && !seen.has(key)) {
                    seen.add(key);
                    result.push(key);
                }
            }
            return result;
        },
        getOwnPropertyDescriptor: (state, prop) => {
            if (state.prefix !== 'data-' || typeof prop !== 'string' || prop === 'ypyPowered') return;
            if (state.elts[0] && targetFor(state, state.elts[0], attrName(state, prop))) {
                return { enumerable: true, configurable: true };
            }
        }
    };

    function makeAttrProxy(elts, cascades, scope, prefix = '') {
        return new Proxy({ elts, cascades, scope, prefix }, attrHandler);
    }

    function applyStyleBinding(elt, value) {
        let prop = api.ypyProp(elt);
        let oldManaged = prop.liveStyles || new Set();
        let styles = [];

        if (typeof value === 'string') {
            for (let decl of value.split(';')) {
                let idx = decl.indexOf(':');
                if (idx < 0) continue;
                let k = decl.slice(0, idx).trim();
                let v = decl.slice(idx + 1).trim();
                if (k) styles.push([k, v]);
            }
        } else if (value && typeof value === 'object') {
            for (let [k, v] of Object.entries(value)) {
                styles.push([camelToKebab(k), v == null || v === '' ? null : String(v)]);
            }
        }

        let newManaged = new Set(styles.map(([k]) => k));
        for (let k of oldManaged) if (!newManaged.has(k)) elt.style.removeProperty(k);
        for (let [k, v] of styles) {
            if (v == null) elt.style.removeProperty(k);
            else elt.style.setProperty(k, v);
        }
        if (elt.style.length === 0) elt.removeAttribute('style');
        prop.liveStyles = newManaged;
    }

    function camelToKebab(s) {
        return s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    }

    function parseJSON(value) {
        try { return JSON.parse(value); } catch { return value; }
    }

    function readData(elt, name) {
        let raw = elt.getAttribute(name);
        return raw === null ? undefined : parseJSON(raw);
    }

    // Protect quoted text and regex literals, then recurse into template expressions.
    let CLASS_TOKEN = /(['"`\/])(?:\\.|(?!\1).)*\1|(?<![.\w$#])class(?=\s*[.?[])/gs;

    function rewriteClass(src) {
        return src.replace(CLASS_TOKEN, (token, quote) => {
            if (!quote) return 'attr.class';
            if (quote === '`') return token.replace(
                /\$\{((?:[^{}]|\{[^{}]*\})*)\}/g,
                (_, code) => '${' + rewriteClass(code) + '}'
            );
            return token;
        });
    }

    let stringAria = new Set('activedescendant details errormessage keyshortcuts label placeholder roledescription valuetext'.split(' '));
    let listAria = new Set('controls describedby dropeffect flowto labelledby owns relevant'.split(' '));
    function readClass(elt, name) {
        return !!elt?.classList.contains(name);
    }

    function writeClass(elt, name, value) {
        if (typeof value === 'function') {
            value = value(readClass(elt, name));
            if (typeof value?.then === 'function') throw new TypeError('ypy-live: assignment returned a promise');
        }
        elt.classList.toggle(name, !!value);
        if (!elt.classList.length) elt.removeAttribute('class');
    }

    function makeClassProxy(elts, cascades = false) {
        let first = elts[0];
        let classTarget = (elt, name) => cascades ? elt.closest('.' + CSS.escape(name)) : elt;
        let read = name => readClass(first && classTarget(first, name), name);
        let write = (name, value) => writeTargets(elts, elt => classTarget(elt, name) || elt)
            .forEach(elt => writeClass(elt, name, value));
        let methods = {
            assign(value) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    console.warn('ypy-live: class.assign expects an object.', { elts });
                    return;
                }
                writeClasses(write, value);
            },
            add: (...classes) => classes.forEach(name => write(name, true)),
            remove: (...classes) => classes.forEach(name => write(name, false)),
            contains: read,
            toggle(name, force) {
                let result = force ?? !read(name);
                write(name, current => force ?? !current);
                return result;
            },
            replace(oldClass, newClass) {
                if (cascades) {
                    if (!read(oldClass)) return false;
                    write(oldClass, false);
                    write(newClass, true);
                    return true;
                }
                let result;
                for (let i = 0; i < elts.length; i++) {
                    let next = elts[i].classList.replace(oldClass, newClass);
                    if (i === 0) result = next;
                }
                return result;
            }
        };
        return new Proxy({}, {
            get: (_, name) => {
                if (typeof name === 'string' && methods[name]) return methods[name];
                let list = !cascades && first?.classList;
                if (list && name in list) {
                    let member = list[name];
                    return typeof member === 'function' ? member.bind(list) : member;
                }
                if (!first) return name === Symbol.iterator ? () => [][Symbol.iterator]() : undefined;
                return typeof name === 'string' ? read(name) : undefined;
            },
            set: (_, name, value) => {
                if (typeof name !== 'string') return false;
                if (!cascades && name === 'value') for (let elt of elts) elt.classList.value = value;
                else write(name, value);
                return true;
            },
            deleteProperty: (_, name) => {
                if (typeof name !== 'string') return false;
                write(name, false);
                return true;
            },
            has: (_, name) => typeof name === 'string' && read(name),
            ownKeys: () => !cascades && first ? [...first.classList] : [],
            getOwnPropertyDescriptor: (_, name) => !cascades && read(name)
                ? { enumerable: true, configurable: true }
                : undefined
        });
    }

    function makeStateScope(elts, cascades) {
        let data, aria, classes, attr;
        let scope = {
            get data() { return data ||= makeAttrProxy(elts, cascades, null, 'data-'); },
            get aria() { return aria ||= makeAttrProxy(elts, cascades, null, 'aria-'); },
            get class() { return classes ||= makeClassProxy(elts, cascades); },
            get attr() { return attr ||= makeAttrProxy(elts, cascades, scope); }
        };
        return scope;
    }

    // `closest` reads as a cascading state bag and calls as a selector:
    //   closest.data.count      nearest owner of data-count
    //   closest('.card').data   query proxy for the nearest matching ancestor
    function makeClosest(elts) {
        let scope;
        return new Proxy(function () {}, {
            apply: (_, __, [selector]) => {
                let out = new Set();
                for (let elt of elts) {
                    let match = elt.closest?.(selector);
                    if (match) out.add(match);
                }
                return qProxy([...out]);
            },
            get: (_, p) => (scope ||= makeStateScope(elts, true))[p]
        });
    }

    function makeExpressionScope(elt) {
        let local = makeStateScope([elt], false);
        let closest = makeClosest([elt]);
        return {
            q: makeQ(elt),
            forEvent: (...args) => forEvent(elt, ...args),
            nextFrame: () => new Promise(r => requestAnimationFrame(r)),
            trigger: (type, detail, bubbles) => ypy.trigger(elt, type, detail, bubbles),
            debounce: getDebounce(elt),
            take: (name, scope) => applyTake([elt], name, scope),
            toggle: (name, ...values) => applyToggle(elt, name, ...values),
            attr: local.attr,
            insert: (pos, html) => insertContent(elt, pos, html),
            matches: sel => elt.matches(sel),
            style: elt.style,
            data: closest.data,
            aria: local.aria,
            local,
            closest
        };
    }

    function writeAria(elt, key, value) {
        let name = 'aria-' + key;
        if (value == null) elt.removeAttribute(name);
        else elt.setAttribute(name, listAria.has(key) && Array.isArray(value) ? value.join(' ') : String(value));
    }

    function readAria(elt, key) {
        let value = elt?.getAttribute('aria-' + key);
        if (value == null) return undefined;
        if (stringAria.has(key)) return value;
        if (listAria.has(key)) return value.trim() ? value.trim().split(/\s+/) : [];
        return parseJSON(value);
    }

    function writeData(elt, name, value) {
        if (value === undefined) elt.removeAttribute(name);
        else elt.setAttribute(name, typeof value === 'object' || parseJSON(value) !== value ? JSON.stringify(value) : value);
    }

    function applyPropertyBinding(elt, name, value) {
        if (name === 'checked' || name === 'selected') {
            let present = !!value;
            elt[name] = present;
            elt.toggleAttribute(name, present);
        } else if (value === false || value == null) {
            elt[name] = typeof elt[name] === 'boolean' ? false : '';
            elt.removeAttribute(name);
        } else if (value === true) {
            elt[name] = true;
            elt.setAttribute(name, '');
        } else {
            elt[name] = value;
            elt.setAttribute(name, String(value));
        }
    }

    function applyClassBinding(elt, name, value) {
        if (name === 'class') {
            applyMultiClass(elt, value);
        } else {
            writeClass(elt, name.slice(1), value);
        }
    }

    function writeClasses(write, value) {
        let written = [];
        if (typeof value === 'string') value = { [value]: true };
        if (value && typeof value === 'object') for (let [classes, enabled] of Object.entries(value)) {
            for (let name of classes.trim().split(/\s+/).filter(Boolean)) {
                written.push(name);
                write(name, !!enabled);
            }
        }
        return written;
    }

    function applyMultiClass(elt, value) {
        let prop = api.ypyProp(elt);
        let oldManaged = prop.liveClasses || new Set();
        let newManaged = new Set(writeClasses((name, value) => writeClass(elt, name, value), value));
        for (let c of oldManaged) if (!newManaged.has(c)) writeClass(elt, c, false);
        prop.liveClasses = newManaged;
    }

    function applyTake(targets, name, scope) {
        let isClass = name.startsWith('.');
        let key = isClass ? name.slice(1) : name;
        let isAria = name.startsWith('aria-');
        let auto = isClass ? '.' + key : '[' + name + ']';
        let root = scope == null ? targets[0]?.parentElement
            : scope.nodeType ? scope : null;
        let sources = root
            ? [root, ...root.querySelectorAll(auto)]
            : targets.length ? document.querySelectorAll(typeof scope === 'string' ? scope : scope?.from || auto) : [];
        let targetSet = new Set(targets);
        for (let s of sources) {
            if (targetSet.has(s)) continue;
            if (isClass) {
                s.classList?.remove(key);
                if (s.classList?.length === 0) s.removeAttribute('class');
            } else if (isAria) {
                s.setAttribute(name, 'false');
            } else {
                s.removeAttribute(name);
            }
        }
        for (let t of targets) {
            if (isClass) t.classList?.add(key);
            else if (isAria) t.setAttribute(name, 'true');
            else t.setAttribute(name, '');
        }
    }

    function forEvent(elt, ...args) {
        let target = elt || document;
        for (let a of args) if (a?.addEventListener) target = a;
        return new Promise(resolve => {
            let cleanups = [], done = false;
            let fire = v => { if (done) return; done = true; for (let c of cleanups) c(); resolve(v); };
            for (let a of args) {
                if (a == null || a?.addEventListener) continue;
                let ms = typeof a === 'number' ? a
                    : (typeof a === 'string' ? ypy.parseInterval(a) : undefined);
                if (ms > 0) {
                    let id = setTimeout(() => fire(a), ms);
                    cleanups.push(() => clearTimeout(id));
                } else if (typeof a === 'string') {
                    target.addEventListener(a, fire, { once: true });
                    cleanups.push(() => target.removeEventListener(a, fire));
                }
            }
        });
    }

    /**
     * Toggle or cycle a class, ARIA attribute, or attribute on an element.
     *
     * @param {Element} element - DOM element to mutate.
     * @param {string} name - Class (`.foo`) or attribute name.
     * @param {...(string|string[])} values - Cycle list, as separate arguments, a pipe-delimited string, or an array. Omit for binary flip.
     *
     * @example
     * toggle('.active')                      // toggle class
     * toggle('aria-expanded')                // flip "true" <-> "false"
     * toggle('hidden')                       // toggle attribute presence
     * toggle('data-view', 'grid', 'list')    // cycle attribute through values
     * toggle('data-view', 'grid|list|table') // same, pipe-delimited
     * toggle('.size', 'sm|md|lg')            // cycle classes (one at a time)
     * toggle('data-open', 'on|')             // 'on' <-> absent slot
     */
    function applyToggle(element, name, ...values) {
        let isClass = name.startsWith('.');
        let key = isClass ? name.slice(1) : name;
        let isAria = name.startsWith('aria-');
        let list = values.length > 1 ? values : values[0];
        if (typeof list === 'string') list = list.split('|').map(value => value.trim());

        if (!list) {
            if (isClass) element.classList.toggle(key);
            else if (isAria) {
                let cur = element.getAttribute(name);
                element.setAttribute(name, cur === 'true' ? 'false' : 'true');
            } else {
                element.toggleAttribute(name);
            }
            return;
        }
        if (isClass) {
            let cur = list.findIndex(v => v && element.classList.contains(v));
            if (cur >= 0) element.classList.remove(list[cur]);
            let next = list[(cur + 1) % list.length];
            if (next) element.classList.add(next);
        } else {
            let cur = list.indexOf(readAttr(element, name) ?? '');
            let next = list[(cur + 1) % list.length];
            writeAttr(element, name, next === '' ? undefined : next);
        }
    }

    function makeDebounce() {
        // Closure form keyed by fn.toString() (no async context to abort); promise form keyed null.
        let channels = new Map();
        let chan = key => channels.get(key) || (channels.set(key, { last: 0, reject: null }), channels.get(key));
        return (ms, fn) => {
            let ch = chan(fn ? fn.toString() : null);
            ch.reject?.(dbSym);
            ch.reject = null;
            let id = ++ch.last;
            if (fn) {
                setTimeout(() => id === ch.last && fn(), ms);
                return;
            }
            return new Promise((res, rej) => {
                ch.reject = rej;
                setTimeout(() => {
                    if (id !== ch.last) return;
                    ch.reject = null;
                    res();
                }, ms);
            });
        };
    }

    function getDebounce(elt) {
        let prop = api.ypyProp(elt);
        return prop.debounce || (prop.debounce = makeDebounce());
    }

    function makeQ(ctx, defaultRoot = document) {
        return selectorOrElt => {
            if (typeof selectorOrElt !== 'string') {
                return qProxy(
                    selectorOrElt?.nodeType ? [selectorOrElt] : [...(selectorOrElt || [])]
                );
            }
            let sel = selectorOrElt;
            let inMatch = sel.match(/^(.+)\s+in\s+(.+)$/);
            let roots = [defaultRoot];
            if (inMatch) {
                sel = inMatch[1];
                if (inMatch[2] === 'this' || inMatch[2] === 'me') {
                    roots = [ctx];
                } else {
                    roots = [...document.querySelectorAll(inMatch[2])];
                }
            }
            if (!roots.length) return qProxy([]);
            let qsa = s => {
                if (roots.length === 1) return [...roots[0].querySelectorAll(s)];
                let out = [], seen = new Set();
                for (let r of roots) for (let e of r.querySelectorAll(s)) {
                    if (!seen.has(e)) { seen.add(e); out.push(e); }
                }
                return out.sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
            };
            let dirMatch = sel.match(/^(next|previous|closest|first|last)\s+(.+)$/);
            let elts;
            if (dirMatch) {
                let [, dir, s] = dirMatch;
                let cdp = e => ctx.compareDocumentPosition(e);
                if (dir === 'closest') {
                    let c = ctx.closest?.(s);
                    elts = c ? [c] : [];
                } else {
                    let all = qsa(s);
                    if (dir === 'first') elts = all.slice(0, 1);
                    else if (dir === 'last') elts = all.slice(-1);
                    else if (dir === 'next') {
                        let n = all.find(e => cdp(e) & 4);
                        elts = n ? [n] : [];
                    } else {
                        let p = all.reverse().find(e => cdp(e) & 2);
                        elts = p ? [p] : [];
                    }
                }
            } else {
                elts = qsa(sel);
            }
            return qProxy(elts);
        };
    }

    let arrayMethods = 'map filter reduce reduceRight forEach some every find findIndex findLast findLastIndex flatMap flat slice indexOf lastIndexOf includes join at'.split(' ');

    let positions = { before: 'beforebegin', after: 'afterend', start: 'afterbegin', end: 'beforeend' };

    function insertContent(elt, pos, html) {
        let parent = elt.parentElement;
        if (pos === 'into') elt.innerHTML = html;
        else if (pos === 'replace') elt.outerHTML = html;
        else elt.insertAdjacentHTML(positions[pos], html);
        ypy.process(parent);
    }

    // Shared rather than a fresh closure per access, so an empty selection has a
    // stable identity and allocates nothing.
    let noop = () => undefined;

    // Find a DOM member's descriptor without invoking it. Reading the value off a
    // prototype would call accessors with the wrong `this` and throw.
    function domDescriptor(name) {
        for (let proto = HTMLElement.prototype; proto; proto = Object.getPrototypeOf(proto)) {
            let d = Object.getOwnPropertyDescriptor(proto, name);
            if (d) return d;
        }
    }

    function qProxy(elts) {
        let local, closest;
        let proxy = new Proxy({}, {
            get: (_, p) => {
                if (p === 'count') return elts.length;
                if (p === 'arr') return () => elts.slice();
                if (p === Symbol.iterator) return () => elts.values();
                if (p === 'q') return s => {
                    let out = new Set();
                    let isPositional = /^(next|previous)\s/.test(s);
                    for (let e of elts) for (let r of makeQ(e, isPositional ? e.parentElement : e)(s).arr()) out.add(r);
                    return qProxy([...out]);
                };
                if (p === 'trigger') return (t, d, b) => { elts.forEach(e => ypy.trigger(e, t, d, b)); return proxy; };
                if (p === 'insert') return (pos, s) => { elts.forEach(e => insertContent(e, pos, s)); return proxy; };
                if (p === 'take') return (name, scope) => { applyTake(elts, name, scope); return proxy; };
                if (p === 'toggle') return (name, ...values) => { elts.forEach(e => applyToggle(e, name, ...values)); return proxy; };
                if (p === 'attr' || p === 'class' || p === 'aria') {
                    return (local ||= makeStateScope(elts, false))[p];
                }
                if (p === 'data') return (closest ||= makeClosest(elts)).data;
                if (p === 'local') return local ||= makeStateScope(elts, false);
                if (p === 'closest') return closest ||= makeClosest(elts);
                if (arrayMethods.includes(p)) return elts[p].bind(elts);
                // if no elts, look up name in DOM api and determine if it's a function
                if (!elts.length) return typeof domDescriptor(p)?.value === 'function' ? noop : undefined;
                let v = elts[0]?.[p];
                if (typeof v === 'function') return (...a) => elts.map(e => e[p](...a))[0];
                if (v && typeof v === 'object') return qProxy(elts.map(e => e[p]));
                return v;
            },
            set: (_, prop, value) => {
                elts.forEach(elt => {
                    let current = elt[prop];
                    if (current == null || typeof current === 'function') elt[prop] = value;
                    else if (typeof value === 'function') {
                        let next = value(current);
                        if (typeof next?.then === 'function') throw new TypeError('ypy-live: assignment returned a promise');
                        elt[prop] = next;
                    } else {
                        elt[prop] = value;
                    }
                });
                schedule();
                return true;
            }
        });
        return proxy;
    }

    let liveQuery, bindPrefixes, ypyLiveNames;

    function buildLiveQuery() {
        let mc = ypy.config.metaCharacter || ':';
        let p = ypy.config.prefix;
        bindPrefixes = ['ypy-live' + mc];
        if (p) bindPrefixes.push(p + 'live' + mc);
        let extra = ypy.config.live?.bindPrefix;
        if (extra === undefined) {
            if (window.Alpine) {
                extra = '';
                console.warn('ypy-live: Alpine detected; set config.live.bindPrefix.');
            } else {
                extra = ':';
            }
        }
        if (extra) bindPrefixes.push(extra);
        ypyLiveNames = ['ypy-live'];
        if (p) ypyLiveNames.push(p + 'live');
        let bind = bindPrefixes.map(bp => `starts-with(name(), "${bp}")`).join(' or ');
        let effect = ypyLiveNames.map(n => `@${n}`).join(' or ');
        liveQuery = new XPathEvaluator().createExpression(`.//*[@*[${bind}] or ${effect}]`);
    }

    function extractBindingName(attrName) {
        for (let p of bindPrefixes) {
            if (attrName.startsWith(p) && attrName.length > p.length) return attrName.slice(p.length);
        }
    }

    function cleanupLive(elt) {
        let prop = elt._ypy;
        if (!prop?.liveRuns) return;
        for (let run of prop.liveRuns) fns.delete(run);
        delete prop.liveRuns;
        delete prop.effectRegistered;
        delete prop.bindings;
    }

    function processElement(elt) {
        if (elt.closest('[ypy-ignore]')) return;
        let prop = api.ypyProp(elt);
        if (!prop.effectRegistered) {
            let ypyLiveName = ypyLiveNames.find(n => elt.hasAttribute(n));
            if (ypyLiveName) {
                prop.effectRegistered = true;
                registerLive(elt, elt.getAttribute(ypyLiveName));
            }
        }
        prop.bindings ||= new Set();
        for (let a of elt.attributes) {
            let name = extractBindingName(a.name);
            if (!name || prop.bindings.has(name)) continue;
            prop.bindings.add(name);
            registerLive(elt, a.value, name);
        }
    }

    function processLive(root) {
        if (!liveQuery) buildLiveQuery();
        if (root.nodeType === 1) processElement(root);
        let iter = liveQuery.evaluate(root), node, nodes = [];
        while (node = iter.iterateNext()) nodes.push(node);
        for (node of nodes) processElement(node);
    }

    function registerLive(elt, code, attrName) {
        ensureActive();
        let binding = attrName !== undefined;
        let debounce = getDebounce(elt);
        let hasAwait = /\bawait\b/.test(code);
        let overlapping = !binding && hasAwait;
        let isAsync = !binding || hasAwait;
        let exec;
        let running = false;
        let run = async () => {
            if (!elt.isConnected) {
                fns.delete(run);
                return;
            }
            if (overlapping && running) return;
            running = overlapping;
            try {
                exec ||= api.executeJavaScript(elt, { debounce }, code, binding, isAsync, true);
                let value = isAsync ? await exec() : exec();
                if (binding) {
                    writeAttrBinding(elt, attrName, value);
                    if (isAsync) observer?.takeRecords();
                }
            } catch (e) {
                if (e !== dbSym) console.error('ypy-live expression failed', e, binding ? { elt, attr: attrName } : { elt });
            } finally {
                if (overlapping) queueMicrotask(() => running = false);
            }
        };
        fns.add(run);
        let prop = api.ypyProp(elt);
        prop.liveRuns = prop.liveRuns || new Set();
        prop.liveRuns.add(run);
        run();
    }

    function writeAttrBinding(elt, attrName, value) {
        if (typeof value === 'function') throw new TypeError('ypy-live: binding returned a function');
        if (attrName.startsWith('?')) {
            elt.toggleAttribute(attrName.slice(1), !!value);
            return;
        }
        if (attrName === 'text') {
            let s = value == null ? '' : String(value);
            if (elt.textContent !== s) elt.textContent = s;
            return;
        }
        if (attrName === 'html') {
            let s = value == null ? '' : String(value);
            if (elt.innerHTML !== s) elt.innerHTML = s;
            return;
        }
        if (attrName === 'style') { applyStyleBinding(elt, value); return; }
        if (attrName === 'class' || attrName.startsWith('.')) {
            applyClassBinding(elt, attrName, value);
            return;
        }
        if (readAttr(elt, attrName) === value) return;
        writeAttr(elt, attrName, value);
    }

    ypy.live = {
        q: s => makeQ(document.documentElement)(s),
        debounce: makeDebounce(),
        refresh: () => schedule(),
        take: (target, name, scope) => applyTake(ypy.live.q(target).arr(), name, scope),
        toggle: (target, name, ...values) => ypy.live.q(target).forEach(e => applyToggle(e, name, ...values)),
        forEvent: (...args) => forEvent(null, ...args),
        nextFrame: () => new Promise(r => requestAnimationFrame(r))
    };
    ypy.live.$ = ypy.live.q;

    ypy.registerExtension('ypy-live', {
        init: (internalAPI) => {
            api = internalAPI;
        },
        ypy_before_cleanup: (elt) => {
            cleanupLive(elt);
        },
        ypy_before_morph_attr: (elt, detail) => {
            if (!liveQuery) buildLiveQuery();
            if (bindPrefixes.some(p => detail.attrName.startsWith(p))) cleanupLive(elt);
        },
        ypy_after_process: (elt) => {
            processLive(elt);
        },
        ypy_before_swap: () => {
            swaps++;
        },
        ypy_finally_swap: () => {
            if (--swaps === 0 && fns.size > 0) schedule();
        },
        ypy_scope: (elt, detail) => {
            let prop = api.ypyProp(elt);
            Object.assign(detail.scope, prop.liveScope ||= makeExpressionScope(elt));
            detail.code = rewriteClass(detail.code);
            if (ypy.config.live?.useDollar) detail.scope.$ = detail.scope.q;
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-history-cache.js
//
// Pages kept in sessionStorage for back and forward (see historyCache in the configuration).
//
// historyCache.encrypt seals the snapshots with WebCrypto (AES-GCM, a 256 bit key made for the
// session, a new IV for each snapshot, the snapshot id as additional data), so what a page showed
// is not readable in the storage of the browser:
//
//   ypy.config.historyCache = {encrypt: true}       // the key is kept in sessionStorage: the
//                                                   // snapshots survive a reload of the tab
//   ypy.config.historyCache = {encrypt: 'memory'}   // the key lives in memory only: after a reload
//                                                   // the old snapshots can not be read and the
//                                                   // pages come from the server
//
// ypy.history.clear() forgets every snapshot and also replaces the key. Without WebCrypto (a page
// that is not a secure context) nothing is stored: a snapshot is never written in the clear when
// encryption was asked for. The key is as safe as the page itself: a script of the page can read
// it, so this protects the storage at rest, not the page from its own scripts. Sealing is
// asynchronous, so ypy:history:cache:after:save fires when the snapshot is stored. A restore of a
// sealed snapshot is asynchronous as well: if a ypy:history:cache:hit listener cancels it, or the
// snapshot can not be opened, the page is reloaded instead of requested.
//==========================================================
(() => {
    let api;
    let _currentId = null;
    let _raw = null;        // the key of the session, base64
    let _sealKey = null;    // {raw, key: Promise<CryptoKey>}
    let _gen = 0;           // grows when the key is replaced: a snapshot sealed before is dropped
    const KEY_NAME = 'ypy-history-key';

    const INDEX_KEY = 'ypy-history-index';

    function cfg() {
        return ypy.config.historyCache;
    }

    function prefixSelector(s) {
        return ['ypy-', 'data-ypy-', ypy.config.prefix].filter(Boolean).map(p => s.replaceAll('ypy-', p)).join(',');
    }

    function canUseStorage() {
        try {
            sessionStorage.setItem('__ypy_test__', '1');
            sessionStorage.removeItem('__ypy_test__');
            return true;
        } catch (_) { return false; }
    }

    function genId() {
        return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    }

    function getHistoryTarget() {
        return ypy.find(prefixSelector('[ypy-history-elt]')) || document.body;
    }

    const ATTR_VALUE   = 'data-ypy-history-value';
    const ATTR_CHECKED = 'data-ypy-history-checked';
    const ATTR_SCROLL  = 'data-ypy-history-scroll';

    // A field the browser itself is told not to remember (password, autocomplete off, a card or a one-time
    // code) is not remembered here either: neither what was typed nor the value the server rendered.
    // Hidden fields are kept on purpose: they hold no secret from a script of the page, and a restored form
    // that lost its token could not be submitted.
    function isSensitive(el) {
        return el.type?.toLowerCase() === 'password' ||
            /(?:^|\s)(?:off|one-time-code|cc-\S+|current-password|new-password)(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
    }

    function annotateState(root) {
        root.querySelectorAll('input, textarea, select').forEach(el => {
            let type = el.type?.toLowerCase();
            if (type === 'file' || isSensitive(el)) return;
            if (type === 'checkbox' || type === 'radio') {
                if (el.checked) el.setAttribute(ATTR_CHECKED, '1');
            } else if (el.tagName === 'SELECT' && el.multiple) {
                let selected = Array.from(el.options).filter(o => o.selected).map(o => o.value);
                if (selected.length) el.setAttribute(ATTR_VALUE, JSON.stringify(selected));
            } else if (el.value) {
                el.setAttribute(ATTR_VALUE, el.value);
            }
        });
        root.querySelectorAll('*').forEach(el => {
            if (el.scrollTop > 0 || el.scrollLeft > 0)
                el.setAttribute(ATTR_SCROLL, `${el.scrollTop},${el.scrollLeft}`);
        });
    }

    function restoreAnnotations(root) {
        root.querySelectorAll(`[${ATTR_CHECKED}]`).forEach(el => {
            el.checked = true;
            el.removeAttribute(ATTR_CHECKED);
        });
        root.querySelectorAll(`[${ATTR_VALUE}]`).forEach(el => {
            let raw = el.getAttribute(ATTR_VALUE);
            if (el.tagName === 'SELECT' && el.multiple) {
                let values = JSON.parse(raw);
                Array.from(el.options).forEach(o => { o.selected = values.includes(o.value); });
            } else {
                el.value = raw;
            }
            el.removeAttribute(ATTR_VALUE);
        });
        root.querySelectorAll(`[${ATTR_SCROLL}]`).forEach(el => {
            let [top, left] = el.getAttribute(ATTR_SCROLL).split(',').map(Number);
            el.scrollTop = top;
            el.scrollLeft = left;
            el.removeAttribute(ATTR_SCROLL);
        });
    }

    function cleanContent(elt) {
        let clone = elt.cloneNode(true);
        let requestClasses = (ypy.config.classes?.request ?? '').split(/\s+/).filter(Boolean);
        for (let cls of requestClasses) clone.querySelectorAll('.' + CSS.escape(cls)).forEach(el => el.classList.remove(...requestClasses));
        clone.querySelectorAll('input, textarea').forEach(el => {
            if (!isSensitive(el)) return;
            el.removeAttribute('value');
            if (el.tagName === 'TEXTAREA') el.textContent = '';
        });
        clone.querySelectorAll('[disabled][data-disabled-by-ypy]').forEach(el => {
            el.removeAttribute('disabled');
            el.removeAttribute('data-disabled-by-ypy');
        });
        return clone.outerHTML;
    }

    // --- Stamp the current history entry with an id and track it ---

    function stampCurrentEntry() {
        let state = history.state || { ypy: true };
        let id = state.ypyId;
        if (!id) {
            id = genId();
            // a browser may refuse the write (Safari: 100 per 10 seconds): the entry is then not stamped and a
            // return to it is a cache miss
            try { history.replaceState({ ...state, ypyId: id }, '', location.href); } catch {}
        }
        _currentId = id;
    }

    // --- sessionStorage (LRU index of ypyIds) ---

    function readIndex() {
        try { return JSON.parse(sessionStorage.getItem(INDEX_KEY)) || []; } catch { return []; }
    }

    function writeIndex(index) {
        sessionStorage.setItem(INDEX_KEY, JSON.stringify(index));
    }

    function store(ypyId, data) {
        let index = readIndex().filter(id => id !== ypyId);
        while (index.length >= cfg().size) {
            sessionStorage.removeItem('ypy-history-' + index.shift());
        }
        while (true) {
            try {
                sessionStorage.setItem('ypy-history-' + ypyId, data);
                index.push(ypyId);
                writeIndex(index);
                return true;
            } catch (e) {
                if (index.length === 0) return false;
                sessionStorage.removeItem('ypy-history-' + index.shift());
            }
        }
    }

    // --- encryption (historyCache.encrypt) ---

    const b64 = bytes => btoa(String.fromCharCode(...bytes));
    const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const encrypting = () => cfg().encrypt ? cfg().encrypt === 'memory' ? 'memory' : 'session' : null;

    // the key of the session, made when `create` says so; the one in sessionStorage survives a reload
    function rawKey(create) {
        if (!_raw && encrypting() === 'session') try { _raw = sessionStorage.getItem(KEY_NAME); } catch (_) { /* no storage */ }
        if (!_raw && create) {
            _raw = b64(crypto.getRandomValues(new Uint8Array(32)));
            if (encrypting() === 'session') try { sessionStorage.setItem(KEY_NAME, _raw); } catch (_) { /* memory only */ }
        }
        return _raw;
    }

    function cryptoKey(create) {
        let raw = rawKey(create);
        if (!raw) return null;
        if (_sealKey?.raw !== raw) {
            _sealKey = {raw, key: crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt'])};
        }
        return _sealKey.key;
    }

    async function seal(ypyId, entry) {
        let iv = crypto.getRandomValues(new Uint8Array(12));
        let data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(ypyId)},
            await cryptoKey(true), new TextEncoder().encode(JSON.stringify(entry)));
        return JSON.stringify({enc: 1, iv: b64(iv), data: b64(new Uint8Array(data))});
    }

    async function open(ypyId, record) {
        let data = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(record.iv), additionalData: new TextEncoder().encode(ypyId)},
            await cryptoKey(false), unb64(record.data));
        return JSON.parse(new TextDecoder().decode(data));
    }

    // Stores a snapshot. Returns true, or false when it could not be stored; with encryption it
    // returns the promise of that, so the caller can wait for the snapshot to be there.
    function saveToStorage(ypyId, entry) {
        if (!canUseStorage() || cfg().size <= 0) return false;
        if (!encrypting()) return store(ypyId, JSON.stringify(entry));
        if (!crypto?.subtle) {
            console.warn('ypy-history-cache: encrypt needs WebCrypto (a secure context); the page is not cached');
            return false;
        }
        let gen = _gen;
        return seal(ypyId, entry).then(data => gen === _gen && store(ypyId, data), () => false);
    }

    function getFromStorage(ypyId) {
        try { return JSON.parse(sessionStorage.getItem('ypy-history-' + ypyId)); } catch { return null; }
    }

    // --- save / get ---


    function saveCurrentPage(targetId) {
        targetId = targetId || _currentId;
        if (!targetId) return;
        if (ypy.find(prefixSelector('[ypy-history="false"]'))) return;

        let target = getHistoryTarget();
        annotateState(target);
        let head = document.head.outerHTML;
        let scroll = window.scrollY;
        let title = document.title;

        let detail = { target, head };
        if (api.triggerEvent(document, 'ypy:history:cache:before:save', detail) === false) return;
        let content = cleanContent(target);
        head = detail.head;

        let saved = saveToStorage(targetId, { content, head, scroll, title });
        let announce = () => api.triggerEvent(document, 'ypy:history:cache:after:save', { content, head, scroll, title });
        saved instanceof Promise ? saved.then(announce) : announce();
    }

    function getCachedContent() {
        let id = history.state?.ypyId;
        if (!id) return null;
        return canUseStorage() ? getFromStorage(id) : null;
    }

    async function restoreFromCache(item) {
        let detail = { head: item.head, ready: null };
        api.triggerEvent(document, 'ypy:history:cache:before:restore', detail);
        if (detail.ready) await detail.ready;

        let cachedHTML = item.content;
        let restoreSwapTarget = getHistoryTarget();
        let restoreSwapStyle = cfg().swapStyle;
        let ctx = {
            sourceElement: document.body,
            target: restoreSwapTarget,
            swap: restoreSwapStyle,
            text: cachedHTML,
            transition: ypy.config.transitions ?? false
        };
        await ypy.swap(ctx);

        document.title = item.title || document.title;
        requestAnimationFrame(() => {
            window.scrollTo(0, item.scroll || 0);
            restoreAnnotations(getHistoryTarget());
            detail.item = item;
            api.triggerEvent(document, 'ypy:history:cache:after:restore', detail);
        });
    }

    // Forgets every snapshot of this tab (call it when the user signs out). With encryption the key
    // is replaced too, so a snapshot that was being sealed, or one that is left somewhere, is lost.
    function clearAll() {
        _gen++;
        _raw = _sealKey = null;
        try {
            for (let key of Object.keys(sessionStorage)) {
                if (key === INDEX_KEY || key.startsWith('ypy-history-')) sessionStorage.removeItem(key);   // the key too
            }
        } catch (_) { /* storage unavailable: nothing was stored */ }
        if (encrypting() && crypto?.subtle) rawKey(true);   // the new key
    }

    // The restore of a sealed snapshot: the core was told to wait, so whatever goes wrong here is a reload.
    async function restoreSealed(ypyId, record, path) {
        let item;
        try {
            item = await open(ypyId, record);
        } catch (_) {
            sessionStorage.removeItem('ypy-history-' + ypyId);
            api.triggerEvent(document, 'ypy:history:cache:miss', { path, refreshOnMiss: true });
            return location.reload();
        }
        let hitDetail = { path, item };
        if (api.triggerEvent(document, 'ypy:history:cache:hit', hitDetail) === false) return location.reload();
        restoreFromCache(hitDetail.item);
    }

    ypy.registerExtension('ypy-history-cache', {
        init: (internalAPI) => {
            api = internalAPI;
            (ypy.history ??= {}).clear = clearAll;
            ypy.config.historyCache            ??= {};
            ypy.config.historyCache.size          ??= 10;
            ypy.config.historyCache.refreshOnMiss ??= false;
            ypy.config.historyCache.disable       ??= false;
            ypy.config.historyCache.swapStyle     ??= 'outerSync';
            ypy.config.historyCache.encrypt       ??= false;
            // Only stamp if core already tagged this entry (YPY-navigated page).
            // If history.state is null this is a fresh/POST-result page - leave it
            // alone so F5 still triggers the browser's resubmit prompt.
            if (history.state?.ypy) stampCurrentEntry();
        },

        // Before core pushes/replaces, save the outgoing page
        ypy_before_history_update: (elt, detail) => {
            if (cfg().disable) return;
            stampCurrentEntry();
            saveCurrentPage();
        },

        // After core pushes/replaces, stamp the new entry and track it
        ypy_after_history_update: () => {
            if (cfg().disable) return;
            stampCurrentEntry();
        },

        ypy_before_history_restore: (elt, detail) => {
            if (cfg().disable) return;

            let outgoingId = _currentId;
            let destinationId = history.state?.ypyId;

            if (outgoingId && outgoingId !== destinationId) {
                saveCurrentPage(outgoingId);
            }

            if (!destinationId) {
                stampCurrentEntry();
            } else {
                _currentId = destinationId;
            }

            let item = getCachedContent();
            if (item?.enc) {
                // sealed: it can only be opened without a key if there is one to open it
                if (encrypting() && rawKey(false)) {
                    detail.cancelled = true;
                    restoreSealed(destinationId, item, detail.path);
                    return false;
                }
                sessionStorage.removeItem('ypy-history-' + destinationId);
                item = null;
            }
            if (!item) {
                let missDetail = { path: detail.path, refreshOnMiss: cfg().refreshOnMiss };
                api.triggerEvent(document, 'ypy:history:cache:miss', missDetail);
                if (missDetail.refreshOnMiss) { location.reload(); return false; }
                return;
            }

            let hitDetail = { path: detail.path, item };
            if (api.triggerEvent(document, 'ypy:history:cache:hit', hitDetail) === false) return;

            detail.cancelled = true;
            restoreFromCache(hitDetail.item);
            return false;
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-upsert.js
//
// An extension to add 'upsert' swap style that updates
// existing elements by ID and inserts new ones.
//
// Modifiers:
//   key:attr - attribute name for sorting (default: id)
//   sort - sort ascending
//   sort:desc - sort descending
//   prepend - prepend elements without keys (default: append)
//==========================================================
(() => {
    let api;
    
    ypy.registerExtension('ypy-upsert', {
        init: (internalAPI) => {
            api = internalAPI;
        },
        ypy_process_upsert: (templateElt, detail) => {
            let {ctx, tasks} = detail;
            let swapSpec = {style: 'upsert'};
            let key = templateElt.getAttribute('key');
            let sort = templateElt.getAttribute('sort');
            let prepend = templateElt.hasAttribute('prepend');
            if (key) swapSpec.key = key;
            if (sort !== null) swapSpec.sort = sort || true;
            if (prepend) swapSpec.prepend = true;
            tasks.push({
                type: 'partial',
                fragment: templateElt.content.cloneNode(true),
                target: api.attributeValue(templateElt, 'ypy-target'),
                swapSpec,
                sourceElement: ctx.sourceElement
            });
        },
        handle_swap: (style, target, fragment, swapSpec) => {
            if (style === 'upsert') {
                let keyAttr = swapSpec.key || 'id';
                let desc = swapSpec.sort === 'desc';
                let firstChild = target.firstChild;
                
                let getKey = (el) => el.getAttribute(keyAttr) || el.id;
                
                let compare = (a, b) => {
                    let result = a.localeCompare(b, undefined, {numeric: true});
                    return desc ? -result : result;
                };
                
                for (let newEl of Array.from(fragment.children)) {
                    let id = newEl.id;
                    if (id) {
                        let existing = document.getElementById(id);
                        if (existing) {
                            existing.replaceWith(newEl);
                            continue;
                        }
                    }
                    
                    let newKey = getKey(newEl);
                    if (!newKey) {
                        if (swapSpec.prepend) {
                            target.insertBefore(newEl, firstChild);
                        } else {
                            target.appendChild(newEl);
                        }
                        continue;
                    }
                    
                    let inserted = false;
                    for (let child of target.children) {
                        let childKey = getKey(child);
                        if (childKey && compare(newKey, childKey) < 0) {
                            target.insertBefore(newEl, child);
                            inserted = true;
                            break;
                        }
                    }
                    
                    if (!inserted) {
                        target.appendChild(newEl);
                    }
                }
                return true;
            }
            return false;
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-alpine-compat.js
//
// Alpine.js compatibility extension for YPY
// Initializes Alpine on fragments before swap
// and preserves Alpine state during morph operations
//==========================================================
(() => {
    let api;
    let deferCount = 0;

    function maybeFlush() {
        if (deferCount > 0) deferCount--;
        if (deferCount === 0 && window.Alpine?.flushAndStopDeferringMutations) {
            window.Alpine.flushAndStopDeferringMutations();
        }
    }

    ypy.registerExtension('ypy-alpine-compat', {
        init: (internalAPI) => {
            api = internalAPI;
            
            // Override isSoftMatch to handle Alpine reactive IDs
            let originalIsSoftMatch = api.isSoftMatch;
            api.isSoftMatch = function(oldNode, newNode) {
                // If both have Alpine reactive ID bindings, ignore ID mismatch
                if (oldNode._x_bindings?.id && newNode.matches?.('[\\:id], [x-bind\\:id]')) {
                    return oldNode instanceof Element && oldNode.tagName === newNode.tagName;
                }
                return originalIsSoftMatch(oldNode, newNode);
            };
        },
        
        ypy_before_swap: (elt, detail) => {
            if (!window.Alpine?.closestDataStack || !window.Alpine?.cloneNode || !window.Alpine?.deferMutations) {
                return;
            }
            if (deferCount === 0) {
                window.Alpine.deferMutations();
            }
            deferCount++;
            
            let {tasks} = detail;
            for (let task of tasks) {
                if (task.swapSpec.style === 'innerMorph' || task.swapSpec.style === 'outerMorph') {
                    if (!task.fragment || !task.target) continue;
                    
                    let target = typeof task.target === 'string' 
                        ? document.querySelector(task.target) 
                        : task.target;
                    if (!target) continue;
                }
            }
        },
        
        ypy_before_morph_node: (elt, detail) => {
            if (!window.Alpine?.closestDataStack || !window.Alpine?.cloneNode) {
                return;
            }
            let {oldNode, newNode} = detail;
            
            let oldDataStack = window.Alpine.closestDataStack(oldNode);
            newNode._x_dataStack = oldDataStack;
            
            // skip cloneNode for template children that will have errors as they can not have reactive content 
            if (!oldNode.isConnected) return;
            
            window.Alpine.cloneNode(oldNode, newNode);
            
            // If both have _x_teleport, morph the teleport target
            if (oldNode._x_teleport && newNode._x_teleport) {
                let fragment = document.createDocumentFragment();
                fragment.append(newNode._x_teleport);
                api.morph(oldNode._x_teleport, fragment, false);
            }
        },

        ypy_history_cache_before_save: (elt, detail) => {
            if (!window.Alpine?.destroyTree) return;
            detail.target.querySelectorAll('[x-data]').forEach(el => {
                if (el._x_dataStack) {
                    el.setAttribute('data-alpine-state', JSON.stringify(el._x_dataStack[0]));
                }
            });
            window.Alpine.destroyTree(detail.target);
        },

        ypy_history_cache_after_restore: (elt, detail) => {
            if (!window.Alpine) return;
            document.querySelectorAll('[data-alpine-state]').forEach(el => {
                let saved = JSON.parse(el.getAttribute('data-alpine-state'));
                el.removeAttribute('data-alpine-state');
                if (el._x_dataStack) {
                    for (let key in saved) {
                        try { el._x_dataStack[0][key] = saved[key]; } catch {}
                    }
                }
            });
        },

        ypy_after_swap: (elt, detail) => {
            detail.ctx._alpineFlushed = true;
            maybeFlush();
        },

        ypy_finally_request: (elt, detail) => {
            if (!detail.ctx._alpineFlushed) maybeFlush();
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-retry.js
//
// Automatic retry of failed requests for ypy.
//
// A request that fails is repeated with an exponential backoff. Retry is off unless config.retry
// or the ypy-retry attribute (inherited with ypy-retry:inherited) sets attempts.
//
// Options (attribute value or config.retry): attempts (default 3 for a bare attribute, else 0),
// delay (1s), max (30s), backoff (2: each wait is that many times longer), jitter (see below),
// on (what counts as a failure, see below), methods (a string or array of upper-case names,
// narrows the safe ones) and unsafe (false: GET, HEAD and QUERY only, because the server may have
// run any other method). ypy-retry="false" turns it off.
//
// on: "network" (the default) repeats only a fetch that rejected (no connection, server
// unreachable); "error" also repeats a response with status 500 or more; "always" also repeats
// any response with status 400 or more; "never" turns it off. The last attempt is not repeated:
// its response goes through the normal flow, so the page shows the error as without retry.
//
// jitter: a fraction (0.2) or a percentage ("20%") by which each wait varies at random, up and
// down, so that many clients do not come back at the same moment. 0 (the default of this
// version) keeps the waits exact.
//
// Retry-After: a 503 or 429 that is repeated is awaited at least as long as its Retry-After
// header says (seconds or an HTTP date, never made shorter by jitter). When the header asks for
// more than max, the request is not repeated: the answer is given to the page as it is.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// How it hooks in: the core calls ctx.fetch once per request. From ypy_before_request this
// extension wraps ctx.fetch with the loop, so the request keeps its queue slot and its
// indicators while it waits and the request events fire once. Each repeat fires the cancelable
// ypy:request:retry event on the source element with {attempt, delay, ctx, status}, where status
// is the response status that is repeated (undefined after a network failure). The wait ends at the
// delay or when the window reports "online", whichever comes first, and a request that is
// aborted (timeout included) or whose element is cleaned up is never repeated. The request
// timeout is the deadline of all the attempts together.
//
// Usage:
//   <script src="ypy-retry.js"></script>
//   <button ypy-get="/feed" ypy-retry="attempts:3 delay:1s">Load</button>
//==========================================================
(() => {

    let api;

    // What each mode repeats, besides a fetch that rejected
    const MODES = {network: () => false, error: status => status >= 500, always: status => status >= 400, never: () => false};
    const JITTER = 0;

    // Retry-After in ms: a number of seconds or an HTTP date; undefined when absent or not valid
    function retryAfter(value) {
        if (value == null) return;
        let ms = /^\s*\d+\s*$/.test(value) ? value * 1000 : Date.parse(value) - Date.now();
        if (ms >= 0) return ms;
    }

    // A fraction, or a percentage written "20%", kept between 0 and 1
    function fraction(v) {
        let n = typeof v == 'string' ? parseFloat(v) / (v.trim().endsWith('%') ? 100 : 1) : +v;
        return n > 0 ? Math.min(1, n) : 0;
    }

    // How long to wait before repeating a failed request, or undefined when it must not be repeated.
    // `response` is the answer that failed; it is absent after a network failure.
    function retryDelay(ctx, attempt, response) {
        let method = ctx.request.method, attr = api.attributeValue(ctx.sourceElement, 'ypy-retry');
        let o = {attempts: attr == null ? 0 : 3, delay: 1000, max: 30000, backoff: 2, jitter: JITTER, on: 'network', ...ypy.config.retry, ...api.HCON.parse(attr)};
        let mode = MODES[o.on] ? o.on : 'network', status = response?.status;
        if (attr === 'false' || mode == 'never' || attempt > o.attempts || response && !MODES[mode](status)
            || !(o.unsafe || /^(GET|HEAD|QUERY)$/.test(method) && (o.methods || method).includes(method))) return;
        let max = ypy.parseInterval(o.max), jitter = fraction(o.jitter);
        let wait = ypy.parseInterval(o.delay) * o.backoff ** (attempt - 1) * (1 + jitter * (2 * Math.random() - 1));
        let after = status == 503 || status == 429 ? retryAfter(response.headers.get('Retry-After')) : undefined;
        if (after > max) return;
        return Math.min(max, Math.max(wait, after ?? 0));
    }

    // Waits for the next attempt: until the delay has passed or the window reports "online".
    // Rejects with the abort reason when the request is aborted, and aborts it when its element
    // is cleaned up, so no timer or listener outlives the request.
    function retryWait(ctx, delay) {
        let {signal} = ctx.request, off = new AbortController(), on = {signal: off.signal}, timer;
        return new Promise((resolve, reject) => {
            let end = ok => { clearTimeout(timer); off.abort(); ok ? resolve() : reject(signal.reason) };
            timer = setTimeout(end, delay, true);
            window.addEventListener('online', () => end(true), on);
            signal.addEventListener('abort', () => end(), on);
            ctx.sourceElement.addEventListener('ypy:before:cleanup', () => ctx.request.abort(), on);
        });
    }

    ypy.registerExtension('ypy-retry', {

        init: (internalApi) => { api = internalApi },

        ypy_before_request: (elt, {ctx}) => {
            let inner = ctx.fetch;
            // An accessor, so a listener that replaces ctx.fetch later still runs inside the loop
            Object.defineProperty(ctx, 'fetch', {
                configurable: true,
                get: () => async (action, request) => {
                    for (let attempt = 1; ; attempt++) {
                        let response, failure;
                        try {
                            response = await inner(action, request);
                        } catch (error) {
                            failure = error;
                        }
                        let delay = request.signal.aborted ? null : retryDelay(ctx, attempt, response);
                        if (delay == null || !api.triggerEvent(elt, 'ypy:request:retry', {attempt, delay, ctx, status: response?.status})) {
                            if (failure) throw failure;
                            return response;
                        }
                        // the answer that is repeated is not read: let go of its connection
                        response?.body?.cancel?.()?.catch(() => {});
                        await retryWait(ctx, delay);
                    }
                },
                set: fn => { inner = fn }
            });
        }
    });

})();
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
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-signals.js
//
// Client state for ypy: signals, computed values and bindings, with an expression language of
// its own. No eval, no new Function: the expressions are parsed here into closures, so the
// extension works with callbacks:"none" and a strict CSP. Full reference: https://ypy.dev/docs/reference/signals.
//
// Attributes (also as data-ypy-*):
//   ypy-signals="count:0, name:'x'"   declares signals; the element is the scope of its descendants
//   ypy-signals.server="plan:'free'"  read-only for the client; only the server (a patch) changes them
//   ypy-signals.local="_theme:'dark'" persisted in localStorage (.session: sessionStorage); needs an id
//   ypy-computed:total="$price * $qty"  derived, read-only signal
//   ypy-bind="name"  ypy-bind:name      two-way with input, select, textarea, contenteditable
//   ypy-text  ypy-show  ypy-class[:name]  ypy-attr[:name]   one-way, re-run when a signal they read changes
//   ypy-on:click="$count++; save($event.key)"   handlers; inside a scope they replace the core ypy-on
// Modifiers: bind .live .blur .debounce.300ms .throttle.300ms; on .prevent .stop .once .window
// .debounce.Nms .throttle.Nms.
//
// Expressions: $name.path, literals, [list], {object}, ! - + * / % < > <= >= == != === !== && || ??,
// a ? b : c, calls of functions given to ypy.signals.register(name, fn). Handlers also take
// statements separated by ";", assignments (= += -= *= /= %= ??=) and ++ --. Nothing else.
//
// Wire format (the Go SDK follows this, spec/PROTOCOL.md 3.2): a request from an element with
// signals in reach carries the signals (computed ones and every key starting with "_" left out, at
// any depth) as one JSON object in the form field "ypy-signals": the core puts the fields of a GET
// or DELETE in the query string and those of the other verbs in the urlencoded or multipart body.
// Opt-in: nothing is sent unless asked. ypy-signals-send on the element, or ypy-signals-send:inherited on an
// ancestor (the nearest value wins; "false" turns it off again), or ypy.config.signals.send = true for the
// whole page. A response of type application/json is a JSON Merge Patch (RFC 7396) applied to the signals; it
// is not swapped. Only the public API and the extension API are used.
//==========================================================
(() => {
    let api;

    const FIELD = 'ypy-signals';
    const BAD = /^(?:constructor|prototype|__proto__)$/;
    const KINDS = ['signals', 'computed', 'bind', 'text', 'show', 'class', 'attr', 'on'];
    const ATTR = new RegExp(`^(?:data-)?ypy-(${KINDS.join('|')})(?::([^.]+))?((?:\\.[^.]+)*)$`);
    const xp = kinds => '(self::*|.//*)[@*[' + kinds.flatMap(k => ['ypy-', 'data-ypy-'].map(p => `starts-with(name(),"${p}${k}")`)).join(' or ') + ']]';
    const IGNORE = '[ypy-ignore],[data-ypy-ignore]';
    const fns = new Map(), scopes = new WeakMap(), recs = new WeakMap(), pending = new Set(), queue = new Set();
    let active = null, live = 0, scheduled = false;

    //============================================================================================
    // Reactivity: a node is a signal (no fn), a computed (fn, lazy) or an effect (fn, runs in a batch)
    //============================================================================================

    const E = m => Error('ypy: signals: ' + m);
    const deny = k => { if (BAD.test(k)) throw E('reserved name ' + k) };
    const fail = (elt, error) => api.triggerEvent(elt, 'ypy:signals:error', {error});
    const poke = n => { for (let s of [...n.subs]) s.dirty() };

    class Node {
        subs = new Set(); deps = new Set(); stale = false; dead = false; ro = false;
        constructor(fn, elt, eff, v) {
            Object.assign(this, {fn, elt, eff, v, stale: !!fn});
            if (fn) live++;
        }
        get() {
            if (active && !this.dead) { this.subs.add(active); active.deps.add(this) }
            if (this.stale) this.run();
            return this.v;
        }
        set(v) { if (v !== this.v) { this.v = v; poke(this) } }
        run() {
            if (this.dead) return;
            if (this.eff && !this.elt.isConnected) return this.kill();   // left the page without a cleanup
            for (let d of this.deps) d.subs.delete(this);
            this.deps.clear();
            let prev = active;
            active = this;
            this.stale = false;
            try { this.v = this.fn() } catch (e) { fail(this.elt, e) } finally { active = prev }
        }
        dirty() {
            if (this.dead || this.stale) return;
            this.stale = true;
            if (!this.eff) return poke(this);
            queue.add(this);
            if (!scheduled) { scheduled = true; queueMicrotask(flush) }
        }
        kill() {
            if (this.dead) return;
            this.dead = true;
            if (this.fn) live--;
            for (let d of this.deps) d.subs.delete(this);
            this.deps.clear();
            queue.delete(this);
            poke(this);
            this.subs.clear();
        }
    }

    // Runs the queued effects until none is left; effects that keep waking each other stop at 100 rounds
    function flush() {
        for (let i = 0; queue.size; i++) {
            if (i > 99) { queue.clear(); console.error('ypy: signals: effects loop'); break }
            let batch = [...queue];
            queue.clear();
            batch.forEach(n => n.run());
        }
        scheduled = false;
    }

    //============================================================================================
    // Scopes and paths. A signal is one node per top-level key; a nested write replaces the
    // value along the path (copy on write), so a change is always a new identity.
    //============================================================================================

    function scopeOf(elt) {
        let s = scopes.get(elt);
        if (!s) {
            scopes.set(elt, s = {elt, cells: new Map(), base: {}, shape: new Node(null, elt, 0, 0)});
            add(s, '_dirty', false, true);
        }
        return s;
    }

    function add(s, k, v, ro) {
        deny(k);
        let n = new Node(null, s.elt, 0, v);
        n.ro = ro;
        s.cells.set(k, n);
        s.base[k] = JSON.stringify(v);
        s.shape.set(s.shape.v + 1);
        return n;
    }

    // The scopes around an element, innermost first
    function up(elt) {
        let out = [];
        for (let p = elt; p; p = p.parentElement) { let s = scopes.get(p); if (s) out.push(s) }
        return out;
    }

    // Same, but an element outside every scope speaks for the top-level scopes of the page (the first
    // in document order is the outermost: where a signal nobody declared is created)
    function chainOf(elt) {
        let out = up(elt);
        if (!out.length) {
            let r = document.evaluate(xp(['signals']), document, null, 7);
            for (let i = 0; i < r.snapshotLength; i++) {
                let e = r.snapshotItem(i), s = scopes.get(e);
                if (s && !up(e.parentElement).length) out.unshift(s);
            }
        }
        return out;
    }

    const own = (v, k) => v != null && typeof v != 'function' && !BAD.test(k) && Object.hasOwn(Object(v), k) ? v[k] : undefined;
    const find = (ch, k) => ch.find(s => s.cells.has(k));

    function read(ch, name, keys) {
        let s = find(ch, name), v;
        if (s) v = s.cells.get(name).get();
        else ch.forEach(c => c.shape.get());   // a signal that does not exist yet: wake when one is declared
        for (let k of keys) v = own(v, k);
        return v;
    }

    function setIn(o, [k, ...rest], v) {
        deny(k);
        let c = o && typeof o == 'object' ? (Array.isArray(o) ? [...o] : {...o}) : {};
        if (Array.isArray(c) && !(/^\d+$/.test(k) && k <= c.length)) throw E('array index');
        c[k] = rest.length ? setIn(own(c, k), rest, v) : v;
        return c;
    }

    // false when the signal is read-only for the client
    function write(ch, name, keys, v, elt) {
        let s = find(ch, name), n = s?.cells.get(name);
        if (n?.ro) return api.triggerEvent(elt, 'ypy:signals:readonly', {name, warn: name + ' is read-only'}), false;
        if (!n) {
            if (!(s = ch.at(-1))) return false;
            n = add(s, name);
        }
        n.set(keys.length ? setIn(n.v, keys, v) : v);
        return true;
    }

    const rebase = (s, k) => {
        for (let [key, n] of k ? [[k, s.cells.get(k)]] : s.cells) if (n) s.base[key] = JSON.stringify(n.v);
        s.shape.set(s.shape.v + 1);   // wakes the unsaved-state effect
    };

    // JSON Merge Patch (RFC 7396) of a value
    const merge = (t, p) => p && typeof p == 'object' && !Array.isArray(p)
        ? Object.entries(p).reduce((o, [k, v]) => (BAD.test(k) || (v === null ? delete o[k] : o[k] = merge(own(o, k), v)), o),
            t && typeof t == 'object' && !Array.isArray(t) ? {...t} : {})
        : p;

    // Applies a merge patch to the signals in reach of elt. A key goes to the nearest scope that has it, a
    // new one to the outermost; null removes it. Computed signals ignore it; server ones accept it.
    function patch(ch, p, elt, missing) {
        if (!api.triggerEvent(elt, 'ypy:signals:patch', {patch: p})) return;
        for (let k of Object.keys(p)) {
            let s = find(ch, k), n = s?.cells.get(k), v = p[k];
            if (BAD.test(k) || n?.fn || (missing && n)) continue;
            if (v === null) {
                if (n) { n.kill(); s.cells.delete(k); delete s.base[k]; s.shape.set(s.shape.v + 1) }
            } else if (n) {
                n.set(merge(n.v, v));
                rebase(s, k);
            } else if ((s = ch.at(-1))) {
                add(s, k, merge(undefined, v));
            }
        }
    }

    //============================================================================================
    // The expression language: a parser that builds closures. Nothing is compiled, nothing global
    // is reachable: a name is a signal ($name), a literal or a registered function.
    //============================================================================================

    const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\$?[A-Za-z_]\w*)|(\?\?=|===|!==|\?\?|\?\.|==|!=|<=|>=|&&|\|\||\+\+|--|[-+*\/%]=|[-+*\/%<>=!?:.,;()[\]{}]))/y;
    const LEVELS = [['||', '??'], ['&&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    const OPS = {
        '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b, '%': (a, b) => a % b,
        '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
        '==': (a, b) => a == b, '!=': (a, b) => a != b, '===': (a, b) => a === b, '!==': (a, b) => a !== b,
        '??': (a, b) => a ?? b
    };
    const LITERALS = new Map([['true', true], ['false', false], ['null', null], ['undefined', undefined]]);
    const MAX_DEPTH = 32, MAX_LENGTH = 1000, MAX_DECLARATION = 20000;
    const cache = new Map();

    const unquote = s => JSON.parse(s[0] == '"' ? s : '"' + s.slice(1, -1).replace(/\\.|"/g, m => m == "\\'" ? "'" : m == '"' ? '\\"' : m) + '"');

    // mode 0: one expression; 1: statements (a handler); 2: the literal of a declaration
    function compile(src, mode) {
        let id = mode + src, hit = cache.get(id);
        if (hit) return hit;
        src = src.trim();
        if (src.length > (mode == 2 ? MAX_DECLARATION : MAX_LENGTH)) throw E('too long');
        let t = [], i = 0, depth = 0, m;
        TOKEN.lastIndex = 0;
        while (TOKEN.lastIndex < src.length) {
            if (!(m = TOKEN.exec(src))) throw E('unexpected character');
            t.push(m[1] ? [1, m[1]] : m[2] ? [2, m[2]] : m[3] ? [3, m[3]] : [4, m[4]]);
        }
        const bad = () => { throw E('unexpected ' + (t[i]?.[1] ?? 'end')) };
        const at = p => t[i]?.[1] === p;
        const eat = p => at(p) && ++i;
        const need = p => eat(p) || bad();
        const take = () => t[i++] || bad();
        const wrong = () => { i--; bad() };
        const deeper = () => { if (++depth > MAX_DEPTH) throw E('too deep') };
        const lhs = (x, ref) => ref.keys.map(k => k(x));
        const assign = (x, ref, v) => write(x.ch, ref.name, lhs(x, ref), v, x.el);

        function expr() {
            deeper();
            let c = binary(0);
            if (eat('?')) { let a = expr(), b = (need(':'), expr()), q = c; c = x => q(x) ? a(x) : b(x) }
            depth--;
            return c;
        }

        function binary(l) {
            if (l == LEVELS.length) return unary();
            let c = binary(l + 1), o;
            while ((o = LEVELS[l].find(at))) {
                i++;
                let a = c, b = binary(l + 1), f = OPS[o];
                c = o == '&&' ? x => a(x) && b(x) : o == '||' ? x => a(x) || b(x) : o == '??' ? x => a(x) ?? b(x) : x => f(a(x), b(x));
            }
            return c;
        }

        // ++ and -- change a signal: handlers only
        function step(a, o, before) {
            if (mode != 1 || !a.ref) bad();
            let d = o == '++' ? 1 : -1;
            return x => { let old = a(x), v = old + d; assign(x, a.ref, v); return before ? v : old };
        }

        function unary() {
            deeper();
            let o = ['!', '-', '+', '++', '--'].find(at), c;
            if (o) {
                i++;
                let a = unary();
                c = o == '!' ? x => !a(x) : o == '-' ? x => -a(x) : o == '+' ? x => +a(x) : step(a, o, 1);
            } else {
                c = primary();
                if (c.ref && (o = ['++', '--'].find(at))) { i++; c = step(c, o, 0) }
            }
            depth--;
            return c;
        }

        function primary() {
            let [type, text] = take();
            if (type == 1) return () => +text;
            if (type == 2) { let s = unquote(text); return () => s }
            if (type == 3 && text[0] == '$') {
                let name = text.slice(1), keys = [], c;
                for (;;) {
                    if (eat('.') || eat('?.')) {
                        let [kt, k] = take();
                        if (kt != 3 || k[0] == '$') wrong();
                        keys.push(() => k);
                    } else if (eat('[')) { keys.push(expr()); need(']') } else break;
                }
                if (at('(')) bad();   // only registered functions are called
                c = x => name == 'event' && x.ev ? keys.reduce((v, k) => own(v, k(x)), x.ev) : read(x.ch, name, keys.map(k => k(x)));
                c.ref = {name, keys};
                return c;
            }
            if (type == 3 && LITERALS.has(text)) { let v = LITERALS.get(text); return () => v }
            if (type == 3 && eat('(')) {
                let args = [];
                if (!eat(')')) { do args.push(expr()); while (eat(',')); need(')') }
                return x => {
                    let f = fns.get(text);
                    if (!f) throw E('no function ' + text);
                    return f(...args.map(a => a(x)));
                };
            }
            if (text == '(') { let c = expr(); need(')'); return c }
            if (text == '[') {
                let items = [];
                if (!eat(']')) { do { if (at(']')) break; items.push(expr()) } while (eat(',')); need(']') }
                return x => items.map(a => a(x));
            }
            if (text == '{') {
                let props = [];
                if (!eat('}')) {
                    do {
                        if (at('}')) break;
                        let [kt, k] = take();
                        if (kt == 2) k = unquote(k); else if (kt == 4 || (kt == 3 && k[0] == '$')) wrong();
                        deny(k);
                        need(':');
                        props.push([k, expr()]);
                    } while (eat(','));
                    need('}');
                }
                return x => { let o = {}; for (let [k, v] of props) o[k] = v(x); return o };
            }
            wrong();
        }

        function statement() {
            let c = expr(), o = ['=', '+=', '-=', '*=', '/=', '%=', '??='].find(at);
            if (!o) return c;
            if (!c.ref) bad();
            i++;
            let r = expr(), f = OPS[o.slice(0, -1)];
            return x => { let v = r(x); assign(x, c.ref, o == '=' ? v : f(c(x), v)) };
        }

        let prog;
        if (mode == 1) {
            let list = [];
            do { if (i < t.length && !at(';')) list.push(statement()) } while (eat(';'));
            prog = x => { for (let s of list) s(x) };
        } else prog = expr();
        if (i < t.length) bad();
        if (cache.size > 255) cache.clear();
        cache.set(id, prog);
        return prog;
    }

    //============================================================================================
    // Attributes
    //============================================================================================

    const ctx = elt => ({ch: chainOf(elt), el: elt});
    const camel = k => k.replace(/-./g, m => m[1].toUpperCase());
    const str = v => v == null ? '' : typeof v == 'object' ? JSON.stringify(v) : String(v);
    // ".debounce.300ms": the time after the modifier, 300 ms when it has none
    const delay = (mods, name) => {
        let i = mods.indexOf(name);
        if (i >= 0) return /^\d+m?s$/.test(mods[i + 1]) ? ypy.parseInterval(mods[i + 1]) : 300;
    };

    // An effect: runs now and again, in a batch, when a signal it read changes
    function fx(rec, elt, fn) {
        let n = new Node(fn, elt, 1);
        rec.nodes.push(n);
        n.run();
        return n;
    }

    function setAttr(elt, name, v) {
        let url = /^(?:href|src|action|formaction|xlink:href|poster)$/i.test(name) && /^[\s\x00-\x20]*(?:javascript|vbscript):/i.test(String(v));
        if (/^(?:on|srcdoc$|(?:data-)?ypy-)/i.test(name) || url) throw E('blocked attribute ' + name);
        v === false || v == null ? elt.removeAttribute(name) : elt.setAttribute(name, v === true ? '' : v);
    }

    // ypy-class and ypy-attr: "name" is in the attribute (ypy-class:name="$on") or the value is an object
    function pairs(rec, elt, k, src, apply) {
        let f = compile(src, 0);
        fx(rec, elt, () => {
            let x = f(ctx(elt));
            if (k) apply(k, x);
            else for (let [a, b] of Object.entries(x && typeof x == 'object' ? x : {})) apply(a, b);
        });
    }

    function declare(rec, elt, text, mods) {
        let s = scopeOf(elt), srv = mods.includes('server'), kind = mods.find(m => /^(?:local|session)$/.test(m)), store, stored = {};
        let id = elt.id, key = FIELD + ':' + id;
        rec.scope = s;
        let obj = compile(/^\s*\{/.test(text) ? text : `{${text}}`, 2)({ch: [s], el: elt});
        if (kind) {
            if (!id) console.warn('ypy: signals: persisting needs an id');
            else try { store = window[kind + 'Storage']; stored = JSON.parse(store.getItem(key)) || {} } catch { store = null }
        }
        let keys = Object.keys(obj);
        for (let k of keys) {
            let n = s.cells.get(k);
            if (!n) { n = add(s, k, obj[k], srv); if (!srv && Object.hasOwn(stored, k)) n.set(stored[k]) }
            else if (srv) { n.ro = true; n.set(obj[k]); rebase(s, k) }   // the server is the authority over its keys
        }
        if (store && !srv) fx(rec, elt, () => {
            let o = {};
            for (let k of keys) o[k] = s.cells.get(k)?.get();
            try { store.setItem(key, JSON.stringify(o)) } catch {}
        });
    }

    function bind(rec, elt, path, mods) {
        let [name, ...keys] = path.replace(/^\$/, '').split('.');
        let type = elt.type, check = type == 'checkbox', radio = type == 'radio', multi = elt.multiple, edit = elt.isContentEditable && !('value' in elt);
        let prop = edit ? 'textContent' : 'value', cur = () => read(chainOf(elt), name, keys), timer = 0;
        let dom = () => check ? elt.checked : radio ? elt.value : multi ? [...elt.selectedOptions].map(o => o.value) : elt[prop];
        let commit = () => {
            clearTimeout(timer);
            timer = 0;
            pending.delete(commit);
            if (radio && !elt.checked) return;
            let v = dom();
            if (typeof cur() == 'number' && !check && !multi) v = Number(v);
            if (!write(chainOf(elt), name, keys, v, elt)) paint.run();   // read-only: show the signal again
        };
        let paint = fx(rec, elt, () => {
            let v = cur();
            if (check) elt.checked = !!v;
            else if (radio) elt.checked = v == elt.value;
            else if (multi) for (let o of elt.options) o.selected = Array.isArray(v) && v.includes(o.value);
            else if (elt[prop] != (v ?? '')) elt[prop] = v ?? '';
        });
        let listen = (ev, f) => elt.addEventListener(ev, f, {signal: rec.ac.signal});
        let wait = delay(mods, 'debounce') ?? delay(mods, 'throttle'), debounce = mods.includes('debounce');
        listen('input', () => {
            pending.add(commit);
            if (mods.includes('live')) commit();
            else if (wait != null) { if (debounce) clearTimeout(timer); if (debounce || !timer) timer = setTimeout(commit, wait) }
        });
        listen(mods.includes('blur') ? 'blur' : 'change', commit);
        rec.ends.push(() => { clearTimeout(timer); pending.delete(commit) });
    }

    function on(rec, elt, event, mods, src) {
        if (!event) throw E('ypy-on needs :event');
        let f = compile(src, 1), debounce = delay(mods, 'debounce'), throttle = delay(mods, 'throttle'), timer = 0;
        let go = e => {
            let t = e.target;
            try {
                f({ch: chainOf(elt), el: elt, ev: {type: e.type, key: e.key, code: e.code, detail: e.detail, value: t?.value, checked: t?.checked,
                    shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey}});
            } catch (error) { fail(elt, error) }
        };
        let h = e => {
            if (!elt.isConnected) return rec.ac.abort();   // a window listener of an element that left without a cleanup
            if (mods.includes('prevent')) e.preventDefault();
            if (mods.includes('stop')) e.stopPropagation();
            if (debounce != null) { clearTimeout(timer); timer = setTimeout(go, debounce, e) }
            else if (throttle != null) { if (!timer) { go(e); timer = setTimeout(() => timer = 0, throttle) } }
            else go(e);
        };
        // capture: on the element itself it runs before the request the same element may start
        (mods.includes('window') ? window : elt).addEventListener(event[0] == ':' ? 'ypy' + event : event, h,
            {signal: rec.ac.signal, once: mods.includes('once'), capture: true});
        rec.ends.push(() => clearTimeout(timer));
    }

    const HANDLERS = {
        signals: (rec, elt, k, mods, v) => declare(rec, elt, v, mods),
        computed: (rec, elt, k, mods, v) => {
            let s = up(elt)[0], f = compile(v, 0), name = camel(k || '');
            if (!s) throw E('no scope');
            if (s.cells.has(name)) throw E('duplicate ' + name);
            let n = add(s, name, undefined, true);
            n.fn = () => f(ctx(elt));
            n.stale = true;
            live++;
            n.home = [s, name];
            rec.nodes.push(n);
        },
        bind: (rec, elt, k, mods, v) => bind(rec, elt, k ? camel(k) : v.trim(), mods),
        text: (rec, elt, k, mods, v) => { let f = compile(v, 0); fx(rec, elt, () => { let s = str(f(ctx(elt))); if (elt.textContent !== s) elt.textContent = s }) },
        show: (rec, elt, k, mods, v) => { let f = compile(v, 0); fx(rec, elt, () => { elt.style.display = f(ctx(elt)) ? '' : 'none' }) },
        class: (rec, elt, k, mods, v) => pairs(rec, elt, k, v, (c, on) => elt.classList.toggle(c, !!on)),
        attr: (rec, elt, k, mods, v) => pairs(rec, elt, k, v, (n, x) => setAttr(elt, n, x)),
        on
    };

    function off(rec) {
        rec.ac.abort();
        rec.ends.forEach(f => f());
        for (let n of rec.nodes) {
            n.kill();
            if (n.home && n.home[0].cells.get(n.home[1]) === n) { n.home[0].cells.delete(n.home[1]); n.home[0].shape.set(n.home[0].shape.v + 1) }
        }
    }

    // Reads the signal attributes of an element and sets up what they say. The element keeps its
    // record while its attributes stay the same, so a morph that leaves them alone only repaints.
    function wire(elt) {
        if (elt.closest(IGNORE)) return;
        let list = [];
        for (let a of elt.attributes) {
            let m = ATTR.exec(a.name);
            if (m) list.push([m[1], m[2], m[3].split('.').slice(1), a.value]);
        }
        let key = JSON.stringify(list), rec = recs.get(elt);
        if (rec?.key == key) return rec.nodes.forEach(n => n.eff && (n.stale = true, n.run()));
        if (rec) { off(rec); recs.delete(elt) }
        if (!list.length) return;
        recs.set(elt, rec = {key, ac: new AbortController(), nodes: [], ends: [], scope: null});
        api.ypyProp(elt);
        list.sort((a, b) => Math.min(KINDS.indexOf(a[0]), 2) - Math.min(KINDS.indexOf(b[0]), 2));
        for (let [kind, k, mods, v] of list) {
            try { HANDLERS[kind](rec, elt, k, mods, v) } catch (e) { fail(elt, e) }
        }
        let s = rec.scope;
        if (s) fx(rec, elt, () => {   // unsaved state: any client-owned signal that differs from what was last saved
            let dirty = false;
            s.shape.get();
            for (let [k, n] of s.cells) if (!n.ro && k[0] != '_' && JSON.stringify(n.get()) != s.base[k]) { dirty = true; break }
            s.cells.get('_dirty').set(dirty);
            for (let c of (ypy.config.classes?.dirty || 'ypy-dirty').split(/\s+/)) elt.classList.toggle(c, dirty);
            // data-ypy-state holds a list of states (the core's convention); the morph leaves it alone
            let states = (elt.dataset.ypyState || '').split(' ').filter(x => x && x != 'dirty');
            if (dirty) states.push('dirty');
            states[0] ? elt.dataset.ypyState = states.join(' ') : delete elt.dataset.ypyState;
        });
    }

    function scan(root) {
        let r = document.evaluate(xp(KINDS), root, null, 7);
        for (let i = 0; i < r.snapshotLength; i++) wire(r.snapshotItem(i));
    }

    const hasAttr = (elt, re) => elt.getAttributeNames().some(n => re.test(n));
    // Is the element inside a scope that is declared in the markup (it may not be wired yet)?
    const inScope = elt => { for (let p = elt; p; p = p.parentElement) if (hasAttr(p, /^(?:data-)?ypy-signals(?:\.|$)/)) return true };

    //============================================================================================
    // Public API: ypy.signals
    //============================================================================================

    const path = p => p.replace(/^\$/, '').split('.');
    ypy.signals = {
        /** Makes fn callable from expressions as name(...). */
        register(name, fn) {
            if (!/^[A-Za-z_]\w*$/.test(name) || typeof fn != 'function') throw new TypeError('register(name, fn)');
            fns.set(name, fn);
        },
        /** The value at a path such as "user.name", seen from elt (default: the page). */
        get(p, elt = document.body) { let [n, ...k] = path(p); return read(chainOf(elt), n, k) },
        /** Applies a JSON Merge Patch the way a server response does; onlyIfMissing skips signals that exist. */
        patch(p, elt = document.body, onlyIfMissing) { patch(chainOf(elt), p, elt, onlyIfMissing) },
        /** Live reactive nodes and uncommitted bindings, for leak tests and tooling. */
        stats: () => ({nodes: live, pending: pending.size})
    };

    ypy.registerExtension('ypy-signals', {
        init(internalApi) { api = internalApi },

        ypy_after_process(root) { scan(root) },

        // Inside a scope, ypy-on takes expressions, not JavaScript: the extension runs them, the core does not
        ypy_before_on_init(elt) {
            if (hasAttr(elt, /^(?:data-)?ypy-on(?:[:.]|$)/) && inScope(elt)) return false;
        },

        ypy_before_cleanup(elt) {
            let rec = recs.get(elt);
            if (rec) { off(rec); recs.delete(elt) }
        },

        // The signals go with a same-origin request only when asked: ypy-signals-send (nearest wins) or config signals.send
        ypy_config_request(elt, {ctx}) {
            let r = ctx.request, v = api.attributeValue(elt, 'ypy-signals-send') ?? ypy.config.signals?.send;
            if (v == null || v === false || v == 'false') return;
            try { if (new URL(r.action, document.baseURI).origin != origin) return } catch { return }
            [...pending].forEach(commit => commit());
            let o = {};
            for (let s of chainOf(elt).reverse()) for (let [k, n] of s.cells) if (!n.fn && k[0] != '_') o[k] = n.v;
            if (!Object.keys(o).length) return;
            try { r.body?.set?.(FIELD, JSON.stringify(o, (k, v) => k[0] == '_' ? undefined : v)) } catch (e) { return fail(elt, e), false }
        },

        // JSON is a patch, not markup; a saved form (2xx to anything but a GET) is not "unsaved" any more
        ypy_after_request(elt, {ctx}) {
            let res = ctx.response, json = /^application\/(?:[^;]*\+)?json/i.test(res.headers?.get?.('Content-Type') ?? ''), ch = chainOf(elt);
            if (json) {
                try {
                    let p = JSON.parse(ctx.text);
                    if (!p || typeof p != 'object' || Array.isArray(p)) throw E('patch must be an object');
                    patch(ch, p, elt);
                } catch (e) { fail(elt, e) }
            }
            if (res.status >= 200 && res.status < 300 && !/^GET$/i.test(ctx.request.method)) ch.forEach(s => rebase(s));
            if (json) return false;
        }
    });

    if (document.readyState != 'loading' && document.body) queueMicrotask(() => scan(document.body));
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-layers.js
//
// Layers: modals, drawers and popups that stack on the native <dialog>. No style is
// required: the extension ships one optional, zero-specificity stylesheet that the
// page can turn off (config.layers.style = false) or override with the --ypy-layer-*
// variables and with classes (config.layers.classes). Nothing is written to a style
// attribute, so a strict CSP is fine. Full reference: https://ypy.dev/docs/reference/layers.
//
// Open a layer
//   <a href="/items/new" ypy-layer="modal">New</a>        a link or a form; the response fills the layer
//   <button ypy-get="/menu" ypy-layer="popup">Menu</button>
//   ypy.layers.open('/items/new', {mode: 'drawer'})       a URL, or a string of HTML ("<...")
//   response header  YPY-Open-Layer: {"url":"/items/new","mode":"modal","closeOn":"saved"}
//
// Options (API object, ypy-layer-* attributes on the opener, keys of the header JSON):
//   mode (modal|drawer|popup)  closeOn (events)  closeOnUrl (globs)  closeOnFragment (selector)
//   outside  escape  history  side  label  class  select  values  method
//
// Result: open() returns a promise that settles when the layer closes with
//   {accepted: true, value} or {accepted: false, reason}; promise.layer is the handle.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {
    let api;

    const KINDS = ['modal', 'drawer', 'popup'];
    const DIALOG = 'dialog[data-ypy-layer-kind]';
    const KEYS = ['url', 'html', 'mode', 'closeOn', 'closeOnUrl', 'closeOnFragment', 'history', 'side', 'label', 'outside', 'escape', 'class'];
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    const stack = [], layers = new WeakMap(), wired = new WeakSet();
    let seq = 0, sheet, ownBack = false;

    //============================================================================================
    // Configuration, parsing, style
    //============================================================================================

    const cfg = () => ({style: true, scrollLock: true, outside: true, escape: true, history: false, ...ypy.config.layers});
    const opener = () => ypy.config.layers?.classes?.opener ?? 'ypy-layer-opener';
    const list = v => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).filter(Boolean);
    const json = v => { try { return JSON.parse(v) } catch { return v } };
    const glob = (p, s) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s);
    const layerOf = elt => layers.get(elt?.closest?.(DIALOG));
    const sel = n => api.prefixSelector('[ypy-' + n + ']');
    const bool = v => v == null ? undefined : v !== 'false';
    const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

    function style() {
        if (sheet || cfg().style === false) return;
        try {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(`
:where(dialog[data-ypy-layer-kind]){box-sizing:border-box;background:var(--ypy-layer-bg,Canvas);color:var(--ypy-layer-color,CanvasText);border:var(--ypy-layer-border,1px solid #8884);border-radius:var(--ypy-layer-radius,.5rem);padding:var(--ypy-layer-padding,1rem);width:var(--ypy-layer-width,min(32rem,calc(100% - 2rem)));max-width:100%;max-height:var(--ypy-layer-max-height,calc(100dvh - 2rem));overflow:auto;box-shadow:var(--ypy-layer-shadow,0 .5rem 2rem #0005)}
:where(dialog[data-ypy-layer-kind])::backdrop{background:var(--ypy-layer-backdrop,#0006)}
:where(dialog[data-ypy-layer-kind=drawer]){inset:0 0 0 auto;margin:0;height:100dvh;max-height:none;border-radius:0;width:var(--ypy-layer-drawer-width,min(24rem,100%))}
:where(dialog[data-ypy-layer-side=start]){inset:0 auto 0 0}
:where(dialog[data-ypy-layer-side=top],dialog[data-ypy-layer-side=bottom]){width:100%;height:auto;max-height:var(--ypy-layer-drawer-height,50dvh)}
:where(dialog[data-ypy-layer-side=top]){inset:0 0 auto 0}
:where(dialog[data-ypy-layer-side=bottom]){inset:auto 0 0 0}
:where(dialog[data-ypy-layer-kind=popup]){position:fixed;inset:auto;top:var(--ypy-layer-popup-top,1rem);right:var(--ypy-layer-popup-right,1rem);margin:0;z-index:var(--ypy-layer-z,1000);width:var(--ypy-layer-popup-width,min(20rem,calc(100% - 2rem)))}
@supports(anchor-name:--a){
:where(.${CSS.escape(opener())}){anchor-name:--ypy-layer}
:where(dialog[data-ypy-layer-anchored]){position-anchor:--ypy-layer;inset:auto;top:anchor(bottom);left:anchor(left);margin:.25rem 0 0;position-try-fallbacks:flip-block,flip-inline}}
:root[data-ypy-layer-lock]{overflow:hidden;scrollbar-gutter:stable}`);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        } catch { sheet = null }
    }

    // The page behind a modal or a drawer does not scroll
    const sync = () => cfg().scrollLock && document.documentElement.toggleAttribute('data-ypy-layer-lock', stack.some(l => l.mode != 'popup'));

    //============================================================================================
    // Opening
    //============================================================================================

    /**
     * Creates a layer and fills it; it is shown once its content is in. Returns a promise of the
     * result, with the handle as promise.layer.
     */
    function open(spec, o = {}) {
        o = {...o};
        if (spec && typeof spec == 'object') o = {...spec, ...o};
        else if (typeof spec == 'string') o[/^\s*</.test(spec) ? 'html' : 'url'] = spec;
        let mode = KINDS.includes(o.mode) ? o.mode : 'modal', c = cfg(), src = o.source, host;
        if (!api.triggerEvent(src?.isConnected ? src : document, 'ypy:layer:before:open', {options: o, mode})) return Promise.resolve({accepted: false, reason: 'cancelled'});
        style();

        let d = document.createElement('dialog'), top = stack.at(-1);
        // a popup over a modal has to live inside it: the rest of the page is inert while a modal is open
        host = mode == 'popup' && top ? (top.mode == 'popup' ? top.element.parentElement : top.element) : document.body;
        d.id = 'ypy-layer-' + ++seq;
        d.tabIndex = -1;
        d.setAttribute('data-ypy-layer-kind', mode);
        if (mode != 'popup') d.setAttribute('aria-modal', 'true');
        if (mode == 'drawer') d.setAttribute('data-ypy-layer-side', o.side || 'end');
        if (o.label) d.setAttribute('aria-label', o.label);
        d.classList.add(...list(`${c.classes?.[mode] ?? ''} ${o.class ?? ''}`));
        if (mode == 'popup' && src?.isConnected) d.setAttribute('data-ypy-layer-anchored', '');

        let L = {
            element: d, mode, source: src, options: o, closed: false, loaded: false, shown: false,
            returnTo: src?.isConnected ? src : document.activeElement,
            outside: o.outside ?? c.outside, escape: o.escape ?? c.escape,
            history: (o.history ?? c.history) && ypy.config.history !== false,
            accept: v => finish(L, true, v),
            dismiss: r => finish(L, false, r ?? 'dismissed')
        };
        layers.set(d, L);
        let p = new Promise(resolve => L.resolve = resolve);
        p.layer = L;
        L.result = p;
        host.append(d);

        // close by an event: the value is its detail. An event from inside the layer counts for that layer;
        // one from the page counts for the top one.
        L.off = list(o.closeOn).map(name => {
            let h = e => {
                let from = e.target instanceof Element && e.target.closest(DIALOG);
                if (from ? layers.get(from) === L : stack.at(-1) === L) L.accept(e.detail);
            };
            document.addEventListener(name, h);
            return [name, h];
        });
        listen(L);

        // The content is in (or will never come): show the layer. A request tells it by ypy:finally:request or
        // ypy:request:dropped, which is why the promise of ypy.ajax (it ends when the request is queued) is no use.
        L.settle = () => L.closed || (L.loaded ? reveal(L) : finish(L, false, 'error', true));
        let base = {layer: L, target: d, swap: 'innerHTML', push: false, replace: false};
        if (o.html != null) ypy.swap({...base, sourceElement: d, text: String(o.html)}).then(L.settle, L.settle);
        else ypy.ajax(String(o.method || 'GET').toUpperCase(), o.url, {...base, ...defined({source: src, event: o.event, select: o.select, values: o.values})}).catch(L.settle);
        return p;
    }

    function reveal(L) {
        let d = L.element;
        try { L.mode == 'popup' ? d.show() : d.showModal() } catch { return finish(L, false, 'error', true) }
        L.shown = true;
        stack.push(L);
        d.setAttribute('data-ypy-layer-depth', stack.length);
        sync();
        if (L.mode == 'popup' && L.source?.isConnected) L.source.classList.add(opener());
        if (L.history && L.url) {
            // a browser may refuse a write (Safari: 100 per 10 seconds): the layer then opens without its URL
            try {
                if (!history.state?.ypy) history.replaceState({ypy: true}, '', location.href);
                history.pushState({ypy: true, ypyLayer: d.id}, '', L.url);
                L.pushed = true;
            } catch {}
        }
        focus(L);
        api.triggerEvent(d, 'ypy:layer:opened', {layer: L});
    }

    // The layer holds the focus: on the first control, or on the layer itself when it has none
    function focus(L) {
        let d = L.element;
        if (!d.contains(document.activeElement)) (d.querySelector('[autofocus]') || d.querySelector(FOCUSABLE) || d).focus({preventScroll: true});
    }

    //============================================================================================
    // Closing
    //============================================================================================

    /**
     * Closes a layer: first the layers above it, then it. A ypy:layer:before:close listener may cancel
     * (unless force is set); the closing then returns false and nothing changes.
     */
    function finish(L, accepted, v, force) {
        if (L.closed) return true;
        let i = stack.indexOf(L), detail = {layer: L, accepted, ...(accepted ? {value: v} : {reason: v})};
        for (let c of i < 0 ? [] : stack.slice(i + 1).reverse()) if (!finish(c, false, 'parent', force)) return false;
        if (L.shown && !force && !api.triggerEvent(L.element, 'ypy:layer:before:close', detail)) return false;
        L.closed = true;
        if (i >= 0) stack.splice(i, 1);
        for (let [name, h] of L.off) document.removeEventListener(name, h);
        sync();
        if (L.mode == 'popup') L.source?.classList?.remove(opener());
        let d = L.element;
        if (d.open) d.close();
        if (L.pushed && !L.popped && history.state?.ypyLayer == d.id) {
            ownBack = true;
            setTimeout(() => ownBack = false, 500);
            history.back();
        }
        if (L.returnTo?.isConnected) L.returnTo.focus?.({preventScroll: true});
        api.triggerEvent(d, accepted ? 'ypy:layer:accepted' : 'ypy:layer:dismissed', detail);
        d.remove();
        L.resolve(accepted ? {accepted, value: v} : {accepted, reason: v});
        return true;
    }

    //============================================================================================
    // Inside a layer: Esc, a click outside, accept and dismiss buttons, links and forms
    //============================================================================================

    const outside = (d, e) => {
        let r = d.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };

    function listen(L) {
        let d = L.element, down;
        d.addEventListener('cancel', e => { e.preventDefault(); if (L.mode != 'popup' && L.escape) L.dismiss('escape') });
        d.addEventListener('close', () => L.closed || finish(L, false, d.returnValue || 'closed', true));
        d.addEventListener('pointerdown', e => down = e.target == d && outside(d, e));
        d.addEventListener('click', e => {
            let t = e.target;
            if (t == d) {
                if (down && L.outside && outside(d, e)) L.dismiss('outside');
                return down = false;
            }
            if (!(t instanceof Element) || layerOf(t) != L) return;
            let b = t.closest(sel('layer-accept') + ',' + sel('layer-dismiss'));
            if (b && d.contains(b)) {
                e.preventDefault();
                let a = api.attr(b, 'ypy-layer-accept');
                return a != null ? L.accept(a ? json(a) : undefined) : L.dismiss(api.attr(b, 'ypy-layer-dismiss') || undefined);
            }
            let a = t.closest('a[href]');
            if (a && d.contains(a) && !e.defaultPrevented && !e.button && !(e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
                && /^(_self)?$/.test(a.target) && !a.hasAttribute('download') && !a.getAttribute('href').startsWith('#') && a.origin == location.origin && stays(a, e)) {
                e.preventDefault();
                go(L, 'GET', a.getAttribute('href'), a, e);
            }
        });
        d.addEventListener('submit', e => {
            let f = e.target, s = e.submitter;
            if (!(f instanceof HTMLFormElement) || layerOf(f) != L || e.defaultPrevented) return;
            let {action, method} = api.determineMethodAndAction(f, e);
            action ||= s?.getAttribute('formaction') ?? f.getAttribute('action') ?? location.href;
            if (method == 'DIALOG' || !/^(_self)?$/.test(s?.formTarget || f.target) || new URL(action, location.href).origin != location.origin || !stays(f, e)) return;
            e.preventDefault();
            go(L, method, action, f, e);
        });
    }

    // Does the layer take over this link or form? Not when it opens a layer, has a request of its own
    // (ypy-get...), or opts out with ypy-boost="false".
    function stays(elt, e) {
        return !elt.matches(sel('layer')) && !api.determineMethodAndAction(elt, e).action && api.attributeValue(elt, 'ypy-boost') != 'false';
    }

    // A link or form inside a layer navigates the layer, unless it names a target or a swap of its own
    function go(L, method, url, source, event) {
        let has = n => api.attributeValue(source, n) != null;
        return ypy.ajax(method, url, {
            source, event, layer: L, push: false, replace: false,
            ...(has('ypy-target') ? {} : {target: L.element}),
            ...(has('ypy-swap') ? {} : {swap: 'innerHTML'})
        }).catch(() => {});
    }

    //============================================================================================
    // Openers: an element with ypy-layer
    //============================================================================================

    function wire(elt) {
        if (wired.has(elt) || elt.closest(sel('ignore'))) return;
        // the same gate the core applies before it initializes an element (the nonce extension answers it)
        if (!api.triggerEvent(elt, 'ypy:before:init', {layers: true})) return;
        wired.add(elt);
        // the core cancels the click of a link; with a modifier key the browser keeps it (a new tab)
        if (elt.matches('a[href]')) elt.addEventListener('click', e => { if (e.ctrlKey || e.metaKey || e.shiftKey) e.stopImmediatePropagation() }, true);
        api.onTrigger(elt, api.attributeValue(elt, 'ypy-trigger', undefined, undefined, false) || (elt.matches('form') ? 'submit' : 'click'), evt => activate(elt, evt));
    }

    function activate(elt, evt) {
        let {action, method} = api.determineMethodAndAction(elt, evt);
        action ??= evt.submitter?.getAttribute?.('formaction') ?? elt.getAttribute(elt.matches('a') ? 'href' : 'action') ?? (elt.matches('form') ? location.href : null);
        if (action == null) return;
        evt.preventDefault?.();
        let mode = api.attr(elt, 'ypy-layer'), shown = stack.find(l => l.mode == 'popup' && l.source == elt);
        if (shown) return shown.dismiss('toggle');
        let a = n => api.attributeValue(elt, 'ypy-layer-' + n);
        open({url: action}, defined({
            mode, method, source: elt, event: evt, closeOn: a('close-on'), closeOnUrl: a('close-on-url'), closeOnFragment: a('close-on-fragment'),
            outside: bool(a('outside')), escape: bool(a('escape')), history: bool(a('history')), side: a('side'), label: a('label'), class: a('class')
        }));
    }

    //============================================================================================
    // Extension hooks and the public API
    //============================================================================================

    // A layer's content has arrived: name the layer after its heading, keep the focus inside
    function ready(L, own) {
        let d = L.element;
        if (own) {
            L.loaded = true;
            if (L.shown) d.scrollTop = 0;
        }
        if (!d.hasAttribute('aria-label')) {
            let h = d.querySelector('h1,h2,h3,[role=heading]');
            if (h) d.setAttribute('aria-labelledby', h.id ||= d.id + '-title');
            else d.removeAttribute('aria-labelledby');
        }
        if (L.shown) {
            focus(L);
            if (own && L.pushed && L.url) try { history.replaceState({ypy: true, ypyLayer: d.id}, '', L.url) } catch {}
        }
    }

    const hooks = {
        init(internalApi) { api = internalApi },

        // an element that opens a layer is the extension's, not the core's
        ypy_before_init(elt, detail) {
            if (!detail.layers && elt.matches?.(sel('layer'))) return false;
        },

        ypy_after_process(root) {
            for (let elt of [root, ...root.querySelectorAll(sel('layer'))]) if (elt.matches?.(sel('layer'))) wire(elt);
        },

        ypy_before_cleanup(elt) { wired.delete(elt) },

        // the request that fills a layer has ended: swapped, failed or answered with a header
        ypy_finally_request(elt, {ctx}) {
            let L = ctx.layer;
            if (L && !L.shown && ctx.target == L.element) L.settle();
        },

        // the server can tell a request from a layer by YPY-Layer (send Vary: YPY-Layer with a cacheable answer)
        ypy_config_request(elt, {ctx}) {
            let L = ctx.layer ||= layerOf(elt);
            if (L) ctx.request.headers['YPY-Layer'] = L.mode;
        },

        // YPY-Open-Layer: the response opens a layer instead of being swapped
        ypy_after_request(elt, {ctx}) {
            let h = ctx.ypy?.openlayer, o;
            if (h == null) return;
            try { o = h.trim()[0] == '{' ? JSON.parse(h) : {url: h} } catch (error) { return console.warn('ypy: layers: YPY-Open-Layer is not valid', {error}) }
            if (!o || typeof o != 'object') return;
            if (ctx.layer && !ctx.layer.shown) finish(ctx.layer, false, 'replaced', true);
            open(Object.fromEntries(KEYS.filter(k => k in o).map(k => [k, o[k]])), {source: elt});
            return false;
        },

        // what a swap into a layer may do before it happens: close the layer, or keep the address bar
        ypy_before_swap(elt, {ctx, tasks}) {
            let L = ctx.layer;
            if (!L) return;
            if (L.closed) return false;
            if (ctx.target != L.element) return;
            ctx.push = ctx.replace = null;
            if (ctx.ypy) ctx.ypy.pushurl = ctx.ypy.replaceurl = undefined;
            try {
                let u = new URL(ctx.response?.raw?.url || ctx.request?.action, location.href);
                L.url = u.pathname + u.search;
            } catch { /* no URL to follow */ }
            if (L.url && list(L.options.closeOnUrl).some(g => glob(g, L.url))) return L.accept(L.url), false;
            let s = L.options.closeOnFragment, hit = s && tasks.map(t => t.fragment?.querySelector?.(s)).find(Boolean);
            if (hit) {
                let v = api.attr(hit, 'ypy-layer-value');
                return L.accept(v ? json(v) : undefined), false;
            }
            // a popup inside this layer would be swapped away with the content
            for (let c of stack.slice(stack.indexOf(L) + 1)) if (L.element.contains(c.element)) finish(c, false, 'navigate', true);
        },

        ypy_after_swap(elt, {ctx}) {
            let L = ctx.layer || layerOf(elt);
            if (L && !L.closed) ready(L, ctx.layer && ctx.target == L.element && !/^none\b/.test(ctx.swap));
        },

        // Back closes the layer that pushed an entry, and does not reload the page behind it
        ypy_before_history_restore() {
            if (ownBack) return ownBack = false;
            let h = stack.findLast(l => l.pushed);
            if (!h) return;
            h.popped = true;
            finish(h, false, 'history', true);
            return false;
        }
    };

    if (ypy.registerExtension('ypy-layers', hooks) !== false) {
        // a popup is not modal: Esc and a pointer outside close it (a modal has the dialog's own)
        document.addEventListener('keydown', e => {
            let t = stack.at(-1);
            if (e.key == 'Escape' && t?.mode == 'popup' && !e.defaultPrevented) {
                e.preventDefault();
                if (t.escape) t.dismiss('escape');
            }
        });
        // The page behind a modal cannot take the focus. The dialog makes it inert, but Safari does so after
        // the next render: until then a script (or a click) can still focus something behind it.
        document.addEventListener('focusin', e => {
            let t = stack.findLast(l => l.mode != 'popup');
            if (t?.shown && !t.element.contains(e.target)) focus(t);
        });
        document.addEventListener('pointerdown', e => {
            let t = stack.at(-1);
            if (t?.mode == 'popup' && t.outside && !t.element.contains(e.target) && !t.source?.contains?.(e.target)) t.dismiss('outside');
        }, true);

        document.addEventListener('ypy:request:dropped', e => {
            let L = e.detail.ctx?.layer;
            if (L && !L.shown) finish(L, false, 'dropped', true);
        });

        ypy.layers = {
            /** Opens a layer. A string starting with "<" is HTML, any other string is a URL. */
            open,
            /** The open layers, bottom first. */
            get stack() { return [...stack] },
            /** The top layer, or undefined. */
            top: () => stack.at(-1),
            /** Accepts the top layer with a value. */
            accept: v => stack.at(-1)?.accept(v),
            /** Dismisses the top layer. */
            dismiss: r => stack.at(-1)?.dismiss(r),
            /** Dismisses every layer, the top one first; false when one refused. */
            closeAll: r => [...stack].reverse().every(l => l.dismiss(r))
        };

        if (document.readyState != 'loading' && document.body) queueMicrotask(() => hooks.ypy_after_process(document.body));
    }
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-nav.js
//
// Application navigation for ypy: global boost, link prefetch, the current link and ypy-once.
//
// Global boost. With ypy.config.nav.boost on, every link and form of the page is navigated with
// a request and a swap, with no attribute on any of them. The extension listens once on the
// document (not on each element), so content that arrives later is covered without being
// processed. It leaves to the browser everything the browser does better:
//   - a link with target (other than _self) or download, a link to another origin or to a
//     fragment of the same page, a click with Ctrl, Meta, Shift or Alt or a button other than
//     the main one, and any event another listener already cancelled;
//   - a form whose target, formtarget, method or formmethod points at another window or at
//     "dialog", or whose action or formaction is on another origin.
// The method, the action and the target of a form are the HTML ones: the method and action of
// the submitter (formmethod, formaction) win over those of the form, and put, patch and delete
// are accepted as method values. A region turns it off with ypy-boost="false" (also with
// :inherited); elements the core already handles (ypy-get, ypy-boost and the like) are left to
// the core. The request is the core's own: the same headers, the same target and swap rules, the
// same history entry as a link that carries ypy-boost.
//
// Prefetch. With nav.prefetch on (or ypy-prefetch on a link or a region), the page a link opens
// is requested ahead of the click, and the response is the one the click uses. Only a link
// YPY would navigate is prefetched, only with GET, only on the page's own origin, with no form
// data and with the fetch mode and credentials of the page (a ypy-boost value or ypy-config
// cannot change them). The request carries Sec-Purpose, Purpose and YPY-Purpose: prefetch. A script
// cannot set Sec-Purpose (the browser drops every header that starts with Sec-), so servers
// should read Purpose or YPY-Purpose. The response is used by the click only when the click's
// request is the same: same URL and same headers; otherwise the click goes to the server as
// usual. Budget: nav.prefetchMax entries alive, nav.prefetchParallel requests in flight for
// the visibility mode, nav.prefetchTtl ms of life; a hover that ends before the request is
// done cancels it, and nothing is prefetched when the browser asks to save data. The "hover"
// mode also covers the keyboard: a link that gets focus (Tab) is requested after the same
// delay, and leaving it before the request is done cancels it. A focus that comes from the
// pointer is left to the hover and the touch.
//
// The current link. A link to the URL of the page (same path and query, no fragment) gets
// aria-current="page" and the class ypy-current; the mark is renewed on every navigation: after
// each history push or replace, on back and forward, and on content that arrives. The extension
// owns aria-current="page" on links, so a server-rendered one is moved too. nav.current: false
// turns it off.
//
// ypy-once. A <script ypy-once> in swapped content runs only once per page: when a response
// brings it again, it is taken out before the swap. The script's identity is the value of
// ypy-once when it has one, else its src, else its text. A script that came with the page
// counts as already run.
//
// Edits are not lost on the way out. Before a navigation (a boosted request, or one that pushes a
// history entry) the field the user is typing in loses focus, so its change event runs, and the
// navigation waits for the requests that form still has in flight (a validation, a change that posts)
// for at most nav.settle ms. mousedown is never cancelled, so the browser's own blur still happens.
// With nav.confirmLeave on, the browser's own "leave this page?" dialog (beforeunload) shows when a
// form has changes no request has saved yet. A control counts as changed from its first input event
// until a request from it, or from its form or a button of it, ends with a 2xx (not a GET), or the form is reset. A
// navigation that only swaps the page does not unload it, so the browser shows nothing then.
//
// A page from outside the app. A boosted response that is a whole page (it has a doctype, html or
// body) is not swapped when it ended on another origin (a redirect), or when it lacks the root of the
// app: nav.root, a selector, else the element with ypy-history-elt of the current page. The final URL
// is then loaded as a plain page (a GET, or the target of a redirect; never a POST answered with 2xx).
//
// Configuration (ypy.config.nav, or the ypy-config meta tag):
//   boost            false  turn global boost on
//   prefetch         false  "hover", "visible" or "hover visible" (true means "hover")
//   prefetchDelay    65     ms of hover before the request
//   prefetchTtl      10000  ms an unused response is kept
//   prefetchMax      10     entries alive at once
//   prefetchParallel 2      requests in flight for the visibility mode
//   current          true   mark the link to the current page (aria-current, ypy-current)
//   settle           1000   ms a navigation waits for the requests of the form being edited (0: no wait)
//   confirmLeave     false  ask the browser to confirm leaving a page whose forms have unsaved changes
//   root             ""     selector the root of a boosted whole page must have, else it loads in full
//
// With config.nonce set, global boost is off: it works without attributes, and the nonce gate
// is about attributes. Only the public API and the extension API are used.
//==========================================================
(() => {

    let api;
    const cfg = () => ypy.config.nav || {};
    const sel = s => api.prefixSelector(s);
    const cache = new Map();   // action -> {p: response promise, ac, k: headers key, t: expiry timer, hover, done}
    const waiting = [];        // links the visibility mode wants to prefetch
    const ran = new Set();     // identities of the ypy-once scripts that already run on this page
    const sent = new Map();    // ctx -> the form (or element) that sent a request still in flight
    const waiters = new Set(), dirty = new WeakSet();
    let active = 0, timer, ftimer, io, last, pointer, edited;   // edited: the field typed in last

    const boostOn = () => cfg().boost && !ypy.config.nonce;
    const key = h => JSON.stringify(Object.entries(h).sort());
    const handled = elt => elt._ypy?.initialized;   // the core already runs it (ypy-get, ypy-boost...)
    const optedOut = elt => !!elt.closest(sel('[ypy-boost="false"],[ypy-boost\\:inherited="false"],[ypy-ignore]'));

    // The URL a link opens in this window, or undefined when the browser has to handle it.
    function pageUrl(a) {
        if (!(a instanceof HTMLAnchorElement) || !a.getAttribute('href') || a.hasAttribute('download') || a.target && a.target !== '_self') return;
        let u = new URL(a.href);
        if (u.origin === location.origin && u.href.split('#')[0] !== location.href.split('#')[0]) return u;
    }

    // Runs the request through the core as a boosted element would.
    function go(elt, method, action, evt) {
        api.ypyProp(elt).boosted ||= 'true';
        ypy.ajax(method, action, {source: elt, event: evt}).catch(error => api.triggerEvent(elt, 'ypy:error', {error}));
    }

    document.addEventListener('click', evt => {
        if (!boostOn() || evt.defaultPrevented || evt.button || evt.ctrlKey || evt.metaKey || evt.shiftKey || evt.altKey) return;
        let a = (evt.composedPath?.()[0] || evt.target).closest?.('a[href]');
        if (a && pageUrl(a) && !handled(a) && !optedOut(a)) {
            evt.preventDefault();
            go(a, 'GET', a.getAttribute('href'), evt);
        }
    });

    document.addEventListener('submit', evt => {
        let f = evt.target, s = evt.submitter;
        if (!boostOn() || evt.defaultPrevented || !(f instanceof HTMLFormElement) || handled(f) || optedOut(f)) return;
        let pick = (own, name) => s?.hasAttribute(own) ? s.getAttribute(own) : f.getAttribute(name);
        let method = (pick('formmethod', 'method') || 'get').toUpperCase(), target = pick('formtarget', 'target');
        let action = pick('formaction', 'action') ?? '';
        if (/^(GET|POST|PUT|PATCH|DELETE|QUERY)$/.test(method) && (!target || target === '_self') &&
            new URL(action, document.baseURI).origin === location.origin) {
            evt.preventDefault();
            go(f, method, action, evt);
        }
    });

    //------------------------------------------------------
    // prefetch
    //------------------------------------------------------

    // "hover", "visible", both, or "" for none: the nearest ypy-prefetch, else the configuration
    function mode(a) {
        let r = a.closest(sel('[ypy-prefetch]')), v = r ? api.attr(r, 'ypy-prefetch') || 'true' : cfg().prefetch;
        return v === true || v === 'true' ? 'hover' : v === false || v === 'false' || v == null ? '' : String(v);
    }

    function drop(action) {
        let e = cache.get(action);
        if (e) { clearTimeout(e.t); e.ac.abort(); cache.delete(action) }
    }

    function clear() {
        for (let action of [...cache.keys()]) drop(action);
        waiting.length = 0;
        last = null;
    }

    function pump() {
        while (active < (cfg().prefetchParallel ?? 2) && waiting.length) {
            let a = waiting.shift();
            if (a.isConnected) start(a);
        }
    }

    function start(a, hover) {
        if (!pageUrl(a) || navigator.connection?.saveData || optedOut(a) || !mode(a) ||
            !(a._ypy?.boosted || boostOn() && !handled(a))) return;
        api.ypyProp(a).boosted ||= 'true';
        // the core builds the request from this very element, as it does at the click
        let ctx = api.createRequestContext(a, new Event('click')), req = ctx.request;
        let u = new URL(req.action, document.baseURI), action = u.pathname + u.search, o = cfg();
        if (u.origin !== location.origin || cache.has(action)) return;
        if (cache.size >= (o.prefetchMax ?? 10)) drop(cache.keys().next().value);
        let headers = {...req.headers, 'YPY-Request-Type': ctx.target === document.body || ctx.select ? 'full' : 'partial'};
        let e = {ac: new AbortController(), k: key(headers), hover};
        e.p = fetch(action, {
            method: 'GET',
            // never req.mode or req.credentials: an attribute can write there, the page's policy cannot be lifted
            headers: {...headers, 'Sec-Purpose': 'prefetch', Purpose: 'prefetch', 'YPY-Purpose': 'prefetch'},
            credentials: 'same-origin', mode: ypy.config.mode, signal: e.ac.signal
        }).then(r => { if (!r.ok) throw r; return r });
        e.t = setTimeout(drop, o.prefetchTtl ?? 10000, action);
        cache.set(action, e);
        last = {a, action, e};
        active++;
        let end = () => { e.done = true; active--; pump() };
        e.p.then(end, () => { end(); if (cache.get(action) === e) drop(action) });
    }

    document.addEventListener('mouseover', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && !a.contains(evt.relatedTarget) && /hover/.test(mode(a))) {
            clearTimeout(timer);
            timer = setTimeout(start, cfg().prefetchDelay ?? 65, a, true);
        }
    });

    document.addEventListener('mouseout', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && !a.contains(evt.relatedTarget)) {
            clearTimeout(timer);
            if (last?.a === a && last.e.hover === true && !last.e.done) drop(last.action);   // the hover ended first
        }
    });

    document.addEventListener('touchstart', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && /hover/.test(mode(a))) start(a, true);
    }, {passive: true});

    // the keyboard: a link that gets focus is prefetched like a hovered one, unless the pointer put it there
    document.addEventListener('pointerdown', () => { pointer = true }, true);
    document.addEventListener('keydown', () => { pointer = false }, true);

    document.addEventListener('focusin', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a && !pointer && /hover/.test(mode(a))) {
            clearTimeout(ftimer);
            ftimer = setTimeout(start, cfg().prefetchDelay ?? 65, a, 'focus');
        }
    });

    document.addEventListener('focusout', evt => {
        let a = evt.target.closest?.('a[href]');
        if (a) {
            clearTimeout(ftimer);
            if (last?.a === a && last.e.hover === 'focus' && !last.e.done) drop(last.action);
        }
    });

    //------------------------------------------------------
    // edits survive a navigation
    //------------------------------------------------------

    const owner = e => e.form || e.closest?.('form') || e;
    const FIELD = 'input,select,textarea,[contenteditable]';
    const pause = ms => new Promise(r => setTimeout(r, ms));

    // Blur the field being edited and wait (a little) for what its form has in flight. A click on a link
    // already took the focus away (the browser blurs at mousedown, and the change that runs a save with it),
    // so the field last typed in counts too.
    async function settle(ctx) {
        let a = document.activeElement, ms = cfg().settle ?? 1000, now = a?.matches?.(FIELD) ? a : edited?.isConnected ? edited : null;
        if (!ms || !now || now === ctx.sourceElement) return;
        let form = owner(now), end = Date.now() + ms, busy = () => [...sent].some(([c, o]) => c !== ctx && o === form);
        if (now === a) a.blur();
        await pause(0);
        while (busy() && Date.now() < end) {
            let wake;
            await Promise.race([new Promise(r => waiters.add(wake = r)), pause(end - Date.now())]);
            waiters.delete(wake);
        }
    }

    document.addEventListener('input', evt => { if (evt.target.matches?.(FIELD)) dirty.add(edited = evt.target) }, true);
    document.addEventListener('reset', evt => { for (let c of evt.target.elements || []) dirty.delete(c) }, true);

    window.addEventListener('beforeunload', evt => {
        if (cfg().confirmLeave && [...document.querySelectorAll(FIELD)].some(c => dirty.has(c))) {
            evt.preventDefault();
            evt.returnValue = '';
        }
    });

    //------------------------------------------------------
    // the current link
    //------------------------------------------------------

    // Marks the links of a subtree that point to the page being shown, and clears the others.
    function current(root = document) {
        if (cfg().current === false) return;
        let here = location.origin + location.pathname + location.search;
        for (let a of [...root.querySelectorAll?.('a[href]') ?? [], ...root.matches?.('a[href]') ? [root] : []]) {
            let on = !a.hash && !a.hasAttribute('download') && (!a.target || a.target === '_self') && a.origin + a.pathname + a.search === here;
            if (on) {
                a.classList.add('ypy-current');
                a.setAttribute('aria-current', 'page');
            } else if (a.classList.contains('ypy-current') || a.getAttribute('aria-current') === 'page') {
                a.classList.remove('ypy-current');
                a.removeAttribute('aria-current');
            }
        }
    }

    window.addEventListener('popstate', () => current());

    //------------------------------------------------------
    // ypy-once
    //------------------------------------------------------

    // links that ask to be prefetched when they become visible
    function watch(root) {
        if (typeof IntersectionObserver != 'function') return;
        for (let a of [...root.querySelectorAll?.('a[href]') ?? [], ...root.matches?.('a[href]') ? [root] : []]) {
            if (/visible/.test(mode(a))) {
                io ||= new IntersectionObserver(entries => entries.forEach(x => {
                    if (x.isIntersecting) { io.unobserve(x.target); waiting.push(x.target); pump() }
                }));
                io.observe(a);
            }
        }
    }

    // The scripts of a subtree that ask to run once, with their identity.
    const onceScripts = root => [...root.querySelectorAll?.(sel('script[ypy-once]')) ?? []].map(s =>
        [s, api.attr(s, 'ypy-once') || s.getAttribute('src') || s.textContent]);

    ypy.registerExtension('ypy-nav', {
        init: a => { api = a },

        // a new page, or new content: the current link, and the scripts that came with it
        ypy_after_process: root => {
            current(root);
            watch(root);
            for (let [, id] of onceScripts(root)) ran.add(id);
        },

        ypy_after_history_update: () => current(),

        // a script that already ran does not come in again
        ypy_before_swap: (elt, {tasks}) => {
            for (let {fragment} of tasks) {
                for (let [script, id] of fragment ? onceScripts(fragment) : []) {
                    if (ran.has(id)) script.remove();
                    else ran.add(id);
                }
            }
        },

        // the click uses the response of the prefetch when it is the same request; a navigation first
        // lets the field being edited settle
        ypy_before_request: (elt, {ctx}) => {
            let r = ctx.request, e = r.method === 'GET' && !r.body && cache.get(r.action);
            sent.set(ctx, owner(elt));
            if (e && e.k === key(r.headers)) {
                cache.delete(r.action);
                clearTimeout(e.t);
                let real = ctx.fetch;
                ctx.fetch = (...args) => e.p.catch(() => real(...args));
            }
            if (r.headers['YPY-Boosted'] || ctx.push && ctx.push !== 'false') {
                let real = ctx.fetch;
                ctx.fetch = async (...args) => { await settle(ctx); return real(...args) };
            }
        },

        ypy_finally_request: (elt, {ctx}) => {
            sent.delete(ctx);
            waiters.forEach(w => w());
            let res = ctx.response;
            if (res && res.status >= 200 && res.status < 300 && ctx.request.method !== 'GET') {
                let o = elt.matches?.(FIELD) ? elt : owner(elt);
                for (let c of o.elements || [o]) dirty.delete(c);
            }
        },

        // a whole page from outside the app is loaded as a page, not swapped in
        ypy_after_request: (elt, {ctx}) => {
            let r = ctx.request, res = ctx.response, url;
            if (!r.headers['YPY-Boosted'] || r.headers['YPY-History-Restore-Request'] || res.status >= 400) return;
            try { url = new URL(res.raw.url || r.action, document.baseURI) } catch { return }
            let root = cfg().root || (document.querySelector(sel('[ypy-history-elt]')) ? sel('[ypy-history-elt]') : ''), t = ctx.text,
                out = url.origin !== location.origin || /<(!doc|html|body)/i.test(t) && root && (r.method === 'GET' || ctx.redirected) &&
                    !new DOMParser().parseFromString(api.ttPolicy().createHTML(t), 'text/html').querySelector(root);
            if (out) {
                (ypy._loc || location).href = url.href;
                return false;
            }
        },

        // the page changed: what was prefetched for the old one is stale
        ypy_after_swap: (elt, {ctx}) => { if (ctx.request.headers['YPY-Boosted']) clear() }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-progress.js
//
// A progress bar for navigation, with no CSS to write and nothing to configure.
//
// While a boosted navigation (or a history restore) is waiting for the server, a thin bar runs
// along the top of the page. It appears only after a delay (200 ms), so a fast answer shows
// nothing, and it fills to the end when the last request finishes. An element or a region
// asks for it with ypy-progress (any request of that element shows the bar) and turns it off
// with ypy-progress="false". With config.progress.all every request shows it.
//
// The bar is one element (<ypy-progress-bar>) appended to <html>, outside <body>, so a swap
// never removes it. It is a shadow root host with its own stylesheet, adopted with the
// Constructable Stylesheet API: no <style> element and no style attribute, so a strict CSP is
// fine, and the CSS of the page cannot reach it. Set the variables on :root (the bar is a child
// of <html>, so they must be set there or on <html>):
//   --ypy-progress-color     #2563eb   bar color
//   --ypy-progress-height    3px
//   --ypy-progress-shadow    glow of the bar (any box-shadow)
//   --ypy-progress-z         z-index
//   --ypy-progress-max       90%       how far the bar goes before the response
//   --ypy-progress-duration  10s       time to get there
// The bar has role="progressbar" and a label (config.progress.label, "Loading" by default); it
// is in the page only while it shows. prefers-reduced-motion turns the animation off.
//
// Configuration (ypy.config.progress): delay (ms, default 200), all (false), label ("Loading").
//
// Only the public API and the extension API are used.
//==========================================================
(() => {

    let api, sheet, host, bar, timer, hideTimer, count = 0;
    const live = new WeakSet();   // requests that count
    const cfg = () => ypy.config.progress || {};

    const CSS_TEXT = `:host{all:initial;position:fixed;top:0;left:0;right:0;height:var(--ypy-progress-height,3px);` +
        `z-index:var(--ypy-progress-z,2147483000);pointer-events:none}` +
        `div{height:100%;width:0;background:var(--ypy-progress-color,#2563eb);` +
        `box-shadow:var(--ypy-progress-shadow,0 0 8px var(--ypy-progress-color,#2563eb));` +
        `transition:width var(--ypy-progress-duration,10s) cubic-bezier(.1,.7,.3,1),opacity .3s ease .1s}` +
        `div[data-ypy-state=run]{width:var(--ypy-progress-max,90%)}` +
        `div[data-ypy-state=done]{width:100%;opacity:0;transition:width .2s ease-out,opacity .3s ease .2s}` +
        `@media (prefers-reduced-motion:reduce){div{transition:none}}`;

    function show() {
        remove();
        if (!sheet) {
            try { (sheet = new CSSStyleSheet()).replaceSync(CSS_TEXT) } catch { sheet = null; return }
        }
        host = document.createElement('ypy-progress-bar');   // no style of the page for div, p... reaches it
        let root = host.attachShadow({mode: 'open'});
        root.adoptedStyleSheets = [sheet];
        bar = root.appendChild(document.createElement('div'));
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', cfg().label ?? 'Loading');
        document.documentElement.append(host);
        bar.offsetWidth;   // the bar starts from zero, not from its final state
        bar.dataset.ypyState = 'run';
    }

    function remove() {
        clearTimeout(hideTimer);
        host?.remove();
        host = bar = null;
    }

    function wanted(ctx) {
        let region = ctx.sourceElement.closest?.(api.prefixSelector('[ypy-progress]')), h = ctx.request.headers;
        let value = region && (api.attr(region, 'ypy-progress') || 'true');
        return value ? value !== 'false' : cfg().all || h['YPY-Boosted'] || h['YPY-History-Restore-Request'];
    }

    ypy.registerExtension('ypy-progress', {
        init: a => { api = a },

        ypy_before_request: (elt, {ctx}) => {
            if (!wanted(ctx) || live.has(ctx)) return;
            live.add(ctx);
            if (++count === 1) {
                clearTimeout(timer);
                timer = setTimeout(show, cfg().delay ?? 200);
            }
        },

        ypy_finally_request: (elt, {ctx}) => {
            if (!live.delete(ctx) || --count) return;
            clearTimeout(timer);
            if (bar) {
                bar.dataset.ypyState = 'done';
                hideTimer = setTimeout(remove, 600);
            }
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-persist.js
//
// Elements that outlive a navigation, and deploy detection.
//
// ypy-persist. An element with an id and ypy-persist stays in the page when a navigation (a
// boosted link or form, back and forward) brings a response that holds an element with the same
// id: the live element, with its state (a playing video, an iframe, typed text, a third-party
// widget), takes the place of the new one. The attribute goes on the live element only; the
// server does not have to mark the next page. It is the same mechanism as ypy-preserve, applied
// to the elements the page asks to keep. A response without the id removes the element as any
// other. A swap that is not a navigation never keeps anything.
//
// ypy-track="reload". An element of the page (usually in <head>) that carries it names a value:
// <meta name="app-version" content="a1b2c3" ypy-track="reload">. When a response that is a whole
// page does not carry the same tracked elements with the same values (a changed content, href,
// src or text, an element added or gone), the page was deployed after it loaded: the extension
// fires the cancelable ypy:track:reload event (detail: {url, from, to}) and, unless a listener
// cancels it (the response is then swapped as usual), loads the URL of the response with a
// normal page load instead of swapping it. A
// response that is a fragment, an error, or the answer to a request that is not a GET never
// triggers it. A page that tracks nothing pays one attribute lookup per response.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {

    let api;

    const sel = s => api.prefixSelector(s);

    // the identity and value of every tracked element of a document, in a comparable form
    const tracked = doc => [...doc.querySelectorAll(sel('[ypy-track="reload"]'))].map(e =>
        e.tagName + '|' + (e.getAttribute('name') || e.id) + '|' +
        (e.getAttribute('content') ?? e.getAttribute('href') ?? e.getAttribute('src') ?? e.getAttribute('value') ?? e.textContent)).sort();

    ypy.registerExtension('ypy-persist', {
        init: a => { api = a },

        ypy_before_swap: (elt, {ctx, tasks}) => {
            let h = ctx.request.headers;
            if (!h['YPY-Boosted'] && !h['YPY-History-Restore-Request']) return;
            for (let live of document.querySelectorAll(sel('[ypy-persist][id]'))) {
                if (api.attr(live, 'ypy-persist') === 'false') continue;
                for (let task of tasks) {
                    // the response copy becomes a ypy-preserve element, and the core keeps the live one
                    task.fragment?.querySelector?.('#' + CSS.escape(live.id))?.setAttribute('ypy-preserve', '');
                }
            }
        },

        ypy_after_request: (elt, {ctx}) => {
            let {text, request: r, response} = ctx, now = tracked(document);
            if (r.method !== 'GET' || response.status >= 400 || !now.length && !text.includes('ypy-track') ||
                !/<(?:!doctype|html|head|body)\b/i.test(text.slice(0, 2048))) return;
            let policy = api.ttPolicy();
            let next = tracked(new DOMParser().parseFromString(policy ? policy.createHTML(text) : text, 'text/html'));
            if (now.join() === next.join()) return;
            let url = response.raw.url || new URL(r.action, document.baseURI).href;
            if (!api.triggerEvent(elt, 'ypy:track:reload', {ctx, url, from: now, to: next})) return;
            location.assign(url);
            return false;
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-lazy.js
//
// Regions that load when they come into view.
//
//   <div ypy-lazy="/reports/summary">Loading the summary...</div>
//
// The value is the URL of a GET request (the same origin, like every YPY request). When the
// element is about to be seen (config.lazy.margin, 200px by default) the extension requests
// the URL and the response replaces the element (outerHTML; ypy-swap, ypy-target and the other
// attributes of the element work as on ypy-get). It is an attribute, never a Custom Element, so
// it works on <tr>, <tbody>, <li>... where a Custom Element is not allowed. The element needs a
// box to be seen: an <option>, or anything with display:none or display:contents, never loads.
//
// While it waits, the content of the element is the placeholder. It is also what a visitor
// without JavaScript sees, so put a link there: <div ypy-lazy="/panel"><a href="/panel">Open
// the panel</a></div>. ypy-lazy-placeholder="#id" names a <template> (or an element) whose
// content replaces the children as soon as the element is processed, for a skeleton that only
// visitors with JavaScript get. The core marks the element during the request (the ypy-request
// class, data-ypy-state="request", aria-busy).
//
// If the request fails (no connection, a status of 400 or more, a swap error) the element gets
// data-ypy-state="error" and ypy:lazy:error fires on it with {ctx, error}. The body of an error
// response is not swapped in (ypy-error-swap="outerHTML" asks for it). ypy-lazy-error="#id"
// names a <template> (or an element) whose content replaces the children. An element with
// ypy-lazy-retry inside a failed region loads it again when clicked.
//
// Grouping. Several regions that come into view together can share one request:
//
//   <div id="sales"  ypy-lazy="/reports/sales"  ypy-lazy-group="reports">...</div>
//   <div id="visits" ypy-lazy="/reports/visits" ypy-lazy-group="reports">...</div>
//
// Regions of the same group (the name) that enter the view within config.lazy.window (50 ms by
// default) are loaded with one GET: the URL is ypy-lazy-group-url of the first region that has it, or
// the ypy-lazy of the first region, plus ?group=<name>&id=<id>&id=<id> (the ids of the regions, in
// the order they came into view) and the header YPY-Lazy-Group. The server answers with one
// <ypy-partial id="sales">...</ypy-partial> per id; a partial with no ypy-swap replaces its region,
// like an individual region does. A region the answer leaves out is an error, like a failed one. A
// region without an id, or one that is alone in its window, loads on its own with its own URL, so
// the individual mode needs nothing from the server.
//
// Elements that carry ypy:before:init gates (the nonce extension) are checked like any other
// element YPY starts: an element that does not pass never loads. Only the public API and the
// extension API are used.
//==========================================================
(() => {

    let api, io;
    const groups = new Map();   // name -> {elts, timer}
    const sel = s => api.prefixSelector(s);

    // the content of a <template> or of an element, cloned; null when the attribute is absent or
    // its selector finds nothing (":not(*)" matches nothing)
    function content(elt, name) {
        let src = document.querySelector(api.attr(elt, name) || ':not(*)');
        return src && (src.content || src).cloneNode(true).childNodes;
    }

    function setState(elt, state, on) {
        let tokens = (elt.dataset.ypyState || '').split(' ').filter(s => s && s !== state);
        if (on) tokens.push(state);
        tokens[0] ? elt.dataset.ypyState = tokens.join(' ') : delete elt.dataset.ypyState;
    }

    function load(elt) {
        let group = api.attr(elt, 'ypy-lazy-group');
        if (!group || !elt.id) return single(elt);
        let g = groups.get(group);
        if (!g) groups.set(group, g = {elts: [], timer: setTimeout(() => flush(group), windowMs())});
        if (!g.elts.includes(elt)) g.elts.push(elt);
    }

    function windowMs() {
        let w = ypy.config.lazy?.window ?? 50;
        return typeof w == 'number' ? w : parseFloat(w) * (/\ds$/.test(w) ? 1000 : 1) || 0;
    }

    function single(elt) {
        let swap = api.attr(elt, 'ypy-swap') ?? 'outerHTML';
        setState(elt, 'error');
        ypy.ajax('GET', api.attr(elt, 'ypy-lazy'), {source: elt, target: elt, swap})
            .catch(error => fail(elt, {error}));
    }

    function flush(name) {
        let elts = groups.get(name).elts.filter(x => x.isConnected && x._ypy?.lazy);
        groups.delete(name);
        if (elts.length < 2) return elts.forEach(single);
        let first = elts[0], url = new URL(elts.map(x => api.attr(x, 'ypy-lazy-group-url')).find(Boolean) ||
            api.attr(first, 'ypy-lazy'), document.baseURI);
        url.searchParams.set('group', name);
        for (let x of elts) url.searchParams.append('id', x.id);
        elts.forEach(x => setState(x, 'error'));
        api.triggerEvent(first, 'ypy:lazy:group', {group: name, ids: elts.map(x => x.id), url: url.href});
        let batch = {elts, hit: new Set()};
        ypy.ajax('GET', url.origin == location.origin ? url.pathname + url.search + url.hash : url.href,
            {source: first, target: first, swap: 'none', lazyBatch: batch, headers: {'YPY-Lazy-Group': name}})
            .catch(error => failAll(batch, {error}))
            .then(() => failAll(batch, {error: new Error('ypy-lazy: no partial for the region')}, true));
    }

    // the regions of a batch the answer did not reach (missing: only the ones with no partial)
    function failAll(batch, detail, missing) {
        for (let x of batch.elts) {
            if (!(missing && batch.hit.has(x)) && !x.dataset.ypyState?.includes('error')) fail(x, detail);
        }
    }

    function fail(elt, detail) {
        if (!elt._ypy?.lazy || !elt.isConnected) return;
        setState(elt, 'error', true);
        let error = content(elt, 'ypy-lazy-error');
        if (error) elt.replaceChildren(...error);
        api.triggerEvent(elt, 'ypy:lazy:error', detail);
    }

    function watch(elt) {
        if (elt._ypy?.lazy || elt.closest(sel('[ypy-ignore]')) || !api.attr(elt, 'ypy-lazy') ||
            !api.triggerEvent(elt, 'ypy:before:init', {})) return;
        let state = api.ypyProp(elt), placeholder = content(elt, 'ypy-lazy-placeholder');
        state.lazy = 1;
        if (placeholder) elt.replaceChildren(...placeholder);
        let retry = evt => {
            let button = evt.target.closest?.(sel('[ypy-lazy-retry]'));
            if (button && elt.contains(button) && elt.dataset.ypyState?.includes('error')) load(elt);
        };
        elt.addEventListener('click', retry);
        state.listeners.push({fromElt: elt, eventName: 'click', handler: retry});
        if (typeof IntersectionObserver == 'function') {
            io ||= new IntersectionObserver(entries => entries.forEach(x => {
                if (x.isIntersecting) { io.unobserve(x.target); load(x.target) }
            }), {rootMargin: ypy.config.lazy?.margin ?? '200px'});
            io.observe(elt);
        } else {
            load(elt);
        }
    }

    ypy.registerExtension('ypy-lazy', {
        init: a => { api = a },

        ypy_after_process: root => {
            for (let elt of [...root.querySelectorAll?.(sel('[ypy-lazy]')) ?? [], ...root.matches?.(sel('[ypy-lazy]')) ? [root] : []]) {
                watch(elt);
            }
        },

        ypy_before_cleanup: elt => { if (elt._ypy?.lazy) io?.unobserve(elt) },

        // the partials of a group answer: a partial that names no swap replaces its region, and every
        // region that got one is marked as reached
        ypy_before_swap: (elt, {ctx, tasks}) => {
            let batch = ctx.lazyBatch;
            for (let task of batch ? tasks : []) {
                if (!batch.elts.includes(task.target)) continue;
                batch.hit.add(task.target);
                if (task.swapSpec.default) task.swapSpec = {...task.swapSpec, style: (api.attr(task.target, 'ypy-swap') || 'outerHTML').split(/\s/)[0]};
            }
        },

        // a failed region shows its own error content: the body of the error response is not swapped
        // in, unless the element chose a destination with ypy-error-swap
        ypy_response_error: (elt, {ctx}) => {
            if (elt._ypy?.lazy && api.attributeValue(elt, 'ypy-error-swap') == null) ctx.swap = 'none';
            ctx.lazyBatch ? failAll(ctx.lazyBatch, {ctx}) : fail(elt, {ctx});
        },

        ypy_error: (elt, detail) => detail.ctx?.lazyBatch ? failAll(detail.ctx.lazyBatch, detail) : fail(elt, detail)
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-cache.js
//
// A response cache with revalidation for ypy: the page shows the copy it has at once, asks the
// server whether it is still current, and swaps again only when it is not (stale-while-revalidate).
//
// Opt in per element with ypy-cache (inherited with ypy-cache:inherited) or for every GET with
// ypy.config.cache.all. Only GET requests to the page's own origin are kept, and never a response
// whose Cache-Control says no-store, or private unless the element asks for it with `private`.
//
// Options (attribute value, as HCON, over ypy.config.cache): ttl (10m: an older copy is not shown,
// it is only revalidated), fresh (0: a copy younger than this is shown without asking, the
// server's max-age wins), offline (keep the copy in sessionStorage and show it when the network
// fails), private, size (50 entries), bytes (2 MiB of text). ypy-cache="false" turns it off.
//
// Expiring is not removing. The server marks copies with two response headers, each a comma
// separated list of patterns (`/items*`, `/cart`, `*`, `tag:products`) or `false`:
//   YPY-Cache-Expire  the copy is marked old: it is still shown at once, and always revalidated
//                     (stale-while-revalidate), whatever its age or max-age;
//   YPY-Cache-Evict   the copy is deleted: the next request goes to the server and waits for it.
// A successful request that is not a GET evicts everything unless the response carries either
// header (`false` keeps everything). ypy.cache.expire(patterns) and ypy.cache.evict(patterns) do
// the same from script.
//
// Tags. ypy-cache-tags="products, featured" on the element (inherited with
// ypy-cache-tags:inherited) labels the copy of its request; the pattern `tag:products` then names
// every copy with that tag, in either header or in the script API.
//
// How it hooks in: from ypy_before_request the extension wraps ctx.fetch, so a copy is answered as
// a response and every later phase (headers, status codes, swap) runs as for the network. The
// copy is stored in ypy_after_request, when the body has been read. After the swap
// (ypy_finally_request) a copy that was not fresh is revalidated with If-None-Match and
// If-Modified-Since; a 304 or an identical body changes nothing, a new body is swapped again into
// the same target with the original context, without a history entry, scroll or focus change.
// While it runs the target carries the ypy-revalidating class.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <script src="ypy-cache.js"></script>
//   <a ypy-get="/reports" ypy-target="#main" ypy-cache>Reports</a>
//==========================================================
(() => {

    let api;
    const KEY = 'ypy-cache:';
    const store = new Map();         // key -> entry, oldest first (a hit moves its entry last)
    const latest = new WeakMap();    // target element -> the last request that went to it
    // the response headers worth replaying with a copy: what the swap reads, not one-off events
    const KEEP = /^(content-type|etag|last-modified|cache-control|vary|ypy-(retarget|reswap|reselect|push-url|replace-url))$/;
    let chars = 0;                   // text held by the store

    const lower = pairs => Object.fromEntries([...pairs].map(([k, v]) => [k.toLowerCase(), v]));
    const options = attr => ({size: 50, bytes: 2097152, ttl: '10m', fresh: 0, ...ypy.config.cache, ...api.HCON.parse(attr)});

    // Removes a copy from the store and from sessionStorage.
    function drop(key) {
        let e = store.get(key);
        if (!e) return;
        chars -= e.text.length;
        store.delete(key);
        if (e.off) try { sessionStorage.removeItem(KEY + key) } catch {}
    }

    // Does the pattern name the copy? `tag:x` is a tag; `*` is anything; otherwise a path, with `*` as a wildcard.
    const matches = (p, e) => /^tag:/.test(p) ? (e.tags || []).includes(p.slice(4).trim()) : p === '*' || (p.includes('*')
        ? new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(e.path)
        : p === e.path || p === e.path.split('?')[0]);

    const persist = e => { if (e.off) try { sessionStorage.setItem(KEY + e.key, JSON.stringify(e)) } catch {} };

    // Marks old (shown, then revalidated) or, with `evict`, deletes the copies the comma separated patterns name; returns how many.
    function mark(spec, evict) {
        let patterns = String(spec).split(',').map(s => s.trim()).filter(Boolean), n = 0;
        for (let [key, e] of store) {
            if (!patterns.some(p => matches(p, e))) continue;
            n++;
            if (evict) drop(key);
            else if (!e.stale) { e.stale = true; persist(e) }
        }
        if (n) api.triggerEvent(document, evict ? 'ypy:cache:evict' : 'ypy:cache:expire', evict ? {patterns, removed: n} : {patterns, expired: n});
        return n;
    }

    // Keeps the response in the store, unless it must not be kept.
    function save(ctx, c) {
        let {response, text} = ctx, h = lower(response.headers), cc = h['cache-control'] || '', o = c.o;
        drop(c.key);
        if (/no-store/i.test(cc) || /private/i.test(cc) && !o.private || /^\s*\*/.test(h.vary) || text.length > o.bytes / 2) return;
        let age = /max-age=(\d+)/i.exec(cc)?.[1];
        let e = {
            key: c.key, href: c.url.href, path: c.url.pathname + c.url.search, text, time: Date.now(),
            headers: Object.fromEntries(Object.entries(h).filter(([k]) => KEEP.test(k))),
            vary: Object.fromEntries((h.vary || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(n => [n, c.rh[n] ?? ''])),
            fresh: age == null ? undefined : age * 1000, redirected: !!ctx.redirected, off: !!o.offline, tags: c.tags
        };
        store.set(c.key, e);
        chars += text.length;
        persist(e);
        while (store.size > o.size || chars > o.bytes) drop(store.keys().next().value);
    }

    // The stored copy as the response the core expects.
    function reply(ctx, e, offline) {
        api.triggerEvent(ctx.sourceElement, 'ypy:cache:hit', {ctx, url: e.href, age: Date.now() - e.time, offline: !!offline});
        // a response proves the connection to the core: say again that the device is offline
        if (!navigator.onLine) setTimeout(() => window.dispatchEvent(new Event('offline')));
        return Object.defineProperties(new Response(e.text, {status: 200, headers: e.headers}), {
            url: {value: e.href}, redirected: {value: e.redirected}
        });
    }

    // Asks the server whether the copy shown is still current; swaps again when it is not.
    async function revalidate(ctx, c) {
        let e = c.hit, mark = ctx.target?.isConnected ? ctx.target : ctx.sourceElement, headers = {...ctx.request.headers};
        let done = (changed, status) => api.triggerEvent(ctx.sourceElement, 'ypy:cache:revalidated', {ctx, url: e.href, changed, status});
        if (e.headers.etag) headers['If-None-Match'] = e.headers.etag;
        if (e.headers['last-modified']) headers['If-Modified-Since'] = e.headers['last-modified'];
        mark.classList.add('ypy-revalidating');
        try {
            let {credentials, mode} = ctx.request;
            let res = await fetch(e.href, {method: 'GET', headers, credentials, mode, signal: AbortSignal.timeout(ypy.config.defaultTimeout || 30000)});
            if (res.status === 304) {
                e.time = Date.now();
                e.stale = false;
                persist(e);
                return done(false, 304);
            }
            if (res.status !== 200) {
                drop(c.key);
                return done(false, res.status);
            }
            let text = await res.text(), same = text === e.text;
            if (same) { e.time = Date.now(); e.stale = false; persist(e) }
            else save({response: res, text, redirected: res.redirected}, c);
            // the region may have moved on to another request or left the page: then only the copy is renewed
            let live = !same && latest.get(ctx.target) === ctx && ctx.target?.isConnected;
            done(live, 200);
            if (live) {
                let ypyHeaders = {};
                for (let [k, v] of res.headers) if (/^ypy-/i.test(k) && !/^ypy-(push|replace)-url$/i.test(k)) ypyHeaders[k.slice(4).toLowerCase().replace(/-/g, '')] = v;
                Object.assign(ctx, {
                    text, response: {raw: res, status: 200, headers: res.headers}, ypy: ypyHeaders,
                    push: 'false', replace: 'false', scroll: 'keep', focus: 'none', swap: ctx.swap + ' show:none'
                });
                ctx.request.anchor = undefined;
                await ypy.swap(ctx);
            }
        } catch {
            // offline or timed out: the copy stays, and the next request tries again
        } finally {
            mark.classList.remove('ypy-revalidating');
        }
    }

    ypy.registerExtension('ypy-cache', {

        init: (internalApi) => {
            api = internalApi;
            // copies kept for offline use by an earlier page of this tab
            try {
                let kept = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    let k = sessionStorage.key(i);
                    if (k?.startsWith(KEY)) try { kept.push(JSON.parse(sessionStorage.getItem(k))) } catch {}
                }
                for (let e of kept.sort((a, b) => a.time - b.time)) {
                    store.set(e.key, e);
                    chars += e.text.length;
                }
            } catch {}
            ypy.cache = {
                /** Marks old the copies named by the comma separated patterns (they are still shown, then revalidated); returns how many. */
                expire: spec => mark(spec),
                /** Deletes the copies named by the comma separated patterns; returns how many. */
                evict: spec => mark(spec, true),
                /** Deletes every copy (call it when the user signs out). */
                clear: () => mark('*', true),
                /** What the store holds, for tests and tooling. */
                stats: () => ({entries: store.size, chars})
            };
        },

        ypy_before_request: (elt, {ctx}) => {
            if (ctx.target?.nodeType === 1) latest.set(ctx.target, ctx);
            let {request} = ctx, attr = api.attributeValue(elt, 'ypy-cache'), url;
            if (request.method !== 'GET' || attr === 'false' || attr == null && !ypy.config.cache?.all) return;
            try { url = new URL(request.action, document.baseURI) } catch { return }
            if (url.origin !== location.origin) return;
            url.hash = '';
            let rh = lower(Object.entries(request.headers)), key = (rh['YPY-Request-Type'.toLowerCase()] || '') + ' ' + url.href;
            let e = store.get(key), o = options(attr);
            if (e && !Object.entries(e.vary).every(([n, v]) => (rh[n] ?? '') === v)) e = null;
            let tags = String(api.attributeValue(elt, 'ypy-cache-tags') ?? '').split(/[\s,]+/).filter(Boolean);
            let c = ctx.cache = {key, url, o, rh, tags}, age = e && Date.now() - e.time, inner = ctx.fetch;
            ctx.fetch = async (action, req) => {
                if (e && age <= ypy.parseInterval(o.ttl)) {
                    store.delete(key);
                    store.set(key, e);
                    c.hit = e;
                    c.fresh = !e.stale && age < (e.fresh ?? ypy.parseInterval(o.fresh));
                    return reply(ctx, e);
                }
                // too old to show: ask with its validators and keep it when the server agrees
                if (e?.headers.etag) req.headers['If-None-Match'] = e.headers.etag;
                if (e?.headers['last-modified']) req.headers['If-Modified-Since'] = e.headers['last-modified'];
                let res;
                try {
                    res = await inner(action, req);
                } catch (error) {
                    if (!e || !(o.offline || e.off) || req.signal.aborted) throw error;
                    c.hit = e;
                    c.fresh = true;
                    return reply(ctx, e, true);
                }
                if (res.status !== 304 || !e) return res;
                e.time = Date.now();
                e.stale = false;
                c.hit = e;
                c.fresh = true;
                return reply(ctx, e);
            };
        },

        ypy_after_request: (elt, {ctx}) => {
            let {response, request} = ctx, c = ctx.cache, h = lower(response.headers), old = h['YPY-Cache-Expire'.toLowerCase()], gone = h['YPY-Cache-Evict'.toLowerCase()];
            if (gone != null && gone.trim() !== 'false') mark(gone, true);
            if (old != null && old.trim() !== 'false') mark(old);
            if (old == null && gone == null && request.method !== 'GET' && response.status < 400 && !request.headers['YPY-Validate']) {
                mark('*', true);
            }
            if (c && !c.hit) response.status === 200 ? save(ctx, c) : drop(c.key);
        },

        ypy_finally_request: (elt, {ctx}) => {
            let c = ctx.cache;
            if (c?.hit && !c.fresh && ctx.status === 'swapped') revalidate(ctx, c);
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-optimistic.js
//
// Optimistic UI for ypy: the page shows the result of a request before the server answers, and
// puts things back if the request fails.
//
// ypy-optimistic names what to show: a <template> or element (`#liked`), `remove` (the target
// goes away), or a function registered with ypy.optimistic.register(name, fn). The content is
// applied to the request target with the request's swap style. ypy-optimistic-target (a selector,
// extended forms such as `closest li` work) and ypy-optimistic-swap choose another place or style.
// A function gets {ctx, source, target, values} and returns HTML, a node or a list of nodes, or an
// undo function when it changes the page by itself.
//
// What ends it, once per request:
//   - a 4xx or 5xx response, a network failure, an abort or a cancelled request: everything is put
//     back (the original nodes, not copies) and ypy:optimistic:rolledback fires;
//   - a success: ypy:optimistic:confirmed fires. If the response is swapped into the same element
//     the server's content replaces the optimistic one (the original nodes are put back first, so a
//     morph keeps their identity); if nothing is swapped there (204, swap:none, another target)
//     the optimistic content stays as the final state and is processed.
// There is one overlay per element: a second request that changes the same element replaces (or,
// for append and prepend, adds to) the first. The overlay ends with the first success, or when the
// last request that wanted it has failed. Every ypy:optimistic:applied is followed by exactly one confirmed or rolledback.
//
// An outer style (outerHTML, outerMorph, delete) shows the content before the target and hides the
// target, which stays in the page so the request and the swap that aim at it still find it.
// The change is made right after ypy:before:request, so a request that is queued, dropped or
// not confirmed leaves nothing behind. The optimistic nodes get the ypy-optimistic class and are
// not processed while they are temporary.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <template id="liked"><button disabled>Liked</button></template>
//   <button ypy-post="/like/7" ypy-target="this" ypy-swap="outerMorph" ypy-optimistic="#liked">Like</button>
//==========================================================
(() => {

    let api;
    const fns = new Map();
    const active = new WeakMap();    // target element -> its overlay
    const records = new WeakMap();   // request context -> {elt, overlay, ok, done}
    // where each insertion style puts the nodes, as the Element method that does it
    const WHERE = {beforebegin: 'before', before: 'before', afterend: 'after', after: 'after', afterbegin: 'prepend', prepend: 'prepend', beforeend: 'append', append: 'append'};

    // The nodes a specification stands for.
    function nodesFor(spec, elt, ctx, target) {
        let fn = fns.get(spec), out;
        if (fn) {
            out = fn({ctx, source: elt, target, values: Object.fromEntries(ctx.request.body ?? [])});
            if (typeof out == 'string') {
                let policy = api.ttPolicy(), tpl = document.createElement('template');
                if (!policy) return [];
                tpl.innerHTML = policy.createHTML(out);
                out = tpl.content;
            }
            if (out instanceof Node) return out.nodeType === 11 ? [...out.childNodes] : [out];
            return Array.isArray(out) || out instanceof NodeList ? [...out] : typeof out == 'function' ? out : null;
        }
        if (spec === 'remove') return [];
        let source = ypy.find(elt, spec);
        return source ? [...(source.content ?? source).childNodes].map(n => n.cloneNode(true)) : null;
    }

    // Shows the nodes on the overlay's target the way its swap style does. An outer style puts them
    // before the target and hides the target instead of taking it out: it stays in the page, so the
    // request that came from it, and the swap that is aimed at it, still find it.
    function put(o, nodes) {
        for (let n of nodes) n.classList?.add('ypy-optimistic');
        let t = o.target;
        if (o.outer) {
            o.display = t.style.display;
            t.before(...nodes);
            t.style.display = 'none';
        } else if (o.inner) {
            t.append(...nodes);
        } else {
            t[o.where](...nodes);
        }
    }

    // Puts the page back as it was, unless somebody else changed the place in the meantime.
    function revert(o) {
        if (o.done) return;
        o.done = true;
        if (active.get(o.target) === o) active.delete(o.target);
        if (o.undo) return o.undo();
        let {target: t, nodes, home} = o, intact = nodes.every(n => n.parentNode === home);
        for (let n of nodes) n.remove();
        if (o.outer) t.style.display = o.display;
        if (o.inner && intact) t.append(...o.saved.childNodes);
    }

    // The overlay's nodes become the real content.
    function commit(o) {
        if (o.done) return;
        o.done = true;
        if (active.get(o.target) === o) active.delete(o.target);
        if (o.outer) o.target.remove();
        for (let n of o.nodes ?? []) {
            n.classList?.remove('ypy-optimistic');
            if (n.nodeType === 1 && n.isConnected) ypy.process(n);
        }
    }

    // Ends the change of one request, once: `ok` keeps it (confirmed). Otherwise the request leaves
    // the overlay, and the page is put back when no other request still wants it.
    function settle(ctx, ok, detail) {
        let r = records.get(ctx), o = r?.overlay;
        if (!r || r.settled) return;
        r.settled = true;
        if (ok) commit(o);
        else {
            o.ctxs.delete(ctx);
            if (!o.ctxs.size) revert(o);
        }
        api.triggerEvent(r.elt, 'ypy:optimistic:' + (ok ? 'confirmed' : 'rolledback'), {ctx, target: o.target, ...detail});
    }

    function apply(elt, ctx, spec) {
        let sel = api.attr(elt, 'ypy-optimistic-target'), target = sel ? ypy.find(elt, sel) : ctx.target;
        if (!elt.isConnected || !target?.isConnected) return;
        let swap = (api.attr(elt, 'ypy-optimistic-swap') || ctx.swap || '').trim(), style = /^\S*:/.test(swap) ? '' : swap.split(/\s+/)[0];
        if (!WHERE[style] && !/^(outer|inner|morph|delete)/.test(style)) style = 'innerHTML';
        let outer = /^(outer|delete)/.test(style), where = WHERE[style], inner = !outer && !where;
        let nodes = nodesFor(spec, elt, ctx, target), o = active.get(target);
        if (typeof nodes == 'function') {
            o = {target, undo: nodes};
        } else if (!nodes) {
            return;
        } else {
            if (o) {
                // one shape per element: a second change replaces the first (inner) or adds to it (insertion)
                if (o.undo || o.outer || outer || o.inner !== inner || o.where !== where) return;
                if (inner) o.nodes.forEach(n => n.remove());
                else o.nodes.push(...nodes);
                put(o, nodes);
                if (inner) o.nodes = nodes;
            } else {
                o = {target, nodes, outer, inner, where, ctxs: new Set()};
                o.home = outer || where === 'before' || where === 'after' ? target.parentNode : target;
                if (inner) {
                    o.saved = document.createDocumentFragment();
                    o.saved.append(...target.childNodes);
                }
                put(o, nodes);
                active.set(target, o);
            }
        }
        (o.ctxs ??= new Set()).add(ctx);
        records.set(ctx, {elt, overlay: o});
        if (!api.triggerEvent(elt, 'ypy:optimistic:applied', {ctx, target, nodes: o.nodes})) settle(ctx, false, {reason: 'cancelled'});
    }

    ypy.registerExtension('ypy-optimistic', {

        init: (internalApi) => {
            api = internalApi;
            ypy.optimistic = {
                /** Makes fn usable as ypy-optimistic="name". */
                register(name, fn) {
                    if (!name || typeof fn != 'function') throw new TypeError('register(name, fn)');
                    fns.set(name, fn);
                }
            };
        },

        ypy_before_request: (elt, {ctx}) => {
            let spec = api.attributeValue(elt, 'ypy-optimistic');
            // after the event has reached the element: the change may take the element out of the page
            if (spec && spec !== 'false') queueMicrotask(() => apply(elt, ctx, spec));
        },

        ypy_before_response: (elt, {ctx}) => {
            let r = records.get(ctx), {status} = ctx.response;
            if (!r) return;
            if (status >= 400) settle(ctx, false, {reason: 'status', status});
            else r.ok = status;
        },

        // the response is about to be swapped: the server's content replaces the optimistic one
        // where they meet, and the optimistic content stays where nothing else is put
        ypy_before_swap: (elt, {ctx, tasks}) => {
            let r = records.get(ctx), o = r?.overlay;
            if (!r || r.settled || !r.ok) return;
            let meets = tasks.some(t => {
                let to = typeof t.target == 'string' ? document.querySelector(t.target) : t.target, s = t.swapSpec?.style ?? t.swapSpec;
                return to === o.target && !/^none/.test(s);
            });
            if (meets && !o.undo) revert(o);
            settle(ctx, true, {status: r.ok});
        },

        ypy_error: (elt, {ctx}) => {
            if (ctx) settle(ctx, false, {reason: 'error', kind: ctx.errorKind});
        },

        ypy_finally_request: (elt, {ctx}) => {
            let r = records.get(ctx);
            if (r && !r.settled) settle(ctx, !!r.ok, r.ok ? {status: r.ok} : {reason: ctx.request.signal.aborted ? 'aborted' : 'cancelled'});
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-validate.js
//
// Field validation on the server for ypy: when the user leaves a field, the form's values go to a
// validation URL and the answer is shown next to the field. The form itself is never submitted.
//
// ypy-validate on a field turns it on. Its value is the URL to ask; a bare attribute asks the
// action of the form (ypy-post, ypy-action or action). ypy-validate="true" and ="false" keep their
// meaning in the core (the browser's own constraint check before a submit) and are not read here.
// ypy-validate-fields on a form, or on any element around fields, does the same for every field
// inside (a field with ypy-validate="false" is left out). ypy-validate-trigger, on the field or on
// the element that has ypy-validate-fields, changes when to ask (a trigger specification, default
// `change delay:200ms`: after the value changed, debounced).
//
// The request is a POST with every value of the form, so a rule can compare fields, and the header
// YPY-Validate with the name of the field. The server must check that header before it does
// anything else, and answer without saving: 422 with the message markup when the field is invalid,
// 204 or an empty 200 when it is valid. A 200 with a body shows that body (for example "available").
//
// Where the answer goes follows the core's error convention. ypy-error-target on the field names
// the place (a selector with the extended forms); without it the extension uses #<id>-error, and
// creates that element after the field when the page has none. ypy-error-swap (default innerHTML)
// and ypy-error-focus (default: the focus stays where the user is) are read from the field. The
// field gets aria-invalid="true" and aria-describedby pointing at the place on a 422, and loses
// aria-invalid when the field is valid. Any other error status is ignored: the form validates again
// when it is submitted.
//
// A new answer for a field cancels the one in flight, and a request sent by the form cancels the
// field requests of that form. Fields that arrive later are wired when their container is
// processed, a swap included.
//
// Batches. ypy-validate-batch on a field, on the element with ypy-validate-fields or on the form
// (the nearest one wins; the value is a time, a bare attribute means 50ms, false is off), or
// ypy.config.validate.batch, turns it on: the fields of one form that ask the same URL within
// that window go in one request, with YPY-Validate: field1,field2 (the names, in the order they
// asked). It is off by default, because the server must read the list. The answer: 422 when any
// field is invalid, 2xx when none is. The message of each invalid field comes as an
// out-of-band element whose id is the id of that field's place, for example
// `<small id="email-error" ypy-swap-oob="innerHTML">Taken</small>`; a field that has none is
// valid, and its place is emptied. aria-invalid and aria-describedby follow what each place
// shows. One field alone is checked as before, with the usual answer. If a field of a batch
// that is still in flight asks again, the request starts over with the whole batch.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <form ypy-post="/signup" ypy-validate-fields="/signup/validate">
//     <input name="email" id="email" type="email">
//     <small id="email-error"></small>
//   </form>
//==========================================================
(() => {

    let api, count = 0;
    const FIELDS = 'input,select,textarea';
    const flight = new WeakMap();   // field -> AbortController of its request (.fields: those of the batch)
    const groups = [];              // fields waiting for the end of a batch window: {form, url, fields}

    // The URL to ask for a field, or undefined when the field is not validated.
    function urlFor(field) {
        let own = api.attr(field, 'ypy-validate'), host = field.closest(api.prefixSelector('[ypy-validate-fields]'));
        let url = own != null && own !== 'true' && own !== 'false' ? own : own !== 'false' && host ? api.attr(host, 'ypy-validate-fields') : null;
        if (url == null) return;
        if (url) return url;
        let form = field.form;
        return form && (api.determineMethodAndAction(form, {}).action || form.getAttribute('action')) || location.pathname + location.search;
    }

    // The element that shows the answer: the one the field names, else #<id>-error (made when missing).
    function errorBox(field) {
        let sel = api.attr(field, 'ypy-error-target'), box = sel && ypy.find(field, sel);
        if (box) return box;
        let id = (field.id || field.name || 'field' + ++count) + '-error';
        if (!(box = document.getElementById(id))) {
            box = document.createElement('div');
            box.id = id;
            box.className = 'ypy-field-error';
            box.setAttribute('aria-live', 'polite');
            field.after(box);
        }
        return box;
    }

    // Asks the URL for the fields, in one request, and shows each answer in its place.
    function send(fields, url) {
        for (let f of fields) flight.get(f)?.abort();
        let abort = new AbortController(), boxes = fields.map(errorBox);
        abort.fields = fields;
        for (let f of fields) flight.set(f, abort);
        ypy.ajax('POST', url, {
            source: fields[0], target: boxes[0], swap: fields[1] ? 'none' : 'innerHTML',
            headers: {'YPY-Validate': fields.map(f => f.name || f.id).join(',')},
            request: {signal: abort.signal}, fieldValidation: {field: fields[0], box: boxes[0], fields, boxes, abort}
        }).catch(() => {});
    }

    // The window of a field's batch in ms, or 0 for none.
    function batchWindow(field) {
        let host = field.closest(api.prefixSelector('[ypy-validate-batch]')), v = host ? api.attr(host, 'ypy-validate-batch') : ypy.config.validate?.batch;
        return v === false || v === 'false' || v == null ? 0 : v === '' || v === true || v === 'true' ? 50 : ypy.parseInterval(v);
    }

    function flush(group) {
        groups.splice(groups.indexOf(group), 1);
        let fields = [...group.fields].filter(f => f.isConnected && (f.name || f.id));
        if (fields.length) send(fields, group.url);
    }

    function validate(field) {
        let url = urlFor(field), ms = url != null && batchWindow(field);
        if (url == null || !(field.name || field.id) || !field.isConnected) return;
        if (!ms) return send([field], url);
        let group = groups.find(g => g.form === field.form && g.url === url);
        if (!group) {
            group = {form: field.form, url, fields: new Set()};
            group.timer = setTimeout(flush, ms, group);
            groups.push(group);
        }
        group.fields.add(field);
        // a batch of the field that is still in flight starts over with it
        flight.get(field)?.fields.forEach(f => group.fields.add(f));
    }

    function wire(field) {
        if (urlFor(field) == null) return;
        let state = api.ypyProp(field);
        if (state.validate) return;
        state.validate = true;
        let host = field.closest(api.prefixSelector('[ypy-validate-fields]'));
        api.onTrigger(field, api.attr(field, 'ypy-validate-trigger') || host && api.attr(host, 'ypy-validate-trigger') || 'change delay:200ms', () => validate(field));
    }

    // Wires the fields of a processed subtree: the ones that name a URL, and those in a container that does.
    function scan(root) {
        let fields = new Set(), selector = api.prefixSelector('[ypy-validate],[ypy-validate-fields]');
        let add = e => e.matches?.(FIELDS) ? fields.add(e) : e.querySelectorAll?.(FIELDS).forEach(f => fields.add(f));
        for (let e of [root, ...root.querySelectorAll?.(selector) ?? []]) if (e.matches?.(selector)) add(e);
        if (root.closest?.(api.prefixSelector('[ypy-validate-fields]'))) add(root);
        fields.forEach(wire);
    }

    ypy.registerExtension('ypy-validate', {

        init: (internalApi) => { api = internalApi },

        ypy_after_process: (elt) => { scan(elt) },

        // a request of the form (its own submit) outranks the field checks that are still running
        ypy_before_request: (elt, {ctx}) => {
            if (ctx.fieldValidation) return;
            for (let f of ctx.request.form?.elements ?? []) flight.get(f)?.abort();
        },

        ypy_after_request: (elt, {ctx}) => {
            let v = ctx.fieldValidation;
            if (!v) return;
            let ok = ctx.response.status < 400;
            // a batch: every place starts empty, the answer fills those of the invalid fields
            if (v.fields[1] && (ok || ctx.response.status === 422)) v.boxes.forEach(b => b.replaceChildren());
            // valid and nothing to say: leave nothing of an earlier message
            else if (ok && !ctx.text.trim()) {
                ctx.swap = 'none';
                v.box.replaceChildren();
            }
        },

        ypy_response_error: (elt, {ctx}) => {
            let v = ctx.fieldValidation;
            if (!v) return;
            if (ctx.response.status !== 422) {
                ctx.swap = 'none';
                return;
            }
            let a = name => api.attr(v.field, 'ypy-error-' + name), focus = a('focus');
            ctx.target = v.box;
            ctx.swap = v.fields[1] ? 'none' : a('swap') || 'innerHTML';
            ctx.focus = focus == null || focus === 'false' ? false : focus;
        },

        ypy_finally_request: (elt, {ctx}) => {
            let v = ctx.fieldValidation;
            if (!v) return;
            for (let f of v.fields) if (flight.get(f) === v.abort) flight.delete(f);
            if (ctx.status !== 'swapped') return;
            let status = ctx.response.status;
            v.fields.forEach((field, i) => {
                let box = v.boxes[i], ids = (field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
                // a batch names the invalid fields by what their places show
                if (status === 422 && (!v.fields[1] || box.hasChildNodes())) {
                    field.setAttribute('aria-invalid', 'true');
                    if (!ids.includes(box.id)) field.setAttribute('aria-describedby', [...ids, box.id].join(' '));
                } else if (status < 400 || status === 422) {
                    field.removeAttribute('aria-invalid');
                }
            });
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-upload.js
//
// Upload progress for ypy.
//
// fetch() cannot report how much of a request body has been sent, so a progress bar needs
// XMLHttpRequest. This extension swaps the transport of one request, and only that request,
// when both are true:
//   1. the body is a FormData that holds at least one File that is not empty, and
//   2. the element asks for progress with the ypy-upload-progress attribute (on the element,
//      on the form, or on a container with ypy-upload-progress:inherited).
// Every other request, including a file upload without the attribute, keeps going through fetch.
//
// While the file is sent, the event ypy:upload:progress (not cancelable) fires on the source
// element with {loaded, total, percent, ctx}. percent is a whole number from 0 to 100; when the
// browser does not know the total, total is 0 and percent stays at 0 until the upload ends.
//
// The attribute value is optional and names where to show the progress:
//   <form ypy-post="/files" ypy-upload-progress>             events only
//   <form ypy-post="/files" ypy-upload-progress="#bar">      also updates #bar
//   <form ypy-post="/files" ypy-upload-progress="false">     off for this element
// The element found by the selector gets the CSS variable --ypy-upload (for example "42%") and
// the attribute data-ypy-upload (the number), both set through the DOM API, so a strict CSP is
// fine. A <progress> element also gets max=100 and value. An element with role="progressbar"
// also gets aria-valuenow.
//
// What the core sees is the same as with fetch: ctx.fetch resolves with a Response (status,
// headers, body, redirected, url), the abort of ctx.request.signal (the timeout included) aborts
// the transfer and rejects with the signal's reason, and a failed transfer rejects with a
// TypeError, so ctx.errorKind and ypy-retry work as usual. Headers set on the request are sent;
// credentials "include" sets withCredentials. Limitations of XMLHttpRequest: credentials "omit"
// cannot hide the cookies of the same origin, and the request has no mode, cache or redirect
// option (redirects are followed).
//
// How it hooks in: like ypy-retry, from ypy_before_request this extension wraps ctx.fetch, so
// it stacks with ypy-retry and ypy-dev in any registration order.
//
// Only the public API and the extension API are used, so it works with the built core too.
//==========================================================
(() => {

    let api;

    const hasFile = body => body instanceof FormData && [...body.values()].some(v => v instanceof File && v.size);

    // Shows the progress in the element named by the attribute value.
    function show(target, percent) {
        if (!target) return;
        target.style.setProperty('--ypy-upload', percent + '%');
        target.setAttribute('data-ypy-upload', percent);
        if (target instanceof HTMLProgressElement) { target.max = 100; target.value = percent }
        if (target.getAttribute('role') === 'progressbar') target.setAttribute('aria-valuenow', percent);
    }

    // The request sent with XMLHttpRequest, resolved as a Response as fetch would.
    function send(elt, ctx, action, request, to) {
        let {signal} = request, off = new AbortController();
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(signal.reason);
            let xhr = new XMLHttpRequest(), up = xhr.upload;
            let report = (loaded, total) => {
                let percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : 0;
                show(to, percent);
                api.triggerEvent(elt, 'ypy:upload:progress', {loaded, total, percent, ctx});
            };
            xhr.open(request.method, action);
            xhr.responseType = 'blob';
            xhr.withCredentials = request.credentials === 'include';
            // no Content-Type for a FormData: the browser adds the multipart one with its boundary
            for (let [name, value] of Object.entries(request.headers || {})) {
                if (!/^content-type$/i.test(name)) xhr.setRequestHeader(name, value);
            }
            up.onloadstart = () => report(0, 0);
            up.onprogress = e => report(e.loaded, e.lengthComputable ? e.total : 0);
            // the last event is always 100, even when the browser reported few events
            up.onload = e => report(e.total || e.loaded, e.total || e.loaded);
            xhr.onload = () => {
                let headers = new Headers();
                for (let line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
                    let i = line.indexOf(':');
                    if (i > 0) try { headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()) } catch {}
                }
                let status = xhr.status, body = [204, 205, 304].includes(status) ? null : xhr.response;
                let response = new Response(body, {status, statusText: xhr.statusText, headers});
                Object.defineProperties(response, {
                    url: {value: xhr.responseURL},
                    redirected: {value: xhr.responseURL !== new URL(action, location.href).href}
                });
                resolve(response);
            };
            xhr.onerror = () => reject(new TypeError('Network error'));
            xhr.onabort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
            signal.addEventListener('abort', () => xhr.abort(), {signal: off.signal});
            xhr.send(request.body);
        }).finally(() => off.abort());
    }

    ypy.registerExtension('ypy-upload', {

        init: (internalApi) => { api = internalApi },

        ypy_before_request: (elt, {ctx}) => {
            // When ypy-retry registered first, ctx.fetch is its accessor: assigning to it puts this
            // wrapper inside the retry loop, and the call that stays is the plain window.fetch
            // (the same rule as ypy-dev)
            let inner = Object.getOwnPropertyDescriptor(ctx, 'fetch')?.set ? window.fetch.bind(window) : ctx.fetch || window.fetch.bind(window);
            ctx.fetch = (action, request) => {
                let attr = api.attributeValue(elt, 'ypy-upload-progress');
                if (attr == null || attr === 'false' || !hasFile(request.body) || /^(GET|HEAD)$/i.test(request.method)) {
                    return inner(action, request);
                }
                let to;
                try { to = attr && document.querySelector(attr) } catch {}
                return send(elt, ctx, action, request, to);
            };
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-csrf.js
//
// CSRF token on every unsafe request of the page, without relying on header inheritance.
//
// The page carries the token in a meta tag:
//
//   <meta name="ypy-csrf" content="TOKEN">
//   <meta name="ypy-csrf" content="TOKEN" data-header="X-CSRF-Token">
//
// data-header names the request header (default X-CSRF-Token). Every request that is not a GET or
// HEAD and goes to the origin of the page carries that header with the token, whatever the
// element, an inherited header or a boosted navigation did before. A request to another origin
// never carries it: a header of that name that an element inherited is removed from it, so the
// token cannot leak.
//
// Renewal: when a same-origin response carries a YPY-CSRF header, its value replaces the content
// of the meta tag (the tag is created when the page has none), and the next request uses it.
//
// Safety net: an unsafe same-origin request that leaves without a token fires the cancelable
// ypy:csrf:missing event on the source element, with {ctx, header}, and a console warning once
// per URL (cancel the event to silence it). The request still goes out: the server decides.
//
// The meta tag is read at each request, so a page that swaps its head, or a script that sets the
// content, is always followed. Only the public API and the extension API are used, so it works
// with the built core too.
//
// Usage:
//   <script src="ypy-csrf.js"></script>
//   <meta name="ypy-csrf" content="{{ token }}">
//==========================================================
(() => {

    const META = 'meta[name="ypy-csrf"]';
    const warned = new Set();
    let api;

    const sameOrigin = url => {
        try {
            return new URL(url, document.baseURI).origin === location.origin;
        } catch {
            return false;
        }
    };

    // Removes a header whatever its letter case (the names are case insensitive on the wire)
    const dropHeader = (headers, name) => {
        for (let key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    };

    ypy.registerExtension('ypy-csrf', {

        init: (internalApi) => { api = internalApi },

        ypy_before_request: (elt, {ctx}) => {
            let {method, action, headers} = ctx.request;
            if (/^(GET|HEAD)$/.test(method)) return;
            let meta = document.querySelector(META), header = meta?.getAttribute('data-header') || 'X-CSRF-Token';
            dropHeader(headers, header);
            if (!sameOrigin(action)) return;
            let token = meta?.getAttribute('content');
            if (token) {
                headers[header] = token;
            } else if (api.triggerEvent(elt, 'ypy:csrf:missing', {ctx, header}) && !warned.has(action)) {
                warned.add(action);
                console.warn(`ypy-csrf: ${method} ${action} has no CSRF token: add <meta name="ypy-csrf" content="...">`);
            }
        },

        ypy_before_response: (elt, {ctx}) => {
            let token = ctx.ypy?.csrf;
            if (!token || !sameOrigin(ctx.request.action)) return;
            let meta = document.querySelector(META);
            if (!meta) {
                meta = document.createElement('meta');
                meta.name = 'ypy-csrf';
                document.head.append(meta);
            }
            meta.setAttribute('content', token);
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-poll.js
//
// Smart polling for `every` triggers:
//   - in a background tab the poll slows down (4 times by default) or pauses,
//     and when the tab is shown again it refreshes at once if a poll is due
//   - the server sets the interval with the response header
//     YPY-Poll-Interval: <ms | 2s | 500ms | 1m>
//   - the status 286 stops the polling of that element (ypy:poll:stop)
//
// Usage:
//   <div ypy-get="/news" ypy-trigger="every 5s">...</div>
//   <div ypy-get="/news" ypy-trigger="every 5s" ypy-poll="hidden:pause">...</div>
//
// Options (attribute value or ypy.config.poll):
//   hidden:<n>      factor applied to the interval while the tab is hidden (default 4)
//   hidden:pause    no polling while the tab is hidden
//   min:<time>      shortest interval a server may ask for (default 100ms)
// ypy-poll="false" leaves the element to the core.
//==========================================================
(() => {
    let api;
    let entries = new Set();   // one per `every` spec that this extension drives

    let now = () => performance.now();

    // The options of an element: the defaults, ypy.config.poll, then the attribute.
    function options(elt) {
        let attr = api.attributeValue(elt, 'ypy-poll');
        return {hidden: 4, min: 100, ...ypy.config.poll, ...(attr == 'false' ? {} : api.HCON.parse(attr))};
    }

    // How many times slower the poll runs now: 1 in a visible tab, Infinity when it pauses.
    function factor(e) {
        if (!document.hidden) return 1;
        let h = options(e.elt).hidden;
        return h === 'pause' || h === false || h == 0 ? Infinity : h >= 1 ? +h : 4;
    }

    function stop(e) {
        clearTimeout(e.timer);
        e.stopped = true;
        entries.delete(e);
    }

    // Plans the next poll from the moment of the last one, so a change of interval or of
    // visibility never makes a poll come earlier than it is due, nor later.
    function schedule(e) {
        clearTimeout(e.timer);
        let f = factor(e);
        if (e.stopped || f === Infinity) return;
        e.timer = setTimeout(tick, Math.max(0, e.ms * f - (now() - e.last)), e);
    }

    function tick(e) {
        if (!e.elt.isConnected) return stop(e);
        e.last = now();
        api.triggerEvent(e.elt, 'every', {}, false);
        schedule(e);
    }

    // The interval a server asks for, in ms, or undefined when the header is missing or invalid.
    function serverInterval(elt, value) {
        let ms = ypy.parseInterval(String(value ?? '').trim());
        return ms > 0 ? Math.max(ms, ypy.parseInterval(options(elt).min) || 0) : undefined;
    }

    ypy.registerExtension('ypy-poll', {
        init(internalAPI) {
            api = internalAPI;
            document.addEventListener('visibilitychange', () => entries.forEach(schedule));
        },

        // The core starts a setInterval for each `every`: this takes it over.
        ypy_after_init(elt) {
            if (api.attributeValue(elt, 'ypy-poll') == 'false') return;
            let polls = [];
            for (let spec of api.ypyProp(elt).triggerSpecs) {
                let ms = spec.name === 'every' && spec.interval && ypy.parseInterval(Object.keys(spec).find(k => k !== 'name'));
                if (!(ms > 0)) continue;
                clearInterval(spec.interval);
                let e = {elt, spec, ms, last: now()};
                entries.add(e);
                polls.push(e);
                schedule(e);
            }
            if (polls.length) api.ypyProp(elt).poll = polls;
        },

        ypy_before_cleanup(elt) {
            elt._ypy?.poll?.forEach(stop);
            if (elt._ypy) elt._ypy.poll = null;
        },

        ypy_after_request(elt, {ctx}) {
            let res = ctx.response, polls = elt._ypy?.poll;
            if (res?.status === 286) {
                polls?.forEach(stop);
                // an element left to the core, or driven by the core, stops too
                for (let spec of elt._ypy?.triggerSpecs || []) if (spec.name === 'every') clearInterval(spec.interval);
                api.triggerEvent(elt, 'ypy:poll:stop', {ctx, status: 286});
                return;
            }
            let ms = polls && serverInterval(elt, res?.headers?.get?.('YPY-Poll-Interval'));
            if (ms) for (let e of polls) { e.ms = ms; schedule(e) }
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-list.js
//
// Keyed and bounded lists for the append and prepend swap styles:
//   key:<attr>   an item whose attribute has the value of one already in the list
//                replaces it where it stands instead of being added again
//                (`key` alone means the id)
//   limit:<n>    after the swap the list keeps at most n items; the oldest go
//                (the first ones for append, the last ones for prepend)
//
// Usage:
//   <ul ypy-get="/events" ypy-trigger="every 2s" ypy-swap="append key:data-id limit:50 focus">...</ul>
//
//   focus        after the swap the focus moves to the first item the response brought, which gets
//                tabindex="-1" when it cannot take focus by itself. The same with ypy-list-focus on the
//                list (or :inherited on an ancestor); ypy-list-focus="false" turns it off. The focus
//                never leaves a field the user is typing in, and the page scrolls to the item only
//                when the swap asks for it (focusScroll, or config.defaultFocusScroll), as the core does.
//
// ypy:list:pruned fires on the list with the items that were removed to keep the limit.
// The list is the element the swap goes into; every element child counts as an item.
//==========================================================
(() => {
    let api;

    // A swap spec given as a string (a task made by an extension) is read in the same way.
    function spec(task) {
        let s = task.swapSpec;
        if (typeof s !== 'string') return s || {};
        let [style, ...mods] = s.trim().split(/\s+/);
        return {style, ...api.HCON.parse(mods.join(' '))};
    }

    // Takes an item out the way the core does for what it removes.
    function drop(el) {
        for (let e of [el, ...el.querySelectorAll('[data-ypy-powered]')]) {
            if (!e._ypy) continue;
            api.triggerEvent(e, 'ypy:before:cleanup', {}, false);
            for (let s of e._ypy.triggerSpecs) {
                clearInterval(s.interval);
                clearTimeout(s.timeout);
                s.observer?.disconnect();
            }
            for (let i of e._ypy.listeners) i.fromElt.removeEventListener(i.eventName, i.handler, i);
        }
        el.remove();
    }

    const STYLES = {append: 'beforeend', prepend: 'afterbegin'};
    const EDITING = 'input:not([type=button],[type=submit],[type=checkbox],[type=radio],[type=reset]),textarea,select,[contenteditable]';
    const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable]';

    ypy.registerExtension('ypy-list', {
        init(internalAPI) { api = internalAPI },

        // The settle is over: the first new item takes the focus, unless the user is typing somewhere.
        ypy_after_settle(list, {task, newContent}) {
            let s = spec(task), style = STYLES[s.style] || s.style, on = s.focus ?? api.attributeValue(list, 'ypy-list-focus');
            if (style !== 'beforeend' && style !== 'afterbegin' || on == null || on === false || on === 'false') return;
            let item = newContent.find(el => el.nodeType === 1 && el.parentNode === list);
            if (!item || document.activeElement?.matches?.(EDITING)) return;
            if (!item.matches(FOCUSABLE)) item.tabIndex = -1;
            item.focus({preventScroll: !(s.focusScroll ?? ypy.config.defaultFocusScroll)});
        },

        // After the swap, before the settle: the list never shows a duplicate or an item over the limit.
        ypy_before_settle(list, {task, newContent}) {
            let s = spec(task), style = STYLES[s.style] || s.style;
            if (style !== 'beforeend' && style !== 'afterbegin') return;
            let key = s.key === true ? 'id' : s.key, limit = Math.floor(s.limit);
            let gone = new Set();

            if (key && typeof key === 'string') {
                let added = new Set(newContent), old = new Map(), fresh = new Map();
                for (let el of list.children) {
                    let v = added.has(el) ? null : el.getAttribute(key);
                    if (v != null && !old.has(v)) old.set(v, el);
                }
                for (let el of newContent) {
                    let v = el.nodeType === 1 && el.parentNode === list ? el.getAttribute(key) : null;
                    if (v == null) continue;
                    // the same key twice in one response: the last one counts
                    if (fresh.has(v)) { drop(fresh.get(v)); gone.add(fresh.get(v)) }
                    fresh.set(v, el);
                }
                for (let [v, el] of fresh) {
                    let was = old.get(v);
                    if (!was) continue;
                    was.replaceWith(el);
                    drop(was);
                }
            }

            if (limit >= 1) {
                let items = [...list.children], extra = items.length - limit;
                if (extra > 0) {
                    let removed = style === 'beforeend' ? items.slice(0, extra) : items.slice(-extra);
                    removed.forEach(el => { drop(el); gone.add(el) });
                    api.triggerEvent(list, 'ypy:list:pruned', {removed, limit, task});
                }
            }

            // what left the page is not processed after the swap
            for (let i = newContent.length; i--;) if (gone.has(newContent[i])) newContent.splice(i, 1);
        }
    });
})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-telemetry.js
//
// Every failure of the page in one event, for an error tracker or a log.
//
// Network failures, timeouts, a lost connection, 4xx and 5xx responses, a target that is not
// there, a refused swap and the errors of the extensions each have their own event, and some of
// them only reach the console. This extension reports all of them the same way:
//
//   ypy.onError(report => send(report))       returns a function that cancels the subscription
//   document.addEventListener('ypy:telemetry:error', evt => send(evt.detail))
//
// The report is {code, url, method, status, target, ctxId}:
//   code    a stable name of what failed:
//             network, offline, timeout      the request did not get an answer
//             status:<n>                     the response has status 400 or more, for example status:500
//             target-missing                 no element matches the target
//             swap-error                     inserting the response into the page failed
//             blocked:<reason>               a swap, redirect or script was refused (redirect,
//                                            websocket-origin, callbacks-none, ...)
//             extension:<name>               an extension reported an error: sse, ws, stream, multipart,
//                                            lazy or signals
//             error                          any other ypy:error (for example a listener that threw)
//   url     the address without query, fragment or credentials; null when there is none
//   method  the HTTP method in upper case; null when there is none
//   status  the HTTP status of the answer; null when there was none
//   target  a short selector of the target: "div#results", or the selector that matched nothing; null
//   ctxId   a number shared by every report of one request; null outside a request
//
// A report never carries the body, the value of a field, a header or a cookie, nor the message of
// the error: those can hold what the user typed. Only the fields above leave the page. A path can
// still hold an identifier, so a tracker that must not see it should cut the url on its side.
//
// The event fires on the element the failure belongs to (on the document when that element is
// gone), bubbles, and is not cancelable. A handler of ypy.onError that throws is logged and does
// not stop the others.
//
// Only the public API and the extension API are used.
//==========================================================
(() => {

    let api, count = 0;
    const subscribers = new Set;
    const ids = new WeakMap;        // request ctx -> ctxId
    const swapErrors = new WeakMap; // request ctx -> errors already reported as swap-error

    const cut = (text, max = 80) => String(text).slice(0, max);

    // "div#results": the tag and the id, never the content of the element
    const short = target => target?.localName ? cut(target.localName + (target.id ? '#' + target.id : '')) : target ? cut(target) : null;

    const clean = href => {
        try {
            let url = new URL(href, document.baseURI);
            url.search = url.hash = url.username = url.password = '';
            return url.href;
        } catch { return null }
    };

    function report(code, elt, {ctx, url, target} = {}) {
        let request = ctx?.request;
        if (ctx && !ids.has(ctx)) ids.set(ctx, ++count);
        let detail = {
            code,
            url: (url ?? request?.action) == null ? null : clean(url ?? request.action),
            method: request?.method ? String(request.method).toUpperCase() : null,
            status: ctx?.response?.status ?? null,
            target: short(target ?? ctx?.target ?? ctx?.targetSelector),
            ctxId: ctx ? ids.get(ctx) : null
        };
        for (let fn of [...subscribers]) {
            try { fn({...detail}) } catch (error) { console.error('ypy-telemetry: an onError handler threw', error) }
        }
        api.triggerEvent(elt?.isConnected ? elt : document, 'ypy:telemetry:error', detail);
    }

    const hooks = {
        init: a => {
            api = a;
            ypy.onError = fn => {
                if (typeof fn !== 'function') throw new TypeError('ypy.onError: a function is required');
                let handler = detail => fn(detail);   // two subscriptions of one function cancel apart
                subscribers.add(handler);
                return () => subscribers.delete(handler);
            };
        },

        ypy_error: (elt, {ctx, error}) => {
            if (swapErrors.get(ctx)?.has(error)) return;   // already reported by ypy:swap:error
            let kind = ctx?.errorKind;
            report(/^(network|offline|timeout)$/.test(kind) ? kind : 'error', elt, {ctx});
        },

        ypy_response_error: (elt, {ctx}) => report('status:' + ctx.response.status, elt, {ctx}),

        ypy_target_missing: (elt, {ctx, selector}) => report('target-missing', elt, {ctx, target: selector}),

        ypy_swap_error: (elt, {ctx, task, error}) => {
            if (ctx) swapErrors.set(ctx, (swapErrors.get(ctx) || new Set).add(error));
            report('swap-error', elt, {ctx, target: task?.target});
        },

        ypy_security_blocked: (elt, {reason, url}) => report('blocked:' + cut(reason, 40), elt, {url})
    };

    // the errors the extensions report on their own
    for (let name of ['sse', 'ws', 'stream', 'multipart', 'lazy', 'signals']) {
        hooks[`ypy_${name}_error`] = (elt, {ctx, url}) => report('extension:' + name, elt, {ctx, url});
    }

    ypy.registerExtension('ypy-telemetry', hooks);

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-switch.js
//
// Shows or hides a part of a form according to the value of a field, with no request.
//
// ypy-switch on the part says when it is shown:
//
//   ypy-switch="kind=company"          the field `kind` has the value company
//   ypy-switch="kind=company|ngo"      ... one of these values
//   ypy-switch="kind!=person"          ... is not one of these values
//   ypy-switch="newsletter"            the field has a value (a checkbox or radio: it is checked)
//
// The field is found by name, inside the form that holds the part (in the whole page when the
// part is in no form). A radio group or a set of checkboxes with the same name counts as one
// field; a select with several options chosen has several values and any of them can match. A
// checkbox with no value attribute has the value "on".
//
// A part that is not shown gets the hidden attribute, and the fields inside it are disabled: they
// are not submitted and a required one does not stop the submit. When the part is shown again the
// fields that the extension disabled come back (one that the page had disabled stays disabled). If
// your CSS gives the part a display value, add `[hidden] { display: none }` for it.
//
// It follows the input and change events of the form, a reset, and content that arrives in a swap.
// A script that sets a value without an event calls ypy.switch.update(). A part fires
// ypy:switch ({shown}) when it changes; its first evaluation is silent. Nested parts are
// evaluated in document order, so an outer part that is hidden keeps the inner ones disabled.
//
// Only the public API and the extension API are used, so it works with the built core too.
//
// Usage:
//   <script src="ypy-switch.js"></script>
//   <form>
//     <select name="kind"><option value="person">Person<option value="company">Company</select>
//     <div ypy-switch="kind=company"><input name="cnpj" required></div>
//   </form>
//==========================================================
(() => {

    let api;
    const state = new WeakMap();   // part -> shown last time
    const off = new WeakSet();     // fields this extension disabled
    const CONTROLS = 'input,select,textarea,button,fieldset';
    const parts = () => api.prefixSelector('[ypy-switch]');

    // The values of the fields named `name` in the scope, as a list of strings.
    function values(scope, name) {
        let out = [];
        for (let f of scope.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
            if (f.type === 'checkbox' || f.type === 'radio') {
                if (f.checked) out.push(f.value);
            } else if (f.tagName === 'SELECT') {
                out.push(...[...f.selectedOptions].map(o => o.value));
            } else {
                out.push(f.value);
            }
        }
        return out;
    }

    // Does the rule `name`, `name=a|b` or `name!=a|b` hold for the part?
    function holds(part, rule) {
        let [, name, not, list] = /^\s*([^=!\s]+)\s*(!?)(?:=\s*(.*?))?\s*$/.exec(rule) || [];
        if (!name) return true;
        let have = values(part.closest('form') || document, name);
        if (list == null) return have.some(v => v !== '');
        let wanted = list.split('|').map(v => v.trim());
        return have.some(v => wanted.includes(v)) !== !!not;
    }

    function show(part, shown) {
        let first = !state.has(part), was = state.get(part);
        state.set(part, shown);
        part.hidden = !shown;
        // inside a part that is hidden, the fields stay disabled whatever this part says
        let up = part.parentElement?.closest(parts());
        while (up && !up.hidden) up = up.parentElement?.closest(parts());
        for (let f of part.matches(CONTROLS) ? [part] : part.querySelectorAll(CONTROLS)) {
            if ((!shown || up) && !f.disabled) { f.disabled = true; off.add(f) }
            else if (shown && !up && off.delete(f)) f.disabled = false;
        }
        if (!first && was !== shown) api.triggerEvent(part, 'ypy:switch', {shown});
    }

    // Evaluates the parts of a subtree, outer ones first.
    function update(root = document) {
        for (let part of [...root.matches?.(parts()) ? [root] : [], ...root.querySelectorAll?.(parts()) ?? []]) {
            show(part, holds(part, api.attr(part, 'ypy-switch') || ''));
        }
    }

    // The parts that depend on the form of a field
    const refresh = field => update(field.form || document);

    document.addEventListener('input', evt => refresh(evt.target));
    document.addEventListener('change', evt => refresh(evt.target));
    document.addEventListener('reset', evt => setTimeout(update, 0, evt.target));

    ypy.registerExtension('ypy-switch', {

        init: (internalApi) => {
            api = internalApi;
            ypy.switch = {
                /** Evaluates the parts again: call it after a script set a value without an event. */
                update
            };
        },

        // new content: its own parts, and the parts of the form it joined
        ypy_after_process: (elt) => { update(elt.closest?.('form') || elt) }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-commands.js
//
// Client commands from the server, in a response header, with no eval.
//
//   YPY-Commands: [{"type":"addClass","target":"#row-4","class":"saved"},
//                  {"type":"focus","target":"#name"}]
//
// The value is a JSON list. Each command is an object with a "type" and a "target", a CSS
// selector: the command acts on every element the selector matches, in document order. The
// commands run in the order of the list, after the response was swapped (in the
// ypy:finally:request of the request), so a target can be an element the response brought. A
// response that is not swapped (204, an error) runs them too. Non-ASCII text has to be written as
// \uXXXX in a header.
//
//   addClass, removeClass       {"class": "a b"}
//   toggleClass                 {"class": "a b", "force": true}   (force is optional)
//   setAttribute                {"name": "title", "value": "Saved"}
//   removeAttribute             {"name": "title"}
//   focus                       {}
//   scrollIntoView              {"behavior": "smooth", "block": "center", "inline": "nearest"}
//   remove                      {}
//   dispatch                    {"event": "saved", "detail": {...}, "bubbles": true}
//                               (the target is optional here: without it the event goes to document)
//   show, hide                  {}   (they remove and set the hidden attribute: a rule of the
//                                    page that forces a display wins over it)
//
// A command that is not in the list, or whose fields are not what the table says, or whose
// selector is not valid, is not run: a console warning and ypy:commands:ignored on the source
// element say why, and the next command runs. A command that targets nothing is skipped without
// a warning (the element may be gone). setAttribute cannot write an event handler (on*), style,
// srcdoc or an attribute of YPY itself, nor a javascript: URL: that would be code, and the
// header must not be a way around the page's CSP. A list that is not valid JSON, or is longer
// than config.commands.max (100), is ignored as a whole.
//
// Cancel ypy:before:command (it fires on the source element with {ctx, command, targets}) to skip
// one command. ypy.commands.run(list, source) runs a list the same way, for code that gets its
// commands elsewhere.
//==========================================================
(() => {

    let api;

    const str = v => typeof v == 'string' && v !== '';
    const tokens = v => str(v) ? v.trim().split(/\s+/) : null;
    // JavaScript hidden in an attribute value: whitespace and control characters are ignored by URL parsers
    const script = v => /^[\x00-\x20]*(javascript|vbscript|data:text\/html)/i.test(String(v).replace(/[\t\n\r]/g, ''));
    const isYpyName = n => /^(data-)?ypy-/i.test(n) || (ypy.config.prefix && n.toLowerCase().startsWith(ypy.config.prefix.toLowerCase()));

    // takes an element out the way the core does for what it removes: its timers and listeners go with it
    function drop(el) {
        for (let e of [el, ...el.querySelectorAll('[data-ypy-powered]')]) {
            if (!e._ypy) continue;
            api.triggerEvent(e, 'ypy:before:cleanup', {}, false);
            for (let s of e._ypy.triggerSpecs ?? []) {
                clearInterval(s.interval);
                clearTimeout(s.timeout);
                s.observer?.disconnect();
            }
            for (let i of e._ypy.listeners ?? []) i.fromElt.removeEventListener(i.eventName, i.handler, i);
        }
        el.remove();
    }

    // the checks of the fields each command needs; they return the reason or nothing
    const commands = {
        addClass: {check: c => tokens(c.class) ? 0 : 'class', run: (e, c) => e.classList.add(...tokens(c.class))},
        removeClass: {check: c => tokens(c.class) ? 0 : 'class', run: (e, c) => e.classList.remove(...tokens(c.class))},
        toggleClass: {
            check: c => tokens(c.class) ? c.force != null && typeof c.force != 'boolean' ? 'force' : 0 : 'class',
            run: (e, c) => tokens(c.class).forEach(t => c.force == null ? e.classList.toggle(t) : e.classList.toggle(t, c.force))
        },
        setAttribute: {
            check: c => !str(c.name) || /[\s"'<>\/=\x00]/.test(c.name) ? 'name' :
                c.value != null && typeof c.value == 'object' ? 'value' :
                /^(on|style$|srcdoc$)/i.test(c.name) || isYpyName(c.name) || script(c.value ?? '') ? 'blocked' : 0,
            run: (e, c) => e.setAttribute(c.name, String(c.value ?? ''))
        },
        removeAttribute: {check: c => str(c.name) ? 0 : 'name', run: (e, c) => e.removeAttribute(c.name)},
        focus: {check: () => 0, run: e => e.focus()},
        scrollIntoView: {
            check: c => ['behavior', 'block', 'inline'].some(k => c[k] != null && typeof c[k] != 'string') ? 'options' : 0,
            run: (e, c) => e.scrollIntoView({behavior: c.behavior ?? 'auto', block: c.block ?? 'start', inline: c.inline ?? 'nearest'})
        },
        remove: {check: () => 0, run: drop},
        dispatch: {
            check: c => str(c.event) ? 0 : 'event',
            run: (e, c) => e.dispatchEvent(new CustomEvent(c.event, {detail: c.detail, bubbles: c.bubbles !== false, cancelable: true}))
        },
        show: {check: () => 0, run: e => e.removeAttribute('hidden')},
        hide: {check: () => 0, run: e => e.setAttribute('hidden', '')}
    };

    function ignore(source, command, reason) {
        console.warn(`ypy-commands: ignored ${JSON.stringify(command)?.slice(0, 120)}: ${reason}`);
        api.triggerEvent(source, 'ypy:commands:ignored', {command, reason});
    }

    function run(list, source, ctx) {
        source = source?.isConnected ? source : document.body;
        let max = ypy.config.commands?.max ?? 100;
        if (typeof list == 'string') {
            try { list = JSON.parse(list) } catch { return ignore(source, list, 'not valid JSON') }
        }
        if (!Array.isArray(list)) return ignore(source, list, 'not a list');
        if (list.length > max) return ignore(source, `${list.length} commands`, `more than ${max}`);
        for (let command of list) {
            let known = command && typeof command == 'object' && Object.hasOwn(commands, command.type), spec = commands[command?.type];
            let reason = known ? spec.check(command) : 0;
            if (!known || reason) { ignore(source, command, !known ? 'unknown command' : reason == 'blocked' ? 'not allowed' : 'invalid ' + reason); continue }
            let targets;
            if (command.target == null && command.type == 'dispatch') {
                targets = [document];
            } else if (!str(command.target)) {
                ignore(source, command, 'invalid target'); continue;
            } else {
                try { targets = [...document.querySelectorAll(command.target)] } catch { ignore(source, command, 'invalid target'); continue }
            }
            if (targets.length && api.triggerEvent(source, 'ypy:before:command', {ctx, command, targets}))
                for (let elt of targets) spec.run(elt, command);
        }
    }

    ypy.registerExtension('ypy-commands', {
        init: a => {
            api = a;
            (ypy.commands ??= {}).run = (list, source) => run(list, source);
        },

        ypy_finally_request: (elt, {ctx}) => {
            let header = ctx.ypy?.commands;
            if (header && !ctx.commandsRun) { ctx.commandsRun = true; run(header, elt, ctx) }
        }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-sort.js
//
// Drag and drop reordering of a list, with a keyboard, and the new order sent to the server.
//
//   <ul ypy-sort ypy-sort-url="/tasks/order">
//     <li id="task-1">Write</li>
//     <li id="task-2">Review</li>
//     <li id="task-3">Ship</li>
//   </ul>
//
// The items are the children of the container that have an id. They get draggable="true" and, when
// they have none, tabindex="0" (also the items a later swap brings). While one is dragged it has
// data-ypy-state="dragging"; the list moves as the pointer passes over the other items. The native
// drag of the browser is used, so it needs no style and no script of the page.
//
// Keyboard, on a focused item: Space picks it up (data-ypy-state="grabbed"), ArrowUp and ArrowLeft
// move it one place before, ArrowDown and ArrowRight one place after, Space puts it down, Escape puts
// everything back. Without a picked up item the arrows move the focus between the items.
//
// When an item is dropped in a new place, ypy:sort:change fires on the container with {ids, item}
// (cancel it to put the list back), and ypy-sort-url gets a POST: the field `id` once per item, in
// the new order, plus whatever the container's ypy-vals and enclosing form carry. The request is
// the usual one (indicators, ypy-confirm, ypy-headers, events); the response is not swapped
// (out-of-band elements and partials in it are), and an answer of 400 or more, or a connection
// that fails, puts the list back in the old order and fires ypy:sort:revert with {ids, reason}.
// A container with no ypy-sort-url only reorders and fires ypy:sort:change. ypy-sort="false" leaves
// the element to the page.
//
// config.sort.messages = {grab, move, drop, cancel, revert} are said in a live region when the
// page sets them ("{position}" and "{total}" are replaced): the core has no text of its own.
//==========================================================
(() => {

    let api, live;
    const sel = s => api.prefixSelector(s);
    const items = c => [...c.children].filter(x => x.id);
    const ids = c => items(c).map(x => x.id);
    const itemOf = (c, e) => { let i = e.target.closest?.('[id]'); while (i && i.parentNode !== c) i = i.parentNode?.closest?.('[id]'); return i };

    // data-ypy-state holds space separated tokens; this sets or clears the one of the sort
    function setState(elt, state) {
        let tokens = (elt.dataset.ypyState || '').split(' ').filter(s => s && s != 'dragging' && s != 'grabbed');
        if (state) tokens.push(state);
        tokens[0] ? elt.dataset.ypyState = tokens.join(' ') : delete elt.dataset.ypyState;
    }

    function say(c, key, item) {
        let text = ypy.config.sort?.messages?.[key];
        if (!text) return;
        if (!live?.isConnected) {
            live = document.createElement('div');
            live.setAttribute('role', 'status');
            live.setAttribute('aria-live', 'polite');
            // visually hidden with an adopted style sheet: no style attribute, so a strict CSP allows it
            try {
                let sheet = new CSSStyleSheet();
                sheet.replaceSync('[data-ypy-sort-live]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
                document.adoptedStyleSheets.push(sheet);
            } catch {}
            live.dataset.ypySortLive = '';
            document.body.append(live);
        }
        let list = items(c);
        live.textContent = text.replace('{position}', list.indexOf(item) + 1).replace('{total}', list.length);
    }

    function revert(c, snapshot, reason) {
        let focused = c.contains(document.activeElement) ? document.activeElement : null;
        c.replaceChildren(...snapshot);
        focused?.focus();
        api.triggerEvent(c, 'ypy:sort:revert', {ids: ids(c), reason});
        say(c, 'revert', focused);
    }

    // the item was put down: tell the page, then the server
    function commit(c, item, snapshot) {
        let before = snapshot.filter(x => x.id).map(x => x.id), now = ids(c);
        if (before.join('\n') == now.join('\n')) return;
        if (!api.triggerEvent(c, 'ypy:sort:change', {ids: now, item})) return revert(c, snapshot, 'cancelled');
        let url = api.attr(c, 'ypy-sort-url');
        if (!url) return;
        let done, back = () => { if (!done && c.isConnected) { done = 1; revert(c, snapshot, 'failed') } };
        ypy.ajax('POST', url, {source: c, target: c, swap: 'none', sortIds: now, sortRevert: back}).catch(back);
    }

    function watch(c) {
        if (c._ypy?.sort || c.closest(sel('[ypy-ignore]')) || api.attr(c, 'ypy-sort') == 'false' ||
            !api.triggerEvent(c, 'ypy:before:init', {})) return;
        let state = api.ypyProp(c), drag, grab;
        state.sort = 1;
        let tag = () => items(c).forEach(x => {
            x.hasAttribute('draggable') || x.setAttribute('draggable', 'true');
            x.hasAttribute('tabindex') || x.setAttribute('tabindex', '0');
        });
        tag();
        (state.sortObserver = new MutationObserver(tag)).observe(c, {childList: true});
        let on = (name, handler) => {
            c.addEventListener(name, handler);
            state.listeners.push({fromElt: c, eventName: name, handler});
        };

        on('dragstart', e => {
            let item = itemOf(c, e);
            if (!item || item !== e.target) return;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.id);   // Firefox does not start a drag without data
            drag = {item, snapshot: [...c.childNodes]};
            setState(item, 'dragging');
        });
        on('dragover', e => {
            if (!drag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            let over = itemOf(c, e), item = drag.item;
            if (!over || over === item) return;
            let a = item.getBoundingClientRect(), b = over.getBoundingClientRect();
            // a row of items is crossed by x, a column by y
            let after = Math.abs(a.top - b.top) < b.height / 2 ? e.clientX > b.left + b.width / 2 : e.clientY > b.top + b.height / 2;
            if (after ? over.nextElementSibling !== item : over.previousElementSibling !== item) after ? over.after(item) : over.before(item);
        });
        on('drop', e => {
            if (!drag) return;
            e.preventDefault();
            drag.dropped = true;
        });
        on('dragend', () => {
            if (!drag) return;
            let {item, snapshot, dropped} = drag;
            drag = null;
            setState(item, null);
            dropped ? commit(c, item, snapshot) : revert(c, snapshot, 'cancelled');
        });

        on('keydown', e => {
            let item = itemOf(c, e);
            if (!item || item !== e.target || e.altKey || e.ctrlKey || e.metaKey) return;
            let list = items(c), i = list.indexOf(item), step = {ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1}[e.key];
            if (e.key == ' ') {
                e.preventDefault();
                if (!grab) {
                    grab = {item, snapshot: [...c.childNodes]};
                    setState(item, 'grabbed');
                    say(c, 'grab', item);
                } else {
                    let {snapshot} = grab;
                    grab = null;
                    setState(item, null);
                    say(c, 'drop', item);
                    commit(c, item, snapshot);
                }
            } else if (e.key == 'Escape' && grab) {
                e.preventDefault();
                let {snapshot} = grab;
                grab = null;
                setState(item, null);
                revert(c, snapshot, 'cancelled');
                item.focus();
                say(c, 'cancel', item);
            } else if (step) {
                e.preventDefault();
                let next = list[i + step];
                if (!next) return;
                if (grab?.item == item) {
                    step < 0 ? next.before(item) : next.after(item);
                    item.focus();
                    say(c, 'move', item);
                } else {
                    next.focus();
                }
            }
        });
    }

    ypy.registerExtension('ypy-sort', {
        init: a => { api = a },

        ypy_after_process: root => {
            for (let c of [...root.querySelectorAll?.(sel('[ypy-sort]')) ?? [], ...root.matches?.(sel('[ypy-sort]')) ? [root] : []]) watch(c);
        },

        ypy_before_cleanup: c => { c._ypy?.sortObserver?.disconnect() },

        // the new order goes in the body: the field `id` once per item
        ypy_config_request: (elt, {ctx}) => ctx.sortIds?.forEach(id => ctx.request.body.append('id', id)),

        // the server said no, or never answered: the list goes back
        ypy_response_error: (elt, {ctx}) => ctx.sortRevert?.(),
        ypy_error: (elt, {ctx}) => { if (ctx?.errorKind || ctx && !ctx.response) ctx.sortRevert?.() }
    });

})();
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-scope.js
//
// Targets the core does not know, for every attribute that takes a selector (ypy-target,
// ypy-indicator, ypy-include, ypy-disable, ypy-sync, `from:` of a trigger, ypy.find()):
//
//   scope             the closest ancestor with the ypy-scope attribute (the element itself counts);
//                     the search goes on from the host when the element sits in a shadow root
//   scope <selector>  the elements that match the selector inside that scope
//   layer             the element of the topmost open layer of the ypy-layers extension
//                     (nothing when no layer is open or ypy-layers is not loaded)
//   layer <selector>  the elements that match the selector inside that layer
//   shadow:<selector> the elements that match the selector below the element, in the flat tree:
//                     the light DOM, the nested open shadow roots (closed ones cannot be entered),
//                     and inside a shadow root the content a <slot> shows (assignedElements,
//                     flattened, with the slot's own content when nothing is assigned), so a light
//                     child that no slot shows is not found. The element itself is not matched.
//
// Usage:
//   <section ypy-scope>
//     <button ypy-get="/save" ypy-target="scope">Save</button>
//     <button ypy-get="/hint" ypy-target="scope .hint">Hint</button>
//   </section>
//   <button ypy-get="/state" ypy-target="shadow:.badge">Refresh the badges</button>
//
// The extension answers the ypy_resolve_target hook of the core, which asks before the selector
// falls to querySelectorAll. Anything else is left to the core (the hook returns undefined).
//==========================================================
(() => {
    let api;

    // the elements below `node` as a browser renders them: a host shows its shadow root, a slot what is assigned to it
    function* flat(node) {
        let kids = node.localName == 'slot' ? node.assignedElements({flatten: true}) : node.shadowRoot?.children ?? node.children;
        for (let kid of kids ?? []) {
            yield kid;
            yield* flat(kid);
        }
    }

    // the closest scope of an element; from a shadow root it goes on from the host
    function scopeOf(elt) {
        let selector = api.prefixSelector('[ypy-scope]');
        for (let at = elt; at; at = at.getRootNode?.().host) {
            let scope = at.closest?.(selector);
            if (scope) return scope;
        }
        return null;
    }

    ypy.registerExtension('ypy-scope', {
        init(internalAPI) {
            api = internalAPI;
        },
        ypy_resolve_target(elt, selector) {
            let [, kind, rest] = selector.match(/^(scope|layer)(?:\s+([\s\S]+))?$/) ?? selector.match(/^(shadow):\s*([\s\S]+)$/) ?? [];
            if (!kind) return;
            if (kind == 'shadow') return [...flat(elt)].filter(found => found.matches(rest));
            let root = kind == 'scope' ? scopeOf(elt) : ypy.layers?.top()?.element;
            return !root || !rest ? root ?? null : [...root.querySelectorAll(rest)];
        }
    });
})();
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
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-preserve.js
//
// What the visitor was doing survives a swap: the modes of ypy-preserve that name a state, and the
// wait for an input method editor (IME).
//
// ypy-preserve="value selection focus scroll". A list of words separated by spaces, on the live
// element. Each word keeps one state of the element and of its descendants that have an `id`,
// through a morph and through a raw swap (innerHTML, outerHTML) alike:
//   value      the text, choice or checked state the visitor gave a field, when it differs from the
//              default the HTML had; a field the visitor did not touch follows the response
//   selection  the caret or the selected text of a field
//   focus      the focus, when the element had it before the swap
//   scroll     the scroll position of the element
// The modes do not combine with `true`, `all`, `attrs` or `children`, which the core reads. A
// response that wants the server to win marks the element with `ypy-morph-force`, the same
// attribute that makes it win over the state of a morph.
//
// IME. While the visitor composes text (compositionstart without compositionend, as with
// Japanese, Chinese or Korean input) in a field that a swap target contains, the swap waits for
// compositionend, so the candidate text is not cut in half. The wait ends after
// config.compositionTimeout milliseconds (3000 by default) at the latest. A page without this
// extension swaps at once.
//
// Only the extension API is used. The core waits for ctx.hold, a promise this extension sets.
//==========================================================
(() => {

    let api, composing, waiting = [];

    const MODES = ['value', 'selection', 'focus', 'scroll'];
    const saved = new WeakMap();   // ctx -> the state taken before its swap

    const sel = s => api.prefixSelector(s);
    const elementOf = t => typeof t === 'string' ? document.querySelector(t) : t;

    // the state of the elements that carry a mode, with their descendants that have an id
    function capture(targets) {
        let list = [];
        for (let elt of document.querySelectorAll(sel('[ypy-preserve]'))) {
            let modes = (api.attr(elt, 'ypy-preserve') || '').split(/\s+/);
            if (!modes.some(m => MODES.includes(m)) || !targets.some(t => t.contains(elt) || elt.contains(t))) continue;
            for (let node of [elt, ...elt.querySelectorAll('[id]')]) {
                let r = {node, id: node.id}, has = m => modes.includes(m);
                if (has('value') && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) && node.type !== 'file') {
                    r.check = /^(checkbox|radio)$/.test(node.type);
                    r.value = r.check ? node.checked : node.value;
                    // only what the visitor changed: select has no default, so it always counts
                    r.dirty = r.check ? node.checked !== node.defaultChecked : node.value !== node.defaultValue;
                }
                if (has('selection') && node.selectionStart != null) r.range = [node.selectionStart, node.selectionEnd, node.selectionDirection];
                if (has('scroll') && (node.scrollTop || node.scrollLeft)) r.scroll = [node.scrollLeft, node.scrollTop];
                if (has('focus') && node === document.activeElement) r.focus = true;
                list.push(r);
            }
        }
        return list;
    }

    // puts the state back on the node that is in the page now, once; `within` limits it to one swap target
    function restore(list, within) {
        for (let r of list || []) {
            let n = r.node.isConnected ? r.node : document.getElementById(r.id);
            if (r.done || !n || within && !(within.contains(n) || n.contains(within))) continue;
            r.done = true;
            // the response asked to win
            if (n.matches(sel('[ypy-morph-force]'))) continue;
            if (r.dirty) r.check ? n.checked = r.value : n.value = r.value;
            if (r.focus && document.activeElement !== n) n.focus({preventScroll: true});
            try { if (r.range) n.setSelectionRange(...r.range); } catch (e) { /* the field has no selection */ }
            if (r.scroll) [n.scrollLeft, n.scrollTop] = r.scroll;
        }
    }

    ypy.registerExtension('ypy-preserve', {
        init: a => {
            api = a;
            document.addEventListener('compositionstart', e => { composing = e.target; }, true);
            document.addEventListener('compositionend', () => {
                composing = null;
                // the browser may still fire the last input event of the composition
                setTimeout(() => waiting.splice(0).forEach(done => done()));
            }, true);
        },

        ypy_before_swap: (elt, {ctx, tasks}) => {
            let targets = tasks.map(t => elementOf(t.target)).filter(t => t instanceof Element);
            let take = () => saved.set(ctx, capture(targets));
            if (composing?.isConnected && targets.some(t => t.contains(composing))) {
                ctx.hold = new Promise(done => {
                    waiting.push(done);
                    setTimeout(done, ypy.config.compositionTimeout ?? 3000);
                }).then(take);
            } else {
                take();
            }
        },

        // right after the DOM work of a task, before the settle delay, so nothing flashes
        ypy_before_settle: (elt, {task}) => restore(saved.get(task.ctx), elementOf(task.target)),

        // what no task restored (an element that came back with the last one)
        ypy_after_swap: (elt, {ctx}) => {
            restore(saved.get(ctx));
            saved.delete(ctx);
        }
    });

})();
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
// SPDX-License-Identifier: MIT
//==========================================================
// ypy-model.js
//
// The client side of a language-model answer that streams into fragments (ADR-0018, protocol 5.8). The
// words of a model are untrusted: what they could do is stopped here as a second wall behind the server's
// renderer. This extension has four jobs.
//
//   ypy-untrusted   marks a container whose content is written by a model. Everything that enters it (and
//                   every container with the attribute that arrives in a response) loses scripts, styles,
//                   forms, frames, svg, ypy-*, data-ypy-*, on* and framework attributes, javascript: and
//                   data: addresses and, unless the value is "images", media that loads from the network.
//   announce        a container with aria-busy="true" is an answer being written. The live region says one
//                   short message when it starts (ypy-announce-start, or config.announce.messages.answerStart)
//                   and one when aria-busy goes away: ypy-announce / answerReady, or ypy-announce-stop /
//                   answerStopped when data-ypy-answer is "stopped", ypy-announce-error / answerFailed when it is
//                   "failed" (assertive). Nothing is said in between, unless config.announce.stream is
//                   "blocks": then the text of each closed block, shortened, at most once every 3 seconds.
//   ypy-follow      on the container: the page scrolls down with the answer, only when the reader was already
//                   at the bottom and prefers-reduced-motion is not set.
//   ypy-stop        on a button: ypy-stop="#selector" sends ypy:abort to those elements, which closes their
//                   stream. The answer that was open is closed in the page as stopped (the server records the
//                   stop with its own request, for example ypy-post on the same button).
//
// Usage:
//   <article id="a1" ypy-untrusted ypy-follow aria-busy="true"><div id="a1-done"></div><div id="a1-tail"></div></article>
//   <button ypy-post="/generations/1/stop" ypy-swap="none" ypy-stop="#gen">Stop</button>
//
// Uses only the public API and the extension API.
//==========================================================
(() => {
    let api, sel;
    // answers being written: container id -> element that holds the stream
    const open = new Map(), said = new Map();
    const BAD = 'script,style,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,link,meta,base,template,noscript,svg,math,portal';
    const MEDIA = 'img,picture,source,video,audio,track';
    const URL_ATTR = /^(?:href|src|action|formaction|poster|data|xlink:href|srcset)$/;
    const BLOCK_EVERY = 3000, BLOCK_LENGTH = 140;

    //============================================================================================
    // The wall: what is left of a model's HTML
    //============================================================================================
    function clean(root, images) {
        let pfx = ypy.config.prefix ? ypy.config.prefix.toLowerCase() : null, bad = images ? BAD : BAD + ',' + MEDIA;
        for (let e of root.querySelectorAll('*')) {
            if (e.matches(bad)) { e.remove(); continue }
            for (let a of [...e.attributes]) {
                let n = a.name.toLowerCase(), v = a.value.replace(/[\0-\x20\x7f-\x9f]/g, '').toLowerCase();
                if (/^(?:on|ypy-|data-ypy-|x-|[@:])/.test(n) || pfx && n.startsWith(pfx) || /^(?:style|srcdoc|target|form)$/.test(n)
                    || URL_ATTR.test(n) && /^(?:javascript|data|vbscript):/.test(v)) e.removeAttribute(a.name);
            }
            if (e.localName == 'a' && e.hasAttribute('href')) e.setAttribute('rel', 'noopener noreferrer nofollow');
        }
    }

    const wants = box => api.attr(box, 'ypy-untrusted') == 'images';

    // Before the swap: the content of every task that goes into an untrusted container, or that is one
    function guard(ctx, tasks) {
        let m = ctx.model = {ids: [], boxes: new Set(), text: ''};
        for (let t of tasks) {
            let f = t.fragment, tg = t.target instanceof Element ? t.target : null, box = tg?.closest(sel);
            let style = t.swapSpec?.style ?? t.swapSpec ?? '';
            if (box && !(box == tg && /^outer/.test(style))) {
                // everything of the content is the model's (an outer patch of the container itself brings the
                // container, which the server wrote)
                clean(f, wants(box));
                m.boxes.add(box);
                if (style == 'beforeend') m.text += (f.textContent || '').trim() + ' ';
            } else {
                for (let r of f.querySelectorAll(sel)) { clean(r, wants(r)); r.id && m.ids.push(r.id) }
                if (box) m.boxes.add(box);
            }
        }
    }

    //============================================================================================
    // The live region
    //============================================================================================
    function say(box, ctx, message, politeness) {
        let cfg = ypy.config.announce;
        if (!message || !(cfg ?? true)) return;
        let detail = {ctx, message, politeness};
        if (!api.triggerEvent(box, 'ypy:announce', detail) || !detail.message) return;
        let level = detail.politeness, live = document.querySelector('[data-ypy-live=' + level + ']');
        if (!live) {
            // the core makes the polite region at start-up and the other on first use; the style that hides it is the core's
            live = document.createElement('div');
            live.setAttribute('data-ypy-live', level);
            live.setAttribute('role', level == 'polite' ? 'status' : 'alert');
            live.setAttribute('aria-live', level);
            document.body.append(live);
        }
        let s = live._ypy_state ||= {};
        clearTimeout(s.t);
        live.textContent = '';
        s.t = setTimeout(() => {
            live.textContent = detail.message;
            s.t = setTimeout(() => live.textContent = '', ypy.config.announce?.clearAfter ?? 5000);
        }, 50);
    }

    const text = (box, attr, key) => api.attr(box, attr) || ypy.config.announce?.messages?.[key];

    // the end of an answer: aria-busy is gone, data-ypy-answer says how it ended
    function ended(box, ctx) {
        let state = box.getAttribute('data-ypy-answer');
        if (state == 'stopped') say(box, ctx, text(box, 'ypy-announce-stop', 'answerStopped'), 'assertive');
        else if (state == 'failed') say(box, ctx, text(box, 'ypy-announce-error', 'answerFailed'), 'assertive');
        else say(box, ctx, text(box, 'ypy-announce', 'answerReady'), 'polite');
    }

    function track(box, ctx, blocks) {
        let id = box.id;
        if (!id) return;
        let busy = box.getAttribute('aria-busy') == 'true';
        if (open.has(id) && !open.get(id).isConnected) open.delete(id);   // its stream went away with the page
        if (busy && !open.has(id)) {
            open.set(id, ctx.sourceElement);
            say(box, ctx, text(box, 'ypy-announce-start', 'answerStart'), 'polite');
        } else if (!busy && open.has(id)) {
            open.delete(id);
            said.delete(id);
            ended(box, ctx);
        } else if (busy && blocks && Date.now() - (said.get(id) ?? 0) >= BLOCK_EVERY) {
            let t = ctx.model.text.trim();
            if (t) {
                said.set(id, Date.now());
                say(box, ctx, t.length > BLOCK_LENGTH ? t.slice(0, BLOCK_LENGTH - 1) + '…' : t, 'polite');
            }
        }
    }

    //============================================================================================
    // Following the answer
    //============================================================================================
    const atBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 24;
    const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

    ypy.registerExtension('ypy-model', {
        init(internalAPI) {
            api = internalAPI;
            sel = api.prefixSelector('[ypy-untrusted]');
        },

        ypy_before_swap(elt, {ctx, tasks}) {
            guard(ctx, tasks);
            let m = ctx.model;
            m.follow = atBottom() && !still() && [...m.boxes].some(b => api.attr(b, 'ypy-follow') != null && b.getAttribute('aria-busy') == 'true');
        },

        ypy_after_swap(elt, {ctx}) {
            let m = ctx.model;
            if (!m) return;
            let boxes = new Set(m.boxes);
            for (let id of m.ids) { let b = document.getElementById(id); b && boxes.add(b) }
            let blocks = ypy.config.announce?.stream == 'blocks';
            for (let b of boxes) {
                if (!b.isConnected) continue;
                b = b.closest(sel) || b;
                track(b, ctx, blocks);
            }
            if (m.follow) scrollTo(scrollX, document.documentElement.scrollHeight);
        },

        // A stream that ends while an answer is open (the user pressed Stop, or the request failed) leaves a
        // page that says so: stopped after an abort, failed after an error
        ypy_stream_close(elt, {reason}) {
            let how = /^(?:abort|api)$/.test(reason) ? 'stopped' : /^(?:error|status )/.test(reason) ? 'failed' : null;
            if (!how) return;
            for (let [id, from] of [...open]) {
                if (from != elt) continue;
                open.delete(id);
                said.delete(id);
                let box = document.getElementById(id);
                if (!box) continue;
                box.removeAttribute('aria-busy');
                if (!box.hasAttribute('data-ypy-answer')) box.setAttribute('data-ypy-answer', how);
                ended(box, {sourceElement: elt});
            }
        },

        ypy_after_process(root) {
            if (!root.querySelectorAll) return;
            let stop = api.prefixSelector('[ypy-stop]');
            for (let b of [root, ...root.querySelectorAll(stop)]) {
                if (!b.matches?.(stop) || api.ypyProp(b).stopBound) continue;
                api.ypyProp(b).stopBound = true;
                b.addEventListener('click', () => {
                    for (let t of api.findAll(b, api.attr(b, 'ypy-stop'))) api.triggerEvent(t, 'ypy:abort');
                });
            }
        }
    });
})();
