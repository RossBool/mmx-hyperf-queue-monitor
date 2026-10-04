/**
 * ofetch: https://github.com/unjs/ofetch
 */
import { ofetch } from 'ofetch'
import { toast } from 'vue-sonner'

import { API_BASE_URL, API_TIMEOUT, API_TOKEN, USE_MOCK } from '@/constants/app-config'

/**
 * Clear the session and send the user back to sign-in when the API returns 401.
 * Imports are lazy to avoid a cycle (router -> pages -> services -> api-client).
 *
 * ⚠️ 下面三个分支的顺序都是踩过坑之后定下来的（复核 D-1），改之前先读：
 *
 * 1. `isLogin` 默认 false，告警页也没有 `meta.auth` —— 用户带着 false 就进了
 *    /alarm/policy。**默认态下 401 曾经被第一行 `if (!isLogin) return` 吞掉**：
 *    无 toast、无跳转、无日志，页面照常渲染只是全空。
 *    那正好是 S-10 声称要避免的「静默」—— 机制层（不发空 token）做到了，
 *    最外层却把证据销毁了。
 *
 * 2. 但把 toast 挪到守卫之前**不算修完**：原来 `isLogin` 兼职当了去重器 ——
 *    第一个 401 把它置 false，后续并发的 401 被早退挡住，所以并发只弹一次。
 *    守卫一旦移走，并发 401 就会弹一串（这个回归真的发生过，是既有测试抓到的）。
 *    因此去重改由 `unauthorizedNotified` 独立承担，语义是「每个登录会话提示一次」。
 *
 * 3. 跳转仍留在守卫**之后**：登录页自己 401 时不能自我重定向成环。
 */
let unauthorizedNotified = false

async function handleUnauthorized() {
  const [{ default: router }, { useAuthStore }, { default: pinia }] = await Promise.all([
    import('@/router'),
    import('@/stores/auth'),
    import('@/plugins/pinia/setup'),
  ])

  const authStore = useAuthStore(pinia)

  // 新的登录会话（isLogin 重新为 true）→ 重置「已提示」标记
  if (authStore.isLogin)
    unauthorizedNotified = false

  if (!unauthorizedNotified) {
    unauthorizedNotified = true
    toast.error('Your session has expired, please sign in again.')
  }

  if (!authStore.isLogin)
    return

  authStore.isLogin = false
  await router.push({ path: '/auth/sign-in' })
}

const httpClient = ofetch.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT ?? 5000,

  /**
   * 契约 §0.1：`Authorization: Bearer <token>`。
   *
   * 后端 `AuthMiddleware` 已改为 fail-closed —— `ALARM_STATIC_TOKENS` 未配置时
   * 拒绝所有请求，因此这个头不是可选的。未配置 `VITE_SERVER_API_TOKEN` 时不发该头，
   * 真实后端会返回 401（属预期：配置缺失应当被看见，而不是被静默吞掉）。
   */
  onRequest({ options }) {
    if (!API_TOKEN)
      return
    // ofetch 的 options.headers 类型是 Headers 实例而非普通对象，
    // 直接展开字面量会过不了类型检查；用标准 Headers API 追加。
    const headers = new Headers(options.headers as HeadersInit | undefined)
    headers.set('Authorization', `Bearer ${API_TOKEN}`)
    options.headers = headers
  },

  onResponseError: async ({ response }) => {
    if (response.status === 401)
      await handleUnauthorized()
  },
})

/**
 * 统一请求入口。
 *
 * `VITE_USE_MOCK=true` 时（见 `.env` / `src/constants/app-config.ts`）不发真实 HTTP 请求，
 * 改走 `src/mocks/` 的本地处理器，返回与 contract.md §0.2 一致的信封；
 * 后端 Hyperf 未就绪时用它让前端先跑通联调。
 *
 * 类型保持与 `ofetch` 实例完全一致，调用方无需感知 mock 开关。
 */
export const apiFetch = ((request, options) => {
  if (USE_MOCK) {
    return import('@/mocks').then(({ handleMockRequest }) =>
      handleMockRequest(String(request), { method: options?.method, body: options?.body }),
    )
  }
  return httpClient(request, options)
}) as typeof httpClient
