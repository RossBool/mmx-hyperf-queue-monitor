import { describe, expect, it } from 'vitest'

import type { AlarmNotificationTemplate, AlarmPolicyDetail } from '@/types/alarm'

import {
  ALARM_NOTIFY_CHANNEL,
  ALARM_OBJECT_TYPE,
  ALARM_OPERATOR,
  ALARM_PRESET_FLAG,
} from '@/types/alarm'

import { createEmptyCondition, createEmptyPolicyFormValues } from '../utils/policy-logic'
import {
  describeMetric,
  describeNotifyChannels,
  describeObjectFilter,
  detailToFormValues,
  formatProjectLabel,
  objectRequiredFieldLabel,
  previewRequestBody,
  resolvePolicyLevel,
  toPolicySectionModel,
  toPolicySectionModelFromForm,
} from '../utils/policy-view'

/** 契约 ② 的示例响应（结构 1:1 照抄）。 */
const detail: AlarmPolicyDetail = {
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
  objectType: ALARM_OBJECT_TYPE.INSTANCE,
  objectIds: [8801, 8802],
  objectGroupIds: null,
  objectFilters: null,
  conditionLogic: 2,
  conditionTemplateId: 0,
  conditions: [
    {
      id: 7001,
      sort: 1,
      metricNamespace: 'CVM',
      metricName: 'CpuUtilizationRate',
      metricNameCn: 'CPU 使用率',
      unit: '%',
      operator: ALARM_OPERATOR.GT,
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
      operator: ALARM_OPERATOR.GT,
      threshold: 85,
      period: 5,
      continuity: 2,
      level: 2,
      frequency: 30,
    },
  ],
  notificationTemplateIds: [3, 5],
  notificationTemplates: [
    { id: 3, name: '运维值班组', isPreset: ALARM_PRESET_FLAG.CUSTOM, channels: [1, 2] },
    { id: 5, name: '系统预置-邮件通知', isPreset: ALARM_PRESET_FLAG.PRESET, channels: [1] },
  ],
  conditionCount: 2,
  creatorName: '张三',
  createdAt: '2026-09-20 10:12:33',
  updatedAt: '2026-09-28 15:02:11',
}

const templates: AlarmNotificationTemplate[] = [
  {
    id: 3,
    name: '运维值班组',
    remark: '',
    isPreset: ALARM_PRESET_FLAG.CUSTOM,
    channels: [{ channel: ALARM_NOTIFY_CHANNEL.EMAIL, receivers: ['a@b.com'], callbackUrl: null, silenceTime: 0 }],
    creatorName: '张三',
    createdAt: '2026-09-20 10:12:33',
    updatedAt: '2026-09-20 10:12:33',
  },
  {
    id: 5,
    name: '系统预置-邮件通知',
    remark: '',
    isPreset: ALARM_PRESET_FLAG.PRESET,
    // N9：非回调渠道但 receivers 为空 → 未配置完成
    channels: [{ channel: ALARM_NOTIFY_CHANNEL.EMAIL, receivers: [], callbackUrl: null, silenceTime: 0 }],
    creatorName: '系统',
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
  },
]

describe('详情 → 展示模型', () => {
  it('基本信息中文名优先用后端回填值', () => {
    const model = toPolicySectionModel(detail)
    expect(model.monitorTypeLabel).toBe('云产品监控')
    expect(model.policyTypeLabel).toBe('云服务器 CVM')
    expect(model.statusLabel).toBe('启用')
    expect(model.levelLabel).toBe('紧急')
    expect(model.projectLabel).toBe('#12')
  })

  it('§0.6 R-JSON-1：objectGroupIds / objectFilters 是 null 时归一化成空数组再渲染', () => {
    const model = toPolicySectionModel(detail)
    expect(model.objectGroupIds).toEqual([])
    expect(model.objectFilters).toEqual([])
    expect(model.objectIds).toEqual([8801, 8802])
    expect(model.objectSummary).toBe('指定实例 · 2 个')
  })

  it('§2.3：notificationTemplates[].channels 是编码数组，转成中文文案', () => {
    const model = toPolicySectionModel(detail)
    expect(model.notificationTemplates[0].channelsLabel).toBe('邮件、短信')
    expect(model.notificationTemplates[1].channelsLabel).toBe('邮件')
  })

  it('通知模板 id 顺序与响应一致（R-JSON-2：永远是数组）', () => {
    const model = toPolicySectionModel(detail)
    expect(model.notificationTemplateIds).toEqual([3, 5])
    expect(model.notificationTemplates.map(t => t.id)).toEqual([3, 5])
  })

  it('projectId=0 显示未分配', () => {
    expect(formatProjectLabel(0)).toBe('未分配')
    expect(toPolicySectionModel({ ...detail, projectId: 0 }).projectLabel).toBe('未分配')
  })
})

describe('表单 → 展示模型（确认页）', () => {
  function formValues() {
    return {
      ...createEmptyPolicyFormValues(),
      name: '生产 CVM CPU 监控',
      monitorType: 1 as const,
      policyType: 2 as const,
      conditions: [
        { ...createEmptyCondition('k1', 1), metricNamespace: 'CVM', metricName: 'CpuUtilizationRate', metricNameCn: 'CPU 使用率', unit: '%', threshold: 90, level: 1 as const },
        { ...createEmptyCondition('k2', 2), metricNamespace: 'CVM', metricName: 'MemoryUsageRate', metricNameCn: '内存使用率', unit: '%', threshold: 85, level: 2 as const },
      ],
      notificationTemplateIds: [3, 5],
    }
  }

  it('确认页与详情页的分区字段一致（共用同一份渲染组件的输入形状）', () => {
    const fromDetail = toPolicySectionModel(detail)
    const fromForm = toPolicySectionModelFromForm(formValues(), { mode: 'create', notificationTemplates: templates })
    expect(Object.keys(fromForm).sort()).toEqual([...Object.keys(fromDetail).sort(), 'notifyErrors'].sort())
  })

  it('p17：确认页的策略等级取所有条件里最严重的', () => {
    const model = toPolicySectionModelFromForm(formValues(), { mode: 'create' })
    expect(model.level).toBe(1)
    expect(model.levelLabel).toBe('紧急')
  })

  it('把通知模板 id 还原成名称，并标出 N9 未配置完成的模板', () => {
    const model = toPolicySectionModelFromForm(formValues(), { mode: 'create', notificationTemplates: templates })
    expect(model.notificationTemplates.map(t => t.name)).toEqual(['运维值班组', '系统预置-邮件通知'])
    expect(model.notificationTemplates.map(t => t.configured)).toEqual([true, false])
  })

  it('运行时通知错误原样带到确认页', () => {
    const model = toPolicySectionModelFromForm(formValues(), {
      mode: 'create',
      notificationTemplates: templates,
      notifyErrors: ['通知模板最多绑定 3 个，当前 4 个'],
    })
    expect(model.notifyErrors).toEqual(['通知模板最多绑定 3 个，当前 4 个'])
  })

  it('回调地址只在表单来源里出现（详情接口不返回）', () => {
    const fromDetail = toPolicySectionModel(detail)
    const fromForm = toPolicySectionModelFromForm(
      { ...formValues(), callbackUrl: 'https://ops.example.com/cb' },
      { mode: 'create' },
    )
    expect(fromDetail.callbackUrl).toBe('')
    expect(fromDetail.callbackUrlFromFormOnly).toBe(true)
    expect(fromForm.callbackUrl).toBe('https://ops.example.com/cb')
  })

  it('使用模板时显示模板来源名称', () => {
    const model = toPolicySectionModelFromForm(
      { ...formValues(), conditionTemplateId: 6 },
      {
        mode: 'create',
        conditionTemplates: [{
          id: 6,
          name: '预置-CVM CPU 高负载',
          remark: '',
          policyType: 2,
          conditions: [],
          isPreset: ALARM_PRESET_FLAG.PRESET,
          creatorName: '系统',
          createdAt: '2026-01-01 00:00:00',
          updatedAt: '2026-01-01 00:00:00',
        }],
      },
    )
    expect(model.conditionTemplateName).toBe('预置-CVM CPU 高负载（系统预置）')
  })
})

describe('详情 → 表单回填（编辑态）', () => {
  it('所有字段都带回，满足 PUT 全量更新语义（P18）', () => {
    const values = detailToFormValues(detail)
    expect(values.name).toBe('生产 CVM CPU 监控')
    expect(values.remark).toBe('核心交易集群')
    expect(values.monitorType).toBe(1)
    expect(values.policyType).toBe(2)
    expect(values.projectId).toBe(12)
    expect(values.objectType).toBe(ALARM_OBJECT_TYPE.INSTANCE)
    expect(values.objectIds).toEqual([8801, 8802])
    expect(values.objectGroupIds).toEqual([])
    expect(values.objectFilters).toEqual([])
    expect(values.conditionLogic).toBe(2)
    expect(values.conditions).toHaveLength(2)
    expect(values.notificationTemplateIds).toEqual([3, 5])
    expect(values.conditionTemplateId).toBe(0)
    expect(values.status).toBe(1)
  })

  it('复制策略时可覆盖名称为「原名 - 副本」', () => {
    expect(detailToFormValues(detail, '生产 CVM CPU 监控 - 副本').name).toBe('生产 CVM CPU 监控 - 副本')
  })

  it('回填的条件行不带响应 id（避免 PUT 提交响应专用字段）', () => {
    const values = detailToFormValues(detail)
    expect(values.conditions[0]).not.toHaveProperty('id')
    expect(values.conditions[0]._key).toBe('c7001')
  })

  it('空表单的初始值：对象类型默认「全部对象」、状态默认停用', () => {
    const values = createEmptyPolicyFormValues()
    expect(values.objectType).toBe(ALARM_OBJECT_TYPE.ALL)
    expect(values.status).toBe(0)
    expect(values.conditions).toEqual([])
  })
})

describe('展示辅助函数', () => {
  it('渠道编码 → 中文', () => {
    expect(describeNotifyChannels([1, 2])).toBe('邮件、短信')
    expect(describeNotifyChannels([5])).toBe('回调')
    expect(describeNotifyChannels([])).toBe('—')
    expect(describeNotifyChannels(null)).toBe('—')
  })

  it('未知渠道编码不吞掉，降级成「渠道 x」', () => {
    expect(describeNotifyChannels([9 as never])).toBe('渠道 9')
  })

  it('p17：无条件时策略等级为 undefined', () => {
    expect(resolvePolicyLevel([])).toBeUndefined()
    expect(resolvePolicyLevel([{ level: 3 as const }, { level: 1 as const }])).toBe(1)
  })

  it('多维筛选文案', () => {
    expect(describeObjectFilter({ key: 'region', operator: '==', values: ['gz', 'sh'], matchType: 'include' }))
      .toBe('region 包含 gz、sh')
    expect(describeObjectFilter({ key: 'tag:service', operator: '!=', values: ['api'] }))
      .toBe('tag:service 包含 api')
  })

  it('指标下拉文案带单位与命名空间', () => {
    expect(describeMetric({
      namespace: 'CVM',
      metricName: 'CpuUtilizationRate',
      metricNameCn: 'CPU 使用率',
      unit: '%',
      policyType: [2],
      periodOptions: [1, 5, 10, 30, 60],
      defaultOperator: '>',
      defaultThreshold: 80,
      suggestedContinuity: 3,
      description: '',
    })).toBe('CPU 使用率（%） · CVM.CpuUtilizationRate')
  })

  it('告警对象类型对应的必填字段说明', () => {
    expect(objectRequiredFieldLabel(ALARM_OBJECT_TYPE.ALL)).toBe('无需选择')
    expect(objectRequiredFieldLabel(ALARM_OBJECT_TYPE.INSTANCE)).toBe('实例 id')
    expect(objectRequiredFieldLabel(ALARM_OBJECT_TYPE.GROUP)).toBe('实例分组 id')
    expect(objectRequiredFieldLabel(ALARM_OBJECT_TYPE.FILTER)).toBe('筛选维度')
  })
})

describe('请求体预览（确认页可见化 P18 全量语义）', () => {
  it('create 模式带 status，update 模式不带', () => {
    const values = detailToFormValues(detail)
    expect(previewRequestBody(values, 'create').status).toBe(1)
    expect('status' in previewRequestBody(values, 'update')).toBe(false)
  })

  it('update 模式仍然带全部 conditions（P18）', () => {
    const payload = previewRequestBody(detailToFormValues(detail), 'update')
    expect(payload.conditions).toHaveLength(2)
    expect(payload.conditions.map(c => c.sort)).toEqual([1, 2])
  })
})
