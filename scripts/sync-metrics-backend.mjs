/**
 * 把 metrics.md §1 的 10 个新指标同步进 server/config/autoload/metrics.php。
 *
 * 为什么用脚本而不是手改：契约 §2.7 规定该文件是 GET /api/alarm/metrics 的
 * **唯一数据源**，且**必须与 metrics.md 逐字一致**。手改 351 行 PHP 表格
 * 容易漏掉 description 里的引号转义 —— 用脚本从同一份字段定义生成，零漂移。
 *
 * 插入位置：同 namespace 内按 metrics.md 的顺序追加到该 namespace 末尾，
 * 保证后端返回顺序与文档一致（契约未强制顺序，但不一致会让排障时对不上号）。
 */
import fs from 'node:fs'

const TARGET = '/workspace/server/config/autoload/metrics.php'
const NEW = [
  // ── CVM ──
  {
    namespace: 'CVM',
    metricName: 'FileDescriptorUsageRate',
    metricNameCn: '文件描述符使用率',
    unit: '%',
    policyType: [2],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 80,
    suggestedContinuity: 3,
    description: '已打开 FD 数占进程 FD 上限（ulimit -n / LimitNOFILE）比例，取值 0-100。「Too many open files」是 Linux Top 5 故障，且通常先于内存耗尽出现；内存与连接数指标都发现不了它——进程可以只开文件、不占多少内存、连接数也正常。',
  },
  {
    namespace: 'CVM',
    metricName: 'InodeUsageRate',
    metricNameCn: 'inode 使用率',
    unit: '%',
    policyType: [2],
    periodOptions: [30, 60],
    defaultOperator: '>',
    defaultThreshold: 85,
    suggestedContinuity: 2,
    description: '已用 inode 数占文件系统 inode 总数比例，取值 0-100。与 DiskUsageRate 正交：磁盘有空间但 inode 用完时，磁盘指标全绿而任何文件创建都会失败（写日志、落临时文件全挂）。慢变量。',
  },
  {
    namespace: 'CVM',
    metricName: 'DiskDaysToFull',
    metricNameCn: '预计写满天数',
    unit: '天',
    policyType: [2],
    periodOptions: [30, 60],
    defaultOperator: '<',
    defaultThreshold: 7,
    suggestedContinuity: 1,
    description: '按近 7 天平均增速外推，距离磁盘写满还剩多少天。取值越小越危险，因此默认算子是 < —— 本字典中唯一一个「越低越糟」的指标。同一个 DiskUsageRate=85% 对 50G/天涨 2G 的盘只剩 3 天、对 1T/天涨 2G 的盘还剩 75 天，绝对阈值表达不了这个差异。',
  },
  {
    namespace: 'CVM',
    metricName: 'DiskReadIops',
    metricNameCn: '磁盘读 IOPS',
    unit: 'IOPS',
    policyType: [2],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 5000,
    suggestedContinuity: 3,
    description: '统计周期内云盘平均每秒读操作数。与 DiskReadTraffic(MB/s) 正交：大量小文件/随机读场景吞吐很低但 IOPS 打满，只看 MB/s 会漏。',
  },
  {
    namespace: 'CVM',
    metricName: 'DiskWriteIops',
    metricNameCn: '磁盘写 IOPS',
    unit: 'IOPS',
    policyType: [2],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 5000,
    suggestedContinuity: 3,
    description: '统计周期内云盘平均每秒写操作数。与 DiskWriteTraffic(MB/s) 正交，理由同上。日志密集型服务的高频小写入是典型场景。',
  },

  // ── WEB ──
  {
    namespace: 'WEB',
    metricName: 'HttpMaxDuration',
    metricNameCn: '最大响应延迟',
    unit: 'ms',
    policyType: [1],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 5000,
    suggestedContinuity: 2,
    description: '统计周期内单次请求的最大耗时。P99 之后仍有 1% 的请求更慢，在低 QPS 服务上这 1% 可能就是全部用户——此时 P99 看起来完全正常。',
  },

  // ── CLB ──
  {
    namespace: 'CLB',
    metricName: 'ClbBackendResponseTime',
    metricNameCn: '后端响应时间',
    unit: 'ms',
    policyType: [3],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 500,
    suggestedContinuity: 3,
    description: 'CLB 侧观测到的后端 RS 响应耗时。与 WEB.HttpP99Duration 交叉可定位「慢在 LB 还是后端」——这是 ClbHttp5xxRatio 已采用的定位思路，响应时间侧此前缺失，导致同一个设计原则只落实了一半。',
  },

  // ── MYSQL ──
  {
    namespace: 'MYSQL',
    metricName: 'MysqlDeadlockCount',
    metricNameCn: '死锁数',
    unit: '次',
    policyType: [4],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 0,
    suggestedContinuity: 2,
    description: '统计周期内 InnoDB 死锁并被回滚的事务对数。MysqlSlowQueryCount 发现不了死锁——死锁涉及的两条 SQL 各自都不慢，它们是互相等锁。表现为间歇性请求超时，极难定位。',
  },
  {
    namespace: 'MYSQL',
    metricName: 'MysqlLockWaitTime',
    metricNameCn: '锁等待平均时长',
    unit: 'ms',
    policyType: [4],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 1000,
    suggestedContinuity: 3,
    description: '统计周期内行锁/元数据锁的平均等待时长。持续偏高说明存在热点行或长事务，是死锁的前兆信号。',
  },
  {
    namespace: 'MYSQL',
    metricName: 'MysqlConnectionRejectCount',
    metricNameCn: '连接被拒数',
    unit: '次',
    policyType: [4],
    periodOptions: [1, 5, 10, 30, 60],
    defaultOperator: '>',
    defaultThreshold: 0,
    suggestedContinuity: 2,
    description: '触及 max_connections 时 MySQL 直接拒绝新连接的次数（Too many connections）。MysqlConnectionRatio 只在连接数逼近上限时告警；瞬时打满再回落时采样点上 ratio 可能根本没超阈值，但用户已经被拒了。',
  },
]

const phpString = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const phpList = (a) => `[${a.join(', ')}]`

function render(m) {
  return `    [
        'namespace' => ${phpString(m.namespace)},
        'metricName' => ${phpString(m.metricName)},
        'metricNameCn' => ${phpString(m.metricNameCn)},
        'unit' => ${phpString(m.unit)},
        'policyType' => ${phpList(m.policyType)},
        'periodOptions' => ${phpList(m.periodOptions)},
        'defaultOperator' => ${phpString(m.defaultOperator)},
        'defaultThreshold' => ${m.defaultThreshold},
        'suggestedContinuity' => ${m.suggestedContinuity},
        'description' => ${phpString(m.description)},
    ],`
}


// ── 尾部：交叉校验 metrics.md ↔ metrics.php ──────────────────────────
// 契约 §2.7 规定 metrics.md 是唯一事实来源，metrics.php 是它的机器可读副本。
// ⚠️ 这里**只比 namespace.metricName 的集合与顺序**，不比字段值。
// 对抗复核证明：只比名字时，把 metrics.md 里 DiskDaysToFull 的阈值从 7 改成 99、
// 把 DiskReadIops 的单位从 IOPS 改成 GB/s，本脚本依然全绿。
// 字段值的逐项比对由 verify-metrics-consistency.mjs 负责（10 字段 × 38 指标）。
// 两个脚本都跑才算守住，不要只看本脚本的输出就认为字段没漂移。
{
  const md = fs.readFileSync("/workspace/docs/alarm/metrics.md", "utf8")
  const rows = []
  let cur = null
  for (const l of md.split("\n")) {
    const h = l.match(/^### 1\.\d+ `([A-Z]+)`/)
    if (h) { cur = h[1]; continue }
    if (l.startsWith("### 1.5")) { cur = null; continue }
    const r = l.match(/^\| `([A-Za-z0-9]+)` \|/)
    if (cur && r) rows.push(cur + "." + r[1])
  }
  const now = fs.readFileSync(TARGET, "utf8")
  const phpRows = [...now.matchAll(/'namespace' => '([A-Z]+)',\s*\n\s*'metricName' => '([A-Za-z0-9]+)'/g)].map((m) => m[1] + "." + m[2])
  const onlyMd = rows.filter((x) => !phpRows.includes(x))
  const onlyPhp = phpRows.filter((x) => !rows.includes(x))
  if (onlyMd.length || onlyPhp.length || JSON.stringify(rows) !== JSON.stringify(phpRows)) {
    console.error("  ✗ metrics.md 与 metrics.php 漂移：")
    if (onlyMd.length) console.error("     仅在 md:", onlyMd.join(", "))
    if (onlyPhp.length) console.error("     仅在 php:", onlyPhp.join(", "))
    if (!onlyMd.length && !onlyPhp.length) console.error("     集合相同但**顺序不一致**")
    process.exit(1)
  }
  console.log(`  ✓ 指标名集合与顺序一致：${rows.length} 个（字段值由 verify-metrics-consistency.mjs 把关）`)
}

let src = fs.readFileSync(TARGET, 'utf8')

// 结构化解析：把 `return [` 到 `];` 之间按 4 空格缩进的 `    [` … `    ],` 切成块。
// 不用正则猜块边界 —— 上面那版在嵌套 `]`（如 periodOptions）上就失配了。
const headEnd = src.indexOf('return [')
if (headEnd < 0) { console.error('  ✗ 未找到 return ['); process.exit(1) }
const head = src.slice(0, headEnd + 'return ['.length)
const body = src.slice(headEnd + 'return ['.length, src.lastIndexOf('];'))
const tail = src.slice(src.lastIndexOf('];'))

const BLOCK_RE = /^ {4}\[\n[\s\S]*?^ {4}\],$/gm
const blocks = body.match(BLOCK_RE) || []
const before = blocks.length

const blockMeta = (b) => ({
  namespace: (b.match(/'namespace' => '([A-Z]+)'/) || [])[1],
  metricName: (b.match(/'metricName' => '([A-Za-z0-9]+)'/) || [])[1],
})

let added = 0
for (const m of NEW) {
  if (blocks.some((b) => blockMeta(b).metricName === m.metricName)) {
    console.log(`  · ${m.metricName} 已存在，跳过`)
    continue
  }
  // 插到该 namespace 最后一条之后（找不到该 namespace 则追加到末尾）
  let at = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blockMeta(blocks[i]).namespace === m.namespace) { at = i + 1; break }
  }
  if (at < 0) at = blocks.length
  blocks.splice(at, 0, render(m).replace(/^ {4}\[\n/, '    [\n'))
  added++
}

fs.writeFileSync(TARGET, head + '\n' + blocks.join('\n') + '\n' + tail)
console.log(`  ✓ 新增 ${added} 个，指标总数 ${before} → ${blocks.length}`)

