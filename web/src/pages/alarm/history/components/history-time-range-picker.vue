<script setup lang="ts">
/**
 * 时间范围选择器 —— 项目已有的 `RangeCalendar`（`@internationalized/date` 的 `CalendarDate`）。
 *
 * ## 为什么用项目组件而不是 `new Date()`
 * 契约 §0.1 的时间是 `YYYY-MM-DD HH:mm:ss`、服务器时区 Asia/Shanghai、**不带时区后缀**。
 * 走 `new Date('2026-09-01')` 会被按 UTC 解析再转本地时区，在非 +08:00 的机器上
 * 直接差一天。`CalendarDate` 是「日历日」没有时区概念，直接取年月日最稳。
 *
 * 格式化与参数拼装全部在 `../logic.ts`（`buildTimeRangeParams`），本组件只收集输入。
 */
import type { CalendarDate, DateValue } from '@internationalized/date'
import type { DateRange } from 'reka-ui'

import { CalendarIcon, XIcon } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RangeCalendar } from '@/components/ui/range-calendar'

import type { TimeRangeInput } from '../logic'

import { buildTimeRangeParams, formatTimeRangeLabel } from '../logic'

const props = defineProps<{
  modelValue: TimeRangeInput
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [range: TimeRangeInput]
}>()

const open = ref(false)

/** 契约 H4 的本地校验结果：`error` 非空时页面**不应**发请求。 */
const params = computed(() => buildTimeRangeParams(props.modelValue))
const errorMessage = computed(() => params.value.error)

const label = computed(() => formatTimeRangeLabel(props.modelValue))

/**
 * 收窄到 `DateValue`（RangeCalendar 的 `modelValue` 只接受 `DateValue` 成员）。
 *
 * 字符串形态（`YYYY-MM-DD`）在**显示方向**上被丢掉：它本来就只出现在单测构造的
 * 非法输入里，标签栏此时已经显示「格式不合法」，日历上高亮与否没有意义。
 * 真正的格式校验统一由 `../logic.ts` 的 `toCalendarDate` 负责。
 */
function toDateValue(value: unknown): DateValue | undefined {
  if (!value || typeof value !== 'object')
    return undefined

  const record = value as Partial<CalendarDate>
  return Number.isFinite(record.year) && Number.isFinite(record.month) && Number.isFinite(record.day)
    ? (value as DateValue)
    : undefined
}

/** `TimeRangeInput` → RangeCalendar 的 `DateRange`（两端都可能只有一端，甚至都没有）。 */
const calendarValue = computed<DateRange | null>(() => {
  const start = toDateValue(props.modelValue?.start)
  const end = toDateValue(props.modelValue?.end)

  if (!start && !end)
    return null

  return { start, end }
})

/**
 * RangeCalendar 回传 `DateRange`（两端都可能是 `undefined`）。
 *
 * 契约的 `TimeRangeInput` 允许任意一端缺失（只选一端是合法的筛选），
 * 所以这里把「没选」表达成 `null`，**不**替用户补默认值。
 *
 * ⚠️ 这里**不收窄** `DateValue` → `CalendarDate`：`TimeRangeInput` 本就接受整个
 * `DateValue` 联合，格式校验（含拒绝 `CalendarDateTime` / `ZonedDateTime`）
 * 统一由 `../logic.ts` 的 `toCalendarDate` 负责——单点收口，不在组件里重复一遍。
 */
function handleChange(value: DateRange | null) {
  emit('update:modelValue', {
    start: value?.start ?? null,
    end: value?.end ?? null,
  })
}

function clear() {
  emit('update:modelValue', { start: null, end: null })
}
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex items-center gap-2">
      <Popover
        v-model:open="open"
      >
        <PopoverTrigger as-child>
          <Button
            variant="outline"
            class="w-[240px] justify-start font-normal"
            :disabled="disabled"
          >
            <CalendarIcon />
            {{ label }}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          class="w-auto p-0"
          align="start"
        >
          <RangeCalendar
            :model-value="calendarValue"
            :number-of-months="2"
            @update:model-value="handleChange"
          />
        </PopoverContent>
      </Popover>

      <Button
        v-if="params.startTime || params.endTime"
        variant="ghost"
        size="icon"
        :disabled="disabled"
        aria-label="清空时间范围"
        @click="clear"
      >
        <XIcon />
      </Button>
    </div>

    <!-- H4 / 非法值：把「开始晚于结束」「非数字」在筛选条上就说清楚，而不是等 422 -->
    <p
      v-if="errorMessage"
      class="text-xs text-destructive"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>
