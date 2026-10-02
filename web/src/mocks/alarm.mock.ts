/**
 * 告警模块 mock 数据 —— 全部**照抄** `/workspace/docs/alarm/contract.md` 里的示例响应，
 * 目的是让联调任务在前端先看到与后端 1:1 的结构，而不是我自己编的假数据。
 *
 * ⚠️ 指标字典（`GET /api/alarm/metrics`）的 28 条指标**不在这里硬编码**：
 * 契约规定其唯一来源是 `metrics.md` §1，本文件只给一条示例条目用于打通链路。
 */
import type {
  AlarmHistory,
  AlarmNotificationTemplate,
  AlarmOverview,
  AlarmPolicyDetail,
  AlarmPolicyListItem,
} from '@/types/alarm'

/** 策略列表项（contract.md ① 示例）。 */
export const policyListMock: AlarmPolicyListItem[] = [
  {
    id: 1001,
    name: '生产 CVM CPU 监控',
    remark: '核心交易集群',
    monitorType: 1,
    monitorTypeCn: '云产品监控',
    policyType: 2,
    policyTypeCn: '云服务器 CVM',
    status: 1,
    level: 1,
    projectId: 12,
    objectType: 2,
    conditionCount: 2,
    notificationTemplateIds: [3, 5],
    conditionTemplateId: 0,
    creatorName: '张三',
    createdAt: '2026-09-20 10:12:33',
    updatedAt: '2026-09-28 15:02:11',
  },
]

/** 策略详情（contract.md ② 示例）。注意三个 object 字段里只有 `objectIds` 非 null。 */
export const policyDetailMock: AlarmPolicyDetail = {
  ...policyListMock[0],
  objectIds: [8801, 8802],
  objectGroupIds: null,
  objectFilters: null,
  conditionLogic: 2,
  conditions: [
    {
      id: 7001,
      sort: 1,
      metricNamespace: 'CVM',
      metricName: 'CpuUtilizationRate',
      metricNameCn: 'CPU 使用率',
      unit: '%',
      operator: '>',
      threshold: 90,
      period: 5,
      continuity: 3,
      level: 1,
      frequency: 15,
    },
    {
      id: 7002,
      sort: 2,
      metricNamespace: 'CVM',
      metricName: 'MemoryUsageRate',
      metricNameCn: '内存使用率',
      unit: '%',
      operator: '>',
      threshold: 85,
      period: 5,
      continuity: 2,
      level: 2,
      frequency: 30,
    },
  ],
  notificationTemplates: [
    { id: 3, name: '运维值班组', isPreset: 0, channels: [1, 2] },
    { id: 5, name: '系统预置-邮件通知', isPreset: 1, channels: [1] },
  ],
}

/** 通知模板（contract.md ⑬ 形状：列表接口返回**完整 channels**，含接收人）。 */
export const notificationTemplateListMock: AlarmNotificationTemplate[] = [
  {
    id: 3,
    name: '运维值班组',
    remark: '',
    channels: [
      { channel: 1, receivers: ['ops@example.com'], callbackUrl: null, silenceTime: 0 },
      { channel: 2, receivers: ['13800000000'], callbackUrl: null, silenceTime: 0 },
    ],
    isPreset: 0,
    creatorName: '张三',
    createdAt: '2026-09-01 09:00:00',
    updatedAt: '2026-09-20 15:30:00',
  },
  {
    id: 5,
    name: '系统预置-邮件通知',
    remark: '出厂占位，接收人待补充',
    channels: [
      { channel: 1, receivers: [], callbackUrl: null, silenceTime: 0 },
    ],
    isPreset: 1,
    creatorName: 'system',
    createdAt: '2026-09-01 09:00:00',
    updatedAt: '2026-09-01 09:00:00',
  },
]

/** 告警历史（contract.md ⑰ 示例，`status=1` 未处理）。 */
export const historyListMock: AlarmHistory[] = [
  {
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
  },
]

/** 首页统计（contract.md ⑲ 示例）。 */
export const overviewMock: AlarmOverview = {
  todayTotal: 27,
  todayUnhandled: 9,
  policyTotal: 128,
  policyEnabledTotal: 96,
  levelDistribution: [
    { level: 1, levelCn: '紧急', count: 3 },
    { level: 2, levelCn: '严重', count: 8 },
    { level: 3, levelCn: '提示', count: 16 },
  ],
  trend7Days: [
    { date: '2026-09-24', total: 18, unhandled: 4 },
    { date: '2026-09-25', total: 25, unhandled: 7 },
    { date: '2026-09-26', total: 9, unhandled: 2 },
    { date: '2026-09-27', total: 31, unhandled: 12 },
    { date: '2026-09-28', total: 22, unhandled: 5 },
    { date: '2026-09-29', total: 14, unhandled: 3 },
    { date: '2026-09-30', total: 27, unhandled: 9 },
  ],
}
