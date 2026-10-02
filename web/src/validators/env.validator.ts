import z from 'zod'

export const EnvSchema = z.object({
  // Add your environment variables here, for example:
  // VITE_API_BASE_URL: z.string().url(),
  VITE_SERVER_API_URL: z.url(),
  VITE_SERVER_API_PREFIX: z.string(),
  VITE_SERVER_API_TIMEOUT: z.coerce.number().default(5000),
  /**
   * Mock 开关：为 `true` 时 `apiFetch` 走本地 mock，不发真实 HTTP 请求，
   * 让前端在后端（PHP/Hyperf）未就绪时也能跑通。
   *
   * ⚠️ 这里**故意不用** `z.coerce.boolean()`：`Boolean('false') === true`，
   * 会把 `.env` 里显式写的 `VITE_USE_MOCK=false` 变成 `true`。改成字符串比较。
   * 接受 `'true'` / `'1'`（忽略大小写与首尾空格），其余一律视为 `false`，
   * 且**不会**让整个 env 校验失败。
   */
  VITE_USE_MOCK: z
    .string()
    .default('false')
    .transform((raw) => {
      const value = raw.trim().toLowerCase()
      return value === 'true' || value === '1'
    }),
})

export type env = z.infer<typeof EnvSchema>
