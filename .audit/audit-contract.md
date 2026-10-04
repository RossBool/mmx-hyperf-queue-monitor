# 攻击线 C：契约一致性与前后端漂移 —— 审查报告

> 审查者：General（对抗式审查者，默认立场「存在漂移，直到逐字段比对过为止」）
> 唯一事实来源：`/workspace/docs/alarm/contract.md` v1.0（2026-09-30，已冻结）
> 审查时间：2026-10-03　范围：策略相关 7 端点（①-⑦）+ 契约声明的全部 12 组枚举 + §2 全部 DTO + §0.6 JSON 归一化 + schema.sql DDL
> 只读审查：**未修改 /workspace 下任何项目文件**（仅新增本报告）

---

## 0. 结论摘要

| 检查项 | 规模 | 结果 |
| --- | --- | --- |
| 12 组枚举（三方值集合 + 中文 label） | 12 组 | **12/12 完全一致**，0 遗漏值、0 多出值、0 文案差异 |
| §2 DTO 字段（契约 ↔ 前端 TS ↔ 后端 Presenter） | 98 字段次 / 60 个去重字段名 | **逐字段 1:1**，0 缺失、0 多出、0 类型方向相反 |
| DDL 列 ↔ DTO 字段 | 6 表 88 列 | 列名/可空性/默认值**一一对应**；派生字段（`*Cn`/`conditionCount`/`notificationTemplates`）按契约语义无对应列，符合预期 |
| `operator` 契约 | 6 值 × 3 端 | **两端都当符号字符串**，无本地化泄漏；DB `VARCHAR(2)` + CHECK 一致 |
| JSON 空值归一化（§0.6 R-JSON-1/2） | 4 列 × 读/写双向 | **后端与前端消费侧均一致**，未发现 `undefined` / `""` 顶替 `null` |

**发现的漂移：3 个 P0（会直接导致错误响应或写库失败）、2 个 P2、4 个 P3。** 枚举与 DTO 字段层面反而是干净的部分，漂移集中在**错误码语义、必填性裁决、写入键名、契约自身元数据**四处。

**复现方式**：本报告全部数据由 4 个脚本机械产出（写在 `/tmp/audit/`，只读输入）：

| 脚本 | 作用 | 输出 |
| --- | --- | --- |
| `/tmp/audit/enum_compare.py` | 12 组枚举三方比对（含 label 文案、逐值行号） | stdout + `/tmp/audit/enum_report.json` |
| `/tmp/audit/field_compare.py` | §2 九组 DTO × 前端 interface × Presenter 输出键 × schema 列 | stdout + `/tmp/audit/field_report.json` |
| `/tmp/audit/ddl_dto_map.py` | DDL 列 ↔ DTO 字段 snake↔camel 映射核对 | stdout + `/tmp/audit/ddl_map.json` |
| `/tmp/audit/summary_counts.py` | 内部列清单 / §2.8 自洽性计数 | stdout |
| `/tmp/audit/verify_findings.py` | 5 个硬性发现的逐行取证 | stdout |
| `/tmp/audit/endpoint_fields.py` | ①-⑦ 逐端点逐字段表（本文 §3） | `/tmp/audit/endpoint_table.md` |

> ⚠️ **执行环境限制（必须声明）**：沙箱内**无 PHP、无 Composer、无 `server/vendor/`、无 MySQL**，因此本报告 **100% 为静态审查**，没有运行过任何一行后端代码；所有结论均为源码级证据，不含任何伪造的运行结果。脚本只做文本/结构解析（Python 标准库）。

---

## 1. 漂移表（核心产出）

字段名 = 契约字段名；证据列给出 `文件:行`。

| # | 端点 / 位置 | 字段 / 主题 | 契约定义 | 前端实现 | 后端实现 | DDL 定义 | 是否一致 | 证据行号 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **D-1** | 全模块（①-⑲）/ `ErrorCode` | `message`（409 的 5 个语义分支） | §0.5：409 下 5 个分支各有**独立中文文案**（已启用的策略不可删除…/策略名称已存在/模板已被策略引用…/预置模板不可删除/该告警已处理…），「message 不同」即区分方式 | 只按 `code===409` 统一提示（契约允许，✔ 无漂移） | 5 个常量数值全等 409 → `MESSAGES` 字面量**同键后写覆盖** → `ErrorCode::message(409)` 恒为 `该告警已处理，不可重复处理` | — | ❌ **漂移（P0）** | 契约 `contract.md:111-115,119`；后端 `ErrorCode.php:19-23,29-41,43-46`；消费点 `AlarmExceptionHandler.php:78`、`AlarmPolicyService.php:262`、`BusinessException.php:27,50-53` |
| **D-2** | ⑥ `POST /policies/{id}/status` | `status` | §3.1 ⑥ 请求体表：`status` \| int \| **是**；错误含 `422 VALIDATION_ERROR`（`status` 非 0/1） | `AlarmPolicyStatusPayload.status: AlarmPolicyStatus`（必填，✔） | 控制器 `$body['status'] ?? null` → 复用 ③ 的 `assertStatus()`：`null`/`''` → **直接 return 0 且不记错** → 200 + 把策略静默改成停用 | `alarm_policy.status TINYINT UNSIGNED NOT NULL DEFAULT 0` | ❌ **漂移（P0）**：缺字段/畸形请求体不 422，反而执行了「停用」副作用 | 契约 `contract.md:737-754`；控制器 `AlarmPolicyController.php:57-64`；服务 `AlarmPolicyService.php:273-287,505-516`；前端 `alarm.ts:873-876`、`alarm-policy.api.ts:136-141` |
| **D-3** | ③ `POST /policies`、④ `PUT /policies/{id}` | `conditions[].*` 落库列名 | §2.1 字段为 camelCase；`schema.sql` 声明「列 ↔ 接口字段 snake_case ↔ camelCase」 | `toConditionPayload` 输出 camelCase DTO 名（✔ 符合契约） | `insertConditions()` 把 `ConditionValidator` 的 **camelCase 数组原样**塞进 `Builder::insert()`；同表的 `copy()` 却用 **snake_case**；模型 `$fillable/$casts` 全 snake_case，无 camelCase mutator | `alarm_policy_condition.metric_namespace / metric_name / metric_name_cn` | ❌ **漂移（P0）**：同一张表两条写路径键名互斥，至少一条错；无 vendor 无法运行时确认是否直接 500（若不转换则 `Unknown column`→500，③/④ 全线不可用） | `AlarmPolicyService.php:328-349`（snake）vs `:649-659`（camel）、`ConditionValidator.php:139-152`、`AlarmPolicyCondition.php:23-38`、`schema.sql:128-130` |
| **D-4** | 契约自身（§2.8） | 内部列清单 / 自检分组数 | §2.8：「合计 **4** 个内部列（字段一致性自检按 **45 − 4 = 41** 组计）」 | 前端不感知内部列（✔） | 后端同样不输出（✔） | 6 表 88 列中**实际 13 列不对外**，其中 5 列 §2.8 未登记：`alarm_policy.creator_id`、`alarm_policy_condition.policy_id`、`alarm_condition_template.creator_id`、`alarm_notification_template.creator_id`、`alarm_history.updated_at`；§2 去重字段名为 **60**、字段出现 **98** 次，均非 45/41 | ❌ **漂移（P2，契约自相矛盾）** | 契约 `contract.md:466-479`；`schema.sql:84,126,138-139,176,214,244-249,304` |
| **D-5** | ③ / ④（前端表单层） | `callbackUrl` | §3.1 ③ 请求体 14 个字段中**无 `callbackUrl`**（N3 的 `callbackUrl` 属 `NotificationChannel`，不是策略字段） | `PolicyFormValues.callbackUrl`、`policyNotifyStepSchema.callbackUrl`、`FIELD_STEP.callbackUrl`、`PolicySectionModel.callbackUrl(+FromFormOnly)` 4 处存在；`buildPolicyPayload` **静默丢弃**该字段 | 无（后端不接收）→ 不存在服务端契约面 | — | ⚠️ **漂移（P2）**：契约外影子字段，UI 让人填却永不提交，详情页该区块恒空（`toPolicySectionModel` 写死 `callbackUrl: ''` + `callbackUrlFromFormOnly: true`） | `policy-logic.ts:620,710-741`、`policy.validator.ts:324-328`、`policy-form.vue:162,1436-1441`、`policy-view.ts:82,84,219-220,289-290,354`、契约 `contract.md:635-651` |
| **D-6** | ①（及 ⑨⑬⑰）前端传输层 | `query`（筛选/分页参数） | §3.1 ①：8 个 query 参数，多条件 AND，空串视为未传，非法枚举 422 | `alarm-policy.api.ts` 传 `{ method:'get', query }`；但 `apiFetch` 走 mock 分支时**只透传 `{method, body}`**，`query` 被丢弃 → 筛选与分页在 mock 下全部失效 | 真实 HTTP 不受影响 | — | ⚠️ **漂移（P2，仅 mock 模式）** | `alarm-policy.api.ts:71-76,163-168,174-179`、`api-client.ts:49-53`、`router.mock.ts:100-117` |
| **D-7** | ① / ⑰ | `keyword` 长度 | §3.1 ① 说明列：「模糊匹配 name/remark，**<=128**」 | 前端无长度限制（`buildPolicyListQuery` 只 trim，✔ 不阻塞） | `strOrNull()` 无长度校验，超长 keyword **不返回 422** | — | ⚠️ **漂移（P3，软约束未落地）** | 契约 `contract.md:499,920`；后端 `AlarmPolicyService.php:71-80,663-670` |
| **D-8** | ③ / ④ | 选填字段的必填性 | §3.1 ③：`remark`/`projectId`/`conditionLogic`/`notificationTemplateIds`/`conditionTemplateId`/`status` 均为「否」+ 有默认值 | zod 全部设为**必填**（无 `.optional()`），比契约严 | 全部有默认值兜底（✔ 符合契约） | 全部有 `DEFAULT` | ⚠️ **漂移（P3）**：因 payload 恒带值，当前无线上影响，但「必填列」与契约不符 | 契约 `contract.md:638-650`；`policy.validator.ts:279-281,284-288,302-306,317-323,344`；`alarm.ts:841-870` |
| **D-9** | 全部 422 端点 | `extra.errors[]` | §0.4：`errors` 是**数组**，每个字段的**具体原因**都应给出；N9 要求「message 须指出是哪几个模板名未配置」 | 前端按 `field/message` 读取（✔） | `Validator::add()` **同字段只保留第一条**，后续原因被静默丢弃 | — | ⚠️ **漂移（P3）**：`notificationTemplateIds` 同字段最多触发 3 类原因（P12/P13/N9），N9 的模板名提示会被 P13 覆盖 | 契约 `contract.md:84-101,1119`；`Validator.php:93-100`、`PolicyPayloadValidator.php:59-88`、`AlarmExceptionHandler.php:85-89` |
| **D-10** | ①-⑦（及全模块） | `403 FORBIDDEN` | §0.5：`403` = 已登录但无该资源所属项目权限 | 前端按 code 统一处理（✔） | 仅 `AuthMiddleware` 401 占位；**无任何项目/资源权限校验**，403 分支不可达 | `alarm_policy.project_id` 仅作筛选维度 | ⚠️ **缺口（P3，已知风险 R7）**：`ErrorCode::FORBIDDEN` 恒不可达 | 契约 `contract.md:109`；`AuthMiddleware.php:17-25`、`AbstractController.php:36-42`、`ErrorCode.php:17` |

### 1.1 与后端审查线的交叉印证

D-1 / D-2 / D-3 与 `/.audit/audit-backend.md` 的 BLOCKER-1（`insertConditions` 键名）、BLOCKER-2（409 message 塌缩）、HIGH-1（`assertStatus` 回落 0）由两条独立路径（我读契约+DTO+DDL，对方读代码流）得出同一结论，可信度提高。差异在于：**对方把它归为实现缺陷，我归为「契约↔实现漂移」**——同一事实、两个视角，建议合并修复项时只留一条。

---

## 2. 12 组枚举逐值比对（契约 ↔ 前端 ↔ 后端）

脚本 `/tmp/audit/enum_compare.py` 输出，三方值集合**完全一致**（含大小写、可选值数量、字符串符号形态）：

| § | 枚举 | 契约（值:label） | 前端 `alarm.ts` | 后端 `AlarmEnum.php` | 一致 |
| --- | --- | --- | --- | --- | --- |
| 1.1 | monitorType | 1:云产品监控 2:应用性能监控 3:前端性能监控 4:云拨测 5:终端性能监控 (L166-171) | `ALARM_MONITOR_TYPE` L91-107 | `MONITOR_TYPE` L14 | ✔ |
| 1.2 | policyType | 1:通用 Web 服务 2:云服务器 CVM 3:负载均衡 CLB 4:云数据库 MySQL (L185-188) | `ALARM_POLICY_TYPE` L113-127 | `POLICY_TYPE` L29 | ✔ |
| 1.3 | level | 1:紧急 2:严重 3:提示 (L194-196) | `ALARM_LEVEL` L151-163 | `LEVEL` L35 | ✔ |
| 1.4 | period | 1/5/10/30/60 (L202-206) | `ALARM_PERIOD` L169-188 | `PERIOD` L38 | ✔ |
| 1.5 | operator | `>` `>=` `<` `<=` `==` `!=` (L214-219) | `ALARM_OPERATOR` L194-212 | `OPERATOR` L41 | ✔ |
| 1.6 | frequency | 0/5/15/30/60/180/360/720/1440 (L227-235) | `ALARM_FREQUENCY` L221-245 | `FREQUENCY` L44 | ✔ |
| 1.7 | objectType | 1:全部对象 2:指定实例 3:实例分组 4:多维筛选 (L246-249) | `ALARM_OBJECT_TYPE` L251-265 | `OBJECT_TYPE` L47 | ✔ |
| 1.8 | conditionLogic | 1:满足所有条件 2:满足任意条件 (L269-270) | `ALARM_CONDITION_LOGIC` L307-317 | `CONDITION_LOGIC` L53 | ✔ |
| 1.9 | status | 0:停用 1:启用 (L276-277) | `ALARM_POLICY_STATUS` L323-333 | `STATUS` L56 | ✔ |
| 1.10 | historyStatus | 1:未处理 2:已处理 3:已忽略 4:已恢复 (L283-286) | `ALARM_HISTORY_STATUS` L339-353 | `HISTORY_STATUS` L59 | ✔ |
| 1.11 | notifyChannel | 1:邮件 2:短信 3:微信 4:电话 5:回调 (L292-296) | `ALARM_NOTIFY_CHANNEL` L359-375 | `NOTIFY_CHANNEL` L65 | ✔ |
| 1.12 | handleAction | handle:处理 ignore:忽略 recover:恢复 (L302-304) | `ALARM_HANDLE_ACTION` L381-400 | `HANDLE_ACTION`（映射到 status 2/3/4，契约第 3 列语义，✔） | ✔ |

**附带一致项**（脚本同时校验，未出现在漂移表）：
- §1.1 联动表 monitorType→policyType：契约 L176-179 ↔ 前端 `ALARM_MONITOR_TYPE_POLICY_TYPES` L135-145（1→[2,3,4]，2→[1]，3/4/5→[]）↔ 后端 `MONITOR_TYPE_POLICY_TYPES` L20-26 —— **完全一致**。
- §1.7 `matchType`（include/exclude）：契约 L263 ↔ 前端 `ALARM_MATCH_TYPE` L280-285 ↔ 后端 `FILTER_MATCH_TYPE` L50 —— 一致；写侧默认值 `include` 在 `filterListOrNull` L256 与前端 `objectFilterSchema` `.optional()` 两侧同为「省略即 include」。

---

## 3. ①-⑦ 逐端点逐字段三方比对（机械产出，35 行全 YES）

> 表格由 `/tmp/audit/endpoint_fields.py` 生成，列为：**契约定义(行) / 前端 DTO(行) / 前端请求构造 / 后端读取 / DDL 列(行) / 是否一致**。
> 下表中 `L` = 行号。⑤ DELETE 与 ⑦ COPY 的响应体分别为 `true`（契约 L725-728）与 `{id,name}`（契约 L776-786），前端 `alarm-policy.api.ts:124-128,150-154` 分别用 `IResponse<boolean>` / `IResponse<AlarmPolicyCopyResult>` 承接，后端 `AlarmPolicyService.php:257-268` 返回 `true`、`:296-355` 返回 `['id'=>..,'name'=>..]`，三方一致。

| # | 字段 | 契约定义 | 前端 DTO | 前端请求构造 | 后端读取 | DDL | 一致 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ①②③④⑥ | id | int (L335) | L494 number | —（只读） | `Presenter.php:25` | `alarm_policy.id` BIGINT UNSIGNED (sql:69) | YES |
| ①②③④⑥ | name | string (L336) | L496 string | `policy-logic.ts:721` | `AlarmPolicyService.php:145` assertName | `name` VARCHAR(128) (sql:70) | YES |
| ①②③④⑥ | remark | string (L337) | L498 string | `policy-logic.ts:722` `?? ''` | `:146` assertRemark | `remark` VARCHAR(500) NOT NULL DEFAULT '' (sql:71) | YES |
| ①②③④⑥ | monitorType | int (L338) | L500 `AlarmMonitorType` | `:723` | `:399` assertMonitorAndPolicyType | `monitor_type` TINYINT UNSIGNED (sql:72) | YES |
| ①②③④⑥ | monitorTypeCn | string (L339) | L502 string | —（只读） | `Presenter.php:29` `AlarmEnum::label` | —（派生回填，无列，契约 L339「回填」） | YES |
| ①②③④⑥ | policyType | int (L340) | L504 `AlarmPolicyType` | `:724` | `:399` | `policy_type` TINYINT UNSIGNED (sql:73) | YES |
| ①②③④⑥ | policyTypeCn | string (L341) | L506 string | —（只读） | `Presenter.php:31` | —（派生回填） | YES |
| ①②③④⑥ | status | int (L342) | L508 `AlarmPolicyStatus` | `:737-738` 仅 create 模式带，update 省略（P18 ✔） | `:505` assertStatus ⚠️见 D-2 | `status` TINYINT UNSIGNED NOT NULL DEFAULT 0 (sql:74) | YES* |
| ①②③④⑥ | level | int (L343) | L510 `AlarmLevel` | —（只读，P17 派生） | `Presenter.php:33` + `deriveLevel():522-526` | `level` TINYINT UNSIGNED NOT NULL DEFAULT 3 (sql:75) | YES |
| ①②③④⑥ | projectId | int (L344) | L512 number | `:725` `?? 0` | `:430` assertProjectId | `project_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 (sql:76) | YES |
| ①②③④⑥ | objectType | int (L345) | L514 `AlarmObjectType` | `:726` | `:442` assertObjectType | `object_type` TINYINT UNSIGNED NOT NULL DEFAULT 1 (sql:77) | YES |
| ①②③④⑥ | conditionCount | int (L346) | L516 number | —（只读，批量 GROUP BY 派生） | `Presenter.php:36` + `conditionCounts():632-647` | —（派生，无列） | YES |
| ①②③④⑥ | notificationTemplateIds | int[] (L347) | L518 `number[]` | `:733` 恒提交数组 | `:468` resolveNotificationTemplateIds | `notification_template_ids` JSON NULL (sql:82) | YES |
| ①②③④⑥ | conditionTemplateId | int (L348) | L520 number | `:734` `?? 0` | `:483` assertConditionTemplateId | `condition_template_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 (sql:83) | YES |
| ①②③④⑥ | creatorName | string (L349) | L522 string | —（只读，服务端取当前登录人） | `Presenter.php:40` | `creator_name` VARCHAR(64) (sql:85) | YES |
| ①②③④⑥ | createdAt | string (L350) | L524 `AlarmDateTime` | —（只读） | `Presenter.php:41` `Time::formatOrEmpty` | `created_at` DATETIME (sql:86) | YES |
| ①②③④⑥ | updatedAt | string (L351) | L526 `AlarmDateTime` | —（只读） | `Presenter.php:42` | `updated_at` DATETIME (sql:87) | YES |
| ②③④⑥ | conditions | `AlarmPolicyCondition[]` (L361) | L565 | `:731` `toConditionPayload`×N | `Presenter.php:65` | `alarm_policy_condition` 表 1-4 行 (sql:124-157) | YES |
| ②③④⑥ | objectIds | `int[] \| null` (L362) | L567 `number[] \| null` | `:727` `resolveObjectBinding` 收敛为 `null` | `Presenter.php:61` `nullableIntList` | `object_ids` JSON DEFAULT NULL (sql:78) | YES |
| ②③④⑥ | objectGroupIds | `int[] \| null` (L363) | L569 `number[] \| null` | `:728` | `Presenter.php:62` | `object_group_ids` JSON DEFAULT NULL (sql:79) | YES |
| ②③④⑥ | objectFilters | `object[] \| null` (L364) | L571 `AlarmObjectFilter[] \| null` | `:729` | `Presenter.php:63` | `object_filters` JSON DEFAULT NULL (sql:80) | YES |
| ②③④⑥ | conditionLogic | int (L365) | L573 `AlarmConditionLogic` | `:730` | `Presenter.php:64` + `:452` | `condition_logic` TINYINT UNSIGNED NOT NULL DEFAULT 1 (sql:81) | YES |
| ②③④⑥ | notificationTemplates | object[] (L366) | L575 `...Brief[]` | —（响应派生） | `Presenter.php:66` + `notificationTemplateSummaries():606-624` | 跨表查 `alarm_notification_template` | YES |
| ②③④ conditions[] | id | int (L314) | L448 `id?: number` | **请求体不提交**（契约 L314「必须省略」；`toConditionFormItem` 回填时丢弃 ✔） | DB AUTO_INCREMENT | `alarm_policy_condition.id` (sql:125) | YES |
| ②③④ conditions[] | sort | int (L315) | L450 `AlarmConditionSort`(1\|2\|3\|4) | `:674-684` | `ConditionValidator.php:88,104,156-165` | `sort` SMALLINT UNSIGNED NOT NULL DEFAULT 1 (sql:127) | YES |
| ②③④ conditions[] | metricNamespace | string (L316) | L452 string | `:674-684` | `ConditionValidator.php:89,123-133` | `metric_namespace` VARCHAR(64) (sql:128) | YES（见 D-3） |
| ②③④ conditions[] | metricName | string (L317) | L454 string | `:674-684` | `:90,125-128` | `metric_name` VARCHAR(64) (sql:129) | YES（见 D-3） |
| ②③④ conditions[] | metricNameCn | string (L318) | L434 string（Payload 侧可选，契约 L318「服务端回填、请求值忽略」✔） | `:674-684` **不提交** ✔ | `:144` 字典回填 | `metric_name_cn` VARCHAR(64) DEFAULT '' (sql:130) | YES（见 D-3） |
| ②③④ conditions[] | unit | string (L319) | L436 string（同上） | `:674-684` 不提交 ✔ | `:145` 字典回填 | `unit` VARCHAR(16) DEFAULT '' (sql:131) | YES（见 D-3） |
| ②③④ conditions[] | operator | string (L320) | L456 `AlarmOperator`（符号联合） | `:674-684` 原样 | `ConditionValidator.php:91,112,222-231`（`assertStringEnum`，**未**误用 `is_numeric` 路径） | `operator` VARCHAR(2) + CHECK 6 值 (sql:132,151) | YES |
| ②③④ conditions[] | threshold | number (L321) | L458 number | `:674-684` | `:92,114,168-186`（可负、≤4 位小数） | `threshold` DECIMAL(20,4) + cast float (sql:133) | YES |
| ②③④ conditions[] | period | int (L322) | L460 `AlarmPeriod` | `:674-684` | `:93,105,189-203`（全局枚举 ∩ `periodOptions`） | `period` SMALLINT UNSIGNED + CHECK (sql:134,152) | YES |
| ②③④ conditions[] | continuity | int (L323) | L462 number | `:674-684` | `:94,106` | `continuity` TINYINT UNSIGNED + CHECK 1-10 (sql:135,153) | YES |
| ②③④ conditions[] | level | int (L324) | L464 `AlarmLevel` | `:674-684` | `:95,107` | `alarm_policy_condition.level` TINYINT UNSIGNED + CHECK (sql:136,154) | YES（见 D-3） |
| ②③④ conditions[] | frequency | int (L325) | L466 `AlarmFrequency` | `:674-684` | `:96,108` | `alarm_policy_condition.frequency` SMALLINT UNSIGNED + CHECK 9 值 (sql:137,155) | YES（见 D-3） |

> `*` status 行标 YES* 是因为 ③ 的选填语义正确，仅 ⑥ 复用同一 helper 出错（见 D-2）。

---

## 4. `operator` 契约专项（任务点 4）

**契约原文**（`contract.md:210-221`）：
> ### 1.5 `operator` 比较关系（字符串）
> | `>` | 大于 | …（共 6 个符号）…
> DB 存储 `VARCHAR(2)`，**必须原样传输，不做本地化转换**（不要传「大于」）。

**两端实现均把它当符号字符串**，证据：

| 位置 | 实现 | 证据 |
| --- | --- | --- |
| 前端类型 | `ALARM_OPERATOR = { GT:'>', GTE:'>=', LT:'<', LTE:'<=', EQ:'==', NE:'!=' } as const`，`AlarmOperator` 为字符串字面量联合 | `alarm.ts:194-203` |
| 前端校验 | `operatorSchema = enumOf(Object.values(ALARM_OPERATOR), '比较关系必须是 > >= < <= == !=')`；`objectFilterSchema.operator` 复用同一 schema | `policy.validator.ts:99-102,139` |
| 前端下拉 | `toOptions(ALARM_OPERATOR, ALARM_OPERATOR_LABEL)` → `value` 取枚举值（符号），`label` 取中文 | `alarm-enum-options.ts:45-49,58-59` |
| 前端渲染 | `ALARM_OPERATOR_LABEL[condition.operator]` 仅用于展示 | `condition-editor.vue:103` |
| 前端请求 | `toConditionPayload` 原样透传 `condition.operator` | `policy-logic.ts:677` |
| 后端枚举 | `public const OPERATOR = ['>', '>=', '<', '<=', '==', '!='];` | `AlarmEnum.php:41` |
| 后端校验 | 走 `assertStringEnum()`（`is_string` + `in_array`），**刻意避开** `assertEnum()` 的 `is_numeric` 分支 | `ConditionValidator.php:109-112,222-231`；filter 同理 `PolicyPayloadValidator.php:202-206` |
| DDL | `operator` VARCHAR(2) + `CHECK (operator IN ('>','>=','<','<=','==','!='))` | `schema.sql:132,151,286,320` |

**反向取证**：`web/src` 全量 grep `大于` 共 10 处，全部出现在**注释、label 映射、单测断言**中，无一处作为请求值；`toAlarmOperator('大于')` 的单测明确断言返回 `undefined`（`types/__tests__/alarm-narrow.test.ts:32`、`policy.validator.test.ts:159-161`）。
**结论：`operator` 无漂移。**

---

## 5. JSON 空值归一化专项（任务点 3）

契约 §0.6（L123-155）规定：三个 object 字段读出**必须 `null`**（R-JSON-1）、`notificationTemplateIds` 读出**必须 `[]`**（R-JSON-2），写侧 `null`/`[]` 一律落 SQL `NULL`；条件/渠道 JSON 列「直传」。

| 列 | 契约方向 | 后端写（API→DB） | 后端读（DB→API） | 前端类型 | 前端消费 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `object_ids` | `null` / `null`,`[]`→NULL / NULL→`null` | `PolicyPayloadValidator.php:184` 返回 null、`AlarmPolicy::normalizeJsonForWrite:87` 转 SQL NULL | 模型 cast `'array'`（`AlarmPolicy.php:55`，DB NULL→null）+ `Presenter::nullableIntList:240-246` | `number[] \| null`（`alarm.ts:567`） | `policy-view.ts:181,210` 经 `resolveObjectBinding` 归一，不解构、不 `\|\| []` | ✔ 一致 |
| `object_group_ids` | 同上 | `:185` | `:62` + 同 cast | `alarm.ts:569` | 同上 | ✔ 一致 |
| `object_filters` | 同上 | `:186` | `:63` `=== null ? null : array_values(...)` | `alarm.ts:571` | 同上 | ✔ 一致 |
| `notification_template_ids` | `[]` / `null`,`[]`→NULL / **NULL→`[]`** | `:475-479` 空数组 → `normalizeJsonForWrite` 转 NULL | `Presenter::intList:234-237` `(array)null → []` | `number[]` 非空（`alarm.ts:518`） | `policy-view.ts:218`、`policy-logic.ts:733` 均直接当数组用，无判空 | ✔ 一致 |
| `alarm_condition_template.conditions` | 直传，不接受 null | — | `Presenter::normalizeConditions:190-203`（补 `id=0`、按 `sort` 升序） | `AlarmPolicyCondition[]` 必填（`alarm.ts:592`） | — | ✔ 一致 |
| `alarm_notification_template.channels` | 直传，不接受 null | — | `normalizeChannels:210-222`（`callbackUrl` 缺省补 `null`、`silenceTime` 补 0） | `NotificationChannel[]` 必填（`alarm.ts:656`） | — | ✔ 一致 |

**「响应里本该是 null 的字段，前端会不会拿到 undefined / 空串」的专项结论**：

- **后端不会输出 `""` 顶替 `null`**：`Time::format()` 对 `null`/`''` 返回 `null`（`Time.php:23-32`），`recoveredAt`/`handledAt` 走 `format`（`Presenter.php:161-162`），只有契约声明为 `string` 非空的字段才走 `formatOrEmpty`（`createdAt`/`updatedAt`/`triggeredAt`，且 DDL 为 `NOT NULL`）。
- **后端不会输出字面量 `'null'` 字符串**：`normalizeJsonForWrite` 显式把 `null`/`[]` 转成 PHP `null`（SQL NULL）而非 `json_encode(null)`（`AlarmPolicy.php:87` + 注释 L67-69）。
- **前端不会崩也不会误判**：`policy-detail.vue:43-44` 直接 `props.model.objectIds.map(...)`，但 `PolicySectionModel.objectIds` 在 `policy-view.ts:181-183,210-212` 已经过 `resolveObjectBinding` + `?? []` 归一，且模板只在 `objectType===2` 分支求值 —— **无 `null.map` 崩溃风险**。
- **唯一注意项**：`policy-detail.vue:43` 依赖「调用方必须先归一」这一隐式约定，若将来有人直接把 `AlarmPolicyDetail` 塞进该组件会 NPE。属可维护性风险，非当前漂移。

---

## 6. DDL ↔ DTO 对齐专项（任务点 5）

脚本 `/tmp/audit/summary_counts.py` 统计：

| 表 | 列数 | DTO 暴露字段数 | 不对外暴露的列 |
| --- | --- | --- | --- |
| `alarm_policy` | 19 | 18（ListItem 17 + Detail 6 中除 `notificationTemplates` 外全部命中列；`conditionCount`/`*Cn` 为派生） | `creator_id` ⚠§2.8 未登记 |
| `alarm_policy_condition` | 15 | 12（§2.1 全 12 字段） | `policy_id` ⚠、`created_at` ✔、`updated_at` ✔ |
| `alarm_condition_template` | 10 | 9 | `creator_id` ⚠ |
| `alarm_notification_template` | 9 | 8 | `creator_id` ⚠ |
| `alarm_history` | 29 | 28（§2.6 全 28 字段） | `updated_at` ⚠ |
| `alarm_notification_receiver` | 6 | 0（§2.8 内部表） | 全 6（备注已带过） |

**列名/可空性/默认值三方核对结果**：
- **列名**：所有 DTO 字段的 camelCase ↔ DDL snake_case 一一映射成功，**无拼写漂移**（`metricNameCn↔metric_name_cn`、`conditionTemplateId↔condition_template_id`、`notificationTemplateIds↔notification_template_ids`、`handleAction↔handle_action`、`actualValue↔actual_value` 等逐个验证通过）。
- **可空性**：契约声明 `null` 的 7 个字段（`objectIds`/`objectGroupIds`/`objectFilters`/`actualValue`/`recoveredAt`/`handledAt`/`handleAction`/`callbackUrl`）在 DDL 中**全部**是可空（JSON 列 `DEFAULT NULL`、DATETIME 无 `NOT NULL`、`handle_action` 可空）✔；`notificationTemplateIds` 契约声明非空 `int[]`，DDL 为可空 JSON —— **符合 §0.6 规定的「DB 存 NULL、API 补 []」方向**，不是漂移。
- **默认值**：契约 §0.6 R-JSON-3 明确「标量列的 DEFAULT 只是 DB 兜底，不构成契约默认值」，DDL 中 `object_type DEFAULT 1`、`level DEFAULT 3`、`sort DEFAULT 1`、`frequency DEFAULT 0` 与该条**自洽** ✔。
- **无 DDL 列在 DTO 中缺失**：唯一 4 个「DTO 有、DDL 无列」的字段是 `monitorTypeCn`/`policyTypeCn`/`conditionCount`/`notificationTemplates` —— 均为契约明示的**服务端派生/回填**字段（`contract.md:339,340,346,366`），符合预期。

**唯一实质问题**：§2.8 的内部列清单不完整且计数错误（见 D-4）。这会导致「字段一致性自检」基线错误，属**契约文档缺陷**，不是代码缺陷。

---

## 7. 未发现漂移的区域（明确 PASS，避免后续重复排查）

- 19 条路由的 method + path 与契约 §5 速查表逐条一致（`server/config/routes.php:28-60`），Base URL `/api/alarm` ✔。
- 响应信封 5 字段、`data` 失败时恒 `null`、HTTP 状态码与 `code` 一致（`Response.php:53-71`；`code=0 → 200`，其余直接 `withStatus($code)`）✔。
- 分页响应恒为 `{list,total,page,pageSize}`（`Response.php:43-51`），`page>=1`、`1<=pageSize<=100` 超限 422（`Pagination.php:31-37`），默认 `1/20`（`AlarmEnum.php:116-119`）✔。
- 排序固定 `created_at DESC, id DESC`，不开放排序参数（`AlarmPolicyService.php:110-114`，`Pagination` 无 orderBy 入口）✔。
- ⑤ 删除前置顺序「404 → 409 → 删除」与 §3.1 ⑤ 一致（`:257-268`）✔；⑦ 复制「不继承 id/创建人、`status` 强制 0、按字符截断、候选到 (99)」全部一致（`:296-355,556-572`）✔。
- ④ PUT 全量更新且 `status` 唯一不回落（`:222-239` 明确不含 `status`，事务内先 DELETE 子条件再批量插）✔。
- 契约 §2.4/§2.5 声明「请求体 `isPreset` 无效」：前端 `AlarmPolicyCreatePayload`（`alarm.ts:841-870`）**根本不含** `isPreset`，`buildPolicyPayload` 自然不会写入（`policy-logic.ts:720-741`）✔。（`AlarmConditionTemplatePayload.isPreset?` 存在于 `alarm.ts:921`，但 §3.2 ⑩ 的请求体字段表同样不含 `isPreset`，属同一性质的前端冗余声明，当前也不会被提交，不单独记为漂移。）

---

## 8. 修复建议（按优先级，均不属本次审查的改动范围）

1. **D-1**：`ErrorCode::MESSAGES` 改为按「语义」索引（如 `MESSAGES_BY_REASON[ErrorCode::POLICY_STATUS_CONFLICT]`），或让 `BusinessException::conflict()` 显式接收文案；在 `destroy()`、唯一键冲突、模板 ⑫⑯ 引用检查处分别传对应文案。**改动面小、用户可感**。
2. **D-2**：为 ⑥ 单独写 `assertStatusRequired()`（`null` → `$errors->add('status', …)` 后 422），不复用 ③ 的默认值 helper；同时建议前端在 `setAlarmPolicyStatus` 前做本地非空断言。
3. **D-3**：在 `insertConditions()` 里做一次 camelCase→snake_case 显式重命名（与 `copy():330-345`、`Presenter::condition():73-86` 保持同一套映射），并补一条**不依赖数据库**的键名映射单测。
4. **D-4**：更新 `contract.md` §2.8，把 5 个未登记的内部列补进表格，并把「4 个」「45−4=41」改成实测值（13 列 / 60 去重字段名 / 98 字段次）。
5. **D-5/D-6/D-7/D-8/D-9/D-10**：分别为「删掉契约外影子字段」「mock 透传 query」「keyword 长度校验」「zod 改 optional」「errors 数组允许同字段多条」「补 403 分支或在契约标注 R7 已知缺口」。

---

## 附录：本次审查实际读取的文件（全部只读）

事实来源与前端：`docs/alarm/contract.md`、`web/src/types/alarm.ts`、`web/src/services/api/alarm-policy.api.ts`、`web/src/pages/alarm/policy/validators/policy.validator.ts`、`web/src/pages/alarm/policy/utils/policy-logic.ts`、`web/src/pages/alarm/policy/utils/policy-view.ts`、`web/src/pages/alarm/policy/components/policy-detail.vue`、`web/src/pages/alarm/policy/[id]/index.vue`、`web/src/pages/alarm/policy/[id]/edit.vue`、`web/src/pages/alarm/components/alarm-enum-options.ts`、`web/src/lib/api-client.ts`、`web/src/mocks/router.mock.ts`。
后端：`server/src/Service/AlarmPolicyService.php`、`server/src/Constants/AlarmEnum.php`、`server/src/Constants/ErrorCode.php`、`server/src/Service/Validator/{ConditionValidator,PolicyPayloadValidator}.php`、`server/src/Support/{Presenter,Pagination,Validator,Time,Response}.php`、`server/src/Model/{AlarmPolicy,AlarmPolicyCondition,Model}.php`、`server/src/Controller/{AbstractController,Alarm/AlarmPolicyController}.php`、`server/src/Exception/{BusinessException,Handler/AlarmExceptionHandler}.php`、`server/src/Middleware/AuthMiddleware.php`、`server/config/routes.php`、`server/config/autoload/middlewares.php`。
数据库：`docs/alarm/schema.sql`。
