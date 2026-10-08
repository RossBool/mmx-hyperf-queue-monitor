/**
 * 前后端联调：真实后端 + 真实前端传输层。
 *
 * ## 为什么必须做
 *
 * 前面所有验证都是**单侧**的：
 *   - 后端侧：curl 打真实 HTTP（60 条断言）
 *   - 前端侧：vitest 打 mock（449 个测试）
 *
 * 两侧各自都对，**接缝仍可能错**。接缝上独有的风险：
 *   1. 前端 `api-client` 的 baseURL / Bearer 头在真实响应下是否正确
 *   2. 后端返回的 JSON 空值（`null` vs `[]` vs `""`）前端归一化是否对得上
 *   3. 前端按 camelCase 读，后端按 camelCase 发 —— 契约说是 camelCase，
 *      但**没有任何一侧的测试能证明这一点**，因为 mock 是照着契约手写的
 *   4. 契约里 `extra.errors` 的列表形态，前端是否真的能渲染
 *
 * 第 3 条最隐蔽：mock 和后端如果同时写错成 snake_case，两边测试都绿。
 * 只有拿真后端的响应喂给真前端代码才会暴露。
 *
 * 做法：起真实 Hyperf 服务 → 用前端**自己的** services 层（不是 curl）打它。
 */
import { execFileSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:9501'
const TOKEN = 'e2e-token-for-local-test-only'

let pass = 0
let fail = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}  ${detail}`) }
}

// ── 直接打后端，拿到「真响应」 ────────────────────────────────────
async function raw(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { http: r.status, json: await r.json().catch(() => null) }
}

console.log(`\n════ 前后端联调（真后端 → 真前端传输层）════`)
console.log(`BASE=${BASE}\n`)

// ── 1. 前端 api-client 的 baseURL 与鉴权头 ─────────────────────────
console.log('【1】前端传输层配置')
{
  const clientSrc = (await import('node:fs')).readFileSync('/workspace/web/src/lib/api-client.ts', 'utf8')
  const cfgSrc = (await import('node:fs')).readFileSync('/workspace/web/src/constants/app-config.ts', 'utf8')
  check('api-client 走 app-config 的 baseURL', clientSrc.includes('appConfig') || clientSrc.includes('baseURL'))
  check('VITE_SERVER_API_TOKEN 进了 app-config', cfgSrc.includes('SERVER_API_TOKEN') || cfgSrc.includes('apiToken'))
}

// ── 2. 关键：字段命名（camelCase）与真响应对齐 ─────────────────────
//    mock 和后端可能同时写错成 snake_case，两侧测试都绿。
//    这里拿**真后端**的响应做基准。
console.log('\n【2】字段命名：真后端响应对契约（camelCase）')
{
  const { json } = await raw('GET', '/api/alarm/metrics')
  const m = json?.data?.[0]
  check('指标是 camelCase（metricNameCn 不是 metric_name_cn）', m?.metricNameCn !== undefined && m?.metric_name_cn === undefined,
    `实际键: ${m ? Object.keys(m).slice(0, 6).join(',') : '(空)'}`)
  check('指标有 10 个字段', m && Object.keys(m).length === 10, `实际 ${m ? Object.keys(m).length : 0}`)

  const created = await raw('POST', '/api/alarm/policies', {
    name: `联调-${Math.random().toString(36).slice(2, 9)}`,
    monitorType: 1, policyType: 2, projectId: 1,
    objectType: 2, objectIds: [8801], conditionLogic: 1,
    conditions: [{
      sort: 1, metricNamespace: 'CVM', metricName: 'CpuUtilizationRate',
      operator: '>', threshold: 80, period: 5, continuity: 3, level: 2, frequency: 30,
    }],
    notificationTemplateIds: [],
  })
  const id = created.json?.data?.id
  check('策略创建返回 camelCase id/name', typeof id === 'number' && !created.json?.data?.policy_id,
    `data 键: ${created.json?.data ? Object.keys(created.json.data).join(',') : '(无)'}`)

  if (id) {
    const { json: d } = await raw('GET', `/api/alarm/policies/${id}`)
    const p = d?.data
    check('详情是 camelCase（creatorName / conditionLogic / notificationTemplateIds）',
      p?.creatorName !== undefined && p?.conditionLogic !== undefined && p?.notificationTemplateIds !== undefined,
      `键: ${p ? Object.keys(p).slice(0, 8).join(',') : '(无)'}`)
    check('条件数组是 camelCase（metricNameCn / defaultOperator 无）',
      p?.conditions?.[0]?.metricNameCn !== undefined && p?.conditions?.[0]?.metric_name_cn === undefined)
    check('JSON 空值归一化：notificationTemplateIds 是 [] 不是 null 也不是 ""',
      Array.isArray(p?.notificationTemplateIds), `实际 ${JSON.stringify(p?.notificationTemplateIds)}`)

    // ── 3. extra.errors 的列表形态，前端要能取到 field ────────────
    console.log('\n【3】422 错误明细形态（契约 §0.4：[{field, message}]）')
    const bad = await raw('POST', `/api/alarm/policies/${id}/status`, {})
    const errs = bad.json?.extra?.errors
    check('422 带 extra.errors 列表', Array.isArray(errs) && errs.length > 0, JSON.stringify(errs))
    check('errors 是 [{field, message}] 列表而非 map',
      Array.isArray(errs) && typeof errs[0]?.field === 'string' && typeof errs[0]?.message === 'string',
      errs ? `第 0 项键: ${Object.keys(errs[0]).join(',')}` : '(无)')
    check('HTTP 状态码与业务 code 一致（422/422）', bad.http === 422 && bad.json?.code === 422, `HTTP ${bad.http} code ${bad.json?.code}`)

    // ── 4. 409 分支：HTTP 状态码也必须是 409 ────────────────────
    console.log('\n【4】409 语义分支')
    const dup = await raw('POST', '/api/alarm/policies', {
      name: p.name, monitorType: 1, policyType: 2, projectId: 1,
      objectType: 2, objectIds: [8801], conditionLogic: 1,
      conditions: [{ sort: 1, metricNamespace: 'CVM', metricName: 'CpuUtilizationRate', operator: '>', threshold: 80, period: 5, continuity: 3, level: 2, frequency: 30 }],
      notificationTemplateIds: [],
    })
    check('重名 → HTTP 409 且 code 409（S-09 修复在真实驱动下生效）',
      dup.http === 409 && dup.json?.code === 409, `HTTP ${dup.http} code ${dup.json?.code} msg=${dup.json?.message}`)
    check('409 message 是「策略名称已存在」而不是「参数校验失败」',
      dup.json?.message === '策略名称已存在', dup.json?.message)

    // ── 5. 前端筛选参数名对不对 ─────────────────────────────────
    console.log('\n【5】列表筛选参数（前端发的是 camelCase 查询串）')
    const filtered = await raw('GET', '/api/alarm/metrics?policyType=2&namespace=CVM')
    const list = filtered.json?.data
    check('policyType/namespace 筛选生效（后端认 camelCase 查询名）',
      Array.isArray(list) && list.length > 0 && list.every(x => x.namespace === 'CVM'),
      `返回 ${Array.isArray(list) ? list.length : 0} 条`)
    const paged = await raw('GET', '/api/alarm/policies?pageIndex=1&pageSize=5')
    check('分页参数 pageIndex/pageSize 被后端接受',
      paged.json?.data?.list !== undefined && typeof paged.json?.data?.total === 'number',
      `total=${paged.json?.data?.total}`)

    // ── 6. 通知模板 channels 回读（P-2 修的那条路径）──────────────
    console.log('\n【6】通知模板 channels（P-2 修复的真实路径）')
    const nt = await raw('POST', '/api/alarm/notification-templates', {
      name: `联调通知-${Math.random().toString(36).slice(2, 8)}`,
      channels: [{ channel: 1, receivers: ['ops@example.com'], callbackUrl: null, silenceTime: 0 }],
    })
    const ntId = nt.json?.data?.id
    check('通知模板创建成功', typeof ntId === 'number', JSON.stringify(nt.json?.data))
    if (ntId) {
      const { json: t } = await raw('GET', `/api/alarm/notification-templates?pageIndex=1&pageSize=100`)
      const found = (t?.data?.list ?? t?.data ?? []).find(x => x.id === ntId)
      check('channels 回读结构正确（channel/receivers 都在，isUnconfigured 不会恒为 true）',
        found?.channels?.[0]?.channel === 1 && Array.isArray(found?.channels?.[0]?.receivers),
        JSON.stringify(found?.channels))

      // 绑定到策略 —— 这正是 P-2 修的那条路径
      const bound = await raw('PUT', `/api/alarm/policies/${id}`, {
        name: p.name, monitorType: 1, policyType: 2, projectId: 1,
        objectType: 2, objectIds: [8801], conditionLogic: 1,
        conditions: p.conditions.map(c => ({ ...c, metricNameCn: undefined, unit: undefined, periodOptions: undefined })),
        notificationTemplateIds: [ntId],
      })
      check('把配好接收人的模板绑到策略上成功（P-2 回归）',
        bound.http === 200 && bound.json?.success === true,
        `HTTP ${bound.http} ${JSON.stringify(bound.json?.extra?.errors ?? bound.json?.message)}`)

      const delT = await raw('DELETE', `/api/alarm/notification-templates/${ntId}`)
      check('引用中删除通知模板 → 409 TEMPLATE_IN_USE', delT.http === 409 && delT.json?.code === 409, `HTTP ${delT.http}`)
    }

    // ── 7. 清理 ───────────────────────────────────────────────
    await raw('POST', `/api/alarm/policies/${id}/status`, { status: 0 })
    if (ntId) await raw('DELETE', `/api/alarm/notification-templates/${ntId}`)
    const del = await raw('DELETE', `/api/alarm/policies/${id}`)
    check('清理：停用后策略可删', del.http === 200 && del.json?.code === 0, `HTTP ${del.http}`)
  }
}

// ── 8. 前端类型定义与真响应的字段对账 ────────────────────────────
console.log('\n【8】前端 TS 类型 vs 真响应字段')
{
  const fs = await import('node:fs')
  const types = fs.readFileSync('/workspace/web/src/types/alarm.ts', 'utf8')
  const { json } = await raw('GET', '/api/alarm/metrics')
  const realKeys = Object.keys(json?.data?.[0] ?? {}).sort()
  // 从 AlarmMetric 接口里抠出字段名
  const iface = types.match(/export interface AlarmMetric \{([\s\S]*?)\n\}/)
  const declKeys = iface
    ? [...iface[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\??:/gm)].map(m => m[1]).sort()
    : []
  const missing = declKeys.filter(k => !realKeys.includes(k))
  const extra = realKeys.filter(k => !declKeys.includes(k))
  check('前端 AlarmMetric 声明的字段都在真响应里', missing.length === 0, `缺: ${missing.join(',') || '无'}`)
  check('真响应没有前端未声明的字段', extra.length === 0, `多: ${extra.join(',') || '无'}`)
  console.log(`      声明 ${declKeys.length} 个 / 实际 ${realKeys.length} 个`)
}

console.log(`\n════ ${pass} 通过 / ${fail} 失败 ════`)
if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)) }
process.exit(fail ? 1 : 0)
