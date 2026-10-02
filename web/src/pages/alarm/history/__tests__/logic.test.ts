/**
 * 告警历史 —— 纯逻辑层单测。
 *
 * 覆盖任务里点名的 5 类边界：
 * 1. 三个 handle 动作映射到正确的 action 值
 * 2. 状态徽章映射覆盖**全部**枚举（不能有 undefined）
 * 3. 时间范围参数拼装（开始 / 结束 / 只选一端 / 非法值 / 跨天 / start>end）
 * 4. overview 统计兜底（字段缺失时不产生 NaN）
 * 5. policyId query 容错（缺失 / 非法不崩）
 */
import { CalendarDateTime, parseDate, ZonedDateTime } from '@internationalized/date'
import { describe, expect, it } from 'vitest'

import {
  ALARM_ERROR_CODE,
  ALARM_HANDLE_ACTION,
  ALARM_HANDLE_ACTION_TO_STATUS,
  ALARM_HISTORY_STATUS,
  ALARM_HISTORY_STATUS_LABEL,
  ALARM_LEVEL,
} from '@/types/alarm'

import {
  ALARM_HISTORY_STATUS_VALUES,
  ALARM_LEVEL_VALUES,
  alarmLevelLabel,
  buildHandlePayload,
  buildHistoryListQuery,
  buildTimeRangeParams,
  canHandleHistory,
  clampPage,
  clampPageSize,
  createEmptyOverview,
  describeAlarmError,
  extractAlarmErrorMessage,
  findHandleAction,
  formatDuration,
  formatMetricValue,
  formatTimeRangeLabel,
  HANDLE_ACTIONS,
  HISTORY_STATUS_VARIANT,
  historyStatusLabel,
  isAlarmConflict,
  normalizeOverview,
  parsePolicyIdQuery,
  validateHandleRemark,
} from '../logic'

// ============================================================================
// 1. 三个 handle 动作映射
// ============================================================================

describe('hANDLE_ACTIONS —— 契约 §1.12 / H1', () => {
  it('**只有三个**动作，且枚举值与契约完全一致', () => {
    expect(HANDLE_ACTIONS.map(item => item.action)).toEqual([
      ALARM_HANDLE_ACTION.HANDLE,
      ALARM_HANDLE_ACTION.IGNORE,
      ALARM_HANDLE_ACTION.RECOVER,
    ])
    expect(HANDLE_ACTIONS).toHaveLength(3)
  })

  it.each([
    [ALARM_HANDLE_ACTION.HANDLE, '处理', ALARM_HISTORY_STATUS.HANDLED],
    [ALARM_HANDLE_ACTION.IGNORE, '忽略', ALARM_HISTORY_STATUS.IGNORED],
    [ALARM_HANDLE_ACTION.RECOVER, '恢复', ALARM_HISTORY_STATUS.RECOVERED],
  ] as const)('%s → 中文名「%s」→ 落库状态 %s', (action, label, status) => {
    const meta = findHandleAction(action)

    expect(meta).toBeDefined()
    expect(meta?.actionLabel).toBe(label)
    // 契约 §1.12 表格第三列：动作决定落库后的 status
    expect(meta?.resultStatus).toBe(status)
    // 与契约类型层给出的映射表一致
    expect(ALARM_HANDLE_ACTION_TO_STATUS[action]).toBe(status)
  })

  it('处理动作提交的是契约的字符串字面量，不是本地化文案', () => {
    expect(buildHandlePayload(ALARM_HANDLE_ACTION.HANDLE, '已扩容').action).toBe('handle')
    expect(buildHandlePayload(ALARM_HANDLE_ACTION.IGNORE).action).toBe('ignore')
    expect(buildHandlePayload(ALARM_HANDLE_ACTION.RECOVER).action).toBe('recover')
  })

  it('remark 缺省归一成空串（契约：默认 ""，不是 null）', () => {
    expect(buildHandlePayload(ALARM_HANDLE_ACTION.HANDLE)).toEqual({ action: 'handle', remark: '' })
    expect(buildHandlePayload(ALARM_HANDLE_ACTION.IGNORE, '   ')).toEqual({ action: 'ignore', remark: '' })
    expect(buildHandlePayload(ALARM_HANDLE_ACTION.RECOVER, '  自动恢复  ').remark).toBe('自动恢复')
  })

  it('findHandleAction 对未知动作返回 undefined（不做静默兜底）', () => {
    expect(findHandleAction('delete' as never)).toBeUndefined()
  })

  it('h2：备注超过 500 字符被拦', () => {
    expect(validateHandleRemark('a'.repeat(500))).toBeNull()
    expect(validateHandleRemark('a'.repeat(501))).toContain('500')
  })

  it('h3：仅 status=1（未处理）可处理', () => {
    expect(canHandleHistory(ALARM_HISTORY_STATUS.UNHANDLED)).toBe(true)
    expect(canHandleHistory(ALARM_HISTORY_STATUS.HANDLED)).toBe(false)
    expect(canHandleHistory(ALARM_HISTORY_STATUS.IGNORED)).toBe(false)
    expect(canHandleHistory(ALARM_HISTORY_STATUS.RECOVERED)).toBe(false)
    expect(canHandleHistory(undefined)).toBe(false)
  })
})

// ============================================================================
// 2. 状态徽章映射覆盖全部枚举
// ============================================================================

describe('hISTORY_STATUS_VARIANT —— 覆盖全部枚举', () => {
  it('契约 §1.10 的 4 个状态都有变体，且没有 undefined', () => {
    expect(ALARM_HISTORY_STATUS_VALUES).toHaveLength(4)

    for (const status of ALARM_HISTORY_STATUS_VALUES) {
      expect(HISTORY_STATUS_VARIANT[status], `状态 ${status} 缺少变体`).toBeDefined()
      expect(typeof HISTORY_STATUS_VARIANT[status]).toBe('string')
      expect(historyStatusLabel(status), `状态 ${status} 缺少中文名`).toBeTruthy()
      expect(historyStatusLabel(status)).not.toBe('undefined')
    }
  })

  it('枚举顺序与契约一致：未处理 / 已处理 / 已忽略 / 已恢复', () => {
    expect(ALARM_HISTORY_STATUS_VALUES).toEqual([1, 2, 3, 4])
    expect(ALARM_HISTORY_STATUS_VALUES.map(historyStatusLabel)).toEqual([
      ALARM_HISTORY_STATUS_LABEL[1],
      ALARM_HISTORY_STATUS_LABEL[2],
      ALARM_HISTORY_STATUS_LABEL[3],
      ALARM_HISTORY_STATUS_LABEL[4],
    ])
  })

  it('object.keys 恰好是全部枚举值（多一个少一个都要被发现）', () => {
    expect(Object.keys(HISTORY_STATUS_VARIANT).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('未知状态有中文兜底文案，不渲染 undefined', () => {
    expect(historyStatusLabel(99 as never)).toBe('未知状态(99)')
    expect(alarmLevelLabel(99 as never)).toBe('未知等级(99)')
  })

  it('等级枚举 3 项且有中文名（alarm-level-badge 依赖 ALARM_LEVEL_LABEL）', () => {
    expect(ALARM_LEVEL_VALUES).toEqual([ALARM_LEVEL.EMERGENCY, ALARM_LEVEL.SERIOUS, ALARM_LEVEL.NOTICE])
    expect(ALARM_LEVEL_VALUES.map(alarmLevelLabel)).toEqual(['紧急', '严重', '提示'])
  })
})

// ============================================================================
// 3. 时间范围参数拼装
// ============================================================================

describe('buildTimeRangeParams —— 契约 ⑰ / H4', () => {
  it('两端都不选：不带任何时间参数', () => {
    expect(buildTimeRangeParams(undefined)).toEqual({ error: null })
    expect(buildTimeRangeParams(null)).toEqual({ error: null })
    expect(buildTimeRangeParams({})).toEqual({ error: null })
    expect(buildTimeRangeParams({ start: null, end: null })).toEqual({ error: null })
  })

  it('两端都选（跨天）：下界 00:00:00、上界 23:59:59', () => {
    const params = buildTimeRangeParams({
      start: parseDate('2026-09-01'),
      end: parseDate('2026-09-30'),
    })

    expect(params).toEqual({
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-30 23:59:59',
      error: null,
    })
  })

  it('同一天：合法（不是错误），只是区间退化为当天', () => {
    expect(buildTimeRangeParams({ start: parseDate('2026-09-30'), end: parseDate('2026-09-30') })).toEqual({
      startTime: '2026-09-30 00:00:00',
      endTime: '2026-09-30 23:59:59',
      error: null,
    })
  })

  it('**只选开始**：只带 startTime', () => {
    const params = buildTimeRangeParams({ start: parseDate('2026-09-01'), end: undefined })
    expect(params).toEqual({ startTime: '2026-09-01 00:00:00', error: null })
  })

  it('**只选结束**：只带 endTime', () => {
    const params = buildTimeRangeParams({ start: null, end: parseDate('2026-09-30') })
    expect(params).toEqual({ endTime: '2026-09-30 23:59:59', error: null })
  })

  it('h4：开始晚于结束 → 返回 error 且**不带任何时间参数**（避免必然 422）', () => {
    const params = buildTimeRangeParams({ start: parseDate('2026-09-30'), end: parseDate('2026-09-01') })

    expect(params.error).toContain('开始时间不能晚于结束时间')
    expect(params).not.toHaveProperty('startTime')
    expect(params).not.toHaveProperty('endTime')
  })

  it.each([
    ['abc', '开始时间格式不合法，请重新选择'],
    ['', '开始时间格式不合法，请重新选择'],
    ['2026-13-01', '开始时间格式不合法，请重新选择'],
    ['2026-02-30', '开始时间格式不合法，请重新选择'],
    ['20260901', '开始时间格式不合法，请重新选择'],
  ])('非法开始值 %s 被识别为格式错误而不是崩掉', (value, expected) => {
    const params = buildTimeRangeParams({ start: value, end: parseDate('2026-09-30') })
    expect(params.error).toBe(expected)
  })

  it('非法结束值同样被识别', () => {
    expect(buildTimeRangeParams({ start: parseDate('2026-09-01'), end: 'not-a-date' }).error)
      .toBe('结束时间格式不合法，请重新选择')
  })

  it('非法结束 + 非法开始时先报开始（顺序稳定）', () => {
    expect(buildTimeRangeParams({ start: 'xx', end: 'yy' }).error).toBe('开始时间格式不合法，请重新选择')
  })

  it('接受 YYYY-MM-DD 字符串（与 CalendarDate 等价）', () => {
    expect(buildTimeRangeParams({ start: '2026-09-01', end: '2026-09-30' })).toEqual({
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-30 23:59:59',
      error: null,
    })
  })

  // `TimeRangeInput` 刻意接受整个 `DateValue` 联合（组件把 RangeCalendar 的回传值原样透传），
  // 收窄与校验因此必须**单点收口**在 `toCalendarDate`。下面两条就是这道闸门的回归测试：
  // 漏掉的话，带时刻的值会被悄悄取年月日，筛选区间看起来生效、实际时刻被丢弃。
  it('calendarDateTime（带 time 字段）被判非法，而不是悄悄取年月日', () => {
    const params = buildTimeRangeParams({ start: new CalendarDateTime(2026, 9, 30, 13, 45) })
    expect(params.error).toBe('开始时间格式不合法，请重新选择')
    expect(params).not.toHaveProperty('startTime')
  })

  it('zonedDateTime（带 time + timeZone）同样被判非法', () => {
    // ZonedDateTime 的构造签名是 (year, month, day, timeZone, offset, hour, …)，
    // timeZone 在**第 4 位**而不是最后一位——写错的话这里构造出来的东西并不是预期的时间值
    const params = buildTimeRangeParams({ end: new ZonedDateTime(2026, 9, 30, 'Asia/Shanghai', 8 * 60 * 60 * 1000, 23) })
    expect(params.error).toBe('结束时间格式不合法，请重新选择')
    expect(params).not.toHaveProperty('endTime')
  })

  it('纯 CalendarDate 仍正常通过（确认上一条没有把合法值一起拒掉）', () => {
    expect(buildTimeRangeParams({ start: parseDate('2026-09-01') })).toEqual({
      startTime: '2026-09-01 00:00:00',
      error: null,
    })
  })

  it('非对象的脏值（数字 / 布尔）不崩，判为格式错误', () => {
    expect(buildTimeRangeParams({ start: 20260901 as never }).error).toBe('开始时间格式不合法，请重新选择')
    expect(buildTimeRangeParams({ end: true as never }).error).toBe('结束时间格式不合法，请重新选择')
  })

  it('formatTimeRangeLabel 覆盖全部/单端/非法三种展示', () => {
    expect(formatTimeRangeLabel({})).toBe('全部时间')
    expect(formatTimeRangeLabel({ start: parseDate('2026-09-01') })).toBe('2026-09-01 ~ 不限')
    expect(formatTimeRangeLabel({ end: parseDate('2026-09-30') })).toBe('不限 ~ 2026-09-30')
    expect(formatTimeRangeLabel({ start: parseDate('2026-09-01'), end: parseDate('2026-09-30') }))
      .toBe('2026-09-01 ~ 2026-09-30')
    expect(formatTimeRangeLabel({ start: 'abc' })).toContain('格式不合法')
  })
})

describe('buildHistoryListQuery —— 契约 ⑰', () => {
  const filters = { keyword: '', range: {} }

  it('空筛选：只带分页', () => {
    expect(buildHistoryListQuery(filters, 1, 20)).toEqual({ query: { page: 1, pageSize: 20 }, timeError: null })
  })

  it('全部筛选项都能正确拼装', () => {
    const { query, timeError } = buildHistoryListQuery({
      policyId: 1001,
      level: ALARM_LEVEL.EMERGENCY,
      status: ALARM_HISTORY_STATUS.UNHANDLED,
      keyword: '  CPU  ',
      range: { start: parseDate('2026-09-01'), end: parseDate('2026-09-30') },
    }, 2, 50)

    expect(timeError).toBeNull()
    expect(query).toEqual({
      page: 2,
      pageSize: 50,
      policyId: 1001,
      level: 1,
      status: 1,
      keyword: 'CPU',
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-30 23:59:59',
    })
  })

  it('时间非法时仍返回可用的 query，但带 timeError（调用方据此不发请求）', () => {
    const { query, timeError } = buildHistoryListQuery({
      ...filters,
      range: { start: parseDate('2026-09-30'), end: parseDate('2026-09-01') },
    })

    expect(timeError).toContain('开始时间不能晚于结束时间')
    expect(query).not.toHaveProperty('startTime')
    expect(query).not.toHaveProperty('endTime')
  })

  it('非法枚举值被丢弃而不是透传（避免 422）', () => {
    const { query } = buildHistoryListQuery({
      ...filters,
      level: 99 as never,
      status: 0 as never,
    })

    expect(query).not.toHaveProperty('level')
    expect(query).not.toHaveProperty('status')
  })

  it('关键词去空格；超过 128 字被截断', () => {
    expect(buildHistoryListQuery({ ...filters, keyword: '   ' }).query).not.toHaveProperty('keyword')
    expect(buildHistoryListQuery({ ...filters, keyword: 'a'.repeat(200) }).query.keyword).toHaveLength(128)
  })

  it.each([
    ['abc', 1],
    [0, 1],
    [3, 3],
  ])('页码 %s → %s', (page, expected) => {
    expect(buildHistoryListQuery(filters, page).query.page).toBe(expected)
  })

  it.each([
    [0, 1],
    [1000, 100],
    ['abc', 20],
  ])('每页条数 %s → %s', (pageSize, expected) => {
    expect(clampPageSize(pageSize)).toBe(expected)
  })

  it('clampPage 对各种脏输入都回落到 1', () => {
    expect(clampPage(undefined)).toBe(1)
    expect(clampPage(NaN)).toBe(1)
    expect(clampPage('abc')).toBe(1)
  })
})

// ============================================================================
// 4. policyId query 容错
// ============================================================================

describe('parsePolicyIdQuery —— 路由 query 容错', () => {
  it('合法正整数字符串被接受', () => {
    expect(parsePolicyIdQuery('1001')).toBe(1001)
    expect(parsePolicyIdQuery(1001)).toBe(1001)
    expect(parsePolicyIdQuery('  1001  ')).toBe(1001)
    expect(parsePolicyIdQuery('1')).toBe(1)
  })

  it.each([
    ['abc', '字母'],
    ['', '空串'],
    ['   ', '纯空格'],
    [undefined, 'undefined'],
    [null, 'null'],
    ['0', '0'],
    ['-3', '负数'],
    ['1.5', '小数'],
    ['1e3', '科学计数法'],
    ['1001,1002', '逗号分隔'],
    ['9007199254740993', '超出安全整数'],
  // 第二列只是给 `it.each` 的标题模板用的说明文字，用 `_` 前缀显式声明「故意不接」
  ])('%s（%s）返回 undefined 而不抛异常', (value, _label) => {
    expect(() => parsePolicyIdQuery(value)).not.toThrow()
    expect(parsePolicyIdQuery(value)).toBeUndefined()
  })

  it('数组（vue-router 可能出现的形态）判为非法，不做 Number() 侥幸', () => {
    expect(parsePolicyIdQuery(['1'])).toBeUndefined()
    expect(parsePolicyIdQuery(['1', '2'])).toBeUndefined()
  })

  it('其他类型（对象/布尔/函数）也安全', () => {
    expect(parsePolicyIdQuery({} as never)).toBeUndefined()
    expect(parsePolicyIdQuery(true as never)).toBeUndefined()
    expect(parsePolicyIdQuery((() => 1) as never)).toBeUndefined()
  })

  it('非法 policyId 不会污染查询参数', () => {
    const { query } = buildHistoryListQuery({ policyId: 'abc', keyword: '', range: {} })
    expect(query).not.toHaveProperty('policyId')
  })
})

// ============================================================================
// 5. overview 统计兜底
// ============================================================================

describe('normalizeOverview —— ⑲ 统计兜底', () => {
  const healthy = {
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
    ],
  }

  function assertNoNaN(overview: ReturnType<typeof normalizeOverview>) {
    for (const [key, value] of Object.entries(overview)) {
      if (typeof value === 'number') {
        expect(Number.isNaN(value), `${key} 不应是 NaN`).toBe(false)
        expect(Number.isFinite(value), `${key} 应是有限数`).toBe(true)
      }
    }
    for (const item of overview.levelDistribution) {
      expect(Number.isFinite(item.count), `level ${item.level} 的 count 不应是 NaN`).toBe(true)
      expect(item.levelCn).toBeTruthy()
    }
    for (const point of overview.trend7Days) {
      expect(Number.isFinite(point.total)).toBe(true)
      expect(Number.isFinite(point.unhandled)).toBe(true)
    }
  }

  it('健康数据原样通过，不标记降级', () => {
    const overview = normalizeOverview(healthy)
    assertNoNaN(overview)

    expect(overview.degraded).toBe(false)
    expect(overview.degradedReason).toBeNull()
    expect(overview.todayTotal).toBe(27)
    expect(overview.levelDistribution).toHaveLength(3)
  })

  it('整个响应为 null / undefined / 非对象 → 全零兜底且标记降级', () => {
    for (const input of [null, undefined, 0, '', 'oops', [], true]) {
      const overview = normalizeOverview(input)
      assertNoNaN(overview)
      expect(overview.todayTotal).toBe(0)
      expect(overview.todayUnhandled).toBe(0)
      expect(overview.degraded).toBe(true)
      expect(overview.levelDistribution).toHaveLength(3)
    }
  })

  it('**字段缺失**（契约里这些是必填，但真实失败时可能缺）→ 补 0，不出 NaN', () => {
    const overview = normalizeOverview({})
    assertNoNaN(overview)

    expect(overview.todayTotal).toBe(0)
    expect(overview.todayUnhandled).toBe(0)
    expect(overview.policyTotal).toBe(0)
    expect(overview.policyEnabledTotal).toBe(0)
    expect(overview.degraded).toBe(true)
    expect(overview.degradedReason).toContain('todayTotal')
  })

  it.each([
    ['NaN 字符串', 'abc'],
    ['空串', ''],
    ['null', null],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['负数', -5],
  ])('非法计数（%s）→ 降级为 0 而非 NaN', (_label, value) => {
    const overview = normalizeOverview({ ...healthy, todayTotal: value })
    assertNoNaN(overview)
    expect(overview.todayTotal).toBe(0)
    expect(overview.degraded).toBe(true)
  })

  it('数字字符串（如 "27"）能被正确归一化', () => {
    const overview = normalizeOverview({ ...healthy, todayTotal: '27' })
    expect(overview.todayTotal).toBe(27)
    expect(overview.degraded).toBe(false)
  })

  it('levelDistribution 缺项 → 固定补齐 3 项、缺失补 0、中文名回落到契约 label', () => {
    const overview = normalizeOverview({ ...healthy, levelDistribution: [{ level: 2, count: 8 }] })
    assertNoNaN(overview)

    expect(overview.levelDistribution).toEqual([
      { level: 1, levelCn: '紧急', count: 0 },
      { level: 2, levelCn: '严重', count: 8 },
      { level: 3, levelCn: '提示', count: 0 },
    ])
  })

  it('levelDistribution 乱序 → 按 level 升序重排', () => {
    const overview = normalizeOverview({
      ...healthy,
      levelDistribution: [
        { level: 3, levelCn: '提示', count: 16 },
        { level: 1, levelCn: '紧急', count: 3 },
        { level: 2, levelCn: '严重', count: 8 },
      ],
    })

    expect(overview.levelDistribution.map(item => item.level)).toEqual([1, 2, 3])
    expect(overview.levelDistribution.map(item => item.count)).toEqual([3, 8, 16])
  })

  it('levelDistribution 含非法 level / 重复 level → 丢弃，不让计数翻倍', () => {
    const overview = normalizeOverview({
      ...healthy,
      levelDistribution: [
        { level: 1, levelCn: '紧急', count: 3 },
        { level: 1, levelCn: '紧急', count: 99 },
        { level: 9, levelCn: '不存在', count: 7 },
        { level: 2, levelCn: '严重', count: 8 },
        { level: 3, levelCn: '提示', count: 16 },
      ],
    })

    expect(overview.levelDistribution).toHaveLength(3)
    expect(overview.levelDistribution[0].count).toBe(3)
    expect(overview.levelDistribution.map(item => item.level)).toEqual([1, 2, 3])
  })

  it('levelCn 缺失 → 回落到契约中文名，不渲染空白', () => {
    const overview = normalizeOverview({
      ...healthy,
      levelDistribution: [{ level: 1, count: 3 }],
    })

    expect(overview.levelDistribution[0].levelCn).toBe('紧急')
  })

  it('trend7Days 非法/乱序 → 只保留合法点并按 date 升序', () => {
    const overview = normalizeOverview({
      ...healthy,
      trend7Days: [
        { date: '2026-09-30', total: 27, unhandled: 9 },
        { date: 'not-a-date', total: 1, unhandled: 1 },
        { date: '2026-09-24', total: 18, unhandled: 4 },
        { date: '2026-09-24', total: 999, unhandled: 9 },
        { date: '2026-09-25', total: 'abc', unhandled: 7 },
        null,
      ],
    })
    assertNoNaN(overview)

    expect(overview.trend7Days.map(point => point.date)).toEqual(['2026-09-24', '2026-09-25', '2026-09-30'])
    // 重复 date 只取首个，不会被 999 覆盖
    expect(overview.trend7Days[0].total).toBe(18)
    // 非法 count 归零
    expect(overview.trend7Days[1].total).toBe(0)
    expect(overview.trend7Days[1].unhandled).toBe(7)
    expect(overview.degraded).toBe(true)
  })

  it('trend7Days 非数组 → 空数组，不崩', () => {
    const overview = normalizeOverview({ ...healthy, trend7Days: 'oops' })
    expect(overview.trend7Days).toEqual([])
    assertNoNaN(overview)
  })

  it('createEmptyOverview 产出可直接渲染的全零结构', () => {
    const overview = createEmptyOverview('统计接口 500')
    assertNoNaN(overview)
    expect(overview.degraded).toBe(true)
    expect(overview.degradedReason).toBe('统计接口 500')
    expect(overview.levelDistribution.map(item => item.levelCn)).toEqual(['紧急', '严重', '提示'])
  })
})

// ============================================================================
// 6. 单元格格式化
// ============================================================================

describe('格式化', () => {
  it('actualValue 为 null（恢复类事件）时显示占位符，不显示 NaN', () => {
    expect(formatMetricValue(null, '%')).toBe('—')
    expect(formatMetricValue(undefined, '%')).toBe('—')
    expect(formatMetricValue(Number.NaN, '%')).toBe('—')
  })

  it('触发值按 DECIMAL(20,4) 归一：去尾随 0、带单位', () => {
    expect(formatMetricValue(96.4, '%')).toBe('96.4%')
    expect(formatMetricValue(96, '%')).toBe('96%')
    expect(formatMetricValue(96.123456, '%')).toBe('96.1235%')
    expect(formatMetricValue(90)).toBe('90')
  })

  it('持续时长：0 / null / 负数 / NaN 都显示占位符', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })

  it('持续时长按秒/分/小时/天分级', () => {
    expect(formatDuration(45)).toBe('45 秒')
    expect(formatDuration(90)).toBe('1 分 30 秒')
    expect(formatDuration(3720)).toBe('1 小时 2 分')
    expect(formatDuration(90000)).toBe('1 天 1 小时')
  })
})

// ============================================================================
// 7. 错误消息提取（409 可见提示）
// ============================================================================

describe('extractAlarmErrorMessage / isAlarmConflict / describeAlarmError', () => {
  it('真实 HTTP：ofetch 抛出的 FetchError（body 在 .data）能取出中文 message', () => {
    const error = Object.assign(new Error('fetch failed'), {
      data: { data: null, extra: {}, code: 409, message: '该告警已处理，不可重复处理', success: false },
    })

    expect(extractAlarmErrorMessage(error, '处理失败')).toBe('该告警已处理，不可重复处理')
    expect(isAlarmConflict(error)).toBe(true)
    expect(describeAlarmError(error, '处理失败')).toBe('该告警已处理，不可重复处理')
  })

  it('真实 HTTP：body 在 .response._data 时同样能取出', () => {
    const error = {
      response: {
        _data: { data: null, extra: {}, code: 409, message: '预置模板不可删除', success: false },
      },
    }

    expect(extractAlarmErrorMessage(error, 'x')).toBe('预置模板不可删除')
    expect(isAlarmConflict(error)).toBe(true)
  })

  it('mock 模式：resolve 的信封本身带 message 时也能取出', () => {
    const res = { data: null, extra: {}, code: 409, message: '模板已被策略引用，不可删除', success: false }
    expect(extractAlarmErrorMessage(res, '删除失败')).toBe('模板已被策略引用，不可删除')
  })

  it('取不到 message 时用兜底文案（不返回 undefined / 空串）', () => {
    expect(extractAlarmErrorMessage(new Error('boom'), '处理失败')).toBe('处理失败')
    expect(extractAlarmErrorMessage(undefined, '处理失败')).toBe('处理失败')
    expect(extractAlarmErrorMessage({}, '处理失败')).toBe('处理失败')
    expect(extractAlarmErrorMessage({ data: { message: '   ' } }, '处理失败')).toBe('处理失败')
  })

  it('非 409 错误不会误判为冲突', () => {
    const error = { data: { code: 500, message: '服务器内部错误', success: false } }
    expect(isAlarmConflict(error)).toBe(false)
    expect(describeAlarmError(error, '处理失败')).toBe('服务器内部错误')
  })

  it('契约 §0.5：409 是 5 个语义分支共用，统一按 code 判定', () => {
    const messages = ['已启用的策略不可删除，请先停用', '策略名称已存在', '模板已被策略引用，不可删除', '预置模板不可删除', '该告警已处理，不可重复处理']
    for (const message of messages) {
      const error = { data: { code: ALARM_ERROR_CODE.CONFLICT, message, success: false } }
      expect(isAlarmConflict(error)).toBe(true)
      expect(describeAlarmError(error, '兜底')).toBe(message)
    }
  })
})
