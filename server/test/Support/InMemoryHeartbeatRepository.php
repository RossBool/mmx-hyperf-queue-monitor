<?php

declare(strict_types=1);

namespace HyperfTest\Support;

use App\Engine\Data\HeartbeatRepository;

/**
 * 内存版心跳仓储。
 *
 * ⚠️ 刻意区分「从未上报」与「上报时间是 0」：
 * `has()` 为 false 时返回 `null`，而 `lastSeenAt` 存了 0 就返回 0。
 * 接口注释里专门说明了这一点，测试桩必须照做 ——
 * 用 0 兜底会让「从未接入」显示成「静默 56 年」，把排查引向错误方向。
 */
final class InMemoryHeartbeatRepository implements HeartbeatRepository
{
    /** @var array<string, int> */
    private array $seen = [];

    public function report(int $targetType, int $targetId, int $ts): void
    {
        $key = $targetType . ':' . $targetId;
        // 只保留最新一次
        $this->seen[$key] = max($this->seen[$key] ?? PHP_INT_MIN, $ts);
    }

    /** 从不写心跳，但**存在**于 seen 里、时间为 0 —— 用于验证 0 与 null 的区别。 */
    public function reportEpochZero(int $targetType, int $targetId): void
    {
        $this->seen[$targetType . ':' . $targetId] = 0;
    }

    public function lastSeenAt(int $targetType, int $targetId): ?int
    {
        return $this->seen[$targetType . ':' . $targetId] ?? null;
    }
}
