/**
 * 列表刷新通道 —— 把「行操作成功后要刷新列表」这个信号从表格单元格传给页面。
 *
 * ## 为什么不用事件
 * `columns.ts` 是**静态列定义数组**（与同模块的 `notification-template` 保持一致），
 * 行操作组件通过 `h()` 渲染在单元格里，而 `DataTable` 本身**没有** `changed` 事件——
 * 挂在 `<DataTable @changed>` 上不会触发任何东西。
 * 用 `provide` / `inject` 则可以在不把回调塞进列定义的前提下，
 * 让任意深度的行操作组件拿到页面的刷新函数。
 *
 * 表格单元格渲染出来的组件，其组件实例父链依然经过页面组件，
 * 所以 `inject` 能正确向上找到页面 `provide` 的值。
 */
import type { InjectionKey } from 'vue'

/** 通知「列表需要重新取数」。 */
export type AlarmRefreshHandler = () => void

const ALARM_REFRESH_KEY: InjectionKey<AlarmRefreshHandler> = Symbol('alarm-list-refresh')

/** 页面侧：把刷新函数发给所有后代。 */
export function provideAlarmRefresh(handler: AlarmRefreshHandler) {
  provide(ALARM_REFRESH_KEY, handler)
}

/**
 * 行操作侧：拿到刷新函数。
 *
 * 找不到提供者时返回 `noop` 而不是抛异常——组件被单独拿去做单测时
 * 不应该因为缺少祖先 provider 而崩掉。
 */
export function useAlarmRefresh(): AlarmRefreshHandler {
  return inject(ALARM_REFRESH_KEY, () => {})
}
