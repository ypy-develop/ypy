// SPDX-License-Identifier: MIT
// Visual matrix fixture: Tailwind CSS v4 with the YPY variants (src/css/ypy-tailwind.css).
// tailwind.css is generated from this file (see ../README.md): every class below is a class the
// page uses, and the build keeps only those. The driver is test/tests/css/matrix.js.
export default {
    name: 'Tailwind CSS v4',
    sheets: ['/test/fixtures/css/tailwind/tailwind.css'],

    form: {
        html: `<form id="signup" ypy-post="/signup" class="max-w-sm space-y-4">
  <div>
    <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
    <input id="email" name="email" type="email" class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 aria-invalid:border-red-500">
  </div>
  <button type="submit" class="rounded-md bg-sky-600 px-4 py-2 text-white hover:bg-sky-700 ypy-request:opacity-50">Create account</button>
</form>`,
        invalid: `
  <div>
    <label for="email" class="block text-sm font-medium text-gray-700">Email</label>
    <input id="email" name="email" type="email" aria-invalid="true" aria-describedby="email-error" class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 aria-invalid:border-red-500">
    <p id="email-error" class="mt-1 text-sm text-red-600">Enter a valid email address.</p>
  </div>
  <button type="submit" class="rounded-md bg-sky-600 px-4 py-2 text-white hover:bg-sky-700 ypy-request:opacity-50">Create account</button>
`,
    },

    list: {
        html: `<button id="more" ypy-get="/more" ypy-target="#items" ypy-swap="beforeend" class="mb-2 rounded-md bg-sky-600 px-3 py-1.5 text-white">Load more</button>
<ul id="items" class="divide-y divide-gray-200 rounded-md border border-gray-200">
  <li class="px-4 py-2 text-gray-800">One</li>
  <li class="px-4 py-2 text-gray-800">Two</li>
</ul>`,
        more: `<li class="px-4 py-2 text-gray-800">Three</li><li class="px-4 py-2 text-gray-800">Four</li>`,
    },

    modal: {
        selector: '#modal',
        html: `<button id="open-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerHTML" class="rounded-md bg-sky-600 px-3 py-1.5 text-white">Delete</button>
<button id="refresh-modal" ypy-get="/modal" ypy-target="#modal-root" ypy-swap="innerMorph" class="rounded-md border px-3 py-1.5">Refresh</button>
<div id="modal-root"></div>`,
        fragment: `<div id="modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-labelledby="modal-title" ypy-preserve-attrs="class,style,aria-*,role">
  <div class="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
    <h2 id="modal-title" class="text-lg font-semibold">Confirm</h2>
    <p class="mt-2 text-gray-600">Delete this item?</p>
    <button class="mt-4 rounded-md bg-red-600 px-3 py-1.5 text-white">Delete</button>
  </div>
</div>`,
        // What the page script does to open the modal: it toggles classes, the server knows nothing of it.
        open(el) {
            el.classList.remove('hidden');
            el.classList.add('flex');
        },
        isOpen: el => el.classList.contains('flex') && !el.classList.contains('hidden'),
    },

    indicator: {
        html: `<div class="space-x-2">
  <button id="go" ypy-get="/slow" ypy-target="#out" ypy-indicator="#spin" class="rounded-md bg-sky-600 px-3 py-1.5 text-white ypy-request:opacity-50">Load</button>
  <span id="spin" class="inline-block size-4 animate-spin rounded-full border-2 border-sky-600 border-t-transparent align-middle opacity-0 transition-opacity duration-200 ypy-request:opacity-100"></span>
  <button id="plain" ypy-get="/slow" ypy-target="#out" class="rounded-md border px-3 py-1.5 ypy-request:opacity-50">No indicator</button>
</div>
<div id="out" class="mt-3 rounded border p-3 ypy-busy:opacity-60">Idle</div>`,
        // the spinner hides with opacity only, there is no .ypy-indicator class on it
        visibility: false,
    },

    error: {
        html: `<div id="panel" class="rounded border-2 border-gray-300 p-4 ypy-error:border-red-500"><p>Ready</p></div>
<button id="boom" ypy-get="/boom" ypy-target="#panel" ypy-swap="innerHTML" class="mt-3 rounded-md bg-sky-600 px-3 py-1.5 text-white">Fail</button>
<div id="offline-banner" class="mt-3 hidden rounded border border-amber-400 bg-amber-100 p-3 ypy-offline:block">You are offline.</div>`,
        response: `<p class="font-medium text-red-700">Something went wrong.</p>`,
        banner: '#offline-banner',
    },

    // One element per variant. Each shows an underline when its state is on, so a test asks the
    // same question of all of them.
    variants: {
        request: '<span id="v" class="ypy-request:underline">x</span>',
        swapping: '<span id="v" class="ypy-swapping:underline">x</span>',
        settling: '<span id="v" class="ypy-settling:underline">x</span>',
        added: '<span id="v" class="ypy-added:underline">x</span>',
        error: '<span id="v" class="ypy-error:underline">x</span>',
        dirty: '<span id="v" class="ypy-dirty:underline">x</span>',
        busy: '<span id="v" class="ypy-busy:underline">x</span>',
        offline: '<span id="v" class="ypy-offline:underline">x</span>',
        group: '<div id="g" class="group"><span id="v" class="group-ypy-request:underline">x</span></div>',
        inside: '<div id="g"><span id="v" class="in-ypy-error:underline">x</span></div>',
        not: '<span id="v" class="not-ypy-error:underline">x</span>',
        responsive: '<span id="v" class="sm:ypy-request:underline">x</span>',
    },
};
