import { env } from '@/utils/env'

export const API_BASE_URL = `${env.VITE_SERVER_API_URL}${env.VITE_SERVER_API_PREFIX ?? '/api'}` as const
export const API_TIMEOUT = env.VITE_SERVER_API_TIMEOUT

/**
 * Bearer token —— 契约 §0.1 的 `Authorization: Bearer <token>`。
 *
 * 后端 `AuthMiddleware` 是 fail-closed 的：`ALARM_STATIC_TOKENS` 未配置时拒绝所有请求，
 * 因此这里留空连真实后端会一律 401。该值必须与后端白名单里的某个 token 一致。
 *
 * 接入真实登录态后应改为运行时读取（当前为 env 占位，与后端同为契约 §0.1 的占位实现）。
 */
export const API_TOKEN = env.VITE_SERVER_API_TOKEN

/**
 * Mock 开关（来自 `.env` 的 `VITE_USE_MOCK`）。
 *
 * 为 `true` 时 `apiFetch` 走 `src/mocks/` 里的本地处理器，不发真实 HTTP 请求。
 * 后端 Hyperf 未就绪时，把 `.env` 里改成 `VITE_USE_MOCK=true` 即可让前端跑通。
 */
export const USE_MOCK = env.VITE_USE_MOCK
