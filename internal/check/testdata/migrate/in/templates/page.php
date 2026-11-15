<div acme-get="<?= $url ?>" acme-target="#out"></div>
<?php if (($_SERVER['HTTP_ACME_REQUEST'] ?? '') === 'true') { header('ACME-Trigger: saved'); } ?>
