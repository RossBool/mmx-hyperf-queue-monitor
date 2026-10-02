import { BellRingIcon, HistoryIcon, MailIcon, SirenIcon } from '@lucide/vue'

import type { NavGroup } from '@/components/app-sidebar/types'

/**
 * 告警管理模块（alarm）的路由入口。
 *
 * 路由由 `vue-router/unplugin` 从 `src/pages/**` 自动生成，本文件**只负责侧边菜单的展示配置**，
 * 两者必须一一对应：新增/删除页面时请同步维护这里的入口。
 *
 * 目录约定（见 deliverable.md「告警模块分工」）：
 * - `src/pages/alarm/policy/**`               → 告警策略（列表 / 新建 / 编辑 / 详情）
 * - `src/pages/alarm/notification-template/**` → 通知模板
 * - `src/pages/alarm/history/**`              → 告警历史
 * - `src/pages/alarm/components/**`           → 告警模块公共组件（不生成路由）
 */
export const ALARM_NAV_PATHS = {
  policy: '/alarm/policy',
  notificationTemplate: '/alarm/notification-template',
  history: '/alarm/history',
} as const

/**
 * 告警管理一级菜单。当前三个子项先指向占位页，
 * 由后续并行任务填充 `src/pages/alarm/{policy,notification-template,history}/**` 的实现。
 *
 * @see src/config/alarm-nav.ts
 */
export const alarmNavGroup: NavGroup = {
  title: 'Monitor',
  items: [
    {
      title: '告警管理',
      icon: SirenIcon,
      items: [
        { title: '告警策略', url: ALARM_NAV_PATHS.policy, icon: BellRingIcon },
        { title: '通知模板', url: ALARM_NAV_PATHS.notificationTemplate, icon: MailIcon },
        { title: '告警历史', url: ALARM_NAV_PATHS.history, icon: HistoryIcon },
      ],
    },
  ],
}
