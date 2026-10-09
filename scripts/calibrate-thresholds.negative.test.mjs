#!/usr/bin/env node
/**
 * 校准脚本的**负对照**。
 *
 * ## 为什么这个文件存在
 *
 * `calibrate-thresholds.mjs` 初版用 MAD 识别离群点，理由是「分布右偏、
 * 标准差被尖峰主导」。用合成的**日周期** CPU 数据一测就露馅：
 * `p50=35 / MAD=17.1 / 稳健离群=0.00%` ——
 * MAD 被日内摆幅撑大，根本没在测量尾部，任何数据都报「没有异常点」。
 *
 * 这种 bug 不会让脚本崩溃，只会让它**稳定地给出错误结论**。
 * 而校准结论会直接变成生产告警阈值 —— 错了没人会发现，因为
 * 它看起来完全正常。
 *
 * 所以这里用三份**已知形态**的合成数据，要求脚本必须**区分开**：
 *   ① 强日周期   → 必须警告「全量分位是错的」
 *   ② 近乎常量   → 必须警告「阈值没有区分度」
 *   ③ 正常右偏   → 必须**不**报警
 *
 * 第 ③ 条是负对照的关键：不能变成「什么都报警」，那等于没检查。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join('/workspace/.calib-test')
fs.mkdirSync(DIR, { recursive: true })

// ── 确定性伪随机（不能用 Math.random，测试必须可复现）──────────────
let seed = 42
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const gauss = () => {
  // Box-Muller
  const u = Math.max(rand(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}
const resetSeed = () => { seed = 42 }

const N = 20160 // 14 天 × 1 分钟

function gen(name, fn) {
  resetSeed()
  const lines = ['timestamp,value']
  for (let i = 0; i < N; i++)
    lines.push(`2026-09-01T00:00:00Z,${fn(i).toFixed(2)}`)
  const p = path.join(DIR, `${name}.csv`)
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  return p
}

const periodic = gen('case-periodic', (i) => {
  const base = 35 + 25 * Math.sin((i / 1440) * 2 * Math.PI)
  let v = Math.max(0, base + gauss() * 4)
  if (rand() < 0.002) v += 20 + rand() * 50
  return v
})

const flat = gen('case-flat', (i) => 45 + gauss() * 3)

const normal = gen('case-normal', (i) => Math.abs(180 + gauss() * 160))

const tiny = path.join(DIR, 'case-tiny.csv')
fs.writeFileSync(tiny, 'timestamp,value\n2026-09-01T00:00:00Z,1\n2026-09-01T00:01:00Z,2\n', 'utf8')

// ── 断言 ──────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  // ⚠️ detail 只在**失败**时打印。成功时也打印会让「预期中的告警文本」
  //    混进输出，几次之后就没人看了 —— 那等于把测试的信号磨平了。
  if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; console.log(`  ✗ ${label}  ${detail}`) }
}

const run = (file) => {
  try {
    return execFileSync('node', ['/workspace/scripts/calibrate-thresholds.mjs', '--input', file],
      { encoding: 'utf8', timeout: 60000 })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

console.log('\n════ 校准脚本负对照 ════\n')

// ① 强日周期 → 必须报警
{
  const out = run(periodic)
  check('日周期数据触发周期性告警', out.includes('日内周期性很强'),
    out.includes('日内周期性很强') ? '' : out.split('\n').filter((l) => l.includes('周期')).join(' | ').slice(0, 120))
  // 断言的是**数值**，不是「有没有报警」——报警文案可以改，数值不会骗人
  const m = out.match(/日内周期性 (\d+)%/)
  check('日周期数据周期性数值 > 50%', m && Number(m[1]) > 50, `实测 ${m?.[1] ?? '未输出'}%`)
}

// ② 近乎常量 → 必须报「无区分度」
{
  const out = run(flat)
  check('常量数据触发平坦度告警', out.includes('阈值没有区分度'))
}

// ③ 正常右偏 → 必须**不**报形态告警（关键负对照）
{
  const out = run(normal)
  const warned = out.includes('日内周期性很强') || out.includes('阈值没有区分度')
  check('正常数据不误报警', !warned, warned ? out.split('\n').filter((l) => l.includes('·')).join(' | ').slice(0, 160) : '')
}

// ④ 样本不足必须拒绝，而不是给个假阈值
{
  const out = run(tiny)
  check('样本不足时拒绝出结果', out.includes('至少需要 30 个') || out.includes('样本只有'),
    out.split('\n').filter((l) => l.includes('样本')).join('').slice(0, 80))
}

// ⑤ 推荐阈值必须真的等于 P99 × 1.2
{
  const out = run(normal)
  const p99 = out.match(/P99=([\d.]+)/)
  const rec = out.match(/推荐阈值：([\d.]+)/)
  if (p99 && rec) {
    const expect = Number(p99[1]) * 1.2
    const got = Number(rec[1])
    check('推荐阈值 = P99 × 1.2', Math.abs(got - expect) / expect < 0.001,
      `P99=${p99[1]} 期望≈${expect.toFixed(3)} 实际=${got}`)
  } else {
    check('推荐阈值 = P99 × 1.2', false, '输出里没解析到 P99 / 推荐阈值')
  }
}

// ⑥ 不能再出现 MAD 离群点判据（那段被负对照推翻过，留注释提醒后来人）
{
  const src = fs.readFileSync('/workspace/scripts/calibrate-thresholds.mjs', 'utf8')
  check('脚本不再用 MAD 离群点做判据', !/稳健离群点占比:/.test(src) && !/const outliers =/.test(src),
    '如果这里失败了，说明有人把已被证伪的 MAD 判据改回来了')
}

console.log(`\n  ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
