/**
 * 迁移幂等性守卫。
 *
 * ## 为什么需要
 *
 * S-07 定的规矩是「迁移重跑必须可自愈」。000100–000800 全用
 * `CREATE TABLE IF NOT EXISTS`，天然幂等。
 *
 * 但 000900 第一版直接 `ALTER TABLE ... ADD COLUMN`，**重跑必然 1060** ——
 * 自己把 S-07 破掉了，而且只有真连 MySQL 重跑一次才会发现。
 * 触发场景很常见：CI 每次都从同一个库快照起；运维手工重跑一次迁移；
 * 部署脚本失败后重试。任一种都会让第二次执行炸掉，
 * 而「第一次明明成功了」的现场很难排查。
 *
 * ## 覆盖三类不幂等写法
 *
 * 1. `ADD COLUMN` / `ADD INDEX` / `ADD UNIQUE KEY` —— 必须先探测存在性
 * 2. `INSERT`（非 `INSERT IGNORE`）—— 重跑会撞唯一键
 *
 * ## 关于 IF NOT EXISTS
 *
 * ⚠️ **MySQL 8.0 不支持 `ADD COLUMN IF NOT EXISTS`**（实测 8.0.46 → 1064 语法错误），
 * 那是 **MariaDB** 的扩展。所以守卫只认「PHP 侧探测 information_schema」这一种解法。
 */
import fs from 'node:fs'
import path from 'node:path'

const MIG = '/workspace/server/migrations'
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.php')).sort()

/**
 * 判断一条 DDL 是否被存在性探测保护。
 *
 * ## 为什么按「往上找最近的 if」而不是函数名白名单
 *
 * 试过两种更简单的写法，都不行：
 *
 *   - **函数名白名单**（认 `columnExists` / `addColumnIfMissing` 等固定名字）：
 *     新迁移里的 `if (! $this->indexExists(...)) { ADD UNIQUE KEY }` 被误判。
 *   - **文件级放行**（文件里出现过任意探测函数就整份跳过）：
 *     只要文件任何角落有 `columnExists()`，真正的裸 `ADD COLUMN` 就被放过。
 *     —— 这是本守卫最早版本的 bug，靠「故意改回裸 ADD COLUMN 看抓不抓得到」
 *     才测出来。
 *
 * 正确做法：从该 DDL 往上找**最近的** `if (...) {`，检查它的条件里
 * 是否真的有存在性探测（`Exists` / `information_schema` / `IF EXISTS`）。
 */
function isGuarded(src, stmtIndex) {
  const before = src.slice(0, stmtIndex)
  const open = before.lastIndexOf('if (')
  if (open < 0)
    return false
  const brace = src.indexOf('{', open)
  if (brace < 0)
    return false
  const cond = src.slice(open, brace)
  return /Exists|information_schema/i.test(cond)
}

const problems = []
let checked = 0

for (const f of files) {
  const src = fs.readFileSync(path.join(MIG, f), 'utf8')
  const upStart = src.indexOf('public function up')
  const upEnd = src.indexOf('public function down')
  if (upStart < 0) {
    problems.push(`${f}: 找不到 up()`)
    continue
  }
  const body = src.slice(upStart, upEnd < 0 ? src.length : upEnd)
  // 去掉注释再看，避免 docblock 里的示例 SQL 造成误判
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  checked++

  // ① 裸 ADD COLUMN（跳过被 if 保护的）
  const addCol = [...code.matchAll(/ALTER TABLE\s+`?(\w+)`?\s+ADD COLUMN\s+`?(\w+)`?/gi)]
    .filter((m) => !isGuarded(code, m.index))
  if (addCol.length) {
    problems.push(
      `${f}: 裸 ADD COLUMN（${addCol.map((m) => `${m[1]}.${m[2]}`).join(', ')}）—— `
      + '重跑会 1060 Duplicate column name。必须先查 information_schema。'
      + '注意 **MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS**（那是 MariaDB）。',
    )
  }

  // ② 裸 ADD UNIQUE / INDEX / KEY / CHECK / CONSTRAINT
  const addIdx = [...code.matchAll(/ALTER TABLE\s+`?(\w+)`?\s+ADD (UNIQUE |FOREIGN KEY |CHECK |CONSTRAINT |INDEX |KEY )/gi)]
    .filter((m) => !isGuarded(code, m.index))
  if (addIdx.length) {
    problems.push(
      `${f}: 裸 ADD INDEX/UNIQUE/CONSTRAINT（${addIdx.length} 处）—— 重跑会 1061/1022/1826，同样需要存在性探测`,
    )
  }

  // ③ 非 IGNORE 的 INSERT
  const ins = [...code.matchAll(/INSERT\s+(?!IGNORE)/gi)]
    .filter((m) => !isGuarded(code, m.index))
  if (ins.length) {
    problems.push(`${f}: 裸 INSERT（${ins.length} 处）—— 重跑会撞唯一键。用 INSERT IGNORE 或先探测`)
  }
}

console.log(`  扫描 ${files.length} 个迁移文件（up() 体检 ${checked} 个）\n`)

// ── 自检：守卫自己必须能抓到东西 ────────────────────────────────────
//
// 「守卫自己抓不到」是这类脚本最常见的失效方式：它跑得很欢、输出 ✓，
// 但规则本身早已失效。��这里用内存里的反例验证规则仍然有效。
const badMigrations = [
  ['裸 ADD COLUMN', `$m = <<<'X';
public function up(): void {
    Db::statement('ALTER TABLE \`t\` ADD COLUMN \`c\` INT NULL');
}`, true],
  ['被 if 保护（应放行）', `$m = <<<'X';
public function up(): void {
    if (! $this->columnExists('t', 'c')) {
        Db::statement('ALTER TABLE \`t\` ADD COLUMN \`c\` INT NULL');
    }
}`, false],
  ['裸 ADD UNIQUE（应抓）', `$m = <<<'X';
public function up(): void {
    Db::statement('ALTER TABLE \`t\` ADD UNIQUE KEY \`uk\` (\`a\`)');
}`, true],
  ['被 if 保护的 UNIQUE（应放行）', `$m = <<<'X';
public function up(): void {
    if (! $this->indexExists('t', 'uk')) {
        Db::statement('ALTER TABLE \`t\` ADD UNIQUE KEY \`uk\` (\`a\`)');
    }
}`, false],
]

const fakeDir = fs.mkdtempSync('/tmp/mig-guard-')
try {
  let selfFail = 0
  for (const [label, content, shouldCatch] of badMigrations) {
    fs.writeFileSync(path.join(fakeDir, 'probe.php'), content, 'utf8')
    const src = fs.readFileSync(path.join(fakeDir, 'probe.php'), 'utf8')
    const upStart = src.indexOf('public function up')
    const body = src.slice(upStart)
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const caught = [...code.matchAll(/ALTER TABLE\s+`?\w+`?\s+ADD (COLUMN|UNIQUE|INDEX|KEY )/gi)]
      .some((m) => !isGuarded(code, m.index))
    if (caught !== shouldCatch) {
      console.log(`  ✗ 守卫自检失败：「${label}」预期 ${shouldCatch ? '被抓' : '被放行'}，实际 ${caught ? '被抓' : '被放行'}`)
      selfFail++
    }
  }
  if (selfFail) {
    console.log('\n  守卫规则本身已失效，先修守卫再谈迁移。\n')
    process.exit(1)
  }
  console.log('  ✓ 守卫自检通过（能抓裸 DDL，也能放行被 if 保护的 DDL）\n')
} finally {
  fs.rmSync(fakeDir, { recursive: true, force: true })
}

if (problems.length) {
  console.log(`  ✗ ${problems.length} 处不幂等：\n`)
  for (const p of problems) console.log(`    · ${p}\n`)
  process.exit(1)
}
console.log('  ✓ 所有迁移的 up() 均幂等（DDL 有存在性探测，INSERT 用 IGNORE 或探测）')
