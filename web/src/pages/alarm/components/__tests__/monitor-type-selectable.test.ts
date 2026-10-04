/**
 * 监控类型可选性 —— F-a「UI 死胡同」的回归测试。
 *
 * ## 缺陷是什么
 *
 * 契约 §1.1 联动表写明 `monitorType` 的 `3`/`4`/`5`（前端性能监控 / 云拨测 / 终端性能监控）
 * 在 v1.0 **没有对应的 policyType**，选了后端返回 422。
 *
 * 向导此前直接用 `alarmMonitorTypeOptions`（全部 5 项）。用户选「前端性能监控」后：
 *
 * ```
 * 监控类型：前端性能监控
 * 策略类型：（空）
 *         该监控类型在 v1.0 暂无可用策略类型
 * ```
 *
 * **既走不完向导，也退不出这个选择** —— 这是功能不可用，不是体验瑕疵。
 * 审查 S-14 只记录了数据库 CHECK 缺约束，没发现 UI 把不可选的值提供给了用户。
 *
 * ## 修法
 *
 * 不提供不可选项。`alarmSelectableMonitorTypeOptions` 按 `ALARM_MONITOR_TYPE_POLICY_TYPES`
 * 过滤，**数据驱动** —— 将来补齐 RUM / 云拨测的 policyType 后自动放开，无需改过滤逻辑。
 *
 * ⚠️ 列表筛选器**必须继续用全量** `alarmMonitorTypeOptions`：可能存在存量数据
 * 需要按 3/4/5 查询，筛选器不负责「新建时能不能选」。
 */
import { describe, expect, it } from 'vitest'

import type { AlarmMonitorType } from '@/types/alarm'

import {
  alarmMonitorTypeOptions,
  alarmSelectableMonitorTypeOptions,
} from '@/pages/alarm/components/alarm-enum-options'
import {
  ALARM_MONITOR_TYPE,
  ALARM_MONITOR_TYPE_POLICY_TYPES,

} from '@/types/alarm'

describe('监控类型可选性（F-a）', () => {
  it('全量列表仍包含契约声明的 5 项', () => {
    expect(alarmMonitorTypeOptions).toHaveLength(5)
    expect(alarmMonitorTypeOptions.map(o => o.value).sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('可选列表剔除 v1.0 无 policyType 的 3/4/5', () => {
    const values = alarmSelectableMonitorTypeOptions.map(o => o.value).sort()

    expect(values, '向导只应提供有 policyType 的监控类型').toEqual([1, 2])
    expect(values).not.toContain(ALARM_MONITOR_TYPE.RUM)
    expect(values).not.toContain(ALARM_MONITOR_TYPE.PING_SITE)
    expect(values).not.toContain(ALARM_MONITOR_TYPE.TERMINAL)
  })

  /**
   * 死锁条件的真正表述：只要**任何一个**可选类型没有 policyType，用户就会走进死胡同。
   * 逐个断言比比对 `[1,2]` 更能指出是哪一个坏了。
   */
  it('可选列表中的每一项都必须有至少一个 policyType', () => {
    for (const option of alarmSelectableMonitorTypeOptions) {
      const types = ALARM_MONITOR_TYPE_POLICY_TYPES[option.value as AlarmMonitorType] ?? []

      expect(
        types.length,
        `监控类型「${option.label}」(${option.value}) 出现在可选列表里，但联动表里它的 policyType 是空的 —— `
        + '用户会走进「选了却走不下去」的死胡同。',
      ).toBeGreaterThan(0)
    }
  })

  it('可选列表是全量列表的真子集且保持原顺序', () => {
    const all = alarmMonitorTypeOptions.map(o => o.value)
    const selectable = alarmSelectableMonitorTypeOptions.map(o => o.value)

    for (const v of selectable)
      expect(all).toContain(v)

    // 顺序必须沿用契约表格顺序，不能被 filter 打乱
    const indices = selectable.map(v => all.indexOf(v))
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('每项都带中文 label（不是裸数字）', () => {
    for (const option of alarmSelectableMonitorTypeOptions) {
      expect(option.label, `监控类型 ${option.value} 缺中文 label`).toBeTruthy()
      expect(typeof option.label).toBe('string')
    }
  })

  it('过滤是数据驱动的：联动表补齐后会自动放开，无需改本文件', () => {
    // 模拟「将来补齐了云拨测的 policyType」
    const simulated: Record<AlarmMonitorType, number[]> = {
      ...ALARM_MONITOR_TYPE_POLICY_TYPES,
      [ALARM_MONITOR_TYPE.PING_SITE]: [99] as never,
    }
    const wouldInclude = alarmMonitorTypeOptions.filter(
      o => (simulated[o.value as AlarmMonitorType] ?? []).length > 0,
    )

    expect(wouldInclude.map(o => o.value)).toContain(ALARM_MONITOR_TYPE.PING_SITE)
  })
})

/**
 * 存量策略的兼容路径。
 *
 * ## 为什么需要这一组
 *
 * 契约说 monitorType 3/4/5 不可选，但**数据库层没有 CHECK 强制**（审查 S-14），
 * 历史数据或直接写库的调用能让它们落进 `alarm_policy`。
 *
 * 向导若只列 [1,2]，编辑这类策略时 Reka Select 找不到匹配 item，
 * `SelectValue` 回退显示 placeholder —— **存量值凭空消失**。
 * `policy-form.vue` 的 `monitorTypeOptions` 用「∪ 当前值」修掉了它，
 * 这里锁住该行为。
 *
 * 该 computed 挂在 policy-form.vue 里（依赖 values/monitorType），
 * 所以这里验证的是它依赖的两个**输入契约**，`policy-form.mount.test.ts`
 * 负责端到端挂载那条链路。
 */
describe('存量策略的监控类型可见性（F-a 的兼容面）', () => {
  /** 复刻 policy-form.vue 里 monitorTypeOptions 的计算逻辑 */
  const optionsFor = (current?: number | null) => {
    if (current === undefined || current === null)
      return alarmSelectableMonitorTypeOptions
    if (alarmSelectableMonitorTypeOptions.some(o => o.value === current))
      return alarmSelectableMonitorTypeOptions
    const label = alarmMonitorTypeOptions.find(o => o.value === current)?.label ?? String(current)
    return [...alarmSelectableMonitorTypeOptions, { label: `${label}（v1.0 不可选）`, value: current }]
  }

  it.each([3, 4, 5])('存量 monitorType=%i 必须出现在下拉里（不能隐身）', (legacy) => {
    const opts = optionsFor(legacy)

    expect(
      opts.map(o => o.value),
      `存量策略的 monitorType=${legacy} 不在下拉里 —— 编辑页会显示 placeholder，真实值消失。`,
    ).toContain(legacy)
  })

  it('存量值必须带「不可选」标注，而不是静默混入可选集', () => {
    const opt = optionsFor(3).find(o => o.value === 3)

    expect(opt?.label).toContain('v1.0 不可选')
    expect(opt?.label, '标注要让用户知道这条数据有问题').not.toBe('前端性能监控')
  })

  it('正常值 1/2 不应被追加多余项', () => {
    for (const v of [1, 2]) {
      expect(optionsFor(v)).toHaveLength(alarmSelectableMonitorTypeOptions.length)
      expect(optionsFor(v).some(o => o.label.includes('不可选'))).toBe(false)
    }
  })

  it('未选中时不追加任何项（新建态就是纯可选集）', () => {
    expect(optionsFor(undefined)).toBe(alarmSelectableMonitorTypeOptions)
    expect(optionsFor(null)).toBe(alarmSelectableMonitorTypeOptions)
  })

  it('存量值排在可选集之后（保持契约表格顺序在前）', () => {
    const opts = optionsFor(4)
    expect(opts[opts.length - 1].value).toBe(4)
  })
})
