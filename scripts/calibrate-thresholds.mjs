#!/usr/bin/env node
/**
 * 阈值校准脚本 —— 从真实时序数据推导候选阈值。
 *
 * ## 为什么要有这个
 *
 * `metrics.md` 里的 `defaultThreshold` 是**通用起点**，不是校准结果。
 * 真正该用的是「你自己业务的历史分位」，而从历史数据到阈值这一步
 * 如果靠人手算，每个人算出来的都不一样，也没法复核。
 *
 * 脚本只做**机械可复现**的那部分，给出候选值。
 * 判断「这个阈值合不合适」仍然是人的事 —— 见
 * `docs/alarm/threshold-calibration.md` §5.3 的复核清单。
 *
 * ## 用法
 *
 *   node scripts/calibrate-thresholds.mjs \
 *     --input data/CpuUtilizationRate.csv \
 *     --metric CVM.CpuUtilizationRate \
 *     --out data/CpuUtilizationRate.json
 *
 * 输入 CSV 两列（表头可选）：
 *
 *   timestamp,value
 *   2026-09-01T00:00:00Z,312.5
 *
 * ## 方法与它的局限
 *
 * 用 P99 × 1.2 而不是 max：max 会被单次网络抖动 / GC 停顿拉飞，
 * 按 max 设阈值必然误报到没人看告警。
 *
 * ## ⚠️ 负对照推翻过的一个错误设计
 *
 * 初版用 **MAD（中位数绝对偏差）** 识别离群点，理由是「指标分布右偏，
 * 标准差被尖峰主导」。用合成的日周期 CPU 数据一测就露馅了：
 * `p50=35 / MAD=17.1 / 稳健离群=0.00%` ——
 * **MAD 被日间摆幅撑大，根本不在测量尾部**。
 * 周期数据的日内方差远大于尾部方差，MAD 在这里完全失效。
 *
 * 所以本脚本**不再**用离群点占比做判据，改成两个真正可解释的量：
 *   - **超阈占比**：按推荐阈值，正常期会有多少点触发（≈1%，由构造保证）
 *   - **日内周期性强度**：解释了日内均值方差占总方差的比例
 *     强周期数据上，全局分位是错的（凌晨的谷会把白天的峰拉低）
 *
 * ## 局限（必须知道，否则会误用）
 *   - **只检测日周期**。周周期（周末/工作日差异）没检。
 *   - 不识别**基线漂移**。若输入数据已含缓慢劣化，分位会跟着漂，
 *     等于把劣化固化进阈值。
 *   - 不处理**容量相关指标**。见 `threshold-calibration.md` §4 ——
 *     磁盘 IOPS / 吞吐这类指标用全局分位是没有意义的。
 */
import fs from 'node:fs'

// ── 参数解析 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const input = arg('input')
const metric = arg('metric', 'unknown')
const out = arg('out')

if (!input) {
  console.error('用法: node scripts/calibrate-thresholds.mjs --input <csv> [--metric Ns.Name] [--out <json>]')
  process.exit(2)
}

// ── 解析 CSV ──────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length)
    return []

  // 表头可选：有表头就跳过第一行
  const first = lines[0].toLowerCase()
  const hasHeader = first.includes('timestamp') || first.includes('value') || first.includes('time')
  const body = hasHeader ? lines.slice(1) : lines

  const out = []
  for (const line of body) {
    const parts = line.split(',')
    const raw = parts[parts.length - 1].trim()
    const v = Number(raw)
    if (raw === '' || Number.isNaN(v))
      continue
    out.push(v)
  }
  return out
}

const values = parseCsv(fs.readFileSync(input, 'utf8'))

if (values.length < 30) {
  console.error(`✗ 样本只有 ${values.length} 个，至少需要 30 个。`)
  console.error('  少于 30 个时 P99 完全由个别离群点决定，算出来的阈值没有意义。')
  process.exit(1)
}

const sorted = [...values].sort((a, b) => a - b)
const quantile = (q) => {
  // 最近秩法：比线性插值更保守，不会低估尾部分布
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const p50 = quantile(0.5)
const p90 = quantile(0.9)
const p95 = quantile(0.95)
const p99 = quantile(0.99)
const p999 = quantile(0.999)
const max = sorted[sorted.length - 1]
const min = sorted[0]

// MAD：中位数绝对偏差
// MAD 只用于算波动率（决定推荐 continuity），不再用于离群点判定。
const mad = median(values.map((v) => Math.abs(v - p50))) || 1e-9
// 稳健 z 分数：|v - 中位数| / (1.4826 × MAD)
// ⚠️ 这里**曾经**算过 `outlierRatio`（稳健 z 分数 > 3.5 的点占比），
// 并用它做判据。已被负对照证伪并删除 —— 见文件头 §「负对照推翻过的一个错误设计」。
// 周期性数据上 MAD 被日内摆幅撑大，任何数据都会报「没有异常点」。

// ── 推荐阈值 ──────────────────────────────────────────────────────
/**
 * 上浮系数 1.2：留 20% 余量。
 * 取 1.0 会让一半的健康期数据落到阈值之上（等于常态告警），
 * 取 1.5 起步则容易漏掉刚开始的劣化。
 */
const MARGIN = 1.2
const recommended = p99 * MARGIN

// 推荐连续周期数：让告警在"劣化持续"时才响，而不是被尖峰触发。
// 经验映射：稳态指标 3，极端指标 1。
const volatility = mad / (Math.abs(p50) || 1e-9)
const recommendedContinuity = volatility < 0.15 ? 3 : volatility < 0.4 ? 2 : 1

// ── 日内周期性强度 ────────────────────────────────────────────────
// 把数据按「小时」（0-23）分组，算组间方差占总方差的比例。
// 比例高 = 这个指标的日内形态本身就主导了分布，
// 此时对**全量**算 P99 是错的：凌晨的谷把白天的峰拉低了。
const hours = new Map()
values.forEach((v, i) => {
  // ⚠️ 这里假设输入是等间隔 1 分钟序列（脚本的主要用途）。
  //    间隔不同时用下标推算小时会算错 —— 所以下面会检查时间戳。
  const h = Math.floor((i % 1440) / 60)
  if (!hours.has(h)) hours.set(h, [])
  hours.get(h).push(v)
})
const hourMeans = [...hours.values()].map((a) => a.reduce((x, y) => x + y, 0) / a.length)
const grandMean = values.reduce((x, y) => x + y, 0) / values.length
const totalVar = values.reduce((x, y) => x + (y - grandMean) ** 2, 0) / values.length
const betweenVar = hourMeans.reduce((x, y) => x + (y - grandMean) ** 2, 0) / hourMeans.length
const periodicity = totalVar > 0 ? betweenVar / totalVar : 0

// 超阈占比：按推荐阈值，正常期有多少点会触发
const exceed = values.filter((v) => v >= recommended).length / values.length

// 平坦度：P99 / P50。接近 1 说明指标几乎是常量，阈值没有区分度
const flatness = Math.abs(p50) > 1e-9 ? p99 / p50 : Infinity

const warnings = []
if (periodicity > 0.5)
  warnings.push(`日内周期性很强（组间方差占 ${(periodicity * 100).toFixed(0)}%）：全量 P99 会把白天峰值和凌晨谷混在一起算。应先按小时分桶、逐小时算分位。`)
if (flatness < 1.2)
  warnings.push(`P99/P50 = ${flatness.toFixed(2)}：指标几乎是常量，阈值没有区分度，确认这个指标本身有意义。`)
if (values.length < 20160)
  warnings.push(`样本 ${values.length} 个，少于 14 天（20160 个 1 分钟点）。不足 2 个完整周周期，周末/工作日差异没被覆盖。`)

const result = {
  metric,
  样本数: values.length,
  统计: {
    min, p50, p90, p95, p99, p999: p999, max,
    波动率_MAD比: Number(volatility.toFixed(4)),
  },
  推荐: {
    阈值: Number(recommended.toFixed(4)),
    依据: `P99(${p99}) × ${MARGIN}`,
    持续周期数: recommendedContinuity,
  },
  自检: {
    超阈占比: `${(exceed * 100).toFixed(2)}%（由 P99×${MARGIN} 的构造决定，理论约 1%）`,
    日内周期性: `${(periodicity * 100).toFixed(0)}% 组间方差占比`,
    平坦度_P99比P50: Number.isFinite(flatness) ? Number(flatness.toFixed(3)) : '∞（P50≈0）',
    需人工复核: [
      '按推荐阈值回放历史故障，确认那次故障触发了',
      '按推荐阈值回放正常期，确认误报次数可接受',
      '确认指标不是容量相关（磁盘 IOPS / 吞吐）——见 threshold-calibration.md §4',
    ],
  },
  警告: warnings.length ? warnings : ['无'],
  已知局限: [
    '只检测日周期，未检测周周期（周末/工作日差异）',
    '未检测基线漂移：若输入数据已含缓慢劣化，分位会跟着漂',
    '假设输入是等间隔 1 分钟序列；间隔不同则周期性检测结果无效',
  ],
}

// ── 输出 ──────────────────────────────────────────────────────────
console.log(`\n════ 阈值校准：${metric} ════\n`)
console.log(`  样本 ${values.length} 个`)
console.log(`  min=${min}  P50=${p50}  P90=${p90}  P95=${p95}`)
console.log(`  P99=${p99}  P99.9=${p999}  max=${max}`)
console.log(`  日内周期性 ${(periodicity * 100).toFixed(0)}%  平坦度 P99/P50 ${Number.isFinite(flatness) ? flatness.toFixed(2) : '∞'}`)
console.log(`\n  推荐阈值：${recommended}   （${result.推荐.依据}）`)
console.log(`  推荐持续周期数：${recommendedContinuity}`)
console.log(`  按此阈值的超阈占比：${(exceed * 100).toFixed(2)}%`)
if (warnings.length) {
  console.log('\n  ⚠ 数据形态告警：')
  warnings.forEach((w) => console.log(`    · ${w}`))
}
console.log('\n  ⚠ 本脚本只给候选值。定稿前必须人工复核：')
result.自检.需人工复核.forEach((c) => console.log(`    · ${c}`))
console.log('\n  已知局限：')
result.已知局限.forEach((w) => console.log(`    · ${w}`))

if (out) {
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')
  console.log(`\n  已写入 ${out}`)
}
console.log()
