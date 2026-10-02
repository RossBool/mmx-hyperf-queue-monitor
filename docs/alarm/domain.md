# 告警管理模块 — 领域模型（domain.md）

> 版本：v1.0　　最后更新：2026-09-30　　状态：**已冻结**
>
> 配套文档：`contract.md`（API 契约）、`schema.sql`（DDL）、`metrics.md`（指标字典）

---

## 1. 五分钟上手摘要（写给后续实现者）

> 如果你只有 5 分钟，读这一节就够开工了。

1. **告警策略（Policy）是本模块的聚合根**。一个策略 = 1 条 `alarm_policy` 主记录 + 1~4 条
   `alarm_policy_condition` 子记录 + 最多 3 个通知模板引用。主表和子表**同事务**写入。

2. **响应永远包在 `{ data, extra, code, message, success }` 里**，前端 `IResponse<T>` 已经这么定义了，
   不要改。业务失败时 `data` 必须是 `null`（不是 `{}`、不是 `[]`）。列表接口的 `data` 必须是
   `{ list, total, page, pageSize }`，**不是裸数组**。

3. **`PUT /policies/{id}` 是全量更新**：没传的字段回落默认值（`status` 除外，它只走
   `POST /status`）。前端表单必须整体提交。后端实现为「先删子条件，再批量插入」。

4. **删除策略前必须检查 `status`**：`status === 1`（启用中）直接返回 `409`，message 为
   `已启用的策略不可删除，请先停用`。这是参照腾讯云的规则，别自作主张放开。

5. **复制策略（`POST /policies/{id}/copy`）**：不继承 `id`、不继承创建人
   （`creatorId` / `creatorName` 归当前登录人，`createdAt` / `updatedAt` 重新生成）、
   新策略强制 `status=0`（停用）、新名称为 `{原名} - 副本`（冲突时追加 `(2)`、`(3)`…），
   拼接后总长必须 ≤128（超长则截断原名）。

6. **每个触发条件必须字段完整**（`metricNamespace` / `metricName` / `operator` / `threshold` /
   `period` / `continuity` / `level` / `frequency` 八项齐全），**不做任何默认值兜底**，
   缺一项就是 422。其中 `metricNameCn` 和 `unit` 由后端从指标字典回填，前端传什么都忽略。

7. **枚举一律用数值传输**（`operator` 除外，它是 `> >= < <= == !=` 字符串）。
   完整 12 组枚举见 `contract.md` §1，**不要在代码里另立一套**。

8. **告警历史（History）是只增不改的快照**。策略名、指标名、阈值、实例名全部冗余存储，
   所以策略被删掉后历史依然可读。它**没有外键**指向 `alarm_policy`，也**没有删除端点**。

9. **6 条预置条件模板**在 `schema.sql` 末尾用 `INSERT IGNORE` 写入，`is_preset=1`，
   可改不可删（删返回 409）。28 个指标在 `metrics.md`，属于**代码常量不入库**。

10. **通知模板的 `receivers` 允许 0-100 个**（预置模板出厂即为空占位）。"必须配好接收人"的校验
    **不在模板自身，而在绑定处**（contract §4.3 **N9**）：策略的 `notificationTemplateIds` 里若含
    `channel≠5` 且 `receivers` 为空的模板，返回 422 并指出模板名。前端应在模板列表/编辑页提示
    「请补充接收人后再绑定到策略」。

11. **唯一键 `name` 是全局唯一的**（策略、两种模板各一张唯一键），冲突返回 `409`，
    不是 422 —— 422 留给字段格式/取值错误，`extra.errors` 里给出字段级明细。

---

## 2. 领域概念

| 概念 | 说明 | 持久化 |
| --- | --- | --- |
| **Policy（告警策略）** | 聚合根。「对哪些对象、按什么指标、在什么阈值下、以什么频率通知谁」的一整套规则。 | `alarm_policy` + `alarm_policy_condition` |
| **PolicyCondition（触发条件）** | 策略内的一条判定规则：`metric op threshold` 连续 `continuity` 个 `period` 成立即命中。 | `alarm_policy_condition` |
| **ConditionTemplate（触发条件模板）** | 可复用的条件集合。创建策略时深拷贝到策略，之后模板变更不回灌已有策略。 | `alarm_condition_template`（conditions 为 JSON） |
| **NotificationTemplate（通知模板）** | 「通过哪些渠道、通知哪些人、静默多久」的复用配置。 | `alarm_notification_template`（channels 为 JSON）+ `alarm_notification_receiver`（明细冗余） |
| **AlarmHistory（告警历史）** | 一次命中/恢复/处理的**快照**记录。只增，状态可流转。 | `alarm_history` |
| **Metric（指标）** | 系统元数据，不入库。唯一键 `namespace.metricName`。 | 代码常量，见 `metrics.md` |

**边界说明**：本模块**不负责**指标采集与计算（那是监控 agent 的事），也**不负责**通知实际投递
（那是通知服务的事）。本模块的职责边界是：**策略配置 CRUD + 告警记录查询/处理 + 首页统计**。

---

## 3. ER 关系

### 3.1 ASCII 图

```
                        ┌──────────────────────────────┐
                        │  alarm_condition_template    │   (触发条件模板, 硬删除)
                        │  PK id                       │
                        │  UK name                     │
                        │  policy_type                 │
                        │  conditions      JSON ───────┼──┐  1-4 条条件
                        │  is_preset                   │  │  (深拷贝来源)
                        └──────────────┬───────────────┘  │
                                       │                 │
                       逻辑引用(无FK)    │ condition_template_id
                       被引用则禁删      │ (409 TEMPLATE_IN_USE)
                                       ▼                 │
  ┌────────────────────────────────────────────────────────────┐
  │                    alarm_policy  (策略主表, 硬删除)         │
  │  PK id                                                       │
  │  UK name                                                     │
  │  monitor_type / policy_type / status / level(派生)           │
  │  project_id / object_type                                   │
  │  object_ids / object_group_ids / object_filters  JSON        │
  │  condition_logic                                            │
  │  notification_template_ids                        JSON       │
  │  condition_template_id  ──► alarm_condition_template.id     │
  │  creator_id / creator_name / created_at / updated_at         │
  └───────┬──────────────────────────────┬───────────────────────┘
          │ 1:N (真外键, 级联物理删除)     │ N:M (JSON 引用, 被引用则禁删)
          │                              │
          ▼                              ▼
┌───────────────────────────┐   ┌──────────────────────────────────┐
│ alarm_policy_condition    │   │ alarm_notification_template       │  (通知模板, 硬删除)
│ PK id                     │   │  PK id                           │
│ FK policy_id ─────────────┘   │  UK name                         │
│ UK (policy_id, sort)         │  channels            JSON ───────┼──┐ 1-5 个渠道
│ metric_namespace/metric_name│   │  is_preset / creator_* / 时间    │  │
│ operator / threshold        │   └───────────────┬──────────────────┘  │
│ period / continuity         │                   │ 1:N (真外键, 级联)   │
│ level / frequency           │                   ▼                     ▼
└───────────────────────────┘   ┌──────────────────────────────────┐
                                │ alarm_notification_receiver      │
                                │ PK id                           │
                                │ FK template_id ──────────────────┘
                                │ UK (template_id, channel,        │
                                │     contact)                    │
                                │ channel / contact               │
                                └──────────────────────────────────┘

          ┌──────────────────────────────────────────┐
          │        alarm_history (告警历史, 只增)      │
          │  PK id                                    │
          │  policy_id  ──► alarm_policy.id          │
          │        ✗ 故意无外键（策略可被硬删除）      │
          │  condition_id ✗ 无外键（快照语义）         │
          │  policy_name / metric_* / operator /      │
          │  threshold / actual_value / period /      │
          │  continuity / object_*  ← 全部冗余快照     │
          │  level / status(1未处理 2已处理            │
          │         3已忽略 4已恢复)                   │
          │  triggered_at / duration / recovered_at   │
          │  handle_action / handled_at /            │
          │  handler_name / handle_remark             │
          │  notify_count                             │
          └──────────────────────────────────────────┘
```

### 3.2 关系清单

| 关系 | 基数 | 约束类型 | 基数说明 |
| --- | --- | --- | --- |
| Policy → PolicyCondition | 1 : 1~4 | **真外键** `fk_condition_policy` ON DELETE CASCADE | 子表有 `uk_condition_policy_sort` 唯一性 + 应用层条数校验 |
| NotificationTemplate → Receiver | 1 : N | **真外键** `fk_receiver_template` ON DELETE CASCADE | 明细冗余，读取以 `channels` JSON 为准 |
| Policy → NotificationTemplate | N : M (≤3) | **JSON 引用 + 应用层校验** | 删除前用 `JSON_CONTAINS` 检查，命中返回 409 |
| Policy → ConditionTemplate | N : 1 (0..1) | **逻辑引用（无 FK）** | 删除前按 `condition_template_id` 索引检查，命中返回 409 |
| Policy → History | 1 : N | **无外键（刻意）** | 策略删除后历史保留 |
| PolicyCondition → History | 1 : N | **无外键（刻意）** | `condition_id=0` 表示未知 |
| Policy → Metric | 逻辑 | **不入库** | 通过 `metric_namespace + metric_name` 关联代码常量 |

### 3.3 为什么有些地方不加外键

| 场景 | 加 FK 的问题 | 本方案 |
| --- | --- | --- |
| `alarm_history.policy_id` | 策略硬删除会被 FK `RESTRICT` 挡住，违背「停用后可删」的规则；或被迫改成 `SET NULL`，则历史丢失策略标识 | 不加 FK，靠应用层插入时校验 id 存在；历史中的 `policy_name` 本就是快照 |
| `alarm_policy.notification_template_ids`（JSON） | JSON 数组无法建外键 | 不加 FK，删除前用 `JSON_CONTAINS` 显式检查，未被引用才允许删 |
| `alarm_policy.condition_template_id` | 加 FK 后删除模板会被挡住，只能靠 409 提前拦截 | 不加 FK，靠 `idx_policy_condition_template_id` 索引 + 应用层 409 拦截 |

**判断准则**：只有「删除父行必然要求级联清理子行」才用真外键；其余一律用**应用层校验 + 409**，
以换取删除语义可控与写入无锁竞争。

---

## 4. 状态流转

### 4.1 策略启停（`status`）

```
        创建(status 默认 0)
              │
              ▼
        ┌──────────┐   POST /status {status:1}    ┌──────────┐
        │  停用 0  │ ─────────────────────────▶  │  启用 1  │
        │ DISABLED│                              │  ENABLED │
        └──────────┘ ◀─────────────────────────  └──────────┘
              ▲        POST /status {status:0}          │
              │                                         │
              │            DELETE 仅允许在              │
              └──────────── 停用态执行 ─────────────────┘
                            否则 → 409 POLICY_STATUS_CONFLICT
```

| 迁移 | 触发端点 | 守卫条件 | 说明 |
| --- | --- | --- | --- |
| 无 → 停用 | `POST /policies` | `status` 省略或为 0 | 默认不生效 |
| 无 → 启用 | `POST /policies` | `status = 1` | 创建即启用 |
| 停用 → 启用 | `POST /policies/{id}/status` | — | 幂等 |
| 启用 → 停用 | `POST /policies/{id}/status` | — | 幂等 |
| 停用 → 删除 | `DELETE /policies/{id}` | `status === 0` | 级联删除子条件；**历史保留** |
| 启用 → 删除 | `DELETE /policies/{id}` | — | **禁止**，返回 409 |
| 任意 → 副本 | `POST /policies/{id}/copy` | 源存在 | 新副本 `status = 0` |

> 副本强制停用是刻意的安全设计：复制出的策略可能仍绑定旧对象/旧阈值，
> 未经人工确认不应立即生效。

### 4.2 告警历史处理（`status` / `historyStatus`）

```
                    触发条件命中
                         │
                         ▼
                  ┌─────────────┐
                  │ 1 未处理    │  UNHANDLED  ← 唯一允许人工处理的状态
                  │  PENDING    │
                  └──────┬──────┘
                         │  POST /histories/{id}/handle
        ┌────────────────┼────────────────┐
        │ action=handle  │ action=ignore  │ action=recover
        ▼                ▼                ▼
 ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
 │ 2 已处理    │  │ 3 已忽略    │  │ 4 已恢复    │
 │  HANDLED    │  │  IGNORED    │  │  RECOVERED  │
 └─────────────┘  └─────────────┘  └─────────────┘
        终态              终态               终态
                                          (+ recovered_at
                                             + duration)
```

| 迁移 | 触发 | 守卫条件 | 落库副作用 |
| --- | --- | --- | --- |
| 无 → 未处理 | 采集/计算模块写入 | — | 初始 `status=1` |
| 未处理 → 已处理 | `handle` | `status === 1` | `handled_at`、`handle_action`、`handler_name`、`handle_remark` |
| 未处理 → 已忽略 | `ignore` | `status === 1` | 同上 |
| 未处理 → 已恢复 | `recover` | `status === 1` | 同上 **+** `recovered_at`、`duration = recovered_at - triggered_at`（秒，min 0） |
| 任意终态 → 再次处理 | — | — | **禁止**，返回 `409 HISTORY_ALREADY_HANDLED` |

**关于「已恢复」的双重语义**：`status=4` 表示**人工标记**恢复；
而监控侧指标回落触发的自动恢复（由采集/计算模块写入）同样落 `status=4` + `recovered_at`。
v1.0 未区分「自动恢复 / 人工恢复」两个来源字段 —— 见 `deliverable.md` 的遗留风险 R1。

### 4.3 通知重复推送计数

```
notify_count: 0 ──首次命中──▶ 1 ──每过 frequency 分钟仍命中──▶ 2, 3, ...
                                          │
                                          └── 24h 后降为每天一次 ──▶ ...
```
- `frequency = 0`（不重复）：`notify_count` 永远为 1
- 该逻辑属于**通知/计算模块**，本模块只负责展示 `notifyCount` 字段

---

## 5. 关键校验规则清单

> 完整版见 `contract.md` §4（编号 P/T/N/H 系列）。此处给出**实现落点**视角的速查。

### 5.1 校验执行顺序（重要，影响错误码优先级）

```
1. 认证            → 401 UNAUTHORIZED
2. 路径参数/查询参数格式 → 422 VALIDATION_ERROR
3. 资源存在性      → 404 NOT_FOUND
4. 状态冲突        → 409（POLICY_STATUS_CONFLICT / POLICY_NAME_DUPLICATED /
                     TEMPLATE_IN_USE / PRESET_READONLY / HISTORY_ALREADY_HANDLED）
5. 请求体字段校验  → 422 VALIDATION_ERROR（一次性收集全部错误放进 extra.errors）
6. 跨字段/业务规则 → 422 VALIDATION_ERROR（如 period 是否在 periodOptions 内、模板 policyType 是否匹配）
7. 落库（唯一键兜底）→ 409 POLICY_NAME_DUPLICATED（捕获 MySQL 错误码 1062 / SQLSTATE 23000 转换）
```

> 无权限访问他人资源返回 `403 FORBIDDEN`（与 401 区分：401 = 未登录/凭证失效）。
> 完整错误码表见 `contract.md` §0.5。

**要点**：先查存在性再校验字段。所以「更新一个不存在的 id」返回 404 而**不是** 422。

### 5.2 规则 → 落点对照

| 规则 | 校验层 | 说明 |
| --- | --- | --- |
| `name` 1-128 + 全局唯一 | 应用层 + `uk_policy_name` | 唯一键冲突时把 SQLSTATE `23000`/错误码 `1062` 转成 409 |
| `remark` ≤ 500 | 应用层 + `ck_policy_remark_len` | CHECK 兜底，防止绕过应用层写库 |
| `conditions` 1-4 条 | 应用层 | CHECK 无法表达条数限制 |
| `conditions[].sort` 为 1..N 连续升序 | 应用层 | DB 唯一键只保证不重复，不保证连续 |
| `period ∈ {1,5,10,30,60}` | 应用层 + `ck_condition_period` | |
| `period ∈ 指标.periodOptions` | **应用层**（查字典） | DB 无法校验跨表规则 |
| `continuity ∈ [1,10]` | 应用层 + `ck_condition_continuity` | |
| `threshold` 可负、≤4 位小数 | 应用层 + `DECIMAL(20,4)` | 负数在 DECIMAL 有符号下天然支持 |
| `operator` ∈ 6 种 | 应用层 + `ck_condition_operator` | |
| 条件八字段完整（无兜底） | **纯应用层** | 任何一项缺失立即 422。⚠️ **应用层不得依赖 DB 列默认值，必须显式传值**——`schema.sql` 中 `sort` / `level` / `frequency` 虽有 `DEFAULT`，但 P10 声明不做兜底；若实现时靠 DB 补值，缺字段的请求会静默通过校验，属于契约违规 |
| 指标 namespace 与 policyType 匹配 | **纯应用层**（查字典） | |
| 通知模板 ≤3 个 | **纯应用层** | JSON 数组长度无法用 CHECK 表达 |
| `receivers` 0-100 个（预置模板允许空） | **纯应用层** | `channels` 是 JSON 列，DB 无法校验数组元素个数 |
| **绑定时**拒绝「未配置完成」的模板（`channel≠5` 且 `receivers` 为空） | **纯应用层**（contract §4.3 N9） | 校验点在策略的 `notificationTemplateIds`，不在模板自身 |
| `objectType` 与三个对象字段一一对应 | **纯应用层** | |
| 删除仅限 `status=0` | **纯应用层**（显式 409） | |
| 模板被引用禁止删除 | **纯应用层**（`JSON_CONTAINS` / 索引查询） | |
| 告警仅 `status=1` 可处理 | **纯应用层**（显式 409） | 建议在 UPDATE 的 WHERE 里同时带 `status=1`，防并发双处理 |
| 分页 `pageSize ∈ [1,100]` | **纯应用层** | |

### 5.3 建议的并发保护

1. **处理告警**：`UPDATE alarm_history SET status=? ... WHERE id=? AND status=1`，
   检查 `affected_rows === 1`，为 0 则返回 `409 HISTORY_ALREADY_HANDLED`。
   比「先 SELECT 再 UPDATE」更安全。
2. **启停策略 / 更新策略**：可用 `updated_at` 做乐观锁（请求带上原 `updatedAt`，不匹配则 409）。
   v1.0 契约未强制，实现可先不加。
3. **名称唯一**：靠 DB 唯一键兜底，不做「先查后插」。

### 5.4 复制策略的名称生成伪代码

```
base    = trim(source.name)
suffix  = " - 副本"
candidate = truncateUtf8(base, 128 - len(suffix)) + suffix   // 长度保护
i = 1
while exists(candidate):
    i++
    if i > 99: return 409 POLICY_NAME_DUPLICATED
    numbered = "({i})"
    candidate = truncateUtf8(base, 128 - len(suffix) - len(numbered)) + suffix + numbered
return candidate
```
`truncateUtf8` 必须按字符（非字节）截断，否则中文名会截出半截字符。

### 5.5 策略 `level` 派生列的维护

策略主表的 `level` 是**冗余派生列**，写入时必须同步计算：

```
policy.level = min(conditions[].level)   // 数值越小越严重
```
- 创建、更新（含全量更新重建子条件）时都要重算
- **删除**无需重算（策略本身被删了）
- 该列存在的唯一目的是支撑列表筛选 `level=1`（紧急）走
  `idx_policy_status_level_created` 复合索引，避免全表扫

### 5.6 已知技术债（供后续演进参考）

1. `JSON_CONTAINS(notification_template_ids, ...)` 无法走索引。若策略数增长到万级且删除校验
   成为热点，改为新增关系表 `alarm_policy_template_ref(policy_id, template_id)`
   （联合唯一键 + 两个单列索引），并保留 JSON 列作为读取缓存。
2. `alarm_policy.conditions` 未冗余存储（存在子表），因此**列表查询要多一次 count**。
   已在列表用 `conditionCount` 字段解决（可用子查询或冗余计数列，二选一，v1.0 建议直接子查询）。
3. 告警历史的自动恢复与人工恢复未区分来源（见 §4.2）。
