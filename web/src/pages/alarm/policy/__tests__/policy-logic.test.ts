import { describe, expect, it } from 'vitest'

import type {
  AlarmConditionTemplate,
  AlarmNotificationTemplate,
  AlarmObjectFilter,
  AlarmPolicyCondition,
} from '@/types/alarm'

import {
  ALARM_NOTIFY_CHANNEL,
  ALARM_OBJECT_TYPE,
  ALARM_OPERATOR,
  ALARM_POLICY_STATUS,
  ALARM_PRESET_FLAG,
} from '@/types/alarm'

import {
  applyOptimisticStatus,
  buildConditionSummary,
  buildCopyName,
  buildObjectSummary,
  buildPolicyListQuery,
  buildPolicyPayload,
  canAddCondition,
  canAddNotificationTemplate,
  canDeletePolicy,
  canRemoveCondition,
  collectNotificationBindingErrors,
  collectObjectBindingErrors,
  COPY_NAME_SUFFIX,
  createEmptyPolicyFormValues,
  describeConditionLimit,
  describePolicyDeleteFailure,
  extractPolicyErrorMessage,
  findUnconfiguredNotificationTemplates,
  isNotificationTemplateConfigured,
  isPolicyConflict,
  isPolicyTypeAllowed,
  isValidCallbackUrl,
  isValidConditionCount,
  isValidPolicyName,
  isValidPolicyRemark,
  normalizePolicyName,
  POLICY_NAME_MAX_LENGTH,
  resolveObjectBinding,
  settleStatusToggle,
  statusActionLabel,
  toConditionFormItem,
  toConditionPayload,
  validateNotificationTemplateIds,
} from '../utils/policy-logic'

/**
 * 造一个长度为 `length` 的 id 数组。
 *
 * ⚠️ 不能写 `Array.from({ length }).fill(1)`：`Array.from` 只拿到 `{ length }` 这个普通对象时
 * 会推导出 `unknown[]`，`.fill()` 之后仍是 `unknown[]`，塞进 `objectIds: number[]` 就报 TS2322。
 * 显式给泛型参数标元素类型才是正解（不加就只能靠 `as any` 糊过去，那是错的），
 * 同时也满足 eslint 的 `e18e/prefer-array-fill`。
 */
function idsOf(length: number, value = 1): number[] {
  return Array.from<number>({ length }).fill(value)
}

/** 造一个长度为 `length` 的多维筛选数组（§1.7 元素结构）。 */
function filtersOf(length: number): AlarmObjectFilter[] {
  return Array.from<AlarmObjectFilter>({ length }).fill({
    key: 'region',
    operator: ALARM_OPERATOR.EQ,
    values: ['gz'],
    matchType: 'include',
  })
}

function condition(overrides: Partial<AlarmPolicyCondition> = {}): AlarmPolicyCondition {
  return {
    sort: 1,
    metricNamespace: 'CVM',
    metricName: 'CpuUtilizationRate',
    metricNameCn: 'CPU 使用率',
    unit: '%',
    operator: ALARM_OPERATOR.GT,
    threshold: 80,
    period: 5,
    continuity: 3,
    level: 1,
    frequency: 15,
    ...overrides,
  }
}

function template(overrides: Partial<AlarmNotificationTemplate> = {}): AlarmNotificationTemplate {
  return {
    id: 3,
    name: '运维值班组',
    remark: '',
    isPreset: ALARM_PRESET_FLAG.CUSTOM,
    channels: [{ channel: ALARM_NOTIFY_CHANNEL.EMAIL, receivers: ['a@b.com'], callbackUrl: null, silenceTime: 0 }],
    creatorName: '张三',
    createdAt: '2026-09-20 10:12:33',
    updatedAt: '2026-09-20 10:12:33',
    ...overrides,
  }
}

// ============================================================================
describe('条件摘要文案生成', () => {
  it('0 条 → 暂无触发条件', () => {
    expect(buildConditionSummary([])).toBe('暂无触发条件')
  })

  it('1 条 → 直接给指标 + 符号 + 阈值 + 单位', () => {
    expect(buildConditionSummary([condition()])).toBe('CPU 使用率 > 80%')
  })

  it('operator 原样取符号，不本地化成「大于」', () => {
    expect(buildConditionSummary([condition({ operator: ALARM_OPERATOR.LTE, threshold: 10 })])).toBe('CPU 使用率 <= 10%')
  })

  it('负数阈值正常输出（P6 允许负数）', () => {
    expect(buildConditionSummary([condition({ threshold: -3.5 })])).toBe('CPU 使用率 > -3.5%')
  })

  it('缺中文名时回落到 namespace.metricName', () => {
    expect(buildConditionSummary([condition({ metricNameCn: '' })])).toBe('CVM.CpuUtilizationRate > 80%')
  })

  it('2 条（不超过 limit）→ 全部用「；」连接', () => {
    const list = [
      condition(),
      condition({ metricNameCn: '内存使用率', metricName: 'MemoryUsageRate', threshold: 85 }),
    ]
    expect(buildConditionSummary(list)).toBe('CPU 使用率 > 80%；内存使用率 > 85%')
  })

  it('4 条 + limit=2 → 前 2 条 + 「等 4 条」', () => {
    const list = [
      condition(),
      condition({ metricNameCn: '内存使用率' }),
      condition({ metricNameCn: '磁盘使用率' }),
      condition({ metricNameCn: '网络流入' }),
    ]
    expect(buildConditionSummary(list, 2)).toBe('CPU 使用率 > 80%；内存使用率 > 80% 等 4 条')
  })

  it('3 条 + limit=2 → 「等 3 条」', () => {
    const list = [condition(), condition({ metricNameCn: 'B' }), condition({ metricNameCn: 'C' })]
    expect(buildConditionSummary(list, 2)).toBe('CPU 使用率 > 80%；B > 80% 等 3 条')
  })

  it('limit=1 时只取首条', () => {
    const list = [condition(), condition({ metricNameCn: '内存使用率' })]
    expect(buildConditionSummary(list, 1)).toBe('CPU 使用率 > 80% 等 2 条')
  })
})

// ============================================================================
describe('条件数量上下界（0 和 5 都要测）', () => {
  it('1-3 条：可加；只有 >1 条才可删（P4 不允许删到 0）', () => {
    expect(canAddCondition(1)).toBe(true)
    expect(canAddCondition(3)).toBe(true)
    // 剩最后 1 条时删了就变成 0 条 → 拦截
    expect(canRemoveCondition(1)).toBe(false)
    expect(canRemoveCondition(2)).toBe(true)
    expect(canRemoveCondition(3)).toBe(true)
  })

  it('0 条：不能再删（下限 1，P4）', () => {
    expect(canRemoveCondition(0)).toBe(false)
    expect(isValidConditionCount(0)).toBe(false)
  })

  it('4 条：不能再加（上限 4，P4）', () => {
    expect(canAddCondition(4)).toBe(false)
    expect(isValidConditionCount(4)).toBe(true)
  })

  it('5 条：非法（绕过 UI 塞 5 条也判失败）', () => {
    expect(canAddCondition(5)).toBe(false)
    expect(isValidConditionCount(5)).toBe(false)
  })

  it('边界提示文案区分「已达上限」与「已低于下限」', () => {
    expect(describeConditionLimit(4)).toContain('已达契约上限')
    expect(describeConditionLimit(5)).toContain('已超过契约上限')
    expect(describeConditionLimit(0)).toContain('已低于契约下限')
    expect(describeConditionLimit(2)).toBe('触发条件 2/4 条，契约要求 1-4 条')
  })
})

// ============================================================================
describe('通知模板 3 个上限（P12 / P13）', () => {
  const map = new Map([
    [3, template({ id: 3 })],
    [5, template({ id: 5, name: '系统预置-邮件通知', isPreset: ALARM_PRESET_FLAG.PRESET })],
    [7, template({ id: 7, name: 'B' })],
    [9, template({ id: 9, name: 'C' })],
  ])

  it('恰好 3 个：合法', () => {
    expect(validateNotificationTemplateIds([3, 5, 7], map)).toEqual([])
  })

  it('第 4 个：拦截并提示上限', () => {
    const errors = validateNotificationTemplateIds([3, 5, 7, 9], map)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('最多绑定 3 个')
  })

  it('canAddNotificationTemplate 在 3 个时为 false', () => {
    expect(canAddNotificationTemplate(2)).toBe(true)
    expect(canAddNotificationTemplate(3)).toBe(false)
  })

  it('重复绑定：拦截', () => {
    const errors = validateNotificationTemplateIds([3, 3], map)
    expect(errors[0]).toContain('不可重复绑定')
  })

  it('不存在的模板 id：拦截', () => {
    const errors = validateNotificationTemplateIds([404], map)
    expect(errors[0]).toContain('通知模板不存在')
  })

  it('不传字典时只校验数量与去重', () => {
    expect(validateNotificationTemplateIds([1, 2, 3])).toEqual([])
  })

  it('空数组合法（通知模板是可选的）', () => {
    expect(validateNotificationTemplateIds([], map)).toEqual([])
  })
})

// ============================================================================
describe('n9：预置模板未配接收人不可绑定', () => {
  const presetNoReceiver = template({
    id: 5,
    name: '系统预置-邮件通知',
    isPreset: ALARM_PRESET_FLAG.PRESET,
    channels: [{ channel: ALARM_NOTIFY_CHANNEL.EMAIL, receivers: [], callbackUrl: null, silenceTime: 0 }],
  })
  const callbackOnly = template({
    id: 11,
    name: '纯回调',
    channels: [{ channel: ALARM_NOTIFY_CHANNEL.CALLBACK, receivers: [], callbackUrl: 'https://o/cb', silenceTime: 0 }],
  })
  const filled = template({ id: 3 })

  it('预置模板 receivers 为空且 channel≠5 → 未配置完成', () => {
    expect(isNotificationTemplateConfigured(presetNoReceiver)).toBe(false)
  })

  it('纯回调模板（channel=5）receivers 为空不算未配置', () => {
    expect(isNotificationTemplateConfigured(callbackOnly)).toBe(true)
  })

  it('已配接收人的模板算配置完成', () => {
    expect(isNotificationTemplateConfigured(filled)).toBe(true)
  })

  it('筛出未配置完成的模板并点名提示', () => {
    const map = new Map([
      [5, presetNoReceiver],
      [3, filled],
      [11, callbackOnly],
    ])
    const unconfigured = findUnconfiguredNotificationTemplates([5, 3, 11], map)
    expect(unconfigured.map(t => t.name)).toEqual(['系统预置-邮件通知'])

    const errors = collectNotificationBindingErrors([5, 3, 11], map)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('系统预置-邮件通知')
    expect(errors[0]).toContain('未配置接收人')
  })

  it('多个渠道里只要有一个非回调渠道为空即算未配置', () => {
    const mixed = template({
      id: 12,
      name: '混合渠道',
      channels: [
        { channel: ALARM_NOTIFY_CHANNEL.EMAIL, receivers: ['a@b.com'], callbackUrl: null, silenceTime: 0 },
        { channel: ALARM_NOTIFY_CHANNEL.SMS, receivers: [], callbackUrl: null, silenceTime: 0 },
      ],
    })
    expect(isNotificationTemplateConfigured(mixed)).toBe(false)
  })

  it('数量越界 + N9 同时命中时，两个原因都要报出来', () => {
    const map = new Map([[1, presetNoReceiver]])
    const errors = collectNotificationBindingErrors([1, 1], map)
    expect(errors.some(e => e.includes('不可重复绑定'))).toBe(true)
    expect(errors.some(e => e.includes('未配置接收人'))).toBe(true)
  })
})

// ============================================================================
describe('策略名 / 备注长度与空值（P1 / P2）', () => {
  it('去首尾空格后为空 → 非法', () => {
    expect(isValidPolicyName('')).toBe(false)
    expect(isValidPolicyName('   ')).toBe(false)
    expect(isValidPolicyName('\n\t ')).toBe(false)
  })

  it('1 个字符合法，128 个字符合法', () => {
    expect(isValidPolicyName('A')).toBe(true)
    expect(isValidPolicyName('A'.repeat(POLICY_NAME_MAX_LENGTH))).toBe(true)
  })

  it('129 个字符非法', () => {
    expect(isValidPolicyName('A'.repeat(POLICY_NAME_MAX_LENGTH + 1))).toBe(false)
  })

  it('「空格 + 128 字 + 空格」按去空格后长度算，合法', () => {
    expect(isValidPolicyName(`  ${'A'.repeat(POLICY_NAME_MAX_LENGTH)}  `)).toBe(true)
  })

  it('中文按字符计（不是字节）', () => {
    expect(isValidPolicyName('告'.repeat(POLICY_NAME_MAX_LENGTH))).toBe(true)
    expect(isValidPolicyName('告'.repeat(POLICY_NAME_MAX_LENGTH + 1))).toBe(false)
  })

  it('normalizePolicyName 去首尾空格', () => {
    expect(normalizePolicyName('  生产 CVM CPU 监控  ')).toBe('生产 CVM CPU 监控')
  })

  it('备注 500 合法，501 非法（P2）', () => {
    expect(isValidPolicyRemark('x'.repeat(500))).toBe(true)
    expect(isValidPolicyRemark('x'.repeat(501))).toBe(false)
  })
})

// ============================================================================
describe('复制命名「- 副本」（§3.1 ⑦）', () => {
  it('普通名称直接拼后缀', () => {
    expect(buildCopyName('生产 CVM CPU 监控')).toBe('生产 CVM CPU 监控 - 副本')
    expect(COPY_NAME_SUFFIX).toBe(' - 副本')
  })

  it('先 trim 再拼', () => {
    expect(buildCopyName('  策略A  ')).toBe('策略A - 副本')
  })

  it('带序号： - 副本(2)', () => {
    expect(buildCopyName('策略A', 2)).toBe('策略A - 副本(2)')
    expect(buildCopyName('策略A', 99)).toBe('策略A - 副本(99)')
  })

  it('超长名称按**字符**截断到 128 - 5 = 123 后再拼', () => {
    const long = 'A'.repeat(POLICY_NAME_MAX_LENGTH)
    const name = buildCopyName(long)
    expect(name).toHaveLength(POLICY_NAME_MAX_LENGTH)
    expect(name.endsWith(COPY_NAME_SUFFIX)).toBe(true)
    expect(name).toBe(`${'A'.repeat(123)}${COPY_NAME_SUFFIX}`)
  })

  it('超长中文名按字符截断，不切出半截汉字（契约明令禁止按字节截断）', () => {
    const long = '告'.repeat(POLICY_NAME_MAX_LENGTH)
    const name = buildCopyName(long)
    expect([...name]).toHaveLength(POLICY_NAME_MAX_LENGTH)
    expect(name.startsWith('告'.repeat(123))).toBe(true)
    // 末尾 5 个字符必须是完整后缀，没有半个汉字
    expect(name.endsWith('副本')).toBe(true)
  })

  it('带序号时按 128 - 8 = 120 截断', () => {
    const name = buildCopyName('A'.repeat(POLICY_NAME_MAX_LENGTH), 2)
    expect([...name]).toHaveLength(POLICY_NAME_MAX_LENGTH)
    expect(name).toBe(`${'A'.repeat(120)} - 副本(2)`)
  })
})

// ============================================================================
describe('objectType ↔ 三个 object 字段一一对应（P14）', () => {
  it('全部对象：三个字段全部收敛为 null，而不是 []', () => {
    const resolved = resolveObjectBinding(ALARM_OBJECT_TYPE.ALL, {
      objectIds: [1, 2],
      objectGroupIds: [3],
      objectFilters: [{ key: 'region', operator: '==', values: ['gz'], matchType: 'include' }],
    })
    expect(resolved).toEqual({ objectIds: null, objectGroupIds: null, objectFilters: null })
  })

  it('全部对象：带上任意一个字段都报错', () => {
    const errors = collectObjectBindingErrors(ALARM_OBJECT_TYPE.ALL, { objectIds: [1] })
    expect(errors[0]).toContain('不得指定实例')
  })

  it('指定实例：只保留 objectIds，另两个为 null', () => {
    const resolved = resolveObjectBinding(ALARM_OBJECT_TYPE.INSTANCE, { objectIds: [8801] })
    expect(resolved).toEqual({ objectIds: [8801], objectGroupIds: null, objectFilters: null })
  })

  it('指定实例：0 个实例 → 报错', () => {
    const errors = collectObjectBindingErrors(ALARM_OBJECT_TYPE.INSTANCE, { objectIds: [] })
    expect(errors[0]).toContain('至少需要 1 项')
  })

  it('指定实例：1000 个合法，1001 个非法', () => {
    expect(collectObjectBindingErrors(ALARM_OBJECT_TYPE.INSTANCE, { objectIds: idsOf(1000) })).toEqual([])
    const errors = collectObjectBindingErrors(ALARM_OBJECT_TYPE.INSTANCE, { objectIds: idsOf(1001) })
    expect(errors[0]).toContain('最多 1000 项')
  })

  it('实例分组：只保留 objectGroupIds，上限 100', () => {
    const resolved = resolveObjectBinding(ALARM_OBJECT_TYPE.GROUP, { objectGroupIds: [7] })
    expect(resolved).toEqual({ objectIds: null, objectGroupIds: [7], objectFilters: null })
    expect(collectObjectBindingErrors(ALARM_OBJECT_TYPE.GROUP, { objectGroupIds: idsOf(101) })[0]).toContain('最多 100 项')
  })

  it('多维筛选：只保留 objectFilters，上限 10', () => {
    const filters = filtersOf(10)
    const resolved = resolveObjectBinding(ALARM_OBJECT_TYPE.FILTER, { objectFilters: filters })
    expect(resolved.objectIds).toBeNull()
    expect(resolved.objectFilters).toHaveLength(10)
    expect(collectObjectBindingErrors(ALARM_OBJECT_TYPE.FILTER, { objectFilters: filtersOf(11) })[0]).toContain('最多 10 项')
  })

  it('未选值时适用字段给 []（后续由校验拦空）', () => {
    expect(resolveObjectBinding(ALARM_OBJECT_TYPE.INSTANCE).objectIds).toEqual([])
  })

  it('告警对象摘要文案', () => {
    expect(buildObjectSummary(ALARM_OBJECT_TYPE.ALL)).toBe('全部对象')
    expect(buildObjectSummary(ALARM_OBJECT_TYPE.INSTANCE, { objectIds: [1, 2] })).toBe('指定实例 · 2 个')
    expect(buildObjectSummary(ALARM_OBJECT_TYPE.INSTANCE, { objectIds: [] })).toBe('指定实例 · 未选择')
    expect(buildObjectSummary(ALARM_OBJECT_TYPE.GROUP, { objectGroupIds: [1] })).toBe('实例分组 · 1 个')
    expect(buildObjectSummary(ALARM_OBJECT_TYPE.FILTER, { objectFilters: [{ key: 'a', operator: '==', values: ['b'] }] })).toBe('多维筛选 · 1 条')
  })
})

// ============================================================================
describe('monitorType ↔ policyType 联动（P3）', () => {
  it('云产品监控（1）只能选 CVM/CLB/MySQL', () => {
    expect(isPolicyTypeAllowed(1, 2)).toBe(true)
    expect(isPolicyTypeAllowed(1, 3)).toBe(true)
    expect(isPolicyTypeAllowed(1, 4)).toBe(true)
    expect(isPolicyTypeAllowed(1, 1)).toBe(false)
  })

  it('应用性能监控（2）只能选通用 Web 服务（1）', () => {
    expect(isPolicyTypeAllowed(2, 1)).toBe(true)
    expect(isPolicyTypeAllowed(2, 2)).toBe(false)
  })

  it('rUM/PING_SITE/TERMINAL（3/4/5）没有任何可用策略类型', () => {
    expect(isPolicyTypeAllowed(3, 1)).toBe(false)
    expect(isPolicyTypeAllowed(4, 1)).toBe(false)
    expect(isPolicyTypeAllowed(5, 1)).toBe(false)
  })
})

// ============================================================================
describe('回调 URL 格式（N3）', () => {
  it('空串视为未填，放行', () => {
    expect(isValidCallbackUrl('')).toBe(true)
  })

  it('http / https 放行', () => {
    expect(isValidCallbackUrl('http://a.com/cb')).toBe(true)
    expect(isValidCallbackUrl('https://a.com/cb')).toBe(true)
  })

  it('缺协议 / ftp 拦截', () => {
    expect(isValidCallbackUrl('a.com/cb')).toBe(false)
    expect(isValidCallbackUrl('ftp://a.com/cb')).toBe(false)
  })

  it('超过 500 字符拦截', () => {
    expect(isValidCallbackUrl(`https://a.com/${'x'.repeat(500)}`)).toBe(false)
  })
})

// ============================================================================
describe('列表 query 组装（§3.1 ①：空串视为未传）', () => {
  it('空串筛选条件不参与筛选', () => {
    const query = buildPolicyListQuery(
      { keyword: '   ', monitorType: undefined, policyType: undefined, status: undefined, level: undefined, projectId: '' },
      { pageIndex: 0, pageSize: 20 },
    )
    expect(query).toEqual({ page: 1, pageSize: 20 })
  })

  it('keyword 去掉首尾空格后有值才带上', () => {
    expect(buildPolicyListQuery({ keyword: '  CPU  ' }, { pageIndex: 0, pageSize: 20 }).keyword).toBe('CPU')
  })

  it('全部条件透传', () => {
    const query = buildPolicyListQuery(
      { keyword: 'CPU', monitorType: 1, policyType: 2, status: 1, level: 3, projectId: 12 },
      { pageIndex: 2, pageSize: 50 },
    )
    expect(query).toEqual({
      page: 3,
      pageSize: 50,
      keyword: 'CPU',
      monitorType: 1,
      policyType: 2,
      status: 1,
      level: 3,
      projectId: 12,
    })
  })

  it('status=0 是合法筛选值，不会被当成「未填」', () => {
    expect(buildPolicyListQuery({ status: 0 }, { pageIndex: 0, pageSize: 20 }).status).toBe(0)
  })

  it('pageIndex 从 0 起始换算成 1 起始的 page', () => {
    expect(buildPolicyListQuery({}, { pageIndex: 0, pageSize: 10 }).page).toBe(1)
    expect(buildPolicyListQuery({}, { pageIndex: 4, pageSize: 10 }).page).toBe(5)
  })
})

// ============================================================================
describe('请求体组装（P5 / P10 / P14 / P18）', () => {
  function filledValues() {
    return {
      ...createEmptyPolicyFormValues(),
      name: '  生产 CVM CPU 监控  ',
      remark: '核心交易集群',
      monitorType: 1 as const,
      policyType: 2 as const,
      objectType: ALARM_OBJECT_TYPE.INSTANCE,
      objectIds: [8801, 8802],
      objectGroupIds: [9],
      objectFilters: [{ key: 'region', operator: '==' as const, values: ['gz'], matchType: 'include' as const }],
      conditions: [
        toConditionFormItem(condition({ id: 7001, sort: 3 }), 'k1'),
        toConditionFormItem(condition({ id: 7002, sort: 9 as never, metricNameCn: '内存使用率' }), 'k2'),
      ],
      notificationTemplateIds: [3, 5],
      status: 1 as const,
    }
  }

  it('create：带 status，条件 sort 重排为 1..N 连续升序（P5）', () => {
    const payload = buildPolicyPayload(filledValues(), 'create')
    expect(payload.status).toBe(1)
    expect(payload.conditions.map(c => c.sort)).toEqual([1, 2])
  })

  it('update：**省略 status**（P18 唯一不回落默认的字段）', () => {
    const payload = buildPolicyPayload(filledValues(), 'update')
    expect('status' in payload).toBe(false)
  })

  it('条件请求体里没有响应专用字段 id / metricNameCn / unit', () => {
    const payload = buildPolicyPayload(filledValues(), 'update')
    for (const condition of payload.conditions) {
      expect(condition).not.toHaveProperty('id')
      expect(condition).not.toHaveProperty('metricNameCn')
      expect(condition).not.toHaveProperty('unit')
    }
    expect(Object.keys(payload.conditions[0]).sort()).toEqual([
      'continuity',
      'frequency',
      'level',
      'metricName',
      'metricNamespace',
      'operator',
      'period',
      'sort',
      'threshold',
    ])
  })

  it('p14：不适用的 object 字段提交 null（不是 []）', () => {
    const payload = buildPolicyPayload(filledValues(), 'create')
    expect(payload.objectGroupIds).toBeNull()
    expect(payload.objectFilters).toBeNull()
    expect(payload.objectIds).toEqual([8801, 8802])
  })

  it('全部对象时三个字段都是 null', () => {
    const payload = buildPolicyPayload(
      { ...filledValues(), objectType: ALARM_OBJECT_TYPE.ALL },
      'create',
    )
    expect(payload.objectIds).toBeNull()
    expect(payload.objectGroupIds).toBeNull()
    expect(payload.objectFilters).toBeNull()
  })

  it('name 去首尾空格；notificationTemplateIds 始终是数组（§0.6 R-JSON-2）', () => {
    const payload = buildPolicyPayload(filledValues(), 'create')
    expect(payload.name).toBe('生产 CVM CPU 监控')
    expect(Array.isArray(payload.notificationTemplateIds)).toBe(true)
    expect(payload.notificationTemplateIds).toEqual([3, 5])
  })

  it('负数阈值原样透传，不被截断为 0（P6）', () => {
    const payload = buildPolicyPayload(
      { ...filledValues(), conditions: [toConditionFormItem(condition({ threshold: -12.5 }), 'k1')] },
      'create',
    )
    expect(payload.conditions[0].threshold).toBe(-12.5)
  })

  it('单条条件 → Payload 只有 9 个 P10 必填字段', () => {
    const payload = toConditionPayload(toConditionFormItem(condition(), 'k'), 1)
    expect(Object.keys(payload)).toHaveLength(9)
  })

  it('回填时丢弃响应里的 id', () => {
    const item = toConditionFormItem(condition({ id: 7001 }), 'k1')
    expect(item).not.toHaveProperty('id')
    expect(item._key).toBe('k1')
  })
})

// ============================================================================
describe('触发条件模板填充（复制策略用）', () => {
  it('模板条件原样进入表单并保持顺序', () => {
    const template: AlarmConditionTemplate = {
      id: 6,
      name: '预置-CVM CPU',
      remark: '',
      policyType: 2,
      isPreset: ALARM_PRESET_FLAG.PRESET,
      conditions: [
        condition({ id: 1, sort: 1 }),
        condition({ id: 2, sort: 2, metricNameCn: '内存使用率' }),
      ],
      creatorName: '系统',
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    }
    const items = template.conditions.map((c, index) => toConditionFormItem(c, `tpl-${c.id ?? index}`))
    expect(items).toHaveLength(2)
    expect(items.every(item => !('id' in item))).toBe(true)
    const payload = buildPolicyPayload(
      { ...createEmptyPolicyFormValues(), monitorType: 1, policyType: 2, conditions: items },
      'create',
    )
    expect(payload.conditions).toHaveLength(2)
  })
})

// ============================================================================
describe('⑥ 启停：乐观更新 + 失败必须回滚（P19）', () => {
  it('乐观更新：先改行状态，并交回原值供回滚', () => {
    const row = { status: ALARM_POLICY_STATUS.ENABLED }
    const previous = applyOptimisticStatus(row, ALARM_POLICY_STATUS.DISABLED)
    expect(previous).toBe(ALARM_POLICY_STATUS.ENABLED)
    expect(row.status).toBe(ALARM_POLICY_STATUS.DISABLED) // 开关已经先动了
  })

  it('成功：保留乐观值，不回滚，并带回后端的 updatedAt', () => {
    const row = { status: ALARM_POLICY_STATUS.DISABLED, updatedAt: '2026-09-20 10:00:00' }
    const previous = applyOptimisticStatus(row, ALARM_POLICY_STATUS.ENABLED)
    const outcome = settleStatusToggle(row, {
      next: ALARM_POLICY_STATUS.ENABLED,
      previous,
      res: { success: true, code: 0, message: 'success' },
      updatedAt: '2026-09-30 09:00:00',
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.rolledBack).toBe(false)
    expect(outcome.status).toBe(ALARM_POLICY_STATUS.ENABLED)
    expect(outcome.updatedAt).toBe('2026-09-30 09:00:00')
    expect(row.status).toBe(ALARM_POLICY_STATUS.ENABLED)
  })

  it('业务失败：行状态必须被拉回原值（这是本节的重点）', () => {
    const row = { status: ALARM_POLICY_STATUS.ENABLED, updatedAt: '2026-09-20 10:00:00' }
    const previous = applyOptimisticStatus(row, ALARM_POLICY_STATUS.DISABLED)
    const outcome = settleStatusToggle(row, {
      next: ALARM_POLICY_STATUS.DISABLED,
      previous,
      res: { success: false, code: 404, message: '资源不存在' },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.rolledBack).toBe(true)
    expect(outcome.status).toBe(ALARM_POLICY_STATUS.ENABLED)
    // 关键断言：界面不能停在骗人的「已停用」
    expect(row.status).toBe(ALARM_POLICY_STATUS.ENABLED)
  })

  it('请求抛异常走同一条回滚路径（catch 里也必须回滚）', () => {
    const row = { status: ALARM_POLICY_STATUS.DISABLED }
    const previous = applyOptimisticStatus(row, ALARM_POLICY_STATUS.ENABLED)
    const outcome = settleStatusToggle(row, {
      next: ALARM_POLICY_STATUS.ENABLED,
      previous,
      res: { success: false, message: 'Network Error' },
    })

    expect(outcome.rolledBack).toBe(true)
    expect(row.status).toBe(ALARM_POLICY_STATUS.DISABLED)
    expect(outcome.message).toBe('Network Error')
  })

  it('回滚后端没给 message 时用兜底文案，不展示空串', () => {
    const row = { status: ALARM_POLICY_STATUS.ENABLED }
    const previous = applyOptimisticStatus(row, ALARM_POLICY_STATUS.DISABLED)
    const outcome = settleStatusToggle(row, {
      next: ALARM_POLICY_STATUS.DISABLED,
      previous,
      res: { success: false, code: 500, message: '  ' },
    })

    expect(outcome.message).toBe('停用策略失败')
    expect(outcome.message.length).toBeGreaterThan(0)
  })

  it('启停动词', () => {
    expect(statusActionLabel(ALARM_POLICY_STATUS.ENABLED)).toBe('启用')
    expect(statusActionLabel(ALARM_POLICY_STATUS.DISABLED)).toBe('停用')
  })

  it('契约 P19：重复提交相同 status 视为成功，逻辑层不产生回滚', () => {
    const row = { status: ALARM_POLICY_STATUS.ENABLED }
    // 幂等：后端返回成功 → 状态保持不变
    const outcome = settleStatusToggle(row, {
      next: ALARM_POLICY_STATUS.ENABLED,
      previous: ALARM_POLICY_STATUS.ENABLED,
      res: { success: true, code: 0 },
    })
    expect(outcome.rolledBack).toBe(false)
    expect(row.status).toBe(ALARM_POLICY_STATUS.ENABLED)
  })
})

// ============================================================================
describe('⑤ 删除前置校验与 409 提示（P15 / §0.5）', () => {
  it('只有停用（status=0）可删除', () => {
    expect(canDeletePolicy(ALARM_POLICY_STATUS.DISABLED)).toBe(true)
    expect(canDeletePolicy(ALARM_POLICY_STATUS.ENABLED)).toBe(false)
  })

  it('409：展示后端 message「已启用的策略不可删除，请先停用」', () => {
    const failure = describePolicyDeleteFailure({
      success: false,
      code: 409,
      message: '已启用的策略不可删除，请先停用',
    })
    expect(failure.message).toBe('已启用的策略不可删除，请先停用')
    expect(failure.title).toBe('策略无法删除')
  })

  it('契约 §0.5：409 下 5 个语义分支共用，前端只按 code 统一提示', () => {
    const conflicts = [
      '已启用的策略不可删除，请先停用',
      '策略名称已存在',
      '模板已被策略引用，不可删除',
      '预置模板不可删除',
      '该告警已处理，不可重复处理',
    ]
    for (const message of conflicts)
      expect(isPolicyConflict({ success: false, code: 409, message })).toBe(true)

    expect(isPolicyConflict({ success: false, code: 422, message: '参数校验失败' })).toBe(false)
    expect(isPolicyConflict({ success: true, code: 0 })).toBe(false)
    expect(isPolicyConflict(null)).toBe(false)
    expect(isPolicyConflict(undefined)).toBe(false)
  })

  it('非 409 失败仍展示后端 message，不静默失败', () => {
    const failure = describePolicyDeleteFailure({ success: false, code: 404, message: '资源不存在' })
    expect(failure.message).toBe('资源不存在')
    expect(failure.title).toBe('删除策略失败')
  })

  it('后端 message 为空时回落到兜底文案', () => {
    expect(extractPolicyErrorMessage({ success: false, code: 500, message: '' }, '删除策略失败')).toBe('删除策略失败')
    expect(extractPolicyErrorMessage({ success: false, code: 500 }, '删除策略失败')).toBe('删除策略失败')
    expect(extractPolicyErrorMessage(null, '删除策略失败')).toBe('删除策略失败')
  })
})
