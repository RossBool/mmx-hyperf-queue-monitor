/**
 * 告警策略 —— 视图模型适配层。
 *
 * 详情页（读 `AlarmPolicyDetail`）与向导第 4 步确认页（读 `PolicyFormValues`）
 * 要展示**同样的四个分区**（基本信息 / 告警条件 / 告警对象 / 告警通知），
 * 所以这里把两个数据源归一化成同一个 `PolicySectionModel`，
 * 由 `components/policy-detail.vue` 一处渲染，保证两页视觉严格一致。
 */

import type {
  AlarmConditionTemplate,
  AlarmLevel,
  AlarmMatchType,
  AlarmMetric,
  AlarmMonitorType,
  AlarmNotificationTemplate,
  AlarmNotifyChannel,
  AlarmObjectFilter,
  AlarmObjectType,
  AlarmPolicyCondition,
  AlarmPolicyDetail,
  AlarmPolicyNotificationTemplateBrief,
  AlarmPolicyType,
} from '@/types/alarm'

import {
  ALARM_LEVEL,
  ALARM_NOTIFY_CHANNEL,
  ALARM_NOTIFY_CHANNEL_LABEL,
  ALARM_OBJECT_TYPE,
  ALARM_OBJECT_TYPE_LIMITS,
  ALARM_PRESET_FLAG,
} from '@/types/alarm'

import type { PolicyConditionFormItem, PolicyFormValues } from './policy-logic'

import { buildObjectSummary, buildPolicyPayload, resolveObjectBinding } from './policy-logic'

/** 通知模板的展示摘要（详情接口与确认页两种来源归一后共用）。 */
export interface PolicyNotificationBrief {
  id: number
  name: string
  isPreset: number
  /** 渠道**编码数组**（§2.3：策略侧只给编码，不给接收人） */
  channels: AlarmNotifyChannel[]
  /** 渠道展示文案，如 `邮件、短信` */
  channelsLabel: string
  /** N9：是否配好了接收人 */
  configured: boolean
}

/** 四个分区的统一展示模型。 */
export interface PolicySectionModel {
  id?: number
  name: string
  remark: string
  monitorType?: AlarmMonitorType
  monitorTypeLabel: string
  policyType?: AlarmPolicyType
  policyTypeLabel: string
  status: number
  statusLabel: string
  /** P17：`min(conditions[].level)`，无条件时为 undefined */
  level?: AlarmLevel
  levelLabel: string
  projectId: number
  projectLabel: string
  creatorName: string
  createdAt: string
  updatedAt: string
  objectType: AlarmObjectType
  objectTypeLabel: string
  objectSummary: string
  objectIds: number[]
  objectGroupIds: number[]
  objectFilters: AlarmObjectFilter[]
  conditionLogicLabel: string
  conditionTemplateName: string
  conditions: AlarmPolicyCondition[]
  notificationTemplates: PolicyNotificationBrief[]
  notificationTemplateIds: number[]
  callbackUrl: string
  /** 详情接口不返回回调地址（那属于通知模板的渠道明细），确认页才有 */
  callbackUrlFromFormOnly?: boolean
}

const STATUS_LABEL: Record<number, string> = { 0: '停用', 1: '启用' }
const CONDITION_LOGIC_LABEL: Record<number, string> = { 1: '满足所有条件（AND）', 2: '满足任意条件（OR）' }
const MATCH_TYPE_LABEL: Record<AlarmMatchType, string> = { include: '包含', exclude: '排除' }

/** 渠道编码数组 → `邮件、短信`。未知编码降级为 `渠道 x`，不吞掉。 */
export function describeNotifyChannels(channels: AlarmNotifyChannel[] | null | undefined): string {
  if (!channels?.length)
    return '—'
  return channels
    .map(channel => ALARM_NOTIFY_CHANNEL_LABEL[channel] ?? `渠道 ${channel}`)
    .join('、')
}

/** P17：策略等级 = 所有条件里最严重者（数值最小）。无条件时返回 undefined。 */
export function resolvePolicyLevel(conditions: Pick<AlarmPolicyCondition, 'level'>[]): AlarmLevel | undefined {
  if (!conditions.length)
    return undefined
  return Math.min(...conditions.map(condition => condition.level)) as AlarmLevel
}

/** `projectId=0` 表示未分配（契约 §2.2）。 */
export function formatProjectLabel(projectId: number): string {
  return projectId > 0 ? `#${projectId}` : '未分配'
}

function toConditionRows(conditions: PolicyConditionFormItem[]): AlarmPolicyCondition[] {
  return conditions.map(({ _key: _rowKey, ...condition }) => condition)
}

function toNotificationBrief(
  templates: AlarmNotificationTemplate[],
  selectedIds: number[],
): PolicyNotificationBrief[] {
  return selectedIds
    .map(id => templates.find(template => template.id === id))
    .filter((template): template is AlarmNotificationTemplate => Boolean(template))
    .map(template => ({
      id: template.id,
      name: template.name,
      isPreset: template.isPreset,
      channels: template.channels.map(channel => channel.channel),
      channelsLabel: describeNotifyChannels(template.channels.map(channel => channel.channel)),
      configured: template.channels.every(
        channel => channel.channel === ALARM_NOTIFY_CHANNEL.CALLBACK || channel.receivers.length > 0,
      ),
    }))
}

/** 详情接口的 `notificationTemplates[]` 摘要 → 展示模型（不回查接收人，契约刻意不返回）。 */
function fromBrief(brief: AlarmPolicyNotificationTemplateBrief): PolicyNotificationBrief {
  return {
    id: brief.id,
    name: brief.name,
    isPreset: brief.isPreset,
    channels: brief.channels,
    channelsLabel: describeNotifyChannels(brief.channels),
    configured: true,
  }
}

const MONITOR_TYPE_LABEL: Record<number, string> = {
  1: '云产品监控',
  2: '应用性能监控',
  3: '前端性能监控',
  4: '云拨测',
  5: '终端性能监控',
}
const POLICY_TYPE_LABEL: Record<number, string> = {
  1: '通用 Web 服务',
  2: '云服务器 CVM',
  3: '负载均衡 CLB',
  4: '云数据库 MySQL',
}
const LEVEL_LABEL: Record<number, string> = { 1: '紧急', 2: '严重', 3: '提示' }
const OBJECT_TYPE_LABEL: Record<number, string> = {
  1: '全部对象',
  2: '指定实例',
  3: '实例分组',
  4: '多维筛选',
}

/** 契约枚举的中文名兜底（后端回填优先，为空时用本地字典）。 */
function labelOf(map: Record<number, string>, value: number | undefined, fallback: string): string {
  if (value === undefined || value === null)
    return fallback
  return map[value] ?? fallback
}

// ---------------------------------------------------------------------------
// 数据源 1：策略详情（② GET /api/alarm/policies/{id}）
// ---------------------------------------------------------------------------

export function toPolicySectionModel(detail: AlarmPolicyDetail): PolicySectionModel {
  const binding = resolveObjectBinding(detail.objectType, {
    objectIds: detail.objectIds,
    objectGroupIds: detail.objectGroupIds,
    objectFilters: detail.objectFilters,
  })

  return {
    id: detail.id,
    name: detail.name,
    remark: detail.remark,
    monitorType: detail.monitorType,
    monitorTypeLabel: detail.monitorTypeCn || labelOf(MONITOR_TYPE_LABEL, detail.monitorType, '—'),
    policyType: detail.policyType,
    policyTypeLabel: detail.policyTypeCn || labelOf(POLICY_TYPE_LABEL, detail.policyType, '—'),
    status: detail.status,
    statusLabel: STATUS_LABEL[detail.status] ?? '未知',
    level: detail.level,
    levelLabel: LEVEL_LABEL[detail.level] ?? '—',
    projectId: detail.projectId,
    projectLabel: formatProjectLabel(detail.projectId),
    creatorName: detail.creatorName,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    objectType: detail.objectType,
    objectTypeLabel: OBJECT_TYPE_LABEL[detail.objectType] ?? `对象类型 ${detail.objectType}`,
    objectSummary: buildObjectSummary(detail.objectType, {
      objectIds: binding.objectIds,
      objectGroupIds: binding.objectGroupIds,
      objectFilters: binding.objectFilters,
    }),
    objectIds: binding.objectIds ?? [],
    objectGroupIds: binding.objectGroupIds ?? [],
    objectFilters: binding.objectFilters ?? [],
    conditionLogicLabel: CONDITION_LOGIC_LABEL[detail.conditionLogic] ?? '—',
    conditionTemplateName: '',
    conditions: detail.conditions,
    notificationTemplates: detail.notificationTemplates.map(fromBrief),
    // §0.6 R-JSON-2：永远是数组，不用判空
    notificationTemplateIds: detail.notificationTemplateIds,
    callbackUrl: '',
    callbackUrlFromFormOnly: true,
  }
}

// ---------------------------------------------------------------------------
// 数据源 2：向导表单（第 4 步确认页）
// ---------------------------------------------------------------------------

export interface PolicyFormViewOptions {
  mode: 'create' | 'update'
  /** ⑬ 拉回来的通知模板字典，用于把 id 还原成名称（N9 也要用） */
  notificationTemplates?: AlarmNotificationTemplate[]
  /** ⑨ 拉回来的触发条件模板字典，用于显示「使用模板」的来源 */
  conditionTemplates?: AlarmConditionTemplate[]
  /** 编辑态回填的元信息（创建人 / 时间 / id） */
  meta?: Partial<Pick<PolicySectionModel, 'id' | 'creatorName' | 'createdAt' | 'updatedAt'>>
  /** 运行时通知侧校验的错误（P12 / P13 / N9），确认页原样展示 */
  notifyErrors?: string[]
}

export function toPolicySectionModelFromForm(
  values: PolicyFormValues,
  options: PolicyFormViewOptions,
): PolicySectionModel & { notifyErrors: string[] } {
  const conditions = toConditionRows(values.conditions)
  const level = resolvePolicyLevel(conditions)
  const notificationTemplates = toNotificationBrief(
    options.notificationTemplates ?? [],
    values.notificationTemplateIds,
  )
  const binding = resolveObjectBinding(values.objectType, values)
  const conditionTemplate = (options.conditionTemplates ?? []).find(
    template => template.id === values.conditionTemplateId,
  )

  return {
    id: options.meta?.id,
    name: values.name,
    remark: values.remark,
    monitorType: values.monitorType,
    monitorTypeLabel: labelOf(MONITOR_TYPE_LABEL, values.monitorType, '未选择'),
    policyType: values.policyType,
    policyTypeLabel: labelOf(POLICY_TYPE_LABEL, values.policyType, '未选择'),
    status: values.status,
    statusLabel: STATUS_LABEL[values.status] ?? '未知',
    level,
    levelLabel: level ? LEVEL_LABEL[level] : '—',
    projectId: values.projectId,
    projectLabel: formatProjectLabel(values.projectId),
    creatorName: options.meta?.creatorName ?? '—',
    createdAt: options.meta?.createdAt ?? '',
    updatedAt: options.meta?.updatedAt ?? '',
    objectType: values.objectType,
    objectTypeLabel: OBJECT_TYPE_LABEL[values.objectType] ?? `对象类型 ${values.objectType}`,
    objectSummary: buildObjectSummary(values.objectType, {
      objectIds: binding.objectIds,
      objectGroupIds: binding.objectGroupIds,
      objectFilters: binding.objectFilters,
    }),
    objectIds: binding.objectIds ?? [],
    objectGroupIds: binding.objectGroupIds ?? [],
    objectFilters: binding.objectFilters ?? [],
    conditionLogicLabel: CONDITION_LOGIC_LABEL[values.conditionLogic] ?? '—',
    conditionTemplateName: conditionTemplate
      ? `${conditionTemplate.name}${conditionTemplate.isPreset === ALARM_PRESET_FLAG.PRESET ? '（系统预置）' : ''}`
      : '',
    conditions,
    notificationTemplates,
    notificationTemplateIds: values.notificationTemplateIds,
    callbackUrl: values.callbackUrl,
    callbackUrlFromFormOnly: false,
    notifyErrors: options.notifyErrors ?? [],
  }
}

/** `objectFilters[]` 的展示文案：`region 包含 gz,sh`。 */
export function describeObjectFilter(filter: AlarmObjectFilter): string {
  const match = MATCH_TYPE_LABEL[filter.matchType ?? 'include'] ?? '包含'
  return `${filter.key} ${match} ${filter.values.join('、')}`
}

/** 指标下拉项：`CPU 使用率（%）· CVM.CpuUtilizationRate`。 */
export function describeMetric(metric: AlarmMetric): string {
  const unit = metric.unit ? `（${metric.unit}）` : ''
  return `${metric.metricNameCn}${unit} · ${metric.namespace}.${metric.metricName}`
}

/** 告警对象类型 → 该类型下**必填**的字段名（确认页给「未配置」提示用）。 */
export function objectRequiredFieldLabel(objectType: AlarmObjectType): string {
  const field = ALARM_OBJECT_TYPE_LIMITS[objectType].field
  if (field === 'objectIds')
    return '实例 id'
  if (field === 'objectGroupIds')
    return '实例分组 id'
  if (field === 'objectFilters')
    return '筛选维度'
  return '无需选择'
}

/** 编辑态把详情回填成表单值（P18：PUT 全量，所以每个字段都要显式带回）。 */
export function detailToFormValues(detail: AlarmPolicyDetail, nameOverride?: string): PolicyFormValues {
  const binding = resolveObjectBinding(detail.objectType, {
    objectIds: detail.objectIds,
    objectGroupIds: detail.objectGroupIds,
    objectFilters: detail.objectFilters,
  })

  return {
    name: nameOverride ?? detail.name,
    remark: detail.remark ?? '',
    monitorType: detail.monitorType,
    policyType: detail.policyType,
    projectId: detail.projectId ?? 0,
    objectType: detail.objectType,
    objectIds: binding.objectIds ?? [],
    objectGroupIds: binding.objectGroupIds ?? [],
    objectFilters: binding.objectFilters ?? [],
    conditionLogic: detail.conditionLogic,
    conditions: detail.conditions.map((condition, index) => ({
      _key: `c${condition.id ?? index}`,
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
    })),
    // §0.6 R-JSON-2：永远是数组
    notificationTemplateIds: [...detail.notificationTemplateIds],
    callbackUrl: '',
    conditionTemplateId: detail.conditionTemplateId ?? 0,
    // 编辑态不动 status：启停只能走 ⑥（P18 / P19）
    status: detail.status,
  }
}

/** 供「查看请求体」调试用：确认页展示真正会发出去的 body（P18 全量语义可见化）。 */
export function previewRequestBody(values: PolicyFormValues, mode: 'create' | 'update') {
  return buildPolicyPayload(values, mode)
}

/** 告警对象「全部对象」的常量再导出，方便模板里直接判断。 */
export const OBJECT_TYPE_ALL = ALARM_OBJECT_TYPE.ALL
/** 最低等级常量（确认页展示「最严重等级」时用）。 */
export const HIGHEST_LEVEL = ALARM_LEVEL.EMERGENCY
