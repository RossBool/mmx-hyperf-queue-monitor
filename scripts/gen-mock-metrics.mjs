/**
 * 从后端字典（server/config/autoload/metrics.php）生成前端 mock 的指标数组。
 *
 * ## 为什么生成而不是手写
 *
 * mock 原来只给 1 条指标（已知限制：mock 模式下看不到完整字典）。
 * 手抄 38 条必然漂移 —— 而 mock 与真实字典漂移的后果是：
 * **开发时能选的指标在真实环境里不存在**（或反之），且不会有任何报错。
 *
 * 直接从 server/config/autoload/metrics.php 解析，消除这个漂移面。
 * 与 sync-metrics-backend.mjs 构成一对：那边保证 md ↔ php，这里保证 php ↔ mock。
 */
import fs from 'node:fs'

const SRC = '/workspace/server/config/autoload/metrics.php'
const OUT = '/workspace/web/src/mocks/alarm-metrics.generated.ts'

const src = fs.readFileSync(SRC, 'utf8')

// 逐块解析 PHP 数组字面量 —— 不执行 PHP，只按语法结构取字段。
const BLOCK = /^ {4}\[\n([\s\S]*?)^ {4}\],$/gm
const field = (body, key) => {
  const m = body.match(new RegExp(`'${key}' => (?:'((?:[^'\\\\]|\\\\.)*)'|(\\[[^\\]]*\\])|(-?[\\d.]+))`))
  if (!m) return null
  if (m[1] !== undefined) return m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  if (m[2] !== undefined) return m[2].slice(1, -1).split(',').map(s => Number(s.trim())).filter(n => !Number.isNaN(n))
  return Number(m[3])
}

const metrics = []
for (const m of src.matchAll(BLOCK)) {
  const b = m[1]
  const ns = field(b, 'namespace')
  const name = field(b, 'metricName')
  if (!ns || !name) continue
  metrics.push({
    namespace: ns,
    metricName: name,
    metricNameCn: field(b, 'metricNameCn'),
    unit: field(b, 'unit'),
    policyType: field(b, 'policyType'),
    periodOptions: field(b, 'periodOptions'),
    defaultOperator: field(b, 'defaultOperator'),
    defaultThreshold: field(b, 'defaultThreshold'),
    suggestedContinuity: field(b, 'suggestedContinuity'),
    description: field(b, 'description'),
  })
}

if (metrics.length === 0) {
  console.error('  ✗ 从 metrics.php 解析出 0 个指标 —— 解析逻辑坏了，不要生成空文件')
  process.exit(1)
}

// 契约 §2.7 的 10 个字段，缺一不可
const REQUIRED = ['namespace', 'metricName', 'metricNameCn', 'unit', 'policyType', 'periodOptions', 'defaultOperator', 'defaultThreshold', 'suggestedContinuity', 'description']
for (const m of metrics) {
  for (const k of REQUIRED) {
    if (m[k] === null || m[k] === undefined) {
      console.error(`  ✗ ${m.metricName} 缺字段 ${k}`)
      if (k === 'description') {
        // 对抗复核实测过的构造用例：description 本身是合法的多行 PHP 字符串，
        // 但中间某行恰好是 `    ],` 会让 BLOCK 正则提前截断，于是 description 解析成 null。
        // 这是最常见的成因，直接指向它，别让读报错的人去猜。
        console.error('    常见成因：这条指标的 description 是多行字符串，且其中一行是 `    ],`')
        console.error('    修法：把该 description 改成单行（metrics.md 的表格也放不下多行）')
      }
      process.exit(1)
    }
  }
}

/**
 * 结构性断言：解析出的条数必须等于源文件里 4 空格缩进的数组开括号数。
 *
 * 为什么 REQUIRED 检查不够：对抗复核实测过一个构造用例 —— description 是多行
 * PHP 单引号字符串（PHP 允许），且其中一行恰好是 `    ],` 时，BLOCK 正则会**提前截断**。
 * 截断后剩下的字段**有可能凑巧仍是 10 个**，REQUIRED 全过，但 description 是错的，
 * 于是错误静默进入 generated.ts。相比之下条数对不上是硬信号。
 */
const sourceBlocks = (src.match(/^ {4}\[$/gm) ?? []).length
if (sourceBlocks !== metrics.length) {
  console.error(`  ✗ 源文件里有 ${sourceBlocks} 个 4 空格缩进的数组块，解析出 ${metrics.length} 条指标`)
  console.error('    多半是某条 description 含换行且其中一行是 `    ],`，导致 BLOCK 正则提前截断')
  console.error('    修法：把该 description 改成单行（metrics.md 表格也放不下多行）')
  process.exit(1)
}

/** description 里的换行会同时打破 md 表格和上面的 BLOCK 解析，直接禁掉。 */
for (const m of metrics) {
  if (/[\r\n]/.test(m.description)) {
    console.error(`  ✗ ${m.metricName} 的 description 含换行`)
    process.exit(1)
  }
}

/** 序列化成项目 lint 认可的风格：单引号、尾逗号、数组不换行。 */
function serialize(list) {
  // 先转义再包引号。description 里含中文双引号（""Too many open files""），
  // 但不含单引号；仍做转义以防将来字典文案里出现撇号。
  const q = v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
  return list
    .map((m) => {
      const fields = [
        `namespace: ${q(m.namespace)},`,
        `metricName: ${q(m.metricName)},`,
        `metricNameCn: ${q(m.metricNameCn)},`,
        `unit: ${q(m.unit)},`,
        `policyType: [${m.policyType.join(', ')}],`,
        `periodOptions: [${m.periodOptions.join(', ')}],`,
        `defaultOperator: ${q(m.defaultOperator)},`,
        `defaultThreshold: ${m.defaultThreshold},`,
        `suggestedContinuity: ${m.suggestedContinuity},`,
        `description: ${q(m.description)},`,
      ]
      return `  {\n${fields.map((f) => `    ${f}`).join('\n')}\n  },`
    })
    .join('\n')
}
const body = serialize(metrics)

const out = `// ⚠️ 本文件由 scripts/gen-mock-metrics.mjs **自动生成，请勿手改**。
//
// 来源：server/config/autoload/metrics.php（= docs/alarm/metrics.md §1 的机器可读副本）
// 重新生成：node scripts/gen-mock-metrics.mjs
//
// 为什么要有这个文件：mock 模式下前端拿不到真实字典，指标下拉就只有 1 条。
// 此前它是**手写**的 1 条，且注释写着「不要把这份数据当字典用」——
// 后果是开发时能选的指标与真实环境不一致，且不会有任何报错。
// 现在改为从后端字典生成，mock 与真实字典不可能漂移。
//
// 共 ${metrics.length} 个指标。类型即契约 §2.7 的 AlarmMetric。
export const alarmMetricsMock = [
${body}
]
`

fs.writeFileSync(OUT, out)

const byNs = {}
for (const m of metrics) byNs[m.namespace] = (byNs[m.namespace] || 0) + 1
console.log(`  ✓ 已生成 ${OUT}`)
console.log(`    ${metrics.length} 个指标：`, Object.entries(byNs).map(([k, v]) => `${k} ${v}`).join(' / '))
