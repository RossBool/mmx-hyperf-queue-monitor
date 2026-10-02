<?php

declare(strict_types=1);

namespace App\Service;

use App\Constants\AlarmEnum;
use App\Support\Presenter;
use App\Support\Time;
use Hyperf\DbConnection\Db;

/**
 * 首页统计服务 —— 契约 §3.3 ⑲。
 *
 * 统计范围固定为「当前用户有权限的全部数据」（契约未定义权限服务，
 * 接入后需在这两个查询上追加 project_id 过滤 —— 见契约 deliverable 风险 R7）。
 *
 * ⚠️ 性能约束：SQL **不能有笛卡尔积**。因此拆成 3 条互不 join 的聚合查询：
 *   1. alarm_history 的今日两值（total / unhandled）—— 一次扫描出两个数
 *   2. alarm_history 的今日等级分布 —— 一次 GROUP BY
 *   3. alarm_history 的近 7 天趋势 —— 一次 GROUP BY
 *   4. alarm_policy 的总数 / 启用数 —— 一次条件聚合
 * 全部命中 idx_history_status_triggered / idx_history_level_triggered /
 * idx_history_triggered_id / idx_policy_status_level_created。
 */
class AlarmOverviewService
{
    public function overview(): array
    {
        $todayStart = Time::todayStart();
        $sevenDaysAgoStart = Time::dayStartOfDaysAgo(6);

        // ---- 1. 今日总数 / 未处理数：一次扫描出两个值，避免两次 count ----
        $today = Db::table('alarm_history')
            ->selectRaw('COUNT(*) AS total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS unhandled', [
                AlarmEnum::HISTORY_STATUS_UNHANDLED,
            ])
            ->where('triggered_at', '>=', $todayStart)
            ->first();

        // ---- 2. 策略总数 / 启用数：一次条件聚合，不 join ----
        $policy = Db::table('alarm_policy')
            ->selectRaw('COUNT(*) AS total, SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS enabled')
            ->first();

        // ---- 3. 今日等级分布：固定 3 项、level 升序，无数据补 0 ----
        $levelRows = Db::table('alarm_history')
            ->selectRaw('level, COUNT(*) AS cnt')
            ->where('triggered_at', '>=', $todayStart)
            ->groupBy('level')
            ->get();
        $levelMap = [];
        foreach ($levelRows as $row) {
            $levelMap[(int) $row->level] = (int) $row->cnt;
        }
        $levelDistribution = [];
        foreach (array_keys(AlarmEnum::LEVEL) as $level) {
            $levelDistribution[] = [
                'level' => $level,
                'levelCn' => AlarmEnum::LEVEL[$level],
                'count' => $levelMap[$level] ?? 0,
            ];
        }

        // ---- 4. 近 7 天趋势：固定 7 项、date 升序，无数据补 0 ----
        $trendRows = Db::table('alarm_history')
            ->selectRaw('DATE(triggered_at) AS d, COUNT(*) AS total, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS unhandled', [
                AlarmEnum::HISTORY_STATUS_UNHANDLED,
            ])
            ->where('triggered_at', '>=', $sevenDaysAgoStart)
            ->groupBy('d')
            ->get();
        $trendMap = [];
        foreach ($trendRows as $row) {
            $trendMap[(string) $row->d] = [
                'total' => (int) $row->total,
                'unhandled' => (int) $row->unhandled,
            ];
        }
        $trend7Days = [];
        for ($i = 6; $i >= 0; $i--) {
            $date = Time::date($i);
            $bucket = $trendMap[$date] ?? ['total' => 0, 'unhandled' => 0];
            $trend7Days[] = [
                'date' => $date,
                'total' => $bucket['total'],
                'unhandled' => $bucket['unhandled'],
            ];
        }

        return Presenter::overview([
            'todayTotal' => (int) ($today->total ?? 0),
            'todayUnhandled' => (int) ($today->unhandled ?? 0),
            'policyTotal' => (int) ($policy->total ?? 0),
            'policyEnabledTotal' => (int) ($policy->enabled ?? 0),
            'levelDistribution' => $levelDistribution,
            'trend7Days' => $trend7Days,
        ]);
    }
}
