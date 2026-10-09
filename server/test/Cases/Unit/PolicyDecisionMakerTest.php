<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Engine\Evaluator\ConditionEvaluator;
use App\Engine\Evaluator\PolicyDecisionMaker;
use App\Engine\Evaluator\PolicyEvaluator;
use App\Engine\Evaluator\SilenceEvaluator;
use HyperfTest\Support\InMemoryHeartbeatRepository;
use HyperfTest\Support\InMemorySampleRepository;
use PHPUnit\Framework\TestCase;

/**
 * 策略级汇总：conditionLogic 的 AND/OR、等级取值、停用短路、静默分支。
 */
final class PolicyDecisionMakerTest extends TestCase
{
    private const T = 1767225600;
    private const MIN = 60;

    private function make(array $rows = [], int $period = 5): PolicyDecisionMaker
    {
        $repo = new InMemorySampleRepository($rows, period: $period);
        $policyEval = new PolicyEvaluator(new ConditionEvaluator(), $repo);
        $silenceEval = new SilenceEvaluator(new InMemoryHeartbeatRepository());

        return new PolicyDecisionMaker($policyEval, $silenceEval);
    }

    private function cond(int $sort, float $threshold, int $level = 2, array $over = []): array
    {
        return array_merge([
            'sort' => $sort,
            'metricNamespace' => 'CVM',
            'metricName' => 'CpuUtilizationRate',
            'operator' => '>',
            'threshold' => $threshold,
            'period' => 5,
            'continuity' => 1,
            'level' => $level,
            'frequency' => 15,
        ], $over);
    }

    private function strategy(array $over = []): array
    {
        return array_merge([
            'id' => 1,
            'status' => 1,
            'policyType' => 2,
            'conditionLogic' => 1,
            'conditions' => [],
        ], $over);
    }

    // ── AND ─────────────────────────────────────────────────────────

    public function testAndRequiresAllConditionsToHit(): void
    {
        $dm = $this->make([
            ['ts' => self::T, 'value' => 90.0],   // 命中 >80
            ['ts' => self::T, 'value' => 90.0],   // 同点
        ]);
        // 两条都指向同一时间点同一指标，所以只能一条命中；
        // 用不同阈值制造一条中一条不中。
        $dm = $this->make([['ts' => self::T, 'value' => 90.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 1,
            'conditions' => [
                $this->cond(1, 80.0),   // 90 > 80 命中
                $this->cond(2, 95.0),   // 90 > 95 不中
            ],
        ]), 0, self::T);

        $this->assertFalse($v->hit, 'AND 需要两条都中');
        $this->assertStringContainsString('AND', $v->summary);
        $this->assertCount(2, $v->conditions);
    }

    public function testAndHitsWhenAllHit(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 90.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 1,
            'conditions' => [
                $this->cond(1, 80.0),
                $this->cond(2, 50.0),
            ],
        ]), 0, self::T);

        $this->assertTrue($v->hit);
        $this->assertStringContainsString('2/2', $v->summary);
    }

    // ── OR ──────────────────────────────────────────────────────────

    public function testOrHitsWhenAnyConditionHits(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 90.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 2,
            'conditions' => [
                $this->cond(1, 80.0),   // 命中
                $this->cond(2, 95.0),   // 不中
            ],
        ]), 0, self::T);

        $this->assertTrue($v->hit, 'OR 任一命中即可');
        $this->assertStringContainsString('OR', $v->summary);
    }

    public function testOrMissesWhenNoneHit(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 10.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 2,
            'conditions' => [
                $this->cond(1, 80.0),
                $this->cond(2, 50.0),
            ],
        ]), 0, self::T);

        $this->assertFalse($v->hit);
    }

    // ── 等级 ────────────────────────────────────────────────────────

    /**
     * 命中多条时取**最严重**（数字最小）。
     * ⚠️ 数字越小越严重（契约 §1.3：1=严重 2=提示 3=通知）。
     * 若取 max 或取最后一条，用户会把严重故障当通知处理。
     */
    public function testLevelTakesMostSevereAmongHits(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 90.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 2,
            'conditions' => [
                $this->cond(1, 80.0, 3),   // 通知
                $this->cond(2, 50.0, 1),   // 严重
                $this->cond(3, 40.0, 2),   // 提示
            ],
        ]), 0, self::T);

        $this->assertTrue($v->hit);
        $this->assertSame(1, $v->level, '三条都命中，等级应取最严重的 1');
    }

    public function testLevelIsZeroWhenNotHit(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 10.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 1,
            'conditions' => [$this->cond(1, 80.0, 1)],
        ]), 0, self::T);

        $this->assertFalse($v->hit);
        $this->assertSame(0, $v->level, '未命中时等级应为 0，不应残留某条条件的等级');
    }

    // ── 停用短路 ────────────────────────────────────────────────────

    public function testDisabledPolicyNeverAlerts(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 999.0]]);
        $v = $dm->evaluate($this->strategy([
            'status' => 0,
            'conditionLogic' => 1,
            'conditions' => [$this->cond(1, 80.0)],
        ]), 0, self::T);

        $this->assertFalse($v->hit, '停用策略即使条件全中也不该告警');
        $this->assertStringContainsString('已停用', $v->summary);
    }

    // ── 静默分支 ────────────────────────────────────────────────────

    /**
     * 静默策略**不走**指标条件。
     *
     * ⚠️ 静默条件的 metricNamespace/metricName 恒为 null（契约 §2.1 规则 3）。
     *    若把 conditions 送进 PolicyEvaluator，只会得到一串
     *    「无数据点」的误导结果；这里必须走 SilenceEvaluator。
     */
    public function testSilencePolicyUsesHeartbeatNotMetrics(): void
    {
        $repo = new InMemorySampleRepository([['ts' => self::T, 'value' => 999.0]], period: 5);
        $heartbeat = new InMemoryHeartbeatRepository();
        $heartbeat->report(1, 100, self::T - 3600);  // 1 小时没上报，阈值 30 分钟

        $dm = new PolicyDecisionMaker(
            new PolicyEvaluator(new ConditionEvaluator(), $repo),
            new SilenceEvaluator($heartbeat)
        );

        $v = $dm->evaluate($this->strategy([
            'policyType' => 5,
            'targetType' => 1,
            'targetFreshnessMinutes' => 30,
            'conditions' => [[
                'sort' => 1, 'period' => 5, 'continuity' => 1, 'level' => 2, 'frequency' => 15,
                'metricNamespace' => null, 'metricName' => null,
                'operator' => null, 'threshold' => null,
            ]],
        ]), 100, self::T);

        $this->assertTrue($v->hit, '心跳 1 小时没上报 > 30 分钟阈值，应命中');
        $this->assertSame(2, $v->level, '静默策略的等级取自其条件');
    }

    public function testSilencePolicyWithFreshHeartbeatDoesNotAlert(): void
    {
        $heartbeat = new InMemoryHeartbeatRepository();
        $heartbeat->report(1, 100, self::T);
        $dm = new PolicyDecisionMaker(
            new PolicyEvaluator(new ConditionEvaluator(), new InMemorySampleRepository([], period: 5)),
            new SilenceEvaluator($heartbeat)
        );

        $v = $dm->evaluate($this->strategy([
            'policyType' => 5, 'targetType' => 1, 'targetFreshnessMinutes' => 30,
            'conditions' => [['sort' => 1, 'period' => 5, 'continuity' => 1, 'level' => 2, 'frequency' => 15]],
        ]), 100, self::T);

        $this->assertFalse($v->hit);
    }

    // ── 诊断信息 ────────────────────────────────────────────────────

    /** 无论命中与否，每条条件的原因都要给出来 —— 这是排查的第一手材料。 */
    public function testEveryConditionAlwaysCarriesReason(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 42.0]]);
        $v = $dm->evaluate($this->strategy([
            'conditionLogic' => 1,
            'conditions' => [
                $this->cond(1, 80.0),
                ['sort' => 2, 'metricNamespace' => null, 'metricName' => null,
                 'operator' => null, 'threshold' => null, 'period' => 5, 'continuity' => 1, 'level' => 2, 'frequency' => 15],
            ],
        ]), 0, self::T);

        $this->assertCount(2, $v->conditions);
        foreach ($v->conditions as $c) {
            $this->assertNotSame('', $c['reason'], "sort={$c['sort']} 的原因不能为空");
        }
    }

    public function testToArrayIsJsonEncodable(): void
    {
        $dm = $this->make([['ts' => self::T, 'value' => 90.0]]);
        $v = $dm->evaluate($this->strategy(['conditions' => [$this->cond(1, 80.0)]]), 0, self::T);
        $json = json_encode($v->toArray(), JSON_UNESCAPED_UNICODE);
        $this->assertIsString($json);
        $decoded = json_decode($json, true);
        $this->assertTrue($decoded['hit']);
        $this->assertArrayHasKey('conditions', $decoded);
    }
}
