import { h } from 'vue'

import type { DataTableColumnDef } from '@/components/data-table'
import type { AlarmPolicyListItem, AlarmPolicyStatus } from '@/types/alarm'

import { Switch } from '@/components/ui/switch'
import { ALARM_OBJECT_TYPE, ALARM_POLICY_STATUS } from '@/types/alarm'

import { AlarmLevelBadge } from '../../components'
import { buildConditionCountLabel } from '../utils/policy-logic'
import PolicyRowActions from './policy-row-actions.vue'

/** 列表页列渲染需要的回调（由 `index.vue` 注入，便于在 .ts 里保持纯渲染逻辑）。 */
export interface PolicyColumnHandlers {
  /** 启停：乐观更新 + 失败回滚由页面负责 */
  onToggleStatus: (policy: AlarmPolicyListItem, next: AlarmPolicyStatus) => void
  onView: (policy: AlarmPolicyListItem) => void
  onEdit: (policy: AlarmPolicyListItem) => void
  /** 复制：跳新建页并预填「原名 - 副本」 */
  onCopy: (policy: AlarmPolicyListItem) => void
  onHistory: (policy: AlarmPolicyListItem) => void
  onDelete: (policy: AlarmPolicyListItem) => void
  /** 正在提交的策略 id（启停 / 删除进行中，禁用交互） */
  pendingId: () => number | null
}

const OBJECT_TYPE_LABEL: Record<number, string> = {
  [ALARM_OBJECT_TYPE.ALL]: '告警对象：全部对象',
  [ALARM_OBJECT_TYPE.INSTANCE]: '告警对象：指定实例',
  [ALARM_OBJECT_TYPE.GROUP]: '告警对象：实例分组',
  [ALARM_OBJECT_TYPE.FILTER]: '告警对象：多维筛选',
}

/**
 * 告警策略列表列定义。
 *
 * ⚠️ 契约 §2.2：列表接口**不返回** `conditions` 明细，也不返回 `objectIds`，
 * 所以「告警条件」列只能用 `conditionCount` 概括；「前 N 条 + 等 N 条」的完整摘要
 * （`buildConditionSummary`）在**详情页 / 确认页**展示，那里才有 conditions。
 */
export function createPolicyColumns(
  handlers: PolicyColumnHandlers,
): DataTableColumnDef<AlarmPolicyListItem>[] {
  return [
    {
      accessorKey: 'name',
      header: '策略名',
      size: 240,
      enableSorting: false,
      cell: ({ row }) => {
        const policy = row.original
        return h('div', { class: 'flex min-w-0 flex-col gap-0.5' }, [
          h('span', { class: 'truncate font-medium' }, policy.name),
          h('span', { class: 'truncate text-xs text-muted-foreground' }, policy.remark || '无备注'),
        ])
      },
    },
    {
      accessorKey: 'monitorType',
      header: '监控类型',
      size: 120,
      enableSorting: false,
      cell: ({ row }) => h('span', { class: 'text-sm' }, row.original.monitorTypeCn || '—'),
    },
    {
      accessorKey: 'policyType',
      header: '策略类型',
      size: 140,
      enableSorting: false,
      cell: ({ row }) => h('span', { class: 'text-sm' }, row.original.policyTypeCn || '—'),
    },
    {
      id: 'conditionSummary',
      header: '告警条件',
      size: 190,
      enableSorting: false,
      cell: ({ row }) => {
        const policy = row.original
        return h('div', { class: 'flex flex-col gap-0.5' }, [
          h('span', { class: 'text-sm' }, buildConditionCountLabel(policy.conditionCount)),
          h('span', { class: 'text-xs text-muted-foreground' }, OBJECT_TYPE_LABEL[policy.objectType] ?? '—'),
        ])
      },
    },
    {
      id: 'notificationTemplates',
      header: '通知模板',
      size: 130,
      enableSorting: false,
      cell: ({ row }) => {
        // §0.6 R-JSON-2：notificationTemplateIds 永远是数组，不需要判空
        const ids = row.original.notificationTemplateIds
        if (!ids.length)
          return h('span', { class: 'text-sm text-muted-foreground' }, '未绑定')
        return h('span', { class: 'text-sm' }, `${ids.length} 个`)
      },
    },
    {
      accessorKey: 'level',
      header: '等级',
      size: 100,
      enableSorting: false,
      cell: ({ row }) => h(AlarmLevelBadge, { level: row.original.level }),
    },
    {
      accessorKey: 'status',
      header: '状态',
      size: 110,
      enableSorting: false,
      cell: ({ row }) => {
        const policy = row.original
        const enabled = policy.status === ALARM_POLICY_STATUS.ENABLED
        return h('div', { class: 'flex items-center gap-2' }, [
          h(Switch, {
            'modelValue': enabled,
            'disabled': handlers.pendingId() === policy.id,
            'ariaLabel': `${policy.name} 启停开关`,
            'onUpdate:modelValue': (value: boolean) =>
              handlers.onToggleStatus(
                policy,
                value ? ALARM_POLICY_STATUS.ENABLED : ALARM_POLICY_STATUS.DISABLED,
              ),
          }),
          h('span', { class: 'text-sm text-muted-foreground' }, enabled ? '启用' : '停用'),
        ])
      },
    },
    {
      accessorKey: 'updatedAt',
      header: '更新时间',
      size: 170,
      enableSorting: false,
      cell: ({ row }) => h('span', { class: 'text-sm text-muted-foreground' }, row.original.updatedAt),
    },
    {
      id: 'actions',
      header: '操作',
      size: 90,
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) =>
        h(PolicyRowActions, {
          policy: row.original,
          disabled: handlers.pendingId() === row.original.id,
          onView: handlers.onView,
          onEdit: handlers.onEdit,
          onCopy: handlers.onCopy,
          onHistory: handlers.onHistory,
          onDelete: handlers.onDelete,
        }),
    },
  ]
}
