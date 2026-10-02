/**
 * 告警历史 —— 纯逻辑层（**不依赖 Vue / DOM，可直接单测**）。
 *
 * 唯一事实来源：`/workspace/docs/alarm/contract.md` v1.0。
 * 落地的契约条款：
 * - §0.3 分页 / §0.5 错误码（409 统一提示）/ §0.6 归一化
 * - §1.3 等级、§1.10 历史状态、§1.12 处理动作
 * - §2.6 `AlarmHistory`、⑲ `AlarmOverview`
 * - §3.3 ⑰ 查询参数（H4 `startTime <= endTime`）、⑱ 请求体（H1/H2）、§4.4 H1-H5
 *
 * 本文件是「页面不崩」的最后一道防线：query 参数、时间范围、统计字段全部先归一化，
 * 任何非法输入都降级成「不过滤」而不是把 `NaN` / `undefined` 透传给后端或渲染到界面上。
 */
import type { DateValue } from '@internationalized/date'

import { CalendarDate, parseDate } from '@internationalized/date'

import type {
  AlarmDate,
  AlarmDateTime,
  AlarmHandleAction,
  AlarmHistoryListQuery,
  AlarmHistoryStatus,
  AlarmLevel,
  AlarmLevelDistribution,
  AlarmTrendPoint,
} from '@/types/alarm'

import {
  ALARM_ERROR_CODE,
  ALARM_HANDLE_ACTION,
  ALARM_HANDLE_ACTION_LABEL,
  ALARM_HANDLE_ACTION_TO_STATUS,
  ALARM_HISTORY_STATUS,
  ALARM_HISTORY_STATUS_LABEL,
  ALARM_LEVEL,
  ALARM_LEVEL_LABEL,
} from '@/types/alarm'

// ============================================================================
// 常量
// ============================================================================

/** §0.3 分页边界。 */
export const PAGE_MIN = 1
export const PAGE_SIZE_MIN = 1
export const PAGE_SIZE_MAX = 100
export const PAGE_SIZE_DEFAULT = 20

/** §3.3 ⑰：`keyword` <=128。 */
export const KEYWORD_MAX_LENGTH = 128

/** H2：处理备注 <=500。 */
export const HANDLE_REMARK_MAX_LENGTH = 500

/** 契约 §0.1 的日期/时间格式正则。 */
export const ALARM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const ALARM_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** 契约 §1.3 的三个等级，按严重度升序（数值越小越严重）。 */
export const ALARM_LEVEL_VALUES: AlarmLevel[] = [
  ALARM_LEVEL.EMERGENCY,
  ALARM_LEVEL.SERIOUS,
  ALARM_LEVEL.NOTICE,
]

/** 契约 §1.10 的四个历史状态。 */
export const ALARM_HISTORY_STATUS_VALUES: AlarmHistoryStatus[] = [
  ALARM_HISTORY_STATUS.UNHANDLED,
  ALARM_HISTORY_STATUS.HANDLED,
  ALARM_HISTORY_STATUS.IGNORED,
  ALARM_HISTORY_STATUS.RECOVERED,
]

// ============================================================================
// 状态 / 等级展示映射
// ============================================================================

/** Badge 的语义变体，取值限定在 `src/components/ui/badge` 真实存在的四个。 */
export type HistoryBadgeVariant = 'destructive' | 'secondary' | 'outline' | 'default'

/**
 * 历史状态 → Badge 变体。**必须覆盖 `ALARM_HISTORY_STATUS` 的全部 4 个枚举**，
 * 少一个就会在表格里渲染出 `undefined`。测试里有「遍历全枚举」的断言兜底。
 */
export const HISTORY_STATUS_VARIANT: Record<AlarmHistoryStatus, HistoryBadgeVariant> = {
  [ALARM_HISTORY_STATUS.UNHANDLED]: 'destructive',
  [ALARM_HISTORY_STATUS.HANDLED]: 'secondary',
  [ALARM_HISTORY_STATUS.IGNORED]: 'outline',
  [ALARM_HISTORY_STATUS.RECOVERED]: 'default',
}

/** 状态中文名，未知值回落到 `未知状态(x)`，不返回 `undefined`。 */
export function historyStatusLabel(status: AlarmHistoryStatus): string {
  return ALARM_HISTORY_STATUS_LABEL[status] ?? `未知状态(${status})`
}

/** 等级中文名，未知值回落到 `未知等级(x)`（`alarm-level-badge.vue` 依赖 label 存在）。 */
export function alarmLevelLabel(level: AlarmLevel): string {
  return ALARM_LEVEL_LABEL[level] ?? `未知等级(${level})`
}

// ============================================================================
// 处理动作（契约 §1.12 / H1）
// ============================================================================

export interface HandleActionMeta {
  /** 契约动作值，**原样提交**，不本地化（§1.5 同样的原则） */
  action: AlarmHandleAction
  /** 契约 §1.12 的中文名（来自 `ALARM_HANDLE_ACTION_LABEL`，不二次定义） */
  actionLabel: string
  /** 按钮文案 */
  buttonLabel: string
  /** 弹窗说明 */
  description: string
  /** 该动作落库后的历史状态（§1.12 表格第三列） */
  resultStatus: AlarmHistoryStatus
}

/**
 * 处理动作清单。顺序 = 契约 §1.12 表格顺序：处理 / 忽略 / 恢复。
 * ⚠️ **只有这三个**（H1），历史记录没有删除端点（H5），不要加第四个动作。
 */
export const HANDLE_ACTIONS: HandleActionMeta[] = [
  {
    action: ALARM_HANDLE_ACTION.HANDLE,
    actionLabel: ALARM_HANDLE_ACTION_LABEL[ALARM_HANDLE_ACTION.HANDLE],
    buttonLabel: '处理',
    description: '确认已处理该告警，状态将变为「已处理」。',
    resultStatus: ALARM_HANDLE_ACTION_TO_STATUS[ALARM_HANDLE_ACTION.HANDLE],
  },
  {
    action: ALARM_HANDLE_ACTION.IGNORE,
    actionLabel: ALARM_HANDLE_ACTION_LABEL[ALARM_HANDLE_ACTION.IGNORE],
    buttonLabel: '忽略',
    description: '忽略该告警，状态将变为「已忽略」，且不可再转为「已处理」。',
    resultStatus: ALARM_HANDLE_ACTION_TO_STATUS[ALARM_HANDLE_ACTION.IGNORE],
  },
  {
    action: ALARM_HANDLE_ACTION.RECOVER,
    actionLabel: ALARM_HANDLE_ACTION_LABEL[ALARM_HANDLE_ACTION.RECOVER],
    buttonLabel: '标记已恢复',
    description: '标记该告警已恢复，服务端会回填恢复时间并按秒计算持续时长。',
    resultStatus: ALARM_HANDLE_ACTION_TO_STATUS[ALARM_HANDLE_ACTION.RECOVER],
  },
]

/** 按契约动作值查元信息；未知动作返回 `undefined`（调用方必须处理，不做静默兜底）。 */
export function findHandleAction(action: AlarmHandleAction): HandleActionMeta | undefined {
  return HANDLE_ACTIONS.find(item => item.action === action)
}

/**
 * ⑱ 请求体（契约 §3.3 ⑱ / H1 / H2）。
 *
 * `remark` 契约定义为「否，默认 `""`」，所以这里始终显式带上（而不是省略），
 * 避免后端对「字段缺失」与「空串」产生分歧。
 */
export function buildHandlePayload(action: AlarmHandleAction, remark?: string): { action: AlarmHandleAction, remark: string } {
  return {
    action,
    remark: (remark ?? '').trim(),
  }
}

/** H2 备注长度校验（<=500），合法返回 `null`。 */
export function validateHandleRemark(remark: string | undefined | null): string | null {
  const value = (remark ?? '').trim()
  return value.length > HANDLE_REMARK_MAX_LENGTH
    ? `处理备注不能超过 ${HANDLE_REMARK_MAX_LENGTH} 个字符`
    : null
}

/**
 * H3：**仅 `status=1`（未处理）的历史可处理**，否则后端返 409。
 * 前端据此禁用操作按钮——但**仍必须处理 409**（并发场景下别人可能已经处理过了）。
 */
export function canHandleHistory(status: AlarmHistoryStatus | null | undefined): boolean {
  return status === ALARM_HISTORY_STATUS.UNHANDLED
}

// ============================================================================
// 时间范围（契约 §3.3 ⑰ / H4）
// ============================================================================

/**
 * 时间范围输入。接受 `DateValue`（RangeCalendar 的原生类型 `CalendarDate` /
 * `CalendarDateTime` / `ZonedDateTime` 的联合），也接受 `YYYY-MM-DD` 字符串——
 * 后者是为了让**非法值**能被单测直接覆盖。
 *
 * 刻意**放宽**到整个 `DateValue` 联合而不是只收 `CalendarDate`：
 * 组件把 RangeCalendar 的回传值原样透传进来，**收窄/校验只由本文件的
 * `toCalendarDate` 一处负责**。否则类型收窄会散落到每个组件里，
 * 迟早漏掉一处，让带时刻的值悄悄被当成日历日用（区间会偏 0 天）。
 */
export interface TimeRangeInput {
  start?: DateValue | string | null
  end?: DateValue | string | null
}

export interface TimeRangeParams {
  /** 触发时间下界（含），`YYYY-MM-DD 00:00:00` */
  startTime?: AlarmDateTime
  /** 触发时间上界（含），`YYYY-MM-DD 23:59:59` */
  endTime?: AlarmDateTime
  /** 非空表示时间范围有本地校验问题，此时**不应带上 startTime/endTime 发请求**（否则必然 422） */
  error: string | null
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 把 `DateValue` / `YYYY-MM-DD` 字符串归一化成**纯日历日** `CalendarDate`；非法值返回 `null`。
 *
 * ⚠️ 刻意**不做时区换算**：契约 §0.1 的时间是 Asia/Shanghai 且**不带时区后缀**，
 * 而 RangeCalendar 给的是「日历日」而非时刻。这里直接按年月日拼字符串，
 * 既绕开了 `new Date()` 的时区陷阱，也让 `跨天` / `只选一端` 的语义保持直觉。
 *
 * ⚠️ 同时**拒绝** `CalendarDateTime` / `ZonedDateTime`：契约的 `startTime` / `endTime`
 * 是「自然日」粒度（`00:00:00` / `23:59:59`），带时刻的值如果只取年月日，
 * 就会**丢掉时刻却不报错**——用户以为筛的是某天，实际拿到的是整天。
 * 宁可明确判非法，也不要给一个看起来生效、实际被悄悄截断的筛选。
 *
 * 用 `instanceof CalendarDate` 而不是探测 `time` 字段：`@internationalized/date` 的
 * 三个类是**平级**的（`CalendarDateTime` 并非 `CalendarDate` 的子类），
 * 字段是各实例自己的可枚举属性、不是原型访问器，探测字段名反而依赖库的实现细节。
 */
function toCalendarDate(value: DateValue | string | null | undefined): CalendarDate | null {
  if (value === null || value === undefined)
    return null

  if (typeof value !== 'string') {
    if (value instanceof CalendarDate)
      return value

    // 非 `CalendarDate`（`CalendarDateTime` / `ZonedDateTime` / 脏数据）一律判非法
    return null
  }

  const trimmed = value.trim()
  if (!trimmed || !ALARM_DATE_PATTERN.test(trimmed))
    return null

  try {
    const parsed = parseDate(trimmed)
    // `parseDate` 对 `2026-02-30` 这类日期会溢出成 3 月，这里再回校一次原始文本
    return formatAlarmDate(parsed) === trimmed ? parsed : null
  }
  catch {
    return null
  }
}

/** `CalendarDate` → `YYYY-MM-DD`（契约 §0.1 的日期格式）。 */
export function formatAlarmDate(date: CalendarDate): AlarmDate {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`
}

/** 起始日 → `YYYY-MM-DD 00:00:00`（下界含当日 0 点）。 */
export function formatAlarmStartTime(date: CalendarDate): AlarmDateTime {
  return `${formatAlarmDate(date)} 00:00:00`
}

/** 结束日 → `YYYY-MM-DD 23:59:59`（上界含当日最后一秒）。 */
export function formatAlarmEndTime(date: CalendarDate): AlarmDateTime {
  return `${formatAlarmDate(date)} 23:59:59`
}

/**
 * 时间范围 → ⑰ 的 `startTime` / `endTime`。
 *
 * 覆盖的边界（都有单测）：
 * - 两端都选：跨天 / 同一天都合法，同一天不报错
 * - **只选一端**：只带 `startTime` 或只带 `endTime`（契约两个参数都是「否」= 可选）
 * - 两端都没选：两个参数都不带
 * - **开始晚于结束**（H4）：返回 `error`，且**不带任何时间参数**——宁可不过滤，
 *   也不发一个必然 422 的请求
 * - 非法值（`abc` / 空串 / 溢出日期）：返回 `error` 并忽略该端
 */
export function buildTimeRangeParams(range: TimeRangeInput | null | undefined): TimeRangeParams {
  const isUnset = (value: unknown) => value === null || value === undefined
  const rawStart = range?.start
  const rawEnd = range?.end
  // `null` / `undefined` = 「这一端没选」；其余值（包括空串 `''`）都视为「选了但可能非法」，
  // 由 `toCalendarDate` 判非法并给出明确文案——区分「没碰过」和「清空过」对用户是有意义的。
  const hasStart = !isUnset(rawStart)
  const hasEnd = !isUnset(rawEnd)

  if (!hasStart && !hasEnd)
    return { error: null }

  const start = hasStart ? toCalendarDate(rawStart) : null
  const end = hasEnd ? toCalendarDate(rawEnd) : null

  if (hasStart && !start)
    return { error: '开始时间格式不合法，请重新选择' }

  if (hasEnd && !end)
    return { error: '结束时间格式不合法，请重新选择' }

  const params: TimeRangeParams = { error: null }

  if (start)
    params.startTime = formatAlarmStartTime(start)

  if (end)
    params.endTime = formatAlarmEndTime(end)

  // H4：startTime <= endTime。ISO 格式字符串的字典序即时间序，可直接比较。
  if (params.startTime && params.endTime && params.startTime > params.endTime)
    return { error: '开始时间不能晚于结束时间' }

  return params
}

/** 时间范围的展示文案（筛选条上的回显）。 */
export function formatTimeRangeLabel(range: TimeRangeInput | null | undefined): string {
  const params = buildTimeRangeParams(range)
  if (params.error)
    return params.error
  if (!params.startTime && !params.endTime)
    return '全部时间'

  const start = params.startTime ? params.startTime.slice(0, 10) : '不限'
  const end = params.endTime ? params.endTime.slice(0, 10) : '不限'
  return `${start} ~ ${end}`
}

// ============================================================================
// ⑰ 查询参数
// ============================================================================

/** 筛选态。`undefined` 表示「全部」。 */
export interface HistoryFilterState {
  /**
   * 策略 id。
   *
   * 刻意放宽成 `number | string | null`：调用方拿到的是**路由 query 的原始值**
   * （`?policyId=abc` 一定是字符串），`buildHistoryListQuery` 内部会用
   * `parsePolicyIdQuery` 归一化。把放宽写在类型上，比在每个调用点写类型断言更诚实，
   * 也让「非法值会被丢弃」这条约束在类型层面可见。
   */
  policyId?: number | string | null
  level?: AlarmLevel
  status?: AlarmHistoryStatus
  keyword: string
  range: TimeRangeInput
}

/** 页码夹取到 §0.3 的合法区间。`abc` / `0` / `-1` / `NaN` 一律回落到 1。 */
export function clampPage(page: unknown): number {
  const value = Number(page)
  return Number.isInteger(value) && value >= PAGE_MIN ? value : PAGE_MIN
}

/** 每页条数夹取到 `[1, 100]`；非法值回落到默认 20。 */
export function clampPageSize(pageSize: unknown): number {
  const value = Number(pageSize)
  if (!Number.isFinite(value))
    return PAGE_SIZE_DEFAULT
  return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.trunc(value)))
}

/**
 * 路由 `?policyId=` 的容错解析。
 *
 * 契约 §0.1：主键是 **number（正整数）**。所以：
 * - 缺失 / `undefined` / 空串 / `abc` / `1.5` / `0` / `-3` / 超出安全整数 → 一律 `undefined`
 * - 合法时返回正整数
 *
 * 策略列表页「查看告警历史」跳转过来时可能拼错，这里**绝不抛异常**——筛选不上就当没传。
 */
export function parsePolicyIdQuery(value: unknown): number | undefined {
  if (value === null || value === undefined)
    return undefined

  // 路由 query 可能是 `string | string[] | null`；数组直接判非法，避免 `Number(['1','2'])` 得 NaN 的侥幸
  if (Array.isArray(value))
    return undefined

  if (typeof value !== 'string' && typeof value !== 'number')
    return undefined

  const text = String(value).trim()
  if (!text || !/^\d+$/.test(text))
    return undefined

  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < PAGE_MIN)
    return undefined

  return parsed
}

export interface HistoryListQueryResult {
  query: AlarmHistoryListQuery
  /** 时间范围的本地校验错误（H4 / 非法值），非空时**不应发请求 */
  timeError: string | null
}

/**
 * 筛选态 + 分页 → 契约 ⑰ 的查询参数。
 *
 * 归一化策略：
 * - 空关键词 / 非法枚举 / 非法 policyId 一律**不带**这个参数（契约「否」= 可选；
 *   非法枚举值会让后端返 422，前端宁可不过滤）
 * - 关键词超过 128 字直接截断（契约 ⑰ 规定 <=128）
 * - 时间范围非法时返回 `timeError`，且查询里不带时间参数
 */
export function buildHistoryListQuery(
  filters: HistoryFilterState,
  page: unknown = PAGE_MIN,
  pageSize: unknown = PAGE_SIZE_DEFAULT,
): HistoryListQueryResult {
  const query: AlarmHistoryListQuery = {
    page: clampPage(page),
    pageSize: clampPageSize(pageSize),
  }

  const policyId = parsePolicyIdQuery(filters?.policyId)
  if (policyId !== undefined)
    query.policyId = policyId

  if (filters?.level !== undefined && ALARM_LEVEL_VALUES.includes(filters.level))
    query.level = filters.level

  if (filters?.status !== undefined && ALARM_HISTORY_STATUS_VALUES.includes(filters.status))
    query.status = filters.status

  const keyword = (filters?.keyword ?? '').trim()
  if (keyword)
    query.keyword = keyword.slice(0, KEYWORD_MAX_LENGTH)

  const time = buildTimeRangeParams(filters?.range)
  if (time.error)
    return { query, timeError: time.error }

  if (time.startTime)
    query.startTime = time.startTime

  if (time.endTime)
    query.endTime = time.endTime

  return { query, timeError: null }
}

// ============================================================================
// ⑲ 统计兜底（接口失败 / 字段缺失时不能出现 NaN 或崩溃）
// ============================================================================

const MISSING = Symbol('missing')

/** 读一个计数字段；缺失 / 非有限数 / 负数一律判为「缺失」。 */
function readCountField(raw: unknown, key: string): number | typeof MISSING {
  if (!raw || typeof raw !== 'object')
    return MISSING

  const value = (raw as Record<string, unknown>)[key]
  if (value === null || value === undefined || value === '')
    return MISSING

  const num = typeof value === 'number' ? value : Number(value)
  // NaN / Infinity / 负数都算异常数据，交给上层降级为 0
  if (!Number.isFinite(num) || num < 0)
    return MISSING

  return num
}

export interface NormalizedOverview {
  todayTotal: number
  todayUnhandled: number
  policyTotal: number
  policyEnabledTotal: number
  /** 固定 3 项（level 升序 1/2/3），缺数据补 0 —— 契约 ⑲ 的硬约定 */
  levelDistribution: AlarmLevelDistribution[]
  /** 只保留**合法**的趋势点（date 合法 + total/unhandled 为有限数），按 date 升序 */
  trend7Days: AlarmTrendPoint[]
  /** true = 原始响应存在缺失/非法字段，已按兜底值展示 */
  degraded: boolean
  /** 降级原因（给 UI 提示用），`degraded=false` 时为 null */
  degradedReason: string | null
}

/** 统计接口彻底失败（网络错误 / `success=false`）时的全零兜底。 */
export function createEmptyOverview(reason = '统计数据加载失败'): NormalizedOverview {
  return {
    todayTotal: 0,
    todayUnhandled: 0,
    policyTotal: 0,
    policyEnabledTotal: 0,
    levelDistribution: ALARM_LEVEL_VALUES.map(level => ({
      level,
      levelCn: alarmLevelLabel(level),
      count: 0,
    })),
    trend7Days: [],
    degraded: true,
    degradedReason: reason,
  }
}

/**
 * 把 ⑲ 的响应归一化成**一定能安全渲染**的形状。
 *
 * 契约保证「`data` 恒为 `AlarmOverview`」，但真实世界的失败形态包括：
 * 字段缺失、`null`、`'abc'`、`NaN`、`Infinity`、负数、`levelDistribution` 乱序/缺项。
 * 这里的职责是：**任何一种情况都不产生 `NaN` / `undefined` 泄漏到模板里**。
 */
export function normalizeOverview(raw: unknown): NormalizedOverview {
  if (!raw || typeof raw !== 'object')
    return createEmptyOverview('统计数据格式异常')

  const reasons: string[] = []

  function readTopLevel(key: string): number {
    const value = readCountField(raw, key)
    if (value === MISSING) {
      reasons.push(key)
      return 0
    }
    return value
  }

  const todayTotal = readTopLevel('todayTotal')
  const todayUnhandled = readTopLevel('todayUnhandled')
  const policyTotal = readTopLevel('policyTotal')
  const policyEnabledTotal = readTopLevel('policyEnabledTotal')

  // ---- levelDistribution：固定 3 项，按 level 升序，缺失补 0 ----
  const rawDistribution = (raw as Record<string, unknown>).levelDistribution
  const distributionByLevel = new Map<AlarmLevel, { count: number, levelCn: string }>()

  if (Array.isArray(rawDistribution)) {
    for (const item of rawDistribution) {
      if (!item || typeof item !== 'object')
        continue
      const level = (item as Record<string, unknown>).level
      if (typeof level !== 'number' || !ALARM_LEVEL_VALUES.includes(level as AlarmLevel))
        continue
      if (distributionByLevel.has(level as AlarmLevel))
        continue // 同 level 重复项只取第一个，避免计数翻倍

      const count = readCountField(item, 'count')
      if (count === MISSING)
        reasons.push(`levelDistribution.${level}.count`)

      const levelCn = (item as Record<string, unknown>).levelCn

      distributionByLevel.set(level as AlarmLevel, {
        count: count === MISSING ? 0 : count,
        levelCn: typeof levelCn === 'string' && levelCn.trim() ? levelCn : alarmLevelLabel(level as AlarmLevel),
      })
    }
  }
  else if (rawDistribution !== undefined) {
    reasons.push('levelDistribution')
  }

  const levelDistribution: AlarmLevelDistribution[] = ALARM_LEVEL_VALUES.map((level) => {
    const hit = distributionByLevel.get(level)
    return {
      level,
      levelCn: hit?.levelCn ?? alarmLevelLabel(level),
      count: hit?.count ?? 0,
    }
  })

  // ---- trend7Days：只保留合法点，按 date 升序去重 ----
  const rawTrend = (raw as Record<string, unknown>).trend7Days
  const trendByDate = new Map<AlarmDate, AlarmTrendPoint>()

  if (Array.isArray(rawTrend)) {
    for (const item of rawTrend) {
      if (!item || typeof item !== 'object')
        continue
      const record = item as Record<string, unknown>
      const date = record.date
      if (typeof date !== 'string' || !ALARM_DATE_PATTERN.test(date.trim()) || trendByDate.has(date.trim()))
        continue

      const total = readCountField(item, 'total')
      const unhandled = readCountField(item, 'unhandled')
      if (total === MISSING || unhandled === MISSING)
        reasons.push(`trend7Days.${String(date).trim()}`)

      trendByDate.set(date.trim(), {
        date: date.trim(),
        total: total === MISSING ? 0 : total,
        unhandled: unhandled === MISSING ? 0 : unhandled,
      })
    }
  }
  else if (rawTrend !== undefined) {
    reasons.push('trend7Days')
  }

  const trend7Days = [...trendByDate.values()].sort((a, b) => a.date.localeCompare(b.date))

  return {
    todayTotal,
    todayUnhandled,
    policyTotal,
    policyEnabledTotal,
    levelDistribution,
    trend7Days,
    degraded: reasons.length > 0,
    degradedReason: reasons.length > 0 ? `以下字段异常并已按 0 展示：${[...new Set(reasons)].join('、')}` : null,
  }
}

// ============================================================================
// 单元格展示格式化
// ============================================================================

/** 触发值/阈值的展示。⚠️ `actualValue` 可以是 `null`（恢复类事件无实测值，契约 §2.6）。 */
export function formatMetricValue(value: number | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return '—'

  // DB 是 DECIMAL(20,4)，最多 4 位小数；去掉多余的尾随 0，`96.4000` → `96.4`
  const text = String(Number(value.toFixed(4)))
  return unit ? `${text}${unit}` : text
}

/** 持续时长（秒 → 人类可读）。未恢复时 `duration=0`，显示 `—`。 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return '—'

  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  if (days > 0)
    return `${days} 天 ${hours} 小时`
  if (hours > 0)
    return `${hours} 小时 ${minutes} 分`
  if (minutes > 0)
    return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

// ============================================================================
// 错误消息提取（契约 §0.5：409 有 5 个语义分支，前端按 code 统一提示，message 是中文文案）
// ============================================================================

/**
 * 只把**契约信封形状**的对象（同时带 `code` 或 `success`）当作业务错误来源。
 *
 * ⚠️ 绝不能直接读 `error.message`：`ofetch` 抛出的 `FetchError` 自己也带 `message`
 * （如 `'fetch failed'`），那不是给用户看的中文业务文案。若不加以形状约束，
 * 网络层错误信息会**顶掉**后端返回的「该告警已处理，不可重复处理」。
 */
function isEnvelopeLike(source: unknown): source is { code?: unknown, message?: unknown, success?: unknown } {
  if (!source || typeof source !== 'object')
    return false
  const record = source as { code?: unknown, success?: unknown }
  return typeof record.code === 'number' || typeof record.success === 'boolean'
}

function messageFrom(source: unknown): string | null {
  if (!isEnvelopeLike(source))
    return null
  const message = source.message
  return typeof message === 'string' && message.trim() ? message : null
}

function codeFrom(source: unknown): number | null {
  if (!isEnvelopeLike(source))
    return null
  return typeof source.code === 'number' && Number.isFinite(source.code) ? source.code : null
}

/** ofetch `FetchError` 与 mock 两种形态下，信封 body 可能挂在这几个位置。 */
function envelopeCandidates(error: unknown): unknown[] {
  return [
    error,
    (error as { data?: unknown })?.data,
    (error as { response?: { _data?: unknown } })?.response?._data,
  ]
}

/**
 * 从抛出的错误里取后端的中文 `message`。
 *
 * 两种失败形态都要覆盖：
 * 1. **真实 HTTP**：契约 §0.2「HTTP 状态码与 code 保持一致」，所以 409/422/404 在
 *    `ofetch` 里是**抛异常**（`FetchError.data` / `.response._data` = 信封 body）。
 * 2. **mock 模式**：`src/mocks` 直接 `return` 一个 `success:false` 的信封，不抛异常。
 */
export function extractAlarmErrorMessage(error: unknown, fallback: string): string {
  for (const candidate of envelopeCandidates(error)) {
    const message = messageFrom(candidate)
    if (message)
      return message
  }

  return fallback
}

/** 同上，但额外判断是不是 **409 冲突**（H3 非未处理 / N7 预置不可删 / N8 被引用 …）。 */
export function isAlarmConflict(error: unknown): boolean {
  return envelopeCandidates(error).some(candidate => codeFrom(candidate) === ALARM_ERROR_CODE.CONFLICT)
}

/** 把错误统一转成一句可展示的中文提示：409 用后端原文，其余用兜底文案。 */
export function describeAlarmError(error: unknown, fallback: string): string {
  return extractAlarmErrorMessage(error, fallback)
}
