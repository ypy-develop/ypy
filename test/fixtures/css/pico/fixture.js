// SPDX-License-Identifier: MIT
// Visual matrix fixture: Pico CSS 2, mostly classless. Pico draws a spinner on every
// [aria-busy="true"] element, which is also what YPY puts on the target of a request.
// The driver is test/tests/css/matrix.js.
export default {
    name: 'Pico CSS 2',
    sheets: ['/test/fixtures/css/pico/pico.min.css', '/test/fixtures/css/pico/site.css'],

    form: {
        html: `<form id="signup" ypy-post="/signup" novalidate>
  <label for="email">Email
    <input id="email" name="email" type="email">
  </label>
  <button type="submit">Create account</button>
</form>`,
        invalid: `
  <label for="email">Email
    <input id="email" name="email" type="email" aria-invalid="true" aria-describedby="email-error">
    <small id="email-error">Enter a valid email address.</small>
  </label>
  <button type="submit">Create account</button>
`,
    },

    list: {
        html: `<button id="more" ypy-get="/more" ypy-target="#items" ypy-swap="beforeend" class="outline">Load more</button>
<ul id="items">
  <li>One</li>
  <li>Two</li>
</ul>`,
        more: `<li>Three</li><li>Four</li>`,
    },

    modal: {
        selector: 'dialog',
        html: `<button id="open-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerHTML">Delete</button>
<button id="refresh-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerMorph" class="secondary">Refresh</button>
<div id="modal-root"></div>`,
        fragment: `<dialog id="modal" aria-labelledby="modal-title" ypy-preserve-attrs="open">
  <article>
    <header><h2 id="modal-title">Confirm</h2></header>
    <p>Delete this item?</p>
    <footer><button>Delete</button></footer>
  </article>
</dialog>`,
        open: el => el.showModal(),
        isOpen: el => el.open,
    },

    indicator: {
        html: `<div class="grid">
  <button id="go" ypy-get="/slow" ypy-target="#out" ypy-indicator="#spin">Load</button>
  <span id="spin" class="ypy-indicator" aria-busy="true">Loading</span>
  <button id="plain" ypy-get="/slow" ypy-target="#out" class="secondary">No indicator</button>
</div>
<article id="out">Idle</article>`,
    },

    error: {
        html: `<article id="panel"><p>Ready</p></article>
<button id="boom" ypy-get="/boom" ypy-target="#panel" ypy-swap="innerHTML">Fail</button>
<div class="offline-banner"><article><p>You are offline.</p></article></div>`,
        response: `<p><ins>Something</ins> <del>went wrong.</del></p>`,
        banner: '.offline-banner',
    },
};
