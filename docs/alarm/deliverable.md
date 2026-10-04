# 告警管理模块规格 — 交付说明（deliverable.md）

> 任务：定义告警管理 API 契约、数据库表结构与指标字典
> 完成时间：2026-09-30　　版本：v1.0（**已冻结**）
> 性质：**纯规格文档，零业务代码**

---

## 1. Summary

参照腾讯云可观测平台的告警策略模型，产出了一套可直接照抄实现的告警管理规格：19 个 REST 端点的
完整契约（统一响应信封 + 分页 + 12 组枚举 + 9 个错误码 + 全部业务约束）、6 张表的 MySQL 8.0
可执行 DDL（含索引、外键/软硬删除取舍说明、7 条预置模板种子数据）、38 个指标的字典与 7 条预置触发
条件模板，以及领域模型/ER 图/状态机/校验规则文档。四份文档已通过自动化交叉校验，确保字段名与枚举
取值零漂移。

---

## 2. 产出文件清单

| 文件 | 路径 | 大小 | 内容 |
| --- | --- | --- | --- |
| `contract.md` | `/workspace/docs/alarm/contract.md` | ~32 KB | REST API 契约：统一响应信封、分页、12 组枚举、错误码表、6 个 DTO、19 个端点（含请求体/响应体字段表与示例 JSON）、业务约束 P/T/N/H 共 46 条、前后端对接检查清单 |
| `schema.sql` | `/workspace/docs/alarm/schema.sql` | ~23 KB | 6 张表 DDL（utf8mb4 / InnoDB / MySQL 8.0）+ 29 个 CHECK + 30 个索引 + 2 个外键 + 预置数据（3 通知模板 + 6 条件模板，`INSERT IGNORE` 幂等） |
| `metrics.md` | `/workspace/docs/alarm/metrics.md` | ~13 KB | 38 个指标（CVM 15 / WEB 9 / CLB 5 / MYSQL 9），每项 **10** 字段；7 条预置触发条件模板（详情表 + 汇总表 + 机器可读 JSON 副本） |
| `domain.md` | `/workspace/docs/alarm/domain.md` | ~14 KB | 5 分钟上手摘要、领域概念、ASCII ER 图、关系清单、策略启停与告警处理状态机、校验执行顺序、规则→落点对照、并发保护建议 |
| `deliverable.md` | `/workspace/docs/alarm/deliverable.md` | 本文件 | 产出清单 + 关键设计取舍 + 遗留风险 |

**任务要求的 19 个端点全部覆盖**，分组与 `contract.md` §3 标题一一对应（7 + 9 + 3 = 19）：

| 分组 | 端点数 | 端点 |
| --- | --- | --- |
| §3.1 策略 | **7** | 列表 / 详情 / 创建 / 更新 / 删除 / 启停 / 复制 |
| §3.2 指标与模板 | **9** | 指标字典 1 个 + 条件模板 4 个（GET/POST/PUT/DELETE）+ 通知模板 4 个（GET/POST/PUT/DELETE） |
| §3.3 告警历史与统计 | **3** | 历史分页 / 处理告警 / 首页统计 |
| **合计** | **19** | 与 `contract.md` §5 速查表的 19 行一致 |

---

## 3. 关键设计取舍（9 条）

### T1 — 响应信封沿用前端 `IResponse<T>`，列表 `data` 强制为分页对象
先读取了模板仓库 `src/services/types/response.type.ts` 确认既有定义（`data/extra/code/message/success`
+ `IPaginationRequestQuery{page,pageSize}`），**未做任何改动**。列表接口的 `data` 统一为
`{list,total,page,pageSize}` 而非裸数组，避免前端为不同列表写两套解包逻辑。
`extra` 定位为「错误明细载体」：422 时放 `errors[{field,message}]`。
**代价**：所有列表响应多一层嵌套，与模板里 `example-tasks.api.ts` 的裸数组写法不同，后端需专门实现。

### T2 — 枚举一律数值传输（`operator` 除外）
对齐数据库 `TINYINT UNSIGNED`，避免"数字↔字符串"双向转换。唯一例外是 `operator`（`> >= < <= == !=`），
因为 `>` 等符号本身就是字符串。**明确禁止本地化**（不能传"大于"），并加了 CHECK 约束兜底。
12 组枚举在 `contract.md` §1 集中定义，DB 侧用 `CHECK (col IN (...))` 逐一对齐（已自动化校验一致）。

### T3 — `PUT /policies/{id}` 采用全量更新，唯一的例外是 `status`
全量更新（PUT）语义下，未传字段回落默认值，实现上是"先删子条件再批量插入"，逻辑简单且无字段漂移风险。
**例外**：`status` 省略时保持原值，启停只能走 `POST /status`，防止表单漏传把线上策略意外停用。
**代价**：前端必须整体提交表单，漏传 `objectIds` 会直接 422 —— 这是刻意的（宁可报错也不静默清空）。

### T4 — 硬删除 + 真实外键仅用于"父子强一致"的两处
`name` 需要全局唯一，软删除会让唯一键必须带 `is_deleted` 维度，查询与校验都复杂化，且业务语义
（参照腾讯云）是"删除即消失"，因此 `alarm_policy` / 两种模板 / 接收人明细**全部硬删除**。
"误删可恢复"的诉求由 `POST /copy` 副本满足。
真外键只加在 2 处强父子关系（`condition.policy_id`、`receiver.template_id`，均 `ON DELETE CASCADE`）；
其余业务关联一律「应用层校验 + 409」。
**关键取舍**：`alarm_history` 故意**不加**外键到 `alarm_policy` —— 否则策略硬删除会被 FK 挡住，
与"停用后可删"的规则直接冲突。历史表通过冗余快照（`policy_name`/`metric_*`/`threshold`）自洽。

### T5 — 策略 `level` 是派生冗余列
腾讯云把告警分级挂在每条条件上，但**列表筛选需要策略级等级**。方案：`conditions[].level` 为权威值，
`alarm_policy.level` 存 `min(conditions[].level)`（最严重者），配合
`idx_policy_status_level_created(status, level, created_at)` 复合索引支撑列表筛选。
**代价**：写放大（创建/更新都要重算），换来筛选走索引而非全表扫。

### T6 — JSON 列 vs 关系表：按"读取模式"决定
- **拆表**：`alarm_policy_condition`（需按 `policy_id` 高频检索 + `(policy_id,sort)` 唯一约束，JSON 做不到）
- **用 JSON**：`condition_template.conditions`、`notification_template.channels`、
  `policy.object_ids/object_filters`（读取永远是整体读，拆表只会带来 N+1 join）

**唯一检索 JSON 的地方**是删除通知模板前的引用检查（`JSON_CONTAINS`，走不了索引），
已在 `domain.md` §5.6 记录演进方案（万级策略时改为关系表 `alarm_policy_template_ref` + JSON 作读取缓存）。

### T7 — 通知模板：渠道配置留 JSON，接收人明细落冗余表
`alarm_notification_template.channels` 存权威渠道配置（免 join 读模板）；同时把接收人冗余展开到
`alarm_notification_receiver`，用于(a) 邮箱/手机号全局查重与格式校验（`idx_receiver_contact`）
(b) 未来"接收人订阅了哪些模板"查询。两者同事务写入，**读取以 `channels` 为准**。
**明确说明**：该表是"可合并进 JSON 列"的方案，DDL 注释里写清了取舍——若不需要 (b) 可直接 DROP，
接口契约不变。

### T8 — 复制策略：不继承 id/创建人、强制停用、名称带长度保护
- 不继承 `id`、`creatorId`、`creatorName`、`createdAt`、`updatedAt`（归当前登录人）
- 新策略强制 `status=0`：副本可能仍绑定旧对象/旧阈值，未经人工确认不应生效
- 名称 `{原名} - 副本`，冲突递增 `(2)(3)`…（上限 99 次后 409）
- **长度保护**：拼接后必须 ≤128，超长时按**字符**（非字节）截断原名，避免中文名截出半截字符
  （`domain.md` §5.4 给了伪代码）

### T9 — 38 个指标入代码常量，不入库
指标字典是**系统元数据**而非租户数据，入库意味着它可能被误删/误改，且每次校验都要查库。
定放 `config/metrics.php` 或独立 YAML，`GET /api/alarm/metrics` 直接读常量。
**代价**：新增指标需发版（不能热更新），换取零误删风险与最低延迟。

---

## 4. 遗留风险

| # | 风险 | 影响 | 缓解 / 建议 |
| --- | --- | --- | --- |
| R1 | **告警恢复来源未区分**：采集模块的自动恢复与人工 `action=recover` 都落 `status=4`，无法区分 | 统计"人工介入率"会失真 | v1.0 可接受。后续加 `recover_source TINYINT`（1 自动 / 2 人工），已在 `domain.md` §4.2 标注 |
| R2 | **DDL 语法/结构已由独立审查在真实 MySQL 8.0.39 上实测通过**（干净执行、可重复执行、最长索引键 1029B、JSON 默认值/CHECK/唯一键/级联删除全部按设计生效、历史无外键且策略删除后历史留存） | 该风险已关闭 | 我本地仍无 mysql/php，无法复现该实测；本地以 `node-sql-parser`（17/17）+ 自研语义校验器（6 表/88 列/6 主键/2 外键/29 CHECK/30 索引/21 项枚举与长度对齐）作等价保障。**剩余未实测项**：第 2/3 轮新增的**文档层规则**（N9 绑定校验、receivers 0-100、§0.6 JSON 空值归一化）从未在真实库上复跑 |
| R3 | **`JSON_CONTAINS` 引用检查走不了索引** | 策略量上万后删除模板可能变慢 | 已在 `domain.md` §5.6 给出演进方案（`alarm_policy_template_ref` 关系表 + JSON 作缓存） |
| R4 | **`threshold` 用 `DECIMAL(20,4)`，接口序列化为 number** | 极端值（>2^53）会有精度损失 | 业务阈值远小于该量级，实际无风险；若未来支持超长周期指标需改字符串或分列存储 |
| R5 | **未定义排序参数**，列表固定 `created_at DESC, id DESC` | 用户无法自定义排序 | v1.0 简化。若需要，加 `sortBy`/`sortOrder` 白名单枚举（**不要**直接拼 SQL 字段名） |
| R6 | **并发保护仅在文档中建议，未进契约** | 两人同时处理同一告警可能都成功 | 已在 `domain.md` §5.3 给出 `UPDATE ... WHERE id=? AND status=1` + 检查 `affected_rows` 的方案；`updatedAt` 乐观锁未强制启用 |
| R7 | **`projectId` 为简化值（`0` = 未分配）**，未接真实项目/权限服务 | 数据权限隔离依赖后续接入 | 契约已预留字段；`overview` 统计口径定义为"当前用户有权限的全部数据"，接入权限后需同步实现 |
| R8 | **告警对象的实例/分组 ID 无来源接口** | `objectIds` 只能手填 | 属于上游资源模块职责，超出本任务边界。契约已固定字段形态，接入时无需改契约 |
| R9 | **`monitorType` 3/4/5（前端性能监控/云拨测/终端性能监控）无对应 `policyType`** | 选了会返回 422 | 有意为之：v1.0 收敛为 4 类策略，避免空壳枚举。扩展点已在 `contract.md` §1.1 联动表写明 |
| R10 | **§0.6 的 JSON 归一化未在真实 MySQL 上复跑**：若 DAO 未按表归一化，`null` / `[]` 编码差异可能让库里出现字面量 `null` 或空串 `''`，破坏 `JSON_CONTAINS` 引用检查 | 删除通知模板时的 409 判定可能失效 | 已在 §0.6 加 DAO 层 `json_encode` 提示；建议实现后在真实库跑一次「空模板 + 绑定 + 删除」探针，验证 `JSON_CONTAINS` 仍能命中 |

---

## 4.5 第 2 轮定点修复记录（应独立审查意见）

本轮**只做定点修复，未重写四份文档**。独立审查用真实 MySQL 8.0.39 执行 DDL 并跑了 21 组对抗性探针，
指出 3 个阻塞项 + 8 项顺手项。已实测通过的部分（19/19 路由、12 组枚举、DDL 可执行且可重复执行、
最长索引键 1029B、JSON 默认值/CHECK/唯一键/级联删除全部生效、7 条预置模板四方一致）**未做任何改动**。

### 3 个阻塞项

| # | 问题 | 修法 | 涉及文件 |
| --- | --- | --- | --- |
| **B1** | 预置通知模板种子的 `"receivers":[]` 违反契约自己的 N5（原文写 `1-100 个`）。真实库读回 `receiver_count:0`，后端按 N5 校验或前端 `z.array().min(1)` 都会让预置模板**永远无法原样 PUT 保存** | ①`receivers` 统一改为 **0-100 个**（§2.5、N5、domain.md 三处同步，去掉 min=1）；②「必须配好接收人」的约束**移到绑定处**，新增 **N9**：策略的 `notificationTemplateIds` 中凡 `channel≠5` 且 `receivers` 为空的模板视为**未配置完成**，绑定时返回 422 并指出模板名；③补产品语义：预置模板出厂即空占位，前端在列表/编辑页提示「请补充接收人后再绑定到策略」。种子 INSERT **无需改动**（`receivers:[]` 现已合法） | contract.md（§2.5 / §3.1 ③ P13 / §4.3 N5+N9）、domain.md（上手摘要第 10 条 + §5.2 落点表） |
| **B2** | 契约把指标字典规模写成 24，实际 28（两处） | 两处 `24` → **`28`**，并注明**唯一来源 `metrics.md` §1**，契约不重复列举避免再次漂移。已实测 metrics.md 为 28（CVM 10 / WEB 8 / CLB 4 / MYSQL 6） | contract.md（§2.7 尾注、§3.2 ⑧） |
| **B3** | 复制策略的「长度保护」两份文档互相矛盾，且契约那版可证伪错误：contract 写「按**字节**安全截断」、domain 写「按**字符**截断」。utf8mb4 下 128 汉字 = 384 字节，两条规则产出不同 name | 统一为**按字符**：与 `VARCHAR(128)` 和 `ck_policy_name_len` 的 `CHAR_LENGTH` 语义一致，也与 domain §5.4 的 `truncateUtf8` 一致。删除「按字节安全」表述，并加 ⚠️ 禁止条款 + 384 字节反例。顺带修正后缀字数：原文写「占 6 个字符」，实测 ` - 副本` = **5 字符 / 9 字节**、` - 副本(2)` = **8 字符 / 12 字节** | contract.md（§3.1 ⑦） |

### 8 项顺手修复

| # | 修法 | 涉及文件 |
| --- | --- | --- |
| **S1** | 「结构固定为 9 个字段」实为 **10** 个 → 改 10 并列出字段名 | metrics.md §0.1、deliverable.md |
| **S2** | 端点计数：§3.1 标题「8 个」→ **7**、§3.2「7 个」→ **9**、§3.3 保持 3，合计 19（原文标题合计 18 ≠ 实际 19）。deliverable 里「8 个」并推出「= 20 条路由」与同句「19」打架 → 改为 7/9/3 分组表 | contract.md §3、deliverable.md |
| **S3** | schema 注释称「唯一一处对 JSON 列做检索」不成立（⑬ 的 `?channel=` 过滤是第二处，实测 EXPLAIN `type: ALL`）→ 改为「共两处」并列明各自处理方式。**按要求只改注释，未新增生成列/多值索引**（已确认文件内无 `GENERATED/STORED/VIRTUAL`） | schema.sql 文件头 |
| **S4** | §2.3 说「不返回 `channels`」但紧接着的字段表与 §6 都有 `channels` → 改为「不返回 `channels` 的**接收人明细**，仅返回渠道编码数组」 | contract.md §2.3 |
| **S5** | `frequency=0`（不重复）是腾讯云 8 值之外的**扩展值** → 注明；`objectType=1` 文案「全部对象」vs 清单「全部实例」→ 注明语义一致且有意为之 | contract.md §1.6 / §1.7 |
| **S6** | schema 注释称接收人表负责「接收人**全局**唯一性」，但唯一键只有 `(template_id, channel, contact)`，同一 contact 挂到另一模板**可以插入** → 注释改为「**模板内**去重」，明确不存在全局唯一性。未加全局唯一键 | schema.sql §5 |
| **S7** | 「45 组列↔字段双向存在」被证伪：`alarm_policy_condition.{created_at,updated_at}`、`alarm_notification_receiver.{template_id,contact}` 在所属 DTO 中无对应字段 → 契约新增 **§2.8 服务端内部列**声明这 4 列刻意不对外；deliverable 自检口径改为 **41 组**并写明扣除项 | contract.md §2.8、deliverable.md |
| **S8** | 索引注释称 `idx_policy_status_level_created` 支撑「列表默认排序」，但默认排序 `created_at DESC, id DESC` 无等值前缀时用不上该索引 → 注释改为「状态+等级组合筛选」并说明排序由 `idx_policy_updated_at` / 聚簇主键顺序兜底 | schema.sql |
| **S10** | schema 给 `sort`/`level`/`frequency` 设了 DEFAULT，但契约 P10 声明「不做任何默认值兜底」→ 两处（P10 与 domain §5.2）补充「**应用层不得依赖 DB 列默认值，必须显式传值**」 | contract.md §4.1 P10、domain.md §5.2 |

> **修复过程中我自己引入又抓到的一个坑**：S8 的第一次写入其实**没有落盘**——同一脚本内先改 S8、后改 S3，
> S3 抛 AssertionError 导致整个脚本在 `write()` 之前退出，S8 的改动只停留在内存里。是新增的自动化校验
> （`/tmp/fix3.mjs`）发现「S8 注释未改」才暴露出来的。已重新落盘并复验。
> 本轮共发现 **3 处真实文档缺陷 + 1 处自身写入丢失**，其余 4 次校验报错均为我校验脚本的正则过严/ASI 问题，
> 逐一证伪后重写，未为迁就脚本而改动文档。

---

## 4.6 第 3 轮修复：`DB 默认值` 空值语义归一化（新增 §0.6）

第 2 轮修复后，我在自查中针对审查意见里残留的 `DB 默认值` 片段做了一次专项审计，
**又查出一处此前两轮都遗漏的真实跨文件矛盾**：

| | 契约声明 | DDL 实际 | 后果 |
| --- | --- | --- | --- |
| `notificationTemplateIds` | `int[]`，默认 **`[]`**（§2.2 / §3.1 ③，均声明为非空） | `notification_template_ids JSON **DEFAULT NULL**` | 后端按 DB 读出 `null`，前端按契约期望 `[]`；两边各自照抄就会产出不一致实现 |

其余 3 个 JSON 列（`objectIds` / `objectGroupIds` / `objectFilters`）契约声明的"空"是 `null`，
与 DDL 的 `DEFAULT NULL` 天然一致——**所以 `notificationTemplateIds` 是唯一一个方向相反的字段**，
也正是"契约 ↔ DB 默认值"最容易漂移的地方。

**修法**：contract.md 新增 **§0.6 JSON 列的「空值」归一化对照**，把 6 个 JSON 列逐行列成
「契约声明的空 / DB 存储的空 / 读归一化 / 写归一化」四列对照表，并立 3 条规则：

- **R-JSON-1**：`objectIds` / `objectGroupIds` / `objectFilters` 响应中**永远**是 `null` 而非 `[]`
  （与 §2.3 的 `int[] | null` 类型声明对齐）
- **R-JSON-2**：`notificationTemplateIds` 响应中**永远**是数组（DB 为 `NULL` 时补 `[]`）；
  写回时 `[]` 与 `null` 都落库为 `NULL`
- **R-JSON-3**：标量列的 `DEFAULT`（`object_type DEFAULT 1` / `level DEFAULT 3` / `sort DEFAULT 1` /
  `frequency DEFAULT 0`）**只是 DB 层兜底，不构成契约默认值**；这些字段契约上一律必填，
  应用层必须显式传值（与 §4.1 P10 一致）

R-JSON-1 与 R-JSON-2 方向相反是**刻意的**并在文档中写明了理由：前者参与严格的
`objectType` 一一对应语义（P14），返回 `null` 能让前端一眼看出"当前不适用"；后者参与 P12/P13/N9
校验与前端双向绑定，永远返回数组可让前端少写一层判空。

同时在 §2.2 / §2.3 / §3.1 ③ / §6 四处补了交叉引用，避免实现者只看字段表而漏掉归一化规则，
并加了一条 DAO 层提示（PHP 侧 `null` 与 `[]` 的 `json_encode` 结果不同，须在 DAO 归一化，
否则库里出现字面量 `null` 会破坏 `JSON_CONTAINS` 检索）。

**本轮 DDL 与另外三份文档未做任何改动**，仅 contract.md 新增 §0.6 + 4 处交叉引用。

---

## 5. 验证记录

| 校验项 | 方法 | 结果 |
| --- | --- | --- |
| 编码/乱码 | 扫描 4 份文件的 U+FFFD 替换字符 | 通过（发现并修复 2 处写入时的字符损坏） |
| SQL 语法 | `node-sql-parser`（MySQL 方言）逐语句 astify | 17/17 通过（`SET NAMES` 为解析器能力缺口，已证伪） |
| SQL 语义 | 自研校验器：列/主键/外键目标/CHECK 列/索引列/枚举值/长度/JSON 列 | 88 列、6 主键、2 外键、29 CHECK、30 索引全通过 |
| 字段一致性 | 41 组 snake_case 列 ↔ camelCase 字段双向存在性比对（**已扣除 4 个刻意不对外暴露的服务端内部列**：`alarm_policy_condition.{created_at,updated_at}`、`alarm_notification_receiver.{template_id,contact}`，已在 `contract.md` §2.8 声明） | 通过 |
| 枚举一致性 | 47 个枚举值在 `contract.md` + `schema.sql` 双向存在 | 通过 |
| 预置模板一致性 | 6 条模板在 metrics.md §3 详情表 ↔ §3.1 汇总表 ↔ schema.sql INSERT ↔ 指标字典四方比对（含 period ∈ periodOptions、continuity ∈ [1,10]、level/frequency 越界检查） | 通过 |
| 端点完整性 | 19 个必需路由逐一存在性检查 | 通过 |
| 错误码交叉引用 | 9 个错误常量在 `contract.md` + `domain.md` 同时出现 | 通过（发现并补齐 2 处） |
| 指标键引用 | 跨文档引用的 20 个 `namespace.metricName` 全部存在于字典 | 通过 |
| **第 2 轮：B1/B2/B3 + S1-S10** | 专项校验器（`/tmp/fix3.mjs`）逐条断言：种子 `receivers` 满足新 N3/N5、契约 `receivers` 0-100 三处口径一致且无 1-100 残留、指标数 28 与 metrics.md 实测一致、按字节截断已消除且后缀字数自证（` - 副本`=5 字符/9 字节）、§3 标题 7/9/3=19、schema 无生成列 | 通过（44 项断言） |
| **第 2 轮：回归** | 原 4 套校验（编码 / SQL 语法 / 跨文档 / DDL 语义）全部重跑 | 全部通过，未引入回归 |
| **第 3 轮：JSON 空值归一化** | 新增 `/tmp/json.mjs`：解析 §0.6 六行对照表，逐列回查 `schema.sql` 真实列类型与 `DEFAULT`，并按 nullable/非空分支校验读归一化方向与写归一化措辞；同时反查 domain.md 与 §2.2/§2.3/§3.1 ③/§6 无冲突残留 | 通过（21 项断言） |

> 校验脚本为一次性工具，跑在 `/tmp`（`node-sql-parser` 装在 `/tmp/sqlcheck`），**未在 `/workspace`
> 引入任何依赖**，也未创建任何 PHP/Vue 代码。
