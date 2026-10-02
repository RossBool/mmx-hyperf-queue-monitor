/**
 * 通知模板 —— 传输层（契约端点 ⑬-⑯）。
 *
 * 唯一事实来源：`/workspace/docs/alarm/contract.md`（v1.0，已冻结）。
 * 签名、路径、method、body **必须与契约 1:1 一致**。
 *
 * 端点速查：
 * | # | method | 路径 | 请求体 | `data` |
 * | --- | --- | --- | --- | --- |
 * | ⑬ | GET | `/alarm/notification-templates` | - | `Page<AlarmNotificationTemplate>` |
 * | ⑭ | POST | `/alarm/notification-templates` | 模板字段 | `AlarmNotificationTemplate` |
 * | ⑮ | PUT | `/alarm/notification-templates/{id}` | 模板字段（全量） | `AlarmNotificationTemplate` |
 * | ⑯ | DELETE | `/alarm/notification-templates/{id}` | - | `true` |
 *
 * 路径写相对 `apiFetch` baseURL（`http://localhost:3000/api`）的部分，故此处是 `/alarm/...`。
 *
 * @see ../../../types/alarm —— 契约类型层
 */

import type {
  AlarmNotificationTemplate,
  AlarmNotificationTemplateListQuery,
  AlarmNotificationTemplatePayload,
  AlarmPage,
} from '@/types/alarm'

import { apiFetch } from '@/lib/api-client'

import type { IResponse } from '../types/response.type'

// ============================================================================
// TODO —— 通知模板任务负责本文件的**全部**实现
//
// 本文件由脚手架任务只落地「签名 + 路径 + method + body」，函数体按契约拼请求。
// 通知模板任务在此基础上补充：
//   - ⑬ 列表的 `keyword` / `channel` / `isPreset` 筛选（契约 ⑬）；
//   - 渠道编辑：1-5 条且 `channel` 不可重复（N2）；
//     `channel=5`（回调）时 `callbackUrl` **必填**（`http(s)://` 开头，<=500）且
//     `receivers` **必须为空**（N3）；`channel≠5` 时 `callbackUrl` **必须为 null**（N4）；
//   - `receivers` 0-100 个（N5）。**预置模板允许为空数组**（出厂占位），
//     是否「配置完成」由 §4.3 N9 在**策略绑定处**统一校验，不要在单条渠道上拦；
//   - ⑯ 删除前先看 `isPreset`：`isPreset=1` 直接禁用删除按钮（必然 409 预置模板不可删除），
//     自定义模板也可能被策略引用（N8）而 409；
//   - ⑮ PUT 是全量更新，必须提交完整 `channels`。
//
// 另：`VITE_USE_MOCK=true` 时本文件所有函数会返回 `src/mocks/` 的契约示例数据。
// TODO(mock)：补齐 ⑭⑮ 的 mock 写入语义。
// ============================================================================

// ---------------------------------------------------------------------------
// ⑬ GET /api/alarm/notification-templates 通知模板分页
//
// ⚠️ 列表接口**返回完整 `channels`**（含接收人），因为通知模板管理页需要编辑接收人。
// 这与**策略详情页**的 `notificationTemplates[].channels`（只是编码数组 `int[]`）不同，
// 不要把两者搞混，否则会把接收人信息泄漏到策略详情页。
// ---------------------------------------------------------------------------

export async function fetchAlarmNotificationTemplateList(query: AlarmNotificationTemplateListQuery = {}) {
  return await apiFetch<IResponse<AlarmPage<AlarmNotificationTemplate>>>('/alarm/notification-templates', {
    method: 'get',
    query,
  })
}

// ---------------------------------------------------------------------------
// ⑭ POST /api/alarm/notification-templates 创建通知模板
//
// `isPreset` 由服务端写入，请求体传入无效。
// ---------------------------------------------------------------------------

export async function createAlarmNotificationTemplate(data: AlarmNotificationTemplatePayload) {
  return await apiFetch<IResponse<AlarmNotificationTemplate>>('/alarm/notification-templates', {
    method: 'post',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑮ PUT /api/alarm/notification-templates/{id} 更新通知模板（全量）
//
// `isPreset=1` 允许修改、禁止删除，修改后 `isPreset` 保持 `1`。
// ---------------------------------------------------------------------------

export async function updateAlarmNotificationTemplate(id: number, data: AlarmNotificationTemplatePayload) {
  return await apiFetch<IResponse<AlarmNotificationTemplate>>(`/alarm/notification-templates/${id}`, {
    method: 'put',
    body: data,
  })
}

// ---------------------------------------------------------------------------
// ⑯ DELETE /api/alarm/notification-templates/{id} 删除通知模板
//
// 校验顺序：不存在 → 404；`isPreset=1` → 409 预置模板不可删除；
// 被任意策略 `notification_template_ids` 引用 → 409 模板已被策略引用，不可删除。
// ---------------------------------------------------------------------------

export async function deleteAlarmNotificationTemplate(id: number) {
  return await apiFetch<IResponse<boolean>>(`/alarm/notification-templates/${id}`, {
    method: 'delete',
  })
}
