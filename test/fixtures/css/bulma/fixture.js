// SPDX-License-Identifier: MIT
// Visual matrix fixture: Bulma 1. Bulma has no script: the page toggles "is-active" itself.
// The driver is test/tests/css/matrix.js.
export default {
    name: 'Bulma 1',
    sheets: ['/test/fixtures/css/bulma/bulma.min.css', '/test/fixtures/css/bulma/site.css'],

    form: {
        html: `<form id="signup" ypy-post="/signup" novalidate>
  <div class="field">
    <label for="email" class="label">Email</label>
    <div class="control"><input id="email" name="email" type="email" class="input"></div>
  </div>
  <button type="submit" class="button is-link">Create account</button>
</form>`,
        invalid: `
  <div class="field">
    <label for="email" class="label">Email</label>
    <div class="control"><input id="email" name="email" type="email" class="input is-danger" aria-invalid="true" aria-describedby="email-error"></div>
    <p id="email-error" class="help is-danger">Enter a valid email address.</p>
  </div>
  <button type="submit" class="button is-link">Create account</button>
`,
    },

    list: {
        html: `<button id="more" ypy-get="/more" ypy-target="#items" ypy-swap="beforeend" class="button is-link is-outlined mb-2">Load more</button>
<div id="items" class="list has-hoverable-list-items">
  <div class="list-item">One</div>
  <div class="list-item">Two</div>
</div>`,
        more: `<div class="list-item">Three</div><div class="list-item">Four</div>`,
    },

    modal: {
        selector: '.modal',
        html: `<button id="open-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerHTML" class="button is-danger">Delete</button>
<button id="refresh-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerMorph" class="button">Refresh</button>
<div id="modal-root"></div>`,
        fragment: `<div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ypy-preserve-attrs="class">
  <div class="modal-background"></div>
  <div class="modal-card">
    <header class="modal-card-head"><p id="modal-title" class="modal-card-title">Confirm</p></header>
    <section class="modal-card-body">Delete this item?</section>
    <footer class="modal-card-foot"><button class="button is-danger">Delete</button></footer>
  </div>
</div>`,
        open: el => el.classList.add('is-active'),
        isOpen: el => el.classList.contains('is-active'),
    },

    indicator: {
        html: `<div class="is-flex is-align-items-center fx-row">
  <button id="go" ypy-get="/slow" ypy-target="#out" ypy-indicator="#spin" class="button is-link">Load</button>
  <progress id="spin" class="ypy-indicator progress is-small is-link fx-progress" max="100"></progress>
  <button id="plain" ypy-get="/slow" ypy-target="#out" class="button">No indicator</button>
</div>
<div id="out" class="box mt-3">Idle</div>`,
    },

    error: {
        html: `<div id="panel" class="box"><p>Ready</p></div>
<button id="boom" ypy-get="/boom" ypy-target="#panel" ypy-swap="innerHTML" class="button is-link mt-3">Fail</button>
<div class="offline-banner mt-3"><div class="notification is-warning">You are offline.</div></div>`,
        response: `<div class="notification is-danger">Something went wrong.</div>`,
        banner: '.offline-banner',
    },
};
