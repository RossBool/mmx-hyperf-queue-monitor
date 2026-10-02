<script setup lang="ts">
import { PlusIcon, XIcon } from '@lucide/vue'

import type { AlarmPolicyCondition } from '@/types/alarm'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ALARM_LEVEL_LABEL, ALARM_OPERATOR_LABEL, ALARM_PERIOD_LABEL } from '@/types/alarm'

/**
 * 条件编辑器（骨架）—— 告警策略的触发条件数组编辑器。
 *
 * ⚠️ **这是一个纯展示骨架，故意不含任何业务逻辑**：
 * - 数据由父组件持有（`v-model:conditions`），本组件只负责排版与增删事件的抛出；
 * - 指标选择、阈值校验、`sort` 连续性、预填 `defaultOperator/defaultThreshold` 等
 *   全部由**告警策略任务**在其目录内实现并通过插槽注入。
 *
 * 插槽：
 * - 默认插槽（每条条件一个）：`{ condition, index }`，用于注入指标/阈值/周期等表单控件；
 * - `metric` 插槽：`{ condition, index }`，用于注入指标选择器。
 *
 * 契约约束（UI 必须体现，改动前请回看 `/workspace/docs/alarm/contract.md` §2.1 / P4-P11）：
 * - 条件数组长度 **1-4 条**，故新增按钮在 4 条时禁用；
 * - `sort` 必须是 1..N 连续升序且不重复；
 * - `metricNameCn` / `unit` 由**服务端从指标字典回填**，前端只读展示，不参与提交。
 */
const props = withDefaults(defineProps<{
  conditions: AlarmPolicyCondition[]
  /** 只读模式（详情页用） */
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  add: []
  remove: [index: number]
}>()

/** 契约硬上限 4 条（P4）。 */
const MAX_CONDITIONS = 4
/** 契约硬下限 1 条（P4），低于 1 条删除按钮禁用。 */
const MIN_CONDITIONS = 1

const canAdd = () => !props.disabled && props.conditions.length < MAX_CONDITIONS
const canRemove = () => !props.disabled && props.conditions.length > MIN_CONDITIONS
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        触发条件（{{ conditions.length }}/{{ MAX_CONDITIONS }}，契约要求 1-4 条）
      </p>
      <Button
        size="sm"
        variant="outline"
        :disabled="!canAdd()"
        @click="emit('add')"
      >
        <PlusIcon />
        添加条件
      </Button>
    </div>

    <Card v-for="(condition, index) in conditions" :key="condition.id ?? index">
      <CardHeader class="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle class="text-base">
          条件 {{ index + 1 }}
          <span class="ml-2 text-xs font-normal text-muted-foreground">
            {{ condition.metricNamespace }}.{{ condition.metricName }}
          </span>
        </CardTitle>
        <Button
          size="icon"
          variant="ghost"
          class="size-8"
          :disabled="!canRemove()"
          :aria-label="`删除条件 ${index + 1}`"
          @click="emit('remove', index)"
        >
          <XIcon />
        </Button>
      </CardHeader>

      <CardContent class="space-y-4">
        <slot name="metric" :condition="condition" :index="index" />

        <slot :condition="condition" :index="index">
          <!-- 未注入默认插槽时的只读兜底展示 -->
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-4">
            <div>
              <dt class="text-muted-foreground">
                指标
              </dt>
              <dd>{{ condition.metricNameCn }}（{{ condition.unit }}）</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">
                触发条件
              </dt>
              <dd>
                {{ ALARM_OPERATOR_LABEL[condition.operator] }}
                {{ condition.threshold }}{{ condition.unit }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground">
                统计粒度
              </dt>
              <dd>{{ ALARM_PERIOD_LABEL[condition.period] }}，持续 {{ condition.continuity }} 个周期</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">
                告警等级
              </dt>
              <dd>{{ ALARM_LEVEL_LABEL[condition.level] }}</dd>
            </div>
          </dl>
        </slot>
      </CardContent>
    </Card>
  </div>
</template>
