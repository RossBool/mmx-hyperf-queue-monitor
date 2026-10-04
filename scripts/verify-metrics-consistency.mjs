/**
 * 指标字典的四处一致性校验（**含 description**）。
 *
 * ## 为什么单独一个脚本
 *
 * 交叉校验报告（.audit/metrics-cross-check.md）发现：`description` 字段在
 * metrics.md 与 metrics.php 之间漂移了 5 个指标，而当时的校验脚本
 * （sync-metrics-backend.mjs 内置段）**只比 9 个字段、不比 description** ——
 * 也就是说，漂移能悄悄通过校验。
 *
 * 这个脚本把 10 个字段全比上。
 *
 * ## 比对口径
 *
 * `description` 在 metrics.md 里是 **markdown 单元格**，允许行内代码（反引号）
 * 与加粗（`**`）——它们是**排版符，渲染后消失**。
 * 而 metrics.php / generated.ts 里是**纯文本字符串**，接口原样返回给前端。
 *
 * 所以比对前先对 md 侧做「去排版符」归一，再要求三方逐字相同。
 * 这不是放水 —— 归一后仍有差异就报漂移，判据是「用户看到的文字是否一致」。
 */
import fs from 'node:fs'

const BT = String.fromCharCode(96)
const MD = '/workspace/docs/alarm/metrics.md'
const PHP = '/workspace/server/config/autoload/metrics.php'
const TS = '/workspace/web/src/mocks/alarm-metrics.generated.ts'

/** markdown 行内代码 `x` 与加粗 **x** 都是排版符，归一后取「渲染结果」。 */
const denormMd = (s) => s.split(BT).join('').split('**').join('')

function fromMd() {
  const out = []
  let cur = null
  for (const l of fs.readFileSync(MD, 'utf8').split('\n')) {
    const h = l.match(/^### 1\.\d+ `([A-Z]+)`/)
    if (h) { cur = h[1]; continue }
    if (l.startsWith('### 1.5')) { cur = null; continue }
    if (!cur) continue
    const cells = l.split('|').map(c => c.trim())
    // | metricName | metricNameCn | unit | policyType | periodOptions |
    // | defaultOperator | defaultThreshold | suggestedContinuity | description |
    const name = cells[1]?.match(/^`([A-Za-z0-9]+)`$/)?.[1]
    if (!name) continue
    const nums = (s) => (s.match(/\d+/g) || []).map(Number)
    out.push({
      key: `${cur}.${name}`,
      namespace: cur,
      metricName: name,
      metricNameCn: denormMd((cells[2] || '').replace(/^`|`$/g, '')),
      unit: denormMd((cells[3] || '').replace(/^`|`$/g, '')),
      policyType: nums(cells[4] || ''),
      periodOptions: nums(cells[5] || ''),
      defaultOperator: denormMd((cells[6] || '').replace(/^`|`$/g, '')),
      defaultThreshold: Number(denormMd((cells[7] || '').replace(/^`|`$/g, ''))),
      suggestedContinuity: Number(denormMd((cells[8] || '').replace(/^`|`$/g, ''))),
      description: denormMd(cells[9] || ''),
    })
  }
  return out
}

function fromPhp() {
  const src = fs.readFileSync(PHP, 'utf8')
  const out = []
  for (const m of src.matchAll(/^ {4}\[\n([\s\S]*?)^ {4}\],$/gm)) {
    const b = m[1]
    const str = (k) => b.match(new RegExp(`'${k}' => '((?:[^'\\\\]|\\\\.)*)'`))?.[1].replace(/\\'/g, "'")
    const list = (k) => (b.match(new RegExp(`'${k}' => \\[([^\\]]*)\\]`))?.[1] || '').split(',').map(s => Number(s.trim()))
    const num = (k) => Number(b.match(new RegExp(`'${k}' => (-?[\\d.]+)`))?.[1])
    const ns = str('namespace')
    const name = str('metricName')
    out.push({
      key: `${ns}.${name}`,
      namespace: ns,
      metricName: name,
      metricNameCn: str('metricNameCn'),
      unit: str('unit'),
      policyType: list('policyType'),
      periodOptions: list('periodOptions'),
      defaultOperator: str('defaultOperator'),
      defaultThreshold: num('defaultThreshold'),
      suggestedContinuity: num('suggestedContinuity'),
      description: str('description'),
    })
  }
  return out
}

function fromTs() {
  const src = fs.readFileSync(TS, 'utf8')
  const out = []
  for (const m of src.matchAll(/^ {2}\{\n([\s\S]*?)^ {2}\},$/gm)) {
    const b = m[1]
    const str = (k) => b.match(new RegExp(`${k}: '((?:[^'\\\\]|\\\\.)*)'`))?.[1].replace(/\\'/g, "'")
    const list = (k) => (b.match(new RegExp(`${k}: \\[([^\\]]*)\\]`))?.[1] || '').split(',').map(s => Number(s.trim()))
    const num = (k) => Number(b.match(new RegExp(`${k}: (-?[\\d.]+)`))?.[1])
    const ns = str('namespace')
    const name = str('metricName')
    out.push({
      key: `${ns}.${name}`,
      namespace: ns,
      metricName: name,
      metricNameCn: str('metricNameCn'),
      unit: str('unit'),
      policyType: list('policyType'),
      periodOptions: list('periodOptions'),
      defaultOperator: str('defaultOperator'),
      defaultThreshold: num('defaultThreshold'),
      suggestedContinuity: num('suggestedContinuity'),
      description: str('description'),
    })
  }
  return out
}

const FIELDS = ['namespace', 'metricName', 'metricNameCn', 'unit', 'policyType', 'periodOptions', 'defaultOperator', 'defaultThreshold', 'suggestedContinuity', 'description']

const sets = { 'metrics.md': fromMd(), 'metrics.php': fromPhp(), 'generated.ts': fromTs() }
for (const [k, v] of Object.entries(sets)) console.log(`  ${k.padEnd(14)} ${v.length} 个指标`)

let drift = 0
const names = Object.keys(sets)
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const A = sets[names[i]]
    const B = sets[names[j]]
    const ma = new Map(A.map(x => [x.key, x]))
    const mb = new Map(B.map(x => [x.key, x]))
    for (const k of new Set([...ma.keys(), ...mb.keys()])) {
      const a = ma.get(k)
      const b = mb.get(k)
      if (!a || !b) {
        drift++
        console.error(`  ✗ ${names[i]} ↔ ${names[j]}：${k} ${!a ? '仅在前者' : '仅在后者'}`)
        continue
      }
      for (const f of FIELDS) {
        const av = JSON.stringify(a[f])
        const bv = JSON.stringify(b[f])
        if (av !== bv) {
          drift++
          console.error(`  ✗ ${k}.${f}  ${names[i]} ↔ ${names[j]}`)
          if (f === 'description') {
            console.error(`      ${names[i]}: ${a[f]}`)
            console.error(`      ${names[j]}: ${b[f]}`)
          } else {
            console.error(`      ${names[i]}: ${av}\n      ${names[j]}: ${bv}`)
          }
        }
      }
    }
  }
}

// 契约计数
const contract = fs.readFileSync('/workspace/docs/alarm/contract.md', 'utf8')
const n = sets['metrics.md'].length
const declared = [...contract.matchAll(/固定 \*\*(\d+)\*\* 条/g)].map(x => Number(x[1]))
if (!declared.length || declared.some(d => d !== n)) {
  drift++
  console.error(`  ✗ contract.md 声明 ${declared.join('/')}，实际 ${n}`)
}
const leftover = /共 \*\*28\*\*/.test(contract)
if (leftover) { drift++; console.error('  ✗ contract.md 仍有「共 28」残留') }

// 自身文件头注释
const php = fs.readFileSync(PHP, 'utf8')
if (!php.includes(`共 ${n} 个`)) { drift++; console.error(`  ✗ metrics.php docblock 未写「共 ${n} 个」`) }

console.log(drift === 0
  ? `\n  ✓ 三处 × ${FIELDS.length} 字段 × ${n} 指标全部一致，契约计数与 docblock 同步`
  : `\n  ✗ ${drift} 处漂移`)
process.exit(drift === 0 ? 0 : 1)
