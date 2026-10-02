/**
 * 告警策略 / 指标 / 触发条件模板 —— 传输层（契约端点 ①-⑫）。
 *
 * 唯一事实来源：`/workspace/docs/alarm/contract.md`（v1.0，已冻结）。
 * 签名、路径、method、body **必须与契约 1:1 一致**；本文件只负责发请求，
 * 不做数据加工、不吞异常、不本地化枚举。
 *
 * 端点速查：
 * | # | method | 路径 | 请求体 | `data` |
 * | --- | --- | --- | --- | --- |
 * | ① | GET | `/alarm/policies` | - | `Page<AlarmPolicyListItem>` |
 * | ② | GET | `/alarm/policies/{id}` | - | `AlarmPolicyDetail` |
 * | ③ | POST | `/alarm/policies` | 创建字段 | `AlarmPolicyDetail` |
 * | ④ | PUT | `/alarm/policies/{id}` | 创建字段（全量） | `AlarmPolicyDetail` |
 * | ⑤ | DELETE | `/alarm/policies/{id}` | - | `true` |
 * | ⑥ | POST | `/alarm/policies/{id}/status` | `{ status }` | `AlarmPolicyDetail` |
 * | ⑦ | POST | `/alarm/policies/{id}/copy` | - | `{ id, name }` |
 * | ⑧ | GET | `/alarm/metrics` | - | `AlarmMetric[]`（不分页） |
 * | ⑨ | GET | `/alarm/condition-templates` | - | `Page<AlarmConditionTemplate>` |
 * | ⑩ | POST | `/alarm/condition-templates` | 模板字段 | `AlarmConditionTemplate` |
 * | ⑪ | PUT | `/alarm/condition-templates/{id}` | 模板字段（全量） | `AlarmConditionTemplate` |
 * | ⑫ | DELETE | `/alarm/condition-templates/{id}` | - | `true` |
 *
 * 路径写相对 `apiFetch` baseURL（`http://localhost:3000/api`）的部分，故此处是 `/alarm/...`。
 *
 * @see ../../../types/alarm —— 契约类型层
 */

import type {
  AlarmConditionTemplate,
  AlarmConditionTemplateListQuery,
  AlarmConditionTemplatePayload,
  AlarmMetric,
  AlarmMetricListQuery,
  AlarmPage,
  AlarmPolicyCopyResult,
  AlarmPolicyCreatePayload,
  AlarmPolicyDetail,
  AlarmPolicyListItem,
  AlarmPolicyListQuery,
  AlarmPolicyStatusPayload,
} from '@/types/alarm'

import { apiFetch } from '@/lib/api-client'

import type { IResponse } from '../types/response.type'

// ============================================================================
// 实现约束（写在这里是为了改这个文件时不用翻契约）
//
// 1. **空串不参与筛选**（契约 ①）：`apiFetch` 的 `query` 透传，所以调用方要在发请求前
//    剔除空串 / undefined，非法枚举值后端会返 422。列表页的 query 组装见
//    `src/pages/alarm/policy/utils/policy-logic.ts:buildPolicyListQuery`。
// 2. **④ PUT 必须提交完整表单**（含全部 conditions）：省略 `conditions` 等价于清空
//    → 422；`status` 省略表示保持原值，启停只能走 ⑥。组装见 `buildPolicyPayload(values, 'update')`。
// 3. **⑤ 删除前先看 `status`**：`status===1` 时前端禁用删除按钮（P15）；但仍要处理 409，
//    因为列表数据是旧的，别人可能刚启用了这条策略。
// 4. **条件编辑器用 ⑧ 拉指标字典**：选定后用 `defaultOperator / defaultThreshold /
//    suggestedContinuity / periodOptions` 预填；`operator` 原样取符号，禁止本地化。
// 5. **⑨-⑫ 条件模板**：`isPreset=1` 可改不可删；被策略引用时删除返 409。
//
// 另：`VITE_USE_MOCK=true` 时本文件所有函数会返回 `src/mocks/` 的契约示例数据，
// 可在无后端的情况下先跑通页面。TODO(mock)：补齐 ③④⑤⑥⑦⑩⑪⑫ 的 mock 写入语义。
// ============================================================================

// ---------------------------------------------------------------------------
// ① GET /api/alarm/policies 策略分页列表
// ---------------------------------------------------------------------------

/** 多条件之间为 AND；空字符串视为未传（不参与筛选）。非法枚举值返回 422。 */
export async function fetchAlarmPolicyList(query: AlarmPolicyListQuery = {}) {
  return await apiFetch<IResponse<AlarmPage<AlarmPolicyListItem>>>('/alarm/policies', {
    method: 'get',
    query,
  })
}

// ---------------------------------------------------------------------------
// ② GET /api/alarm/policies/{id} 策略详情
//
// ⚠️ 详情里的 `objectIds/objectGroupIds/objectFilters` 永远是 `null`（不是 `[]`），
// `notificationTemplateIds` 永远是数组；`notificationTemplates[].channels` 是编码数组 `int[]`。
// ---------------------------------------------------------------------------

export async function fetchAlarmPolicyDetail(id: number) {
  return await apiFetch<IResponse<AlarmPolicyDetail>>(`/alarm/policies/${id}`, {
    method: 'get',
  })
}

// ---------------------------------------------------------------------------
// ③ POST /api/alarm/policies 创建策略
// ---------------------------------------------------------------------------

export async function createAlarmPolicy(data: AlarmPolicyCreatePayload) {
  return await apiFetch<IResponse<AlarmPolicyDetail>>('/alarm/policies', {
    method: 'post',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ④ PUT /api/alarm/policies/{id} 更新策略（**全量更新语义**）
//
// 未传的字段一律回落到默认值（等价于删除后重建子资源）：
// 省略 `conditions` → 视为清空 → 因 1-4 条约束直接 422（刻意设计，避免误清空）。
// **唯一例外**：`status` 省略时保持原值不变，启停只能走 ⑥。
// ---------------------------------------------------------------------------

export async function updateAlarmPolicy(id: number, data: AlarmPolicyCreatePayload) {
  return await apiFetch<IResponse<AlarmPolicyDetail>>(`/alarm/policies/${id}`, {
    method: 'put',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑤ DELETE /api/alarm/policies/{id} 删除策略
//
// 前置校验顺序固定：不存在 → 404；`status === 1`（启用中）→ 409。
// ⚠️ 前端应在 `status===1` 时直接禁用删除按钮，避免必然 409。
// ---------------------------------------------------------------------------

export async function deleteAlarmPolicy(id: number) {
  return await apiFetch<IResponse<boolean>>(`/alarm/policies/${id}`, {
    method: 'delete',
  })
}

// ---------------------------------------------------------------------------
// ⑥ POST /api/alarm/policies/{id}/status 启停策略
//
// **幂等**：重复提交相同 `status` 视为成功（不返回 409）。
// ---------------------------------------------------------------------------

export async function setAlarmPolicyStatus(id: number, data: AlarmPolicyStatusPayload) {
  return await apiFetch<IResponse<AlarmPolicyDetail>>(`/alarm/policies/${id}/status`, {
    method: 'post',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑦ POST /api/alarm/policies/{id}/copy 复制策略
//
// 无请求体（可为空对象）。新名称 `{原名} - 副本`，冲突则 `(2)`、`(3)`……最多 `(99)`；
// 新策略 `status` 强制为 `0`（停用），创建人归当前登录人。
// ---------------------------------------------------------------------------

export async function copyAlarmPolicy(id: number) {
  return await apiFetch<IResponse<AlarmPolicyCopyResult>>(`/alarm/policies/${id}/copy`, {
    method: 'post',
  })
}

// ---------------------------------------------------------------------------
// ⑧ GET /api/alarm/metrics 指标字典
//
// **不分页**，固定 28 条，唯一来源 `metrics.md` §1。指标选择器的数据源就是它，
// 选定后用 `defaultOperator / defaultThreshold / suggestedContinuity / periodOptions` 预填条件表单。
// ---------------------------------------------------------------------------

export async function fetchAlarmMetrics(query: AlarmMetricListQuery = {}) {
  return await apiFetch<IResponse<AlarmMetric[]>>('/alarm/metrics', {
    method: 'get',
    query,
  })
}

// ---------------------------------------------------------------------------
// ⑨ GET /api/alarm/condition-templates 触发条件模板分页
// ---------------------------------------------------------------------------

export async function fetchAlarmConditionTemplateList(query: AlarmConditionTemplateListQuery = {}) {
  return await apiFetch<IResponse<AlarmPage<AlarmConditionTemplate>>>('/alarm/condition-templates', {
    method: 'get',
    query,
  })
}

// ---------------------------------------------------------------------------
// ⑩ POST /api/alarm/condition-templates 创建条件模板
//
// `isPreset` 仅服务端写入，请求体传入无效。
// ---------------------------------------------------------------------------

export async function createAlarmConditionTemplate(data: AlarmConditionTemplatePayload) {
  return await apiFetch<IResponse<AlarmConditionTemplate>>('/alarm/condition-templates', {
    method: 'post',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑪ PUT /api/alarm/condition-templates/{id} 更新条件模板（全量）
//
// `isPreset=1` 的预置模板**允许修改**（仅禁止删除），修改后 `isPreset` 保持 `1`。
// ---------------------------------------------------------------------------

export async function updateAlarmConditionTemplate(id: number, data: AlarmConditionTemplatePayload) {
  return await apiFetch<IResponse<AlarmConditionTemplate>>(`/alarm/condition-templates/${id}`, {
    method: 'put',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑫ DELETE /api/alarm/condition-templates/{id} 删除条件模板
//
// 校验顺序：不存在 → 404；`isPreset=1` → 409 预置模板不可删除；被策略引用 → 409 模板已被引用。
// ---------------------------------------------------------------------------

export async function deleteAlarmConditionTemplate(id: number) {
  return await apiFetch<IResponse<boolean>>(`/alarm/condition-templates/${id}`, {
    method: 'delete',
  })
}
