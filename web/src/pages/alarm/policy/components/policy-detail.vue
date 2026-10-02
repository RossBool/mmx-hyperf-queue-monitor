<script setup lang="ts">
import { TriangleAlertIcon } from '@lucide/vue'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'

import type { PolicySectionModel } from '../utils/policy-view'

import { AlarmLevelBadge, ConditionEditor } from '../../components'
import { buildConditionSummary } from '../utils/policy-logic'
import { describeObjectFilter, objectRequiredFieldLabel } from '../utils/policy-view'

/**
 * 策略详情分区渲染 —— 详情页与向导第 4 步「确认」页**共用同一个组件**，
 * 保证两处视觉与信息完全一致（契约字段一个不落）。
 *
 * 四个分区：基本信息 / 告警条件 / 告警对象 / 告警通知。
 * 数据源由 `utils/policy-view.ts` 归一化：
 * - 详情页 → `toPolicySectionModel(AlarmPolicyDetail)`
 * - 确认页 → `toPolicySectionModelFromForm(PolicyFormValues)`
 */
const props = withDefaults(defineProps<{
  model: PolicySectionModel
  /** 运行时校验错误（P12 / P13 / N9），确认页传，详情页不传 */
  notifyErrors?: string[]
}>(), {
  notifyErrors: () => [],
})

const basicItems = computed(() => [
  { label: '策略名称', value: props.model.name || '—' },
  { label: '监控类型', value: props.model.monitorTypeLabel },
  { label: '策略类型', value: props.model.policyTypeLabel },
  { label: '所属项目', value: props.model.projectLabel },
  { label: '策略状态', value: props.model.statusLabel },
  { label: '创建人', value: props.model.creatorName || '—' },
  { label: '创建时间', value: props.model.createdAt || '—' },
  { label: '更新时间', value: props.model.updatedAt || '—' },
])

const objectIdsText = computed(() => props.model.objectIds.map(String))
const objectGroupIdsText = computed(() => props.model.objectGroupIds.map(String))

/**
 * 条件摘要：「前 2 条；… 等 N 条」（`buildConditionSummary`）。
 *
 * 这里**才有**完整 `conditions` 可用——列表接口按契约 §2.2 只给 `conditionCount`，
 * 所以摘要只能出现在详情页与确认页。
 */
const conditionSummary = computed(() => buildConditionSummary(props.model.conditions, 2))
</script>

<template>
  <div class="space-y-6">
    <!-- ① 基本信息 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          基本信息
        </CardTitle>
        <CardDescription>
          备注：{{ model.remark || '—' }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4">
          <div v-for="item in basicItems" :key="item.label">
            <dt class="text-muted-foreground">
              {{ item.label }}
            </dt>
            <dd class="break-all">
              {{ item.value }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">
              策略等级
            </dt>
            <dd>
              <AlarmLevelBadge v-if="model.level" :level="model.level" />
              <span v-else>—</span>
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>

    <!-- ② 告警条件 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          告警条件
        </CardTitle>
        <CardDescription>
          条件关系：{{ model.conditionLogicLabel }}
          <template v-if="model.conditionTemplateName">
            · 来源模板：{{ model.conditionTemplateName }}
          </template>
          <div class="mt-1">
            条件摘要：{{ conditionSummary }}
          </div>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <!-- 复用公共条件编辑器的只读兜底展示；disabled 关掉增删按钮 -->
        <ConditionEditor :conditions="model.conditions" disabled />
      </CardContent>
    </Card>

    <!-- ③ 告警对象 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          告警对象
        </CardTitle>
        <CardDescription>
          {{ model.objectTypeLabel }} · {{ model.objectSummary }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 text-sm">
        <div v-if="model.objectType === 1">
          <span class="text-muted-foreground">全部对象：</span>
          该策略类型下当前账号有权限的全部实例，无需逐个选择。
        </div>

        <div v-else-if="model.objectType === 2">
          <div class="mb-1 text-muted-foreground">
            指定实例（{{ objectRequiredFieldLabel(model.objectType) }}，共 {{ objectIdsText.length }} 个）
          </div>
          <div class="flex flex-wrap gap-1">
            <Badge v-for="id in objectIdsText" :key="id" variant="outline">
              {{ id }}
            </Badge>
            <span v-if="!objectIdsText.length" class="text-destructive">
              未选择实例
            </span>
          </div>
        </div>

        <div v-else-if="model.objectType === 3">
          <div class="mb-1 text-muted-foreground">
            实例分组（共 {{ objectGroupIdsText.length }} 个）
          </div>
          <div class="flex flex-wrap gap-1">
            <Badge v-for="id in objectGroupIdsText" :key="id" variant="outline">
              {{ id }}
            </Badge>
            <span v-if="!objectGroupIdsText.length" class="text-destructive">
              未选择分组
            </span>
          </div>
        </div>

        <div v-else>
          <div class="mb-1 text-muted-foreground">
            多维筛选（共 {{ model.objectFilters.length }} 条）
          </div>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="(filter, index) in model.objectFilters" :key="index">
              {{ describeObjectFilter(filter) }}
            </li>
          </ul>
          <span v-if="!model.objectFilters.length" class="text-destructive">未配置筛选条件</span>
        </div>
      </CardContent>
    </Card>

    <!-- ④ 告警通知 -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          告警通知
        </CardTitle>
        <CardDescription>
          已绑定 {{ model.notificationTemplates.length }} / 3 个通知模板
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 text-sm">
        <div v-if="model.notificationTemplates.length" class="space-y-2">
          <div
            v-for="template in model.notificationTemplates"
            :key="template.id"
            class="flex flex-wrap items-center gap-2"
          >
            <span class="font-medium">{{ template.name }}</span>
            <Badge variant="secondary">
              {{ template.channelsLabel }}
            </Badge>
            <Badge v-if="template.isPreset === 1" variant="outline">
              系统预置
            </Badge>
          </div>
        </div>
        <p v-else class="text-muted-foreground">
          未绑定通知模板（告警将不推送通知，仅在控制台记录）。
        </p>

        <Separator />

        <div>
          <span class="text-muted-foreground">回调地址：</span>
          <template v-if="model.callbackUrl">
            {{ model.callbackUrl }}
          </template>
          <span v-else-if="model.callbackUrlFromFormOnly" class="text-muted-foreground">
            —（回调地址属于通知模板的渠道明细，策略详情接口不返回）
          </span>
          <span v-else class="text-muted-foreground">
            —
          </span>
        </div>

        <Alert v-if="notifyErrors.length" variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>告警通知未通过校验</AlertTitle>
          <AlertDescription>
            <ul class="list-disc space-y-1 pl-4">
              <li v-for="(error, index) in notifyErrors" :key="index">
                {{ error }}
              </li>
            </ul>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  </div>
</template>
