<script setup lang="ts">
import type { RouteLocationNormalized } from 'vue-router'

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  LoaderIcon,
  RotateCcwIcon,
  WandSparklesIcon,
  XIcon,
} from '@lucide/vue'
import { useForm } from '@tanstack/vue-form'
import { onBeforeRouteLeave } from 'vue-router'
import { toast } from 'vue-sonner'

import type {
  AlarmConditionTemplate,
  AlarmMetric,
  AlarmNotificationTemplate,
  AlarmObjectFilter,
} from '@/types/alarm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { fetchAlarmNotificationTemplateList } from '@/services/api/alarm-notification.api'
import {
  createAlarmPolicy,
  fetchAlarmConditionTemplateList,
  fetchAlarmMetrics,
  fetchAlarmPolicyDetail,
  updateAlarmPolicy,
} from '@/services/api/alarm-policy.api'
import {
  ALARM_LEVEL,
  ALARM_NOTIFY_CHANNEL_LABEL,
  ALARM_OBJECT_TYPE,
  ALARM_OBJECT_TYPE_LIMITS,
  ALARM_OPERATOR,
  ALARM_POLICY_STATUS,
  ALARM_PRESET_FLAG,
  ALARM_PRESET_FLAG_LABEL,
} from '@/types/alarm'

import type { PolicyConditionFormItem, PolicyFormValues } from '../utils/policy-logic'

import {
  alarmConditionLogicOptions,
  alarmFrequencyOptions,
  alarmLevelOptions,
  alarmMonitorTypeOptions,
  alarmObjectTypeOptions,
  alarmOperatorOptions,
  alarmPeriodOptions,
  alarmPolicyTypeOptions,
  ConditionEditor,
} from '../../components'
import {
  buildCopyName,
  buildPolicyPayload,
  canAddCondition,
  canAddNotificationTemplate,
  canRemoveCondition,
  collectNotificationBindingErrors,
  createEmptyCondition,
  createEmptyPolicyFormValues,
  describeConditionLimit,
  getPolicyTypeOptions,
  isNotificationTemplateConfigured,
  MAX_CONDITIONS,
  MAX_CONTINUITY,
  MAX_NOTIFICATION_TEMPLATES,
  MAX_OBJECT_FILTER_VALUES,
  MAX_OBJECT_FILTERS,
  MAX_OBJECT_GROUP_IDS,
  MAX_OBJECT_IDS,
  MIN_CONTINUITY,
} from '../utils/policy-logic'
import { detailToFormValues, toPolicySectionModelFromForm } from '../utils/policy-view'
import { POLICY_FORM_STEP_SCHEMAS, policyFormSchema } from '../validators/policy.validator'
import PolicyDetail from './policy-detail.vue'

/** zod issue 的最小形状（本组件只用到 path + message，不直接依赖 form-core 的类型）。 */
interface StepIssue {
  path: PropertyKey[]
  message: string
}

/**
 * 告警策略新建 / 编辑向导（对标腾讯云可观测平台的策略配置页）。
 *
 * 四步：① 基本信息 → ② 告警条件 → ③ 告警通知 → ④ 确认并提交。
 *
 * ## 契约要点
 * - **P4** 触发条件 1-4 条：增删按钮到边界即禁用，并 toast 说明原因。
 * - **P12/P13** 通知模板最多 3 个、不可重复、必须存在。
 * - **N9** 预置模板 `receivers` 为空且 `channel≠5` 时**禁止绑定**，并点名提示补充接收人。
 * - **P14** `objectType` 与三个 object 字段一一对应，切类型时自动清空不适用的字段。
 * - **P18** 编辑提交走 PUT，**必须带完整表单含全部 conditions**；`status` 故意省略
 *   （省略表示保持原值，启停只走 ⑥）。
 * - **§0.6** 三个 object 字段提交 `null` 而不是 `[]`；`notificationTemplateIds` 提交数组。
 *
 * 校验用 `@tanstack/vue-form` + `zod`：每步一个 schema 决定能否前进，
 * `policyFormSchema` 作为 onSubmit 的**最终闸门**（绕过 UI 提交非法数据也会被拒）。
 */
const props = defineProps<{
  mode: 'create' | 'update'
  /** 编辑态的策略 id */
  policyId?: number
  /** 复制来源策略 id（列表「复制」跳新建页时带上，预填「原名 - 副本」） */
  copyFrom?: number
}>()

const emit = defineEmits<{
  saved: [id: number]
}>()

const router = useRouter()

// ---------------------------------------------------------------------------
// 步骤定义
// ---------------------------------------------------------------------------

const STEPS = [
  { title: '基本信息', description: '名称、监控类型与所属项目' },
  { title: '告警条件', description: '触发条件与告警对象' },
  { title: '告警通知', description: '通知模板与回调地址' },
  { title: '确认', description: '汇总全部配置并提交' },
] as const

/** 字段 → 所属步骤，用于提交失败时把用户跳回出问题的那一步。 */
const FIELD_STEP: Record<string, number> = {
  name: 0,
  remark: 0,
  monitorType: 0,
  policyType: 0,
  projectId: 0,
  objectType: 1,
  objectIds: 1,
  objectGroupIds: 1,
  objectFilters: 1,
  conditionLogic: 1,
  conditionTemplateId: 1,
  conditions: 1,
  notificationTemplateIds: 2,
  callbackUrl: 2,
}

const currentStep = ref(0)
const stepIssues = ref<StepIssue[]>([])
const notifyErrors = ref<string[]>([])
const submitting = ref(false)
const loadingDetail = ref(false)
const loadError = ref('')
const dirty = ref(false)

/** 编辑态回填的原始快照，用于脏检查。 */
let snapshot = ''
/** 最近一次回填的表单值，「放弃修改」用它还原。 */
let baseline: PolicyFormValues = createEmptyPolicyFormValues()

// ---------------------------------------------------------------------------
// 字典数据
// ---------------------------------------------------------------------------

const metrics = ref<AlarmMetric[]>([])
const metricsLoading = ref(false)
const conditionTemplates = ref<AlarmConditionTemplate[]>([])
const notificationTemplates = ref<AlarmNotificationTemplate[]>([])

const notificationTemplateMap = computed(() => {
  const map = new Map<number, AlarmNotificationTemplate>()
  for (const template of notificationTemplates.value)
    map.set(template.id, template)
  return map
})

const conditionMode = ref<'template' | 'manual'>('manual')

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

const form = useForm({
  defaultValues: createEmptyPolicyFormValues(),
  validators: {
    // 用函数而非直接把 schema 塞进来：zod 仍是唯一校验来源，
    // 转换成 vue-form 认识的 `{ field: { message } }` 错误映射（字面量联合类型也不会打架）
    onSubmit: ({ value }) => {
      const result = policyFormSchema.safeParse(value)
      if (result.success)
        return undefined
      const errors: Record<string, { message: string }> = {}
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '__form'
        if (!errors[key])
          errors[key] = { message: issue.message }
      }
      return errors
    },
  },
  onSubmit: async ({ value }) => {
    await submitPayload(value)
  },
})

/**
 * 表单值的**响应式**入口。
 *
 * ⚠️ 不能写 `computed(() => form.state.values)`：
 * `FormApi` 里的 `get state()` 是普通 getter（@tanstack/form-core 的 dist/esm/FormApi.js，
 * 该包 0 处 import vue），`form.state.values` 求值时**不建立任何 Vue 响应式依赖**，
 * computed 只算一次就永久缓存。后果：
 *   - `watch(values, …)` 永不触发 → `dirty` 恒为 false
 *   - 所有 `computed(() => values.value.x)` 派生值冻结在首次求值那一刻
 * 直接读 `values.value` 看似正常（store 原地改同一对象引用），所以纯函数单测全绿，
 * 但真实向导里「下一步」校验恒读旧值 → 永远停在第 1 步、0 次请求。
 *
 * 正确入口是 `@tanstack/vue-form` 挂在 `form` 上的 `useSelector`，它内部走
 * `@tanstack/vue-store` 的 `useSelector(api.store, selector)`，真正建立依赖。
 */
// 审查 E-1a：这里用 `as Ref<>` 洗掉了 useSelector 返回值上的 `Readonly`。
// 当前 0 处对 values 赋值，所以不构成缺陷，但 cast 说谎会让将来写
// `values.value = x` 的人以为合法、实际静默失效。诚实地保留只读语义。
const values = form.useSelector(state => state.values) as Readonly<Ref<PolicyFormValues>>

/** 统一的字段写入入口：`key` 一定是 `PolicyFormValues` 的顶层键。 */
function setValue<K extends keyof PolicyFormValues>(key: K, value: PolicyFormValues[K]) {
  form.setFieldValue(key as never, value as never)
}

// ---------------------------------------------------------------------------
// 派生数据
// ---------------------------------------------------------------------------

/** P3：策略类型下拉只列出当前监控类型允许的取值。 */
const policyTypeOptions = computed(() => {
  const allowed = getPolicyTypeOptions(values.value.monitorType)
  return alarmPolicyTypeOptions.filter(option => allowed.includes(option.value))
})

const policyTypeLabel = computed(() =>
  alarmPolicyTypeOptions.find(option => option.value === values.value.policyType)?.label ?? '未选择',
)

/** 当前策略类型下的指标（⑧ 按 policyType 过滤）。 */
const availableMetrics = computed(() => metrics.value)

function metricOf(namespace: string, name: string): AlarmMetric | undefined {
  return availableMetrics.value.find(metric => metric.namespace === namespace && metric.metricName === name)
}

/** P8：period 必须属于该指标的 `periodOptions[]`。 */
function periodOptionsOf(namespace: string, name: string): number[] {
  const metric = metricOf(namespace, name)
  if (!metric)
    return alarmPeriodOptions.map(option => option.value)
  return alarmPeriodOptions.filter(option => metric.periodOptions.includes(option.value as never)).map(option => option.value)
}

const objectTypeOptions = alarmObjectTypeOptions
const levelOptions = alarmLevelOptions
const operatorOptions = alarmOperatorOptions
const frequencyOptions = alarmFrequencyOptions
const logicOptions = alarmConditionLogicOptions
const periodOptions = alarmPeriodOptions

const continuityOptions = computed(() =>
  Array.from({ length: MAX_CONTINUITY - MIN_CONTINUITY + 1 }, (_, index) => MIN_CONTINUITY + index),
)

const selectedTemplateOptions = computed(() =>
  notificationTemplates.value.map(template => ({
    id: template.id,
    name: template.name,
    isPreset: template.isPreset,
    configured: isNotificationTemplateConfigured(template),
    channels: template.channels.map(channel => ALARM_NOTIFY_CHANNEL_LABEL[channel.channel]).join('、'),
  })),
)

const conditionTemplateOptions = computed(() =>
  conditionTemplates.value.map(template => ({
    id: template.id,
    name: template.name,
    isPreset: template.isPreset,
    count: template.conditions.length,
  })),
)

// ---------------------------------------------------------------------------
// 错误映射
// ---------------------------------------------------------------------------

const fieldErrorMap = computed(() => {
  const map: Record<string, string> = {}
  for (const issue of stepIssues.value) {
    const path = issue.path?.join('.') ?? ''
    if (path && !map[path])
      map[path] = String(issue.message ?? '校验不通过')
  }
  return map
})

function errorOf(path: string): string {
  return fieldErrorMap.value[path] ?? ''
}

/** 条件数组的汇总错误（`conditions` / `conditions.0.metricName` 都归到 conditions 区块顶部）。 */
const conditionBlockError = computed(() => {
  const messages = Object.entries(fieldErrorMap.value)
    .filter(([path]) => path === 'conditions' || path.startsWith('conditions.'))
    .map(([, message]) => message)
  return [...new Set(messages)].join('；')
})

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

async function loadNotificationTemplates() {
  try {
    const res = await fetchAlarmNotificationTemplateList({ page: 1, pageSize: 100 })
    if (!res.success) {
      toast.error('通知模板加载失败', { description: res.message })
      return
    }
    notificationTemplates.value = res.data?.list ?? []
  }
  catch (error) {
    toast.error('通知模板加载失败', { description: (error as Error).message })
  }
}

async function loadMetrics(policyType: number | undefined) {
  if (!policyType) {
    metrics.value = []
    return
  }
  metricsLoading.value = true
  try {
    const res = await fetchAlarmMetrics({ policyType: policyType as never })
    if (!res.success) {
      toast.error('指标字典加载失败', { description: res.message })
      metrics.value = []
      return
    }
    metrics.value = res.data ?? []
  }
  catch (error) {
    toast.error('指标字典加载失败', { description: (error as Error).message })
  }
  finally {
    metricsLoading.value = false
  }
}

async function loadConditionTemplates(policyType: number | undefined) {
  if (!policyType) {
    conditionTemplates.value = []
    return
  }
  try {
    const res = await fetchAlarmConditionTemplateList({
      policyType: policyType as never,
      page: 1,
      pageSize: 100,
    })
    conditionTemplates.value = res.success ? (res.data?.list ?? []) : []
  }
  catch {
    // 模板字典失败不阻断向导：用户可以切到「手动配置」
    conditionTemplates.value = []
  }
}

/** 详情回填（编辑态）或复制回填（复制来源）。 */
async function loadDetail(id: number, nameOverride?: string) {
  loadingDetail.value = true
  loadError.value = ''
  try {
    const res = await fetchAlarmPolicyDetail(id)
    if (!res.success) {
      loadError.value = res.message || '策略详情加载失败'
      return
    }
    const detail = res.data
    if (!detail) {
      loadError.value = '策略详情为空'
      return
    }
    resetForm(detailToFormValues(detail, nameOverride))
    conditionMode.value = detail.conditionTemplateId > 0 ? 'template' : 'manual'
  }
  catch (error) {
    loadError.value = (error as Error).message
  }
  finally {
    loadingDetail.value = false
  }
}

function resetForm(next: PolicyFormValues) {
  form.reset(next, { keepDefaultValues: true })
  stepIssues.value = []
  notifyErrors.value = []
  currentStep.value = 0
  baseline = next
  snapshot = JSON.stringify(next)
  dirty.value = false
}

/** 放弃未保存的修改：回到最近一次加载/复制的基线值。 */
function discardChanges() {
  form.reset(JSON.parse(JSON.stringify(baseline)) as PolicyFormValues, { keepDefaultValues: true })
  stepIssues.value = []
  notifyErrors.value = []
  dirty.value = false
  toast.info('已放弃未保存的修改')
}

// ---------------------------------------------------------------------------
// 步骤校验
// ---------------------------------------------------------------------------

function currentValues(): PolicyFormValues {
  return JSON.parse(JSON.stringify(values.value)) as PolicyFormValues
}

function validateStep(step: number): boolean {
  const schema = POLICY_FORM_STEP_SCHEMAS[step]
  const result = schema.safeParse(currentValues())
  if (result.success) {
    stepIssues.value = []
    return true
  }
  stepIssues.value = result.error.issues as StepIssue[]
  return false
}

function goNext() {
  if (!validateStep(currentStep.value))
    return
  currentStep.value = Math.min(currentStep.value + 1, STEPS.length - 1)
}

function goPrev() {
  stepIssues.value = []
  currentStep.value = Math.max(currentStep.value - 1, 0)
}

function jumpToStep(step: number) {
  // 只允许回退到已走过的步骤，避免跳过校验
  if (step < currentStep.value) {
    stepIssues.value = []
    currentStep.value = step
  }
}

// ---------------------------------------------------------------------------
// 字段联动
// ---------------------------------------------------------------------------

/** P3：切监控类型后，原策略类型可能不再合法 → 立即清空，避免带着非法组合往下走。 */
watch(() => values.value.monitorType, (next, prev) => {
  if (prev === undefined)
    return
  const allowed = getPolicyTypeOptions(next)
  if (values.value.policyType && !allowed.includes(values.value.policyType)) {
    setValue('policyType', undefined)
    toast.warning('监控类型已变更', { description: '原策略类型不再适用，请重新选择' })
  }
})

/** 策略类型变化 → 重新拉指标与模板字典。 */
watch(() => values.value.policyType, (next) => {
  loadMetrics(next)
  loadConditionTemplates(next)
})

/** P14：切告警对象类型时，把不适用的字段清空。 */
watch(() => values.value.objectType, (next, prev) => {
  if (prev === undefined)
    return
  const nextField = ALARM_OBJECT_TYPE_LIMITS[next].field
  if (nextField !== 'objectIds')
    setValue('objectIds', [])
  if (nextField !== 'objectGroupIds')
    setValue('objectGroupIds', [])
  if (nextField !== 'objectFilters')
    setValue('objectFilters', [])
  if (next === ALARM_OBJECT_TYPE.ALL) {
    setValue('objectIds', [])
    setValue('objectGroupIds', [])
    setValue('objectFilters', [])
  }
})

watch(values, () => {
  if (snapshot)
    dirty.value = JSON.stringify(currentValues()) !== snapshot
}, { deep: true })

// ---------------------------------------------------------------------------
// 触发条件增删（P4）
// ---------------------------------------------------------------------------

function addCondition() {
  const list = values.value.conditions
  if (!canAddCondition(list.length)) {
    toast.error('无法继续添加触发条件', { description: describeConditionLimit(list.length) })
    return
  }
  if (list.length === 0) {
    setValue('conditions', [createEmptyCondition(`c${Date.now()}`, 1)])
    return
  }
  setValue('conditions', [...list, createEmptyCondition(`c${Date.now()}-${list.length}`, list.length + 1)])
}

function removeCondition(index: number) {
  const list = values.value.conditions
  if (!canRemoveCondition(list.length)) {
    toast.error('无法删除触发条件', { description: describeConditionLimit(list.length) })
    return
  }
  setValue('conditions', list.filter((_, i) => i !== index).map((condition, i) => ({ ...condition, sort: (i + 1) as never })))
}

function updateCondition(index: number, patch: Partial<PolicyConditionFormItem>) {
  setValue(
    'conditions',
    values.value.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
  )
}

/** 选定指标后用字典默认值预填（P6 检查清单：预填 defaultOperator/defaultThreshold/suggestedContinuity/periodOptions）。 */
function selectMetric(index: number, key: string) {
  const metric = metricOf(key.split('.')[0], key.split('.').slice(1).join('.'))
  if (!metric)
    return
  const period = metric.periodOptions[0] ?? 5
  updateCondition(index, {
    metricNamespace: metric.namespace,
    metricName: metric.metricName,
    metricNameCn: metric.metricNameCn,
    unit: metric.unit,
    operator: metric.defaultOperator,
    threshold: metric.defaultThreshold,
    continuity: metric.suggestedContinuity,
    period: period as never,
    level: ALARM_LEVEL.NOTICE,
  })
}

function applyConditionTemplate(templateId: number) {
  const template = conditionTemplates.value.find(item => item.id === templateId)
  if (!template)
    return
  if (template.conditions.length > MAX_CONDITIONS) {
    toast.error('模板条件超出上限', { description: describeConditionLimit(template.conditions.length) })
    return
  }
  setValue(
    'conditions',
    template.conditions.map((condition, index) => ({
      _key: `tpl-${template.id}-${index}`,
      sort: (index + 1) as never,
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
  )
  setValue('conditionTemplateId', template.id)
  toast.success('已应用触发条件模板', { description: `${template.name}（${template.conditions.length} 条，可继续微调）` })
}

// ---------------------------------------------------------------------------
// 告警对象
// ---------------------------------------------------------------------------

function parseIdList(raw: string): number[] {
  return raw
    .split(/[\s,，]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter(value => Number.isFinite(value))
}

const objectIdsInput = computed(() => values.value.objectIds.join(','))
const objectGroupIdsInput = computed(() => values.value.objectGroupIds.join(','))

function onObjectIdsInput(raw: string) {
  setValue('objectIds', parseIdList(raw).slice(0, ALARM_OBJECT_TYPE_LIMITS[ALARM_OBJECT_TYPE.INSTANCE].max))
}

function onObjectGroupIdsInput(raw: string) {
  setValue('objectGroupIds', parseIdList(raw).slice(0, ALARM_OBJECT_TYPE_LIMITS[ALARM_OBJECT_TYPE.GROUP].max))
}

function addObjectFilter() {
  const list = values.value.objectFilters
  if (list.length >= MAX_OBJECT_FILTERS) {
    toast.error('多维筛选最多 10 条', { description: `当前已有 ${list.length} 条` })
    return
  }
  setValue('objectFilters', [
    ...list,
    { key: '', operator: ALARM_OPERATOR.EQ, values: [], matchType: 'include' },
  ])
}

function updateObjectFilter(index: number, patch: Partial<AlarmObjectFilter>) {
  setValue(
    'objectFilters',
    values.value.objectFilters.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)),
  )
}

function removeObjectFilter(index: number) {
  setValue('objectFilters', values.value.objectFilters.filter((_, i) => i !== index))
}

function parseValues(raw: string): string[] {
  return raw.split(/[\s,，]+/).map(item => item.trim()).filter(Boolean).slice(0, MAX_OBJECT_FILTER_VALUES)
}

// ---------------------------------------------------------------------------
// 通知模板（P12 / P13 / N9）
// ---------------------------------------------------------------------------

function isTemplateSelected(id: number): boolean {
  return values.value.notificationTemplateIds.includes(id)
}

function toggleNotificationTemplate(id: number, checked: boolean) {
  const current = values.value.notificationTemplateIds
  if (!checked) {
    setValue('notificationTemplateIds', current.filter(item => item !== id))
    return
  }
  if (current.includes(id))
    return
  if (!canAddNotificationTemplate(current.length)) {
    toast.error('通知模板最多绑定 3 个', { description: `已绑定 ${current.length} 个，无法继续添加` })
    return
  }
  const template = notificationTemplateMap.value.get(id)
  // N9：未配好接收人的模板禁止绑定
  if (template && !isNotificationTemplateConfigured(template)) {
    toast.error('该通知模板未配置完成', {
      description: `「${template.name}」存在未填写接收人的渠道，请先到「通知模板」补充后再绑定`,
    })
    return
  }
  setValue('notificationTemplateIds', [...current, id])
}

const unconfiguredSelected = computed(() =>
  values.value.notificationTemplateIds
    .map(id => notificationTemplateMap.value.get(id))
    .filter(template => template && !isNotificationTemplateConfigured(template))
    .map(template => template!.name),
)

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

async function submitPayload(value: PolicyFormValues) {
  // 运行时校验：P12 / P13 / N9（依赖字典，静态 schema 表达不了）
  const errors = collectNotificationBindingErrors(value.notificationTemplateIds, notificationTemplateMap.value)
  notifyErrors.value = errors
  if (errors.length) {
    currentStep.value = 2
    toast.error('告警通知未通过校验', { description: errors[0] })
    return
  }

  submitting.value = true
  try {
    // P18：update 走全量提交（完整 conditions），并省略 status
    const payload = buildPolicyPayload(value, props.mode)
    const res = props.mode === 'update' && props.policyId
      ? await updateAlarmPolicy(props.policyId, payload)
      : await createAlarmPolicy(payload)

    if (!res.success) {
      // 后端 message 直接展示（409 名称重复 / 422 字段级）
      toast.error(props.mode === 'update' ? '策略更新失败' : '策略创建失败', { description: res.message })
      return
    }

    const id = res.data?.id ?? props.policyId ?? 0
    toast.success(props.mode === 'update' ? '策略已更新' : '策略已创建', { description: res.data?.name ?? value.name })
    dirty.value = false
    emit('saved', id)

    if (props.mode === 'update' && props.policyId) {
      await router.push(`/alarm/policy/${props.policyId}`)
      return
    }
    await router.push('/alarm/policy')
  }
  catch (error) {
    toast.error('提交失败', { description: (error as Error).message })
  }
  finally {
    submitting.value = false
  }
}

function handleSubmit() {
  if (currentStep.value < STEPS.length - 1) {
    goNext()
    return
  }
  // 最终闸门：整表校验（含 conditions 1-4 条、P14、P3…）
  const result = policyFormSchema.safeParse(currentValues())
  if (!result.success) {
    const issues = result.error.issues as StepIssue[]
    const first = issues[0]
    const step = first ? (FIELD_STEP[first.path?.join('.') ?? ''] ?? currentStep.value) : currentStep.value
    currentStep.value = step
    stepIssues.value = issues
    toast.error('表单校验未通过', { description: first ? String(first.message) : '请检查各步骤配置' })
    return
  }
  form.handleSubmit()
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

onMounted(async () => {
  await loadNotificationTemplates()

  if (props.mode === 'update' && props.policyId) {
    await loadDetail(props.policyId)
    return
  }
  if (props.copyFrom) {
    // 复制：预填「原名 - 副本」，新策略默认停用（P16）
    await loadDetail(props.copyFrom, undefined)
    if (!loadError.value) {
      const source = values.value.name
      const copyName = buildCopyName(source)
      setValue('name', copyName)
      setValue('status', ALARM_POLICY_STATUS.DISABLED)
      baseline = currentValues()
      snapshot = JSON.stringify(currentValues())
      dirty.value = true
      toast.info('已复制策略配置', { description: `名称预填为「${copyName}」，确认后提交即创建新策略` })
    }
  }
  else {
    baseline = currentValues()
    snapshot = JSON.stringify(currentValues())
  }
})

// ---------------------------------------------------------------------------
// 离开确认（脏检查）
//
// 不用原生 `window.confirm`：它是浏览器级弹窗，视觉上与本页、与列表页的删除确认
// 全部割裂。这里改成「拦截导航 → 弹应用内 ConfirmDialog → 用户确认后补发」，
// 顺带避免 `window.confirm` 在部分内网/自动化环境被拦截后直接静默放行。
// ---------------------------------------------------------------------------

const leaveDialogOpen = ref(false)
const leaveTarget = ref<RouteLocationNormalized | null>(null)

onBeforeRouteLeave((to) => {
  if (!dirty.value || submitting.value)
    return true
  leaveTarget.value = to
  leaveDialogOpen.value = true
  return false // 拦下这一次导航
})

async function confirmLeave() {
  leaveDialogOpen.value = false
  const to = leaveTarget.value
  leaveTarget.value = null
  if (!to)
    return
  // 必须先清脏标记，否则补发的这次导航会被自己的守卫再拦一次
  dirty.value = false
  await router.push(to.fullPath)
}

function cancelLeave() {
  leaveDialogOpen.value = false
  leaveTarget.value = null
}
</script>

<template>
  <div class="space-y-6">
    <!-- 步骤条 -->
    <div class="flex items-center justify-between gap-2">
      <ol class="flex flex-1 flex-wrap items-center gap-2">
        <li v-for="(step, index) in STEPS" :key="step.title" class="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            class="h-auto gap-2 px-2 py-1"
            :class="index === currentStep ? 'bg-accent' : ''"
            :disabled="index > currentStep"
            @click="jumpToStep(index)"
          >
            <span
              class="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs"
              :class="index < currentStep ? 'border-primary bg-primary text-primary-foreground' : ''"
            >
              <CheckIcon v-if="index < currentStep" class="size-3.5" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="text-left">
              <span class="block text-sm font-medium leading-tight">{{ step.title }}</span>
              <span class="block text-xs font-normal text-muted-foreground">{{ step.description }}</span>
            </span>
          </Button>
          <Separator v-if="index < STEPS.length - 1" orientation="vertical" class="h-8" />
        </li>
      </ol>

      <Badge v-if="dirty" variant="outline">
        有未保存的修改
      </Badge>
      <Button
        v-if="dirty && mode === 'update'"
        variant="ghost"
        size="sm"
        @click="discardChanges"
      >
        <RotateCcwIcon />
        放弃修改
      </Button>
    </div>

    <div v-if="loadingDetail" class="space-y-4">
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-64 w-full" />
    </div>

    <div v-else-if="loadError" class="rounded-md border border-destructive/50 p-6 text-sm text-destructive">
      {{ loadError }}
      <Button class="ml-4" size="sm" variant="outline" @click="router.back()">
        <ArrowLeftIcon />
        返回
      </Button>
    </div>

    <template v-else>
      <!-- ① 基本信息 -->
      <Card v-show="currentStep === 0">
        <CardHeader>
          <CardTitle class="text-base">
            基本信息
          </CardTitle>
          <CardDescription>
            策略名称全局唯一（1-128 个字符），备注最多 500 个字符。
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-6">
          <form.Field name="name">
            <template #default="{ field, state }">
              <div class="space-y-2">
                <Label for="policy-name">策略名称</Label>
                <Input
                  id="policy-name"
                  :model-value="field.state.value"
                  placeholder="如：生产 CVM CPU 监控"
                  @input="field.handleChange(($event.target as HTMLInputElement).value)"
                  @blur="field.handleBlur"
                />
                <p class="text-sm text-destructive">
                  {{ state.meta.errors?.[0] ?? errorOf('name') }}
                </p>
                <p class="text-xs text-muted-foreground">
                  去首尾空格后长度 1-128，保存时若与已有策略重名会返回 409「策略名称已存在」。
                </p>
              </div>
            </template>
          </form.Field>

          <form.Field name="remark">
            <template #default="{ field }">
              <div class="space-y-2">
                <Label for="policy-remark">备注</Label>
                <Textarea
                  id="policy-remark"
                  :model-value="field.state.value"
                  placeholder="选填，最多 500 个字符"
                  rows="3"
                  @input="field.handleChange(($event.target as HTMLTextAreaElement).value)"
                  @blur="field.handleBlur"
                />
                <p class="text-sm text-destructive">
                  {{ errorOf('remark') }}
                </p>
              </div>
            </template>
          </form.Field>

          <div class="grid gap-6 md:grid-cols-2">
            <form.Field name="monitorType">
              <template #default="{ field }">
                <div class="space-y-2">
                  <Label>监控类型</Label>
                  <Select
                    :model-value="field.state.value === undefined ? undefined : String(field.state.value)"
                    @update:model-value="(v) => field.handleChange(Number(v) as never)"
                  >
                    <SelectTrigger class="w-full">
                      <SelectValue placeholder="请选择监控类型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        v-for="option in alarmMonitorTypeOptions"
                        :key="option.value"
                        :value="String(option.value)"
                      >
                        {{ option.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-sm text-destructive">
                    {{ errorOf('monitorType') }}
                  </p>
                </div>
              </template>
            </form.Field>

            <form.Field name="policyType">
              <template #default="{ field }">
                <div class="space-y-2">
                  <Label>策略类型</Label>
                  <Select
                    :model-value="field.state.value === undefined ? undefined : String(field.state.value)"
                    :disabled="!values.monitorType"
                    @update:model-value="(v) => field.handleChange(Number(v) as never)"
                  >
                    <SelectTrigger class="w-full">
                      <SelectValue :placeholder="values.monitorType ? '请选择策略类型' : '请先选择监控类型'" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        v-for="option in policyTypeOptions"
                        :key="option.value"
                        :value="String(option.value)"
                      >
                        {{ option.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p class="text-sm text-destructive">
                    {{ errorOf('policyType') }}
                  </p>
                  <p v-if="values.monitorType && !policyTypeOptions.length" class="text-xs text-muted-foreground">
                    该监控类型在 v1.0 暂无可用策略类型
                  </p>
                </div>
              </template>
            </form.Field>
          </div>

          <form.Field name="projectId">
            <template #default="{ field }">
              <div class="max-w-xs space-y-2">
                <Label>所属项目</Label>
                <Input
                  type="number"
                  min="0"
                  :model-value="String(field.state.value)"
                  placeholder="0 表示未分配"
                  @input="field.handleChange(Number(($event.target as HTMLInputElement).value || 0) as never)"
                />
                <p class="text-sm text-destructive">
                  {{ errorOf('projectId') }}
                </p>
                <p class="text-xs text-muted-foreground">
                  填 0 表示未分配项目；本模块契约未提供项目列表端点，故直接填项目 id。
                </p>
              </div>
            </template>
          </form.Field>
        </CardContent>
      </Card>

      <!-- ② 告警条件 -->
      <div v-show="currentStep === 1" class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">
              告警对象
            </CardTitle>
            <CardDescription>
              告警对象类型与「指定实例 / 实例分组 / 多维筛选」一一对应；选「全部对象」时其余三项必须为空。
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="space-y-2">
              <Label>告警对象类型</Label>
              <Select
                :model-value="String(values.objectType)"
                @update:model-value="(v) => setValue('objectType', Number(v) as never)"
              >
                <SelectTrigger class="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in objectTypeOptions" :key="option.value" :value="String(option.value)">
                    {{ option.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p class="text-sm text-destructive">
                {{ errorOf('objectType') }}
              </p>
            </div>

            <div v-if="values.objectType === 2" class="space-y-2">
              <Label for="object-ids">指定实例</Label>
              <Input
                id="object-ids"
                :model-value="objectIdsInput"
                placeholder="输入实例 id，多个用逗号分隔，如 8801,8802"
                @input="onObjectIdsInput(($event.target as HTMLInputElement).value)"
              />
              <p class="text-xs text-muted-foreground">
                共 {{ values.objectIds.length }} / {{ MAX_OBJECT_IDS }} 个
              </p>
              <p class="text-sm text-destructive">
                {{ errorOf('objectIds') }}
              </p>
            </div>

            <div v-else-if="values.objectType === 3" class="space-y-2">
              <Label for="object-group-ids">实例分组</Label>
              <Input
                id="object-group-ids"
                :model-value="objectGroupIdsInput"
                placeholder="输入分组 id，多个用逗号分隔"
                @input="onObjectGroupIdsInput(($event.target as HTMLInputElement).value)"
              />
              <p class="text-xs text-muted-foreground">
                共 {{ values.objectGroupIds.length }} / {{ MAX_OBJECT_GROUP_IDS }} 个
              </p>
              <p class="text-sm text-destructive">
                {{ errorOf('objectGroupIds') }}
              </p>
            </div>

            <div v-else-if="values.objectType === 4" class="space-y-3">
              <div class="flex items-center justify-between">
                <Label>多维筛选</Label>
                <Button size="sm" variant="outline" :disabled="values.objectFilters.length >= MAX_OBJECT_FILTERS" @click="addObjectFilter">
                  添加筛选维度
                </Button>
              </div>
              <p class="text-xs text-muted-foreground">
                共 {{ values.objectFilters.length }} / {{ MAX_OBJECT_FILTERS }} 条；候选值 1-{{ MAX_OBJECT_FILTER_VALUES }} 个
              </p>
              <div
                v-for="(filter, index) in values.objectFilters"
                :key="index"
                class="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_2fr_1fr_auto]"
              >
                <Input
                  :model-value="filter.key"
                  placeholder="维度名，如 region"
                  @input="updateObjectFilter(index, { key: ($event.target as HTMLInputElement).value })"
                />
                <Select
                  :model-value="filter.operator"
                  @update:model-value="(v) => updateObjectFilter(index, { operator: v as never })"
                >
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="option in operatorOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  :model-value="filter.values.join(',')"
                  placeholder="候选值，逗号分隔"
                  @input="updateObjectFilter(index, { values: parseValues(($event.target as HTMLInputElement).value) })"
                />
                <Select
                  :model-value="filter.matchType ?? 'include'"
                  @update:model-value="(v) => updateObjectFilter(index, { matchType: v as never })"
                >
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="include">
                      包含
                    </SelectItem>
                    <SelectItem value="exclude">
                      排除
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button size="icon" variant="ghost" aria-label="删除筛选维度" @click="removeObjectFilter(index)">
                  <XIcon />
                </Button>
              </div>
              <p class="text-sm text-destructive">
                {{ errorOf('objectFilters') }}
              </p>
            </div>

            <p v-else class="text-sm text-muted-foreground">
              全部对象：作用于该策略类型下当前账号有权限的全部实例，无需逐个选择。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="text-base">
              触发条件
            </CardTitle>
            <CardDescription>
              契约要求 1-4 条。可以选用预置模板一键填充，也可以完全手动配置。
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <Tabs v-model="conditionMode">
              <TabsList>
                <TabsTrigger value="template">
                  <WandSparklesIcon class="size-4" />
                  使用模板
                </TabsTrigger>
                <TabsTrigger value="manual">
                  手动配置
                </TabsTrigger>
              </TabsList>

              <TabsContent value="template" class="space-y-2 pt-2">
                <Label>触发条件模板</Label>
                <Select
                  :model-value="values.conditionTemplateId > 0 ? String(values.conditionTemplateId) : undefined"
                  :disabled="!values.policyType"
                  @update:model-value="(v) => applyConditionTemplate(Number(v))"
                >
                  <SelectTrigger class="w-full sm:w-96">
                    <SelectValue :placeholder="values.policyType ? '选择预置或自定义触发条件模板' : '请先选择策略类型'" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="option in conditionTemplateOptions"
                      :key="option.id"
                      :value="String(option.id)"
                    >
                      <div class="flex items-center gap-2">
                        {{ option.name }}
                        <Badge v-if="option.isPreset === ALARM_PRESET_FLAG.PRESET" variant="outline">
                          系统预置
                        </Badge>
                        <span class="text-xs text-muted-foreground">{{ option.count }} 条</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">
                  模板只提供初始值，应用后仍可在下方逐条微调（指标、阈值、等级、频次）。
                </p>
              </TabsContent>

              <TabsContent value="manual" class="pt-2">
                <p class="text-xs text-muted-foreground">
                  手动逐条配置触发条件，保存时记录 `conditionTemplateId = 0`（未使用模板）。
                </p>
              </TabsContent>
            </Tabs>

            <div class="flex items-center justify-between">
              <div>
                <Label>条件关系</Label>
                <Select
                  class="mt-2 w-full sm:w-56"
                  :model-value="String(values.conditionLogic)"
                  @update:model-value="(v) => setValue('conditionLogic', Number(v) as never)"
                >
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="option in logicOptions" :key="option.value" :value="String(option.value)">
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p class="text-sm text-destructive">
                {{ errorOf('conditionLogic') }}
              </p>
            </div>

            <Separator />

            <ConditionEditor
              :conditions="values.conditions"
              @add="addCondition"
              @remove="removeCondition"
            >
              <template #metric="{ index }">
                <div class="space-y-2">
                  <Label>监控指标</Label>
                  <Select
                    :model-value="values.conditions[index]?.metricName ? `${values.conditions[index].metricNamespace}.${values.conditions[index].metricName}` : undefined"
                    :disabled="!values.policyType"
                    @update:model-value="(v) => selectMetric(index, String(v))"
                  >
                    <SelectTrigger class="w-full">
                      <SelectValue :placeholder="metricsLoading ? '指标字典加载中…' : '选择指标'" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        v-for="metric in availableMetrics"
                        :key="`${metric.namespace}.${metric.metricName}`"
                        :value="`${metric.namespace}.${metric.metricName}`"
                      >
                        {{ metric.metricNameCn }}{{ metric.unit ? `（${metric.unit}）` : '' }}
                        <span class="ml-1 text-xs text-muted-foreground">{{ metric.namespace }}</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </template>

              <template #default="{ condition, index }">
                <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div class="space-y-2">
                    <Label>触发条件</Label>
                    <div class="flex items-center gap-2">
                      <Select
                        class="w-24 shrink-0"
                        :model-value="condition.operator"
                        @update:model-value="(v) => updateCondition(index, { operator: v as never })"
                      >
                        <SelectTrigger class="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem v-for="option in operatorOptions" :key="option.value" :value="option.value">
                            {{ option.label }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        step="any"
                        :model-value="Number.isNaN(condition.threshold) ? '' : String(condition.threshold)"
                        placeholder="阈值"
                        @input="updateCondition(index, { threshold: ($event.target as HTMLInputElement).value === '' ? Number.NaN : Number(($event.target as HTMLInputElement).value) })"
                      />
                    </div>
                    <p class="text-xs text-muted-foreground">
                      单位 {{ condition.unit || '—' }}，可填负数，最多 4 位小数
                    </p>
                  </div>

                  <div class="space-y-2">
                    <Label>统计粒度</Label>
                    <Select
                      :model-value="String(condition.period)"
                      @update:model-value="(v) => updateCondition(index, { period: Number(v) as never })"
                    >
                      <SelectTrigger class="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem
                          v-for="option in periodOptions.filter(item => periodOptionsOf(condition.metricNamespace, condition.metricName).includes(item.value))"
                          :key="option.value"
                          :value="String(option.value)"
                        >
                          {{ option.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="space-y-2">
                    <Label>持续周期</Label>
                    <Select
                      :model-value="String(condition.continuity)"
                      @update:model-value="(v) => updateCondition(index, { continuity: Number(v) })"
                    >
                      <SelectTrigger class="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="item in continuityOptions" :key="item" :value="String(item)">
                          连续 {{ item }} 个数据点
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="space-y-2">
                    <Label>告警等级</Label>
                    <Select
                      :model-value="String(condition.level)"
                      @update:model-value="(v) => updateCondition(index, { level: Number(v) as never })"
                    >
                      <SelectTrigger class="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="option in levelOptions" :key="option.value" :value="String(option.value)">
                          {{ option.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div class="space-y-2">
                    <Label>告警频次</Label>
                    <Select
                      :model-value="String(condition.frequency)"
                      @update:model-value="(v) => updateCondition(index, { frequency: Number(v) as never })"
                    >
                      <SelectTrigger class="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="option in frequencyOptions" :key="option.value" :value="String(option.value)">
                          {{ option.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </template>
            </ConditionEditor>

            <p v-if="conditionBlockError" class="text-sm text-destructive">
              {{ conditionBlockError }}
            </p>
            <p class="text-xs text-muted-foreground">
              {{ describeConditionLimit(values.conditions.length) }}
            </p>
          </CardContent>
        </Card>
      </div>

      <!-- ③ 告警通知 -->
      <div v-show="currentStep === 2" class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="text-base">
              通知模板
            </CardTitle>
            <CardDescription>
              最多绑定 {{ MAX_NOTIFICATION_TEMPLATES }} 个，不可重复。带「未配置接收人」标记的模板无法绑定。
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div class="flex items-center justify-between text-sm">
              <span class="text-muted-foreground">已绑定 {{ values.notificationTemplateIds.length }} / {{ MAX_NOTIFICATION_TEMPLATES }} 个</span>
              <Badge v-if="values.notificationTemplateIds.length >= MAX_NOTIFICATION_TEMPLATES" variant="outline">
                已达上限
              </Badge>
            </div>

            <ScrollArea v-if="selectedTemplateOptions.length" class="max-h-80">
              <div class="space-y-2 pr-3">
                <label
                  v-for="option in selectedTemplateOptions"
                  :key="option.id"
                  class="flex cursor-pointer items-center gap-3 rounded-md border p-3"
                  :class="option.configured ? '' : 'border-dashed opacity-80'"
                >
                  <Checkbox
                    :model-value="isTemplateSelected(option.id)"
                    @update:model-value="(v) => toggleNotificationTemplate(option.id, Boolean(v))"
                  />
                  <div class="flex-1 space-y-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-sm font-medium">{{ option.name }}</span>
                      <Badge v-if="option.isPreset === ALARM_PRESET_FLAG.PRESET" variant="outline">
                        {{ ALARM_PRESET_FLAG_LABEL[ALARM_PRESET_FLAG.PRESET] }}
                      </Badge>
                      <Badge v-if="!option.configured" variant="destructive">
                        未配置接收人
                      </Badge>
                    </div>
                    <p class="text-xs text-muted-foreground">
                      渠道：{{ option.channels }}
                      <template v-if="!option.configured">（存在未填写接收人的渠道，绑定会被拒绝）</template>
                    </p>
                  </div>
                </label>
              </div>
            </ScrollArea>
            <p v-else class="text-sm text-muted-foreground">
              暂无通知模板，请先到「告警管理 → 通知模板」创建。
            </p>

            <p v-if="unconfiguredSelected.length" class="text-sm text-destructive">
              已选模板未配置完成：{{ unconfiguredSelected.join('、') }}
            </p>
            <p class="text-sm text-destructive">
              {{ errorOf('notificationTemplateIds') }}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="text-base">
              回调地址
            </CardTitle>
            <CardDescription>
              可选。用于在收到告警时回调你自己的服务，必须以 http:// 或 https:// 开头，不超过 500 个字符。
            </CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <Input
              :model-value="values.callbackUrl"
              placeholder="https://ops.example.com/alarm/callback"
              @input="setValue('callbackUrl', ($event.target as HTMLInputElement).value)"
            />
            <p class="text-sm text-destructive">
              {{ errorOf('callbackUrl') }}
            </p>
          </CardContent>
        </Card>
      </div>

      <!-- ④ 确认 -->
      <div v-show="currentStep === 3" class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-medium">
              确认配置
            </h2>
            <p class="text-sm text-muted-foreground">
              提交后将{{ mode === 'update' ? '覆盖' : '创建' }}策略；编辑提交为<strong class="font-medium text-foreground">全量更新</strong>，
              下方四个分区就是最终会保存的内容。
            </p>
          </div>
          <Badge variant="outline">
            {{ values.monitorType === undefined ? '未选择监控类型' : `监控类型已选` }} · {{ policyTypeLabel }}
          </Badge>
        </div>

        <PolicyDetail
          :model="toPolicySectionModelFromForm(currentValues(), {
            mode,
            notificationTemplates,
            conditionTemplates,
            notifyErrors,
          })"
          :notify-errors="notifyErrors"
        />
      </div>

      <!-- 底部操作条 -->
      <div class="flex items-center justify-between border-t pt-4">
        <Button variant="outline" :disabled="currentStep === 0 || submitting" @click="goPrev">
          <ArrowLeftIcon />
          上一步
        </Button>
        <div class="flex items-center gap-2">
          <span class="text-sm text-muted-foreground">
            第 {{ currentStep + 1 }} / {{ STEPS.length }} 步
          </span>
          <Button :disabled="submitting" @click="handleSubmit">
            <LoaderIcon v-if="submitting" class="animate-spin" />
            <template v-if="currentStep < STEPS.length - 1">
              下一步
              <ArrowRightIcon />
            </template>
            <template v-else>
              {{ mode === 'update' ? '保存修改' : '创建策略' }}
            </template>
          </Button>
        </div>
      </div>
    </template>

    <!-- 离开确认：脏检查拦下导航后弹这里 -->
    <ConfirmDialog
      :open="leaveDialogOpen"
      cancel-button-text="继续编辑"
      confirm-button-text="放弃修改并离开"
      @update:open="(value: boolean) => { if (!value) cancelLeave() }"
      @confirm="confirmLeave"
    >
      <template #title>
        确定要离开吗？
      </template>
      <template #description>
        <p class="text-sm text-muted-foreground">
          当前有<strong class="text-foreground">未保存的修改</strong>，离开后这些改动会丢失。
        </p>
      </template>
    </ConfirmDialog>
  </div>
</template>
