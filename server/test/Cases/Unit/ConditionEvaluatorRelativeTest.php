<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Engine\Evaluator\ConditionEvaluator;
use App\Engine\Value\Sample;
use PHPUnit\Framework\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * 契约 §1.5.4 相对判据的边界求值。
 *
 * 契约原文列了**三条**「极易实现错」的边界：
 *   ① `baseline == 0`      → 不命中
 *   ② 基线窗口无数据       → 不命中
 *   ③ `baseline < 0`       → 用 abs 做分母，否则符号翻转
 *
 * 这三条**每一条**都有专门用例，因为它们都不会让程序崩溃 ——
 * 只会让告警默默失准，正是最难被发现的一类。
 */
final class ConditionEvaluatorRelativeTest extends TestCase
{
    private ConditionEvaluator $ev;

    protected function setUp(): void
    {
        $this->ev = new ConditionEvaluator();
    }

    // ── 边界 ①：基线为 0 ────────────────────────────────────────────

    public function testBaselineZeroDoesNotHit(): void
    {
        $v = $this->ev->evaluateRelative(
            [100.0],
            [new Sample(1000, 0.0)],
            '>', 10.0, 'period', 1
        );

        $this->assertFalse($v->hit, '基线为 0 时除法无意义，契约要求不命中');
        $this->assertStringContainsString('基线', $v->reason);
    }

    /**
     * 浮点近似零也要拦住。
     *
     * ⚠️ 这是从「实现细节」反推出来的用例：均值在浮点下可能算出
     *    1e-17 而不是精确 0。只判 `=== 0.0` 的话，
     *    deviation 会算成 1e19 —— 一个**巨大的正数**，`> 10` 成立 → 每次都告警。
     *    比「不告警」糟得多。
     */
    public function testBaselineNearZeroAlsoDoesNotHit(): void
    {
        $v = $this->ev->evaluateRelative(
            [100.0],
            [new Sample(1000, 1e-17)],
            '>', 10.0, 'period', 1
        );
        $this->assertFalse($v->hit, '浮点近似零同样会让 deviation 爆到 1e19，必须拦住');
    }

    // ── 边界 ②：基线窗口无数据 ──────────────────────────────────────

    public function testEmptyBaselineDoesNotHit(): void
    {
        $v = $this->ev->evaluateRelative([100.0], [], '>', 10.0, 'period', 1);

        $this->assertFalse($v->hit, '基线窗口无数据时契约要求不命中（宁可漏报）');
        $this->assertStringContainsString('无数据', $v->reason);
    }

    /**
     * 负对照：无数据 ≠ 值为 0。
     *
     * 若实现里把「无数据」退化成 baseline=0，
     * 就会走到边界①那条路 —— 但**原因文案不同**，可观测性也不同。
     * 这里断言两者不产生相同的 hit 结果。
     */
    public function testEmptyBaselineDiffersFromZeroBaseline(): void
    {
        $empty = $this->ev->evaluateRelative([100.0], [], '>', 10.0, 'period', 1);
        $zero = $this->ev->evaluateRelative([100.0], [new Sample(1000, 0.0)], '>', 10.0, 'period', 1);

        $this->assertFalse($empty->hit);
        $this->assertFalse($zero->hit);
        $this->assertNotSame($empty->reason, $zero->reason, '两者原因必须可区分，否则排查会指错方向');
    }

    // ── 边界 ③：基线为负 ────────────────────────────────────────────

    /**
     * ⚠️ 这是本文件最重要的用例。
     *
     * 场景：value=-20，baseline=-100（指标为负数，比如温度、某些 delta 值）。
     *
     *   错误算法 (v-b)/b   = 80 / -100  = -0.8  → 「比基线跌了 80%」 **说反了**
     *   正确算法 (v-b)/|b| = 80 / 100   = +0.8  → 「比基线涨了 80%」
     *
     * 配上 `operator='<'` 判「跌超 30%」时，错误实现会**持续误报**：
     * 明明是从 -100 涨到 -20（好转），却判成「跌了 80%」。
     */
    public function testNegativeBaselineKeepsDirectionCorrect(): void
    {
        $v = $this->ev->evaluateRelative(
            [-20.0],
            [new Sample(1000, -100.0)],
            '>', 30.0, 'period', 1
        );

        $this->assertGreaterThan(0, $v->deviationPercent, '负基线下「从 -100 到 -20」是**涨**，偏离必须为正');
        $this->assertSame(80.0, round((float) $v->deviationPercent, 6));
        $this->assertTrue($v->hit, 'operator=> 且偏离 +80%，应该命中');
    }

    /** 同一场景配 operator='<' 时必须**不**命中 —— 错误实现会在这里误报。 */
    public function testNegativeBaselineDoesNotFalsePositiveOnLessThan(): void
    {
        $v = $this->ev->evaluateRelative(
            [-20.0],
            [new Sample(1000, -100.0)],
            '<', -30.0, 'period', 1
        );
        $this->assertFalse($v->hit, 'operator=<-30% 而实际是 +80%，误报');
    }

    /** 反向：真的下跌时 operator='<' 必须命中。 */
    public function testNegativeBaselineDetectsRealDrop(): void
    {
        $v = $this->ev->evaluateRelative(
            [-200.0],
            [new Sample(1000, -100.0)],
            '<', -30.0, 'period', 1
        );
        // (v-b)/|b| = (-200+100)/100 = -100 → 跌了 100%
        $this->assertSame(-100.0, round((float) $v->deviationPercent, 6));
        $this->assertTrue($v->hit);
    }

    // ── 常规相对判据 ────────────────────────────────────────────────

    #[DataProvider('relativeProvider')]
    public function testRelative(float $value, float $baseline, string $op, float $threshold, bool $expect): void
    {
        $v = $this->ev->evaluateRelative([$value], [new Sample(1000, $baseline)], $op, $threshold, 'period', 1);
        $this->assertSame($expect, $v->hit, $v->reason);
    }

    public static function relativeProvider(): array
    {
        return [
            // ⚠️ deviation **带符号**（契约 §1.5.4）：
            //    跌超 N% 的 threshold 必须写 **-N**，不是 N。
            //    初稿契约写的是 `operator=<, threshold=30 表示跌超 30%`，
            //    那是错的 —— -20 < 30 恒真，任何幅度的小跌都会触发。已更正。
            '涨 50% > 30' => [150.0, 100.0, '>', 30.0, true],
            '涨 20% > 30' => [120.0, 100.0, '>', 30.0, false],
            '涨 30% >= 30' => [130.0, 100.0, '>=', 30.0, true],
            // ⚠️ 正好 -30% 时 `< -30` 为 false —— operator 是**严格**比较。
            //    「跌超 30%」字面就是「超过」，所以取 -31%；要含等于得用 `<=`。
            '跌 31% < -30' => [69.0, 100.0, '<', -30.0, true],
            '正好跌 30% < -30（严格，不命中）' => [70.0, 100.0, '<', -30.0, false],
            '正好跌 30% <= -30' => [70.0, 100.0, '<=', -30.0, true],
            '跌 20% < -30' => [80.0, 100.0, '<', -30.0, false],
            '跌 20% < 30（错配，正阈值）' => [80.0, 100.0, '<', 30.0, true],
            '不变 != 0' => [100.0, 100.0, '!=', 0.0, false],
            '不变 == 0' => [100.0, 100.0, '==', 0.0, true],
            '持平 <= 0' => [100.0, 100.0, '<=', 0.0, true],
        ];
    }

    /** 基线是**均值**时按所有基线点算，不是只看第一个。 */
    public function testBaselineIsMeanOfAllBaselineSamples(): void
    {
        $v = $this->ev->evaluateRelative(
            [160.0],
            [new Sample(1000, 100.0), new Sample(1060, 200.0)],
            '>', 30.0, 'period', 1
        );
        // 均值 = 150，偏离 = (160-150)/150 = 6.67% → 不命中 30
        $this->assertSame(150.0, (float) $v->baseline);
        $this->assertFalse($v->hit);
    }

    /** 当前值无数据 → 不命中，且原因要说清是「无数据点」而不是「阈值不满足」。 */
    public function testNoCurrentSampleDoesNotHit(): void
    {
        $v = $this->ev->evaluateRelative([], [new Sample(1000, 100.0)], '>', 30.0, 'period', 1);
        $this->assertFalse($v->hit);
        $this->assertSame('无数据点', $v->reason);
    }

    /**
     * 非法算子必须**炸出来**。
     *
     * 若用 `match` + 兜底 `false`，非法算子会表现为「条件永不触发」——
     * 一个静默失效的策略，比报错难查一百倍。
     */
    public function testUnknownOperatorThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->ev->evaluateAbsolute([1.0], '约等于', 1.0);
    }

    // ── 绝对判据 ────────────────────────────────────────────────────

    #[DataProvider('absoluteProvider')]
    public function testAbsolute(float $value, string $op, float $threshold, bool $expect): void
    {
        $this->assertSame($expect, $this->ev->evaluateAbsolute([$value], $op, $threshold)->hit);
    }

    public static function absoluteProvider(): array
    {
        return [
            '80 > 80' => [80.0, '>', 80.0, false],
            '80.1 > 80' => [80.1, '>', 80.0, true],
            '80 >= 80' => [80.0, '>=', 80.0, true],
            '0 < 1' => [0.0, '<', 1.0, true],
            '负阈值 -5 < -10' => [-5.0, '<', -10.0, false],
            '负阈值 -15 < -10' => [-15.0, '<', -10.0, true],
        ];
    }

    /**
     * 取**最新**的采样点（末尾），不是第一个。
     *
     * ⚠️ 传 [50, 90]，阈值 80：应该命中 90。取第一个会判 50 未命中。
     */
    public function testUsesLatestSampleNotFirst(): void
    {
        $this->assertTrue($this->ev->evaluateAbsolute([50.0, 90.0], '>', 80.0)->hit);
    }

    /** NaN / INF 必须在 Sample 构造时就被挡掉 —— 否则 `NaN > x` 恒 false，表现为永不告警。 */
    public function testSampleRejectsNonFinite(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Sample(1000, NAN);
    }

    public function testSampleRejectsInfinity(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Sample(1000, INF);
    }
}
