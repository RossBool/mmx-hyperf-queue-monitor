# 告警管理模块 — REST API 契约（contract.md）

> 版本：v1.0　　最后更新：2026-09-30　　状态：**已冻结，后续实现必须 1:1 照抄**
>
> 本文件是告警管理模块的唯一事实来源（single source of truth）。后端 Hyperf / 前端 Vue / 建表 DDL / 指标字典
> 均以本文件为准，**任何字段名不得在其他文档或代码中漂移**。
>
> 配套文档：
> - `schema.sql` —— MySQL 8.0 建表 DDL（列名与本文响应字段一一对应，snake_case ↔ camelCase）
> - `metrics.md` —— 指标字典与 7 条预置触发条件模板
> - `domain.md` —— 领域模型、ER 图、状态流转、校验规则清单

---

## 0. 通用约定

### 0.1 基础信息

| 项 | 值 |
| --- | --- |
| Base URL | `/api/alarm` |
| 请求编码 | `Content-Type: application/json; charset=utf-8` |
| 响应编码 | `application/json; charset=utf-8` |
| 时间格式 | 字符串 `YYYY-MM-DD HH:mm:ss`（服务器时区 Asia/Shanghai，**不带时区后缀**） |
| 日期格式 | 字符串 `YYYY-MM-DD` |
| 主键类型 | `id` 一律为 **number（正整数）**，JS 安全整数范围内（不使用雪花 ID） |
| 金额/浮点 | `threshold` / `actualValue` 为 number，DB 内为 `DECIMAL(20,4)`，序列化时按 number 输出，**不要输出成字符串** |
| 鉴权 | `Authorization: Bearer <token>`，缺失或失效返回 `code=401` |
| 幂等 | 非幂等端点（POST/PUT/DELETE）不保证重放安全，前端需禁用重复提交 |

### 0.2 统一响应信封（前端 `IResponse<T>` 已按此定义，禁止修改）

```jsonc
{
  "data": {},      // 业务数据。各端点类型见下文，删除类端点为 true
  "extra": {},     // 附加信息。成功时为 {}；参数校验失败时承载 errors 明细
  "code": 0,       // 业务错误码，0 = 成功
  "message": "success",
  "success": true  // 等价于 code === 0
}
```

对应前端类型（已存在于 `src/services/types/response.type.ts`，**不要动**）：

```ts
export interface IResponse<T, E = Record<string, any>> {
  data: T
  extra: E
  code: number
  message: string
  success: boolean
}
```

**约束**

1. 业务失败时 `success=false`、`code != 0`，`data` 固定为 `null`，**不要返回 `{}` 或空数组**（前端用 `if (!res.success)` 判断）。
2. HTTP 状态码与 `code` 保持一致（业务码 `404` → HTTP `404`），便于网关/监控识别。
3. `message` 为**中文可读文案**，可直接弹窗展示；参数校验失败的每个字段的具体原因放在 `extra.errors`。
4. 列表接口 `data` 恒为分页对象（见 0.3），**不返回裸数组**。

### 0.3 分页

**分页响应体**（`data` 部分）：

```jsonc
{
  "list": [],       // 当前页数据
  "total": 128,     // 总条数（int）
  "page": 1,        // 当前页码，从 1 开始
  "pageSize": 20    // 每页条数
}
```

**分页请求参数**（query string，所有列表端点通用）：

| 参数 | 类型 | 必填 | 默认 | 校验 |
| --- | --- | --- | --- | --- |
| `page` | int | 否 | `1` | `>= 1` |
| `pageSize` | int | 否 | `20` | `1 <= pageSize <= 100`，超出返回 422 |

排序固定为 `created_at DESC, id DESC`（`alarm_history` 为 `triggered_at DESC, id DESC`），**当前版本不开放排序参数**。

### 0.4 参数校验失败时的 `extra` 结构（422）

```jsonc
{
  "data": null,
  "extra": {
    "errors": [
      { "field": "name", "message": "策略名称长度必须为 1-128 个字符" },
      { "field": "conditions.0.period", "message": "统计周期必须是 1/5/10/30/60 之一" }
    ]
  },
  "code": 422,
  "message": "参数校验失败",
  "success": false
}
```

`field` 使用请求体/查询参数的点分路径（数组用 `下标`，如 `conditions.0.threshold`）。

### 0.5 错误码表

| code | HTTP | 名称（常量） | message 文案 | 触发场景 |
| --- | --- | --- | --- | --- |
| `0` | 200 | `SUCCESS` | `success` | 成功 |
| `401` | 401 | `UNAUTHORIZED` | 未登录或登录已过期 | token 缺失/无效/过期 |
| `403` | 403 | `FORBIDDEN` | 无权限操作该资源 | 已登录但无该资源所属项目权限 |
| `404` | 404 | `NOT_FOUND` | 资源不存在 | 策略/模板/告警历史 id 不存在 |
| `409` | 409 | `POLICY_STATUS_CONFLICT` | 已启用的策略不可删除，请先停用 | 删除 `status=1` 的策略 |
| `409` | 409 | `POLICY_NAME_DUPLICATED` | 策略名称已存在 | 名称唯一键冲突（创建/更新/复制） |
| `409` | 409 | `TEMPLATE_IN_USE` | 模板已被策略引用，不可删除 | 删除仍被策略引用的通知/条件模板 |
| `409` | 409 | `PRESET_READONLY` | 预置模板不可删除 | 删除 `isPreset=1` 的模板 |
| `409` | 409 | `HISTORY_ALREADY_HANDLED` | 该告警已处理，不可重复处理 | 对非「未处理」的历史再次 handle |
| `422` | 422 | `VALIDATION_ERROR` | 参数校验失败 | 任何字段级校验不通过（明细见 `extra.errors`） |
| `500` | 500 | `INTERNAL_ERROR` | 服务器内部错误 | 未捕获异常 |

**同码多义说明**：`409` 下有 5 个语义分支，实现时通过 `code` 相同、`message` 不同区分；前端**只需按 `code === 409` 做统一提示**。若未来需要前端区分，可在 `extra` 增加 `reason` 字段（v1.0 未强制）。

---

### 0.6 JSON 列的「空值」归一化对照（契约 ↔ DB 必须严格一致）

`schema.sql` 中所有 JSON 列的 `DEFAULT` 都是 `NULL`，而契约中部分字段声明的默认值是 `null`、部分是 `[]`。
**这两者不等价**，若不显式规定，后端按 DB 读、前端按契约写就会产出不一致的实现。本节是**唯一裁决**，
实现时按此表做归一化，不允许各端自行发挥：

| DB 列（`schema.sql`） | 契约字段 | 契约声明的"空" | DB 存储的"空" | **读（DB → API）归一化** | **写（API → DB）归一化** |
| --- | --- | --- | --- | --- | --- |
| `alarm_policy.object_ids` | `objectIds` | `null` | `NULL` | `NULL` → 输出 `null` | `null` / `[]` 均写为 `NULL` |
| `alarm_policy.object_group_ids` | `objectGroupIds` | `null` | `NULL` | `NULL` → 输出 `null` | `null` / `[]` 均写为 `NULL` |
| `alarm_policy.object_filters` | `objectFilters` | `null` | `NULL` | `NULL` → 输出 `null` | `null` / `[]` 均写为 `NULL` |
| `alarm_policy.notification_template_ids` | `notificationTemplateIds` | **`[]`（非 null）** | **`NULL`** | **`NULL` → 输出 `[]`** | `null` / `[]` 均写为 `NULL` |
| `alarm_condition_template.conditions` | `conditions` | 必填 1-4 条 | `NOT NULL`（无默认值） | 直传 | 直传，**不接受 null** |
| `alarm_notification_template.channels` | `channels` | 必填 1-5 条 | `NOT NULL`（无默认值） | 直传 | 直传，**不接受 null** |

**规则 R-JSON-1**：上表前三行的字段，响应中**永远**是 `null`（不是 `[]`），因为契约把它们声明为
`int[] | null` / `object[] | null`（见 §2.3）。**不因为 DB 存了 NULL 就输出 `[]`**——那会与 §2.3 的
类型声明冲突。

**规则 R-JSON-2**：`notificationTemplateIds` 是**唯一**一个声明为非空 `int[]` 的 JSON 字段，
所以读出 `NULL` 时**必须**补成 `[]` 再返回；写回时 `[]` 与 `null` 都落库为 `NULL`。
**这两条规则方向相反，是刻意的**：`notificationTemplateIds` 参与 P12/P13/N9 校验与前端双向绑定，
永远返回数组可以让前端少写一层判空；而三个 object 字段有严格的 `objectType` 一一对应语义（§1.7 / P14），
返回 `null` 能让前端一眼看出"该字段对当前 objectType 不适用"。

**规则 R-JSON-3**：标量列的 `DEFAULT`（如 `object_type DEFAULT 1`、`level DEFAULT 3`、
`sort DEFAULT 1`、`frequency DEFAULT 0`）**只是 DB 层的兜底，不构成契约默认值**。
契约中这些字段一律为**必填**；应用层**必须显式传值**，不得依赖 DB 补值（见 §4.1 P10）。
若绕过应用层直接写库导致漏值，CHECK 约束与唯一键是最后一道防线，但**不应发生**。

**实现提示（Hyperf / PDO）**：写入 JSON 列时，PHP 侧 `null` 与 `[]` 的 JSON 编码结果不同
（`null` vs `[]`），请在 DAO 层统一按上表"写"列归一化后再 `json_encode`，
避免库里出现字面量 `null` 字符串或空字符串 `''` 破坏 `JSON_CONTAINS` 检索。

---

## 1. 枚举字典（全量，数值即存储值，前端直接使用）

所有枚举在后端以 `TINYINT UNSIGNED`（`operator` 除外，为 `VARCHAR(2)`）或字符串存储；接口出入参一律用**数值**或**字符串字面量**，前端下拉框用 `label=中文名, value=数值`。

### 1.1 `monitorType` 监控类型

| value | label（中文） | name（英文常量） |
| --- | --- | --- |
| `1` | 云产品监控 | `CLOUD_PRODUCT` |
| `2` | 应用性能监控 | `APM` |
| `3` | 前端性能监控 | `RUM` |
| `4` | 云拨测 | `PING_SITE` |
| `5` | 终端性能监控 | `TERMINAL` |

**联动规则**：`policyType` 必须属于当前 `monitorType`。v1.0 映射固定如下（后端写死校验）：

| monitorType | 允许的 policyType |
| --- | --- |
| `1` 云产品监控 | `2` CVM、`3` CLB、`4` MySQL |
| `2` 应用性能监控 | `1` 通用 Web 服务 |
| `3` / `4` / `5` | v1.0 暂无策略类型，**不可选**（选了返回 422） |

### 1.2 `policyType` 策略类型

| value | label | name | 所属 monitorType | 指标 namespace 前缀 |
| --- | --- | --- | --- | --- |
| `1` | 通用 Web 服务 | `GENERIC_WEB` | `2` | `WEB` |
| `2` | 云服务器 CVM | `CVM` | `1` | `CVM` |
| `3` | 负载均衡 CLB | `CLB` | `1` | `CLB` |
| `4` | 云数据库 MySQL | `MYSQL` | `1` | `MYSQL` |
| `5` | **采集静默** | `SILENCE` | `1` | **无**（见 1.2.1） |

> ⚠️ **`5` 是 v1.1 新增的 F 类策略类型**，它**不使用任何指标**。
> 判据是「目标的数据多久没上报」，与「指标值是否越界」正交。
> 因此 `conditions` 固定长度为 1，且该条不含 `metricNamespace` / `metricName` /
> `threshold` / `operator` / `compareMode` 等任何指标判据字段；
> 实际阈值由策略级的 `targetFreshnessMinutes` 承载（见 2.3）。

#### 1.2.1 `targetType` 静默检测目标类型

仅 `policyType=5` 时有值，其余策略恒为 `null`（**不返回 `0`**，见 §0.6 R-JSON-1）。

| value | label | 心跳表 `alarm_target_heartbeat.target_type` |
| --- | --- | --- |
| `1` | CVM 实例 | `1` |
| `2` | CLB 实例 | `2` |
| `3` | MySQL 实例 | `3` |
| `4` | WEB 服务 | `4` |

> ⚠️ 与 `objectType` **刻意不合并**：`objectType` 描述「告警哪些对象」，
> `targetType` 描述「监控什么类型的目标的数据新鲜度」。两者取值域恰好相同纯属巧合，
> 合并会让「CVM 实例」在两个语境下含义漂移。

### 1.3 `level` 告警等级

| value | label | name |
| --- | --- | --- |
| `1` | 紧急 | `EMERGENCY` |
| `2` | 严重 | `SERIOUS` |
| `3` | 提示 | `NOTICE` |

### 1.4 `period` 统计粒度（分钟）

| value | label |
| --- | --- |
| `1` | 1 分钟 |
| `5` | 5 分钟 |
| `10` | 10 分钟 |
| `30` | 30 分钟 |
| `60` | 60 分钟 |

**枚举校验**：`period ∈ {1, 5, 10, 30, 60}`，且必须是该指标 `metrics.md:periodOptions[]` 的子集。

### 1.5 `operator` 比较关系（字符串）

| value | label |
| --- | --- |
| `>` | 大于 |
| `>=` | 大于等于 |
| `<` | 小于 |
| `<=` | 小于等于 |
| `==` | 等于 |
| `!=` | 不等于 |

DB 存储 `VARCHAR(2)`，**必须原样传输，不做本地化转换**（不要传「大于」）。

#### 1.5.1 `compareMode` 判据模式（v1.1 新增）

| value | label | 含义 |
| --- | --- | --- |
| `absolute` | 绝对阈值 | 当前值 `operator` `threshold`（**v1.0 唯一支持的行为**） |
| `relative` | 相对基线偏离 | 当前值相对基线的偏离百分比 `operator` `threshold` |

**缺省即 `absolute`**。存量策略的该字段为 `NULL`，服务端按 `absolute` 处理。
请求体**省略该字段**与显式传 `"absolute"` 等价。

#### 1.5.2 `baselineType` 基线类型（v1.1 新增，仅 `relative` 时必填）

| value | label | 基线定义 |
| --- | --- | --- |
| `period` | 环比 | 第 `baselineCount + 1` 个 `period` 窗口的均值 |
| `day` | 同比昨日 | 昨日同一时刻起、一个 `period` 长度的均值 |
| `week` | 同比上周 | 上周同一时刻起、一个 `period` 长度的均值 |

#### 1.5.3 `baselineCount` 环比前移周期数（v1.1 新增，仅 `baselineType=period` 时必填）

整数，`1 <= n <= 60`。`n=1` 表示「与前一个周期比」。

#### 1.5.4 相对判据的求值与边界（必须逐条实现）

```
absolute : 命中 ⟺ value OP threshold

relative : baseline = 按 baselineType 取参考窗口均值
           deviation = (value - baseline) / baseline × 100%
           命中 ⟺ deviation OP threshold
```

⚠️ **两条极易实现错的边界，实现方必须显式处理**：

| 情况 | 判定 | 理由 |
| --- | --- | --- |
| `baseline == 0` | **不命中** | 除以 0 无意义。此场景应改用 `absolute` |
| 基线窗口无数据 | **不命中** | 宁可漏报，也不要用「0 当基线」算出天文数字偏离 |
| `baseline < 0` | 用 `abs(value - baseline) / abs(baseline) × 100%` | 直接除会在负基数下**符号翻转**，语义反了 |

**`relative` 模式下 `threshold` 的量纲是百分比，不是指标原单位。**

> ⚠️ **`deviation` 带符号**，所以「涨/跌超 N%」的 `threshold` **要带负号**。
>
> | 想表达 | operator | threshold | 例（value=80, baseline=100, deviation=-20） |
> | --- | --- | --- | --- |
> | 涨超 30% | `>` | `30` | `-20 > 30` → 不命中 ✓ |
> | 跌超 30% | `<` | **`-30`** | `-20 < -30` → 不命中 ✓ |
> | 涨超 30% | `>` | `30` | `deviation=+40` → 命中 ✓ |
>
> **本节初稿曾写过「`operator=<, threshold=30` 表示跌超 30%」，那是错的** ——
> 按公式 `-20 < 30` 恒为真，任何幅度的小幅下跌都会触发，用户却以为只报大跌。
> 现已更正。实现方请以本表为准。
>
> 想避免负号歧义，可以在 UI 上用「跌幅 30%」这类文案并在提交时转成 `-30`；
> 但**契约层就是带符号的**，不要在引擎里取绝对值 —— 那样会丢掉方向，
> `>` 和 `<` 会变得无法区分。

> 判定逻辑属于**告警引擎**，引擎不在本项目范围内。
> 本项目负责：契约、校验、存储、透传。详见 `docs/alarm/metrics-v1.1-design.md`。

### 1.6 `frequency` 告警频次 / 重复通知（分钟）

| value | label |
| --- | --- |
| `0` | 不重复 |
| `5` | 每 5 分钟 |
| `15` | 每 15 分钟 |
| `30` | 每 30 分钟 |
| `60` | 每 1 小时 |
| `180` | 每 3 小时 |
| `360` | 每 6 小时 |
| `720` | 每 12 小时 |
| `1440` | 每 1 天 |

DB 列名 `frequency`（`SMALLINT UNSIGNED`）。重复通知规则：告警产生后 24h 内按此频率重复；超过 24h 每天一次；`0` 表示生命周期内只通知一次。

> ⚠️ **`0`（不重复）是本模块的扩展值**，不在腾讯云原枚举（5分钟/15分钟/30分钟/1小时/3小时/6小时/12小时/1天，共 8 个）之内；
> 其余 8 个取值与腾讯云一一对应。DB CHECK 约束 `ck_condition_frequency` 覆盖全部 9 个值。

### 1.7 `objectType` 告警对象类型

| value | label | 必填的配套字段 |
| --- | --- | --- |
| `1` | 全部对象 | 无 |
| `2` | 指定实例 | `objectIds`（1-1000 个） |
| `3` | 实例分组 | `objectGroupIds`（1-100 个） |
| `4` | 多维筛选 | `objectFilters`（1-10 条） |

`objectType ≠ 2/3/4` 时，对应的 `objectIds` / `objectGroupIds` / `objectFilters` **必须为 `null` 或空数组**，传非空值返回 422。

> 📌 **措辞说明（有意为之）**：本模块用「全部对象」而非腾讯云原文的「全部实例」，语义完全一致——指该 `policyType` 下
> 当前账号**有权限的全部实例**。改称「全部对象」是为了与下面 2/3/4 的「指定实例/实例分组/多维筛选」在同一层级上并列，不产生歧义。

`objectFilters[]` 元素结构：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 维度名，如 `region` / `appId` / `env` / `tag:service` |
| `operator` | string | 是 | 同 1.5 六种取值之一 |
| `values` | string[] | 是 | 1-200 个候选值 |
| `matchType` | string | 否 | `include` / `exclude`，默认 `include` |

### 1.8 `conditionLogic` 条件间逻辑

| value | label | name |
| --- | --- | --- |
| `1` | 满足所有条件 | `AND` |
| `2` | 满足任意条件 | `OR` |

### 1.9 `status` 策略状态

| value | label |
| --- | --- |
| `0` | 停用 |
| `1` | 启用 |

### 1.10 `historyStatus` 告警历史状态（列名 `status`）

| value | label | name |
| --- | --- | --- |
| `1` | 未处理 | `UNHANDLED` |
| `2` | 已处理 | `HANDLED` |
| `3` | 已忽略 | `IGNORED` |
| `4` | 已恢复 | `RECOVERED` |

### 1.11 `notifyChannel` 通知渠道（列名 `channel`）

| value | label | name | 必填字段 |
| --- | --- | --- | --- |
| `1` | 邮件 | `EMAIL` | `receivers` 为邮箱 |
| `2` | 短信 | `SMS` | `receivers` 为手机号 |
| `3` | 微信 | `WECHAT` | `receivers` 为微信号/公众号 |
| `4` | 电话 | `VOICE` | `receivers` 为手机号（仅大陆） |
| `5` | 回调 | `CALLBACK` | `callbackUrl`，`receivers` 必须为空 |

### 1.12 `handleAction` 告警处理动作（字符串）

| value | label | 落库后的 `status` |
| --- | --- | --- |
| `handle` | 处理 | `2` 已处理 |
| `ignore` | 忽略 | `3` 已忽略 |
| `recover` | 恢复 | `4` 已恢复 |

---

## 2. 核心数据对象（DTO）

### 2.1 `AlarmPolicyCondition` 触发条件

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 条件 id。**仅响应返回**，请求体中必须省略 |
| `sort` | int | 策略内排序，1-4，升序。请求必填 |
| `metricNamespace` | string | 指标命名空间，如 `CVM`。必须存在于 `GET /api/alarm/metrics` |
| `metricName` | string | 指标英文名，如 `CpuUtilizationRate` |
| `metricNameCn` | string | 指标中文名，如 `CPU 使用率`。**服务端按字典回填，请求体传入的值一律忽略** |
| `unit` | string | 单位，如 `%`。**服务端按字典回填，请求体传入的值一律忽略** |
| `operator` | string | 见 1.5，必填 |
| `threshold` | number | 阈值，**可负数**，最多 4 位小数，必填 |
| `period` | int | 统计粒度（分钟），见 1.4，必填 |
| `continuity` | int | 持续周期（数据点数），`1 <= continuity <= 10`，必填 |
| `level` | int | 该条件命中后的告警等级，见 1.3，必填 |
| `frequency` | int | 该条件的重复通知频率，见 1.6，必填 |
| `compareMode` | string | 判据模式，见 1.5.1。**可省略**，省略 = `absolute`。`policyType=5` 时**必须省略** |
| `baselineType` | string | 基线类型，见 1.5.2。仅 `compareMode=relative` 时必填，其余必须为 `null` |
| `baselineCount` | int | 环比前移周期数，见 1.5.3。仅 `baselineType=period` 时必填，其余必须为 `null` |

> **v1.1 校验规则**（实现方必须逐条落地）：
> 1. `compareMode=relative` 时 `baselineType` **必填**；`absolute` 时两者必须缺省或为 `null`。
> 2. `baselineType=period` 时 `baselineCount` **必填**且 `1 <= n <= 60`；`day`/`week` 时必须为 `null`。
> 3. `policyType=5`（采集静默）时，本对象的上述 6 个指标判据字段**全部必须缺省**。
> 4. 响应中 `compareMode` 恒有值（`null` 归一化为 `"absolute"`），`baselineType` / `baselineCount` 在 absolute 模式下恒为 `null`。

> **字典字段回填规则**：`metricNameCn` / `unit` 属于派生数据，**永远由服务端从指标字典回填**。前端可以选择带上（便于表单回显），后端忽略请求值。
>
> **字典字段映射**：`metrics.md` 中的 `namespace` ↔ 条件的 `metricNamespace`；`metricName` ↔ `metricName`。唯一键为 `metricNamespace + "." + metricName`。

### 2.2 `AlarmPolicyListItem` 策略列表项

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 策略 id |
| `name` | string | 策略名称 |
| `remark` | string | 备注，可能为 `""` |
| `monitorType` | int | 监控类型 |
| `monitorTypeCn` | string | 监控类型中文名，回填 |
| `policyType` | int | 策略类型 |
| `policyTypeCn` | string | 策略类型中文名，回填 |
| `status` | int | `0` 停用 / `1` 启用 |
| `level` | int | 策略告警等级 = **所有条件中等级最严重者**（数值最小），用于列表筛选与色标 |
| `projectId` | int | 所属项目 id，`0` 表示未分配 |
| `objectType` | int | 告警对象类型 |
| `conditionCount` | int | 触发条件条数（1-4） |
| `notificationTemplateIds` | int[] | 已绑定的通知模板 id 列表（<=3）。**永远返回数组**：DB 存 `NULL` 时按 §0.6 R-JSON-2 补 `[]` |
| `conditionTemplateId` | int | 创建该策略时引用的触发条件模板 id，`0` 表示未使用模板 |
| `creatorName` | string | 创建人姓名 |
| `createdAt` | string | `YYYY-MM-DD HH:mm:ss` |
| `updatedAt` | string | `YYYY-MM-DD HH:mm:ss` |

> 列表接口**不返回** `conditions` 明细与 `objectIds`（避免列表过重），条件数量用 `conditionCount` 表达。

### 2.3 `AlarmPolicyDetail` 策略详情

= `AlarmPolicyListItem` 全部字段 **+** 下列字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `conditions` | `AlarmPolicyCondition[]` | 触发条件数组，长度 1-4，按 `sort` 升序 |
| `objectIds` | int[] \| null | `objectType=2` 时有值，否则 `null`（**不返回 `[]`**，见 §0.6 R-JSON-1） |
| `objectGroupIds` | int[] \| null | `objectType=3` 时有值，否则 `null`（**不返回 `[]`**，见 §0.6 R-JSON-1） |
| `objectFilters` | object[] \| null | `objectType=4` 时有值，元素见 1.7，否则 `null`（**不返回 `[]`**，见 §0.6 R-JSON-1） |
| `conditionLogic` | int | 条件间逻辑，见 1.8 |
| `notificationTemplates` | object[] | **通知模板摘要**，最多 3 个 |

`notificationTemplates[]` 摘要结构（只含 4 个字段，**不返回 `channels` 的接收人明细**——只返回渠道编码数组 `int[]`，避免把接收人信息泄漏到策略详情页）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 模板 id |
| `name` | string | 模板名称 |
| `isPreset` | int | `1` 系统预置 / `0` 自定义 |
| `channels` | int[] | 渠道编码数组（**只给编码，不给接收人**），如 `[1,2]` |

### 2.4 `AlarmConditionTemplate` 触发条件模板

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | int | 响应 | — |
| `name` | string | 是 | 模板名称，1-64 字符，**全局唯一** |
| `remark` | string | 否 | 备注，<=500，默认 `""` |
| `policyType` | int | 是 | 策略类型，见 1.2 |
| `conditions` | `AlarmPolicyCondition[]` | 是 | 条件数组，1-4 条 |
| `isPreset` | int | 否 | `1` 预置 / `0` 自定义，**请求体忽略该字段，仅服务端写入**；6 条预置模板见 `metrics.md` |
| `creatorName` | string | 响应 | 创建人姓名 |
| `createdAt` | string | 响应 | — |
| `updatedAt` | string | 响应 | — |

### 2.5 `AlarmNotificationTemplate` 通知模板

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | int | 响应 | — |
| `name` | string | 是 | 模板名称，1-64 字符，**全局唯一** |
| `remark` | string | 否 | 备注，<=500，默认 `""` |
| `channels` | `NotificationChannel[]` | 是 | 渠道数组，1-5 个，**同一 `channel` 不可重复** |
| `isPreset` | int | 响应 | `1` 预置 / `0` 自定义，请求体传入无效 |
| `creatorName` | string | 响应 | 创建人姓名 |
| `createdAt` | string | 响应 | — |
| `updatedAt` | string | 响应 | — |

`NotificationChannel` 结构：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channel` | int | 是 | 通知渠道，见 1.11 |
| `receivers` | string[] | 是 | 接收人列表，**0-100 个**；`channel=5`（回调）时必须为 `[]`。**预置模板（`isPreset=1`）允许为空数组**——出厂即为空占位，需用户补充；非预置模板应配 1-100 个。是否"配置完成"在**绑定处**统一校验，见 §4.3 N9 |
| `callbackUrl` | string \| null | 否 | 回调地址，`channel=5` 时**必填**（`http(s)://` 开头，<=500 字符）；其他渠道必须为 `null` |
| `silenceTime` | int | 否 | 静默时间（分钟），`0-1440`，默认 `0`（不静默） |

### 2.6 `AlarmHistory` 告警历史

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | int | 历史 id |
| `policyId` | int | 策略 id（策略可能已删除，故历史表无外键） |
| `policyName` | string | 策略名称**快照**（冗余） |
| `level` | int | 告警等级，见 1.3 |
| `status` | int | 历史状态，见 1.10 |
| `conditionId` | int | 触发条件 id快照，`0` 表示未知 |
| `metricNamespace` | string | 指标命名空间快照 |
| `metricName` | string | 指标英文名快照 |
| `metricNameCn` | string | 指标中文名快照 |
| `unit` | string | 单位快照 |
| `operator` | string | 比较关系快照 |
| `threshold` | number | 阈值快照 |
| `actualValue` | number | 实际值，`null` 表示恢复类事件无实测值 |
| `period` | int | 统计粒度快照 |
| `continuity` | int | 持续周期快照 |
| `objectType` | int | 告警对象类型快照 |
| `objectId` | int | 告警实例 id，`0` 表示无具体实例（全部对象场景） |
| `objectName` | string | 告警实例名称 |
| `content` | string | 告警内容摘要，<=500，**服务端生成**，如 `CVM ins-abc123 CPU 使用率 > 80%，实际 92.3%` |
| `triggeredAt` | string | 触发时间 |
| `duration` | int | 持续时长（秒），未恢复为 `0` |
| `recoveredAt` | string \| null | 恢复时间，未恢复为 `null` |
| `handledAt` | string \| null | 处理时间，未处理为 `null` |
| `handleAction` | string \| null | 处理动作，见 1.12；未处理为 `null` |
| `handlerName` | string | 处理人姓名，未处理为 `""` |
| `handleRemark` | string | 处理备注，<=500，未处理为 `""` |
| `notifyCount` | int | 已通知次数（同一 `id` 重复推送计数） |
| `createdAt` | string | 记录创建时间 |

### 2.7 `AlarmMetric` 指标字典条目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `namespace` | string | 命名空间，如 `CVM` |
| `metricName` | string | 指标英文名 |
| `metricNameCn` | string | 指标中文名 |
| `unit` | string | 单位 |
| `policyType` | int[] | 适用的策略类型列表（一个指标可被多个 policyType 复用） |
| `periodOptions` | int[] | 该指标允许的 `period` 取值子集，见 1.4 |
| `defaultOperator` | string | 默认比较关系 |
| `defaultThreshold` | number | 推荐阈值 |
| `suggestedContinuity` | int | 推荐持续周期，1-10 |
| `description` | string | 指标说明 |

内容**唯一来源：`metrics.md` §1**（共 **38** 个指标）。`GET /api/alarm/metrics` 由该文档驱动实现，

| `targetType` | int \| null | 仅 `policyType=5` 时有值，见 1.2.1，否则 `null`（**不返回 `0`**） |
| `targetFreshnessMinutes` | int \| null | 数据静默超过该分钟数即告警，`5 <= n <= 10080`。仅 `policyType=5` 时有值，否则 `null` |
> 本契约不重复列举指标，避免两处漂移。

---

### 2.8 服务端内部列（不出现在任何 API DTO 中）

以下 DB 列由服务端自行维护，**不出现在任何请求体/响应体中**，前端无需也不应感知。它们不是"漏写"，
而是刻意不对外暴露的内部/冗余列：

| 表 | 列 | 用途 | 为何不对外 |
| --- | --- | --- | --- |
| `alarm_policy_condition` | `created_at` | 子行创建时间 | 条件随策略整体替换（PUT 为先删后插），单独暴露没有稳定语义 |
| `alarm_policy_condition` | `updated_at` | 子行更新时间 | 同上 |
| `alarm_notification_receiver` | `template_id` | 冗余外键，指向所属通知模板 | 该表是 `channels` JSON 的**冗余明细**，不作为独立 DTO 暴露（读取一律以 `channels` 为准） |
| `alarm_notification_receiver` | `contact` | 接收人标识（邮箱/手机号/微信号/回调地址） | 同上；接收人只经由 `NotificationTemplate.channels[].receivers` 读写 |

> 合计 **4 个**内部列（字段一致性自检按 `45 − 4 = 41` 组计）。
> 同表的 `id` / `channel` / `created_at` / `updated_at` 是明细行的常规技术列，同样不对外，无需单列。
>
> **实现提示**：写通知模板时，`channels` JSON 与 `alarm_notification_receiver` 明细必须在**同一事务**内写入；
> 读模板时**一律以 `channels` 为准**，receiver 表只服务于**模板内去重**（唯一键是
> `(template_id, channel, contact)`，**不保证**同一 contact 跨模板唯一）与未来订阅查询。

---

## 3. 端点清单

### 3.1 策略（7 个端点：①-⑦）

---

#### ① `GET /api/alarm/policies` 策略分页列表

**查询参数**

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `keyword` | string | 否 | — | 模糊匹配 `name` / `remark`，<=128 |
| `monitorType` | int | 否 | — | 见 1.1 |
| `policyType` | int | 否 | — | 见 1.2 |
| `status` | int | 否 | — | 见 1.9 |
| `level` | int | 否 | — | 见 1.3 |
| `projectId` | int | 否 | — | 所属项目 id |
| `page` | int | 否 | 1 | 见 0.3 |
| `pageSize` | int | 否 | 20 | 见 0.3 |

多个筛选条件之间为 **AND**；空字符串视为未传（不参与筛选）。非法枚举值返回 422。

**响应**：`data` = `{ list: AlarmPolicyListItem[], total, page, pageSize }`

**示例**

```jsonc
// GET /api/alarm/policies?keyword=CPU&policyType=2&status=1&page=1&pageSize=20
{
  "data": {
    "list": [
      {
        "id": 1001,
        "name": "生产 CVM CPU 监控",
        "remark": "核心交易集群",
        "monitorType": 1,
        "monitorTypeCn": "云产品监控",
        "policyType": 2,
        "policyTypeCn": "云服务器 CVM",
        "status": 1,
        "level": 1,
        "projectId": 12,
        "objectType": 2,
        "conditionCount": 2,
        "notificationTemplateIds": [3, 5],
        "conditionTemplateId": 0,
        "creatorName": "张三",
        "createdAt": "2026-09-20 10:12:33",
        "updatedAt": "2026-09-28 15:02:11"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  },
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

---

#### ② `GET /api/alarm/policies/{id}` 策略详情

**路径参数**：`id`（int，必填）—— 策略 id

**响应**：`data` = `AlarmPolicyDetail`（含 `conditions[]` 与 `notificationTemplates[]` 摘要）

**示例**

```jsonc
// GET /api/alarm/policies/1001
{
  "data": {
    "id": 1001,
    "name": "生产 CVM CPU 监控",
    "remark": "核心交易集群",
    "monitorType": 1,
    "monitorTypeCn": "云产品监控",
    "policyType": 2,
    "policyTypeCn": "云服务器 CVM",
    "status": 1,
    "level": 1,
    "projectId": 12,
    "objectType": 2,
    "objectIds": [8801, 8802],
    "objectGroupIds": null,
    "objectFilters": null,
    "conditionLogic": 2,
    "conditionTemplateId": 0,
    "conditions": [
      {
        "id": 7001,
        "sort": 1,
        "metricNamespace": "CVM",
        "metricName": "CpuUtilizationRate",
        "metricNameCn": "CPU 使用率",
        "unit": "%",
        "operator": ">",
        "threshold": 90,
        "period": 5,
        "continuity": 3,
        "level": 1,
        "frequency": 15
      },
      {
        "id": 7002,
        "sort": 2,
        "metricNamespace": "CVM",
        "metricName": "MemoryUsageRate",
        "metricNameCn": "内存使用率",
        "unit": "%",
        "operator": ">",
        "threshold": 85,
        "period": 5,
        "continuity": 2,
        "level": 2,
        "frequency": 30
      }
    ],
    "notificationTemplateIds": [3, 5],
    "notificationTemplates": [
      { "id": 3, "name": "运维值班组", "isPreset": 0, "channels": [1, 2] },
      { "id": 5, "name": "系统预置-邮件通知", "isPreset": 1, "channels": [1] }
    ],
    "conditionCount": 2,
    "creatorName": "张三",
    "createdAt": "2026-09-20 10:12:33",
    "updatedAt": "2026-09-28 15:02:11"
  },
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

**错误**：id 不存在 → `404 NOT_FOUND`

---

#### ③ `POST /api/alarm/policies` 创建策略

**请求体字段**（全量，对应 `AlarmPolicyDetail` 的可写部分）

| 字段 | 类型 | 必填 | 默认 | 校验 |
| --- | --- | --- | --- | --- |
| `name` | string | **是** | — | 1-128 字符，**全局唯一**，去首尾空格后非空 |
| `remark` | string | 否 | `""` | <=500 |
| `monitorType` | int | **是** | — | 见 1.1，且须有可用 policyType |
| `policyType` | int | **是** | — | 见 1.2，且须属于 `monitorType` |
| `projectId` | int | 否 | `0` | `>= 0` |
| `objectType` | int | **是** | — | 见 1.7 |
| `objectIds` | int[] | 条件必填 | `null` | `objectType=2` 时 1-1000 个；其他情况必须为 `null`/`[]` |
| `objectGroupIds` | int[] | 条件必填 | `null` | `objectType=3` 时 1-100 个 |
| `objectFilters` | object[] | 条件必填 | `null` | `objectType=4` 时 1-10 条，结构见 1.7 |
| `conditionLogic` | int | 否 | `1` | 见 1.8 |
| `conditions` | `AlarmPolicyCondition[]` | **是** | — | **1-4 条**；每条必须完整含 `sort/metricNamespace/metricName/operator/threshold/period/continuity/level/frequency`；`sort` 必须为 1..N 连续升序且不重复 |
| `notificationTemplateIds` | int[] | 否 | `[]` | **最多 3 个**，不重复，id 均须存在。落库时 `[]`/`null` 均写为 `NULL`，见 §0.6 |
| `conditionTemplateId` | int | 否 | `0` | 若 `>0` 则该模板须存在且 `policyType` 一致 |
| `status` | int | 否 | `0` | 见 1.9。`1` 表示创建即启用 |

**服务端行为**
1. `conditions[].metricNameCn` / `unit` 从指标字典回填。
2. 派生 `level` = `min(conditions[].level)`（最严重），仅存冗余列供列表筛选。
3. `creatorId` / `creatorName` 取当前登录人，**请求体传入无效**。
4. `id` / `createdAt` / `updatedAt` 服务端生成。
5. 落库顺序：先插 `alarm_policy`，再批量插 `alarm_policy_condition`（同一事务）。

**响应**：`data` = `AlarmPolicyDetail`

**示例**

```jsonc
// POST /api/alarm/policies
// 请求
{
  "name": "生产 CVM CPU 监控",
  "remark": "核心交易集群",
  "monitorType": 1,
  "policyType": 2,
  "projectId": 12,
  "objectType": 2,
  "objectIds": [8801, 8802],
  "conditionLogic": 2,
  "status": 1,
  "conditions": [
    { "sort": 1, "metricNamespace": "CVM", "metricName": "CpuUtilizationRate",
      "operator": ">", "threshold": 90, "period": 5, "continuity": 3, "level": 1, "frequency": 15 }
  ],
  "notificationTemplateIds": [3, 5]
}

// 响应
{
  "data": { "id": 1001, "name": "生产 CVM CPU 监控", "status": 1, "level": 1, "conditionCount": 1, "...": "同上表全部字段" },
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

**错误**：`422 VALIDATION_ERROR`（字段级）、`409 POLICY_NAME_DUPLICATED`

---

#### ④ `PUT /api/alarm/policies/{id}` 更新策略（**全量更新语义**）

**路径参数**：`id`（int，必填）

**语义**：请求体字段与 `POST` 完全一致，**未传的字段一律回落到默认值（等价于删除后重建子资源）**。因此：
- 省略 `conditions` → 视为清空 → 因 1-4 条约束直接返回 422（这是刻意的，避免误清空）。
- 省略 `objectIds` 且 `objectType=2` → 422。
- 省略 `remark` → 置为 `""`。
- 省略 `status` → **保持原值不变**（启停只能通过 `POST /status`，避免误改）。这是唯一不回落默认的字段。

**处理流程**：事务内 `DELETE FROM alarm_policy_condition WHERE policy_id = ?` → 重新批量插入；`alarm_policy` 主表按传入字段 `UPDATE`（`status` 除外）。

**响应**：`data` = `AlarmPolicyDetail`（更新后的完整详情）

**错误**：`404 NOT_FOUND`、`422 VALIDATION_ERROR`、`409 POLICY_NAME_DUPLICATED`（新名称与自身或其他策略冲突）

---

#### ⑤ `DELETE /api/alarm/policies/{id}` 删除策略

**路径参数**：`id`（int，必填）

**前置校验（顺序固定，命中即返回）**

1. 策略不存在 → `404 NOT_FOUND`
2. **`status === 1`（启用中）→ `409 POLICY_STATUS_CONFLICT`**，message：`已启用的策略不可删除，请先停用`
3. 正常删除：`alarm_policy_condition` 随主记录级联删除；`alarm_history` **保留**（历史表无外键）

**响应**：`data` = `true`

```jsonc
{ "data": true, "extra": {}, "code": 0, "message": "success", "success": true }
```

---

#### ⑥ `POST /api/alarm/policies/{id}/status` 启停策略

**路径参数**：`id`（int，必填）

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | int | **是** | `1` 启用 / `0` 停用 |

**响应**：`data` = `AlarmPolicyDetail`（启停后的完整详情，便于前端直接刷新行内开关）

```jsonc
// 请求
{ "status": 0 }
// 响应 data（节选）
{ "id": 1001, "status": 0, "updatedAt": "2026-09-30 09:00:00", "...": "..." }
```

**幂等**：重复提交相同 `status` 视为成功（不返回 409）。

**错误**：`404 NOT_FOUND`、`422 VALIDATION_ERROR`（`status` 非 0/1）

---

#### ⑦ `POST /api/alarm/policies/{id}/copy` 复制策略

**路径参数**：`id`（int，必填）

**请求体**：无（可为空对象 `{}`）

**服务端行为**
1. 源策略不存在 → `404 NOT_FOUND`。
2. 深拷贝 `alarm_policy`（**不继承** `id`、`creatorId`、`creatorName`、`createdAt`、`updatedAt`）与全部 `alarm_policy_condition`（**不继承** `condition.id`，`policy_id` 指向新策略）。
3. 新 `name` 生成规则：`{原名} - 副本`，若已存在则依次尝试 `{原名} - 副本(2)`、`(3)`……最多尝试到 `(99)`，仍冲突返回 `409`。
   **长度保护**：拼接后总长必须 `<= 128`，长度一律按**字符**计（`VARCHAR(128)` 与 `ck_policy_name_len` 的 `CHAR_LENGTH` 都按字符计，与 domain.md §5.4 的 `truncateUtf8` 一致）。
   超长时按**字符**截断原名至 `128 - 后缀字符数` 再拼接：后缀 ` - 副本` = **5 个字符**（9 字节），带序号的 ` - 副本(2)` = 8 个字符（12 字节）。
   ⚠️ **禁止按字节截断**——utf8mb4 下 128 个汉字 = 384 字节，按字节截断会切出半截字符并产生 3 字节数不一致的结果。
4. 新策略 `status` **强制为 `0`（停用）** —— 复制出的策略默认不生效，需人工确认后启用。
5. `remark` 原样继承，可在返回后由用户编辑。
6. `notificationTemplateIds` / `objectIds` / `objectGroupIds` / `objectFilters` / `conditionTemplateId` 原样继承。
7. `creatorId` / `creatorName` = **当前登录人**。

**响应**：`data` = `{ "id": 1002, "name": "生产 CVM CPU 监控 - 副本" }`

```jsonc
{
  "data": { "id": 1002, "name": "生产 CVM CPU 监控 - 副本" },
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

**错误**：`404 NOT_FOUND`、`409 POLICY_NAME_DUPLICATED`（重试 99 次后仍冲突）

---

### 3.2 指标与模板（9 个端点：⑧-⑯）

---

#### ⑧ `GET /api/alarm/metrics` 指标字典

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `policyType` | int | 否 | 按策略类型过滤，只返回 `policyType[]` 包含该值的指标 |
| `namespace` | string | 否 | 按命名空间精确过滤 |
| `keyword` | string | 否 | 模糊匹配 `metricName` / `metricNameCn` |

**响应**：`data` = `AlarmMetric[]`（**不分页**，固定 **38** 条，唯一来源 `metrics.md` §1）

```jsonc
{
  "data": [
    {
      "namespace": "CVM",
      "metricName": "CpuUtilizationRate",
      "metricNameCn": "CPU 使用率",
      "unit": "%",
      "policyType": [2],
      "periodOptions": [1, 5, 10, 30, 60],
      "defaultOperator": ">",
      "defaultThreshold": 80,
      "suggestedContinuity": 3,
      "description": "统计周期内实例 CPU 使用率平均值，单位 %，取值 0-100。"
    }
  ],
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

---

#### ⑨ `GET /api/alarm/condition-templates` 触发条件模板分页

**查询参数**：`policyType`(int,否)、`keyword`(string,否)、`isPreset`(int,否)、`page`、`pageSize`

**响应**：`data` = `{ list: AlarmConditionTemplate[], total, page, pageSize }`

---

#### ⑩ `POST /api/alarm/condition-templates` 创建条件模板

**请求体**：`AlarmConditionTemplate` 的可写字段（`name` / `remark` / `policyType` / `conditions`），字段表见 2.4。
**额外规则**：`conditions` 中 1-4 条；`policyType` 下所有 `metricNamespace` 必须属于该 policyType。

**响应**：`data` = `AlarmConditionTemplate`
**错误**：`422 VALIDATION_ERROR`、`409 POLICY_NAME_DUPLICATED`（模板名同样唯一）

---

#### ⑪ `PUT /api/alarm/condition-templates/{id}` 更新条件模板

**路径参数**：`id`（int，必填）　**请求体**：同创建（**全量更新语义**）　**响应**：`data` = `AlarmConditionTemplate`
**额外规则**：`isPreset=1` 的预置模板**允许修改**（仅禁止删除），修改后 `isPreset` 保持 `1`。
**错误**：`404`、`422`、`409`

---

#### ⑫ `DELETE /api/alarm/condition-templates/{id}` 删除条件模板

**前置校验顺序**：不存在 → `404`；`isPreset=1` → `409 PRESET_READONLY`（message：`预置模板不可删除`）；被 `alarm_policy.condition_template_id` 引用 → `409 TEMPLATE_IN_USE`。

**响应**：`data` = `true`

---

#### ⑬ `GET /api/alarm/notification-templates` 通知模板分页

**查询参数**：`keyword`(string,否)、`channel`(int,否，按渠道过滤)、`isPreset`(int,否)、`page`、`pageSize`

**响应**：`data` = `{ list: AlarmNotificationTemplate[], total, page, pageSize }`（列表接口**返回完整 `channels`**，因为通知模板管理页需要编辑接收人）

---

#### ⑭ `POST /api/alarm/notification-templates` 创建通知模板

**请求体**：`AlarmNotificationTemplate` 可写字段（`name` / `remark` / `channels`），字段表见 2.5。
**额外规则**：`channels` 1-5 条，`channel` 不可重复；`channel=5` 时 `callbackUrl` 必填且 `receivers` 必须为空数组。

**响应**：`data` = `AlarmNotificationTemplate`
**错误**：`422`、`409 POLICY_NAME_DUPLICATED`

---

#### ⑮ `PUT /api/alarm/notification-templates/{id}` 更新通知模板

全量更新语义。`isPreset=1` 允许修改、禁止删除。
**响应**：`data` = `AlarmNotificationTemplate`　**错误**：`404`、`422`、`409`

---

#### ⑯ `DELETE /api/alarm/notification-templates/{id}` 删除通知模板

**前置校验顺序**：不存在 → `404`；`isPreset=1` → `409 PRESET_READONLY`；被任意 `alarm_policy.notification_template_ids` 引用 → `409 TEMPLATE_IN_USE`。
引用检查 SQL（JSON 列）：

```sql
SELECT id, name FROM alarm_policy
WHERE JSON_CONTAINS(notification_template_ids, CAST(:tid AS JSON))
LIMIT 1;
```

**响应**：`data` = `true`

---

### 3.3 告警历史与统计（3 个端点：⑰-⑲）

---

#### ⑰ `GET /api/alarm/histories` 告警历史分页

**查询参数**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `policyId` | int | 否 | 按策略过滤 |
| `level` | int | 否 | 见 1.3 |
| `status` | int | 否 | 见 1.10 |
| `keyword` | string | 否 | 模糊匹配 `policyName` / `objectName` / `metricNameCn`，<=128 |
| `startTime` | string | 否 | 触发时间下界（含），`YYYY-MM-DD HH:mm:ss` |
| `endTime` | string | 否 | 触发时间上界（含），`YYYY-MM-DD HH:mm:ss` |
| `page` / `pageSize` | int | 否 | 见 0.3 |

约束：`startTime <= endTime`，否则 422。排序固定 `triggered_at DESC, id DESC`。

**响应**：`data` = `{ list: AlarmHistory[], total, page, pageSize }`

**示例**

```jsonc
// GET /api/alarm/histories?level=1&status=1&startTime=2026-09-01 00:00:00&endTime=2026-09-30 23:59:59
{
  "data": {
    "list": [
      {
        "id": 90001,
        "policyId": 1001,
        "policyName": "生产 CVM CPU 监控",
        "level": 1,
        "status": 1,
        "conditionId": 7001,
        "metricNamespace": "CVM",
        "metricName": "CpuUtilizationRate",
        "metricNameCn": "CPU 使用率",
        "unit": "%",
        "operator": ">",
        "threshold": 90,
        "actualValue": 96.4,
        "period": 5,
        "continuity": 3,
        "objectType": 2,
        "objectId": 8801,
        "objectName": "prod-web-01",
        "content": "CVM prod-web-01 CPU 使用率 > 90%，实际 96.4%",
        "triggeredAt": "2026-09-30 03:15:00",
        "duration": 0,
        "recoveredAt": null,
        "handledAt": null,
        "handleAction": null,
        "handlerName": "",
        "handleRemark": "",
        "notifyCount": 3,
        "createdAt": "2026-09-30 03:15:01"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  },
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

---

#### ⑱ `POST /api/alarm/histories/{id}/handle` 处理告警

**路径参数**：`id`（int，必填）—— 告警历史 id

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | **是** | `handle` / `ignore` / `recover`，见 1.12 |
| `remark` | string | 否 | 处理备注，<=500，默认 `""` |

**服务端行为**
1. 历史不存在 → `404`。
2. `status !== 1`（非未处理）→ `409 HISTORY_ALREADY_HANDLED`，message：`该告警已处理，不可重复处理`。
3. 落库：`status` 按 1.12 映射；`handle_action` = `action`；`handled_at` = 当前时间；`handler_name` = 当前登录人。
4. `action = recover` 时额外置 `recovered_at` = 当前时间，`duration` = `recovered_at - triggered_at`（秒，最小 0）。

**响应**：`data` = `AlarmHistory`（更新后）

```jsonc
// 请求
{ "action": "handle", "remark": "已扩容并重启服务" }
// 响应 data（节选）
{ "id": 90001, "status": 2, "handleAction": "handle",
  "handledAt": "2026-09-30 09:20:00", "handlerName": "李四",
  "handleRemark": "已扩容并重启服务", "...": "..." }
```

---

#### ⑲ `GET /api/alarm/overview` 首页统计

**查询参数**：无（统计范围固定为「当前用户有权限的全部数据」）

**响应**：`data` = `AlarmOverview`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `todayTotal` | int | 今日（服务器自然日 00:00:00 起）告警总数 |
| `todayUnhandled` | int | 今日告警中 `status=1`（未处理）的条数 |
| `policyTotal` | int | 策略总数 |
| `policyEnabledTotal` | int | `status=1` 的策略数 |
| `levelDistribution` | object[] | 今日按等级分布，**固定 3 项、level 升序**（1,2,3），无数据补 0 |
| `trend7Days` | object[] | 近 7 天（含今日）趋势，**固定 7 项、date 升序**，无数据补 0 |

`levelDistribution[]` 元素（固定 3 项，`level` 升序，无数据补 0）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `level` | int | 告警等级，见 1.3 |
| `levelCn` | string | 等级中文名，服务端回填 |
| `count` | number | 今日该等级的告警条数 |

`trend7Days[]` 元素（固定 7 项，`date` 升序，无数据补 0）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | string | `YYYY-MM-DD` |
| `total` | number | 当日告警总数 |
| `unhandled` | number | 当日未处理（`status=1`）条数 |

**示例**

```jsonc
{
  "data": {
    "todayTotal": 27,
    "todayUnhandled": 9,
    "policyTotal": 128,
    "policyEnabledTotal": 96,
    "levelDistribution": [
      { "level": 1, "levelCn": "紧急", "count": 3 },
      { "level": 2, "levelCn": "严重", "count": 8 },
      { "level": 3, "levelCn": "提示", "count": 16 }
    ],
    "trend7Days": [
      { "date": "2026-09-24", "total": 18, "unhandled": 4 },
      { "date": "2026-09-25", "total": 25, "unhandled": 7 },
      { "date": "2026-09-26", "total": 9,  "unhandled": 2 },
      { "date": "2026-09-27", "total": 31, "unhandled": 12 },
      { "date": "2026-09-28", "total": 22, "unhandled": 5 },
      { "date": "2026-09-29", "total": 14, "unhandled": 3 },
      { "date": "2026-09-30", "total": 27, "unhandled": 9 }
    ]
  },
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

---

## 4. 业务约束汇总（实现必须逐条落地）

### 4.1 策略

| # | 规则 | 违反时 |
| --- | --- | --- |
| P1 | `name` 去首尾空格后长度 1-128，**全局唯一**（含副本） | 422 / 409 |
| P2 | `remark` <= 500 | 422 |
| P3 | `monitorType` 与 `policyType` 必须匹配（见 1.1 联动表） | 422 |
| P4 | 每策略 `conditions` **1-4 条** | 422 |
| P5 | `conditions[].sort` 必须为 1..N 连续升序且不重复 | 422 |
| P6 | `conditions[].threshold` 为数值，**可负数**，最多 4 位小数 | 422 |
| P7 | `conditions[].continuity` ∈ [1, 10] | 422 |
| P8 | `conditions[].period` ∈ {1,5,10,30,60} **且**属于该指标的 `periodOptions` | 422 |
| P9 | `conditions[].operator` ∈ {`>`,`>=`,`<`,`<=`,`==`,`!=`} | 422 |
| P10 | **只要 `conditions.length >= 1`（即恒成立），每条条件必须完整提供** `metricNamespace/metricName/operator/threshold/period/continuity/level/frequency`，**缺一即 422**（不做默认值兜底；**应用层不得依赖 DB 列默认值，必须显式传值**，见 `schema.sql` 中 `sort`/`level`/`frequency` 的 DEFAULT） | 422 |
| P11 | `conditions[].level` ∈ {1,2,3}，`conditions[].frequency` ∈ 1.6 枚举 | 422 |
| P12 | 每策略**最多绑定 3 个** `notificationTemplateIds` | 422 |
| P13 | `notificationTemplateIds` 内不得重复，且 id 均须存在（另见 §4.3 **N9**：未配好接收人的模板不可被绑定） | 422 |
| P14 | `objectType` 与 `objectIds/objectGroupIds/objectFilters` 三者一一对应，其余必须为 `null`/`[]` | 422 |
| P15 | **仅 `status=0`（停用）的策略可删除**，否则 409 | 409 |
| P16 | **复制策略不继承 `id` 与创建人**（`creatorId`/`creatorName` 归当前登录人），新策略 `status=0` | — |
| P17 | 策略 `level`（列表筛选用）= `min(conditions[].level)` | — |
| P18 | `PUT` 为全量更新；`status` 是唯一不回落默认的字段 | — |
| P19 | `POST /status` 幂等，重复设置相同值返回成功 | — |

### 4.2 条件模板

| # | 规则 | 违反时 |
| --- | --- | --- |
| T1 | `name` 1-64 字符，全局唯一 | 422 / 409 |
| T2 | `conditions` 1-4 条，字段完整性同 P4-P11 | 422 |
| T3 | 模板内所有指标的 `metricNamespace` 必须属于模板的 `policyType` | 422 |
| T4 | `isPreset=1` 的模板**禁止删除**（可修改） | 409 |
| T5 | 被 `alarm_policy.condition_template_id` 引用的模板**禁止删除** | 409 |

### 4.3 通知模板

| # | 规则 | 违反时 |
| --- | --- | --- |
| N1 | `name` 1-64 字符，全局唯一 | 422 / 409 |
| N2 | `channels` 1-5 条，`channel` 不得重复 | 422 |
| N3 | `channel=5`（回调）：`callbackUrl` 必填（`http(s)://` 开头，<=500），`receivers` 必须为空 | 422 |
| N4 | `channel≠5`：`callbackUrl` 必须为 `null` | 422 |
| N5 | `receivers` **0-100 个**；邮箱/手机号需通过基础格式校验。预置模板（`isPreset=1`）允许为空数组（出厂占位，用户需补充后才能真正投递） | 422 |
| N9 | **绑定校验**：策略的 `notificationTemplateIds` 中，凡存在 `channel≠5` 且该渠道 `receivers` 为空的模板，视为**未配置完成**，拒绝绑定；`message` 须指出是哪几个模板名未配置 | 422 |
| N6 | `silenceTime` ∈ [0, 1440]，默认 0 | 422 |
| N7 | `isPreset=1` 的模板禁止删除 | 409 |
| N8 | 被任意策略 `notification_template_ids` 引用的模板禁止删除 | 409 |

### 4.4 告警历史

| # | 规则 | 违反时 |
| --- | --- | --- |
| H1 | `action` ∈ {`handle`,`ignore`,`recover`} | 422 |
| H2 | `remark` <= 500 | 422 |
| H3 | **仅 `status=1`（未处理）的历史可处理**，否则 409 | 409 |
| H4 | `startTime <= endTime` | 422 |
| H5 | 历史记录**不提供删除端点**，只增不改状态 | — |

---

## 5. 端点速查表

| # | 方法 | 路径 | 请求体 | `data` 响应 | 主要错误 |
| --- | --- | --- | --- | --- | --- |
| ① | GET | `/api/alarm/policies` | - | `Page<AlarmPolicyListItem>` | 422 |
| ② | GET | `/api/alarm/policies/{id}` | - | `AlarmPolicyDetail` | 404 |
| ③ | POST | `/api/alarm/policies` | 创建字段 | `AlarmPolicyDetail` | 422, 409 |
| ④ | PUT | `/api/alarm/policies/{id}` | 创建字段（全量） | `AlarmPolicyDetail` | 404, 422, 409 |
| ⑤ | DELETE | `/api/alarm/policies/{id}` | - | `true` | 404, **409** |
| ⑥ | POST | `/api/alarm/policies/{id}/status` | `{status}` | `AlarmPolicyDetail` | 404, 422 |
| ⑦ | POST | `/api/alarm/policies/{id}/copy` | - | `{id, name}` | 404, 409 |
| ⑧ | GET | `/api/alarm/metrics` | - | `AlarmMetric[]` | 422 |
| ⑨ | GET | `/api/alarm/condition-templates` | - | `Page<AlarmConditionTemplate>` | 422 |
| ⑩ | POST | `/api/alarm/condition-templates` | 模板字段 | `AlarmConditionTemplate` | 422, 409 |
| ⑪ | PUT | `/api/alarm/condition-templates/{id}` | 模板字段（全量） | `AlarmConditionTemplate` | 404, 422, 409 |
| ⑫ | DELETE | `/api/alarm/condition-templates/{id}` | - | `true` | 404, 409 |
| ⑬ | GET | `/api/alarm/notification-templates` | - | `Page<AlarmNotificationTemplate>` | 422 |
| ⑭ | POST | `/api/alarm/notification-templates` | 模板字段 | `AlarmNotificationTemplate` | 422, 409 |
| ⑮ | PUT | `/api/alarm/notification-templates/{id}` | 模板字段（全量） | `AlarmNotificationTemplate` | 404, 422, 409 |
| ⑯ | DELETE | `/api/alarm/notification-templates/{id}` | - | `true` | 404, 409 |
| ⑰ | GET | `/api/alarm/histories` | - | `Page<AlarmHistory>` | 422 |
| ⑱ | POST | `/api/alarm/histories/{id}/handle` | `{action, remark}` | `AlarmHistory` | 404, **409**, 422 |
| ⑲ | GET | `/api/alarm/overview` | - | `AlarmOverview` | 401 |

---

## 6. 前后端对接检查清单

- [ ] 所有响应都包在 `{data, extra, code, message, success}` 中，失败时 `data === null`
- [ ] 列表接口 `data` 是 `{list,total,page,pageSize}`，不是裸数组
- [ ] `PUT /policies/{id}` 前端必须**提交完整表单**（含所有条件），因为是全量更新
- [ ] 删除策略前，前端先看 `status`：为 `1` 时禁用删除按钮（或提示先停用），避免必然 409
- [ ] `operator` 原样发送 `> / >= / < / <= / == / !=`，不要本地化
- [ ] 等级/状态等下拉一律用**数值 value**，label 取中文名
- [ ] 指标选择器数据源是 `GET /api/alarm/metrics?policyType=x`，选定后用 `defaultOperator/defaultThreshold/suggestedContinuity/periodOptions` 预填条件表单
- [ ] 详情页的 `notificationTemplates[].channels` 是**编码数组**，不是对象数组（仅模板管理页才是完整对象）
- [ ] `conditions[].metricNameCn` / `unit` 无需前端计算（后端回填），但表单回显要用后端返回值
- [ ] `notificationTemplateIds` 永远拿到数组（不用判空）；`objectIds` / `objectGroupIds` / `objectFilters` 永远拿到 `null` 而非 `[]`（按 §0.6 R-JSON-1/2）
