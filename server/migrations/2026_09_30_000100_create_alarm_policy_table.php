<?php

declare(strict_types=1);
/**
 * 迁移：建表 `alarm_policy`（告警策略主表）。
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
            CREATE TABLE IF NOT EXISTS `alarm_policy` (
              `id`                       BIGINT UNSIGNED    NOT NULL AUTO_INCREMENT COMMENT '策略 id',
              `name`                     VARCHAR(128)       NOT NULL                COMMENT '策略名称，长度 1-128，全局唯一',
              `remark`                   VARCHAR(500)       NOT NULL DEFAULT ''     COMMENT '备注，最长 500',
              `monitor_type`             TINYINT UNSIGNED   NOT NULL                COMMENT '监控类型 1云产品监控 2应用性能监控 3前端性能监控 4云拨测 5终端性能监控',
              `policy_type`              TINYINT UNSIGNED   NOT NULL                COMMENT '策略类型 1通用Web服务 2CVM 3CLB 4MySQL',
              `status`                   TINYINT UNSIGNED   NOT NULL DEFAULT 0      COMMENT '策略状态 0停用 1启用（仅 0 可删除）',
              `level`                    TINYINT UNSIGNED   NOT NULL DEFAULT 3      COMMENT '策略告警等级 = min(conditions.level) 派生列，1紧急 2严重 3提示，仅供列表筛选',
              `project_id`               BIGINT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '所属项目 id，0 表示未分配',
              `object_type`              TINYINT UNSIGNED   NOT NULL DEFAULT 1      COMMENT '告警对象类型 1全部对象 2指定实例 3实例分组 4多维筛选',
              `object_ids`               JSON               DEFAULT NULL            COMMENT '[objectType=2] 实例 id 数组，1-1000 个；其余情况为 NULL',
              `object_group_ids`         JSON               DEFAULT NULL            COMMENT '[objectType=3] 实例分组 id 数组，1-100 个；其余情况为 NULL',
              `object_filters`           JSON               DEFAULT NULL            COMMENT '[objectType=4] 多维筛选数组 [{key,operator,values[],matchType}]，1-10 条；其余情况为 NULL',
              `condition_logic`          TINYINT UNSIGNED   NOT NULL DEFAULT 1      COMMENT '条件间逻辑 1满足所有条件(AND) 2满足任意条件(OR)',
              `notification_template_ids` JSON              DEFAULT NULL            COMMENT '绑定的通知模板 id 数组，最多 3 个；与 alarm_notification_template 无外键',
              `condition_template_id`    BIGINT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '创建时引用的触发条件模板 id，0 表示未使用；与 alarm_condition_template 无外键',
              `creator_id`               BIGINT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '创建人用户 id（复制策略时重置为当前登录人）',
              `creator_name`             VARCHAR(64)        NOT NULL DEFAULT ''     COMMENT '创建人姓名（复制策略时重置为当前登录人）',
              `created_at`               DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间 YYYY-MM-DD HH:mm:ss',
              `updated_at`               DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间 YYYY-MM-DD HH:mm:ss',
            
              PRIMARY KEY (`id`),
              
              UNIQUE KEY `uk_policy_name` (`name`),
              
              
              
              KEY `idx_policy_status_level_created` (`status`, `level`, `created_at`),
              
              KEY `idx_policy_monitor_type` (`monitor_type`),
              KEY `idx_policy_policy_type` (`policy_type`),
              KEY `idx_policy_project_id` (`project_id`),
              KEY `idx_policy_condition_template_id` (`condition_template_id`),
              
              KEY `idx_policy_updated_at` (`updated_at`),
            
              CONSTRAINT `ck_policy_name_len`   CHECK (CHAR_LENGTH(TRIM(`name`)) BETWEEN 1 AND 128),
              CONSTRAINT `ck_policy_remark_len` CHECK (CHAR_LENGTH(`remark`) <= 500),
              CONSTRAINT `ck_policy_status`     CHECK (`status` IN (0, 1)),
              CONSTRAINT `ck_policy_monitor_type` CHECK (`monitor_type` IN (1, 2, 3, 4, 5)),
              CONSTRAINT `ck_policy_policy_type`  CHECK (`policy_type`  IN (1, 2, 3, 4)),
              CONSTRAINT `ck_policy_level`      CHECK (`level` IN (1, 2, 3)),
              CONSTRAINT `ck_policy_object_type` CHECK (`object_type` IN (1, 2, 3, 4)),
              CONSTRAINT `ck_policy_condition_logic` CHECK (`condition_logic` IN (1, 2))
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
              COMMENT='告警策略主表（硬删除；子条件级联物理删除）'
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
            Db::statement('DROP TABLE IF EXISTS `alarm_policy`');
        } finally {
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
};
