# Changelog — 告警管理功能

> 本文件记录**本项目**的开发历史。
> `web/CHANGELOG.md` 是上游模板 [shadcn-vue-admin](https://github.com/Whbbit1999/shadcn-vue-admin) 自带的版本记录，与本项目无关，未做改动。

---

## 说明：历史提交去哪了

前端 `web/` 原本是一个独立的 Git 仓库，有 6 个提交。本项目推送到 monorepo 时是通过 GitHub API 逐文件推送的
（`push_files`），**没有携带 Git 历史**，所以本仓库的提交历史是从零开始的。

原始 6 个提交的信息在下方完整保留。`server/` 后端**从未被 Git 管理过**，一直是沙箱里的裸目录，
因此它没有提交历史可记录——它的变更节点只能按功能阶段归纳。

---

## 2026-10-03 · 五批修复 + 对抗式复核

一轮**四线对抗式审查**（51 条原始发现去重为 44 条）之后，做了五批修复，
随后又发起了**针对修复本身的对抗式复核**（54 个攻击/探针）。

### 修复清单

| 编号 | 问题 | 级别 |
| --- | --- | --- |
| S-01 | `insertConditions()` 把 camelCase 条件键直接写入 snake_case 表 → 全部落库失败 | 阻塞 |
| S-02 | `computed(() => form.state.values)` 响应式依赖图为空 → 向导永远停在第 1 步 | 阻塞 |
| S-03 | 5 个语义常量求值都是 409，被当数组键 → 5 条文案塌缩成 1 条 | 严重 |
| S-04 | 启停接口缺 `status` 时静默停用线上策略并返回 200 | 严重 |
| S-05 | 通知模板字典 `pageSize:100` 截断 → 字典外的 id 被判「不存在」，保存必失败 | 严重 |
| S-07 | 6 个 `up()` 无条件 `DROP TABLE` → 重跑迁移静默清空整表 | 严重 |
| S-08 | `schema.sql` 声明 `MySQL >= 8.0.13`，而 8.0.16 以下**只解析不执行 CHECK** → 29 条约束静默失效 | 严重 |
| S-09 | `isDuplicateKey()` 把整个 SQLSTATE `23xxx` 当「重名」→ 外键失败被报成「策略名称已存在」 | 严重 |
| S-10 | 鉴权中间件白名单为空时 fail-open → 漏配一个环境变量即全部接口无鉴权 | 严重 |
| S-17 | 迁移不设 `FOREIGN_KEY_CHECKS` → 失败后 errno 3730 不可自愈 | 中等 |

### 复核过程中发现并修掉的、**由修复本身引入**的问题

这几条值得单独记，因为它们是「改完之后才发现」：

- **本以为 fail-closed 是纯收益，结果它把服务锁死了。**
  `composer.json` 缺 `hyperf/dotenv`、`config/bootstrap.php` 不存在 →
  `env()` 没有数据源 → `ALARM_STATIC_TOKENS` 恒为空 → 配合新的 fail-closed
  语义，**19 个端点永久 401，且 `ALARM_AUTH_DISABLED` 这个逃生舱同样读不到**。
  修复前的 fail-open 在这个仓库里**恰好是能用的**（不安全但通）。
- **`.env.example` 预填了可用的 `dev-token-1`**，而 `composer.json` 的
  `post-root-package-install` 会自动 copy 成 `.env` → 白送公开凭据。
- **S-04 改了行为却没有一条测试**：既有 5 处 `changeStatus` 全传 0/1，从没传过 `null`/``。
- **S-10 改了全部 19 个端点的鉴权语义，后端零测试**。
- **401 在默认态被完全吞掉**：`handleUnauthorized()` 第一行就早退，
  无 toast、无跳转、无日志 —— 正好是 S-10 声称要避免的「静默」。
  顺带发现原来 `isLogin` **兼职当了去重器**，把 toast 移出守卫会导致并发 401 刷屏。

### 验证边界（务必阅读）

- ✅ **前端**：`lint` / `vue-tsc` / `test:run` / `build` 全 0，**431 用例 / 23 个测试文件**
- ✅ 后端 56 个 PHP 文件通过结构检查；3 个可复现的验证脚本（迁移幂等性、S-09 分类表）
- ❌ **后端一行 PHP 都没执行过**。`server/vendor` 不存在，沙箱无 PHP / Composer / MySQL / Redis。
  151 个测试方法**从未运行**，D-2 的超全局变量优先级是静态推理而非实测。
- ❌ **未做前后端真实联调**，告警引擎的触发/去重/投递完全未审。

> 因此后端只能称为「经过多轮静态审查的代码」，**不能**称为「运行验证通过」。

### 本次新增

- `server/config/bootstrap.php` —— env() 的唯一数据源加载点
- 4 个后端测试文件（`AuthMiddlewareTest` / `PolicyStatusValidationTest` /
  `IntegrityViolationMappingTest` / `EnvBootstrapTest`），
  测试方法数 **109 → 151**
- `web/src/lib/__tests__/api-client.auth.test.ts` —— Bearer 头回归
- `.audit/` 8 份审查与复核报告（84KB 主报告 + 4 份攻击报告 + 汇总判定）
- `scripts/` 3 个可复现的验证脚本


---

## 2026-10-04（第二段）· 指标覆盖度第一性原理分析 + 扩充至 38 个

### 起因

前一轮把 44 条审查发现修掉约 10 条后，暴露出一个更根本的问题：
**28 个指标是按「资源清单」枚举的，不是按「失效模式」枚举的。**

### 分析方法

新建 `docs/alarm/metrics-gap-analysis.md`。不从「腾讯云有什么指标」出发，
而是从**监控系统为什么存在**推导它必须能发现什么，得到 A–F 六类故障语义，
再用三个判据筛掉那些「靠别的指标就能发现」的伪缺口：

| 判据 | 问题 |
| --- | --- |
| R1 故障可达性 | 对应故障用户真的会遇到吗？ |
| R2 状态不可见性 | 这类故障不告警，用户多久会发现？ |
| R3 现有覆盖 | 现有指标里有没有别的能间接发现它？ |

### 三条最重要的发现

1. **E 类「异常」整类缺失** —— 28 个指标全是静态绝对阈值，
   契约 `operator` 只有 `> >= < <= == !=` 六个比较算子，
   **没有同比/环比/突变判据**。QPS 从 100 跌到 10、延迟从 20ms 涨到 300ms
   这类「相对自身基线的异常」全部逃逸。
2. **A 类「流量断流」无专用指标** —— `HttpRequestCount` 阈值 10000 只能发现「QPS 冲到一万」，
   发现不了「QPS 归零」。理论上 `HttpSuccessRate` 能兜底，但 QPS=0 时分母也是 0，
   不同实现返回 0% 还是 100% 没有统一约定 —— **靠语义未定义的指标兜底最严重的故障不可接受**。
3. **D 类「将耗尽」看着最全、实际漏 4 项** —— CPU/内存/磁盘/IO/连接数五项齐全，
   但漏了 FD 耗尽、inode 耗尽、预计写满天数、IOPS。
   根因是按资源种类枚举：同一份资源有多种耗尽方式（块满 / inode 满 / FD 满 / 配额满），每种独立失效。

### 已落地（不涉及契约变更的 10 个新指标）

| namespace | 新增 | 补的是哪一类缺口 |
| --- | --- | --- |
| CVM +5 | `FileDescriptorUsageRate` / `InodeUsageRate` / `DiskDaysToFull` / `DiskReadIops` / `DiskWriteIops` | D 将耗尽 |
| WEB +1 | `HttpMaxDuration` | B 变慢（P99 之后的长尾） |
| CLB +1 | `ClbBackendResponseTime` | B 变慢（与 `HttpP99Duration` 交叉定位） |
| MYSQL +3 | `MysqlDeadlockCount` / `MysqlLockWaitTime` / `MysqlConnectionRejectCount` | C 错误 |

**指标总数 28 → 38**（CVM 15 / WEB 9 / CLB 5 / MYSQL 9）。

`DiskDaysToFull` 是全字典**唯一** `defaultOperator` 为 `<` 的指标（「越低越糟」），
已确认 `ConditionValidator::assertThreshold` 用的是 `===` 严格比较，
`threshold = 0` 不会被 falsy 误判成缺省（S-04 踩过的坑没有重演）。

### 预置模板 7「流量断流」

A 类缺口的唯一落地方式：`HttpRequestCount` + `<` + 阈值 `1` + 紧急等级。
落在**新建的迁移文件** `2026_10_04_000800_*.php`，
**不改已应用的 000700**（改已应用迁移是「模板在不同环境行为不同」的经典成因）。

### UI 死胡同修复（F-a）

契约说 `monitorType` 的 3/4/5 不可选，但向导此前把它们**全列在下拉里**。
用户选「前端性能监控」→ 策略类型为空 → 提示「暂无可用策略类型」
→ **既走不完向导，也退不出这个选择**。这是功能不可用，不是体验瑕疵。

修法是**不提供不可选项**（`alarmSelectableMonitorTypeOptions`，按联动表数据驱动过滤），
**同时**让存量值可见：若表单当前值是 3/4/5，追加一项并标注「（v1.0 不可选）」。
不这么做的话，编辑这类存量策略时 Reka Select 找不到匹配 item 会回退显示 placeholder，
**真实值凭空消失**（数据库层没有 CHECK 强制，这类数据确实可能存在）。

列表筛选器**保留全量 5 项** —— 筛选项要能查存量，筛选器不负责「新建时能不能选」。

### mock 与文档一致性

- `web/src/mocks/index.ts` 的 `/metrics` 原先只有 **1 条手写** 指标，
  注释还写着「不要把这份数据当字典用」。现改为从后端字典生成（`gen-mock-metrics.mjs`），
  **mock 与真实字典不可能漂移**。
- 新增 `verify-metrics-consistency.mjs`：**三处 × 10 字段 × 38 指标**全比对
  （metrics.md ↔ metrics.php ↔ generated.ts），
  并校验 contract.md 的计数与两个文件的头注释。
  已验证它能抓出：改一个 threshold / 往 description 塞反引号 / 删掉一个指标。

### 交叉校验发现并修掉的 3 处漂移

独立复核（自写 Python 解析器，未复用任何现成脚本）判定
**「单一事实来源」不变量不成立** —— 原先的校验只比 9 个字段，**漏了 `description`**：

| 漂移 | 归属 |
| --- | --- |
| 8 个字面反引号残留（`long_query_time`、`max_connections`…） | **原有 28 条就有的**，扩充时原样保留 |
| `DiskDaysToFull` 多一个空格 | **本轮引入** |
| `metrics.php` 头注释仍写「共 28 个」 | **本轮引入** |

反引号那条的实质：metrics.md 里反引号是 markdown 行内代码（渲染后消失），
而 php 是纯文本字符串，**接口会把带反引号的文本原样显示给用户**。已全部剥离。

### 验证边界

- ✅ 前端四项基线全 0；`verify-metrics-consistency.mjs` 与
  `verify-preset-template.mjs` 均通过且有牙齿
- ❌ **后端仍一行 PHP 都没跑过**；新增迁移 000800 从未执行；
  10 个新指标的 `defaultThreshold` 未经真实监控数据校准（文档中已标注为占位）


---

## 2026-10-04（第三段）· 指标扩充轮的对抗复核与修复

对上一段的 10 个新指标 + 模板 7 + 守卫脚本 + UI 死胡同修复做了对抗式复核。
两条攻击线，一条专攻新指标本身，一条专攻跨源一致性。
**攻破 3 个 BLOCKER / 2 个 HIGH / 4 个 MEDIUM / 2 个 LOW，全部已修。**

### 3 个 BLOCKER

**B-1 迁移 000800 写了一个不存在的列 —— 模板 7 在任何环境都插不进去**

建表迁移里该列叫 `remark`，新迁移写成了 `description`。
真实 MySQL 上是 `ER_BAD_FIELD_ERROR (1054)`，
而 `INSERT IGNORE` 只降级**数据类**错误，**列名解析错误发生在 prepare 阶段，异常照抛** →
`up()` 的 `try/finally` 只恢复 `FOREIGN_KEY_CHECKS`，迁移失败，发布卡住。

这类错误属沙箱盲区（无 PHP/MySQL），补了 `verify-migration-columns.mjs`：
解析每张表真实列，核对所有 INSERT 的列名与必填项。
**顺带修掉一个老问题**：`alarm_history` 缺 `created_at`，在 `000200` 里补上。

**B-2 后端测试套件是红的**

`AlarmRuleTest` 仍断言 28/8/4/10，而字典已是 38/9/5/15。
这条印证了一条判据：**「断言了实现给不出的值」= 证明测试从未运行**。
已改数字，并**补上 MYSQL 的条数断言**（它之前完全没有保护）。

**B-3 「前端基线全 0」这句话当时是假的**

加完 `alarmMonitorTypeOptions` 那行 import 后没重跑 lint，`pnpm lint` 实际退出码 1。
印证另一条：**「构建和类型检查全绿」不等于 lint 也绿**。

### 2 个 HIGH：两个守卫脚本在夸大自己的作用

| 脚本 | 它的文案声称 | 实际只做 | 复核实测 |
| --- | --- | --- | --- |
| `verify-preset-template.mjs` | 「三处逐字一致，漂移就报错」 | 只比 `conditions` 那段 JSON，**6 项内容守 1 项** | 改模板名 / 改 policy_type / 改文案，**全部 EXIT=0** |
| `sync-metrics-backend.mjs` | 「38 个指标**逐项一致**且顺序一致」 | 只比 `namespace.metricName` | 阈值 7→99、单位 IOPS→GB/s，**全部 EXIT=0** |

H-4 的盲区**恰好包含 B-1 出错的那一列**。

**这比没有守卫更危险 —— 它给人虚假的安全感。**
已把两处措辞改成各自真正做的事，补上缺失断言，
并新增真正逐字段比对的 `verify-metrics-consistency.mjs`（三处 × 10 字段 × 38 指标）。

### 4 个 MEDIUM

- **`DiskDaysToFull` 的 description 自称「本字典中唯一一个『越低越糟』的指标」—— 是假的**，
  `HttpSuccessRate` 早就在字典里且同为 `<`。
  这段文案会经接口返回给用户、进指标选择器展示，是**面向用户的数据字段**，不是注释。
- **模板数 6→7 一个地方都没改**：`metrics.md` 的章节标题写着
  「## 3. 6 条预置触发条件模板」，而**模板 7 就写在这个章节里**。
  对比：`contract.md` 的 28→38 改了，同一文件里的 6→7 一次没扫 —— **28→38 是部分扫过的**。
- **13 处「28」残留**：改掉描述当前状态的 11 处；
  **保留 `metrics-gap-analysis.md` 的 4 处**（那是对扩充前现状的历史陈述，
  改了等于篡改分析记录的前提）。判断写进了 `fix-stale-metric-counts.mjs`，不靠人肉 grep。
- **`metrics.md` 自相矛盾**：§1.5.2 说流量断流「仍缺」，§1.5.3 说模板 7 补上了。
  技术上两边各自成立（「覆盖」列统计**指标**，模板 7 是给已有指标换算子方向），
  是**措辞没交代统计口径**。已补口径说明。

### 2 个 LOW

- **存量 monitorType 兼容路径，仓内测试是复刻件**（docblock 自己写着「复刻」）——
  复刻件**可以和生产代码一起错**。复核方挂载真组件验证了产品行为正确，
  但那份测试写在 `/tmp` 没进仓，等于**仓里对这条路径零真组件覆盖**。
  已把真挂载测试补进 `policy-form.mount.test.ts`，并做负对照：
  拆掉存量值合并 → 3 个测试红；关掉新建态过滤 → 1 个测试红。
- **`gen-mock-metrics.mjs` 遇多行 description 会静默产出 null**。
  PHP 单引号字符串允许含换行，若其中一行恰好是 `    ],`，
  `BLOCK` 正则会提前截断。已补结构性断言
  （解析条数必须等于源文件 4 空格缩进数组块数）+ 换行禁令 + 报错指向真正成因，
  并用复核方给的构造用例做负对照。

### 修复后的验证边界

**✅ 真跑过并全绿**

- 前端四项基线：lint 0 / vue-tsc 0 / **449 个测试通过（24 个文件）** / build 18.49s
- 6 个守卫脚本 EXIT=0，且**逐个验证过注入错误会变红**（见报告 §4）

**❌ 仍未运行**

- **后端 151+ 个测试方法一行都没执行过**
- 迁移 000100～000800 **从未在真实 MySQL 上跑过**；
  B-1 那个 1054 正是纯静态比对抓出来的 —— **静态校验不能替代真跑**
- `env(` / Dotenv 在真实 Hyperf 3.2 + Swoole 下的行为未验证
- 10 个新指标的 `defaultThreshold` **未经真实监控数据校准**（文档已标注为占位）

**本轮交付可称「经过多轮静态审查与对抗式复核」，不能称「运行验证通过」。**


---

## 2026-10-04（第二段）· 指标覆盖度第一性原理分析 + 扩充至 38 个

### 起因

前一轮把 44 条审查发现修掉约 10 条后，暴露出一个更根本的问题：
**28 个指标是按「资源清单」枚举的，不是按「失效模式」枚举的。**

### 分析方法

新建 `docs/alarm/metrics-gap-analysis.md`。不从「腾讯云有什么指标」出发，
而是从**监控系统为什么存在**推导它必须能发现什么，得到 A–F 六类故障语义，
再用三个判据筛掉那些「靠别的指标就能发现」的伪缺口：

| 判据 | 问题 |
| --- | --- |
| R1 故障可达性 | 对应故障用户真的会遇到吗？ |
| R2 状态不可见性 | 这类故障不告警，用户多久会发现？ |
| R3 现有覆盖 | 现有指标里有没有别的能间接发现它？ |

### 三条最重要的发现

1. **E 类「异常」整类缺失** —— 28 个指标全是静态绝对阈值，
   契约 `operator` 只有 `> >= < <= == !=` 六个比较算子，
   **没有同比/环比/突变判据**。QPS 从 100 跌到 10、延迟从 20ms 涨到 300ms
   这类「相对自身基线的异常」全部逃逸。
2. **A 类「流量断流」无专用指标** —— `HttpRequestCount` 阈值 10000 只能发现「QPS 冲到一万」，
   发现不了「QPS 归零」。理论上 `HttpSuccessRate` 能兜底，但 QPS=0 时分母也是 0，
   不同实现返回 0% 还是 100% 没有统一约定 —— **靠语义未定义的指标兜底最严重的故障不可接受**。
3. **D 类「将耗尽」看着最全、实际漏 4 项** —— CPU/内存/磁盘/IO/连接数五项齐全，
   但漏了 FD 耗尽、inode 耗尽、预计写满天数、IOPS。
   根因是按资源种类枚举：同一份资源有多种耗尽方式（块满 / inode 满 / FD 满 / 配额满），每种独立失效。

### 已落地（不涉及契约变更的 10 个新指标）

| namespace | 新增 | 补的是哪一类缺口 |
| --- | --- | --- |
| CVM +5 | `FileDescriptorUsageRate` / `InodeUsageRate` / `DiskDaysToFull` / `DiskReadIops` / `DiskWriteIops` | D 将耗尽 |
| WEB +1 | `HttpMaxDuration` | B 变慢（P99 之后的长尾） |
| CLB +1 | `ClbBackendResponseTime` | B 变慢（与 `HttpP99Duration` 交叉定位） |
| MYSQL +3 | `MysqlDeadlockCount` / `MysqlLockWaitTime` / `MysqlConnectionRejectCount` | C 错误 |

**指标总数 28 → 38**（CVM 15 / WEB 9 / CLB 5 / MYSQL 9）。

`DiskDaysToFull` 是全字典**唯一** `defaultOperator` 为 `<` 的指标（「越低越糟」），
已确认 `ConditionValidator::assertThreshold` 用的是 `===` 严格比较，
`threshold = 0` 不会被 falsy 误判成缺省（S-04 踩过的坑没有重演）。

### 预置模板 7「流量断流」

A 类缺口的唯一落地方式：`HttpRequestCount` + `<` + 阈值 `1` + 紧急等级。
落在**新建的迁移文件** `2026_10_04_000800_*.php`，
**不改已应用的 000700**（改已应用迁移是「模板在不同环境行为不同」的经典成因）。

### UI 死胡同修复（F-a）

契约说 `monitorType` 的 3/4/5 不可选，但向导此前把它们**全列在下拉里**。
用户选「前端性能监控」→ 策略类型为空 → 提示「暂无可用策略类型」
→ **既走不完向导，也退不出这个选择**。这是功能不可用，不是体验瑕疵。

修法是**不提供不可选项**（`alarmSelectableMonitorTypeOptions`，按联动表数据驱动过滤），
**同时**让存量值可见：若表单当前值是 3/4/5，追加一项并标注「（v1.0 不可选）」。
不这么做的话，编辑这类存量策略时 Reka Select 找不到匹配 item 会回退显示 placeholder，
**真实值凭空消失**（数据库层没有 CHECK 强制，这类数据确实可能存在）。

列表筛选器**保留全量 5 项** —— 筛选项要能查存量，筛选器不负责「新建时能不能选」。

### mock 与文档一致性

- `web/src/mocks/index.ts` 的 `/metrics` 原先只有 **1 条手写** 指标，
  注释还写着「不要把这份数据当字典用」。现改为从后端字典生成（`gen-mock-metrics.mjs`），
  **mock 与真实字典不可能漂移**。
- 新增 `verify-metrics-consistency.mjs`：**三处 × 10 字段 × 38 指标**全比对
  （metrics.md ↔ metrics.php ↔ generated.ts），
  并校验 contract.md 的计数与两个文件的头注释。
  已验证它能抓出：改一个 threshold / 往 description 塞反引号 / 删掉一个指标。

### 交叉校验发现并修掉的 3 处漂移

独立复核（自写 Python 解析器，未复用任何现成脚本）判定
**「单一事实来源」不变量不成立** —— 原先的校验只比 9 个字段，**漏了 `description`**：

| 漂移 | 归属 |
| --- | --- |
| 8 个字面反引号残留（`long_query_time`、`max_connections`…） | **原有 28 条就有的**，扩充时原样保留 |
| `DiskDaysToFull` 多一个空格 | **本轮引入** |
| `metrics.php` 头注释仍写「共 28 个」 | **本轮引入** |

反引号那条的实质：metrics.md 里反引号是 markdown 行内代码（渲染后消失），
而 php 是纯文本字符串，**接口会把带反引号的文本原样显示给用户**。已全部剥离。

### 验证边界

- ✅ 前端四项基线全 0；`verify-metrics-consistency.mjs` 与
  `verify-preset-template.mjs` 均通过且有牙齿
- ❌ **后端仍一行 PHP 都没跑过**；新增迁移 000800 从未执行；
  10 个新指标的 `defaultThreshold` 未经真实监控数据校准（文档中已标注为占位）


---

## 前端 `web/` 原始提交（2026-09-29 → 2026-10-02）

### `909de27` — 2026-09-29 17:15 · `chore: deps update`

导入 shadcn-vue-admin 模板基线。此提交不含任何告警功能。

---

### `1d020a6` — 2026-09-30 16:33 · `feat(alarm): contract type layer + alarm module scaffold`

建立告警模块的地基。

**新增/修改 34 个文件**，其中告警相关 17 个：

| 类别 | 内容 |
|---|---|
| 契约类型层 | `src/types/alarm.ts` — 19 个端点的请求/响应 DTO、12 组枚举 |
| API 传输层 | `services/api/alarm-{policy,history,notification}.api.ts` 三个模块 |
| Mock 层 | `mocks/alarm.mock.ts`、`mocks/router.mock.ts` — 无后端时可跑 |
| 导航 | `config/alarm-nav.ts` — 侧边栏「告警管理」入口 |
| 页面骨架 | `pages/alarm/` 下 6 个占位页（policy 列表/新建/详情/编辑、通知模板、历史） |
| 公共组件 | `condition-editor.vue`、`alarm-level-badge.vue`、`alarm-enum-options.ts` |

**同时删除 45 个模板演示文件**——这是模板裁剪，不是功能改动：
`pages/marketing`、`pages/billing`、`pages/ai-talk`、`pages/apps`、
`layouts/marketing.vue`、`components/marketing/*`、`components/inspira-ui/*`。

改动量：+2811 / −2754。

---

### `5ce0286` — 2026-10-01 04:42 · `feat(alarm): notification template + alarm history pages`

**21 个文件，+5135 / −19。** 两大模块从占位页变成可用实现。

- **通知模板**：列表、表单（渠道配置器 `notification-channel-editor.vue`）、删除确认、行操作
- **告警历史**：统计概览卡（`history-overview-cards.vue`）、时间范围选择器、行操作（处理/忽略/恢复）
- 两者都遵循同一套分层：`logic.ts`（业务）+ `refresh.ts`（刷新信号）+ `components/` + `__tests__/`

---

### `144017e` — 2026-10-01 04:43 · `feat(alarm): policy list + wizard + detail`

**17 个文件，+5791 / −49。** 改动量最大的一次提交。

- **列表页**：`policy-filters.vue` 多条件筛选 + 分页
- **三步向导**：`create.vue` / `[id]/edit.vue` 共用 `policy-form.vue`（60KB，本项目最大的单文件）
- **详情页**：`policy-detail.vue`
- **策略操作**：复制、删除、启停（`policy-row-actions.vue`）
- **校验**：`validators/policy.validator.ts` — 独立于表单组件，可单测

---

### `1eb81d3` — 2026-10-01 05:24 · `fix(alarm): separate request/response channel types + enum narrowing helpers`

**4 个文件，+192 / −3。** 修两个契约层面的隐患。

1. **请求/响应类型分离** — 新增 `NotificationChannelPayload`。此前通知渠道的请求和响应共用一个类型，
   契约里可选字段（`receivers` 等）在请求侧被误判为必填。
2. **枚举收窄工具** — 保留严格枚举类型（不放宽成 `number`），新增 `toAlarm*` 系列函数在运行时收窄。
   校验器强制 `cast`，避免用类型断言掩盖真实数据问题。

---

### `00c3ec8` — 2026-10-02 01:39 · `fix(alarm): 回调渠道误填接收人显式提示，不再静默丢弃`

**2 个文件，+87 / −4。** 跨端审计发现的中等问题。

回调渠道填了 `receivers` 时，旧实现会**静默丢弃**该字段——用户以为配了接收人，实际没生效。
改为显式提示。修复过程同步补了测试。

---

## 后端 `server/` — 无 Git 历史

后端 64 个 PHP 文件 / 约 7030 行，**从未被 Git 管理**，因此没有逐次提交记录。
按开发阶段归纳：

| 阶段 | 内容 |
|---|---|
| 规格冻结 | 以 `docs/alarm/contract.md` 为唯一事实来源，锁定 19 端点、12 组枚举、业务规则 |
| 骨架与迁移 | 19 个业务端点 + 7 个按表拆分的迁移文件（每条迁移只执行一条 `Db::statement()`） |
| DTO 与校验 | 请求/响应对象、枚举校验、业务规则实现 |
| 测试 | 109 个测试方法代码 |
| 缺陷修复 | 修 4 个致命缺陷（见下） |

### 审查中修复的 4 个致命缺陷

| 缺陷 | 后果 |
|---|---|
| `Router::addGroup` 签名用错 | 服务无法启动 |
| `operator` 被按数字校验 | 全部写入操作被拒（它必须是 `>` `>=` `<` `<=` `==` `!=` 符号字符串）|
| 更新逻辑静默不落库 | 数据丢失 |
| 成功响应 HTTP 状态为 0 | 违反响应契约 |

---

## 验证状态（重要）

| | 状态 | 依据 |
|---|---|---|
| **前端** | ✅ 验证过能跑 | `lint` / `vue-tsc` / **424 个测试** / `build` 四项退出码全 0 |
| **后端** | ⚠️ **从未运行过** | 沙箱无 PHP / Composer / MySQL，109 个测试、迁移、启动一次都没执行 |

后端是「**经多轮对抗式静态审查的代码**」，不是「验证过能跑的代码」。
静态审查发现不了运行时问题——第一次在真实环境启动时很可能还要修一轮。
详见 [`INTEGRATION.md`](./INTEGRATION.md)。

---

## 推送记录（2026-10-04 第三段）

**仓库**：https://github.com/RossBool/mmx-hyperf-queue-monitor （分支 `main`）

本轮共 **19 个批次 / 77 个文件**，每批都用 `push_files` 返回的
`ref` + `object.sha` 作为成功判据（**空返回不算成功** —— 上一轮正是
因为把空串当成功，重复推送生成了几个空提交）。

### 远端核验：77/77 逐字节一致

`get_commit` 的文件清单**不能**用来核验，原因有两条：

1. 它只列**本次真正变化**的文件 —— 内容与远端已一致的文件不会出现，
   所以「清单里没有」≠「没推上去」；
2. 这个 connector 的 `get_commit` **不返回 `parents`**，无法遍历历史。

`get_file_contents` 又是只读受限的，拿不到正文。但它会返回
`successfully downloaded text file (SHA: <sha>)` —— 那个 SHA 就是
**git blob 对象哈希**（`sha1("blob <字节数>\0" + 内容)`），
可用 `git hash-object` 在本地算出精确对比。

实测 **77 个文件远端 blob SHA 与本地完全相同**，即字节级一致。

核验脚本：`scripts/verify-github-blob-sha.mjs`。

