<script setup lang="ts">
/**
 * 通知模板 —— 新建 / 编辑表单（契约 §2.5 + §4.3 N1-N6）。
 *
 * ## 为什么不用 @tanstack/vue-form
 * 范式页 `src/pages/tasks/components/task-form.vue` 用的是 `useForm` + zod。
 * 这里**刻意不照抄**：通知模板的表单是一个**动态渠道数组**（勾选几个渠道就渲染几行），
 * 校验规则还是条件式的（只有勾了「回调」才要求 Webhook URL）。
 * 把这些规则再用 zod 写第二遍，等于让**已单测覆盖的契约逻辑出现第二个未测试的实现**。
 * 因此这里让 `../logic.ts` 的 `validateTemplateDraft`（已单测）做唯一校验入口，
 * 组件只负责把返回的 `TemplateValidationError[]` 按 field 路径分发到对应输入框下方。
 */
import type { AlarmNotificationTemplate, AlarmNotificationTemplatePayload, AlarmNotifyChannel } from '@/types/alarm'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ALARM_NOTIFY_CHANNEL_LABEL } from '@/types/alarm'

import type { ChannelDraft, TemplateFieldPath, TemplateValidationError } from '../logic'

import { channelsToDrafts, createChannelDraft, NAME_MAX_LENGTH, NOTIFY_CHANNEL_VALUES, REMARK_MAX_LENGTH, validateTemplateDraft } from '../logic'
import NotificationChannelEditor from './notification-channel-editor.vue'

const props = defineProps<{
  /** `null` = 新建模式 */
  template: AlarmNotificationTemplate | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  submit: [payload: AlarmNotificationTemplatePayload]
  cancel: []
}>()

const isEdit = computed(() => props.template !== null)

const name = ref('')
const remark = ref('')
/** 渠道草稿数组，每个元素对应表单里渲染的一行编辑块 */
const drafts = ref<ChannelDraft[]>([])
/** 校验错误，按 field 路径索引；提交前为空 */
const errors = ref<TemplateValidationError[]>([])
const showErrors = ref(false)

let draftSeed = 0

function reset() {
  name.value = props.template?.name ?? ''
  remark.value = props.template?.remark ?? ''
  errors.value = []
  showErrors.value = false

  if (props.template) {
    drafts.value = channelsToDrafts(props.template.channels)
  }
  else {
    // 新建：默认勾上「邮件」，避免一进来就是 N2 的报错态
    draftSeed += 1
    drafts.value = [createChannelDraft(NOTIFY_CHANNEL_VALUES[0], `draft-${draftSeed}`)]
  }
}

onMounted(reset)
watch(() => props.template, reset)

/** 已勾选的渠道（ToggleGroup 用字符串做 value，这里转回契约的数值编码）。 */
const selectedChannels = computed(() => drafts.value.map(draft => draft.channel))

function isChannelSelected(channel: AlarmNotifyChannel) {
  return selectedChannels.value.includes(channel)
}

function handleChannelsChange(values: unknown) {
  const next = Array.isArray(values) ? values : []
  const picked = NOTIFY_CHANNEL_VALUES.filter(channel => next.includes(String(channel)))
  const previous = new Map(drafts.value.map(draft => [draft.channel, draft]))

  drafts.value = picked.map((channel) => {
    // 已存在的渠道保留用户已填的接收人，避免切换勾选时丢失输入
    const existing = previous.get(channel)
    if (existing)
      return existing
    draftSeed += 1
    return createChannelDraft(channel, `draft-${draftSeed}`)
  })
}

function handleDraftUpdate(index: number, draft: ChannelDraft) {
  const next = [...drafts.value]
  next[index] = draft
  drafts.value = next
}

/** 某一行某个字段的错误文案。 */
function fieldErrors(field: TemplateFieldPath | `channels.${number}`): string[] {
  return errors.value.filter(error => error.field === field).map(error => error.message)
}

function rowErrors(index: number, suffix: 'receivers' | 'callbackUrl' | 'silenceTime'): string[] {
  return errors.value
    .filter(error => error.field === `channels.${index}.${suffix}`)
    .map(error => error.message)
}

function handleSubmit(event: Event) {
  event.preventDefault()
  showErrors.value = true

  const result = validateTemplateDraft({ name: name.value, remark: remark.value, channels: drafts.value })
  errors.value = result.ok ? [] : result.errors

  // 校验不通过就**留在表单里**展示错误，不关闭抽屉——否则用户会丢掉已填的内容
  if (!result.ok)
    return

  emit('submit', result.payload)
}
</script>

<template>
  <form class="flex flex-col gap-6" @submit="handleSubmit">
    <!-- N1：名称 1-64 字符，全局唯一 -->
    <Field>
      <FieldLabel>模板名称</FieldLabel>
      <Input
        v-model="name"
        :maxlength="NAME_MAX_LENGTH"
        placeholder="例如：运维值班组"
        :disabled="submitting"
      />
      <FieldDescription>
        全局唯一，长度 1-{{ NAME_MAX_LENGTH }} 个字符。
      </FieldDescription>
      <FieldError v-if="showErrors" :errors="fieldErrors('name')" />
    </Field>

    <Field>
      <FieldLabel>备注</FieldLabel>
      <Textarea
        v-model="remark"
        :maxlength="REMARK_MAX_LENGTH"
        rows="2"
        placeholder="选填"
        :disabled="submitting"
      />
      <FieldError v-if="showErrors" :errors="fieldErrors('remark')" />
    </Field>

    <!-- N2：至少选 1 个渠道（至多 5 个），同一渠道不可重复 -->
    <Field>
      <FieldLabel>接收渠道</FieldLabel>
      <ToggleGroup
        :model-value="selectedChannels.map(String)"
        type="multiple"
        variant="outline"
        class="flex flex-wrap gap-2"
        @update:model-value="handleChannelsChange"
      >
        <ToggleGroupItem
          v-for="channel in NOTIFY_CHANNEL_VALUES"
          :key="channel"
          :value="String(channel)"
          :disabled="submitting"
          :data-selected="isChannelSelected(channel)"
        >
          {{ ALARM_NOTIFY_CHANNEL_LABEL[channel] }}
        </ToggleGroupItem>
      </ToggleGroup>
      <FieldDescription>
        至少选择 1 个，最多 {{ NOTIFY_CHANNEL_VALUES.length }} 个。勾选「回调」后需填写 Webhook URL。
      </FieldDescription>
      <FieldError v-if="showErrors" :errors="fieldErrors('channels')" />
    </Field>

    <!-- 每个已勾选渠道一行编辑块；未勾选任何渠道时给出明确指引（N2） -->
    <div v-if="drafts.length > 0" class="space-y-4">
      <NotificationChannelEditor
        v-for="(draft, index) in drafts"
        :key="draft.key"
        :draft="draft"
        :errors="[
          ...rowErrors(index, 'receivers'),
          ...rowErrors(index, 'callbackUrl'),
          ...rowErrors(index, 'silenceTime'),
        ]"
        :disabled="submitting"
        @update:draft="handleDraftUpdate(index, $event)"
      />
    </div>
    <p v-else class="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
      请先选择至少 1 个接收渠道，提交前必须配置渠道。
    </p>

    <div class="flex justify-end gap-2">
      <Button
        type="button"
        variant="outline"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        取消
      </Button>
      <Button
        type="submit"
        :disabled="submitting"
      >
        <Spinner v-if="submitting" />
        {{ isEdit ? '保存' : '创建' }}
      </Button>
    </div>
  </form>
</template>
