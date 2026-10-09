<?php

declare(strict_types=1);

namespace App\Engine\Data;

/**
 * 采样序列仓储（引擎侧）。
 *
 * ## 为什么是接口而不是直接查表
 *
 * 引擎的求值逻辑必须能脱离数据库单测 —— 而更重要的是，
 * **告警引擎本来就该独立部署**（它有自己的一致性要求、自己的伸缩节奏）。
 * 管理面（本项目）不执行判定，判定方只需要一个「按时间范围取采样」的契约。
 *
 * 实现方可以是时序库（InfluxDB / VictoriaMetrics）、也可以是本项目的 MySQL。
 * 这里不选边。
 */
interface SampleRepository
{
    /**
     * 取「窗口起点在 [from, to] 内」的采样，按时间**升序**返回。
     *
     * 闭区间。⚠️ 端点必须是**闭区间**而不是左闭右开：
     * 环比取「前 N 个周期」时，相邻窗口的边界点必须能同时被两个窗口引用，
     * 否则基线会少一个点，而少一个点不会报错，只会让基线算错一点点 ——
     * 这种错极难发现。
     *
     * @return \App\Engine\Value\Sample[]
     */
    public function fetch(string $namespace, string $metricName, int $period, int $fromTs, int $toTs): array;
}
