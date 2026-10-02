<script setup lang="ts">
import { CheckCircle2Icon, EllipsisIcon, EyeOffIcon, HeartPulseIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * 告警历史 —— 行操作（处理 / 忽略 / 标记已恢复，契约 ⑱）。
 *
 * ## 状态机（契约 §1.10 + §1.12 + H3）
 * ```
 *   未处理(1) ──handle──▶ 已处理(2)
 *            ──ignore──▶ 已忽略(3)   ← 此后**不可**再转「已处理」
 *            ──recover─▶ 已恢复(4)
 * ```
 * H3：**仅 `status=1`（未处理）可处理**，否则后端返 409。前端据此禁用按钮，
 * 但**仍然必须处理 409**——并发场景下别人可能已经先处理过了，此时要把后端的中文
 * `message` 原样 toast 出来，不能静默失败。
 *
 * ⚠️ 契约 H5：历史记录**不提供删除端点**，所以这里**没有**删除按钮。
 */
import type { AlarmHandleAction, AlarmHistory } from '@/types/alarm'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { handleAlarmHistory } from '@/services/api/alarm-history.api'

import type { HandleActionMeta } from '../logic'

import {
  buildHandlePayload,
  canHandleHistory,
  describeAlarmError,
  HANDLE_ACTIONS,
  HANDLE_REMARK_MAX_LENGTH,
  historyStatusLabel,
  validateHandleRemark,
} from '../logic'
import { useAlarmRefresh } from '../refresh'

const props = defineProps<{
  history: AlarmHistory
}>()

/** 页面提供的「重新取数」通道（见 `../refresh.ts`）。 */
const refresh = useAlarmRefresh()

const dialogOpen = ref(false)
const activeAction = ref<HandleActionMeta | null>(null)
const remark = ref('')
const remarkError = ref<string | null>(null)
const submitting = ref(false)

/** H3：非「未处理」的行禁用操作。 */
const actionable = computed(() => canHandleHistory(props.history.status))

/** 每个动作的图标，按契约动作值索引。 */
const ACTION_ICON: Record<AlarmHandleAction, typeof CheckCircle2Icon> = {
  handle: CheckCircle2Icon,
  ignore: EyeOffIcon,
  recover: HeartPulseIcon,
}

function openDialog(meta: HandleActionMeta) {
  if (!actionable.value)
    return

  activeAction.value = meta
  remark.value = ''
  remarkError.value = null
  dialogOpen.value = true
}

function handleOpenChange(open: boolean) {
  // 提交中不允许点遮罩/Esc 关掉，避免用户以为已经提交成功
  if (submitting.value)
    return
  dialogOpen.value = open
}

async function handleConfirm() {
  const meta = activeAction.value
  if (!meta)
    return

  // H2：remark <= 500
  const reason = validateHandleRemark(remark.value)
  if (reason) {
    remarkError.value = reason
    return
  }
  remarkError.value = null

  submitting.value = true
  try {
    // `action` 是契约的字符串字面量，**原样提交**（契约 §1.12，不本地化）
    const res = await handleAlarmHistory(props.history.id, buildHandlePayload(meta.action, remark.value))

    if (!res.success) {
      toast.error(res.message || `${meta.buttonLabel}失败`)
      return
    }

    dialogOpen.value = false
    toast.success(`已${meta.buttonLabel}：${props.history.policyName || '该告警'}`)
    // 状态与「今日未处理」统计都会变，两边一起刷
    refresh()
  }
  catch (error) {
    // 409（已被他人处理）/ 404 / 422 都在这里用后端原文提示，不吞掉
    toast.error(describeAlarmError(error, `${meta.buttonLabel}失败`))
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        class="flex size-8 p-0 data-[state=open]:bg-muted"
        :aria-label="`${history.policyName || '告警'} ${history.id} 的操作`"
      >
        <EllipsisIcon class="size-4" />
        <span class="sr-only">
          {{ history.policyName || '告警' }} {{ history.id }} 的操作
        </span>
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-[200px]">
      <!-- HANDLE_ACTIONS 就是契约 §1.12 的全部三个动作，顺序即契约表格顺序 -->
      <DropdownMenuItem
        v-for="meta in HANDLE_ACTIONS"
        :key="meta.action"
        :disabled="!actionable || submitting"
        @select="openDialog(meta)"
      >
        <span>{{ meta.buttonLabel }}</span>
        <DropdownMenuShortcut>
          <component :is="ACTION_ICON[meta.action]" class="size-4" />
        </DropdownMenuShortcut>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <!-- 只读信息，不是操作入口 -->
      <div class="px-2 py-1.5 text-xs text-muted-foreground">
        <div class="flex items-center gap-1.5">
          <span>当前状态</span>
          <Badge variant="outline">
            {{ historyStatusLabel(history.status) }}
          </Badge>
        </div>
        <p v-if="!actionable" class="mt-1">
          仅「未处理」的告警可以操作。
        </p>
        <p v-if="history.handlerName" class="mt-1">
          处理人：{{ history.handlerName }}
        </p>
        <p v-if="history.handleRemark" class="mt-1 line-clamp-2">
          备注：{{ history.handleRemark }}
        </p>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>

  <Dialog
    :open="dialogOpen"
    @update:open="handleOpenChange"
  >
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ activeAction?.buttonLabel ?? '处理告警' }}</DialogTitle>
        <DialogDescription>
          {{ activeAction?.description }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3 rounded-md border p-3 text-sm">
        <p class="font-medium">
          {{ history.policyName || '（策略已删除）' }}
        </p>
        <p class="text-muted-foreground">
          {{ history.objectName || '（全部对象）' }} · {{ history.metricNameCn || history.metricName }} ·
          {{ history.operator }} {{ history.threshold }}{{ history.unit }}
        </p>
        <p class="text-xs text-muted-foreground">
          触发时间：{{ history.triggeredAt }}
        </p>
      </div>

      <form class="space-y-4" @submit.prevent="handleConfirm">
        <Field>
          <FieldLabel>处理备注</FieldLabel>
          <Textarea
            v-model="remark"
            :maxlength="HANDLE_REMARK_MAX_LENGTH"
            rows="3"
            :disabled="submitting"
            placeholder="选填，最多 500 个字符"
          />
          <FieldDescription>
            契约 §3.3 ⑱：`remark` 选填，最多 {{ HANDLE_REMARK_MAX_LENGTH }} 个字符。
          </FieldDescription>
          <FieldError v-if="remarkError" :errors="[remarkError]" />
        </Field>

        <DialogFooter>
          <Button
            variant="outline"
            :disabled="submitting"
            @click="handleOpenChange(false)"
          >
            取消
          </Button>
          <Button
            type="submit"
            :disabled="submitting || !activeAction"
          >
            <Spinner v-if="submitting" />
            确认{{ activeAction?.buttonLabel ?? '处理' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
