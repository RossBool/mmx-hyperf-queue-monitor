/**
 * ofetch: https://github.com/unjs/ofetch
 */
import { ofetch } from 'ofetch'
import { toast } from 'vue-sonner'

import { API_BASE_URL, API_TIMEOUT, USE_MOCK } from '@/constants/app-config'

/**
 * Clear the session and send the user back to sign-in when the API returns 401.
 * Imports are lazy to avoid a cycle (router -> pages -> services -> api-client).
 */
async function handleUnauthorized() {
  const [{ default: router }, { useAuthStore }, { default: pinia }] = await Promise.all([
    import('@/router'),
    import('@/stores/auth'),
    import('@/plugins/pinia/setup'),
  ])

  const authStore = useAuthStore(pinia)
  if (!authStore.isLogin)
    return

  authStore.isLogin = false
  toast.error('Your session has expired, please sign in again.')
  await router.push({ path: '/auth/sign-in' })
}

const httpClient = ofetch.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT ?? 5000,

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
