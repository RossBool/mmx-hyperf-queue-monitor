/**
 * 通知模板 —— 纯逻辑层（**不依赖 Vue / DOM，可直接单测**）。
 *
 * 唯一事实来源：`/workspace/docs/alarm/contract.md` v1.0。字段名、枚举取值、校验规则
 * 全部照抄契约，本文件**不新增任何契约之外的字段**（包括不臆造「启用状态」）。
 *
 * 落地的契约条款：
 * - §0.3 分页：`page >= 1`、`1 <= pageSize <= 100`（超出返回 422，前端先本地夹取）
 * - §1.11 通知渠道字典（5 个渠道，回调=5）
 * - §2.5 `AlarmNotificationTemplate` / `NotificationChannel`
 * - §4.3 N1-N9 业务约束
 *
 * 与组件的分工：表单组件只负责**收集输入**，所有「能不能提交 / 提交成什么形状」的判断
 * 都落在这里，这样边界（N2 至少 1 个渠道、N3 回调 URL 必填…）可以被单测直接覆盖。
 */
import type {
  AlarmNotificationTemplate,
  AlarmNotificationTemplateListQuery,
  AlarmNotificationTemplatePayload,
  AlarmNotifyChannel,
  AlarmPresetFlag,
  NotificationChannel,
} from '@/types/alarm'

import { ALARM_NOTIFY_CHANNEL, ALARM_NOTIFY_CHANNEL_LABEL } from '@/types/alarm'

// ============================================================================
// 常量（全部来自契约的取值范围，不是自创阈值）
// ============================================================================

/** 契约 §1.11 的 5 个渠道，顺序 = contract.md 表格顺序。 */
export const NOTIFY_CHANNEL_VALUES: AlarmNotifyChannel[] = [
  ALARM_NOTIFY_CHANNEL.EMAIL,
  ALARM_NOTIFY_CHANNEL.SMS,
  ALARM_NOTIFY_CHANNEL.WECHAT,
  ALARM_NOTIFY_CHANNEL.VOICE,
  ALARM_NOTIFY_CHANNEL.CALLBACK,
]

/** 回调渠道：§1.11 `channel=5`，唯一「接收人为空、必须配 callbackUrl」的渠道。 */
export const CALLBACK_CHANNEL: AlarmNotifyChannel = ALARM_NOTIFY_CHANNEL.CALLBACK

/** N2：`channels` 1-5 条。 */
export const CHANNELS_MIN = 1
export const CHANNELS_MAX = 5

/** N1：`name` 1-64 字符。 */
export const NAME_MAX_LENGTH = 64
export const NAME_MIN_LENGTH = 1

/** 契约 §2.5：`remark` <=500。 */
export const REMARK_MAX_LENGTH = 500

/** N5：`receivers` 0-100 个。⚠️ min 已被取消为 0，预置模板出厂就是空数组。 */
export const RECEIVERS_MAX_COUNT = 100

/** N3：`callbackUrl` <=500 字符。 */
export const CALLBACK_URL_MAX_LENGTH = 500

/** N6：`silenceTime` ∈ [0, 1440]，默认 0。 */
export const SILENCE_TIME_MIN = 0
export const SILENCE_TIME_MAX = 1440

/** §0.3 分页边界。 */
export const PAGE_MIN = 1
export const PAGE_SIZE_MIN = 1
export const PAGE_SIZE_MAX = 100
export const PAGE_SIZE_DEFAULT = 20

// ============================================================================
// 基础格式校验（N5：「邮箱/手机号需通过基础格式校验」）
// ============================================================================

/** N3：`callbackUrl` 必须 `http(s)://` 开头且不含空白。 */
export const CALLBACK_URL_PATTERN = /^https?:\/\/\S+$/i

/**
 * N5 邮件接收人基础格式。
 *  ⚠️ 两个 `[^\s@.]+` 之间由**字面量 `.`** 分隔（域名的每个标签段都不含 `.`），
 *  所以匹配点唯一，回溯是线性的——不能写成 `(\.[^\s@]+)+`，那会触发指数级回溯。
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

/** N5 短信接收人基础格式：可选国际区号 + 6-20 位数字。 */
export const PHONE_PATTERN = /^\+?\d{6,20}$/

/** N5 电话接收人：契约 §1.11 明确「仅大陆」，故用大陆手机号格式。 */
export const VOICE_PATTERN = /^1[3-9]\d{9}$/

/**
 * 各渠道的接收人格式要求。
 *
 * 用 `Record<AlarmNotifyChannel, …>` 而不是 `switch`，是为了让**漏掉某个渠道变成编译期错误**
 * 而不是运行时静默放行；`null` 表示契约未定义可校验格式（微信号/公众号、回调）。
 */
const RECEIVER_PATTERN_BY_CHANNEL: Record<AlarmNotifyChannel, RegExp | null> = {
  [ALARM_NOTIFY_CHANNEL.EMAIL]: EMAIL_PATTERN,
  [ALARM_NOTIFY_CHANNEL.SMS]: PHONE_PATTERN,
  [ALARM_NOTIFY_CHANNEL.WECHAT]: null,
  [ALARM_NOTIFY_CHANNEL.VOICE]: VOICE_PATTERN,
  [ALARM_NOTIFY_CHANNEL.CALLBACK]: null,
}

/** 格式不匹配时的中文原因，与 `RECEIVER_PATTERN_BY_CHANNEL` 一一对应。 */
const RECEIVER_ERROR_BY_CHANNEL: Record<AlarmNotifyChannel, string | null> = {
  [ALARM_NOTIFY_CHANNEL.EMAIL]: '邮箱格式不正确',
  [ALARM_NOTIFY_CHANNEL.SMS]: '手机号格式不正确',
  [ALARM_NOTIFY_CHANNEL.WECHAT]: null,
  [ALARM_NOTIFY_CHANNEL.VOICE]: '电话渠道仅支持大陆手机号',
  [ALARM_NOTIFY_CHANNEL.CALLBACK]: null,
}

/**
 * 校验单个接收人是否合法；合法返回 `null`，否则返回中文原因。
 *
 * ⚠️ 这是**基础**格式校验，不是严格校验——契约只要求「基础格式」，
 * 真正的最终判定在服务端（N5 违反返回 422）。
 */
export function validateReceiver(channel: AlarmNotifyChannel, receiver: string): string | null {
  const value = receiver.trim()
  if (!value)
    return '接收人不能为空'

  // 微信号/公众号没有可校验的统一格式，契约也未要求，只挡首尾空白
  const pattern = RECEIVER_PATTERN_BY_CHANNEL[channel]
  if (!pattern)
    return null

  return pattern.test(value) ? null : (RECEIVER_ERROR_BY_CHANNEL[channel] ?? '接收人格式不正确')
}

/** 渠道编码 → 中文名。未知值回落到 `未知渠道(x)`，避免渲染出 `undefined`。 */
export function channelLabel(channel: AlarmNotifyChannel): string {
  return ALARM_NOTIFY_CHANNEL_LABEL[channel] ?? `未知渠道(${channel})`
}

// ============================================================================
// 表单草稿（组件状态）↔ 请求体 `NotificationChannel`（契约形状）
// ============================================================================

/**
 * 表单里的渠道草稿。⚠️ `key` **只用于前端列表渲染，绝不进请求体**——
 * 契约 §2.5 的 `NotificationChannel` 只有 4 个字段。
 */
export interface ChannelDraft {
  /** 前端稳定 key，仅用于 `v-for` */
  key: string
  channel: AlarmNotifyChannel
  receivers: string[]
  /** 表单里用空串表示「未填」，提交时非回调渠道一律归一化成 `null`（N4） */
  callbackUrl: string
  silenceTime: number
}

/** 新建一个空白渠道草稿。 */
export function createChannelDraft(channel: AlarmNotifyChannel, key: string): ChannelDraft {
  return {
    key,
    channel,
    receivers: [],
    callbackUrl: '',
    // N6：默认 0 = 不静默
    silenceTime: 0,
  }
}

/** 契约响应 `NotificationChannel[]` → 表单草稿（编辑页回显）。 */
export function channelsToDrafts(channels: NotificationChannel[] | null | undefined): ChannelDraft[] {
  if (!Array.isArray(channels))
    return []

  return channels.map((channel, index) => ({
    key: `channel-${channel?.channel ?? index}-${index}`,
    channel: channel.channel,
    receivers: Array.isArray(channel.receivers) ? [...channel.receivers] : [],
    // 契约里非回调渠道 callbackUrl 恒为 null，这里统一成空串便于表单绑定
    callbackUrl: channel.callbackUrl ?? '',
    silenceTime: Number.isFinite(channel.silenceTime) ? channel.silenceTime : 0,
  }))
}

/**
 * 渠道草稿 → 契约请求体 `NotificationChannel`。
 *
 * 归一化（对应 §4.3 N3 / N4 / N5）：
 * - `channel=5`（回调）：`receivers` **强制为 `[]`**，`callbackUrl` 去空白
 * - `channel≠5`：`callbackUrl` **强制为 `null`**（N4）
 * - `receivers`：去首尾空格、丢弃空串（不改变 N5 的 0-100 语义）
 */
export function draftToPayloadChannel(draft: ChannelDraft): NotificationChannel {
  const isCallback = draft.channel === CALLBACK_CHANNEL
  const receivers = (Array.isArray(draft.receivers) ? draft.receivers : [])
    .map(item => String(item ?? '').trim())
    .filter(Boolean)

  return {
    channel: draft.channel,
    receivers: isCallback ? [] : receivers,
    callbackUrl: isCallback ? (draft.callbackUrl ?? '').trim() : null,
    silenceTime: Number.isFinite(draft.silenceTime) ? draft.silenceTime : 0,
  }
}

/**
 * 渠道草稿数组 → 契约请求体 `channels[]`：去重 + 按契约渠道顺序排序。
 *
 * N2 明确「同一 `channel` 不可重复」。表单用多选构造，理论上不会重复，
 * 这里仍然去重（保留首次出现）作为最后一道防线——**不让脏数据走到请求里**。
 */
export function buildChannelsPayload(drafts: ChannelDraft[] | null | undefined): NotificationChannel[] {
  if (!Array.isArray(drafts))
    return []

  const seen = new Set<AlarmNotifyChannel>()
  const channels: NotificationChannel[] = []

  for (const draft of drafts) {
    if (!draft || seen.has(draft.channel))
      continue
    seen.add(draft.channel)
    channels.push(draftToPayloadChannel(draft))
  }

  return channels.sort(
    (a, b) => NOTIFY_CHANNEL_VALUES.indexOf(a.channel) - NOTIFY_CHANNEL_VALUES.indexOf(b.channel),
  )
}

// ============================================================================
// 表单校验（N1-N6）
// ============================================================================

/** 错误字段路径，格式与契约 §0.4 的 `extra.errors[].field` 一致（点分路径，数组用下标）。 */
export type TemplateFieldPath
  = | 'name'
    | 'remark'
    | 'channels'
    | `channels.${number}.receivers`
    | `channels.${number}.callbackUrl`
    | `channels.${number}.silenceTime`

export interface TemplateValidationError {
  field: TemplateFieldPath
  message: string
}

/** 通知模板表单的原始输入。 */
export interface TemplateDraft {
  name: string
  remark: string
  channels: ChannelDraft[]
}

export type TemplateValidationResult
  = | { ok: true, payload: AlarmNotificationTemplatePayload }
    | { ok: false, errors: TemplateValidationError[] }

/**
 * 校验草稿并产出 `AlarmNotificationTemplatePayload`（契约 §2.5 的可写字段）。
 *
 * ⚠️ **不会**把 `isPreset` 塞进 payload：契约 §2.5 写明「请求体传入无效，仅服务端写入」，
 * 预置标记只用于**删除按钮的禁用判断**（N7）。
 */
export function validateTemplateDraft(draft: TemplateDraft): TemplateValidationResult {
  const errors: TemplateValidationError[] = []

  // ---- N1：name 1-64 字符 ----
  const name = (draft.name ?? '').trim()
  if (name.length < NAME_MIN_LENGTH)
    errors.push({ field: 'name', message: '模板名称不能为空' })
  else if (name.length > NAME_MAX_LENGTH)
    errors.push({ field: 'name', message: `模板名称不能超过 ${NAME_MAX_LENGTH} 个字符` })

  // ---- remark <= 500 ----
  const remark = (draft.remark ?? '').trim()
  if (remark.length > REMARK_MAX_LENGTH)
    errors.push({ field: 'remark', message: `备注不能超过 ${REMARK_MAX_LENGTH} 个字符` })

  // ---- N2：channels 至少 1 条、至多 5 条、channel 不重复 ----
  const channels = buildChannelsPayload(draft.channels)
  if (channels.length < CHANNELS_MIN) {
    errors.push({ field: 'channels', message: '至少需要选择 1 个接收渠道' })
  }
  else if (channels.length > CHANNELS_MAX) {
    errors.push({ field: 'channels', message: `接收渠道最多 ${CHANNELS_MAX} 个` })
  }

  // 逐条校验走**原始草稿**而不是归一化后的 payload：
  //  - 错误路径 `channels.<i>` 与用户看到的表单行号一一对应；
  //  - N4（非回调渠道不得填 callbackUrl）在归一化后 callbackUrl 已被强制成 null，
  //    只校验 payload 会让这条规则变成**永远不触发的死代码**。走原始草稿才能真正提示用户
  //    「你在邮件渠道填的 URL 不会被发送」，而不是静默丢弃。
  (draft.channels ?? []).forEach((item, index) => {
    if (!item)
      return

    const path = `channels.${index}` as const
    const normalized = draftToPayloadChannel(item)
    const rawCallbackUrl = (item.callbackUrl ?? '').trim()
    // 原始草稿里的接收人（未归一化）：回调渠道的 payload 会强制清空它，
    // 所以要用原始值才能检出「填了但会被丢弃」的情况。
    const rawReceivers = (Array.isArray(item.receivers) ? item.receivers : [])
      .map(item2 => String(item2 ?? '').trim())
      .filter(Boolean)

    // ---- N5：receivers 0-100 个 + 基础格式（回调渠道的 receivers 恒为 []，天然跳过）----
    if (normalized.receivers.length > RECEIVERS_MAX_COUNT) {
      errors.push({
        field: `${path}.receivers`,
        message: `${channelLabel(item.channel)}的接收人不能超过 ${RECEIVERS_MAX_COUNT} 个`,
      })
    }
    else {
      normalized.receivers.forEach((receiver, receiverIndex) => {
        const reason = validateReceiver(item.channel, receiver)
        if (reason) {
          errors.push({
            field: `${path}.receivers`,
            message: `${channelLabel(item.channel)}的第 ${receiverIndex + 1} 个接收人：${reason}`,
          })
        }
      })
    }

    // ---- N3：回调渠道 callbackUrl 必填、http(s):// 开头、<=500 ----
    //      （`receivers` 必须为空由 `draftToPayloadChannel` 在构造 payload 时强制）
    if (item.channel === CALLBACK_CHANNEL) {
      if (!rawCallbackUrl) {
        errors.push({ field: `${path}.callbackUrl`, message: '选择「回调」渠道时，回调 Webhook URL 必填' })
      }
      else if (rawCallbackUrl.length > CALLBACK_URL_MAX_LENGTH) {
        errors.push({
          field: `${path}.callbackUrl`,
          message: `回调 Webhook URL 不能超过 ${CALLBACK_URL_MAX_LENGTH} 个字符`,
        })
      }
      else if (!CALLBACK_URL_PATTERN.test(rawCallbackUrl)) {
        errors.push({ field: `${path}.callbackUrl`, message: '回调 Webhook URL 必须以 http:// 或 https:// 开头' })
      }

      // ---- N3 的另一半：回调渠道填了接收人 ----
      // payload 侧 `draftToPayloadChannel` 会把回调渠道的 receivers 强制清空，
      // 若只校验归一化结果，用户填的接收人就**无声无息消失**（不报错、不提示）——
      // 比报错更糟：用户以为配好了，实际一条也发不出去。
      // 这里走原始草稿显式提示，与下方 N4 分支对称。
      if (rawReceivers.length > 0) {
        errors.push({
          field: `${path}.receivers`,
          message: '「回调」渠道不使用接收人，请改填回调 Webhook URL（已填的接收人不会被保存）',
        })
      }
    }
    // ---- N4：非回调渠道 callbackUrl 必须为 null ----
    else if (rawCallbackUrl) {
      errors.push({ field: `${path}.callbackUrl`, message: '仅「回调」渠道可以填写 Webhook URL' })
    }

    // ---- N6：silenceTime ∈ [0, 1440] ----
    const silenceTime = normalized.silenceTime
    if (silenceTime < SILENCE_TIME_MIN || silenceTime > SILENCE_TIME_MAX) {
      errors.push({
        field: `${path}.silenceTime`,
        message: `静默时间必须在 ${SILENCE_TIME_MIN}-${SILENCE_TIME_MAX} 分钟之间`,
      })
    }
  })

  if (errors.length > 0)
    return { ok: false, errors }

  return {
    ok: true,
    payload: { name, remark, channels },
  }
}

// ============================================================================
// N9 绑定就绪度（「某渠道 channel≠5 且 receivers 为空 → 未配置完成」）
// ============================================================================

export interface TemplateReadiness {
  /** 是否已配置完成（N9：可以绑定到策略） */
  ready: boolean
  /** 未配置完成的渠道编码（`channel≠5` 且 `receivers` 为空） */
  unconfiguredChannels: AlarmNotifyChannel[]
  /** 未配置完成的原因（N9 指出「未配置完成」的模板拒绝绑定），null = 已就绪 */
  message: string | null
}

/**
 * 判定模板是否配置完成（N9）。
 *
 * 契约 §4.3 N9：策略的 `notificationTemplateIds` 中，凡存在 `channel≠5` 且该渠道
 * `receivers` 为空的模板，视为**未配置完成**，拒绝绑定。
 * ⚠️ **回调渠道（5）的 `receivers` 本来就必须为空**，所以它永远不参与判定。
 *
 * 注意：这只是**前端提示**。真正的拒绝发生在策略保存时（后端返 422），
 * 前端不替后端做拦截，只是提前把话说清楚。
 */
export function getTemplateReadiness(
  channels: NotificationChannel[] | null | undefined,
): TemplateReadiness {
  // 防御：`channels` 缺失或为空数组的模板**一律按「未配置完成」处理**。
  // 契约 §2.5 声明 `channels` 必填 1-5 条，所以这两种形态只可能来自脏响应；
  // 此时若返回 ready=true 会让「可以绑定」的判断建立在空数据上，属于**失效开放**，故取失效关闭。
  if (!Array.isArray(channels) || channels.length === 0) {
    return {
      ready: false,
      unconfiguredChannels: [],
      message: '接收渠道信息缺失，请检查模板配置后再绑定到策略',
    }
  }

  const unconfiguredChannels = channels
    .filter(channel => channel.channel !== CALLBACK_CHANNEL && (!Array.isArray(channel.receivers) || channel.receivers.length === 0))
    .map(channel => channel.channel)
    .sort((a, b) => NOTIFY_CHANNEL_VALUES.indexOf(a) - NOTIFY_CHANNEL_VALUES.indexOf(b))

  if (unconfiguredChannels.length === 0)
    return { ready: true, unconfiguredChannels: [], message: null }

  const names = unconfiguredChannels.map(channelLabel).join('、')
  return {
    ready: false,
    unconfiguredChannels,
    message: `${names}渠道未配置接收人，请补充接收人后才能绑定到策略`,
  }
}

/** 列表页表格用：所有渠道的接收人总数（回调渠道不计，它没有接收人）。 */
export function countReceivers(channels: NotificationChannel[] | null | undefined): number {
  if (!Array.isArray(channels))
    return 0

  return channels.reduce((total, channel) => {
    if (channel.channel === CALLBACK_CHANNEL)
      return total
    return total + (Array.isArray(channel.receivers) ? channel.receivers.length : 0)
  }, 0)
}

// ============================================================================
// 列表查询参数（契约 ⑬ + §0.3）
// ============================================================================

/** 列表页筛选态。`channel` / `isPreset` 为 `undefined` 表示「全部」。 */
export interface TemplateFilterState {
  keyword: string
  channel?: AlarmNotifyChannel
  isPreset?: AlarmPresetFlag
}

/** 页码夹取到 §0.3 的合法区间。`abc` / `0` / `-1` / `NaN` 一律回落到 1。 */
export function clampPage(page: unknown): number {
  const value = Number(page)
  return Number.isInteger(value) && value >= PAGE_MIN ? value : PAGE_MIN
}

/** 每页条数夹取到 §0.3 的 `[1, 100]`；非法值回落到默认 20。 */
export function clampPageSize(pageSize: unknown): number {
  const value = Number(pageSize)
  if (!Number.isFinite(value))
    return PAGE_SIZE_DEFAULT
  return Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.trunc(value)))
}

/** 判断一个值是否为合法的通知渠道枚举（用于容错 query / 脏数据）。 */
export function isNotifyChannel(value: unknown): value is AlarmNotifyChannel {
  return NOTIFY_CHANNEL_VALUES.includes(value as AlarmNotifyChannel)
}

/**
 * 筛选态 + 分页 → 契约 ⑬ 的查询参数。
 *
 * 归一化：空字符串按「未传」处理（契约 §3.1 的通用约定），非法枚举值直接丢弃而不是
 * 透传给后端——契约规定非法枚举值返回 422，前端宁可不过滤也不要制造 422。
 */
export function buildTemplateListQuery(
  filters: TemplateFilterState,
  page: unknown = PAGE_MIN,
  pageSize: unknown = PAGE_SIZE_DEFAULT,
): AlarmNotificationTemplateListQuery {
  const query: AlarmNotificationTemplateListQuery = {
    page: clampPage(page),
    pageSize: clampPageSize(pageSize),
  }

  const keyword = (filters?.keyword ?? '').trim()
  if (keyword)
    query.keyword = keyword

  if (isNotifyChannel(filters?.channel))
    query.channel = filters.channel

  if (filters?.isPreset === 0 || filters?.isPreset === 1)
    query.isPreset = filters.isPreset

  return query
}

// ============================================================================
// 错误消息提取（契约 §0.5：前端按 code 统一提示，message 是中文可读文案）
// ============================================================================

interface AlarmEnvelopeLike {
  code?: unknown
  message?: unknown
  success?: unknown
}

function readEnvelope(source: unknown): AlarmEnvelopeLike | null {
  if (!source || typeof source !== 'object')
    return null
  return source as AlarmEnvelopeLike
}

function messageFrom(source: unknown): string | null {
  const envelope = readEnvelope(source)
  const message = envelope?.message
  return typeof message === 'string' && message.trim() ? message : null
}

/**
 * 从抛出的错误里取出后端的**中文 message**，取不到才用 `fallback`。
 *
 * 为什么要兼容两种形状：
 * 1. **真实 HTTP**：契约 §0.2 规定「HTTP 状态码与 code 保持一致」，所以 409/422/404
 *    在 `ofetch` 里是**抛异常**（`FetchError.data` = 信封 body）。
 * 2. **mock 模式**（`VITE_USE_MOCK=true`）：`src/mocks` 直接 `return` 一个
 *    `success: false` 的信封，**不抛异常**。
 * 两种都要能拿到 `message`，否则 409 会退化成一句无信息的「操作失败」。
 */
export function extractAlarmErrorMessage(error: unknown, fallback: string): string {
  const candidates = [
    error,
    (error as { data?: unknown })?.data,
    (error as { response?: { _data?: unknown } })?.response?._data,
    (error as { data?: { data?: unknown } })?.data?.data,
  ]

  for (const candidate of candidates) {
    const message = messageFrom(candidate)
    if (message)
      return message
  }

  return fallback
}

/** 判断一个**已 resolve** 的响应是否是业务失败（mock 模式下的 409 会走这里）。 */
export function isAlarmFailure(res: { success?: boolean, message?: string } | null | undefined): boolean {
  return !res?.success
}

// ============================================================================
// 列表行派生（展示用）
// ============================================================================

/** 契约 §2.5 响应 → 列表行需要的派生数据。 */
export interface TemplateRowMeta {
  /** 所有渠道编码（按契约顺序） */
  channelValues: AlarmNotifyChannel[]
  /** 接收人数（回调渠道不计） */
  receiverCount: number
  /** N9 就绪度 */
  readiness: TemplateReadiness
}

/** 列表行派生：渠道编码 / 接收人数 / N9 提示。 */
export function buildTemplateRowMeta(template: AlarmNotificationTemplate): TemplateRowMeta {
  const channels = Array.isArray(template?.channels) ? template.channels : []

  return {
    channelValues: channels
      .map(channel => channel.channel)
      .filter(isNotifyChannel)
      .sort((a, b) => NOTIFY_CHANNEL_VALUES.indexOf(a) - NOTIFY_CHANNEL_VALUES.indexOf(b)),
    receiverCount: countReceivers(channels),
    readiness: getTemplateReadiness(channels),
  }
}
