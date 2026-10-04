/**
 * 迁移列名校验：解析每个建表迁移的真实列名，核对所有 INSERT 的列清单。
 *
 * 起因：000800 往 alarm_condition_template 插数据时写了 `description`，
 * 而 000700 建表时该列叫 `remark` —— 真实 MySQL 上是 1054 Unknown column，迁移直接失败。
 * 沙箱没有 MySQL/PHP，这类错误只有静态校验能兜住。
 *
 * 纪律：不只校验「列存在」，还要校验「没有多余列」和「必填列没漏」。
 */
import fs from 'node:fs'
import path from 'node:path'

const MIG = '/workspace/server/migrations'
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.php')).sort()

/** 收集所有 CREATE TABLE 的列名（跳过 PRIMARY KEY / UNIQUE / KEY / CONSTRAINT / CHECK 行）。 */
const tableCols = new Map() // table -> Set<col>
const tableColsOrdered = new Map() // table -> string[]

for (const f of files) {
  const src = fs.readFileSync(path.join(MIG, f), 'utf8')
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`(\w+)`\s*\(([\s\S]*?)\n\s*\)\s*ENGINE/g
  let m
  while ((m = re.exec(src)) !== null) {
    const [, table, body] = m
    const cols = []
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/,\s*$/, '').trim()
      if (!line) continue
      if (/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FOREIGN|CHECK|INDEX)\b/i.test(line)) continue
      const cm = line.match(/^`(\w+)`\s+/)
      if (cm) cols.push(cm[1])
    }
    if (!tableCols.has(table)) {
      tableCols.set(table, new Set())
      tableColsOrdered.set(table, [])
    }
    for (const c of cols) {
      tableCols.get(table).add(c)
      tableColsOrdered.get(table).push(c)
    }
  }
}

/** NOT NULL 且无 DEFAULT、且不在主键/自增里的列 → 插入时必须给值。 */
const required = new Map() // table -> Set<col>
for (const f of files) {
  const src = fs.readFileSync(path.join(MIG, f), 'utf8')
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`(\w+)`\s*\(([\s\S]*?)\n\s*\)\s*ENGINE/g
  let m
  while ((m = re.exec(src)) !== null) {
    const [, table, body] = m
    if (!required.has(table)) required.set(table, new Set())
    const rset = required.get(table)
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/,\s*$/, '').trim()
      if (/^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FOREIGN|CHECK|INDEX)\b/i.test(line)) continue
      const cm = line.match(/^`(\w+)`\s+(.*)$/)
      if (!cm) continue
      const [, col, rest] = cm
      const hasDefault = /\bDEFAULT\b/i.test(rest)
      const isAutoInc = /\bAUTO_INCREMENT\b/i.test(rest)
      const isNull = /\bNULL\b/i.test(rest) && !/\bNOT\s+NULL\b/i.test(rest)
      if (!hasDefault && !isAutoInc && !isNull) rset.add(col)
    }
  }
}

let errors = 0
const err = (...a) => {
  errors++
  console.log('  ✗ ' + a.join(' '))
}

const checkedInserts = []

for (const f of files) {
  const src = fs.readFileSync(path.join(MIG, f), 'utf8')
  // INSERT [IGNORE] INTO `tbl` (`a`,`b`) VALUES ... / (...), (...);
  const re = /INSERT(?:\s+IGNORE)?\s+INTO\s+`(\w+)`\s*\(([^)]*?)\)\s*VALUES/gi
  let m
  while ((m = re.exec(src)) !== null) {
    const [, table, colListRaw] = m
    const insertCols = colListRaw
      .split(',')
      .map((c) => c.trim().replace(/^`|`$/g, ''))
      .filter(Boolean)
    checkedInserts.push({ file: f, table, insertCols })

    if (!tableCols.has(table)) {
      err(`${f}: INSERT 目标表 \`${table}\` 没有对应的 CREATE TABLE，无法校验`)
      continue
    }
    const known = tableCols.get(table)
    const order = tableColsOrdered.get(table)
    for (const c of insertCols) {
      if (!known.has(c)) {
        err(
          `${f}: 表 \`${table}\` 没有列 \`${c}\``
          + (c === 'description' ? '（列名疑似写成了 description，真实列名可能是 remark）' : '')
          + `\n      真实列: ${order.join(', ')}`
        )
      }
    }
    const dup = insertCols.filter((c, i) => insertCols.indexOf(c) !== i)
    if (dup.length) err(`${f}: 表 \`${table}\` INSERT 列清单重复: ${[...new Set(dup)].join(', ')}`)

    for (const c of required.get(table) || []) {
      if (!insertCols.includes(c)) {
        err(`${f}: 表 \`${table}\` 的必填列 \`${c}\`（NOT NULL 且无 DEFAULT）未出现在 INSERT 列清单中`)
      }
    }
  }
}

/** 反向：建表里声明了但从没有任何迁移写入过的列（仅提示，多为正常业务列）。 */
console.log(`  扫描 ${files.length} 个迁移文件，${tableCols.size} 张表，${checkedInserts.length} 处 INSERT`)
console.log(`  ${[...tableCols.entries()].map(([t, s]) => `${t}:${s.size}列`).join('  ')}`)

if (errors) {
  console.log(`\n  ✗ ${errors} 处迁移列名/必填项问题`)
  process.exit(1)
}
console.log('\n  ✓ 所有 INSERT 列名存在于建表定义，且必填列齐全')
