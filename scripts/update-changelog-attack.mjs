/** 把「对抗复核 → 修复」这一段追加到 CHANGELOG。用文件避免反引号在 shell 里被吃掉。 */
import fs from 'node:fs'

const P = '/workspace/CHANGELOG.md'
let s = fs.readFileSync(P, 'utf8')
const BT = String.fromCharCode(96)
const c = (x) => BT + x + BT

const entry = `
---

## 2026-10-04（第三段）· 指标扩充轮的对抗复核与修复

对上一段的 10 个新指标 + 模板 7 + 守卫脚本 + UI 死胡同修复做了对抗式复核。
两条攻击线，一条专攻新指标本身，一条专攻跨源一致性。
**攻破 3 个 BLOCKER / 2 个 HIGH / 4 个 MEDIUM / 2 个 LOW，全部已修。**

### 3 个 BLOCKER

**B-1 迁移 000800 写了一个不存在的列 —— 模板 7 在任何环境都插不进去**

建表迁移里该列叫 ${c('remark')}，新迁移写成了 ${c('description')}。
真实 MySQL 上是 ${c('ER_BAD_FIELD_ERROR (1054)')}，
而 ${c('INSERT IGNORE')} 只降级**数据类**错误，**列名解析错误发生在 prepare 阶段，异常照抛** →
${c('up()')} 的 ${c('try/finally')} 只恢复 ${c('FOREIGN_KEY_CHECKS')}，迁移失败，发布卡住。

这类错误属沙箱盲区（无 PHP/MySQL），补了 ${c('verify-migration-columns.mjs')}：
解析每张表真实列，核对所有 INSERT 的列名与必填项。
**顺带修掉一个老问题**：${c('alarm_history')} 缺 ${c('created_at')}，在 ${c('000200')} 里补上。

**B-2 后端测试套件是红的**

${c('AlarmRuleTest')} 仍断言 28/8/4/10，而字典已是 38/9/5/15。
这条印证了一条判据：**「断言了实现给不出的值」= 证明测试从未运行**。
已改数字，并**补上 MYSQL 的条数断言**（它之前完全没有保护）。

**B-3 「前端基线全 0」这句话当时是假的**

加完 ${c('alarmMonitorTypeOptions')} 那行 import 后没重跑 lint，${c('pnpm lint')} 实际退出码 1。
印证另一条：**「构建和类型检查全绿」不等于 lint 也绿**。

### 2 个 HIGH：两个守卫脚本在夸大自己的作用

| 脚本 | 它的文案声称 | 实际只做 | 复核实测 |
| --- | --- | --- | --- |
| ${c('verify-preset-template.mjs')} | 「三处逐字一致，漂移就报错」 | 只比 ${c('conditions')} 那段 JSON，**6 项内容守 1 项** | 改模板名 / 改 policy_type / 改文案，**全部 EXIT=0** |
| ${c('sync-metrics-backend.mjs')} | 「38 个指标**逐项一致**且顺序一致」 | 只比 ${c('namespace.metricName')} | 阈值 7→99、单位 IOPS→GB/s，**全部 EXIT=0** |

H-4 的盲区**恰好包含 B-1 出错的那一列**。

**这比没有守卫更危险 —— 它给人虚假的安全感。**
已把两处措辞改成各自真正做的事，补上缺失断言，
并新增真正逐字段比对的 ${c('verify-metrics-consistency.mjs')}（三处 × 10 字段 × 38 指标）。

### 4 个 MEDIUM

- **${c('DiskDaysToFull')} 的 description 自称「本字典中唯一一个『越低越糟』的指标」—— 是假的**，
  ${c('HttpSuccessRate')} 早就在字典里且同为 ${c('<')}。
  这段文案会经接口返回给用户、进指标选择器展示，是**面向用户的数据字段**，不是注释。
- **模板数 6→7 一个地方都没改**：${c('metrics.md')} 的章节标题写着
  「## 3. 6 条预置触发条件模板」，而**模板 7 就写在这个章节里**。
  对比：${c('contract.md')} 的 28→38 改了，同一文件里的 6→7 一次没扫 —— **28→38 是部分扫过的**。
- **13 处「28」残留**：改掉描述当前状态的 11 处；
  **保留 ${c('metrics-gap-analysis.md')} 的 4 处**（那是对扩充前现状的历史陈述，
  改了等于篡改分析记录的前提）。判断写进了 ${c('fix-stale-metric-counts.mjs')}，不靠人肉 grep。
- **${c('metrics.md')} 自相矛盾**：§1.5.2 说流量断流「仍缺」，§1.5.3 说模板 7 补上了。
  技术上两边各自成立（「覆盖」列统计**指标**，模板 7 是给已有指标换算子方向），
  是**措辞没交代统计口径**。已补口径说明。

### 2 个 LOW

- **存量 monitorType 兼容路径，仓内测试是复刻件**（docblock 自己写着「复刻」）——
  复刻件**可以和生产代码一起错**。复核方挂载真组件验证了产品行为正确，
  但那份测试写在 ${c('/tmp')} 没进仓，等于**仓里对这条路径零真组件覆盖**。
  已把真挂载测试补进 ${c('policy-form.mount.test.ts')}，并做负对照：
  拆掉存量值合并 → 3 个测试红；关掉新建态过滤 → 1 个测试红。
- **${c('gen-mock-metrics.mjs')} 遇多行 description 会静默产出 null**。
  PHP 单引号字符串允许含换行，若其中一行恰好是 ${c('    ],')}，
  ${c('BLOCK')} 正则会提前截断。已补结构性断言
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
- ${c('env(')} / Dotenv 在真实 Hyperf 3.2 + Swoole 下的行为未验证
- 10 个新指标的 ${c('defaultThreshold')} **未经真实监控数据校准**（文档已标注为占位）

**本轮交付可称「经过多轮静态审查与对抗式复核」，不能称「运行验证通过」。**

`

const marker = '\n---\n\n## 前端 `web/` 原始提交'
if (!s.includes(marker)) {
  console.error('  ✗ 未找到插入锚点')
  process.exit(1)
}
s = s.replace(marker, entry + marker)
fs.writeFileSync(P, s)
console.log(`  ✓ CHANGELOG 已追加第三段；现 ${(s.length / 1024).toFixed(0)}KB`)
