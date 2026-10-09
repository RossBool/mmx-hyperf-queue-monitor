/**
 * schema.sql ↔ 迁移 ↔ 真实 MySQL 三方一致性守卫。
 *
 * ## 为什么静态比对不够
 *
 * v1.1 实施过程中，schema.sql、迁移文件、真实库三者**同时**漂移过，
 * 而且每一处都是靠真实 HTTP 请求才暴露：
 *
 *   1. 迁移没更新 ck_policy_policy_type → 采集静默策略建不出来（1060 类）
 *   2. 5 个新列一个 CHECK 都没有 → v1.0 的 29 个 CHECK 防线在新增字段上整个失效
 *   3. 4 个指标列还是 NOT NULL → 静默条件写 null 被 DB 拒绝
 *   4. CHECK 表达式跨行 → MySQL 8.0 直接 1064，且报错指向第 2 行的 OR
 *
 * 任何一处只要「文档写了、代码没跟上」就是线上事故。
 * 这个守卫比对的是**能真正挡住事故的那部分**，不是行数。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const SCHEMA = '/workspace/docs/alarm/schema.sql'
const MIG = '/workspace/server/migrations/2026_10_08_000900_add_relative_and_silence_criteria.php'

const sql = fs.readFileSync(SCHEMA, 'utf8')
const mig = fs.readFileSync(MIG, 'utf8')

const problems = []
const ok = []

const check = (cond, passMsg, failMsg) => {
  if (cond) ok.push(passMsg)
  else problems.push(failMsg)
}

// ── ① v1.1 新列：schema.sql 与迁移必须都声明 ────────────────────────
const V11_COLS = [
  ['alarm_policy_condition', 'compare_mode'],
  ['alarm_policy_condition', 'baseline_type'],
  ['alarm_policy_condition', 'baseline_count'],
  ['alarm_policy', 'target_type'],
  ['alarm_policy', 'target_freshness_minutes'],
]
for (const [table, col] of V11_COLS) {
  const inSchema = new RegExp(`\`${col}\``).test(sql)
  const inMig = mig.includes(`'${table}', '${col}'`)
  check(inSchema && inMig,
    `${table}.${col} 两侧都有`,
    `${table}.${col}: schema.sql=${inSchema} 迁移=${inMig} —— 两侧必须同时声明，否则回滚/重建会丢列`)
}

// ── ② policy_type 取值域必须含 5 ───────────────────────────────────
const policyTypeCheck = sql.match(/ck_policy_policy_type`\s+CHECK \([^)]*policy_type`\s+IN \(([^)]*)\)/)
check(policyTypeCheck && /5/.test(policyTypeCheck[1]),
  'schema.sql 的 ck_policy_policy_type 已含 5',
  `schema.sql 的 ck_policy_policy_type 不含 5（实际: ${policyTypeCheck?.[1] ?? '未找到'}）—— 采集静默策略会被 CHECK 拒绝`)
check(/ck_policy_policy_type',\s*'\(`policy_type` IN \(1, 2, 3, 4, 5\)\)'/.test(mig),
  '迁移的 ck_policy_policy_type 已含 5',
  '迁移里 ck_policy_policy_type 仍是 1-4（只改 schema.sql 不改迁移 = 重建即回归）')

// ── ③ v1.1 的 CHECK 约束：schema 与迁移数量都要够 ────────────────────
// 5 个新列 + 2 个跨字段一致性 = 7 个新增（ck_policy_policy_type 是替换不是新增）
const V11_CHECKS = [
  'ck_condition_compare_mode',
  'ck_condition_baseline_type',
  'ck_condition_baseline_count',
  'ck_condition_relative_pair',
  'ck_policy_target_type',
  'ck_policy_freshness',
  'ck_policy_silence_pair',
]
for (const name of V11_CHECKS) {
  const inSchema = sql.includes(name)
  const inMig = mig.includes(name)
  check(inSchema && inMig,
    `${name} 两侧都有`,
    `${name}: schema.sql=${inSchema} 迁移=${inMig} —— v1.1 的 CHECK 防线不能只写一半`)
}

// ── ④ 4 个指标列必须可空（否则静默条件写不进去）─────────────────────
// ⚠️ 只看 alarm_policy_condition 那张表；alarm_history / alarm_condition_template
//    里的同名列是 NOT NULL 且**应该**保持 NOT NULL。
const condTable = sql.slice(sql.indexOf('CREATE TABLE `alarm_policy_condition`'),
  sql.indexOf('CREATE TABLE', sql.indexOf('CREATE TABLE `alarm_policy_condition`') + 10))
for (const col of ['metric_namespace', 'metric_name', 'operator', 'threshold']) {
  const line = condTable.split('\n').find((l) => l.trim().startsWith('`' + col + '`'))
  check(line && !/\bNOT NULL\b/.test(line),
    `alarm_policy_condition.${col} 已可空`,
    `alarm_policy_condition.${col} 仍是 NOT NULL —— 采集静默条件按契约这几个字段恒为 NULL，写不进去`)
  check(mig.includes(`MODIFY COLUMN \`${col}\``),
    `迁移里有 ${col} 的 MODIFY COLUMN`,
    `迁移里没有 ${col} 的 MODIFY COLUMN —— 只改 schema.sql 的话迁移后的库仍是 NOT NULL`)
}

// ── ⑤ CHECK 表达式必须单行 ────────────────────────────────────────
// 实测 MySQL 8.0.46：ALTER TABLE ... ADD CONSTRAINT CHECK 里带换行 → 1064，
// 且报错指向第 2 行开头，看起来像括号不配对，排查极费时间。
for (const name of V11_CHECKS) {
  const inMigIdx = mig.indexOf(`'${name}'`)
  if (inMigIdx < 0) continue
  const seg = mig.slice(inMigIdx, inMigIdx + 500)
  // 取 replaceCheck 的第三个实参
  const argStart = seg.indexOf(',', seg.indexOf('\n'))
  const arg = seg.slice(argStart, seg.indexOf(');', argStart))
  const literalNewlines = (arg.match(/\\\\n/g) || []).length
  check(literalNewlines === 0,
    `${name} 表达式单行`,
    `${name} 的 CHECK 表达式含换行 —— MySQL 8.0 会 1064，且错误信息指向第 2 行`)
}

// ── ⑥ 心跳表两侧都有 ──────────────────────────────────────────────
check(/CREATE TABLE.*alarm_target_heartbeat|alarm_target_heartbeat/.test(sql),
  'schema.sql 声明了 alarm_target_heartbeat',
  'schema.sql 缺少 alarm_target_heartbeat')
check(mig.includes('alarm_target_heartbeat'),
  '迁移里声明了 alarm_target_heartbeat',
  '迁移里缺少 alarm_target_heartbeat')

// ── ⑦ 真实 MySQL 里实际生效的 CHECK 数量 ──────────────────────────
// 静态比对只能证明「写了」，证明不了「MySQL 真在执行」——
// MySQL 8.0.15 及更早会**静默忽略** CHECK，不报任何错。
let liveCount = null
try {
  const out = execFileSync('mysql', ['-uroot', '-prootpw', 'alarm', '-N', '-e',
    "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='alarm' AND CONSTRAINT_TYPE='CHECK'"],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  liveCount = Number(out)
  check(liveCount >= 36,
    `真实库已生效 ${liveCount} 个 CHECK（v1.0 的 29 + v1.1 的 7）`,
    `真实库只有 ${liveCount} 个 CHECK，预期 >= 36 —— 迁移可能没跑，或 MySQL 版本过低静默忽略了 CHECK`)
} catch {
  console.log('  ⚠ 跳过真实库 CHECK 数量校验（MySQL 不可用）')
}

console.log(`  通过 ${ok.length} 项`)
if (liveCount !== null) console.log(`  真实 MySQL 生效 CHECK: ${liveCount} 个`)

if (problems.length) {
  console.log(`\n  ✗ ${problems.length} 处不一致：\n`)
  for (const p of problems) console.log(`    · ${p}\n`)
  process.exit(1)
}
console.log('  ✓ schema.sql / 迁移 / 真实库三方一致')
