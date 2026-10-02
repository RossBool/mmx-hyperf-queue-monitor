/**
 * 告警历史列表 —— 表格列定义（契约 §2.6 `AlarmHistory`）。
 *
 * 字段全部来自契约，**不新增列**：
 * `triggeredAt` / `policyName` / `objectName` / `metricNameCn` / `actualValue` /
 * `threshold` / `level` / `status` / `duration`。
 *
 * 排序：契约 ⑰ 固定 `triggered_at DESC, id DESC`，**不开放排序参数**，
 * 所以每一列都 `enableSorting: false`——给用户一个能点、但点了不生效的表头是欺骗。
 */
import { h } from 'vue'

import type { DataTableColumnDef } from '@/components/data-table'
import type { AlarmHistory } from '@/types/alarm'

import { DataTableColumnHeader } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { AlarmLevelBadge } from '@/pages/alarm/components'

import { formatDuration, formatMetricValue, HISTORY_STATUS_VARIANT, historyStatusLabel } from '../logic'
import HistoryRowActions from './history-row-actions.vue'

/** 指标列：`metricNameCn(operator) threshold` + 实测值，契约里 unit 由服务端回填。 */
function renderMetricCell(history: AlarmHistory) {
  return h('div', { class: 'flex flex-col gap-0.5' }, [
    h('span', { class: 'font-medium' }, history.metricNameCn || history.metricName || '—'),
    h('span', { class: 'text-xs text-muted-foreground' }, `${history.operator ?? ''} ${formatMetricValue(history.threshold, history.unit)}`),
  ])
}

export const columns: DataTableColumnDef<AlarmHistory>[] = [
  {
    accessorKey: 'triggeredAt',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '告警时间' }),
    cell: ({ row }) => h(
      'div',
      { class: 'flex flex-col gap-0.5 whitespace-nowrap' },
      [
        h('span', row.original.triggeredAt),
        // `content` 是服务端生成的告警摘要（契约 §2.6），鼠标悬停看全文
        h('span', { class: 'max-w-[320px] truncate text-xs text-muted-foreground', title: row.original.content || undefined }, row.original.content || ''),
      ],
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'policyName',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '策略名' }),
    cell: ({ row }) => h(
      'div',
      { class: 'max-w-[200px] truncate', title: row.original.policyName || undefined },
      row.original.policyName || '—',
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'objectName',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '告警对象' }),
    // `objectId=0` 表示「全部对象」场景，没有具体实例
    cell: ({ row }) => h(
      'div',
      { class: 'max-w-[200px] truncate', title: row.original.objectName || undefined },
      row.original.objectName || '（全部对象）',
    ),
    enableSorting: false,
  },
  {
    id: 'metric',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '指标' }),
    cell: ({ row }) => renderMetricCell(row.original),
    enableSorting: false,
  },
  {
    accessorKey: 'actualValue',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '触发值' }),
    // ⚠️ `actualValue` 契约允许为 `null`（恢复类事件无实测值），`formatMetricValue` 兜底成「—」
    cell: ({ row }) => h('span', { class: 'font-medium tabular-nums' }, formatMetricValue(row.original.actualValue, row.original.unit)),
    enableSorting: false,
  },
  {
    accessorKey: 'threshold',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '阈值' }),
    cell: ({ row }) => h('span', { class: 'tabular-nums' }, formatMetricValue(row.original.threshold, row.original.unit)),
    enableSorting: false,
  },
  {
    accessorKey: 'level',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '等级' }),
    cell: ({ row }) => h(AlarmLevelBadge, { level: row.original.level }),
    enableSorting: false,
  },
  {
    accessorKey: 'status',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '状态' }),
    // `HISTORY_STATUS_VARIANT` 覆盖全部 4 个枚举（logic.ts 有「遍历全枚举」的测试兜底），
    // 未知值也会走 `historyStatusLabel` 的中文兜底，不会渲染出 undefined
    cell: ({ row }) => h(Badge, { variant: HISTORY_STATUS_VARIANT[row.original.status] ?? 'outline' }, () => historyStatusLabel(row.original.status)),
    enableSorting: false,
  },
  {
    accessorKey: 'duration',
    header: ({ column }) => h(DataTableColumnHeader<AlarmHistory>, { column, title: '持续时长' }),
    // `duration=0` 表示未恢复，`formatDuration` 显示「—」
    cell: ({ row }) => h('span', { class: 'whitespace-nowrap tabular-nums' }, formatDuration(row.original.duration)),
    enableSorting: false,
  },
  {
    id: 'actions',
    header: () => h('div', { class: 'text-right' }, '操作'),
    cell: ({ row }) => h(HistoryRowActions, { history: row.original }),
    enableSorting: false,
    enableHiding: false,
  },
]
