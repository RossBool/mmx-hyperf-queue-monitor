<script setup lang="ts">
import { FilterXIcon, SearchIcon } from '@lucide/vue'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import type { PolicyListFilters } from '../utils/policy-logic'

import {
  alarmLevelOptions,
  alarmMonitorTypeOptions,
  alarmPolicyStatusOptions,
  alarmPolicyTypeOptions,
} from '../../components'

/**
 * 告警策略筛选栏。
 *
 * 契约 §3.1 ①：`keyword / monitorType / policyType / status / level / projectId`，
 * 多条件之间为 AND，**空字符串视为未传**（组装 query 时处理，见 `buildPolicyListQuery`）。
 *
 * 筛选值通过 `v-model` 直接写回列表页；列表页用防抖 watch 监听，
 * 一变就把页码**重置回第 1 页**再重新拉数据（契约 §3.1 ① 的筛选与分页是独立参数）。
 */
const filters = defineModel<PolicyListFilters>({ required: true })

/** 项目没有列表端点，契约只接受 `projectId` 数字，这里用数字输入。 */
const projectIdInput = computed({
  get: () => (filters.value.projectId === undefined || filters.value.projectId === '' ? '' : String(filters.value.projectId)),
  set: (value: string) => {
    filters.value = { ...filters.value, projectId: value }
  },
})

function update<K extends keyof PolicyListFilters>(key: K, value: PolicyListFilters[K]) {
  filters.value = { ...filters.value, [key]: value }
}

function reset() {
  filters.value = { keyword: '', monitorType: undefined, policyType: undefined, status: undefined, level: undefined, projectId: '' }
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-lg border p-4">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 text-sm font-medium">
        <FilterXIcon class="size-4" />
        筛选条件
      </div>
      <Button variant="ghost" size="sm" @click="reset">
        重置
      </Button>
    </div>

    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <div class="space-y-2">
        <Label for="filter-keyword">名称关键词</Label>
        <div class="relative">
          <SearchIcon class="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input
            id="filter-keyword"
            class="pl-8"
            :model-value="filters.keyword ?? ''"
            placeholder="模糊匹配策略名/备注"
            @input="update('keyword', ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>

      <div class="space-y-2">
        <Label>监控类型</Label>
        <Select
          :model-value="filters.monitorType === undefined ? undefined : String(filters.monitorType)"
          @update:model-value="(v) => update('monitorType', v === undefined ? undefined : Number(v))"
        >
          <SelectTrigger class="w-full">
            <SelectValue placeholder="全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in alarmMonitorTypeOptions" :key="option.value" :value="String(option.value)">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label>策略类型</Label>
        <Select
          :model-value="filters.policyType === undefined ? undefined : String(filters.policyType)"
          @update:model-value="(v) => update('policyType', v === undefined ? undefined : Number(v))"
        >
          <SelectTrigger class="w-full">
            <SelectValue placeholder="全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in alarmPolicyTypeOptions" :key="option.value" :value="String(option.value)">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label>告警等级</Label>
        <Select
          :model-value="filters.level === undefined ? undefined : String(filters.level)"
          @update:model-value="(v) => update('level', v === undefined ? undefined : Number(v))"
        >
          <SelectTrigger class="w-full">
            <SelectValue placeholder="全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in alarmLevelOptions" :key="option.value" :value="String(option.value)">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label>状态</Label>
        <Select
          :model-value="filters.status === undefined ? undefined : String(filters.status)"
          @update:model-value="(v) => update('status', v === undefined ? undefined : Number(v))"
        >
          <SelectTrigger class="w-full">
            <SelectValue placeholder="全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in alarmPolicyStatusOptions" :key="option.value" :value="String(option.value)">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-2">
        <Label for="filter-project">所属项目</Label>
        <Input
          id="filter-project"
          type="number"
          min="0"
          placeholder="项目 id，0=未分配"
          :model-value="projectIdInput"
          @input="projectIdInput = ($event.target as HTMLInputElement).value"
        />
      </div>
    </div>
  </div>
</template>
