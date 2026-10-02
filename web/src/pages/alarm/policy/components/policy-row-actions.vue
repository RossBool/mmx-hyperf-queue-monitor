<script setup lang="ts">
import { CopyIcon, EyeIcon, MoreHorizontalIcon, PencilIcon, SirenIcon, Trash2Icon } from '@lucide/vue'

import type { AlarmPolicyListItem } from '@/types/alarm'

import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { ALARM_POLICY_STATUS } from '@/types/alarm'

/**
 * 列表行操作：查看详情 / 编辑 / 复制 / 查看告警历史 / 删除。
 *
 * ⚠️ P15：**仅 `status=0`（停用）的策略可删除**，启用中直接 409，
 * 所以这里在 `status===1` 时禁用删除项并说明原因，避免用户点了必然失败。
 */
const props = defineProps<{
  policy: AlarmPolicyListItem
  disabled?: boolean
}>()

const emit = defineEmits<{
  view: [policy: AlarmPolicyListItem]
  edit: [policy: AlarmPolicyListItem]
  copy: [policy: AlarmPolicyListItem]
  history: [policy: AlarmPolicyListItem]
  delete: [policy: AlarmPolicyListItem]
}>()

const deletable = computed(() => props.policy.status === ALARM_POLICY_STATUS.DISABLED)
const deleteHint = computed(() =>
  deletable.value
    ? '删除后不可恢复；告警历史会保留'
    : '已启用的策略不可删除，请先停用',
)
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="size-8"
        :disabled="disabled"
        :aria-label="`${policy.name} 的更多操作`"
      >
        <MoreHorizontalIcon />
        <span class="sr-only">{{ policy.name }} 的更多操作</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-48">
      <DropdownMenuItem @click="emit('view', policy)">
        <EyeIcon />
        查看详情
      </DropdownMenuItem>
      <DropdownMenuItem @click="emit('edit', policy)">
        <PencilIcon />
        编辑
      </DropdownMenuItem>
      <DropdownMenuItem @click="emit('copy', policy)">
        <CopyIcon />
        复制
      </DropdownMenuItem>
      <DropdownMenuItem @click="emit('history', policy)">
        <SirenIcon />
        查看告警历史
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        :disabled="!deletable"
        :title="deleteHint"
        @click="emit('delete', policy)"
      >
        <Trash2Icon />
        删除
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
