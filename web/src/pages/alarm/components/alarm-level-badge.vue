<script setup lang="ts">
import type { AlarmLevel } from '@/types/alarm'

import { Badge } from '@/components/ui/badge'
import { ALARM_LEVEL, ALARM_LEVEL_LABEL } from '@/types/alarm'

/**
 * 告警等级徽标 —— 告警策略列表与告警历史列表共用。
 *
 * 等级色标遵循契约「数值越小越严重」：`1` 紧急 / `2` 严重 / `3` 提示。
 * 纯展示组件，不含业务逻辑，三个页面都可直接用。
 */
defineProps<{
  level: AlarmLevel
  /** 是否额外显示数值（表格里需要区分时打开） */
  showValue?: boolean
}>()

/** 1 紧急 → destructive，2 严重 → secondary（橙/amber 语义由样式层决定），3 提示 → outline。 */
const VARIANT_BY_LEVEL = {
  [ALARM_LEVEL.EMERGENCY]: 'destructive',
  [ALARM_LEVEL.SERIOUS]: 'default',
  [ALARM_LEVEL.NOTICE]: 'outline',
} as const

const label = (level: AlarmLevel) => ALARM_LEVEL_LABEL[level]
</script>

<template>
  <Badge :variant="VARIANT_BY_LEVEL[level]">
    {{ label(level) }}
    <span v-if="showValue" class="opacity-60">({{ level }})</span>
  </Badge>
</template>
