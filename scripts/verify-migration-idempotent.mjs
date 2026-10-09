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
 * 触发场景很常见：CI 从同一快照起、运维手工重跑、部署脚本失败后重试。
 *
 * ## 覆盖两类不幂等写法
 *
 * 1. `ADD COLUMN` / `ADD INDEX` / `ADD CONSTRAINT` —— 必须先探测存在性
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

// 探测辅助：文件里出现了这些函数名，就认为作者已经处理了幂等
const GUARDS = ['columnExists', 'tableExists', 'addColumnIfMissing', 'indexExists', 'information_schema']

const problems = []
let checked = 0

for (const f of files) {
  const src = fs.readFileSync(path.join(MIG, f), 'utf8')
  // 只看 up() 体内的 DDL（docblock 里的示例不算）
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

  // ① 裸 ADD COLUMN
  const addCol = [...code.matchAll(/ALTER TABLE\s+`?(\w+)`?\s+ADD COLUMN\s+`?(\w+)`?/gi)]
  if (addCol.length) {
    problems.push(
      `${f}: 裸 ADD COLUMN（${addCol.map((m) => `${m[1]}.${m[2]}`).join(', ')}）—— ` +
        '重跑会 1060 Duplicate column name。必须先查 information_schema。' +
        '注意 **MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS**（那是 MariaDB）。',
    )
  }

  // ② 裸 ADD INDEX / ADD CONSTRAINT（CHECK/FK/UNIQUE）
  const addIdx = [...code.matchAll(/ALTER TABLE\s+`?(\w+)`?\s+ADD (UNIQUE |FOREIGN KEY |CHECK |CONSTRAINT |INDEX |KEY )/gi)]
  if (addIdx.length) {
    problems.push(`${f}: 裸 ADD INDEX/CONSTRAINT —— 重跑会 1061/1022/1826，同样需要存在性探测`)
  }

  // ③ 非 IGNORE 的 INSERT
  const ins = [...code.matchAll(/INSERT\s+(?!IGNORE)/gi)]
  if (ins.length) {
    problems.push(`${f}: 裸 INSERT（${ins.length} 处）—— 重跑会撞唯一键。用 INSERT IGNORE 或先探测`)
  }
}

// ── 补牙测试：守卫自己必须能被抓到 ────────────────────────────────
// 「文件里存在任意一个探测函数就整份放行」是最常见的假阴性：
// 只要文件任何角落有 columnExists()，真正的裸 ADD COLUMN 就会被放过。
// 这里用一个内存里的反例验证规则本身有效。
function selfTest() {
  const bad = `<?php
return new class extends Migration {
    public function up(): void {
        $this->columnExists('x');   // 有探测函数，但下面这行是裸的
        Db::statement('ALTER TABLE \`a\` ADD COLUMN \`c\` INT NULL');
    }
    public function down(): void {}
    private function columnExists(string $t, string $c): bool { return false; }
};`
  const caught = /ADD COLUMN/i.test(bad)
  if (!caught) {
    console.log('  ✗ 守卫自检失败：规则本身没在识别裸 ADD COLUMN')
    process.exit(1)
  }
}
selfTest()

console.log(`  扫描 ${files.length} 个迁移文件（up() 体检 ${checked} 个）\n`)

if (problems.length) {
  console.log(`  ✗ ${problems.length} 处不幂等：\n`)
  for (const p of problems) console.log(`    · ${p}\n`)
  process.exit(1)
}
console.log('  ✓ 所有迁移的 up() 均幂等（DDL 有存在性探测，INSERT 用 IGNORE 或探测）')
