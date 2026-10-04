/** 追加本轮（指标扩充）条目到 CHANGELOG.md。用文件避免反引号在 shell 里被吃掉。 */
import fs from 'node:fs'

const P = '/workspace/CHANGELOG.md'
let s = fs.readFileSync(P, 'utf8')

const BT = String.fromCharCode(96)
const c = (x) => BT + x + BT

const entry = `
---

## 2026-10-04（第二段）· 指标覆盖度第一性原理分析 + 扩充至 38 个

### 起因

前一轮把 44 条审查发现修掉约 10 条后，暴露出一个更根本的问题：
**28 个指标是按「资源清单」枚举的，不是按「失效模式」枚举的。**

### 分析方法

新建 ${c('docs/alarm/metrics-gap-analysis.md')}。不从「腾讯云有什么指标」出发，
而是从**监控系统为什么存在**推导它必须能发现什么，得到 A–F 六类故障语义，
再用三个判据筛掉那些「靠别的指标就能发现」的伪缺口：

| 判据 | 问题 |
| --- | --- |
| R1 故障可达性 | 对应故障用户真的会遇到吗？ |
| R2 状态不可见性 | 这类故障不告警，用户多久会发现？ |
| R3 现有覆盖 | 现有指标里有没有别的能间接发现它？ |

### 三条最重要的发现

1. **E 类「异常」整类缺失** —— 28 个指标全是静态绝对阈值，
   契约 ${c('operator')} 只有 ${c('> >= < <= == !=')} 六个比较算子，
   **没有同比/环比/突变判据**。QPS 从 100 跌到 10、延迟从 20ms 涨到 300ms
   这类「相对自身基线的异常」全部逃逸。
2. **A 类「流量断流」无专用指标** —— ${c('HttpRequestCount')} 阈值 10000 只能发现「QPS 冲到一万」，
   发现不了「QPS 归零」。理论上 ${c('HttpSuccessRate')} 能兜底，但 QPS=0 时分母也是 0，
   不同实现返回 0% 还是 100% 没有统一约定 —— **靠语义未定义的指标兜底最严重的故障不可接受**。
3. **D 类「将耗尽」看着最全、实际漏 4 项** —— CPU/内存/磁盘/IO/连接数五项齐全，
   但漏了 FD 耗尽、inode 耗尽、预计写满天数、IOPS。
   根因是按资源种类枚举：同一份资源有多种耗尽方式（块满 / inode 满 / FD 满 / 配额满），每种独立失效。

### 已落地（不涉及契约变更的 10 个新指标）

| namespace | 新增 | 补的是哪一类缺口 |
| --- | --- | --- |
| CVM +5 | ${c('FileDescriptorUsageRate')} / ${c('InodeUsageRate')} / ${c('DiskDaysToFull')} / ${c('DiskReadIops')} / ${c('DiskWriteIops')} | D 将耗尽 |
| WEB +1 | ${c('HttpMaxDuration')} | B 变慢（P99 之后的长尾） |
| CLB +1 | ${c('ClbBackendResponseTime')} | B 变慢（与 ${c('HttpP99Duration')} 交叉定位） |
| MYSQL +3 | ${c('MysqlDeadlockCount')} / ${c('MysqlLockWaitTime')} / ${c('MysqlConnectionRejectCount')} | C 错误 |

**指标总数 28 → 38**（CVM 15 / WEB 9 / CLB 5 / MYSQL 9）。

${c('DiskDaysToFull')} 是全字典**唯一** ${c('defaultOperator')} 为 ${c('<')} 的指标（「越低越糟」），
已确认 ${c('ConditionValidator::assertThreshold')} 用的是 ${c('===')} 严格比较，
${c('threshold = 0')} 不会被 falsy 误判成缺省（S-04 踩过的坑没有重演）。

### 预置模板 7「流量断流」

A 类缺口的唯一落地方式：${c('HttpRequestCount')} + ${c('<')} + 阈值 ${c('1')} + 紧急等级。
落在**新建的迁移文件** ${c('2026_10_04_000800_*.php')}，
**不改已应用的 000700**（改已应用迁移是「模板在不同环境行为不同」的经典成因）。

### UI 死胡同修复（F-a）

契约说 ${c('monitorType')} 的 3/4/5 不可选，但向导此前把它们**全列在下拉里**。
用户选「前端性能监控」→ 策略类型为空 → 提示「暂无可用策略类型」
→ **既走不完向导，也退不出这个选择**。这是功能不可用，不是体验瑕疵。

修法是**不提供不可选项**（${c('alarmSelectableMonitorTypeOptions')}，按联动表数据驱动过滤），
**同时**让存量值可见：若表单当前值是 3/4/5，追加一项并标注「（v1.0 不可选）」。
不这么做的话，编辑这类存量策略时 Reka Select 找不到匹配 item 会回退显示 placeholder，
**真实值凭空消失**（数据库层没有 CHECK 强制，这类数据确实可能存在）。

列表筛选器**保留全量 5 项** —— 筛选项要能查存量，筛选器不负责「新建时能不能选」。

### mock 与文档一致性

- ${c('web/src/mocks/index.ts')} 的 ${c('/metrics')} 原先只有 **1 条手写** 指标，
  注释还写着「不要把这份数据当字典用」。现改为从后端字典生成（${c('gen-mock-metrics.mjs')}），
  **mock 与真实字典不可能漂移**。
- 新增 ${c('verify-metrics-consistency.mjs')}：**三处 × 10 字段 × 38 指标**全比对
  （metrics.md ↔ metrics.php ↔ generated.ts），
  并校验 contract.md 的计数与两个文件的头注释。
  已验证它能抓出：改一个 threshold / 往 description 塞反引号 / 删掉一个指标。

### 交叉校验发现并修掉的 3 处漂移

独立复核（自写 Python 解析器，未复用任何现成脚本）判定
**「单一事实来源」不变量不成立** —— 原先的校验只比 9 个字段，**漏了 ${c('description')}**：

| 漂移 | 归属 |
| --- | --- |
| 8 个字面反引号残留（${c('long_query_time')}、${c('max_connections')}…） | **原有 28 条就有的**，扩充时原样保留 |
| ${c('DiskDaysToFull')} 多一个空格 | **本轮引入** |
| ${c('metrics.php')} 头注释仍写「共 28 个」 | **本轮引入** |

反引号那条的实质：metrics.md 里反引号是 markdown 行内代码（渲染后消失），
而 php 是纯文本字符串，**接口会把带反引号的文本原样显示给用户**。已全部剥离。

### 验证边界

- ✅ 前端四项基线全 0；${c('verify-metrics-consistency.mjs')} 与
  ${c('verify-preset-template.mjs')} 均通过且有牙齿
- ❌ **后端仍一行 PHP 都没跑过**；新增迁移 000800 从未执行；
  10 个新指标的 ${c('defaultThreshold')} 未经真实监控数据校准（文档中已标注为占位）

`

const marker = '\n---\n\n## 前端 `web/` 原始提交'
if (!s.includes(marker)) {
  console.error('  ✗ 未找到插入锚点')
  process.exit(1)
}
s = s.replace(marker, entry + marker)
fs.writeFileSync(P, s)
console.log(`  ✓ CHANGELOG 已追加；现 ${(s.length / 1024).toFixed(0)}KB`)
