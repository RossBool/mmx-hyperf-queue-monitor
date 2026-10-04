/**
 * 验证 `classifyIntegrityViolation()` 的分类逻辑 —— S-09。
 *
 * ⚠️ 沙箱无 PHP / MySQL，本脚本是**逻辑等价复刻**，不是实跑。
 * 它复刻的是 `classifyIntegrityViolation()` 的分支判断，输入用 **MySQL 8.0
 * 真实的 (errno, SQLSTATE) 对**。
 */

/** MySQL 8.0 真实的 errno → SQLSTATE。只列本项目可能遇到的。 */
const MYSQL = [
  // 唯一键 —— 真·重名
  { errno: 1062, state: '23000', name: 'ER_DUP_ENTRY（唯一键冲突）', want: [409, '策略名称已存在'] },
  // 外键
  { errno: 1451, state: '23000', name: 'ER_ROW_IS_REFERENCED_2（父行仍被引用）', want: [409, '关联数据已变更，请刷新后重试'] },
  { errno: 1452, state: '23000', name: 'ER_NO_REFERENCED_ROW_2（子行找不到父行）', want: [409, '关联数据已变更，请刷新后重试'] },
  // 非空
  { errno: 1048, state: '23000', name: 'ER_BAD_NULL_ERROR（非空列写 NULL）', want: [422, '参数校验失败'] },
  { errno: 1121, state: 'HY000', name: 'ER_WRONG_COL_NAME', want: [422, '参数校验失败'] },
  // CHECK
  { errno: 3819, state: 'HY000', name: 'ER_CHECK_CONSTRAINT_VIOLATED', want: [422, '参数校验失败'] },
  // 越界 / 超长 —— 审查 A-6：旧实现这里报 500
  { errno: 1264, state: '22003', name: 'ER_WARN_DATA_OUT_OF_RANGE（DECIMAL(20,4) 溢出）', want: [422, '参数校验失败'] },
  { errno: 1406, state: '22001', name: 'ER_DATA_TOO_LONG', want: [422, '参数校验失败'] },
  { errno: 1265, state: '01000', name: 'ER_WARN_DATA_TRUNCATED', want: [422, '参数校验失败'] },
  { errno: 1366, state: '22007', name: 'ER_TRUNCATED_WRONG_VALUE', want: [422, '参数校验失败'] },
  { errno: 1064, state: '42000', name: 'ER_PARSE_ERROR（SQL 写错＝代码 bug）', want: [500, '服务器内部错误'] },
  // 非完整性类：不该被这个处理器接走
  { errno: 1146, state: '42S02', name: 'ER_NO_SUCH_TABLE', want: [500, '服务器内部错误'] },
  { errno: 2006, state: 'HY000', name: 'CR_SERVER_GONE_ERROR（连接断开）', want: [500, '服务器内部错误'] },
]

/** SQLSTATE 无歧义、errno 不可得时的兜底分支 */
const SQLSTATE_ONLY = [
  { errno: null, state: '23505', name: 'SQLSTATE 23505 unique violation（无 errno）', want: [409, '策略名称已存在'] },
  { errno: null, state: '23503', name: 'SQLSTATE 23503 FK violation（无 errno）', want: [409, '关联数据已变更，请刷新后重试'] },
]

/** ── 以下是 AlarmExceptionHandler::classifyIntegrityViolation 的逐字复刻 ── */
const PAYLOAD_REJECTED_ERRNOS = [1048, 1052, 1121, 1136, 1137, 1264, 1265, 1364, 1365, 1366, 1406, 3819, 4025]

function classify(errno, state) {
  if (errno === 1062 || state === '23505') return [409, '策略名称已存在']
  if ([1451, 1452].includes(errno) || ['23001', '23503'].includes(state)) return [409, '关联数据已变更，请刷新后重试']
  if (PAYLOAD_REJECTED_ERRNOS.includes(errno)) return [422, '参数校验失败']
  if (['22001', '22003', '23514'].includes(state)) return [422, '参数校验失败']
  if (state === '23000') return [422, '参数校验失败']
  return null // → 500
}

let pass = 0, fail = 0
const run = (rows) => {
  for (const r of rows) {
    const got = classify(r.errno, r.state) ?? [500, '服务器内部错误']
    const ok = got[0] === r.want[0] && got[1] === r.want[1]
    ok ? pass++ : fail++
    console.log(`  ${ok ? '✓' : '✗'} ${r.name.padEnd(42)} errno=${String(r.errno).padEnd(5)} state=${r.state.padEnd(6)} -> ${got[0]} ${got[1]}`)
  }
}
run(MYSQL)
run(SQLSTATE_ONLY)

// ── 旧实现在同一批输入上的表现（对照组）──
const old = (state) => (String(state).startsWith('23') ? [409, '策略名称已存在'] : [500, '服务器内部错误'])
let oldWrong = 0
for (const r of MYSQL.concat(SQLSTATE_ONLY)) {
  const g = old(r.state)
  if (g[0] !== r.want[0] || g[1] !== r.want[1]) oldWrong++
}
const total = MYSQL.length + SQLSTATE_ONLY.length

console.log(`\n  新实现: ${pass} 通过 / ${fail} 失败（共 ${total} 例）`)
console.log(`  旧实现: ${oldWrong} 例判错（同一批输入）`)
if (fail === 0 && oldWrong > 0) {
  console.log('  ✓ 分类逻辑成立，且旧实现确有错判')
  process.exit(0)
}
console.log('  ✗ 分类逻辑不成立')
process.exit(1)
