<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Middleware\CorsMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

/**
 * CORS 中间件。
 *
 * ## 为什么这组测试必须有
 *
 * CORS 是 2026-10-09 真实浏览器验证才发现的缺失项。在那之前，
 * 285 个单测 + 107 条 curl E2E + 35 条联调 + 461 个 jsdom 前端测试
 * **全绿**，而前后端一不同源就全线失败 ——
 * 因为 curl 和 jsdom 都不执行同源策略。
 *
 * 所以这类问题天然无法靠既有测试发现，只能靠真浏览器。
 * 有了真浏览器之后，**必须**把它的行为钉死，否则下次重构又会悄悄弄坏。
 */
final class CorsMiddlewareTest extends TestCase
{
    private function request(string $method, array $headers = []): ServerRequestInterface
    {
        // ⚠️ 造请求的两个坑（都实测踩过）：
        //    1. `Hyperf\Psr7\Request` 不存在（`Class not found`）
        //    2. `Hyperf\HttpMessage\Base\Request` 存在但**没有静态 create()**
        // 可用写法：`new Hyperf\HttpMessage\Server\Request($method, $uri)`
        $r = new \Hyperf\HttpMessage\Server\Request($method, '/api/alarm/policies');
        foreach ($headers as $k => $v) {
            $r = $r->withHeader($k, $v);
        }

        return $r;
    }

    /** 假的 handler：只回一个带标记的响应，用来断言「中间件确实放行到下游了」。 */
    private function handler(?ResponseInterface $inner = null, ?bool &$reached = null)
    {
        return new class($inner, $reached) implements \Psr\Http\Server\RequestHandlerInterface {
            public function __construct(private ?ResponseInterface $inner, private ?bool &$reached)
            {
            }

            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->reached = true;
                // 同样没有静态 create()，只能 new
                return $this->inner ?? new \Hyperf\HttpMessage\Base\Response();
            }
        };
    }

    // ── 预检 ────────────────────────────────────────────────────────

    public function testPreflightReturns204WithAllowHeaders(): void
    {
        $m = new CorsMiddleware();
        $reached = false;
        $req = $this->request('OPTIONS', [
            'Origin' => 'http://example.com',
            'Access-Control-Request-Method' => 'PUT',
            'Access-Control-Request-Headers' => 'authorization,content-type',
        ]);

        $res = $m->process($req, $this->handler(null, $reached));

        $this->assertSame(204, $res->getStatusCode());
        $this->assertSame('http://example.com', $res->getHeaderLine('Access-Control-Allow-Origin'));
        // ⚠️ PUT / DELETE 必须在白名单里，否则浏览器的编辑/删除操作全被拦
        $methods = $res->getHeaderLine('Access-Control-Allow-Methods');
        foreach (['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] as $m2) {
            $this->assertStringContainsString($m2, $methods, "缺少 {$m2}");
        }
        $this->assertSame('authorization,content-type', $res->getHeaderLine('Access-Control-Allow-Headers'));
        $this->assertFalse($reached, '预检**不能**进业务链路 —— 它只是浏览器问「能不能跨域」');
    }

    /**
     * 预检绝不能被鉴权拦掉。
     *
     * 这是原始 bug 的形态：AuthMiddleware 排在前面 → 预检 401 →
     * 浏览器随即拦掉真实请求 → 所有告警接口全灭。
     * 这里断言预检**不经过**任何 handler，等价于「它绕过了鉴权」。
     */
    public function testPreflightBypassesDownstreamCompletely(): void
    {
        $m = new CorsMiddleware();
        $reached = false;
        $res = $m->process(
            $this->request('OPTIONS', ['Origin' => 'http://example.com']),
            $this->handler(null, $reached)
        );
        $this->assertFalse($reached);
        $this->assertSame(204, $res->getStatusCode());
    }

    // ── 实际请求 ────────────────────────────────────────────────────

    public function testActualRequestGetsAllowOriginAndVary(): void
    {
        $m = new CorsMiddleware();
        $reached = false;
        $req = $this->request('GET', ['Origin' => 'http://example.com']);

        $res = $m->process($req, $this->handler(null, $reached));

        $this->assertTrue($reached, '实际请求必须走到下游');
        $this->assertSame('http://example.com', $res->getHeaderLine('Access-Control-Allow-Origin'));
        // ⚠️ Vary 缺了会让 CDN 把 A 站点的响应头缓存给 B 站点
        $this->assertStringContainsString('Origin', $res->getHeaderLine('Vary'));
    }

    /**
     * 不带 Origin 的请求（curl / 服务端调用）**不应**带 CORS 头。
     *
     * 带上会让「本来是同源」的调用看起来像跨域，掩盖配置错误；
     * 而且无谓地多几个响应头。
     */
    public function testRequestWithoutOriginGetsNoCorsHeaders(): void
    {
        $m = new CorsMiddleware();
        $reached = false;
        $res = $m->process($this->request('GET'), $this->handler(null, $reached));

        $this->assertTrue($reached);
        $this->assertSame('', $res->getHeaderLine('Access-Control-Allow-Origin'));
    }

    // ── 白名单 ──────────────────────────────────────────────────────

    /**
     * 默认（未配 `ALARM_CORS_ORIGINS`）= 允许全部来源。
     *
     * ⚠️ 这**不是**「忘了实现拒绝逻辑」，是刻意的开发期默认：
     * 鉴权走 Bearer token 而非 Cookie，恶意站点拿不到 token 就读不到响应，
     * 详见 CorsMiddleware 类注释的安全性小节。生产必须显式配置。
     */
    public function testDefaultAllowsAllOrigins(): void
    {
        putenv('ALARM_CORS_ORIGINS');
        unset($_ENV['ALARM_CORS_ORIGINS'], $_SERVER['ALARM_CORS_ORIGINS']);

        $m = new CorsMiddleware();
        $reached = false;
        $res = $m->process(
            $this->request('GET', ['Origin' => 'http://any.example']),
            $this->handler(null, $reached)
        );

        $this->assertTrue($reached);
        $this->assertSame('http://any.example', $res->getHeaderLine('Access-Control-Allow-Origin'));
    }

    /**
     * 配了白名单后，非白名单来源**不**得拿到 Allow-Origin 头。
     *
     * ⚠️ 拒绝时绝不能附带任何 `Access-Control-Allow-Origin` ——
     *    带了浏览器会当成功，掩盖掉「其实被拒了」这个事实，
     *    排查时会一直盯着网络面板看半天。
     */
    public function testWhitelistRejectsForeignOrigin(): void
    {
        putenv('ALARM_CORS_ORIGINS=https://a.example,https://b.example');
        $_ENV['ALARM_CORS_ORIGINS'] = 'https://a.example,https://b.example';
        $_SERVER['ALARM_CORS_ORIGINS'] = 'https://a.example,https://b.example';

        try {
            $m = new CorsMiddleware();
            $reached = false;
            $res = $m->process(
                $this->request('GET', ['Origin' => 'https://evil.example']),
                $this->handler(null, $reached)
            );

            $this->assertTrue($reached, 'CORS 不负责拒绝，只是不给放行头；真正的拒绝交给调用方');
            $this->assertSame('', $res->getHeaderLine('Access-Control-Allow-Origin'));
        } finally {
            putenv('ALARM_CORS_ORIGINS');
            unset($_ENV['ALARM_CORS_ORIGINS'], $_SERVER['ALARM_CORS_ORIGINS']);
        }
    }

    /** 白名单内的来源要正常放行，且**只回显自己的** Origin（不能回显 `*`，见 Vary 注释）。 */
    public function testWhitelistAllowsListedOriginAndEchoesIt(): void
    {
        putenv('ALARM_CORS_ORIGINS=https://a.example');
        $_ENV['ALARM_CORS_ORIGINS'] = 'https://a.example';

        try {
            $m = new CorsMiddleware();
            $reached = false;
            $res = $m->process(
                $this->request('GET', ['Origin' => 'https://a.example']),
                $this->handler(null, $reached)
            );
            $this->assertSame('https://a.example', $res->getHeaderLine('Access-Control-Allow-Origin'));
            $this->assertStringContainsString('Origin', $res->getHeaderLine('Vary'));
        } finally {
            putenv('ALARM_CORS_ORIGINS');
            unset($_ENV['ALARM_CORS_ORIGINS'], $_SERVER['ALARM_CORS_ORIGINS']);
        }
    }
}
