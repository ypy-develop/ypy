<div ypy-get="<?= $url ?>" ypy-target="#out"></div>
<?php if (($_SERVER['HTTP_YPY_REQUEST'] ?? '') === 'true') { header('YPY-Trigger: saved'); } ?>
