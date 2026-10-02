<script setup lang="ts">
import type { PaginationState } from '@tanstack/vue-table'

import { AlertCircleIcon, RotateCwIcon, SearchIcon } from '@lucide/vue'

/**
 * 告警历史 —— 列表页（契约端点 ⑰-⑲）。
 *
 * - ⑰ `GET /api/alarm/histories`（策略 / 等级 / 状态 / 关键词 / 时间范围 + 分页）
 * - ⑱ `POST /api/alarm/histories/{id}/handle`（处理 / 忽略 / 标记已恢复）
 * - ⑲ `GET /api/alarm/overview`（顶部统计）
 *
 * ⚠️ 历史记录**不提供删除端点**（H5），只增不改状态。
 * 排序固定 `triggered_at DESC, id DESC`，当前版本不开放排序参数。
 *
 * ## 三处「不崩」设计
 * 1. **路由 query**：`?policyId=xxx` 缺失 / 非法（`abc`）时降级为「不过滤」，
 *    由 `parsePolicyIdQuery` 兜住，绝不抛异常。
 * 2. **时间范围**：本地校验（`buildTimeRangeParams`），非法时**不发请求**——
 *    否则 `startTime > endTime` 必然换来一个 422。
 * 3. **统计**：任何异常都经 `normalizeOverview` 归一成有限数 + `degraded` 标记，
 *    界面上不会出现 `NaN`。
 *
 * ## 竞态防护
 * 列表与统计各有一个自增请求序号，只有最后一次请求的结果能写回，
 * 快速切换筛选时旧响应不会覆盖新响应。
 */
import type { AlarmHistory } from '@/types/alarm'

import { DataTable } from '@/components/data-table'
import { BasicPage } from '@/components/global-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { alarmHistoryStatusOptions, alarmLevelOptions } from '@/pages/alarm/components'
import { fetchAlarmHistoryList, fetchAlarmOverview } from '@/services/api/alarm-history.api'
import { ALARM_HISTORY_STATUS } from '@/types/alarm'

import type { HistoryFilterState, NormalizedOverview, TimeRangeInput } from './logic'

import { columns } from './components/columns'
import HistoryOverviewCards from './components/history-overview-cards.vue'
import HistoryTimeRangePicker from './components/history-time-range-picker.vue'
import {
  buildHistoryListQuery,
  createEmptyOverview,
  extractAlarmErrorMessage,
  normalizeOverview,
  PAGE_SIZE_DEFAULT,
  parsePolicyIdQuery,
} from './logic'
import { provideAlarmRefresh } from './refresh'

/** 页面级草稿筛选：与 `buildHistoryListQuery` 的入参同构，但 `policyId` 已归一化成 number。 */
interface HistoryDraftFilters {
  keyword: string
  level?: AlarmHistory['level']
  status?: AlarmHistory['status']
  range: TimeRangeInput
  policyId?: number
}

// ============================================================================
// 状态
// ============================================================================

const list = ref<AlarmHistory[]>([])
const total = ref(0)
const loading = ref(false)
const errorMessage = ref<string | null>(null)
const timeError = ref<string | null>(null)

const overview = ref<NormalizedOverview>(createEmptyOverview('统计数据加载中'))
const overviewLoading = ref(false)

/** 分页：TanStack 用 0-based `pageIndex`，契约用 1-based `page`。 */
const pagination = ref<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE_DEFAULT })

/**
 * 筛选态拆成「草稿 / 生效中」两份：
 * 关键词是输入框、等级/状态/时间是下拉，都不应该每敲一个字就打一次接口。
 *
 * ⚠️ 用 `shallowReactive` / `shallowRef` 而不是 `reactive` / `ref`：
 * `range` 里装的是 `@internationalized/date` 的 `DateValue` **类实例**（带 `#private` 品牌字段），
 * 而深层响应式的 `UnwrapNestedRefs` 会把它摊平成普通对象，类型上就不再是 `DateValue`，
 * 传给 `buildHistoryListQuery` / `TimeRangePicker` 时直接报类型不兼容。
 * 浅层响应式不做这层摊平；而且时间范围本来就是**整体替换** `{ start, end }`，
 * 不需要深层追踪——这个「必须用 shallow」的坑值得留在注释里。
 */
const draftFilters = shallowReactive<HistoryDraftFilters>({
  keyword: '',
  level: undefined,
  status: undefined,
  range: { start: null, end: null },
  policyId: undefined,
})

const activeFilters = shallowRef<HistoryFilterState>({ keyword: '', range: { start: null, end: null } })

// 竞态防护：只有序号等于当前值的响应才允许写回
let listSeq = 0
let overviewSeq = 0

// ============================================================================
// 路由 query 预置筛选（?policyId=xxx）
// ============================================================================

const route = useRoute()

/**
 * 读一次路由 query 里的 `policyId`。
 *
 * ⚠️ 非法值（`abc` / 空 / 负数 / 数组）由 `parsePolicyIdQuery` 判为 `undefined`，
 * 页面照常展示全量列表，**不抛异常、不白屏**。
 */
const initialPolicyId = parsePolicyIdQuery(route.query.policyId)
const invalidPolicyIdQuery = route.query.policyId !== undefined && initialPolicyId === undefined

// ============================================================================
// 取数
// ============================================================================

async function load() {
  const { query, timeError: rangeError } = buildHistoryListQuery(
    activeFilters.value,
    pagination.value.pageIndex + 1,
    pagination.value.pageSize,
  )

  // H4：时间范围非法时**不发请求**（发出去必然 422），保留上一次的结果并给出原因
  if (rangeError) {
    timeError.value = rangeError
    return
  }
  timeError.value = null

  const seq = ++listSeq
  loading.value = true
  try {
    const res = await fetchAlarmHistoryList(query)

    if (seq !== listSeq)
      return

    if (!res.success) {
      errorMessage.value = res.message || '告警历史加载失败'
      list.value = []
      total.value = 0
      return
    }

    errorMessage.value = null
    list.value = Array.isArray(res.data?.list) ? res.data.list : []
    total.value = Number.isFinite(res.data?.total) ? res.data.total : list.value.length
  }
  catch (error) {
    if (seq !== listSeq)
      return
    errorMessage.value = extractAlarmErrorMessage(error, '告警历史加载失败')
    list.value = []
    total.value = 0
  }
  finally {
    // 同样判 seq：被取代的请求不能提前把 loading 关掉
    if (seq === listSeq)
      loading.value = false
  }
}

async function loadOverview() {
  const seq = ++overviewSeq
  overviewLoading.value = true
  try {
    const res = await fetchAlarmOverview()

    if (seq !== overviewSeq)
      return

    // `success=false` 或 `data` 缺失都走 `normalizeOverview` 兜底，
    // 绝不让 `res.data.todayTotal` 变成 `undefined + 1 = NaN` 渲染到卡片上
    overview.value = res.success ? normalizeOverview(res.data) : createEmptyOverview(res.message || '统计数据加载失败')
  }
  catch (error) {
    if (seq !== overviewSeq)
      return
    overview.value = createEmptyOverview(extractAlarmErrorMessage(error, '统计数据加载失败'))
  }
  finally {
    if (seq === overviewSeq)
      overviewLoading.value = false
  }
}

onMounted(() => {
  // query 合法才预置；非法时保持「全部」并在界面上说明
  if (initialPolicyId !== undefined) {
    draftFilters.policyId = initialPolicyId
    activeFilters.value = { ...activeFilters.value, policyId: initialPolicyId }
  }

  load()
  loadOverview()
})

// ============================================================================
// 交互
// ============================================================================

function applyFilters() {
  activeFilters.value = {
    keyword: draftFilters.keyword,
    level: draftFilters.level,
    status: draftFilters.status,
    range: draftFilters.range,
    policyId: draftFilters.policyId,
  }
  // 改筛选后必须回到第 1 页，否则可能停在一个已经不存在的空页上
  pagination.value = { ...pagination.value, pageIndex: 0 }
  load()
}

function resetFilters() {
  draftFilters.keyword = ''
  draftFilters.level = undefined
  draftFilters.status = undefined
  draftFilters.range = { start: null, end: null }
  draftFilters.policyId = undefined
  activeFilters.value = { keyword: '', range: { start: null, end: null } }
  pagination.value = { ...pagination.value, pageIndex: 0 }
  load()
}

function handlePaginationChange(updater: PaginationState | ((old: PaginationState) => PaginationState)) {
  const next = typeof updater === 'function' ? updater(pagination.value) : updater
  pagination.value = next
  load()
}

/** 筛选条上「只看待处理」的快捷入口：等价于 `status = 1`（契约 §1.10）。 */
function showUnhandledOnly() {
  draftFilters.status = ALARM_HISTORY_STATUS.UNHANDLED
  applyFilters()
}

/**
 * 等级 / 状态筛选的 Select 用字符串 value，提交前转回契约的**数值枚举**。
 * 无法在选项里匹配到的一律按「全部」处理，不透传给后端（非法枚举会换来 422）。
 */
function parseLevelValue(value: string): AlarmHistory['level'] | undefined {
  return alarmLevelOptions.find(option => String(option.value) === value)?.value
}

function parseStatusValue(value: string): AlarmHistory['status'] | undefined {
  return alarmHistoryStatusOptions.find(option => String(option.value) === value)?.value
}

// ⑱ 处理成功后由行操作组件调用（见 `../refresh.ts`）：列表与统计同时刷新
provideAlarmRefresh(() => {
  load()
  loadOverview()
})
</script>

<template>
  <BasicPage
    title="告警历史"
    description="查询历史告警，并进行处理、忽略或标记已恢复"
    sticky
  >
    <template #actions>
      <Button
        variant="outline"
        :disabled="loading"
        @click="showUnhandledOnly"
      >
        只看待处理
      </Button>
      <Button
        :disabled="loading"
        @click="load"
      >
        <RotateCwIcon />
        刷新
      </Button>
    </template>

    <div class="space-y-4">
      <!-- ⑲ 顶部统计：任何异常都降级显示，不出现 NaN -->
      <HistoryOverviewCards
        :overview="overview"
        :loading="overviewLoading"
      />

      <!-- 筛选条：契约 ⑰ 的 policyId / level / status / keyword / startTime / endTime -->
      <div class="flex flex-col gap-3 rounded-md border p-3 lg:flex-row lg:items-end">
        <div class="flex-1 space-y-1.5">
          <label class="text-sm font-medium" for="history-keyword">关键词</label>
          <Input
            id="history-keyword"
            v-model="draftFilters.keyword"
            placeholder="模糊匹配策略名 / 告警对象 / 指标名"
            @keyup.enter="applyFilters"
          />
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">告警等级</label>
          <Select
            :model-value="draftFilters.level === undefined ? 'all' : String(draftFilters.level)"
            @update:model-value="value => draftFilters.level = value === 'all' ? undefined : parseLevelValue(String(value))"
          >
            <SelectTrigger class="w-[140px]">
              <SelectValue placeholder="全部等级" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                全部等级
              </SelectItem>
              <SelectItem
                v-for="option in alarmLevelOptions"
                :key="option.value"
                :value="String(option.value)"
              >
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-1.5">
          <label class="text-sm font-medium">处理状态</label>
          <Select
            :model-value="draftFilters.status === undefined ? 'all' : String(draftFilters.status)"
            @update:model-value="value => draftFilters.status = value === 'all' ? undefined : parseStatusValue(String(value))"
          >
            <SelectTrigger class="w-[140px]">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                全部状态
              </SelectItem>
              <SelectItem
                v-for="option in alarmHistoryStatusOptions"
                :key="option.value"
                :value="String(option.value)"
              >
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="space-y-1.5">
          <span class="text-sm font-medium">触发时间范围</span>
          <HistoryTimeRangePicker
            v-model="draftFilters.range"
            :disabled="loading"
          />
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
            重置
          </Button>
        </div>
      </div>

      <!-- 路由 query 预置提示：合法值显示当前筛选，非法值给出说明而不是白屏 -->
      <Alert v-if="initialPolicyId !== undefined || invalidPolicyIdQuery">
        <AlertCircleIcon />
        <AlertTitle>已按策略预置筛选</AlertTitle>
        <AlertDescription>
          <template v-if="initialPolicyId !== undefined">
            当前仅显示策略 id = {{ initialPolicyId }} 的告警历史。
          </template>
          <template v-else>
            链接中的 policyId 参数不是合法的正整数，已忽略该筛选条件。
          </template>
        </AlertDescription>
      </Alert>

      <!-- 时间范围本地校验错误：H4，发请求前就拦住 -->
      <Alert v-if="timeError" variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>时间范围有误</AlertTitle>
        <AlertDescription>{{ timeError }}，已保留上一次的结果。请修正后重新查询。</AlertDescription>
      </Alert>

      <!-- 错误态：接口失败时给可读提示 + 重试，而不是空表格 -->
      <Alert v-if="errorMessage" variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>告警历史加载失败</AlertTitle>
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
              <EmptyDescription>{{ errorMessage }}</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <Empty v-else>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>没有匹配的告警历史</EmptyTitle>
              <EmptyDescription>
                调整筛选条件后重试。当前共 {{ table.getRowCount() }} 条。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </template>
      </DataTable>
    </div>
  </BasicPage>
</template>
