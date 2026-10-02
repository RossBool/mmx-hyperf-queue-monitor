/**
 * 统一响应信封工厂 —— mock 与真实后端保持完全一致的包络。
 *
 * 契约见 `/workspace/docs/alarm/contract.md` §0.2：
 * `{ data, extra, code, message, success }`，成功 `code=0`，失败 `data` 固定为 `null`。
 */
import type { IResponse } from '@/services/types/response.type'

/** 成功响应：`data` 有值。 */
export function ok<T>(data: T, message = 'success'): IResponse<T> {
  return { data, extra: {}, code: 0, message, success: true }
}

/** 删除类端点的成功响应（`data` 恒为 `true`）。 */
export function okTrue(): IResponse<boolean> {
  return ok(true)
}

/** 业务失败响应。⚠️ `data` 固定为 `null`，**不要**返回 `{}` 或 `[]`。 */
export function fail(code: number, message: string, extra: Record<string, any> = {}): IResponse<null> {
  return { data: null, extra, code, message, success: false }
}

/** 资源不存在（404）。 */
export function notFound(message = '资源不存在'): IResponse<null> {
  return fail(404, message)
}

/**
 * 冲突（409）。
 *
 * `409` 下有 5 个语义分支（已启用策略不可删 / 名称重复 / 模板被引用 / 预置不可删 / 告警已处理），
 * 契约规定前端只需按 `code === 409` 统一提示，靠 `message` 区分文案。
 */
export function conflict(message: string): IResponse<null> {
  return fail(409, message)
}

/** 参数校验失败（422），明细放在 `extra.errors`。 */
export function validationError(errors: { field: string, message: string }[]): IResponse<null> {
  return fail(422, '参数校验失败', { errors })
}

/** 分页响应体（`data` 恒为分页对象，**不返回裸数组**）。 */
export function page<T>(list: T[], pageNo = 1, pageSize = 20): IResponse<{
  list: T[]
  total: number
  page: number
  pageSize: number
}> {
  return ok({ list, total: list.length, page: pageNo, pageSize })
}
