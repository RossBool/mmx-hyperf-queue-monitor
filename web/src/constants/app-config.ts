import { env } from '@/utils/env'

export const API_BASE_URL = `${env.VITE_SERVER_API_URL}${env.VITE_SERVER_API_PREFIX ?? '/api'}` as const
export const API_TIMEOUT = env.VITE_SERVER_API_TIMEOUT

/**
 * Mock 开关（来自 `.env` 的 `VITE_USE_MOCK`）。
 *
 * 为 `true` 时 `apiFetch` 走 `src/mocks/` 里的本地处理器，不发真实 HTTP 请求。
 * 后端 Hyperf 未就绪时，把 `.env` 里改成 `VITE_USE_MOCK=true` 即可让前端跑通。
 */
export const USE_MOCK = env.VITE_USE_MOCK
