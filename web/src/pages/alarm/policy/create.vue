<script setup lang="ts">
import { computed } from 'vue'

import { BasicPage } from '@/components/global-layout'

import PolicyForm from './components/policy-form.vue'

/**
 * 告警策略 —— 新建页（契约端点 ③ `POST /api/alarm/policies`）。
 *
 * 支持两种进入方式：
 * - 直接新建：`/alarm/policy/create`
 * - 从列表「复制」进来：`/alarm/policy/create?copyFrom=1001`，
 *   向导会拉源策略详情并预填「原名 - 副本」（P16：新策略默认停用，需人工确认后启用）。
 *
 * 提交体是**全量**的（含 1-4 条 conditions），组装见 `buildPolicyPayload`。
 */
const route = useRoute()

const copyFrom = computed(() => {
  const raw = route.query.copyFrom
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number(value)
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
})
</script>

<template>
  <BasicPage
    title="新建告警策略"
    :description="copyFrom ? `基于策略 #${copyFrom} 复制配置，确认后创建新策略` : '填写策略基本信息、触发条件、告警对象与通知模板'"
  >
    <PolicyForm mode="create" :copy-from="copyFrom" />
  </BasicPage>
</template>
