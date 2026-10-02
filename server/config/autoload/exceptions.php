<?php

declare(strict_types=1);

use App\Exception\Handler\AlarmExceptionHandler;
use Hyperf\HttpServer\Exception\Handler\HttpExceptionHandler;

return [
    'handler' => [
        'http' => [
            HttpExceptionHandler::class,
            AlarmExceptionHandler::class,
        ],
    ],
];
