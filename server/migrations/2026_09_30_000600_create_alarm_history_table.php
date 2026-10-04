<?php

declare(strict_types=1);
/**
 * 迁移：建表 `alarm_history`（告警历史）。
 *
 * DDL 与 docs/alarm/schema.sql **逐字一致**（列名 / 类型 / DEFAULT / 索引 / 外键 / CHECK 全部照抄，
 * 只有 `--` 行注释被剥离，列级 `COMMENT '...'` 属于语句本身已保留）。
 * ⚠️ 不要用 Blueprint 构造器改写：hyperf/database 3.2 的 Blueprint 无法表达
 *    CHECK 约束与 JSON 列的 `DEFAULT NULL`，改写会导致字段漂移。
 *
 * 执行方式：单条 `Db::statement()` 承载**一条** CREATE TABLE 语句。
 * ⚠️ 绝不能把整份 schema.sql 塞进一次 statement()：Connection::statement() 走
 *    `getPdo()->prepare()`，PDO 预处理语句不接受分号分隔的多语句。
 *
 * 幂等性：`up()` 用 `CREATE TABLE IF NOT EXISTS`，**重跑不会清空数据**。
 * 文件序号保证 alarm_policy 先于 alarm_policy_condition 建表（后者有 FK 指向前者）；
 * 此外 `up()`/`down()` 都被 `SET FOREIGN_KEY_CHECKS=0/1` 包裹并用 try/finally 恢复，
 * 因此即使文件乱序执行、或上一轮迁移中途失败留下残留子表，也不会 errno 3730 卡死。
 */

use Hyperf\Database\Migrations\Migration;
use Hyperf\DbConnection\Db;

return new class extends Migration
{
    public function up(): void
    {
        // S-07：幂等且非破坏。原实现是 `DROP TABLE IF EXISTS` + `CREATE TABLE`，
        // 重跑会**静默清空整表**（`alarm_history` 尤其致命，schema 自称「永不删除」）。
        // 改为 IF NOT EXISTS：首次部署行为完全不变，重跑变成 no-op。
        // ⚠️ 代价：表已存在但结构不符时会**静默跳过**，schema 漂移不可见。
        //    改结构必须新建迁移文件，不要改这里。
        // S-17：建表语句全部包在 try/finally 里。SET FOREIGN_KEY_CHECKS 是**会话级**开关，
        // 建表抛异常时也必须在 finally 恢复，否则连接池把这条 session 交给
        // 下一个请求时会带着外键检查关闭运行 —— 那是比本 bug 更隐蔽的故障。
        // 有了它，父表先建/后建、上一轮迁移中途失败留残留子表，都不会再 errno 3730 卡死。
        try {
            Db::statement('SET FOREIGN_KEY_CHECKS = 0');
            Db::statement(
            <<<'SQL'
            CREATE TABLE IF NOT EXISTS `alarm_history` (
              `id`                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT COMMENT '告警历史 id',
              `policy_id`         BIGINT UNSIGNED   NOT NULL                COMMENT '策略 id（快照；无外键，策略可被删除）',
              `policy_name`       VARCHAR(128)      NOT NULL DEFAULT ''     COMMENT '策略名称快照（策略删除后仍可展示）',
              `level`             TINYINT UNSIGNED  NOT NULL                COMMENT '告警等级 1紧急 2严重 3提示',
              `status`            TINYINT UNSIGNED  NOT NULL DEFAULT 1      COMMENT '1未处理 2已处理 3已忽略 4已恢复',
              `condition_id`      BIGINT UNSIGNED   NOT NULL DEFAULT 0      COMMENT '触发条件 id 快照，0 表示未知（无外键）',
              `metric_namespace`  VARCHAR(64)       NOT NULL DEFAULT ''     COMMENT '指标命名空间快照',
              `metric_name`       VARCHAR(64)       NOT NULL DEFAULT ''     COMMENT '指标英文名快照',
              `metric_name_cn`    VARCHAR(64)       NOT NULL DEFAULT ''     COMMENT '指标中文名快照',
              `unit`              VARCHAR(16)       NOT NULL DEFAULT ''     COMMENT '指标单位快照',
              `operator`          VARCHAR(2)        NOT NULL DEFAULT '>'    COMMENT '比较关系快照 > >= < <= == !=',
              `threshold`         DECIMAL(20, 4)    NOT NULL DEFAULT 0.0000 COMMENT '阈值快照，可负',
              `actual_value`      DECIMAL(20, 4)    DEFAULT NULL            COMMENT '实际值，NULL 表示恢复类事件无实测值',
              `period`            SMALLINT UNSIGNED NOT NULL DEFAULT 1      COMMENT '统计粒度快照（分钟）',
              `continuity`        TINYINT UNSIGNED  NOT NULL DEFAULT 1      COMMENT '持续周期快照（数据点数）',
              `object_type`       TINYINT UNSIGNED  NOT NULL DEFAULT 1      COMMENT '告警对象类型快照 1全部对象 2指定实例 3实例分组 4多维筛选',
              `object_id`         BIGINT UNSIGNED   NOT NULL DEFAULT 0      COMMENT '告警实例 id 快照，0 表示无具体实例',
              `object_name`       VARCHAR(128)      NOT NULL DEFAULT ''     COMMENT '告警实例名称快照',
              `content`           VARCHAR(500)      NOT NULL DEFAULT ''     COMMENT '告警内容摘要（服务端生成，最长 500）',
              `triggered_at`      DATETIME          NOT NULL                COMMENT '触发时间',
              `duration`          INT UNSIGNED      NOT NULL DEFAULT 0      COMMENT '持续时长（秒）；未恢复为 0',
              `recovered_at`      DATETIME          DEFAULT NULL            COMMENT '恢复时间，NULL 表示未恢复',
              `handled_at`        DATETIME          DEFAULT NULL            COMMENT '处理时间，NULL 表示未处理',
              `handle_action`     VARCHAR(16)       DEFAULT NULL            COMMENT '处理动作 handle|ignore|recover，NULL 表示未处理',
              `handler_name`      VARCHAR(64)       NOT NULL DEFAULT ''     COMMENT '处理人姓名，未处理为 ""',
              `handle_remark`     VARCHAR(500)      NOT NULL DEFAULT ''     COMMENT '处理备注，最长 500',
              `notify_count`      SMALLINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '已通知次数（重复推送计数）',
              `created_at`        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
              `updated_at`        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
            
              PRIMARY KEY (`id`),
              
              KEY `idx_history_policy_triggered` (`policy_id`, `triggered_at`),
              
              KEY `idx_history_status_triggered` (`status`, `triggered_at`),
              
              KEY `idx_history_level_triggered` (`level`, `triggered_at`),
              
              KEY `idx_history_triggered_id` (`triggered_at`, `id`),
              
              KEY `idx_history_object` (`object_id`),
            
              CONSTRAINT `ck_history_level`     CHECK (`level` IN (1, 2, 3)),
              CONSTRAINT `ck_history_status`    CHECK (`status` IN (1, 2, 3, 4)),
              CONSTRAINT `ck_history_operator`  CHECK (`operator` IN ('>', '>=', '<', '<=', '==', '!=')),
              CONSTRAINT `ck_history_period`    CHECK (`period` IN (1, 5, 10, 30, 60)),
              CONSTRAINT `ck_history_continuity` CHECK (`continuity` BETWEEN 1 AND 10),
              CONSTRAINT `ck_history_object_type` CHECK (`object_type` IN (1, 2, 3, 4)),
              CONSTRAINT `ck_history_handle_action` CHECK (`handle_action` IS NULL OR `handle_action` IN ('handle', 'ignore', 'recover'))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
              COMMENT='告警历史（快照语义；无外键；永不删除）'
            SQL
        );
        } finally {
            // 无论建表成功还是抛异常，都必须恢复会话级开关。
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }

        public function down(): void
    {
        // 与 up() 对称：单步回滚父表时子表可能仍带 FK，包裹后不再 errno 3730。
        try {
            Db::statement('SET FOREIGN_KEY_CHECKS = 0');
            Db::statement('DROP TABLE IF EXISTS `alarm_history`');
        } finally {
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
};
