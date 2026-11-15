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
