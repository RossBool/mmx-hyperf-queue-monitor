<?php

declare(strict_types=1);

use App\Middleware\AuthMiddleware;

return [
    'http' => [
        // 契约 0.1：缺失/失效 token 返回 code=401。未接真实鉴权时由 AuthMiddleware 做占位校验。
        AuthMiddleware::class,
    ],
];
