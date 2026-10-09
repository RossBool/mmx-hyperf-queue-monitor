<?php

declare(strict_types=1);

namespace App\Engine\Evaluator;

use App\Engine\Value\Sample;
use App\Engine\Value\Verdict;

/**
 * 单条条件的判据求值器。
 *
 * 实现契约 §1.5 与 §1.5.1-1.5.4。**逐条对照写，不按记忆写。**
 *
 * ```
 * absolute : 命中 ⟺ value OP threshold
 * relative : baseline = 按 baselineType 取参考窗口均值
 *            deviation = (value - baseline) / baseline × 100%
 *            命中 ⟺ deviation OP threshold
 * ```
 *
 * 契约 §1.5.4 明列三条**极易实现错**的边界，这里逐条实现并单测：
 *
 * | 情况 | 判定 | 契约给的理由 |
 * | --- | --- | --- |
 * | `baseline == 0` | 不命中 | 除以 0 无意义，此场景应改用 absolute |
 * | 基线窗口无数据 | 不命中 | 宁可漏报，也不要用「0 当基线」算出天文数字偏离 |
 * | `baseline < 0` | `abs(value-baseline)/abs(baseline)` | 直接除会在负基数下符号翻转，语义反了 |
 */
final class ConditionEvaluator
{
    /**
     * 求值一条**绝对判据**。
     *
     * @param float[] $samples  按时间**升序**排列，最近的在末尾
     */
    public function evaluateAbsolute(array $samples, string $operator, float $threshold): Verdict
    {
        $value = $this->latest($samples);
        if ($value === null) {
            return Verdict::miss('无数据点');
        }

        $hit = $this->compare($value, $operator, $threshold);
        $desc = sprintf('%.4g %s %.4g', $value, $operator, $threshold);

        return $hit
            ? Verdict::hit($value, null, null, '绝对阈值命中：' . $desc)
            : Verdict::miss('绝对阈值未命中：' . $desc, $value);
    }

    /**
     * 求值一条**相对判据**。
     *
     * @param float[] $samples   当前窗口的采样值（升序，最近的在末尾）
     * @param Sample[] $baselineSamples 基线窗口的采样（升序）
     */
    /** @param Sample[] $baselineSamples */
    public function evaluateRelative(
        array $samples,
        array $baselineSamples,
        string $operator,
        float $threshold,
        string $baselineType,
        int $baselineCount,
    ): Verdict {
        $value = $this->latest($samples);
        if ($value === null) {
            return Verdict::miss('无数据点');
        }

        // ── 边界 ①：基线窗口无数据 → 不命中 ────────────────────────
        // 契约原文：「宁可漏报，也不要用『0 当基线』算出天文数字偏离」。
        // 若这里退化成 baseline=0，deviation 会是 ±INF，
        // 而 `INF > 30` 为真 → **每次都告警**，比不告警还糟。
        if ($baselineSamples === []) {
            return Verdict::miss('基线窗口无数据，按契约不命中（勿用 0 代替基线）', $value);
        }

        $baseline = $this->mean(array_map(static fn (Sample $s): float => $s->value, $baselineSamples));

        // ── 边界 ②：基线恰为 0 → 不命中 ────────────────────────────
        // 除以 0 在 PHP 8 里是 DivisionByZeroError（不是 INF），
        // 抛出去会让整次求值挂掉。必须在这里显式拦。
        if (abs($baseline) < 1e-12) {
            return Verdict::miss(sprintf('基线≈0（%.6g），除法无意义，按契约不命中', $baseline), $value, $baseline);
        }

        // ── 边界 ③：基线为负 → 用绝对值分母，否则符号翻转 ──────────
        // 例：value=-20, baseline=-100。
        //   错误算法 (v-b)/b  = 80/-100 = -0.8  → 「跌了 80%」，**完全说反**
        //   正确算法 |v-b|/|b| = 80/100   = +0.8  → 「涨了 80%」
        //   而 (v-b)/|b|      = 80/100    = +0.8  （等价，且保留方向）
        // 本实现用 (v-b)/|b|：分母取绝对值，分子保留符号，
        // 这样「上涨为正、下跌为负」的方向语义在正负基线上都成立。
        $deviation = ($value - $baseline) / abs($baseline) * 100.0;

        $hit = $this->compare($deviation, $operator, $threshold);
        $desc = sprintf('相对%s基线%.4g 偏离 %+.2f%% %s %.4g%%',
            $this->baselineLabel($baselineType, $baselineCount), $baseline, $deviation, $operator, $threshold);

        return $hit
            ? Verdict::hit($value, $baseline, $deviation, '相对判据命中：' . $desc)
            : Verdict::miss('相对判据未命中：' . $desc, $value, $baseline, $deviation);
    }

    /**
     * 取最新的采样值。
     *
     * ⚠️ 调用方必须保证**末尾是最新**。引擎不做排序：
     *    排序一次 O(n log n)，而基线窗口和当前窗口会反复扫同一批数据。
     *    约定优于隐藏的排序。
     */
    private function latest(array $samples): ?float
    {
        if ($samples === []) {
            return null;
        }
        $last = $samples[count($samples) - 1];

        return is_array($last) ? (float) $last : (float) $last;
    }

    /**
     * 六种比较关系。
     *
     * ⚠️ **不用** `match($op) { '>' => $a > $b, ... }` 配 `??` 兜底 ——
     *    未知算子会静默走到兜底分支（假设不命中），
     *    表现为「条件永远不触发」，而不是报错。
     *    非法算子必须**炸出来**：枚举已由 ConditionValidator 校验过，
     *    到这里出现非法值说明数据被绕过校验改过，属于必须暴露的情况。
     */
    private function compare(float $left, string $operator, float $right): bool
    {
        return match ($operator) {
            '>' => $left > $right,
            '>=' => $left >= $right,
            '<' => $left < $right,
            '<=' => $left <= $right,
            '==' => $left == $right,
            // ⚠️ `!=` 用松散比较是有意的：DB 里 threshold 是 DECIMAL(20,4)，
            //    回读可能是 0.1+0.2 这种浮点残差。严格 !== 会永远为 true。
            '!=' => $left != $right,
            default => throw new \InvalidArgumentException('未知比较算子：' . var_export($operator, true)),
        };
    }

    /** @param float[] $values */
    private function mean(array $values): float
    {
        if ($values === []) {
            return 0.0;
        }

        return array_sum($values) / count($values);
    }

    private function baselineLabel(string $type, int $count): string
    {
        return match ($type) {
            'period' => sprintf('前 %d 个周期', max(1, $count)),
            'day' => '昨日同期',
            'week' => '上周同期',
            default => $type,
        };
    }
}
