<?php

declare(strict_types=1);

namespace App\Engine\Data;

/**
 * 心跳仓储（引擎侧）。
 *
 * 心跳由**采集侧写入**、引擎读取。本项目（管理面）不写心跳 ——
 * 契约 §1.2 明确心跳表是引擎与采集侧之间的接口。
 *
 * @see \App\Engine\Evaluator\SilenceEvaluator
 */
interface HeartbeatRepository
{
    /**
     * 某目标最后一次上报心跳的时间戳（秒）。从未上报返回 `null`。
     *
     * ⚠️ 返回 `null` 与返回 `0` 语义**不同**：
     * `null` = 从未上报；`0` = 1970 年上报过。实现方不能图省事用 0 兜底 ——
     * 那样「从未接入」会被算成「静默 56 年」，而 SilenceEvaluator 对两者
     * 给出的原因文案完全不同，排查时会指向错误方向。
     */
    public function lastSeenAt(int $targetType, int $targetId): ?int;
}
