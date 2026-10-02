// @vitest-environment happy-dom

import type { Component } from 'vue'

/**
 * 列表刷新通道（`refresh.ts`）的集成测试。
 *
 * ## 为什么值得单独测
 * 通知模板的**编辑 / 删除**在行操作组件里发请求，成功后需要让列表重新取数。
 * 但行操作组件是通过 `h()` 渲染在表格单元格里的，而 `DataTable` **没有** `changed` 事件
 * —— 半成品里 `emit('changed')` 就是打到空气里，操作完列表纹丝不动。
 * 这个 bug **不产生任何报错**，纯靠读代码很容易漏掉，所以必须用测试钉住。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import type { AlarmNotificationTemplate } from '@/types/alarm'

import { DataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'
import { ALARM_PRESET_FLAG } from '@/types/alarm'

import { columns } from '../components/columns'
import { provideAlarmRefresh, useAlarmRefresh } from '../refresh'

/**
 * `DataTable` 是泛型 SFC，而 `h()` 不接受类型实参（只有 `mount` 接受）。
 * 这里把它收成一个非泛型的 `Component` 再用——运行时行为完全一致。
 */
const DataTableAny = DataTable as unknown as Component

const template: AlarmNotificationTemplate = {
  id: 5,
  name: '系统预置-邮件通知',
  remark: '',
  channels: [
    // N9：`channel≠5` 且 receivers 为空 → 未配置完成，列表会给出「接收人未配置」提示
    { channel: 1, receivers: [], callbackUrl: null, silenceTime: 0 },
  ],
  isPreset: ALARM_PRESET_FLAG.PRESET,
  creatorName: 'system',
  createdAt: '2026-09-01 09:00:00',
  updatedAt: '2026-09-01 09:00:00',
}

function mountWithRefresh(onRefresh: () => void) {
  const Probe = defineComponent({
    setup() {
      const refresh = useAlarmRefresh()
      return () => h(
        Button,
        { 'data-testid': 'probe', 'onClick': refresh },
        () => '刷新',
      )
    },
  })

  const probeColumns = [
    { accessorKey: 'name' as const, header: '模板名称' },
    { id: 'actions', header: '操作', cell: () => h(Probe) },
  ]

  const Page = defineComponent({
    setup() {
      provideAlarmRefresh(onRefresh)
      return () => h(DataTableAny, {
        data: [template],
        columns: probeColumns,
      })
    },
  })

  return mount(Page)
}

describe('通知模板列表刷新通道', () => {
  it('行操作组件能通过 inject 拿到页面 provide 的刷新函数并调用', async () => {
    const onRefresh = vi.fn()
    const wrapper = mountWithRefresh(onRefresh)

    await wrapper.get('[data-testid="probe"]').trigger('click')

    expect(onRefresh).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('没有 provider 时返回 noop，调用不抛异常', () => {
    const Orphan = defineComponent({
      setup() {
        const refresh = useAlarmRefresh()
        expect(() => refresh()).not.toThrow()
        return () => h('div')
      },
    })

    const wrapper = mount(Orphan)
    expect(wrapper.html()).toBe('<div></div>')
    wrapper.unmount()
  })

  it('真实列定义里有操作列（刷新链路的起点必须存在）', () => {
    expect(columns.find(column => column.id === 'actions')?.cell).toBeTypeOf('function')
  })
})
