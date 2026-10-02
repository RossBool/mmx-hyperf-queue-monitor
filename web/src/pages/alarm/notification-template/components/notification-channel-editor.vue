<script setup lang="ts">
/**
 * 单个通知渠道的编辑块（契约 §2.5 `NotificationChannel`）。
 *
 * 渠道相关规则全部来自 `../logic.ts`（已单测覆盖），本组件只负责**收集输入**：
 * - `channel≠5`：接收人用标签式输入（N5：0-100 个，可为空 → N9 未配置完成）
 * - `channel=5`（回调）：**只显示 Webhook URL**，不显示接收人输入（N3：receivers 必须为空）
 * - 两个渠道都有静默时间（N6：0-1440 分钟）
 *
 * ⚠️ 接收人目前**没有可用的数据源**（契约未提供人员/用户组列表端点），
 * 所以做成可增删的标签式输入，并在界面上注明这一点。
 */
import type { AlarmNotifyChannel } from '@/types/alarm'

import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NumberField, NumberFieldContent, NumberFieldDecrement, NumberFieldIncrement, NumberFieldInput } from '@/components/ui/number-field'
import { TagsInput, TagsInputInput, TagsInputItem, TagsInputItemDelete, TagsInputItemText } from '@/components/ui/tags-input'
import { ALARM_NOTIFY_CHANNEL } from '@/types/alarm'

import type { ChannelDraft } from '../logic'

import {
  CALLBACK_CHANNEL,
  CALLBACK_URL_MAX_LENGTH,
  channelLabel,
  RECEIVERS_MAX_COUNT,
  SILENCE_TIME_MAX,
  SILENCE_TIME_MIN,
} from '../logic'

const props = defineProps<{
  draft: ChannelDraft
  /** 该行的校验错误（来自 `validateTemplateDraft`，路径形如 `channels.0.receivers`） */
  errors: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:draft': [draft: ChannelDraft]
}>()

const isCallback = computed(() => props.draft.channel === CALLBACK_CHANNEL)

/**
 * 契约 §1.11「必填字段」一列的展示文案，贴在输入框下面让人知道该填什么。
 *
 * 用 `Record<AlarmNotifyChannel, string>` 而不是 `switch` 的理由：漏掉任一渠道
 * 会在**编译期**报「缺属性」，而不是等某个渠道上线后提示文案变成空白。
 */
const RECEIVER_HINT_BY_CHANNEL: Record<AlarmNotifyChannel, string> = {
  [ALARM_NOTIFY_CHANNEL.EMAIL]: '接收人为邮箱地址',
  [ALARM_NOTIFY_CHANNEL.SMS]: '接收人为手机号',
  [ALARM_NOTIFY_CHANNEL.WECHAT]: '接收人为微信号 / 公众号',
  [ALARM_NOTIFY_CHANNEL.VOICE]: '接收人为手机号（仅支持大陆）',
  [ALARM_NOTIFY_CHANNEL.CALLBACK]: '回调渠道不配置接收人',
}

const receiverHint = computed(() => RECEIVER_HINT_BY_CHANNEL[props.draft.channel] ?? '')

function patch(partial: Partial<ChannelDraft>) {
  emit('update:draft', { ...props.draft, ...partial })
}

function handleReceiversUpdate(value: unknown) {
  patch({ receivers: Array.isArray(value) ? value.map(item => String(item)) : [] })
}

function handleCallbackUrlUpdate(event: Event) {
  patch({ callbackUrl: (event.target as HTMLInputElement).value })
}
</script>

<template>
  <div class="space-y-4 rounded-lg border p-4">
    <div class="flex items-center justify-between">
      <p class="text-sm font-medium">
        {{ channelLabel(draft.channel) }}
      </p>
      <p v-if="isCallback" class="text-xs text-muted-foreground">
        回调渠道不配置接收人
      </p>
    </div>

    <!-- 回调渠道：N3 —— callbackUrl 必填（http(s):// 开头，<=500 字符） -->
    <Field v-if="isCallback">
      <FieldLabel>回调 Webhook URL</FieldLabel>
      <Input
        :model-value="draft.callbackUrl"
        :maxlength="CALLBACK_URL_MAX_LENGTH"
        :disabled="disabled"
        placeholder="https://example.com/webhook/alarm"
        @input="handleCallbackUrlUpdate"
      />
      <FieldDescription>
        必填。需以 http:// 或 https:// 开头，长度不超过 {{ CALLBACK_URL_MAX_LENGTH }} 个字符。
      </FieldDescription>
      <FieldError :errors="errors" />
    </Field>

    <!-- 非回调渠道：N5 —— receivers 0-100 个 -->
    <Field v-else>
      <FieldLabel>接收对象</FieldLabel>
      <TagsInput
        :model-value="draft.receivers"
        :disabled="disabled"
        :max="RECEIVERS_MAX_COUNT"
        class="min-h-9"
        @update:model-value="handleReceiversUpdate"
      >
        <TagsInputItem v-for="(receiver, index) in draft.receivers" :key="`${receiver}-${index}`" :value="receiver">
          <TagsInputItemText>{{ receiver }}</TagsInputItemText>
          <TagsInputItemDelete />
        </TagsInputItem>
        <TagsInputInput
          placeholder="输入后按回车添加"
          :disabled="disabled"
        />
      </TagsInput>
      <FieldDescription>
        {{ receiverHint }}。最多 {{ RECEIVERS_MAX_COUNT }} 个；
        当前 {{ draft.receivers.length }} 个。
        暂无可用的人员/用户组数据源，暂以手动录入方式维护。
      </FieldDescription>
      <FieldError :errors="errors" />
    </Field>

    <!-- N6 —— silenceTime ∈ [0, 1440]，0 = 不静默 -->
    <Field>
      <FieldLabel>静默时间（分钟）</FieldLabel>
      <NumberField
        :model-value="draft.silenceTime"
        :min="SILENCE_TIME_MIN"
        :max="SILENCE_TIME_MAX"
        :step="5"
        :disabled="disabled"
        @update:model-value="value => patch({ silenceTime: Number(value) || 0 })"
      >
        <NumberFieldContent>
          <NumberFieldDecrement />
          <NumberFieldInput />
          <NumberFieldIncrement />
        </NumberFieldContent>
      </NumberField>
      <FieldDescription>
        同一渠道在静默时间内不重复通知。0 表示不静默。
      </FieldDescription>
      <FieldError :errors="errors.filter(error => error.includes('静默'))" />
    </Field>
  </div>
</template>
