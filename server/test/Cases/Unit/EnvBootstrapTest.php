<?php

declare(strict_types=1);
/**
 * **配置加载链路**的回归测试 —— 阻塞级缺陷的守卫。
 *
 * ## 缺陷是什么
 *
 * `Hyperf\Support\env()` 读的是 `$_ENV` / `$_SERVER`，**它自己不解析 .env**。
 * 把 .env 灌进这两个超全局变量的是 `Dotenv\Dotenv`，而调用点唯一。
 *
 * 本仓库一度：composer.json 没 require `hyperf/dotenv`、`config/bootstrap.php` 不存在、
 * 全仓 0 处 Dotenv 调用 —— 于是 `env()` 只能拿到**默认值**。
 *
 * 配合 `AuthMiddleware` 的 fail-closed 语义，后果是：
 *
 *   env('ALARM_STATIC_TOKENS', '')    恒为 ''    → 白名单恒空
 *   env('ALARM_AUTH_DISABLED', false) 恒为 false → 逃生舱同样读不到
 *   → 全部 19 个端点**永久 401**，且没有任何配置能绕过
 *
 * 也就是说：原来的 fail-open 是「不安全但能用」，配上坏掉的 env() 之后就变成
 * 「策略正确但服务直接死」。**这是静态分析发现的**（沙箱无 PHP，跑不起来），
 * 所以这里用**源码级断言**把它钉死 —— 不需要 PHP 运行，也不需要 .env 存在。
 */
namespace Tests\Cases\Unit;

use PHPUnit\Framework\TestCase;

final class EnvBootstrapTest extends TestCase
{
    private const ROOT = __DIR__ . '/../../../';

    private function read(string $relative): string
    {
        $path = self::ROOT . '/' . $relative;
        self::assertFileExists($path);

        return (string) file_get_contents($path);
    }

    /**
     * 缺依赖 → env() 没有数据源。这是最底层的一条，其余都是它的推论。
     */
    public function testDotenvPackageIsRequired(): void
    {
        $composer = json_decode($this->read('composer.json'), true, 512, JSON_THROW_ON_ERROR);

        self::assertArrayHasKey(
            'require',
            $composer,
            'composer.json 解析失败或缺 require 段。'
        );
        self::assertArrayHasKey(
            'hyperf/dotenv',
            $composer['require'],
            'composer.json 必须 require hyperf/dotenv —— 否则没有任何东西能把 .env '
                . '读进 $_ENV/$_SERVER，env() 恒返回默认值。'
        );
    }

    public function testBootstrapFileExistsAndLoadsDotenv(): void
    {
        $src = $this->read('config/bootstrap.php');

        self::assertStringContainsString(
            'Dotenv',
            $src,
            'config/bootstrap.php 必须调用 Dotenv —— 它是全仓唯一把 .env 灌进 '
                . '$_ENV/$_SERVER 的地方。'
        );
        self::assertStringContainsString(
            'BASE_PATH',
            $src,
            'config/bootstrap.php 必须以 BASE_PATH 为根定位 .env。'
        );
    }

    public function testTestBootstrapAlsoLoadsEnv(): void
    {
        $src = $this->read('test/bootstrap.php');

        self::assertStringContainsString(
            'config/bootstrap.php',
            $src,
            'test/bootstrap.php 必须 require config/bootstrap.php —— 否则测试读不到 DB_*，'
                . '而 AuthMiddleware 的鉴权用例会全走 fail-closed 分支，测的就不是原本的意图了。'
        );
    }

    /**
     * 防止有人用「静态硬编码」绕过 env()：代码里不应出现对 .env 的手工解析。
     */
    public function testNoManualEnvParsingAnywhere(): void
    {
        $src = $this->read('config/bootstrap.php');

        self::assertDoesNotMatchRegularExpression(
            '/file_get_contents\s*\(\s*[^)]*\.env/',
            $src,
            '不要手工解析 .env —— 统一走 Dotenv，否则 $_ENV 与 Dotenv 的加载顺序会打架。'
        );
    }

    /**
     * `ALARM_AUTH_DISABLED` 是 fail-closed 的唯一逃生舱。
     * 它必须真的读得到，否则配置错误时连自救手段都没有。
     */
    public function testEscapeHatchIsReadThroughEnv(): void
    {
        $src = $this->read('src/Middleware/AuthMiddleware.php');

        self::assertStringContainsString(
            "env('ALARM_AUTH_DISABLED'",
            $src,
            'ALARM_AUTH_DISABLED 必须经 env() 读取，且开关名不能拼错 —— '
                . '拼错会被 filter_var 当 false，fail-closed 就再也打不开了。'
        );
    }
}
