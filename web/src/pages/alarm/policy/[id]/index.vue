<script setup lang="ts">
import { PencilIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import type { AlarmPolicyDetail } from '@/types/alarm'

import { BasicPage } from '@/components/global-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchAlarmPolicyDetail } from '@/services/api/alarm-policy.api'

import PolicyDetail from '../components/policy-detail.vue'
import { toPolicySectionModel } from '../utils/policy-view'

/**
 * 告警策略 —— 详情页（契约端点 ② `GET /api/alarm/policies/{id}`）。
 *
 * ⚠️ 两个归一化红线（§0.6），渲染前都已处理：
 * - `objectIds` / `objectGroupIds` / `objectFilters` 响应里**永远是 `null`**（不是 `[]`），
 *   由 `resolveObjectBinding` 归一后才渲染；
 * - `notificationTemplateIds` 响应里**永远是数组**，不需要判空。
 *
 * ⚠️ 详情里的 `notificationTemplates[].channels` 是**编码数组** `int[]`，
 * 不含接收人明细（避免泄漏），因此页面上不展示接收人。
 */
const route = useRoute()
const router = useRouter()

const policyId = computed(() => {
  // 路由参数在 auto-routes 里是所有页面 params 的联合类型，这里收窄成字符串
  const raw = (route.params as Record<string, string | string[] | undefined>).id
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
})

const detail = ref<AlarmPolicyDetail | null>(null)
const loading = ref(false)
const errorMessage = ref('')

async function load() {
  if (!policyId.value)
    return
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await fetchAlarmPolicyDetail(policyId.value)
    if (!res.success) {
      errorMessage.value = res.message || '策略详情加载失败'
      detail.value = null
      return
    }
    detail.value = res.data ?? null
    if (!detail.value)
      errorMessage.value = '策略详情为空'
  }
  catch (error) {
    errorMessage.value = (error as Error).message
  }
  finally {
    loading.value = false
  }
}

const model = computed(() => (detail.value ? toPolicySectionModel(detail.value) : null))

function goEdit() {
  if (policyId.value)
    router.push(`/alarm/policy/${policyId.value}/edit`)
}

function goHistory() {
  if (policyId.value)
    router.push({ path: '/alarm/history', query: { policyId: String(policyId.value) } })
}

onMounted(load)
</script>

<template>
  <BasicPage
    :title="detail?.name ?? '告警策略详情'"
    :description="detail ? `策略 #${detail.id} · 创建人 ${detail.creatorName}` : '查看策略全量配置：触发条件、告警对象与已绑定的通知模板'"
  >
    <template #actions>
      <Button variant="outline" @click="goHistory">
        查看告警历史
      </Button>
      <Button @click="goEdit">
        <PencilIcon />
        编辑
      </Button>
    </template>

    <div class="space-y-4">
      <div v-if="loading" class="space-y-4">
        <Skeleton class="h-40 w-full" />
        <Skeleton class="h-64 w-full" />
      </div>

      <Alert v-else-if="errorMessage" variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>加载失败</AlertTitle>
        <AlertDescription class="flex items-center gap-3">
          <span>{{ errorMessage }}</span>
          <Button size="sm" variant="outline" @click="load">
            重试
          </Button>
        </AlertDescription>
      </Alert>

      <PolicyDetail v-else-if="model" :model="model" />

      <div v-else class="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
        未找到该策略
      </div>
    </div>
  </BasicPage>
</template>
