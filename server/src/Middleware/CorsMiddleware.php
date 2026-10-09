<?php

declare(strict_types=1);

namespace App\Middleware;

use Hyperf\HttpMessage\Base\Response;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * CORS 中间件。
 *
 * ## 为什么必须有（这不是「锦上添花」）
 *
 * 2026-10-09 用真实 Chromium 验证时才发现：前端 `http://host:4173` 调后端
 * `http://host:9501` 时，**所有告警接口全部失败** —— 浏览器先发 OPTIONS 预检，
 * 而 `AuthMiddleware` 对 OPTIONS 也要求 Bearer token，直接返回 401，
 * 浏览器于是拦掉真正的请求。
 *
 * 这个 bug 躲过了此前**全部**验证：
 *   - 285 个 PHPUnit：中间件没进单测
 *   - 107 条 HTTP E2E：用 curl，curl **不执行同源策略**
 *   - 35 条前后端联调：同上
 *   - 461 个前端测试：jsdom **不执行同源策略**
 *   - vue-tsc / lint：完全无关
 *
 * 也就是说，只要前后端不同源（这是**正常部署方式**——前端挂 CDN、
 * 后端有独立 API 域名），整个告警系统是全灭的，而所有仪表盘都是绿的。
 * **只有真实浏览器能发现这一类问题。**
 *
 * ## 为什么排在 AuthMiddleware 之前
 *
 * 预检请求**不带** `Authorization` 头（浏览器的预检只发
 * `Access-Control-Request-*`）。所以 CORS 必须先于鉴权处理，
 * 否则预检 401 → 真实请求被浏览器拦掉。
 *
 * ## 安全性：为什么默认 `*` 在这里是可接受的
 *
 * 常见顾虑是 `Access-Control-Allow-Origin: *` 会导致任意站点能读接口数据。
 * 在本项目里这个顾虑**不成立**，前提是两条，都已满足：
 *   1. 鉴权走 `Authorization: Bearer <token>`，**不是 Cookie**。
 *      浏览器不会自动带上 token，恶意站点拿不到 token 就读不到响应。
 *   2. 本中间件**不**发送 `Access-Control-Allow-Credentials`。
 *      规范规定 `*` 与 credentials 不能共存，浏览器会直接拒绝，
 *      这是规范帮我们兜的底。
 *
 * 但生产环境**仍建议**用 `ALARM_CORS_ORIGINS` 显式列出允许的来源：
 * 一是收敛攻击面，二是 `*` 会让 `Vary` 缓存行为变差。
 */
class CorsMiddleware implements MiddlewareInterface
{
    /** 允许前端跨域调用的方法。PUT/DELETE 必须列出，否则浏览器会拦。 */
    private const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

    /**
     * 允许的来源。
     *
     * `ALARM_CORS_ORIGINS` 逗号分隔；未配置时放开全部。
     * 放开时回显**请求的 Origin** 而不是发 `*` —— 因为带 `Vary: Origin`
     * 时发 `*` 会让 CDN 把某个来源的响应缓存给别的来源，属于安全问题。
     * 回显 + 正确 Vary 才是与 `*` 等价且安全的做法。
     */
    private function allowedOrigins(): ?array
    {
        $raw = \Hyperf\Support\env('ALARM_CORS_ORIGINS', '');
        if (! is_string($raw) || trim($raw) === '') {
            return null;
        }
        $list = array_filter(array_map('trim', explode(',', $raw)));
        return $list === [] ? null : $list;
    }

    /**
     * 浏览器预检里实际请求的头；缺省回落到本项目需要的两个。
     *
     * 回显浏览器给的值而不是写死，好处是将来加了自定义头也不用改这里。
     */
    private function requestedHeaders(ServerRequestInterface $request): string
    {
        $requested = $request->getHeaderLine('Access-Control-Request-Headers');
        // getHeaderLine 缺省返回 '' 而不是 null，所以这里显式判空串
        if (trim($requested) !== '') {
            return $requested;
        }

        return 'Authorization, Content-Type';
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $origin = $request->getHeaderLine('Origin');

        if ($origin === '') {
            // 同源请求 / 服务端调用 / curl —— 不需要 CORS 头，直接放行
            return $handler->handle($request);
        }

        $allowed = $this->allowedOrigins();
        $isAllowed = $allowed === null || in_array($origin, $allowed, true);

        if (! $isAllowed) {
            // ⚠️ 明确拒绝时**不能**附带任何 Access-Control-* 头。
            //    带了反而会让浏览器把响应当成功，掩盖掉拒绝的事实。
            return $handler->handle($request);
        }

        // 预检：直接 204，不进业务链路
        if (strtoupper($request->getMethod()) === 'OPTIONS') {
            // 直接构造，不走 DI。
            //
            // ⚠️ 这里试过两条更「规范」的路，都失败了，且都只在真实 HTTP 才暴露：
            //    1. `new \Hyperf\Psr7\Response()` → `Class not found`（该类不存在）
            //    2. 构造注入 `ResponseFactoryInterface` → 容器报 `not instantiable`，
            //       显式在 config/autoload/dependencies.php 里绑定也不生效
            //       （本项目的 DI 装配不读这个键）
            // 已实测 `Hyperf\HttpMessage\Base\Response` 可直接 new + withStatus。
            // 预检只需要 204 这一种响应，为此引入一整套工厂抽象不划算。
            $response = (new Response())->withStatus(204)
                ->withHeader('Access-Control-Allow-Origin', $origin)
                ->withHeader('Access-Control-Allow-Methods', self::ALLOWED_METHODS)
                // ⚠️ 这里用 `?:`（判 falsy）而不是 `??`（判 null）。
                //    区别很实际：`getHeaderLine()` 请求头**不存在时返回空字符串**，
                //    不是 null。两者在缺省时都落到默认值，所以行为一致 ——
                //    但只要哪天默认值改成空字符串或 '0'，`?:` 就会把 '0' 当成缺省，
                //    静默发错的头。这里统一用 `??` 并把原因写下来。
                ->withHeader('Access-Control-Allow-Headers', $this->requestedHeaders($request))
                ->withHeader('Access-Control-Max-Age', '600');
            return $response;
        }

        $response = $handler->handle($request);

        return $response
            ->withHeader('Access-Control-Allow-Origin', $origin)
            // ⚠️ Vary 必须有：否则 CDN 会把 A 站点的响应头缓存给 B 站点
            ->withHeader('Vary', 'Origin')
            ->withHeader('Access-Control-Expose-Headers', 'Content-Type');
    }

}
