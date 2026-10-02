<script setup lang="ts">
import type { PaginationState } from '@tanstack/vue-table'

import { PlusIcon, RefreshCwIcon, SirenIcon, TriangleAlertIcon } from '@lucide/vue'
import { useDebounceFn } from '@vueuse/core'
import { toast } from 'vue-sonner'

import type { AlarmPolicyListItem, AlarmPolicyStatus } from '@/types/alarm'

import { DataTable } from '@/components/data-table'
import { BasicPage } from '@/components/global-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  deleteAlarmPolicy,
  fetchAlarmPolicyList,
  setAlarmPolicyStatus,
} from '@/services/api/alarm-policy.api'

import type { PolicyListFilters } from './utils/policy-logic'

import { createPolicyColumns } from './components/policy-columns'
import PolicyFilters from './components/policy-filters.vue'
import {
  applyOptimisticStatus,
  buildPolicyListQuery,
  canDeletePolicy,
  describePolicyDeleteFailure,
  extractPolicyErrorMessage,
  settleStatusToggle,
  statusActionLabel,
} from './utils/policy-logic'

/**
 * 告警策略 —— 列表页（契约端点 ① / ⑤ / ⑥）。
 *
 * 覆盖的硬性要求：
 * - **筛选**：名称关键词、监控类型、策略类型、告警等级、状态、所属项目，全部走服务端 query；
 * - **分页**：筛选变化后**重置回第 1 页**（防抖 watch）；
 * - **三态**：加载（DataTable loading）/ 空（empty 插槽）/ 错误（Alert + 重试）；
 * - **启停**：乐观更新，**失败必须回滚**并用后端 message 提示；
 * - **删除**：二次确认；`status=1` 时前端直接禁用（P15），后端 409 时用 vue-sonner
 *   展示**后端 message**，不静默失败；
 * - **查看告警历史**：跳 `/alarm/history?policyId=xxx`（历史页由另一任务实现，
 *   这里只负责带 query 跳转）。
 */

const router = useRouter()

// ---------------------------------------------------------------------------
// 列表数据 + 筛选 + 分页
// ---------------------------------------------------------------------------

const rows = ref<AlarmPolicyListItem[]>([])
const total = ref(0)
const loading = ref(false)
const errorMessage = ref('')

const filters = ref<PolicyListFilters>({
  keyword: '',
  monitorType: undefined,
  policyType: undefined,
  status: undefined,
  level: undefined,
  projectId: '',
})

const pagination = ref<PaginationState>({ pageIndex: 0, pageSize: 20 })
const pendingId = ref<number | null>(null)
const deleteTarget = ref<AlarmPolicyListItem | null>(null)
const deleting = ref(false)

async function loadList() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await fetchAlarmPolicyList(buildPolicyListQuery(filters.value, pagination.value))
    if (!res.success) {
      errorMessage.value = res.message || '策略列表加载失败'
      rows.value = []
      total.value = 0
      return
    }
    rows.value = res.data?.list ?? []
    total.value = res.data?.total ?? 0
  }
  catch (error) {
    errorMessage.value = (error as Error).message
    rows.value = []
    total.value = 0
  }
  finally {
    loading.value = false
  }
}

function onServerPaginationChange(updater: unknown) {
  const next = typeof updater === 'function'
    ? (updater as (old: PaginationState) => PaginationState)(pagination.value)
    : (updater as PaginationState)
  pagination.value = { pageIndex: next.pageIndex, pageSize: next.pageSize }
  loadList()
}

const serverPagination = computed(() => ({
  state: pagination.value,
  rowCount: total.value,
  onChange: onServerPaginationChange,
}))

// 筛选变化 → 页码重置回第 1 页 → 重新拉数据
const reloadForFilters = useDebounceFn(() => {
  pagination.value = { ...pagination.value, pageIndex: 0 }
  loadList()
}, 300)

watch(filters, () => reloadForFilters(), { deep: true })

onMounted(loadList)

// ---------------------------------------------------------------------------
// 行操作
// ---------------------------------------------------------------------------

/**
 * ⑥ 启停：乐观更新，**失败必须回滚**。
 *
 * 「乐观更新」和「回滚」两步都抽在 `utils/policy-logic.ts` 里（`applyOptimisticStatus` /
 * `settleStatusToggle`），所以这条硬要求能被单测真正击穿，而不是只能人肉点页面确认。
 * ⚠️ 业务失败（`res.success === false`）和请求抛异常**走同一条回滚路径**——
 *    只在 try 里回滚、catch 里忘了回滚，是这类乐观 UI 最常见的漏网之鱼。
 */
async function toggleStatus(policy: AlarmPolicyListItem, next: AlarmPolicyStatus) {
  if (pendingId.value !== null)
    return

  if (policy.status === next)
    return

  pendingId.value = policy.id
  const previous = applyOptimisticStatus(policy, next) // 乐观更新：开关先动
  try {
    const res = await setAlarmPolicyStatus(policy.id, { status: next })
    const outcome = settleStatusToggle(policy, {
      next,
      previous,
      res,
      updatedAt: res.data?.updatedAt,
    })
    if (outcome.updatedAt)
      policy.updatedAt = outcome.updatedAt

    if (outcome.rolledBack) {
      toast.error(`${statusActionLabel(next)}策略失败`, { description: outcome.message })
      return
    }
    toast.success(`策略已${statusActionLabel(next)}`, { description: policy.name })
  }
  catch (error) {
    // 网络/超时异常：同样回滚，否则界面会停在骗人的新状态
    const outcome = settleStatusToggle(policy, {
      next,
      previous,
      res: { success: false, message: (error as Error).message },
    })
    toast.error('启停请求失败', { description: outcome.message })
  }
  finally {
    pendingId.value = null
  }
}

function goDetail(policy: AlarmPolicyListItem) {
  router.push(`/alarm/policy/${policy.id}`)
}

function goEdit(policy: AlarmPolicyListItem) {
  router.push(`/alarm/policy/${policy.id}/edit`)
}

/** 复制：跳新建页，由向导拉源策略详情并预填「原名 - 副本」（P16：新策略默认停用）。 */
function goCopy(policy: AlarmPolicyListItem) {
  router.push({ path: '/alarm/policy/create', query: { copyFrom: String(policy.id) } })
}

/** 查看告警历史：带 policyId 跳历史页（该页由另一并行任务实现）。 */
function goHistory(policy: AlarmPolicyListItem) {
  router.push({ path: '/alarm/history', query: { policyId: String(policy.id) } })
}

function askDelete(policy: AlarmPolicyListItem) {
  // P15：仅停用可删。列表数据是旧的，后端 409 仍要处理，所以这里是体验优化而非替代。
  if (!canDeletePolicy(policy.status)) {
    toast.error('策略无法删除', { description: '已启用的策略不可删除，请先停用' })
    return
  }
  deleteTarget.value = policy
}

async function confirmDelete() {
  const policy = deleteTarget.value
  if (!policy)
    return

  deleting.value = true
  pendingId.value = policy.id
  try {
    const res = await deleteAlarmPolicy(policy.id)
    if (!res.success) {
      // ⑤ 的 409（已启用不可删）/ 404 等一律展示**后端 message**，不静默失败
      const failure = describePolicyDeleteFailure(res)
      toast.error(failure.title, { description: failure.message })
      return
    }
    toast.success('策略已删除', { description: policy.name })
    deleteTarget.value = null
    // 删掉当前页最后一条时回退一页
    if (rows.value.length === 1 && pagination.value.pageIndex > 0)
      pagination.value = { ...pagination.value, pageIndex: pagination.value.pageIndex - 1 }
    await loadList()
  }
  catch (error) {
    toast.error('删除请求失败', { description: extractPolicyErrorMessage(null, (error as Error).message) })
  }
  finally {
    deleting.value = false
    pendingId.value = null
  }
}

const columns = createPolicyColumns({
  onToggleStatus: toggleStatus,
  onView: goDetail,
  onEdit: goEdit,
  onCopy: goCopy,
  onHistory: goHistory,
  onDelete: askDelete,
  pendingId: () => pendingId.value,
})
</script>

<template>
  <BasicPage
    title="告警策略"
    description="创建与管理监控告警策略：监控类型、触发条件、告警对象与通知模板绑定"
    sticky
  >
    <template #actions>
      <Button variant="outline" :disabled="loading" @click="loadList">
        <RefreshCwIcon :class="loading ? 'animate-spin' : ''" />
        刷新
      </Button>
      <Button @click="router.push('/alarm/policy/create')">
        <PlusIcon />
        新建策略
      </Button>
    </template>

    <div class="space-y-4">
      <PolicyFilters v-model="filters" />

      <Alert v-if="errorMessage" variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>加载失败</AlertTitle>
        <AlertDescription class="flex items-center gap-3">
          <span>{{ errorMessage }}</span>
          <Button size="sm" variant="outline" @click="loadList">
            重试
          </Button>
        </AlertDescription>
      </Alert>

      <DataTable
        :data="rows"
        :columns="columns"
        :loading="loading"
        :server-pagination="serverPagination"
      >
        <template #empty>
          <div class="flex flex-col items-center gap-2 py-6">
            <SirenIcon class="size-8 text-muted-foreground" />
            <p class="font-medium">
              暂无告警策略
            </p>
            <p class="text-sm text-muted-foreground">
              调整筛选条件，或新建一条告警策略。
            </p>
            <Button size="sm" class="mt-2" @click="router.push('/alarm/policy/create')">
              <PlusIcon />
              新建策略
            </Button>
          </div>
        </template>
      </DataTable>
    </div>

    <ConfirmDialog
      :open="deleteTarget !== null"
      :is-loading="deleting"
      destructive
      cancel-button-text="取消"
      confirm-button-text="确认删除"
      @update:open="(value: boolean) => { if (!value) deleteTarget = null }"
      @confirm="confirmDelete"
    >
      <template #title>
        确认删除策略「{{ deleteTarget?.name }}」？
      </template>
      <template #description>
        <p class="text-sm text-muted-foreground">
          删除后策略与其触发条件一并移除，且<strong class="text-foreground">不可恢复</strong>；
          告警历史会保留（历史表无外键）。仅停用状态的策略可删除。
        </p>
      </template>
    </ConfirmDialog>
  </BasicPage>
</template>
