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
            CREATE TABLE IF NOT EXISTS `alarm_notification_receiver` (
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
            Db::statement('DROP TABLE IF EXISTS `alarm_notification_receiver`');
        } finally {
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
};
