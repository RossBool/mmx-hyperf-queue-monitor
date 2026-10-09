<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Engine\Evaluator\SilenceEvaluator;
use HyperfTest\Support\InMemoryHeartbeatRepository;
use PHPUnit\Framework\TestCase;

/**
 * 采集静默（F 类）判定。
 *
 * F 类缺口的核心危害是「**所有故障都不被发现，且系统看起来一切正常**」。
 * 所以这里的每条用例都在验证一件事：**不正常的静默状态不会被当成正常**。
 */
final class SilenceEvaluatorTest extends TestCase
{
    private const T = 1767225600; // 2026-01-01 00:00:00 UTC
    private const MIN = 60;

    private function policy(int $minutes = 30): array
    {
        return ['targetType' => 1, 'targetFreshnessMinutes' => $minutes];
    }

    private function ev(InMemoryHeartbeatRepository $repo): SilenceEvaluator
    {
        return new SilenceEvaluator($repo);
    }

    // ── 正常上报 ────────────────────────────────────────────────────

    public function testFreshHeartbeatDoesNotHit(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T - 5 * self::MIN);

        $v = $this->ev($repo)->evaluate($this->policy(30), 1, 100, self::T);
        $this->assertFalse($v->hit, '5 分钟前刚上报过，远未到 30 分钟阈值');
        $this->assertStringContainsString('已静默 5 分钟', $v->reason);
    }

    public function testHeartbeatExactlyAtThresholdDoesNotHit(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T - 30 * self::MIN);

        // 判定是 `>` 不是 `>=` —— 正好等于阈值不算静默
        $this->assertFalse($this->ev($repo)->evaluate($this->policy(30), 1, 100, self::T)->hit);
    }

    public function testHeartbeatOneSecondPastThresholdHits(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T - 30 * self::MIN - 1);

        $v = $this->ev($repo)->evaluate($this->policy(30), 1, 100, self::T);
        $this->assertTrue($v->hit, '超过阈值 1 秒就该命中');
    }

    public function testLongSilenceReportsMinutesAndThreshold(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T - 3 * 3600);

        $v = $this->ev($repo)->evaluate($this->policy(30), 1, 100, self::T);
        $this->assertTrue($v->hit);
        $this->assertStringContainsString('已静默 180 分钟', $v->reason);
        $this->assertStringContainsString('阈值 30 分钟', $v->reason);
    }

    // ── 从未上报 ────────────────────────────────────────────────────

    /**
     * ⚠️ 关键设计决策：从未上报**判命中**。
     *
     * 反过来（判不命中）的话，采集侧完全没接上时会永远不告警 ——
     * 而这正是 F 类要消除的「看起来一切正常」。宁可多报一次
     * 「目标从未上报」，也不要让接入失败静默通过。
     */
    public function testNeverReportedCountsAsSilent(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $v = $this->ev($repo)->evaluate($this->policy(30), 1, 999, self::T);

        $this->assertTrue($v->hit, '从未上报 = 静默，必须能被发现');
        $this->assertStringContainsString('从未上报', $v->reason);
    }

    /**
     * 「从未上报(null)」与「上报时间是 0」**必须区分**。
     *
     * 如果仓储用 0 兜底，1970 年的时间戳会让静默时长变成 1.7 亿分钟，
     * 原因文案也变成「已静默 5610 万年」—— 把排查引向完全错误的方向。
     */
    public function testEpochZeroIsNotSameAsNeverReported(): void
    {
        $a = new InMemoryHeartbeatRepository();
        $vNever = $this->ev($a)->evaluate($this->policy(30), 1, 1, self::T);

        $b = new InMemoryHeartbeatRepository();
        $b->reportEpochZero(1, 1);
        $vZero = $this->ev($b)->evaluate($this->policy(30), 1, 1, self::T);

        $this->assertNotSame($vNever->reason, $vZero->reason);
        $this->assertStringContainsString('从未上报', $vNever->reason);
        $this->assertStringContainsString('已静默', $vZero->reason);
    }

    /** 首次心跳到达后，行为自然从「从未上报」转为按正常时长判断。 */
    public function testFirstHeartbeatTransitionsOutOfNeverReported(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 999, self::T);
        $v = $this->ev($repo)->evaluate($this->policy(30), 1, 999, self::T);
        $this->assertFalse($v->hit, '刚上报过就不该再报「从未上报」');
    }

    // ── 目标隔离 ────────────────────────────────────────────────────

    /** 目标 A 静默不能让目标 B 跟着报警。 */
    public function testSilenceIsPerTarget(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 1, self::T);            // 目标 1 刚上报
        $repo->report(1, 2, self::T - 3600);    // 目标 2 很久没报

        $this->assertFalse($this->ev($repo)->evaluate($this->policy(30), 1, 1, self::T)->hit);
        $this->assertTrue($this->ev($repo)->evaluate($this->policy(30), 1, 2, self::T)->hit);
    }

    /** 不同 targetType 的同一 id 也要隔离。 */
    public function testTargetTypeIsPartOfIdentity(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T);
        $repo->report(2, 100, self::T - 3600);

        $this->assertFalse($this->ev($repo)->evaluate($this->policy(30), 1, 100, self::T)->hit);
        $this->assertTrue($this->ev($repo)->evaluate($this->policy(30), 2, 100, self::T)->hit);
    }

    // ── 阈值边界 ────────────────────────────────────────────────────

    public function testSmallestThresholdFiveMinutes(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T - 6 * self::MIN);
        $this->assertTrue($this->ev($repo)->evaluate($this->policy(5), 1, 100, self::T)->hit);
    }

    public function testLargestThresholdSevenDays(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $repo->report(1, 100, self::T - 6 * 86400);
        $this->assertFalse(
            $this->ev($repo)->evaluate($this->policy(10080), 1, 100, self::T)->hit,
            '静默 6 天，阈值 7 天，不该命中'
        );
    }

    /**
     * 缺 `targetFreshnessMinutes` 必须**抛异常**。
     *
     * 契约要求 policyType=5 时该字段必填且 5<=n<=10080。
     * 若这里当成「永不安静」放过去，配置缺失就变成了**永不发告警** ——
     * 这是最坏的静默失效形式。
     */
    public function testMissingFreshnessThrowsInsteadOfNeverAlerting(): void
    {
        $repo = new InMemoryHeartbeatRepository();
        $this->expectException(\InvalidArgumentException::class);
        $this->ev($repo)->evaluate(['targetType' => 1], 1, 1, self::T);
    }
}
