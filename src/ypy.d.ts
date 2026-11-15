// SPDX-License-Identifier: MIT
export namespace YpyLive {
  /** Configures the ypy-live extension. */
  export interface Config {
    /**
     * Debounces `input` events by a number of milliseconds or an interval string.
     * @default 100
     */
    inputDebounce?: number | string;
    /**
     * Sets the short binding prefix (`':'` -> `:text`, `'ypy:'` -> `ypy:text`, `''`/`false` -> disabled).
     * Alpine.js detection disables the default.
     * @default ":"
     */
    bindPrefix?: string | false;
    /**
     * Adds `$()` as a `q()` alias in `ypy-live`, `:attr`, `ypy-on`, `js:` attributes, and `ypy-trigger` filters.
     * @default false
     */
    useDollar?: boolean;
  }
}

export interface YpyClasses {
  /** Applied to the requesting element and to its indicators while a request is in flight. */
  request: string;
  /** Applied to the swap target between the start of the swap and the swap itself. */
  swapping: string;
  /** Applied to the swap target while settling. */
  settling: string;
  /** Applied to freshly swapped content until it settles. */
  added: string;
  /** Applied to elements that show only during a request. */
  indicator: string;
}

export interface YpyConfig {
  /**
   * Log all YPY events to the console.
   * @default false
   */
  logAll: boolean;
  /**
   * Extra attribute prefix. `ypy-` and `data-ypy-` always work; this adds one more. The default `""` adds none.
   * Must be set via `<meta name="ypy-config">`. Changing after page load has no effect.
   * @default ""
   */
  prefix: string;
  /**
   * Use the View Transitions API for swap animations.
   * @default false
   */
  transitions: boolean;
  /**
   * Controls browser history management.
   * - `true`: push URLs and restore via AJAX on back/forward
   * - `false`: disable history entirely
   * - `"reload"`: push URLs but use `location.reload()` on back/forward
   * @default true
   */
  history: boolean | 'reload';
  /**
   * Fetch `mode` for all YPY requests. Per-element overrides are ignored.
   * @default "same-origin"
   */
  mode: 'same-origin' | 'cors' | 'no-cors';
  /**
   * Default swap style when `ypy-swap` is not specified. Setting it, in code or in the config
   * meta tag, replaces the default.
   * @default "innerMorph"
   */
  defaultSwap: string;
  /**
   * Scroll the focused element into view after each swap.
   * @default false
   */
  defaultFocusScroll: boolean;
  /**
   * Delay in ms between the swap and settle phases.
   * @default 1
   */
  defaultSettleDelay: number;
  /**
   * State classes, one entry per state, each a space separated list. Set an entry to replace it.
   * @default { request: "ypy-request", swapping: "ypy-swapping", settling: "ypy-settling", added: "ypy-added", indicator: "ypy-indicator" }
   */
  classes: YpyClasses;
  /**
   * Include YPY's built-in CSS for the indicator class.
   * @default true
   */
  includeIndicatorCSS: boolean;
  /**
   * Default request timeout in ms.
   * @default 60000
   */
  defaultTimeout: number;
  /**
   * `nonce` for inline `<script>` elements YPY generates (for CSP).
   * @default undefined
   */
  inlineScriptNonce?: string;
  /**
   * Comma-separated list of extensions to auto-load.
   * @default ""
   */
  extensions: string;
  /**
   * Attribute name prefixes preserved during morphing (ignored if name starts with any entry).
   * @default ["data-ypy-powered"]
   */
  morphIgnore: string[];
  /**
   * Max siblings scanned when matching nodes during a morph swap.
   * @default 10
   */
  morphScanLimit: number;
  /**
   * CSS selector for elements skipped entirely during morphing.
   * @default "[ypy-morph-skip]"
   */
  morphSkip?: string;
  /**
   * CSS selector for elements whose children are frozen during morphing (attributes still update).
   * @default "[ypy-morph-skip-children]"
   */
  morphSkipChildren?: string;
  /**
   * HTTP status codes for which YPY will not perform a content swap.
   * @default [204, 304]
   */
  noSwap: number[];
  /**
   * Replaces `:` in attribute modifiers (e.g. `ypy-get:inherited`).
   * Useful when templating engines treat `:` specially.
   * @default undefined (uses `:`)
   */
  metaCharacter?: string;
  /**
   * Run the main swap when the response contained only out-of-band elements.
   * `<ypy-partial>` content always prevents the main swap, whatever this is set to.
   * Override per element with the `swapEmpty` modifier on `ypy-swap`.
   * @default false
   */
  allowEmptySwapAfterOOB: boolean;
  /** Requires ypy-live. */
  live?: YpyLive.Config;
}

/** Context object passed to `ypy.swap()` */
export interface YpySwapContext {
  /** HTML string to swap into the DOM */
  text: string;
  /** Element that triggered the swap, used for history and event firing */
  sourceElement?: Element;
  /** Swap style (e.g. `'innerHTML'`, `'outerHTML'`). Defaults to `ypy.config.defaultSwap` */
  swap?: string;
  /** CSS selector to extract content from the response */
  select?: string;
  /** Selector for out-of-band swaps */
  selectOOB?: string;
  /** Target element to swap into. Defaults to `document.body` */
  target?: Element;
  /** Whether to use the View Transitions API for this swap */
  transition?: boolean;
  /** `ypy-push-url` value: push a URL into history after the swap */
  push?: string | boolean;
  /** `ypy-replace-url` value: replace the current history entry after the swap */
  replace?: string | boolean;
  /** URL fragment to scroll into view after the swap */
  anchor?: string;
}

export namespace YpyLive {
  /** Boolean class membership and class operations. */
  export interface ClassProxy {
    assign(classes: Record<string, any>): void;
    add(...classes: string[]): void;
    remove(...classes: string[]): void;
    toggle(className: string, force?: boolean): boolean;
    replace(oldClass: string, newClass: string): boolean;
    contains(className: string): boolean;
    [name: string]: any;
  }

  export type Updater<Current, Next = Current> = (current: Current) => Next;
  type AriaWrite<T> = T | null | undefined | Updater<T | undefined, T | null | undefined>;
  type AriaTristate = boolean | 'mixed' | 'undefined';
  type AriaOptionalBoolean = boolean | 'undefined';
  type AriaCurrent = boolean | 'page' | 'step' | 'location' | 'date' | 'time';
  type AriaHasPopup = boolean | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
  type AriaInvalid = boolean | 'grammar' | 'spelling';
  type AriaDropEffect = Array<'copy' | 'execute' | 'link' | 'move' | 'none' | 'popup'>;
  type AriaRelevant = Array<'additions' | 'removals' | 'text' | 'all'>;

  /** Typed WAI-ARIA 1.2 state. Assign a function to update the current value. */
  export interface AriaProxy {
    /** Strings and ID references. */
    get activeDescendant(): string | undefined; set activeDescendant(value: AriaWrite<string>);
    get details(): string | undefined; set details(value: AriaWrite<string>);
    get errorMessage(): string | undefined; set errorMessage(value: AriaWrite<string>);
    get keyShortcuts(): string | undefined; set keyShortcuts(value: AriaWrite<string>);
    get label(): string | undefined; set label(value: AriaWrite<string>);
    get placeholder(): string | undefined; set placeholder(value: AriaWrite<string>);
    get roleDescription(): string | undefined; set roleDescription(value: AriaWrite<string>);
    get valueText(): string | undefined; set valueText(value: AriaWrite<string>);

    /** Booleans and states. */
    get atomic(): boolean | undefined; set atomic(value: AriaWrite<boolean>);
    get busy(): boolean | undefined; set busy(value: AriaWrite<boolean>);
    get checked(): AriaTristate | undefined; set checked(value: AriaWrite<AriaTristate>);
    get disabled(): boolean | undefined; set disabled(value: AriaWrite<boolean>);
    get expanded(): AriaOptionalBoolean | undefined; set expanded(value: AriaWrite<AriaOptionalBoolean>);
    get grabbed(): AriaOptionalBoolean | undefined; set grabbed(value: AriaWrite<AriaOptionalBoolean>);
    get hidden(): AriaOptionalBoolean | undefined; set hidden(value: AriaWrite<AriaOptionalBoolean>);
    get modal(): boolean | undefined; set modal(value: AriaWrite<boolean>);
    get multiLine(): boolean | undefined; set multiLine(value: AriaWrite<boolean>);
    get multiSelectable(): boolean | undefined; set multiSelectable(value: AriaWrite<boolean>);
    get pressed(): AriaTristate | undefined; set pressed(value: AriaWrite<AriaTristate>);
    get readOnly(): boolean | undefined; set readOnly(value: AriaWrite<boolean>);
    get required(): boolean | undefined; set required(value: AriaWrite<boolean>);
    get selected(): AriaOptionalBoolean | undefined; set selected(value: AriaWrite<AriaOptionalBoolean>);

    /** Tokens. */
    get autoComplete(): 'inline' | 'list' | 'both' | 'none' | undefined; set autoComplete(value: AriaWrite<'inline' | 'list' | 'both' | 'none'>);
    get current(): AriaCurrent | undefined; set current(value: AriaWrite<AriaCurrent>);
    get hasPopup(): AriaHasPopup | undefined; set hasPopup(value: AriaWrite<AriaHasPopup>);
    get invalid(): AriaInvalid | undefined; set invalid(value: AriaWrite<AriaInvalid>);
    get live(): 'assertive' | 'off' | 'polite' | undefined; set live(value: AriaWrite<'assertive' | 'off' | 'polite'>);
    get orientation(): 'horizontal' | 'undefined' | 'vertical' | undefined; set orientation(value: AriaWrite<'horizontal' | 'undefined' | 'vertical'>);
    get sort(): 'ascending' | 'descending' | 'none' | 'other' | undefined; set sort(value: AriaWrite<'ascending' | 'descending' | 'none' | 'other'>);

    /** Integers and numbers. */
    get colCount(): number | undefined; set colCount(value: AriaWrite<number>);
    get colIndex(): number | undefined; set colIndex(value: AriaWrite<number>);
    get colSpan(): number | undefined; set colSpan(value: AriaWrite<number>);
    get level(): number | undefined; set level(value: AriaWrite<number>);
    get posInSet(): number | undefined; set posInSet(value: AriaWrite<number>);
    get rowCount(): number | undefined; set rowCount(value: AriaWrite<number>);
    get rowIndex(): number | undefined; set rowIndex(value: AriaWrite<number>);
    get rowSpan(): number | undefined; set rowSpan(value: AriaWrite<number>);
    get setSize(): number | undefined; set setSize(value: AriaWrite<number>);
    get valueMax(): number | undefined; set valueMax(value: AriaWrite<number>);
    get valueMin(): number | undefined; set valueMin(value: AriaWrite<number>);
    get valueNow(): number | undefined; set valueNow(value: AriaWrite<number>);

    /** ID reference lists and token lists. */
    get controls(): string[] | undefined; set controls(value: AriaWrite<string[]>);
    get describedBy(): string[] | undefined; set describedBy(value: AriaWrite<string[]>);
    get flowTo(): string[] | undefined; set flowTo(value: AriaWrite<string[]>);
    get labelledBy(): string[] | undefined; set labelledBy(value: AriaWrite<string[]>);
    get owns(): string[] | undefined; set owns(value: AriaWrite<string[]>);
    get dropEffect(): AriaDropEffect | undefined; set dropEffect(value: AriaWrite<AriaDropEffect>);
    get relevant(): AriaRelevant | undefined; set relevant(value: AriaWrite<AriaRelevant>);
  }

  export interface AttrProxy {
    readonly class: ClassProxy & DOMTokenList;
    [name: string]: any;
  }

  /** Typed application-defined `data-*` state. */
  export interface DataProxy {
    [name: string]: any;
  }

  /** State bags that resolve each key from the nearest owning element. */
  export interface Scope {
    /** Typed attributes from the nearest element carrying each attribute. */
    readonly attr: AttrProxy;
    /** Typed `data-*` values from the nearest element carrying each key. */
    readonly data: DataProxy;
    /** Typed ARIA values from the nearest element carrying each attribute. */
    readonly aria: AriaProxy;
    /** Class membership from the nearest element carrying each class. */
    readonly class: ClassProxy;
  }

  /**
   * Reads as a cascading state bag and calls as a selector.
   * `closest.data.count` resolves the nearest owner of `data-count`.
   * `closest('.card')` returns the nearest matching ancestor.
   */
  export interface Closest extends Scope {
    (selector: string): Query;
  }

  export interface Query {
    /** Number of matched elements. */
    count: number;
    /** Returns a plain array of the matched elements. */
    arr(): Element[];
    /**
     * Re-runs the selector grammar with each matched element as the anchor.
     * Supports `next`, `previous`, `closest`, `first`, `last`, and `in` scoping.
     */
    q(selector: string): Query;
    /** Typed attributes on the selected elements themselves. */
    readonly attr: AttrProxy;
    /** Typed `data-*` values from the nearest element carrying each key. */
    readonly data: DataProxy;
    /** Typed `aria-*` values on the selected elements themselves. */
    readonly aria: AriaProxy;
    /** Class state and `classList` methods on the selected elements themselves. */
    readonly class: ClassProxy & DOMTokenList;
    /** Forces element scoping for every bag, including `data`. */
    readonly local: Scope;
    /** Forces DOM scoping for every bag. Also callable as `closest(selector)`. */
    readonly closest: Closest;
    /**
     * Move a class or attribute from sibling/scoped elements to all matched elements.
     * @param scope - CSS selector, DOM node, or `{ from: string }`. Defaults to parent element.
     */
    take(name: string, scope?: string | Node | { from: string }): Query;
    /**
     * Toggle (binary flip) or cycle (with `values`) a class or attribute on all matched elements.
     * @param values - Pipe-delimited string (`'grid|list'`) or array to cycle through.
     */
    toggle(name: string, ...values: any[]): Query;
    /**
     * Dispatch a `CustomEvent` from all matched elements.
     * @param bubbles - Defaults to `true`.
     */
    trigger(type: string, detail?: any, bubbles?: boolean): Query;
    /**
     * Insert HTML relative to all matched elements, then process what was added.
     * - `'before'`/`'after'`: sibling before/after
     * - `'start'`/`'end'`: first/last child
     * - `'into'`: replace the children
     * - `'replace'`: replace the element itself
     */
    insert(pos: 'before' | 'after' | 'start' | 'end' | 'into' | 'replace', html: string): Query;
    /** Iterate over matched elements. */
    [Symbol.iterator](): IterableIterator<Element>;
    /** DOM property passthrough: reads from first element, writes to all. */
    [key: string]: any;
  }
}

/** ypy-signals extension API (see https://ypy.dev/docs/reference/signals). */
export interface YpySignals {
  /**
   * Makes `fn` callable from signal expressions as `name(...)`. The name is a plain identifier; a function
   * registered later is found when the expression runs. The function receives plain values.
   */
  register(name: string, fn: (...args: any[]) => any): void;
  /** The value at a path such as `"user.name"` (a leading `$` is allowed), seen from `element`. */
  get(path: string, element?: Element): any;
  /**
   * Applies a merge patch like a server response does. With `onlyIfMissing`, existing signals keep their value.
   * Fires the cancelable `ypy:signals:patch` event first.
   */
  patch(patch: Record<string, any>, element?: Element, onlyIfMissing?: boolean): void;
  /** Live computed and effect nodes, and bindings with an uncommitted value. */
  stats(): { nodes: number; pending: number };
}

/** ypy-stream extension API (see https://ypy.dev/docs/reference/stream). */
export interface YpyStream {
  /** Closes the stream of an element (reason `api`); it does not reconnect. */
  close(element: Element): void;
  /** The number of streams that are open, for leak tests and tooling. */
  stats(): { open: number };
}

export interface YpyLive {
  /**
   * Returns a query proxy over elements matching a selector, element, or collection.
   * Directional keywords (`next`, `previous`, `closest`) only work inside `ypy-live`/`ypy-on` expressions.
   */
  q(selector: string): YpyLive.Query;
  q(element: Element): YpyLive.Query;
  q(elements: Iterable<Element>): YpyLive.Query;
  /** Aliases `q()`. */
  $(selector: string): YpyLive.Query;
  $(element: Element): YpyLive.Query;
  $(elements: Iterable<Element>): YpyLive.Query;
  /**
   * Awaitable debounce: resolves after `ms` ms. Cancels any pending call on the same element.
   */
  debounce(ms: number): Promise<void>;
  /** Callback debounce: calls `fn` after `ms` ms, cancelling any pending call. */
  debounce(ms: number, fn: () => void): void;
  /**
   * Force a recompute of all live expressions.
   * Use when an expression reads from a source the observer cannot track (JS variable, getter, external store).
   */
  refresh(): void;
  /** Move a class or attribute from sibling/scoped elements to the target. */
  take(target: string | Element | NodeList, name: string, scope?: string | Node | { from: string }): void;
  /** Toggle or cycle a class or attribute on the target. */
  toggle(target: string | Element | NodeList, name: string, ...values: any[]): void;
  /**
   * Resolves on the next matching event, timeout, or interval, whichever fires first.
   * - `string`: event name or interval
   * - `number`: timeout in ms
   * - `EventTarget`: redirects listeners to that target
   */
  forEvent(...args: (string | number | EventTarget)[]): Promise<Event | string | number>;
  /**
   * Resolves on the next animation frame. Useful to force a style recalc between two DOM writes.
   */
  nextFrame(): Promise<void>;
}

/** Fetch request options, modifiable in ypy:config:request */
export interface YpyRequestOptions {
  /** Whether to validate the form before sending */
  validate: boolean;
  /** Request URL without its fragment */
  action: string;
  /** URL fragment used for history and scrolling */
  anchor?: string;
  /** HTTP method */
  method: string;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body. FormData during ypy:config:request, then encoded for Fetch */
  body?: BodyInit | null;
  /** Abort YPY's request controller */
  abort: () => void;
  /** Signal passed to fetch() */
  signal: AbortSignal;
  /** Fetch credentials mode */
  credentials: RequestCredentials;
  /** Fetch mode */
  mode: RequestMode;
  /** Fetch cache mode */
  cache?: RequestCache;
  /** Per-request YPY timeout */
  timeout?: number | string | null;
  [key: string]: any;
}

/** Response object available after a fetch completes */
export interface YpyResponse {
  /** Raw Fetch API Response (body not yet consumed in ypy:before:response) */
  raw: Response;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Headers;
}

/** Parsed swap specification: the style plus its modifiers (`ypy-swap="innerHTML swap:1s scroll:top"`). */
export interface YpySwapSpec {
  /** Normalized swap style, for example `innerHTML`, `outerHTML`, `beforeend`, `delete`, `none` */
  style: string;
  /** Delay before the swap, `swap:` modifier */
  swap?: number | string;
  /** Delay before settling, `settle:` modifier */
  settle?: number | string;
  /** `transition:` modifier; `false` opts out of a view transition */
  transition?: boolean;
  /** `ignoreTitle:` modifier */
  ignoreTitle?: boolean;
  /** `swapEmpty:` modifier: swap even when the response has nothing left for this swap */
  swapEmpty?: boolean;
  /** `strip:` modifier: swap the children of the fragment's wrapper element */
  strip?: boolean;
  /** `scroll:` modifier */
  scroll?: 'top' | 'bottom';
  /** `scroll:` target selector */
  scrollTarget?: string;
  /** `show:` modifier */
  show?: 'top' | 'bottom';
  /** `show:` target selector */
  showTarget?: string;
  /** `focus-scroll:` modifier */
  focusScroll?: boolean;
  /** `target:` modifier: selector of the element to swap into */
  target?: string;
  [key: string]: any;
}

/**
 * One piece of a response to insert: the main swap, an out-of-band element or a partial
 * (extensions may add their own types). Listed in `evt.detail.tasks` of `ypy:before:swap`.
 */
export interface YpySwapTask {
  /** `main`, `oob`, `partial`, or the type an extension gave it */
  type: string;
  /** The content to insert */
  fragment: DocumentFragment;
  /** Element to swap into, or a selector resolved when the task runs; set to the final target after the swap */
  target: Element | string | null;
  /** Swap specification, or its string form */
  swapSpec: YpySwapSpec | string;
  /** Element the request started from */
  sourceElement?: Element;
  /** Whether this task runs in a view transition (main swap only) */
  transition?: boolean;
}

/** Request context passed as evt.detail.ctx on most YPY request lifecycle events */
export interface YpyRequestCtx {
  /** Element that triggered the request */
  sourceElement: Element;
  /** Event that triggered the request */
  sourceEvent: Event | null;
  /** Target element where the response will be swapped */
  target: Element;
  /** ypy-select value */
  select: string;
  /** ypy-select-oob value */
  selectOOB: string;
  /** ypy-swap value */
  swap: string;
  /** ypy-push-url value */
  push: string | boolean;
  /** ypy-replace-url value */
  replace: string | boolean;
  /** Whether to use view transitions */
  transition: boolean;
  /** Fetch request options: modify here in ypy:config:request */
  request: YpyRequestOptions;
  /** Response object, available after fetch resolves */
  response?: YpyResponse;
  /** Response body text, available during ypy:after:request */
  text?: string;
}

/** History detail shared by ypy:before:history:update and ypy:after:history:update */
export interface YpyHistoryDetail {
  /** "push" or "replace" */
  type: 'push' | 'replace';
  /** The URL path */
  path: string;
}

/**
 * Events named ypy:<noun>:<verb>. They are
 * fired with `__triggerNative`. A task declares its events by merging this interface inside its
 * own region at the end of this file, for example:
 *
 *     export interface YpyNativeEventMap { 'ypy:target:missing': { ctx: YpyRequestCtx; selector: string } }
 */
export interface YpyNativeEventMap {}

export interface YpyEventMap extends YpyNativeEventMap {
  /**
   * Fires after request values are collected and validated, but before encoding and sending.
   * Modify `ctx.request` to change headers, timeout, credentials, etc.
   * Call `evt.preventDefault()` to cancel the request.
   */
  'ypy:config:request': { ctx: YpyRequestCtx };

  /**
   * Fires immediately before `fetch()` is called, after all configuration.
   * Cancel to prevent the request from being sent.
   */
  'ypy:before:request': { ctx: YpyRequestCtx };

  /**
   * Fires after the fetch resolves and the response is received, before swapping.
   * `ctx.response` is available with status and headers.
   */
  'ypy:after:request': { ctx: YpyRequestCtx };

  /**
   * Fires when request completes, fails, or is cancelled.
   * Does not run if processing stops before the request begins issuing.
   */
  'ypy:finally:request': { ctx: YpyRequestCtx };

  /**
   * Fires after the network response arrives but before YPY reads the response body.
   * `ctx.response.raw` is the unconsumed Fetch `Response`.
   * Cancel to skip body consumption and the swap entirely.
   */
  'ypy:before:response': { ctx: YpyRequestCtx };

  /**
   * Fires after response content is parsed but before it is inserted into the DOM.
   * Cancel to prevent the swap from occurring.
   */
  'ypy:before:swap': { ctx: YpyRequestCtx; tasks: any[] };

  /**
   * Fires after new content has been swapped into the DOM, before elements are processed.
   */
  'ypy:after:swap': { ctx: YpyRequestCtx };

  /**
   * Fires at the end of the swap lifecycle whether successful or failed.
   * Equivalent to a `finally` block for swaps.
   */
  'ypy:finally:swap': { ctx: YpyRequestCtx };

  /**
   * Fires after new content is inserted but before CSS transitions are applied.
   * Modify `newContent` nodes before transitions run.
   */
  'ypy:before:settle': { task: any; newContent: ChildNode[]; settleTasks: any[] };

  /**
   * Fires after the settle phase completes, including all CSS transitions.
   * The DOM is fully stable at this point.
   */
  'ypy:after:settle': { task: any; newContent: ChildNode[]; settleTasks: any[] };

  /**
   * Fires before YPY removes listeners and internal data from an element.
   * Fires before element removal during a swap or before re-processing.
   */
  'ypy:before:cleanup': Record<string, never>;

  /**
   * Fires after YPY has removed all listeners and internal data from an element.
   */
  'ypy:after:cleanup': Record<string, never>;

  /**
   * Fires when an element with `ypy-confirm` is triggered, before the request is sent.
   * Call `evt.preventDefault()` to replace the default `window.confirm()` dialog,
   * then call either `issueRequest()` or `dropRequest()`. Failing to call one
   * will leave the request pending indefinitely.
   */
  'ypy:confirm': {
    ctx: YpyRequestCtx;
    /** Call to proceed with the request */
    issueRequest: () => void;
    /** Call to cancel the request */
    dropRequest: () => void;
  };

  /**
   * Fires when an exception occurs during the request or swap process.
   * Does NOT fire for HTTP 4xx/5xx. Use ypy:response:error for those.
   * Note: `ctx` is absent when the error occurs before the request context is established.
   */
  'ypy:error': { ctx?: YpyRequestCtx; error: unknown };

  /**
   * Fires when the server responds with HTTP 400 or higher.
   * Does NOT fire for network errors. Use ypy:error for those.
   */
  'ypy:response:error': { ctx: YpyRequestCtx };

  /**
   * Control event: fire this on an element to abort its ongoing request.
   * @example ypy.trigger('#myElement', 'ypy:abort')
   */
  'ypy:abort': Record<string, never>;

  /**
   * Fires before YPY attaches its internal metadata structure to an element.
   */
  'ypy:before:init': Record<string, never>;

  /**
   * Fires after an element is fully initialized with all behaviors and event listeners.
   */
  'ypy:after:init': Record<string, never>;

  /**
   * Fires before YPY begins processing a DOM node or subtree.
   * Cancel to prevent YPY from processing the element.
   */
  'ypy:before:process': Record<string, never>;

  /**
   * Fires after YPY has finished processing a DOM node or subtree.
   */
  'ypy:after:process': Record<string, never>;

  /**
   * Fires before YPY attaches `ypy-on` event listeners to an element.
   * Cancel to prevent `ypy-on` handlers from being registered on the element.
   */
  'ypy:before:on:init': Record<string, never>;

  /**
   * Fires before `history.pushState()` or `history.replaceState()` is called.
   * Cancel to prevent the history update.
   */
  'ypy:before:history:update': { history: YpyHistoryDetail; sourceElement: Element; response: YpyResponse };

  /**
   * Fires after `history.pushState()` or `history.replaceState()` completes.
   */
  'ypy:after:history:update': { history: YpyHistoryDetail; sourceElement: Element; response: YpyResponse };

  /**
   * Fires after a `history.pushState()` operation (new history entry created).
   */
  'ypy:after:history:push': { path: string };

  /**
   * Fires after a `history.replaceState()` operation (current entry replaced).
   */
  'ypy:after:history:replace': { path: string };

  /**
   * Fires when the user navigates back/forward (popstate), before content is restored.
   * Cancel to prevent history restoration and handle it manually.
   * `cacheMiss` is always `true` from core; extensions such as `ypy-history-cache`
   * intercept this event and set `detail.cancelled = true` to handle cache hits themselves.
   */
  'ypy:before:history:restore': { path: string; cacheMiss: boolean };

  /**
   * Fires before a View Transition starts.
   * Only fires when `ypy.config.transitions` is `true` and the browser supports the View Transitions API.
   * Cancel to skip the view transition for this swap.
   */
  'ypy:before:viewTransition': { task: () => Promise<void> };

  /**
   * Fires after a View Transition animation completes.
   */
  'ypy:after:viewTransition': { task: () => Promise<void> };
}

export type YpyEvent<K extends keyof YpyEventMap> = CustomEvent<YpyEventMap[K]>;

/**
 * Hooks delivered to extensions only: an extension declares a method named like the hook with `:`
 * written `_` (`ypy_scope`) in the object it gives to `ypy.registerExtension()`. They are
 * never dispatched on the DOM, so `ypy.on()` and `addEventListener()` do not see them.
 * `detail.cancelled` is set when a hook returns `false`.
 */
export interface YpyHookMap {
  /** Runs before author code is compiled: add names to `scope`, or rewrite `code`. */
  'ypy:scope': { scope: Record<string, any>; code: string };
  /** Runs for each pair of nodes a morph matches. Return `false` to skip the node. */
  'ypy:before:morph:node': { oldNode: Node; newNode: Node };
  /** Runs for each attribute a morph is about to set or remove. Return `false` to keep the attribute as it is. */
  'ypy:before:morph:attr': { element: Element; attributeName: string; mutationType: 'update' | 'remove' };
  /** Runs for a `<ypy-partial>` of a type that is not built in, so an extension can add swap tasks. Written `ypy:process:<type>`. */
  [hook: `ypy:process:${string}`]: { ctx: YpyRequestCtx; tasks: YpySwapTask[] };
}

/** Options accepted by `ypy.ajax()` */
export interface YpyAjaxOptions {
  /** Element to use as the request source (for headers, inheritance, etc.) */
  source?: Element | string;
  /** Event that triggered the request */
  event?: Event;
  /** Target element or CSS selector to swap the response into */
  target?: Element | string;
  /** Swap style (e.g. `'innerHTML'`, `'outerHTML'`) */
  swap?: string;
  /** Additional values to include in the request body */
  values?: Record<string, any>;
  /** Additional request headers */
  headers?: Record<string, string>;
  /** CSS selector to extract content from the response */
  select?: string;
  /** Selector for out-of-band swaps */
  selectOOB?: string;
  /** Push a URL into browser history after the swap. `true` uses the request URL */
  push?: string | boolean;
  /** Replace the current history entry after the swap. `true` uses the request URL */
  replace?: string | boolean;
}

export interface Ypy {
  /** YPY version string */
  version: string;
  /** Global YPY configuration */
  config: YpyConfig;
  /** ypy-live extension API, available when the extension is loaded */
  live?: YpyLive;
  /** ypy-signals extension API, available when the extension is loaded */
  signals?: YpySignals;
  /** ypy-stream extension API, available when the extension is loaded */
  stream?: YpyStream;
  /**
   * Issues an ypy-style AJAX request programmatically.
   * Returns a Promise that resolves after the response has been swapped into the DOM.
   * @param verb - HTTP method (GET, POST, PUT, PATCH, DELETE)
   * @param path - URL to request
   * @param options - Swap target element, CSS selector, or full request context object
   * @example
   * ypy.ajax('GET', '/items', '#list')
   * ypy.ajax('POST', '/save', { target: '#result', swap: 'outerHTML' })
   */
  ajax(verb: string, path: string, options?: Element | string | YpyAjaxOptions): Promise<void>;
  /**
   * Find the first element matching `selector` in the document.
   */
  find(selector: string): Element | null;
  /**
   * Find the first element matching `selector` within `elt`.
   */
  find(elt: Element, selector: string): Element | null;
  /**
   * Find all elements matching `selector` in the document.
   */
  findAll(selector: string): Element[];
  /**
   * Find all elements matching `selector` within `elt`.
   */
  findAll(elt: Element, selector: string): Element[];
  /**
   * Register an event listener on `document` for an YPY event, with full type inference on `evt.detail`.
   */
  on<K extends keyof YpyEventMap>(event: K, handler: (evt: YpyEvent<K>) => void): (evt: YpyEvent<K>) => void;
  /**
   * Register an event listener on a specific element for an YPY event.
   */
  on<K extends keyof YpyEventMap>(target: string | Element, event: K, handler: (evt: YpyEvent<K>) => void): (evt: YpyEvent<K>) => void;
  on<K extends keyof HTMLElementEventMap>(event: K, handler: (evt: HTMLElementEventMap[K]) => void): (evt: HTMLElementEventMap[K]) => void;
  on<K extends keyof HTMLElementEventMap>(target: string | Element, event: K, handler: (evt: HTMLElementEventMap[K]) => void): (evt: HTMLElementEventMap[K]) => void;
  on<K extends keyof WindowEventMap>(target: Window, event: K, handler: (evt: WindowEventMap[K]) => void): (evt: WindowEventMap[K]) => void;
  on(event: string, handler: (evt: Event) => void): (evt: Event) => void;
  on(target: string | Element, event: string, handler: (evt: Event) => void): (evt: Event) => void;
  /**
   * Register a callback that fires whenever YPY finishes processing a new element.
   * Equivalent to listening for `ypy:after:process`.
   */
  onLoad(callback: (elt: Element) => void): void;
  /**
   * Sets up history handling and processes `document.body`.
   * Called automatically on `DOMContentLoaded` (or next tick if the document is already loaded).
   * Safe to call multiple times. History listeners are only registered once.
   * Call manually when loading YPY asynchronously or after a streaming response delivers the full page.
   */
  initialize(): void;
  /**
   * Initialize YPY attributes on `root` and all its descendants.
   * When `force` is `true`, tears down and re-initializes already-processed elements.
   * Use this after manually mutating `ypy-*` attributes on a live element.
   */
  process(root: Element | ShadowRoot, force?: boolean): void;
  /**
   * Register an YPY extension. The extension must be listed in `ypy.config.extensions`
   * (unless that list is empty). Duplicate registrations are silently ignored.
   */
  registerExtension(name: string, ext: any): void;
  /**
   * Dispatch a `CustomEvent` on `elt` and return `true` if it was not cancelled.
   */
  trigger<K extends keyof YpyEventMap>(elt: Element | string, event: K, detail: YpyEventMap[K], bubbles?: boolean): boolean;
  trigger(elt: Element | string, event: string, detail?: any, bubbles?: boolean): boolean;
  /**
   * Returns a Promise that resolves after `time` milliseconds.
   * Accepts a number (ms) or an interval string (`'2s'`, `'500ms'`, `'1m'`).
   * Returns `undefined` if `time` is 0 or falsy.
   */
  timeout(time: number | string): Promise<void> | undefined;
  /**
   * Parse a time interval string or number into milliseconds.
   * Accepts a number (returned as-is) or a string with units: `ms`, `s`, `m`.
   * Returns `undefined` if parsing fails.
   * @example
   * ypy.parseInterval('2s')    // 2000
   * ypy.parseInterval('500ms') // 500
   * ypy.parseInterval(1000)    // 1000
   */
  parseInterval(str: string | number): number | undefined;
  /**
   * Perform an HTML content swap into the DOM.
   * Primarily used by extensions and advanced integrations. Prefer `ypy.ajax()` for most use cases.
   */
  swap(ctx: YpySwapContext): Promise<void>;
}

//================================================================================
// One region per Phase 1 task. A task edits only its own region, so two tasks never
// touch the same lines. Declare additions by merging the interface in question:
//   YpyConfig          config keys
//   YpyRequestCtx      ctx fields
//   YpyNativeEventMap  new ypy:<noun>:<verb> events
//   Ypy                new members of the ypy object
// (TASK-006 declares the reserved ctx fields in the region of the task that owns them:
//  errorKind and redirected in 009, fallback in 011, announce in 013, focus and scroll in 014.)
//================================================================================

// #region TASK-007 morph as the default swap

/** The swap specification, as `__parseSwapSpec` returns it. */
export interface YpySwapSpec {
  /**
   * `true` when nobody wrote the style, so it came from `ypy.config.defaultSwap`. The
   * default is `innerMorph`, and a default style meeting `document.body` replaces
   * the page instead of morphing it. A style that is written never has this flag.
   */
  default?: boolean;
}

export interface Ypy {
  /**
   * The swap style of an out-of-band element that gives none (`ypy-swap-oob="true"`):
   * `"outerMorph default:true"`.
   */
  __defaultOOBSwap(): string;
}
// #endregion

// #region TASK-008 request queue outside the element and ypy-sync
/** Why a request was queued, dropped or aborted */
export type YpyRequestReason =
  | 'queue'          // queued only: the request waits for its turn
  | 'drop'           // `drop`: a request was in flight, this one was refused
  | 'replace'        // `replace`: the in-flight request and the waiting ones were replaced
  | 'abort'          // `abort`: this request was refused, or an `abort` request was aborted
  | 'queue-overflow' // the waiting line was full (`queue first`) or replaced (`queue last`)
  | 'timeout'        // the request timed out
  | 'cleanup'        // the element was removed or restarted
  | 'user';          // ypy:abort, or a direct ctx.request.abort()

export interface YpyNativeEventMap {
  /** A request waits behind the one in flight (`queue first`, `queue last`, `queue all`) */
  'ypy:request:queued': { ctx: YpyRequestCtx; reason: 'queue' };
  /** A request that never ran was discarded; `ctx` is that request */
  'ypy:request:dropped': { ctx: YpyRequestCtx; reason: Exclude<YpyRequestReason, 'queue' | 'timeout' | 'user'> };
  /** The request in flight was aborted before its response; `ctx` is that request */
  'ypy:request:aborted': { ctx: YpyRequestCtx; reason: Exclude<YpyRequestReason, 'queue'> };
}
// #endregion

// #region TASK-009 error targets, 422 and 303

/** Reserved by TASK-006, filled by 009 (validation, client, server), 010 (network, offline, timeout). */
export interface YpyRequestCtx {
  /**
   * What kind of failure ended the request: `validation` (422), `client` (other 4xx), `server`
   * (5xx), `network` (fetch rejected), `offline` (the browser reported no connection), `timeout`
   * (the request timeout aborted it). Set before `ypy:response:error`; unset
   * for a successful request.
   */
  errorKind?: 'validation' | 'client' | 'server' | 'network' | 'offline' | 'timeout';
  /**
   * `true` when the response was reached through a redirect (`response.redirected`, a 303 after a
   * `POST`), `false` when it was not. A redirect is a success: nothing else marks it.
   */
  redirected?: boolean;
}

export interface YpyClasses {
  /**
   * Added to the error target (together with `data-ypy-state="error"`) after a response of 400 or
   * more was swapped, and removed when the element that sent the request sends its next one.
   * There is no default class: the attribute alone is enough to style it.
   */
  error?: string;
}

export interface Ypy {
  /**
   * Called for a response of 400 or more, before `ypy:response:error`: sets `ctx.errorKind` and
   * reads `ypy-error-target`, `ypy-error-swap` and `ypy-error-focus` (all inheritable) into
   * `ctx.target`, `ctx.swap` and `ctx.focus`. A 422 goes into the form of the
   * source element, with the default swap, and `ctx.focus = "first-invalid"`.
   */
  __errorDefaults(ctx: YpyRequestCtx): void;
  /**
   * Once the request ended, marks the error target with `data-ypy-state="error"`;
   * nothing else: the focus is `__applyFocus`'s (task 014). Registered by `__errorDefaults`.
   */
  __watchError(ctx: YpyRequestCtx): void;
}
// #endregion

// #region TASK-010 offline apart from error

export interface YpyClasses {
  /**
   * Applied to `<html>` (together with `data-ypy-state="offline"`) while the browser reports no
   * connection.
   * @default "ypy-offline"
   */
  offline?: string;
}

/** Retry of requests that failed to reach the server. Off unless `attempts` is above 0. */
export interface YpyRetryOptions {
  /** How many times a failed request is repeated. A bare `ypy-retry` attribute means 3. @default 0 */
  attempts: number;
  /** Wait before the first repeat, in ms or as `"1s"`. The wait also ends when the window goes online. @default 1000 */
  delay: number | string;
  /** Longest wait between two attempts. @default 30000 */
  max: number | string;
  /** Each wait is this many times longer than the one before. `1` keeps it constant. @default 2 */
  backoff: number;
  /** Methods that are repeated, a space or comma separated list or an array. Only safe methods count. @default "GET HEAD QUERY" */
  methods: string | string[];
  /** Repeat every method, including POST, PUT, PATCH and DELETE. The server may have run the first one. @default false */
  unsafe: boolean;
}

export interface YpyConfig {
  /** Default retry options; the `ypy-retry` attribute overrides them per element. */
  retry?: Partial<YpyRetryOptions>;
}

export interface YpyNativeEventMap {
  /** The browser went offline (`<html>` carries the offline class). Fired on `document`. */
  'ypy:offline': Record<string, never>;
  /** The connection came back, or a response proved it. Fired on `document`. */
  'ypy:online': Record<string, never>;
  /**
   * A failed request is about to be repeated after `delay` ms. `attempt` is 1 for the first
   * repeat. Call `evt.preventDefault()` to give up (the error is then reported as usual).
   */
  'ypy:request:retry': { attempt: number; delay: number; ctx: YpyRequestCtx };
}
// (ctx.errorKind also takes "timeout", set by `__failRequest`; the union is declared in TASK-009's region.)
// #endregion

// #region TASK-011 target fallback

export interface YpyConfig {
  /**
   * What happens when a target selector (`ypy-target`, `target:` or `YPY-Retarget`) matches nothing.
   * `true`: fall back to the main target (`[ypy-main]`, then `<main>`) when the response is a whole
   * page or holds a main; `"always"`: also for a fragment; `false`: never. The attribute
   * `ypy-fallback` (`true`, `always`, `false`) overrides it per element.
   * Unset means on.
   */
  targetFallback?: boolean | 'always';
}

export interface YpyRequestCtx {
  /** The selector of the main target when it was missing and a fallback ran: `[ypy-main]` or `main`. */
  fallback?: string;
  /** The `ypy-target` selector that matched nothing when the request was made (only under a fallback policy). */
  targetSelector?: string;
}

export interface YpySwapTask {
  /** The selector behind a missing `target`, for `ypy:target:missing` (set by whoever builds the task). */
  selector?: string;
  /** The request the task belongs to, passed on in `ypy:target:missing` (set by whoever builds the task). */
  ctx?: YpyRequestCtx;
}

export interface YpyNativeEventMap {
  /**
   * The main target selector matched nothing and the chain `[ypy-main]`, `<main>` took over.
   * `selector` is what failed, `used` the fallback selector (`[ypy-main]` or `main`).
   * Fires on the source element before the swap.
   */
  'ypy:target:fallback': { selector: string; used: string; ctx: YpyRequestCtx };
  /**
   * No target could be found: a main swap with no fallback, or an out-of-band element or partial
   * whose target matched nothing (these never fall back). Cancelable: cancel it to silence
   * the console warning. `task` is set for out-of-band elements and partials.
   */
  'ypy:target:missing': { selector: string; ctx?: YpyRequestCtx; task?: YpySwapTask };
}
// #endregion

// #region TASK-012 partials and out-of-band
export interface YpyNativeEventMap {
  /**
   * A swap task failed while the others went on; fires once per failed
   * task, on the element the request started from, before `ypy:after:swap`.
   */
  'ypy:swap:error': { ctx: YpyRequestCtx; task: YpySwapTask; error: unknown };
}

export interface YpyRequestCtx {
  /**
   * The out-of-band elements and partials of the response that found no
   * element to swap into (`ypy:target:missing` fired for each). Set while the swap tasks are built.
   */
  missingTargets?: { type: 'oob' | 'partial'; selector: string }[];
}
// #endregion

// #region TASK-013 aria-busy and announcements

/** Reserved by TASK-006, read by 013's `__announce`; 009, 010 and 011 may set it. */
export interface YpyRequestCtx {
  /**
   * What to say in the live region when the request ends: literal text, `"title"` (the new
   * document title) or `"none"`; `false` is silence. Read before the `ypy-announce` attribute.
   */
  announce?: string | boolean | null;
  /** The elements marked `aria-busy` for this request (the target, then each OOB and partial target), until the request ends. */
  busy?: Element[] | null;
}

/** Texts for the live region. The core carries none: an unset message says nothing. */
export interface YpyAnnounceMessages {
  /** Said when a request starts (and the target is marked busy). */
  loading?: string;
  /** Said when a request ends and its response was swapped. */
  done?: string;
  /** Said when the request failed for lack of a connection (`network`, `offline`). */
  offline?: string;
  /** Said when the request failed for any other reason. */
  error?: string;
}

export interface YpyAnnounceConfig {
  /** Milliseconds before the live region is emptied again. @default 5000 */
  clearAfter?: number;
  messages?: YpyAnnounceMessages;
}

export interface YpyConfig {
  /**
   * Mark the target `aria-busy="true"` while a request runs. Unset means on.
   * `ypy-busy="false"` opts one element out.
   */
  ariaBusy?: boolean;
  /**
   * Announcements through the managed live region (`<div data-ypy-live>`). Unset means on;
   * `false` turns them off; an object sets the messages and `clearAfter`.
   */
  announce?: boolean | YpyAnnounceConfig;
}

export interface YpyNativeEventMap {
  /**
   * Fires, cancelable, just before a message goes into the live region. A listener may change
   * `message` and `politeness`.
   */
  'ypy:announce': { ctx: YpyRequestCtx; message: string; politeness: 'polite' | 'assertive' };
}
// #endregion

// #region TASK-014 focus and scroll

export interface YpyRequestCtx {
  /**
   * Where the focus goes once the swap ends: a selector (extended syntax, relative to the source
   * element), `"first-heading"`, `"first-invalid"` (the first `[aria-invalid="true"]` or invalid field
   * of the swap target; the default of a 422, see `ypy-error-focus`), `"none"`, `"auto"` or `false`. Read before the `ypy-focus`
   * attribute; unset means the attribute, then `"auto"`.
   */
  focus?: string | false | null;
  /**
   * Scroll policy applied when the swap ends: `"keep"`, `"top"`, `"restore"`, or a vertical offset
   * in pixels (`"120"`, `"120px"`, `120`). Read before the `ypy-scroll` attribute.
   */
  scroll?: string | number | false | null;
  /** What `scroll: "keep"` puts back: the window and the swap target, noted just before the swap. */
  scrollKept?: [ScrollToOptions | undefined, (ScrollToOptions | null | undefined)?];
}
// #endregion

// #region TASK-015 security: nonce, trusted types, callbacks, meta
export interface YpyConfig {
  /**
   * What author code may do: `ypy-on`, `js:` values, and `[filter]` triggers.
   * `"none"` never compiles code (a warning is logged once and `ypy:security:blocked` fires),
   * `"nonce"` runs it only through the `ypy-csp` extension, which checks the element's nonce, and
   * `"all"` always runs it. Unset: `"none"`. Any other value counts as `"none"`.
   */
  callbacks?: 'none' | 'nonce' | 'all';
  /**
   * `true` requires the `ypy-csp` extension: until it has started (it needs `extensions:"ypy-csp"`,
   * a script with a CSP nonce, and the `ypy` Trusted Types policy when the CSP enforces them),
   * YPY processes no element and sends no request.
   */
  nonce?: boolean;
  /**
   * Alias of `mode`: `true` is `"same-origin"`, `false` is `"cors"`. Same origin is the default.
   */
  selfRequestsOnly: boolean;
  /**
   * `true` once the configuration is locked: `mode`, `callbacks`, `extensions`, `nonce`,
   * `inlineScriptNonce` and `ypy.config` itself ignore later assignments (with a console
   * warning). Set `locked:true` in the `ypy-config` meta tag, or call `ypy.config.lock()`.
   */
  readonly locked?: boolean;
  /** Locks the configuration (see `locked`). Cannot be undone. Present once the `ypy-lock` extension has started. */
  lock?(): void;
}

export interface YpyNativeEventMap {
  /**
   * Author code (`ypy-on`, `js:` value, `[filter]` trigger) was not compiled because of
   * `config.callbacks`. `reason` is `"callbacks-none"` or `"callbacks-nonce"`.
   */
  'ypy:security:blocked': { reason: 'callbacks-none' | 'callbacks-nonce'; code: string };
  /** `ypy-csp` removed `ypy-*` and `data-ypy-*` attributes from an element without a valid nonce. */
  'ypy:security:strip': { reason: 'missing-nonce' | 'nonce-mismatch'; stripped: string[] };
  /** `ypy-csp` stopped an action: `javascript:` URL, unnonced submitter or code without a nonce. */
  'ypy:security:violation': {
    reason: 'nonce-mismatch-at-eval' | 'javascript-url' | 'unnonced-submitter';
    action?: string;
    submitter?: Element;
    ctx?: YpyRequestCtx;
  };
}
// #endregion

// #region TASK-016 trustworthy history

/** What `ypy.config.historyRestore` accepts. */
export interface YpyHistoryRestoreConfig {
  /**
   * Fetch `cache` mode of the request that restores a page on back and forward.
   * @default "no-cache"
   */
  cache?: RequestCache;
  /**
   * When the response of a restore is not a whole page (no doctype, `<html>` or `<body>`),
   * reload the page instead of swapping the fragment, and fire `ypy:history:restore:fragment`.
   * @default true
   */
  fragment?: boolean;
}

export interface YpyConfig {
  /** Options of the request that restores a page from history. See `YpyHistoryRestoreConfig`. */
  historyRestore?: YpyHistoryRestoreConfig;
}

/** State YPY stores in an entry it created. Other keys of the entry are kept. */
export interface YpyHistoryState {
  ypy: true;
  /** `[scrollX, scrollY]` of the page when the user left the entry by a push. */
  scroll?: [number, number];
}

export interface YpyRequestCtx {
  /** Scroll position of the entry being restored, passed with `scroll: "restore"`. */
  scrollPosition?: [number, number];
}

/** What `ypy.ajax()` takes in `options.request`: merged into the request, never a replacement. */
export interface YpyAjaxOptions {
  /**
   * Fields of the request: `cache`, `signal`, `headers` and any other `fetch` option. They are
   * merged into the request YPY built, which keeps `mode`, `credentials`, `abort`, `validate` and
   * the core headers. A `signal` is combined with the request's own. A header set to `null` or
   * `undefined` is removed (also in `options.headers`).
   */
  request?: Partial<Omit<YpyRequestOptions, 'action' | 'method' | 'headers'>> & {
    headers?: Record<string, string | null | undefined>;
  };
}

export interface YpyNativeEventMap {
  /**
   * Fires when a history restore got something that is not a whole page. The page is reloaded
   * right after it, so the browser asks for the page itself. Not cancelable in effect: turn the
   * safety net off with `config.historyRestore.fragment = false`.
   */
  'ypy:history:restore:fragment': { ctx: YpyRequestCtx };
}
// #endregion

// #region TASK-017 preserved elements
export interface YpyConfig {
  /**
   * Selector of the elements a script other than YPY owns, besides every custom element (a tag name with a
   * hyphen). A morph keeps the children of such an element when the response gives it
   * with no content, unless it carries `ypy-preserve="false"`. Default `[data-reactroot],[data-v-app],[x-data]`.
   */
  morphThirdParty?: string;
}
export interface Ypy {
  /**
   * Calls `callback(elt)` once for each element that matches `selector` in the content YPY processes: the
   * page on load, and every swap, out-of-band element and partial. Use it to start a script's components,
   * for example `ypy.onLoad('[data-bs-toggle="tooltip"]', el => new bootstrap.Tooltip(el))`.
   */
  onLoad(selector: string, callback: (elt: Element) => void): void;
}
// #endregion

// #region TASK-052 request context and extensions

export interface YpyRequestCtx {
  /**
   * Where the request is in its life: `created`, `issuing`, `response received`, `swapped`, or
   * `error: <reason>`. Read it, do not set it.
   */
  status: string;
  /** The `ypy-confirm` value of the source element, a message or a `js:` expression. */
  confirm?: string;
  /**
   * The `YPY-*` response headers, named without the `YPY-` prefix, lower case and without hyphens:
   * `YPY-Push-Url` is `ctx.ypy.pushurl`. Set before `ypy:before:response`.
   */
  ypy?: YpyResponseHeaders;
  /** Set by an extension that takes over the response (`ypy-sse`, `ypy-download`): the request ends when it settles. */
  extensionPromise?: Promise<unknown>;
  /** Request timeout in ms, set by `ypy.ajax()`. The streaming extensions copy it to `ctx.request.timeout`. */
  timeout?: number | string;
}

/** The `YPY-*` headers of a response, as `ctx.ypy` holds them. Any other `YPY-*` header is in there too. */
export interface YpyResponseHeaders {
  /** `YPY-Trigger` */
  trigger?: string;
  /** `YPY-Push-Url` */
  pushurl?: string;
  /** `YPY-Replace-Url` */
  replaceurl?: string;
  /** `YPY-Redirect` */
  redirect?: string;
  /** `YPY-Location` */
  location?: string;
  /** `YPY-Refresh` */
  refresh?: string;
  /** `YPY-Retarget` */
  retarget?: string;
  /** `YPY-Reswap` */
  reswap?: string;
  /** `YPY-Reselect` */
  reselect?: string;
  [header: string]: string | undefined;
}

export interface YpyAjaxOptions {
  /** Request timeout in ms. */
  timeout?: number | string;
}

export interface YpyClasses {
  /** Added to a signals scope while it holds unsaved changes (`ypy-signals`). @default "ypy-dirty" */
  dirty?: string;
}

// --- ypy-sse, ypy-ws, ypy-multipart: connections and messages ---

/** A part of a `multipart/mixed` or `multipart/parallel` response. */
export interface YpyBodyPart {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  json(): Promise<any>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
}

/** One Server-Sent Event. */
export interface YpySseMessage {
  data: string;
  event: string;
  id: string;
}

/** The options of an SSE connection. The defaults depend on the element: see `ypy-sse:connect`. */
export interface YpySseConnectionConfig {
  /** Reconnect after the stream ends or fails. Default `true` on an element with `ypy-sse:connect`, else `false`. */
  reconnect: boolean;
  /** Wait before the first reconnect. @default 500 */
  reconnectDelay: number | string;
  /** Longest wait between two reconnects. @default 60000 */
  reconnectMaxDelay: number | string;
  /** Give up after this many attempts. @default Infinity */
  reconnectMaxAttempts: number;
  /** Random fraction added to each wait, from 0 to 1. @default 0.3 */
  reconnectJitter: number;
  /** Abort a connection attempt after this time; `0` waits without limit. @default ypy.config.defaultTimeout */
  connectTimeout: number | string;
  /** Close while the tab is in the background. Default `true` on an element with `ypy-sse:connect`, else `false`. */
  pauseOnBackground: boolean;
  /** When a request that opened a stream counts as finished. Default `immediate` on an element with `ypy-sse:connect`, else `end`. */
  releaseOn: 'immediate' | 'first' | 'end';
}

export interface YpySseConnection {
  url: string;
  config: YpySseConnectionConfig;
  abortController: AbortController | { abort: () => void; signal: AbortSignal };
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  lastEventId: string;
  attempt: number;
  /** Set to `true` in a `before:connection` listener to stop connecting. */
  cancelled: boolean;
  status: number | null;
}

export interface YpyWsConnectionConfig {
  reconnect: boolean;
  /** Close codes that trigger a reconnect. */
  reconnectCodes: number[];
  reconnectDelay: number | string;
  reconnectMaxDelay: number | string;
  reconnectMaxAttempts: number;
  reconnectJitter: number;
  pauseOnBackground: boolean;
  /** Messages kept while the socket is not open. */
  maxOutgoingMessagesQueueSize: number;
  protocols?: string | string[];
}

export interface YpyWsOutgoingMessage {
  headers: Record<string, string>;
  values: Record<string, any>;
  /** Set it to send raw data instead of the JSON of `values` and `headers`. */
  data: string | ArrayBufferLike | Blob | ArrayBufferView | undefined;
}

export interface YpyWsIncomingMessage {
  data: string | Blob | ArrayBuffer;
  text(): Promise<string>;
  json(): Promise<any>;
}

export interface YpyWsConnection {
  url: string;
  config: YpyWsConnectionConfig;
  socket: WebSocket | null;
  attempt: number;
  queue: Array<{ element: Element; message: YpyWsOutgoingMessage }>;
  /** Set to `true` in a `before:connection` listener to stop connecting. */
  cancelled: boolean;
}

/** The options of a multipart connection: the SSE ones, without `releaseOn`. */
export interface YpyMultipartConnectionConfig {
  reconnect: boolean;
  reconnectDelay: number | string;
  reconnectMaxDelay: number | string;
  reconnectMaxAttempts: number;
  reconnectJitter: number;
  connectTimeout: number | string;
  pauseOnBackground: boolean;
}

export interface YpyMultipartConnection {
  url: string;
  config: YpyMultipartConnectionConfig;
  lastPartId: string | null;
  attempt: number;
  cancelled: boolean;
  reconnectRequested: boolean;
  status: number;
}

// --- ypy-history-cache ---

export interface YpyHistoryCacheItem {
  content: string;
  head: string;
  scroll: number;
  title: string;
}

export interface YpyHistoryCacheConfig {
  /** Pages kept in `sessionStorage`, the oldest dropped first; `0` turns saving off. @default 10 */
  size: number;
  /** Reload on back and forward when the page is not cached. @default false */
  refreshOnMiss: boolean;
  /** Turn the cache off without unloading the extension. @default false */
  disable: boolean;
  /** Swap style that puts cached content back. @default "outerSync" */
  swapStyle: string;
}

export interface YpyPreloadConfig {
  /** Preload boosted links that have no `ypy-preload`. @default true */
  autoBoost?: boolean;
  /** How long an automatic preload stays valid, in ms or as `"5s"`. @default 5000 */
  boostTimeout?: number | string;
  /** The event that starts an automatic preload; `touchstart` always does too. @default "mousedown" */
  boostEvent?: string;
}

export interface YpyConfig {
  /** `ypy-sse` defaults. An element overrides them with `ypy-config='{"sse":{...}}'`. */
  sse?: Partial<YpySseConnectionConfig>;
  /** `ypy-ws` defaults. */
  ws?: Partial<YpyWsConnectionConfig>;
  /** `ypy-multipart` defaults. */
  multipart?: Partial<YpyMultipartConnectionConfig>;
  /** `ypy-history-cache`. Filled with its defaults when the extension starts. */
  historyCache?: Partial<YpyHistoryCacheConfig>;
  /** `ypy-preload` */
  preload?: YpyPreloadConfig;
  /** `ypy-browser-indicator`: show the browser indicator for every boosted element. @default false */
  boostBrowserIndicator?: boolean;
  /** `ypy-csp`: run author code through nonce-checked script injection, so no `unsafe-eval` is needed. @default false */
  safeEval?: boolean;
}

export interface YpyNativeEventMap {
  // ypy-sse
  /** Before an SSE connection opens. Set `connection.cancelled` to stop it. */
  'ypy:sse:before:connection': { connection: YpySseConnection };
  /** After an SSE connection opened. */
  'ypy:sse:after:connection': { connection: YpySseConnection };
  /** Before a message is swapped. Cancel it, or set `cancelled`, to drop the message. `waitUntil` delays the swap until a promise settles. */
  'ypy:sse:before:message': {
    connection: YpySseConnection;
    message: YpySseMessage;
    cancelled: boolean;
    waitUntil: (promise: Promise<unknown>) => void;
  };
  /** After a message was swapped. */
  'ypy:sse:after:message': { connection: YpySseConnection; message: YpySseMessage };
  /** A connection failed or a message could not be handled. */
  'ypy:sse:error': { connection?: YpySseConnection; error: unknown; status?: number; url?: string };
  /** A connection closed. */
  'ypy:sse:close': { connection: YpySseConnection; reason: 'cancelled' | 'message' | 'ended' | 'removed' | 'cleanup' };
  /** The named event a server sends to release the request early. */
  'ypy:release': { data: string; id: string };

  // ypy-stream
  /** A stream connection delivered its headers and is being read (first time or after a reconnection). */
  'ypy:stream:open': { stream: object };
  /** The client waits `delay` ms before the next connection attempt. */
  'ypy:stream:reconnect': { stream: object; delay: number };
  /** The stream ended for good: `api`, `removed`, `redirect`, `replaced`, `status <code>` or `error`. */
  'ypy:stream:close': { stream: object; reason: string };
  /** An event failed, or the read broke (the client reconnects after a read error). */
  'ypy:stream:error': { stream: object; error: unknown };
  /** A signals patch arrived and the signals extension is not loaded. */
  'ypy:stream:signals': { patch: Record<string, unknown>; onlyIfMissing: boolean };

  // ypy-ws
  'ypy:ws:before:connection': { connection: YpyWsConnection };
  'ypy:ws:after:connection': { connection: YpyWsConnection };
  'ypy:ws:close': { connection: YpyWsConnection; reason: 'closed' | 'cancelled' | 'removed'; code: number | null };
  'ypy:ws:error': { connection?: YpyWsConnection; error: unknown; url?: string | null };
  'ypy:ws:before:message:outgoing': {
    connection: YpyWsConnection;
    message: YpyWsOutgoingMessage;
    cancelled: boolean;
    waitUntil: (promise: Promise<unknown>) => void;
  };
  'ypy:ws:after:message:outgoing': { connection: YpyWsConnection; message: YpyWsOutgoingMessage };
  'ypy:ws:before:message:incoming': {
    connection: YpyWsConnection;
    message: YpyWsIncomingMessage;
    cancelled: boolean;
    waitUntil: (promise: Promise<unknown>) => void;
  };
  'ypy:ws:after:message:incoming': { connection: YpyWsConnection; message: YpyWsIncomingMessage };

  // ypy-multipart
  'ypy:multipart:before:connection': { connection: YpyMultipartConnection };
  'ypy:multipart:after:connection': { connection: YpyMultipartConnection };
  'ypy:multipart:before:part': {
    connection: YpyMultipartConnection;
    ctx: YpyRequestCtx;
    part: YpyBodyPart;
    cancelled: boolean;
    waitUntil: (promise: Promise<unknown>) => void;
  };
  'ypy:multipart:after:part': { connection: YpyMultipartConnection; ctx: YpyRequestCtx; part: YpyBodyPart };
  'ypy:multipart:error': { connection: YpyMultipartConnection; error: unknown; status?: number };
  'ypy:multipart:close': { connection: YpyMultipartConnection; reason: 'cancelled' | 'ended' | 'removed' | 'part' | 'cleanup' };

  // ypy-signals
  /** Before a patch is applied to the signals. Cancel it to drop the patch. */
  'ypy:signals:patch': { patch: Record<string, any> };
  /** A patch tried to write a server-owned or read-only signal. */
  'ypy:signals:readonly': { name: string; warn: string };
  'ypy:signals:error': { error: unknown };

  // ypy-download, fired on the source element
  'ypy:download:start': { total: number | null; ctx: YpyRequestCtx };
  'ypy:download:progress': { loaded: number; total: number | null; percent: number | null; ctx: YpyRequestCtx };
  'ypy:download:complete': { filename: string; size: number; ctx: YpyRequestCtx };

  // ypy-prompt: cancel it to abort the request
  'ypy:prompt': { prompt: string; target: Element | string | undefined };

  // ypy-head, fired on `document.body`
  /** Cancel it to skip the merge. */
  'ypy:head:before:merge': { ctx: YpyRequestCtx };
  /** Cancel it to leave this head element out. */
  'ypy:head:before:add': { headElement: Element };
  /** Cancel it to keep this head element. */
  'ypy:head:before:remove': { headElement: Element };
  'ypy:head:after:merge': { added: Element[]; kept: Element[]; removed: Element[] };

  // ypy-history-cache, fired on `document`
  /** Cancel it to leave this page out of the cache. */
  'ypy:history:cache:before:save': { target: Element; head: string };
  'ypy:history:cache:after:save': YpyHistoryCacheItem;
  'ypy:history:cache:before:restore': { head: string; ready: Promise<void> | null };
  'ypy:history:cache:after:restore': { head: string; ready: Promise<void> | null; item: YpyHistoryCacheItem };
  /** Cancel it to ignore the cached page and ask the server. */
  'ypy:history:cache:hit': { path: string; item: YpyHistoryCacheItem };
  'ypy:history:cache:miss': { path: string; refreshOnMiss: boolean };
}
// #endregion

// #region TASK-051 ypy-dev and ypy-inspector
export interface YpyDevMessage {
  level: 'info' | 'warn' | 'error';
  /** A stable name: `target-missing`, `unknown-swap`, `empty-response`, `status-404`, `timeout`, `unknown-attribute`, `legacy-attribute`... */
  code: string;
  text: string;
  elt: Element | null;
  [key: string]: unknown;
}

/** `ypy-dev` extension API, available when the extension is loaded. For development only. */
export interface YpyDev {
  /** The messages so far (the last 200). */
  messages: YpyDevMessage[];
  /** Simulated latency in ms before every request is sent; `latency(min, max)` picks a random one in the range; `0` turns it off. */
  latency(min: number, max?: number): void;
  /** Starts (default) or ends the simulated offline state. */
  offline(on?: boolean): void;
  /** Listens to the Server-Sent Events endpoint that announces changed templates; `true` is `/__ypy/reload`, `false` closes it. */
  reload(url: string | boolean): void;
  /** Adds attribute names (without `ypy-`) that are not typos. */
  known(...names: string[]): void;
  /** Empties `messages`. */
  clear(): void;
  /** The state of the simulator. */
  simulation: { min: number; max: number; offline: boolean };
}

export type YpyInspectorTab = 'requests' | 'swaps' | 'events' | 'signals' | 'streams';

/** The lists the inspector keeps, as `ypy.inspector.data()` and the JSON export hold them. */
export interface YpyInspectorData {
  version: 1;
  url: string;
  at: string;
  requests: Record<string, unknown>[];
  swaps: Record<string, unknown>[];
  events: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  streams: Record<string, unknown>[];
  signalsNow: { scope: string; name: string; value: unknown }[];
}

/** `ypy-inspector` extension API, available when the extension is loaded. For development only. */
export interface YpyInspector {
  open(tab?: YpyInspectorTab): void;
  close(): void;
  toggle(): void;
  pause(on?: boolean): void;
  clear(): void;
  filter(text: string): void;
  data(): YpyInspectorData;
  export(): string;
  /** Records an event that is dispatched with `dispatchEvent` instead of `ypy.trigger`. */
  watch(...events: string[]): void;
  enable(): void;
  disable(): void;
}

export interface Ypy {
  dev?: YpyDev;
  inspector?: YpyInspector;
}

/** Options of `ypy-dev` (`ypy.config.dev`). */
export interface YpyDevOptions {
  /** Simulated latency in ms, or `[min, max]`. */
  latency: number | [number, number];
  /** Start with the simulated offline state on. @default false */
  offline: boolean;
  /** `true` listens on `/__ypy/reload`; a string is the URL of the endpoint. @default false */
  reload: boolean | string;
  /** `false` turns the markup and legacy warnings off. @default true */
  lint: boolean;
  /** `false` keeps the console quiet. @default true */
  log: boolean;
  /** Base URL of the guide pages in legacy warnings. @default "https://ypy.dev/docs/guides/upgrade-check" */
  docs: string;
}

/** Options of `ypy-inspector` (`ypy.config.inspector`). */
export interface YpyInspectorOptions {
  /** Show the panel at start. @default false */
  open: boolean;
  /** The shortcut: modifiers (`Alt`, `Shift`, `Ctrl`, `Meta`) and a letter joined with `+`. @default "Alt+Shift+Y" */
  key: string;
  /** Rows kept in each list. @default 500 */
  max: number;
}

export interface YpyConfig {
  /** Options of `ypy-dev`; `false` turns the extension off. */
  dev?: false | Partial<YpyDevOptions>;
  /** Options of `ypy-inspector`; `false` leaves the page untouched. */
  inspector?: false | Partial<YpyInspectorOptions>;
}

export interface YpyNativeEventMap {
  /** A message of `ypy-dev`; the detail is `YpyDevMessage`. */
  'ypy:dev:message': YpyDevMessage;
}
// #endregion

// #region TASK-048 layers
/** Handle of a layer (see https://ypy.dev/docs/reference/layers). */
export interface YpyLayer {
  /** The native `<dialog>` of the layer. */
  readonly element: HTMLDialogElement;
  readonly mode: 'modal' | 'drawer' | 'popup';
  /** The element that opened the layer, when there is one. */
  readonly source?: Element;
  /** The options the layer was opened with. */
  readonly options: YpyLayerOptions;
  readonly closed: boolean;
  /** Settles when the layer closes. */
  readonly result: Promise<YpyLayerResult>;
  /** Closes the layer with a value. Returns `false` when a `ypy:layer:before:close` listener cancelled. */
  accept(value?: any): boolean;
  /** Closes the layer with a reason (default `'dismissed'`). Returns `false` when cancelled. */
  dismiss(reason?: string): boolean;
}

export type YpyLayerResult = { accepted: true; value: any } | { accepted: false; reason: string };

export interface YpyLayerOptions {
  mode?: 'modal' | 'drawer' | 'popup';
  /** A URL to fetch into the layer. */
  url?: string;
  /** HTML to put into the layer. */
  html?: string;
  method?: string;
  values?: Record<string, any>;
  select?: string;
  /** Event names (list or array) that accept the layer; the event `detail` is the value. */
  closeOn?: string | string[];
  /** Path patterns (`*` matches any text) that accept the layer when it navigates to one. */
  closeOnUrl?: string | string[];
  /** Selector: a response that holds a match accepts the layer. */
  closeOnFragment?: string;
  /** Clicks outside dismiss the layer. Default `true`. */
  outside?: boolean;
  /** Esc dismisses the layer. Default `true`. */
  escape?: boolean;
  /** Show the layer URL in the address bar while it is open. */
  history?: boolean;
  /** The side a drawer comes from. Default `'end'`. */
  side?: 'start' | 'end' | 'top' | 'bottom';
  /** Accessible name (`aria-label`). */
  label?: string;
  /** Extra classes of the dialog. */
  class?: string;
  /** The element the layer comes from; the focus returns to it. */
  source?: Element;
  event?: Event;
}

/** ypy-layers extension API, available when the extension is loaded. */
export interface YpyLayers {
  /** Opens a layer. A string that starts with `<` is HTML, any other string is a URL. The promise settles when the layer closes; `promise.layer` is the handle. */
  open(spec: string | YpyLayerOptions, options?: YpyLayerOptions): Promise<YpyLayerResult> & { layer?: YpyLayer };
  /** The open layers, bottom first. */
  readonly stack: YpyLayer[];
  top(): YpyLayer | undefined;
  /** Accepts the top layer. */
  accept(value?: any): boolean | undefined;
  /** Dismisses the top layer. */
  dismiss(reason?: string): boolean | undefined;
  /** Dismisses every layer, the top one first. `false` when one refused. */
  closeAll(reason?: string): boolean;
}

export interface YpyConfigLayers {
  /** `false` adds no default stylesheet. Default `true`. */
  style?: boolean;
  /** `false` leaves the page scrolling behind a modal or a drawer. Default `true`. */
  scrollLock?: boolean;
  /** A click outside dismisses a layer. Default `true`. */
  outside?: boolean;
  /** Esc dismisses a layer. Default `true`. */
  escape?: boolean;
  /** Layers show their URL by default. Default `false`. */
  history?: boolean;
  /** Classes per kind, and `opener`, the class a popup puts on its opener (default `ypy-layer-opener`). */
  classes?: { modal?: string; drawer?: string; popup?: string; opener?: string };
}

export interface YpyConfig {
  /** Defaults of the ypy-layers extension. */
  layers?: YpyConfigLayers;
}

export interface Ypy {
  /** ypy-layers extension API, available when the extension is loaded */
  layers?: YpyLayers;
}

export interface YpyNativeEventMap {
  /** Fires on the opener (or the document) before a layer is built. Cancel it to open nothing. */
  'ypy:layer:before:open': { options: YpyLayerOptions; mode: 'modal' | 'drawer' | 'popup' };
  /** Fires on the dialog once its content is in and it is shown. */
  'ypy:layer:opened': { layer: YpyLayer };
  /** Fires on the dialog before it closes. Cancel it to keep the layer open. */
  'ypy:layer:before:close': { layer: YpyLayer; accepted: boolean; value?: any; reason?: string };
  /** Fires on the dialog, still in the page, when the layer is accepted. */
  'ypy:layer:accepted': { layer: YpyLayer; accepted: true; value: any };
  /** Fires on the dialog, still in the page, when the layer is dismissed. */
  'ypy:layer:dismissed': { layer: YpyLayer; accepted: false; reason: string };
}
// #endregion

// #region TASK-049 application navigation (ypy-nav, ypy-progress, ypy-persist, ypy-lazy)

/** Settings of the `ypy-nav` extension (global boost and prefetch), in `ypy.config.nav`. */
export interface YpyNavConfig {
  /** Navigate every link and form of the page with a request and a swap, with no attribute. Off with `config.nonce`. @default false */
  boost?: boolean;
  /** When a link the page navigates is requested ahead of the click: `"hover"` (hover and touch), `"visible"`, both separated by a space, or `false`. `true` means `"hover"`. @default false */
  prefetch?: boolean | 'hover' | 'visible' | 'hover visible' | 'visible hover';
  /** Milliseconds of hover before the prefetch starts. @default 65 */
  prefetchDelay?: number;
  /** Milliseconds an unused prefetched response is kept. @default 10000 */
  prefetchTtl?: number;
  /** Prefetched responses alive at once, in flight or kept; the oldest is dropped. @default 10 */
  prefetchMax?: number;
  /** Prefetches in flight at once for the visibility mode. @default 2 */
  prefetchParallel?: number;
}

/** Settings of the `ypy-progress` extension, in `ypy.config.progress`. */
export interface YpyProgressConfig {
  /** Milliseconds a navigation waits before the bar shows. @default 200 */
  delay?: number;
  /** Show the bar for every request, not only navigations and elements with `ypy-progress`. @default false */
  all?: boolean;
  /** The accessible name of the bar. @default "Loading" */
  label?: string;
}

/** Settings of the `ypy-lazy` extension, in `ypy.config.lazy`. */
export interface YpyLazyConfig {
  /** How far outside the window a region is loaded, as a CSS margin. @default "200px" */
  margin?: string;
}

export interface YpyConfig {
  nav?: YpyNavConfig;
  progress?: YpyProgressConfig;
  lazy?: YpyLazyConfig;
}

export interface YpyNativeEventMap {
  /**
   * `ypy-persist`'s deploy detection: a page response carries other `ypy-track="reload"` values than the
   * page. Cancel it to swap the response instead of loading `url`. `from` and `to` list the tracked elements.
   */
  'ypy:track:reload': { ctx: YpyRequestCtx; url: string; from: string[]; to: string[] };
  /** A region with `ypy-lazy` failed to load. Fired on the region. */
  'ypy:lazy:error': { ctx?: YpyRequestCtx; error?: unknown };
}
// #endregion

// #region TASK-050 cache with revalidation, optimistic UI, field validation

/** `ypy-cache` options; the attribute overrides them per element. */
export interface YpyCacheOptions {
  /** Cache every GET of the page, not only the elements with `ypy-cache`. @default false */
  all: boolean;
  /** A copy older than this is not shown, only revalidated. @default "10m" */
  ttl: number | string;
  /** A copy younger than this is shown without asking the server; the response's `max-age` wins. @default 0 */
  fresh: number | string;
  /** Also keep responses marked `Cache-Control: private`. @default false */
  private: boolean;
  /** Keep copies in `sessionStorage` and show them when the network fails. @default false */
  offline: boolean;
  /** Most copies held; the least recently used goes first. @default 50 */
  size: number;
  /** Most characters of response text held. @default 2097152 */
  bytes: number;
}

export interface YpyConfig {
  /** `ypy-cache` defaults. */
  cache?: Partial<YpyCacheOptions>;
}

/** ypy-cache extension API (see https://ypy.dev/docs/reference/cache). */
export interface YpyCache {
  /** Marks old the copies named by comma separated patterns (`/items*`, `/cart`, `*`, `tag:products`): they are still shown, then revalidated; returns how many. */
  expire(patterns: string): number;
  /** Deletes the copies named by comma separated patterns; returns how many. */
  evict(patterns: string): number;
  /** Deletes every copy. */
  clear(): number;
  /** What the store holds. */
  stats(): { entries: number; chars: number };
}

/** What a function registered for `ypy-optimistic` receives. */
export interface YpyOptimisticCall {
  ctx: YpyRequestCtx;
  /** The element that sends the request. */
  source: Element;
  /** The element the change goes to. */
  target: Element;
  /** The values of the request, the last one wins for a repeated name. */
  values: Record<string, FormDataEntryValue>;
}

/** ypy-optimistic extension API (see https://ypy.dev/docs/reference/optimistic). */
export interface YpyOptimistic {
  /**
   * Makes `fn` usable as `ypy-optimistic="name"`. It returns a node, a list of nodes or an HTML string to show,
   * or a function that undoes a change it made itself.
   */
  register(
    name: string,
    fn: (call: YpyOptimisticCall) => Node | Node[] | NodeList | string | (() => void) | null | undefined
  ): void;
}

export interface Ypy {
  /** ypy-cache extension API, available when the extension is loaded */
  cache?: YpyCache;
  /** ypy-optimistic extension API, available when the extension is loaded */
  optimistic?: YpyOptimistic;
}

export interface YpyNativeEventMap {
  /** A stored copy answers the request. `age` is in ms. */
  'ypy:cache:hit': { ctx: YpyRequestCtx; url: string; age: number; offline: boolean };
  /** The check after a shown copy ended; `changed` is true when new content was swapped in. */
  'ypy:cache:revalidated': { ctx: YpyRequestCtx; url: string; changed: boolean; status: number };
  /** Copies were marked old (still shown, then revalidated). Fired on `document`. */
  'ypy:cache:expire': { patterns: string[]; expired: number };
  /** The optimistic change was made. Cancel it to undo the change at once. */
  'ypy:optimistic:applied': { ctx: YpyRequestCtx; target: Element; nodes: Node[] };
  /** The server accepted the request. */
  'ypy:optimistic:confirmed': { ctx: YpyRequestCtx; target: Element; status: number };
  /** The page was put back. */
  'ypy:optimistic:rolledback': {
    ctx: YpyRequestCtx;
    target: Element;
    reason: 'status' | 'error' | 'aborted' | 'cancelled';
    status?: number;
    kind?: string;
  };
}
// #endregion

// #region TASK-065 upload progress (ypy-upload)
export interface YpyNativeEventMap {
  /**
   * Fires on the source element while a file is sent by a request that asked for progress with
   * `ypy-upload-progress`. `percent` is a whole number from 0 to 100; `total` is 0 (and `percent`
   * stays 0) when the browser does not know the size of the body.
   */
  'ypy:upload:progress': { loaded: number; total: number; percent: number; ctx: YpyRequestCtx };
}
// #endregion

// #region TASK-064 ypy-csrf

export interface YpyNativeEventMap {
  /**
   * An unsafe (not GET or HEAD) request to the page's own origin is leaving without a CSRF token:
   * the `<meta name="ypy-csrf">` tag is missing or empty. `header` is the header the token would
   * have gone in. Call `evt.preventDefault()` to silence the console warning (shown once per URL).
   * The request is still sent. Fires on the source element. Needs the `ypy-csrf` extension.
   */
  'ypy:csrf:missing': { ctx: YpyRequestCtx; header: string };
}
// #endregion

// #region TASK-066 smart polling and keyed lists

/** Options of the `ypy-poll` extension (see https://ypy.dev/docs/reference/poll). */
export interface YpyPollOptions {
  /** Factor applied to the interval while the tab is hidden, or `"pause"` to stop until it is shown. @default 4 */
  hidden: number | 'pause';
  /** Shortest interval a `YPY-Poll-Interval` header may set, in milliseconds or as `"100ms"`. @default 100 */
  min: number | string;
}

export interface YpyConfig {
  /** Default options of the smart polling; the `ypy-poll` attribute overrides them per element. */
  poll?: Partial<YpyPollOptions>;
}

export interface YpyNativeEventMap {
  /** A response with status 286 stopped the polling of the element. */
  'ypy:poll:stop': { ctx: YpyRequestCtx; status: number };
  /** A swap with `limit:<n>` removed the oldest items of a list to keep the limit. */
  'ypy:list:pruned': { removed: Element[]; limit: number; task: YpySwapTask };
}
// #endregion

declare const ypy: Ypy;
export default ypy;

type YpyEventMapAsCustomEvents = { [K in keyof YpyEventMap]: CustomEvent<YpyEventMap[K]> };

declare global {
  interface HTMLElementEventMap extends YpyEventMapAsCustomEvents {}
  interface DocumentEventMap extends YpyEventMapAsCustomEvents {}
  interface WindowEventMap extends YpyEventMapAsCustomEvents {}
  interface Window {
    ypy: Ypy;
  }
}

// #region TASK-067 ypy-retry modes and the ypy-dev overlay
// Added here, apart from the regions above: the interfaces merge with the ones declared earlier.

/** What `ypy-retry` counts as a failure (`retry.on`, or `on:` in the attribute). */
export type YpyRetryOn = 'network' | 'error' | 'always' | 'never';

export interface YpyRetryOptions {
  /**
   * What is repeated. `network`: a request that did not reach the server. `error`: also a response with status 500 or more.
   * `always`: also any response with status 400 or more. `never`: nothing. A 503 or 429 waits at least its `Retry-After`,
   * and is not repeated when that is longer than `max`.
   * @default "network"
   */
  on: YpyRetryOn;
  /** Each wait varies at random by up to this fraction (`0.2`) or percentage (`"20%"`), up and down. `0` keeps the waits exact. @default 0 */
  jitter: number | string;
}

/** The detail of `ypy:request:retry`. `status` is the status of the answer that is repeated; it is absent after a network failure. */
export interface YpyRetryDetail {
  attempt: number;
  delay: number;
  ctx: YpyRequestCtx;
  status?: number;
}

export interface YpyDevOptions {
  /** The error overlay: a panel with the status, the URL, the start of the response and the element. Default: on for a development host only. */
  overlay: boolean;
}

export interface YpyDev {
  /** The error overlay of `ypy-dev`. */
  overlay: { close(): void };
}

/** The `code` of the messages that `ypy-dev` adds: a POST, PUT, PATCH or DELETE that `ypy-sync` aborted in flight or dropped. */
export type YpyDevSyncCode = 'sync-aborted' | 'sync-dropped';
// #endregion

// #region TASK-078 cache expire and evict, nav focus prefetch and current link, validate batch, ypy-switch
export interface YpyNativeEventMap {
  /** Copies were deleted (`YPY-Cache-Evict`, `ypy.cache.evict()`, `ypy.cache.clear()`, or a successful non-GET request). Fired on `document`. */
  'ypy:cache:evict': { patterns: string[]; removed: number };
}
// #endregion
