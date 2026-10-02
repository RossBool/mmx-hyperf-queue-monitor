/**
 * 告警历史与统计 —— 传输层（契约端点 ⑰-⑲）。
 *
 * 唯一事实来源：`/workspace/docs/alarm/contract.md`（v1.0，已冻结）。
 * 签名、路径、method、body **必须与契约 1:1 一致**。
 *
 * 端点速查：
 * | # | method | 路径 | 请求体 | `data` |
 * | --- | --- | --- | --- | --- |
 * | ⑰ | GET | `/alarm/histories` | - | `Page<AlarmHistory>` |
 * | ⑱ | POST | `/alarm/histories/{id}/handle` | `{ action, remark }` | `AlarmHistory` |
 * | ⑲ | GET | `/alarm/overview` | - | `AlarmOverview` |
 *
 * 路径写相对 `apiFetch` baseURL（`http://localhost:3000/api`）的部分，故此处是 `/alarm/...`。
 *
 * @see ../../../types/alarm —— 契约类型层
 */

import type {
  AlarmHistory,
  AlarmHistoryHandlePayload,
  AlarmHistoryListQuery,
  AlarmOverview,
  AlarmPage,
} from '@/types/alarm'

import { apiFetch } from '@/lib/api-client'

import type { IResponse } from '../types/response.type'

// ============================================================================
// TODO —— 告警历史任务负责本文件的**全部**实现
//
// 本文件由脚手架任务只落地「签名 + 路径 + method + body」，函数体按契约拼请求。
// 告警历史任务在此基础上补充：
//   - ⑰ 列表筛选：`policyId` / `level` / `status` / `keyword` / `startTime` / `endTime`；
//     约束 `startTime <= endTime`，否则 422（H4），前端应先本地校验；
//     排序固定 `triggered_at DESC, id DESC`，**当前版本不开放排序参数**；
//   - ⑱ 处理动作：`handle` / `ignore` / `recover`（H1），`remark` <=500（H2），
//     且**仅 `status=1`（未处理）可处理**，否则 409（H3）→ 建议对非未处理行直接禁用操作按钮；
//   - ⚠️ 历史记录**不提供删除端点**，只增不改状态（H5）—— 不要加删除按钮；
//   - ⑲ 首页统计：`levelDistribution` 固定 3 项、`trend7Days` 固定 7 项，
//     无数据后端已补 0，前端只需按顺序渲染（`level` / `date` 升序）。
//
// 另：`VITE_USE_MOCK=true` 时本文件所有函数会返回 `src/mocks/` 的契约示例数据。
// TODO(mock)：补齐 ⑱ 的 mock 处理语义（已实现基础版，见 src/mocks/index.ts）。
// ============================================================================

// ---------------------------------------------------------------------------
// ⑰ GET /api/alarm/histories 告警历史分页
//
// ⚠️ `actualValue` 可能是 `null`（恢复类事件无实测值），渲染前要判空。
// `recoveredAt` / `handledAt` / `handleAction` 未处理时为 `null`，
// 但 `handlerName` / `handleRemark` 未处理时是 `""`（不是 null）—— 这两个字段行为不同，别搞混。
// ---------------------------------------------------------------------------

export async function fetchAlarmHistoryList(query: AlarmHistoryListQuery = {}) {
  return await apiFetch<IResponse<AlarmPage<AlarmHistory>>>('/alarm/histories', {
    method: 'get',
    query,
  })
}

// ---------------------------------------------------------------------------
// ⑱ POST /api/alarm/histories/{id}/handle 处理告警
//
// 服务端行为：不存在 → 404；`status !== 1` → 409 `HISTORY_ALREADY_HANDLED`；
// `action = recover` 时额外置 `recoveredAt` 并按秒计算 `duration`。
// 响应 `data` 是**更新后的完整** `AlarmHistory`，可直接替换列表行。
// ---------------------------------------------------------------------------

export async function handleAlarmHistory(id: number, data: AlarmHistoryHandlePayload) {
  return await apiFetch<IResponse<AlarmHistory>>(`/alarm/histories/${id}/handle`, {
    method: 'post',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑲ GET /api/alarm/overview 首页统计
//
// 无查询参数，统计范围固定为「当前用户有权限的全部数据」。
// ---------------------------------------------------------------------------

export async function fetchAlarmOverview() {
  return await apiFetch<IResponse<AlarmOverview>>('/alarm/overview', {
    method: 'get',
  })
}
