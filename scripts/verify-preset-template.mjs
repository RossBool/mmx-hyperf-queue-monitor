/**
 * 预置模板「流量断流」的三处拷贝一致性校验。
 *
 * 同一条模板的内容出现在三个地方：
 *   1. server/migrations/2026_10_04_000800_*.php  （增量迁移）
 *   2. docs/alarm/schema.sql                       （推倒重建脚本）
 *   3. docs/alarm/metrics.md §3                   （模板文档）
 *
 * 契约 §0.6 的精神是「同一事实只有一处定义」；seed 数据是例外（三处都是它的消费者），
 * 所以必须靠脚本保证不漂移 —— 手改三处 200 字符的 JSON，漏一处就是「模板在不同环境行为不同」。
 *
 * ⚠️ 匹配必须锚定 `metricName`，不能只按 namespace 匹配：
 *    schema.sql 里 WEB 的第一条是「服务错误率升高」（Http5xxRatio），
 *    只按 namespace 匹配会抓到错误的模板并报出假阳性。
 */
import fs from 'node:fs'

/**
 * ⚠️ 本脚本的覆盖范围（对抗复核实测得出，别夸大它的作用）：
 *
 *   守住   —— conditions 那段 JSON 字符串在三处是否逐字节相同
 *   补上   —— 模板名 name、policy_type、INSERT 列清单
 *   守不住 —— description 文案（改文案它不会红）
 *
 * 对抗复核的实测：把模板名在迁移和 schema 两处同时改掉、把 policy_type 从 1 改成 3、
 * 把 description 换成另一句话，本脚本**全部返回 EXIT=0**。其中
 * 「INSERT 列清单写错列名」是那一轮攻破的 BLOCKER（description 列在表里叫 remark），
 * 现在由 verify-migration-columns.mjs 独立兜住。
 */
const ANCHOR = '"metricName":"HttpRequestCount"'
const grab = (src) => {
  const at = src.indexOf(ANCHOR)
  if (at < 0) return null
  // anchor 与 `[{"sort"` 同行，所以从 at **往前**找；
  // ⚠️ 不能拿 lineStart 去找 —— `[{"sort"` 在行首之后（前面有缩进和引号），
  //    lastIndexOf(x, lineStart) 会漏掉它（这版脚本第一版就栽在这里）。
  const start = src.lastIndexOf('[{"sort"', at)
  const end = src.indexOf('\'', at)
  if (start < 0 || end < 0) return null
  return src.slice(start, end)
}

const sources = [
  ['迁移 000800', '/workspace/server/migrations/2026_10_04_000800_add_traffic_dropout_template.php'],
  ['schema.sql', '/workspace/docs/alarm/schema.sql'],
]

const picked = []
for (const [label, path] of sources) {
  const v = grab(fs.readFileSync(path, 'utf8'))
  console.log(`  ${v ? '✓' : '✗'} ${label}`)
  picked.push([label, v])
}

// ⚠️ metrics.md **不参与**「逐字一致」比对：
//    它的模板段是表格（模板 1-7 统一格式），没有裸 JSON 可比。
//    三处里只有迁移与 schema.sql 是逐字拷贝，metrics.md 改为下面单独校验表格取值。
const base = picked[0][1]
if (!base) {
  console.error('  ✗ 迁移里没找到模板，终止')
  process.exit(1)
}
let drift = 0
for (const [label, v] of picked) {
  if (v === base) console.log(`  ✓ ${label} 与迁移逐字一致`)
  else { drift++; console.error(`  ✗ ${label} 与迁移不一致:\n     迁移: ${base}\n     ${label}: ${v}`) }
}

// 契约约束逐条校验

// ── 补三条断言：模板名、policy_type、INSERT 列清单 ─────────────────
// 原版只比 conditions JSON，上面三项全在 slice 之外（对抗复核实测：改掉它们脚本仍全绿）
const migSrc = fs.readFileSync(sources[0][1], 'utf8')
// ⚠️ 必须从 INSERT 之后开始找：文件 docblock 里也提到了「流量断流」，
//    用 indexOf 会匹配到注释而不是数据行（第一版就栽在这）。
const insAt = migSrc.indexOf('INSERT IGNORE INTO')
const tplAt = migSrc.indexOf("('流量断流',", insAt)
if (insAt < 0 || tplAt < 0) { console.log('  ✗ 迁移里找不到模板「流量断流」的数据行'); process.exit(1) }
const colList = (migSrc.match(/\(`name`, `(\w+)`, `policy_type`/) || [])[1]
if (!colList) { console.log('  ✗ 解析不出迁移的 INSERT 列清单（第 2 列应为 remark）'); process.exit(1) }
console.log(`  ✓ 迁移 INSERT 第 2 列 = ${colList}`)
if (colList !== 'remark') { console.log('  ✗ 模板说明列应为 remark（建表列名），实为 ' + colList); process.exit(1) }
const pt = (migSrc.slice(tplAt, tplAt + 400).match(/'[^\n]*',\n\s*'[^\n]*',\n\s*(\d+)/) || [])[1]
if (pt !== '1') { console.log(`  ✗ 模板 policy_type 应为 1（通用 Web），实为 ${pt}`); process.exit(1) }
console.log('  ✓ 模板 policy_type = 1')

console.log('\n  条件字段约束：')
const parsed = JSON.parse(base)
// ⚠️ conditions 列的类型是 JSON 数组（`[{\"sort\":1,...}]`），
//    parse 出来是数组不是对象 —— 第一版脚本当对象用，c.sort 拿到的是
//    Array.prototype.sort 函数，于是 9 条约束全假红。
if (!Array.isArray(parsed)) {
  console.error(`  ✗ conditions 应为 JSON 数组，实际为 ${typeof parsed}`)
  process.exit(1)
}
if (parsed.length !== 1) {
  console.error(`  ✗ 本模板应恰好 1 个条件，实际 ${parsed.length} 个`)
  process.exit(1)
}
const c = parsed[0]
const checks = [
  ['sort === 1', c.sort === 1],
  ['operator === "<"', c.operator === '<'],
  ['threshold === 1', c.threshold === 1],
  ['period ∈ HttpRequestCount.periodOptions [1,5,10,30,60]', [1, 5, 10, 30, 60].includes(c.period)],
  ['continuity ∈ [1,10]', c.continuity >= 1 && c.continuity <= 10],
  ['level ∈ {1,2,3}', [1, 2, 3].includes(c.level)],
  ['frequency ∈ {0,5,15,30,60,180,360,720,1440}', [0, 5, 15, 30, 60, 180, 360, 720, 1440].includes(c.frequency)],
  ['namespace === "WEB"', c.metricNamespace === 'WEB'],
  ['metricName 存在于后端字典',
    (() => {
      const php = fs.readFileSync('/workspace/server/config/autoload/metrics.php', 'utf8')
      return php.includes(`'metricName' => '${c.metricName}'`)
    })()],
]
for (const [n, ok] of checks) {
  if (!ok) drift++
  console.log(`    ${ok ? '✓' : '✗'} ${n}`)
}

// metrics.md 表格取值（模板 7 段落）
{
  const md = fs.readFileSync('/workspace/docs/alarm/metrics.md', 'utf8')
  const sec = md.slice(md.indexOf('### 模板 7'), md.indexOf('### 3.1 模板参数汇总表'))
  const row = md.split('\n').find(l => l.startsWith('| 7 | **流量断流**')) ?? ''
  // 用 includes 而不是正则：汇总表单元格是 **`<`**（粗体包反引号包尖括号），
  // 正则里反引号反复和转义打架，第一版脚本就在这里假红了两次。
  const BT = String.fromCharCode(96)
  const t = [
    ['metrics.md 模板 7 段落存在', sec.length > 0],
    ['metrics.md 模板 7 记为 < / 1', sec.includes(`${BT}<${BT} / ${BT}1${BT}`)],
    ['metrics.md 汇总表含第 7 行', row.length > 0],
    ['metrics.md 汇总表 operator 为 <', row.includes(`**${BT}<${BT}**`)],
    ['metrics.md 汇总表 threshold 为 1', row.includes(`**${BT}1${BT}**`)],
    ['metrics.md 汇总表 metric 为 WEB.HttpRequestCount', row.includes(`${BT}WEB.HttpRequestCount${BT}`)],
    ['metrics.md 汇总表 policyType 为 1', row.includes(`| ${BT}1${BT} | ${BT}WEB.HttpRequestCount${BT}`)],
  ]
  for (const [n, ok] of t) { if (!ok) drift++; console.log(`    ${ok ? '✓' : '✗'} ${n}`) }
}

console.log(drift === 0 ? '\n  ✓ 三处一致且全部约束通过' : `\n  ✗ ${drift} 项不一致`)
process.exit(drift === 0 ? 0 : 1)
