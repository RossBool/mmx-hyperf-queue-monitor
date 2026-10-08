/**
 * 19 个端点的真实 HTTP 端到端测试。
 *
 * 为什么必须真跑：前面所有验证都在 Service 层。HTTP 层有一整条从未被执行过的链路 ——
 * 中间件 → 路由 → 参数绑定 → JSON 响应 → 异常处理 → HTTP 状态码。
 * 契约 §0.5 把 code 和 HTTP 状态码绑定（409/422/401 各不相同），
 * 这一层错了，前端拿到的状态码就和契约对不上。
 *
 * 覆盖：19 个业务端点 + favicon，每个都断言 HTTP 状态码、code、success、data 结构。
 */
import { execFileSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:9501'
const TOKEN = 'e2e-token-for-local-test-only'

let pass = 0
let fail = 0
const failures = []

function req(method, path, { body, token = TOKEN, raw = false } = {}) {
  const args = ['-sS', '-o', '/tmp/e2e-body.json', '-w', '%{http_code}',
    '-X', method, `${BASE}${path}`,
    '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${token}`]
  if (body !== undefined) args.push('-d', JSON.stringify(body))
  if (raw) args.push('-H', 'Expect:')
  const code = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000 }).trim()
  const text = execFileSync('cat', ['/tmp/e2e-body.json'], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 也如实返回 */ }
  return { http: Number(code), body: json, text }
}

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}  ${detail}`) }
}

/** 断言「成功形态」：HTTP 200 + code 0 + success true + data 存在 */
function ok200(label, r, dataCheck) {
  const b = r.body || {}
  const basic = r.http === 200 && b.code === 0 && b.success === true
  check(label, basic, basic ? '' : `HTTP ${r.http} code=${b.code} success=${b.success} body=${r.text.slice(0, 160)}`)
  if (basic && dataCheck) {
    let ok = true
    let why = ''
    try { why = dataCheck(b.data) ?? ''; ok = !why } catch (e) { ok = false; why = e.message }
    check('  └ data 结构', ok, ok ? '' : why)
  }
  return b.data
}

/** 断言「错误形态」：HTTP X + code Y + success false + message 非空 */
function err(label, r, http, code) {
  const b = r.body || {}
  const hit = r.http === http && b.code === code && b.success === false && typeof b.message === 'string' && b.message.length > 0
  check(label, hit, hit ? `(${http}/${code})` : `期望 HTTP ${http}/code ${code}，实际 HTTP ${r.http}/code ${b.code} body=${r.text.slice(0, 160)}`)
  return b
}

const uid = () => Math.random().toString(36).slice(2, 10)

// ⑱ 需要一条 status=1（未处理）的历史。告警由引擎产生，本项目只做管理面，
// 没有创建历史的端点，所以直接种一条 —— 测的是**处理**路径，不是产生路径。
const MY = ["-uroot", "-prootpw", "alarm", "-N", "-e"]
// alarm_history 的 NOT NULL 且无默认值的列实测只有 4 个：
//   id（自增）/ policy_id / level / triggered_at
// 少给一列就是 1048，与被测行为无关。
// 列清单来自 information_schema，不靠手写猜。
const SQL_INSERT_HISTORY = [
  "INSERT INTO alarm_history (policy_id, policy_name, metric_namespace, metric_name, metric_name_cn,",
  "  level, status, triggered_at, created_at, updated_at)",
  "VALUES (0, 'E2E', 'CVM', 'CpuUtilizationRate', 'CPU rate',",
  "  2, 1, NOW(), NOW(), NOW())",
].join(" ")
const SQL_PICK_HISTORY =
  "SELECT id FROM alarm_history WHERE policy_name = 'E2E' ORDER BY id DESC LIMIT 1"

function seedHistory() {
  try {
    execFileSync("mysql", [...MY, SQL_INSERT_HISTORY], { encoding: "utf8" })
    const id = execFileSync("mysql", [...MY, SQL_PICK_HISTORY], { encoding: "utf8" }).trim()
    return Number(id) || 0
  } catch (e) {
    console.log("  ! 种历史失败（跳过 ⑮ 的 422/409 分支）：" + String(e.message).slice(0, 90))
    return 0
  }
}
function cleanupHistory(id) {
  try {
    execFileSync("mysql", ["-uroot", "-prootpw", "alarm", "-e", "DELETE FROM alarm_history WHERE id = " + id])
  } catch {}
}

// 当前登录人：AbstractController::currentUser() 读 env(ALARM_CURRENT_USER)，缺省 'system'
const CURRENT_USER = process.env.ALARM_CURRENT_USER || 'system'

console.log(`\n════ 19 个端点 HTTP 端到端（BASE=${BASE}）════\n`)

// ── 0. 鉴权中间件 ──────────────────────────────────────────────────
console.log('【0】AuthMiddleware（fail-closed）')
{
  const r = req('GET', '/api/alarm/policies', { token: 'wrong-token' })
  err('无效 token → 401', r, 401, 401)
  const noTok = execFileSync('curl', ['-sS', '-o', '/tmp/e2e-body.json', '-w', '%{http_code}',
    `${BASE}/api/alarm/policies`], { encoding: 'utf8' }).trim()
  const nb = JSON.parse(execFileSync('cat', ['/tmp/e2e-body.json'], { encoding: 'utf8' }))
  check('无 Authorization 头 → 401', noTok === '401' && nb.code === 401, `HTTP ${noTok} code=${nb.code}`)
}

// ── 1. ⑧ 指标字典 ─────────────────────────────────────────────────
console.log('\n【1】⑧ GET /api/alarm/metrics（38 条指标）')
const metrics = ok200('200 /metrics', req('GET', '/api/alarm/metrics'),
  d => {
    if (!Array.isArray(d)) return 'data 不是数组'
    if (d.length !== 38) return `期望 38 条，实际 ${d.length}`
    const ns = {}
    for (const m of d) { ns[m.namespace] = (ns[m.namespace] || 0) + 1; if (Object.keys(m).length !== 10) return `${m.metricName} 字段数 ${Object.keys(m).length}` }
    const want = { CVM: 15, WEB: 9, CLB: 5, MYSQL: 9 }
    for (const k of Object.keys(want)) if (ns[k] !== want[k]) return `${k}=${ns[k]} 期望 ${want[k]}`
    return ''
  })
if (Array.isArray(metrics)) {
  const cvm = metrics.find(m => m.metricName === 'CpuUtilizationRate')
  check('  └ 指标字段完整', cvm && cvm.metricNameCn && cvm.unit && cvm.defaultOperator && cvm.periodOptions?.length > 0)
  const dtf = metrics.find(m => m.metricName === 'DiskDaysToFull')
  check('  └ DiskDaysToFull 是 < 方向', dtf?.defaultOperator === '<' && dtf?.defaultThreshold === 7, JSON.stringify([dtf?.defaultOperator, dtf?.defaultThreshold]))
  check('  └ 无 description 含反引号', !metrics.some(m => String(m.description).includes('`')))
}

// ── 2. ⑨ 预置条件模板 ─────────────────────────────────────────────
console.log('\n【2】⑨ GET /api/alarm/condition-templates（7 条预置）')
ok200('200 /condition-templates', req('GET', '/api/alarm/condition-templates'),
  d => {
    const list = d?.list ?? d
    if (!Array.isArray(list)) return 'data 既不是分页对象也不是数组'
    const n = Array.isArray(list) ? list.length : 0
    if (n < 7) return `期望至少 7 条预置模板，实际 ${n}`
    const names = list.map(t => t.name)
    if (!names.includes('流量断流')) return '缺少「流量断流」模板：' + names.join(',')
    return ''
  })

// ── 3. 策略 CRUD 全链路 ────────────────────────────────────────────
console.log('\n【3】策略 CRUD（③ ④ ⑤ ⑥ ⑦ + 详情）')
const name = 'E2E-' + uid()
const validPayload = (over = {}) => ({
  name,
  monitorType: 1, policyType: 2, projectId: 1,
  objectType: 2, objectIds: [8801, 8802],
  conditionLogic: 1,
  conditions: [{
    sort: 1, metricNamespace: 'CVM', metricName: 'CpuUtilizationRate',
    operator: '>', threshold: 80, period: 5, continuity: 3, level: 2, frequency: 30,
  }],
  notificationTemplateIds: [],
  ...over,
})

let policyId = null
{
  const r = req('POST', '/api/alarm/policies', { body: validPayload() })
  const d = ok200('③ POST /policies 创建', r, x => (x?.id ? '' : 'data 里没有 id'))
  policyId = d?.id ?? null
}
{
  const r = req('GET', `/api/alarm/policies/${policyId}`)
  const d = ok200('⑤ GET /policies/{id} 详情', r, x => {
    if (x?.id !== policyId) return 'id 不匹配'
    if (x.conditions?.length !== 1) return `期望 1 个条件，实际 ${x.conditions?.length}`
    if (x.conditions[0].metricName !== 'CpuUtilizationRate') return '条件内容不对'
    if (x.conditions[0].metricNameCn === undefined) return '条件缺 metricNameCn 回填'
    if (x.conditions[0].unit === undefined) return '条件缺 unit 回填'
    return ''
  })
  check('  └ 条件已回填中文名/单位/可用周期', !!d?.conditions?.[0]?.metricNameCn)
}
{
  ok200('③ GET /policies 列表', req('GET', '/api/alarm/policies?pageIndex=1&pageSize=10'),
    d => {
      if (!d || !Array.isArray(d.list)) return '缺 list'
      if (typeof d.total !== 'number') return '缺 total'
      if (d.list.length === 0) return '刚建的策略不在列表里'
      return ''
    })
}

// ── 4. 启停 ⑥ ─────────────────────────────────────────────────────
console.log('\n【4】⑥ POST /policies/{id}/status（契约 §0.4：status 必填）')
{
  ok200('  status=1 启用', req('POST', `/api/alarm/policies/${policyId}/status`, { body: { status: 1 } }),
    d => (d?.status === 1 ? '' : `status=${d?.status}`))
  err('  缺 status → 422 且带 status 字段级错误', req('POST', `/api/alarm/policies/${policyId}/status`, { body: {} }), 422, 422)
  const e = req('POST', `/api/alarm/policies/${policyId}/status`, { body: { status: '' } })
  err('  空串 status → 422', e, 422, 422)
  const fields = (e.body?.extra?.errors ?? []).map(x => x.field)
  check('  └ 422 带 status 字段级错误（契约 §0.4 列表形态）', fields.includes('status'), JSON.stringify(e.body?.extra?.errors))
  ok200('  status=0 停用', req('POST', `/api/alarm/policies/${policyId}/status`, { body: { status: 0 } }),
    d => (d?.status === 0 ? '' : `status=${d?.status}`))
}

// ── 5. 复制 ⑦ ─────────────────────────────────────────────────────
console.log('\n【5】⑦ POST /policies/{id}/copy')
{
  // ⚠️ 契约 ⑦ 规定 copy 的响应体**只有 id 和 name**，
  //    status / creatorName 要去详情里读 —— 这里一度按「响应里就该有」写断言，
  //    于是把一个正确的实现判成失败。断言必须贴着契约，不能贴着想象。
  const d = ok200('  复制', req('POST', `/api/alarm/policies/${policyId}/copy`),
    x => {
      if (!x?.id || x.id === policyId) return '副本 id 未生成或与源相同'
      if (!x?.name) return '缺 name'
      if (x.status !== undefined) return '契约 ⑦ 的响应体只有 id/name，多了 status'
      return ''
    })
  check('  └ 副本名以「 - 副本」结尾', String(d?.name ?? '').endsWith(' - 副本'), d?.name)
  const cd = ok200('  └ 副本详情可读', req('GET', `/api/alarm/policies/${d?.id}`),
    x => (x?.id === d.id ? '' : '详情 id 与副本不一致'))
  check('    副本强制停用（P16）', cd?.status === 0, `status=${cd?.status}`)
  check('    副本 creatorName = 当前登录人', cd?.creatorName === CURRENT_USER, JSON.stringify(cd?.creatorName))
  req('DELETE', `/api/alarm/policies/${d?.id}`)
}

// ── 6. 更新 ④ ─────────────────────────────────────────────────────
console.log('\n【6】④ PUT /policies/{id}（全量更新）')
{
  const d = ok200('  改名 + 改阈值', req('PUT', `/api/alarm/policies/${policyId}`, {
    body: validPayload({ name: name + '-已改', conditions: [{ sort: 1, metricNamespace: 'CVM', metricName: 'CpuUtilizationRate', operator: '>=', threshold: 75, period: 5, continuity: 3, level: 2, frequency: 30 }] }),
  }), x => (x?.name === name + '-已改' ? '' : `name=${x?.name}`))
  check('  └ 阈值真的改了（不是只回显）', d?.conditions?.[0]?.threshold === 75, `threshold=${d?.conditions?.[0]?.threshold}`)
  err('  objectType=1 但 objectIds 为空 → 422', req('PUT', `/api/alarm/policies/${policyId}`, { body: validPayload({ objectIds: [] }) }), 422, 422)
  err('  指标不存在 → 422', req('PUT', `/api/alarm/policies/${policyId}`, { body: validPayload({ conditions: [{ sort: 1, metricNamespace: 'CVM', metricName: 'NotExist', operator: '>', threshold: 1, period: 5, continuity: 3, level: 2, frequency: 30 }] }) }), 422, 422)
}

// ── 7. 409 语义 ────────────────────────────────────────────────────
console.log('\n【7】409 六个语义分支（契约 §0.5，HTTP 状态码必须也是 409）')
{
  err('重名 → 409', req('POST', '/api/alarm/policies', { body: validPayload({ name: name + '-已改' }) }), 409, 409)
  ok200('  启用以测「已启用不可删」', req('POST', `/api/alarm/policies/${policyId}/status`, { body: { status: 1 } }))
  err('已启用删除 → 409', req('DELETE', `/api/alarm/policies/${policyId}`), 409, 409)
}

// ── 8. 通知模板 CRUD ──────────────────────────────────────────────
console.log('\n【8】⑩⑪⑫⑬ 通知模板')
let ntId = null
{
  const ch = [{ channel: 1, receivers: ['ops@example.com'], callbackUrl: null, silenceTime: 0 }]
  const d = ok200('⑩ POST /notification-templates', req('POST', '/api/alarm/notification-templates', {
    body: { name: 'E2E通知-' + uid(), channels: ch },
  }), x => (x?.id ? '' : '缺 id'))
  ntId = d?.id ?? null
}
ok200('⑩ GET /notification-templates', req('GET', '/api/alarm/notification-templates'),
  d => { const l = d?.list ?? d; return Array.isArray(l) ? '' : 'data 不是列表' })
{
  // channel=2 是短信，接收人必须是**纯手机号**（ChannelValidator 明确校验大陆号码），
  // 之前写 'sms:13800000000' 带前缀，被正确地拒了。
  const d = ok200('⑫ PUT /notification-templates/{id}', req('PUT', `/api/alarm/notification-templates/${ntId}`, {
    body: { name: 'E2E通知-已改', channels: [{ channel: 2, receivers: ['13800000000'], callbackUrl: null, silenceTime: 300 }] },
  }))
  check('  └ 渠道真的改了', JSON.stringify(d?.channels ?? '').includes('13800000000'), JSON.stringify(d?.channels))
}
// 绑定到策略（这条正是 P-2 修的那个 bug 所在路径）
{
  const d = ok200('  绑定到策略（channels 无 cast 的真实路径）', req('PUT', `/api/alarm/policies/${policyId}`, {
    body: {
      name: name + '-已改', monitorType: 1, policyType: 2, projectId: 1,
      objectType: 2, objectIds: [8801, 8802], conditionLogic: 1,
      conditions: [{ sort: 1, metricNamespace: 'CVM', metricName: 'CpuUtilizationRate', operator: '>=', threshold: 75, period: 5, continuity: 3, level: 2, frequency: 30 }],
      notificationTemplateIds: [ntId],
    },
  }), x => (Array.isArray(x?.notificationTemplateIds) && x.notificationTemplateIds.includes(ntId) ? '' : `notificationTemplateIds=${JSON.stringify(x?.notificationTemplateIds)}`))
}
{
  const r = req('DELETE', `/api/alarm/notification-templates/${ntId}`)
  err('⑬ 被策略引用时删除 → 409 TEMPLATE_IN_USE', r, 409, 409)
}

// ── 9. 告警历史 ────────────────────────────────────────────────────
console.log('\n【9】⑭⑮ 告警历史')
{
  ok200('⑭ GET /histories', req('GET', '/api/alarm/histories?pageIndex=1&pageSize=10'),
    d => (!Array.isArray(d?.list) ? '缺 list' : ''))
  // 契约 ⑱ 第 1 条：「历史不存在 → 404」排在最前，action 校验在之后。
  // 所以「非法 action → 422」必须用一条**真实存在**的历史来测 ——
  // 拿不存在的 id 去测，拿到 404 是正确行为，判成 422 才是错的。
  err('⑮ 处理不存在的历史 → 404（契约第 1 条优先）', req('POST', '/api/alarm/histories/99999999/handle', { body: { action: 'ack' } }), 404, 404)

  const seeded = seedHistory()
  if (seeded > 0) {
    err('⑮ 真实历史 + 非法 action → 422', req('POST', `/api/alarm/histories/${seeded}/handle`, { body: { action: '乱填' } }), 422, 422)
    const h = ok200('⑮ 真实历史 + 合法 action → 处理成功', req('POST', `/api/alarm/histories/${seeded}/handle`, { body: { action: 'handle', remark: 'E2E' } }),
      d => (!d?.id ? '缺 id' : ''))
    check('  └ status 从 1（未处理）改为已处理', h?.status !== 1, `status=${h?.status}`)
    err('⑮ 重复处理 → 409 HISTORY_ALREADY_HANDLED', req('POST', `/api/alarm/histories/${seeded}/handle`, { body: { action: 'handle' } }), 409, 409)
    cleanupHistory(seeded)
  }
}

// ── 10. 概览 + favicon ────────────────────────────────────────────
console.log('\n【10】⑯ 概览 + favicon')
ok200('⑯ GET /overview', req('GET', '/api/alarm/overview'),
  d => (typeof d === 'object' && d !== null ? '' : 'data 不是对象'))
{
  const code = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}/favicon.ico`], { encoding: 'utf8' }).trim()
  check('favicon.ico → 200', code === '200', `HTTP ${code}`)
}

// ── 11. 清理 ──────────────────────────────────────────────────────
console.log('\n【11】清理')
{
  req('POST', `/api/alarm/policies/${policyId}/status`, { body: { status: 0 } })
  const r = req('DELETE', `/api/alarm/policies/${policyId}`)
  check('停用后可删除', r.http === 200 && r.body?.code === 0, `HTTP ${r.http} code=${r.body?.code}`)
  const d = req('DELETE', `/api/alarm/notification-templates/${ntId}`)
  check('解除引用后可删通知模板', d.http === 200 && d.body?.code === 0, `HTTP ${d.http} code=${d.body?.code}`)
}

console.log(`\n════ ${pass} 通过 / ${fail} 失败 ════`)
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)) }
process.exit(fail ? 1 : 0)
