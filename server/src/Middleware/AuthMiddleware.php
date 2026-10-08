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
        // ⚠️ 本中间件是**全局**中间件（config/autoload/middlewares.php 的 'http' 段），
        //    它会拦下**每一个**请求，包括 `/favicon.ico` 这种浏览器自动发起的静态资源请求。
        //    浏览器不会给 favicon 带 Authorization 头 → 401 → 控制台红字 + 日志噪声。
        //
        //    契约把 401 的适用范围定义为「/api/alarm 下的业务端点」，
        //    favicon 不属于业务端点，不该走鉴权。
        //    这里用路径前缀判定而不是白名单具体路由：新增业务端点时自动被覆盖，
        //    不会因为忘了加进白名单而漏鉴权。
        if (! str_starts_with($request->getUri()->getPath(), '/api/')) {
            return $handler->handle($request);
        }

        $this->authenticate($request);

        return $handler->handle($request);
    }

    private function authenticate(ServerRequestInterface $request): void
    {
        /**
         * ⚠️ 必须用 PSR-7 的 `getHeaderLine()`，**不能**用 `header()`。
         *
         *    `header()` 是 Laravel / Symfony 风格的便捷方法，**PSR-7 接口里没有**，
         *    Hyperf 3.2 的 `Hyperf\HttpMessage\Server\Request` 也不提供它。
         *    调用结果是 `Call to undefined method ...Request::header()` →
         *    **每一个请求都 500**，19 个端点全部不可用。
         *
         *    为什么单测没抓到：`AuthMiddlewareTest` 用的是手写桩对象，
         *    桩上恰好定义了 `header()`，于是「通过了」。
         *    桩比真实实现更宽松 = 测试在验证一个不存在的 API。
         *    这条只有真起服务才会暴露 —— 已加 HTTP 端到端测试防回归。
         *
         *    `getHeaderLine()` 的大小写不敏感（PSR-7 规定 header 名不区分大小写），
         *    多值头会拼成逗号分隔，正好符合下面正则的预期。
         */
        $authorization = $request->getHeaderLine('authorization');
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
