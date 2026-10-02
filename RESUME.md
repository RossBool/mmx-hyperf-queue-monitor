# 告警管理功能 — 断点记录

> 状态：**已暂停**（用户主动叫停）。恢复时从「待办」清单续上即可，无需重新摸索。

## 环境事实（别浪费时间试错）

- 沙箱**无 PHP / composer / MySQL / Redis** → 后端代码**从未运行过**，只能静态审查。
  产出物是"经多轮对抗式审查的代码"，不是"验证过能跑的代码"。
- Node v22.19 + pnpm 11.27.1 可用；`/workspace/web/node_modules` 已装好，**不要重装**。
- `hyperf.io/docs/3.2/*` 全部 404。核对 Hyperf API 请从 packagist 拉官方 dist 包读源码。
- MySQL 最低 **8.0.16**（更早版本 CHECK 约束被静默忽略，29 条会全部失效且不报错）。
- `team` 编排链路在本环境**不可用**（decision 通道传不进去、派活会往失效会话上戳）→ 已改为直接调度 subagent。

## 已完结（干净可用）

| 产出 | 位置 | 状态 |
|---|---|---|
| 接口契约 / 建表 DDL / 指标字典 / 领域模型 | `/workspace/docs/alarm/` | 3 轮审查修正，含真实 MySQL 8.0.39 实测 |
| 后端 19 个端点 | `/workspace/server/` | 3 轮对抗式审查，4 个致命缺陷已修 |
| 前端类型层 + 接口层 + mock | `/workspace/web/` | commit `1d020a6`，构建/类型/73 测试全绿 |
| 前端基线（模板落地 + 裁剪） | `/workspace/web/` | 53 测试全绿 |

## 待办 1：修复策略页的 7 处类型错误（半成品，当前编译不过）

`vue-tsc -b` 的真实报错：

1. `policy-form.vue(783)` → `Property 'reload' does not exist on type 'RouterClassic'`
2. `policy/index.vue(14)` → `Cannot find module '@/components/confirm-dialog'`（该组件在裁剪时被删了）
3. `policy/index.vue(270)` → `Parameter 'value' implicitly has an 'any' type`
4. `policy/validators/policy.validator.ts(100)` → `z.enum` 传了符号字符串数组，签名要 `readonly number[]`
5. `policy/validators/policy.validator.ts(136)` → 多维筛选 `operator` 被声明成 `number`，契约里是 `AlarmOperator`（符号字符串）
6. `services/api/__tests__/alarm-policy.api.test.ts(65)` → `policyType: number` 应为 `AlarmPolicyType`
7. 同文件其余同类

⚠️ **第 4/5 条与后端曾出现的致命 bug 同源**：契约里「比较关系」`operator` 的取值是
`> >= < <= == !=`（符号字符串），任何按数字处理的分支都会导致全部策略写入 422。
改的时候顺手全局 grep 一遍 `operator`，前后端都不能有数字假设。

## 待办 2：完成两个页面

- `src/pages/alarm/policy/**` —— 列表 / 三步向导 / 详情，已铺 12 个文件但未验证
- `src/pages/alarm/notification-template/**` + `src/pages/alarm/history/**` —— 同上

验收口径（三条命令必须全绿，且必须真跑）：

```bash
cd /workspace/web
pnpm lint && pnpm test:run
pnpm exec vue-tsc -b --force
pnpm exec vite build --outDir dist-check   # 并行任务用独立 outDir，避免抢 dist/
```

## 待办 3：前后端对账 + 端到端冒烟

- `web/src/types/alarm.ts` 每个字段/枚举 ↔ `server/src/**` 逐项对照，出漂移矩阵
- 用 `VITE_USE_MOCK=true` 驱动真实前端跑完整流程（后端跑不起来，只能这样联调）
- 产出 `/workspace/INTEGRATION.md`

## 交付时必须写明的风险

- **后端未做任何运行时验证**：无 PHP 环境，`composer install` / `migrate` / `start` / 109 个测试一次都没执行过
- 最高风险项：路由 `addGroup` 修好后，19 个端点**是否真的注册成功，只有本地启动才知道**
- 建议用户首次运行第 1 步：`mysql -u... < server/../docs/alarm/schema.sql` 手工验证 DDL，
  第 2 步查 `SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()`
  期望返回 **29**，返回 0 说明 MySQL < 8.0.16，约束被静默忽略

---

## 续坑记录（2026-10-01 恢复时踩到）

**沙箱隔夜回收后 `pnpm` 消失**。`corepack enable && corepack prepare pnpm@11.27.1 --activate`
可恢复，但**每次新会话跑前端命令前都要先激活**，否则：

```
pnpm exec vue-tsc -b --force   →  EXIT=127，"pnpm: No such file or directory"
```

⚠️ **致命**：127 会让 `grep -c "error TS"` 得到 **0**，看起来像"零错误全绿"，实际是命令根本没跑。
**任何前端验证必须先打印真实 EXIT 码再下结论**，`EXIT=127` 一律视为验证失败。

恢复后的真实类型错误数是 **12**（不是断点里记的 7——那 7 个在停机前已被修掉）。
