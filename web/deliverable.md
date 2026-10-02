# 告警管理模块 — 前端脚手架交付说明（deliverable.md）

> 任务：告警管理模块前端**脚手架收尾**（类型层 + 传输层校验 + 目录地基 + 基线验证）
> 契约来源：`/workspace/docs/alarm/contract.md` v1.0（已冻结，19 个端点 / 12 组枚举 / 6 个 DTO）
> 约束：只交付**地基**，不实现业务页面（留给后续两个并行任务）
> 边界：本次只操作 `/workspace/web`，未触碰 `/workspace/server`

---

## 1. Summary

在上一轮（会话中断）已落地的模板裁剪、mock 层、传输层与页面骨架之上，本轮**收尾**了四件事：

1. **补齐并归位契约类型层** —— `src/types/alarm.ts`（958 行，14 个枚举 / 19 个 type / 29 个 interface）。
   上一轮的类型层被写在了 `src/services/types/alarm.ts`，与本任务约定的路径不符，本轮**整体迁移**到
   `src/types/alarm.ts` 并同步修正了全部 9 处引用（3 个传输层 + 2 个 mock + 3 个告警组件 + 1 处文档）。
2. **修正一处与契约 P10 的类型漂移** —— 请求体的触发条件此前复用了响应类型，会**强制**前端提交
   `id` / `metricNameCn` / `unit` 三个契约明确说「不需要」的字段，导致 §3.1 ③ 的**官方示例请求体都无法通过类型检查**。
3. **逐端点校验三个传输层文件** —— 19/19 端点的 URL、method、body、`IResponse<T>` 信封与契约 §5 速查表 1:1 一致，**未发现漂移**，仅修正了 import 路径。
4. **三条基线命令全绿** —— `pnpm lint` 0 / `pnpm test:run` 73 passed（9 files）/ `pnpm build` 0（含 `vue-tsc -b` 类型检查）。

另外顺带修正了 `src/pages/alarm/components/index.ts` 中一处 barrel 导出错位（`export *` 被排到了文件首行、
跑到模块文档注释之前），并用 `@/types/alarm` 统一了 4 个文件的引用路径。

---

## 2. 裁剪清单（删除的示例页与相关组件，共 45 个文件）

删除的是模板的**营销/示例类页面**及其私有组件与路由布局，**没有删除任何被保留页面引用的公共组件**。
保留的页面：`dashboard` / `tasks` / `users` / `settings` / `help-center` / `auth` / `errors` + 新增 `alarm`。

| #   | 删除的顶层条目                       | 文件数 | 说明                                                                                                 |
| --- | ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------- |
| 1   | `src/pages/ai-talk/**`               | 11     | AI 对话示例页（`index.vue` + 8 个私有组件 + `data/talks.ts` + `types/index.ts`）                     |
| 2   | `src/pages/billing/**`               | 12     | 账单示例页（`index.vue` + billing-history / billing-plan / transaction-card 三组组件与 data/schema） |
| 3   | `src/pages/apps/**`                  | 4      | 应用卡片示例页（`index.vue` + `components/app-card.vue` + `data/apps.ts` + `type.ts`）               |
| 4   | `src/pages/marketing/**`             | 2      | 营销首页（`index.vue` + `hello.vue`）                                                                |
| 5   | `src/pages/prop-components/**`       | 1      | 组件属性展示示例页                                                                                   |
| 6   | `src/components/marketing/**`        | 6      | 仅被营销页引用的私有展示组件（hero/features/logos/setup/evaluation/pricing-plans）                   |
| 7   | `src/components/marketing-layout/**` | 2      | 营销页头尾（`the-header.vue` / `the-footer.vue`）                                                    |
| 8   | `src/components/inspira-ui/**`       | 7      | 营销页特效组件（flickering-grid / glowing-effect / marquee×2 / ripple×3）                            |
| 9   | `src/layouts/marketing.vue`          | 1      | 营销页专用布局                                                                                       |
|     | **合计**                             | **45** |                                                                                                      |

配套改动（`M`）：

- `src/constants/sidebar-data.ts` —— 移除 Apps / Ai Talk Example / Prop Components 三个菜单项，引入 `alarmNavGroup`。
- `src/plugins/i18n/{en,zh}.json` —— 各删 98 行已下线页面的文案（合计 196 行）。
- `src/components/command-menu-panel/command-to-page.vue`、`src/components/app-sidebar/nav-footer.vue` —— 去掉指向已删页面的链接。
- `src/types/auto-import*.d.ts`、`src/types/route-map.d.ts` —— 由构建重新生成的声明（随页面裁剪同步变化）。

---

## 3. 三条基线命令的真实输出摘要

以下为本轮改动**全部完成后**的实测结果（`cd /workspace/web`）：

| 命令            | 退出码 | 结果摘要                                                                                           |
| --------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `pnpm lint`     | **0**  | `eslint .` 无 error / 无 warning，输出为空                                                         |
| `pnpm test:run` | **0**  | `vitest run` → **Test Files 9 passed (9)**，**Tests 73 passed (73)**，Duration 22.34s              |
| `pnpm build`    | **0**  | `vue-tsc -b && vite build` → `✓ built in 16.65s`，产出 `dist/`（含 `dist/index.html`），无类型错误 |

表中的耗时为该次实测值，多次运行会有波动；退出码与用例数是稳定的。

`test:run` 的 9 个测试文件（73 个用例）分布：

| 测试文件                                               | 用例数 |
| ------------------------------------------------------ | ------ |
| `src/utils/__tests__/env.test.ts`                      | 27     |
| `src/utils/__tests__/is-external-url.test.ts`          | 11     |
| `src/pages/errors/__tests__/error-pages.test.ts`       | 8      |
| `src/mocks/__tests__/mock-router.test.ts`              | 7      |
| `src/lib/__tests__/api-client.test.ts`                 | 5      |
| `src/services/api/__tests__/example-tasks.api.test.ts` | 5      |
| `src/components/data-table/__tests__/table.test.ts`    | 4      |
| `src/stores/__tests__/stores.test.ts`                  | 3      |
| `src/composables/__tests__/use-system-config.test.ts`  | 3      |

> **基线说明**：三条命令在**本轮改动之前**同样全绿（lint 0 / 73 passed / build 0），
> 即模板侧**无遗留失败**，本轮未引入任何回归。
>
> **`pnpm build` 是本次最重要的验证**：它含 `vue-tsc -b` 静态类型检查，类型层写错会直接让构建失败。

### 类型层的额外契约符合性验证（临时探针，已删除）

除三条基线外，另用两个**临时**文件（`src/__scratch_contract_check.ts` / `src/__scratch_contract_neg.ts`）
跑 `npx vue-tsc -b`（两次退出码均为 0）验证类型层与契约的**双向**符合性，验证后立即删除、不进入提交：

- **正向 9 例**：把契约 §3.1 ③ 的官方请求体示例、§2.2 列表项、§2.3 详情（含 `objectGroupIds: null` / `objectFilters: null`）、
  §2.5 预置通知模板（`receivers: []`）、§2.6 历史（`actualValue: null`、`handlerName: ''`）、§2.4 条件模板、§2.7 指标、§3.3 ⑲ 统计
  **原样**赋给对应类型，全部通过。
- **反向 11 例**（`@ts-expect-error` 断言，全部按预期报错 = 类型层确实能拦住漂移）：
  `notificationTemplateIds: null`、`level: 4`、`operator: '大于'`、`frequency: 10`、`period: 15`、`sort: 5`、
  响应条件缺 `metricNameCn`、`id: '1001'`（字符串主键）、详情页 `channels` 传完整对象、`handleAction: 'closed'`、
  **请求体条件里带 `id`**。

---

## 4. 告警模块目录结构与写入边界

### 4.1 目录结构

```
src/
├── types/
│   └── alarm.ts                      ← ★ 契约类型层（本轮归位 + 修正 P10）
├── services/
│   ├── types/
│   │   └── response.type.ts          ← IResponse<T>（契约 §0.2 要求「已存在，不要动」，本轮未改）
│   └── api/
│       ├── alarm-policy.api.ts         ← ①-⑫ 策略 / 指标 / 触发条件模板
│       ├── alarm-notification.api.ts   ← ⑬-⑯ 通知模板
│       └── alarm-history.api.ts        ← ⑰-⑲ 告警历史 / 统计
├── config/
│   └── alarm-nav.ts                 ← 「告警管理」侧边菜单入口（只读依赖）
├── mocks/                           ← mock 层（router/response/alarm + 7 个用例）
└── pages/alarm/
    ├── components/                  ← 公共件（骨架任务独占，后续任务只读）
    │   ├── index.ts                     barrel + 目录归属说明
    │   ├── alarm-enum-options.ts        枚举 → 下拉选项数组
    │   ├── alarm-level-badge.vue        等级徽标
    │   ├── condition-editor.vue         条件编辑器骨架（纯展示 + 插槽）
    │   └── alarm-module-placeholder.vue 页面占位骨架
    ├── policy/                     ← 告警策略任务可写
    │   ├── index.vue                    ① 列表
    │   ├── create.vue                   ③ 新建
    │   └── [id]/{index.vue,edit.vue}    ② 详情 / ④ 编辑
    ├── notification-template/       ← 通知模板任务可写
    │   └── index.vue                    ⑬-⑯
    └── history/                    ← 告警历史任务可写
        └── index.vue                    ⑰-⑲
```

### 4.2 写入边界（后续两个并行任务）

| 任务                    | **可写**（只新增/改自己目录内文件）                                      | **只读**（不得改动）                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 告警策略任务            | `src/pages/alarm/policy/**`                                              | `src/pages/alarm/components/**`、`src/types/alarm.ts`、`src/services/api/alarm-*.api.ts`、`src/mocks/**`、`src/config/**` |
| 通知模板 + 告警历史任务 | `src/pages/alarm/notification-template/**`、`src/pages/alarm/history/**` | 同上                                                                                                                      |

两条硬约束：

1. **契约只读** —— `src/types/alarm.ts` 是 contract.md 的 1:1 映射。需要新类型时**在本文件追加**并标注契约出处，
   禁止在页面目录里另建一份枚举/类型（否则必然与契约漂移）。
2. **页面目录互不越界** —— policy 任务不得写 notification-template / history，反之亦然；公共件一律加到
   `components/` 并回写 barrel，不要在页面目录里复制一份。

---

## 5. `src/types/alarm.ts` 清单与对齐点

### 5.1 枚举（14 个 `as const` 对象 + 派生联合类型 + 中文 label 映射）

| 常量                    | 契约节 | 取值                          | 中文 label                                                       |
| ----------------------- | ------ | ----------------------------- | ---------------------------------------------------------------- |
| `ALARM_MONITOR_TYPE`    | §1.1   | 1-5                           | 云产品监控 / 应用性能监控 / 前端性能监控 / 云拨测 / 终端性能监控 |
| `ALARM_POLICY_TYPE`     | §1.2   | 1-4                           | 通用 Web 服务 / 云服务器 CVM / 负载均衡 CLB / 云数据库 MySQL     |
| `ALARM_LEVEL`           | §1.3   | 1-3                           | 紧急 / 严重 / 提示                                               |
| `ALARM_PERIOD`          | §1.4   | 1/5/10/30/60                  | 1 分钟 / 5 分钟 / 10 分钟 / 30 分钟 / 60 分钟                    |
| `ALARM_OPERATOR`        | §1.5   | `>` `>=` `<` `<=` `==` `!=`   | 大于 / 大于等于 / 小于 / 小于等于 / 等于 / 不等于                |
| `ALARM_FREQUENCY`       | §1.6   | 0/5/15/30/60/180/360/720/1440 | 不重复 / 每 5 分钟 … / 每 1 天                                   |
| `ALARM_OBJECT_TYPE`     | §1.7   | 1-4                           | 全部对象 / 指定实例 / 实例分组 / 多维筛选                        |
| `ALARM_CONDITION_LOGIC` | §1.8   | 1-2                           | 满足所有条件 / 满足任意条件                                      |
| `ALARM_POLICY_STATUS`   | §1.9   | 0-1                           | 停用 / 启用                                                      |
| `ALARM_HISTORY_STATUS`  | §1.10  | 1-4                           | 未处理 / 已处理 / 已忽略 / 已恢复                                |
| `ALARM_NOTIFY_CHANNEL`  | §1.11  | 1-5                           | 邮件 / 短信 / 微信 / 电话 / 回调                                 |
| `ALARM_HANDLE_ACTION`   | §1.12  | `handle`/`ignore`/`recover`   | 处理 / 忽略 / 恢复                                               |

另有两个契约未单列但页面必需的辅助枚举：`ALARM_ERROR_CODE`（§0.5，9 个错误码，`409` 合并为单值因为契约规定前端按 code 统一提示）、
`ALARM_PRESET_FLAG`（`isPreset` 的 0/1）。以及 3 个联动/校验辅助表：
`ALARM_MONITOR_TYPE_POLICY_TYPES`（§1.1 联动）、`ALARM_OBJECT_TYPE_LIMITS`（P14 一一对应）、`ALARM_HANDLE_ACTION_TO_STATUS`（§1.12 落库状态映射）。

### 5.2 类型清单

- **通用（§0）**：`AlarmDateTime` / `AlarmDate`（时间字符串，别名标注，**不是** `Date`）、
  `AlarmPage<T>` = `{ list, total, page, pageSize }`、`AlarmPageQuery` = `{ page?, pageSize? }`、
  `AlarmValidationError` / `AlarmValidationExtra`（§0.4 的 422 明细）。
- **DTO（§2）**：`AlarmPolicyCondition`、`AlarmPolicyListItem`、`AlarmPolicyDetail`、
  `AlarmPolicyNotificationTemplateBrief`、`AlarmConditionTemplate`、`AlarmNotificationTemplate`、
  `NotificationChannel`、`AlarmHistory`、`AlarmMetric`、`AlarmOverview` + `AlarmLevelDistribution` / `AlarmTrendPoint`。
  §2.8 的 4 个「服务端内部列」**刻意不定义**。
- **请求 payload / 查询（§3）**：`AlarmPolicyListQuery`、`AlarmPolicyCreatePayload`、`AlarmPolicyStatusPayload`、
  `AlarmPolicyCopyResult`、`AlarmMetricListQuery`、`AlarmConditionTemplateListQuery` / `…Payload`、
  `AlarmNotificationTemplateListQuery` / `…Payload`、`AlarmHistoryListQuery`、`AlarmHistoryHandlePayload`、
  以及本轮新增的 `AlarmPolicyConditionPayload`。
- 响应信封 `IResponse<T>` **不在本文件重复定义**，继续用 `src/services/types/response.type.ts`（契约 §0.2 要求不动）。

### 5.3 与 contract.md 的关键对齐点

| #   | 契约条款                                                                                                                      | 类型层落法                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **§0.6 R-JSON-2**：`notificationTemplateIds` 是**唯一**非空 `int[]` JSON 字段，读出 `NULL` 必须补 `[]`                        | `AlarmPolicyListItem.notificationTemplateIds: number[]`（**非可选、非 null**），反例探针确认传 `null` 会报错                                                                                                  |
| 2   | **§0.6 R-JSON-1**：`objectIds` / `objectGroupIds` / `objectFilters` 响应里**永远是 `null` 不是 `[]`**                         | `AlarmPolicyDetail` 三者均为 `number[] \| null` / `AlarmObjectFilter[] \| null`；请求侧（§3.1 ③）同为 `\| null`，即 `null` 与 `[]` 都合法（写侧均落 `NULL`）                                                  |
| 3   | **§2.1 + P10**：请求条件**不含** `id`，且 `metricNameCn` / `unit` 由服务端回填、请求可带可省                                  | 新增 `AlarmPolicyConditionPayload = Omit<AlarmPolicyCondition,'id'\|'metricNameCn'\|'unit'> & Partial<Pick<…,'metricNameCn'\|'unit'>>`，供 `AlarmPolicyCreatePayload` 与 `AlarmConditionTemplatePayload` 使用 |
| 4   | **§1.3**：字段名是 `level`（**不是** `alarmLevel`）                                                                           | `AlarmPolicyCondition.level` / `AlarmPolicyListItem.level` / `AlarmHistory.level` 全部为 `level`                                                                                                              |
| 5   | **§1.6**：`frequency = 0`（不重复）是**扩展值**，共 9 个取值                                                                  | `ALARM_FREQUENCY` 含 `NEVER: 0`，并注释标注其不在腾讯云原 8 值内                                                                                                                                              |
| 6   | **§1.5**：`operator` 是 `VARCHAR(2)` 字符串，**原样传输、禁止本地化**                                                         | `AlarmOperator` 为字符串字面量联合；中文名只存在于 `ALARM_OPERATOR_LABEL`（仅用于展示）                                                                                                                       |
| 7   | **§0.2**：业务失败时 `data` 恒为 `null`，列表 `data` 恒为分页对象                                                             | 所有列表端点返回 `IResponse<AlarmPage<T>>`，**没有**任何裸数组；`⑧ /metrics` 按契约是唯一不分页的端点                                                                                                         |
| 8   | **§0.1**：`id` 一律 number、`threshold` / `actualValue` 一律 number、时间是不带时区的 `YYYY-MM-DD HH:mm:ss` 字符串            | 全部类型按此声明（`threshold: number` 而非 string，时间用 `AlarmDateTime` 别名而非 `Date`）                                                                                                                   |
| 9   | **§2.5 + N5/N3/N4**：预置模板 `receivers` **允许 `[]`**；`channel=5` 时 `callbackUrl` 必填、其他渠道必须 `null`               | `NotificationChannel.receivers: string[]`（非空数组但可为空）、`callbackUrl: string \| null`                                                                                                                  |
| 10  | **§2.3 vs §2.5**：详情页 `notificationTemplates[].channels` 是**编码数组**，模板页才是完整对象                                | 两个不同类型：`AlarmPolicyNotificationTemplateBrief.channels: AlarmNotifyChannel[]` vs `AlarmNotificationTemplate.channels: NotificationChannel[]`                                                            |
| 11  | **§1.10 / §1.12**：未处理时 `recoveredAt` / `handledAt` / `handleAction` 是 `null`，但 `handlerName` / `handleRemark` 是 `""` | 三个可空字段用 `\| null`，两个字符串字段保持非空 `string`（反例探针覆盖）                                                                                                                                     |
| 12  | **P5**：`sort` 必须 1..N 连续升序                                                                                             | `AlarmConditionSort = 1 \| 2 \| 3 \| 4`（传 `5` 报错）                                                                                                                                                        |
| 13  | **R-JSON-3**：标量列 DEFAULT 只是 DB 兜底，契约上一律必填                                                                     | `level` / `period` / `continuity` / `frequency` / `sort` 在 payload 中**均无默认值、全部必填**                                                                                                                |

### 5.4 传输层校验结论

三个传输层文件逐端点比对契约 §5 速查表，**19/19 全部一致**，未发现 URL / method / body 漂移：

| 文件                        | 端点         | 校验                                                                                                                                                       |
| --------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alarm-policy.api.ts`       | ①-⑫（12 个） | URL 前缀 `/alarm/**`（正确相对 baseURL `http://localhost:3000/api`）、method 全对（get/post/put/delete）、`data` 泛型全对、删除类返回 `IResponse<boolean>` |
| `alarm-notification.api.ts` | ⑬-⑯（4 个）  | 同上；列表返回 `AlarmPage<AlarmNotificationTemplate>`（**完整 channels**，与详情页编码数组不同）                                                           |
| `alarm-history.api.ts`      | ⑰-⑲（3 个）  | 同上；`handle` 的 body 为 `{ action, remark }`，`overview` 无查询参数                                                                                      |

三处均统一走 `apiFetch` + `IResponse<T>` 信封，无裸 fetch、无自造错误处理。**本轮对传输层的唯一改动是 import 路径**。

---

## 6. 已知限制

1. **业务页面未实现**（本任务边界）。7 个页面文件全部是 `AlarmModulePlaceholder` 占位，侧边栏可点开但不渲染业务表格/表单。
2. **mock 层只覆盖读接口 + 2 个演示性 409**。③④⑤⑥⑦⑩⑪⑫⑭⑮⑯⑱ 的**写入语义**（唯一性校验、启停冲突、模板引用检查）
   未实现；且 `apiFetch` 在 mock 模式下只把 `{ method, body }` 传给 `handleMockRequest`，**`query` 被丢弃**，
   因此 mock 下列表筛选参数不生效（返回固定数据）。联调需以真实后端为准。
3. **`⑧ /metrics` 的 mock 只给 1 条示例**。契约规定真实响应固定 28 条、唯一来源 `metrics.md` §1，前端不应硬编码指标字典。
4. **`AlarmMetric` 的 `policyType` / `periodOptions` 字段名与契约一致但类型收窄为枚举联合**
   （`AlarmPolicyType[]` / `AlarmPeriod[]`）。若后端未来放宽取值，需同步放宽类型。
5. **R-JSON-1 在类型层只能表达为 `| null`，无法阻止后端误发 `[]`**。这是契约自带的类型层限制：
   `number[] | null` 在结构上同时接受 `[]`。真正的约束在后端 DAO 归一化（§0.6 写归一化列），前端需在渲染处
   按 `objectType` 判断，不要仅依赖 `!== null`。
6. **`threshold` 为 `number`**，DB 是 `DECIMAL(20,4)`。超过 2^53 的极端值会有精度损失（契约 R4 已记录为可接受）。
7. **`POST /policies/{id}/copy` 传输层不发送 body**（契约注明「请求体无，可为空对象」），若后端严格要求 `{}` 需补一个空 body。
8. **`sort-keys` 已被 eslint 关闭、`perfectionist/sort-imports` 强制开启**：类型与枚举声明顺序按语义分组而非字典序，
   后续任务追加类型时请沿用现有分节注释（`§0` / `§1` / `§2` / `§3`）以免风格漂移。
9. **未新增针对类型层的自动化测试**。本轮的类型符合性验证用的是一次性 `vue-tsc` 探针（已删除），
   §3 里记录了断言清单；如需长期回归，可把正向/反向样例固化为 `*.test-d.ts`（本仓库当前未接 `vitest-typecheck`）。

---

## 7. 文件变更清单

### 本轮新增

- `src/types/alarm.ts` —— 契约类型层（958 行；从 `src/services/types/alarm.ts` 迁移而来并修正 P10）

### 本轮修改

- `src/services/api/alarm-policy.api.ts` / `alarm-notification.api.ts` / `alarm-history.api.ts` —— import 路径 + 模块头注释回位
- `src/mocks/alarm.mock.ts` / `src/mocks/index.ts` —— import 路径
- `src/pages/alarm/components/alarm-enum-options.ts` / `alarm-level-badge.vue` / `condition-editor.vue` —— import 路径
- `src/pages/alarm/components/index.ts` —— barrel 导出错位修正 + 文档中的类型层路径更新
- `.gitignore` 未改动；`dist/` 为构建产物，未纳入提交

### 前一轮（会话中断前）已完成、本轮**未重做**

- `src/mocks/**`（router/response/alarm + index + 7 个测试用例）
- `src/services/api/alarm-*.api.ts` 三件套的**内容**（本轮只改了 import 路径）
- `src/pages/alarm/**` 全部目录与 7 个占位页
- `src/config/alarm-nav.ts` 与 `src/constants/sidebar-data.ts` 的菜单入口
- `.env.example` / `src/utils/env.ts` / `src/validators/env.validator.ts` 的 `VITE_USE_MOCK` 开关
- 45 个示例页/组件的裁剪
