/**
 * Mock 入口 —— 注册所有 mock 路由，并导出 `handleMockRequest` 给 `apiFetch` 用。
 *
 * 开关在 `.env` 的 `VITE_USE_MOCK`（默认 `false`）。
 * 打开后 `apiFetch('/alarm/policies')` 不会再发 HTTP，而是直接返回下面的契约示例数据。
 *
 * @see ./router.mock.ts —— 路由注册与分发
 * @see ./response.mock.ts —— 统一响应信封工厂（必须与 contract.md §0.2 一致）
 * @see ./alarm.mock.ts —— 告警模块示例数据（照抄 contract.md）
 */
import { alarmMetricsMock } from '@/mocks/alarm-metrics.generated'
import { ALARM_ERROR_CODE } from '@/types/alarm'

import { historyListMock, notificationTemplateListMock, overviewMock, policyDetailMock, policyListMock } from './alarm.mock'
import { conflict, notFound, ok, okTrue, page } from './response.mock'
import { handleMockRequest, registerMock } from './router.mock'

/**
 * 注册告警模块的读接口 mock（契约 ①②⑧⑬⑰⑲）。
 *
 * 写接口（③④⑤⑥⑦⑩⑪⑫⑭⑮⑯⑱）**故意不注册**：
 * 它们需要真实的写入语义（唯一性校验、启停冲突、模板引用检查等），
 * 留给联调任务按后端真实行为补，避免 mock 给出与后端不一致的假象。
 */
function registerAlarmMocks() {
  // ① GET /api/alarm/policies —— 策略分页列表
  registerMock('get', '/alarm/policies', () => page(policyListMock))

  // ② GET /api/alarm/policies/:id —— 策略详情
  registerMock('get', '/alarm/policies/:id', ({ params }) => {
    if (params.id !== String(policyDetailMock.id))
      return notFound()
    return ok(policyDetailMock)
  })

  // ⑧ GET /api/alarm/metrics —— 指标字典，**完整 38 条**。
  //
  // 数据由 scripts/gen-mock-metrics.mjs 从 server/config/autoload/metrics.php 生成，
  // 不再手写。此前这里只有 1 条硬编码，注释还写着「不要把这份数据当字典用」——
  // 后果是 mock 模式下指标下拉只有 1 项，且与真实字典的差异**不会有任何报错**。
  //
  // ⚠️ `/metrics` 的查询参数（policyType / namespace / keyword）在 mock 里**仍然不生效**
  //    —— 这是 mock-router 的已知限制（query 被丢弃），不是本次改动引入的。
  //    要验证筛选正确性必须连真实后端。
  registerMock('get', '/alarm/metrics', () => ok(alarmMetricsMock))

  // ⑬ GET /api/alarm/notification-templates —— 通知模板分页（返回完整 channels）
  registerMock('get', '/alarm/notification-templates', () => page(notificationTemplateListMock))

  // ⑰ GET /api/alarm/histories —— 告警历史分页
  registerMock('get', '/alarm/histories', () => page(historyListMock))

  // ⑲ GET /api/alarm/overview —— 首页统计
  registerMock('get', '/alarm/overview', () => ok(overviewMock))

  // ⑤ DELETE /api/alarm/policies/:id —— 演示「启用中的策略不可删除」的 409 语义
  registerMock('delete', '/alarm/policies/:id', ({ params }) => {
    if (params.id === String(policyDetailMock.id)) {
      // 契约 P15：仅 status=0（停用）的策略可删除，示例策略 status=1，故必然 409
      return conflict('已启用的策略不可删除，请先停用')
    }
    return notFound()
  })

  // ⑯ DELETE /api/alarm/notification-templates/:id —— 演示「预置模板不可删除」
  registerMock('delete', '/alarm/notification-templates/:id', ({ params }) => {
    const preset = notificationTemplateListMock.find(t => String(t.id) === params.id)?.isPreset === 1
    if (preset)
      return conflict('预置模板不可删除')
    return okTrue()
  })

  // ⑱ POST /api/alarm/histories/:id/handle —— 演示 H3「非未处理不可重复处理」
  registerMock('post', '/alarm/histories/:id/handle', ({ params, body }) => {
    const history = historyListMock.find(h => String(h.id) === params.id)
    if (!history)
      return notFound()
    if (history.status !== 1)
      return conflict('该告警已处理，不可重复处理')
    if (!body?.action) {
      return {
        data: null,
        extra: { errors: [{ field: 'action', message: '处理动作必须是 handle / ignore / recover 之一' }] },
        code: ALARM_ERROR_CODE.VALIDATION_ERROR,
        message: '参数校验失败',
        success: false,
      }
    }
    return ok({ ...history })
  })
}

registerAlarmMocks()

export { handleMockRequest }
export * from './response.mock'
export * from './router.mock'
