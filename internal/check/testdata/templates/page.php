<?php /* items view */ ?>
<meta name="bolt-config" content='{"defaultSwapStyle": "outerHTML"}'> <!-- expect: V2-CONFIG-DEFAULT-SWAP-STYLE -->
<script src="/static/ext/sse.js"></script> <!-- expect: V2-SCRIPT-EXTENSION -->
<div id="out"></div>
<div acme-target="#out" acme-swap="innerHTML show:#top:top"> <!-- expect: V2-INHERIT-IMPLICIT, V2-SWAP-SHOW-SYNTAX -->
    <?php foreach ($items as $item): ?>
    <button acme-get="/items/<?= $item->id ?>" acme-vars="id:<?= $item->id ?>"><?= htmlspecialchars($item->name) ?></button> <!-- expect: V2-ATTR-VARS -->
    <?php endforeach; ?>
    <?php if ($admin) { echo '<button acme-get="/admin" acme-disabled-elt="this">Go</button>'; } ?> <!-- expect: V2-ATTR-DISABLED-ELT -->
</div>
<form acme-post="<?= $saveUrl ?>" acme-on::configRequest="tweak(event)"> <!-- expect: V2-EVENT-CONFIG-REQUEST -->
    <input name="q" acme-on:bolt:afterSwap="done()"> <!-- expect: V2-EVENT-AFTER-SWAP -->
</form>
<p acme-disable>Raw <b acme-get="/x">text</b></p> <!-- expect: V2-ATTR-DISABLE -->
<div sse-connect="<?= $stream ?>" sse-swap="message"></div> <!-- expect: V2-EXT-SSE-CONNECT, V2-EXT-SSE-SWAP -->
<script>
    document.body.addEventListener('bolt:responseError', fn) // expect: V2-EVENT-RESPONSE-ERROR
    bolt.addClass(el, 'on') // expect: V2-API-ADD-CLASS
</script>
<?php
header('ACME-Trigger-After-Swap: {"done":true}'); // expect: V2-HEADER-TRIGGER-AFTER-SWAP
