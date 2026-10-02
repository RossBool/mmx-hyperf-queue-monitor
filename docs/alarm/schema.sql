-- =============================================================================
-- 告警管理模块 — MySQL 8.0 建表 DDL
-- =============================================================================
-- 版本    : v1.0
-- 更新时间: 2026-09-30
-- 配套契约: ../contract.md（字段名一一对应，snake_case 列名 <-> camelCase 接口字段）
-- 指标字典: metrics.md
--
-- 【执行前提】
--   MySQL >= 8.0.13（使用 JSON 列 + CHECK 约束 + 表达式默认值的能力）
--   执行前请确认当前库为 utf8mb4。本文件可整段直接执行：
--     mysql -u<user> -p <db> < schema.sql
--
-- 【全局设计取舍】（详细理由见 domain.md §5）
--   1. 硬删除 vs 软删除
--      - alarm_policy / alarm_policy_condition / *_template / alarm_notification_receiver
--        采用【硬删除 + 物理级联】。原因：策略/模板的 name 需要"全局唯一"，
--        软删除会让唯一键必须带 is_deleted 维度，查询与校验都会复杂化；
--        且业务语义参照腾讯云 —— 删除即消失。
--      - alarm_history 采用【永不删除】（本模块不提供删除端点）。历史表不建任何
--        指向 alarm_policy 的外键，策略被删除后历史仍可查阅。
--      - 唯一做法替代软删除的"可恢复"诉求：策略支持「复制」(POST /copy)，
--        误删可从副本重建。
--   2. 外键策略
--      - 【表内父子】使用真实外键 + ON DELETE CASCADE：
--        alarm_policy_condition.policy_id -> alarm_policy.id
--        alarm_notification_receiver.template_id -> alarm_notification_template.id
--      - 【业务逻辑关联但不加外键】：
--        alarm_policy.notification_template_ids      (JSON 数组，运行时校验引用)
--        alarm_policy.condition_template_id          (无 FK，允许模板删除后残留 0/TEMP，
--                                                   但删除前有 409 保护)
--        alarm_history.policy_id                     (故意不加 FK，见上)
--        alarm_history.condition_id                  (故意不加 FK，快照语义)
--        加 FK 的收益（级联一致性）远小于其代价（写入顺序约束、跨表锁、
--        归档/分表受阻），因此只保留父子强一致的 2 处。
--   3. JSON 列的使用取舍
--      - 结构会整体读写、不会被单独检索的字段 -> JSON：
--        alarm_policy.object_ids / object_group_ids / object_filters
--        alarm_policy_condition 不使用 JSON（需按 policy_id 检索与排序 -> 独立成表）
--        alarm_condition_template.conditions  -> JSON（模板详情总是整体读，不单独查条件）
--        alarm_notification_template.channels  -> JSON（渠道配置整体读，接收人明细在从表）
--      - 对 JSON 列做检索的地方共【两处】，都走不了索引，均由应用层兜底：
--        (1) 删除通知模板前的引用检查
--            SELECT ... WHERE JSON_CONTAINS(notification_template_ids, CAST(:tid AS JSON));
--            EXPLAIN 为 type: ALL 全表扫。本版本假设 alarm_policy 为小表（百~千级）可接受；
--            若增长到万级，改为维护 alarm_policy_template_ref 关系表（方案见 domain.md §5.6）。
--        (2) 通知模板列表按渠道过滤（contract.md §3.2 ⑬ 的 ?channel= 查询）
--            channels 为 JSON 数组，无法直接索引。本版本【不】为此新增生成列或多值索引
--            （避免超出本次规格范围），改为在应用层先按 is_preset / keyword 缩小集合后再过滤。
--            模板数量级很小（预置 3 条 + 用户自定义），EXPLAIN 为 type: ALL 属预期内。
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1. alarm_policy 告警策略主表
-- -----------------------------------------------------------------------------
-- 列 <-> 接口字段映射（camelCase）：
--   id->id  name->name  remark->remark  monitor_type->monitorType  policy_type->policyType
--   status->status  level->level(派生)  project_id->projectId  object_type->objectType
--   object_ids->objectIds  object_group_ids->objectGroupIds  object_filters->objectFilters
--   condition_logic->conditionLogic  notification_template_ids->notificationTemplateIds
--   condition_template_id->conditionTemplateId  creator_name->creatorName
--   created_at->createdAt  updated_at->updatedAt
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `alarm_policy`;
CREATE TABLE `alarm_policy` (
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
  -- 名称唯一：配合"硬删除"策略，无需 is_deleted 维度
  UNIQUE KEY `uk_policy_name` (`name`),
  -- 核心查询索引：状态 + 等级 组合筛选（如 status=1 AND level=1）。
  -- 注意：列表默认排序是 created_at DESC, id DESC，本复合索引在无等值前缀时不会被排序利用
  --       （该排序由 idx_policy_updated_at / InnoDB 聚簇主键顺序兜底），本索引只为筛选服务。
  KEY `idx_policy_status_level_created` (`status`, `level`, `created_at`),
  -- 单维筛选索引
  KEY `idx_policy_monitor_type` (`monitor_type`),
  KEY `idx_policy_policy_type` (`policy_type`),
  KEY `idx_policy_project_id` (`project_id`),
  KEY `idx_policy_condition_template_id` (`condition_template_id`),
  -- 支持按更新时间倒序的"最近变更"场景
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
  COMMENT='告警策略主表（硬删除；子条件级联物理删除）';

-- -----------------------------------------------------------------------------
-- 2. alarm_policy_condition 告警策略触发条件表
-- -----------------------------------------------------------------------------
-- 为什么不用 JSON 列：本表必须被 policy_id 高频检索（详情/复制/全量更新时先删后插），
-- 并需要 (policy_id, sort) 唯一约束，JSON 列无法建索引，故独立成表。
-- 每策略 1-4 条，由应用层 + contract.md P4/P5 双重保证。
-- `operator` 非 MySQL 保留字，此处仍统一加引号，PHP 侧如拼接 SQL 建议同样转义。
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `alarm_policy_condition`;
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
  -- 同一策略内排序唯一；其最左前缀已覆盖按 policy_id 查询详情的场景
  UNIQUE KEY `uk_condition_policy_sort` (`policy_id`, `sort`),
  -- 冗余索引：按指标反查策略（指标字典运营/审计用）
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
  COMMENT='告警策略触发条件（每策略 1-4 条，随策略硬删除级联清理）';

-- -----------------------------------------------------------------------------
-- 3. alarm_condition_template 触发条件模板表
-- -----------------------------------------------------------------------------
-- conditions 用 JSON：本模板的读取模式永远是"按 id 取整份模板"，不存在
-- "按其中某条条件检索"的场景，拆子表只会带来无收益的 join。
-- 取舍代价：无法对单个条件建索引/做条件级去重校验 —— 已由应用层
-- (contract.md T3) 用 policyType 白名单校验替代。
-- 预置模板 is_preset=1 可修改不可删除（contract.md T4）。
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `alarm_condition_template`;
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
  -- 按策略类型列出可用模板（含预置）
  KEY `idx_condition_template_type_preset` (`policy_type`, `is_preset`),
  KEY `idx_condition_template_created_at` (`created_at`),

  CONSTRAINT `ck_condition_template_name_len`  CHECK (CHAR_LENGTH(TRIM(`name`)) BETWEEN 1 AND 64),
  CONSTRAINT `ck_condition_template_remark_len` CHECK (CHAR_LENGTH(`remark`) <= 500),
  CONSTRAINT `ck_condition_template_policy_type` CHECK (`policy_type` IN (1, 2, 3, 4)),
  CONSTRAINT `ck_condition_template_is_preset`  CHECK (`is_preset` IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='触发条件模板（conditions 为 JSON 数组；硬删除，被引用时返回 409）';

-- -----------------------------------------------------------------------------
-- 4. alarm_notification_template 通知模板表
-- -----------------------------------------------------------------------------
-- channels 用 JSON 存"渠道级配置"：[{channel,receivers[],callbackUrl,silenceTime}]
-- 拆分取舍（channels JSON vs 纯关系表）：
--   * 选 JSON 的理由：模板读取是整体读（一次查询出完整配置），JSON 免去 N+1 join；
--     前端提交体本身就是数组结构，回写无需重组。
--   * 选纯关系表的代价：每次读模板多一次查询，回写需在应用层拼装 JSON，
--     且将来若要给"某接收人订阅了哪些模板"做能力时无索引可用。
--   * 折中方案（当前采用）：渠道配置留在本表 JSON，同时把接收人明细冗余落到
--     alarm_notification_receiver，以支持全局接收人唯一性校验与未来订阅查询；
--     读取以本表 channels 为准，两者同事务写入。
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `alarm_notification_template`;
CREATE TABLE `alarm_notification_template` (
  `id`           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '模板 id',
  `name`         VARCHAR(64)      NOT NULL                COMMENT '模板名称，长度 1-64，全局唯一',
  `remark`       VARCHAR(500)     NOT NULL DEFAULT ''     COMMENT '备注，最长 500',
  `channels`     JSON             NOT NULL                COMMENT '渠道数组 [{channel,receivers[],callbackUrl,silenceTime}]，1-5 条，channel 不可重复',
  `is_preset`    TINYINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '1系统预置（不可删除） 0用户自定义',
  `creator_id`   BIGINT UNSIGNED  NOT NULL DEFAULT 0      COMMENT '创建人用户 id',
  `creator_name` VARCHAR(64)      NOT NULL DEFAULT ''     COMMENT '创建人姓名',
  `created_at`   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',

  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_notification_template_name` (`name`),
  KEY `idx_notification_template_is_preset` (`is_preset`),
  KEY `idx_notification_template_created_at` (`created_at`),

  CONSTRAINT `ck_notification_template_name_len`  CHECK (CHAR_LENGTH(TRIM(`name`)) BETWEEN 1 AND 64),
  CONSTRAINT `ck_notification_template_remark_len` CHECK (CHAR_LENGTH(`remark`) <= 500),
  CONSTRAINT `ck_notification_template_is_preset`  CHECK (`is_preset` IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='告警通知模板（channels 为 JSON 数组；硬删除，被引用时返回 409）';

-- -----------------------------------------------------------------------------
-- 5. alarm_notification_receiver 通知接收人明细表
-- -----------------------------------------------------------------------------
-- 与 alarm_notification_template.channels 的关系：冗余明细，非权威数据。
-- 权威配置是 channels JSON；本表只承担两个职责：
--   (a) 模板内去重与格式校验。⚠️ 唯一键是 (template_id, channel, contact)，
--       因此【只保证同一模板内不重复】；同一个 contact 挂到另一个模板是允许的，
--       也就【不存在接收人全局唯一性】。idx_receiver_contact 仅用于按接收人反查所属模板。
--   (b) 未来"接收人 ↔ 模板"订阅关系查询
-- 若确定不需要 (b)，可直接 DROP 本表，仅依赖 channels JSON，接口契约不变。
-- 删除模板时随模板级联物理删除。
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `alarm_notification_receiver`;
CREATE TABLE `alarm_notification_receiver` (
  `id`          BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT '接收人明细 id',
  `template_id` BIGINT UNSIGNED  NOT NULL                COMMENT '所属通知模板 id',
  `channel`     TINYINT UNSIGNED NOT NULL                COMMENT '渠道 1邮件 2短信 3微信 4电话 5回调',
  `contact`     VARCHAR(255)     NOT NULL                COMMENT '接收人标识：邮箱/手机号/微信号；channel=5 时为回调地址',
  `created_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at`  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',

  PRIMARY KEY (`id`),
  -- 同一模板内同一渠道下接收人不可重复
  UNIQUE KEY `uk_receiver_template_channel_contact` (`template_id`, `channel`, `contact`),
  -- 全局接收人查重/订阅查询
  KEY `idx_receiver_contact` (`contact`),
  KEY `idx_receiver_template_channel` (`template_id`, `channel`),

  CONSTRAINT `fk_receiver_template` FOREIGN KEY (`template_id`)
    REFERENCES `alarm_notification_template` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ck_receiver_channel` CHECK (`channel` IN (1, 2, 3, 4, 5))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='通知接收人明细（冗余表，非权威；随模板级联删除）';

-- -----------------------------------------------------------------------------
-- 6. alarm_history 告警历史表
-- -----------------------------------------------------------------------------
-- 【故意不加外键】policy_id / condition_id：
--   策略可被硬删除，历史必须保留可查；且 metric/policy 等均为快照语义，
--   即便策略被删改，历史展示的仍是"当时"的值。referential integrity 由
--   应用层保证（插入时校验 id 存在）。
-- 条件/策略/实例等字段全部冗余快照，是为了让"策略已删"的历史仍可完整渲染。
-- 本表无删除端点，只增 + 状态流转。
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS `alarm_history`;
CREATE TABLE `alarm_history` (
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
  -- 核心查询索引：按策略查历史 + 时间倒序（策略详情页"告警历史"）
  KEY `idx_history_policy_triggered` (`policy_id`, `triggered_at`),
  -- 首页统计与"未处理"筛选
  KEY `idx_history_status_triggered` (`status`, `triggered_at`),
  -- 按等级筛选（紧急告警列表）
  KEY `idx_history_level_triggered` (`level`, `triggered_at`),
  -- 全局按时间翻页（默认排序 triggered_at DESC, id DESC）
  KEY `idx_history_triggered_id` (`triggered_at`, `id`),
  -- 冗余索引：未来按对象/指标反查
  KEY `idx_history_object` (`object_id`),

  CONSTRAINT `ck_history_level`     CHECK (`level` IN (1, 2, 3)),
  CONSTRAINT `ck_history_status`    CHECK (`status` IN (1, 2, 3, 4)),
  CONSTRAINT `ck_history_operator`  CHECK (`operator` IN ('>', '>=', '<', '<=', '==', '!=')),
  CONSTRAINT `ck_history_period`    CHECK (`period` IN (1, 5, 10, 30, 60)),
  CONSTRAINT `ck_history_continuity` CHECK (`continuity` BETWEEN 1 AND 10),
  CONSTRAINT `ck_history_object_type` CHECK (`object_type` IN (1, 2, 3, 4)),
  CONSTRAINT `ck_history_handle_action` CHECK (`handle_action` IS NULL OR `handle_action` IN ('handle', 'ignore', 'recover'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='告警历史（快照语义；无外键；永不删除）';

SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
-- 预置数据（幂等：可重复执行）
-- 与 metrics.md §3 的 6 条预置触发条件模板严格一一对应。
-- creator_id=0 / creator_name='system' 表示系统预置。
-- =============================================================================

-- --- 3 条预置通知模板（is_preset=1，不可删除） --------------------------------
INSERT IGNORE INTO `alarm_notification_template`
  (`name`, `remark`, `channels`, `is_preset`, `creator_id`, `creator_name`) VALUES
  ('系统预置-邮件通知', '系统内置，仅邮件通知，接收人需自行补充',
   '[{"channel":1,"receivers":[],"callbackUrl":null,"silenceTime":0}]', 1, 0, 'system'),
  ('系统预置-短信通知', '系统内置，仅短信通知，适合紧急告警',
   '[{"channel":2,"receivers":[],"callbackUrl":null,"silenceTime":0}]', 1, 0, 'system'),
  ('系统预置-回调通知', '系统内置，通过公网回调地址推送告警，需填写 callbackUrl',
   '[{"channel":5,"receivers":[],"callbackUrl":"https://example.com/alarm/callback","silenceTime":0}]', 1, 0, 'system');

-- --- 6 条预置触发条件模板（is_preset=1，不可删除，可修改） --------------------
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
   1, 0, 'system');
