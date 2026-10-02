/**
 * 告警历史 —— 传输层单测（契约 ⑰-⑲）。
 *
 * 风格对齐 `src/services/api/__tests__/example-tasks.api.test.ts`：
 * 断言 **URL / method / body 形状**。文件放在页面目录下，
 * 是因为本任务的写入边界不含 `src/services/api/__tests__/`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AlarmHistory, AlarmHistoryHandlePayload, AlarmHistoryListQuery } from '@/types/alarm'

import {
  fetchAlarmHistoryList,
  fetchAlarmOverview,
  handleAlarmHistory,
} from '@/services/api/alarm-history.api'
import { ALARM_HANDLE_ACTION, ALARM_HISTORY_STATUS, ALARM_LEVEL } from '@/types/alarm'

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api-client', () => ({ apiFetch }))

const history: AlarmHistory = {
  id: 90001,
  policyId: 1001,
  policyName: '生产 CVM CPU 监控',
  level: 1,
  status: 1,
  conditionId: 7001,
  metricNamespace: 'CVM',
  metricName: 'CpuUtilizationRate',
  metricNameCn: 'CPU 使用率',
  unit: '%',
  operator: '>',
  threshold: 90,
  actualValue: 96.4,
  period: 5,
  continuity: 3,
  objectType: 2,
  objectId: 8801,
  objectName: 'prod-web-01',
  content: 'CVM prod-web-01 CPU 使用率 > 90%，实际 96.4%',
  triggeredAt: '2026-09-30 03:15:00',
  duration: 0,
  recoveredAt: null,
  handledAt: null,
  handleAction: null,
  handlerName: '',
  handleRemark: '',
  notifyCount: 3,
  createdAt: '2026-09-30 03:15:01',
}

const response = { data: history, extra: {}, code: 0, message: 'success', success: true }

describe('alarm-history transport (⑰-⑲)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(response)
  })

  it('⑰ 以 GET 请求分页列表，全量筛选条件原样透传', async () => {
    // `satisfies` 而不是类型标注：`level`/`status` 会被窄化成契约枚举字面量，
    // 断言里也能看到断言对象**确实**逐字段对得上 `AlarmHistoryListQuery`。
    const query = {
      page: 2,
      pageSize: 20,
      policyId: 1001,
      level: ALARM_LEVEL.EMERGENCY,
      status: ALARM_HISTORY_STATUS.UNHANDLED,
      keyword: 'CPU',
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-30 23:59:59',
    } satisfies AlarmHistoryListQuery

    await expect(fetchAlarmHistoryList(query)).resolves.toBe(response)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/histories', { method: 'get', query })
  })

  it('⑰ 不传 query 时用空对象', async () => {
    await fetchAlarmHistoryList()
    expect(apiFetch).toHaveBeenCalledWith('/alarm/histories', { method: 'get', query: {} })
  })

  it('⑰ 只带时间范围时（不传其他筛选）也合法', async () => {
    const query = { page: 1, pageSize: 20, startTime: '2026-09-01 00:00:00' }
    await fetchAlarmHistoryList(query)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/histories', { method: 'get', query })
  })

  it.each([
    ['handle', '已扩容并重启服务'],
    ['ignore', ''],
    ['recover', '自动恢复'],
  ])('⑱ 以 POST 处理，action=%s 原样提交（不本地化）', async (action, remark) => {
    const payload: AlarmHistoryHandlePayload = {
      action: action as AlarmHistoryHandlePayload['action'],
      remark,
    }

    await expect(handleAlarmHistory(90001, payload)).resolves.toBe(response)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/histories/90001/handle', {
      method: 'post',
      body: payload,
    })
  })

  it('⑱ 三个动作的契约字面量精确匹配', async () => {
    await handleAlarmHistory(1, { action: ALARM_HANDLE_ACTION.HANDLE, remark: 'r' })
    await handleAlarmHistory(1, { action: ALARM_HANDLE_ACTION.IGNORE, remark: 'r' })
    await handleAlarmHistory(1, { action: ALARM_HANDLE_ACTION.RECOVER, remark: 'r' })

    const actions = apiFetch.mock.calls.map(call => call[1].body.action)
    expect(actions).toEqual(['handle', 'ignore', 'recover'])
  })

  it('⑱ remark 省略时 body 只有 action（契约：remark 可选，默认 ""）', async () => {
    await handleAlarmHistory(90001, { action: ALARM_HANDLE_ACTION.IGNORE })
    expect(apiFetch).toHaveBeenCalledWith('/alarm/histories/90001/handle', {
      method: 'post',
      body: { action: 'ignore' },
    })
  })

  it('⑲ 以 GET 请求统计，路径不带 query', async () => {
    await expect(fetchAlarmOverview()).resolves.toBe(response)
    expect(apiFetch).toHaveBeenCalledWith('/alarm/overview', { method: 'get' })
  })
})
