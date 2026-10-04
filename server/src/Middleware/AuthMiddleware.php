<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Exception\BusinessException;
use Hyperf\Contract\StdoutLoggerInterface;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

use function Hyperf\Support\env;

/**
 * 鉴权占位中间件 —— 契约 §0.1：`Authorization: Bearer <token>`，缺失或失效返回 code=401。
 *
 * ⚠️ 未接入真实用户/权限服务（契约 deliverable 风险 R7）。当前实现只做
 * 「Bearer token 存在性 + 与 ALARM_STATIC_TOKENS 白名单比对」的占位校验，
 * 接入真实鉴权时应整体替换 isValid()，其余契约行为（401 信封）不变。
 *
 * 当前登录人（creatorName / handlerName）由 ALARM_CURRENT_USER 兜底，
 * 后续接真实鉴权时从 token 解析。
 */
class AuthMiddleware implements MiddlewareInterface
{
    public function __construct(private readonly StdoutLoggerInterface $logger)
    {
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $this->authenticate($request);

        return $handler->handle($request);
    }

    private function authenticate(ServerRequestInterface $request): void
    {
        /** @var RequestInterface $request */
        $authorization = $request->header('authorization', '');
        if ($authorization === '' || ! preg_match('/^Bearer\s+(\S+)$/i', trim($authorization), $m)) {
            throw BusinessException::unauthorized();
        }

        $token = $m[1];
        if (! $this->isValid($token)) {
            throw BusinessException::unauthorized();
        }
    }

    private function isValid(string $token): bool
    {
        // 显式关闭鉴权：仅供本地联调。必须是**主动设置**的开关，
        // 不会因为「忘配白名单」而意外生效。
        if (filter_var(env('ALARM_AUTH_DISABLED', false), FILTER_VALIDATE_BOOLEAN)) {
            $this->logger->warning('ALARM_AUTH_DISABLED=true，鉴权已被显式关闭 —— 生产环境禁止设置该变量');

            return true;
        }

        $allow = trim((string) env('ALARM_STATIC_TOKENS', ''));
        if ($allow === '') {
            // fail-closed：白名单未配置时**拒绝**，而不是放行。
            // 旧实现是 fail-open —— 漏配 ALARM_STATIC_TOKENS ＝ 全部告警接口无鉴权，
            // 且没有任何错误信号。安全默认值必须反过来。
            $this->logger->error(
                'ALARM_STATIC_TOKENS 未配置，已拒绝请求（fail-closed）。'
                . '请配置白名单；仅本地联调可设置 ALARM_AUTH_DISABLED=true 显式跳过鉴权。',
            );

            return false;
        }

        return in_array($token, array_map('trim', explode(',', $allow)), true);
    }
}
