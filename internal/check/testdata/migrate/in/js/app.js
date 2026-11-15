// acme-get in a comment, and bolt:afterSwap too
document.addEventListener("bolt:afterSwap", (e) => bolt.process(e.target));
const tpl = `<div acme-get="/x" class="bolt-request">${bolt.config.defaultSwapStyle}</div>`;
const q = document.querySelectorAll('[acme-get],[data-acme-post]');
fetch('/x', { headers: { 'ACME-Request': 'true', 'X-Request-Id': '1' } });
el.dataset.acmeSwap = 'none';
const acmeOn = el.getAttribute('acme-on:click');
const max = 'max-width'; const url = 'https://cdn.example/bolt.org/x.js';
