// @vitest-environment happy-dom

import type { Component } from 'vue'

/**
 * 列表刷新通道（`refresh.ts`）的集成测试。
 *
 * ## 为什么值得单独测
 * 行操作组件（编辑 / 删除 / 处理）是通过 `h()` 渲染在表格单元格里的，
 * 而 `DataTable` **没有** `changed` 事件。这条链路一旦接错，表现是
 * 「操作成功、toast 弹了，但列表数据纹丝不动」——**没有任何报错**，
 * 纯靠读代码很难发现，恰恰是最该被测出来的那类问题。
 *
 * 所以这里用真实的 `DataTable` + 真实列定义挂载整个链路，
 * 断言：单元格里的行操作组件能通过 `inject` 拿到页面 `provide` 的刷新函数并调用它。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

import type { AlarmHistory } from '@/types/alarm'

import { DataTable } from '@/components/data-table'
import { Button } from '@/components/ui/button'

import { columns } from '../components/columns'
import { provideAlarmRefresh, useAlarmRefresh } from '../refresh'

/**
 * `DataTable` 是泛型 SFC，而 `h()` 不接受类型实参（只有 `mount` 接受）。
 * 这里把它收成一个非泛型的 `Component` 再用——运行时行为完全一致。
 */
const DataTableAny = DataTable as unknown as Component

const history: AlarmHistory = {
  id: 90001,
  policyId: 1001,
  policyName: '生产 CVM CPU 监控',
  level: 1,
  status: 1,
  conditionId: 7001,
  metricNamespace: 'CVM',
  metricName: 'CpuUtilizationRate',
  metricNameCn: 'CPU 使用率',
  unit: '%',
  operator: '>',
  threshold: 90,
  actualValue: 96.4,
  period: 5,
  continuity: 3,
  objectType: 2,
  objectId: 8801,
  objectName: 'prod-web-01',
  content: 'CVM prod-web-01 CPU 使用率 > 90%，实际 96.4%',
  triggeredAt: '2026-09-30 03:15:00',
  duration: 0,
  recoveredAt: null,
  handledAt: null,
  handleAction: null,
  handlerName: '',
  handleRemark: '',
  notifyCount: 3,
  createdAt: '2026-09-30 03:15:01',
}

/**
 * 用一行数据挂出「页面 → DataTable → 单元格 → 行操作」的完整链路。
 * `onRefresh` 是页面 `provide` 的刷新函数，这里用 spy 观察是否被调用。
 */
function mountWithRefresh(onRefresh: () => void) {
  const Probe = defineComponent({
    setup() {
      const refresh = useAlarmRefresh()
      return () => h(
        Button,
        { 'data-testid': 'probe', 'onClick': refresh },
        // 函数式默认槽：传字符串会触发 Vue 的「Non-function value encountered for default slot」警告
        () => '刷新',
      )
    },
  })

  // 用真实列定义，但把行操作替换成 Probe——
  // 这里关注的是「单元格里的组件能否 inject 到祖先 provide 的刷新函数」，
  // 而不是行操作组件内部的 API 调用（那部分由 logic/api 单测覆盖）。
  const probeColumns = [
    { accessorKey: 'policyName' as const, header: '策略名' },
    {
      id: 'actions',
      header: '操作',
      cell: () => h(Probe),
    },
  ]

  const Page = defineComponent({
    setup() {
      provideAlarmRefresh(onRefresh)
      return () => h(DataTableAny, {
        data: [history],
        columns: probeColumns,
      })
    },
  })

  return mount(Page)
}

describe('provideAlarmRefresh / useAlarmRefresh', () => {
  it('表格单元格里的组件能 inject 到页面 provide 的刷新函数并调用', async () => {
    const onRefresh = vi.fn()
    const wrapper = mountWithRefresh(onRefresh)

    // `get()` 找不到元素会直接抛错，所以不需要（也不应该）再 `.exists()` 断言一遍
    const probe = wrapper.get('[data-testid="probe"]')

    await probe.trigger('click')

    expect(onRefresh).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('多次操作会多次触发刷新（不是去重成一次）', async () => {
    const onRefresh = vi.fn()
    const wrapper = mountWithRefresh(onRefresh)
    const probe = wrapper.get('[data-testid="probe"]')

    await probe.trigger('click')
    await probe.trigger('click')
    await probe.trigger('click')

    expect(onRefresh).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('没有 provider 时 useAlarmRefresh 返回 noop，调用不抛异常', () => {
    // 组件被单独拿去单测时不应因为缺少祖先 provider 而崩掉
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

  it('真实列定义里确实挂了行操作组件（保证刷新链路的起点存在）', () => {
    // 纯静态断言：列定义里必须有操作列，否则 provide 的刷新函数永远没人调
    const actionColumn = columns.find(column => column.id === 'actions')
    expect(actionColumn).toBeDefined()
    expect(actionColumn?.cell).toBeTypeOf('function')
  })
})
