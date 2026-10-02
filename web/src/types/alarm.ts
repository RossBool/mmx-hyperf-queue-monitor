/**
 * 告警管理模块 —— 契约类型层
 *
 * 唯一事实来源：`/workspace/docs/alarm/contract.md`（v1.0，已冻结）。
 * 本文件是 contract.md 的 **1:1 TypeScript 映射**：字段名、类型、可空性、枚举取值
 * 都不得在此处漂移。后端 Hyperf / 前端 Vue / 建表 DDL 三方均以 contract.md 为准。
 *
 * 约定（全模块统一，勿在调用点各自发挥）：
 * 1. **主键 `id` 一律是 `number`（正整数）**，不使用雪花 ID，不出现 string。
 * 2. **时间是 `YYYY-MM-DD HH:mm:ss` 字符串**（Asia/Shanghai，不带时区后缀），不是 `Date`。
 *    日期是 `YYYY-MM-DD` 字符串。统一用 `AlarmDateTime` / `AlarmDate` 别名标注。
 * 3. **`threshold` / `actualValue` 是 `number`**（DB 为 `DECIMAL(20,4)`），不是 string。
 * 4. **`operator` 是字符串字面量**（`'>' | '>=' | ...`），原样传输，禁止本地化成「大于」。
 * 5. **JSON 列的空值方向相反，务必区分**（contract.md §0.6 R-JSON-1 / R-JSON-2）：
 *    - `objectIds` / `objectGroupIds` / `objectFilters` 读出来**永远是 `null`，不是 `[]`**；
 *    - `notificationTemplateIds` 读出来**永远是数组**，不用判空。
 * 6. 业务失败时后端返回 `data: null`，用 `if (!res.success)` 判断，不要解构 `data`。
 * 7. 列表接口的 `data` **恒为分页对象**，不是裸数组。
 *
 * 响应信封 `IResponse<T>` 定义在 `src/services/types/response.type.ts`（contract.md §0.2
 * 明确要求「已存在，不要动」），本文件只定义 `data` 的业务载荷类型。
 *
 * @see ../services/types/response.type.ts —— 统一响应信封 + 分页请求基类
 * @see ../services/api/alarm-policy.api.ts —— ①-⑫ 传输层
 * @see ../services/api/alarm-notification.api.ts —— ⑬-⑯ 传输层
 * @see ../services/api/alarm-history.api.ts —— ⑰-⑲ 传输层
 */

// ============================================================================
// §0 通用类型（contract.md §0）
// ============================================================================

/** 时间字符串：`YYYY-MM-DD HH:mm:ss`，服务器时区 Asia/Shanghai，**不带时区后缀**。 */
export type AlarmDateTime = string

/** 日期字符串：`YYYY-MM-DD`。 */
export type AlarmDate = string

/**
 * 分页响应体（contract.md §0.3）。
 *
 * 所有列表端点的 `data` 都是这个形状，**不返回裸数组**。
 */
export interface AlarmPage<T> {
  /** 当前页数据 */
  list: T[]
  /** 总条数 */
  total: number
  /** 当前页码，从 1 开始 */
  page: number
  /** 每页条数 */
  pageSize: number
}

/** 分页请求参数（contract.md §0.3）。所有列表端点通用。 */
export interface AlarmPageQuery {
  /** 页码，`>= 1`，默认 1 */
  page?: number
  /** 每页条数，`1 <= pageSize <= 100`，默认 20；超出返回 422 */
  pageSize?: number
}

/**
 * 参数校验失败时 `extra` 的结构（contract.md §0.4，HTTP 422）。
 *
 * `field` 使用请求体/查询参数的点分路径，数组用下标，如 `conditions.0.threshold`。
 */
export interface AlarmValidationError {
  /** 字段点分路径 */
  field: string
  /** 中文可读原因，可直接展示 */
  message: string
}

/** 422 响应里 `extra` 的形状：`{ errors: [...] }`。 */
export interface AlarmValidationExtra {
  errors: AlarmValidationError[]
}

// ============================================================================
// §1 枚举字典（contract.md §1）
//
// 全部用 `as const` 对象 + 派生联合类型，并同时给出中文 label 映射，
// 下拉框直接用「label=中文名, value=数值」。
// ============================================================================

// ---------------------------------------------------------------------------
// §1.1 monitorType 监控类型
// ---------------------------------------------------------------------------

export const ALARM_MONITOR_TYPE = {
  CLOUD_PRODUCT: 1,
  APM: 2,
  RUM: 3,
  PING_SITE: 4,
  TERMINAL: 5,
} as const

export type AlarmMonitorType = (typeof ALARM_MONITOR_TYPE)[keyof typeof ALARM_MONITOR_TYPE]

export const ALARM_MONITOR_TYPE_LABEL: Record<AlarmMonitorType, string> = {
  [ALARM_MONITOR_TYPE.CLOUD_PRODUCT]: '云产品监控',
  [ALARM_MONITOR_TYPE.APM]: '应用性能监控',
  [ALARM_MONITOR_TYPE.RUM]: '前端性能监控',
  [ALARM_MONITOR_TYPE.PING_SITE]: '云拨测',
  [ALARM_MONITOR_TYPE.TERMINAL]: '终端性能监控',
}

// ---------------------------------------------------------------------------
// §1.2 policyType 策略类型
// ---------------------------------------------------------------------------

export const ALARM_POLICY_TYPE = {
  GENERIC_WEB: 1,
  CVM: 2,
  CLB: 3,
  MYSQL: 4,
} as const

export type AlarmPolicyType = (typeof ALARM_POLICY_TYPE)[keyof typeof ALARM_POLICY_TYPE]

export const ALARM_POLICY_TYPE_LABEL: Record<AlarmPolicyType, string> = {
  [ALARM_POLICY_TYPE.GENERIC_WEB]: '通用 Web 服务',
  [ALARM_POLICY_TYPE.CVM]: '云服务器 CVM',
  [ALARM_POLICY_TYPE.CLB]: '负载均衡 CLB',
  [ALARM_POLICY_TYPE.MYSQL]: '云数据库 MySQL',
}

/**
 * monitorType → 允许的 policyType（contract.md §1.1 联动表，v1.0 后端写死校验）。
 *
 * monitorType 3/4/5 在 v1.0 暂无策略类型，即**不可选**，选了返回 422。
 * 声明在 `ALARM_POLICY_TYPE` 之后，避免 TDZ 引用。
 */
export const ALARM_MONITOR_TYPE_POLICY_TYPES: Record<AlarmMonitorType, AlarmPolicyType[]> = {
  [ALARM_MONITOR_TYPE.CLOUD_PRODUCT]: [
    ALARM_POLICY_TYPE.CVM,
    ALARM_POLICY_TYPE.CLB,
    ALARM_POLICY_TYPE.MYSQL,
  ],
  [ALARM_MONITOR_TYPE.APM]: [ALARM_POLICY_TYPE.GENERIC_WEB],
  [ALARM_MONITOR_TYPE.RUM]: [],
  [ALARM_MONITOR_TYPE.PING_SITE]: [],
  [ALARM_MONITOR_TYPE.TERMINAL]: [],
}

// ---------------------------------------------------------------------------
// §1.3 level 告警等级（数值越小越严重）
// ---------------------------------------------------------------------------

export const ALARM_LEVEL = {
  EMERGENCY: 1,
  SERIOUS: 2,
  NOTICE: 3,
} as const

export type AlarmLevel = (typeof ALARM_LEVEL)[keyof typeof ALARM_LEVEL]

export const ALARM_LEVEL_LABEL: Record<AlarmLevel, string> = {
  [ALARM_LEVEL.EMERGENCY]: '紧急',
  [ALARM_LEVEL.SERIOUS]: '严重',
  [ALARM_LEVEL.NOTICE]: '提示',
}

// ---------------------------------------------------------------------------
// §1.4 period 统计粒度（分钟）
// ---------------------------------------------------------------------------

export const ALARM_PERIOD = {
  MINUTE_1: 1,
  MINUTE_5: 5,
  MINUTE_10: 10,
  MINUTE_30: 30,
  MINUTE_60: 60,
} as const

export type AlarmPeriod = (typeof ALARM_PERIOD)[keyof typeof ALARM_PERIOD]

export const ALARM_PERIOD_LABEL: Record<AlarmPeriod, string> = {
  [ALARM_PERIOD.MINUTE_1]: '1 分钟',
  [ALARM_PERIOD.MINUTE_5]: '5 分钟',
  [ALARM_PERIOD.MINUTE_10]: '10 分钟',
  [ALARM_PERIOD.MINUTE_30]: '30 分钟',
  [ALARM_PERIOD.MINUTE_60]: '60 分钟',
}

/** 合法 period 取值集合，供校验用（`period ∈ {1,5,10,30,60}`，contract.md P8）。 */
export const ALARM_PERIOD_VALUES = Object.values(ALARM_PERIOD) as AlarmPeriod[]

// ---------------------------------------------------------------------------
// §1.5 operator 比较关系（字符串，VARCHAR(2)，**原样传输不做本地化**）
// ---------------------------------------------------------------------------

export const ALARM_OPERATOR = {
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  EQ: '==',
  NE: '!=',
} as const

export type AlarmOperator = (typeof ALARM_OPERATOR)[keyof typeof ALARM_OPERATOR]

export const ALARM_OPERATOR_LABEL: Record<AlarmOperator, string> = {
  [ALARM_OPERATOR.GT]: '大于',
  [ALARM_OPERATOR.GTE]: '大于等于',
  [ALARM_OPERATOR.LT]: '小于',
  [ALARM_OPERATOR.LTE]: '小于等于',
  [ALARM_OPERATOR.EQ]: '等于',
  [ALARM_OPERATOR.NE]: '不等于',
}

// ---------------------------------------------------------------------------
// §1.6 frequency 告警频次 / 重复通知（分钟）
//
// 注意：`0`（不重复）是本模块的**扩展值**，不在腾讯云原枚举（8 个）之内；
// 其余 8 个取值与腾讯云一一对应。DB CHECK 约束覆盖全部 9 个值。
// ---------------------------------------------------------------------------

export const ALARM_FREQUENCY = {
  NEVER: 0,
  MIN_5: 5,
  MIN_15: 15,
  MIN_30: 30,
  MIN_60: 60,
  MIN_180: 180,
  MIN_360: 360,
  MIN_720: 720,
  MIN_1440: 1440,
} as const

export type AlarmFrequency = (typeof ALARM_FREQUENCY)[keyof typeof ALARM_FREQUENCY]

export const ALARM_FREQUENCY_LABEL: Record<AlarmFrequency, string> = {
  [ALARM_FREQUENCY.NEVER]: '不重复',
  [ALARM_FREQUENCY.MIN_5]: '每 5 分钟',
  [ALARM_FREQUENCY.MIN_15]: '每 15 分钟',
  [ALARM_FREQUENCY.MIN_30]: '每 30 分钟',
  [ALARM_FREQUENCY.MIN_60]: '每 1 小时',
  [ALARM_FREQUENCY.MIN_180]: '每 3 小时',
  [ALARM_FREQUENCY.MIN_360]: '每 6 小时',
  [ALARM_FREQUENCY.MIN_720]: '每 12 小时',
  [ALARM_FREQUENCY.MIN_1440]: '每 1 天',
}

// ---------------------------------------------------------------------------
// §1.7 objectType 告警对象类型
// ---------------------------------------------------------------------------

export const ALARM_OBJECT_TYPE = {
  ALL: 1,
  INSTANCE: 2,
  GROUP: 3,
  FILTER: 4,
} as const

export type AlarmObjectType = (typeof ALARM_OBJECT_TYPE)[keyof typeof ALARM_OBJECT_TYPE]

export const ALARM_OBJECT_TYPE_LABEL: Record<AlarmObjectType, string> = {
  [ALARM_OBJECT_TYPE.ALL]: '全部对象',
  [ALARM_OBJECT_TYPE.INSTANCE]: '指定实例',
  [ALARM_OBJECT_TYPE.GROUP]: '实例分组',
  [ALARM_OBJECT_TYPE.FILTER]: '多维筛选',
}

/** 多维筛选项（contract.md §1.7）。 */
export interface AlarmObjectFilter {
  /** 维度名，如 `region` / `appId` / `env` / `tag:service` */
  key: string
  /** 比较关系，取值同 `AlarmOperator` */
  operator: AlarmOperator
  /** 1-200 个候选值 */
  values: string[]
  /** `include` / `exclude`，默认 `include` */
  matchType?: 'include' | 'exclude'
}

/** `objectFilters[].matchType` 的合法取值。 */
export const ALARM_MATCH_TYPE = {
  INCLUDE: 'include',
  EXCLUDE: 'exclude',
} as const

export type AlarmMatchType = (typeof ALARM_MATCH_TYPE)[keyof typeof ALARM_MATCH_TYPE]

/**
 * objectType 与三个 object 字段的**一一对应**关系（contract.md P14）。
 * 与 objectType 不配套的字段**必须**为 `null` / `[]`，传非空值返回 422。
 *
 * 数组长度为上限；`null` 表示「该字段对当前 objectType 不适用」（R-JSON-1）。
 */
export const ALARM_OBJECT_TYPE_LIMITS: Record<
  AlarmObjectType,
  { field: null | 'objectIds' | 'objectGroupIds' | 'objectFilters', min: number, max: number }
> = {
  [ALARM_OBJECT_TYPE.ALL]: { field: null, min: 0, max: 0 },
  [ALARM_OBJECT_TYPE.INSTANCE]: { field: 'objectIds', min: 1, max: 1000 },
  [ALARM_OBJECT_TYPE.GROUP]: { field: 'objectGroupIds', min: 1, max: 100 },
  [ALARM_OBJECT_TYPE.FILTER]: { field: 'objectFilters', min: 1, max: 10 },
}

// ---------------------------------------------------------------------------
// §1.8 conditionLogic 条件间逻辑
// ---------------------------------------------------------------------------

export const ALARM_CONDITION_LOGIC = {
  AND: 1,
  OR: 2,
} as const

export type AlarmConditionLogic = (typeof ALARM_CONDITION_LOGIC)[keyof typeof ALARM_CONDITION_LOGIC]

export const ALARM_CONDITION_LOGIC_LABEL: Record<AlarmConditionLogic, string> = {
  [ALARM_CONDITION_LOGIC.AND]: '满足所有条件',
  [ALARM_CONDITION_LOGIC.OR]: '满足任意条件',
}

// ---------------------------------------------------------------------------
// §1.9 status 策略状态
// ---------------------------------------------------------------------------

export const ALARM_POLICY_STATUS = {
  DISABLED: 0,
  ENABLED: 1,
} as const

export type AlarmPolicyStatus = (typeof ALARM_POLICY_STATUS)[keyof typeof ALARM_POLICY_STATUS]

export const ALARM_POLICY_STATUS_LABEL: Record<AlarmPolicyStatus, string> = {
  [ALARM_POLICY_STATUS.DISABLED]: '停用',
  [ALARM_POLICY_STATUS.ENABLED]: '启用',
}

// ---------------------------------------------------------------------------
// §1.10 historyStatus 告警历史状态（DB 列名为 `status`）
// ---------------------------------------------------------------------------

export const ALARM_HISTORY_STATUS = {
  UNHANDLED: 1,
  HANDLED: 2,
  IGNORED: 3,
  RECOVERED: 4,
} as const

export type AlarmHistoryStatus = (typeof ALARM_HISTORY_STATUS)[keyof typeof ALARM_HISTORY_STATUS]

export const ALARM_HISTORY_STATUS_LABEL: Record<AlarmHistoryStatus, string> = {
  [ALARM_HISTORY_STATUS.UNHANDLED]: '未处理',
  [ALARM_HISTORY_STATUS.HANDLED]: '已处理',
  [ALARM_HISTORY_STATUS.IGNORED]: '已忽略',
  [ALARM_HISTORY_STATUS.RECOVERED]: '已恢复',
}

// ---------------------------------------------------------------------------
// §1.11 notifyChannel 通知渠道（DB 列名为 `channel`）
// ---------------------------------------------------------------------------

export const ALARM_NOTIFY_CHANNEL = {
  EMAIL: 1,
  SMS: 2,
  WECHAT: 3,
  VOICE: 4,
  CALLBACK: 5,
} as const

export type AlarmNotifyChannel = (typeof ALARM_NOTIFY_CHANNEL)[keyof typeof ALARM_NOTIFY_CHANNEL]

export const ALARM_NOTIFY_CHANNEL_LABEL: Record<AlarmNotifyChannel, string> = {
  [ALARM_NOTIFY_CHANNEL.EMAIL]: '邮件',
  [ALARM_NOTIFY_CHANNEL.SMS]: '短信',
  [ALARM_NOTIFY_CHANNEL.WECHAT]: '微信',
  [ALARM_NOTIFY_CHANNEL.VOICE]: '电话',
  [ALARM_NOTIFY_CHANNEL.CALLBACK]: '回调',
}

// ---------------------------------------------------------------------------
// §1.12 handleAction 告警处理动作（字符串，**由它决定落库后的 status**）
// ---------------------------------------------------------------------------

export const ALARM_HANDLE_ACTION = {
  HANDLE: 'handle',
  IGNORE: 'ignore',
  RECOVER: 'recover',
} as const

export type AlarmHandleAction = (typeof ALARM_HANDLE_ACTION)[keyof typeof ALARM_HANDLE_ACTION]

export const ALARM_HANDLE_ACTION_LABEL: Record<AlarmHandleAction, string> = {
  [ALARM_HANDLE_ACTION.HANDLE]: '处理',
  [ALARM_HANDLE_ACTION.IGNORE]: '忽略',
  [ALARM_HANDLE_ACTION.RECOVER]: '恢复',
}

/** handleAction → 处理后落库的历史状态（contract.md §1.12）。 */
export const ALARM_HANDLE_ACTION_TO_STATUS: Record<AlarmHandleAction, AlarmHistoryStatus> = {
  [ALARM_HANDLE_ACTION.HANDLE]: ALARM_HISTORY_STATUS.HANDLED,
  [ALARM_HANDLE_ACTION.IGNORE]: ALARM_HISTORY_STATUS.IGNORED,
  [ALARM_HANDLE_ACTION.RECOVER]: ALARM_HISTORY_STATUS.RECOVERED,
}

// ---------------------------------------------------------------------------
// §0.5 错误码
//
// `409` 下有 5 个语义分支（POLICY_STATUS_CONFLICT / POLICY_NAME_DUPLICATED /
// TEMPLATE_IN_USE / PRESET_READONLY / HISTORY_ALREADY_HANDLED），契约规定
// 前端**只需按 `code === 409` 做统一提示**（message 不同即可区分文案）。
// ---------------------------------------------------------------------------

export const ALARM_ERROR_CODE = {
  SUCCESS: 0,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  /** 5 种语义共用，按 code 统一提示 */
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  INTERNAL_ERROR: 500,
} as const

export type AlarmErrorCode = (typeof ALARM_ERROR_CODE)[keyof typeof ALARM_ERROR_CODE]

// ============================================================================
// §2 核心数据对象 DTO（contract.md §2）
// ============================================================================

// ---------------------------------------------------------------------------
// §2.1 AlarmPolicyCondition 触发条件
// ---------------------------------------------------------------------------

/** 触发条件中**由服务端按指标字典回填**的字段（contract.md §2.1 字典字段回填规则）。 */
export interface AlarmConditionDerived {
  /** 指标中文名，如 `CPU 使用率`。服务端从 `metrics.md` 回填，请求体传入的值一律忽略。 */
  metricNameCn: string
  /** 单位，如 `%`。服务端从 `metrics.md` 回填，请求体传入的值一律忽略。 */
  unit: string
}

/**
 * 触发条件（contract.md §2.1）。
 *
 * 条件数组长度 **1-4 条**（P4），`sort` 必须是 1..N 连续升序且不重复（P5）。
 * P10：**每条条件必须完整提供** `sort/metricNamespace/metricName/operator/threshold/period/continuity/level/frequency`，
 * 缺一即 422，**后端不做默认值兜底**，所以除 `id` 外全部是必填。
 */
export interface AlarmPolicyCondition extends AlarmConditionDerived {
  /** 条件 id。**仅响应返回**，请求体中必须省略。 */
  id?: number
  /** 策略内排序，1-4，升序。请求必填。 */
  sort: AlarmConditionSort
  /** 指标命名空间，如 `CVM`。必须存在于 `GET /api/alarm/metrics`。 */
  metricNamespace: string
  /** 指标英文名，如 `CpuUtilizationRate`。与 `metricNamespace` 组成字典唯一键。 */
  metricName: string
  /** 比较关系，原样传输 `> / >= / < / <= / == / !=`。 */
  operator: AlarmOperator
  /** 阈值，**可负数**，最多 4 位小数。DB 为 `DECIMAL(20,4)`，按 number 传输。 */
  threshold: number
  /** 统计粒度（分钟）。必须是该指标 `periodOptions[]` 的子集。 */
  period: AlarmPeriod
  /** 持续周期（数据点数），`1 <= continuity <= 10`。 */
  continuity: number
  /** 该条件命中后的告警等级。 */
  level: AlarmLevel
  /** 该条件的重复通知频率。 */
  frequency: AlarmFrequency
}

/** 条件在策略内的排序位（P5：1..N 连续升序，N <= 4）。 */
export type AlarmConditionSort = 1 | 2 | 3 | 4

/**
 * 触发条件的**请求体**形态（contract.md §2.1 + P10）。
 *
 * 与 `AlarmPolicyCondition`（响应形态）有两处刻意的差异：
 * 1. **`id` 必须省略** —— 契约原文「仅响应返回，请求体中必须省略」；
 * 2. **`metricNameCn` / `unit` 是可选的** —— P10 的必填清单里**没有**这两项，契约允许前端
 *    「选择带上（便于表单回显）」但后端**一律忽略**、改为从指标字典回填。
 *    所以这里不能直接复用响应类型，否则 §3.1 ③ 的官方示例请求体（不带这两个字段）会类型报错。
 *
 * 必填 9 项 = `sort` + P10 原文的 `metricNamespace/metricName/operator/threshold/period/continuity/level/frequency`，
 * 后端**不做任何默认值兜底**，缺一即 422。
 */
export type AlarmPolicyConditionPayload = Omit<AlarmPolicyCondition, 'id' | 'metricNameCn' | 'unit'>
  & Partial<Pick<AlarmPolicyCondition, 'metricNameCn' | 'unit'>>

// ---------------------------------------------------------------------------
// §2.2 / §2.3 AlarmPolicyListItem / AlarmPolicyDetail
// ---------------------------------------------------------------------------

/** 策略列表项（contract.md §2.2）。列表接口**不返回** `conditions` 明细与 `objectIds`。 */
export interface AlarmPolicyListItem {
  /** 策略 id */
  id: number
  /** 策略名称，1-128 字符，全局唯一 */
  name: string
  /** 备注，可能为 `""` */
  remark: string
  /** 监控类型 */
  monitorType: AlarmMonitorType
  /** 监控类型中文名，服务端回填 */
  monitorTypeCn: string
  /** 策略类型 */
  policyType: AlarmPolicyType
  /** 策略类型中文名，服务端回填 */
  policyTypeCn: string
  /** `0` 停用 / `1` 启用 */
  status: AlarmPolicyStatus
  /** 策略告警等级 = 所有条件中等级最严重者（`min(conditions[].level)`，P17），用于列表筛选与色标 */
  level: AlarmLevel
  /** 所属项目 id，`0` 表示未分配 */
  projectId: number
  /** 告警对象类型 */
  objectType: AlarmObjectType
  /** 触发条件条数（1-4） */
  conditionCount: number
  /** 已绑定的通知模板 id 列表（<=3）。**永远返回数组**，DB 存 NULL 时补 `[]`（R-JSON-2）。 */
  notificationTemplateIds: number[]
  /** 创建该策略时引用的触发条件模板 id，`0` 表示未使用模板 */
  conditionTemplateId: number
  /** 创建人姓名 */
  creatorName: string
  /** `YYYY-MM-DD HH:mm:ss` */
  createdAt: AlarmDateTime
  /** `YYYY-MM-DD HH:mm:ss` */
  updatedAt: AlarmDateTime
}

/** 策略详情里 `notificationTemplates[]` 的**摘要**结构（contract.md §2.3）。 */
export interface AlarmPolicyNotificationTemplateBrief {
  /** 模板 id */
  id: number
  /** 模板名称 */
  name: string
  /** `1` 系统预置 / `0` 自定义 */
  isPreset: AlarmPresetFlag
  /**
   * 渠道**编码数组**（只给编码，不给接收人），如 `[1, 2]`。
   *
   * ⚠️ 策略详情页拿到的是 `int[]`；只有通知模板管理页才是完整的 `NotificationChannel[]`。
   */
  channels: AlarmNotifyChannel[]
}

/** 预置标记：`1` 系统预置 / `0` 自定义。 */
export const ALARM_PRESET_FLAG = {
  CUSTOM: 0,
  PRESET: 1,
} as const

export type AlarmPresetFlag = (typeof ALARM_PRESET_FLAG)[keyof typeof ALARM_PRESET_FLAG]

export const ALARM_PRESET_FLAG_LABEL: Record<AlarmPresetFlag, string> = {
  [ALARM_PRESET_FLAG.CUSTOM]: '自定义',
  [ALARM_PRESET_FLAG.PRESET]: '系统预置',
}

/**
 * 策略详情（contract.md §2.3）= `AlarmPolicyListItem` 全部字段 **+** 下列字段。
 *
 * ⚠️ 三个 object 字段永远是 `null`（不是 `[]`），用来一眼看出「该字段对当前 objectType 不适用」（R-JSON-1）。
 */
export interface AlarmPolicyDetail extends AlarmPolicyListItem {
  /** 触发条件数组，长度 1-4，按 `sort` 升序 */
  conditions: AlarmPolicyCondition[]
  /** `objectType=2` 时有值，否则 `null`（**不返回 `[]`**） */
  objectIds: number[] | null
  /** `objectType=3` 时有值，否则 `null`（**不返回 `[]`**） */
  objectGroupIds: number[] | null
  /** `objectType=4` 时有值，元素见 `AlarmObjectFilter`，否则 `null`（**不返回 `[]`**） */
  objectFilters: AlarmObjectFilter[] | null
  /** 条件间逻辑 */
  conditionLogic: AlarmConditionLogic
  /** 通知模板摘要，最多 3 个，**不含接收人明细 */
  notificationTemplates: AlarmPolicyNotificationTemplateBrief[]
}

// ---------------------------------------------------------------------------
// §2.4 AlarmConditionTemplate 触发条件模板
// ---------------------------------------------------------------------------

export interface AlarmConditionTemplate {
  /** 模板 id */
  id: number
  /** 模板名称，1-64 字符，**全局唯一 */
  name: string
  /** 备注，<=500，默认 `""` */
  remark: string
  /** 策略类型 */
  policyType: AlarmPolicyType
  /** 条件数组，1-4 条。**不接受 null**。 */
  conditions: AlarmPolicyCondition[]
  /** `1` 预置 / `0` 自定义。**请求体忽略该字段，仅服务端写入**。 */
  isPreset: AlarmPresetFlag
  /** 创建人姓名 */
  creatorName: string
  /** `YYYY-MM-DD HH:mm:ss` */
  createdAt: AlarmDateTime
  /** `YYYY-MM-DD HH:mm:ss` */
  updatedAt: AlarmDateTime
}

// ---------------------------------------------------------------------------
// §2.5 AlarmNotificationTemplate 通知模板
// ---------------------------------------------------------------------------

/** 通知渠道明细（contract.md §2.5）。 */
export interface NotificationChannel {
  /** 通知渠道 */
  channel: AlarmNotifyChannel
  /**
   * 接收人列表，**0-100 个**。
   *
   * - `channel=5`（回调）时**必须为 `[]`**；
   * - 预置模板（`isPreset=1`）**允许为空数组**（出厂占位，需用户补充）；
   * - 非预置模板应配 1-100 个。
   *
   * 「是否配置完成」在**绑定处**统一校验（§4.3 N9），不在单条渠道上校验。
   */
  receivers: string[]
  /**
   * 回调地址。`channel=5` 时**必填**（`http(s)://` 开头，<=500 字符）；
   * 其他渠道**必须为 `null`**（N4）。
   */
  callbackUrl: string | null
  /** 静默时间（分钟），`0-1440`，默认 `0`（不静默） */
  silenceTime: number
}

/**
 * ⑭ / ⑮ 请求体里的单条通知渠道（contract.md §2.5）。
 *
 * **与响应类型的区别**：`callbackUrl` / `silenceTime` 在契约 §2.5 的"必填"列均为**否**
 * ——请求侧可以整个不传（后端按 `null` / `0` 处理，不做默认值兜底的字段只有 §4 P10 那八项）。
 * 响应侧则总是有值（`null` / `0`），所以 `NotificationChannel` 把它们声明为必填是正确的。
 *
 * ⚠️ 二者不能混用：直接复用 `NotificationChannel` 会让请求体被迫每次显式传这两个字段，
 * 照抄契约 §3.2 ⑭ 的官方示例请求体就会报 `TS2739: missing the following properties`。
 */
export interface NotificationChannelPayload
  extends Omit<NotificationChannel, 'callbackUrl' | 'silenceTime'> {
  /** `channel=5`（回调）时**必填**（N3）；`channel≠5` 时**必须为 `null`**（N4） */
  callbackUrl?: string | null
  /** `0-1440`，默认 `0`（不静默） */
  silenceTime?: number
}

export interface AlarmNotificationTemplate {
  /** 模板 id */
  id: number
  /** 模板名称，1-64 字符，**全局唯一 */
  name: string
  /** 备注，<=500，默认 `""` */
  remark: string
  /** 渠道数组，1-5 个，**同一 `channel` 不可重复**。**不接受 null**。 */
  channels: NotificationChannel[]
  /** `1` 预置 / `0` 自定义。**请求体传入无效**。 */
  isPreset: AlarmPresetFlag
  /** 创建人姓名 */
  creatorName: string
  /** `YYYY-MM-DD HH:mm:ss` */
  createdAt: AlarmDateTime
  /** `YYYY-MM-DD HH:mm:ss` */
  updatedAt: AlarmDateTime
}

// ---------------------------------------------------------------------------
// §2.6 AlarmHistory 告警历史
//
// 注意：除 `id` / `policyId` / `policyName` 等派生快照外，条件、指标、阈值字段
// 都是**触发时刻的快照**（策略可能已被修改或删除），历史表**无外键**。
// ---------------------------------------------------------------------------

export interface AlarmHistory {
  /** 历史 id */
  id: number
  /** 策略 id（策略可能已删除，故历史表无外键） */
  policyId: number
  /** 策略名称**快照**（冗余） */
  policyName: string
  /** 告警等级 */
  level: AlarmLevel
  /** 历史状态 */
  status: AlarmHistoryStatus
  /** 触发条件 id 快照，`0` 表示未知 */
  conditionId: number
  /** 指标命名空间快照 */
  metricNamespace: string
  /** 指标英文名快照 */
  metricName: string
  /** 指标中文名快照 */
  metricNameCn: string
  /** 单位快照 */
  unit: string
  /** 比较关系快照 */
  operator: AlarmOperator
  /** 阈值快照 */
  threshold: number
  /** 实际值，`null` 表示恢复类事件无实测值 */
  actualValue: number | null
  /** 统计粒度快照 */
  period: AlarmPeriod
  /** 持续周期快照 */
  continuity: number
  /** 告警对象类型快照 */
  objectType: AlarmObjectType
  /** 告警实例 id，`0` 表示无具体实例（全部对象场景） */
  objectId: number
  /** 告警实例名称 */
  objectName: string
  /** 告警内容摘要，<=500，**服务端生成 */
  content: string
  /** 触发时间 */
  triggeredAt: AlarmDateTime
  /** 持续时长（秒），未恢复为 `0` */
  duration: number
  /** 恢复时间，未恢复为 `null` */
  recoveredAt: AlarmDateTime | null
  /** 处理时间，未处理为 `null` */
  handledAt: AlarmDateTime | null
  /** 处理动作，未处理为 `null` */
  handleAction: AlarmHandleAction | null
  /** 处理人姓名，未处理为 `""` */
  handlerName: string
  /** 处理备注，<=500，未处理为 `""` */
  handleRemark: string
  /** 已通知次数（同一 `id` 重复推送计数） */
  notifyCount: number
  /** 记录创建时间 */
  createdAt: AlarmDateTime
}

// ---------------------------------------------------------------------------
// §2.7 AlarmMetric 指标字典条目
//
// 内容唯一来源是 `metrics.md` §1（共 28 个指标），**不在前端硬编码**，
// 运行时从 `GET /api/alarm/metrics` 拉取。
// ---------------------------------------------------------------------------

export interface AlarmMetric {
  /** 命名空间，如 `CVM`。对应条件的 `metricNamespace`。 */
  namespace: string
  /** 指标英文名。与 `namespace` 组成字典唯一键 `namespace + "." + metricName`。 */
  metricName: string
  /** 指标中文名 */
  metricNameCn: string
  /** 单位 */
  unit: string
  /** 适用的策略类型列表（一个指标可被多个 policyType 复用） */
  policyType: AlarmPolicyType[]
  /** 该指标允许的 `period` 取值子集 */
  periodOptions: AlarmPeriod[]
  /** 默认比较关系 */
  defaultOperator: AlarmOperator
  /** 推荐阈值 */
  defaultThreshold: number
  /** 推荐持续周期，1-10 */
  suggestedContinuity: number
  /** 指标说明 */
  description: string
}

// ---------------------------------------------------------------------------
// §2.8 服务端内部列 —— **不出现在任何 API DTO 中**
//
// `alarm_policy_condition.created_at / updated_at`、
// `alarm_notification_receiver.template_id / contact`
// 由服务端自行维护，前端**不应感知**，故本文件不定义对应字段。
// ============================================================================

// ---------------------------------------------------------------------------
// 首页统计 AlarmOverview（contract.md ⑲）
// ---------------------------------------------------------------------------

/** `GET /api/alarm/overview` → `levelDistribution[]` 元素：**固定 3 项，level 升序**，无数据补 0。 */
export interface AlarmLevelDistribution {
  /** 告警等级 */
  level: AlarmLevel
  /** 等级中文名，服务端回填 */
  levelCn: string
  /** 今日该等级的告警条数 */
  count: number
}

/** `GET /api/alarm/overview` → `trend7Days[]` 元素：**固定 7 项，date 升序**，无数据补 0。 */
export interface AlarmTrendPoint {
  /** `YYYY-MM-DD` */
  date: AlarmDate
  /** 当日告警总数 */
  total: number
  /** 当日未处理（`status=1`）条数 */
  unhandled: number
}

export interface AlarmOverview {
  /** 今日（服务器自然日 00:00:00 起）告警总数 */
  todayTotal: number
  /** 今日告警中 `status=1`（未处理）的条数 */
  todayUnhandled: number
  /** 策略总数 */
  policyTotal: number
  /** `status=1` 的策略数 */
  policyEnabledTotal: number
  /** 今日按等级分布，固定 3 项、level 升序（1,2,3），无数据补 0 */
  levelDistribution: AlarmLevelDistribution[]
  /** 近 7 天（含今日）趋势，固定 7 项、date 升序，无数据补 0 */
  trend7Days: AlarmTrendPoint[]
}

// ============================================================================
// §3 请求 payload / 查询对象（contract.md §3）
// ============================================================================

// ---------------------------------------------------------------------------
// 策略（①-⑦）
// ---------------------------------------------------------------------------

/** ① `GET /api/alarm/policies` 查询参数。多条件之间为 AND；空字符串视为未传。 */
export interface AlarmPolicyListQuery extends AlarmPageQuery {
  /** 模糊匹配 `name` / `remark`，<=128 */
  keyword?: string
  /** 监控类型 */
  monitorType?: AlarmMonitorType
  /** 策略类型 */
  policyType?: AlarmPolicyType
  /** 策略状态 */
  status?: AlarmPolicyStatus
  /** 告警等级 */
  level?: AlarmLevel
  /** 所属项目 id */
  projectId?: number
}

/**
 * ③ `POST /api/alarm/policies` / ④ `PUT /api/alarm/policies/{id}` 的请求体（**全量**）。
 *
 * PUT 是**全量更新语义**：未传的字段一律回落到默认值（等价于删除后重建子资源），
 * 所以 `conditions` 省略会被判为「清空」而直接 422。唯一例外是 `status`——
 * 省略时**保持原值不变**，启停只能走 `POST /policies/{id}/status`（P18）。
 */
export interface AlarmPolicyCreatePayload {
  /** 1-128 字符，**全局唯一**，去首尾空格后非空（P1） */
  name: string
  /** <=500，默认 `""`（P2） */
  remark?: string
  /** 监控类型。必须与 `policyType` 匹配（P3） */
  monitorType: AlarmMonitorType
  /** 策略类型。必须属于 `monitorType`（P3） */
  policyType: AlarmPolicyType
  /** `>= 0`，默认 `0`；`0` 表示未分配 */
  projectId?: number
  /** 告警对象类型。决定三个 object 字段谁必填、其余必须为 `null`/`[]`（P14） */
  objectType: AlarmObjectType
  /** `objectType=2` 时**必填**，1-1000 个；其他情况必须为 `null`/`[]` */
  objectIds?: number[] | null
  /** `objectType=3` 时**必填**，1-100 个；其他情况必须为 `null`/`[]` */
  objectGroupIds?: number[] | null
  /** `objectType=4` 时**必填**，1-10 条；其他情况必须为 `null`/`[]` */
  objectFilters?: AlarmObjectFilter[] | null
  /** 条件间逻辑，默认 `1`（AND） */
  conditionLogic?: AlarmConditionLogic
  /** 触发条件，**1-4 条且必填**；每条字段完整（`sort` 1..N 连续升序）（P4/P5/P10） */
  conditions: AlarmPolicyConditionPayload[]
  /** 最多 3 个、不重复、id 均须存在（P12/P13）。落库时 `[]`/`null` 均写为 `NULL`。 */
  notificationTemplateIds?: number[]
  /** `> 0` 时该模板须存在且 `policyType` 一致；默认 `0` 表示未使用模板 */
  conditionTemplateId?: number
  /** `1` 表示创建即启用，默认 `0`。**PUT 时省略表示保持原值**（P18）。 */
  status?: AlarmPolicyStatus
}

/** ⑥ `POST /api/alarm/policies/{id}/status` 请求体。**幂等**，重复设置相同值返回成功（P19）。 */
export interface AlarmPolicyStatusPayload {
  /** `1` 启用 / `0` 停用 */
  status: AlarmPolicyStatus
}

/** ⑦ `POST /api/alarm/policies/{id}/copy` 响应 `data`。无请求体（可为空对象）。 */
export interface AlarmPolicyCopyResult {
  /** 新策略 id */
  id: number
  /** 自动生成的新名称：`{原名} - 副本`，冲突则 `(2)`、`(3)`……最多到 `(99)` */
  name: string
}

// ---------------------------------------------------------------------------
// 指标与模板（⑧-⑯）
// ---------------------------------------------------------------------------

/** ⑧ `GET /api/alarm/metrics` 查询参数。响应 `data` 是 `AlarmMetric[]`（**不分页**，固定 28 条）。 */
export interface AlarmMetricListQuery {
  /** 按策略类型过滤，只返回 `policyType[]` 包含该值的指标 */
  policyType?: AlarmPolicyType
  /** 按命名空间精确过滤 */
  namespace?: string
  /** 模糊匹配 `metricName` / `metricNameCn` */
  keyword?: string
}

/** ⑨ `GET /api/alarm/condition-templates` 查询参数。 */
export interface AlarmConditionTemplateListQuery extends AlarmPageQuery {
  /** 策略类型 */
  policyType?: AlarmPolicyType
  /** 名称模糊匹配 */
  keyword?: string
  /** 按预置标记过滤 */
  isPreset?: AlarmPresetFlag
}

/** ⑩ `POST` / ⑪ `PUT /api/alarm/condition-templates` 的请求体。 */
export interface AlarmConditionTemplatePayload {
  /** 1-64 字符，全局唯一（T1） */
  name: string
  /** <=500，默认 `""` */
  remark?: string
  /** 策略类型。模板内所有 `metricNamespace` 必须属于该 policyType（T3） */
  policyType: AlarmPolicyType
  /** 条件数组，1-4 条，字段完整性同 P4-P11（T2） */
  conditions: AlarmPolicyConditionPayload[]
  /** **请求体忽略该字段，仅服务端写入 */
  isPreset?: AlarmPresetFlag
}

/** ⑬ `GET /api/alarm/notification-templates` 查询参数。 */
export interface AlarmNotificationTemplateListQuery extends AlarmPageQuery {
  /** 名称模糊匹配 */
  keyword?: string
  /** 按渠道过滤 */
  channel?: AlarmNotifyChannel
  /** 按预置标记过滤 */
  isPreset?: AlarmPresetFlag
}

/**
 * ⑭ `POST` / ⑮ `PUT /api/alarm/notification-templates` 的请求体。
 *
 * 列表接口**返回完整 `channels`**（含接收人），因为通知模板管理页需要编辑接收人。
 */
export interface AlarmNotificationTemplatePayload {
  /** 1-64 字符，全局唯一（N1） */
  name: string
  /** <=500，默认 `""` */
  remark?: string
  /** 1-5 条，`channel` 不可重复（N2）；`channel=5` 时 `callbackUrl` 必填且 `receivers` 必须为空（N3） */
  channels: NotificationChannelPayload[]
  /** **请求体传入无效**，仅服务端写入 */
  isPreset?: AlarmPresetFlag
}

// ---------------------------------------------------------------------------
// 告警历史与统计（⑰-⑲）
// ---------------------------------------------------------------------------

/** ⑰ `GET /api/alarm/histories` 查询参数。约束：`startTime <= endTime`，否则 422（H4）。 */
export interface AlarmHistoryListQuery extends AlarmPageQuery {
  /** 按策略过滤 */
  policyId?: number
  /** 告警等级 */
  level?: AlarmLevel
  /** 历史状态 */
  status?: AlarmHistoryStatus
  /** 模糊匹配 `policyName` / `objectName` / `metricNameCn`，<=128 */
  keyword?: string
  /** 触发时间下界（含），`YYYY-MM-DD HH:mm:ss` */
  startTime?: AlarmDateTime
  /** 触发时间上界（含），`YYYY-MM-DD HH:mm:ss` */
  endTime?: AlarmDateTime
}

/** ⑱ `POST /api/alarm/histories/{id}/handle` 请求体。 */
export interface AlarmHistoryHandlePayload {
  /** `handle` / `ignore` / `recover`（H1） */
  action: AlarmHandleAction
  /** 处理备注，<=500，默认 `""`（H2） */
  remark?: string
}

// ---------------------------------------------------------------------------
// 枚举收窄工具
//
// 为什么需要：查询类型（如 `AlarmPolicyListQuery.policyType?: AlarmPolicyType`）用的是
// **严格字面量联合**，这是刻意的——它能在编译期挡住 `level: 4`、`operator: '大于'` 这类
// 越界值。但表单/下拉组件产出的是 `number`，直接赋值会报
// `Type 'number' is not assignable to type 'AlarmPolicyType'`。
//
// 正确做法不是把类型放宽成 `number`（那等于把编译期的保护拆掉），也不是在调用处
// `as AlarmPolicyType` 硬断言（那等于绕过保护）。**用下面这组函数在运行时收窄一次**：
// 值合法就返回精确类型，非法就返回 `undefined`（对应"不筛该维度"）。
// ---------------------------------------------------------------------------

/** 构造一个「由数值收窄到枚举」的收窄函数。非法值返回 `undefined`，不做静默兜底。 */
function narrowByValues<T extends number>(map: Record<string, T>): (value: unknown) => T | undefined
function narrowByValues<T extends string>(map: Record<string, T>): (value: unknown) => T | undefined
function narrowByValues<T extends number | string>(map: Record<string, T>) {
  const allowed = new Set<T>(Object.values(map) as T[])
  return (value: unknown): T | undefined =>
    typeof value === typeof (allowed.values().next().value as T) && allowed.has(value as T)
      ? (value as T)
      : undefined
}

/** 监控类型收窄 */
export const toAlarmMonitorType = narrowByValues(ALARM_MONITOR_TYPE)
/** 策略类型收窄 */
export const toAlarmPolicyType = narrowByValues(ALARM_POLICY_TYPE)
/** 告警等级收窄（紧急/严重/提示 = 1/2/3） */
export const toAlarmLevel = narrowByValues(ALARM_LEVEL)
/** 统计周期收窄（1/5/10/30/60） */
export const toAlarmPeriod = narrowByValues(ALARM_PERIOD)
/** 比较关系收窄（`>` `>=` `<` `<=` `==` `!=`，**符号字符串**） */
export const toAlarmOperator = narrowByValues(ALARM_OPERATOR)
/** 重复通知频率收窄 */
export const toAlarmFrequency = narrowByValues(ALARM_FREQUENCY)
/** 告警对象类型收窄 */
export const toAlarmObjectType = narrowByValues(ALARM_OBJECT_TYPE)
/** 条件关系收窄（AND/OR） */
export const toAlarmConditionLogic = narrowByValues(ALARM_CONDITION_LOGIC)
/** 策略状态收窄（启用/停用） */
export const toAlarmPolicyStatus = narrowByValues(ALARM_POLICY_STATUS)
/** 告警处理状态收窄 */
export const toAlarmHistoryStatus = narrowByValues(ALARM_HISTORY_STATUS)
/** 通知渠道收窄（邮件/短信/微信/电话/回调 = 1..5） */
export const toAlarmNotifyChannel = narrowByValues(ALARM_NOTIFY_CHANNEL)
/** 告警处理动作收窄（`handle` / `ignore` / `recover`） */
export const toAlarmHandleAction = narrowByValues(ALARM_HANDLE_ACTION)
