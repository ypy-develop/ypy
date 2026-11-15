// acme-get in a comment, and bolt:afterSwap too
document.addEventListener("ypy:after:swap", (e) => ypy.process(e.target));
const tpl = `<div ypy-get="/x" class="ypy-request">${ypy.config.defaultSwapStyle}</div>`;
const q = document.querySelectorAll('[ypy-get],[data-ypy-post]');
fetch('/x', { headers: { 'YPY-Request': 'true', 'X-Request-Id': '1' } });
el.dataset.ypySwap = 'none';
const ypyOn = el.getAttribute('ypy-on:click');
const max = 'max-width'; const url = 'https://cdn.example/bolt.org/x.js';
