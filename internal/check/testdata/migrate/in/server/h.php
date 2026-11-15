<?php
if (($_SERVER['HTTP_ACME_REQUEST'] ?? '') === 'true') {
    header('ACME-Redirect: /login');
    header('Vary: ACME-Request');
}
