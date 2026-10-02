<?php

declare(strict_types=1);
/**
 * 迁移：预置数据（幂等）。
 *
 * 对应 docs/alarm/schema.sql 末尾的 INSERT IGNORE：
 *   - 3 条通知模板（is_preset=1，不可删除）
 *   - 6 条触发条件模板（is_preset=1，可改不可删），与 metrics.md §3 严格一一对应
 * 内容与 schema.sql 逐字一致，同样是「一条 Db::statement() = 一条 INSERT」。
 *
 * down() 只删除系统预置行（is_preset=1 AND creator_id=0），不动用户数据。
 */

use Hyperf\Database\Migrations\Migration;
use Hyperf\DbConnection\Db;

return new class extends Migration
{
    public function up(): void
    {
        Db::statement(
            <<<'SQL'
            INSERT IGNORE INTO `alarm_notification_template`
              (`name`, `remark`, `channels`, `is_preset`, `creator_id`, `creator_name`) VALUES
              ('系统预置-邮件通知', '系统内置，仅邮件通知，接收人需自行补充',
               '[{"channel":1,"receivers":[],"callbackUrl":null,"silenceTime":0}]', 1, 0, 'system'),
              ('系统预置-短信通知', '系统内置，仅短信通知，适合紧急告警',
               '[{"channel":2,"receivers":[],"callbackUrl":null,"silenceTime":0}]', 1, 0, 'system'),
              ('系统预置-回调通知', '系统内置，通过公网回调地址推送告警，需填写 callbackUrl',
               '[{"channel":5,"receivers":[],"callbackUrl":"https://example.com/alarm/callback","silenceTime":0}]', 1, 0, 'system')
            SQL
        );
        Db::statement(
            <<<'SQL'
            INSERT IGNORE INTO `alarm_condition_template`
              (`name`, `remark`, `policy_type`, `conditions`, `is_preset`, `creator_id`, `creator_name`) VALUES
              ('CPU 持续过高',
               '通用：所有 CVM 实例通用。连续 3 个 5 分钟周期 CPU 使用率超过 80% 即触发严重告警，用于发现计算资源打满。',
               2,
               '[{"sort":1,"metricNamespace":"CVM","metricName":"CpuUtilizationRate","operator":">","threshold":80,"period":5,"continuity":3,"level":2,"frequency":30}]',
               1, 0, 'system'),
              ('内存即将耗尽',
               '通用：CVM 通用。连续 3 个 5 分钟周期内存使用率超过 90% 触发紧急告警，预留 OOM 处置时间。',
               2,
               '[{"sort":1,"metricNamespace":"CVM","metricName":"MemoryUsageRate","operator":">","threshold":90,"period":5,"continuity":3,"level":1,"frequency":15}]',
               1, 0, 'system'),
              ('磁盘空间不足',
               '通用：CVM 通用。磁盘使用率是慢变量，采样周期放宽到 60 分钟，连续 2 次超过 85% 触发严重告警。',
               2,
               '[{"sort":1,"metricNamespace":"CVM","metricName":"DiskUsageRate","operator":">","threshold":85,"period":60,"continuity":2,"level":2,"frequency":180}]',
               1, 0, 'system'),
              ('服务错误率升高',
               '通用 Web 服务专用。以 1 分钟粒度采样 5xx 比例，连续 3 次超过 5% 视为发布/依赖异常，触发紧急告警。',
               1,
               '[{"sort":1,"metricNamespace":"WEB","metricName":"Http5xxRatio","operator":">","threshold":5,"period":1,"continuity":3,"level":1,"frequency":15}]',
               1, 0, 'system'),
              ('响应延迟劣化',
               '通用 Web 服务专用。P99 延迟连续 5 个 1 分钟周期超过 1000ms 触发严重告警，比平均值更早暴露长尾问题。',
               1,
               '[{"sort":1,"metricNamespace":"WEB","metricName":"HttpP99Duration","operator":">","threshold":1000,"period":1,"continuity":5,"level":2,"frequency":30}]',
               1, 0, 'system'),
              ('数据库主从延迟异常',
               'MySQL 专用。只读实例复制延迟连续 2 个 1 分钟周期超过 30 秒触发紧急告警，通常指向大事务或主库 IO 瓶颈。',
               4,
               '[{"sort":1,"metricNamespace":"MYSQL","metricName":"MysqlReplicationDelay","operator":">","threshold":30,"period":1,"continuity":2,"level":1,"frequency":30}]',
               1, 0, 'system')
            SQL
        );
    }

    public function down(): void
    {
        Db::statement('DELETE FROM `alarm_notification_template` WHERE `is_preset` = 1 AND `creator_id` = 0');
        Db::statement('DELETE FROM `alarm_condition_template` WHERE `is_preset` = 1 AND `creator_id` = 0');
    }
};
