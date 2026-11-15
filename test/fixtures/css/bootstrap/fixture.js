// SPDX-License-Identifier: MIT
// Visual matrix fixture: Bootstrap 5. The page script (here the fixture) opens the modal the way
// Bootstrap's own script does, with an inline display and the "show" class. The driver is
// test/tests/css/matrix.js.
export default {
    name: 'Bootstrap 5',
    sheets: ['/test/fixtures/css/bootstrap/bootstrap.min.css', '/test/fixtures/css/bootstrap/site.css'],

    form: {
        html: `<form id="signup" ypy-post="/signup" novalidate>
  <div class="mb-3">
    <label for="email" class="form-label">Email</label>
    <input id="email" name="email" type="email" class="form-control">
  </div>
  <button type="submit" class="btn btn-primary">Create account</button>
</form>`,
        invalid: `
  <div class="mb-3">
    <label for="email" class="form-label">Email</label>
    <input id="email" name="email" type="email" class="form-control is-invalid" aria-invalid="true" aria-describedby="email-error">
    <div id="email-error" class="invalid-feedback">Enter a valid email address.</div>
  </div>
  <button type="submit" class="btn btn-primary">Create account</button>
`,
    },

    list: {
        html: `<button id="more" ypy-get="/more" ypy-target="#items" ypy-swap="beforeend" class="btn btn-outline-primary mb-2">Load more</button>
<ul id="items" class="list-group">
  <li class="list-group-item">One</li>
  <li class="list-group-item">Two</li>
</ul>`,
        more: `<li class="list-group-item">Three</li><li class="list-group-item">Four</li>`,
    },

    modal: {
        selector: '.modal',
        html: `<button id="open-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerHTML" class="btn btn-danger">Delete</button>
<button id="refresh-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerMorph" class="btn btn-outline-secondary">Refresh</button>
<div id="modal-root"></div>`,
        fragment: `<div id="modal" class="modal fade" tabindex="-1" aria-labelledby="modal-title" aria-hidden="true" ypy-preserve-attrs="class,style,aria-*,role">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h2 id="modal-title" class="modal-title fs-5">Confirm</h2></div>
      <div class="modal-body">Delete this item?</div>
      <div class="modal-footer"><button type="button" class="btn btn-danger">Delete</button></div>
    </div>
  </div>
</div>`,
        open(el) {
            el.style.display = 'block';
            el.removeAttribute('aria-hidden');
            el.setAttribute('aria-modal', 'true');
            el.setAttribute('role', 'dialog');
            el.offsetWidth;   // reflow, so the fade starts from the closed state
            el.classList.add('show');
        },
        isOpen: el => el.classList.contains('show') && el.style.display === 'block',
    },

    indicator: {
        html: `<div class="d-flex align-items-center gap-2">
  <button id="go" ypy-get="/slow" ypy-target="#out" ypy-indicator="#spin" class="btn btn-primary">Load</button>
  <span id="spin" class="ypy-indicator spinner-border spinner-border-sm" role="status"><span class="visually-hidden">Loading</span></span>
  <button id="plain" ypy-get="/slow" ypy-target="#out" class="btn btn-secondary">No indicator</button>
</div>
<div id="out" class="border rounded p-3 mt-3">Idle</div>`,
    },

    error: {
        html: `<div id="panel" class="border rounded p-3"><p class="mb-0">Ready</p></div>
<button id="boom" ypy-get="/boom" ypy-target="#panel" ypy-swap="innerHTML" class="btn btn-primary mt-3">Fail</button>
<div class="offline-banner mt-3"><div class="alert alert-warning mb-0" role="status">You are offline.</div></div>`,
        response: `<div class="alert alert-danger mb-0" role="alert">Something went wrong.</div>`,
        banner: '.offline-banner',
    },
};
