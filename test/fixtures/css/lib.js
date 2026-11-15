// SPDX-License-Identifier: MIT
// Helpers of the styling tests (test/tests/css): load a style sheet from the repository, read layout
// and computed style, and recognise a colour whatever syntax the browser reports it in.

/**
 * Adds the style sheets to the page, in order, and resolves when all are loaded.
 * @param {string[]} hrefs paths on the test server
 * @returns {Promise<() => void>} removes them again
 */
export async function loadSheets(hrefs) {
    const links = [];
    for (const href of hrefs) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        await new Promise((resolve, reject) => {
            link.onload = resolve;
            link.onerror = () => reject(new Error('cannot load ' + href));
            document.head.append(link);
        });
        links.push(link);
    }
    return () => links.forEach(link => link.remove());
}

/** Puts the markup in the playground and lets YPY process it. */
export function mount(html) {
    const pg = playground();
    pg.innerHTML = html;
    ypy.process(pg);
    return pg;
}

export const cs = elt => getComputedStyle(elt);
export const rect = elt => elt.getBoundingClientRect();

/** Drawn on the page: it takes room, is not hidden and is not transparent. */
export function visible(elt) {
    const s = cs(elt), r = rect(elt);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) > 0;
}

/**
 * A CSS colour as [r, g, b, a], read back from a canvas so that oklch(), color-mix() and the like
 * come out the same in every browser.
 */
export function rgb(color) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
}

/** Opaque and clearly red: what every framework uses for a danger border. */
export const isRed = ([r, g, b, a]) => a > 0 && r >= 150 && r - g >= 60 && r - b >= 60;

/** True when the element is in the state by its class (ypy-<state>) or by data-ypy-state. */
export function marked(elt, state) {
    return elt.classList.contains('ypy-' + state) || (elt.dataset.ypyState || '').split(' ').includes(state);
}

const SIGNATURE = ['display', 'marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingLeft', 'fontSize',
    'lineHeight', 'color', 'backgroundColor', 'borderTopWidth', 'borderBottomWidth', 'borderBottomColor',
    'borderTopLeftRadius', 'listStyleType'];

/** The computed style that makes an item look like itself. */
export function signature(elt) {
    const s = cs(elt);
    return Object.fromEntries(SIGNATURE.map(k => [k, s[k]]));
}

/**
 * Resolves when every CSS transition that is running (or waiting for its delay) has ended, so that
 * a computed style is the final one and not a frame of the transition. Animations that never end
 * (a spinner) are not waited for.
 */
export async function transitionsDone() {
    for (let i = 0; i < 5; i++) {
        const running = document.getAnimations().filter(a => a instanceof CSSTransition);
        if (!running.length) return;
        await Promise.all(running.map(a => a.finished.catch(() => {})));
    }
}

/** The layout box of an element, which a transform (a spinner turning) does not change. */
export const box = elt => ({left: elt.offsetLeft, top: elt.offsetTop, width: elt.offsetWidth, height: elt.offsetHeight});
