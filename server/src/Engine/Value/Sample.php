<?php

declare(strict_types=1);

namespace App\Engine\Value;

/**
 * 时间序列上的一个采样点。
 *
 * ## 为什么用**只读**值对象而不是数组
 *
 * 引擎要反复读同一批采样（基线窗口、连续性判定各扫一遍），
 * 用数组的话每次都要 `$s['value']` 拼写，纯属自找拼写错误。
 * 更重要的是：值对象可以在构造时就把**非法输入挡掉**，
 * 而数组做不到 —— `['value' => 'abc']` 要等到做算术时才炸。
 */
final class Sample
{
    public function __construct(
        /** Unix 时间戳（秒）。**必须**是 period 对齐的窗口起点。 */
        public readonly int $timestamp,
        public readonly float $value,
    ) {
        if (! is_finite($value)) {
            // NaN / INF 混进基线均值会让结果静默变成 NaN，
            // 而 `NaN > x` 恒为 false —— 表现为「永远不告警」，极难排查。
            throw new \InvalidArgumentException('采样值必须是有限数，收到 ' . var_export($value, true));
        }
    }
}
