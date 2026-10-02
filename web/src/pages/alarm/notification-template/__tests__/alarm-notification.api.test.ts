/**
 * 通知模板 —— 传输层单测（契约 ⑬-⑯）。
 *
 * 风格对齐 `src/services/api/__tests__/example-tasks.api.test.ts`：
 * 断言 **URL / method / body 形状**三点，不关心返回值怎么用。
 * 文件放在页面目录下，是因为本任务的写入边界不含 `src/services/api/__tests__/`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AlarmNotificationTemplate, AlarmNotificationTemplatePayload } from '@/types/alarm'

import {
  createAlarmNotificationTemplate,
  deleteAlarmNotificationTemplate,
  fetchAlarmNotificationTemplateList,
  updateAlarmNotificationTemplate,
} from '@/services/api/alarm-notification.api'
import {
  ALARM_NOTIFY_CHANNEL,

} from '@/types/alarm'

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-client', () => ({ apiFetch }))

const { EMAIL, CALLBACK } = ALARM_NOTIFY_CHANNEL

const template: AlarmNotificationTemplate = {
  id: 3,
  name: '运维值班组',
  remark: '',
  channels: [
    { channel: EMAIL, receivers: ['ops@example.com'], callbackUrl: null, silenceTime: 0 },
    { channel: CALLBACK, receivers: [], callbackUrl: 'https://example.com/hook', silenceTime: 0 },
  ],
  isPreset: 0,
  creatorName: '张三',
  createdAt: '2026-09-01 09:00:00',
  updatedAt: '2026-09-20 15:30:00',
}

const response = { data: template, extra: {}, code: 0, message: 'success', success: true }

describe('alarm-notification transport (⑬-⑯)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(response)
  })

  it('⑬ 以 GET 请求分页列表，query 原样透传', async () => {
    const query = { page: 2, pageSize: 50, keyword: '值班', channel: EMAIL }

    await expect(fetchAlarmNotificationTemplateList(query)).resolves.toBe(response)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/notification-templates', { method: 'get', query })
  })

  it('⑬ 不传 query 时用空对象（契约所有筛选参数都是可选）', async () => {
    await fetchAlarmNotificationTemplateList()
    expect(apiFetch).toHaveBeenCalledWith('/alarm/notification-templates', { method: 'get', query: {} })
  })

  it('⑭ 以 POST 创建，body 就是完整模板字段（含 channels 明细）', async () => {
    const payload: AlarmNotificationTemplatePayload = {
      name: '运维值班组',
      remark: '核心交易',
      channels: [{ channel: EMAIL, receivers: ['ops@example.com'], callbackUrl: null, silenceTime: 0 }],
    }

    await expect(createAlarmNotificationTemplate(payload)).resolves.toBe(response)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/notification-templates', {
      method: 'post',
      body: payload,
    })
  })

  it('⑮ 以 PUT 更新，路径带 id，body 是全量（契约：PUT 为全量更新语义）', async () => {
    const payload: AlarmNotificationTemplatePayload = { name: '改名后', remark: '', channels: template.channels }

    await updateAlarmNotificationTemplate(3, payload)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/notification-templates/3', {
      method: 'put',
      body: payload,
    })
  })

  it('⑯ 以 DELETE 删除，路径带 id，无 body', async () => {
    await deleteAlarmNotificationTemplate(3)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/notification-templates/3', { method: 'delete' })
  })

  it('⑯ 删除预置模板同样只发 DELETE（前端负责禁用按钮，后端负责 409）', async () => {
    await deleteAlarmNotificationTemplate(5)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/notification-templates/5', { method: 'delete' })
  })
})
