/**
 * 修 metrics.php 的三处漂移（交叉校验报告 .audit/metrics-cross-check.md 发现）。
 *
 * 1. docblock 的指标数还写着 28 —— 本轮加到 38 时漏改了自己文件的头注释。
 * 2. `CVM.DiskDaysToFull` 的 description 里 `<` 后面多一个半角空格，
 *    与 metrics.md 渲染结果差 1 个码位（**本轮引入**）。
 * 3. 4 个**原有**指标的 description 里，metrics.md 用反引号做 markdown 行内代码
 *    （渲染后消失），而 php 把反引号当**字面字符**存进了字符串 ——
 *    前端会原样显示 `WEB.Http5xxRatio` 这种带反引号的文本。
 *    （**非本轮引入**，是原 28 条里就有的，本轮扩充时原样保留了。）
 *
 * 只改 description 字符串内的反引号 —— 结构、数值、字段一律不动。
 */
import fs from 'node:fs'

const P = '/workspace/server/config/autoload/metrics.php'
let s = fs.readFileSync(P, 'utf8')
const changes = []

// ── 1. docblock 计数 ──
const c0 = '（共 28 个：CVM 10 / WEB 8 / CLB 4 / MYSQL 6）'
const c1 = '（共 38 个：CVM 15 / WEB 9 / CLB 5 / MYSQL 9）'
if (s.includes(c0)) {
  s = s.replace(c0, c1)
  changes.push('docblock 计数 28 → 38')
}

// ── 2. DiskDaysToFull 多余空格 ──
const sp = '默认算子是 < —— 本字典'
if (s.includes(sp)) {
  s = s.replace(sp, '默认算子是 <—— 本字典')
  changes.push('DiskDaysToFull 多余空格')
}

// ── 3. description 内的字面反引号 ──
// 只在 'description' => '...' 这一对引号内部处理，避免误伤 PHP 语法。
const BT = String.fromCharCode(96)
let stripped = 0
s = s.replace(/'description' => '[^']*'/g, (m) => {
  const hits = m.split(BT).length - 1
  if (hits === 0) return m
  stripped += hits
  return m.split(BT).join('')
})
if (stripped > 0) changes.push(`剥离 ${stripped} 个 description 字面反引号`)

fs.writeFileSync(P, s)
for (const c of changes) console.log(`  ✓ ${c}`)
if (changes.length === 0) console.log('  · 无需改动')
