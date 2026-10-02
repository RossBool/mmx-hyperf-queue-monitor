<script setup lang="ts">
import type { PaginationState } from '@tanstack/vue-table'

import { AlertCircleIcon, PlusIcon, RotateCwIcon, SearchIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'

/**
 * 通知模板 —— 列表页（契约端点 ⑬-⑯）。
 *
 * - 列表：⑬ `GET /api/alarm/notification-templates`（**返回完整 channels**，含接收人）
 * - 新建：⑭ `POST` / 编辑：⑮ `PUT`（全量）/ 删除：⑯ `DELETE`
 *
 * ⚠️ 列表接口返回完整 `channels`，与**策略详情页**的 `notificationTemplates[].channels`
 * （只是 `int[]` 编码数组）不同，不要混用，否则会把接收人泄漏到策略详情页。
 *
 * ## 契约缺口（已在交付说明中列出，未自行发明字段）
 * 任务要求「启用状态筛选 + 启停开关」，但契约 §2.5 的 `AlarmNotificationTemplate`
 * **没有 `status` 字段**，⑬ 的查询参数里也只有 `keyword` / `channel` / `isPreset` / 分页。
 * 因此这里按契约实现第三个筛选 = `isPreset`（自定义 / 系统预置），**不臆造 `status`**。
 */
import type { AlarmNotificationTemplate, AlarmNotificationTemplatePayload, AlarmNotifyChannel, AlarmPresetFlag } from '@/types/alarm'

import { DataTable } from '@/components/data-table'
import { BasicPage } from '@/components/global-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { createAlarmNotificationTemplate, fetchAlarmNotificationTemplateList } from '@/services/api/alarm-notification.api'
import { ALARM_NOTIFY_CHANNEL_LABEL, ALARM_PRESET_FLAG } from '@/types/alarm'

import type { TemplateFilterState } from './logic'

import { columns } from './components/columns'
import NotificationTemplateForm from './components/notification-template-form.vue'
import {
  buildTemplateListQuery,
  extractAlarmErrorMessage,
  getTemplateReadiness,
  NOTIFY_CHANNEL_VALUES,
  PAGE_SIZE_DEFAULT,
} from './logic'
import { provideAlarmRefresh } from './refresh'

// ============================================================================
// 状态
// ============================================================================

const list = ref<AlarmNotificationTemplate[]>([])
const total = ref(0)
const loading = ref(false)
const errorMessage = ref<string | null>(null)

const createOpen = ref(false)
const creating = ref(false)

/** 分页：TanStack 用 0-based `pageIndex`，契约用 1-based `page`。 */
const pagination = ref<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE_DEFAULT })

/** 筛选态（提交前）与已提交的筛选（生效中），避免每敲一个字就打一次接口。 */
const draftFilters = reactive<TemplateFilterState>({ keyword: '' })
const activeFilters = ref<TemplateFilterState>({ keyword: '' })

/** 竞态防护：只有最后一次请求的结果才允许写进列表，防止旧响应覆盖新响应。 */
let requestSeq = 0

// ============================================================================
// 取数
// ============================================================================

async function load() {
  const seq = ++requestSeq
  const query = buildTemplateListQuery(
    activeFilters.value,
    pagination.value.pageIndex + 1,
    pagination.value.pageSize,
  )

  loading.value = true
  try {
    const res = await fetchAlarmNotificationTemplateList(query)

    // 已被更新的请求取代 → 丢弃本次结果
    if (seq !== requestSeq)
      return

    if (!res.success) {
      errorMessage.value = res.message || '通知模板列表加载失败'
      list.value = []
      total.value = 0
      return
    }

    errorMessage.value = null
    list.value = Array.isArray(res.data?.list) ? res.data.list : []
    total.value = Number.isFinite(res.data?.total) ? res.data.total : list.value.length
  }
  catch (error) {
    if (seq !== requestSeq)
      return
    errorMessage.value = extractAlarmErrorMessage(error, '通知模板列表加载失败')
    list.value = []
    total.value = 0
  }
  finally {
    // 同样要判 seq：被取代的请求不能把 loading 提前关掉
    if (seq === requestSeq)
      loading.value = false
  }
}

onMounted(load)

// ============================================================================
// 交互
// ============================================================================

function applyFilters() {
  activeFilters.value = { ...draftFilters }
  // 改筛选后必须回到第 1 页，否则可能停在一个已经不存在的空页上
  pagination.value = { ...pagination.value, pageIndex: 0 }
  load()
}

function resetFilters() {
  draftFilters.keyword = ''
  draftFilters.channel = undefined
  draftFilters.isPreset = undefined
  activeFilters.value = { keyword: '' }
  pagination.value = { ...pagination.value, pageIndex: 0 }
  load()
}

/** TanStack 的分页变更（0-based）→ 回写并重新取数。 */
function handlePaginationChange(updater: PaginationState | ((old: PaginationState) => PaginationState)) {
  const next = typeof updater === 'function' ? updater(pagination.value) : updater
  pagination.value = next
  load()
}

function handleCreate(payload: AlarmNotificationTemplatePayload) {
  creating.value = true
  createAlarmNotificationTemplate(payload)
    .then((res) => {
      if (!res.success) {
        toast.error(res.message || '创建失败')
        return
      }
      createOpen.value = false
      toast.success('通知模板已创建')
      load()
    })
    .catch((error) => {
      toast.error(extractAlarmErrorMessage(error, '创建通知模板失败'))
    })
    .finally(() => {
      creating.value = false
    })
}

/** 全表未配置完成（N9）的渠道集合，作为页面级提示汇总。 */
const unconfiguredSummary = computed(() => {
  const channels = new Set<AlarmNotifyChannel>()
  for (const template of list.value) {
    const { unconfiguredChannels } = getTemplateReadiness(template.channels)
    for (const channel of unconfiguredChannels)
      channels.add(channel)
  }

  if (channels.size === 0)
    return null

  return [...channels]
    .map(channel => ALARM_NOTIFY_CHANNEL_LABEL[channel] ?? `渠道${channel}`)
    .join('、')
})

// ⑮ 编辑 / ⑯ 删除成功后由行操作组件调用（见 `./refresh.ts`）重新取数
provideAlarmRefresh(load)
</script>

<template>
  <BasicPage
    title="通知模板"
    description="配置告警通知的接收渠道与接收人：邮件、短信、微信、电话、回调"
    sticky
  >
    <template #actions>
      <Button @click="createOpen = true">
        <PlusIcon />
        新建模板
      </Button>
    </template>

    <div class="space-y-4">
      <!-- 筛选条：契约 ⑬ 的三个查询参数 keyword / channel / isPreset -->
      <div class="flex flex-col gap-3 rounded-md border p-3 lg:flex-row lg:items-end">
        <div class="flex-1 space-y-1.5">
          <label class="text-sm font-medium" for="nt-keyword">名称关键词</label>
          <Input
            id="nt-keyword"
            v-model="draftFilters.keyword"
            placeholder="按模板名称模糊匹配"
            @keyup.enter="applyFilters"
          />
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">接收渠道</label>
          <Select
            :model-value="draftFilters.channel === undefined ? 'all' : String(draftFilters.channel)"
            @update:model-value="(value) => {
              draftFilters.channel = value === 'all' ? undefined : (Number(value) as AlarmNotifyChannel)
            }"
          >
            <SelectTrigger class="w-[160px]">
              <SelectValue placeholder="全部渠道" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                全部渠道
              </SelectItem>
              <SelectItem v-for="channel in NOTIFY_CHANNEL_VALUES" :key="channel" :value="String(channel)">
                {{ ALARM_NOTIFY_CHANNEL_LABEL[channel] }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">模板来源</label>
          <Select
            :model-value="draftFilters.isPreset === undefined ? 'all' : String(draftFilters.isPreset)"
            @update:model-value="(value) => {
              draftFilters.isPreset = value === 'all' ? undefined : (Number(value) as AlarmPresetFlag)
            }"
          >
            <SelectTrigger class="w-[160px]">
              <SelectValue placeholder="全部" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                全部
              </SelectItem>
              <SelectItem :value="String(ALARM_PRESET_FLAG.CUSTOM)">
                自定义
              </SelectItem>
              <SelectItem :value="String(ALARM_PRESET_FLAG.PRESET)">
                系统预置
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex gap-2">
          <Button
            :disabled="loading"
            @click="applyFilters"
          >
            <SearchIcon />
            查询
          </Button>
          <Button
            variant="outline"
            :disabled="loading"
            @click="resetFilters"
          >
            <RotateCwIcon />
            重置
          </Button>
        </div>
      </div>

      <!-- 错误态：接口失败时给可读的提示 + 重试，而不是空表格 -->
      <Alert v-if="errorMessage" variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>通知模板列表加载失败</AlertTitle>
        <AlertDescription class="flex items-center justify-between gap-4">
          <span>{{ errorMessage }}</span>
          <Button
            size="sm"
            variant="outline"
            @click="load"
          >
            重试
          </Button>
        </AlertDescription>
      </Alert>

      <!-- N9 页面级汇总提示：只要有渠道没配接收人，就明确告诉用户「不能绑定到策略」 -->
      <Alert v-else-if="unconfiguredSummary">
        <AlertCircleIcon />
        <AlertTitle>部分模板未配置接收人</AlertTitle>
        <AlertDescription>
          当前列表中 {{ unconfiguredSummary }} 渠道没有配置接收人。
          按契约 N9，这类模板属于「未配置完成」，请补充接收人后才能绑定到策略。
        </AlertDescription>
      </Alert>

      <DataTable
        :data="list"
        :columns="columns"
        :loading="loading"
        :server-pagination="{
          state: pagination,
          rowCount: total,
          onChange: handlePaginationChange,
        }"
      >
        <template #empty="{ table }">
          <Empty v-if="loading">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Spinner />
              </EmptyMedia>
              <EmptyTitle>加载中…</EmptyTitle>
            </EmptyHeader>
          </Empty>

          <Empty v-else-if="errorMessage">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AlertCircleIcon />
              </EmptyMedia>
              <EmptyTitle>数据加载失败</EmptyTitle>
              <EmptyDescription>
                {{ errorMessage }}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>

          <Empty v-else>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlusIcon />
              </EmptyMedia>
              <EmptyTitle>没有匹配的通知模板</EmptyTitle>
              <EmptyDescription>
                调整筛选条件，或新建一个通知模板。
                当前共 {{ table.getRowCount() }} 条。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </template>
      </DataTable>
    </div>

    <Sheet
      :open="createOpen"
      @update:open="createOpen = $event"
    >
      <SheetContent class="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>新建通知模板</SheetTitle>
          <SheetDescription>
            至少选择 1 个接收渠道。选择「回调」渠道时必须填写 Webhook URL。
          </SheetDescription>
        </SheetHeader>

        <NotificationTemplateForm
          :template="null"
          :submitting="creating"
          @submit="handleCreate"
          @cancel="createOpen = false"
        />
      </SheetContent>
    </Sheet>
  </BasicPage>
</template>
