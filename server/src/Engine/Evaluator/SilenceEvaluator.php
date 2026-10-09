<?php

declare(strict_types=1);

namespace App\Engine\Evaluator;

use App\Engine\Data\HeartbeatRepository;
use App\Engine\Value\Verdict;

/**
 * 采集静默（F 类）判定。
 *
 * 契约 §1.2 / §2.3：`policyType=5` 的策略不看指标，看**心跳**。
 *
 * ```
 * 命中 ⟺ (now - 最后一次心跳) > targetFreshnessMinutes × 60
 * ```
 *
 * ## 关键设计：静默判定**不要求**该目标曾经有心跳
 *
 * 一个刚创建、采集侧还没上报过任何心跳的目标，`lastHeartbeat` 是 null。
 * 此时 `now - null` 无意义。两种选择：
 *   - 判「不命中」→ 采集侧完全没接上时**永远不告警**，回到 F 类要解决的原问题
 *   - 判「命中」→ 刚建策略就报一条「从未上报」，噪音但方向对
 *
 * 本实现取**命中**，理由是 F 类缺口的核心危害是「所有故障都不被发现，
 * 且系统看起来一切正常」。「看起来一切正常」正是必须消除的状态。
 * 首次心跳到达后行为自然转为正常，不再报警。
 */
final class SilenceEvaluator
{
    public function __construct(private readonly HeartbeatRepository $heartbeats)
    {
    }

    /**
     * @param array $policy 契约 §2.3 的策略字段：targetFreshnessMinutes（必填）
     * @param int   $targetType 1CVM 2CLB 3MySQL 4WEB
     * @param int   $targetId   目标实例 id
     */
    public function evaluate(array $policy, int $targetType, int $targetId, int $nowTs): Verdict
    {
        $freshness = (int) ($policy['targetFreshnessMinutes'] ?? 0);
        if ($freshness <= 0) {
            // 契约要求 policyType=5 时该字段必填且 5<=n<=10080。
            // 到这里为 0 说明数据绕过了校验 —— 不能当成「永不安静」放过去。
            throw new \InvalidArgumentException('采集静默策略缺少 targetFreshnessMinutes');
        }

        $last = $this->heartbeats->lastSeenAt($targetType, $targetId);

        if ($last === null) {
            return Verdict::hit(null, null, null, sprintf(
                '目标 %d/%d 从未上报过心跳 —— 按契约判为静默（采集侧可能未接入）',
                $targetType,
                $targetId
            ));
        }

        $silentSec = $nowTs - $last;
        $thresholdSec = $freshness * 60;

        if ($silentSec > $thresholdSec) {
            return Verdict::hit((float) $silentSec, (float) $last, null, sprintf(
                '已静默 %d 分钟，超过阈值 %d 分钟（最后心跳 %s）',
                intdiv($silentSec, 60),
                $freshness,
                gmdate('m-d H:i', $last)
            ));
        }

        return Verdict::miss(sprintf(
            '已静默 %d 分钟，未超过阈值 %d 分钟（最后心跳 %s）',
            intdiv($silentSec, 60),
            $freshness,
            gmdate('m-d H:i', $last)
        ), (float) $silentSec, (float) $last);
    }
}
