import { describe, expect, it } from 'vitest'

import { handleMockRequest } from '../index'

/**
 * Mock 层测试：验证「`VITE_USE_MOCK=true` 时返回的结构与 contract.md §0.2 信封一致」。
 *
 * 这层是给联调任务的地基——mock 一旦和契约漂移，前端就会在「能跑」的假象下
 * 埋下和后端对不上的数据结构，所以这里断言信封形状与关键字段。
 */
describe('mock response envelope', () => {
  it('returns a contract-shaped envelope for the policy list', async () => {
    const res = await handleMockRequest('/alarm/policies', { method: 'get' })

    expect(res).toMatchObject({ extra: {}, code: 0, message: 'success', success: true })
    // 列表接口 data 恒为分页对象，不是裸数组
    expect(Array.isArray(res.data)).toBe(false)
    expect(res.data).toHaveProperty('list')
    expect(res.data).toHaveProperty('total')
    expect(res.data).toHaveProperty('page')
    expect(res.data).toHaveProperty('pageSize')
  })

  it('returns a 404 envelope (not a throw) for unregistered endpoints', async () => {
    const res = await handleMockRequest('/alarm/not-a-real-endpoint', { method: 'get' })

    // 业务失败时 data 固定为 null
    expect(res).toMatchObject({ data: null, code: 404, success: false })
  })

  it('resolves path params for the policy detail endpoint', async () => {
    const hit = await handleMockRequest('/alarm/policies/1001', { method: 'get' })
    expect(hit.success).toBe(true)
    expect(hit.data).toMatchObject({ id: 1001, objectGroupIds: null, objectFilters: null })

    const miss = await handleMockRequest('/alarm/policies/9999', { method: 'get' })
    expect(miss).toMatchObject({ data: null, code: 404, success: false })
  })

  it('honours the 409 semantics for deleting an enabled policy', async () => {
    const res = await handleMockRequest('/alarm/policies/1001', { method: 'delete' })

    expect(res).toMatchObject({ data: null, code: 409, success: false })
  })

  it('returns `true` as data for preset-protected delete on a custom template', async () => {
    const preset = await handleMockRequest('/alarm/notification-templates/5', { method: 'delete' })
    expect(preset).toMatchObject({ data: null, code: 409, success: false })

    const custom = await handleMockRequest('/alarm/notification-templates/3', { method: 'delete' })
    expect(custom).toMatchObject({ data: true, code: 0, success: true })
  })

  it('rejects handling an already-handled history with 409', async () => {
    const res = await handleMockRequest('/alarm/histories/9999/handle', {
      method: 'post',
      body: { action: 'handle' },
    })

    expect(res).toMatchObject({ data: null, code: 404, success: false })
  })

  it('parses query strings off the request path', async () => {
    const res = await handleMockRequest('/alarm/policies?keyword=CPU&status=1&page=1', { method: 'get' })
    expect(res.success).toBe(true)
  })
})
