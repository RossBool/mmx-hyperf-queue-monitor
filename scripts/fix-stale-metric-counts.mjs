/**
 * 修掉散落在代码注释和文档里的「陈旧指标数」。
 *
 * 为什么不手工改完就算：指标从 28 变 38 之后，grep「28 个指标 / 28 条」能扫出 15 处，
 * 其中一部分是**故意保留的**——metrics-gap-analysis.md 讲的就是扩充前的 28 条现状，
 * 改成 38 反而会篡改分析结论。人和人肉 grep 都会在这里出错，所以把判断写进脚本：
 * 只有「明确在描述当前状态」的表述才改，分析类文档不动。
 */
import fs from 'node:fs'

// [文件, 期望条数, 命名空间分布描述]
const CURRENT = [
  ['server/README.md', 38],
  ['web/src/mocks/alarm.mock.ts', 38],
  ['web/src/services/api/alarm-policy.api.ts', 38],
  ['web/src/types/alarm.ts', 38],
  ['docs/alarm/metrics.md', 38],
  ['docs/alarm/domain.md', 38],
  ['docs/alarm/deliverable.md', 38],
]

// 描述扩充前现状的文档，**不动**。
const HISTORICAL = new Set(['docs/alarm/metrics-gap-analysis.md', '.audit/attack-metrics.md', '.audit/metrics-cross-check.md'])

let changed = 0
const log = []

for (const [rel, n] of CURRENT) {
  if (HISTORICAL.has(rel)) continue
  const p = `/workspace/${rel}`
  const before = fs.readFileSync(p, 'utf8')
  let after = before

  after = after.replace(/(\d+)\s*个指标/g, (m, num) => (num === '28' ? `${n} 个指标` : m))
  after = after.replace(/(\d+)\s*条(?![的])/g, (m, num) => (num === '28' ? `${n} 条` : m))
  after = after.replace(/★\s*\d+\s*个指标字典/g, `★ ${n} 个指标字典`)
  after = after.replace(/固定\s*\d+\s*条/g, `固定 ${n} 条`)
  after = after.replace(/共\s*\d+\s*个指标/g, `共 ${n} 个指标`)

  if (after !== before) {
    fs.writeFileSync(p, after)
    changed++
    const diff = before
      .split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /28\s*(个指标|条)/.test(l))
      .map(([i]) => i)
    log.push(`  ✓ ${rel}${diff.length ? ` (行 ${diff.join(',')})` : ''}`)
  }
}

// deliverable.md 里的命名空间分布也要跟着变
const dp = '/workspace/docs/alarm/deliverable.md'
let ds = fs.readFileSync(dp, 'utf8')
const distBefore = ds
ds = ds.replace(/38 个指标（CVM \d+ \/ WEB \d+ \/ CLB \d+ \/ MYSQL \d+）/g, '38 个指标（CVM 15 / WEB 9 / CLB 5 / MYSQL 9）')
if (ds !== distBefore) {
  fs.writeFileSync(dp, ds)
  log.push('  ✓ docs/aliverable.md 命名空间分布')
}

console.log(log.join('\n'))
console.log(`  改动 ${changed} 个文件`)
console.log(`  保留（扩充前现状，不改）：${[...HISTORICAL].join(', ')}`)

// 复查：当前状态类文件里不该再有 28
let leftover = 0
for (const [rel] of CURRENT) {
  const s = fs.readFileSync(`/workspace/${rel}`, 'utf8')
  s.split('\n').forEach((l, i) => {
    if (/\b28\s*(个指标|条)/.test(l)) {
      console.log(`  ! 残留 ${rel}:${i + 1}  ${l.trim().slice(0, 90)}`)
      leftover++
    }
  })
}
process.exit(leftover ? 1 : 0)
