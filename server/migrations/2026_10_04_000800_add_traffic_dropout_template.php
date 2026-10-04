<?php

declare(strict_types=1);
/**
 * 迁移：追加第 7 条预置触发条件模板「流量断流」。
 *
 * ## 为什么是**新文件**而不是改 000700
 *
 * 000700 已经在别的环境执行过。改已应用的迁移文件不会重跑，
 * 改动只对**新部署**生效 —— 这是 `alarm_condition_template` 少一条模板的经典成因。
 * 每个迁移文件的 docblock 里都写着「改结构必须新建迁移文件」，这条对 seed 数据同样成立。
 *
 * ## 为什么需要第 7 条
 *
 * `WEB.HttpRequestCount` 的 `defaultOperator` 是 `>` 阈值 10000，
 * 它能发现「QPS 冲到一万」，**发现不了「QPS 归零」**。
 * 而「进程存活、健康检查通过、却一个请求都处理不了」是真实存在的故障形态。
 *
 * 理论上 `WEB.HttpSuccessRate`（`&lt; 99`）能兜底，但 QPS=0 时分母也是 0，
 * 不同监控系统对该情形的取值约定不统一（部分实现返回 100%）——
 * 依赖语义未定义的指标去兜底最严重的故障是不可接受的。
 *
 * 详见 `docs/alarm/metrics-gap-analysis.md` §1 A-1。
 *
 * ## 幂等
 *
 * `INSERT IGNORE` + 唯一键 `uk_condition_template`（按 `name` 去重），重跑不产生重复。
 * 与 up() 中其他迁移一致的 try/finally 包裹 `SET FOREIGN_KEY_CHECKS`（S-17）。
 */
use Hyperf\Database\Migrations\Migration;
use Hyperf\DbConnection\Db;

return new class extends Migration
{
    public function up(): void
    {
        try {
            Db::statement('SET FOREIGN_KEY_CHECKS = 0');
            Db::statement(
                <<<'SQL'
                INSERT IGNORE INTO `alarm_condition_template`
                  (`name`, `remark`, `policy_type`, `conditions`, `is_preset`, `creator_id`, `creator_name`) VALUES
                  ('流量断流',
                   '通用 Web 服务专用。QPS 连续 2 个 1 分钟周期低于 1 触发紧急告警。用于捕获「进程存活、健康检查通过，但一个请求都处理不了」的断流故障——这类故障无法被 HttpRequestCount 的正向阈值（> 10000）发现。低峰期为空的内部系统请勿使用，应改用同比/环比判据（v1.1 立项）。',
                   1,
                   '[{"sort":1,"metricNamespace":"WEB","metricName":"HttpRequestCount","operator":"<","threshold":1,"period":1,"continuity":2,"level":1,"frequency":15}]',
                   1, 0, 'system')
                SQL
            );
        } finally {
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }

    /**
     * ⚠️ **不是 `up()` 的严格逆操作**（与 000700 同样的已知取舍）：
     * 只按 `name = '流量断流'` 精确删除，**不碰其他预置模板**，也不碰用户数据。
     * 若用户已基于该模板创建了策略，`alarm_policy.condition_template_id`
     * 没有外键约束 → 会留下悬空引用（审查 S-16 记录了同类问题）。
     * 因此这里刻意用精确 name 匹配而非 `is_preset=1` 批量删。
     */
    public function down(): void
    {
        try {
            Db::statement('SET FOREIGN_KEY_CHECKS = 0');
            Db::statement('DELETE FROM `alarm_condition_template` WHERE `name` = \'流量断流\' AND `is_preset` = 1');
        } finally {
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
};
