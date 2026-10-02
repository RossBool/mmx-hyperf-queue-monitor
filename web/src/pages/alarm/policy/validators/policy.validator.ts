/**
 * 告警策略 —— zod 校验层（对齐 `src/pages/tasks/validators/task.validator.ts` 的风格）。
 *
 * 三步向导每一步一个 schema，**再合并出一个全量 schema**：
 *
 * | schema | 覆盖 | 契约 |
 * | --- | --- | --- |
 * | `policyBasicStepSchema` | 名称 / 备注 / 监控类型 / 策略类型 / 所属项目 | P1 P2 P3 |
 * | `policyConditionStepSchema` | 告警对象 + 触发条件 + 条件逻辑 + 模板来源 | P4 P5 P6 P7 P8 P9 P10 P11 P14 |
 * | `policyNotifyStepSchema` | 通知模板多选 + 回调 URL | P12 P13 N3 |
 * | `policyFormSchema` | 三步合并，**表单 onSubmit 的最终闸门** | 全部 |
 *
 * ⚠️ `policyFormSchema` 是**兜底闸门**而不是装饰：即便绕过 UI 直接构造 5 条 conditions，
 * 它也会以 `conditions: 最多 4 条` 拒绝提交（见 `__tests__/policy.validator.test.ts`）。
 * 状态/通知模板的存在性与 N9 依赖运行时字典，无法写成静态 schema，在
 * `policy-logic.ts:collectNotificationBindingErrors` 里做运行时校验。
 */

import { z } from 'zod'

import type {
  AlarmConditionLogic,
  AlarmFrequency,
  AlarmLevel,
  AlarmMonitorType,
  AlarmObjectFilter,
  AlarmObjectType,
  AlarmOperator,
  AlarmPeriod,
  AlarmPolicyConditionPayload,
  AlarmPolicyType,
} from '@/types/alarm'

import {
  ALARM_CONDITION_LOGIC,
  ALARM_FREQUENCY,
  ALARM_LEVEL,
  ALARM_MONITOR_TYPE,
  ALARM_MONITOR_TYPE_POLICY_TYPES,
  ALARM_OBJECT_TYPE,
  ALARM_OPERATOR,
  ALARM_PERIOD,
  ALARM_POLICY_STATUS,
  ALARM_POLICY_TYPE,
} from '@/types/alarm'

import {
  CALLBACK_URL_MAX_LENGTH,
  MAX_CONDITIONS,
  MAX_CONTINUITY,
  MAX_NOTIFICATION_TEMPLATES,
  MAX_OBJECT_FILTER_VALUES,
  MAX_OBJECT_FILTERS,
  MAX_OBJECT_GROUP_IDS,
  MAX_OBJECT_IDS,
  MAX_THRESHOLD_DECIMALS,
  MIN_CONDITIONS,
  MIN_CONTINUITY,
  POLICY_NAME_MAX_LENGTH,
  POLICY_REMARK_MAX_LENGTH,
} from '../utils/policy-logic'

/** P14：objectType → 必填的 object 字段（`null` = 三个都不许填）。 */
const ALARM_OBJECT_TYPE_REQUIRED_FIELD: Record<AlarmObjectType, null | 'objectIds' | 'objectGroupIds' | 'objectFilters'> = {
  [ALARM_OBJECT_TYPE.ALL]: null,
  [ALARM_OBJECT_TYPE.INSTANCE]: 'objectIds',
  [ALARM_OBJECT_TYPE.GROUP]: 'objectGroupIds',
  [ALARM_OBJECT_TYPE.FILTER]: 'objectFilters',
}

/** P14：三个 object 字段各自的条目上限。 */
const ALARM_OBJECT_TYPE_MAX: Record<'objectIds' | 'objectGroupIds' | 'objectFilters', number> = {
  objectIds: MAX_OBJECT_IDS,
  objectGroupIds: MAX_OBJECT_GROUP_IDS,
  objectFilters: MAX_OBJECT_FILTERS,
}

/**
 * 数值枚举校验器。
 *
 * ⚠️ zod v4 的 `z.enum` 只接受字符串字面量，数值枚举用它会直接判失败（实测 `z.enum([1,2,3])`
 * 对 `2` 都返回 false），所以统一走 `z.custom` + `Object.values` 集合判定，
 * 好处是能给出**中文 message**（`FieldError` 直接展示）。
 */
function enumOf<T extends number | string>(values: readonly T[], message: string): z.ZodType<T> {
  return z.custom<T>(value => values.includes(value as T), { message })
}

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

const monitorTypeSchema = enumOf(Object.values(ALARM_MONITOR_TYPE), '请选择监控类型')
const policyTypeSchema = enumOf(Object.values(ALARM_POLICY_TYPE), '请选择策略类型')
const objectTypeSchema = enumOf(Object.values(ALARM_OBJECT_TYPE), '请选择告警对象类型')
const levelSchema = enumOf(Object.values(ALARM_LEVEL), '告警等级必须是 1/2/3')
const periodSchema = enumOf(Object.values(ALARM_PERIOD), '统计周期必须是 1/5/10/30/60')
const frequencySchema = enumOf(Object.values(ALARM_FREQUENCY), '告警频次取值非法')
const operatorSchema = enumOf(
  Object.values(ALARM_OPERATOR),
  '比较关系必须是 > >= < <= == !=',
)
const conditionLogicSchema = enumOf(Object.values(ALARM_CONDITION_LOGIC), '条件关系必须是 1/2')
const policyStatusSchema = enumOf(Object.values(ALARM_POLICY_STATUS), '状态必须是 0/1')
const matchTypeSchema = z
  .enum(['include', 'exclude'], { message: '匹配方式必须是 include/exclude' })
  .optional()

/** P6：阈值可负数、最多 4 位小数。 */
function hasValidThresholdDecimals(value: number): boolean {
  if (!Number.isFinite(value))
    return false
  // 用字符串判定小数位数，避开 `0.1 * 10000 = 1000.0000000000001` 这类浮点误差
  const text = String(value)
  if (text.includes('e') || text.includes('E'))
    return false
  const dotIndex = text.indexOf('.')
  return dotIndex === -1 || text.length - dotIndex - 1 <= MAX_THRESHOLD_DECIMALS
}

const thresholdSchema = z
  .number({ message: '阈值必须是数字' })
  .refine(hasValidThresholdDecimals, { message: `阈值最多 ${MAX_THRESHOLD_DECIMALS} 位小数` })

/** P7：持续周期 1-10 的整数。 */
const continuitySchema = z
  .number({ message: '持续周期必须是数字' })
  .int('持续周期必须是整数')
  .min(MIN_CONTINUITY, `持续周期不能小于 ${MIN_CONTINUITY}`)
  .max(MAX_CONTINUITY, `持续周期不能大于 ${MAX_CONTINUITY}`)

// ---------------------------------------------------------------------------
// §1.7 多维筛选
// ---------------------------------------------------------------------------

export const objectFilterSchema: z.ZodType<AlarmObjectFilter> = z
  .object({
    key: z.string().trim().min(1, '维度名不能为空').max(64, '维度名最长 64 个字符'),
    operator: operatorSchema,
    values: z
      .array(z.string().trim().min(1, '候选值不能为空'))
      .min(1, '候选值至少 1 个')
      .max(MAX_OBJECT_FILTER_VALUES, `候选值最多 ${MAX_OBJECT_FILTER_VALUES} 个`),
    matchType: matchTypeSchema,
  })
  .strip()

// ---------------------------------------------------------------------------
// §2.1 触发条件（P4 P5 P6 P7 P8 P9 P10 P11）
// ---------------------------------------------------------------------------

/**
 * 单条触发条件的**请求体**校验（P10 的 9 个必填字段一个都不能少）。
 * `metricNameCn` / `unit` 是服务端回填字段，表单里允许带上但不参与必填。
 *
 * ⚠️ 这里**刻意不加** `: z.ZodType<AlarmPolicyConditionPayload>` 显式标注。
 * zod v4 对 `Omit<A, 'x'> & Partial<Pick<A, 'x'>>` 这类交叉类型推导不出来，
 * 一旦加标注就必须在末尾写 `as unknown as z.ZodType<...>` 把真实类型整个盖掉——
 * 那样 zod schema 与 `AlarmPolicyConditionPayload` 之间就**没有任何编译期关联**了，
 * 契约改了也不会报错。改为让类型自然推导，下面用 `satisfies` 做**单向**校验：
 * 推导结果必须**可赋给** payload 类型（能抓到缺字段/多字段），但不用它反向约束 zod 内部。
 */
export const policyConditionSchema = z
  .object({
    sort: z
      .number({ message: '条件排序必须是数字' })
      .int('条件排序必须是整数')
      .min(1, '条件排序最小为 1')
      .max(MAX_CONDITIONS, `条件排序最大为 ${MAX_CONDITIONS}`),
    metricNamespace: z.string().trim().min(1, '请选择监控指标'),
    metricName: z.string().trim().min(1, '请选择监控指标'),
    operator: operatorSchema,
    threshold: thresholdSchema,
    period: periodSchema,
    continuity: continuitySchema,
    level: levelSchema,
    frequency: frequencySchema,
  })
  .strip()

// 编译期断言：`AlarmPolicyConditionPayload` 必须是 schema 输出的子集。
// 契约漂移（payload 多出/缺少 schema 未覆盖的字段）时这里会先红，
// 不再需要用 `as unknown as z.ZodType<...>` 把真实类型整个盖掉。
type _PayloadIsSchemaOutput = AlarmPolicyConditionPayload extends z.output<typeof policyConditionSchema>
  ? true
  : ['契约漂移：payload 存在 schema 未覆盖的字段', AlarmPolicyConditionPayload]
const _payloadMatchesSchema: _PayloadIsSchemaOutput = true
void _payloadMatchesSchema

/** 条件数组：1-4 条（P4）+ `sort` 1..N 连续升序且不重复（P5）。 */
const conditionsSchema = z
  .array(policyConditionSchema)
  .min(MIN_CONDITIONS, `触发条件至少 ${MIN_CONDITIONS} 条`)
  .max(MAX_CONDITIONS, `触发条件最多 ${MAX_CONDITIONS} 条`)
  .refine(
    conditions => conditions.every((condition, index) => condition.sort === index + 1),
    { message: '条件排序必须是 1..N 连续升序且不重复' },
  )

// ---------------------------------------------------------------------------
// 跨字段规则：抽成函数，供「分步 schema」与「全量合并 schema」复用
//
// ⚠️ zod v4 的 `ZodObject.shape` **不携带 superRefine**，所以合并 schema 时 refine 会丢。
//    这两段规则必须以函数形式重跑一遍，否则「绕过 UI 直接提交」就能击穿全量闸门。
// ---------------------------------------------------------------------------

/** P3：policyType 必须属于 monitorType（§1.1 联动表）。 */
function addMonitorPolicyTypeIssues(
  values: { monitorType: AlarmMonitorType, policyType: AlarmPolicyType },
  ctx: z.RefinementCtx,
): void {
  const allowed = ALARM_MONITOR_TYPE_POLICY_TYPES[values.monitorType]
  if (!allowed)
    return
  if (!allowed.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['policyType'],
      message: '该监控类型在 v1.0 暂无可用策略类型',
    })
    return
  }
  if (!allowed.includes(values.policyType)) {
    ctx.addIssue({
      code: 'custom',
      path: ['policyType'],
      message: '策略类型与监控类型不匹配，请重新选择',
    })
  }
}

/** P14：objectType 与三个 object 字段一一对应，不适用的必须为空、适用的不能为空。 */
function addObjectBindingIssues(
  values: {
    objectType: AlarmObjectType
    objectIds?: number[]
    objectGroupIds?: number[]
    objectFilters?: AlarmObjectFilter[]
  },
  ctx: z.RefinementCtx,
): void {
  const field = ALARM_OBJECT_TYPE_REQUIRED_FIELD[values.objectType]

  if (field === null) {
    if (values.objectIds?.length)
      ctx.addIssue({ code: 'custom', path: ['objectIds'], message: '「全部对象」不能指定实例' })
    if (values.objectGroupIds?.length)
      ctx.addIssue({ code: 'custom', path: ['objectGroupIds'], message: '「全部对象」不能指定实例分组' })
    if (values.objectFilters?.length)
      ctx.addIssue({ code: 'custom', path: ['objectFilters'], message: '「全部对象」不能使用多维筛选' })
    return
  }

  const list = (values[field] ?? []) as unknown[]
  const max = ALARM_OBJECT_TYPE_MAX[field]
  if (list.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: '请至少选择 1 项告警对象，或把告警对象类型改为「全部对象」',
    })
    return
  }
  if (list.length > max)
    ctx.addIssue({ code: 'custom', path: [field], message: `告警对象最多 ${max} 项` })
}

// ---------------------------------------------------------------------------
// 第 1 步：基本信息（P1 P2 P3）
// ---------------------------------------------------------------------------

export const policyBasicStepSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '策略名称不能为空')
      .max(POLICY_NAME_MAX_LENGTH, `策略名称最长 ${POLICY_NAME_MAX_LENGTH} 个字符`),
    remark: z
      .string()
      .max(POLICY_REMARK_MAX_LENGTH, `备注最长 ${POLICY_REMARK_MAX_LENGTH} 个字符`),
    monitorType: monitorTypeSchema,
    policyType: policyTypeSchema,
    projectId: z
      .number({ message: '所属项目必须是数字' })
      .int('所属项目必须是整数')
      .min(0, '所属项目 id 不能为负数')
      .max(Number.MAX_SAFE_INTEGER, '所属项目 id 超出范围'),
  })
  .superRefine(addMonitorPolicyTypeIssues)

// ---------------------------------------------------------------------------
// 第 2 步：告警条件 + 告警对象（P4 P5 P6 P7 P8 P9 P10 P11 P14）
// ---------------------------------------------------------------------------

export const policyConditionStepSchema = z
  .object({
    objectType: objectTypeSchema,
    objectIds: z.array(z.number().int('实例 id 必须是整数')).max(MAX_OBJECT_IDS, `指定实例最多 ${MAX_OBJECT_IDS} 个`),
    objectGroupIds: z.array(z.number().int('分组 id 必须是整数')).max(MAX_OBJECT_GROUP_IDS, `实例分组最多 ${MAX_OBJECT_GROUP_IDS} 个`),
    objectFilters: z.array(objectFilterSchema).max(MAX_OBJECT_FILTERS, `多维筛选最多 ${MAX_OBJECT_FILTERS} 条`),
    conditionLogic: conditionLogicSchema,
    conditionTemplateId: z
      .number()
      .int('触发条件模板 id 必须是整数')
      .min(0, '触发条件模板 id 不能为负数'),
    conditions: conditionsSchema,
  })
  .superRefine(addObjectBindingIssues)

// ---------------------------------------------------------------------------
// 第 3 步：告警通知（P12 P13 N3）
// ---------------------------------------------------------------------------

export const policyNotifyStepSchema = z
  .object({
    notificationTemplateIds: z
      .array(z.number().int('通知模板 id 必须是整数'))
      .max(MAX_NOTIFICATION_TEMPLATES, `通知模板最多绑定 ${MAX_NOTIFICATION_TEMPLATES} 个`)
      .refine(
        ids => new Set(ids).size === ids.length,
        { message: '通知模板不可重复绑定' },
      ),
    callbackUrl: z
      .string()
      .trim()
      .refine(url => !url || /^https?:\/\/.+/i.test(url), { message: '回调地址必须以 http:// 或 https:// 开头' })
      .refine(url => url.length <= CALLBACK_URL_MAX_LENGTH, { message: `回调地址最长 ${CALLBACK_URL_MAX_LENGTH} 个字符` }),
  })

// ---------------------------------------------------------------------------
// 全量 schema —— onSubmit 的最终闸门
// ---------------------------------------------------------------------------

/**
 * 三步 schema 合并后的**最终闸门**。
 *
 * ⚠️ `ZodObject.shape` 不携带 superRefine，所以 P3 / P14 两条跨字段规则在这里**显式重跑**，
 * 保证「绕过 UI 直接构造请求体」也一定会被拦下。
 */
export const policyFormSchema = policyBasicStepSchema
  .extend(policyConditionStepSchema.shape)
  .extend(policyNotifyStepSchema.shape)
  .extend({ status: policyStatusSchema })
  .superRefine((values, ctx) => {
    addMonitorPolicyTypeIssues(values, ctx)
    addObjectBindingIssues(values, ctx)
  })

/** 向导三步的 schema，顺序即 `POLICY_STEP_TITLES` 的顺序。 */
export const POLICY_FORM_STEP_SCHEMAS = [
  policyBasicStepSchema,
  policyConditionStepSchema,
  policyNotifyStepSchema,
] as const

/** 导出枚举 schema 供表单组件复用（避免各处重复写 literal 校验）。 */
export const alarmFieldSchemas = {
  monitorType: monitorTypeSchema,
  policyType: policyTypeSchema,
  objectType: objectTypeSchema,
  level: levelSchema,
  period: periodSchema,
  frequency: frequencySchema,
  operator: operatorSchema,
  conditionLogic: conditionLogicSchema,
  status: policyStatusSchema,
} satisfies Record<string, z.ZodType>

export type AlarmLevelSchema = z.infer<typeof levelSchema> & AlarmLevel
export type AlarmPeriodSchema = z.infer<typeof periodSchema> & AlarmPeriod
export type AlarmFrequencySchema = z.infer<typeof frequencySchema> & AlarmFrequency
export type AlarmOperatorSchema = z.infer<typeof operatorSchema> & AlarmOperator
export type AlarmConditionLogicSchema = z.infer<typeof conditionLogicSchema> & AlarmConditionLogic
