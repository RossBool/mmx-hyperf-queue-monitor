<?php

declare(strict_types=1);

namespace App\Engine\Evaluator;

use App\Engine\Value\PolicyVerdict;
use App\Engine\Value\Verdict;

/**
 * 策略级汇总：把多条条件的结果按 `conditionLogic` 合成一个告警决策。
 *
 * 契约 §1.8：`conditionLogic=1` 满足所有（AND）/ `=2` 满足任意（OR）。
 *
 * ## 等级取最高severity的原因
 *
 * 契约 §1.3 的 level 是 1/2/3，数字越小越严重。
 * 命中多条时取**最严重**的那条 —— 用户配了「错误率>5% 严重」和
 * 「CPU>90% 提示」两条都命中，告警必须是「严重」，
 * 否则用户会先按提示处理、把真正的严重故障排到最后。
 */
final class PolicyDecisionMaker
{
    public function __construct(
        private readonly PolicyEvaluator $policy,
        private readonly SilenceEvaluator $silence,
    ) {
    }

    /**
     * @param array $strategy 契约 §2.2/§2.3 的策略字段
     * @param int   $targetId 目标实例 id（静默判定用）
     * @param int   $nowTs
     */
    public function evaluate(array $strategy, int $targetId, int $nowTs): PolicyVerdict
    {
        $policyId = (int) ($strategy['id'] ?? 0);

        // ── 停用的策略直接不判 ──────────────────────────────────────
        // ⚠️ 契约 §1.9：status=0 是停用。停用策略**不应**产生任何告警，
        //    但**仍应**被求值路径看到并跳过 —— 放在这里短路，
        //    是为了让「策略被停用」这件事在返回结果里可解释。
        if ((int) ($strategy['status'] ?? 1) === 0) {
            return new PolicyVerdict($policyId, false, 0, [], '策略已停用（status=0），不产生告警');
        }

        // ── 采集静默走独立分支 ──────────────────────────────────────
        // 静默策略**不看指标条件**（契约 §2.1 规则 3：那 6 个字段恒为 null），
        // 所以不能把 conditions 送进 PolicyEvaluator —— 那样只会得到一串
        // 「无数据点」的误导性结果。
        if ((int) ($strategy['policyType'] ?? 0) === 5) {
            return $this->decideSilence($strategy, $targetId, $nowTs);
        }

        $conditions = $strategy['conditions'] ?? [];
        $logic = (int) ($strategy['conditionLogic'] ?? 1);

        $details = [];
        $hits = [];
        foreach ($conditions as $c) {
            $v = $this->policy->evaluateCondition((array) $c, $nowTs);
            $details[] = [
                'sort' => (int) ($c['sort'] ?? 0),
                'hit' => $v->hit,
                'reason' => $v->reason,
                'value' => $v->value,
                'baseline' => $v->baseline,
                'deviationPercent' => $v->deviationPercent,
            ];
            if ($v->hit) {
                $hits[] = $c;
            }
        }

        $hit = $this->combine($logic, $hits, $details);

        return new PolicyVerdict(
            $policyId,
            $hit,
            $hit ? $this->highestLevel($hits) : 0,
            $details,
            $this->summary($logic, $hit, $details)
        );
    }

    private function decideSilence(array $strategy, int $targetId, int $nowTs): PolicyVerdict
    {
        $v = $this->silence->evaluate(
            $strategy,
            (int) ($strategy['targetType'] ?? 0),
            $targetId,
            $nowTs
        );

        // 静默策略的告警等级：取第一条命中条件的 level（静默条件的 level 仍有意义）
        $level = 0;
        if ($v->hit) {
            foreach (($strategy['conditions'] ?? []) as $c) {
                $level = (int) ($c['level'] ?? 0);
                break;
            }
        }

        return new PolicyVerdict(
            (int) ($strategy['id'] ?? 0),
            $v->hit,
            $level,
            [['sort' => 0, 'hit' => $v->hit, 'reason' => $v->reason, 'value' => $v->value, 'baseline' => $v->baseline, 'deviationPercent' => $v->deviationPercent]],
            $v->reason
        );
    }

    /**
     * AND/OR 合成。
     *
     * ⚠️ OR 模式下**不需要**全部条件都判过 —— 有一条命中就够了。
     *    但这里仍然把每条都判了，因为 `details` 要给排查用：
     *    「策略没报」时，用户需要知道每条条件各自什么情况。
     *    代价是 OR 策略也要全查；可以后续加短路优化，
     *    但那会让 details 不完整，权衡下来先保可解释性。
     */
    private function combine(int $logic, array $hits, array $details): bool
    {
        if ($hits === []) {
            return false;
        }

        return $logic === 2
            ? true                    // OR：任一命中即可
            : count($hits) === count($details); // AND：必须全中
    }

    /** 命中条件里取**最严重**的等级（数字最小 = 最严重）。 */
    private function highestLevel(array $hits): int
    {
        $levels = array_map(static fn ($c): int => (int) ($c['level'] ?? 0), $hits);
        $levels = array_filter($levels, static fn (int $l): bool => $l > 0);

        return $levels === [] ? 0 : min($levels);
    }

    private function summary(int $logic, bool $hit, array $details): string
    {
        $total = count($details);
        $hitCount = count(array_filter($details, static fn (array $d): bool => $d['hit']));

        if (!$hit) {
            return sprintf('未命中（%s，%d/%d 条条件满足）', $logic === 2 ? 'OR' : 'AND', $hitCount, $total);
        }

        return sprintf('命中（%s，%d/%d 条条件满足）', $logic === 2 ? 'OR' : 'AND', $hitCount, $total);
    }
}
