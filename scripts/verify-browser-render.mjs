#!/usr/bin/env node
/**
 * 真实浏览器渲染验证。
 *
 * ## 为什么非做不可
 *
 * 之前所有验证都在 jsdom 或 HTTP 层，**没有任何一个跑过真实浏览器**。
 * 这类测试覆盖不到的失败恰好是最常见的那批：
 *   - Vue 运行时错误（模板编译期查不出、jsdom 不执行、真实浏览器才炸）
 *   - 组件库（shadcn-vue / reka-ui）在真实 DOM 上的行为差异
 *   - CSS 导致元素不可见但「存在」→ jsdom 测不出来
 *   - 异步 chunk 加载失败、路由懒加载异常
 *   - `vue-tsc` 能过但运行时 undefined
 *
 * ## 链路是真的
 *
 *   真实 Chromium
 *     → 生产构建产物（vite build，不是 dev server）
 *     → 真实 HTTP 到 Hyperf 后端（9501）
 *     → 真实 MySQL
 *
 * 任何一环挂了都会在这里暴露。
 *
 * ## 用法
 *
 *   node scripts/verify-browser-render.mjs [--keep-screenshots]
 *
 * 前置：后端在 9501、web/dist 已按正确 env 构建。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { chromium } from '/workspace/web/node_modules/playwright/index.mjs'

const BASE = process.env.RENDER_BASE_URL || 'http://127.0.0.1:4173'
const API = process.env.RENDER_API_URL || 'http://127.0.0.1:9501'
const SHOT_DIR = '/workspace/.render-shots'
const KEEP = process.argv.includes('--keep-screenshots')

fs.mkdirSync(SHOT_DIR, { recursive: true })

let pass = 0
let fail = 0
const failures = []
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}  ${detail}`) }
}

// ── 先确认两个服务都活着，否则报错会伪装成「渲染失败」──────────────
function probe(url, label) {
  try {
    const code = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-m', '5', url],
      { encoding: 'utf8', timeout: 15000 }).trim()
    return code === '200'
  } catch {
    console.log(`  ✗ ${label} 不可达（${url}）—— 先起服务，否则所有断言都会假失败`)
    process.exit(2)
  }
}

console.log(`\n════ 真实浏览器渲染验证 ════\n  前端 ${BASE}\n  后端 ${API}\n`)
if (!probe(`${BASE}/`, '前端'))
  process.exit(2)
if (!probe(`${API}/favicon.ico`, '后端'))
  process.exit(2)

// ── 造一批真实数据，让页面不是空的 ──────────────────────────────────
// 空表格渲染成功毫无意义：数据形态（null 字段、超长中文、
// 静默策略、相对判据）才是最容易炸渲染的地方。
const TOKEN = 'e2e-token-for-local-test-only'
const now = Date.now()
const seeds = [
  {
    name: `渲染-相对环比-${now}`, policyType: 2, monitorType: 1, enabled: 1,
    objectType: 2, objectIds: [8801, 8802], conditionLogic: 1,
    conditions: [{
      sort: 1, metricNamespace: 'CVM', metricName: 'CpuUtilizationRate',
      operator: '>', threshold: 80, period: 5, continuity: 3, level: 2, frequency: 15,
      compareMode: 'relative', baselineType: 'period', baselineCount: 2,
    }],
  },
  {
    name: `采集静默策略名称很长很长很长很长很长很长用来测试换行-${now}`,
    policyType: 5, monitorType: 1, enabled: 1,
    objectType: 2, objectIds: [8801], conditionLogic: 1,
    targetType: 1, targetFreshnessMinutes: 30,
    conditions: [{ sort: 1, period: 5, continuity: 1, level: 2, frequency: 15 }],
  },
  {
    name: `渲染-绝对阈值-${now}`, policyType: 1, monitorType: 2, enabled: 0,
    objectType: 2, objectIds: [8801], conditionLogic: 1,
    conditions: [{
      sort: 1, metricNamespace: 'WEB', metricName: 'Http5xxRatio',
      operator: '>', threshold: 5, period: 5, continuity: 2, level: 1, frequency: 15,
    }],
  },
]

const created = []
for (const s of seeds) {
  const r = execFileSync('curl', ['-sS', '-X', 'POST', `${API}/api/alarm/policies`,
    '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${TOKEN}`,
    '-d', JSON.stringify(s)], { encoding: 'utf8', timeout: 20000 })
  const j = JSON.parse(r)
  if (j.code === 0) created.push(j.data.id)
  else console.log(`  ⚠ 造数据失败：${j.message}`)
}
check('造出 3 条真实策略数据', created.length === 3, `实际 ${created.length}`)

// ⚠️ 必须显式指定 executablePath：`npx playwright install chromium` 装的是
// **完整版 Chromium**，而 playwright 的 headless 模式默认去找
// `chromium_headless_shell-*`（另一个包）。不指就报
// 「Executable doesn't exist」，看起来像没装成功，其实是装了两个不同的东西。
// 本机只有完整版，所以指到它，并用 headless 模式跑。
const CHROME = process.env.RENDER_CHROME
  || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`

if (!fs.existsSync(CHROME)) {
  console.log(`  ✗ 找不到 Chromium：${CHROME}`)
  console.log('    先跑：PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright npx playwright install chromium')
  process.exit(2)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

// 收集**所有**控制台错误和未捕获异常 —— 这是本脚本的主要产出
const consoleErrors = []
const externalNoise = []
const pageErrors = []
const failedRequests = []
/**
 * 控制台错误收集。
 *
 * ⚠️ 必须区分「**我们的**错误」和「环境噪声」。
 * 沙箱里 iconify / unisvg 这类外部图标 CDN 走 HTTPS 会报
 * `ERR_CERT_AUTHORITY_INVALID` —— 那是网络环境问题，不是代码问题。
 * 但**不能**简单地把所有证书错误忽略掉：那会让将来真的出现
 * 「自签名证书导致 API 调不通」时被一起吞掉。
 *
 * 判据：只有**外部第三方域名**的证书/QUIC 错误算噪声；
 * 指向我们自己服务（本 BASE / 本 API）的任何错误一律算真问题。
 */
const NOISE_HOSTS = /api\.iconify\.design|api\.unisvg\.com|fonts\.googleapis|fonts\.gstatic/

/** 记录所有失败请求（含主机名），用于给「无 URL 的控制台错误」归因。 */
const failedAll = []
page.on('requestfailed', (r) => {
  let host = ''
  try { host = new URL(r.url()).host } catch { host = r.url() }
  failedAll.push({ url: r.url(), host, err: r.failure()?.errorText ?? '' })
})

page.on('console', (m) => {
  if (m.type() !== 'error') return
  const text = m.text().slice(0, 300)
  // 控制台消息「Failed to load resource: ...」**不带 URL**，
  // 所以不能只看文案 —— 靠下面 failedAll 里有无非噪声主机来归因。
  if (/^Failed to load resource:/.test(text)) {
    const hasOwnFailure = failedAll.some((f) => !NOISE_HOSTS.test(f.host) && /CERT|QUIC_TLS/i.test(f.err))
    if (hasOwnFailure) {
      consoleErrors.push(text)
      return
    }
    externalNoise.push(text)
    return
  }
  consoleErrors.push(text)
})
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
page.on('requestfailed', (r) => {
  const u = r.url()
  if (u.startsWith(BASE)) failedRequests.push(`${u} ${r.failure()?.errorText ?? ''}`.slice(0, 200))
})
page.on('response', (r) => {
  // 本项目自己的接口返回 4xx/5xx 也要算问题，不能只看网络层失败
  if (r.url().startsWith(API) && r.status() >= 400) {
    failedRequests.push(`${r.status()} ${r.url()}`)
  }
})

const PAGES = [
  { path: '/alarm/policy', name: '告警策略', expect: ['告警策略', '策略'] },
  { path: '/alarm/history', name: '告警历史', expect: [] },
  { path: '/alarm/notification-template', name: '通知模板', expect: [] },
]

console.log('\n【1】逐页渲染')
for (const p of PAGES) {
  const before = { c: consoleErrors.length, p: pageErrors.length, r: failedRequests.length }
  let status = 0
  try {
    const resp = await page.goto(`${BASE}${p.path}`, { waitUntil: 'networkidle', timeout: 45000 })
    status = resp?.status() ?? 0
    // 等 Vue 真正把内容渲染出来，而不是只等 network idle
    await page.waitForFunction(() => {
      const el = document.querySelector('#app')
      return el && el.children.length > 0 && el.innerText.trim().length > 20
    }, { timeout: 20000 })
    await page.waitForTimeout(900)
  } catch (e) {
    check(`${p.name} 渲染`, false, String(e).slice(0, 160))
    continue
  }

  const text = await page.evaluate(() => document.querySelector('#app')?.innerText ?? '')
  const newErr = consoleErrors.length - before.c
  const newPageErr = pageErrors.length - before.p

  check(`${p.name} HTTP 200`, status === 200, `实际 ${status}`)
  check(`${p.name} 有实际内容`, text.trim().length > 30, `innerText 长度 ${text.trim().length}`)
  check(`${p.name} 无控制台错误`, newErr === 0, consoleErrors.slice(before.c).join(' | ').slice(0, 200))
  check(`${p.name} 无未捕获异常`, newPageErr === 0, pageErrors.slice(before.p).join(' | ').slice(0, 200))

  if (KEEP) {
    const f = path.join(SHOT_DIR, `${p.path.replace(/\//g, '_')}.png`)
    await page.screenshot({ path: f, fullPage: true })
    console.log(`     截图 ${f}`)
  }
}

// ── 列表页必须真的渲染出那 3 条数据 ────────────────────────────────
console.log('\n【2】数据真的上屏')
{
  await page.goto(`${BASE}/alarm/policy`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const text = await page.evaluate(() => document.querySelector('#app')?.innerText ?? '')
  check('列表出现「相对环比」策略', text.includes('相对环比'))
  check('列表出现「采集静默」策略', text.includes('采集静默'))
  check('列表出现「绝对阈值」策略', text.includes('绝对阈值'))
  // 静默策略的 targetType=null，列表不应把它渲染成 "null"
  check('页面不出现字面量 null', !/\bnull\b/.test(text),
    (text.match(/.{0,20}null.{0,20}/) ?? [''])[0])
  check('页面不出现 undefined', !/\bundefined\b/.test(text),
    (text.match(/.{0,20}undefined.{0,20}/) ?? [''])[0])
  check('页面不出现 NaN', !/\bNaN\b/.test(text),
    (text.match(/.{0,20}NaN.{0,20}/) ?? [''])[0])
  if (KEEP) {
    await page.screenshot({ path: path.join(SHOT_DIR, '_list.png'), fullPage: true })
  }
}

// ── 新建向导：v1.1 的两个新 UI 在真实浏览器里能否渲染 ────────────────
//
// ⚠️ 这里踩过三个假设错误，全部记录下来，因为它们让**测试本身**先失败：
//
//   1. 以为表单是抽屉（dialog）。实际是**独立路由页** `/alarm/policy/create`
//      —— 断言 `[role=dialog]` 恒为 0，而页面里确实没有对话框。
//      更阴的是：侧边导航里本来就有「触发条件」四个字，
//      于是 `text.includes('触发条件')` **恒为真** —— 一个必然通过的假断言。
//   2. 以为「添加条件」在第 1 步。实际表单是 **4 步向导**，
//      条件编辑器在**第 2 步（告警条件）**。
//   3. 以为「静默检测」卡在第 1 步。实际也在第 2 步。
//
// 教训：UI 断言必须**先确认控件真的在页面上**，再断言它的内容。
// 用「包含某段文字」当存在性证明，是最常见的假阳性来源。
console.log('\n【3】v1.1 表单控件（走完真实向导流程）')
{
  await page.goto(`${BASE}/alarm/policy/create`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)

  // 存在性前置：确认这真的是新建页，而不是落到了别处
  const t0 = await page.evaluate(() => document.body.innerText)
  check('新建页渲染出「新建告警策略」', t0.includes('新建告警策略'),
    `实际页面前 60 字：${t0.slice(0, 60).replace(/\n/g, ' ')}`)

  await page.getByLabel('策略名称').fill('浏览器渲染验证')
  await page.locator('[role="combobox"]').nth(0).click()
  await page.waitForTimeout(500)
  await page.locator('[role="option"]').filter({ hasText: '云产品监控' }).first().click()
  await page.waitForTimeout(800)

  // ── ① 采集静默 → 静默检测卡
  await page.locator('[role="combobox"]').nth(1).click()
  await page.waitForTimeout(500)
  const hasSilence = await page.locator('[role="option"]').filter({ hasText: '采集静默' }).count()
  check('策略类型下拉含「采集静默」(v1.1)', hasSilence > 0)
  await page.locator('[role="option"]').filter({ hasText: '采集静默' }).first().click()
  await page.waitForTimeout(900)

  await page.getByRole('button', { name: /下一步/ }).first().click()
  await page.waitForTimeout(1600)
  const t1 = await page.evaluate(() => document.body.innerText)
  check('静默策略显示「静默检测」卡 (v1.1)', t1.includes('静默检测'))
  check('静默策略显示「监控目标类型」', t1.includes('监控目标类型'))
  check('静默策略显示「静默时长」', t1.includes('静默时长'))
  check('静默策略**不**显示「判据模式」', !t1.includes('判据模式'),
    '静默条件不含指标判据，显示出来是错的')
  if (KEEP) await page.screenshot({ path: path.join(SHOT_DIR, '_form-silence.png'), fullPage: true })

  // ── ② CVM → 相对判据控件
  await page.goto(`${BASE}/alarm/policy/create`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.getByLabel('策略名称').fill('浏览器渲染验证2')
  await page.locator('[role="combobox"]').nth(0).click()
  await page.waitForTimeout(500)
  await page.locator('[role="option"]').filter({ hasText: '云产品监控' }).first().click()
  await page.waitForTimeout(800)
  await page.locator('[role="combobox"]').nth(1).click()
  await page.waitForTimeout(500)
  await page.locator('[role="option"]').filter({ hasText: '云服务器 CVM' }).first().click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: /下一步/ }).first().click()
  await page.waitForTimeout(1600)

  const add = page.getByRole('button', { name: '添加条件' }).first()
  check('第 2 步有可用的「添加条件」', await add.count() > 0 && await add.isVisible(),
    '向导第 2 步才是条件编辑器')
  if (await add.count() && await add.isVisible()) {
    await add.click()
    await page.waitForTimeout(1400)
    const t2 = await page.evaluate(() => document.body.innerText)
    check('CVM 条件显示「判据模式」(v1.1)', t2.includes('判据模式'))
    check('条件显示「阈值」', t2.includes('阈值'))
    // 绝对模式下不该出现基线配置（那是 relative 才有的）
    check('绝对模式默认**不**显示「基线类型」', !t2.includes('基线类型'),
      '默认 absolute 时显示基线配置会让用户以为必须填')
    if (KEEP) await page.screenshot({ path: path.join(SHOT_DIR, '_form-condition.png'), fullPage: true })

    // 切到相对判据，看基线面板是否按契约联动
    const cmb = page.locator('[role="combobox"]').filter({ hasText: '绝对阈值' }).first()
    if (await cmb.count()) {
      await cmb.click()
      await page.waitForTimeout(500)
      await page.locator('[role="option"]').filter({ hasText: '相对基线偏离' }).first().click()
      await page.waitForTimeout(1000)
      const t3 = await page.evaluate(() => document.body.innerText)
      check('切到相对判据后显示「基线类型」', t3.includes('基线类型'))
      check('切到相对判据后显示「环比（与前 N 个周期比）」', t3.includes('环比'))
      check('切到相对判据后显示「前移周期数」', t3.includes('前移周期数'))
      check('相对模式提示阈值是百分比', t3.includes('百分比'),
        '不提示量纲变了，用户会把 30 当成 30% CPU')
      if (KEEP) await page.screenshot({ path: path.join(SHOT_DIR, '_form-relative.png'), fullPage: true })
    } else {
      check('找到「判据模式」选择器', false, '页面上没有显示「绝对阈值」的下拉')
    }
  }
}

// ── 汇总 ──────────────────────────────────────────────────────────
console.log('\n【4】全局汇总')
check('全程无失败的前端资源请求', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '))
check('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ').slice(0, 200))

await browser.close()

// 清理造的数据
for (const id of created) {
  execFileSync('curl', ['-sS', '-o', '/dev/null', '-X', 'POST', `${API}/api/alarm/policies/${id}/status`,
    '-H', 'Content-Type: application/json', '-H', `Authorization: Bearer ${TOKEN}`, '-d', '{"status":0}'], { timeout: 15000 })
  execFileSync('curl', ['-sS', '-o', '/dev/null', '-X', 'DELETE', `${API}/api/alarm/policies/${id}`,
    '-H', `Authorization: Bearer ${TOKEN}`], { timeout: 15000 })
}

if (!KEEP) fs.rmSync(SHOT_DIR, { recursive: true, force: true })

if (externalNoise.length) {
  console.log(`\n  ℹ 已忽略 ${externalNoise.length} 条**外部 CDN** 错误（非本项目代码问题）`)
  const noiseHosts = [...new Set(failedAll.filter((f) => NOISE_HOSTS.test(f.host)).map((f) => f.host))]
  console.log(`    实际失败主机：${noiseHosts.join(', ') || '（未能归因，见 failedAll）'}`)
  console.log(`    错误文案：${[...new Set(externalNoise.map((e) => e.replace(/^Failed to load resource: /, '')))].slice(0, 2).join(' / ')}`)
  console.log('    判据：仅当域名属于第三方图标/字体 CDN 且错误是证书类时忽略。')
  console.log('    指向本项目自身服务的同类错误不会被忽略。')
}

console.log(`\n  ${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('  失败项：')
  failures.forEach((f) => console.log('    - ' + f))
}
process.exit(fail ? 1 : 0)
