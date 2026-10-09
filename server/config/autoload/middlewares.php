<?php

declare(strict_types=1);

use App\Middleware\AuthMiddleware;
use App\Middleware\CorsMiddleware;

return [
    'http' => [
        // 契约 0.1：缺失/失效 token 返回 code=401。未接真实鉴权时由 AuthMiddleware 做占位校验。
        // ⚠️ CorsMiddleware **必须**排在 AuthMiddleware 之前。
        //
        // 浏览器发起的预检请求只带 Access-Control-Request-*，**不带 Authorization**。
        // CORS 放在鉴权后面的话，预检会被 AuthMiddleware 判成 401，
        // 浏览器随即拦掉真实请求 —— 表现为「所有告警接口全部失败」，
        // 而 curl / jsdom / 单测全都测不出来（它们不执行同源策略）。
        // 2026-10-09 真实浏览器验证时才发现。
        CorsMiddleware::class,
        AuthMiddleware::class,
    ],
];
