<?php

declare(strict_types=1);
/**
 * 鉴权中间件的回归测试 —— 审查缺口 D-6。
 *
 * ## 为什么这条测试存在
 *
 * S-10 把 `isValid()` 从 **fail-open**（白名单未配置 → `return true`，即漏配一个环境变量
 * 就等于全部告警接口无鉴权且无任何错误信号）改成 **fail-closed**。
 * 这是**改动全部 19 个端点**的行为变更，而当时后端 test/ 下**一条鉴权测试都没有**。
 * 「改了 19 个端点的安全语义且零测试」是本轮最不可接受的一条。
 *
 * 同样地 `.env.example` 一度预填了可用的 `dev-token-1`（D-4），
 * 而 `composer.json` 的 `post-root-package-install` 会把它自动 copy 成 `.env` ——
 * 等于把 fail-closed 换成「用仓库公开凭据的有鉴权」。
 * `testExampleEnvShipsNoWorkingCredential()` 专门钉死这一条。
 *
 * ⚠️ 本文件**不连数据库**，可在没有 MySQL 的环境运行。
 * ⚠️ 但 `env()` 读的是进程环境变量，测试内用 `putenv` + 反射改写私有方法的可测边界，
 *    因此**不依赖容器**，可在 PHPUnit 单进程里直接跑。
 */
namespace Tests\Cases\Unit;

use App\Middleware\AuthMiddleware;
use Hyperf\Contract\StdoutLoggerInterface;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class AuthMiddlewareTest extends TestCase
{
    private string $tokenBackup;
    private string $disabledBackup;
    private bool $tokenWasSet;
    private bool $disabledWasSet;
    /** 超全局变量（复核 D-2）：$_ENV / $_SERVER 的优先级高于 putenv() */
    private array $globalsBackup = [];

    private const MANAGED_VARS = ['ALARM_STATIC_TOKENS', 'ALARM_AUTH_DISABLED'];

    protected function setUp(): void
    {
        foreach (self::MANAGED_VARS as $name) {
            $this->globalsBackup[$name] = [
                'env' => array_key_exists($name, $_ENV),
                'envValue' => $_ENV[$name] ?? null,
                'server' => array_key_exists($name, $_SERVER),
                'serverValue' => $_SERVER[$name] ?? null,
            ];
        }
        $this->tokenWasSet = getenv('ALARM_STATIC_TOKENS') !== false;
        $this->disabledWasSet = getenv('ALARM_AUTH_DISABLED') !== false;
        $this->tokenBackup = (string) getenv('ALARM_STATIC_TOKENS');
        $this->disabledBackup = (string) getenv('ALARM_AUTH_DISABLED');
    }

    protected function tearDown(): void
    {
        foreach ([
            'ALARM_STATIC_TOKENS' => [$this->tokenWasSet, $this->tokenBackup],
            'ALARM_AUTH_DISABLED' => [$this->disabledWasSet, $this->disabledBackup],
        ] as $name => [$wasSet, $value]) {
            if ($wasSet) {
                putenv("{$name}={$value}");
            } else {
                putenv($name);
            }
        }
        foreach ($this->globalsBackup as $name => $saved) {
            $this->restoreGlobal($name, '_ENV', $saved['env'], $saved['envValue']);
            $this->restoreGlobal($name, '_SERVER', $saved['server'], $saved['serverValue']);
        }
    }

    private function restoreGlobal(string $name, string $bucket, bool $wasSet, mixed $value): void
    {
        if ($wasSet) {
            $GLOBALS[$bucket][$name] = $value;
        } else {
            unset($GLOBALS[$bucket][$name]);
        }
    }

    /** 直接调 private isValid()，绕开 Request 构造与容器。 */
    private function isValid(string $token): bool
    {
        $middleware = new AuthMiddleware($this->createMock(StdoutLoggerInterface::class));
        $method = new ReflectionMethod($middleware, 'isValid');

        return (bool) $method->invoke($middleware, $token);
    }

    /**
     * ⚠️ 必须**同时**清掉超全局变量（复核 D-2）。
     *
     * Hyperf 的 `env()` 有三个 adapter：`EnvConstAdapter`（读 `$_ENV`）、
     * `ServerConstAdapter`（读 `$_SERVER`）、`PutenvAdapter`（读 `getenv()`）。
     * 前两者优先级**高于** putenv —— 已经存在于 `$_ENV`/`$_SERVER` 的值会盖住
     * `putenv()` 的写入。只清 putenv 的话，本机若有 `.env` 配了
     * `ALARM_STATIC_TOKENS`（README 恰恰教人这么做），
     * `testAcceptsTokenOnWhitelist` 会因为**与被测代码无关的原因**变红。
     */
    private function withEnv(string $name, string $value): void
    {
        putenv("{$name}={$value}");
        unset($_ENV[$name], $_SERVER[$name]);
    }

    // ── fail-closed：白名单未配置必须拒绝 ──────────────────────────────

    public function testRejectsWhenWhitelistNotConfigured(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', '');
        $this->withEnv('ALARM_AUTH_DISABLED', 'false');

        // 这就是旧实现返回 true 的那一条 —— fail-open 意味着漏配 = 全部接口裸奔。
        self::assertFalse(
            $this->isValid('any-token-at-all'),
            'ALARM_STATIC_TOKENS 未配置时必须拒绝所有 token（fail-closed）。'
                . '返回 true 等于「漏配一个环境变量 → 全部告警接口无鉴权且无任何错误信号」。'
        );
    }

    public function testRejectsWhenWhitelistIsOnlyWhitespace(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', '   ');
        $this->withEnv('ALARM_AUTH_DISABLED', 'false');

        self::assertFalse(
            $this->isValid('any-token'),
            '白名单只有空白字符等价于未配置，必须拒绝（trim 后为空）。'
        );
    }

    // ── 白名单已配置：命中放行、未命中拒绝 ────────────────────────────

    public function testAcceptsTokenOnWhitelist(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', 'tok-aaa,tok-bbb');
        $this->withEnv('ALARM_AUTH_DISABLED', 'false');

        self::assertTrue($this->isValid('tok-aaa'), '白名单内 token 应放行');
        self::assertTrue($this->isValid('tok-bbb'), '白名单第二个 token 也应放行');
    }

    public function testRejectsTokenNotOnWhitelist(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', 'tok-aaa,tok-bbb');
        $this->withEnv('ALARM_AUTH_DISABLED', 'false');

        self::assertFalse($this->isValid('tok-ccc'), '白名单外 token 必须拒绝');
        self::assertFalse($this->isValid(''), '空 token 必须拒绝');
    }

    public function testTrimsWhitespaceAroundWhitelistEntries(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', ' tok-aaa , tok-bbb ');
        $this->withEnv('ALARM_AUTH_DISABLED', 'false');

        self::assertTrue(
            $this->isValid('tok-aaa'),
            '白名单条目应被 trim（`tok-aaa , tok-bbb` 是常见的粘贴写法）。'
        );
    }

    // ── 显式关闭开关 ──────────────────────────────────────────────────

    public function testAuthDisabledBypassesWhitelist(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', '');
        $this->withEnv('ALARM_AUTH_DISABLED', 'true');

        self::assertTrue(
            $this->isValid('whatever'),
            'ALARM_AUTH_DISABLED=true 应显式放行 —— 这是本地联调的逃生舱。'
        );
    }

    /**
     * 安全关键：`filter_var(..., FILTER_VALIDATE_BOOLEAN)` 对无法识别的字符串返回 **false**。
     * 这意味着把开关名写错 → 鉴权保持开启（fail-secure），不会静默关闭。
     */
    public function testUnrecognisedAuthDisabledValueKeepsAuthOn(): void
    {
        $this->withEnv('ALARM_STATIC_TOKENS', '');
        $this->withEnv('ALARM_AUTH_DISABLED', 'flase'); // 拼错

        self::assertFalse(
            $this->isValid('whatever'),
            'ALARM_AUTH_DISABLED 写成无法识别的值时必须保持 fail-closed，不得当成 true。'
        );
    }

    // ── 守住 D-4：示例 env 不得预填可用凭据 ───────────────────────────

    /**
     * `composer.json` 的 `post-root-package-install` 是
     * `file_exists('.env') || copy('.env.example', '.env')`，
     * 因此 `.env.example` 里预填的 token 会**自动落进新建项目的 .env**，
     * 且对任何拿到仓库的人公开 —— fail-closed 被完全抵消。
     */
    public function testExampleEnvShipsNoWorkingCredential(): void
    {
        $path = __DIR__ . '/../../../.env.example';
        self::assertFileExists($path);

        $src = (string) file_get_contents($path);
        self::assertMatchesRegularExpression(
            '/^ALARM_STATIC_TOKENS\s*=\s*$/m',
            $src,
            '.env.example 的 ALARM_STATIC_TOKENS 必须留空。'
                . 'composer install 会自动 copy 本文件为 .env，预填的 token 等于公开凭据（D-4）。'
        );

        // 兜底：整份文件里不允许出现任何看起来像 token 的预填值
        //
        // ⚠️ 这里必须用 `[ \t]*` 而不是 `\s*`：
        //    `\s` 包含换行，所以 `\s*=\s*\S` 会把 `ALARM_STATIC_TOKENS=` 行尾的
        //    换行一起吃掉，再去匹配**下一行**的第一个非空白字符（`#`），
        //    于是一份完全正确的空值 .env.example 也会被判成「有预填值」。
        //    这个假失败是本文件写完从未运行过的直接后果。
        self::assertDoesNotMatchRegularExpression(
            '/^ALARM_STATIC_TOKENS[ \t]*=[ \t]*\S/m',
            $src,
            '.env.example 的 ALARM_STATIC_TOKENS 后面跟了非空值（D-4 回归）。'
        );
    }

    /**
     * 守住 S-04 的反面：`.env.example` 不能把 `ALARM_AUTH_DISABLED` 默认打开。
     */
    public function testExampleEnvDoesNotDisableAuthByDefault(): void
    {
        $path = __DIR__ . '/../../../.env.example';
        $src = (string) file_get_contents($path);

        self::assertMatchesRegularExpression(
            '/^ALARM_AUTH_DISABLED\s*=\s*(false|0|no|off|""|\'\')\s*$/mi',
            $src,
            '.env.example 不得默认关闭鉴权 —— ALARM_AUTH_DISABLED 必须是显式 opt-in。'
        );
    }
}
