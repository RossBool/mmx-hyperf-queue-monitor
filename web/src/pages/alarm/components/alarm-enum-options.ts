import type { AlarmMonitorType } from '@/types/alarm'

/**
 * 告警模块公共枚举选项 —— 把契约类型层的中文 label 映射转成下拉框可直接用的
 * `{ label, value }` 数组，供 **告警策略 / 通知模板 / 告警历史** 三个页面共用。
 *
 * 所有取值与文案都来自 `/workspace/docs/alarm/contract.md` §1，**不在此处二次定义枚举值**，
 * 统一从 `@/types/alarm` 引入，避免与契约漂移。
 *
 * 约定：下拉框一律用**数值 value**（`operator` / `handleAction` 除外，它们在契约里就是字符串），
 * label 取中文名。
 */
import {
  ALARM_CONDITION_LOGIC,
  ALARM_CONDITION_LOGIC_LABEL,
  ALARM_FREQUENCY,
  ALARM_FREQUENCY_LABEL,
  ALARM_HISTORY_STATUS,
  ALARM_HISTORY_STATUS_LABEL,
  ALARM_LEVEL,
  ALARM_LEVEL_LABEL,
  ALARM_MONITOR_TYPE,
  ALARM_MONITOR_TYPE_LABEL,
  ALARM_MONITOR_TYPE_POLICY_TYPES,
  ALARM_NOTIFY_CHANNEL,
  ALARM_NOTIFY_CHANNEL_LABEL,
  ALARM_OBJECT_TYPE,
  ALARM_OBJECT_TYPE_LABEL,
  ALARM_OPERATOR,
  ALARM_OPERATOR_LABEL,
  ALARM_PERIOD,
  ALARM_PERIOD_LABEL,
  ALARM_POLICY_STATUS,
  ALARM_POLICY_STATUS_LABEL,
  ALARM_POLICY_TYPE,
  ALARM_POLICY_TYPE_LABEL,
  ALARM_PRESET_FLAG,
  ALARM_PRESET_FLAG_LABEL,
} from '@/types/alarm'

/** 下拉/筛选项的通用形状，与 `DataTableToolbarFilter` 的 `FacetedFilterOption` 对齐。 */
export interface AlarmSelectOption<T extends number | string = number> {
  label: string
  value: T
}

/** 把 `as const` 枚举对象 + 中文 label 映射转成选项数组，顺序即对象声明顺序（= 契约表格顺序）。 */
function toOptions<T extends number | string>(
  dict: Record<string, T>,
  labels: Record<T, string>,
): AlarmSelectOption<T>[] {
  return Object.values(dict).map(value => ({ label: labels[value], value }))
}

/** 告警等级：紧急 / 严重 / 提示 */
export const alarmLevelOptions = toOptions(ALARM_LEVEL, ALARM_LEVEL_LABEL)

/** 统计粒度（分钟）：1 / 5 / 10 / 30 / 60 */
export const alarmPeriodOptions = toOptions(ALARM_PERIOD, ALARM_PERIOD_LABEL)

/** 比较关系。⚠️ value 是字符串字面量，**必须原样发送**，不要本地化成「大于」。 */
export const alarmOperatorOptions = toOptions(ALARM_OPERATOR, ALARM_OPERATOR_LABEL)

/** 重复通知频率（含扩展值 `0` 不重复） */
export const alarmFrequencyOptions = toOptions(ALARM_FREQUENCY, ALARM_FREQUENCY_LABEL)

/** 监控类型（**全部 5 项**，用于列表筛选 —— 可能存在存量数据需要按 3/4/5 查） */
export const alarmMonitorTypeOptions = toOptions(ALARM_MONITOR_TYPE, ALARM_MONITOR_TYPE_LABEL)

/**
 * 监控类型（**仅当前可用的**），用于新建/编辑向导。
 *
 * ⚠️ 契约 §1.1 联动表写明 `3`/`4`/`5`（RUM / 云拨测 / 终端性能）在 v1.0
 * **没有对应的 policyType，选了返回 422**。
 *
 * 此前向导直接用了 `alarmMonitorTypeOptions`（全部 5 项），于是：
 *   选「前端性能监控」→ 策略类型下拉为空 → 提示「该监控类型在 v1.0 暂无可用策略类型」
 *   → **用户既走不完向导，也退不出这个选择**，是功能不可用而非体验瑕疵。
 *
 * 正确做法是**不提供不可选项**，而不是提供后再告诉他不行。
 * 补齐 RUM / 云拨测的 policyType 与指标后，把 `ALARM_MONITOR_TYPE_POLICY_TYPES`
 * 里对应的空数组填上即可自动放开 —— 本函数的过滤是数据驱动的，无需改这里。
 */
export const alarmSelectableMonitorTypeOptions = alarmMonitorTypeOptions.filter(
  option => (ALARM_MONITOR_TYPE_POLICY_TYPES[option.value as AlarmMonitorType] ?? []).length > 0,
)

/** 策略类型 */
export const alarmPolicyTypeOptions = toOptions(ALARM_POLICY_TYPE, ALARM_POLICY_TYPE_LABEL)

/** 告警对象类型：全部对象 / 指定实例 / 实例分组 / 多维筛选 */
export const alarmObjectTypeOptions = toOptions(ALARM_OBJECT_TYPE, ALARM_OBJECT_TYPE_LABEL)

/** 条件间逻辑：满足所有条件 / 满足任意条件 */
export const alarmConditionLogicOptions = toOptions(ALARM_CONDITION_LOGIC, ALARM_CONDITION_LOGIC_LABEL)

/** 策略状态：停用 / 启用 */
export const alarmPolicyStatusOptions = toOptions(ALARM_POLICY_STATUS, ALARM_POLICY_STATUS_LABEL)

/** 告警历史状态：未处理 / 已处理 / 已忽略 / 已恢复 */
export const alarmHistoryStatusOptions = toOptions(ALARM_HISTORY_STATUS, ALARM_HISTORY_STATUS_LABEL)

/** 通知渠道：邮件 / 短信 / 微信 / 电话 / 回调 */
export const alarmNotifyChannelOptions = toOptions(ALARM_NOTIFY_CHANNEL, ALARM_NOTIFY_CHANNEL_LABEL)

/** 预置标记：自定义 / 系统预置 */
export const alarmPresetFlagOptions = toOptions(ALARM_PRESET_FLAG, ALARM_PRESET_FLAG_LABEL)
