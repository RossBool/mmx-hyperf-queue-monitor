<?php

declare(strict_types=1);
/**
 * 迁移：建表 `alarm_policy_condition`（告警策略触发条件）。
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
 * 文件序号保证 alarm_policy 先于 alarm_policy_condition 建表（后者有 FK 指向前者）。
 * down() 由 migrate:rollback 按 batch **逆序**执行，子表先于父表 drop，不会触发外键检查。
 */

use Hyperf\Database\Migrations\Migration;
use Hyperf\DbConnection\Db;

return new class extends Migration
{
    public function up(): void
    {
        Db::statement('DROP TABLE IF EXISTS `alarm_policy_condition`');
        Db::statement(
            <<<'SQL'
            CREATE TABLE `alarm_policy_condition` (
              `id`                BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT COMMENT '条件 id',
              `policy_id`         BIGINT UNSIGNED   NOT NULL                COMMENT '所属策略 id',
              `sort`              SMALLINT UNSIGNED NOT NULL DEFAULT 1      COMMENT '策略内排序，1-4 连续升序',
              `metric_namespace`  VARCHAR(64)       NOT NULL                COMMENT '指标命名空间 CVM/WEB/CLB/MYSQL，见 metrics.md',
              `metric_name`       VARCHAR(64)       NOT NULL                COMMENT '指标英文名，见 metrics.md',
              `metric_name_cn`    VARCHAR(64)       NOT NULL DEFAULT ''     COMMENT '指标中文名（由指标字典回填，服务端生成）',
              `unit`              VARCHAR(16)       NOT NULL DEFAULT ''     COMMENT '指标单位（由指标字典回填，服务端生成）',
              `operator`          VARCHAR(2)        NOT NULL                COMMENT '比较关系 > >= < <= == !=（原样存取，禁本地化）',
              `threshold`         DECIMAL(20, 4)    NOT NULL                COMMENT '阈值，可负数，最多 4 位小数',
              `period`            SMALLINT UNSIGNED NOT NULL                COMMENT '统计粒度（分钟）1/5/10/30/60',
              `continuity`        TINYINT UNSIGNED  NOT NULL                COMMENT '持续周期（数据点数）1-10',
              `level`             TINYINT UNSIGNED  NOT NULL DEFAULT 3      COMMENT '该条件命中后的告警等级 1紧急 2严重 3提示',
              `frequency`         SMALLINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '重复通知频率（分钟）0/5/15/30/60/180/360/720/1440，0=不重复',
              `created_at`        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
              `updated_at`        DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
            
              PRIMARY KEY (`id`),
              
              UNIQUE KEY `uk_condition_policy_sort` (`policy_id`, `sort`),
              
              KEY `idx_condition_metric` (`metric_namespace`, `metric_name`),
              KEY `idx_condition_policy_id` (`policy_id`),
            
              CONSTRAINT `fk_condition_policy` FOREIGN KEY (`policy_id`)
                REFERENCES `alarm_policy` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
              CONSTRAINT `ck_condition_sort`       CHECK (`sort` BETWEEN 1 AND 4),
              CONSTRAINT `ck_condition_operator`   CHECK (`operator` IN ('>', '>=', '<', '<=', '==', '!=')),
              CONSTRAINT `ck_condition_period`     CHECK (`period` IN (1, 5, 10, 30, 60)),
              CONSTRAINT `ck_condition_continuity` CHECK (`continuity` BETWEEN 1 AND 10),
              CONSTRAINT `ck_condition_level`      CHECK (`level` IN (1, 2, 3)),
              CONSTRAINT `ck_condition_frequency`  CHECK (`frequency` IN (0, 5, 15, 30, 60, 180, 360, 720, 1440))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
              COMMENT='告警策略触发条件（每策略 1-4 条，随策略硬删除级联清理）'
            SQL
        );
    }

    public function down(): void
    {
        Db::statement('DROP TABLE IF EXISTS `alarm_policy_condition`');
    }
};
