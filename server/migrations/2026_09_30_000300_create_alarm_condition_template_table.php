<?php

declare(strict_types=1);
/**
 * 迁移：建表 `alarm_condition_template`（触发条件模板）。
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
        Db::statement('DROP TABLE IF EXISTS `alarm_condition_template`');
        Db::statement(
            <<<'SQL'
            CREATE TABLE `alarm_condition_template` (
              `id`           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '模板 id',
              `name`         VARCHAR(64)      NOT NULL                COMMENT '模板名称，长度 1-64，全局唯一',
              `remark`       VARCHAR(500)     NOT NULL DEFAULT ''     COMMENT '备注，最长 500',
              `policy_type`  TINYINT UNSIGNED NOT NULL                COMMENT '适用的策略类型 1通用Web服务 2CVM 3CLB 4MySQL',
              `conditions`   JSON             NOT NULL                COMMENT '条件数组 [{sort,metricNamespace,metricName,operator,threshold,period,continuity,level,frequency}]，1-4 条',
              `is_preset`    TINYINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '1系统预置（不可删除） 0用户自定义',
              `creator_id`   BIGINT UNSIGNED  NOT NULL DEFAULT 0      COMMENT '创建人用户 id',
              `creator_name` VARCHAR(64)      NOT NULL DEFAULT ''     COMMENT '创建人姓名',
              `created_at`   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
              `updated_at`   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
            
              PRIMARY KEY (`id`),
              UNIQUE KEY `uk_condition_template_name` (`name`),
              
              KEY `idx_condition_template_type_preset` (`policy_type`, `is_preset`),
              KEY `idx_condition_template_created_at` (`created_at`),
            
              CONSTRAINT `ck_condition_template_name_len`  CHECK (CHAR_LENGTH(TRIM(`name`)) BETWEEN 1 AND 64),
              CONSTRAINT `ck_condition_template_remark_len` CHECK (CHAR_LENGTH(`remark`) <= 500),
              CONSTRAINT `ck_condition_template_policy_type` CHECK (`policy_type` IN (1, 2, 3, 4)),
              CONSTRAINT `ck_condition_template_is_preset`  CHECK (`is_preset` IN (0, 1))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
              COMMENT='触发条件模板（conditions 为 JSON 数组；硬删除，被引用时返回 409）'
            SQL
        );
    }

    public function down(): void
    {
        Db::statement('DROP TABLE IF EXISTS `alarm_condition_template`');
    }
};
