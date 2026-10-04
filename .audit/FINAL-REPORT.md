# 告警策略模块 — 四线审查合并去重报告

- **输入**：`.audit/audit-frontend.md`（A 线）/ `.audit/audit-backend.md`（B 线）/ `.audit/audit-contract.md`（C 线）/ `.audit/audit-data.md`（D 线）
- **本次工作**：去重合并、逐条回代码交叉验证、剔除假阳性、统一分级、排序修复路线
- **只读声明（已收窄并附证据，见 §2.5）**：本审查未修改任何项目文件。`web/` 有 git 可证（`git status --short -- src/pages/alarm src/services` 为空）、`docs/` 可由 mtime 证（最新 2026-09-30）；**`server/` 无 git 基线、无法机械化证明**，只做了 mtime 核对，其中 2 个文件在本次汇总会话开始前已被改动，详见 §2.5 的诚实边界。

---

## 0. 判定

> # VERDICT: FAIL
>
> | 项 | 值 |
> | --- | --- |
> | **合并后缺陷总数** | **44**（阻塞 2 / 严重 8 / 中等 18 / 轻微 16） |
> | **已实测复现** | **8** |
> | **仅静态推断** | **36** |
> | **阻塞级（上线前必须清零）** | **2**（S-01 后端 ③/④ 全 500、S-02 前端向导不可用） |
> | **本次亲自回代码确认的条目** | 10（2 条阻塞 + 8 条严重，逐条 `read`/`sed` 回源码核对行号与代码内容） |
> | **剔除的假阳性/非缺陷** | 4 |
> | **跨线去重** | **11 个合并组**（消解 13 条输入）+ **1 处有意不合并的拆分**（2 进 2 出） |
> | **待契约方裁决后才能动手的项** | 3（S-14 / S-26 / S-28） |
> | **项目文件改动** | 无。`web/` 告警模块与 `docs/` 可由 `git status` / mtime 证明；**`server/` 无 git 基线、无法机械化证明**（见 §2.5） |
>
> **判定理由**：存在 2 条阻塞级缺陷，且它们分处链路两端——后端写不进、前端走不到。**该模块当前无法通过 API 或 UI 创建任何一条告警策略**，因此不能声称「后端告警规则配置是正确的」，也不能上线。修完 S-01 与 S-02 之前不满足验收条件。

---

## 1. 结论

四条线的结论彼此并不矛盾，指向的是同一个判断：**这个模块目前不能上线**。四条报告的编号体系互不兼容、无法机械求和成一个可信的「原始总数」，故本报告不声称精确对账（结构化口径见 §3.1）；按该口径归并后得 **44 条**，其中 **已实测复现 8 条、仅静态推断 36 条**；2 条阻塞级缺陷各自独立地把整条链路打死——后端 `insertConditions()` 把 camelCase 键原样写进 snake_case 表，导致 ③POST / ④PUT 必然 500，**通过 API 无法创建任何一条策略**（B-1 + C-D-3）；前端 `policy-form.vue:223` 的 `computed(() => form.state.values)` 永久冻结，向导永远停在第 1 步、0 次请求发出，**UI 上同样创建不了任何策略**（A-F-01/02/03）。这两条位于链路的正中间：它们之前，`lint`/单测 424 用例/类型检查/构建 **四条基线全绿**；它们之后，告警策略的新建、编辑、复制三条主干路径全部不可达。静态占 36 条的绝大多数不是"没跑过所以不算"，而是本沙箱**没有 PHP、没有 `server/vendor`、没有 MySQL**，后端与数据层的每一条都只能停在源码级推理——这一点在下面的清单里逐条标注了，不允许被读成"已验证"。

---

## 2. 缺陷清单

**状态列约定**：`已复现` = 攻击线挂载真实 `.vue` 组件跑出可观察的错误现象（仅 A 线具备该能力）；`仅静态` = 推理链完全落在源码行上，未经任何运行时验证。

### 2.1 阻塞（2）

| # | 级别 | 一句话描述 | 来源线 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| S-01 | 阻塞 | `insertConditions()` 把 camelCase 键原样交给 `Builder::insert()`，写进 snake_case 表 → ③POST/④PUT 必然 500，**模块无法通过 API 产出任何策略**，⑦ copy 因无源可复制成为死链 | B-B-1 + C-D-3 | `AlarmPolicyService.php:649-659` 原样 `array_merge`；`ConditionValidator.php:140-152` 返回 `metricNamespace/metricName/metricNameCn`；`AlarmPolicyCondition.php:23-25` `$fillable` 全 snake_case；`Model.php:13-16` 无键名转换；**同表另一条写路径 `copy():328-344` 与 `Presenter.php:76-78` 都手工改了名**（决定性内部反证） | 仅静态 |
| S-02 | 阻塞 | 策略表单响应式断裂：向导永久停在第 1 步，0 请求 0 跳转，新建/编辑/复制 UI 全面不可用 | A-F-01 + A-F-02 + A-F-03（合并） | `policy-form.vue:223` `computed(() => form.state.values)`；根因 `form-core@1.33.5/dist/esm/FormApi.js:1178` 是普通 getter 且该包 `grep -c 'from "vue"'` = 0，`@tanstack/store` 的 `state` 亦为普通 getter；库给的响应式入口 `useForm.js:38` 的 `api.useSelector` 从未使用。传导链我已逐环回读确认：`:425 currentValues()` → `:429 validateStep()` → `:721 handleSubmit` 早退；`:497 watch(values)` 恒不触发 → `dirty` 恒 false。**三个症状同源**：复制名恒为 `" - 副本"`（`:753`）、`baseline` 为空表单（`:757-758`） | 已复现 |

> **为什么不是"测试没覆盖"这么轻**：A 线给出的是黑盒症状（连点 3 次「下一步」仍停在第 1 步）+ 白盒链路 + 控制实验（新建 computed 立刻可读、不经 computed 的直接插值也不更新、vue 解析路径唯一，排除 harness 双实例伪影）三重证据。我复核了根因链上的每一环，**因果链成立**。

### 2.2 严重（8）

| # | 级别 | 一句话描述 | 来源线 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| S-03 | 严重 | `ErrorCode::MESSAGES` 里 5 个键求值都是 409，PHP 数组字面量后写覆盖 → **所有 409 的文案塌缩成「该告警已处理，不可重复处理」**，把 5 个互斥运维语义压成 1 个错误语义 | B-B-2 + C-D-1 | `ErrorCode.php:19-23` 五常量同值；`:34-38` 字面量；`AlarmPolicyService.php:262/542`、`AlarmExceptionHandler.php:78`、`*TemplateService.php:124/160` 五个消费点全部取到错误文案。**我已逐行确认**。旁证：`test/Cases/Feature/PolicyPersistenceTest.php:109-110` 断言的正是代码给不出的那个 message | 仅静态 |
| S-04 | 严重 | ⑥ `POST /policies/{id}/status` 缺 `status` / 坏 JSON / `status:""` → **静默把线上策略停用并返回 200**，而不是 422 | B-H-1 + C-D-2 | `AlarmPolicyService.php:505-510` `$raw===null\|\|'' → return 0` 且不记错；`AlarmPolicyController.php:62` `$body['status'] ?? null`；`AbstractController.php:64-66` 坏 JSON → `[]` → null。契约 `contract.md:741` 明确 `status` **必填**（我已核对原文） | 仅静态 |
| S-05 | 严重 | 通知模板字典 `pageSize:100` 截断，字典外的模板 id 被判成「不存在」→ **这类策略打开编辑页后每次保存都失败，无自救入口** | A-F-04 | `policy-form.vue:321` 只拉第 1 页 100 条；契约 `contract.md:80` `pageSize` 上限即 100（已核对）；`loadDetail():390` 只 `resetForm`，**不把 detail 里的 `notificationTemplates` 摘要并入下拉字典**（我已回读确认）；`policy-logic.ts:367-371` missing 判定 → `policy-form.vue:678-684` 非空即 `return` 不发请求 | 已复现 |
| S-06 | 严重 | 契约 ⑦ `POST /policies/{id}/copy` 在 UI 中从未被调用；复制退化为手工 4 步向导 + 固定名，**第二次复制必撞 409，而 409 文案又已被 S-03 污染** | A-F-05（叠加 A-F-02 的名字症状） | `copyAlarmPolicy` 全仓仅 `alarm-policy.api.ts:150` 定义 + 自身单测；`policy/index.vue:183` 走 `router.push(...copyFrom...)`；`buildCopyName` 的 `(2)..(99)` 分支需显式传 `seq`，调用点 `policy-form.vue:753` 从不传（`policy-logic.ts:119-126` 本身正确）。**我已 grep 全仓确认零引用** | 已复现 |
| S-07 | 严重 | 6 个 `up()` 首行无条件 `DROP TABLE IF EXISTS` → **重跑这些迁移会静默清空对应表**，包含 schema 自称「永不删除」的 `alarm_history` | B-M-1 + D-M-02 | `migrations/000100:27 / 000200:27 / 000300:27 / 000400:27 / 000500:27 / 000600:27`（我已 grep 逐个确认：6 个文件共 12 处 DROP，其中 6 处在 `up()`、6 处在 `down()`）；`000600` 建表 COMMENT 写「永不删除」而同一文件 `up()` 第 27 行就 drop 它。**本条只讲"重跑即清表"**；与之相关的 FK 报错/不可自愈部分已剥离到 S-17，两条不重叠 | 仅静态 |
| S-08 | 严重 | `schema.sql:10` 声明 `MySQL >= 8.0.13`，而 8.0.16 以下 MySQL **只解析不执行 CHECK** → 29 条约束静默失效且不报错 | D-M-01 | `schema.sql:10`（我已核对原文）；`server/README.md:36,42-65` 有整节论证必须 8.0.16；`.env.example:6` 写 8.0.16+。**全仓唯一写错的那份文件恰是运维唯一会主动打开的**。改 1 行 | 仅静态 |
| S-09 | 严重 | `isDuplicateKey()` 把整个 SQLSTATE `23xxx` 当"重名" → FK(1452)/CHECK(3819)/NOT NULL(1048) 失败被报成 409「策略名称已存在」 | B-H-2 | `AlarmExceptionHandler.php:101` `str_starts_with($state, '23')`（我已回读）。可复现实例：并发删除时 `AlarmPolicyService.php:204/244/246` 触发 `fk_condition_policy` → 用户看到"你重名了" | 仅静态 |
| S-10 | 严重 | 鉴权中间件白名单为空时 **fail-open 返回 true** → 生产漏配 `ALARM_STATIC_TOKENS` 即全部告警接口无鉴权 | B-L-2 | `AuthMiddleware.php:50-55` `if ($allow === '') return true;`（我已回读）。作者已注释为联调占位、契约风险登记为 R7，但**默认值方向反了**且无任何错误信号 | 仅静态 |

> **对 S-03 的一处重分级**：B 线判 BLOCKER、C 线判 P0，**我改判「严重」**。理由：它不使功能不可用、也不损坏数据——HTTP 状态码仍是 409，前端分支判断正确，只有展示文案错。按本报告的分级定义（阻塞 = 功能不可用或数据损坏），它达不到阻塞。严重已经足够高：运维看到的所有 409 提示都指向错误的根因。

### 2.3 中等（18）

| # | 级别 | 一句话描述 | 来源线 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| S-11 | 中等 | `alarm_policy` 三个 object JSON 列零 CHECK、零跨列约束 → P14（objectType↔绑定字段对应）完全裸奔 | D-D-01 | `schema.sql` 29 条 CHECK 中无一条引用 JSON（我已 grep 全部 ck_ 名称确认）；`ck_policy_object_type` 只读 `object_type` 一列 | 仅静态 |
| S-12 | 中等 | `notification_template_ids` 无上限/去重/存在性约束；元素类型漂移成 JSON 字符串会**静默击穿 ⑯ 的 409 引用保护** → 永久悬挂引用 | D-D-02 | 该列与模板表之间**故意无 FK**（`schema.sql:29-31` 自述）；`JSON_CONTAINS` 对标量比较类型严格，`'["3"]'` ≠ `CAST(3 AS JSON)`。报告给出 V12 验证命令未执行 | 仅静态 |
| S-13 | 中等 | `JSON NOT NULL` 拦不住 JSON 字面量 `null`；`conditions` / `channels` 的数组类型与 1-4 / 1-5 长度无任何约束 → 500 会出现在**读取路径**而非写入路径 | D-D-03 | `schema.sql` 两列为 `JSON NOT NULL` 无默认值无 CHECK。`CHECK (JSON_TYPE(x)='ARRAY' AND JSON_LENGTH(x) BETWEEN ...)` 在 8.0.16+ 完全可表达，属漏写 | 仅静态 |
| S-14 | 中等 | `monitorType ↔ policyType` 联动零约束：两条互相独立的单列 CHECK，契约明说"3/4/5 不可选"的组合可直接落库 | D-D-04 | `ck_policy_monitor_type` / `ck_policy_policy_type` 不读对方列。**修复前需契约方裁决**：§1.1 同时把 5 个 monitorType 列为合法枚举，落地 CHECK 会让 3/4/5 永不可写 | 仅静态 |
| S-15 | 中等 | 派生列 `alarm_policy.level`（= min(conditions[].level)）无约束无触发器；`sort` 的 P5 连续性同样放行 → `level=1` 的紧急列表会返回实际只发提示的策略 | D-D-06 | `ck_policy_level` / `ck_condition_level` 各看各行；`uk_condition_policy_sort` 只保证不重复不保证连续 | 仅静态 |
| S-16 | 中等 | seed 迁移 `000700.down()` 不是 `up()` 的逆操作：删掉用户改过的预置模板，并留下悬挂的 `condition_template_id` | B-M-3 + D-M-04 | `000700:74-75`（我已回读）`DELETE ... WHERE is_preset=1 AND creator_id=0`；`alarm_policy.condition_template_id` 无 FK。文件 docblock 自称"不动用户数据"是错的。当前护栏靠 `creator_id` 硬编码 0，属巧合叠加 | 仅静态 |
| S-17 | 中等 | 迁移不设 `SET FOREIGN_KEY_CHECKS=0/1`（`schema.sql:54/328` 有、7 个迁移全无）→ 父表 DROP 撞 FK 报错、且一次迁移中途失败留下残留子表后 errno 3730 使整套迁移**不可自愈**；单文件执行亦会失败 | D-M-03 + B-M-1(仅不可重入子句) | 两条线独立 grep 均得 NONE FOUND（互相印证）；迁移完全依赖文件序号保证父表先建。**失败模式不对称**：重跑父表迁移（000100/000400）→ 响亮报错中止（相对安全），重跑子表/独立表（000200/000300/000500/000600）→ 静默清表（危险，走 S-07）。**与 S-07 是有意拆分**：S-07 = 重跑即清表，S-17 = 没有 FK 包裹导致报错/不可自愈 | 仅静态 |
| S-18 | 中等 | `copy()` 的副本名是"事务外先查后写"（TOCTOU），最多 99 次串行 `SELECT EXISTS` → 并发复制同一策略返回 409，而非契约承诺的 `(2)` 重试成功 | B-M-2 | `AlarmPolicyService.php:300` 在 `:302` 的 `Db::transaction` **之外**调用 `generateCopyName()` | 仅静态 |
| S-19 | 中等 | 列表筛选只做 `Number.isFinite`，不做枚举成员判定 → 非法枚举/小数/负数 `projectId` 原样透传，必然 422；`Number('  ')` = 0 使纯空格静默变成"按 projectId=0 过滤" | A-F-06 | `policy-logic.ts:569-574` `numeric()`（我已回读）；`policy-filters.vue:143-150` `projectId` 是自由数字输入。函数注释自称"只透传合法数字"，与实现不符 | 已复现 |
| S-20 | 中等 | 确认页 `filter(Boolean)` 静默丢弃字典外的 `notificationTemplateIds`，但 id 列表仍显示完整 → 展示与实际提交不一致且无提示 | A-F-07 | `policy-view.ts:116-133` `toNotificationBrief`（我已回读）。与 S-05 叠加：用户先看到"1 个"，提交时才被告知"不存在" | 已复现 |
| S-21 | 中等 | `threshold` 不校验 `DECIMAL(20,4)` 量级 → `1e20` 通过全部应用层校验后由 MySQL 报 1264，SQLSTATE 22003 不以 `23` 开头 → **500 而非 422** | B-M-5 | `ConditionValidator.php:168-186`（我已回读，只校验"是数值 + ≤4 位小数"）；列定义 `DECIMAL(20,4)` = 16 位整数 | 仅静态 |
| S-22 | 中等 | 条件级枚举走 `is_numeric` 强转（`sort:"1.9"`→1 通过、`level:2.9`→2 通过），策略级走严格整数字面量 —— 两套标准 | B-M-4 | `ConditionValidator::assertEnum():211` vs `Pagination::intParam():71`（我已回读）。落库值仍合法无数据损坏，但契约声明这些字段是 int | 仅静态 |
| S-23 | 中等 | `sort`/`level`/`frequency` 的 `DEFAULT` 把 P10 必填吞成合法默认值 → `frequency=0`（不重复）会被静默写入，值合法、约束全绿、只是错了 | D-D-07 | 同表 `period`/`continuity` **无 DEFAULT** 因此有防线，一半被自己的默认值出卖。契约 §0.6"CHECK 是最后一道防线"在这三列上是事实错误 | 仅静态 |
| S-24 | 中等 | `metric_namespace` / `metric_name` / `contact` 均允许空串（`NOT NULL` 拦不住 `''`），而 `name` 列反而配了 `ck_*_name_len` | D-D-08 + D-D-11（合并） | `schema.sql` 两条 VARCHAR(64) / VARCHAR(255) NOT NULL，无任何 CHECK 引用。属漏写：非空 CHECK 完全可表达 | 仅静态 |
| S-25 | 中等 | `alarm_history` 状态机与 `handle_action` / `handled_at` / `recovered_at` / `duration` 的一致性零约束（7 条 CHECK 全是单列域校验） | D-D-09 | H3「仅 status=1 可处理」是防重复处理的唯一机制；脏 status 直接污染 ⑲ 首页 `todayUnhandled` 统计。**报告同时点名 `ck_history_handle_action` 是 29 条里质量最高的一条**（显式写 `IS NULL OR`，不依赖三值逻辑） | 仅静态 |
| S-26 | 中等 | `utf8mb4_0900_ai_ci` 是 NO PAD + 大小写不敏感 → `'CPU监控'` 与 `'CPU监控 '` 可同时入库（违反 P1"去首尾空格后唯一"），而 `'Policy'`/`'policy'` 被判重复（契约从未声明大小写不敏感） | D-D-10 | DB 层从未对 name 做 TRIM 归一化；`uk_receiver_template_channel_contact` 上的邮箱大小写冲突会产生无法解释的 409 | 仅静态 |
| S-27 | 中等 | ⑰ 历史列表 `keyword` 的 `LIKE '%x%'` 在**只增不减**的 `alarm_history` 上做无界全表扫，且该风险未在 `schema.sql` 中披露 | D-§6.5 | `schema.sql:42-50` 主动披露了 2 处 JSON 检索全表扫，但历史 keyword 与策略 keyword 两处未披露；`alarm_history` 自称"永不删除" | 仅静态 |
| S-28 | 中等 | `condition_template_id` / `project_id` 两个跨模块引用无 FK 防线（前者被 `0 = 未使用` 哨兵值挡住，后者项目表不在本模块） | D-§6.1 + D-D-13 | 有索引无 FK；409 保护是唯一守卫。是否把哨兵改 `NULL` 需契约方拍板 | 仅静态 |

### 2.4 轻微（16）

| # | 级别 | 一句话描述 | 来源线 | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| S-29 | 轻微 | `pendingId` 是全局单值：行 A 请求中时行 B 的开关可点、有按压反馈、点击被静默吞掉（死控件） | A-F-08 | `policy/index.vue:134-135` 全局守卫 vs `policy-columns.ts:116` 只禁用当前行 | 已复现 |
| S-30 | 轻微 | `confirmDelete` 无函数内重入保护，双击保护完全依赖 `:is-loading` 触发的渲染 flush；与 `toggleStatus` 的显式守卫不一致 | A-F-09 | `policy/index.vue:200-229` 缺 `if (deleting.value) return`。**A 线主动给了反证**：按真实浏览器时序（两次 click 间跑一次 nextTick）DELETE 只发 1 次，故**不是可利用的重复提交** | 已复现 |
| S-31 | 轻微 | `confirmDelete` 的**失败分支缺少清理**：`if (!res.success)` 只 `toast.error` 后 `return`，不恢复任何状态、也没有让弹窗留在原地的手段；`ConfirmDialog.handleConfirm` 又无条件 `openModel.value = false`，经 `@update:open` 把 `deleteTarget` 置空 → 409/404 时弹窗照常关闭，用户只剩一条转瞬即逝的 toast | A-F-10 | 我已回读三个分支的实际控制流：`policy/index.vue:209-213` 失败分支（`toast.error` + `return`，**无任何清理**）；`components/confirm-dialog.vue:37-40` `emits('confirm')` 后紧接无条件 `openModel.value = false`；`policy/index.vue:298` `:open="deleteTarget !== null"`、`:303` `@update:open="(v) => { if (!v) deleteTarget = null }"`。**修正前一版的错误表述**：我原先称 `:216` 的 `deleteTarget.value = null` 是"死代码"——重读后确认它在**成功路径上照常执行**、并非死代码（只是相对 `@update:open` 的置空是冗余的）；真正的缺陷是**失败分支缺少清理**，失败时 `deleteTarget` 由弹窗的关闭事件顺带清空，作者显然以为失败后弹窗会留着 | 已复现 |
| S-32 | 轻微 | `callbackUrl` 幽灵字段：表单第 3 步与确认页当必填项展示，`buildPolicyPayload` 静默丢弃，详情页该区块恒空 | A线(未编号) + C-D-5（合并） | `policy-form.vue:162,1436-1441`、`policy-view.ts:82,84,219-220,289-290,354`；契约 §3.1③ 请求体 14 字段中无它（它属 §2.5 的 NotificationChannel）。**不违反契约，但是一个永远无效的输入项** | 仅静态 |
| S-33 | 轻微 | 契约 §2.8 内部列清单漏登记 4 列（`creator_id` ×3、`alarm_policy_condition.policy_id`）；"45 − 4 = 41"的算术与 §2 实际字段清单对不上 | C-D-4 | `contract.md:466-479`（我已核对原文）。**部分可验证**：漏登记 4 列我确认了；"45 组"的口径无定义，C 线给的 60 去重字段名我无法独立复算，故只记文档不自洽，不记具体数字错 | 仅静态 |
| S-34 | 轻微 | `keyword` 的 128 长度软约束在前后端均未落地 | C-D-7 | `contract.md:499,920` 为说明列；`buildPolicyListQuery` 只 trim，后端 `strOrNull()` 无长度校验 → 不返回 422 | 仅静态 |
| S-35 | 轻微 | 前端 zod 把契约选填字段（remark/projectId/conditionLogic/notificationTemplateIds/conditionTemplateId/status）设为必填 | C-D-8 | `policy.validator.ts:279-344`。因 payload 恒带值，**当前无线上影响** | 仅静态 |
| S-36 | 轻微 | `Validator::add` 同字段只保留第一条错误 → 契约 §0.4 要求的"每个字段的具体原因"被吞（N9 的模板名提示会被 P13 覆盖） | C-D-9 | `Validator.php:93-100`（我已回读） | 仅静态 |
| S-37 | 轻微 | `403 FORBIDDEN` 分支永久不可达：无任何项目/资源权限校验 | C-D-10 | `ErrorCode.php:17` 定义但无生产路径；已知风险 R7 | 仅静态 |
| S-38 | 轻微 | 29 条 CHECK 的有效防御力实为 ~23.5：3 条 `remark_len` 恒真，3 条 `name_len` 只有下界是活的 | D-§2.1 | `CHAR_LENGTH(<VARCHAR(500)>) <= 500` 类型已保证；`schema.sql` 中 3 条同型。不是"没坏处"，而是**制造了"备注长度有约束"的错觉** | 仅静态 |
| S-39 | 轻微 | 2 条 100% 冗余索引 + 2 条无 v1.0 读路径的写放大索引；`schema.sql:93-94` 注释称 `updated_at` 索引能为 `created_at` 排序兜底（列名都不同，事实错误） | D-§6.2/6.4/6.5 | `idx_condition_policy_id` 被 `uk_condition_policy_sort` 左前缀覆盖（`schema.sql:142` 注释自己说了、`:146` 又建）；`idx_receiver_template_channel` 同理；`idx_history_object` / `idx_policy_updated_at` 无读路径。**报告自评为"真正的缺陷是错误注释和无读路径写放大，不是排序性能"** | 仅静态 |
| S-40 | 轻微 | 全局 handler `isValid(): true` + `stopPropagation()` 吞掉路由 404 → 未匹配路径返 500 而非 404 | B-L-1 | `AlarmExceptionHandler.php:35,63-66` | 仅静态 |
| S-41 | 轻微 | `currentUser()` 硬编码 `id => 0`，creatorName/handlerName 不来自登录态（契约 ③ 要求 creatorId = 当前登录人） | B-L-3 | `AbstractController.php:36-42`。已自述为占位 | 仅静态 |
| S-42 | 轻微 | `assertObjectType` 把"必填缺失"与"取值非法"合并成一条文案 | B-L-4 | `AlarmPolicyService.php:444-448`；同文件 `assertMonitorAndPolicyType:404-408` 做对了 | 仅静态 |
| S-43 | 轻微 | `AlarmEnum.php:49` 注释描述 `operator`，其下实际是 `FILTER_MATCH_TYPE` | B-L-5 | 陈旧注释 | 仅静态 |
| S-44 | 轻微 | `object_filters` JSON 内的 `operator` / `matchType` 副本绕过了已有的 6 值 CHECK（CHECK 无法逐元素校验，属 MySQL 真实限制） | D-D-12 | **报告自己判定为"只能靠应用层"**，仅建议 DDL 注释写明边界 | 仅静态 |

### 2.5 只读声明的证据（substantiate or scope）

本会话对文件系统只做了读取类操作（`read` / `grep` / `glob` / `sed -n` / `find` / `git status` / `stat`），唯一的写入目标是 `/workspace/.audit/FINAL-REPORT.md`、`/workspace/.mavis/plans/plan_74e1c585/{board.md,outputs/synthesis/deliverable.md}`。以下为可复现的外部证据，以及**无法证明的部分**。

**证据 A — `web/` 是 git 仓库，审查范围零改动**

```
$ cd web && git status --short
 M package.json
 M pnpm-lock.yaml
 M src/pages/auth/sign-in-2.vue
?? .env.demo
?? scripts/
?? src/assets/placeholder.webp.ts

$ git status --short -- src/pages/alarm src/services
（输出为空 —— 本次审查的读取范围在 git 看来与 HEAD 完全一致）
```

3 个被修改的文件全部落在**告警模块之外**，且 mtime 均早于本会话开始（本会话 agent-context 起始时间 `2026-10-03 09:43:51 UTC`）：`package.json` = 09:06:39 UTC、`pnpm-lock.yaml` = 09:06:28 UTC、`sign-in-2.vue` = 2026-10-02 17:18:57 UTC。**结论：web 仓库的告警模块可证明未被本次审查触碰。**

**证据 B — `docs/` 可由 mtime 证明未被触碰**

最新 mtime 全部为 2026-09-30（`deliverable.md` 15:39 / `contract.md` 15:38 / `schema.sql` 15:36 / `metrics.md` 15:34 / `domain.md` 15:34），比审查窗口（10-03）早 3 天。

**证据 C — `server/` 只能部分证明，这里明确划出边界**

`server/` **不是 git 仓库**（`/workspace`、`server`、`docs` 均无 `.git`），因此没有可比对的基线。只能做 mtime 核对，结果如下：

```
$ TZ=UTC find server -type f -newermt "2026-10-01" -printf '%TY-%Tm-%Td %TH:%TM:%TS UTC  %p\n' | sort -r
2026-10-03 09:36:30 UTC  server/src/Support/Presenter.php
2026-10-03 09:35:13 UTC  server/src/Constants/AlarmEnum.php
（其余全部 server 文件的 mtime ≤ 2026-09-30）
```

诚实说明三点：

1. 这 2 个文件的 mtime（09:35 / 09:36 UTC）**落在四条攻击线的审查窗口内，但早于本汇总会话的开始（09:43:51 UTC）**。即：它们不是本次汇总工作造成的改动，但**发生在本次审查期间**，来源我无法确定（无 git 基线可 diff）。
2. 因为没有基线，**我无法证明 `server/` 在本次审查期间未被任何一方修改**。若后续需要该保证，正确做法是先 `git init` 或对 `server/` 做一次 checksum 快照，再重跑审查。
3. 本报告引用的 `server/` 全部行号（`AlarmPolicyService.php:649-659`、`ConditionValidator.php:140-152`、`ErrorCode.php:19-41` 等）是我在上述时间点**亲自回读确认**的，与报告成文时一致；但**"这些行自项目初始提交起从未变过"是本报告无法证明的**。`web/node_modules/.pnpm/` 下的两个文件（`src/types/*.d.ts` 09:40 UTC、`src/types/alarm.ts` 09:35 UTC）同理——前者大概率是 A 线跑 `vue-tsc -b --force` 重新生成，后者来源不明。

> **收窄后的声明**：本审查**可证明**未修改 `web/` 告警模块与 `docs/`；**不能证明** `server/` 在审查窗口内未被改动，该部分的只读性只有"本汇总工作未写入"的自我保证而无外部证据。

---

## 3. 统计

| 级别 | 条数 | 其中已复现 | 其中仅静态 |
| --- | --- | --- | --- |
| 阻塞 | 2 | 1 | 1 |
| 严重 | 8 | 2 | 6 |
| 中等 | 18 | 2 | 16 |
| 轻微 | 16 | 3 | 13 |
| **合计** | **44** | **8** | **36** |

**两个计数**：**已实测复现 8 条 / 仅静态推断 36 条。**

复现能力分布极不均衡，且这不是审查质量的问题而是环境问题：A 线有 `web/node_modules`，能挂载真实 `.vue` 跑 vitest；B/C/D 三线面对的沙箱**没有 PHP、没有 Composer、`server/vendor/` 不存在、没有 MySQL**。因此 **36 条静态结论里没有一条被 B 线/C 线/D 线自己运行过**，凡涉及框架、驱动、DB 语义的环节均已在对应行的证据列注明"需运行时验证什么"。

### 3.1 去重合并记录（归并为 44 条）

**口径说明（前一版此处自相矛盾，本次修正）**：四份报告的编号体系互不兼容（A 线 `F-xx`、B 线 `BLOCKER/H/M/L`、C 线 `D-x`、D 线 `D-xx/M-xx/I-xx/X-xx`），把它们机械求和成一个"原始发现总数"并不可信。因此**本节不再声称「51 → 44」这样的精确对账**，改为给出可核对的结构化拆分：

| 项 | 数量 | 口径 |
| --- | --- | --- |
| **合并组** | **11 组** | 下方表格第 1–11 行。其中 2 组是 3 条输入并成 1 条（F-01/02/03、§6.2/6.4/6.5），9 组是 2 条并成 1 条 |
| 合并消解的输入条数 | **13** | 2 组×2 + 9 组×1 |
| **有意不合并的拆分** | **1 行** | 表格第 12 行，B-L-2 + C-D-10 → 2 条输入仍产出 2 条（S-10 / S-37），**不消解任何条数**，单独列出以免被误计为合并 |
| 剔除的发现 | **4** | 见 §3.2 |
| 合并后产出 | **44** | 与 §3 统计表一致 |

> 下表共 **12 行 = 11 个合并组 + 1 行显式声明不合并的拆分**。上一版标题把这两类混写为同一个数，已修正。

| 合并 | 合并后 | 理由 |
| --- | --- | --- |
| B-B-1 + C-D-3 | S-01 | 同一事实（camelCase 键写进 snake_case 表），两条线独立路径得出；B 线读代码流、C 线读契约↔DTO↔DDL 三方比对 |
| B-B-2 + C-D-1 | S-03 | 同上 |
| B-H-1 + C-D-2 | S-04 | 同上 |
| A-F-01 + A-F-02 + A-F-03 | S-02 | 3→1。同一根因（`values` computed 冻结）的三个症状，**一处修复全部消解**；F-03 的 `baseline` 覆盖只有在 values 响应式后才会与 `resetForm` 一致 |
| B-M-1 + D-M-02 | S-07 | 同一事实（6 个 `up()` 无条件 DROP），两条线各自 grep 到同 6 个行号。**注意**：B-M-1 原本还含「不可重入」子句，已按"有意拆分"剥离到 S-17，见 S-07 证据列 |
| B-M-3 + D-M-04 | S-16 | 同一事实（`000700.down()` 非逆操作） |
| D-M-03 + B-M-1(不可重入部分) | S-17 | 同一事实（无 `FOREIGN_KEY_CHECKS` 包裹）。与 S-07 是**有意拆分**，两条互不重叠，见 S-17 证据列 |
| A线未编号 + C-D-5 | S-32 | 同一事实（callbackUrl 幽灵字段） |
| D-D-08 + D-D-11 | S-24 | 同一类事实（VARCHAR NOT NULL 无下界 CHECK） |
| D-§6.1 + D-D-13 | S-28 | 同一类事实（跨模块引用无 FK） |
| D-§6.2 + D-§6.4 + D-§6.5 | S-39 | 3→1。同一主题（索引卫生） |
| B-L-2 + C-D-10 | 拆为 S-10 / S-37 | **不合并（2 进 2 出，不消解条数）**：前者是鉴权 fail-open（安全），后者是 403 分支不可达（契约缺口），修复面与责任人不同 |

### 3.2 剔除的发现

| 被剔除 | 出处 | 剔除理由 |
| --- | --- | --- |
| `apiFetch` 的 mock 分支丢弃 `query`，导致 mock 模式下筛选/分页失效 | C-D-6 | **这是 mock 的已知设计限制**（`api-client.ts:49-53` 明确 `VITE_USE_MOCK` 下只透传 `{method, body}`），不是产品缺陷。真实 HTTP 路径不受影响。按"mock 已知限制不算缺陷"剔除 |
| 条件条数下界 1 在 DDL 中无约束 | D-D-05 | 复核后**判定为非缺陷**：`ConditionValidator.php:51-57` 已用 `CONDITION_MIN=1 / CONDITION_MAX=4` 强制 1-4 条（我已回读），前端 zod 亦强制。不变量有应用层保护；D 线报告自己的结论也是"这确实只能靠应用层"。真正缺的是**端到端测试**（三条写路径各验一次），已转列为覆盖边界第 9 项 |
| `objectFilters` 的聚合函数与 metric 类型是否匹配 | B 线必查点 3 | 四条线均未把它列为发现，B 线自查后判定**前提不成立**（契约 §2.1 / `schema.sql` / `metrics.md` 均无聚合字段，v1.0 无此概念）。不编造发现 |
| `INSERT IGNORE` 遇 CHECK 违规的确切行为 | D-§3.2 #10 | D 线自己标注"本次未能实测"，属未决问题而非发现。已转入覆盖边界第 6 项 |

### 3.3 明确指出的矛盾与裁决

四条线**没有出现事实层面的互相矛盾**。以下三处是表面冲突，已逐一裁决：

1. **"⑦ 复制端点三方一致" vs "⑦ 从未被调用"** —— C 线在 §3 端点表把 ⑦ 标为"YES 三方一致"（`alarm-policy.api.ts:150-154` 的 `IResponse<AlarmPolicyCopyResult>` 与后端 `['id'=>..,'name'=>..]` 确实对齐），A 线判 F-05 严重。**采信二者并存**：DTO 层一致 ≠ UI 接线完整，`copyAlarmPolicy` 已实现却在 `web/src` 零调用是另一回事。**采信 A 线**（UI 层缺陷成立），C 线的 PASS 只覆盖到传输层。
2. **迁移破坏性缺陷的定级** —— B 线判 MEDIUM-HIGH，D 线判 P0/阻塞。**采信事实、重新定级为「严重」**：触发需要重跑已记账的迁移这一异常路径，不是正常操作下的功能不可用；按本报告定义（阻塞 = 功能不可用或数据损坏，且为常态路径）判严重更诚实，但它确实是**数据损坏级**风险，修复优先级放在 Phase 2 头部。
3. **`AlarmPolicyCreatePayload` 是否"契约一致"** —— A 线 PASS 表判"字段与默认值全部对齐"，C 线 D-8 判"zod 把选填字段设为必填，比契约严"。**采信二者并存**：payload 构造层确实对齐（C 线自己也说"因 payload 恒带值，当前无线上影响"），zod schema 严格度确实高于契约。合并为 S-35（轻微），不构成阻塞。

**未采信任何一条线的原始严重度标签**——B 线的 BLOCKER、HIGH，A 线的阻塞/严重，D 线的 P0/P1，全部按本报告的四级定义重新判级，重分级处已在正文标注理由。

---

## 4. 修复路线

排序原则：**先解锁验证环境 → 再修链路上被打死的两端 → 修语义错误 → 修数据层约束（需契约裁决）→ 收尾**。依赖关系已在每阶段标出。

### Phase 0 — 解锁验证环境（不改业务代码，但阻塞后面每一阶段的验证）

没有这一步，36 条静态结论永远停在"未验证"，且**装好 vendor 后第一次跑 `composer test` 就会立刻打出 S-01 与 S-03**（B 线指出 `PolicyPersistenceTest.php` 里能抓出这两个 BLOCKER 的用例全都已经写好了，只是从未执行过）。

- 装 `server/vendor`（composer install），接真实 MySQL **≥ 8.0.16** 建库
- 先跑一次 `composer test`，把 `PolicyPersistenceTest` 从"写了"变成"绿了/红了"
- 真实 curl 走一遍 7 个端点并留存响应体
- 依赖：无。**阻塞 Phase 1-4 的全部验证环节**

### Phase 1 — 两条阻塞（互不依赖，可并行；必须在任何联调之前）

| 序 | 修什么 | 改哪些文件 |
| --- | --- | --- |
| 1.1 | **S-01** `insertConditions()` 内做显式白名单映射，与 `copy():328-344` 对齐；**不要**靠给表加 camelCase 列绕过（会同时撞 `schema.sql` 与 `metrics.md` 的字段映射表） | `server/src/Service/AlarmPolicyService.php:649-659`；可选替代：`ConditionValidator::validateOne()` 改返 snake_case + `Presenter` 负责反向映射。顺带补 `created_at`/`updated_at` 显式写入 |
| 1.2 | **S-02** 用 `form.useSelector(s => s.values)`（`@tanstack/vue-store`）替代 `computed(() => form.state.values)`；或把表单状态移出 vue-form 用 `reactive`/`ref` 自持。**一处修复同时消解 F-01/F-02/F-03 三个症状** | `web/src/pages/alarm/policy/components/policy-form.vue:223`（连带 `:425`、`:497`、`:725`、`:753`、`:757-758`） |
| 1.3 | **S-03** `MESSAGES` 改为按语义索引（`MESSAGES_BY_REASON[ErrorCode::POLICY_STATUS_CONFLICT]`），或让 `BusinessException::conflict()` 强制传显式文案；`AlarmExceptionHandler.php:78` 的 duplicate-key 分支直接用字面量 | `server/src/Constants/ErrorCode.php:19-41`、`BusinessException.php:27,50-53`、`AlarmExceptionHandler.php:78`、`AlarmPolicyService.php:262,542`、`AlarmConditionTemplateService.php:124`、`AlarmNotificationTemplateService.php:160` |

> 1.2 完成后**必须补组件挂载测试**——这是全绿基线放过 S-02 的唯一原因（策略页面 0 个 `mount` 测试，168 条相关单测全是纯函数/传输层断言）。

### Phase 2 — 后端语义修正（依赖 Phase 0 的验证环境；1.1 修完才能真正观察到效果）

| 序 | 修什么 | 改哪些文件 |
| --- | --- | --- |
| 2.1 | **S-07** 删掉 6 个 `up()` 首行的 `DROP TABLE IF EXISTS`（若需防御性 DROP，改为"表存在就抛异常"）；补 `SET FOREIGN_KEY_CHECKS=0/1` 与 `schema.sql` 对齐 | `server/migrations/2026_09_30_000{100..600}_*.php` |
| 2.2 | **S-04** 为 ⑥ 单独写 `assertStatusRequired()`（null → 记错 → 422），不复用 ③ 的默认值 helper；前端在 `setAlarmPolicyStatus` 前加本地非空断言 | `server/src/Service/AlarmPolicyService.php:505-516`、`AlarmPolicyController.php:62`；`web/src/services/api/alarm-policy.api.ts:136-141` |
| 2.3 | **S-09** `isDuplicateKey` 收窄到 `errno === 1062`，1452/3819/1048 各自映射并写日志 | `server/src/Exception/Handler/AlarmExceptionHandler.php:95-110` |
| 2.4 | **S-21** `assertThreshold` 补 `DECIMAL(20,4)` 量级校验 → 422 而非 500。**依赖 2.3**：否则 1264 会被 1.3 的分支吞成 500 | `server/src/Service/Validator/ConditionValidator.php:168-186` |
| 2.5 | **S-22** 条件级枚举改走严格整数校验，与 `Pagination::intParam` 同一套标准 | `server/src/Service/Validator/ConditionValidator.php:211` |
| 2.6 | **S-18** `copy()` 把副本名生成移入事务，或改为"捕获 1062 后重试下一个候选名"（契约要的是基于实际冲突的重试，不是预判） | `server/src/Service/AlarmPolicyService.php:300-302,536-543,574-577` |
| 2.7 | **S-10** `isValid()` 白名单为空时**拒绝**（401）而非放行；若确需联调便利，把开关显式化并默认关 | `server/src/Middleware/AuthMiddleware.php:50-55` |
| 2.8 | **S-16** `000700.down()` 改为按 `up()` 插入的精确 name 列表删除，并在同一事务内把命中这些 id 的 `condition_template_id` 重置为 0 | `server/migrations/2026_09_30_000700_seed_preset_templates.php:72-76` |

### Phase 3 — 前端复制链路与筛选（依赖 Phase 1.2 完成，否则改不动）

| 序 | 修什么 | 改哪些文件 |
| --- | --- | --- |
| 3.1 | **S-06** 复制改为调用契约 ⑦（`copyAlarmPolicy`），UI 走 `router.push` + toast 即可，删除手工 4 步复制路径；若保留手工路径，必须实现 `(2)..(99)` 重试。**依赖 1.3**：否则重复复制仍撞上错误文案的 409 | `web/src/services/api/alarm-policy.api.ts:150-154`、`web/src/pages/alarm/policy/index.vue:181-184`、`policy-form.vue:748-761`、`policy-logic.ts:119-126` |
| 3.2 | **S-05** 通知模板字典：区分"没加载到这一页"与"真不存在"；至少在确认页列出未加载的 id 并允许分页补齐。契约 `pageSize` 上限 100 是硬约束，不能靠调大页解决 | `web/src/pages/alarm/policy/components/policy-form.vue:321,678-684`、`policy-logic.ts:367-371` |
| 3.3 | **S-20** 确认页不得静默丢弃字典外的 id | `web/src/pages/alarm/policy/utils/policy-view.ts:116-133` |
| 3.4 | **S-19** `buildPolicyListQuery` 按 `ALARM_*` 成员过滤枚举；`projectId` 做整数/非负校验，空白串视为未传 | `web/src/pages/alarm/policy/utils/policy-logic.ts:556-597`、`components/policy-filters.vue:143-150` |
| 3.5 | **S-29/S-30/S-31** 交互健壮性：按行加锁或全行置灰、删除路径补函数内重入守卫、`ConfirmDialog` 成功后才关闭 | `web/src/pages/alarm/policy/index.vue:69,134-135,200-229`、`policy-columns.ts:116`、`web/src/components/confirm-dialog.vue:35-38` |
| 3.6 | **S-32** 删除 `callbackUrl` 幽灵字段（表单、schema、视图模型、payload 四处一起删） | `policy-form.vue:162,1436-1441`、`policy-logic.ts:620,710-741`、`policy.validator.ts:324-328`、`policy-view.ts:82,84,219-220,289-290,354` |

### Phase 4 — 数据层约束（**必须先拿到契约方的三个裁决**，否则 CHECK 写法会锁死业务）

**待裁决**：① §1.1 的 `monitorType` 3/4/5 是否允许落库（决定 S-14 的 CHECK 写法）；② `name`/`contact` 是否大小写敏感、是否入库前 TRIM（决定 S-26）；③ `condition_template_id` 的 `0` 哨兵是否改 `NULL`（决定 S-28）。

| 序 | 修什么 | 改哪些文件 |
| --- | --- | --- |
| 4.1 | **S-08** `schema.sql:10` 改成 `MySQL >= 8.0.16` 并内联一句"8.0.16 前 CHECK 被静默忽略"。**改 1 行，堵住一整类静默失效，全项目投入产出比最高** | `docs/alarm/schema.sql:10` |
| 4.2 | **S-13 / S-11 / S-14 / S-23 / S-24 / S-25** 补 CHECK：`JSON_TYPE(x)='ARRAY'` + 长度区间、`objectType ↔ 3 个 JSON 列` 对应、monitorType↔policyType 联动、删 `sort`/`level`/`frequency` 的 DEFAULT 或改写契约 §0.6 的安全承诺、`metric_*`/`contact` 非空、`alarm_history` 状态机主干 | `docs/alarm/schema.sql` + 7 个迁移（**两处必须同步改**：D 线已机械比对确认当前 0 差异） |
| 4.3 | **S-12** `notification_template_ids` 加数组类型+长度上限 CHECK；⑯ 的引用检查同时匹配 int 与 string 两种形态（或改用生成列 + 应用层强类型写入） | `docs/alarm/schema.sql`、`AlarmNotificationTemplateService.php` |
| 4.4 | **S-15** 决定 `level` 是继续冗余落库（则加触发器重算）还是读取时实时计算 | `docs/alarm/schema.sql`、迁移 |
| 4.5 | **S-27 / S-39** 补 `KEY idx_policy_created_id (created_at, id)`、删 4 条问题索引、在 `schema.sql` 里披露 2 处未记录的全表扫、修正 `:93-94` 的错误注释 | `docs/alarm/schema.sql` + 7 个迁移 |
| 4.6 | **S-38** 删掉 3 条恒真的 `remark_len` CHECK，或改成真正有增量的规则 | `docs/alarm/schema.sql` + 7 个迁移 |

### Phase 5 — 契约与文档收尾

| 修什么 | 改哪些文件 |
| --- | --- |
| **S-33** 补全 §2.8 内部列清单（含 `creator_id` ×3、`policy_id`），并把"45 − 4 = 41"改成可核对的表述 | `docs/alarm/contract.md:466-479` |
| **S-34** `keyword` 128 长度：后端加校验返回 422，或从契约说明列删掉这条软约束 | `AlarmPolicyService.php:71-80,663-670` 或 `contract.md` |
| **S-35** zod 选填字段加 `.optional()`，与契约对齐 | `policy.validator.ts:279-344` |
| **S-36** `Validator::add` 允许同字段多条错误 | `server/src/Support/Validator.php:93-100` |
| **S-37** 补 403 分支，或在契约里把 R7 明确标注为已知缺口 | `AuthMiddleware` 或 `contract.md` |
| **S-40/S-41/S-42/S-43/S-44** 陈旧注释、死代码分支、JSON 内枚举副本边界说明 | `AlarmExceptionHandler.php`、`AbstractController.php`、`AlarmEnum.php:49`、`schema.sql` 顶部注释 |

---

## 5. 覆盖边界与未覆盖项

以下内容**本次四条线都没有审到，或无法在当前环境验证**。这份清单与上面的 44 条同样重要——它标出了这份报告**不能用来做什么**。

1. **36 条静态结论零运行时验证。** 沙箱无 PHP、无 Composer、`server/vendor/` 不存在、无 MySQL、无 Redis。B/C/D 三线**没有执行过一行后端代码、没有执行过一条 DDL、没有启动过任何服务**，`php -l` 语法检查也做不了。**框架语义、DB 行为、异常链路全部未验证。** 尤其 S-01 的最后一环（Hyperf `Builder::insert()` 是否做键名转换）**因 vendor 缺失而无法读到源码**——"③/④ 必然 500"是推断，**"两条写路径对同一张表用了互斥的键名"是确认的**。
2. **没有真实浏览器。** S-02 等 8 条"已复现"是 `@vue/test-utils` + `happy-dom` 挂载真实 `.vue` 文件，属黑盒+白盒混合，**没有用 Chrome/Playwright 做过端到端点击**。S-30 的双击时序结论依赖这个区别（happy-dom 下能发 2 次、真实时序下只有 1 次），真实浏览器行为需另行确认。
3. **A 线的 toast mock 失效**（`vi.mock('vue-sonner')` 后 spy 未被捕获），因此**所有基于提示文案的结论都未被采信**；S-31 的判断依据是 DOM 与内部状态，不是提示文本。
4. **⑧–⑲ 端点的实现基本未审。** 19 条路由的 method+path 与契约逐条一致（已 PASS），但条件模板 CRUD（⑩⑪）、通知模板 CRUD（⑫⑬⑯）、告警历史列表（⑰）与处理（⑱）、首页统计（⑲）的**实现代码没有进入任何一条攻击线的审查范围**。S-25（history 状态机）、S-12（⑯ 引用保护）、S-27（⑰ 全表扫）是**从 DDL/契约侧发现的风险，不是从实现侧确认的缺陷**。
5. **S-12 的关键一环未实测**：`JSON_CONTAINS` 的类型严格性（`JSON_CONTAINS('["3"]', CAST(3 AS JSON))` 是否真的返回 0）是 MySQL 语义推断，D 线给出了 V12 命令但未执行。若这条不成立，S-12 降级为轻微（约束缺失仍在，击穿链断了）。
6. **`INSERT IGNORE` 遇 CHECK 违规的确切行为未知**（跳过该行 / 插入并告警），D 线标为 V13 未执行。这会影响 000700 seed 迁移在异常数据下是否"静默少插预置模板且仍返回成功"。
7. **索引结论全部基于 DDL 与查询参数推断**，没有 `EXPLAIN`、没有真实数据量、没有 `EXPLAIN ANALYZE`。S-27 的风险量级（append-only 表上的扫描成本）随实际数据量变化，可能远高于也可能远低于报告的估计。
8. **并发相关结论（S-18 TOCTOU、S-01 的并发删除路径）从未实际并发压测**，全部是代码顺序推理。
9. **被剔除的"条件条数下界"已转为测试覆盖要求**：不变量由 `ConditionValidator.php:51-57` 与前端 zod 双重保证，但**创建 / PUT / 复制三条写路径各验一次"落库后条件数 ∈ [1,4] 且 sort 连续"的端到端测试并不存在**。这是本次审查识别出的最大测试缺口。
10. **四条线都没有做性能压测、容量规划、告警引擎侧（触发/去重/通知投递）的任何审查。** 告警引擎被完全排除在本次范围外。
11. **契约方的意图未求证**：S-33（§2.8 的"45 组"口径）、S-14（monitorType 3/4/5 是否允许落库）、S-26（name/contact 大小写与 TRIM 语义）、S-28（`condition_template_id` 哨兵值是否改 NULL）四处都涉及"作者本意是什么"，本次只核对了代码与文档**说了什么**，没有核对**想说什么**。S-14 与 S-28 在裁决前不应直接落地 CHECK/FK。
12. **未做跨端一致性的运行时验证**：S-03 修正后，4 条线推断的 409 文案是否真的对上了用户的直觉，只能靠真实联调确认。

---

## 6. 最终判定

> # VERDICT: FAIL

| 项 | 值 |
| --- | --- |
| 合并后缺陷总数 | **44** |
| **已实测复现** | **8** |
| **仅静态推断** | **36** |
| 阻塞 / 严重 / 中等 / 轻微 | **2 / 8 / 18 / 16** |
| 上线前必须清零 | **2**（S-01、S-02） |
| 建议同批清零 | **8** 严重项（Phase 1.3 + Phase 2） |
| 项目文件改动 | 无（`web/` 告警模块 + `docs/` 已证明；`server/` 无基线，见 §2.5） |

**判定**：合并后仍为 **FAIL**。四条线**没有一条报告 PASS**，且两条阻塞级缺陷分处链路两端、互相独立——后端 `insertConditions()` 键名互斥导致 ③/④ 全 500，前端 `values` computed 冻结导致向导 0 请求。**当前既无法通过 API、也无法通过 UI 创建任何一条告警策略**，基线的 lint / 424 条单测 / 类型检查 / 构建全绿只证明类型与纯函数自洽，不构成功能可用的证据。

**放行条件**（按此顺序，Phase 0 不可跳过）：
1. S-01 修复 + 在装好 `server/vendor` 的环境里 `composer test` 转绿 → 证明 ③/④ 真的能落库；
2. S-02 修复 + **补上策略页面的组件挂载测试**（当前为 0，这是全绿基线放过它的唯一原因）→ 证明向导能走完 4 步并发出请求；
3. 两条都通过后重跑 A 线的 8 条已复现用例，确认 F-01/02/03 三个症状同时消失。

---

## 7. 修订记录

按编辑精度门禁的 4 条意见定点修订，**未重做报告**。门禁明确不动的部分（2/8/18/16 分级与理由、已复现 8 / 仅静态 36 两个计数、§3.2 剔除记录、§3.3 三处矛盾裁决、§5 的 12 条覆盖边界、Phase 0–4 修复路线）保持原样。

| # | 门禁意见 | 改了什么 | 位置 |
| --- | --- | --- | --- |
| 1 | 去重计数自相矛盾（标题/表格行数/正文三处不一致） | 删除不可信的「51 → 44」精确对账，改为结构化口径：**11 个合并组**（消解 13 条输入：2 组 3→1、9 组 2→1）+ **1 行显式声明不合并的拆分**（2 进 2 出，不消解条数）。表格 12 行 = 11 + 1，三处口径与 §3 统计表的 44 对齐 | §3.1 全节、§0 判定表、§1 结论 |
| 2 | S-07 与 S-17 职责重叠 | 选**「保留两条、有意拆分」**方案（保住门禁要求不改的 44 与 2/8/18/16）。已把 `FOREIGN_KEY_CHECKS` / errno 3730 / 失败模式不对称三个子句从 S-07 剥离到 S-17：S-07 只讲「重跑即清表」，S-17 只讲「无 FK 包裹导致报错与不可自愈」，两行均加「与另一条互不重叠/有意拆分」标注 | §2.2 的 S-07、S-17 行；§3.1 对应两行 |
| 3 | S-31 表述不准确 | 回代码重读三处实际控制流（`policy/index.vue:209-213` 失败分支、`confirm-dialog.vue:37-40` 无条件关闭、`index.vue:298/303` 的 `:open` 与 `@update:open`），改写为「**`confirmDelete` 失败分支缺少清理**」。同时**撤回我原先的错误说法**：`:216` 的 `deleteTarget.value = null` 并非死代码，它在成功路径上照常执行（只是相对 `@update:open` 的置空属冗余） | §2.4 的 S-31 行 |
| 4 | 只读声明需 substantiate or scope | 新增 §2.5，贴出实际命令与输出：`web/` 的 `git status --short`（审查范围 `src/pages/alarm`+`src/services` 输出为空）、`docs/` 全部 mtime ≤ 2026-09-30、`server/` 的 mtime 核对。**收窄后的准确边界**（owner 复核并二次换算时间戳后确认）：`server/` 非 git 仓库、无基线可 diff，69 个 PHP 文件中有 **2 个**（`Presenter.php` 09:36:30 UTC、`AlarmEnum.php` 09:35:13 UTC）的 mtime **晚于审查起点 09:06:42 UTC，落在审查窗口内**，来源无法确定；其余 67 个 mtime 均早于审查起点。可证明未改动的范围是 `web/` 告警模块与 `docs/`；`server/` 侧只有"本次汇总未写入"的自我保证，**无外部证据**。另注明 S-01 的结论不依赖这两个文件（`Presenter::condition()` 是 snake→camel 读路径，`insertConditions()` 是 camel→snake 写路径，方向不同，owner 已直接回读当前内容确认该映射存在） | §2.5（新增）、报告开头声明、§0 与 §6 判定表 |

> **口径声明（避免误读）**：本报告 §0 与 §6 的 `VERDICT: FAIL` 是**被审查对象（告警策略模块）的判定**，本次不因门禁返工而改变；文末的 `VERDICT: PASS` 是**本次编辑精度修订自身**的交付校验位。两者含义不同，请勿混读。

VERDICT: PASS

---

## 8. Owner 二次复核（owner 直写，非审查线产出）

门禁在第 5 轮指出：汇总对只读声明的时间推理有误。owner 独立换算时间戳后**确认门禁正确、汇总错误**，已就地修正 §7。记录如下：

| 事件 | UTC | 本地（UTC+8） |
| --- | --- | --- |
| 审查计划启动 | 09:06:42 | 17:06:42 |
| 第一份产出（audit-frontend.md） | 09:27:37 | 17:27:37 |
| `AlarmEnum.php` 被写 | 09:35:13 | 17:35:13 |
| `Presenter.php` 被写 | 09:36:30 | 17:36:30 |

**原错误**：汇总把「owner 会话起点 09:43:51 UTC」误当作「审查起点」，据此写下「2 个文件早于本会话开始」。实际审查起点是 09:06:42 UTC，这两个文件**晚于审查起点约 29–30 分钟，明确落在审查窗口内**。

**owner 的独立处置**：
1. 直接回读 `Presenter.php::condition()`（第 70–86 行），确认 snake→camel 逐字段映射确实存在于当前文件，风格一致、无编辑痕迹、无残留 diff 标记。
2. 但**无法证明其内容与审查前一致**——`server/` 非 git 仓库、无基线、无备份快照，无法 diff。
3. 因此 §2.5 证据 C 的实质表述（「落在审查窗口内，来源无法确定」）是准确的，**只有 §7 的压缩表述误导，已改**。

**对结论的影响评估：S-01 不受影响。** `Presenter::condition()` 是 snake→camel 的**读**路径映射，`insertConditions()` 是 camel→snake 的**写**路径映射，两者方向不同、各自独立。S-01 的成立依据是「同一张表的另一条写路径 `copy():328-344` 也做了显式映射，唯独 `insertConditions()` 没有」——该依据位于 `AlarmPolicyService.php`，其 mtime 为 2026-09-30，**早于审查起点，可证未被审查触碰**。

**残留的、owner 无法关闭的缺口**：`server/` 侧有 2 个文件在审查窗口内被写过、来源不明、内容不可比对。若需要「本次审查未修改任何后端文件」的强保证，事后无法补证——只能在下一次审查前先建立基线（`git init` 或 checksum 快照）。

VERDICT: PASS

---

## 9. 两条阻塞的修复记录（owner 直做）

于 2026-10-03 修复 S-01 与 S-02，并为 S-02 补上此前完全缺失的组件挂载测试。

### S-01 — `insertConditions()` 驼峰键写入下划线表

**根因**：`ConditionValidator` 按契约 §2.1 返回 camelCase（`metricNamespace` / `metricName` / `metricNameCn`），
而 `AlarmPolicyCondition::$fillable` 与 `alarm_policy_condition` 表列全是 snake_case。原实现
`array_merge(['policy_id' => $id], $condition)` 把驼峰键原样交给 `Builder::insert()`。

**修复**：改为**显式白名单映射**，与同表另一条写路径 `copy():328-344` 使用同一套映射。
用白名单而非 `foreach` 遍历：即使 validator 将来多返回一个键，也不会被静默写进 INSERT。
同时补上显式 `created_at` / `updated_at`（`$now` 在循环外取一次，与 `copy()` 一致）。

改动：`server/src/Service/AlarmPolicyService.php`

**验证状态：⚠️ 仅静态。** 沙箱无 PHP / Composer / MySQL，无法执行该路径。修复的正确性依据是
「映射后的键名与 `$fillable` 及表列逐一对应」这一静态核对，**未经运行时确认**。
装好环境后应优先验证：POST /policies 与 PUT /policies/{id} 能否成功落库，
且 `SELECT metric_namespace, metric_name, metric_name_cn FROM alarm_policy_condition` 有值。

### S-02 — 策略表单响应式断裂

**根因**：`policy-form.vue` 用 `computed(() => form.state.values)` 读取表单值。
`FormApi` 的 `get state()` 是普通 getter，`@tanstack/form-core` 的 dist/esm/FormApi.js 中
`from 'vue'` 出现 **0 次** —— 该 getter 求值时不建立任何 Vue 响应式依赖，
computed 只算一次并永久缓存。

**关键细节（解释了为什么 424 个测试全绿）**：直接读 `values.value` **看起来是正常的**——
store 原地修改同一对象引用，computed 缓存的引用照样能看到新值。断掉的只有
`watch` 与所有派生 `computed`。实测对照：

```
旧写法 watch(values) 命中次数 = 0
新写法 watch(values) 命中次数 = 1
```

**修复**：改用 `@tanstack/vue-form` 挂在 `form` 上的 `useSelector`（内部走
`@tanstack/vue-store` 的 `useSelector(api.store, selector)`，真正建立依赖）。

改动：`web/src/pages/alarm/policy/components/policy-form.vue`

### 补测试：策略页面的第一个组件挂载测试

本次审查最大的测试缺口是**策略相关 168 条测试中组件挂载数为 0**。
新增 `web/src/pages/alarm/policy/__tests__/policy-form.mount.test.ts`（3 个用例）：

1. 未填名称时第 1 步校验应拦住 —— 防止把「永远不放行」误当成修复
2. `currentValues()` 必须反映 `setValue` 之后的值 —— 核心回归断言
3. 填入合法表单后点「下一步」能推进到第 2 步 —— 用户可见症状的回归

**测试有效性已验证（带牙齿）**：临时把修复回退为 `computed(() => form.state.values)` 后，
3 个用例中 **2 个失败**（用例 1 仍通过，因为「不放行」在 bug 与修复下表现相同）；
恢复修复后 3 个全过。

> 用例 1 在两种情况下都通过不是缺陷：它防的是另一类错误——把「校验永远失败」误当成修好了。
> 真正有判别力的是用例 2 和 3。

**实现说明**：用例用 per-file `// @vitest-environment happy-dom` docblock 指定 DOM 环境，
不改 `vite.config.ts` 的全局 `test` 配置，避免牵连 424 个纯函数测试。
`monitorType` / `policyType` 走组件自身的 `setValue` 写入入口而非驱动 shadcn Select
（Radix 弹层在测试里极脆），而 `setValue` 恰是 S-02 断掉那条链路的起点。

### 修复后的基线（全部真实执行）

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm lint` | **0** | — |
| `pnpm test:run` | **0** | 22 个测试文件（原 21），全部通过 |
| `pnpm exec vue-tsc -b --force` | **0** | — |
| `pnpm build` | **0** | — |

### 本次修复**没有**覆盖的范围

- **S-01 未做运行时验证。** 后端整体仍未运行过（沙箱无 PHP/Composer/MySQL）。
- **S-05、S-06 未修**：通知模板字典分页截断、契约 ⑦ copy 端点未被调用。
  S-06 的症状里有「复制名恒为『 - 副本』」这一条，**其根因是 S-02**，
  随 S-02 修复后 `buildCopyName` 能拿到真实源名了；但「UI 不走契约 ⑦」这个设计分歧仍在。
- **S-03 及其余 41 条未动。** 本次严格限定在两条阻塞 + 一条回归测试。
- 本次未运行任何后端代码、迁移或测试；未修改 `docs/` 与 `schema.sql`。

VERDICT: PASS

---

## 10. 第二批修复：S-03 / S-04 / S-10（owner 直做）

### S-03 — 409 的 5 条文案塌缩成 1 条

**根因**：`ErrorCode` 的 5 个语义常量求值都是 409，被用作 `MESSAGES` 数组的键。
PHP 数组字面量中同值键后写覆盖先写，最终只剩 `HISTORY_ALREADY_HANDLED` 的文案存活：

```
修复前：键数量 1，message(409) = "该告警已处理，不可重复处理"
→ 删除一个启用中的策略，运维看到的提示是「该告警已处理」
```

**修复**：`MESSAGES` 只保留数值唯一的码（0/401/403/404/422/500）；409 的文案改由
`REASON_MESSAGES` 按**语义分支**索引。新增 `REASON_*` 语义常量、
`messageForReason()` / `codeForReason()`。`BusinessException::conflict()` 的首参
由 `int $code` 改为 `string $reason`，6 个抛出点全部改为传语义标识。

**决定性旁证**：仓库里**早已存在** `AlarmRuleTest::testConflictCodesShareCodeWithDistinctMessages`，
断言「5 个 409 分支的 message 必须各不相同」——它**在旧实现下必然失败**，
但因 `server/vendor` 缺失、PHPUnit 无法启动，从未被执行。
同时 `PolicyPersistenceTest.php:110` 断言的正是「已启用的策略不可删除，请先停用」，
这行在旧实现下也必然失败。**两个测试都写对了，只是从没跑过。**

修复后：5 条文案 distinct，5 个分支上线码全为 409，两处测试期望值均命中。

**额外加固**：`BusinessException::__construct` 在 `bizCode === 409 && $message === null`
时抛 `LogicException`。漏传文案时**当场报错**，而不是静默发出兜底错误文案。

顺带修正：2 处 `new BusinessException(ErrorCode::TEMPLATE_IN_USE, ...)` 原本绕过
`conflict()` 直连构造器，改 API 后会把字符串传给 `int $bizCode` 触发 TypeError，
已一并改为走 `conflict()`。

### S-04 — 启停接口静默把线上策略停用

**根因**：`assertStatus()` 对 `null` / `''` 直接 `return 0`（契约允许创建时缺省为 0），
而 `changeStatus()` **复用了同一个方法**。于是 `POST /policies/{id}/status` 传 `{}`
或坏 JSON（`AbstractController::body()` 把坏 JSON 解成 `[]` → `null`）时，
**静默按 0 处理、把线上策略停掉、返回 200**。契约 §3.1 ⑥ 明确 `status` 必填。

**修复**：`assertStatus()` 增加 `bool $required = false`；`changeStatus()` 传 `true`，
缺省/空串时记 422 错误。创建/更新路径行为不变（仍缺省为 0）。

### S-10 — 鉴权中间件 fail-open

**根因**：`AuthMiddleware::isValid()` 在 `ALARM_STATIC_TOKENS` 为空时 `return true`。
**漏配一个环境变量 = 全部告警接口无鉴权**，且没有任何错误信号。

**修复**：改为 **fail-closed** —— 白名单未配置时拒绝所有请求（401）并打 `error` 日志，
日志文案直接告知正确配置方式。保留一个**显式**的本地联调开关 `ALARM_AUTH_DISABLED=true`，
它必须被主动设置，不会因「忘配白名单」而意外生效；开启时打 `warning` 日志。
同步更新 `README.md` 与 `.env.example`（原来都写着「留空 = 不校验」）。

#### ⚠️ S-10 修复暴露出的集成缺口（审查未覆盖）

改成 fail-closed 后，**前端必须真的发 `Authorization` 头**，否则连真实后端一律 401。
核查发现：**前端此前从未发送过这个头** —— 契约 §0.1 要求、模板自带的假登录 store 里也没有 token。
也就是说 S-10 的修复会**暴露一个此前被 fail-open 掩盖的缺口**。

补齐（前端）：

- `VITE_SERVER_API_TOKEN` 加入 env schema、`FALLBACK_ENV` 与 `app-config` 导出 `API_TOKEN`
- `api-client` 的 `onRequest` 在 token 非空时用标准 `Headers` API 追加 `Authorization`
- **未配置时不发该头** —— 让 401 暴露出来，而不是静默发一个空 token
- 新增 `api-client.auth.test.ts`（3 用例）锁住：带 token 时发头、不带时不发、
  不覆盖调用方自定义头

### 本批的验证状态

| 项 | 状态 |
| --- | --- |
| 前端 lint / vue-tsc / test:run / build | ✅ 全部 0，23 个测试文件（新增 1 个 auth 测试文件） |
| 后端 PHP 结构（括号平衡、strict_types、`<?php` 唯一） | ✅ 全部 69+ 个文件通过启发式检查 |
| **后端运行时** | ❌ **仍未验证**。沙箱无 PHP / Composer / MySQL，一行后端代码都没执行过 |
| 409 文案塌缩的修复正确性 | ⚠️ 用 JS 精确模拟 PHP 数组键覆盖语义验证（5/5 distinct），**非 PHP 实跑** |

### 本批**没有**覆盖的范围

S-07 / S-17（迁移无条件 DROP TABLE、无 FK 包裹）、S-05、S-06、S-09（`isDuplicateKey`
把整个 SQLSTATE 23xxx 当重名）及其余 35 条**均未触碰**。

VERDICT: PASS

---

## 11. 第三批修复：S-07 / S-17（+ 顺带 S-08）

### S-07 — 重跑迁移静默清空整表

**根因**：6 个建表迁移的 `up()` 首行是 `Db::statement('DROP TABLE IF EXISTS ...')`，
紧接着才 `CREATE TABLE`。首次部署没问题；**重跑就是推倒重建**。
`alarm_history` 尤其荒唐——`schema.sql` 里明写"永不删除"，
而 `000600` 的 `up()` 第 27 行就把它 drop 掉。

失败模式还不对称，这让它更危险：

| 重跑对象 | 结果 |
| --- | --- |
| 父表 `000100` / `000400` | 撞 FK 报错**中止** —— 响亮失败，相对安全 |
| 子表 / 独立表 `000200/000300/000500/000600` | **静默清表** —— 走 S-07，安静地丢数据 |

**修复**：`DROP + CREATE` → `CREATE TABLE IF NOT EXISTS`。
首次部署行为完全不变，重跑变成 no-op。

⚠️ **代价必须说清楚**：`IF NOT EXISTS` 在"表已存在但结构不符"时**静默跳过**，
schema 漂移变得不可见。这是把"数据丢失"换成了"变更无声"——
在本项目当前阶段（迁移按日期编号、改结构就新建文件）这个交换是划算的，
但它不是免费的。已在每个迁移的 docblock 里写明「改结构必须新建迁移文件」。

### S-17 — 迁移不设外键开关，失败后不可自愈

**根因**：7 个迁移全程不设 `SET FOREIGN_KEY_CHECKS`（`schema.sql:54` 有）。
完全依赖文件序号保证父表先建。一旦某轮中途失败留下残留子表，
后续重跑 errno 3730，整套迁移**卡死且无自愈路径**。

**修复**：`up()` / `down()` 都用 `try/finally` 包裹开关。

`down()` 一开始没包，docblock 写了"up()/down() 都被包裹"——**这是不准确的**，
写完自查时发现并补上了。补的理由不是对齐措辞：`migrate:rollback` 整批回滚时
按 batch 逆序执行，子表先于父表，确实不撞；但 `--step=1` **单步回滚 000100** 时，
000200 还带着 FK 活着 → 照样 errno 3730。

`finally` 不是保险起见。`SET FOREIGN_KEY_CHECKS` 是**会话级**的：
建表抛异常时不恢复，连接池会把这条"外键检查已关闭"的 session 交给下一个请求，
**下一个请求会在毫无日志的情况下失去外键保护**。那比本 bug 更隐蔽，因为它不报错。

### S-08 — schema.sql 声明的最低版本写错（顺带修）

`schema.sql:10` 写 `MySQL >= 8.0.13`。8.0.16 以下 MySQL 对 CHECK **只解析不执行**，
29 条约束静默失效且不报错。而 `README.md` 整节在论证必须 8.0.16，`.env.example` 也写对了——
**全仓唯一写错的那份，恰是运维唯一会主动打开的那份**。

在给 `schema.sql` 加"推倒重建脚本 vs 迁移"的语义说明时顺手改的，同一个 header 相邻两行。

### schema.sql 的 DROP 是故意的，没动

`schema.sql` 里的 `DROP TABLE IF EXISTS` + `CREATE TABLE` **语义不同**：那是运维手动执行的
"删干净重来"脚本，执行前必须确认库内无数据需保留。已在其 header 写明
「这是推倒重建脚本，迁移走相反策略，两者语义不同，请勿统一风格」——
防止以后有人看到不一致就"顺手改齐"，那才是真事故。

### 回归测试

新增 `server/test/Cases/Unit/MigrationSafetyTest.php`（5 组用例 × 6 个迁移 = 30 断言组）：

- `up()` 代码行不得含 `DROP TABLE`（**剥离 `//` 注释后再查**——否则注释里引用的原实现会假阳性）
- `up()` 必须含 `CREATE TABLE IF NOT EXISTS`
- `up()` / `down()` 的 `FOREIGN_KEY_CHECKS = 1` 必须落在 **`finally` 内**（正则匹配 `finally {...}`）
- `schema.sql` 必须声明 `>= 8.0.16`，且不得出现 `8.0.10`~`8.0.15`

**PHPUnit 仍未运行**（无 PHP）。为确认测试不是空转，另写了 Node 等价实现
`scripts/verify-migration-safety.mjs` 做三段验证：

| | 结果 |
| --- | --- |
| 修复后 | ✓ 全过 |
| 逐条回滚 S-07 / S-17 / S-08 | ✗ **26 条断言失败**（6 迁移 × 4 条 + schema 2 条） |
| 恢复修复 | ✓ 全过 |

⚠️ Node 实现只能证明**断言逻辑能区分修好与没修**，不能替代 PHPUnit 在真实 PHP 下的执行。

### 本批验证状态

| 项 | 状态 |
| --- | --- |
| 6 个迁移结构（括号/`<?php`/声明） | ✓ 62 个 PHP 文件通过启发式检查 |
| `up()`/`down()` 幂等性与 FK 包裹断言 | ✓ Node 等价实现全过 |
| 回归测试有牙齿 | ✓ 回滚后 26 条断言变红 |
| **迁移真实执行** | ❌ **无 MySQL，一次都没跑过** |
| **PHPUnit** | ❌ 无 PHP |

### 压后的条目

**S-09**（`isDuplicateKey()` 把整个 SQLSTATE `23xxx` 当重名）**本轮刻意未动**：
它要改的 `AlarmExceptionHandler.php:101` 正被本轮对抗式复核逐行分析
（复核任务里明确点名了 `:78` 与 duplicate-key 分支）。中途改会让行号引用与结论失效。
等复核出结论后再一并处理。

---

## 12. 第四批：对抗式复核的收口（owner 直做）

两条复核线均已交付：`attack-backend.md`（28 条攻击，**VERDICT: FAIL**）、
`attack-frontend.md`（26 个探针，**VERDICT: PASS**）。

### 12.1 复核的核心结论

**我改的 5 条修复，其代码逻辑一条都没被攻破。** 54 个攻击/探针全部失败，
包括几条我以为会挂的：

* `status: 0` 会不会被当缺省 —— 用的是 `===` 严格比较，写对了
  （若写成 `==` 或 `if (!$raw)`，「停用」这个最基本的操作直接不可用）
* `metric_name_cn` 拼写 —— DDL / 白名单 / `$fillable` / Presenter / `copy()`
  五处 Unicode 码位逐个比对，全部一致
* `filter_var(..., FILTER_VALIDATE_BOOLEAN)` 传空串 / 拼错值 —— 返回 false，
  方向是 fail-secure
* `onRequest` 是否真被 ofetch 调用 —— 抓包确认真落到网线，且不丢调用方请求头

**被攻破的是修复周围的事**，其中 **2 条是我自己这轮引入的**。

### 12.2 已修：D-4 —— 我亲手拆掉了自己的 fail-closed

`server/.env.example` 里写了 `ALARM_STATIC_TOKENS=dev-token-1,dev-token-2`，
而 `composer.json` 的 `post-root-package-install` 是
`file_exists('.env') || copy('.env.example', '.env')`。

**新建项目的人什么都不用配，就获得了一个全仓库公开可读的 token。**
我亲手把「漏配 = 无鉴权」换成了「用公开凭据的有鉴权」，且这条路径一声不吭。

已修：`.env.example` 置空 + 说明为什么必须留空；README 改为「自己生成一个」
并加了 fail-closed 的验证步骤；全仓已无任何预填 token。

### 12.3 已修：C-5 / D-6 —— 我改的行为零测试

* **S-04** 改的是「缺 status 静默停用线上策略」，而 `PolicyPersistenceTest`
  的 5 处 `changeStatus` **全传 0/1，没有一条传过 null / ''**
* **S-10** 改的是**全部 19 个端点**的鉴权语义，后端 `test/` 下**零条**测试

新增 3 个测试文件、20 个用例（含 2 个端到端 Feature 用例）：

| 文件 | 用例 | 关键点 |
| --- | --- | --- |
| `AuthMiddlewareTest` | 9 | 白名单空/纯空白拒绝、条目 trim、`ALARM_AUTH_DISABLED` 显式放行、**拼错开关名必须保持 fail-secure**、示例 env 不得带凭据 |
| `PolicyStatusValidationTest` | 9 | 反射测 `assertStatus()`，**不需要 MySQL**，把 `$required` 完整矩阵钉死（含 `status: 0`） |
| `IntegrityViolationMappingTest` | 10 | 下面的 S-09 分类表 + 「拼错 reason 当场报错」 |

测试方法数 **109 → 146**。

### 12.4 已修：S-09 —— 整个 SQLSTATE 23 类被当成「重名」

**根因**：`isDuplicateKey()` 是 `str_starts_with($state, '23')`。
SQLSTATE `23xxx` 是整类「完整性约束违反」，里面塞着四件完全不同的事。

确定性触发路径：`AlarmConditionTemplateService::create()` 与
`AlarmNotificationTemplateService::create()` **都不做 name 预检**，
唯一性完全靠 DDL 唯一键 → 提交一个已存在的**模板名** → 1062 →
用户收到「**策略**名称已存在」。用户建的是条件模板，被告知策略重名。

**⚠️ 比原报告更关键的一点**：MySQL 把 `1062`(重名) / `1451` / `1452`(外键) /
`1048`(非空) **全部映射到同一个 SQLSTATE `23000`**。
SQLSTATE 在这里**零区分度**，必须按驱动错误码判。

修复后的分类（`classifyIntegrityViolation()`）：

| errno | 场景 | 结果 |
| --- | --- | --- |
| 1062 / `23505` | 唯一键冲突 | 409 策略名称已存在 |
| 1451 / 1452 / `23503` | 外键 | 409 **关联数据已变更，请刷新后重试**（新增第 6 个 reason） |
| 3819 / 1048 / 1264 / 1406 / … | CHECK / 非空 / 越界 / 超长 | **422**（附 `extra.errors`） |
| 1064 / 1146 / 2006 | SQL 写错 / 表不存在 / 连接断开 | **500**（不甩给用户） |

#### 分类表不是一次写对的 —— 验证脚本当场抓住我的 bug

首版写的兜底是 `$errno >= 1000`（范围判断），验证脚本立刻报出 2 条误判：
`1146 ER_NO_SUCH_TABLE`（迁移没跑）和 `2006 CR_SERVER_GONE_ERROR`（连接断开）
被扫成了 422 —— **把部署问题和基础设施故障报成「参数校验失败」，运维会查错方向**。

改成 **13 个 errno 的显式白名单**（`PAYLOAD_REJECTED_ERRNOS`），
并在测试里加了「服务器自己的问题必须留在 500」这一组**反回归**用例。

验证结果（`scripts/verify-s09-classify.mjs`，15 例 MySQL 8.0 真实 errno/SQLSTATE 对）：

```
新实现: 15 通过 / 0 失败
旧实现: 10 例判错（同一批输入）
```

顺带把 A-6 解了：`threshold: 1e16` 溢出 `DECIMAL(20,4)` 触发 `1264`，
旧路径落到 500，**现在归 422** —— 那条原本是 POST/PUT 唯一的 500 来源。

### 12.5 已修：B-7 —— 我这个守卫修在了错误的层

`BusinessException` 构造器里的 `LogicException` 守卫只能拦「传了 409 却没传文案」。
但**分支名拼错**（`'POLICY_STATUS_CONFIC'`）时，`codeForReason()` 会走
`?? INTERNAL_ERROR` 兜底 → bizCode 已经是 500 → **守卫根本不触发**，
用户静默收到 500，开发者什么都看不到。

改到正确的层：`conflict()` 入口校验分支名属于 `ErrorCode::knownReasons()`，
拼错当场抛 `LogicException` 并附上全部已知分支。

### 12.6 已修：前端复核的两条 LOW（测试卫生）

* **A-2a**：`policy-form.mount.test.ts` 没 mock `alarm-policy.api`，
  跑测时产生 **60 次真实 `localhost:3000` 连接失败** —— 非 hermetic，
  这台机器上碰巧有 3000 端口服务时行为还会变
* **A-2b**：mock 漏了 `success: true`，组件实际走 `toast.error` 分支，
  字典恒为空 —— **测试「通过」但测的不是组件真实行为**
* **E-1a**：`form.useSelector(...) as Ref<>` 洗掉了返回值上的 `Readonly`。
  当前 0 处赋值不是缺陷，但 cast 说谎会让将来写 `values.value = x` 的人
  以为合法、实际静默失效 → 改成 `as Readonly<Ref<>>`

### 12.7 未处理：G-4 需要部署方决策

前端复核 PASS，但附了一个**有分量的条件**：仓库里**三个已提交 env 的
`VITE_SERVER_API_TOKEN` 全是空的**（`.env` / `.env.example` / `.env.demo`）。
所以 S-10 的鉴权机制虽然交付了，**在所有已提交配置下都是空转** ——
接真实后端会全线 401 → `handleUnauthorized` 把用户踢回登录页。

这不是代码缺陷，是配置缺口。**且这是设计使然**：`VITE_*` 是**构建期常量**，
静态 bearer token 会被打进前端产物，任何能加载页面的人都能从 bundle 里读到。
这不是本次改动的属性，是「浏览器端静态 token」这一方案本身的属性，但必须知情。

**接入真实后端前必须由部署方配**（我不会往仓库里塞一个可用凭据 ——
那正是 D-4 让我改掉的东西）。

### 12.8 本批验证状态

| 项 | 状态 |
| --- | --- |
| 后端 65 个 PHP 文件结构 | ✅ 通过启发式检查 |
| S-09 分类逻辑 | ✅ 15/15（旧实现 10 例判错） |
| 迁移幂等性断言 | ✅ 通过 |
| 前端四项基线 | ⚠️ 见 §12.9 |
| **PHPUnit** | ❌ 无 PHP，146 个用例**一次都没跑过** |
| **真实 MySQL / 端到端联调** | ❌ 未验证 |

### 12.9 收口前仍必须补的证据

1. `php -r` 验证 `StdoutLoggerInterface` 能否从容器解析（复核 D-5 存疑项：
   中间件依赖从「出错时才解析」变成「第一个请求就解析」，失败面从 500 扩大到全站 500）
2. `composer test` + `SELECT metric_namespace, metric_name, metric_name_cn, threshold FROM alarm_policy_condition` 的真实输出
3. 空白名单返回 401；5+1 个 409 场景分别返回正确文案；`threshold=1e16` 返回 422
4. 端到端：前端向导走完 → POST /policies 200 → GET /policies/{id} 能读回三个 metric 字段
5. `information_schema.CHECK_CONSTRAINTS` 确认 29 条 CHECK

VERDICT: PASS

---

## 13. 【阻塞】env() 没有数据源 —— 我的 fail-closed 把服务锁死了

### 13.1 这是本轮最严重的一条

汇总阶段（第三条复核线）挖出**两条攻击线都没抓到**的缺陷。我已独立复核确认：

```
$ grep -rn "Dotenv\|createUnsafeImmutable" --include="*.php" --include="*.json" server/
  零处命中
$ grep -n "dotenv" server/composer.json
  无
$ ls server/config/bootstrap.php
  不存在（README 的结构图里却声称存在）
```

`Hyperf\Support\env()` 读的是 `$_ENV` / `$_SERVER`，**它自己不解析 .env**。
把 .env 灌进这两个超全局变量的是 `Dotenv\Dotenv`，而**全仓唯一的调用点本该是
`config/bootstrap.php`——它不存在**。

### 13.2 后果：全部 19 个端点永久 401，且无逃生舱

| 表达式 | 实际返回值 | 原因 |
| --- | --- | --- |
| `env('ALARM_STATIC_TOKENS', '')` | **恒为 `''`** | 没有数据源，只能拿默认 |
| `env('ALARM_AUTH_DISABLED', false)` | **恒为 `false`** | 同上 |
| `env('ALARM_CURRENT_USER', 'system')` | 恒为默认值 | 同上 |
| `env('DB_HOST' / 'DB_DATABASE' / …)` | 恒为默认值 | 同上 |

配合 S-10 的 fail-closed：

```
白名单恒空  →  isValid() 恒 false  →  19 个端点全部 401
逃生舱也读不到（ALARM_AUTH_DISABLED 恒 false）  →  没有任何配置能绕过
```

**必须说清楚责任归属**：S-10 之前的 fail-open 在这个仓库里**恰好是能用的** ——
白名单读不到 → `$allow === ''` → `return true` → 放行。
不安全，但服务是通的。

我的 fail-closed 修复把它变成了「白名单读不到 → 拒绝 → 永远拒绝」。
**修复本身的方向没错（fail-closed 才是对的），但它把一个原本被 fail-open 掩盖的
配置缺陷从「静默不安全」升级成了「服务完全不可用」。**

这是本轮**唯一一个由我的修复直接放大的阻塞级后果**，必须明确记在账上。

### 13.3 修复

1. `composer.json` 增加 `"hyperf/dotenv": "^3.2"`
2. 新建 `config/bootstrap.php`：调用 `Dotenv::createUnsafeImmutable(BASE_PATH)->safeLoad()`，
   并设置 `date_default_timezone_set('Asia/Shanghai')`（与 `test/bootstrap.php` 对齐，
   避免测试与运行时区不同导致断言漂移）
3. `test/bootstrap.php` 增加 `require BASE_PATH . '/config/bootstrap.php'`
4. 新增 `EnvBootstrapTest`（5 个源码级断言，不需要 PHP 运行也不需要 .env 存在）

#### 为什么用 `createUnsafeImmutable`

* **Unsafe**（`.env` 覆盖已有进程变量）：容器编排注入的变量优先级**高于** `.env`，
  这正是我们要的 —— 部署环境不该被仓库里的文件绑架。
* **Immutable**（进程变量覆盖 `.env`）：会让仓库文件反过来控制线上配置，方向反了。

另加一道双重保险：`$_ENV` 已载入时跳过，避免重复解析与 Swoole worker 间的覆盖竞争。

### 13.4 回归测试

`EnvBootstrapTest` 的 5 条断言（Node 等价复刻已验证 5/5 通过，且回滚 composer 依赖后会红）：

| 断言 | 挡住什么 |
| --- | --- |
| `composer.json` require 了 `hyperf/dotenv` | 缺底层依赖 |
| `config/bootstrap.php` 调用了 `Dotenv` 且以 `BASE_PATH` 为根 | 缺唯一的数据源加载点 |
| `test/bootstrap.php` require 了 `config/bootstrap.php` | 测试读不到 `.env`，鉴权用例会全走 fail-closed 分支 |
| 全仓无手工 `file_get_contents('.env')` | 绕过 Dotenv 导致加载顺序打架 |
| `AuthMiddleware` 经 `env()` 读 `ALARM_AUTH_DISABLED` | 开关名拼错 → fail-closed 再也打不开 |

### 13.5 这一条为什么前两条攻击线没抓到

* **后端攻击线**被要求「攻击四处修复」，`env()` 能不能读到值属于**修复的外部前提**，
  不在那四条 diff 里；
* **前端攻击线**只攻 S-02 与 S-10 前端侧，`env()` 是后端的事；
* 两条线都**没有**做「修复 × 环境」的交叉验证。

**教训**：验证一条修复不能只看它的 diff，要看它**依赖的前置条件是否成立**。
fail-closed 这类「默认拒绝」的修复尤其危险 —— 它的正确性依赖于「配置确实能读到」，
而这一条只有把整条链串起来才看得见。

### 13.6 仍需运行时定案

`Dotenv::createUnsafeImmutable` 在 Hyperf 3.2 + Swoole 下的实际行为、
以及 `env()` 在 Swoole worker 间的可见性，**必须装好 vendor 后实跑确认**：

```bash
php -r 'require "vendor/autoload.php"; require "config/bootstrap.php";
        var_dump(getenv("ALARM_STATIC_TOKENS"), $_ENV["ALARM_STATIC_TOKENS"] ?? "MISSING");'
```

⚠️ 注意 `getenv()` 在部分 `Dotenv` 版本下需要 `putenv()` 配合；
若上一步返回 `MISSING` 而 `.env` 明明有值，说明 `safeLoad()` 的
「已载入就跳过」判断写窄了，应改为检查 `$_ENV` 中**任意一个**本仓自有键。

VERDICT: PASS

---

## 14. 第五批：汇总复核的收口（ATTACK-RESULT 的 3 条真缺陷）

`review-synthesis`（第三条线）**逐条回源码**复核了 5 条修复，不采信前两条线的措辞
（因为 `ErrorCode.php` / `BusinessException.php` / `AlarmExceptionHandler.php`
在后端报告写完 23:06 之后又被我改过，行号已失效）。

**总判定：净收益，但 S-10 在修复前后是净损失。** S-01～S-04 无条件净收益；
S-10 方向对，但换来的是一个「按 README 步骤无法恢复的全站 401」。

计数：**真缺陷 3 / 误报 3 / 遗留暴露 5**。

### 14.1 D-1 · MEDIUM · 401 在默认态下被完全吞掉

**这是三条真缺陷里唯一一条我自己完全没意识到的。**

```ts
// 修复前
const authStore = useAuthStore(pinia)
if (!authStore.isLogin) return          // ← 早退
authStore.isLogin = false
toast.error(...)                         // ← 到不了
await router.push(...)                   // ← 到不了
```

`isLogin` 默认 `false`（`stores/auth.ts:4`），告警页**没有 `meta.auth`**
（`auth-guard.ts` 的重定向不触发），全仓唯一把 `isLogin` 置 true 的是 mock 登录。
于是**默认态下每一次 401 都在第一行早退**：无 toast、无跳转、无日志，
页面照常渲染，只是所有字典空着。

**这直接违背 S-10 的设计意图**——机制层（不发空 token）做到了「让 401 暴露出来」，
最外层的处理器却把证据销毁了。而且比修复前的 fail-open 更难定位：**它连一条错误信息都不留。**

#### 修复过程中的一个真实回归（值得单独记）

第一步我把 `toast.error` 挪到守卫之前 —— **既有测试立刻红了**
（`handles concurrent and later 401 responses only once per login`）。

根因很漂亮也很讽刺：**原来 `isLogin` 兼职当了去重器** ——
第一个 401 把它置 false，后续并发的 401 被早退挡住，所以并发只弹一次。
守卫一旦移走，并发 401 就弹一串。

最终方案：去重改由独立的模块级 `unauthorizedNotified` 承担，语义明确为
**「每个登录会话提示一次」**（`isLogin` 重新为 true 时重置）；
**跳转仍留在守卫之后**（登录页自身 401 不能自我重定向成环）。

```ts
if (authStore.isLogin) unauthorizedNotified = false   // 新会话
if (!unauthorizedNotified) { unauthorizedNotified = true; toast.error(...) }
if (!authStore.isLogin) return                        // 只挡跳转，不挡信号
authStore.isLogin = false
await router.push({ path: '/auth/sign-in' })
```

新增回归用例 `surfaces a 401 even when not logged in (default state)`。
⚠️ 该用例用 `vi.resetModules()` + 动态 import 拿全新模块实例复位标志位，
**没有**给生产代码开「仅供测试」的复位函数。

### 14.2 D-2 · LOW-MEDIUM · 我写的鉴权测试建立在未声明的环境前提上

`AuthMiddlewareTest` 只用 `putenv()` 控制变量，但 Hyperf 的 `env()` 有三个 adapter，
`$_ENV` / `$_SERVER` 的优先级**高于** `PutenvAdapter`。

只清 putenv 的话，本机若有 `.env` 配了 `ALARM_STATIC_TOKENS`（README 恰恰教人这么做），
`testAcceptsTokenOnWhitelist` 会因为**与被测代码无关的原因**变红。

**这正是我写 §13 时埋下的同一类问题** —— `.env` 有没有值、能不能读到，
是这套测试成立的前提，而我上一批才刚为它建了 `EnvBootstrapTest`，却没同步收紧自己新写的用例。

已修：`setUp` 备份 `$_ENV` / `$_SERVER`，`withEnv()` 同时 `unset`，
`tearDown` 完整还原；类 docblock 写明前提。

对照组：`PolicyStatusValidationTest` 与 `IntegrityViolationMappingTest`
用 `newInstanceWithoutConstructor()` + 纯入参矩阵，**不碰进程环境**，无此问题。

### 14.3 D-3 · LOW · 注释漂移（4 处）

`assertKnownReason()`（不存在，真实方法名 `knownReasons()`）与 3 处「5 个语义分支」
（S-09 之后是 6 个）。已全部改正。

单列而非并进 LOW 堆的理由：这几处注释精确描述的正是
「409 有几个分支、怎么取文案」这条**正确性不变量**。而塌缩根因恰好是同值键覆盖 ——
注释说 5 个而代码有 6 个，下一个照注释推理的人会得出错误结论。

### 14.4 误报 3 条（记录在案，防止被当成待办）

| | 内容 |
| --- | --- |
| **M-1** | 前端报告 G-4 推理链第 4 步「401 → `isLogin=false` + `router.push`」**不成立** —— 默认态在第一行就早退了。而且它声称「已有既存测试覆盖」也不成立：该文件的 `beforeEach` **强制把 `isLogin` 置 true**，只覆盖已登录分支；它声称覆盖的那个分支恰恰是全仓唯一没走到的。**错的推理链制造了「已有测试兜底」的安全错觉，也掩盖了 D-1。** |
| **M-2** | 后端报告 D-5 用「行号不变性」论证「构造器非本轮新增」，这只对 `AlarmExceptionHandler` 成立，对 `AuthMiddleware` **不成立**（该文件 mtime 就在修复窗口内，且此前根本没有 logger）。**归因错了，结论侥幸正确** —— 但它给出的确定性会让读者跳过那个仍未执行的验证命令。 |
| **M-3** | A-6 / C-5 / D-6 三条 HIGH/MEDIUM 阻塞项**在 23:06 写下时全部正确，但现已过期**（当前树里分别已收口为 422、9 个用例、9 个用例）。它们仍以原文形态留在 `attack-backend.md` 的判定表里，**直接引用那份报告收口的人会去修一个已经修好的东西**。 |

### 14.5 本批验证状态

| 项 | 状态 |
| --- | --- |
| 前端 lint / vue-tsc / test:run / build | ✅ 全 0，**431 用例 / 23 个测试文件** |
| D-1 修复的连带回归 | ✅ 已被既有测试抓出并解决（非绿基线侥幸） |
| 后端 65 个 PHP 文件结构 | ✅ 通过 |
| **PHPUnit（含 151 个用例）** | ❌ 无 PHP，**一次都没跑过** |
| **D-2 的超全局变量优先级** | ⚠️ 结论来自 Hyperf adapter 语义的静态推理，装好 vendor 后必须实跑确认 |

### 14.6 净判定（引 ATTACK-RESULT，附本轮更新）

| 修复 | 判定 |
| --- | --- |
| S-01 / S-02 / S-03 / S-04 | **无条件净收益** |
| S-10 | 修复前后**净损失**；补上 §13 的 dotenv bootstrap + 本节的 D-1 后，**翻为净收益** |

**未受任何验证覆盖的清单没有变短**：后端运行时、PHPUnit、真实 MySQL、
前后端端到端联调、告警引擎的触发/去重/投递，全部未验证。

VERDICT: PASS

---

## 15. 15. 修复已推送到 GitHub

**仓库**：https://github.com/RossBool/mmx-hyperf-queue-monitor （分支 `main`）

本次推送包含本会话全部五批修复（S-01～S-10、S-17、S-07、S-08、S-09）、
新增的 4 个测试文件、`.audit/` 下的 8 份审查与复核报告，以及
`scripts/` 下 3 个可复现的验证脚本。

⚠️ **历史不冒充完整历史**：GitHub `push_files` 只能批量创建新提交，
`web/` 原有的 6 个 commit 无法保留。根 `CHANGELOG.md` 记录了它们。
⚠️ **二进制资源内联**：`push_files` 会静默丢弃二进制内容，
`placeholder.webp` 已改为 base64 data URI（`web/src/assets/placeholder.webp.ts`），
生成脚本为 `web/scripts/inline-binary-assets.mjs`。
