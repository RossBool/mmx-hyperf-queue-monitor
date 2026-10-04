# 攻击线 D：数据层约束与迁移安全 —— 对抗式静态审查

> **审查对象**：`docs/alarm/schema.sql`（6 表 / 29 CHECK / 30 索引 / 2 FK）、`server/migrations/`（7 个迁移文件）
> **业务语义基准**：`docs/alarm/contract.md` v1.0（已冻结）
> **审查日期**：2026-10-03
> **审查立场**：默认「约束不够严」，逐条尝试证明它拦得住；证明不了就记为缺陷。
> **审查方式**：⚠️ **纯静态审查（STATIC ONLY）**。沙箱内无 MySQL、无 PHP，**未执行任何一条 DDL、未查询过 information_schema**。
> 本报告中所有「实际会不会被拦」的判断均为**依据 MySQL 8.0 语法与语义规则的推断**，每一条都在 §9 给出了用户本地可直接执行的验证命令。
>
> 另注：`docs/alarm/deliverable.md:108` 声称此前有一次「独立审查在真实 MySQL 8.0.39 上实测通过」。那是**项目文档中的声明，不是本次审查的验证结果**，本次审查不引用它作为任何结论的依据。

---

## 0. 结论摘要

| 维度 | 结论 |
| --- | --- |
| **迁移 vs schema.sql** | ✅ **完全等价，0 差异**。逐表机械比对通过（方法见 §5.1）。这是本次审查中最干净的一块。 |
| **枚举漂移** | ✅ **标量枚举 0 漂移**，13 组枚举 / 取值逐条对齐（§8）。JSON 列里的枚举副本全部失控。 |
| **CHECK 覆盖率** | ❌ **标量列覆盖良好，JSON 列覆盖率为 0**。6 个 JSON 列、承载 40+ 条业务规则，**一条 CHECK 都没有**。 |
| **有效防御力** | ⚠️ 29 条 CHECK 中 **3 条恒真（永不可能失败）、3 条只有一半是活的** → 实际有效防御力约 **23.5/29**。 |
| **P0 级脏数据路径** | **6 条**，其中 4 条可直接通过一条普通 INSERT/UPDATE 落库。 |
| **P0 级迁移安全缺陷** | **2 条**（`up()` 开头无条件 `DROP TABLE`；`schema.sql` 版本下限写错）。 |
| **索引缺陷** | **2 条完全冗余索引**（`idx_condition_policy_id`、`idx_receiver_template_channel`）、**1 条方向错误**（`idx_policy_updated_at`）、**1 条无读路径**（`idx_history_object`）、**2 处未披露的全表扫**。 |

### 严重度分布

| 严重度 | 数量 | 编号 |
| --- | --- | --- |
| 🔴 P0（脏数据可直接落库 / 迁移会炸库） | 8 | D-01 ~ D-06、M-01、M-02 |
| 🟠 P1（脏数据可落库，或契约被静默击穿） | 6 | D-07 ~ D-11、D-13 |
| 🟡 P2（语义收窄 / 性能退化 / 一致性风险） | 5 | D-12、D-14、I-01、I-02、X-01 |
| ⚪ 已核对通过（记录在案） | 6 | 见 §8 枚举漂移表 + §7.4 |

---

## 1. 脏数据写入路径清单

> **格式**：触发 SQL → 期望被哪个 CHECK 拦 → 实际会不会被拦。
> 「实际」列的判定依据在括号内注明；标注「需本地确认」的给出对应命令号。

---

### 🔴 D-01 `alarm_policy` 三个 object JSON 列零约束 —— P14 完全裸奔

**契约依据**：contract §1.7 + P14 —— `objectType=2` → `objectIds` 1-1000 个 int；`=3` → `objectGroupIds` 1-100 个 int；`=4` → `objectFilters` 1-10 条，元素含 `operator ∈ 6 值`、`values` 1-200 字符串、`matchType ∈ {include, exclude}`；**其余情况必须为 `null`/`[]`**。
**DDL 现状**：`alarm_policy` 的 8 条 CHECK 里只有 `ck_policy_object_type` 校验了 `object_type` 自身的取值域，**没有任何一条约束 object JSON 列，也没有任何一条跨列约束**。

```sql
-- 路径 1：P14 违反——声明「指定实例」却不给任何实例
UPDATE alarm_policy SET object_type = 2, object_ids = NULL WHERE id = 1;

-- 路径 2：JSON 结构错误——塞对象而不是数组
UPDATE alarm_policy SET object_ids = '{"a":1}' WHERE id = 1;

-- 路径 3：元素类型错误——塞字符串而不是实例 id
UPDATE alarm_policy SET object_ids = '["abc","def"]' WHERE id = 1;

-- 路径 4：objectFilters 三个枚举同时非法（operator/matchType/values 全错）
UPDATE alarm_policy
   SET object_filters = '[{"key":"r","operator":"GT","values":[],"matchType":"maybe"}]'
 WHERE id = 1;

-- 路径 5：超出上限——契约规定 1-1000 个，这里 5000 个
UPDATE alarm_policy SET object_ids = JSON_ARRAY(1,2,3, /* ... */ ,5000) WHERE id = 1;
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `ck_policy_object_type` | ❌ **不拦**（5 条路径全部放行） | 该 CHECK 的表达式是 `` `object_type` IN (1,2,3,4) ``，只读 `object_type` 一列；`object_ids` 根本没出现在任何 CHECK 里 |

**这为什么是「漏写」而不是「MySQL 做不到」**：MySQL 8.0.16+ 的 CHECK 允许使用 JSON 函数，以下约束完全可表达：

```sql
CHECK (object_type <> 2 OR (object_ids IS NOT NULL
       AND JSON_TYPE(object_ids) = 'ARRAY'
       AND JSON_LENGTH(object_ids) BETWEEN 1 AND 1000))
```

`objectFilters` 内的 `operator` / `matchType` **逐元素**枚举校验则**无法**用 CHECK 表达（CHECK 不允许子查询，而 `JSON_TABLE` 是派生表），这属于 MySQL 的真实限制——但当前是**连数组类型和长度都没写**，离能力上限还差很远。

**业务后果**：`objectType=2` + `object_ids=NULL` 的策略落库后，告警引擎无从取实例。要么静默不告警（最坏：以为在监控，其实没有），要么退化成「全部对象」——后者更危险，会让用户以为限定了实例。

---

### 🔴 D-02 `notification_template_ids` 无上限/无去重/无存在性 → 且 JSON 类型漂移会**静默击穿 409 引用保护**

**契约依据**：P12 最多 3 个；P13 不重复且 id 均须存在；⑯ 删除通知模板前用 `JSON_CONTAINS(notification_template_ids, CAST(:tid AS JSON))` 做 `409 TEMPLATE_IN_USE` 保护（contract:897-901）。
**DDL 现状**：无任何 CHECK；`alarm_policy` 与 `alarm_notification_template` 之间**故意无 FK**（schema.sql:29-31 明确说明）。也就是说这条引用关系**完全由应用层 + 运行时校验**支撑。

```sql
-- 路径 1：P12 违反——绑 7 个模板
UPDATE alarm_policy SET notification_template_ids = JSON_ARRAY(1,2,3,4,5,6,7) WHERE id = 1;

-- 路径 2：P13 违反——同一个模板绑两次
UPDATE alarm_policy SET notification_template_ids = JSON_ARRAY(3,3) WHERE id = 1;

-- 路径 3：元素类型从 int 漂移成 string（本条最致命，见下）
UPDATE alarm_policy SET notification_template_ids = '["3"]' WHERE id = 1;

-- 路径 4：整个字段写成 JSON 字面量 null
UPDATE alarm_policy SET notification_template_ids = 'null' WHERE id = 1;
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| 无（DDL 里根本没有相关 CHECK） | ❌ **全部放行** | 6 个 JSON 列零 CHECK |

**路径 3 的连锁反应（本次审查发现的最隐蔽一条）**：
`JSON_CONTAINS` 对标量比较是**类型严格**的。`'["3"]'` 里的 `"3"` 是 JSON 字符串，与 `CAST(3 AS JSON)` 的 JSON 数字 `3` **不相等**。因此当有人（或某个把 int 序列化成 string 的 DAO bug）把 id 写成字符串后：

> 删除通知模板 id=3 时，`JSON_CONTAINS` 返回 0 → 引用检查判定「未被引用」→ **409 保护静默失效** → 模板被物理删除 → `alarm_policy.notification_template_ids` 变成**永久悬挂引用**，而 DB 层没有 FK、不会报任何错。

contract §0.6 已经明确警告过「PHP 侧 `null` 与 `[]` 的 JSON 编码结果不同…避免破坏 `JSON_CONTAINS` 检索」——**作者知道这一类 bug 存在，但没有为它设任何 DB 防线**。这是典型的「默认约束不够严」：唯一的引用完整性守卫是一个类型敏感的字符串比较。

**可修与不可修的分界**（避免给出做不到的建议）：

| 校验目标 | CHECK 能否表达 |
| --- | --- |
| 是数组、`JSON_LENGTH <= 3` | ✅ 可以 |
| 元素必须是 JSON 整数（防路径 3） | ❌ **不能**（需 `JSON_TABLE` 派生表，CHECK 禁用子查询） |
| 元素 id 必须存在（防路径 1/2） | ❌ 不能（跨表，CHECK 不能引用其他表） |

**建议**：数组类型 + 长度上限用 CHECK 补齐；类型漂移与存在性改用**生成列 + 应用层强类型写入**双保险，或在删除模板的引用检查里同时匹配两种形态（`JSON_CONTAINS(ids, CAST(tid AS JSON)) OR JSON_CONTAINS(ids, JSON_QUOTE(CAST(tid AS CHAR)))`）。

---

### 🔴 D-03 `JSON NOT NULL` 挡不住 JSON 字面量 `null`；且数组长度/结构无人管

**契约依据**：§0.6 表格末两行 —— `alarm_condition_template.conditions` 与 `alarm_notification_template.channels` 均为「直传，**不接受 null**」；§2.5 `channels` **1-5 条**；§2.4 `conditions` **1-4 条**。
**DDL 现状**：两列都是 `JSON NOT NULL`，**无默认值、无 CHECK**。

```sql
-- 路径 1：JSON 字面量 null —— 不是 SQL NULL，NOT NULL 判定通过
INSERT INTO alarm_condition_template (name, policy_type, conditions)
VALUES ('空模板', 1, 'null');

-- 路径 2：空数组 —— 违反「1-4 条」，NOT NULL 判定通过
INSERT INTO alarm_condition_template (name, policy_type, conditions)
VALUES ('空数组模板', 1, '[]');

-- 路径 3：对象而非数组
INSERT INTO alarm_notification_template (name, channels)
VALUES ('结构错', '{"channel":1}');

-- 路径 4：channels 放 9 个渠道 —— 违反 N2「1-5 条」
INSERT INTO alarm_notification_template (name, channels)
VALUES ('超长', '[{"channel":1},{"channel":1},{"channel":1},{"channel":1},
                      {"channel":1},{"channel":1},{"channel":1},{"channel":1},{"channel":1}]');
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| 列的 `NOT NULL` | ❌ **不拦** | SQL 标准三值逻辑下，**JSON 字面量 `null` 是合法的 JSON 值，不是 SQL NULL**。`NOT NULL` 只拦 SQL NULL（路径 1-2 放行；直接写 `INSERT ... VALUES (NULL)` 才会报错） |
| 无（无 CHECK） | ❌ **不拦** | 路径 3-4 无任何约束触及 |

**这同样是漏写而非限制**：`CHECK (JSON_TYPE(conditions)='ARRAY' AND JSON_LENGTH(conditions) BETWEEN 1 AND 4)` 在 8.0.16+ 完全可表达，一条就能同时堵住 4 条路径。

**业务后果**：一条 `conditions = 'null'` 的模板行可以通过 P10 全部校验进库，之后每次「按 id 取整份模板」都返回 `null`，前端 `conditions.map()` 直接抛 `TypeError: Cannot read properties of null`——**500 出现在读取路径而不是写入路径**，排查成本极高。

---

### 🔴 D-04 `monitorType ↔ policyType` 联动规则零约束

**契约依据**：§1.1 联动表——`monitorType=1` ↔ `policyType ∈ {2,3,4}`；`monitorType=2` ↔ `policyType=1`；**`monitorType=3/4/5` 「v1.0 暂无策略类型，不可选（选了返回 422）」**。
**DDL 现状**：`ck_policy_monitor_type` 与 `ck_policy_policy_type` 是**两条互相独立的单列 CHECK**，无任何跨列约束。

```sql
-- 路径 1：契约明确「不可选」的组合，直接落库
INSERT INTO alarm_policy (name, monitor_type, policy_type)
VALUES ('非法组合', 3, 4);

-- 路径 2：monitorType 与 policyType 所属关系颠倒
INSERT INTO alarm_policy (name, monitor_type, policy_type)
VALUES ('颠倒', 2, 2);
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `ck_policy_monitor_type`（3 ∈ 1-5 ✓ 通过） | ❌ **不拦** | 该 CHECK 只保证 `monitor_type` 是 1-5 之一，**完全不读 `policy_type`** |
| `ck_policy_policy_type`（4 ∈ 1-4 ✓ 通过） | ❌ **不拦** | 同上 |

**可修**：`CHECK ((monitor_type=1 AND policy_type IN (2,3,4)) OR (monitor_type=2 AND policy_type=1))`。

**⚠️ 但这条建议本身有个契约歧义，必须先裁决**：§1.1 把 5 个 `monitorType` 都列为合法枚举（用于下拉框/列表筛选展示），同时又说 3/4/5「不可选」。上述 CHECK 落地后会**让 `monitor_type` 3/4/5 永远写不进库**。如果未来要用它们表示「已定义但暂无策略类型」的状态，这条 CHECK 就过严了。**建议先让契约方明确「3/4/5 是否允许作为 monitorType 落库」，再决定 CHECK 的写法**，不要由数据层单方面替契约做决定。

---

### 🔴 D-05 「每策略 1-4 条条件」的**下界 1 无法约束**（上界 4 是侥幸成立的）

**契约依据**：P4 每策略 `conditions` **1-4 条**；schema.sql:120 自己也写着「每策略 1-4 条，由应用层 + contract.md P4/P5 双重保证」。
**DDL 现状**：
- **上界 4**：`ck_condition_sort` 限制 `sort BETWEEN 1 AND 4` + `uk_condition_policy_sort (policy_id, sort)` 唯一 ⇒ 单策略**最多 4 行**。上界被结构性地保证了（但这是副作用，不是设计意图）。
- **下界 1**：**无任何机制**。一条 `alarm_policy` 行 + 0 条 `alarm_policy_condition` 是完全合法的数据状态。

```sql
-- 路径 1：只建策略，不建任何条件（PUT 的「先删后插」在事务里插了 0 行也走这条路）
INSERT INTO alarm_policy (name, monitor_type, policy_type)
VALUES ('空策略', 1, 2);
-- 此时 alarm_policy_condition 里 0 行；8 条 CHECK + 3 条子表 CHECK 全部"满足"
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| 无 | ❌ **不拦** | CHECK 是**行级**约束，无法表达「至少存在 1 条子行」 |

**这不是 CHECK 能力问题**——需要 `BEFORE INSERT` 触发器（延迟到事务提交时校验）才能表达。MySQL 触发器**不能**在一个 `alarm_policy` 的 INSERT 事件里查询正在构造的子表并对尚未提交的未来行做断言（子行是随后才插入的），所以**严格来说这是 MySQL 触发器也难以覆盖的场景**。

**务实结论**：下界 1 在本架构下**确实只能靠应用层**。但这恰恰意味着：**它是全模块最需要端到端测试保护的一条不变量**（创建/PUT/复制三条写路径都要验），而 §0.6 R-JSON-3 那句「CHECK 约束与唯一键是最后一道防线」在这里是**失效的**——没有防线。

**业务后果**：空策略静默存在，列表里 `conditionCount=0` 显示为「0 个条件」，告警引擎永不触发。若前端把 `conditionCount=0` 渲染成一个红点，用户可能以为「0 个告警」而不是「0 条条件」。

---

### 🔴 D-06 `alarm_policy.level`（= min(conditions.level)）无约束、无触发器，双写漂移

**契约依据**：P17 `level` = `min(conditions[].level)`；§3.1③ 服务端行为 2「派生 `level` = min(conditions[].level)，仅存冗余列供列表筛选」；列 COMMENT（schema.sql:75）也这么写。
**DDL 现状**：`ck_policy_level` 只保证 `level ∈ {1,2,3}`。**没有任何约束或触发器保证它等于子表的 min**。这是**全模块最可能发生漂移**的一条，因为 `level` 必须在创建时算一次、在每次 PUT 时再算一次，而 PUT 的语义是「先 DELETE 子表再批量 INSERT」。

```sql
-- 路径：策略标称「紧急」，但它唯一的条件是「提示」
INSERT INTO alarm_policy (name, monitor_type, policy_type, level)
VALUES ('等级漂移', 1, 2, 1);

INSERT INTO alarm_policy_condition
  (policy_id, metric_namespace, metric_name, operator, threshold, period, continuity, level)
VALUES (LAST_INSERT_ID(), 'CVM', 'CpuUtilizationRate', '>', 80, 5, 3, 3);
-- 结果：alarm_policy.level=1（紧急），min(子表 level)=3（提示）
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `ck_policy_level`（1 ∈ 1-3 ✓ 通过）<br>`ck_condition_level`（3 ∈ 1-3 ✓ 通过） | ❌ **两条都放行** | 两条 CHECK 各自只看自己那一行，**跨表派生关系无法用 CHECK 表达** |

**同时被放行的还有 P5「sort 必须 1..N 连续升序」**：

```sql
-- 同一条策略下 sort 只有 1 和 3，缺 2
INSERT INTO alarm_policy_condition (policy_id, sort, metric_namespace, metric_name, operator, threshold, period, continuity, level)
VALUES (1, 1, 'CVM','CpuUtilizationRate','>',80,5,3,3),
       (1, 3, 'CVM','MemoryUsageRate','>',90,5,2,1);
-- ck_condition_sort ✓ (1,3 都在 1-4 内)、uk_condition_policy_sort ✓ (不重复) → 放行
-- 但 P5 要求 1..N 连续，缺 2 违反
```

**业务后果**：`GET /policies?level=1`（紧急告警列表）会返回一个实际只会发「提示」的策略；前端色标也是错的。**且 `idx_policy_status_level_created (status, level, created_at)` 正是为这个筛选建的索引**——错误的 `level` 会直接导致**列表漏查**（真·紧急告警因 level 被写成 3 而不出现在紧急列表里）。这是本次审查中「脏数据 → 用户看不见」的最长传导链。

**建议**（不改表结构）：`level` 既然是派生冗余列，**要么在读取时实时计算并停止落库**（代价：失去 `idx_policy_status_level_created` 的筛选能力），**要么加一个 `BEFORE INSERT/UPDATE` 触发器重算**。当前状态是「既要冗余又不保证一致」——两难。

---

### 🟠 D-07 P10 的必填字段被 `DEFAULT` 吞掉 —— CHECK 校验的是「存下来的值」，不是「调用方给了值」

**契约依据**：P10 + §0.6 R-JSON-3 —— 「**应用层不得依赖 DB 列默认值，必须显式传值**…若绕过应用层直接写库导致漏值，**CHECK 约束与唯一键是最后一道防线**」。
**DDL 现状**：`alarm_policy_condition` 的 `sort DEFAULT 1`、`level DEFAULT 3`、`frequency DEFAULT 0` —— 这三列**都有 DEFAULT**。契约声称 CHECK 是防线，但 **CHECK 校验的是默认值本身，而默认值完全合法**。

```sql
-- 只给契约 P10 标记为「必填」的 7 个字段，故意漏掉 sort / level / frequency
INSERT INTO alarm_policy_condition
  (policy_id, metric_namespace, metric_name, operator, threshold, period, continuity)
VALUES (1, 'CVM', 'CpuUtilizationRate', '>', 80, 5, 3);
-- 落库结果：sort=1, level=3, frequency=0
-- 8 条 CHECK 中的 ck_condition_sort(1✓) / ck_condition_level(3✓) / ck_condition_frequency(0✓) 全部"通过"
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `ck_condition_sort` / `ck_condition_level` / `ck_condition_frequency` | ❌ **不拦**，反而成为「背书」 | 三条 CHECK 验证的是**默认值 `1`/`3`/`0` 本身合法**，无法区分「调用方漏传」与「调用方显式传了 1/3/0」 |

**同一张表内防御力不一致（这才是关键论点）**：`period` 与 `continuity` **没有 DEFAULT**，因此漏传会在 strict mode 下直接报错——**这两列有防线**。`sort`/`level`/`frequency` **有 DEFAULT**，所以没防线。同一条 P10 规则，一半被守住了，一半被自己的默认值出卖了。

**业务后果**：`frequency=0` 的契约含义是「不重复」——一个 PHP 侧的 payload 拼装漏字段，会**永久地**把一条本该每 15 分钟重复通知的条件改成生命周期内只通知一次。**没有报错、没有日志线索、CHECK 还显示"通过"。** 这是「脏数据最难查」的一类：值合法、类型正确、约束全绿，只是错了。

**建议**（二选一，倾向 A）：
- **A**：删掉 `sort`/`level`/`frequency` 三个 `DEFAULT`，让漏传在 strict mode 下直接失败，与 `period`/`continuity` 行为对齐。（代价：`INSERT` 不带条件表的语句需显式列名——本来就该显式。）
- **B**：保留 DEFAULT，但把契约 §0.6 那句「CHECK 约束与唯一键是最后一道防线」**改掉**——因为这句话在这三列上是**事实错误**，会误导后续实现者以为有兜底。

---

### 🟠 D-08 `metric_namespace` / `metric_name` 允许空串，且无字典约束

**契约依据**：P8 period 必须属于该指标 `periodOptions`；T3 namespace 必须属于模板的 `policyType`；§2.1 指标必须存在于 `GET /api/alarm/metrics`。
**DDL 现状**：`metric_namespace VARCHAR(64) NOT NULL`、`metric_name VARCHAR(64) NOT NULL`，**两者都没有长度下限 CHECK**。

```sql
-- 空命名空间 + 空指标名，全部通过
INSERT INTO alarm_policy_condition
  (policy_id, metric_namespace, metric_name, operator, threshold, period, continuity, level, frequency)
VALUES (1, '', '', '>', 0, 5, 1, 3, 0);
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| —— | ❌ **不拦** | `NOT NULL` 拦不住 `''`；无任何 CHECK 引用这两列 |

**这里暴露了 DDL 自身的设计不一致**：作者对 `name` 列非常严格——3 张表各配了一条 `ck_*_name_len`（`CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND n`），正是为了拦空串；但对**同样承载业务标识的 `metric_namespace`/`metric_name` 却一条都没写**。这是遗漏，不是设计取舍。

**可修 / 不可修分界**：

| 校验目标 | CHECK 能否表达 |
| --- | --- |
| `CHAR_LENGTH(metric_namespace) BETWEEN 1 AND 64`（非空） | ✅ 可以，**纯漏写** |
| `metric_namespace` 必须属于该 `policyType`（T3） | ❌ 不能（跨表，metrics 是文档/应用层字典） |
| `period` 必须属于该指标的 `periodOptions`（P8） | ❌ 不能（同上） |
| `metric_namespace` 与 `alarm_policy.policy_type` 一致 | ✅ **可以**（同表跨列）——但两张 CHECK 都在同一张表，**完全可以补**，当前也没有 |

**业务后果**：`metric_name=''` 的条件永远匹配不到任何指标序列，策略静默失效；`period=1` 配上一个 `periodOptions=[5,30]` 的指标，会按错误的采样窗口评估，**产生"看起来正常但阈值算错"的错误告警**——比不告警更危险。

---

### 🟠 D-09 `alarm_history` 状态机与快照列的一致性零约束

**契约依据**：§1.12 定义 `handleAction → status` 的**固定映射**（handle→2、ignore→3、recover→4）；H3「仅 `status=1` 可处理」；§2.6 `duration` = 恢复时长，未恢复为 0。
**DDL 现状**：7 条 CHECK 里 `ck_history_status` 只管 `status` 取值域，`ck_history_handle_action` 只管 `handle_action` 字符串域。**两者的映射关系、`handled_at`/`handler_name`/`recovered_at`/`duration` 与状态的一致性，全部无人管。**

```sql
-- 路径 1：status=1 意为「未处理」，但处理动作/处理时间/处理人都已填
UPDATE alarm_history
   SET status = 1, handle_action = 'handle', handled_at = NOW(), handler_name = '李四'
 WHERE id = 1;

-- 路径 2：已恢复却没有对应动作
UPDATE alarm_history SET status = 4, handle_action = NULL WHERE id = 1;

-- 路径 3：恢复时间与状态自相矛盾
UPDATE alarm_history SET recovered_at = NOW(), status = 1 WHERE id = 1;

-- 路径 4：duration 与 recovered_at 无关（未恢复却有非 0 时长）
UPDATE alarm_history SET duration = 999999 WHERE id = 1;

-- 路径 5：handle_action 合法，但 action 与 status 映射错误（recover 对应 status=4，这里写了 2）
UPDATE alarm_history SET status = 2, handle_action = 'recover' WHERE id = 1;
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `ck_history_status`（1 ∈ 1-4 ✓）<br>`ck_history_handle_action`（'handle' ∈ 3 值 ✓） | ❌ **5 条路径全部放行** | 两条 CHECK 都是**单列域校验**，不含任何跨列/状态机断言 |

**⚠️ 一处必须点名的正确写法**：`ck_history_handle_action` 写的是 `handle_action IS NULL OR handle_action IN (...)`。这个 `IS NULL OR` **不是必需的**——MySQL 的 CHECK 遵循三值逻辑，NULL 求值为 NULL（既非 TRUE 也非 FALSE）**被视为通过**，所以哪怕只写 `IN (...)` 也能让 NULL 放行。作者显式加了 `IS NULL OR` 是正确的（意图明确、不依赖三值逻辑的微妙行为），**这条是 29 条 CHECK 里质量最高的一条**。

**可修（部分）**：状态机主干可以用同表 CHECK 表达，这是**纯漏写**：
```sql
CHECK ( (status = 1 AND handle_action IS NULL AND handled_at IS NULL)
     OR (status > 1 AND handle_action IS NOT NULL AND handled_at IS NOT NULL) )
```
`duration` 与 `recovered_at` 的联动、`handler_name=''` 的一致性，同样可表达。`handle_action` 与 `status` 的**具体映射**也可表达（拆成 3 个 OR 分支）。

**业务后果**：H3 的「仅未处理可处理」是**防重复处理的唯一机制**（409 `HISTORY_ALREADY_HANDLED`）。如果 `status` 与 `handle_action` 可以不一致，那么「判断是否已处理」到底读哪个字段就成了实现细节——两个实现者会写出不同结果。⑲ 首页统计的 `todayUnhandled` 直接按 `status=1` 统计，**脏 `status` 会直接污染运营看板**。

---

### 🟠 D-10 `utf8mb4_0900_ai_ci` 排序规则带来的「看不见的重复」与 JSON↔关系表分歧

**契约依据**：P1「`name` 去首尾空格后长度 1-128，**全局唯一**」；§2.8「`channels` JSON 与 receiver 明细必须在同一事务内写入…唯一键是 `(template_id, channel, contact)`」。
**DDL 现状**：6 张表全部 `COLLATE=utf8mb4_0900_ai_ci`，而 `uk_policy_name` 与 `uk_receiver_template_channel_contact` 都建在这个排序规则上。

```sql
-- 路径 1：去空格后肉眼完全相同的两个策略，可以同时存在
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('CPU监控', 1, 2);
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('CPU监控 ', 1, 2);
-- 均成功（0900_* 是 NO PAD 排序规则，尾空格参与比较）
-- 但 ck_policy_name_len 用的是 TRIM(name)，说明业务语义上是"去空格后的名字"
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `uk_policy_name` | ❌ **不拦**（放行两条） | `utf8mb4_0900_ai_ci` 是 **NO PAD** 排序规则，`'CPU监控' <> 'CPU监控 '`。**DB 层从未对 name 做 TRIM 归一化**，P1 的「去首尾空格后…唯一」在 DB 层不成立 |
| `uk_policy_name` | ⚠️ **反向拦截**：`'Policy'` 与 `'policy'` 被判为**重复** → POST 返回 409 | `ai_ci` = accent-insensitive + **case-insensitive**。契约只说「全局唯一」，**从未声明大小写不敏感**——这是一个未声明的语义收窄 |

**receiver 表上的同一个排序规则还有一个连带风险**：`'Ops@Example.com'` 与 `'ops@example.com'` 在 `uk_receiver_template_channel_contact` 下判为**冲突**。若应用层按 contract §2.8「同事务写入 channels + receiver」实现，第二次 insert 会抛 1062：
- 若异常向上冒泡 → 整个创建/更新失败 → 用户填了两个大小写不同的邮箱却被拒，**报错信息完全无法解释原因**；
- 若应用层 catch 后继续 → **`channels` JSON 与 `alarm_notification_receiver` 永久分歧**，而 contract 明确规定「读模板时**一律以 channels 为准**」→ 冗余表的去重职责失效。

**建议**：`name` / `contact` 若要真正实现 P1 的「去空格后唯一」，应在应用层**入库前 TRIM 归一化**并在唯一键上建 `VARCHAR(128) COLLATE utf8mb4_0900_as_cs` 或生成列；若保留 `ai_ci`，需在契约里**显式声明「名称大小写不敏感」**，否则 409 会成为用户无法理解的谜。

---

### 🟠 D-11 `alarm_notification_receiver.contact` 允许空串

**契约依据**：N5 `receivers` **0-100 个**，邮箱/手机号需通过基础格式校验；§2.5 `channel=5` 时 `receivers` 必须为 `[]`。
**DDL 现状**：`contact VARCHAR(255) NOT NULL`，**无长度下限 CHECK**（对比：`name` 列有 `ck_*_name_len`）。

```sql
INSERT INTO alarm_notification_receiver (template_id, channel, contact) VALUES (1, 1, '');
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| —— | ❌ **不拦** | `NOT NULL` 不拦 `''`；无 CHECK 引用 `contact` |

**业务后果**：一条无法投递的接收人记录占据 N5 的 100 个名额之一，并让「模板是否配置完成」的判断（N9 绑定校验依赖 `receivers` 非空）出现口径不一致——`channels` JSON 里是 `[""]` 还是 `[]`？两者语义完全不同，但 DB 都接受。

---

### 🟡 D-12 `object_filters` 中的 `operator` 副本绕过了已有的 6 值 CHECK

**契约依据**：§1.7 `objectFilters[].operator`「同 1.5 六种取值之一」；§1.7 `matchType ∈ {include, exclude}`。
**DDL 现状**：`operator` 这个**枚举在标量列上有 CHECK 保护**（`ck_condition_operator`、`ck_history_operator`），但 `object_filters` JSON 里的**同名副本一个 CHECK 都没有**。

```sql
UPDATE alarm_policy
   SET object_filters = '[{"key":"env","operator":"greaterThan","values":["prod"],"matchType":"IN"}]'
 WHERE id = 1;
-- 三处枚举同时漂移，全部放行
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| `ck_condition_operator` / `ck_history_operator` | ❌ **不拦** | 那两条 CHECK 只约束**别的表**的 `operator` 列，对 JSON 内的副本零影响 |

**这类「枚举在项目里有多个副本、只有部分副本被约束」的漂移是系统性的**，完整清单见 §8 的「JSON 内副本」行。逐元素校验在 MySQL CHECK 里做不到（见 D-02），所以这条**只能靠应用层**——但 DDL 至少应当在注释里写明「JSON 内的枚举副本无 DB 约束」，让实现者知道边界在哪。

---

### 🟡 D-13 `project_id` 无 FK 无 CHECK，可指向不存在的项目

**契约依据**：§0.1 错误码表 —— `403 FORBIDDEN`「无权限操作该资源」，其判定依赖「该资源所属项目」；§3.1③ `projectId` `>= 0`，`0` = 未分配。
**DDL 现状**：`project_id BIGINT UNSIGNED NOT NULL DEFAULT 0`，**无 FK**（合理：项目表不在本模块）、**无 CHECK**（UNSIGNED 已挡住负数，契约的 `>=0` 已被类型覆盖 ✓）。

```sql
-- 指向一个不存在 / 已删除的项目
UPDATE alarm_policy SET project_id = 999999 WHERE id = 1;
```

| 预期被拦 | 实际 | 依据 |
| --- | --- | --- |
| —— | ❌ **不拦** | 无 FK（跨模块，刻意）、UNSIGNED 只保证非负 |
| 类型层面的 `>= 0` | ✅ **拦住负数** | `BIGINT UNSIGNED` 结构性保证 |

**业务后果**：一个指向已删除项目的策略，403 判定逻辑会走向两个极端——要么对所有人一律 403（策略"消失"了），要么把 `project_id` 当作未分配放行（**越权风险**）。**降级建议**：给 `alarm_policy.project_id` 配一个 `COMMENT` 注明「无 FK，删除项目时需同步清理/降级」，并在项目删除的流程里显式加一步。⚠️ 降级理由：这是跨模块一致性，本模块无法自行修复，**不宜在此单方面加 CHECK**。

---

### 🟡 D-14 `CHECK` 三值逻辑的边界（**已核对通过，记录在案**）

`handle_action` 之外的 28 条 CHECK 全部作用在 `NOT NULL` 列上，**不存在 NULL 求值为 NULL 而意外放行的情况**。唯一一条可空列上的 CHECK（`ck_history_handle_action`）已显式处理 NULL（见 D-09）。

**结论**：三值逻辑在本 schema 上**没有隐藏漏洞**。但这也说明 28 条 CHECK 的作者对这条规则是**无意识使用**的——若将来给任何可空列加 `CHECK (col IN (...))` 而不写 `IS NULL OR`，就会踩坑。建议在 schema.sql 顶部注释里加一句提醒。

---

## 2. CHECK 覆盖率逐表对照

| 表 | 业务规则类别 | 应有 CHECK | 实际 CHECK | 覆盖率 | 缺口 |
| --- | --- | --- | --- | --- | --- |
| `alarm_policy` | 枚举（monitorType/policyType/status/level/objectType/conditionLogic） | 6 | 6 | ✅ 100% | — |
| | 名称长度 `name` 1-128 | 1 | 1 | ⚠️ 50% 有效 | 上界 128 与 `VARCHAR(128)` 重复，**仅下界 1 是活的** |
| | 备注 `remark` <= 500 | 1 | 1 | ❌ **0% 有效** | `CHAR_LENGTH(remark) <= 500` on `VARCHAR(500)` **恒真，永不可能失败** |
| | **`monitorType ↔ policyType` 联动（P3）** | 1 | **0** | ❌ 0% | D-04 |
| | **`objectType ↔ 3 个 JSON 列对应（P14）** | 1 | **0** | ❌ 0% | D-01 |
| | **JSON 结构（objectIds/GroupIds/Filters 数组类型与长度）** | 3 | **0** | ❌ 0% | D-01 |
| | **JSON 内 `operator`/`matchType` 枚举** | 2 | **0** | ❌ 0%（CHECK 不可表达） | D-12 |
| | **`notificationTemplateIds` 数组类型/长度 <= 3（P12）** | 1 | **0** | ❌ 0% | D-02 |
| | **`level` = min(子表 level)（P17）** | 1 | **0** | ❌ 0%（跨表 CHECK 不可表达） | D-06 |
| | **条件条数 1-4（P4）** | 1 | **0** | ❌ 上界偶然成立，下界 0% | D-05 |
| | `project_id >= 0` | 1 | **0** | ⚠️ 类型已覆盖 | D-13 |
| **小计** | | **18** | **8** | **44%** | |
| `alarm_policy_condition` | `sort` 1-4 | 1 | 1 | ✅ 100%（活） | 连续性 P5 无约束（D-06） |
| | `operator` 6 值 | 1 | 1 | ✅ 100%（活） | — |
| | `period` 5 值 | 1 | 1 | ✅ 100%（活） | periodOptions 子集不可表达（D-08） |
| | `continuity` 1-10 | 1 | 1 | ✅ 100%（活） | — |
| | `level` 1-3 | 1 | 1 | ✅ 100%（活） | — |
| | `frequency` 9 值 | 1 | 1 | ✅ 100%（活） | — |
| | **`metric_namespace`/`metric_name` 非空** | 2 | **0** | ❌ 0% | D-08 |
| | **`namespace` 属于 policyType（T3）** | 1 | **0** | ❌ 0%（跨表不可表达） | D-08 |
| | **必填完整性（P10）** | 1 | **0** | ❌ **0%，且被 DEFAULT 反向破坏** | **D-07** |
| **小计** | | **9** | **6** | **67%** | |
| `alarm_condition_template` | `name` 1-64 | 1 | 1 | ⚠️ 50% 有效 | — |
| | `remark` <= 500 | 1 | 1 | ❌ **0% 有效（恒真）** | — |
| | `policy_type` 1-4 | 1 | 1 | ✅ 100%（活） | — |
| | `is_preset` 0/1 | 1 | 1 | ✅ 100%（活） | — |
| | **`conditions` JSON 数组 1-4 条（T2）** | 1 | **0** | ❌ 0% | D-03 |
| | **JSON 内 sort/period/continuity/level/frequency 枚举副本** | 5 | **0** | ❌ 0%（CHECK 不可表达） | D-03 |
| **小计** | | **10** | **4** | **40%** | |
| `alarm_notification_template` | `name` 1-64 | 1 | 1 | ⚠️ 50% 有效 | — |
| | `remark` <= 500 | 1 | 1 | ❌ **0% 有效（恒真）** | — |
| | `is_preset` 0/1 | 1 | 1 | ✅ 100%（活） | — |
| | **`channels` JSON 数组 1-5 条（N2）** | 1 | **0** | ❌ 0% | D-03 |
| | **JSON 内 channel 不重复 + 1-5 值（N2/§1.11）** | 2 | **0** | ❌ 0%（CHECK 不可表达） | D-03 |
| | **callbackUrl 规则（N3/N4）** | 2 | **0** | ❌ 0% | — |
| | **receivers 0-100 个（N5）** | 1 | **0** | ❋ 0% | — |
| | **silenceTime 0-1440（N6）** | 1 | **0** | ❋ 0% | — |
| **小计** | | **10** | **3** | **30%**（最低） | |
| `alarm_notification_receiver` | `channel` 1-5（§1.11） | 1 | 1 | ✅ 100%（活） | — |
| | **`contact` 非空** | 1 | **0** | ❌ 0% | D-11 |
| | **contact 格式（邮箱/手机号，N5）** | 1 | **0** | ❋ 0%（正则不可表达） | — |
| **小计** | | **3** | **1** | **33%** | |
| `alarm_history` | `level` 1-3 | 1 | 1 | ✅ 100%（活） | — |
| | `status` 1-4 | 1 | 1 | ✅ 100%（活） | 状态机无约束（D-09） |
| | `operator` 6 值 | 1 | 1 | ✅ 100%（活） | — |
| | `period` 5 值 | 1 | 1 | ✅ 100%（活） | — |
| | `continuity` 1-10 | 1 | 1 | ✅ 100%（活） | — |
| | `object_type` 1-4 | 1 | 1 | ✅ 100%（活） | — |
| | `handle_action` 3 值 + NULL | 1 | 1 | ✅ 100%（**质量最高**） | — |
| | **status ↔ handle_action 映射（§1.12）** | 1 | **0** | ❌ 0%（纯漏写） | D-09 |
| | **status ↔ handled_at/handler_name 一致性（H3）** | 1 | **0** | ❌ 0%（纯漏写） | D-09 |
| | **recovered_at ↔ duration 一致性** | 1 | **0** | ❌ 0%（纯漏写） | D-09 |
| **小计** | | **10** | **7** | **70%** | |

### 2.1 有效防御力折算（29 条 CHECK 的真实含金量）

| 分类 | 条数 | 说明 |
| --- | --- | --- |
| ✅ 有效（可能失败并拦住脏数据） | **23** | 全部枚举域 + `continuity`/`sort` 的上界 + 3 条 `name_len` 的下界 + `handle_action` |
| ❌ **恒真（永不可能失败）** | **3** | `ck_policy_remark_len`、`ck_condition_template_remark_len`、`ck_notification_template_remark_len` —— 都是 `CHAR_LENGTH(<VARCHAR(500)>) <= 500`，**类型已经保证，CHECK 零增量防御** |
| ⚠️ 半活（只有下界有效） | **3** | `ck_policy_name_len`、`ck_condition_template_name_len`、`ck_notification_template_name_len` 的 `<= 128/64` 上界部分恒真，**只有 `>= 1` 拦空串** |

**结论：29 条 CHECK 的有效防御力约为 23.5/29。** 三条恒真 CHECK 不是"写了没坏处"，而是**它们制造了"备注长度有约束"的错觉**——审阅者看到 29 这个数字会高估整体防线密度。

### 2.2 覆盖率的一句话总结

> **标量列的枚举约束做得相当扎实（13 组枚举零漂移）；全部失守的是两类东西——① 6 个 JSON 列（承载 40+ 条业务规则，0 条 CHECK）；② 需要跨行/跨表才能判断的不变量（派生 level、条件条数、状态机、枚举联动）。**
> 后者在 MySQL CHECK 的能力边界内**部分可表达**（D-03/D-06 的 sort 连续性/D-09 状态机/D-04 联动，都是同表或简单跨表，**纯属漏写**），只有「跨表 min()」「至少 1 条子行」两类是 CHECK 真正做不到的。

---

## 3. MySQL 8.0.16 依赖检查

### 🔴 M-01 `schema.sql` 自己声明的版本下限是错的 —— 而且它是唯一错的那份文件

| 文件 | 行 | 声明 |
| --- | --- | --- |
| **`docs/alarm/schema.sql`** | **10** | **`MySQL >= 8.0.13`（使用 JSON 列 + CHECK 约束 + 表达式默认值的能力）** |
| `server/README.md` | 36 | `≥ 8.0.16` —— ⚠️ **不是 8.0.13**。8.0.16 之前 MySQL 只会*解析* CHECK 约束而**静默忽略**，本项目的 **29 个 CHECK 会全部失效且不报任何错** |
| `server/README.md` | 42-65 | 专章《为什么下限是 8.0.16 而不是 8.0.13》，引用 Oracle 发布说明原文 + 8.0.15 实测行为（`INSERT INTO t1 VALUES (0)` → `Query OK, 1 row affected`） |
| `server/.env.example` | 6 | `# ---- MySQL 8.0.16+ (8.0.16 之前 CHECK 约束会被静默忽略) ----` |

**为什么这条是 P0**：README 花了整整一节论证「8.0.13 不够、必须 8.0.16」，`.env.example` 也标注了，**唯独 `schema.sql` 第 10 行写着「8.0.13」**。而 `schema.sql` 是运维**唯一会主动打开的文件**——README 第 84 行让用户执行的正是 `mysql -u<user> -p <db> < /workspace/docs/alarm/schema.sql`。用户读完 schema.sql 头部就以为 8.0.13 够用。

**后果精确描述**：在 8.0.13 / 8.0.14 / 8.0.15 上执行这份 DDL——**不报任何错，29 条 CHECK 全部被静默丢弃**（MySQL 解析后忽略）。于是本报告里 §1 的 D-01 ~ D-13 **每一条都会真实发生**，且没有任何错误信号。§9 的 V1/V2 两条命令就是为拦截这个场景设计的。

**修复建议**：`schema.sql:10` 改为 `MySQL >= 8.0.16`，并把 README:42-65 的结论内联一句（"8.0.16 之前 CHECK 被静默忽略"）。**这是全审查中投入产出比最高的一处修改**（改 1 行，堵住一整类静默失效）。

### 3.2 其他版本相关写法核查

| # | 写法 | 依赖 | 判定 |
| --- | --- | --- | --- |
| 1 | `CHECK (...)` 29 条 | ≥ 8.0.16 才生效 | 🔴 见 M-01。8.0.13-8.0.15 **静默忽略**（不报错） |
| 2 | `DEFAULT (表达式)` | ≥ 8.0.13 | ✅ **未使用**。本 schema 所有 DEFAULT 都是字面量（`DEFAULT ''`/`DEFAULT 0`/`DEFAULT NULL`），JSON 列用 `DEFAULT NULL`（SQL NULL，任何 8.0 版本都合法） |
| 3 | `JSON` 列类型 | 8.0.0+ | ✅ 正常。5.7 上会因不认识 `JSON` 类型而**报错**（响亮失败，比静默失败好） |
| 4 | `COLLATE=utf8mb4_0900_ai_ci` | 8.0.0+ | ✅ 正常。5.7 / MariaDB 上**报错**（响亮失败）。README:65 已正确指出它不是版本下限的原因 |
| 5 | `utf8mb4` + 最长索引键 | — | ✅ **无需 `innodb_large_prefix`**。最长键 = `uk_receiver_template_channel_contact` = 8 + 1 + 255×4 = **1029 字节** < 3072 字节上限，8.0 默认 `innodb_default_row_format=DYNAMIC` 天然支持 |
| 6 | `CHECK` 引用 `TRIM()`/`CHAR_LENGTH()` | — | ✅ 允许（确定性内置函数）。`TRIM` 只去**空格**，不去 tab/换行——`name=CHAR(9)`（单个 Tab）会通过 `ck_policy_name_len`。契约 P1 说的是「去首尾空格」，字面上不算违反，但若产品期望「去空白」需用 `TRIM(BOTH ' \t\n' FROM ...)` |
| 7 | `CHECK` 引用 JSON 函数 | 8.0.16+ | ⚠️ 可用但**未使用**。本 schema 6 个 JSON 列**一条 JSON CHECK 都没有**，这是漏写而非限制 |
| 8 | `CHECK` 引用其他表 / 子查询 / `JSON_TABLE` | — | 🚫 **永不支持**。这是 D-02/D-05/D-06/D-08 中部分规则**无法**用 CHECK 表达的原因，属真实能力边界 |
| 9 | `CHECK` 引用 `AUTO_INCREMENT` 列 | — | 🚫 MySQL 不允许。**本 schema 未违反** ✓（`id` 未出现在任何 CHECK 里） |
| 10 | `INSERT IGNORE` + CHECK 违规 | — | ⚠️ `INSERT IGNORE` 会把错误降级为 warning。**CHECK 违规时的确切行为（跳过该行 vs 插入并警告）本次未能实测**，已列入 §9 V13 由用户本地确认。**若为"跳过"**，则 000700 迁移会静默少插入预置模板且仍返回成功 |
| 11 | `SET FOREIGN_KEY_CHECKS = 0` | — | ⚠️ `schema.sql:54/328` 有；**7 个迁移全部没有**（见 M-03） |

---

## 4. 迁移安全性（可逆性 / 部分应用 / 幂等性）

### 🔴 M-02 每个 `up()` 开头无条件 `DROP TABLE IF EXISTS` —— 重跑即清库

**事实**：7 个迁移中 **6 个建表迁移的 `up()` 第一行都是 `DROP TABLE IF EXISTS <本表>`**（`000100:27`、`000200:27`、`000300:27`、`000400:27`、`000500:27`、`000600:27`），第 7 个是 seed 迁移。

| 问题 | 说明 |
| --- | --- |
| **正常路径无害** | Hyperf 的 `migrations` 记账表保证已应用的迁移不重跑，`DROP IF EXISTS` 只是防御性写法 |
| **异常路径 1：记账丢失，表还在** | 从备份恢复、`migrations` 表被 truncate、有人手工复制了 6 张 alarm 表到新库、切换 DB 时 → 重跑 `migrate` → **每张表被静默清空** |
| **异常路径 2：`alarm_history` 被清空** | 000600 的 `DROP TABLE IF EXISTS alarm_history` —— 这是全模块**唯一没有删除端点、schema.sql 明确「永不删除」的表**（:272, :326），却被迁移文件提供了无提示的删除入口。`migrate:refresh` / 迁移重跑 = 静默丢失全部告警历史，**无备份、无确认、无日志** |
| **异常路径 3（更隐蔽）：DROP 在 FK 上不安全** | `000100` 要 drop 的 `alarm_policy` 是 `alarm_policy_condition` 的 **FK 父表**。当子表存在且 FK 仍挂着时，MySQL **拒绝** drop 被引用的父表（外键错误类）。`000400` 对 `alarm_notification_template` 同理。 |
| **→ 失败模式不对称且反直觉** | 重跑**父表**迁移（000100 / 000400）→ **报错中止**（相对安全）；重跑**子表/独立表**迁移（000200 / 000300 / 000500 / **000600**）→ **静默清表**（危险）。同一个「重跑一个迁移」的操作，因文件序号不同而一个响亮失败、一个悄悄毁数据。运维无法从行为推断风险 |

**建议**（按投入产出排序）：
1. **立即**：把 6 个 `up()` 里的 `DROP TABLE IF EXISTS` 删掉（迁移应当是"建"，不是"重建"）。若确实需要防御性 DROP，改为**先判断表是否存在，存在就抛异常**而不是 DROP。
2. 若要保留幂等性，改用 `CREATE TABLE IF NOT EXISTS`（**注意**：它对已存在的表会静默跳过，导致"迁移成功但结构是旧的"——同样危险，仅在纯新建库场景可接受）。
3. **强烈建议**：在 `server/README.md` 的首次部署步骤里加一条醒目警告——**`migrate` 在这些文件上不是幂等操作**。

### 🟠 M-03 迁移不设 `SET FOREIGN_KEY_CHECKS = 0`，与 schema.sql 行为不一致

`schema.sql:54` 和 `:328` 明确包了 `SET FOREIGN_KEY_CHECKS = 0/1`；**7 个迁移一个都没有**（已 grep 确认）。

- 迁移完全依赖**文件序号**保证父表先建（每个文件的 docblock 都写了「文件序号保证…先于…」）。单次 `migrate` 顺序执行 → 成立 ✓
- 但**单文件执行会失败**：`php bin/hyperf.php migrate --path=.../000200_...php` 在空库上会因 `alarm_policy` 不存在而失败
- **两条建库路径行为不一致**：走 `schema.sql` 成功、走 migrations 失败（或反之），排查时容易误判。建议对齐（要么都加，要么都不加并在文档说明依赖序号）。

### 🟠 M-04 seed 迁移 000700 的 `down()` 不是 `up()` 的逆操作

```php
// up():   INSERT IGNORE 3 条通知模板 + 6 条条件模板（按 name 唯一）
// down(): DELETE FROM alarm_notification_template  WHERE is_preset = 1 AND creator_id = 0;
//         DELETE FROM alarm_condition_template    WHERE is_preset = 1 AND creator_id = 0;
```

| 问题 | 说明 |
| --- | --- |
| **误删用户数据** | contract ⑪ 明确「`isPreset=1` 的预置模板**允许修改**」。用户改过的预置模板，`creator_id` 仍为 `0`、`is_preset` 仍为 `1` → `down()` **连同用户的修改一起删除**。文件 docblock 自称「不动用户数据」——**这句是错的** |
| **留下悬挂引用** | `down()` 不清理 `alarm_policy.condition_template_id`。`migrate:rollback --step=1` 只回滚 seed，表还在 ⇒ **一批指向已删除模板的 `condition_template_id`**。而 DDL 设计（schema.sql:30-31）明确依赖「删除前有 409 保护」来维持这个不变量——现在不变量破了，409 保护挡不住一个已经发生的悬挂引用 |
| **`up()` 重跑会"复活"预置** | 若用户把预置模板改名，原 `name` 腾空 → 重跑 `INSERT IGNORE` 会**再插一条同名预置**，出现 7 条预置条件模板 |

**建议**：`down()` 改为按 `up()` 插入的**精确 name 列表**删除，并在同一事务内把 `alarm_policy.condition_template_id` 里命中这些 id 的行**重置为 0**（回到契约定义的「未使用」态）。

### ⚪ M-05 seed 迁移的部分应用分析 —— **通过**

`000700` 的两条 `INSERT IGNORE` 都在同一迁移内。若第二条失败，第一条已提交 → 迁移不记账 → 重跑 → `INSERT IGNORE` 幂等补齐 ✓。**不会产生半播种的持久损坏**。
唯一残留风险是 §3.2 第 10 条（`INSERT IGNORE` 可能静默跳过违反 CHECK 的行）——**待 V13 本地确认**。

### ⚠️ M-06 迁移与数据的中间态分析

**6 个建表迁移按表拆分，会不会引入部分应用的中间态？**

| 场景 | 结果 | 判定 |
| --- | --- | --- |
| `migrate` 在第 3 个迁移失败 | `migrations` 表只记账前 2 个，其余待执行；重试从 000300 继续 | ✅ **记账一致，无损坏** |
| 中间态的应用行为 | 此刻 `alarm_policy` + `alarm_policy_condition` 存在，3 张模板表 + `alarm_history` 不存在 | ⚠️ 应用启动若不检查迁移状态，会在**缺表**上跑查询 → 500 而非优雅降级。**属应用健壮性问题，不在本次审查范围**，但建议加一个「迁移版本」启动检查 |
| `migrate:rollback` 全部 | 逆序 000700→000100 | ✅ **FK 顺序安全**。两组 FK 对（000100↔000200）、（000400↔000500）在文件序上都是"父在子前"，逆序 drop 即"子先父后" ✓。**即使分两个 batch 执行也安全**（batch1={100,200,300}, batch2={400..700} 各自逆序仍满足） |
| `migrate:rollback --step=N` | —— | ⚠️ **N=2 即删除全部 `alarm_history`**；N=4 即删除全部通知模板及接收人。`--step` 无确认、无备份。**建议在 README 明确警告 `--step` 的破坏性** |

---

## 5. 迁移 vs schema.sql 一致性比对

### 5.1 比对方法（可复现）

对 `schema.sql` 的 6 个 `CREATE TABLE ... ENGINE` 块，与 7 个迁移 heredoc 中的 `CREATE TABLE` 块，分别做：去 `--` 行注释 → 逐行 trim → 折叠连续空白 → 丢弃空行 → **按行有序比对**。

```
schema tables: 6 ['alarm_condition_template', 'alarm_history', 'alarm_notification_receiver',
                  'alarm_notification_template', 'alarm_policy', 'alarm_policy_condition']
mig   tables: 6 [同上]
missing in migrations: []          extra in migrations: []
[SAME] alarm_condition_template   (18 lines)
[SAME] alarm_history              (42 lines)
[SAME] alarm_notification_receiver(13 lines)
[SAME] alarm_notification_template(16 lines)
[SAME] alarm_policy               (35 lines)
[SAME] alarm_policy_condition     (27 lines)
tables with structural diff: 0
```

**预置数据也已逐字核对**：`000700` 的 9 条 INSERT（3 通知 + 6 条件模板，含全部中文 remark 与 conditions JSON 字符串）与 `schema.sql:337-378` **逐字节一致**。

### 5.2 差异表

| 对比项 | schema.sql | 7 个迁移 | 差异 |
| --- | --- | --- | --- |
| 表数量 | 6 | 6 | **0** |
| 列名 / 顺序 | — | — | **0** |
| 列类型（含精度/unsigned） | — | — | **0** |
| 可空性 | — | — | **0** |
| DEFAULT（含 `DEFAULT NULL` / `DEFAULT CURRENT_TIMESTAMP` / `ON UPDATE`） | — | — | **0** |
| 列级 `COMMENT` | — | — | **0**（迁移 docblock 声称保留，实测确实保留 ✓） |
| 字符集 / 排序规则 / 引擎 / 表注释 | `utf8mb4` / `utf8mb4_0900_ai_ci` / InnoDB | 同 | **0** |
| UNIQUE KEY | 6 | 6 | **0** |
| 普通 KEY | 18 | 18 | **0** |
| PRIMARY KEY | 6 | 6 | **0** |
| FOREIGN KEY + 引用动作 | 2 | 2 | **0** |
| CHECK（名称 + 表达式） | 29 | 29 | **0** |
| 预置数据 INSERT | 9 行 | 9 行 | **0** |
| **`SET NAMES utf8mb4`** | 有（:53） | **无** | ⚠️ 1 处（见下） |
| **`SET FOREIGN_KEY_CHECKS = 0/1`** | 有（:54/:328） | **无** | ⚠️ 1 处（见 M-03） |
| **`--` 行注释** | 大量设计说明 | 剥离 | ✅ 预期内，非结构差异 |

### 5.3 数量核对（用户声称 vs 实测）

| 项目 | 用户/文档声称 | 实测 | 判定 |
| --- | --- | --- | --- |
| 表 | 6 | 6 | ✅ |
| CHECK | 29 | **29**（8/6/4/3/1/7） | ✅ |
| 索引 | 30 | **30**（24 二级 + 6 PRIMARY） | ✅ |
| 外键 | 2 | **2**（`fk_condition_policy`、`fk_receiver_template`） | ✅ |
| 迁移文件 | 7 | **7** | ✅ |
| `down()` 存在 | — | **7/7** | ✅ |

逐表 CHECK 分布明细：

| 表 | CHECK | 二级索引 | PK | FK |
| --- | --- | --- | --- | --- |
| `alarm_policy` | 8 | 7 | 1 | 0 |
| `alarm_policy_condition` | 6 | 3 | 1 | 1 |
| `alarm_condition_template` | 4 | 3 | 1 | 0 |
| `alarm_notification_template` | 3 | 3 | 1 | 0 |
| `alarm_notification_receiver` | 1 | 3 | 1 | 1 |
| `alarm_history` | 7 | 5 | 1 | 0 |
| **合计** | **29** | **24** | **6** | **2** |

### 5.4 唯一的非结构性差异

**`SET NAMES utf8mb4`（schema.sql:53）在迁移中缺失。**

- **影响面**：极小。`Db::statement()` 走 PDO 预处理语句，连接字符集由 `config/autoload/databases.php` 的 `charset`（通常 `utf8mb4`）决定；`SET NAMES` 只影响**该 mysql 客户端会话**。
- **但存在一个真实风险**：`schema.sql` 是通过 `mysql < schema.sql` 执行的，其正确性**依赖这一行**。若运维在 `LANG=C` / `POSIX` locale 的终端里执行，**`SET NAMES utf8mb4` 是唯一保证中文 remark / 预置模板名正确落库的手段**。这一行必须保留在 schema.sql 里 ✓（它在那里）。
- **结论**：✅ **不构成缺陷**。记录在此仅为说明「迁移不需要它」的理由，避免后人误加。

### 5.5 一致性小结

> ✅ **7 个迁移拼接起来与 schema.sql 结构上完全等价**。列的类型、长度、可空、默认值、索引、外键、CHECK、预置数据——**逐条比对 0 差异**。
> 迁移文件 docblock 声称的「与 schema.sql 逐字一致」**属实**。
> **但是**——结构等价 ≠ 迁移安全。M-02 ~ M-04 的问题**全部在 `up()/down()` 的行为层面**，与 DDL 内容无关，因此**不落在本节的比对范围内**。这正是「7 个迁移逐字抄对了，但仍然会毁数据」的地方。

---

## 6. 索引与外键

### 6.1 外键 ON DELETE 行为 vs 业务删除语义 —— **无冲突**

| 外键 | 引用 | 动作 | 业务删除语义 | 判定 |
| --- | --- | --- | --- | --- |
| `fk_condition_policy` | `alarm_policy_condition.policy_id` → `alarm_policy.id` | `ON DELETE CASCADE ON UPDATE CASCADE` | contract §3.1⑤：「正常删除：`alarm_policy_condition` 随主记录级联删除」 | ✅ **一致** |
| `fk_receiver_template` | `alarm_notification_receiver.template_id` → `alarm_notification_template.id` | `ON DELETE CASCADE ON UPDATE CASCADE` | schema.sql:240「删除模板时随模板级联物理删除」 | ✅ **一致** |

**软删除/硬删除语义无冲突**：schema.sql:15-23 的设计取舍（策略/模板/接收人**硬删除 + 物理级联**；`alarm_history` **永不删除**）与 contract §3.1⑤、H5 完全吻合。**唯一键不带 `is_deleted` 维度**的决策也因此自洽（硬删除后 name 可复用）。

**⚠️ 一处无害但值得清理的冗余**：两条 FK 都有 `ON UPDATE CASCADE`，而父表主键是 `BIGINT UNSIGNED AUTO_INCREMENT`——**id 实际上永不改变**。`ON UPDATE CASCADE` 在这里不产生任何作用，却带来一个真实（虽小）的隐患：它让 `UPDATE alarm_policy SET id=5 WHERE id=1` 变成一次**静默的重新挂载**，把 `alarm_policy_condition` 悄悄转移到另一个策略下。建议删掉 `ON UPDATE CASCADE`（默认 `RESTRICT` 恰好能挡住这种误操作）。

**⚠️ 引用完整性最大的缺口**：`alarm_policy.condition_template_id` **有索引 `idx_policy_condition_template_id` 却没有 FK**，而 contract T5（模板被引用则禁止删除）**只由应用层的 409 保证**。根因是 `0 = 未使用` 这个哨兵值挡住了 FK。后果与 D-02 同构：**一旦应用层有 bug 或 409 检查被绕过，删除模板就会留下永久悬挂引用，DB 层一声不吭。**

> **建议（需权衡，非单方面决定）**：把 `condition_template_id` 的哨兵从 `0` 改为 `NULL`，然后加 `FOREIGN KEY (condition_template_id) REFERENCES alarm_condition_template(id) ON DELETE RESTRICT`。代价是 contract 侧 `conditionTemplateId: 0 表示未使用` 的 API 约定要改（可在 Presenter 层做 0↔NULL 映射，API 不变）。**这条需要契约方拍板，不应由数据层单方面改。**

### 6.2 冗余索引（完全被其他索引的左前缀覆盖）

| 冗余索引 | 被谁覆盖 | 代价 | 证据 |
| --- | --- | --- | --- |
| `idx_condition_policy_id (policy_id)` | `uk_condition_policy_sort (policy_id, sort)` 的左前缀 | 多一棵完整 B 树，每次条件增删都维护 | schema.sql:142 注释原文：「其最左前缀已覆盖按 policy_id 查询详情的场景」——**紧接着第 146 行又建了这条完全被覆盖的索引**，自相矛盾 |
| `idx_receiver_template_channel (template_id, channel)` | `uk_receiver_template_channel_contact (template_id, channel, contact)` 的左前缀 | 同上 | receiver 表 3 个二级索引里有 1 个是纯浪费 |

**两条都是 100% 冗余**（左前缀完全一致，无任何额外过滤能力）。在 `alarm_policy_condition` 上尤其值得删——该表在 PUT 时是**全量先删后插**，索引维护成本直接乘以条件条数。

### 6.3 `idx_history_triggered_id (triggered_at, id)` —— 无害但也无益

`id` 是聚簇主键，**InnoDB 会自动把主键追加到每一个二级索引的末尾**。因此 `(triggered_at, id)` 物理上等价于 `(triggered_at)` + 隐式 PK。

- **成本**：0（不会多建一棵树，MySQL 建的就是那棵树）
- **收益**：0（末尾那列本来就是隐式存在的）
- **判定**：⚪ **低优先级 / 无害**。显式写出来能表达意图，可保留。**不夸大**——它不是缺陷，只是冗余的声明。

### 6.4 方向错误的索引 + 未被服务的默认排序

**contract §0.3 明确规定**：「排序固定为 `created_at DESC, id DESC`」，**且不开放排序参数**。
**但 `schema.sql:101-102` 建了 `idx_policy_updated_at (updated_at)`**，注释写「支持按更新时间倒序的『最近变更』场景」。

| 问题 | 说明 |
| --- | --- |
| **无读路径** | contract v1.0 **没有任何端点**按 `updated_at` 排序。「最近变更」不是本模块的端点 |
| **写放大** | `updated_at` 有 `ON UPDATE CURRENT_TIMESTAMP` ⇒ **每次 UPDATE 策略都会重写这个索引**。策略编辑是高频写操作 |
| **schema.sql 注释里的一个事实错误** | 注释称「该排序由 `idx_policy_updated_at` / InnoDB 聚簇主键顺序兜底」。**`updated_at` 索引不可能为 `created_at` 排序兜底**——列名都不同。这条注释是错的，会误导后续维护者以为默认排序有索引支撑 |

**`GET /policies` 默认排序的真实成本**：

| 查询条件 | 能否用上 `idx_policy_status_level_created (status, level, created_at)` | 实际 |
| --- | --- | --- |
| 无筛选（默认列表页） | ❌ `status`/`level` 都无等值前缀 | **filesort** |
| 仅 `status=1` | ❌ `level` 无等值前缀，索引第 2 列悬空 | **filesort** |
| `status=1 AND level=1` | ✅（InnoDB 会把 PK 追加为第 4 列，物理等价 `(status, level, created_at, id)`） | 反向扫描，无 filesort |

**修复建议**：`KEY idx_policy_created_id (created_at, id)`（或直接信任聚簇顺序——`id` 是 `AUTO_INCREMENT`，而 `created_at` 单调性只在同一秒内成立，**不能**依赖聚簇顺序）。同时删掉 `idx_policy_updated_at` 或改名为反映真实用途。
**严重度校准**：`alarm_policy` 按 schema.sql:45 自述是「百~千级小表」，filesort 代价可忽略。**真正的缺陷是那条错误的注释和无读路径的写放大，不是排序性能。**

### 6.5 缺失索引 / 未披露的全表扫

schema.sql:42-50 主动披露了 **2 处**预期内的全表扫（两处 JSON 检索）。**实际还有 2 处未披露**：

| # | 查询 | 端点 | 预期 EXPLAIN | 是否披露 |
| --- | --- | --- | --- | --- |
| 1 | `SELECT ... WHERE JSON_CONTAINS(notification_template_ids, ...)` | ⑯ 删除通知模板 | `type: ALL` | ✅ 已披露（:42-46） |
| 2 | `channels` JSON 渠道过滤 | ⑬ 通知模板列表 | `type: ALL` | ✅ 已披露（:47-50） |
| **3** | **`WHERE policy_name LIKE '%x%'`** | **⑰ 历史列表 `keyword`** | **`type: ALL`** | ❌ **未披露** |
| **4** | **`WHERE name LIKE '%x%' OR remark LIKE '%x%'`** | **① 策略列表 `keyword`** | **`type: ALL`** | ❌ **未披露** |

**为什么 #3 才是真正的问题**：schema.sql:45 为 `alarm_policy` 的全表扫做了规模假设（「本版本假设 alarm_policy 为小表（百~千级）可接受」）。**但 `alarm_history` 的规模假设是相反的**——schema.sql:272 与 :326 明确它**「永不删除」「本模块不提供删除端点」**，是一条**单调增长**的表。**在一条只增不减的表上做无界全表扫，且这个风险在任何注释里都没有被提及**，是本次索引审查中最值得指出的一条。

- `keyword` 支持匹配 `policyName` / `objectName` / `metricNameCn` 三个字段，`LIKE '%x%'` **无法用索引**（前导通配符）
- 缓解手段（按侵入性排序）：① 限定 `keyword` 必带 `startTime/endTime`；② 加 `FULLTEXT` 索引（中文需 ngram parser，8.0 内置）；③ 按 `triggered_at` 做时间分区/归档；④ 至少**在 schema.sql 里把这条全表扫披露出来**，让容量规划看见它
- 配套索引 `idx_history_object (object_id)` 的注释写「**冗余索引：未来按对象/指标反查**」——但 contract ⑰ **没有 `objectId` 筛选参数，v1.0 无任何端点按 object 反查**。这是一条**为不存在的查询、在一条只增不减的表上、每次插入都要维护**的索引。与 `idx_policy_updated_at` 一起，构成 **2 条无 v1.0 读路径的写放大索引**。

### 6.6 索引总体判定

| 分类 | 数量 | 明细 |
| --- | --- | --- |
| ✅ 合理且有读路径 | 17 | 含 4 条历史表复合索引、6 条唯一键 |
| ❌ 完全冗余（100%） | **2** | `idx_condition_policy_id`、`idx_receiver_template_channel` |
| ⚠️ 无 v1.0 读路径（写放大） | **2** | `idx_history_object`、`idx_policy_updated_at` |
| ⚪ 无害冗余声明（0 成本） | 1 | `idx_history_triggered_id` 的尾列 `id` |
| 📉 事实错误的注释 | 1 | schema.sql:93-94 关于 `updated_at` 兜底 `created_at` 排序 |
| 📖 未披露的全表扫 | **2** | 历史列表 keyword、策略列表 keyword |

**24 条二级索引中，真正有问题的 4 条（2 完全冗余 + 2 无读路径），占比 17%。** 唯一键设计（`uk_policy_name` / `uk_condition_policy_sort` / 两个 `*_template_name` / `uk_receiver_*`）**全部合理**，与契约的唯一性要求一一对应 ✓。

---

## 7. 枚举漂移专项

### 7.1 标量枚举：contract → DDL **零漂移**（13/13 通过）

| contract 枚举 | 契约取值 | 对应 CHECK | 位置 | 判定 |
| --- | --- | --- | --- | --- |
| §1.1 `monitorType` | 1,2,3,4,5 | `ck_policy_monitor_type` | `alarm_policy` | ✅ 取值一致（联动缺失见 D-04） |
| §1.2 `policyType` | 1,2,3,4 | `ck_policy_policy_type` | `alarm_policy` | ✅ |
| §1.2 `policyType`（模板侧） | 1,2,3,4 | `ck_condition_template_policy_type` | `alarm_condition_template` | ✅ |
| §1.3 `level` | 1,2,3 | `ck_policy_level` | `alarm_policy` | ✅ |
| §1.3 `level` | 1,2,3 | `ck_condition_level` | `alarm_policy_condition` | ✅ |
| §1.3 `level` | 1,2,3 | `ck_history_level` | `alarm_history` | ✅ |
| §1.4 `period` | 1,5,10,30,60 | `ck_condition_period` | `alarm_policy_condition` | ✅ |
| §1.4 `period` | 1,5,10,30,60 | `ck_history_period` | `alarm_history` | ✅ |
| §1.5 `operator` | `> >= < <= == !=` | `ck_condition_operator` | `alarm_policy_condition` | ✅ |
| §1.5 `operator` | `> >= < <= == !=` | `ck_history_operator` | `alarm_history` | ✅ |
| §1.6 `frequency` | 0,5,15,30,60,180,360,720,1440（**9 个，含扩展值 0**） | `ck_condition_frequency` | `alarm_policy_condition` | ✅ **契约 §1.6 特别声明「DB CHECK 约束 `ck_condition_frequency` 覆盖全部 9 个值」——属实** |
| §1.7 `objectType` | 1,2,3,4 | `ck_policy_object_type` | `alarm_policy` | ✅ |
| §1.7 `objectType` | 1,2,3,4 | `ck_history_object_type` | `alarm_history` | ✅ |
| §1.8 `conditionLogic` | 1,2 | `ck_policy_condition_logic` | `alarm_policy` | ✅ |
| §1.9 policy `status` | 0,1 | `ck_policy_status` | `alarm_policy` | ✅ |
| §1.10 history `status` | 1,2,3,4 | `ck_history_status` | `alarm_history` | ✅ |
| §1.11 `channel` | 1,2,3,4,5 | `ck_receiver_channel` | `alarm_notification_receiver` | ✅ |
| §1.12 `handleAction` | handle,ignore,recover | `ck_history_handle_action` | `alarm_history` | ✅ |
| §2.1 `sort` | 1-4 | `ck_condition_sort` | `alarm_policy_condition` | ✅ |
| §2.1 `continuity` | 1-10 | `ck_condition_continuity` | `alarm_policy_condition` | ✅ |
| §2.1 `continuity` | 1-10 | `ck_history_continuity` | `alarm_history` | ✅ |

**21 组逐条比对，0 处漂移。** 含 contract §1.6 那条特别声明的 9 值 frequency，也完全一致。**DDL 的标量枚举纪律是可靠的。**

### 7.2 JSON 内的枚举副本：**100% 未受约束**（系统性漂移）

| JSON 列 | 内含的枚举副本 | 契约取值 | 是否有 CHECK |
| --- | --- | --- | --- |
| `alarm_policy.object_filters[].operator` | §1.5 六值 | `> >= < <= == !=` | ❌ **无** |
| `alarm_policy.object_filters[].matchType` | include / exclude | | ❌ **无** |
| `alarm_policy.notification_template_ids[]` | 模板 id | 存在性由 P13 保证 | ❌ **无** |
| `alarm_policy.object_ids[]` / `object_group_ids[]` | 实例/分组 id | int | ❌ **无** |
| `alarm_condition_template.conditions[].operator` | §1.5 六值 | | ❌ **无**（且与 `alarm_policy_condition.operator` 同一份枚举，同一个 CHECK **管不到这里**） |
| `alarm_condition_template.conditions[].period` | §1.4 五值 | | ❌ **无** |
| `alarm_condition_template.conditions[].continuity` | 1-10 | | ❌ **无** |
| `alarm_condition_template.conditions[].level` | §1.3 | | ❌ **无** |
| `alarm_condition_template.conditions[].frequency` | §1.6 九值 | | ❌ **无** |
| `alarm_condition_template.conditions[].sort` | 1-4 | | ❌ **无** |
| `alarm_notification_template.channels[].channel` | §1.11 五值 | | ❌ **无**（与 `ck_receiver_channel` 同一枚举，同一个 CHECK **管不到这里**） |
| `alarm_notification_template.channels[].silenceTime` | 0-1440 | | ❌ **无** |

**这是本次审查最重要的结构性发现**：
> 同一个枚举在项目里存在**多个存储副本**（标量列 + JSON 内），而 CHECK 只覆盖了标量副本。
> 最典型的是 **`operator`（6 值）** 和 **`channel`（5 值）**——契约里它们是**全局字典**，DDL 里却有**两个互不相干的存储位置**，其中一个完全裸奔。
> **`alarm_notification_receiver` 存在的全部意义就是给 `channel` 提供一个可约束的标量副本**（schema.sql:231-240 说明了它是为「模板内去重与格式校验」而存在的冗余表）——**但 `channels` JSON 才是权威数据源**（contract §2.8：「读模板时**一律以 channels 为准**」）。**于是「被约束的那个不是权威的那个」**——这是本模块数据约束设计上最核心的错配。

---

## 8. 修复优先级建议（不含具体 patch，供实现方决策）

| 优先级 | 建议 | 涉及 | 成本 | 收益 |
| --- | --- | --- | --- | --- |
| **1** | `schema.sql:10` 版本下限 `8.0.13` → `8.0.16`，内联"8.0.16 前 CHECK 静默忽略" | 1 行 | 极低 | **堵住一整类静默失效** |
| **2** | 删掉 6 个 `up()` 开头的 `DROP TABLE IF EXISTS` | 6 行 | 极低 | **堵住静默清库（含全部告警历史）** |
| **3** | 给 2 个 `NOT NULL` JSON 列加 `CHECK (JSON_TYPE(x)='ARRAY' AND JSON_LENGTH(x) BETWEEN ...)` | 2 条 | 低 | 堵住 D-03 的 4 条路径 |
| **4** | 补 `CHECK`：`monitorType↔policyType` 联动、`objectType↔JSON` 对应、`status↔handle_action`、`metric_namespace`/`contact` 非空 | ~6 条 | 低 | 堵住 D-01/D-04/D-08/D-09/D-11（**均为纯漏写**） |
| **5** | 删 `sort`/`level`/`frequency` 的 DEFAULT，或修正 contract §0.6 那句错误的安全承诺 | 3 处 | 低 | 堵住 D-07 |
| **6** | 删 2 条 100% 冗余索引 + 2 条无读路径索引；加 `(created_at, id)`；修正 schema.sql:93-94 的错误注释 | 4 删 1 加 | 低 | 减写放大、修正文档误导 |
| **7** | 修 `000700` 的 `down()`：按精确 name 删 + 同事务重置 `condition_template_id` 为 0 | 1 方法 | 中 | 消除悬挂引用 + 停止误删用户修改 |
| **8** | 在 schema.sql 里**披露**两处未记录的全表扫（历史/策略 keyword LIKE） | 2 行 | 极低 | 让容量规划看见 append-only 表的扫描风险 |
| **9** | 契约方裁决：`monitorType` 3/4/5 是否允许落库（影响建议 4 的写法）；`name` 是否大小写敏感、是否入库前 TRIM | 契约 | 中 | 消除 §2 中的两处歧义 |

---

## 9. 用户本地需执行的验证命令清单

> ⚠️ **本次审查未执行任何一条以下命令**（沙箱无 MySQL / 无 PHP）。以下全部是给**有真实 MySQL ≥ 8.0.16 环境**的用户执行的复核清单。
> 请在**一次性测试库**上执行（尤其 V11 ~ V14 会写数据）。

```bash
# ============ 阶段 0：建库 ============
# 强烈建议用独立测试库，不要在开发/生产库上跑本清单
mysql -u<user> -p -e "DROP DATABASE IF EXISTS alarm_verify; CREATE DATABASE alarm_verify DEFAULT CHARACTER SET utf8mb4;"
```

```sql
-- ============ V0【最高优先级】版本门槛 ============
-- 若返回 < 8.0.16，本报告 §1 的全部结论都会真实发生，且没有任何错误信号
SELECT VERSION(), @@version_comment;

-- ============ V1 CHECK 总数：期望 29 ============
-- 若返回 0，说明 MySQL < 8.0.16，29 条 CHECK 被静默忽略，数据完整性形同虚设
SELECT COUNT(*) AS alive_checks
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE();

-- ============ V2 逐条列出 29 条 CHECK（人工比对 schema.sql）============
SELECT TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, CONSTRAINT_NAME;
-- 期望 29 行；分布应为 alarm_policy=8, alarm_policy_condition=6,
-- alarm_condition_template=4, alarm_notification_template=3,
-- alarm_notification_receiver=1, alarm_history=7

-- ============ V3 分布核对（应为 8/6/4/3/1/7 = 29）============
SELECT TABLE_NAME, COUNT(*) AS n
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
GROUP BY TABLE_NAME ORDER BY n DESC;

-- ============ V4 索引总数：含 PRIMARY 期望 30；不含 PRIMARY 期望 24 ============
SELECT COUNT(*) AS idx_with_pk
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'alarm%';
SELECT COUNT(*) AS idx_without_pk
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'alarm%' AND INDEX_NAME <> 'PRIMARY';

-- ============ V5 冗余索引自查：确认 2 组左前缀重复 ============
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('alarm_policy_condition','alarm_notification_receiver')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
-- 人工确认：
--   alarm_policy_condition: uk_condition_policy_sort(policy_id,sort) 与 idx_condition_policy_id(policy_id) 左前缀重复  → §6.2
--   alarm_notification_receiver: uk_receiver_template_channel_contact(template_id,channel,contact) 与
--                                idx_receiver_template_channel(template_id,channel) 左前缀重复                    → §6.2

-- ============ V6 外键：期望 2 行，均为 CASCADE ============
SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME,
       k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       r.UPDATE_RULE, r.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL;

-- ============ V7 迁移 vs schema.sql 等价性：逐表导出与 schema.sql 逐字比对 ============
-- 先用 schema.sql 建库
mysql -u<user> -p alarm_verify < docs/alarm/schema.sql
mysql -u<user> -p alarm_verify -e "SHOW CREATE TABLE alarm_policy\G SHOW CREATE TABLE alarm_policy_condition\G SHOW CREATE TABLE alarm_condition_template\G SHOW CREATE TABLE alarm_notification_template\G SHOW CREATE TABLE alarm_notification_receiver\G SHOW CREATE TABLE alarm_history\G" > /tmp/from_schema.txt

# 再用迁移建一个库（假设 hyperf 命令可用）
mysql -u<user> -p -e "DROP DATABASE IF EXISTS alarm_mig; CREATE DATABASE alarm_mig DEFAULT CHARACTER SET utf8mb4;"
cd server && php bin/hyperf.php migrate   # 按项目实际的 .env 配置执行
mysql -u<user> -p alarm_mig -e "SHOW CREATE TABLE alarm_policy\G ... \G" > /tmp/from_migration.txt

diff /tmp/from_schema.txt /tmp/from_migration.txt && echo "✅ 6 表 DDL 完全一致（本次静态审查预测：无差异）"

-- ============ V8 预置数据核对：期望 3 + 6 = 9 行 ============
SELECT 'alarm_notification_template' AS t, COUNT(*) AS n FROM alarm_notification_template
UNION ALL SELECT 'alarm_condition_template', COUNT(*) FROM alarm_condition_template;
SELECT name, is_preset, creator_id, creator_name FROM alarm_notification_template
UNION ALL SELECT name, is_preset, creator_id, creator_name FROM alarm_condition_template
ORDER BY name;
```

```sql
-- ============ V9 脏数据路径实测（本次审查判定"DB 会放行"，请逐条确认）============
-- 逐条单独执行，观察是否报错。全部预期【不报错】= 脏数据落库。
-- 若某条报错了，说明本报告该条判断偏保守，请在结论中标注。

-- D-01: object JSON 无约束
UPDATE alarm_policy SET object_type = 2, object_ids = NULL WHERE id = 1;
UPDATE alarm_policy SET object_ids = '{"a":1}'  WHERE id = 1;          -- 期望：放行
UPDATE alarm_policy SET object_ids = '["abc"]'   WHERE id = 1;          -- 期望：放行（字符串元素）
UPDATE alarm_policy SET object_filters = '[{"key":"r","operator":"GT","values":[],"matchType":"maybe"}]' WHERE id = 1;

-- D-02: notificationTemplateIds 无约束
UPDATE alarm_policy SET notification_template_ids = JSON_ARRAY(1,2,3,4,5,6,7) WHERE id = 1;
UPDATE alarm_policy SET notification_template_ids = '["3"]' WHERE id = 1;   -- 期望：放行，且见 V12
UPDATE alarm_policy SET notification_template_ids = 'null'  WHERE id = 1;

-- D-03: JSON NOT NULL 挡不住 JSON 字面量 null
INSERT INTO alarm_condition_template (name, policy_type, conditions) VALUES ('空模板', 1, 'null');
INSERT INTO alarm_condition_template (name, policy_type, conditions) VALUES ('空数组', 1, '[]');
INSERT INTO alarm_notification_template (name, channels) VALUES ('结构错', '{"channel":1}');
-- 验证 JSON null 不是 SQL NULL：
SELECT name, JSON_TYPE(conditions) AS t FROM alarm_condition_template WHERE name IN ('空模板','空数组');
-- 期望 t = 'NULL' 和 'ARRAY'；两条都成功插入 = NOT NULL 未拦住

-- D-04: monitorType/policyType 联动
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('非法组合', 3, 4);  -- 契约：不可选
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('颠倒', 2, 2);

-- D-05: 条件条数下界 1 —— 0 条条件的合法策略
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('空策略', 1, 2);
SELECT p.id, p.name, COUNT(c.id) AS cond_cnt
FROM alarm_policy p LEFT JOIN alarm_policy_condition c ON c.policy_id = p.id
WHERE p.name = '空策略' GROUP BY p.id, p.name;   -- 期望 cond_cnt = 0，且无任何报错

-- D-06: 派生 level 漂移 + sort 不连续
INSERT INTO alarm_policy (name, monitor_type, policy_type, level) VALUES ('等级漂移', 1, 2, 1);
SET @pid = (SELECT id FROM alarm_policy WHERE name='等级漂移');
INSERT INTO alarm_policy_condition (policy_id, metric_namespace, metric_name, operator, threshold, period, continuity, level)
VALUES (@pid, 'CVM', 'CpuUtilizationRate', '>', 80, 5, 3, 3);
SELECT p.level AS policy_level, MIN(c.level) AS real_min, p.level = MIN(c.level) AS consistent
FROM alarm_policy p JOIN alarm_policy_condition c ON c.policy_id = p.id
WHERE p.id = @pid GROUP BY p.level;   -- 期望 policy_level=1, real_min=3, consistent=0

INSERT INTO alarm_policy_condition (policy_id, sort, metric_namespace, metric_name, operator, threshold, period, continuity, level)
VALUES (@pid, 1, 'CVM','CpuUtilizationRate','>',80,5,3,3), (@pid, 3, 'CVM','MemoryUsageRate','>',90,5,2,1);
SELECT sort FROM alarm_policy_condition WHERE policy_id=@pid ORDER BY sort;  -- 期望 1,3（缺 2，违反 P5）

-- D-07: DEFAULT 吞掉 P10 必填字段
INSERT INTO alarm_policy_condition (policy_id, metric_namespace, metric_name, operator, threshold, period, continuity)
VALUES (@pid, 'CVM', 'CpuUtilizationRate', '>', 80, 5, 3);
SELECT sort, level, frequency FROM alarm_policy_condition
WHERE policy_id=@pid AND metric_namespace='CVM' AND metric_name='CpuUtilizationRate' AND id > (SELECT MAX(id) FROM alarm_policy_condition)-1;
-- 期望：sort=1, level=3, frequency=0  ← P10 要求显式传值，实际静默补默认值

-- D-08: 指标列允许空串
INSERT INTO alarm_policy_condition (policy_id, metric_namespace, metric_name, operator, threshold, period, continuity, level, frequency)
VALUES (@pid, '', '', '>', 0, 5, 1, 3, 0);

-- D-09: 历史状态机不一致
INSERT INTO alarm_history (policy_id, level, triggered_at, content) VALUES (1, 1, NOW(), 'x');
UPDATE alarm_history SET status=1, handle_action='handle', handled_at=NOW(), handler_name='李四';
UPDATE alarm_history SET status=4, handle_action=NULL WHERE id=1;
UPDATE alarm_history SET recovered_at=NOW(), status=1 WHERE id=1;
UPDATE alarm_history SET duration=999999 WHERE id=1;
UPDATE alarm_history SET status=2, handle_action='recover' WHERE id=1;   -- 映射错误：recover 应配 status=4

-- D-10: 排序规则导致的看不见的重复
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('CPU监控', 1, 2);
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('CPU监控 ', 1, 2);  -- 期望：两条都成功
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('policy', 1, 2);
INSERT INTO alarm_policy (name, monitor_type, policy_type) VALUES ('POLICY', 1, 2);   -- 期望：第二条报 1062（大小写不敏感）

-- D-11: contact 空串
INSERT INTO alarm_notification_receiver (template_id, channel, contact) VALUES (1, 1, '');
```

```sql
-- ============ V10 CHECK 恒真性验证（§2.1：3 条 CHECK 永不可能失败）============
CREATE TEMPORARY TABLE t_taut (
  remark VARCHAR(500) NOT NULL DEFAULT '',
  CONSTRAINT ck_t CHECK (CHAR_LENGTH(remark) <= 500)
);
INSERT INTO t_taut (remark) VALUES (REPEAT('x', 500));   -- 必然成功
-- 结论：ck_policy_remark_len / ck_condition_template_remark_len /
--       ck_notification_template_remark_len 三条 CHECK 零增量防御
-- 同样逻辑：VARCHAR(128) 上的 CHAR_LENGTH(TRIM(name)) BETWEEN 1 AND 128，
--       只有 '>= 1' 拦空串，'<= 128' 恒真

-- ============ V11 排序规则语义（D-10 的根因）============
SELECT 'abc' = 'ABC'  COLLATE utf8mb4_0900_ai_ci AS ci_equal,   -- 期望 1（大小写不敏感）
       'abc' = 'abc ' COLLATE utf8mb4_0900_ai_ci AS pad_equal;   -- 期望 0（NO PAD）
SELECT COLLATION_NAME, PAD_ATTRIBUTE FROM information_schema.COLLATIONS
WHERE COLLATION_NAME = 'utf8mb4_0900_ai_ci';                     -- 期望 PAD_ATTRIBUTE = 'NO PAD'

-- ============ V12 JSON_CONTAINS 类型严格性（D-02 的关键证据）============
SELECT JSON_CONTAINS('["3"]', CAST(3 AS JSON)) AS str_vs_num,   -- 期望 0  ← 引用保护被击穿
       JSON_CONTAINS('[3]',   CAST(3 AS JSON)) AS num_vs_num,   -- 期望 1
       JSON_CONTAINS('[3.0]', CAST(3 AS JSON)) AS float_vs_num; -- 期望 0（浮点同样被击穿）
-- 用真实数据复现 409 保护失效：
-- UPDATE alarm_policy SET notification_template_ids='["3"]' WHERE id=1;
-- SELECT id FROM alarm_policy WHERE JSON_CONTAINS(notification_template_ids, CAST(3 AS JSON)) LIMIT 1;
--   → 返回空 = 模板 id=3 可以被删除 = 悬挂引用

-- ============ V13 INSERT IGNORE 遇 CHECK 违规的确切行为（§3.2 第 10 条）============
CREATE TEMPORARY TABLE t_ign (c TINYINT NOT NULL, CONSTRAINT ck CHECK (c IN (1,2)));
INSERT IGNORE INTO t_ign (c) VALUES (1), (9), (2);
SELECT * FROM t_ign;                    -- 观察：只留 1,2？还是留下 9？
SHOW WARNINGS;
-- 若 9 被跳过且无 ERROR → 000700 迁移若遇 CHECK 违规会静默少插预置模板

-- ============ V14 EXPLAIN：验证 §6.4 / §6.5 的索引结论 ============
-- 需先造出若干行数据
EXPLAIN SELECT * FROM alarm_policy ORDER BY created_at DESC, id DESC LIMIT 20;
--  期望：type=ALL + Using filesort（无索引支撑默认排序）→ §6.4
EXPLAIN SELECT * FROM alarm_policy WHERE status=1 AND level=1 ORDER BY created_at DESC, id DESC LIMIT 20;
--  期望：走 idx_policy_status_level_created，filesort 消失
EXPLAIN SELECT * FROM alarm_policy WHERE name LIKE '%CPU%';
--  期望：type=ALL（全表扫，schema.sql 未披露）→ §6.5 #4
EXPLAIN SELECT * FROM alarm_history WHERE policy_name LIKE '%CPU%';
--  期望：type=ALL（在只增不减的表上全表扫，schema.sql 未披露）→ §6.5 #3  【最高风险】
EXPLAIN SELECT * FROM alarm_history WHERE policy_id=1 ORDER BY triggered_at DESC, id DESC LIMIT 20;
--  期望：走 idx_history_policy_triggered
EXPLAIN DELETE FROM alarm_policy WHERE id = 999999;
--  期望：走 PRIMARY；并观察是否连带 DELETE alarm_policy_condition（FK CASCADE）

-- ============ V15 FK 父表 drop 行为（M-02 异常路径 3 的证据）============
-- 请在一次性测试库执行
CREATE DATABASE alarm_fk_probe; USE alarm_fk_probe;
CREATE TABLE p (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB;
CREATE TABLE c (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                pid BIGINT UNSIGNED NOT NULL,
                KEY idx_pid (pid),
                CONSTRAINT fk FOREIGN KEY (pid) REFERENCES p(id) ON DELETE CASCADE) ENGINE=InnoDB;
DROP TABLE IF EXISTS p;
-- 观察是否报错以及错误号：这就是"重跑 000100 迁移"时发生的事
-- 预期【报错】（被 FK 引用，无法 drop）→ 父表迁移重跑是响亮失败（相对安全）
-- 对照：000200/000300/000500/000600 无 FK 保护 → 重跑会【静默清表】
DROP DATABASE alarm_fk_probe;
```

```bash
# ============ V16 迁移可逆性与数据损失（在一次性库执行）============
mysql -u<user> -p -e "DROP DATABASE IF EXISTS alarm_mig2; CREATE DATABASE alarm_mig2 DEFAULT CHARACTER SET utf8mb4;"
# 按项目实际配置让 hyperf 指向 alarm_mig2，然后：
cd server
php bin/hyperf.php migrate
php bin/hyperf.php migrate:status                       # 期望 7 条，全部 Batch: 1
mysql -u<user> -p alarm_mig2 -e "SELECT COUNT(*) FROM alarm_notification_template; SELECT COUNT(*) FROM alarm_condition_template;"
# 期望 3 和 6（预置数据播种成功）

# V16-a 全量回滚：期望逆序 7 条全部成功，且不触发 FK 错误
php bin/hyperf.php migrate:rollback
mysql -u<user> -p alarm_mig2 -e "SHOW TABLES LIKE 'alarm%';"   # 期望：空

# V16-b ⚠️ 警告：--step 破坏性。step=2 会删除全部告警历史
php bin/hyperf.php migrate
php bin/hyperf.php migrate:rollback --step=2      # 000700 + 000600 → alarm_history 被删除
mysql -u<user> -p alarm_mig2 -e "SHOW TABLES LIKE 'alarm%';"   # 期望：无 alarm_history

# V16-c seed down() 的悬挂引用（§M-04）
php bin/hyperf.php migrate
mysql -u<user> -p alarm_mig2 -e "INSERT INTO alarm_policy (name, monitor_type, policy_type, condition_template_id)
                                  VALUES ('引用预置模板', 1, 2, 1);"
php bin/hyperf.php migrate:rollback --step=1       # 只回滚 seed
mysql -u<user> -p alarm_mig2 -e "
  SELECT p.id, p.name, p.condition_template_id, t.id AS template_exists
  FROM alarm_policy p LEFT JOIN alarm_condition_template t ON t.id = p.condition_template_id;"   -- 期望 template_exists = NULL（悬挂）

# V16-d 000700 down() 会删掉"用户改过的预置模板"
php bin/hyperf.php migrate
mysql -u<user> -p alarm_mig2 -e "UPDATE alarm_notification_template SET remark='用户改过了' WHERE name='系统预置-邮件通知';"
php bin/hyperf.php migrate:rollback --step=1
mysql -u<user> -p alarm_mig2 -e "SELECT COUNT(*) AS still_there FROM alarm_notification_template WHERE remark='用户改过了';"  -- 期望 0（用户修改被删）
```

```bash
# ============ V17 最终确认清单 ============
# 全部通过后，可认为本报告 §1 的静态判断在真实库上得到确认：
#  [ ] V0  MySQL >= 8.0.16
#  [ ] V1  CHECK 总数 = 29
#  [ ] V2  29 条 CHECK 名称与表达式与 schema.sql 一致
#  [ ] V3  CHECK 分布 = 8/6/4/3/1/7
#  [ ] V4  索引 = 30（含 PK）/ 24（不含 PK）
#  [ ] V5  确认 2 组冗余索引
#  [ ] V6  外键 = 2，均 CASCADE
#  [ ] V7  schema.sql 与 migrations 的 6 表 DDL diff 为空
#  [ ] V8  预置数据 = 9 行
#  [ ] V9  D-01~D-11 的脏数据路径逐条【确认放行】
#  [ ] V10 确认 3 条 CHECK 恒真
#  [ ] V11 utf8mb4_0900_ai_ci = NO PAD + case-insensitive
#  [ ] V12 JSON_CONTAINS 类型严格 → 409 保护可被击穿
#  [ ] V13 INSERT IGNORE 遇 CHECK 违规的行为
#  [ ] V14 EXPLAIN 确认 2 处未披露全表扫 + 1 处无索引排序
#  [ ] V15 FK 父表 drop 报错（重跑父表迁移会失败）
#  [ ] V16 迁移回滚顺序安全，但 --step 破坏性、seed down() 有悬挂引用与误删
```

---

## 10. 声明

1. **本报告是静态审查。** 沙箱内无 MySQL、无 PHP 客户端，**未执行任何 DDL、未查询任何 information_schema**。所有"实际会不会被拦"的判断均基于 MySQL 8.0 的语法与语义规则推断，**每一条都在 §9 配了可执行的验证命令**。
2. **DDL 等价性结论（§5）是机械比对的产物**，比对脚本逻辑与可复现步骤已给出（§5.1），结论"0 差异"具有较高置信度；但它**未考虑 MySQL 的隐式行为**（如排序规则、隐式类型转换），这部分需要 §9 的 V7/V11 在真实库上确认。
3. **未修改 /workspace 下任何项目文件。** 本次仅新建本报告与任务输出目录下的文件。
4. **未审计** `alarm_history` 的查询性能实测（需要真实数据量与 EXPLAIN ANALYZE），§6.5 的全表扫结论基于 contract 的查询参数与 schema 的索引定义推断。
5. **未审计** 应用层实现（`AlarmPolicyService.php` 等）是否真的落实了 P4/P10/T3/P8/N9 等规则。本报告的立场是：**即使应用层完全正确，DB 层仍应能拦住 §1 列出的脏数据**；反过来，若应用层存在遗漏（据队友 audit-backend 进展，至少有 3 处高危实现缺陷），§1 中的每一条脏数据路径**都会从真实 API 端点被触发**，而不只是手工 SQL。
6. `docs/alarm/deliverable.md:108` 声称此前有独立审查在真实 MySQL 8.0.39 上实测过 DDL。**本报告未引用该声明作为任何结论的依据**，§9 的全部验证仍需独立执行。
