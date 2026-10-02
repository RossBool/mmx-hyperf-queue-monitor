<script setup lang="ts">
import { BasicPage } from '@/components/global-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'

/**
 * 告警模块占位页骨架（route slot placeholder）。
 *
 * 三个页面（告警策略 / 通知模板 / 告警历史）当前都指向本占位组件，
 * 由后续并行任务替换为真实实现。**本任务只交付地基 + 契约类型层，不实现业务页面。**
 *
 * @see src/pages/alarm/components/index.ts —— 目录归属与分工说明
 */
defineProps<{
  /** 页面标题，与侧边菜单文案保持一致 */
  title: string
  /** 页面副标题 */
  description: string
  /** 契约中该页面主数据表的接口路径，便于联调时对齐 */
  endpoint: string
  /** 负责填充该页面的后续任务代号 */
  owner: string
}>()
</script>

<template>
  <BasicPage
    :title="title"
    :description="description"
  >
    <Alert>
      <AlertTitle>
        {{ title }} — 路由插槽已就位，页面实现由后续任务填充
      </AlertTitle>
      <AlertDescription class="space-y-2">
        <p>
          本任务只交付可扩展地基（目录结构 / 路由 / 契约类型层 / 传输层），
          <strong>不实现业务页面</strong>。
        </p>
        <p class="flex flex-wrap items-center gap-2">
          <span>主数据接口：</span>
          <Badge variant="secondary">
            {{ endpoint }}
          </Badge>
        </p>
        <p class="flex flex-wrap items-center gap-2">
          <span>负责任务：</span>
          <Badge variant="outline">
            {{ owner }}
          </Badge>
        </p>
      </AlertDescription>
    </Alert>
  </BasicPage>
</template>
