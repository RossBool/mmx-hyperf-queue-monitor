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
        // ⚠️ 包名是 `vlucas/phpdotenv`，**不是** `hyperf/dotenv` ——
        //    Packagist 上**不存在** `hyperf/dotenv`（实测 p2/hyperf/dotenv.json → 404）。
        //    写错包名的后果不是「env() 没数据源」这么温和：`composer install` 直接失败，
        //    整个项目无法部署 —— 而这个错误只有真跑一次 install 才会暴露。
        //    hyperf 自己在 composer.json 里用的也是 `vlucas/phpdotenv: ^5.0`。
        self::assertArrayHasKey(
            'vlucas/phpdotenv',
            $composer['require'],
            'composer.json 必须 require vlucas/phpdotenv —— Packagist 上没有 hyperf/dotenv，'
                . '写那个名字会让 composer install 整体失败。'
        );
        self::assertArrayNotHasKey(
            'hyperf/dotenv',
            $composer['require'],
            'hyperf/dotenv 在 Packagist 上不存在，必须改用 vlucas/phpdotenv。'
        );
    }

    /**
     * 光断言 composer.json 里有包名不够 —— 那只证明字符串写对了，
     * 不证明**依赖真装上了、类真能加载**。
     *
     * 真实失败模式有两种：包名写对但没跑 install（vendor 里没有），
     * 或者包装了但当前 PHP 版本上 `Dotenv` 类不存在。
     * 只有 `class_exists` 能同时挡住这两种。
     */
    public function testDotenvClassIsActuallyLoadable(): void
    {
        self::assertTrue(
            class_exists(\Dotenv\Dotenv::class),
            'vlucas/phpdotenv 没装上或 Dotenv 类不可用 —— 先跑 `composer install`。'
        );
    }

    /**
     * 端到端：bootstrap 真的把 .env 灌进了 `getenv()`。
     *
     * 本条是本文件的核心价值。`Hyperf\Support\env()` 的实现是 `getenv($key)`，
     * 而 `Dotenv::createUnsafeImmutable()` 默认带 `PutenvAdapter`，
     * 所以 getenv / $_ENV / $_SERVER 三条路径都应该读得到。
     * 哪天换成不注册 PutenvAdapter 的构造方式，只有这条测试能发现。
     */
    public function testBootstrapActuallyPopulatesGetenv(): void
    {
        $dir = sys_get_temp_dir() . '/alarm-env-probe-' . bin2hex(random_bytes(4));
        mkdir($dir);
        file_put_contents($dir . '/.env', "ALARM_ENV_PROBE=probe_value_123\n");

        try {
            \Dotenv\Dotenv::createUnsafeImmutable($dir)->safeLoad();
            self::assertSame(
                'probe_value_123',
                getenv('ALARM_ENV_PROBE'),
                'createUnsafeImmutable 之后 getenv() 读不到 —— env() 正是走 getenv()，'
                    . '这会让白名单/DB 配置恒为默认值。'
            );
            self::assertSame('probe_value_123', $_ENV['ALARM_ENV_PROBE'] ?? null);
            self::assertSame('probe_value_123', $_SERVER['ALARM_ENV_PROBE'] ?? null);
        } finally {
            putenv('ALARM_ENV_PROBE');
            unset($_ENV['ALARM_ENV_PROBE'], $_SERVER['ALARM_ENV_PROBE']);
            @unlink($dir . '/.env');
            @rmdir($dir);
        }
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
