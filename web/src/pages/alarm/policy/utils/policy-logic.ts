/**
 * 告警策略 —— 纯逻辑层（无 Vue、无请求、可直接单测）。
 *
 * 这里只放**可被单测击穿的业务规则**，页面/组件只负责调用与渲染：
 *
 * | 规则 | 函数 | 契约出处 |
 * | --- | --- | --- |
 * | 策略名 1-128 字符（去首尾空格） | `isValidPolicyName` / `normalizePolicyName` | P1 |
 * | 备注 <= 500 | `isValidPolicyRemark` | P2 |
 * | 触发条件 1-4 条（增删边界） | `canAddCondition` / `canRemoveCondition` / `describeConditionLimit` | P4 |
 * | 通知模板最多 3 个、不重复、须存在 | `validateNotificationTemplateIds` | P12 / P13 |
 * | 预置模板未配接收人不可绑定 | `isNotificationTemplateConfigured` / `findUnconfiguredNotificationTemplates` | N9 |
 * | `objectType` 与三个 object 字段一一对应 | `resolveObjectBinding` / `collectObjectBindingErrors` | P14 |
 * | monitorType ↔ policyType 联动 | `getPolicyTypeOptions` | P3 / §1.1 |
 * | 复制命名 `{原名} - 副本` | `buildCopyName` | §3.1 ⑦ |
 * | 回调 URL 格式 | `isValidCallbackUrl` | §3.1 ③ / N3 |
 * | 列表筛选 query 组装（空串视为未传） | `buildPolicyListQuery` | §3.1 ① |
 * | 条件摘要文案 | `describeCondition` / `buildConditionSummary` | §2.1 |
 * | 请求体组装（用 Payload 而非响应类型） | `buildPolicyPayload` | §0.6 / P10 / P18 |
 * | 启停乐观更新 + **失败回滚** | `applyOptimisticStatus` / `settleStatusToggle` | P19 |
 * | 删除前置校验（仅停用可删） | `canDeletePolicy` | P15 |
 * | 409 统一提示（用后端 message） | `isPolicyConflict` / `extractPolicyErrorMessage` / `describePolicyDeleteFailure` | §0.5 |
 *
 * ⚠️ **JSON 空值方向相反**（contract.md §0.6）：`notificationTemplateIds` 永远数组，
 * `objectIds` / `objectGroupIds` / `objectFilters` 永远 `null` 而不是 `[]`。
 * `resolveObjectBinding` 负责在提交前把不适用的字段强制收敛成 `null`（P14）。
 */

import type {
  AlarmConditionLogic,
  AlarmMonitorType,
  AlarmNotificationTemplate,
  AlarmObjectFilter,
  AlarmObjectType,
  AlarmPolicyCondition,
  AlarmPolicyConditionPayload,
  AlarmPolicyCreatePayload,
  AlarmPolicyListQuery,
  AlarmPolicyStatus,
  AlarmPolicyType,
} from '@/types/alarm'

import {
  ALARM_MONITOR_TYPE_POLICY_TYPES,
  ALARM_OBJECT_TYPE,
  ALARM_OBJECT_TYPE_LIMITS,
  ALARM_OPERATOR,
  ALARM_POLICY_STATUS,
} from '@/types/alarm'

// ============================================================================
// 契约常量（全部出自 /workspace/docs/alarm/contract.md）
// ============================================================================

/** P1：策略名去首尾空格后长度 1-128。 */
export const POLICY_NAME_MIN_LENGTH = 1
export const POLICY_NAME_MAX_LENGTH = 128

/** P2：备注 <= 500。 */
export const POLICY_REMARK_MAX_LENGTH = 500

/** P4：每策略触发条件 1-4 条。 */
export const MIN_CONDITIONS = 1
export const MAX_CONDITIONS = 4

/** P12：每策略最多绑定 3 个通知模板。 */
export const MAX_NOTIFICATION_TEMPLATES = 3

/** §3.1 ⑦：复制策略的名称后缀 ` - 副本`（含两侧空格共 5 个字符）。 */
export const COPY_NAME_SUFFIX = ' - 副本'

/** N3：回调地址 <= 500 字符。 */
export const CALLBACK_URL_MAX_LENGTH = 500

/** §1.7 / P14：三个 object 字段的条目上限。 */
export const MAX_OBJECT_IDS = 1000
export const MAX_OBJECT_GROUP_IDS = 100
export const MAX_OBJECT_FILTERS = 10

/** §1.7：`objectFilters[].values` 候选值 1-200 个。 */
export const MAX_OBJECT_FILTER_VALUES = 200

/** P7：持续周期 1-10 个数据点。 */
export const MIN_CONTINUITY = 1
export const MAX_CONTINUITY = 10

/** P6：阈值最多 4 位小数。 */
export const MAX_THRESHOLD_DECIMALS = 4

// ============================================================================
// P1 / P2 名称与备注
// ============================================================================

/** 去首尾空格（P1 明确要求按去空格后的长度判定）。 */
export function normalizePolicyName(name: string): string {
  return name.trim()
}

/** P1：1-128 字符。空串 / 全空白 / 超长都返回 false。 */
export function isValidPolicyName(name: string): boolean {
  const length = normalizePolicyName(name).length
  return length >= POLICY_NAME_MIN_LENGTH && length <= POLICY_NAME_MAX_LENGTH
}

/** P2：备注 <= 500。 */
export function isValidPolicyRemark(remark: string): boolean {
  return remark.length <= POLICY_REMARK_MAX_LENGTH
}

/**
 * §3.1 ⑦ 复制策略的名称生成：`{原名} - 副本`。
 *
 * ⚠️ 长度保护按**字符**计（契约原文：禁止按字节截断，否则会切出半截汉字）：
 * 拼接后总长必须 <= 128，故原名先按字符截到 `128 - 5 = 123`。
 *
 * @param sourceName 源策略名
 * @param seq 可选序号，`2` 起步时生成 ` - 副本(2)`（后缀 8 个字符）
 */
export function buildCopyName(sourceName: string, seq?: number): string {
  const base = normalizePolicyName(sourceName)
  const suffix = seq && seq > 1 ? `${COPY_NAME_SUFFIX}(${seq})` : COPY_NAME_SUFFIX
  const budget = POLICY_NAME_MAX_LENGTH - [...suffix].length
  // Array.from 按码点切分，不会把一个代理对/组合字符切成两半
  const truncated = [...base].slice(0, Math.max(0, budget)).join('')
  return `${truncated}${suffix}`
}

// ============================================================================
// P3 / §1.1 monitorType ↔ policyType 联动
// ============================================================================

/**
 * 取出当前 `monitorType` 允许的 `policyType` 列表。
 * monitorType 3/4/5 在 v1.0 没有可用策略类型，返回空数组（下拉无可选项）。
 */
export function getPolicyTypeOptions(monitorType?: AlarmMonitorType): AlarmPolicyType[] {
  if (monitorType === undefined || monitorType === null)
    return []
  return ALARM_MONITOR_TYPE_POLICY_TYPES[monitorType] ?? []
}

/** P3：`policyType` 是否属于当前 `monitorType`。 */
export function isPolicyTypeAllowed(monitorType: AlarmMonitorType, policyType: AlarmPolicyType): boolean {
  return getPolicyTypeOptions(monitorType).includes(policyType)
}

// ============================================================================
// P4 触发条件数量上下界
// ============================================================================

/** P4：是否还能新增条件（已到 4 条即拦）。 */
export function canAddCondition(count: number): boolean {
  return count < MAX_CONDITIONS
}

/** P4：是否还能删除条件（剩 1 条即拦，不允许删到 0）。 */
export function canRemoveCondition(count: number): boolean {
  return count > MIN_CONDITIONS
}

/** P4：数量是否在 1-4 闭区间内。 */
export function isValidConditionCount(count: number): boolean {
  return count >= MIN_CONDITIONS && count <= MAX_CONDITIONS
}

/**
 * P4：给用户看的边界提示（增删按钮的 tooltip / 越界 toast 文案）。
 * 例：`触发条件 4/4 条，已达契约上限（1-4 条）`。
 */
export function describeConditionLimit(count: number): string {
  if (count > MAX_CONDITIONS)
    return `触发条件 ${count}/${MAX_CONDITIONS} 条，已超过契约上限（1-${MAX_CONDITIONS} 条）`
  if (count < MIN_CONDITIONS)
    return `触发条件 ${count}/${MAX_CONDITIONS} 条，已低于契约下限（1-${MAX_CONDITIONS} 条）`
  if (count === MAX_CONDITIONS)
    return `触发条件 ${count}/${MAX_CONDITIONS} 条，已达契约上限（1-${MAX_CONDITIONS} 条）`
  return `触发条件 ${count}/${MAX_CONDITIONS} 条，契约要求 1-${MAX_CONDITIONS} 条`
}

// ============================================================================
// §2.1 条件文案（详情 / 确认页 / 列表摘要共用）
// ============================================================================

/** 阈值转字符串：整数不带小数点，非法值降级为 `-`。 */
export function formatThreshold(value: number): string {
  return Number.isFinite(value) ? String(value) : '-'
}

/**
 * 单条条件的可读文案，与契约 §2.6 `content` 的写法对齐（`operator` 原样取符号，不本地化）。
 * 例：`CPU 使用率 > 80%`；缺中文名时回落到 `CVM.CpuUtilizationRate`。
 */
export function describeCondition(condition: AlarmPolicyCondition): string {
  const metric = condition.metricNameCn || `${condition.metricNamespace}.${condition.metricName}`
  return `${metric} ${condition.operator} ${formatThreshold(condition.threshold)}${condition.unit ?? ''}`
}

/**
 * 条件摘要文案：多条时只取前 `limit` 条，后面跟「等 N 条」。
 *
 * - 0 条 → `暂无触发条件`（正常数据不会出现，P4 要求 1-4 条）
 * - <= limit 条 → 全部用 `；` 连接
 * - > limit 条 → `前 N 条；… 等 M 条`
 */
export function buildConditionSummary(conditions: AlarmPolicyCondition[], limit = 2): string {
  if (!conditions.length)
    return '暂无触发条件'
  const head = conditions.slice(0, Math.max(1, limit)).map(describeCondition).join('；')
  return conditions.length > limit ? `${head} 等 ${conditions.length} 条` : head
}

/** 列表页专用：列表接口不返回 conditions 明细（§2.2），只能用 `conditionCount` 概括。 */
export function buildConditionCountLabel(count: number): string {
  if (!count)
    return '暂无触发条件'
  return `共 ${count} 条触发条件`
}

// ============================================================================
// P14 objectType ↔ objectIds / objectGroupIds / objectFilters
// ============================================================================

/** 提交前必须收敛成 `null` 的不适用字段（契约 §0.6 R-JSON-1：响应里是 null，不是 []）。 */
export interface ResolvedObjectBinding {
  objectIds: number[] | null
  objectGroupIds: number[] | null
  objectFilters: AlarmObjectFilter[] | null
}

/**
 * P14 归一化：只有与 `objectType` 对应的字段保留值，其余一律置 `null`。
 * `objectType=1`（全部对象）时三个字段全为 `null`。
 */
export function resolveObjectBinding(
  objectType: AlarmObjectType,
  binding: Partial<ResolvedObjectBinding> = {},
): ResolvedObjectBinding {
  const limit = ALARM_OBJECT_TYPE_LIMITS[objectType]
  return {
    objectIds: limit.field === 'objectIds' ? (binding.objectIds ?? []) : null,
    objectGroupIds: limit.field === 'objectGroupIds' ? (binding.objectGroupIds ?? []) : null,
    objectFilters: limit.field === 'objectFilters' ? (binding.objectFilters ?? []) : null,
  }
}

/** P14：objectType 与配套字段一一对应，返回全部违规原因（空数组 = 合法）。 */
export function collectObjectBindingErrors(
  objectType: AlarmObjectType,
  binding: Partial<ResolvedObjectBinding> = {},
): string[] {
  const errors: string[] = []
  const limit = ALARM_OBJECT_TYPE_LIMITS[objectType]

  if (limit.field === null) {
    // 全部对象：三个字段必须为空，否则后端 422
    if (binding.objectIds?.length)
      errors.push('选择「全部对象」时不得指定实例（objectIds 必须为空）')
    if (binding.objectGroupIds?.length)
      errors.push('选择「全部对象」时不得指定实例分组（objectGroupIds 必须为空）')
    if (binding.objectFilters?.length)
      errors.push('选择「全部对象」时不得使用多维筛选（objectFilters 必须为空）')
    return errors
  }

  const value = binding[limit.field] as unknown[] | null | undefined
  const length = Array.isArray(value) ? value.length : 0
  if (length < limit.min) {
    errors.push(`「${objectTypeLabel(objectType)}」至少需要 ${limit.min} 项，当前 ${length} 项`)
    return errors
  }
  if (length > limit.max)
    errors.push(`「${objectTypeLabel(objectType)}」最多 ${limit.max} 项，当前 ${length} 项`)

  return errors
}

/** 告警对象类型中文名，缺枚举时降级为 `对象类型 x`。 */
export function objectTypeLabel(objectType: AlarmObjectType): string {
  return {
    [ALARM_OBJECT_TYPE.ALL]: '全部对象',
    [ALARM_OBJECT_TYPE.INSTANCE]: '指定实例',
    [ALARM_OBJECT_TYPE.GROUP]: '实例分组',
    [ALARM_OBJECT_TYPE.FILTER]: '多维筛选',
  }[objectType] ?? `对象类型 ${objectType}`
}

/** 告警对象摘要文案（列表「告警对象」列 / 详情「告警对象」区）。 */
export function buildObjectSummary(
  objectType: AlarmObjectType,
  binding: Partial<ResolvedObjectBinding> = {},
): string {
  const limit = ALARM_OBJECT_TYPE_LIMITS[objectType]
  if (limit.field === 'objectIds') {
    const count = binding.objectIds?.length ?? 0
    return count ? `指定实例 · ${count} 个` : '指定实例 · 未选择'
  }
  if (limit.field === 'objectGroupIds') {
    const count = binding.objectGroupIds?.length ?? 0
    return count ? `实例分组 · ${count} 个` : '实例分组 · 未选择'
  }
  if (limit.field === 'objectFilters') {
    const count = binding.objectFilters?.length ?? 0
    return count ? `多维筛选 · ${count} 条` : '多维筛选 · 未配置'
  }
  return '全部对象'
}

// ============================================================================
// P12 / P13 / N9 通知模板绑定
// ============================================================================

/**
 * N9：模板是否「配置完成」。
 *
 * 只要存在**非回调渠道**（`channel ≠ 5`）且该渠道 `receivers` 为空 → 视为未配置完成，
 * 禁止绑定。纯回调模板（只有 `channel=5`）不受此限制。
 */
export function isNotificationTemplateConfigured(template: AlarmNotificationTemplate): boolean {
  return !template.channels.some(
    channel => channel.channel !== 5 && channel.receivers.length === 0,
  )
}

/**
 * N9：筛出选中的模板里**未配置完成**的那些。
 * `templateMap` 由 ⑬ 列表接口的 `list` 构造（需要完整 `channels`，含接收人）。
 */
export function findUnconfiguredNotificationTemplates(
  selectedIds: number[],
  templateMap: Map<number, AlarmNotificationTemplate>,
): AlarmNotificationTemplate[] {
  return selectedIds
    .map(id => templateMap.get(id))
    .filter((template): template is AlarmNotificationTemplate => Boolean(template))
    .filter(template => !isNotificationTemplateConfigured(template))
}

/** N9：未配好接收人的模板名清单，用于 toast 文案。 */
export function describeUnconfiguredTemplates(templates: AlarmNotificationTemplate[]): string {
  return templates.map(template => template.name).join('、')
}

/**
 * P12 / P13：返回全部违规原因（空数组 = 合法）。
 * - 最多 3 个
 * - 不重复
 * - 传了的 id 必须能在 `templateMap` 中找到（存在性）
 */
export function validateNotificationTemplateIds(
  ids: number[],
  templateMap?: Map<number, AlarmNotificationTemplate>,
): string[] {
  const errors: string[] = []
  if (ids.length > MAX_NOTIFICATION_TEMPLATES)
    errors.push(`通知模板最多绑定 ${MAX_NOTIFICATION_TEMPLATES} 个，当前 ${ids.length} 个`)

  const seen = new Set<number>()
  const duplicated = ids.filter((id) => {
    if (seen.has(id))
      return true
    seen.add(id)
    return false
  })
  if (duplicated.length)
    errors.push(`通知模板不可重复绑定（重复：${duplicated.join('、')}）`)

  if (templateMap) {
    const missing = ids.filter(id => !templateMap.has(id))
    if (missing.length)
      errors.push(`通知模板不存在：${missing.join('、')}`)
  }

  return errors
}

/** P12：新增一个通知模板是否越界（用于多选的即时拦截）。 */
export function canAddNotificationTemplate(count: number): boolean {
  return count < MAX_NOTIFICATION_TEMPLATES
}

/**
 * 第 3 步的**全部**通知侧校验（P12 / P13 / N9 一次跑完，空数组 = 可提交）。
 * 存在性与 N9 依赖 ⑬ 拉回来的运行时字典，所以是函数而不是 zod schema。
 */
export function collectNotificationBindingErrors(
  ids: number[],
  templateMap: Map<number, AlarmNotificationTemplate>,
): string[] {
  const unconfigured = findUnconfiguredNotificationTemplates(ids, templateMap)
  if (unconfigured.length) {
    return [
      ...validateNotificationTemplateIds(ids, templateMap),
      `以下通知模板未配置接收人，请先在「通知模板」中补充：${describeUnconfiguredTemplates(unconfigured)}`,
    ]
  }
  return validateNotificationTemplateIds(ids, templateMap)
}

// ============================================================================
// §3.1 ③ 回调 URL
// ============================================================================

/** `http(s)://` 开头且 <= 500 字符。空串视为「未填」（不校验）。 */
export function isValidCallbackUrl(url: string): boolean {
  if (!url)
    return true
  return /^https?:\/\/.+/i.test(url.trim()) && url.trim().length <= CALLBACK_URL_MAX_LENGTH
}

// ============================================================================
// 列表行操作：启停乐观更新 + 回滚、删除前置校验、409 提示（§0.5 / P15 / P19）
//
// 这些是**行级交互状态机**，抽成纯函数才能被单测真正击穿——
// 写在 `index.vue` 里的话，「失败必须回滚」这条只能靠人肉点页面验证。
// ============================================================================

/** 契约响应信封里，本节只用到这三个字段。 */
export interface PolicyActionResponse {
  success: boolean
  /** 业务错误码，0 = 成功（§0.5） */
  code?: number
  /** 中文可读文案，可直接展示（§0.2 约束 3） */
  message?: string
}

/** 启停目标状态的中文动词（用于 toast 标题）。 */
export function statusActionLabel(next: AlarmPolicyStatus): string {
  return next === ALARM_POLICY_STATUS.ENABLED ? '启用' : '停用'
}

/**
 * ⑥ 启停的**乐观更新**：立刻把行状态改成目标值，并返回**原值**供失败时回滚。
 *
 * 必须与 `settleStatusToggle` 成对使用：先乐观改，再拿响应结算。
 * 单独调用会留下「界面显示已启用、实际没改」的脏状态。
 */
export function applyOptimisticStatus<T extends { status: AlarmPolicyStatus }>(
  policy: T,
  next: AlarmPolicyStatus,
): AlarmPolicyStatus {
  const previous = policy.status
  policy.status = next
  return previous
}

/** 启停结算结果。 */
export interface StatusToggleOutcome {
  /** 结算后行上**最终应当呈现**的状态（失败时等于回滚后的原值） */
  status: AlarmPolicyStatus
  /** 成功：true；失败：false */
  ok: boolean
  /** 失败时为 true（已执行回滚）；成功时为 false */
  rolledBack: boolean
  /** 展示给用户的中文原因；成功时为空串 */
  message: string
  /** ⑥ 返回的完整详情里的 `updatedAt`，成功且后端有返回时用它刷新行 */
  updatedAt?: string
}

/**
 * ⑥ 启停的**结算**：按响应决定「保留乐观值」还是「回滚」。
 *
 * ⚠️ 回滚是**硬要求**：乐观更新只服务于「点下去手感快」，一旦请求失败而界面还停在
 * 新值，用户会以为策略真的启用了，直到告警不来才发觉——比慢 200ms 严重得多。
 *
 * ⚠️ `context.next` 显式传入**用户点的那个目标状态**，而不是就地读 `policy.status`：
 * 回滚后 `policy.status` 已经变回原值，据此生成兜底文案会把「停用失败」说成「启用失败」。
 */
export function settleStatusToggle<T extends { status: AlarmPolicyStatus, updatedAt?: string }>(
  policy: T,
  context: {
    /** 用户点的目标状态 */
    next: AlarmPolicyStatus
    /** 乐观更新前的原值 */
    previous: AlarmPolicyStatus
    res: PolicyActionResponse
    /** ⑥ 返回的完整详情里的 `updatedAt` */
    updatedAt?: string
  },
): StatusToggleOutcome {
  const { next, previous, res, updatedAt } = context

  if (res.success)
    return { status: next, ok: true, rolledBack: false, message: '', updatedAt }

  policy.status = previous // 回滚：把界面拉回真实状态
  return {
    status: previous,
    ok: false,
    rolledBack: true,
    message: extractPolicyErrorMessage(res, `${statusActionLabel(next)}策略失败`),
  }
}

/** 契约 §0.5：`409` 下 5 个语义分支共用，前端只按 code 统一提示，message 区分文案。 */
export function isPolicyConflict(res: PolicyActionResponse | null | undefined): boolean {
  return res?.code === 409
}

/**
 * 提取展示文案：**优先用后端 `message`**（§0.2 约束 3：中文可读，可直接弹窗）。
 * 后端没给 message 时才退回调用方的兜底文案，绝不展示空串。
 */
export function extractPolicyErrorMessage(
  res: PolicyActionResponse | null | undefined,
  fallback: string,
): string {
  const message = res?.message?.trim()
  return message || fallback
}

/**
 * ⑤ 删除的**前置校验**（P15）。
 *
 * 仅 `status=0`（停用）可删，`status=1` 时后端必返 409。
 * 前端先拦一次是体验优化，**但仍必须处理 409**——列表数据是旧的，
 * 别人可能刚刚启用了这条策略。
 */
export function canDeletePolicy(status: AlarmPolicyStatus): boolean {
  return status === ALARM_POLICY_STATUS.DISABLED
}

/** ⑤ 删除失败时的完整提示（409 用后端 message，不静默失败）。 */
export function describePolicyDeleteFailure(
  res: PolicyActionResponse | null | undefined,
  fallback = '删除策略失败',
): { title: string, message: string } {
  return {
    title: isPolicyConflict(res) ? '策略无法删除' : fallback,
    message: extractPolicyErrorMessage(res, fallback),
  }
}

// ============================================================================
// §3.1 ① 列表筛选 query 组装
// ============================================================================
/** 列表页筛选表单的原始形状（可能带空串 / undefined / 字符串形式的数字）。 */
export interface PolicyListFilters {
  keyword?: string
  monitorType?: number
  policyType?: number
  status?: number
  level?: number
  projectId?: number | string
}

export interface PolicyListPagination {
  pageIndex: number
  pageSize: number
}

/**
 * 组装 ① 的 query：契约明确「空字符串视为未传（不参与筛选）」，非法枚举值会 422，
 * 所以这里只透传**有值且为合法数字**的项，页码从 0 起始换算成 1 起始。
 */
export function buildPolicyListQuery(
  filters: PolicyListFilters,
  pagination: PolicyListPagination,
): AlarmPolicyListQuery {
  const query: AlarmPolicyListQuery = {
    page: pagination.pageIndex + 1,
    pageSize: pagination.pageSize,
  }

  const keyword = filters.keyword?.trim()
  if (keyword)
    query.keyword = keyword

  const numeric = (value: number | string | undefined): number | undefined => {
    if (value === undefined || value === null || value === '')
      return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const monitorType = numeric(filters.monitorType)
  if (monitorType !== undefined)
    query.monitorType = monitorType as AlarmPolicyListQuery['monitorType']

  const policyType = numeric(filters.policyType)
  if (policyType !== undefined)
    query.policyType = policyType as AlarmPolicyListQuery['policyType']

  const status = numeric(filters.status)
  if (status !== undefined)
    query.status = status as AlarmPolicyListQuery['status']

  const level = numeric(filters.level)
  if (level !== undefined)
    query.level = level as AlarmPolicyListQuery['level']

  const projectId = numeric(filters.projectId)
  if (projectId !== undefined)
    query.projectId = projectId

  return query
}

// ============================================================================
// §2.1 / P10 / P18 请求体组装
// ============================================================================

/** 条件编辑器持有的行形态：响应字段全量 + 前端行 key（`metricNameCn`/`unit` 供回显，不参与提交校验）。 */
export type PolicyConditionFormItem = AlarmPolicyCondition & { _key: string }

/** 策略表单值（表单态，`_key` 之类的 UI 字段只在这里出现）。 */
export interface PolicyFormValues {
  name: string
  remark: string
  monitorType?: AlarmMonitorType
  policyType?: AlarmPolicyType
  projectId: number
  objectType: AlarmObjectType
  objectIds: number[]
  objectGroupIds: number[]
  objectFilters: AlarmObjectFilter[]
  conditionLogic: AlarmConditionLogic
  conditions: PolicyConditionFormItem[]
  notificationTemplateIds: number[]
  callbackUrl: string
  conditionTemplateId: number
  status: AlarmPolicyStatus
}

/** 空表单的初始值（新建态）。 */
export function createEmptyPolicyFormValues(): PolicyFormValues {
  return {
    name: '',
    remark: '',
    monitorType: undefined,
    policyType: undefined,
    projectId: 0,
    objectType: ALARM_OBJECT_TYPE.ALL,
    objectIds: [],
    objectGroupIds: [],
    objectFilters: [],
    conditionLogic: 1,
    conditions: [],
    notificationTemplateIds: [],
    callbackUrl: '',
    conditionTemplateId: 0,
    status: ALARM_POLICY_STATUS.DISABLED,
  }
}

/** 生成一条空白条件（指标未选，字段留空由校验拦）。 */
export function createEmptyCondition(key: string, sort: number): PolicyConditionFormItem {
  return {
    _key: key,
    sort: sort as PolicyConditionFormItem['sort'],
    metricNamespace: '',
    metricName: '',
    metricNameCn: '',
    unit: '',
    operator: ALARM_OPERATOR.GT,
    threshold: Number.NaN,
    period: 5,
    continuity: 1,
    level: 3,
    frequency: 0,
  }
}

/**
 * 单条条件 → **请求体**形态（`AlarmPolicyConditionPayload`）。
 *
 * ⚠️ 契约红线：`id` 是响应专用，提交了就是漂移；`metricNameCn` / `unit` 虽允许带上（便于回显），
 * 但这里只提交 P10 要求的 9 个必填字段，与契约 ③ 的官方示例请求体完全一致。
 */
export function toConditionPayload(
  condition: PolicyConditionFormItem,
  sort: number,
): AlarmPolicyConditionPayload {
  return {
    sort: sort as AlarmPolicyConditionPayload['sort'],
    metricNamespace: condition.metricNamespace,
    metricName: condition.metricName,
    operator: condition.operator,
    threshold: condition.threshold,
    period: condition.period,
    continuity: condition.continuity,
    level: condition.level,
    frequency: condition.frequency,
  }
}

/** 响应条件 → 表单行（回填时必须**丢弃 `id`**，否则 PUT 会把响应专用字段带上去）。 */
export function toConditionFormItem(condition: AlarmPolicyCondition, key: string): PolicyConditionFormItem {
  return {
    _key: key,
    sort: condition.sort,
    metricNamespace: condition.metricNamespace,
    metricName: condition.metricName,
    metricNameCn: condition.metricNameCn,
    unit: condition.unit,
    operator: condition.operator,
    threshold: condition.threshold,
    period: condition.period,
    continuity: condition.continuity,
    level: condition.level,
    frequency: condition.frequency,
  }
}

/**
 * P18：PUT 是**全量更新**语义，编辑提交必须带完整表单（含全部 conditions），
 * 且 `sort` 重排为 1..N 连续升序（P5）。`status` 在 update 模式下**故意省略**——
 * 契约规定 PUT 省略 `status` 时保持原值不变，启停只能走 ⑥。
 */
export function buildPolicyPayload(
  values: PolicyFormValues,
  mode: 'create' | 'update',
): AlarmPolicyCreatePayload {
  const binding = resolveObjectBinding(values.objectType, {
    objectIds: values.objectIds,
    objectGroupIds: values.objectGroupIds,
    objectFilters: values.objectFilters,
  })

  const payload: AlarmPolicyCreatePayload = {
    name: normalizePolicyName(values.name),
    remark: values.remark ?? '',
    monitorType: values.monitorType!,
    policyType: values.policyType!,
    projectId: values.projectId ?? 0,
    objectType: values.objectType,
    objectIds: binding.objectIds,
    objectGroupIds: binding.objectGroupIds,
    objectFilters: binding.objectFilters,
    conditionLogic: values.conditionLogic,
    conditions: values.conditions.map((condition, index) => toConditionPayload(condition, index + 1)),
    // §0.6 R-JSON-2：永远提交数组（后端把 null/[] 都落库为 NULL）
    notificationTemplateIds: [...values.notificationTemplateIds],
    conditionTemplateId: values.conditionTemplateId ?? 0,
  }

  if (mode === 'create')
    payload.status = values.status
  // update 模式：省略 status，走 ⑥ 端点启停（P18）

  return payload
}
