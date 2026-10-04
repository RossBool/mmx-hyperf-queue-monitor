/**
 * MigrationSafetyTest 的 Node 等价实现。
 *
 * 沙箱没有 PHP，PHPUnit 跑不了。本脚本用同一套断言逻辑验证测试**不是空转**：
 * 先在当前代码上跑（应全过），再把修复回滚（应全红）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = '/workspace'
const MIG = path.join(ROOT, 'server/migrations')

const CREATE_TABLE_FILES = [
  '2026_09_30_000100_create_alarm_policy_table.php',
  '2026_09_30_000200_create_alarm_policy_condition_table.php',
  '2026_09_30_000300_create_alarm_condition_template_table.php',
  '2026_09_30_000400_create_alarm_notification_template_table.php',
  '2026_09_30_000500_create_alarm_notification_receiver_table.php',
  '2026_09_30_000600_create_alarm_history_table.php',
]

function upBody(file) {
  const src = fs.readFileSync(path.join(MIG, file), 'utf8')
  const start = src.indexOf('public function up')
  const end = src.indexOf('public function down')
  if (start < 0 || end < 0) throw new Error(`${file}: 找不到 up()/down()`)
  return src.slice(start, end)
}

const codeOnly = (php) => php.replace(/^\s*\/\/.*$/gm, '')

function run() {
  const fails = []
  for (const f of CREATE_TABLE_FILES) {
    const body = upBody(f)
    const code = codeOnly(body)

    if (code.includes('DROP TABLE'))
      fails.push(`${f}: up() 仍含 DROP TABLE`)

    if (!code.includes('CREATE TABLE IF NOT EXISTS'))
      fails.push(`${f}: 缺 CREATE TABLE IF NOT EXISTS`)

    if (!code.includes('SET FOREIGN_KEY_CHECKS = 0'))
      fails.push(`${f}: 缺 FOREIGN_KEY_CHECKS = 0`)

    if (!code.includes('SET FOREIGN_KEY_CHECKS = 1'))
      fails.push(`${f}: 缺 FOREIGN_KEY_CHECKS = 1`)

    if (!/finally\s*\{[^}]*SET FOREIGN_KEY_CHECKS = 1/s.test(code))
      fails.push(`${f}: FOREIGN_KEY_CHECKS = 1 不在 finally 里`)
  }

  const schema = fs.readFileSync(path.join(ROOT, 'docs/alarm/schema.sql'), 'utf8')
  if (!/MySQL\s*>=\s*8\.0\.16/.test(schema))
    fails.push('schema.sql: 未声明 MySQL >= 8.0.16')
  if (/MySQL\s*>=\s*8\.0\.1[0-5]\b/.test(schema))
    fails.push('schema.sql: 仍声明 < 8.0.16')

  return fails
}

const fails = run()
if (fails.length === 0) console.log("  ✓ 6 个迁移 up() + schema.sql 全部断言通过（与 MigrationSafetyTest 等价）")
else { console.log(`  ✗ ${fails.length} 条断言失败：`); fails.forEach(f => console.log(`    · ${f}`)) }

// ── 追加：down() 对称性断言（与 MigrationSafetyTest::testDownAlsoWrapsForeignKeyChecks 等价）──
function downChecks() {
  const extra = []
  for (const f of CREATE_TABLE_FILES) {
    const src = fs.readFileSync(path.join(MIG, f), 'utf8')
    const start = src.indexOf('public function down')
    if (start < 0) { extra.push(`${f}: 找不到 down()`); continue }
    const code = codeOnly(src.slice(start))
    if (!code.includes('SET FOREIGN_KEY_CHECKS = 0'))
      extra.push(`${f}: down() 缺 FOREIGN_KEY_CHECKS = 0`)
    if (!/finally\s*\{[^}]*SET FOREIGN_KEY_CHECKS = 1/s.test(code))
      extra.push(`${f}: down() 未在 finally 里恢复外键检查`)
  }
  return extra
}
const e = downChecks()
if (e.length === 0) { console.log('  ✓ down() 对称性断言通过（6 个迁移）'); process.exit(0) }
console.log(`  ✗ down() ${e.length} 条断言失败：`); e.forEach(x => console.log(`    · ${x}`)); process.exit(1)
