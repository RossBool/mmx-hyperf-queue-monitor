# 交叉校验报告：38 个指标跨 4 处是否一致

**任务**：独立验证「`metrics.md` 是唯一事实来源」这一不变量是否成立
**方法**：**完全自写解析器**（`/tmp/xcheck/parse_metrics.py`，Python 3.11，~250 行）。
未读取、未复用 `scripts/verify-preset-template.mjs` / `scripts/sync-metrics-backend.mjs` /
`scripts/gen-mock-metrics.mjs` 的任何解析逻辑；4 处来源各自独立写了 4 套解析函数。
**未修改 `/workspace` 下任何文件**（反向验证全部在 `/tmp/xcheck/fx*` 的临时副本中进行）。

## 被审计对象（sha256 指纹，防止交付后内容漂移）

| 文件 | sha256 | mtime |
| --- | --- | --- |
| `docs/alarm/metrics.md` | `77b03c293702c42f268f034b9892ad6be127f7152d01454c4bee22b4e1f39f6f` | 2026-10-04 17:47:01 |
| `server/config/autoload/metrics.php` | `cbabd73e580a9ca516047dea2f199816a117292c506fecdc9eb144ee8653e3dd` | 2026-10-04 17:47:58 |
| `web/src/mocks/alarm-metrics.generated.ts` | `f9c7381d2d7060d6a220f099029e39f594d5ebdca506d548ad5af08c78bd5758` | 2026-10-04 18:35:20 |
| `docs/alarm/contract.md` | `ea2166198a7fbd2b5ba43fc5eb12caefa8f3087d22d3c34da3bcf497128ef42d` | 2026-10-04 17:48:09 |

---

## 1. 四处各自的指标数

| # | 位置 | 指标数 | CVM | WEB | CLB | MYSQL |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `docs/alarm/metrics.md` §1（4 张表，namespace 取自 `### 1.x` 标题） | **38** | 15 | 9 | 5 | 9 |
| 2 | `server/config/autoload/metrics.php`（`return [...]`，38 个 `metricName` 块） | **38** | 15 | 9 | 5 | 9 |
| 3 | `web/src/mocks/alarm-metrics.generated.ts`（`alarmMetricsMock`） | **38** | 15 | 9 | 5 | 9 |
| 4 | `docs/alarm/contract.md` | 2 处声明 `38`（见 §4） | — | — | — | — |

唯一键集合（`namespace` + `"."` + `metricName`）在三处**完全相同**：
`md \ php = md \ ts = php \ ts = ∅`。无孤儿指标，无缺失指标，无重复键。

> 注：`metrics.md:70` 标题写「共 38 个」，与实际 38 一致。

## 2. 逐字段比对结果

比对口径：38 指标 × 10 字段 = **380 个字段位/对**。
markdown 单元格先剥离行内代码/加粗标记（`**`、`` ` ``）后取值，这是「文档渲染后」的值；
PHP/TS 直接取字符串字面量内容。`description` 额外做逐码点（codepoint）比对。

| 字段 | md vs php | md vs ts | php vs ts | 备注 |
| --- | --- | --- | --- | --- |
| `namespace` | ✅ 0 | ✅ 0 | ✅ 0 | |
| `metricName` | ✅ 0 | ✅ 0 | ✅ 0 | |
| `metricNameCn` | ✅ 0 | ✅ 0 | ✅ 0 | |
| `unit` | ✅ 0 | ✅ 0 | ✅ 0 | |
| `policyType` | ✅ 0 | ✅ 0 | ✅ 0 | 全部为数组，元素全为 int |
| `periodOptions` | ✅ 0 | ✅ 0 | ✅ 0 | 全部为数组，元素全为 int |
| `defaultOperator` | ✅ 0 | ✅ 0 | ✅ 0 | |
| `defaultThreshold` | ✅ 0 | ✅ 0 | ✅ 0 | 全部为数字，无字符串化 |
| `suggestedContinuity` | ✅ 0 | ✅ 0 | ✅ 0 | |
| `description` | ❌ **5** | ❌ **5** | ✅ 0 | 详见下表 |
| **合计** | **10 处不一致** | **10 处不一致** | **0** | |

`php vs ts` = 0 差异：**两个代码副本逐字节完全一致**（含同样的 4 处反引号残留）。
即 mock 与后端不会互相漂移，二者只相对 metrics.md 漂移。

### 2.1 不一致项明细（5 个指标，10 处）

| # | 唯一键 | metrics.md | metrics.php | generated.ts | 差异类型 |
| --- | --- | --- | --- | --- | --- |
| 1 | `CLB.ClbHttp5xxRatio` | `:111` | `:303` | `:303` | 反引号残留 |
| 2 | `CVM.DiskDaysToFull` | `:88` | `:147` | `:147` | 空格差异 |
| 3 | `MYSQL.MysqlConnectionCount` | `:122` | `:375` | `:375` | 反引号残留 |
| 4 | `MYSQL.MysqlConnectionRatio` | `:123` | `:387` | `:387` | 反引号残留 |
| 5 | `MYSQL.MysqlSlowQueryCount` | `:121` | `:363` | `:363` | 反引号残留 |

**差异 1（反引号，4 个指标）** — metrics.md 用 markdown 行内代码排版，PHP/TS 把反引号当普通字符存进了字符串：

```
md  (渲染后): …与后端 WEB.Http5xxRatio 可交叉定位…      ← 反引号是排版符，渲染后消失
php (接口返回): …与后端 `WEB.Http5xxRatio` 可交叉定位…   ← 反引号是字面字符
                                                    ↑ 2 个码位差
```

受影响的 4 条：`WEB.Http5xxRatio` / `long_query_time` / `max_connections`（2 次），共 8 个字面反引号残留
（`metrics.php:325,385,397,409`；`alarm-metrics.generated.ts:323,383,395,407`）。

**这不是一条统一的规则，而是生成器的不一致**：metrics.md §1 中共 **12** 个指标的 description 含反引号，
其中 **8 个已被剥离**、**4 个被保留**：

| 已剥离（与 md 渲染结果一致） | 保留（与 md 渲染结果不一致） |
| --- | --- |
| `CVM.FileDescriptorUsageRate`(:86)、`CVM.InodeUsageRate`(:87)、`CVM.DiskDaysToFull`(:88)、`CVM.DiskReadIops`(:89)、`CVM.DiskWriteIops`(:90)、`CLB.ClbBackendResponseTime`(:114)、`MYSQL.MysqlDeadlockCount`(:126)、`MYSQL.MysqlConnectionRejectCount`(:128) | `CLB.ClbHttp5xxRatio`(:111)、`MYSQL.MysqlSlowQueryCount`(:121)、`MYSQL.MysqlConnectionCount`(:122)、`MYSQL.MysqlConnectionRatio`(:123) |

**差异 2（空格，1 个指标）** — `CVM.DiskDaysToFull`：

```
md  (渲染后): …因此默认算子是 <——本字典中唯一一个…   ← 「<」后直接接「——」
php (接口返回): …因此默认算子是 < ——本字典中唯一一个…  ← 多一个半角空格
                                                  ↑ 1 个码位差
```

影响：用户在前端看到的描述与文档不一致；纯观感问题，但**违反**「派生副本逐字一致」的不变量。

### 2.2 专项核对

**a) `description` 标点 / 转义完整性 —— ✅ 通过**

| 检查项 | metrics.md | metrics.php | generated.ts |
| --- | --- | --- | --- |
| 反斜杠 `\` 总数 | 0 | 0 | 0 |
| 全角 `「` / `」` 配对 | 14 / 14 | 3 / 3 | 4 / 4 |
| ASCII `"` 出现在 description 内 | 0 | 0 | 0 |

`CVM.FileDescriptorUsageRate` 的描述在三处均完整无转义破坏：

```
md  : `LimitNOFILE`）比例，取值 0-100。**「Too many open files」是 Linux Top 5 故障，且通常先于内存耗尽出现；…
php : -n / LimitNOFILE）比例，取值 0-100。「Too many open files」是 Linux Top 5 故障，且通常先于内存耗尽出现；…
ts  : -n / LimitNOFILE）比例，取值 0-100。「Too many open files」是 Linux Top 5 故障，且通常先于内存耗尽出现；…
```

中文引号 `「」` 完整、顺序正确、无 `\'` 之类转义残留（PHP 单引号串在文件中 0 个 `\'`）。
md 中 110 个 ASCII `"` 全部位于 §4 的 jsonc 代码块与散文，**没有一个进入 description 字段**。

**b) `policyType` / `periodOptions` 是数组 —— ✅ 通过**

38 × 2 = **76 个数组字段位**，三处全部为数组字面量，元素全部为 int。
`php vs ts` 的**类型差异数为 0**（脚本对每个字段独立做 `string|array|number|other` 分类后逐一比对类型）。
反例验证：把任一处改成 `'1,5,10,30,60'` 会被立刻捕获（见 §3 案例 F3/F5）。

**c) `defaultThreshold` 是数字 —— ✅ 通过**（重点核 `0` 与 `7`）

| 唯一键 | 值 | md 原样 | php 类型 / 原样 | ts 类型 / 原样 |
| --- | --- | --- | --- | --- |
| `MYSQL.MysqlDeadlockCount` | **0** | `` `0` `` | `number` / `0` | `number` / `0` |
| `MYSQL.MysqlConnectionRejectCount` | **0** | `` `0` `` | `number` / `0` | `number` / `0` |
| `CVM.DiskDaysToFull` | **7** | `` `7` `` | `number` / `7` | `number` / `7` |

**没有出现 `"0"` / `"7"` 字符串化。** 全库 38 个 `defaultThreshold` 均为无引号数字字面量。

## 3. 反向验证（7 个篡改用例，全部被检出）

在 `/tmp/xcheck/fx3` 复制出 4 份文件的临时副本做单点篡改（**`/workspace` 未被触碰**），
基线为「10 处 description 差异」，下表只列**超出基线**的新增检出：

| # | 篡改 | md/php/ts 计数 | 新增检出 | 结论 |
| --- | --- | --- | --- | --- |
| **F7** | **从 metrics.md 真实删掉 `MYSQL.MysqlDeadlockCount` 整行** | **37 / 38 / 38** | `仅存在于派生副本: {php:[MYSQL.MysqlDeadlockCount], ts:[…]}` + 该指标全部 10 字段 × 2 对 = **+20 处** | ✅ **检出** |
| F1 | 把该行 `metricName` 改成 `~~MysqlDeadlockCount~~`（模拟注释掉） | 38 / 38 / 38 | 旧键消失 + 新键 `MYSQL.~~MysqlDeadlockCount~~` 全字段不一致，**+40 处** | ✅ 检出 |
| F2 | md 里 `0` 改成 `"0"`（模拟阈值被序列化成字符串） | 38 / 38 / 38 | `+2` 字段差异 + 异常 `metrics.md:126 defaultThreshold 非数字` | ✅ 检出 |
| F3 | md 里 `[1,5,10,30,60]` 改成 `1,5,10,30,60`（数组塌缩成字符串） | 38 / 38 / 38 | `+2` 字段差异 + 异常 `periodOptions 非数组字面量` | ✅ 检出 |
| F4 | php 里 `7` 改成 `'7'` | 38 / 38 / 38 | `+2` 字段差异 + **类型差异** `php_type=string vs ts_type=number` | ✅ 检出 |
| F5 | php 里 `periodOptions` 数组改成字符串 `'1,5,10,30,60'` | 38 / 38 / 38 | `+2` 字段差异 + **类型差异** `php_type=string vs ts_type=array` | ✅ 检出 |
| F6 | ts 里删掉 `unit` 字段 | 38 / 38 / 38 | `+2` 字段差异 + 异常 `TS: entry@423 缺字段 unit` | ✅ 检出 |

**F7 是任务指定的反向验证**：从 metrics.md 删掉一个指标后，脚本把 md 解析为 37、
把 php/ts 解析为 38，并把 `MYSQL.MysqlDeadlockCount` 归入「仅存在于派生副本、md 中没有」——
即**最危险的那种漂移（开发时能选、生产没有）能被可靠检出**。检查具备可证伪性，不是恒真断言。

## 4. `contract.md` 的计数核对

任务提到「3 处计数」。实际扫描结果：**`contract.md` 中只有 2 处显式指标计数，且两处都是 38（正确）；
全文无任何残留的 `28`。**

| 行 | 原文 | 判定 |
| --- | --- | --- |
| `contract.md:461` | 内容**唯一来源：`metrics.md` §1**（共 **38** 个指标） | ✅ 已是 38 |
| `contract.md:806` | `data` = `AlarmMetric[]`（**不分页**，固定 **38** 条，唯一来源 `metrics.md` §1） | ✅ 已是 38 |
| `contract.md:1147` | 端点总表 `GET /api/alarm/metrics` → `AlarmMetric[]` | ✅ 无计数，无需改 |

**但 contract.md 存在另一类漂移（比计数更隐蔽）**：`contract.md:812-822` 的 JSON 示例里，
`CVM.CpuUtilizationRate` 的 `description` 与 metrics.md 不一致：

```
contract.md:821  "description": "统计周期内实例 CPU 使用率平均值，单位 %，取值 0-100。"
metrics.md:76     统计周期内实例 CPU 使用率平均值，取值 0-100。持续偏高通常意味着计算资源打满、需扩容或存在死循环。
```

多插了「单位 %」、少了一整句。其余 9 个字段（namespace / metricName / metricNameCn / unit /
policyType / periodOptions / defaultOperator / defaultThreshold / suggestedContinuity）**完全一致**。
这直接违反 `contract.md:462` 自己写的「本契约不重复列举指标，避免两处漂移」。

**另有两处 `28` 残留在「真源」侧（不在 contract.md，但属同一不变量范围）：**

| 位置 | 原文 | 实际 | 严重度 |
| --- | --- | --- | --- |
| `metrics.md:327` | 后端可直接把本段作为实现的比对基准（仅列 3 条，**实际接口返回全部 28 条**） | 38 | 中：真源自身自述错误 |
| `metrics.php:6` | `……机器可读副本（**共 28 个：CVM 10 / WEB 8 / CLB 4 / MYSQL 6**）` | 38 个：**CVM 15 / WEB 9 / CLB 5 / MYSQL 9** | 高：文件头是维护者第一眼看到的说明，**计数和分布双错** |

（范围外、但同一批次 28→38 遗漏：`docs/alarm/deliverable.md:13,25,96`、`docs/alarm/domain.md:42`、
`docs/alarm/metrics-gap-analysis.md:4,19,121,256`。）

## 5. 结论：「单一事实来源」这个不变量当前成立吗？

### 分层回答

**（1）机器可读载荷层面：✅ 成立，且质量高。**
指标集合、唯一键、以及 10 个字段中的 **9 个**（namespace / metricName / metricNameCn / unit /
policyType / periodOptions / defaultOperator / defaultThreshold / suggestedContinuity）
在三处**逐字段零差异**；`policyType`/`periodOptions` 确为数组、`defaultThreshold` 确为数字（含 `0`、`7`）、
中文引号与标点无转义破坏；后端与前端 mock **逐字节完全一致**（380/380）。
换言之：*「开发时能选的指标在生产不存在」这一类致命漂移，当前为零。*

**（2）逐字一致层面：❌ 不成立。**
5 个指标的 `description`（占 13.2%）与 metrics.md 渲染结果**不是同一条字符串**：
4 个残留字面反引号、1 处多余半角空格。合计 10 个码位差。
且生成器剥离反引号的规则自相矛盾（12 个含反引号的指标中 8 剥 4 留）——这不是一条可复现的规则，
意味着**下次同步仍会随机漂移**。

**（3）计数自洽层面：❌ 不成立。**
`metrics.php:6` 的文件头（`共 28 个：CVM 10 / WEB 8 / CLB 4 / MYSQL 6`）与
`metrics.md:327`（`全部 28 条`）都停留在 28，且前者的 namespace 分布也全错。
`contract.md` 的 2 处计数已正确改为 38，但其 JSON 示例的 `description` 是陈旧的。

### 判定

> **「单一事实来源」不变量在「指标集合 + 9/10 字段 + 类型系统」上成立；
> 在「description 逐字一致」和「文档内计数自洽」上不成立。**
>
> 准确表述是：**当前没有致命的静默漂移，但也没有达成契约 §2.7 声明的「唯一来源」——
> 派生关系是「大体同步 + 5 处漏字」，而不是可证明的机械同步。**
>
> 5 处 description 差异与 2 处陈旧计数均为**低危**（不影响选指标、不影响阈值行为、不报错），
> 但它们足以让「唯一事实来源」这句话在审计意义上**不成立**。

### 建议（不改代码，仅结论）

1. 让 `sync-metrics-backend.mjs` 的 markdown 剥离逻辑**确定性化**：要么统一剥离所有 `` ` ``，
   要么统一保留。当前 8 剥 4 留是 bug 级的不一致。
2. 修 `metrics.php:6` 文件头（`共 38 个：CVM 15 / WEB 9 / CLB 5 / MYSQL 9`）与 `metrics.md:327`（`全部 38 条`）。
3. 修 `contract.md:821` 示例 description，或按 `contract.md:462` 的自述把该示例删掉/标注「节选，非字典」。
4. 把本报告 §3 的 7 个篡改用例固化成 CI 回归测试——现在这些检查**只能靠人跑一次**，
   而漂移是静默的，没有测试就等于没有守卫。

---

### 复现方式

```bash
python3 /tmp/xcheck/parse_metrics.py /workspace        # 全量逐字段比对，输出 JSON
python3 /tmp/xcheck/revcheck2.py                       # 7 个篡改用例的可证伪性验证
python3 /tmp/xcheck/revcheck.py                        # §4 jsonc 节选核对 + md 删行验证
```

脚本与 fixture 全部在 `/tmp/xcheck/`，`/workspace` 下只新增了本报告文件。
