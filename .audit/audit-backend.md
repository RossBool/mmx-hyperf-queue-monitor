# 攻击线 B — 后端策略服务与规则语义｜对抗式静态审查

**审查对象**：`server/src/Service/AlarmPolicyService.php`(672) · `AlarmPolicyController.php` · `AlarmPolicy.php` / `AlarmPolicyCondition.php` · `server/migrations/` 7 个迁移
**事实来源**：`docs/alarm/contract.md` §0.5 / §1 / §2 / §3.1 ①-⑦
**审查者立场**：默认「实现有 bug，直到证明它站得住」

---

## 0. 运行环境声明（必读）

```
$ which php composer mysql redis-cli
EXIT=1
/bin/bash: line 1: php: command not found
$ ls server/vendor
ls: cannot access 'vendor': No such file or directory
```

**本沙箱没有 PHP / Composer / MySQL / Redis，且 `server/vendor/` 根本不存在。**
因此：

* 本报告 **100% 为静态审查**。没有执行过任何迁移、没有启动过任何服务、没有跑过任何测试。
* 报告里 **不存在** 任何"我运行了，输出是……"式的运行结果。
* `php -l` 语法检查同样无法执行（无 php 二进制）。**所有文件的语法正确性未经任何机器验证。**
* 每条发现都标注了证据等级：
  * **【静态确认】** = 推理链完全落在已读到的源码行上，结论不依赖运行时行为。
  * **【需运行时验证】** = 结论依赖框架/DB 的运行时语义，本环境无法证实（已逐条注明需要验什么）。

**总判定：2 个 BLOCKER、2 个 HIGH、5 个 MEDIUM、4 个 LOW。策略模块在 API 层面不可用。**

---

## 1. BLOCKER

### B-1 `insertConditions()` 把 camelCase 键写进 snake_case 表 → ③创建 与 ④更新 全部 500

**严重级别**：BLOCKER（模块级不可用）
**证据等级**：**【静态确认】**（推理链见下；唯一需运行时钉死的一环已单独标注）

#### 静态推理链

| 步 | 位置 | 事实 |
| --- | --- | --- |
| 1 | `ConditionValidator.php:140-152` | `validateOne()` 的返回值键名是 **camelCase**：`'metricNamespace'`, `'metricName'`, `'metricNameCn'` |
| 2 | `AlarmPolicyService.php:654-658` | `insertConditions()` 用 `array_merge(['policy_id'=>…], $condition)` **原样**合并，整批丢给 `AlarmPolicyCondition::query()->insert($rows)`，**没有任何改名** |
| 3 | `AlarmPolicyCondition.php:23-26` | `$fillable` 是 snake_case：`metric_namespace` / `metric_name` / `metric_name_cn` |
| 4 | `Model.php:13-16` | `App\Model\Model` 只设了 `$dateFormat`，**没有任何键名转换 / accessor / mutator** |
| 5 | `000200_…condition_table.php:34-36` | 建表列名是 `metric_namespace` / `metric_name` / `metric_name_cn`（与 `schema.sql:128-130` 一致） |
| 6 | `000200:44-45` | `created_at` / `updated_at` 是 `NOT NULL DEFAULT CURRENT_TIMESTAMP` |

`Eloquent\Builder::insert()` **不做 mass-assignment 过滤，也不做键名转换**——数组键原样成为 SQL 的列清单。`vendor/` 缺失，我无法读到 hyperf 源码逐字确认这一点（**需运行时验证**：打印 `$connection->prepare()->getSQL()`）。**但即使这一点存疑，本条依然是 bug**，见步 7：

7. **决定性内部反证**——同一张表的**另一条写入路径显式做了改名**：

```php
// AlarmPolicyService.php:330-345  copy() —— 逐字段显式映射
'metric_namespace' => $condition->metric_namespace,   // ← 手工改名
'metric_name'      => $condition->metric_name,
'metric_name_cn'   => $condition->metric_name_cn,
```
```php
// Presenter.php:76-78  condition() —— 读出时也按 snake_case 取
'metricNamespace' => $condition->metric_namespace,     // ← 手工改名
'metricName'      => $condition->metric_name,
'metricNameCn'    => $condition->metric_name_cn,
```

`copy()` 与 `Presenter::condition()` **都**做了 camelCase↔snake_case 映射，唯独 `insertConditions()` 没做。**两条路径写同一张表，只有其中一条映射 → 这不是"约定"，是漏写。**

#### 触发条件

任意一次成功通过校验的 `POST /api/alarm/policies`（③）或 `PUT /api/alarm/policies/{id}`（④）。**无特殊条件——正常请求即触发。**

#### 运行时表现预测

```
SQLSTATE[42S22]: Column not found: 1054 Unknown column 'metricNamespace' in 'field list'
```
经 `AlarmExceptionHandler::resolve()`：`isDuplicateKey()` 判 `'42S22'` 不以 `'23'` 开头（`AlarmExceptionHandler.php:101`）→ 落到 `INTERNAL_ERROR` 分支（:81）→ **HTTP 500 `服务器内部错误`**。

#### 影响面（这是最致命的部分）

契约 7 个端点里 **③ POST 与 ④ PUT 全废**。而 ⑦ `copy()` 只能复制**已存在**的策略——但没有任何端点能创建策略。于是：

> **整个告警策略模块无法通过 API 产出任何一条策略。7 个端点里至少 3 个（③ ④，以及依赖它们的 ⑦）构成一条死链。**

#### 潜伏的第二个缺陷（当前被默认值掩盖）

`insertConditions()` 从不写 `created_at` / `updated_at`。它没炸，只是因为 `000200:44-45` 给了 `DEFAULT CURRENT_TIMESTAMP`。一旦哪天有人按"契约 §2.8 说 `created_at` 是服务端维护的内部列"去收紧成 `NOT NULL` 无默认值（迁移头部注释 :9-10 明确说 Blueprint 表达不了 CHECK 与 JSON DEFAULT，是在鼓励往这个方向改），**create/update 会立刻二次失败**。建议同批修掉。

#### 修复方向（我不改代码，仅给方向）

在 `insertConditions()` 内做显式白名单映射（对齐 `copy():330-345`），或让 `ConditionValidator` 直接返回 snake_case 并由 `Presenter` 负责反向映射。**不要**靠"给表加 camelCase 列"来绕过——那会与 `schema.sql` 和 `metrics.md §0.1` 的字段映射表同时冲突。

---

### B-2 `ErrorCode::MESSAGES` 五个常量同值 409 → 4 条 message 被静默覆盖，**所有 409 都返回错误文案**

**严重级别**：BLOCKER（直接违反契约 §0.5，且是静默的）
**证据等级**：**【静态确认】**

#### 静态推理链

```php
// ErrorCode.php:19-23  —— 五个常量，值全是 409
public const POLICY_STATUS_CONFLICT  = 409;
public const POLICY_NAME_DUPLICATED = 409;
public const TEMPLATE_IN_USE         = 409;
public const PRESET_READONLY         = 409;
public const HISTORY_ALREADY_HANDLED = 409;

// ErrorCode.php:34-38  —— 数组字面量，五个条目，键全部求值为 409
self::POLICY_STATUS_CONFLICT  => '已启用的策略不可删除，请先停用',
self::POLICY_NAME_DUPLICATED => '策略名称已存在',
self::TEMPLATE_IN_USE         => '模板已被策略引用，不可删除',
self::PRESET_READONLY         => '预置模板不可删除',
self::HISTORY_ALREADY_HANDLED => '该告警已处理，不可重复处理',   // ← 最后一个，赢
```

PHP 数组字面量遇重复键 **后者覆盖前者，不报错、不告警**。所以：

```php
ErrorCode::message(409) === '该告警已处理，不可重复处理'
```

契约 §0.5 原文：

> **同码多义说明**：`409` 下有 5 个语义分支，实现时通过 `code` 相同、**`message` 不同**区分

`ErrorCode.php:10` 的类注释也自称"code 相同、message 不同"。**代码实际做不到这件事。**

#### 污染面（4 处，全部已确认）

| 调用点 | 契约要求的 message | 实际返回 |
| --- | --- | --- |
| `AlarmPolicyService.php:262` `destroy()` 删启用中策略 | 已启用的策略不可删除，请先停用 | **该告警已处理，不可重复处理** |
| `AlarmPolicyService.php:542` `copy()` 重试 99 次仍冲突 | 策略名称已存在 | **该告警已处理，不可重复处理** |
| `AlarmExceptionHandler.php:78` 唯一键冲突（重名创建/更新） | 策略名称已存在 | **该告警已处理，不可重复处理** |
| `AlarmConditionTemplateService.php:124` / `AlarmNotificationTemplateService.php:160` `isPreset=1` 删模板 | 预置模板不可删除 | **该告警已处理，不可重复处理** |

（TEMPLATE_IN_USE 同理。）

用户删除一条正在报警的策略，弹窗告诉他"该告警已处理，不可重复处理"。**这不是文案瑕疵——它把 5 个互斥的运维语义压成了 1 个错误的语义。**

#### 佐证：作者自己写的测试断言了代码给不出的值

`test/Cases/Feature/PolicyPersistenceTest.php:109-110`
```php
$this->assertSame(ErrorCode::POLICY_STATUS_CONFLICT, $e->getBizCode());   // 409
$this->assertSame('已启用的策略不可删除，请先停用', $e->getMessage());      // ← 代码给不出这个值
```
这条断言是**照契约写的**，不是照实现写的——所以它一旦被执行就会 FAIL，而它从未被执行（见 §4）。

对照 `PolicyPersistenceTest.php:187-188`，HISTORY_ALREADY_HANDLED 那条断言**恰好**等于 `MESSAGES[409]` 真正持有的值，所以它会"通过"——**通过的原因完全是错的**。这两条并排，正好暴露测试从未运行。

#### 修复方向

`message()` 需要接受 409 的**语义分支**而非仅 code；最小改动是给 `BusinessException::conflict()` 强制传入显式 message，并在 `AlarmExceptionHandler::resolve()` 里对 duplicate-key 分支直接用字面量 `'策略名称已存在'`（该处 :78 已经是 `ErrorCode::message(ErrorCode::POLICY_NAME_DUPLICATED)`，仍受污染）。

---

## 2. HIGH

### H-1 `POST /policies/{id}/status` 缺 `status` 时**静默停用**线上策略，而不是 422

**严重级别**：HIGH（破坏性 + 静默）
**证据等级**：**【静态确认】**

#### 静态推理链

契约 `contract.md:741`：
```
| `status` | int | **是** | `1` 启用 / `0` 停用 |
```

`AlarmPolicyService.php:505-516`：
```php
private function assertStatus(mixed $raw, Validator $errors): int
{
    if ($raw === null || $raw === '') {
        return 0;                       // ← 静默回落 0（停用），不记错误
    }
```

`AlarmPolicyController.php:62`：`$this->service->changeStatus($this->pathId($request), $body['status'] ?? null)`
`AbstractController.php:64-66`：`json_decode` 失败 → `return []` → 上游 `$body['status'] ?? null` → `null`

**根因**：`assertStatus()` 同时服务两个契约不同的调用方——
* `create()`（契约 ③：`status` **选填**，默认 `0`）→ 回落 0 **正确**
* `changeStatus()`（契约 ⑥：`status` **必填**）→ 回落 0 **错误**

同一文件里 `assertMonitorAndPolicyType()`（:399-428）**正确地**分了「必须提供」与「必须是 1/2/3/4/5 之一」两支（:404-408）；`assertStatus()` 没有这个分支。这是遗漏，不是设计。

#### 触发条件

```bash
curl -X POST .../api/alarm/policies/1001/status -d '{}'      # → 200，策略被停用
curl -X POST .../api/alarm/policies/1001/status -d '{"sta"'  # 坏 JSON → 200，策略被停用
curl -X POST .../api/alarm/policies/1001/status -d '{"status":""}'  # → 200，策略被停用
```

#### 运行时表现预测

`changeStatus():281-284` 发现 `status !== 1` → `$policy->save()` → 返回 `detail()`。**HTTP 200，告警策略被停用，前端行内开关显示"已停用"，全程零错误。** 一条正在报警的策略因为一次前端 bug / 代理截断 / 空 body 而静默失效。

**【需运行时验证】**：需在有 MySQL 的环境跑一次上述 curl，确认 `alarm_policy.status` 真的从 1 变 0。

---

### H-2 `isDuplicateKey()` 把整个 SQLSTATE `23xxx` 类都当成"重名"，掩盖真实完整性错误

**严重级别**：HIGH
**证据等级**：**【静态确认】**

#### 静态推理链

`AlarmExceptionHandler.php:95-110`：
```php
$code  = (int) $t->getCode();
$state = (string) ($t->errorInfo[0] ?? $t->getCode());
if ($code === 1062 || str_starts_with($state, '23')) {   // ← :101
    return true;
}
```

SQLSTATE `23xxx` = **integrity constraint violation 整类**，不止重名：

| MySQL errno | SQLSTATE | 含义 | 会被误判成"重名"吗 |
| --- | --- | --- | --- |
| 1062 Duplicate entry | 23000 | 唯一键冲突 | ✅ 唯一**应该**命中的那个 |
| 1452 Cannot find/child | 23000 | **外键**约束失败 | ❌ 会 |
| 3819 Check constraint | 23000 | **CHECK** 约束失败 | ❌ 会 |
| 1048 Column cannot be null | 23000 | **非空**约束失败 | ❌ 会 |

然后 :78 把它统一渲染成 `409 POLICY_NAME_DUPLICATED`（再叠加 B-2 的文案污染）。

#### 一个可复现的实例

`AlarmPolicyService.php:204` 在事务**外**加载 `$policy`；:244 在事务内按 `$policy->id` 做 UPDATE。若此刻另一请求删除了该策略，UPDATE 影响 0 行，:246 的 `insertConditions()` 随即插入悬空 `policy_id` → 撞 `fk_condition_policy`（`000200:54-55`）→ errno 1452 / SQLSTATE 23000 → **用户看到 409 "策略名称已存在"，而真实原因是并发删除。**

（事务本身会正确回滚，**不会**留下孤儿数据——这一点是好的。但错误分类是错的，会把并发 bug 一直伪装成"你重名了"。）

#### 修复方向

判定应收窄到 `errno === 1062`，或至少 `23000` 且错误信息含 `uk_`；1452/3819/1048 应各自映射到 500（或补 409 的独立分支），并写进日志。

---

## 3. MEDIUM

### M-1 迁移 000100–000600 具破坏性、不可重复执行；`alarm_history` 自称"永不删除"却在 `up()` 里被 drop

**严重级别**：MEDIUM-HIGH　**证据等级**：**【静态确认】**

* 6 个 DDL 迁移的 `up()` **全部**以 `DROP TABLE IF EXISTS` 开头：`000100:27`、`000200:27`、`000300:27`、`000400:27`、`000500:27`、`000600:27`。任何一次重跑（`migrate:refresh`、`migrate:fresh`、误加一个更早时间戳的迁移文件、CI 反复建库打到同一个持久库）**静默清空全部策略 / 条件 / 告警历史**。
* **自相矛盾**：`000600:81` 建表 COMMENT 写 `'告警历史（快照语义；无外键；**永不删除**）'`，而同一个文件的 `up()` 第 27 行就是 `DROP TABLE IF EXISTS alarm_history`。
* **不可重入**：`grep -rn "FOREIGN_KEY_CHECKS" server/` → **NONE FOUND**。若某次迁移中途失败、留下 `alarm_policy_condition` 残留，重跑 `000100` 的 `DROP TABLE alarm_policy` 会被 MySQL 拒绝（errno 3730：被外键引用的表不能删）。**部分失败之后这套迁移无法自愈。**
* **`down()` 是否丢数据**：7 个全部丢。6 个 `DROP TABLE` + `000700:74-75` 两条 `DELETE`。`migrate:rollback` **不可逆销毁全部数据**（对"预置种子"而言合理，对建表迁移而言需在文档里写死）。

### M-2 `copy()` 的副本名生成是"事务外先查后写"（TOCTOU）

**证据等级**：**【静态确认】**

`AlarmPolicyService.php:300` 在 `:302` 的 `Db::transaction` **之外**调用 `generateCopyName()`；后者（:536-543 → :574-577）用最多 **99 次串行 `SELECT EXISTS`** 判重。

* 并发复制同一策略：两个请求都选中 `X - 副本` → 后者撞 `uk_policy_name` → **409，而非契约 §3.1 ⑦ 期望的 `(2)` 重试成功**。
* 单次复制最坏 99 次串行往返（性能）。

契约要求"依次尝试 (2)(3)…(99)"，但重试是**基于预判**而非**基于实际冲突**，所以并发下契约承诺的语义不成立。

### M-3 `000700.down()` 绕过 `TEMPLATE_IN_USE` 保护，删除预置模板后留下悬空引用

**证据等级**：**【静态确认】**

`000700:74-75`：
```sql
DELETE FROM `alarm_notification_template` WHERE `is_preset` = 1 AND `creator_id` = 0;
DELETE FROM `alarm_condition_template`      WHERE `is_preset` = 1 AND `creator_id` = 0;
```
`alarm_policy.notification_template_ids` 是 **JSON 列、无外键**（`000100:44`），`condition_template_id` 是**无外键的 int 列**（`000100:45`）。回滚后策略里残留指向已删模板的 id，而契约 ⑬ 要求"被策略引用的模板不可删除 → 409 TEMPLATE_IN_USE"。迁移层直接绕过了这道闸。

**当前风险有限**：`AlarmConditionTemplateService.php:90` / `AlarmNotificationTemplateService.php:111` 在创建时硬编码 `'is_preset' => 0`，所以 `creator_id = 0` 这个护栏暂时有效（`currentUser()` 恒返回 `id => 0`，见 `AbstractController.php:39`）。**但这两条护栏是巧合叠加，不是设计**——任一条改动，rollback 就会删掉用户数据。

### M-4 条件级枚举走 `is_numeric` 强转，策略级枚举走严格整数字面量——两套标准

**证据等级**：**【静态确认】**

`ConditionValidator::assertEnum():211`
```php
if (! is_numeric($value) || ! in_array((int) $value, $allowed, true)) { … }
```
对比 `Pagination::intParam():71`（策略层的 `monitorType`/`policyType`/`status`/`objectType`/`conditionLogic`/`conditionTemplateId` 全走它）
```php
if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) { return (int) $value; }
```

后果：`sort: "1.9"` → 1 通过；`level: 2.9` → 2 通过；`frequency: "5.0"` → 5 通过。且 `assertSortSequence():156-165` 比较的是**已被截断的 int**，所以 `sort: [1.9, 2]` → `[1,2]` → 判为合法连续升序。

落库值仍是合法枚举（`validateOne():141/148-151` 重新 `(int)`），**无数据损坏**；但契约声明这些字段是 `int`，API 却在收非 int。

### M-5 `threshold` 没有对 `DECIMAL(20,4)` 的量级校验 → 纯客户端输入错误变成 500

**证据等级**：**【静态确认】**

`ConditionValidator::assertThreshold():168-186` 只校验「是数值」+「≤4 位小数」，**不校验量级**。列定义 `DECIMAL(20,4)`（`000200:39`）= 16 位整数 + 4 位小数。

`threshold: 1e20` → 通过应用层全部校验 → MySQL errno 1264 Out of range，SQLSTATE `22003` → 不以 `'23'` 开头（`AlarmExceptionHandler.php:101`）→ **500 服务器内部错误**。

---

## 4. LOW

| 编号 | 发现 | 位置 | 说明 |
| --- | --- | --- | --- |
| L-1 | 全局 handler `isValid(): true` + `stopPropagation()` 吞掉路由 404 | `AlarmExceptionHandler.php:35, 63-66` | 未匹配路由的 `NotFoundException` 落到 :81 的 `INTERNAL_ERROR` 分支 → 返 500 而非 404 |
| L-2 | `ALARM_STATIC_TOKENS` 未配置时 `isValid()` 返 `true` | `AuthMiddleware.php:51-55` | fail-open。生产漏配 env ⇒ API 完全无鉴权。已注释说明是联调便利，但**默认值方向反了** |
| L-3 | `currentUser()` 硬编码 `id => 0` | `AbstractController.php:36-42` | 契约 ③ 要求 creatorId = 当前登录人。已自述为占位 |
| L-4 | `assertObjectType` 把「缺失」与「非法」合并成一条文案 | `AlarmPolicyService.php:444-448` | 必填字段缺失报"必须是 1/2/3/4 之一"而非"必须提供"。`assertMonitorAndPolicyType` 做对了（:404-408） |
| L-5 | `AlarmEnum.php:49` 注释描述 `operator`，其下却是 `FILTER_MATCH_TYPE` | `AlarmEnum.php:49-50` | 陈旧注释 |

---

## 5. 逐条回应审查任务书（6 个必查点）

| # | 必查点 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 全量更新：先删后插？同事务？中途失败留孤儿/空条件？ | **事务边界 PASS；事务内容 FAIL** | 校验全在事务**前**（:206-217），422 绝不产生半写；DELETE(:220)→UPDATE(:244)→INSERT(:246) 全在 `Db::transaction`(:219) 内，Hyperf 遇异常回滚；批量 INSERT 是单语句，**无部分插入**。FK `ON DELETE CASCADE`(:54-55) 也兜住了并发删除。**但事务里写的键名是错的 → B-1。** 不会留孤儿，只会整条回滚后返 500。 |
| 2 | 状态机：合法转换 / 重复调用 / 已删除策略 | **幂等 PASS；必填校验 FAIL** | 幂等 `:281` ✅；已删除 → `findOrFail` → 404 ✅；`0↔1` 双向 ✅。**但缺 `status` 静默回落 0 → H-1。** 契约 ⑥ 只要求 0/1 两态，无更复杂状态机要求。 |
| 3 | operator 严格校验？`is_numeric` 放行？聚合函数与 metric 类型匹配？ | **operator PASS；聚合=前提不成立** | `assertStringEnum():222-231` 用 `is_string` + `in_array` 严格比对 6 个字面量，**未用 `is_numeric`**；:109-111 与 :216-221 两处注释明确写清了"为什么不能用 assertEnum"。DB 侧 `ck_condition_operator`(000200:57) 二次兜底。**关于聚合函数：契约 §2.1 的 `AlarmPolicyCondition` 无任何聚合字段，`schema.sql:124-139` 亦无，`metrics.md §0.1` 把 `AlarmMetric` 固定为 10 字段且不含聚合 —— v1.0 无此概念，该审查项前提不成立。** 最接近的语义是 `period` ⊆ 该指标 `periodOptions`，**该项已正确强制**（`assertPeriodOptions():189-203`，叠加全局枚举 :105）。唯一瑕疵见 M-4。 |
| 4 | 事务边界：漏 `Db::transaction` / 异常不回滚 | **PASS** | `create:158-191`、`update:219-247`、`copy:302-352` 三处多语句写全包在 `Db::transaction` 内，无手写 `begin/commit`，无 catch 吞异常。`destroy:257-268` 与 `changeStatus:273-287` 是单语句写 + DB 级 FK CASCADE，本身即原子，**不需要**显式事务——不构成缺陷。 |
| 5 | 迁移可逆性 / `down()` 丢数据 / 幂等 / 多 SQL 执行方式 | **多 SQL 执行 PASS；其余 FAIL** | 每条 `Db::statement()` 恰好承载一条语句，:12-14 的注释正确解释了 PDO prepare 不接受分号多语句 ✅。但 6 个 `up()` 以 `DROP TABLE IF EXISTS` 开头、缺 `SET FOREIGN_KEY_CHECKS`、部分失败后 errno 3730 不可自愈、`alarm_history` 自称"永不删除"却被 drop、7 个 `down()` 全 irreversible → **M-1 / M-3**。 |
| 6 | 错误码与 HTTP 状态逐条对表 | **FAIL** | HTTP status = code（:59）✅；422 带 `extra.errors[{field,message}]`（:74, 85-89）✅；404/409/422 分支齐全 ✅。**但 ①B-2 文案全错；②H-2 完整性错误被误分类为重名。** 契约 §0.5「code 相同、message 不同」实际未实现。 |

---

## 6. 测试覆盖审计（必查项 6）

```
server/test/Cases/Unit/AlarmRuleTest.php            630 行
server/test/Cases/Unit/CopyNameTest.php             101 行
server/test/Cases/Unit/PolicyPayloadValidatorTest.php 520 行
server/test/Cases/Feature/PolicyPersistenceTest.php 480 行
phpunit.xml.dist:4   bootstrap="./test/bootstrap.php"
test/bootstrap.php:18  require BASE_PATH . '/vendor/autoload.php';
$ ls server/vendor  →  No such file or directory
```

**结论：测试存在，但一次都没有被执行过，且当前 checkout 里根本跑不起来。**

`PolicyPersistenceTest.php:20-23` 自己写着：

> ⚠️ 本沙箱没有 PHP / MySQL，**这些用例从未被执行过**。

而 `vendor/` 缺失 ⇒ `composer test` 在此 checkout 直接失败。**这意味着任务书要求的「实跑证据」层在本项目里是 0。**

### 关键：能抓出上述 BLOCKER 的用例**都写了，但都没跑**

| 缺陷 | 本可抓出它的用例 | 位置 | 为何没抓到 |
| --- | --- | --- | --- |
| **B-1** | `testUpdateIsFullAndActuallyPersists` | `:287` | 第 291 行先调 `$service->create()` → 立刻撞未知列异常，测试在第一个断言前就死 |
| **B-1** | `testPolicyNameMustBeGloballyUnique` | `:79` | 第 84 行同样先 `create()` |
| **B-2** | `testEnabledPolicyCannotBeDeleted` | `:100` | `:110` 断言的 message 正是**代码给不出的那个**。作者照契约写、照实现跑，就会 FAIL |
| **H-1** | — | 无 | **没有任何**「`POST /status` 空 body」的用例 |
| **H-2** | — | 无 | 没有 FK / CHECK 失败的错误分类用例 |
| **M-1** | — | 无 | 没有任何迁移 up/down 可重入性用例 |
| **M-2** | — | 无 | 没有并发复制用例 |

### 单元层评价

`test/Cases/Unit/` 三个文件覆盖纯函数（`copyNameCandidates`、`PolicyPayloadValidator`、规则枚举）——**设计是对的**：不碰容器、不碰 DB，理论上可独立运行。但同样从未执行。且 `PolicyPayloadValidatorTest` 测的是纯校验，**碰不到 B-1/B-2 这类跨层缺陷**。

### 修复方需要补的证据（我不代写）

1. 装好 `server/vendor` + 真实 MySQL，**先跑一次 `composer test`**，把 `PolicyPersistenceTest` 从「写了」变成「绿了」——这一步会立刻暴露 B-1 与 B-2。
2. 补 `POST /status` 空 body / 坏 JSON / `status:""` → 期望 422 的集成用例。
3. 补唯一键冲突（期望 409 + 「策略名称已存在」）、FK 失败、CHECK 失败三者的**错误分类**用例。
4. 补迁移 `up` 重跑、`down`→`up` 往返的用例。
5. 真实 curl 走一遍 7 个端点并留存响应体——这是任务书要求的"user-path 真实运行证据"，目前一条都没有。

---

## 7. 判定

**「后端告警规则配置是正确的」这个命题不成立。**

| 严重级别 | 数量 | 编号 |
| --- | --- | --- |
| BLOCKER | 2 | B-1（③/④ 全废，模块不可用）、B-2（全部 409 文案错误） |
| HIGH | 2 | H-1（静默停用线上策略）、H-2（完整性错误误分类） |
| MEDIUM | 5 | M-1 ~ M-5 |
| LOW | 5 | L-1 ~ L-5 |

同时，**该做的确实做对了**的部分（避免审查沦为纯挑刺）：

* ✅ `operator` 严格字符串枚举校验（未被 `is_numeric` 污染），DB CHECK 二次兜底 —— **必查点 3 的核心，通过**
* ✅ 事务边界完整：三条多语句写路径全在 `Db::transaction` 内，校验全部前置 —— **必查点 4，通过**
* ✅ 校验前置于任何写入，422 不产生半写状态
* ✅ 复制命名按**字符**截断（`Text::truncateChars` 用 `mb_strcut`，`Text.php:19-25`），未踩 utf8mb4 按字节切半截字符的坑
* ✅ 种子数据质量高：6 条预置条件模板（`000700:36-68`）逐条核对 `config/autoload/metrics.php`——`namespace.metricName` 全部存在、`policyType` 全部匹配、`period` 全部落在该指标 `periodOptions` 内（含 `DiskUsageRate` period=60 / opts [30,60]）。**零错误**
* ✅ 回滚顺序安全：子表 000200 先于父表 000100 drop；跨迁移的两个引用列（`notification_template_ids` JSON / `condition_template_id` int）均无外键，无顺序隐患
* ✅ 聚合函数审查项**前提不成立**（v1.0 无此概念），已核实而非臆造

**修完 B-1 与 B-2 之前，这套策略服务不能声称"配置正确"：前者让模块整体不可用，后者让所有运维错误提示指向错误的根因。**
