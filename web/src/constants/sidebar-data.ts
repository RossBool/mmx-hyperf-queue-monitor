import { BadgeHelpIcon, BellDotIcon, BirdIcon, BugIcon, LayoutDashboardIcon, ListTodoIcon, PaletteIcon, PictureInPicture2Icon, SettingsIcon, SquareUserRoundIcon, UserIcon, UsersIcon, WrenchIcon } from '@lucide/vue'

import type { NavGroup, NavItem } from '@/components/app-sidebar/types'

import { alarmNavGroup } from '@/config/alarm-nav'

type SidebarLink = Extract<NavItem, { url: string }>

export const settingsNavItems: SidebarLink[] = [
  { title: 'Profile', url: '/settings/', icon: UserIcon },
  { title: 'Account', url: '/settings/account', icon: WrenchIcon },
  { title: 'Appearance', url: '/settings/appearance', icon: PaletteIcon },
  { title: 'Notifications', url: '/settings/notifications', icon: BellDotIcon },
  { title: 'Display', url: '/settings/display', icon: PictureInPicture2Icon },
]

export const navData: NavGroup[] = [
  {
    title: 'General',
    items: [
      { title: 'Dashboard', url: '/dashboard', icon: LayoutDashboardIcon },
      { title: 'Tasks', url: '/tasks', icon: ListTodoIcon },
      { title: 'Users', url: '/users', icon: UsersIcon },
    ],
  },
  // 告警管理：菜单定义见 src/config/alarm-nav.ts，页面由后续任务填充
  alarmNavGroup,
  {
    title: 'Pages',
    items: [
      {
        title: 'Auth',
        icon: SquareUserRoundIcon,
        items: [
          { title: 'Sign In', url: '/auth/sign-in' },
          { title: 'Sign In(2 Col)', url: '/auth/sign-in-2' },
          { title: 'Sign Up', url: '/auth/sign-up' },
          { title: 'Forgot Password', url: '/auth/forgot-password' },
          { title: 'OTP', url: '/auth/otp' },
        ],
      },
      {
        title: 'Errors',
        icon: BugIcon,
        items: [
          { title: '401 | Unauthorized', url: '/errors/401' },
          { title: '403 | Forbidden', url: '/errors/403' },
          { title: '404 | Not Found', url: '/errors/404' },
          { title: '500 | Internal Server Error', url: '/errors/500' },
          { title: '503 | Maintenance Error', url: '/errors/503' },
        ],
      },
    ],
  },
  {
    title: 'Other',
    items: [
      { title: 'Settings', items: settingsNavItems, icon: SettingsIcon },
      { title: 'Help Center', url: '/help-center', icon: BadgeHelpIcon },
      { title: 'Outside Page(GitHub)', url: 'https://www.github.com/Whbbit1999/shadcn-vue-admin', icon: BirdIcon },
    ],
  },
]
