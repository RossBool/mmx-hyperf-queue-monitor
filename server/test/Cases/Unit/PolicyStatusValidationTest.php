<?php

declare(strict_types=1);
/**
 * `assertStatus()` 的 `$required` 语义回归测试 —— 审查缺口 C-5。
 *
 * ## 为什么这条测试存在
 *
 * S-04 之前，`assertStatus()` 对 `null` / `''` 一律 `return 0`，而 `create()` 与
 * `changeStatus()` **共用这一个方法**。于是 `POST /policies/{id}/status` 传 `{}`
 * 或坏 JSON 时，会**静默把线上策略停用并返回 200**。
 *
 * 修复加了 `bool $required = false` 区分两条路径，但当时**一条回归测试都没有**：
 * `PolicyPersistenceTest` 里的 5 处 `changeStatus` 调用全传 0/1，
 * 从来没有一条传 `null` / `''` / 不传 —— **连断言都不存在**。
 *
 * ## 为什么要用反射测私有方法
 *
 * `changeStatus()` 的第一行是 `findOrFail($id)`，**先查库再校验**，
 * 所以「缺 status → 422」这条端到端路径必须有真实 MySQL 才能走通。
 * 而 `assertStatus()` 是纯函数：只依赖一个 `Validator`，不碰数据库。
 * 因此本文件能在**没有 MySQL、没有容器**的环境里跑，把核心语义钉死；
 * 端到端那条见 `PolicyPersistenceTest::testChangeStatusRejectsMissingStatus()`。
 *
 * 反射调用私有方法是有意为之：这些分支无法从公开 API 抵达而不付出数据库代价，
 * 而「构造器注入两个纯校验器」让 `newInstanceWithoutConstructor` 完全安全。
 */
namespace Tests\Cases\Unit;

use App\Service\AlarmPolicyService;
use PHPUnit\Framework\Attributes\DataProvider;
use App\Support\Validator;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class PolicyStatusValidationTest extends TestCase
{
    /** @return array{0: int, 1: array<string,string>} 返回 [归一化后的 status, 错误表] */
    private function assertStatus(mixed $raw, bool $required): array
    {
        // assertStatus 不碰 $this 的任何状态，只用注入的两个校验器；
        // 跳过构造器可避免为拿一个纯函数而拉起整个依赖图。
        $service = (new \ReflectionClass(AlarmPolicyService::class))->newInstanceWithoutConstructor();
        $errors = new Validator();

        $method = new ReflectionMethod($service, 'assertStatus');
        $status = (int) $method->invoke($service, $raw, $errors, $required);

        return [$status, $errors->errors()];
    }

    // ── ⑥ required=true：缺省必须报错（这是 S-04 的核心）────────────────

    public function testRequiredRejectsNull(): void
    {
        [$status, $errors] = $this->assertStatus(null, true);

        self::assertArrayHasKey('status', $errors, '缺省 status 必须记 422 字段错误，不能静默放行。');
        self::assertSame(0, $status);
    }

    public function testRequiredRejectsEmptyString(): void
    {
        [$status, $errors] = $this->assertStatus('', true);

        self::assertArrayHasKey(
            'status',
            $errors,
            '空串 status 在 ⑥ 下必须报错 —— 旧实现把它当 0，'
                . '于是 POST /policies/{id}/status 传 {} 会静默停用线上策略。'
        );
        self::assertSame(0, $status);
    }

    // ── 显式 0 是合法停用值，绝不能被误判为「缺省」─────────────────────

    /**
     * 这是整个修复里**最容易写错**的一条：`0` 是 falsy。
     * 若把 `===` 写成 `==`，或写成 `if (!$raw)`，显式传 0 就会走进缺省分支被拒，
     * 「停用」这个最基本的操作直接不可用。
     */
    public function testExplicitZeroIsAcceptedWhenRequired(): void
    {
        [$status, $errors] = $this->assertStatus(0, true);

        self::assertSame([], $errors, '显式 status=0 是合法停用值，不得被判为缺省。');
        self::assertSame(0, $status);
    }

    public function testExplicitOneIsAcceptedWhenRequired(): void
    {
        [$status, $errors] = $this->assertStatus(1, true);

        self::assertSame([], $errors);
        self::assertSame(1, $status);
    }

    public function testStringFormsAreAcceptedWhenRequired(): void
    {
        // JSON 里写数字和写字符串都常见，两者都应接受
        self::assertSame([0, []], $this->assertStatus('0', true));
        self::assertSame([1, []], $this->assertStatus('1', true));
    }

    // ── 非法值一律 422，且归一化为 0 ──────────────────────────────────

    public static function invalidValueProvider(): array
    {
        return [
            'bool false' => [false],
            'bool true' => [true],
            '空数组' => [[]],
            '空对象' => [new \stdClass()],
            '非数字串' => ['abc'],
            '带空格串' => [' 1 '],
            '指数写法' => ['1e0'],
            '小数' => ['1.5'],
            '越界 2' => [2],
            '负数' => [-1],
        ];
    }

    #[DataProvider('invalidValueProvider')]
    public function testInvalidValuesAreRejected(mixed $raw): void
    {
        [$status, $errors] = $this->assertStatus($raw, true);

        self::assertArrayHasKey('status', $errors, '非法 status 必须记字段错误。');
        self::assertSame(0, $status, '非法值归一化为 0，但必须已记错。');
    }

    // ── ③ required=false：创建/更新路径行为必须与修复前逐字节一致 ────────

    public function testOptionalAcceptsMissingAsZero(): void
    {
        self::assertSame([0, []], $this->assertStatus(null, false), '创建时缺省 status 应为 0 且不报错。');
        self::assertSame([0, []], $this->assertStatus('', false), '创建时空串应归一化为 0 且不报错。');
    }

    public function testOptionalStillRejectsInvalidValues(): void
    {
        [, $errors] = $this->assertStatus('abc', false);

        self::assertArrayHasKey('status', $errors, '宽松只放宽「缺省」，不放松「非法值」。');
    }

    public function testRequiredFlagDoesNotChangeExplicitValueHandling(): void
    {
        // 同一个值在两条路径下的结果必须完全一致 —— $required 只影响 null/'' 这一支
        foreach ([0, 1, '0', '1', 'abc', 2, -1] as $raw) {
            self::assertSame(
                $this->assertStatus($raw, false),
                $this->assertStatus($raw, true),
                '传入 ' . var_export($raw, true) . ' 时，required 开关不应改变结果。'
            );
        }
    }
}
