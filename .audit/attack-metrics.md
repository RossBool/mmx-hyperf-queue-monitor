# 对抗式审查报告 — 2026-10-04 指标扩充（10 新指标 + 模板 7）

> 审查者立场：**默认这批新增是错的**。目标是把它们打穿，不是确认它们对。
>
> **环境限制声明（重要）**：本沙箱**无 PHP / Composer / MySQL**。所有涉及 PHP/MySQL 的结论
> 均为**静态推断**，已逐条标注。后端测试失败的结论用「JS 复刻 PHP 语义 + 负对照」给出，
> 模拟器可信度已自证（见 B-2）。前端与三个 `.mjs` 脚本为**实测**。
>
> 审查对象：`docs/alarm/metrics.md`、`server/config/autoload/metrics.php`、
> `server/migrations/2026_10_04_000800_add_traffic_dropout_template.php`、`docs/alarm/schema.sql`、
> `web/src/pages/alarm/components/alarm-enum-options.ts`、`web/src/mocks/*`、
> `scripts/{sync-metrics-backend,gen-mock-metrics,verify-preset-template}.mjs`

---

## 0. 结论摘要

| 级别 | 数量 | 编号 |
| --- | --- | --- |
| **BLOCKER** | 3 | B-1 / B-2 / B-3 |
| **HIGH** | 2 | H-4 / H-5 |
| **MEDIUM** | 4 | M-6 / M-7 / M-8 / M-9 |
| **LOW** | 2 | L-10 / L-11 |
| 攻破数合计 | **11** | |

另记录 **7 条攻不破的攻击线**（第 6 节），其中 3 条是任务书点名要求查的
（`<` 算子合法性、`threshold: 0` 的 falsy 陷阱、`unit: IOPS` 合规性）——**都没打穿**。

**一句话**：字典内容本身是干净的（38×10 字段 md/php/mock 三方逐字段一致、0 条域违规），
**炸的是它的周边**：一个必然报错的迁移、一个断言旧数字的后端测试、一条红的 lint、
两个只会说「通过」却抓不到任何漂移的脚本。

---

## 1. BLOCKER

### B-1 迁移 000800 写了一个**不存在的列** `description` —— 模板 7 在任何环境都插不进去

**我怎么攻**：不看新迁移的自我说明，直接去读**建表迁移**和**上一条种子迁移**，
看这张表真实的列名是什么，再把三份文件并排比。

**证据**（四处，两处是 DDL 两处是同表写入）：

```
server/migrations/2026_09_30_000300_create_alarm_condition_template.php:45
  `remark`       VARCHAR(500)     NOT NULL DEFAULT ''     COMMENT '备注，最长 500',

docs/alarm/schema.sql:178
  `remark`       VARCHAR(500)     NOT NULL DEFAULT ''     COMMENT '备注，最长 500',

server/migrations/2026_09_30_000700_seed_preset_templates.php:37   ← 上一条种子迁移写的是 remark
  (`name`, `remark`, `policy_type`, `conditions`, `is_preset`, `creator_id`, `creator_name`) VALUES

server/migrations/2026_10_04_000800_add_traffic_dropout_template.php:44   ← 本次新增
  (`name`, `description`, `policy_type`, `conditions`, `is_preset`, `creator_id`, `creator_name`) VALUES
```

全仓只有 000800 一个文件用 `description`：

```
$ timeout 25 grep -rn "\`description\`\|\`remark\`" server/migrations/ | grep condition_template -A0
（000300 / 000700 全部为 remark；000800 为 description）
```

**后果**：`INSERT IGNORE INTO alarm_condition_template (name, description, ...)` 引用未知列
→ MySQL `ER_BAD_FIELD_ERROR (1054) / SQLSTATE 42S22`。
`INSERT IGNORE` 只把**数据类**错误（1062 重复键、1264/1366 越界、1265 截断）降级为 warning，
**列名解析错误发生在 prepare 阶段，不在可忽略列表内**，异常照抛。
`up()` 里的 `try/finally` 只会恢复 `FOREIGN_KEY_CHECKS`，异常继续上抛 → **迁移失败，发布卡住，模板 7 永远不落库**。

**判定：攻破（BLOCKER）**

**证据类型：静态推断**（无 MySQL 可跑）。但推断链是「列名字面量比对」，不是判断题：
建表 DDL、schema.sql、同表上一条 INSERT 三处一致地叫 `remark`，只有新迁移叫 `description`。

**附带**：`description` 文本实测 153 字符（我用 python 按行提取），`ck_condition_template_remark_len`
上限 500 —— **长度不是问题**，唯一的问题就是列名。文本里也没有 ASCII 撇号，SQL 单引号转义没问题。

---

### B-2 后端单元测试仍在断言 28 / 8 / 4 / 10 —— **后端测试套件是红的**

**我怎么攻**：字典从 28 变 38，就去找所有**把 28 写进断言**的地方。
`server/README.md:199` 自己写着「指标字典 28 条自检」，顺着找进测试。

**证据**（`server/test/Cases/Unit/AlarmRuleTest.php`）：

```php
615:  public function testMetricDictionaryHasTwentyEightEntries(): void   ← 方法名本身就写着 28
617:      $all = $this->dictionary()->all();
619:      $this->assertCount(28, $all);
...
634:      $this->assertCount(8, $dictionary->filter(1, null, null));   // WEB 8
635:      $this->assertCount(4, $dictionary->filter(3, null, null));   // CLB 4
637:      $this->assertCount(10, $dictionary->filter(2, 'CVM', null));
```

字典真实条数（我实测解析 `metrics.php`）：**CVM 15 / WEB 9 / CLB 5 / MYSQL 9 = 38**。

**怎么证明这 4 条断言必挂**（无 PHP，用 JS 复刻 `MetricDictionary`，并带负对照）：

我逐字照搬了 `src/Service/Metric/MetricDictionary.php:54-70` 的 `filter()` 逻辑
（`all()` 在 `:34-47` 不做任何过滤，直接返回 `require` 进来的数组，所以条数就是数组长度）。
关键纪律：**先拿改动前的 28 条喂给模拟器**，要求它复现测试里写死的每一个数字——
复现不出来就说明是我模拟器写错了，后面的差异不可归因。

```
【负对照】把模拟器跑在「改动前的 28 条」上，必须复现测试里写死的数字：
   ✓ all()              模拟器得 28 / 测试期望 28
   ✓ filter(1)          模拟器得  8 / 测试期望 8
   ✓ filter(3)          模拟器得  4 / 测试期望 4
   ✓ filter(2,'CVM')    模拟器得 10 / 测试期望 10
   ✓ filter(4)          模拟器得  6 / 测试期望 6
   → 模拟器已被证明可信（能复现改动前的全部 5 个数字）

【实测】同一模拟器跑「改动后的 38 条」：
   ✗ all()  (:619 assertCount(28))            实际 38 / 断言 28  → FAIL
   ✗ filter(1) (:634 assertCount(8))          实际  9 / 断言 8   → FAIL
   ✗ filter(3) (:635 assertCount(4))          实际  5 / 断言 4   → FAIL
   ✗ filter(2,'CVM') (:637 assertCount(10))   实际 15 / 断言 10  → FAIL
```

**判定：攻破（BLOCKER）**

**证据类型：模拟实测 + 静态推断**。模拟器做过负对照自证；PHP 未跑。

**这条还证明了一件更重要的事**：`testEveryMetricHasTenFields`（`:623-628`）是遍历式的，
它对新增的 10 条**照样会过**；挂的是那 4 个写死数字的断言。
也就是说 —— **这批改动交付时，PHP 测试套件从未被跑过**。
（这正是「断言了实现给不出的值 = 证明测试从未运行」那条判据的教科书实例。）

**修法**：把 4 个数字改成 38 / 9 / 5 / 15，并补一条 `filter(4)` 的 MYSQL 9 断言
（现在这条根本没被测，MYSQL 是唯一一个 namespace 条数无测试保护的）。

---

### B-3 `pnpm lint` 退出码 1 —— 本次改动引入的 CI 红线

**我怎么攻**：任务书允许前端真跑，就把四件套全跑一遍，不看"应该没问题"。

**证据（实测，真实退出码）**：

```
$ cd /workspace/web && pnpm lint ; echo EXIT=$?
$ eslint .
/workspace/web/src/pages/alarm/policy/components/policy-form.vue
  71:3  error  Expected "alarmMonitorTypeOptions" to come before "alarmPolicyTypeOptions"
        perfectionist/sort-named-imports
✖ 1 problem (1 error, 0 warnings)
[ELIFECYCLE] Command failed with exit code 1.
EXIT=1
```

出错的 import 块（`policy-form.vue:63-74`）：

```ts
63: import {
64:   alarmConditionLogicOptions,
65:   alarmFrequencyOptions,
66:   alarmLevelOptions,
67:   alarmObjectTypeOptions,      ← M 应排在 O 前面
68:   alarmOperatorOptions,
69:   alarmPeriodOptions,
70:   alarmPolicyTypeOptions,
71:   alarmMonitorTypeOptions,     ← 本次为存量 monitorType 兼容新加的，位置错了
72:   alarmSelectableMonitorTypeOptions,
73:   ConditionEditor,
74: } from '../../components'
```

**这是本次改动引入的**：`alarmMonitorTypeOptions` 是 S-14 存量兼容路径新加的 import
（`policy-form.vue:287` 用它取 label），加进去时没重新排序。

**其余三件套实测退出码全 0**：

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `pnpm lint` | **1** | 1 error |
| `pnpm test:run` | 0 | Duration 131.48s |
| `pnpm vue-tsc --noEmit -p tsconfig.app.json` | 0 | 无输出 |
| `pnpm build` | 0 | `✓ built in 46.92s` |

**判定：攻破（BLOCKER）**。构建和类型检查能过，**lint 不能** —— 恰是「绿色基线不是证据」的典型：
只看 build/tsc 会以为一切正常。

---

## 2. HIGH

### H-4 `verify-preset-template.mjs` 只会说「通过」，抓不到任何真正的漂移

**我怎么攻**：任务书要求「尝试让它失败」。我把它复制到 `/tmp`（不改项目文件）、
把绝对路径重定向到副本，然后**故意破坏三处**。

**证据（实测退出码）**：

```
$ node scripts/verify-preset-template.mjs     # 原样跑，全绿
  ✓ 三处一致且全部约束通过
EXIT=0

### T2: 只把迁移里的 policy_type 1 改成 3（CLB），schema 不动
  ✓ 三处一致且全部约束通过
EXIT=0          ← 挂错 namespace 的模板，脚本毫无反应

### T3: 把模板名「流量断流」在迁移+schema 两处都改成「流量断了」
  ✓ 三处一致且全部约束通过
EXIT=0          ← 模板名漂移，脚本毫无反应

### T4: 把 description 文本换成完全不同的一句话
  ✓ 三处一致且全部约束通过
EXIT=0          ← 文案漂移，脚本毫无反应
```

**根因**（`verify-preset-template.mjs:22-27`）：

```js
const start = src.lastIndexOf('[{"sort"', at)
const end   = src.indexOf('\'', at)
return src.slice(start, end)      // ← 只截 conditions 这一段 JSON
```

它比对的范围**只有 `conditions` 那段 JSON 字符串**。列清单、`name`、`policy_type`、
`description` 全部落在 `slice` 之外。

**致命之处**：B-1 那个 `description` 列名错误，就**正好**落在这个脚本的盲区里。
脚本的 docblock 写着「同一条模板的内容出现在三个地方 …… 必须靠脚本保证不漂移」，
但它实际守住的只有 1/6 的内容，而且是**恰好漏掉出错的那一处**。

**判定：攻破（HIGH）**。证据类型：实测。

**修法**：`grab()` 应返回从 `'流量断流',` 开始的整个 VALUES 元组切片，
或至少单独断言列清单 + name + policy_type；并补一条
「迁移的列清单 ⊆ 建表迁移的列清单」的检查（这一条能直接抓住 B-1）。

---

### H-5 `sync-metrics-backend.mjs` 的「交叉校验」只比了名字，字段全裸奔

**我怎么攻**：脚本自称「保证 md ↔ php 零漂移」。那就在 md 里改字段值，看它抓不抓。

**证据（实测退出码）**：

```
$ node mirror/sync.mjs           # 幂等性 OK：10 条全部「已存在，跳过」，php 文件 md5 未变
  ✓ 交叉校验通过：38 个指标逐项一致且顺序一致

### T-A: 把 metrics.md 里 DiskDaysToFull 的 defaultThreshold 从 7 改成 99（php 不动）
  ✓ 交叉校验通过：38 个指标逐项一致且顺序一致
EXIT=0          ← 推荐阈值错了 13 倍，脚本毫无反应

### T-B: 把 metrics.md 里 DiskReadIops 的 unit 从 IOPS 改成 GB/s（php 不动）
  ✓ 交叉校验通过：38 个指标逐项一致且顺序一致
EXIT=0          ← 量纲整个错了，脚本毫无反应
```

**根因**（`sync-metrics-backend.mjs` 尾部校验块）：

```js
const phpRows = [...now.matchAll(/'namespace' => '([A-Z]+)',\s*\n\s*'metricName' => '([A-Za-z0-9]+)'/g)]
                .map((m) => m[1] + "." + m[2])
const onlyMd  = rows.filter((x) => !phpRows.includes(x))   // ← 只比 namespace.metricName 字符串
```

**文案在主动误导**：`✓ 交叉校验通过：38 个指标逐项一致且顺序一致`。
读者会理解成「38 个指标的**每一项内容**都对上了」，实际含义是「38 个**名字**按同样顺序出现」。
脚本 docblock 里那句「『逐项一致 + 顺序一致』是这个副本契约的全部内容」也一样含糊 ——
`metrics.php` 作为「机器可读副本」的价值 100% 在字段值上，而字段值一个都没比。

**判定：攻破（HIGH）**。证据类型：实测。

**注意**：我另外**独立**做了一次真正的 md↔php 逐字段比对（不复用该脚本的逻辑），
结论是**当前 38 条的 10 个字段确实全部一致** —— 所以这是**守卫缺失**，不是**现存数据漂移**。
但守卫缺失意味着下一次漂移照样绿灯。

---

## 3. MEDIUM

### M-6 `DiskDaysToFull` 的 description 宣称自己是字典里**唯一**「越低越糟」的指标 —— 是假的

**我怎么攻**：任务书说它「是全字典唯一越低越糟的指标」。我不用读，用程序数。

**证据（实测）**：

```
$ node /tmp/atk/dict-validate.mjs
「越低越糟」方向（op 为 < 或 <=）的指标：2 条
   CVM.DiskDaysToFull  op=< thr=7 unit=天  [新增]
   WEB.HttpSuccessRate  op=< thr=99 unit=%

DiskDaysToFull.description 自称: 「本字典中唯一一个『越低越糟』的指标」
实际字典中同类指标: WEB.HttpSuccessRate
```

`WEB.HttpSuccessRate` 早就在字典里（`defaultOperator: '<'`, `defaultThreshold: 99`, unit `%`），
成功率当然也是越低越糟。**同一个文件 §1.2 的表格行直接反驳 §1.1 新增行的 description。**

**为什么这条不只是文案瑕疵**：这段 description 会经 `GET /api/alarm/metrics`
返回给前端，进指标选择器展示。它是**面向用户的数据字段**，不是注释。

**判定：攻破（MEDIUM）**。证据类型：实测（程序判定，非目视）。

**修法**：`本字典中唯一一个` → `本字典中第二个「越低越糟」的指标（另一个是 `HttpSuccessRate`）`
或直接删掉「唯一」二字 —— 后者更省事且不会再次过期。

---

### M-7 模板数 **6 → 7 这条线一个地方都没改**（含被审文件自己）

**我怎么攻**：任务书只让我 grep「28」。我顺手 grep 了「6 条预置」——
因为新增了模板 7，这个数字也该动。

**证据（实测 grep）**：

```
docs/alarm/metrics.md:5     > 本文件是 GET /api/alarm/metrics 的唯一数据源，同时是 6 条预置触发条件模板的来源
docs/alarm/metrics.md:192   schema.sql 末尾以 INSERT IGNORE 写入 **6 条** is_preset = 1 的 alarm_condition_template。
docs/alarm/metrics.md:202   ## 3. 6 条预置触发条件模板        ← 模板 7 自己所在的章节标题写着「6 条」
docs/alarm/metrics.md:385   4. 新增指标**不破坏**已有 6 条预置模板引用的唯一键。
docs/alarm/schema.sql:338   -- 与 metrics.md §3 的 6 条预置触发条件模板严格一一对应。
docs/alarm/schema.sql:352   -- --- 6 条预置触发条件模板（is_preset=1，不可删除，可修改） ---
docs/alarm/contract.md:10   > - metrics.md —— 指标字典与 6 条预置触发条件模板
docs/alarm/contract.md:386  | isPreset | ... | 6 条预置模板见 metrics.md |
docs/alarm/domain.md:41     9. **6 条预置条件模板**在 schema.sql 末尾用 INSERT IGNORE 写入
docs/alarm/deliverable.md:13,25,124,201
README.md:28                metrics.md           28 个指标 + 6 条预置触发条件模板
```

**对比**：`contract.md` 的 **28→38 改了**（`:461`、`:806` 都已是 38），
但同一份文件里的 **6→7 没改**（`:10`、`:386`）。28→38 是**部分扫过**的，6→7 是**一次没扫**。

最刺眼的一条：`metrics.md:202` 的章节标题是「## 3. 6 条预置触发条件模板」，
而**模板 7 就写在这个章节的第 218 行**。

**判定：攻破（MEDIUM）**。证据类型：实测 grep。

---

### M-8 13 处「28」残留，其中 4 处在**被审文件自己身上**

**证据（实测 grep，已排除 `128 字符` 等同形噪声）**：

| 文件:行 | 原文 |
| --- | --- |
| **`docs/alarm/metrics.md:327`** | 后端可直接把本段作为实现的比对基准（仅列 3 条，**实际接口返回全部 28 条**） |
| **`server/config/autoload/metrics.php:6`** | 告警指标字典 —— docs/alarm/metrics.md §1 的机器可读副本（**共 28 个：CVM 10 / WEB 8 / CLB 4 / MYSQL 6**） |
| **`web/src/mocks/alarm.mock.ts:5`** | ⚠️ 指标字典（GET /api/alarm/metrics）的 **28 条**指标不在这里硬编码 |
| `web/src/types/alarm.ts:736` | 内容唯一来源是 metrics.md §1（**共 28 个指标**） |
| `web/src/types/alarm.ts:890` | 响应 data 是 AlarmMetric[]（不分页，**固定 28 条**） |
| `web/src/services/api/alarm-policy.api.ts:159` | **不分页**，固定 **28 条**，唯一来源 metrics.md §1 |
| `server/README.md:199` | 指标字典 **28 条**自检 |
| `server/README.md:226` │ ★ **28 个**指标字典（metrics.md 的机器可读副本） |
| `server/README.md:287` │ AlarmMetric[]（**28 条**，不分页） |
| `docs/alarm/deliverable.md:13,25,96` │ 28 个指标（CVM 10 / WEB 8 / CLB 4 / MYSQL 6） |
| `docs/alarm/domain.md:42` │ **28 个**指标在 metrics.md |
| `README.md:28` │ metrics.md　**28 个**指标 + 6 条预置触发条件模板 |
| `docs/alarm/metrics-gap-analysis.md:4,19,121,256` │ 「现有 28 个指标」 |

**分类**：
- **必须改**：`metrics.php:6` 和 `metrics.md:327` 是被审文件的自述，**当场就是错的**
  （`metrics.php:6` 甚至把四个 namespace 的分解数也写错了：写成 CVM 10/WEB 8/CLB 4/MYSQL 6，
  实际 CVM 15/WEB 9/CLB 5/MYSQL 9）。前端 4 处 + 后端 README 3 处是用户/开发者会读到的文档。
- **可不改**：`metrics-gap-analysis.md` 的「现有 28 个」是对**改动前状态**的历史陈述，
  保留是对的（改了反而篡改了分析记录的前提）。这一点我认为生产者做对了。
- **`alarm.mock.ts:5` 附带一处更旧的失效陈述**：同一段还写着「本文件只给一条示例条目用于打通链路」，
  但该文件现在**已不含任何指标条目**（已移到 `alarm-metrics.generated.ts`），这句也是死的。

**判定：攻破（MEDIUM）**。证据类型：实测 grep。

---

### M-9 metrics.md 内部自相矛盾：§1.5.2 说流量断流「仍缺」，§1.5.3 说模板 7 补上了

**证据（原文摘录）**：

```
metrics.md §1.5.2 表
| **A** | 不可用（服务不了） | 5xx、成功率、超时、CLB 后端异常 | **流量断流**（QPS=0）无专用指标，见 1.5.3 |

metrics.md §1.5.3（紧接其下）
→ 预置模板「模板 7 —— 流量断流」用 HttpRequestCount + < + 极小阈值表达该场景。
```

读者连着读两段：先被告知「仍缺」，紧接着被告知「已经用模板 7 补了」。

**技术上两边各自都能自圆其说**：「覆盖」列统计的是**字典里的指标**，
QPS=0 确实没有专用**指标**；模板 7 复用已有指标换了个算子，不算新增指标。
所以这不是事实错误，是**措辞没交代统计口径**。

**关于任务书问的「E/F 两类写 0 会不会误导」**：
逐条看完，**E/F 两行的「0」是诚实的**，不判缺陷 ——
「覆盖」列是覆盖计数，「仍缺」列紧跟着说明了为什么补不上
（E 缺的是契约 §1.5 没有同比/环比算子，F 缺的是心跳/freshness 机制），
并各自指向了 `metrics-gap-analysis.md` 的立项条目。读者不会误以为字典有 bug。
**真正会误导的是 A 行**（「仍缺」+ 下面立刻「已补」），不是 E/F。

**判定：攻破（MEDIUM，措辞缺陷非事实错误）**。证据类型：实测（原文对读）。

---

## 4. LOW

### L-10 存量 monitorType 兼容路径的**唯一**测试是复刻件 —— 我真挂载了组件，结论对，但证据不在仓里

**我怎么攻**：任务书让我重点查这条。仓里那条测试
（`src/pages/alarm/components/__tests__/monitor-type-selectable.test.ts:125`）
自己写着 `/** 复刻 policy-form.vue 里 monitorTypeOptions 的计算逻辑 */` ——
**复刻件无法发现真组件分叉**。所以我在 `/tmp` 建 vitest 工程（root 指向真项目、
AutoImport/Components 从项目 vite.config 抄、pnpm 解析兜底插件），挂载**真的** `policy-form.vue`。

**证据（实测，11 条断言全过）**：

```
# 真 computed 层
  monitorType=1 → 可视选项: [1,2]     label: ["云产品监控","应用性能监控"]
  monitorType=2 → 可视选项: [1,2]     label: ["云产品监控","应用性能监控"]
  monitorType=3 → 可视选项: [1,2,3]   label: [...,"前端性能监控（v1.0 不可选）"]
  monitorType=4 → 可视选项: [1,2,4]   label: [...,"云拨测（v1.0 不可选）"]
  monitorType=5 → 可视选项: [1,2,5]   label: [...,"终端性能监控（v1.0 不可选）"]
  新建态 → [1,2]（正确过滤掉 3/4/5）

# 纯 DOM 驱动 Reka Select（用户眼睛看到的那一层）
  【负对照】未选时 trigger = "请选择监控类型"          ← 证明断言可失败，不是恒绿
  monitorType=3 → trigger 显示 "前端性能监控（v1.0 不可选）"   （没回退成 placeholder）
      下拉项 = ["云产品监控","应用性能监控","前端性能监控（v1.0 不可选）"]
      选中后 trigger 不变，form.monitorType = 3
  monitorType=4 / 5 → 同上，均正确
  monitorType=3 时策略类型下拉 = "请选择策略类型"（空）
      页面含「该监控类型在 v1.0 暂无可用策略类型，请返回重新选择」提示 = true
```

**判定：攻不破（产品正确），但测试证据不合格（LOW）**。
- 产品行为是对的：存量值**可见 + 标注 + 可回填**，且**说明了为什么走不下去**。
  这条攻击线没打穿。
- 但仓里 `policy-form.mount.test.ts` 只用 `ss.setValue('monitorType', CLOUD_PRODUCT)`（=1），
  **从没设过 3/4/5**。所以整条兼容路径**零真组件覆盖**，
  全靠一个复刻件撑着 —— 复刻件和生产代码可以一起错。

**建议**：把上面这段真挂载 + 纯 DOM 断言补进 `policy-form.mount.test.ts`。
（我的测试文件在 `/tmp/atk/harness/`，**未写入项目**。）

---

### L-11 `gen-mock-metrics.mjs` 的正则：9 个构造用例，只挂 1 个（且当前不可触发）

**我怎么攻**：任务书点名「构造能让它解析错误的输入」。我把它的 `BLOCK` 与 `field()`
**原样正则**抽出来，喂 9 个手构的 PHP 块。

**证据（实测）**：

```
输入 9 条，解析出 9 条
  ✓ A_正常基线
  ✓ B_描述含ASCII单引号            （\' 转义 + 反转义正确）
  ✓ C_描述含反斜杠                （C:\Users\x 往返正确）
  ✓ D_描述含右方括号              （[1, 2, 3] 不影响）
  ✗ E_描述含换行(多行字符串)      期望 desc 非 null，实际 null
  ✓ F_description值含伪造字段名    （"'unit' => 'GB'," 不构成注入）
  ✓ G_负阈值  ✓ H_浮点阈值  ✓ I_单元素policyType
```

任务书猜的两个方向（单引号、`]`、嵌套 `]`）**都没打穿**。
只有**多行 description 且其中一行恰好是 `    ],`** 会让 `BLOCK` 提前截断。

**为什么是 LOW**：PHP 单引号字符串**允许**含换行，所以这不是非法输入；
但当前 38 条 description **无一是多行的**，且多行 description 也会先打爆 metrics.md 的表格。
`policyType => [2]` 的 `\[[^\]]*\]` 遇不到嵌套 —— 本字典 `policyType` 全是单元素标量。

**判定：攻破（LOW，潜在脆弱性，非现存缺陷）**。证据类型：实测。
**另**：脚本的「空产物保护」（`metrics.length === 0` 时 exit 1）是真的有牙齿，实测过。

---

## 5. 攻不破的攻击线（诚实记录：这些我打穿了但产品是对的）

### N-1 `operator = '<'` 会不会被判非法？—— **不会**（静态追踪 + 前端实测）

**证据**：
```
server/src/Constants/AlarmEnum.php:41
  public const OPERATOR = ['>', '>=', '<', '<=', '==', '!='];       ← '<' 在枚举里
server/src/Service/Validator/ConditionValidator.php:112
  $this->assertStringEnum($raw, 'operator', AlarmEnum::OPERATOR, ...)  ← 走字符串枚举
web/src/types/alarm.ts:194-201
  export const ALARM_OPERATOR = { GT:'>', GTE:'>=', LT:'<', LTE:'<=', EQ:'==', NE:'!=' }
web/src/pages/alarm/policy/validators/policy.validator.ts:99-102
  const operatorSchema = enumOf(Object.values(ALARM_OPERATOR), '比较关系必须是 > >= < <= == !=')
```
**「有没有代码路径假设 `>` 方向」** —— 逐个查了任务点名的三处：
- **条件编辑**：`condition-editor.vue:103-104` 是
  `{{ ALARM_OPERATOR_LABEL[condition.operator] }}{{ condition.threshold }}{{ condition.unit }}` ——
  纯查表 + 拼接，**无任何方向数学**。
- **校验器**：`operatorSchema` 是 `Object.values(ALARM_OPERATOR)` 驱动的，不是 `['>']` 硬编码。
- **预填逻辑**：`policy-form.vue:597` `operator: metric.defaultOperator` —— 直接取字典值，不改写。
- 全仓 grep 硬编码 `'>'`：**只出现在类型定义与中文 label 里**，无业务判断。

**判定：没攻破。**

---

### N-2 `defaultThreshold = 0` 会不会被「falsy 即缺省」误判？—— **不会**（S-04 那个坑没重蹈）

**证据**（三个环节全查）：
```
server/src/Service/Validator/ConditionValidator.php:170-176
  if ($raw === null || $raw === '') { return null; }          ← 严格比较，不是 !$raw
  if (! is_int($raw) && ! is_float($raw) && ! (is_string($raw) && is_numeric($raw))) {...}
  $value = (float) $raw;                                       ← 0 走到这里，返回 0.0
web/src/pages/alarm/policy/validators/policy.validator.ts:121-123
  const thresholdSchema = z.number({...}).refine(hasValidThresholdDecimals, {...})   ← 没有 .min(0)
web/src/pages/alarm/policy/components/policy-form.vue:1323-1325
  :model-value="Number.isNaN(condition.threshold) ? '' : String(condition.threshold)"
  @input="... value === '' ? Number.NaN : Number(...)"        ← 空串显式处理，不用 ||
```
`MysqlDeadlockCount`（阈值 0，`>`）与 `MysqlConnectionRejectCount`（阈值 0，`>`）
在字典、校验器、输入框三层都畅通。契约 §1.5 明确 `threshold` 允许负数，zod 也没有下限。

**判定：没攻破。** 附带：`threshold: 1e-20` 静默落库为 0 是**上一轮已记录的既存问题**（S-04），
本轮未改动该代码，不重复计分。

---

### N-3 `unit = 'IOPS'` / `'天'` 合规吗？—— **合规**（契约根本没约束 unit）

**证据**：
- `metrics.md §0.3 通用取值域` 只约束 4 件事：`period` 枚举、`operator` 枚举、
  `continuity ∈ [1,10]`、`unit = '%'` 时阈值 0-100。**没有 unit 枚举**。
- `contract.md §2.7`：`unit` 类型是 string，无枚举约束。
- 我的校验脚本对全部 38 条跑 `unit === '%' → 阈值必须在 0-100`：**0 条违规**。

**判定：没攻破。** `IOPS`、`天` 都合法。

---

### N-4 `suggestedContinuity` / `policyType` / `periodOptions` 域约束 —— **0 违规**

**证据（实测，38 条全跑）**：
```
$ node /tmp/atk/dict-validate.mjs
共 38 条，违规 0 条

各指标 periodOptions 分布:
   [1,5,10,30,60]  ×34
   [30,60]  ×4        (DiskUsageRate / InodeUsageRate / DiskDaysToFull / MysqlDiskUsageRate)
```
逐条校验项：`policyType` 数组 == §0.2 namespace 映射 ✓；`periodOptions ⊆ {1,5,10,30,60}` ✓；
`operator ∈ 六种` ✓；`suggestedContinuity ∈ [1,10]` ✓；`unit='%'` 时阈值 0-100 ✓；字段非空 ✓。

**关于任务书问的两个具体 periodOptions**：
- `InodeUsageRate` 只有 `[30,60]` —— **对**。inode 以百万为单位，耗尽是小时/天级慢变量，
  与同为慢变量的 `DiskUsageRate` / `MysqlDiskUsageRate` 保持一致。
- `FileDescriptorUsageRate` 给 `[1,5,10,30,60]` —— **对**。FD 泄漏可以在几分钟内打满，
  1 分钟粒度是必需的；给 `[30,60]` 才是错的。

**判定：没攻破。**

---

### N-5 md ↔ php ↔ mock 三方一致性 —— **真的逐字段一致**（我做了真正的逐字段比对）

**证据（实测）**：

```
# 1) md §1 表格  ↔  metrics.php  （38 行 × 10 字段）
md 表格行数 = 38 ; php 块数 = 38
  ✗ CVM.DiskDaysToFull  description 差异
      md : ...因此默认算子是 <——本字典中唯一一个...
      php: ...因此默认算子是 < ——本字典中唯一一个...
  → 唯一一处差异是 **markdown 粗体标记 `**` 剥离后残留的空格**，是我自己归一化函数的产物
    （md 原文是 `` **`<`** ``，剥掉 ** 和 ` 后 `<` 前后空格被吃掉），不是数据漂移。
  其余 37 条 × 10 字段全部一致。

# 2) metrics.php  ↔  alarm-metrics.generated.ts  （38 × 10 字段）
php=38  mock=38
  ✓ 38×10 字段 php↔mock 全部一致

# 3) 生成器幂等性
$ node scripts/gen-mock-metrics.mjs ; diff /tmp/before-mock.ts <产物>
  ✓ 已生成 ... 38 个指标： CVM 15 / WEB 9 / CLB 5 / MYSQL 9
  IDENTICAL (idempotent)      ← 重跑逐字节相同
```

**判定：没攻破**（数据层是干净的）。**但**这恰恰让 H-5 更刺眼：
**数据现在是对的，唯一的保障是一个抓不到字段漂移的脚本。**

---

### N-6 mock 是否真的接到了端点上？—— **接到了**（排除「生成了但没接」）

**证据**：
```
web/src/mocks/index.ts:11    import { alarmMetricsMock } from '@/mocks/alarm-metrics.generated'
web/src/mocks/index.ts:45    registerMock('get', '/alarm/metrics', () => ok(alarmMetricsMock))
web/src/mocks/index.ts:36    // ⑧ GET /api/alarm/metrics —— 指标字典，**完整 38 条**。
web/src/mocks/index.ts:42-44 // ⚠️ /metrics 的查询参数在 mock 里**仍然不生效**（mock-router 已知限制，非本次引入）
```
index.ts 的注释已更新到 38，且**诚实披露了 query 参数不生效**的残留限制。
唯一没更新的是 `alarm.mock.ts:5`（见 M-8）。

**判定：没攻破。**

---

### N-7 `policy-filters.vue` 保留全量有没有被误改？—— **没被误改**（任务书要求确认）

**证据**：
```
web/src/pages/alarm/policy/components/policy-filters.vue:13   alarmMonitorTypeOptions,      ← 仍是全量
web/src/pages/alarm/policy/components/policy-filters.vue:83   <SelectItem v-for="option in alarmMonitorTypeOptions" ...>
alarm-enum-options.ts:67   /** 监控类型（全部 5 项），用于列表筛选 —— 可能存在存量数据需要按 3/4/5 查 */
```
全仓 grep 确认 `alarmSelectableMonitorTypeOptions` **只在 `policy-form.vue` 一处**被使用
（外加它自己的测试文件），没有第二个「新建」入口漏改。

**判定：没攻破。** 筛选项保留全量是刻意且正确的。

---

## 6. 修复清单（按优先级）

**必须修（否则功能不可用 / CI 红）**
1. `2026_10_04_000800_...php:44`：`description` → **`remark`**（B-1）
2. `AlarmRuleTest.php:619,634,635,637`：28→**38**、8→**9**、4→**5**、10→**15**；
   并补 `filter(4)` == 9 的断言（B-2）
3. `policy-form.vue:71`：`alarmMonitorTypeOptions` 上移到 `alarmLevelOptions` 与
   `alarmObjectTypeOptions` 之间（B-3）

**应该修（守卫失效 = 下次漂移照样绿灯）**
4. `verify-preset-template.mjs`：`grab()` 扩到整个 VALUES 元组；
   新增「迁移列清单 ⊆ 建表迁移列清单」断言（H-4，**这一条直接抓 B-1**）
5. `sync-metrics-backend.mjs`：交叉校验从「比名字」升级为「比 10 个字段」，
   并把成功文案改成不说大话（H-5）

**文档一致性**
6. `6 条预置模板` → `7 条`，10 处（M-7）
7. `28 个指标` → `38 个`，13 处（`metrics-gap-analysis.md` 的历史陈述**保持不动**）（M-8）
8. `metrics.md` §1.5.2 A 行「仍缺 流量断流」与 §1.5.3「模板 7 已补」的口径冲突（M-9）
9. `DiskDaysToFull.description` 删掉「本字典中唯一一个」（M-6）

**测试补强**
10. 把存量 monitorType 3/4/5 的**真挂载 + 纯 DOM** 断言补进 `policy-form.mount.test.ts`（L-10）

---

## 7. 本次审查的诚实边界

- **没有跑 PHP、没有跑 MySQL、没有跑 Composer。** B-1 与 B-2 的**结论**是静态推断
  （列名字面量比对 / 数组长度算术），不是运行结果。B-2 用了 JS 复刻 PHP 语义并做负对照自证，
  但**它仍然是模拟，不是 hyperf 跑出来的**。
- **前端四件套是真跑的**，退出码见 B-3 表格。`pnpm build` 在 `web/dist` 落了构建产物
  （任务书授权的基线运行），`vue-tsc -b` 顺带重写了 `src/types/auto-import.d.ts`（生成文件）。
  **除这两个构建副作用外，我没有在 `/workspace` 下写入或修改任何项目文件**；
  全部临时脚本与测试在 `/tmp/atk/`。
- **我自己犯过 2 个错，都已自查剔除，不计入发现**：
  (1) 第一次跑 `gen-adversarial.mjs` 时把结果按 case 名查而不是按 metricName 查，
      导致 9/9 全报「整条丢失」—— 是我 harness 的 keying bug，不是产品问题；
  (2) 第一次跑纯 DOM 测试忘了 `attachTo: document.body`，
      报「页面上共有 0 个 Select trigger」—— 是我漏了挂载点，
      加 `data-slot="select-trigger"` 探测后确认 DOM 里一直有。
- **md↔php 逐字段比对报出的那一处 description 差异是我的归一化函数产物**（markdown 粗体剥离），
  不是数据漂移，已在 N-5 里写明，**不计入发现**。
