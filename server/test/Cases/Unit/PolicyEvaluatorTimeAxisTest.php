<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Engine\Evaluator\PolicyEvaluator;
use App\Engine\Evaluator\ConditionEvaluator;
use HyperfTest\Support\InMemorySampleRepository;
use PHPUnit\Framework\TestCase;

/**
 * 策略级求值：period / continuity / baselineType 的时间轴对齐。
 *
 * ## 为什么这组测试最关键
 *
 * 判据的「算错了」通常表现为**恒不触发**或**恒触发**，
 * 而这两种都不会报错、不抛异常、不会在日志里留痕。
 * 只有把时间对齐钉死，才敢说引擎的求值是对的。
 *
 * 这里全部用**绝对时间戳**（`T = 2026-01-01 00:00:00 UTC`）而不是相对偏移，
 * 因为「昨天」「上周」这类语义在绝对时间轴上才看得清。
 */
final class PolicyEvaluatorTimeAxisTest extends TestCase
{
    /** 2026-01-01 00:00:00 UTC —— 周四 */
    private const T = 1767225600;

    private const MIN = 60;
    private const DAY = 86400;
    private const WEEK = 604800;

    private function evaluator(array $rows, int $period = 5): array
    {
        $repo = new InMemorySampleRepository($rows, period: $period);
        $p = new PolicyEvaluator(new ConditionEvaluator(), $repo);

        return [$p, $repo];
    }

    private function cond(array $over = []): array
    {
        return array_merge([
            'sort' => 1,
            'metricNamespace' => 'CVM',
            'metricName' => 'CpuUtilizationRate',
            'operator' => '>',
            'threshold' => 80.0,
            'period' => 5,
            'continuity' => 1,
            'level' => 2,
            'frequency' => 15,
        ], $over);
    }

    // ── 绝对判据：取的是 t 时刻那个点 ────────────────────────────────

    public function testAbsoluteUsesValueAtEvaluationTime(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 50.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 95.0],
        ]);
        $v = $p->evaluateCondition($this->cond(), self::T);
        $this->assertFalse($v->hit, 't 时刻是 50，之前的 95 不该影响判定');
        $this->assertSame(50.0, (float) $v->value);
    }

    public function testAbsoluteFiresWhenCurrentValueOverThreshold(): void
    {
        [$p] = $this->evaluator([['ts' => self::T, 'value' => 90.0]]);
        $this->assertTrue($p->evaluateCondition($this->cond(), self::T)->hit);
    }

    // ── 环比：基线往前挪 baselineCount 个 period ────────────────────

    /**
     * baselineCount=1、period=5min → 基线是 t-300 秒那个点。
     * 造一个「只有基线点变了」的对照：如果实现取错窗口，结果会反过来。
     */
    public function testPeriodBaselineOffsetsByExactlyOnePeriod(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 150.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 100.0],   // 正确基线
            ['ts' => self::T - 10 * self::MIN, 'value' => 999.0],  // 更早的干扰点
        ]);

        $v = $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'period', 'baselineCount' => 1, 'operator' => '>', 'threshold' => 30.0]),
            self::T
        );
        $this->assertSame(100.0, (float) $v->baseline, '基线必须是 t-5min，不是 t-10min');
        $this->assertTrue($v->hit);
    }

    public function testPeriodBaselineRespectsBaselineCountThree(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 150.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 999.0],
            ['ts' => self::T - 10 * self::MIN, 'value' => 999.0],
            ['ts' => self::T - 15 * self::MIN, 'value' => 100.0],  // n=3 → 前移 3 个周期
        ]);

        $v = $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'period', 'baselineCount' => 3, 'operator' => '>', 'threshold' => 30.0]),
            self::T
        );
        $this->assertSame(100.0, (float) $v->baseline);
    }

    // ── 同比昨日：往前 1 天同一时刻 ──────────────────────────────────

    public function testDayBaselineOffsetsExactlyOneDay(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 200.0],
            ['ts' => self::T - self::DAY, 'value' => 100.0],          // 正确
            ['ts' => self::T - self::DAY - 5 * self::MIN, 'value' => 1.0],  // 错一格
        ]);

        $v = $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'day', 'operator' => '>', 'threshold' => 30.0]),
            self::T
        );
        $this->assertSame(100.0, (float) $v->baseline, '同比昨日必须取**昨天同一时刻**，不是昨天前一个周期');
        $this->assertTrue($v->hit);
    }

    // ── 同比上周：往前 1 周同一时刻 ──────────────────────────────────

    public function testWeekBaselineOffsetsExactlyOneWeek(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 200.0],
            ['ts' => self::T - self::WEEK, 'value' => 100.0],
        ]);

        $v = $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'week', 'operator' => '>', 'threshold' => 30.0]),
            self::T
        );
        $this->assertSame(100.0, (float) $v->baseline);
    }

    /** 昨天和上周的数据都在时，必须按 baselineType 选对那一个。 */
    public function testDayAndWeekBaselinesDoNotCrossTalk(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 100.0],
            ['ts' => self::T - self::DAY, 'value' => 50.0],
            ['ts' => self::T - self::WEEK, 'value' => 80.0],
        ]);

        $day = $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'day', 'operator' => '>', 'threshold' => 30.0]),
            self::T
        );
        $week = $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'week', 'operator' => '>', 'threshold' => 30.0]),
            self::T
        );

        $this->assertSame(50.0, (float) $day->baseline, '同比昨日取昨天');
        $this->assertSame(80.0, (float) $week->baseline, '同比上周取上周');
    }

    // ── 连续性 ──────────────────────────────────────────────────────

    /**
     * continuity=3：最近 3 个评估时刻都要命中。
     * 三个都 90 → 命中。
     */
    public function testContinuityRequiresAllThreePointsToHit(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 90.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 90.0],
            ['ts' => self::T - 10 * self::MIN, 'value' => 90.0],
        ]);
        $this->assertTrue($p->evaluateCondition($this->cond(['continuity' => 3]), self::T)->hit);
    }

    /** 中间断一个 → 不命中，且原因要说清是第几个时刻没中。 */
    public function testContinuityFailsWhenMiddlePointMisses(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 90.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 50.0],   // 断了
            ['ts' => self::T - 10 * self::MIN, 'value' => 90.0],
        ]);
        $v = $p->evaluateCondition($this->cond(['continuity' => 3]), self::T);
        $this->assertFalse($v->hit);
        $this->assertStringContainsString('连续性不足', $v->reason);
    }

    /**
     * ⚠️ 数据不足时**不判命中**。
     *
     * continuity=3 但只有 2 个点 —— 如果实现写成「够不到 3 个就默认通过」，
     * 那就是**把缺数据当成健康**，与 F 类要解决的问题背道而驰。
     */
    public function testContinuityDoesNotPassWhenDataInsufficient(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 90.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 90.0],
            // 缺 T-10min
        ]);
        $v = $p->evaluateCondition($this->cond(['continuity' => 3]), self::T);
        $this->assertFalse($v->hit);
        $this->assertStringContainsString('连续性', $v->reason);
    }

    /**
     * 相对判据 + 连续性：每个评估时刻必须用**自己的**基线。
     *
     * ⚠️ 这是最容易写错的地方，而且错了**不会报错**：
     * 实现若偷懒，用「最新时刻的基线」去回测历史评估点 ——
     *
     *   正确：T-5min 的值 100 对它自己昨天的基线 100 → 0% → 不命中 → 整体不命中
     *   错误：T-5min 的值 100 拿 T 的基线 50 比      → +100% → 命中 → 整体命中
     *
     * 两者结论相反，且都不抛异常。只能靠这种「让两种实现给出相反答案」的数据钉死。
     */
    public function testRelativeContinuityUsesPerTimestampBaseline(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 200.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 100.0],
            // 各自「昨天同一时刻」的基线
            ['ts' => self::T - self::DAY, 'value' => 50.0],                 // 200 vs 50 → +300%
            ['ts' => self::T - self::DAY - 5 * self::MIN, 'value' => 100.0], // 100 vs 100 → 0%
        ]);

        $v = $p->evaluateCondition($this->cond([
            'compareMode' => 'relative', 'baselineType' => 'day',
            'operator' => '>', 'threshold' => 50.0, 'continuity' => 2,
        ]), self::T);

        $this->assertFalse(
            $v->hit,
            'T-5min 相对**它自己**昨天的基线是 0% 偏离，不该命中。'
            . '若这里命中了，说明实现拿 T 的基线去回测了历史点。'
        );
    }

    /** 负对照：两个时刻各自都相对自己的基线涨超 50% → 整体命中。 */
    public function testRelativeContinuityHitsWhenEachTimestampQualifies(): void
    {
        [$p] = $this->evaluator([
            ['ts' => self::T, 'value' => 200.0],
            ['ts' => self::T - 5 * self::MIN, 'value' => 120.0],
            ['ts' => self::T - self::DAY, 'value' => 50.0],
            ['ts' => self::T - self::DAY - 5 * self::MIN, 'value' => 60.0],
        ]);

        $v = $p->evaluateCondition($this->cond([
            'compareMode' => 'relative', 'baselineType' => 'day',
            'operator' => '>', 'threshold' => 50.0, 'continuity' => 2,
        ]), self::T);

        $this->assertTrue($v->hit, 'T:+300%、T-5min:+100%，都超 50%');
        $this->assertStringContainsString('连续 2', $v->reason);
    }

    // ── 缺数据 ──────────────────────────────────────────────────────

    public function testNoDataAtAllDoesNotHit(): void
    {
        [$p] = $this->evaluator([]);
        $v = $p->evaluateCondition($this->cond(), self::T);
        $this->assertFalse($v->hit);
        $this->assertStringContainsString('无数据点', $v->reason);
    }

    /** 静默条件的 metricNamespace/metricName 为 null（契约 §2.1 规则 3）→ 不应报错。 */
    public function testSilenceConditionWithNullMetricFieldsReturnsNoData(): void
    {
        [$p] = $this->evaluator([['ts' => self::T, 'value' => 99.0]]);
        $v = $p->evaluateCondition($this->cond([
            'metricNamespace' => null,
            'metricName' => null,
            'operator' => null,
            'threshold' => null,
        ]), self::T);
        $this->assertFalse($v->hit, '静默条件不走指标判据（由 SilenceEvaluator 负责）');
    }

    // ── 非法输入必须炸 ──────────────────────────────────────────────

    public function testUnknownBaselineTypeThrows(): void
    {
        [$p] = $this->evaluator([['ts' => self::T, 'value' => 1.0]]);
        $this->expectException(\InvalidArgumentException::class);
        $p->evaluateCondition(
            $this->cond(['compareMode' => 'relative', 'baselineType' => 'month']),
            self::T
        );
    }
}
