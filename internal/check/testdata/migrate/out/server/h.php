<?php
if (($_SERVER['HTTP_YPY_REQUEST'] ?? '') === 'true') {
    header('YPY-Redirect: /login');
    header('Vary: YPY-Request');
}
