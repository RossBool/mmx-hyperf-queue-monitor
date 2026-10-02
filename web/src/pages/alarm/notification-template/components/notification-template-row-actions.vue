<script setup lang="ts">
import { EllipsisIcon, FilePenLineIcon, Trash2Icon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * 通知模板 —— 行操作（编辑 / 删除）+ 对应的两个弹层。
 *
 * 自带弹层而不是把状态提到列表页，与范式页 `src/pages/tasks/components/data-table-row-actions.vue`
 * 保持一致，也让 `columns.ts` 保持纯展示（不需要往列定义里塞回调）。
 *
 * 两种 409 都在这里覆盖（N7 预置不可删 / N8 被策略引用）：
 * - `isPreset=1`（N7）**直接禁用删除项**——后端必然拒，点了只是白等一次请求；
 * - 被策略引用（N8）前端**无法预判**，捕获后用 toast 展示后端返回的中文原文。
 */
import type { AlarmNotificationTemplate, AlarmNotificationTemplatePayload } from '@/types/alarm'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  deleteAlarmNotificationTemplate,
  updateAlarmNotificationTemplate,
} from '@/services/api/alarm-notification.api'
import { ALARM_PRESET_FLAG } from '@/types/alarm'

import { extractAlarmErrorMessage } from '../logic'
import { useAlarmRefresh } from '../refresh'
import NotificationTemplateDeleteDialog from './notification-template-delete-dialog.vue'
import NotificationTemplateForm from './notification-template-form.vue'

const props = defineProps<{
  template: AlarmNotificationTemplate
}>()

/** 页面提供的「重新取数」通道（见 `../refresh.ts`）。 */
const refresh = useAlarmRefresh()

const editOpen = ref(false)
const deleteOpen = ref(false)
const submitting = ref(false)

const isPreset = computed(() => props.template.isPreset === ALARM_PRESET_FLAG.PRESET)

/**
 * 统一的提交包装。
 *
 * ⚠️ 必须同时处理「抛异常」和「resolve 出业务失败信封」两种形态：
 * - 真实 HTTP：契约 §0.2 规定 HTTP 状态码 = code，409/422/404 在 ofetch 里是**抛异常**；
 * - mock 模式：`src/mocks` 直接 return 一个 `success:false` 的信封，**不抛**。
 * 只处理其中一种，另一种就会静默失败（用户点了没反应）。
 */
async function run(
  request: () => Promise<{ success: boolean, message: string }>,
  fallback: string,
  onSuccess: (message: string) => void,
) {
  submitting.value = true
  try {
    const res = await request()
    if (!res.success) {
      toast.error(res.message || fallback)
      return
    }
    onSuccess(fallback)
  }
  catch (error) {
    toast.error(extractAlarmErrorMessage(error, fallback))
  }
  finally {
    submitting.value = false
  }
}

function handleUpdate(payload: AlarmNotificationTemplatePayload) {
  return run(
    () => updateAlarmNotificationTemplate(props.template.id, payload),
    '保存通知模板失败',
    () => {
      editOpen.value = false
      toast.success('通知模板已保存')
      refresh()
    },
  )
}

function handleDeleteConfirm() {
  return run(
    () => deleteAlarmNotificationTemplate(props.template.id),
    '删除通知模板失败',
    () => {
      deleteOpen.value = false
      toast.success('通知模板已删除')
      refresh()
    },
  )
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        class="flex size-8 p-0 data-[state=open]:bg-muted"
        :aria-label="`${template.name} 的操作`"
      >
        <EllipsisIcon class="size-4" />
        <span class="sr-only">
          {{ template.name }} 的操作
        </span>
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-[180px]">
      <DropdownMenuItem @select="editOpen = true">
        <span>编辑</span>
        <DropdownMenuShortcut>
          <FilePenLineIcon class="size-4" />
        </DropdownMenuShortcut>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem
        :disabled="isPreset"
        @select="deleteOpen = true"
      >
        <span>删除</span>
        <DropdownMenuShortcut>
          <Trash2Icon class="size-4" />
        </DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <!-- N7：`isPreset=1` 的预置模板禁止删除，按钮已禁用；这里再兜一层提示 -->
  <p v-if="isPreset" class="sr-only">
    预置模板不可删除
  </p>

  <Sheet
    :open="editOpen"
    @update:open="editOpen = $event"
  >
    <SheetContent class="w-full overflow-y-auto sm:max-w-xl">
      <SheetHeader>
        <SheetTitle>编辑通知模板</SheetTitle>
        <SheetDescription>
          修改后将按契约 ⑮ 全量覆盖该模板的渠道配置。
        </SheetDescription>
      </SheetHeader>

      <NotificationTemplateForm
        :template="template"
        :submitting="submitting"
        @submit="handleUpdate"
        @cancel="editOpen = false"
      />
    </SheetContent>
  </Sheet>

  <NotificationTemplateDeleteDialog
    v-model:open="deleteOpen"
    :template="template"
    :submitting="submitting"
    @confirm="handleDeleteConfirm"
  />
</template>
