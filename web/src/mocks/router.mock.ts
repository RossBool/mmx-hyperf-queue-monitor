/**
 * Mock 路由注册与分发。
 *
 * 由 `src/constants/app-config.ts` 的 `USE_MOCK`（`.env` 的 `VITE_USE_MOCK`）驱动：
 * 开关打开时 `apiFetch` 不发真实 HTTP 请求，而是走这里注册的处理器，
 * 让前端在后端 Hyperf 未就绪时也能跑通联调。
 *
 * 设计约束：
 * 1. mock **必须返回与 contract.md §0.2 完全一致的信封**，否则联调时会把
 *    「前端能跑」误判成「契约一致」。请用 `./response.mock` 里的 `ok/fail/...` 工厂构造。
 * 2. 路径写**相对 baseURL 的部分**（baseURL 已是 `http://localhost:3000/api`），
 *    即契约里的 `/alarm/policies` 而不是 `/api/alarm/policies`。
 * 3. 路径参数用 `:name` 占位，如 `/alarm/policies/:id/copy`。
 */
import type { IResponse } from '@/services/types/response.type'

import { notFound } from './response.mock'

/** 一次 mock 请求的归一化输入。 */
export interface MockRequest {
  /** 小写 method：`get` / `post` / `put` / `delete` */
  method: string
  /** 去掉 baseURL 与 query string 后的路径，如 `/alarm/policies/1001/copy` */
  path: string
  /** 解析后的 query string */
  query: Record<string, any>
  /** 已解析的请求体（无 body 时为 `undefined`） */
  body: any
  /** 路径参数，如 `{ id: '1001' }` */
  params: Record<string, string>
}

export type MockHandler = (request: MockRequest) => IResponse<any> | Promise<IResponse<any>>

interface MockRoute {
  method: string
  segments: string[]
  handler: MockHandler
}

const routes: MockRoute[] = []

/** 注册一条 mock 路由。重复注册同一 method+path 时后注册的先命中（便于临时覆盖）。 */
export function registerMock(method: string, path: string, handler: MockHandler) {
  routes.unshift({
    method: method.toLowerCase(),
    segments: normalizePath(path),
    handler,
  })
}

/** 清空已注册的 mock 路由（测试用）。 */
export function resetMocks() {
  routes.length = 0
}

function normalizePath(path: string): string[] {
  return path.split('?')[0].split('/').filter(Boolean)
}

/** 把 `http://localhost:3000/api/alarm/policies?page=1` 归一化成 `{ path, query }`。 */
function splitRequest(request: string): { path: string, query: Record<string, any> } {
  const url = new URL(request, 'http://mock.local')
  const query: Record<string, any> = {}
  url.searchParams.forEach((value, key) => {
    query[key] = value
  })
  // 去掉可能的 baseURL 前缀（`/api`），mock 路由只写契约里的相对路径
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '')
  return { path, query }
}

function findRoute(method: string, segments: string[]): { route: MockRoute, params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segments.length)
      continue

    const params: Record<string, string> = {}
    let matched = true
    for (const [i, segment] of segments.entries()) {
      const pattern = route.segments[i]
      if (pattern.startsWith(':')) {
        params[pattern.slice(1)] = decodeURIComponent(segment)
      }
      else if (pattern !== segment) {
        matched = false
        break
      }
    }
    if (matched)
      return { route, params }
  }
  return null
}

/**
 * 分发一次 mock 请求。命中返回处理器结果；未命中返回 **契约形状**的 404 信封
 * （而不是抛错），这样「mock 没覆盖这个端点」在页面上表现为空态而不是白屏。
 */
export async function handleMockRequest(request: string, options?: { method?: string, body?: any }): Promise<IResponse<any>> {
  const { path, query } = splitRequest(request)
  const method = (options?.method ?? 'get').toLowerCase()
  const segments = normalizePath(path)

  const hit = findRoute(method, segments)
  if (!hit) {
    return notFound(`[mock] 未注册的端点：${method.toUpperCase()} ${path}`)
  }

  return await hit.route.handler({
    method,
    path,
    query,
    body: options?.body,
    params: hit.params,
  })
}
