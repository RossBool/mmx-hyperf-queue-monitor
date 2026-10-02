<script setup lang="ts">
/**
 * 告警历史 —— 顶部统计卡片（契约 ⑲ `GET /api/alarm/overview`）。
 *
 * ## 降级契约
 * 上游 `normalizeOverview`（`../logic.ts`）保证传进来的每个数字都是**有限数**——
 * 字段缺失 / `null` / `'abc'` / `NaN` / `Infinity` / 负数都已归一成 `0` 并置 `degraded`。
 * 所以本组件**不重复**做数值兜底，只负责：
 * 1. 把 `levelDistribution` 的 3 个等级（契约保证固定 3 项）画成条形；
 * 2. `degraded=true` 时给出可见的降级提示，而不是让用户以为「今天真的 0 条告警」。
 */
import { AlertTriangleIcon, BellRingIcon, FileStackIcon, ShieldCheckIcon } from '@lucide/vue'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ALARM_LEVEL } from '@/types/alarm'

import type { NormalizedOverview } from '../logic'

const props = defineProps<{
  overview: NormalizedOverview
  loading?: boolean
}>()

/** 三个等级各配一个色点，让条形图不依赖颜色也能读。 */
const LEVEL_DOT_CLASS: Record<number, string> = {
  [ALARM_LEVEL.EMERGENCY]: 'bg-destructive',
  [ALARM_LEVEL.SERIOUS]: 'bg-amber-500',
  [ALARM_LEVEL.NOTICE]: 'bg-sky-500',
}

/** 条形宽度百分比的最大刻度：取最大值并保底 1，避免全 0 时除以 0 产生 NaN。 */
const maxLevelCount = computed(() => {
  const counts = props.overview.levelDistribution.map(item => (Number.isFinite(item.count) ? item.count : 0))
  return Math.max(1, ...counts)
})

function levelBarWidth(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? count : 0
  return `${Math.round((safe / maxLevelCount.value) * 100)}%`
}
</script>

<template>
  <div class="space-y-3">
    <!-- 降级提示：宁可告诉用户「统计没拿到」，也不让 0 被误读成「今天没有告警」 -->
    <Alert v-if="overview.degraded" variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>统计数据不完整</AlertTitle>
      <AlertDescription>
        {{ overview.degradedReason ?? '统计数据加载失败' }}。异常字段已按 0 展示，数值仅供参考。
      </AlertDescription>
    </Alert>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <!-- 今日告警总数 -->
      <Card>
        <CardHeader>
          <CardDescription class="flex items-center gap-1.5">
            <BellRingIcon class="size-4" />
            今日告警总数
          </CardDescription>
          <CardTitle class="text-3xl tabular-nums">
            <Skeleton v-if="loading" class="h-8 w-16" />
            <template v-else>
              {{ overview.todayTotal }}
            </template>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-xs text-muted-foreground">
            服务器自然日 00:00:00 起统计
          </p>
        </CardContent>
      </Card>

      <!-- 今日未处理 -->
      <Card>
        <CardHeader>
          <CardDescription class="flex items-center gap-1.5">
            <AlertTriangleIcon class="size-4" />
            今日未处理
          </CardDescription>
          <CardTitle class="text-3xl tabular-nums">
            <Skeleton v-if="loading" class="h-8 w-16" />
            <template v-else>
              {{ overview.todayUnhandled }}
            </template>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-xs text-muted-foreground">
            状态为「未处理」的今日告警条数
          </p>
        </CardContent>
      </Card>

      <!-- 策略总数 / 已启用 -->
      <Card>
        <CardHeader>
          <CardDescription class="flex items-center gap-1.5">
            <FileStackIcon class="size-4" />
            策略总数
          </CardDescription>
          <CardTitle class="text-3xl tabular-nums">
            <Skeleton v-if="loading" class="h-8 w-16" />
            <template v-else>
              {{ overview.policyTotal }}
            </template>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Badge v-if="!loading" variant="secondary">
            <ShieldCheckIcon class="size-3" />
            已启用 {{ overview.policyEnabledTotal }}
          </Badge>
          <Skeleton v-else class="h-5 w-24" />
        </CardContent>
      </Card>

      <!-- 今日各等级分布：契约 ⑲ 固定 3 项、level 升序、无数据补 0 -->
      <Card>
        <CardHeader>
          <CardDescription>今日等级分布</CardDescription>
          <CardTitle class="text-sm font-normal">
            共 {{ overview.levelDistribution.reduce((sum, item) => sum + (Number.isFinite(item.count) ? item.count : 0), 0) }} 条
          </CardTitle>
        </CardHeader>
        <CardContent class="space-y-2">
          <Skeleton v-if="loading" class="h-16 w-full" />
          <div
            v-for="item in overview.levelDistribution"
            v-else
            :key="item.level"
            class="space-y-1"
          >
            <div class="flex items-center justify-between text-xs">
              <span class="flex items-center gap-1.5">
                <span class="size-2 rounded-full" :class="LEVEL_DOT_CLASS[item.level] ?? 'bg-muted-foreground'" />
                {{ item.levelCn }}
              </span>
              <span class="tabular-nums">{{ item.count }}</span>
            </div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                class="h-full rounded-full"
                :class="LEVEL_DOT_CLASS[item.level] ?? 'bg-muted-foreground'"
                :style="{ width: levelBarWidth(item.count) }"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
