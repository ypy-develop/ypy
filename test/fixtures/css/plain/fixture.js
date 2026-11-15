// SPDX-License-Identifier: MIT
// Visual matrix fixture: plain CSS, no framework (plain.css is written for the matrix).
// The driver is test/tests/css/matrix.js.
export default {
    name: 'Plain CSS',
    sheets: ['/test/fixtures/css/plain/plain.css'],

    form: {
        html: `<form id="signup" ypy-post="/signup" novalidate class="form">
  <div class="field">
    <label for="email">Email</label>
    <input id="email" name="email" type="email">
  </div>
  <button type="submit" class="button">Create account</button>
</form>`,
        invalid: `
  <div class="field">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" class="invalid" aria-invalid="true" aria-describedby="email-error">
    <p id="email-error" class="message">Enter a valid email address.</p>
  </div>
  <button type="submit" class="button">Create account</button>
`,
    },

    list: {
        html: `<button id="more" ypy-get="/more" ypy-target="#items" ypy-swap="beforeend" class="button">Load more</button>
<ul id="items" class="items">
  <li>One</li>
  <li>Two</li>
</ul>`,
        more: `<li>Three</li><li>Four</li>`,
    },

    modal: {
        selector: '.modal',
        html: `<button id="open-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerHTML" class="button">Delete</button>
<button id="refresh-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerMorph" class="button">Refresh</button>
<div id="modal-root"></div>`,
        fragment: `<div id="modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ypy-preserve-attrs="class">
  <div class="modal-box">
    <h2 id="modal-title">Confirm</h2>
    <p>Delete this item?</p>
    <button class="button">Delete</button>
  </div>
</div>`,
        open: el => el.classList.add('open'),
        isOpen: el => el.classList.contains('open'),
    },

    indicator: {
        html: `<div class="row">
  <button id="go" ypy-get="/slow" ypy-target="#out" ypy-indicator="#spin" class="button">Load</button>
  <span id="spin" class="ypy-indicator spinner"></span>
  <button id="plain" ypy-get="/slow" ypy-target="#out" class="button">No indicator</button>
</div>
<div id="out" class="panel">Idle</div>`,
    },

    error: {
        html: `<div id="panel" class="panel"><p>Ready</p></div>
<button id="boom" ypy-get="/boom" ypy-target="#panel" ypy-swap="innerHTML" class="button">Fail</button>
<div class="offline-banner"><p>You are offline.</p></div>`,
        response: `<p class="message">Something went wrong.</p>`,
        banner: '.offline-banner',
    },
};
