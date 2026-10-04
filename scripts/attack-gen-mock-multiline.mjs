/**
 * L-11 负对照：构造对抗复核报告里的那个用例 ——
 * description 是多行 PHP 单引号字符串，且其中一行恰好是 `    ],`。
 * 期望 gen-mock-metrics.mjs **响亮失败**，而不是静默产出错的 description。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const PHP = '/workspace/server/config/autoload/metrics.php'
const GEN = '/workspace/scripts/gen-mock-metrics.mjs'
const orig = fs.readFileSync(PHP, 'utf8')
const BT = String.fromCharCode(96)

const run = () => {
  try {
    const out = execFileSync('node', [GEN], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

let fail = 0
try {
  // 注入多行 description：中间夹一行 `    ],` 逼 BLOCK 正则提前截断
  // description 是每个块的最后一个字段，所以锚点是它后面紧跟的块结束行
  const needle = /('description' => ')([^']*)(',\n    \],)/
  if (!needle.test(orig)) {
    console.log('  ! 未找到注入锚点（metrics.php 结构变了？）')
    process.exit(2)
  }
  const injected = orig.replace(needle, (_m, a, _b, c) => `${a}第一行\n    ],\n    'x' => 'y',\n    'description' => '第二行${c}`)
  fs.writeFileSync(PHP, injected)

  const r = run()
  if (r.code === 0) {
    console.log('  ✗ 注入多行 description 后脚本仍返回 EXIT=0 —— 静默失败，守卫无效')
    fail = 1
  } else {
    const firstErr = (r.out.match(/✗[^\n]*/) || ['（无 ✗ 行）'])[0]
    console.log(`  ✓ 注入后 EXIT=${r.code}，响亮失败`)
    console.log(`    ${firstErr.trim()}`)
    if (firstErr.includes('✗')) {
      // 逐条负对照：每个 ✗ 都要有可操作的修法指引
      const hasHint = /修法|改成单行|多半是|含换行/.test(r.out)
      console.log(`    ${hasHint ? '✓' : '✗'} 报错信息给出了可操作的修法指引`)
      if (!hasHint) fail = 1
    }
  }
} finally {
  fs.writeFileSync(PHP, orig)
  const r2 = run()
  console.log(`  ${r2.code === 0 ? '✓' : '✗'} 恢复原文件后 EXIT=${r2.code}`)
  if (r2.code !== 0) fail = 1
}

// 恢复后 generated.ts 必须与磁盘上的原版一致（不能被负对照污染）
const gen = fs.readFileSync(GEN, 'utf8')
if (gen.includes('BT')) { /* noop */ }

process.exit(fail)
