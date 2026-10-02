<script setup lang="ts">
import { computed } from 'vue'

import { BasicPage } from '@/components/global-layout'

import PolicyForm from '../components/policy-form.vue'

/**
 * 告警策略 —— 编辑页（契约端点 ④ `PUT /api/alarm/policies/{id}`）。
 *
 * ⚠️ **全量更新语义（P18）**：
 * - 必须提交完整表单（含全部 1-4 条 conditions），省略 `conditions` 等价于清空 → 422；
 * - `status` 故意**不提交**（省略表示保持原值），启停只能走 ⑥ `POST /policies/{id}/status`。
 * 这两条都由 `buildPolicyPayload(values, 'update')` 保证，见 `utils/policy-logic.ts`。
 */
const route = useRoute()

const policyId = computed(() => {
  // 路由参数在 auto-routes 里是所有页面 params 的联合类型，这里收窄成字符串
  const raw = (route.params as Record<string, string | string[] | undefined>).id
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
})
</script>

<template>
  <BasicPage
    title="编辑告警策略"
    description="修改策略配置。注意 PUT 为全量更新，需提交完整表单"
  >
    <PolicyForm v-if="policyId" mode="update" :policy-id="policyId" />
  </BasicPage>
</template>
