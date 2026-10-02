<?php

declare(strict_types=1);
/**
 * 迁移：建表 `alarm_notification_receiver`（通知接收人明细）。
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
        Db::statement('DROP TABLE IF EXISTS `alarm_notification_receiver`');
        Db::statement(
            <<<'SQL'
            CREATE TABLE `alarm_notification_receiver` (
              `id`          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '接收人明细 id',
              `template_id` BIGINT UNSIGNED  NOT NULL                COMMENT '所属通知模板 id',
              `channel`     TINYINT UNSIGNED NOT NULL                COMMENT '渠道 1邮件 2短信 3微信 4电话 5回调',
              `contact`     VARCHAR(255)     NOT NULL                COMMENT '接收人标识：邮箱/手机号/微信号；channel=5 时为回调地址',
              `created_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
              `updated_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
            
              PRIMARY KEY (`id`),
              
              UNIQUE KEY `uk_receiver_template_channel_contact` (`template_id`, `channel`, `contact`),
              
              KEY `idx_receiver_contact` (`contact`),
              KEY `idx_receiver_template_channel` (`template_id`, `channel`),
            
              CONSTRAINT `fk_receiver_template` FOREIGN KEY (`template_id`)
                REFERENCES `alarm_notification_template` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
              CONSTRAINT `ck_receiver_channel` CHECK (`channel` IN (1, 2, 3, 4, 5))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
              COMMENT='通知接收人明细（冗余表，非权威；随模板级联删除）'
            SQL
        );
    }

    public function down(): void
    {
        Db::statement('DROP TABLE IF EXISTS `alarm_notification_receiver`');
    }
};
