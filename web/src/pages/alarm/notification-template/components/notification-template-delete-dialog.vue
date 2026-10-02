<script setup lang="ts">
/**
 * 通知模板 —— 删除二次确认（契约 ⑯）。
 *
 * ⚠️ 历史记录/模板都**没有**「静默删除」：删除一定要用户明确确认。
 * 后端 409 的两种情形（N7 预置不可删 / N8 被策略引用）由父组件用 toast 展示后端原文。
 */
import type { AlarmNotificationTemplate } from '@/types/alarm'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ALARM_PRESET_FLAG } from '@/types/alarm'

import { buildTemplateRowMeta } from '../logic'

const props = defineProps<{
  open: boolean
  template: AlarmNotificationTemplate | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  'confirm': []
}>()

const meta = computed(() => (props.template ? buildTemplateRowMeta(props.template) : null))

function handleOpenChange(open: boolean) {
  // 提交中不允许通过点遮罩/Esc 关掉，避免用户以为删掉了
  if (props.submitting)
    return
  emit('update:open', open)
}
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>删除通知模板</DialogTitle>
        <DialogDescription>
          即将删除模板「<strong>{{ template?.name ?? '—' }}</strong>」。
          此操作不可撤销。
        </DialogDescription>
      </DialogHeader>

      <ul v-if="template && meta" class="space-y-1 rounded-md border p-3 text-sm text-muted-foreground">
        <li>接收渠道：{{ meta.channelValues.length }} 个</li>
        <li>接收人：{{ meta.receiverCount }} 个</li>
        <li>备注：{{ template.remark || '（空）' }}</li>
      </ul>

      <DialogFooter>
        <Button
          variant="outline"
          :disabled="submitting"
          @click="handleOpenChange(false)"
        >
          取消
        </Button>
        <Button
          variant="destructive"
          :disabled="submitting || !template || template.isPreset === ALARM_PRESET_FLAG.PRESET"
          @click="emit('confirm')"
        >
          <Spinner v-if="submitting" />
          确认删除
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
