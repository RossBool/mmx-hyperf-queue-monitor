# v1.1 契约级扩展设计：E 类（相对判据）与 F 类（无数据检测）

> 状态：**设计提案**。`metrics-gap-analysis.md` 把 E-1 / F-1 标为「需要契约变更」，
> 这一轮把它们落成具体字段与端点。落地前先读本文的**取舍记录**——
> 每个「为什么不用更简单的方案」都是踩过的坑。

---

## 0. 为什么要单独立项

v1.0 的 38 个指标**全部**是静态绝对阈值：把当前值和一个常量比。
这导致整类故障逃逸：

| 故障 | v1.0 表达得了吗 |
| --- | --- |
| QPS 从 100 跌到 10 | 表达不了（阈值 10000，10 远低于它，健康） |
| 延迟从 20ms 涨到 300ms | 表达不了（阈值 1000，没触发） |
| 某接口 100% 失败但量小 | 表达不了（`Http5xxCount` 阈值 10，3 次不触发） |
| 采集 agent 挂了 | **表达不了**，且系统看起来一切正常 |

注意第 4 行：它和其它三个不是一类。其它三个是「某个值不对」，
它是「**没有值**」—— 用「比较当前值和阈值」的模型根本描述不了。

所以这是**两件独立的事**，共用一次契约版本：

- **E 类**：条件的判据从「绝对阈值」扩展到「相对基线的偏离」
- **F 类**：引入与指标**正交**的「数据新鲜度」维度

---

## 1. E 类：相对判据

### 1.1 三种候选方案与取舍

#### 方案 A：加新算子（`<<` 环比跌超、`>>` 环比涨超、`~~` 同比偏离）

```json
{ "operator": "<<", "threshold": 30 }
```

- ✅ 改动最小：只加枚举值，条件结构不变
- ❌ **不可扩展**。方向 × 基线类型至少 3×2 = 6 种，每加一种基线就要加 3 个算子。
  `VARCHAR(2)` 也快放不下了。
- ❌ **语义不可读**。`<<` 在不同监控系统里含义不同（有的当位移运算）。
- ❌ 用户要理解「`<<` 是环比、同比是 `~~`」这种映射关系。

**否决。**

#### 方案 B：把 `threshold` 改成对象

```json
{ "operator": ">", "threshold": { "type": "relative", "value": 30, "baseline": "prev" } }
```

- ✅ 表达力强，一个字段容纳所有判据
- ❌ **破坏性**。`threshold` 从 `number` 变成 `object`，v1.0 的所有存量策略、
  前端类型、mock、DDL 全部要改。契约 §0 说的「storage 与 transport 分离」也做不到。
- ❌ 前端表单要按类型分叉渲染，改动面大。

**否决。**

#### 方案 C ✅：加正交字段，`threshold` 语义不动

```json
{
  "operator": "<",
  "threshold": 30,
  "compareMode": "relative",
  "baselineType": "period",
  "baselineCount": 1
}
```

- ✅ **完全向后兼容**：`compareMode` 缺省 = `absolute`，
  v1.0 的存量数据**一行都不用改**，DDL 的新列都有 DEFAULT
- ✅ 语义正交：`operator` 管方向，`compareMode` 管「跟什么比」，
  两个维度独立组合，新增基线类型不动其他字段
- ✅ 可读：`operator: "<"` + `compareMode: "relative"` 读出来就是「相对基线跌超 30%」
- ⚠️ 条件结构多了 3 个字段 —— 但**只在 `compareMode=relative` 时才读**，
  绝对判据的请求/响应里它们可以缺省

**采纳。**

### 1.2 字段定义

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `compareMode` | string | `"absolute"` | `absolute` = 当前值 vs `threshold`（v1.0 行为）；`relative` = 当前值 vs 基线 |
| `baselineType` | string | `null` | 仅 `relative` 时必填。`period` = 环比（前一周期）；`day` = 同比（昨日同时段）；`week` = 上周同时段 |
| `baselineCount` | int | `null` | 仅 `baselineType=period` 时必填。前移几个统计周期，`1 <= n <= 60` |

**为什么 `baselineType` 只有 3 种**：再多就是「用户自己算」了。
告警配置不该要求用户做时序分析，3 种覆盖绝大多数「相对自身基线异常」的场景。

### 1.3 语义精确定义

```
absolute:
  命中 ⟺ value OP threshold

relative + baselineType=period + baselineCount=n:
  baseline = 第 (n+1) 个 period 窗口的平均值
  deviation = (value - baseline) / baseline × 100%
  命中 ⟺ deviation OP threshold
      注意：此时 threshold 的单位是**百分比**，不是指标原单位

relative + baselineType=day:
  baseline = 昨日同一时刻往前一个 period 窗口的平均值
relative + baselineType=week:
  baseline = 上周同一时刻往前一个 period 窗口的平均值
```

**关键：`relative` 模式下 `threshold` 的量纲变成百分比。** 这必须在契约里写死，
否则用户会拿「80」去填相对判据（而 80% 偏离显然过宽）。

### 1.4 边界情况（必须定义，否则实现必然出错）

| 情况 | 处理 | 理由 |
| --- | --- | --- |
| `baseline = 0` | **不命中** | 除以 0 无意义。此时应改用 absolute 判据 |
| 基线窗口无数据 | **不命中** | 宁可漏报也不要用「0 当基线」算出天文数字偏离 |
| `value` 为负 | `baseline` 为负时用绝对差替代百分比 | `(v-b)/b` 在负基数下符号翻转，语义反了。改用 `abs(v-b) / abs(b)` |
| 偏离恰好等于 `threshold` | 按 `operator` 的常规语义（`>` 不命中，`>=` 命中） | 与 absolute 保持一致 |
| 同一策略内多个 relative 条件 | 各算各的，独立命中 | `conditionLogic` 决定如何合并 |

### 1.5 为什么不新增指标

「QPS 同比跌 30%」不是某个指标的属性，是**对任意指标的一种判据**。
如果为每个指标 × 每种基线各造一个指标，38 个指标会膨胀成几百个，
而且新增指标时这些组合要重新造一遍。加在条件上则对所有指标自动生效。

---

## 2. F 类：无数据检测

### 2.1 为什么它不是「加一个指标」

F 类故障的形态是「**没有数据**」。任何形如「当前值 OP 阈值」的判据都要求
**先有一个当前值**。没有值时，判据根本无法求值。

更糟的是：多数监控系统在无数据时会返回 `0` 或「沿用上次值」。
于是「QPS=0」既可能是「真的没流量」，也可能是「采集挂了」——
**同一个读数对应两种完全相反的结论**。

### 2.2 模型：把「数据新鲜度」做成正交维度

引入一个独立的心跳表，由**采集侧**写入，告警侧读取：

```
alarm_target_heartbeat
  target_type      TINYINT      1=CVM实例 2=CLB实例 3=MySQL实例 4=WEB服务
  target_id        VARCHAR(128) 目标唯一标识
  last_metric_at   DATETIME     最后一次收到该目标的**指标数据**的时间
  updated_at       DATETIME
  PRIMARY KEY (target_type, target_id)
```

判据不放在 `alarm_policy_condition` 里（那里描述的是「指标值满足什么条件」），
而是新增一个**独立的策略类型**：

```
policyType = 5 「采集静默」
```

它在 `conditions` 里只需要一条，且不含 `metricNamespace/metricName/threshold/operator`。

### 2.3 取舍

#### 候选 A：给每个指标加 `freshnessMinutes`

- ❌ 38 个指标各配一个「多久没数据算异常」，用户要填 38 个值
- ❌ 语义错位：`freshnessMinutes` 是**目标**的属性，不是**指标**的属性

**否决。**

#### 候选 B：新增 `policyType=5`，独立表存 `targetFreshness`

- ✅ 一个策略管一批目标，填一个「静默多久算异常」
- ✅ 与「值不对」在语义上正交，用户不会混淆
- ✅ 采集侧只需维护一张心跳表，不必理解告警语义

**采纳。**

### 2.4 字段定义

策略级新增：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `targetType` | int | `null` | 仅 `policyType=5` 时必填，见下 |
| `targetFreshnessMinutes` | int | `null` | 仅 `policyType=5` 时必填，`5 <= n <= 10080`（7 天） |

| `targetType` | label | 心跳表里对应的值 |
| --- | --- | --- |
| `1` | CVM 实例 | 1 |
| `2` | CLB 实例 | 2 |
| `3` | MySQL 实例 | 3 |
| `4` | WEB 服务 | 4 |

### 2.5 命中语义

```
命中 ⟺ now - last_metric_at > targetFreshnessMinutes
```

`last_metric_at` 为 NULL（**从未上报过**）也算命中 —— 从未上报是最强的静默信号。

### 2.6 心跳表谁来写

**本项目不写。** 本项目是管理面，心跳由采集侧（agent / 上报进程）维护。
所以本轮交付的是：**契约 + 表结构 + 管理端 API + 校验**。
判定逻辑属于告警引擎，引擎不在本项目范围内。

> 这一条必须写清楚，否则会被误读成「无数据检测已经能用了」。

---

## 3. 对现有契约的影响面

| 受影响的部分 | 改动 | 是否破坏兼容 |
| --- | --- | --- |
| `AlarmPolicyCondition` | +3 个可缺省字段 | 否 |
| `AlarmPolicy` | +2 个可缺省字段 | 否 |
| `policyType` 枚举 | +1 个值 `5` | 否（追加而非修改） |
| `conditions` 校验 | `compareMode` / `policyType=5` 的分支 | 否 |
| DB schema | `alarm_policy_condition` +3 列，`alarm_policy` +2 列，**全部 nullable** | 否 |
| 新表 | `alarm_target_heartbeat` | 否 |
| 前端类型 | +5 个可选字段 | 否 |
| 前端表单 | 条件编辑器多一个「判据模式」开关 | 否 |

**全部是加法。** v1.0 的存量数据、前端表单、已推送的模板全部继续有效。

---

## 4. 明确不做的事

| 不做 | 理由 |
| --- | --- |
| 相对判据的**计算** | 需要时序数据，本项目没有指标数据存储。计算属于告警引擎 |
| 无数据判定的**执行** | 同上；且心跳表要采集侧写，本项目不写 |
| 基线窗口的**预聚合** | 属于采集/存储层设计，超出告警管理面 |
| 多目标混合的心跳策略 | 一条策略只管一种 `targetType`，跨类型组合是另一件事 |

---

## 5. 落地顺序

1. 更新 `contract.md`：1.5 加 `compareMode` / `baselineType` / `baselineCount`；1.2 加 `policyType=5`；2.1 条件对象加字段；2.2 策略对象加字段；§3 加端点或扩展既有端点
2. `schema.sql` + **新迁移**（不改已应用的）：`alarm_policy_condition` / `alarm_policy` 加列 + `alarm_target_heartbeat` 建表
3. 后端：枚举、校验分支、DTO、迁移
4. 前端：类型、条件编辑器的判据模式开关
5. 全套验证：单测 / HTTP 端到端 / 前后端联调 / 前端四项
6. 一致性守卫：新增字段要进 `verify-metrics-consistency` 同级的检查

---

## 6. 实施记录（v1.1 已落地）

契约、存储、校验、透传全部完成。以下是实施过程中**靠真实运行才发现**的问题，
静态检查和 Service 层测试一次都没报出来。

### 6.1 迁移层面

| # | 问题 | 表现 | 根因 |
| --- | --- | --- | --- |
| M-1 | 迁移不幂等 | 重跑必然 `1060 Duplicate column name` | 000100–000800 用 `CREATE TABLE IF NOT EXISTS`，000900 第一版直接 `ADD COLUMN` |
| M-2 | 试过 `ADD COLUMN IF NOT EXISTS` | `1064` 语法错误 | **那是 MariaDB 的扩展**，MySQL 8.0.46 不支持。改用 `information_schema` 探测 |
| M-3 | v1.1 新列一个 CHECK 都没有 | 应用层之外的写入毫无防线 | 只加了列没加约束，把 v1.0 的 29-CHECK 防线在新增字段上整个丢掉了 |
| M-4 | `ck_policy_policy_type` 仍锁 1-4 | 采集静默策略**一条也建不出来** | 只加了列没改取值域 |
| M-5 | CHECK 表达式跨行 | `1064`，报错指向第 2 行的 `OR` | MySQL 8.0 的 `ADD CHECK` 不接受换行，看起来像括号不配对 |
| M-6 | 4 个指标列仍 `NOT NULL` | `Column 'threshold' cannot be null` | 契约要求静默条件这 4 列为 NULL，DB 却不允许 |
| M-7 | `down()` 撞 `3959` | 回滚中途失败，表停在半完成状态 | CHECK 引用了列 → 列不能删。必须先删约束再删列 |
| M-8 | `down()` 关闭外键检查 | 级联删除不触发，留下孤儿行 | `FOREIGN_KEY_CHECKS=0` 会让 `ON DELETE CASCADE` 失效 |

> M-7 / M-8 值得单说：`down()` 失败**不会**让表处于明显的错误状态 ——
> `CREATE TABLE IF NOT EXISTS` 和 `information_schema` 探测都不认为有问题，
> 于是之后每次重跑都从半完成状态继续，现场极难排查。

### 6.2 应用层

| # | 问题 | 表现 | 根因 |
| --- | --- | --- | --- |
| A-1 | 采集静默走通用条件分支 | 每条条件报「指标命名空间不属于该策略类型」 | `POLICY_TYPE_NAMESPACE[5]` 刻意不存在，`belongsToPolicyType()` 恒 false |
| A-2 | `update()` 闭包漏 `use $silenceTarget` | **每次更新策略都把静默配置写成 NULL** | 闭包不自动捕获外层变量。静默策略改个名字就失效，且无任何报错 |
| A-3 | 可空列被 `(string)` 强转 | 空串写进库，撞 CHECK；报错指向一个请求里根本没出现的字段 | PHP 的 `(string) null === ''` |
| A-4 | Presenter 里 `(float) $condition->threshold` | 静默条件读回 `threshold: 0` | 同上，`(float) null === 0.0`。而 **0 对普通条件是合法阈值**，两者无法区分 |
| A-5 | 守卫「文件里有探测函数就整份放行」 | 真正的裸 `ADD COLUMN` 被放过 | 规则粒度太粗，只要文件任何角落有 `columnExists()` 就整份放行 |

### 6.3 测试自身的坑

| # | 现象 | 真相 |
| --- | --- | --- |
| T-1 | e2e 的「错误路径精确」断言一直失败 | `extra.errors` 是**数组** `[{field, message}]`，我用 `Object.keys()` 拿到的是下标 |
| T-2 | e2e 一直打到**旧代码**上 | 端口被上一个后台服务占着，新服务静默启动失败；`pkill -f hyperf.php` 又因为 Swoole 的 `setproctitle` 匹配不到 |
| T-3 | 联调里「非静默策略的 targetType 应为 null」失败 | 我拿错了对象（用了静默详情而不是相对判据详情） |
| T-4 | `assertSame(80, $threshold)` 失败，实际 80.0 | 断言了与被测行为无关的实现细节 |

> T-2 最值得记：**测试全绿但验的是旧代码**，和「测试全绿但测的是 mock」是同一类错误。
> 判断依据只能是「服务进程确实带着新代码启动」，不能靠「端口有响应」。

### 6.4 新增守护

- `scripts/verify-migration-idempotent.mjs` — 逐语句检查 `up()` 的幂等性（含自检）
- `scripts/verify-schema-consistency.mjs` — `schema.sql` / 迁移 / **真实 MySQL** 三方一致
  （静态比对只能证明「写了」，证明不了「MySQL 真在执行」—— 8.0.15 及更早会**静默忽略** CHECK）

### 6.5 最终基线

| 项 | v1.0 | v1.1 |
| --- | --- | --- |
| PHPUnit | 260 / 740 | **285 / 835** |
| HTTP E2E | 60 断言 | **107 断言** |
| 前后端联调 | 22 断言 | **35 断言** |
| 前端测试 | 449 | **461**（25 个文件） |
| DB CHECK | 29 | **36** |

前端 lint 0 / vue-tsc 0 / build 成功。运行时校验 15 项通过。
