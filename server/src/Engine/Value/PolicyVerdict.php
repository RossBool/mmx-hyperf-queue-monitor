<?php

declare(strict_types=1);

namespace App\Engine\Value;

/**
 * 策略级求值结果：条件明细 + 汇总命中。
 *
 * 把**每条条件**的判据原因都带出来，是因为 `conditionLogic=AND` 时
 * 「整体没命中」本身没有诊断价值 —— 用户需要知道是哪一条拖后腿。
 */
final class PolicyVerdict
{
    /**
     * @param array<int, array{sort:int, hit:bool, reason:string, value:?float, baseline:?float, deviationPercent:?float}> $conditions
     */
    public function __construct(
        public readonly int $policyId,
        public readonly bool $hit,
        public readonly int $level,
        /** 命中的条件里取最高等级（数字最小 = 最严重） */
        public readonly array $conditions,
        /** 条件是否被停用的策略短路（status=0 直接不算） */
        public readonly string $summary,
    ) {
    }

    public function toArray(): array
    {
        return [
            'policyId' => $this->policyId,
            'hit' => $this->hit,
            'level' => $this->level,
            'summary' => $this->summary,
            'conditions' => $this->conditions,
        ];
    }
}
