/**
 * 通知模板列表 —— 表格列定义（契约 §2.5 `AlarmNotificationTemplate`）。
 *
 * 字段全部来自契约，**不新增列**。列表接口返回**完整 `channels`**（含接收人），
 * 与策略详情页的 `int[]` 编码数组不同，这里按对象数组处理。
 */
import { h } from 'vue'

import type { DataTableColumnDef } from '@/components/data-table'
import type { AlarmNotificationTemplate } from '@/types/alarm'

import { DataTableColumnHeader } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
import { ALARM_NOTIFY_CHANNEL_LABEL, ALARM_PRESET_FLAG } from '@/types/alarm'

import { buildTemplateRowMeta } from '../logic'
import NotificationTemplateRowActions from './notification-template-row-actions.vue'

export const columns: DataTableColumnDef<AlarmNotificationTemplate>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => h(DataTableColumnHeader<AlarmNotificationTemplate>, { column, title: '模板名称' }),
    cell: ({ row }) => h('div', { class: 'flex flex-col gap-1' }, [
      h('div', { class: 'font-medium' }, row.original.name),
      row.original.isPreset === ALARM_PRESET_FLAG.PRESET
        ? h(Badge, { variant: 'outline', class: 'w-fit' }, () => '系统预置')
        : null,
    ]),
    enableSorting: false,
  },
  {
    accessorKey: 'channels',
    header: ({ column }) => h(DataTableColumnHeader<AlarmNotificationTemplate>, { column, title: '接收渠道' }),
    cell: ({ row }) => {
      const { channelValues } = buildTemplateRowMeta(row.original)

      if (channelValues.length === 0)
        return h('span', { class: 'text-muted-foreground' }, '—')

      return h(
        'div',
        { class: 'flex flex-wrap gap-1' },
        channelValues.map(channel => h(Badge, { variant: 'secondary', key: channel }, () => ALARM_NOTIFY_CHANNEL_LABEL[channel] ?? `渠道${channel}`)),
      )
    },
    enableSorting: false,
  },
  {
    id: 'receiverCount',
    header: ({ column }) => h(DataTableColumnHeader<AlarmNotificationTemplate>, { column, title: '接收人数' }),
    cell: ({ row }) => {
      const { receiverCount, readiness } = buildTemplateRowMeta(row.original)

      return h('div', { class: 'flex flex-col gap-1' }, [
        h('span', String(receiverCount)),
        // N9：某渠道 channel≠5 且 receivers 为空 → 未配置完成，前端必须给出可见提示
        readiness.ready
          ? null
          : h(Badge, { variant: 'destructive', class: 'w-fit' }, () => '接收人未配置'),
      ])
    },
    enableSorting: false,
  },
  {
    accessorKey: 'remark',
    header: ({ column }) => h(DataTableColumnHeader<AlarmNotificationTemplate>, { column, title: '备注' }),
    cell: ({ row }) => h(
      'div',
      { class: 'max-w-[280px] truncate text-muted-foreground', title: row.original.remark || undefined },
      row.original.remark || '—',
    ),
    enableSorting: false,
  },
  {
    accessorKey: 'updatedAt',
    header: ({ column }) => h(DataTableColumnHeader<AlarmNotificationTemplate>, { column, title: '更新时间' }),
    cell: ({ row }) => h('div', { class: 'whitespace-nowrap' }, row.original.updatedAt),
    enableSorting: false,
  },
  {
    id: 'actions',
    header: () => h('div', { class: 'text-right' }, '操作'),
    cell: ({ row }) => h(NotificationTemplateRowActions, { template: row.original }),
    enableSorting: false,
    enableHiding: false,
  },
]
