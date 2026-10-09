<?php

declare(strict_types=1);

namespace App\Engine\Evaluator;

use App\Engine\Data\SampleRepository;
use App\Engine\Value\Sample;
use App\Engine\Value\Verdict;

/**
 * 策略级求值：把契约的 `period` / `continuity` / `baselineType` 落到具体时间轴上。
 *
 * ## 语义定义（这里写清楚，因为契约只给了字段定义）
 *
 * **单点求值**：`period=p` 意味着每个采样点代表 `[t-p*60, t)` 这个窗口的统计值。
 * `period=5` 时，`t` 时刻的点是最近 5 分钟的聚合。
 *
 * **基线定位**：
 * | baselineType | 基线位置 |
 * | --- | --- |
 * | `period` | 往前 `baselineCount` 个 `period` 窗口的那**一个**窗口 |
 * | `day` | 前 1 天同一时刻的窗口 |
 * | `week` | 前 1 周同一时刻的窗口 |
 *
 * 契约 §1.5.3 明确「`n=1` 表示与前一个周期比」，所以基线是**单个窗口**而非 N 个窗口的均值 ——
 * 否则 `n=1` 会变成「和前 2 个窗口的均值比」，与契约描述不符。
 *
 * **连续性**：`continuity=N` 表示条件在最近 N 个**评估时刻**上都成立。
 * 评估时刻 = `now, now-p, ..., now-(N-1)p`。
 *
 * ⚠️ 每个评估时刻都有**自己的**基线（基线随时间平移）。
 *    用「最新一个基线」去回测历史点是错的：昨天 9:00 的基线不是今天 9:00 的基线。
 *    代价是 N 次求值、N 组数据读取 —— 用正确性换性能，这笔交易在告警系统里划算。
 */
final class PolicyEvaluator
{
    private const SEC_PER_MIN = 60;
    private const SEC_PER_DAY = 86400;
    private const SEC_PER_WEEK = 604800;

    public function __construct(
        private readonly ConditionEvaluator $condition,
        private readonly SampleRepository $samples,
    ) {
    }

    /**
     * 求值一条条件在 $nowTs 时刻的结果。
     *
     * @param array $condition 契约 §2.1 的条件对象（已通过 ConditionValidator 校验的形态）
     */
    public function evaluateCondition(array $condition, int $nowTs): Verdict
    {
        $period = (int) ($condition['period'] ?? 1);
        $periodSec = $period * self::SEC_PER_MIN;
        $continuity = max(1, (int) ($condition['continuity'] ?? 1));

        $latest = null;
        for ($i = 0; $i < $continuity; $i++) {
            // 从最早的评估时刻往回推，保证「最新一个」最后算、最后返回
            $t = $nowTs - ($continuity - 1 - $i) * $periodSec;
            $v = $this->evaluateAt($condition, $t);

            if (! $v->hit) {
                return Verdict::miss(sprintf(
                    '连续性不足：%d 个评估时刻中，第 %d 个（%s）未命中。%s',
                    $continuity,
                    $i + 1,
                    gmdate('m-d H:i', $t),
                    $v->reason
                ), $v->value, $v->baseline, $v->deviationPercent);
            }

            $latest = $v;
        }

        if ($continuity === 1) {
            return $latest;
        }

        return Verdict::hit(
            $latest->value,
            $latest->baseline,
            $latest->deviationPercent,
            sprintf('连续 %d 个评估时刻均命中。%s', $continuity, $latest->reason)
        );
    }

    /** 在**单个**时刻上求值（不含连续性）。 */
    private function evaluateAt(array $condition, int $t): Verdict
    {
        $current = $this->sampleAt($condition, $t);
        if ($current === null) {
            return Verdict::miss(sprintf('%s 时刻无数据点', gmdate('m-d H:i', $t)));
        }

        $operator = (string) ($condition['operator'] ?? '>');
        $threshold = (float) ($condition['threshold'] ?? 0);

        if (($condition['compareMode'] ?? 'absolute') !== 'relative') {
            return $this->condition->evaluateAbsolute([$current->value], $operator, $threshold);
        }

        return $this->condition->evaluateRelative(
            [$current->value],
            $this->baselineSamples($condition, $t),
            $operator,
            $threshold,
            (string) ($condition['baselineType'] ?? 'period'),
            (int) ($condition['baselineCount'] ?? 1),
        );
    }

    /** 取 $t 时刻那个窗口的采样值。 */
    private function sampleAt(array $condition, int $t): ?Sample
    {
        $ns = (string) ($condition['metricNamespace'] ?? '');
        $name = (string) ($condition['metricName'] ?? '');
        if ($ns === '' || $name === '') {
            return null;
        }

        $period = (int) ($condition['period'] ?? 1);
        $samples = $this->samples->fetch($ns, $name, $period, $t, $t);

        return $samples === [] ? null : $samples[count($samples) - 1];
    }

    /**
     * 基线窗口。
     *
     * @return Sample[] 空数组 = 基线窗口无数据，交给 ConditionEvaluator 按契约判不命中
     */
    private function baselineSamples(array $condition, int $t): array
    {
        $period = (int) ($condition['period'] ?? 1);
        $periodSec = $period * self::SEC_PER_MIN;
        $type = (string) ($condition['baselineType'] ?? 'period');

        $offset = match ($type) {
            'period' => (int) ($condition['baselineCount'] ?? 1) * $periodSec,
            'day' => self::SEC_PER_DAY,
            'week' => self::SEC_PER_WEEK,
            // ⚠️ 未知类型必须炸。静默降级成「基线=当前值」会算出 deviation=0，
            //    表现为「条件永不触发」—— 这种静默失效排查起来最费时间。
            default => throw new \InvalidArgumentException('未知 baselineType：' . var_export($type, true)),
        };

        $at = $t - $offset;

        return $this->samples->fetch(
            (string) $condition['metricNamespace'],
            (string) $condition['metricName'],
            $period,
            $at,
            $at
        );
    }
}
