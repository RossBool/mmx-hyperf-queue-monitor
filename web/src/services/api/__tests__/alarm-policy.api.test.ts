import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AlarmPolicyConditionPayload } from '@/types/alarm'

import {
  copyAlarmPolicy,
  createAlarmConditionTemplate,
  createAlarmPolicy,
  deleteAlarmConditionTemplate,
  deleteAlarmPolicy,
  fetchAlarmConditionTemplateList,
  fetchAlarmMetrics,
  fetchAlarmPolicyDetail,
  fetchAlarmPolicyList,
  setAlarmPolicyStatus,
  updateAlarmConditionTemplate,
  updateAlarmPolicy,
} from '../alarm-policy.api'

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-client', () => ({ apiFetch }))

const response = { data: null, extra: {}, code: 0, message: 'success', success: true }

/** P10 的 9 个必填字段，官方示例里不带 `id` / `metricNameCn` / `unit`。 */
const conditionPayload: AlarmPolicyConditionPayload = {
  sort: 1,
  metricNamespace: 'CVM',
  metricName: 'CpuUtilizationRate',
  operator: '>',
  threshold: 90,
  period: 5,
  continuity: 3,
  level: 1,
  frequency: 15,
}

const policyPayload = {
  name: '生产 CVM CPU 监控',
  remark: '核心交易集群',
  monitorType: 1 as const,
  policyType: 2 as const,
  projectId: 12,
  objectType: 2 as const,
  objectIds: [8801, 8802],
  objectGroupIds: null,
  objectFilters: null,
  conditionLogic: 2 as const,
  conditions: [conditionPayload],
  notificationTemplateIds: [3, 5],
  conditionTemplateId: 0,
  status: 1 as const,
}

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockResolvedValue(response)
})

describe('alarm-policy 传输层', () => {
  // ① GET /alarm/policies —— 筛选参数原样进 query
  it('① 拉取策略列表时把筛选条件放进 query', async () => {
    const query = { keyword: 'CPU', policyType: 2 as const, status: 1 as const, page: 1, pageSize: 20 }
    await expect(fetchAlarmPolicyList(query)).resolves.toBe(response)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies', { method: 'get', query })
  })

  it('① 不带参数时 query 为空对象', async () => {
    await fetchAlarmPolicyList()
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies', { method: 'get', query: {} })
  })

  // ② GET /alarm/policies/{id}
  it('② 拉取策略详情', async () => {
    await fetchAlarmPolicyDetail(1001)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies/1001', { method: 'get' })
  })

  // ③ POST /alarm/policies
  it('③ 创建策略：POST + 全量 body', async () => {
    await createAlarmPolicy(policyPayload)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies', {
      method: 'post',
      body: policyPayload,
    })
  })

  it('③ 条件用 Payload 形态：请求体里不出现响应专用字段 id', async () => {
    await createAlarmPolicy(policyPayload)
    const [, options] = apiFetch.mock.calls[0]
    const sent = options.body.conditions[0]
    expect(sent).toEqual(conditionPayload)
    expect(sent).not.toHaveProperty('id')
    expect(sent).not.toHaveProperty('metricNameCn')
    expect(sent).not.toHaveProperty('unit')
  })

  it('③ §0.6 R-JSON-1：不适用的 object 字段提交 null 而不是 []', async () => {
    await createAlarmPolicy({ ...policyPayload, objectType: 1, objectIds: null })
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body.objectIds).toBeNull()
    expect(options.body.objectGroupIds).toBeNull()
    expect(options.body.objectFilters).toBeNull()
  })

  // ④ PUT /alarm/policies/{id} —— 全量更新语义
  it('④ 更新策略：PUT + 完整 body（含全部 conditions）', async () => {
    const twoConditions = [conditionPayload, { ...conditionPayload, sort: 2 as const }]
    await updateAlarmPolicy(1001, { ...policyPayload, conditions: twoConditions })
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies/1001', {
      method: 'put',
      body: { ...policyPayload, conditions: twoConditions },
    })
    expect(apiFetch.mock.calls[0][1].body.conditions).toHaveLength(2)
  })

  it('④ 全量更新时省略 status 表示保持原值（P18）', async () => {
    // P18：PUT 省略 status 时服务端保持原值，启停只能走 ⑥
    const fullUpdatePayload = {
      name: policyPayload.name,
      remark: policyPayload.remark,
      monitorType: policyPayload.monitorType,
      policyType: policyPayload.policyType,
      projectId: policyPayload.projectId,
      objectType: policyPayload.objectType,
      objectIds: policyPayload.objectIds,
      conditionLogic: policyPayload.conditionLogic,
      conditions: policyPayload.conditions,
      notificationTemplateIds: policyPayload.notificationTemplateIds,
      conditionTemplateId: policyPayload.conditionTemplateId,
    }
    await updateAlarmPolicy(1001, fullUpdatePayload)
    expect(apiFetch.mock.calls[0][1].body).not.toHaveProperty('status')
  })

  // ⑤ DELETE /alarm/policies/{id}
  it('⑤ 删除策略', async () => {
    await deleteAlarmPolicy(1001)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies/1001', { method: 'delete' })
  })

  // ⑥ POST /alarm/policies/{id}/status
  it('⑥ 启停策略：POST + { status }', async () => {
    await setAlarmPolicyStatus(1001, { status: 0 })
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies/1001/status', {
      method: 'post',
      body: { status: 0 },
    })
  })

  // ⑦ POST /alarm/policies/{id}/copy
  it('⑦ 复制策略：POST 且不带请求体', async () => {
    await copyAlarmPolicy(1001)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/policies/1001/copy', { method: 'post' })
  })

  // ⑧ GET /alarm/metrics
  it('⑧ 拉取指标字典（不分页）', async () => {
    await fetchAlarmMetrics({ policyType: 2 })
    expect(apiFetch).toHaveBeenCalledWith('/alarm/metrics', {
      method: 'get',
      query: { policyType: 2 },
    })
  })

  // ⑨ GET /alarm/condition-templates
  it('⑨ 拉取触发条件模板分页', async () => {
    await fetchAlarmConditionTemplateList({ policyType: 2, page: 1, pageSize: 20 })
    expect(apiFetch).toHaveBeenCalledWith('/alarm/condition-templates', {
      method: 'get',
      query: { policyType: 2, page: 1, pageSize: 20 },
    })
  })

  // ⑩ POST /alarm/condition-templates
  it('⑩ 创建触发条件模板', async () => {
    const payload = { name: 'CVM 高频模板', policyType: 2 as const, conditions: [conditionPayload] }
    await createAlarmConditionTemplate(payload)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/condition-templates', {
      method: 'post',
      body: payload,
    })
  })

  // ⑪ PUT /alarm/condition-templates/{id}
  it('⑪ 更新触发条件模板：PUT 全量', async () => {
    const payload = { name: 'CVM 高频模板', policyType: 2 as const, conditions: [conditionPayload] }
    await updateAlarmConditionTemplate(9, payload)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/condition-templates/9', {
      method: 'put',
      body: payload,
    })
  })

  // ⑫ DELETE /alarm/condition-templates/{id}
  it('⑫ 删除触发条件模板', async () => {
    await deleteAlarmConditionTemplate(9)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/condition-templates/9', { method: 'delete' })
  })
})
