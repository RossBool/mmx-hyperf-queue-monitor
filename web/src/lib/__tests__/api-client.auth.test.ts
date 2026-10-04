// @vitest-environment happy-dom
/**
 * 契约 §0.1「`Authorization: Bearer <token>`」的回归测试。
 *
 * ## 为什么需要它
 *
 * 后端 `AuthMiddleware` 原先是 **fail-open**：`ALARM_STATIC_TOKENS` 没配就 `return true`，
 * 任何 Bearer token 都能通过。改成 fail-closed 后（白名单未配置 → 拒绝所有请求），
 * 前端如果继续不发这个头，**连真实后端的每一次调用都会 401**。
 *
 * 而前端此前**根本没有**发送 `Authorization` —— 契约要求、模板的假登录 store 也没有 token。
 * 也就是说 S-10 的修复会暴露一个此前被 fail-open 掩盖的集成缺口。
 *
 * 本测试锁住两件事：
 * 1. 配了 token 时，`Authorization: Bearer <token>` 确实出现在请求头上；
 * 2. 没配 token 时**不**发这个头（让 401 暴露出来，而不是静默发一个空 token）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchMock } = vi.hoisted(() => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock }
})

function mockConfig(token: string) {
  vi.doMock('@/constants/app-config', () => ({
    API_BASE_URL: 'https://example.test/api',
    API_TIMEOUT: 5000,
    API_TOKEN: token,
    USE_MOCK: false,
  }))
}

function okResponse() {
  return new Response(JSON.stringify({ code: 0, message: 'success', data: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 取出最后一次 fetch 的请求头，兼容 Request / URL+init 两种调用形态 */
function lastAuthHeader(): string | null {
  const call = fetchMock.mock.calls.at(-1)
  if (!call)
    return null
  const init = call[1] as { headers?: HeadersInit } | undefined
  if (init?.headers instanceof Headers)
    return init.headers.get('authorization')
  if (init?.headers)
    return new Headers(init.headers).get('authorization')
  return null
}

describe('契约 §0.1 Authorization: Bearer <token>', () => {
  beforeEach(() => {
    // `httpClient` 在模块加载时创建一次并捕获当时的 API_TOKEN，
    // 不重置模块缓存的话后续用例拿到的仍是上一个 token 的实例。
    vi.resetModules()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(okResponse())
  })

  it('配置了 VITE_SERVER_API_TOKEN 时应带上 Bearer 头', async () => {
    mockConfig('dev-token-1')
    const { apiFetch } = await import('@/lib/api-client')

    await apiFetch('/alarm/policies', { method: 'GET' })

    expect(lastAuthHeader(), '应发出 Authorization: Bearer dev-token-1').toBe('Bearer dev-token-1')
  })

  it('未配置 token 时不应发送空 Authorization（让后端 401 暴露出来）', async () => {
    mockConfig('')
    const { apiFetch } = await import('@/lib/api-client')

    await apiFetch('/alarm/policies', { method: 'GET' })

    expect(lastAuthHeader(), '未配置 token 时不应发送 Authorization 头').toBeNull()
  })

  it('不应覆盖调用方自己设置的其他请求头', async () => {
    mockConfig('dev-token-2')
    const { apiFetch } = await import('@/lib/api-client')

    await apiFetch('/alarm/policies', {
      method: 'GET',
      headers: { 'X-Request-Id': 'trace-abc' },
    })

    const call = fetchMock.mock.calls.at(-1)
    const init = call?.[1] as { headers?: HeadersInit } | undefined
    const headers = new Headers(init?.headers)
    expect(headers.get('x-request-id'), '调用方的自定义头应保留').toBe('trace-abc')
    expect(headers.get('authorization')).toBe('Bearer dev-token-2')
  })
})
