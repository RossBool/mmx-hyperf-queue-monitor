<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Exception\BusinessException;
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
        $allow = (string) env('ALARM_STATIC_TOKENS', '');
        if ($allow === '') {
            // 未配置白名单时不做拒绝（本地联调），生产必须配置 ALARM_STATIC_TOKENS
            return true;
        }
        return in_array($token, array_map('trim', explode(',', $allow)), true);
    }
}
