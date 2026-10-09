/**
 * v1.1 前端逻辑：相对判据（E 类）+ 采集静默（F 类）。
 *
 * ## 为什么这些必须测
 *
 * v1.1 引入的两类判据都有一条「**配错了不会报错，只会静默不生效**」的路径：
 *
 * - 绝对模式但表单里还留着 baselineType → 后端 422，用户看到的是
 *   一个和界面上没有任何可见字段对应的报错；
 * - 同比（day/week）但 baselineCount 没清掉 → 同样 422，而那个输入框
 *   在界面上是隐藏的，用户无从修改。
 *
 * 这类问题不会在「能跑就行」的验收里暴露，只会在真实使用中变成工单。
 */
import { describe, expect, it } from 'vitest'

import type { AlarmPolicyCondition } from '@/types/alarm'

import { ALARM_POLICY_TYPE } from '@/types/alarm'

import {
  buildPolicyPayload,
  createEmptyCondition,
  createEmptyPolicyFormValues,
  describeCondition,
  describeConditionCriteria,
  toConditionFormItem,
  toConditionPayload,
} from '../utils/policy-logic'

const base = {
  sort: 1,
  metricNamespace: 'CVM',
  metricName: 'CpuUtilizationRate',
  metricNameCn: 'CPU 使用率',
  unit: '%',
  operator: '>',
  threshold: 80,
  period: 5,
  continuity: 3,
  level: 2,
  frequency: 15,
} satisfies AlarmPolicyCondition

describe('v1.1 相对判据', () => {
  it('新建条件缺省为 absolute，且两个 baseline 字段是 undefined', () => {
    const c = createEmptyCondition('k1', 1)
    expect(c.compareMode).toBe('absolute')
    // ⚠️ 必须是 undefined 而不是 0 / '' / null：
    //    提交时靠 `...(compareMode === 'relative' ? ... : {})` 展开，
    //    填了任何值都会被带上请求体，而契约要求 absolute 时必须缺省。
    expect(c.baselineType).toBeUndefined()
    expect(c.baselineCount).toBeUndefined()
  })

  it('相对 + 环比：请求体带齐 3 个字段', () => {
    const c = { ...createEmptyCondition('k1', 1), compareMode: 'relative' as const, baselineType: 'period' as const, baselineCount: 3 }
    const p = toConditionPayload(c, 1)
    expect(p.compareMode).toBe('relative')
    expect(p.baselineType).toBe('period')
    expect(p.baselineCount).toBe(3)
  })

  it('相对 + 同比昨日：请求体**不带** baselineCount', () => {
    // 契约 §2.1 规则 2：day/week 时 baselineCount 必须为 null。
    // 带上就会被 422 拒 —— 而界面上的那个输入框是隐藏的，用户改不了。
    const c = { ...createEmptyCondition('k1', 1), compareMode: 'relative' as const, baselineType: 'day' as const, baselineCount: 2 }
    const p = toConditionPayload(c, 1)
    expect(p.baselineType).toBe('day')
    expect('baselineCount' in p).toBe(false)
  })

  it('绝对模式：请求体不带任何 baseline 字段', () => {
    // 负对照：即使表单里残留了值（从相对切回来没清干净），也不能提交
    const c = { ...createEmptyCondition('k1', 1), compareMode: 'absolute' as const, baselineType: 'day' as const, baselineCount: 3 }
    const p = toConditionPayload(c, 1)
    expect('compareMode' in p).toBe(false)
    expect('baselineType' in p).toBe(false)
    expect('baselineCount' in p).toBe(false)
  })

  it('存量条件回填：后端没给 compareMode 时兜底成 absolute', () => {
    // v1.0 建的数据，后端会归一化成 'absolute'；万一没给，
    // 开关初始状态不能是 undefined（会让「相对判据」面板显隐不确定）。
    const item = toConditionFormItem({ ...base, compareMode: undefined } as AlarmPolicyCondition, 'c1')
    expect(item.compareMode).toBe('absolute')
  })

  it('相对判据的文案必须点破「百分比」', () => {
    const c = { ...base, compareMode: 'relative' as const, baselineType: 'day' as const, threshold: 30 }
    const text = describeConditionCriteria(c)
    expect(text).toContain('昨日同期')
    expect(text).toContain('30%')
    // ⚠️ 负对照：不能只显示「CPU 使用率 > 30%」——
    //    那句话在绝对模式下也成立，会让用户误以为阈值还是 CPU 百分比
    expect(text).not.toBe(describeCondition(c))
  })

  it('环比文案带上前移周期数', () => {
    const c = { ...base, compareMode: 'relative' as const, baselineType: 'period' as const, baselineCount: 5 }
    expect(describeConditionCriteria(c)).toContain('前 5 个 5 分钟周期')
  })

  it('绝对模式文案保持 v1.0 原样', () => {
    expect(describeConditionCriteria(base)).toBe('CPU 使用率 > 80%')
  })
})

describe('v1.1 采集静默', () => {
  const silenceCond = {
    sort: 1,
    metricNamespace: null,
    metricName: null,
    metricNameCn: '',
    unit: '',
    operator: null,
    threshold: null,
    period: 5,
    continuity: 1,
    level: 2,
    frequency: 15,
    compareMode: null,
  } as unknown as AlarmPolicyCondition

  it('静默条件不渲染成 `null < nullnull%`', () => {
    const text = describeCondition(silenceCond)
    expect(text).not.toContain('null')
    expect(text).toContain('数据静默')
  })

  it('静默策略的请求体带 targetType + targetFreshnessMinutes', () => {
    const values = createEmptyPolicyFormValues()
    values.policyType = ALARM_POLICY_TYPE.SILENCE
    values.monitorType = 1
    values.objectType = 2
    values.objectIds = [8801]
    values.targetType = 1
    values.targetFreshnessMinutes = 30
    values.conditions = [toConditionFormItem(silenceCond, 'c1')]

    const p = buildPolicyPayload(values, 'create')
    expect(p.targetType).toBe(1)
    expect(p.targetFreshnessMinutes).toBe(30)
  })

  it('非静默策略必须整个省略两个静默字段', () => {
    // 契约 §1.2.1：非静默策略恒为 null。提交 0 或 null 都会拿到
    // 「只有 policyType=5 才能设置 targetType」的 422，而用户界面上
    // 根本没这两个字段，无从判断是哪来的问题。
    const values = createEmptyPolicyFormValues()
    values.policyType = ALARM_POLICY_TYPE.CVM
    values.monitorType = 1
    values.objectType = 2
    values.objectIds = [8801]
    // 负对照：故意填上，模拟「从静默切到 CVM 但没清干净」
    values.targetType = 1
    values.targetFreshnessMinutes = 30
    values.conditions = [createEmptyCondition('c1', 1)]

    const p = buildPolicyPayload(values, 'create') as unknown as Record<string, unknown>
    expect('targetType' in p).toBe(false)
    expect('targetFreshnessMinutes' in p).toBe(false)
  })

  it('静默策略的条件不提交任何指标字段', () => {
    const item = toConditionFormItem(silenceCond, 'c1')
    const p = toConditionPayload(item, 1) as unknown as Record<string, unknown>
    // 契约 §2.1 规则 3：6 个指标判据字段全部缺省。
    // 提交空串同样会被 422 拒（后端把 '' 当「提供了空值」）。
    for (const key of ['metricNamespace', 'metricName', 'operator', 'threshold']) {
      expect(p[key]).toBeFalsy()
    }
  })
})
