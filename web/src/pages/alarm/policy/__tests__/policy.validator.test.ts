import type { z } from 'zod'

import { describe, expect, it } from 'vitest'

import {
  ALARM_CONDITION_LOGIC,
  ALARM_FREQUENCY,
  ALARM_LEVEL,
  ALARM_MONITOR_TYPE,
  ALARM_OBJECT_TYPE,
  ALARM_OPERATOR,
  ALARM_PERIOD,
  ALARM_POLICY_STATUS,
  ALARM_POLICY_TYPE,
} from '@/types/alarm'

import type { PolicyConditionFormItem, PolicyFormValues } from '../utils/policy-logic'

import { createEmptyCondition, createEmptyPolicyFormValues } from '../utils/policy-logic'
import {
  policyBasicStepSchema,
  policyConditionStepSchema,
  policyFormSchema,
  policyNotifyStepSchema,
} from '../validators/policy.validator'

/** 造一条合法条件，`n` 决定 sort（P5 要求 1..N 连续）。 */
function validCondition(n: number): PolicyConditionFormItem {
  return {
    _key: `k${n}`,
    sort: n as PolicyConditionFormItem['sort'],
    metricNamespace: 'CVM',
    metricName: 'CpuUtilizationRate',
    metricNameCn: 'CPU 使用率',
    unit: '%',
    operator: ALARM_OPERATOR.GT,
    threshold: 80,
    period: ALARM_PERIOD.MINUTE_5,
    continuity: 3,
    level: ALARM_LEVEL.EMERGENCY,
    frequency: ALARM_FREQUENCY.MIN_15,
  }
}

function baseValues(overrides: Partial<PolicyFormValues> = {}): PolicyFormValues {
  return {
    ...createEmptyPolicyFormValues(),
    name: '生产 CVM CPU 监控',
    remark: '核心交易集群',
    monitorType: ALARM_MONITOR_TYPE.CLOUD_PRODUCT,
    policyType: ALARM_POLICY_TYPE.CVM,
    objectType: ALARM_OBJECT_TYPE.ALL,
    conditionLogic: ALARM_CONDITION_LOGIC.AND,
    conditions: [validCondition(1)],
    notificationTemplateIds: [],
    ...overrides,
  }
}

/** zod safeParse 结果的最小结构（各步 schema 输出不同，用宽松签名统一处理）。 */
interface ParseResultLike {
  success: boolean
  error?: { issues: { path: PropertyKey[], message: string }[] }
}

function messages(result: ParseResultLike): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map(issue => issue.message)
}

function paths(result: ParseResultLike): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map(issue => issue.path.join('.'))
}

// ============================================================================
describe('① 绕过 UI 的击穿用例：直接提交 5 条条件', () => {
  it('policyFormSchema 拒绝 5 条 conditions', () => {
    const result = policyFormSchema.safeParse(baseValues({
      conditions: [1, 2, 3, 4, 5].map(validCondition),
    }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('触发条件最多 4 条')
  })

  it('第 2 步的 schema 同样拦住 5 条', () => {
    const result = policyConditionStepSchema.safeParse(
      baseValues({ conditions: [1, 2, 3, 4, 5].map(validCondition) }),
    )
    expect(result.success).toBe(false)
  })

  it('绕过 UI 提交 0 条条件也被拦（PUT 省略 conditions 等价于清空 → 422）', () => {
    const result = policyFormSchema.safeParse(baseValues({ conditions: [] }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('触发条件至少 1 条')
  })

  it('4 条条件通过（第 2 步边界上界）', () => {
    const result = policyFormSchema.safeParse(baseValues({
      conditions: [1, 2, 3, 4].map(validCondition),
    }))
    expect(result.success).toBe(true)
  })

  it('sort 不是 1..N 连续升序 → 拦截（P5）', () => {
    const conditions = [validCondition(1), validCondition(1)]
    const result = policyConditionStepSchema.safeParse(baseValues({ conditions }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('条件排序必须是 1..N 连续升序且不重复')
  })
})

// ============================================================================
describe('② 条件字段级校验（P6 P7 P8 P9 P10 P11）', () => {
  it('合法条件通过', () => {
    expect(policyConditionStepSchema.safeParse(baseValues()).success).toBe(true)
  })

  it('未选指标 → 拦截（P10 缺一即 422）', () => {
    const result = policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), metricName: '   ' }],
    }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('请选择监控指标')
  })

  it('缺 continuity → 拦截', () => {
    const { continuity: _drop, ...incomplete } = validCondition(1)
    const result = policyConditionStepSchema.safeParse(baseValues({ conditions: [incomplete as never] }))
    expect(result.success).toBe(false)
  })

  it('continuity 0 与 11 非法，1 与 10 合法（P7）', () => {
    for (const continuity of [0, 11]) {
      const result = policyConditionStepSchema.safeParse(baseValues({
        conditions: [{ ...validCondition(1), continuity }],
      }))
      expect(result.success).toBe(false)
      expect(messages(result).some(message => message.includes('持续周期'))).toBe(true)
    }
    for (const continuity of [1, 10]) {
      expect(policyConditionStepSchema.safeParse(baseValues({
        conditions: [{ ...validCondition(1), continuity }],
      })).success).toBe(true)
    }
  })

  it('period 非法值 3 被拦，合法值 1/5/10/30/60 通过（P8）', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), period: 3 as never }],
    })).success).toBe(false)

    for (const period of [1, 5, 10, 30, 60]) {
      expect(policyConditionStepSchema.safeParse(baseValues({
        conditions: [{ ...validCondition(1), period: period as never }],
      })).success).toBe(true)
    }
  })

  it('operator 只接受 6 个符号（P9），本地化中文「大于」被拦', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), operator: '大于' as never }],
    })).success).toBe(false)

    for (const operator of ['>', '>=', '<', '<=', '==', '!=']) {
      expect(policyConditionStepSchema.safeParse(baseValues({
        conditions: [{ ...validCondition(1), operator: operator as never }],
      })).success).toBe(true)
    }
  })

  it('threshold 负数合法（P6）', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), threshold: -40 }],
    })).success).toBe(true)
  })

  it('threshold 4 位小数合法，5 位非法（P6）', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), threshold: 1.2345 }],
    })).success).toBe(true)

    const result = policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), threshold: 1.23456 }],
    }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('阈值最多 4 位小数')
  })

  it('threshold 为 NaN（空白条件的初值）被拦', () => {
    const result = policyConditionStepSchema.safeParse(baseValues({
      conditions: [createEmptyCondition('k1', 1)],
    }))
    expect(result.success).toBe(false)
  })

  it('level / frequency 非法枚举被拦（P11）', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), level: 4 as never }],
    })).success).toBe(false)

    expect(policyConditionStepSchema.safeParse(baseValues({
      conditions: [{ ...validCondition(1), frequency: 7 as never }],
    })).success).toBe(false)
  })
})

// ============================================================================
describe('③ 基本信息（P1 P2 P3）', () => {
  it('合法值通过', () => {
    expect(policyBasicStepSchema.safeParse(baseValues()).success).toBe(true)
  })

  it('名称为空 / 全空白被拦', () => {
    expect(messages(policyBasicStepSchema.safeParse(baseValues({ name: '   ' })))).toContain('策略名称不能为空')
  })

  it('名称 128 合法、129 非法（P1）', () => {
    expect(policyBasicStepSchema.safeParse(baseValues({ name: 'A'.repeat(128) })).success).toBe(true)
    expect(messages(policyBasicStepSchema.safeParse(baseValues({ name: 'A'.repeat(129) }))))
      .toContain('策略名称最长 128 个字符')
  })

  it('备注 501 非法（P2）', () => {
    expect(messages(policyBasicStepSchema.safeParse(baseValues({ remark: 'x'.repeat(501) }))))
      .toContain('备注最长 500 个字符')
  })

  it('未选监控类型 / 策略类型被拦', () => {
    expect(messages(policyBasicStepSchema.safeParse(baseValues({ monitorType: undefined }))))
      .toContain('请选择监控类型')
    expect(messages(policyBasicStepSchema.safeParse(baseValues({ policyType: undefined }))))
      .toContain('请选择策略类型')
  })

  it('monitorType 与 policyType 不匹配被拦（P3）', () => {
    const result = policyBasicStepSchema.safeParse(baseValues({ policyType: ALARM_POLICY_TYPE.GENERIC_WEB }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('策略类型与监控类型不匹配，请重新选择')
  })

  it('monitorType 3/4/5 在 v1.0 没有任何可用策略类型', () => {
    const result = policyBasicStepSchema.safeParse(baseValues({
      monitorType: ALARM_MONITOR_TYPE.RUM,
      policyType: ALARM_POLICY_TYPE.CVM,
    }))
    expect(messages(result)).toContain('该监控类型在 v1.0 暂无可用策略类型')
  })

  it('projectId 负数被拦，0（未分配）合法', () => {
    expect(messages(policyBasicStepSchema.safeParse(baseValues({ projectId: -1 }))))
      .toContain('所属项目 id 不能为负数')
    expect(policyBasicStepSchema.safeParse(baseValues({ projectId: 0 })).success).toBe(true)
  })
})

// ============================================================================
describe('④ 告警对象一一对应（P14）', () => {
  it('全部对象 + 三个字段都为空 → 合法', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({ objectType: ALARM_OBJECT_TYPE.ALL })).success).toBe(true)
  })

  it('全部对象却带了 objectIds → 拦截，且错误落在 objectIds 路径上', () => {
    const result = policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.ALL,
      objectIds: [8801],
    }))
    expect(result.success).toBe(false)
    expect(paths(result)).toContain('objectIds')
  })

  it('全部对象却带了 objectGroupIds / objectFilters → 拦截', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.ALL,
      objectGroupIds: [1],
    })).success).toBe(false)

    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.ALL,
      objectFilters: [{ key: 'region', operator: ALARM_OPERATOR.EQ, values: ['gz'], matchType: 'include' }],
    })).success).toBe(false)
  })

  it('指定实例但没选实例 → 拦截', () => {
    const result = policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.INSTANCE,
      objectIds: [],
    }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('请至少选择 1 项告警对象，或把告警对象类型改为「全部对象」')
  })

  it('指定实例 1000 个合法、1001 个非法', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.INSTANCE,
      objectIds: Array.from({ length: 1000 }, (_, i) => i + 1),
    })).success).toBe(true)

    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.INSTANCE,
      objectIds: Array.from({ length: 1001 }, (_, i) => i + 1),
    })).success).toBe(false)
  })

  it('实例分组 101 个非法', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.GROUP,
      objectGroupIds: Array.from({ length: 101 }, (_, i) => i + 1),
    })).success).toBe(false)
  })

  it('多维筛选 11 条非法；单条结构非法（空维度名 / 空候选值）也被拦', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.FILTER,
      objectFilters: Array.from({ length: 11 }, () => ({ key: 'region', operator: ALARM_OPERATOR.EQ, values: ['gz'], matchType: 'include' as const })),
    })).success).toBe(false)

    const result = policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.FILTER,
      objectFilters: [{ key: '  ', operator: ALARM_OPERATOR.EQ, values: ['gz'] }],
    }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('维度名不能为空')

    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.FILTER,
      objectFilters: [{ key: 'region', operator: ALARM_OPERATOR.EQ, values: [] }],
    })).success).toBe(false)
  })

  it('多维筛选 matchType 非法值被拦', () => {
    expect(policyConditionStepSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.FILTER,
      objectFilters: [{ key: 'region', operator: ALARM_OPERATOR.EQ, values: ['gz'], matchType: 'cover' as never }],
    })).success).toBe(false)
  })
})

// ============================================================================
describe('⑤ 通知模板与回调 URL（P12 P13 N3）', () => {
  it('0 个 / 3 个模板都合法', () => {
    expect(policyNotifyStepSchema.safeParse({ notificationTemplateIds: [], callbackUrl: '' }).success).toBe(true)
    expect(policyNotifyStepSchema.safeParse({ notificationTemplateIds: [1, 2, 3], callbackUrl: '' }).success).toBe(true)
  })

  it('第 4 个通知模板被拦（P12）', () => {
    const result = policyNotifyStepSchema.safeParse({ notificationTemplateIds: [1, 2, 3, 4], callbackUrl: '' })
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('通知模板最多绑定 3 个')
  })

  it('重复绑定被拦（P13）', () => {
    const result = policyNotifyStepSchema.safeParse({ notificationTemplateIds: [1, 1], callbackUrl: '' })
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('通知模板不可重复绑定')
  })

  it('回调 URL：空串放行、http(s) 放行、缺协议拦截、超长拦截', () => {
    expect(policyNotifyStepSchema.safeParse({ notificationTemplateIds: [], callbackUrl: '' }).success).toBe(true)
    expect(policyNotifyStepSchema.safeParse({ notificationTemplateIds: [], callbackUrl: 'https://a.com/cb' }).success).toBe(true)

    const bad = policyNotifyStepSchema.safeParse({ notificationTemplateIds: [], callbackUrl: 'a.com/cb' })
    expect(bad.success).toBe(false)
    expect(messages(bad)).toContain('回调地址必须以 http:// 或 https:// 开头')

    const tooLong = policyNotifyStepSchema.safeParse({
      notificationTemplateIds: [],
      callbackUrl: `https://a.com/${'x'.repeat(500)}`,
    })
    expect(tooLong.success).toBe(false)
  })
})

// ============================================================================
describe('⑥ 全量 schema 的多步合并闸门', () => {
  it('三步都合法的完整表单通过', () => {
    expect(policyFormSchema.safeParse(baseValues({ status: ALARM_POLICY_STATUS.ENABLED })).success).toBe(true)
  })

  it('绕过 UI 提交 5 条条件 → 拒绝（击穿用例）', () => {
    const result = policyFormSchema.safeParse(baseValues({
      conditions: [1, 2, 3, 4, 5].map(validCondition),
      status: ALARM_POLICY_STATUS.ENABLED,
    }))
    expect(result.success).toBe(false)
    expect(messages(result)).toContain('触发条件最多 4 条')
  })

  it('绕过 UI 提交「全部对象 + 指定实例」→ 拒绝', () => {
    const result = policyFormSchema.safeParse(baseValues({
      objectType: ALARM_OBJECT_TYPE.ALL,
      objectIds: [1, 2],
      status: ALARM_POLICY_STATUS.ENABLED,
    }))
    expect(result.success).toBe(false)
  })

  it('第 1 步的 monitorType/policyType 联动在合并后依然生效', () => {
    const result = policyFormSchema.safeParse(baseValues({
      policyType: ALARM_POLICY_TYPE.MYSQL,
      monitorType: ALARM_MONITOR_TYPE.APM,
      status: ALARM_POLICY_STATUS.ENABLED,
    }))
    expect(result.success).toBe(false)
  })

  it('status 非法值被拦', () => {
    expect(policyFormSchema.safeParse(baseValues({ status: 5 as never })).success).toBe(false)
  })

  it('全空表单（新建初始值）必然不通过，错误覆盖 name/monitorType/policyType/conditions', () => {
    const result = policyFormSchema.safeParse(createEmptyPolicyFormValues())
    expect(result.success).toBe(false)
    const found = paths(result)
    expect(found).toContain('name')
    expect(found).toContain('monitorType')
    expect(found).toContain('policyType')
    expect(found).toContain('conditions')
  })

  it('zod schema 类型可导出，供表单复用', () => {
    const schema: z.ZodType = policyFormSchema
    expect(schema).toBeDefined()
  })
})
