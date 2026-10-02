<?php

declare(strict_types=1);

return [
    // 统一响应封装：所有 Controller 依赖注入 Psr\Http\Message\ResponseInterface
    // （由 hyperf/http-server 的 ConfigProvider 绑定到 Hyperf\HttpServer\Response）
    // 业务异常由 App\Exception\Handler\AlarmExceptionHandler 统一翻译成契约信封
];
