import { describe, expect, it } from 'vitest'

import type {
  AlarmNotificationTemplatePayload,
  AlarmPolicyCreatePayload,
  NotificationChannelPayload,
} from '../alarm'

/**
 * 契约符合性探针：正向用例的赋值**原样抄自 contract.md 的官方示例**。
 * 目的不是测运行时行为，而是让「照抄文档示例能过类型检查」成为一条可回归的断言。
 */
describe('契约示例的请求体必须能直接通过类型检查', () => {
  it('⑭ 通知模板：channels 里不传 callbackUrl / silenceTime（契约 §2.5 标注为非必填）', () => {
    const payload: AlarmNotificationTemplatePayload = {
      name: '运维值班组',
      channels: [
        { channel: 1, receivers: ['ops@example.com'] },
        { channel: 5, receivers: [], callbackUrl: 'https://hooks.example.com/alarm' },
      ],
    }
    expect(payload.channels).toHaveLength(2)
  })

  it('callbackUrl / silenceTime 传了也合法（非必填 ≠ 禁止传）', () => {
    const ch: NotificationChannelPayload = {
      channel: 1,
      receivers: ['a@example.com'],
      callbackUrl: null,
      silenceTime: 30,
    }
    expect(ch.silenceTime).toBe(30)
  })

  it('③ 告警策略：条件体不传 id / metricNameCn / unit（服务端回填字段）', () => {
    const payload: AlarmPolicyCreatePayload = {
      name: 'CPU 持续过高',
      monitorType: 1,
      policyType: 1,
      objectType: 1, // 契约 ③ 必填；=1 全部实例 → 三个 object 字段须为 null（§0.6 R-JSON-1）
      conditions: [
        {
          sort: 1,
          metricNamespace: 'CVM',
          metricName: 'CVM.CpuUtilizationRate',
          operator: '>',
          threshold: 80,
          period: 5,
          continuity: 3,
          level: 2,
          frequency: 30,
        },
      ],
      notificationTemplateIds: [1, 2],
    }
    expect(payload.conditions?.[0].operator).toBe('>')
  })
})
