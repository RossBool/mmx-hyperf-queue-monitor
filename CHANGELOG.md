# Changelog — 告警管理功能

> 本文件记录**本项目**的开发历史。
> `web/CHANGELOG.md` 是上游模板 [shadcn-vue-admin](https://github.com/Whbbit1999/shadcn-vue-admin) 自带的版本记录，与本项目无关，未做改动。

---

## 说明：历史提交去哪了

前端 `web/` 原本是一个独立的 Git 仓库，有 6 个提交。本项目推送到 monorepo 时是通过 GitHub API 逐文件推送的
（`push_files`），**没有携带 Git 历史**，所以本仓库的提交历史是从零开始的。

原始 6 个提交的信息在下方完整保留。`server/` 后端**从未被 Git 管理过**，一直是沙箱里的裸目录，
因此它没有提交历史可记录——它的变更节点只能按功能阶段归纳。

---

## 前端 `web/` 原始提交（2026-09-29 → 2026-10-02）

### `909de27` — 2026-09-29 17:15 · `chore: deps update`

导入 shadcn-vue-admin 模板基线。此提交不含任何告警功能。

---

### `1d020a6` — 2026-09-30 16:33 · `feat(alarm): contract type layer + alarm module scaffold`

建立告警模块的地基。

**新增/修改 34 个文件**，其中告警相关 17 个：

| 类别 | 内容 |
|---|---|
| 契约类型层 | `src/types/alarm.ts` — 19 个端点的请求/响应 DTO、12 组枚举 |
| API 传输层 | `services/api/alarm-{policy,history,notification}.api.ts` 三个模块 |
| Mock 层 | `mocks/alarm.mock.ts`、`mocks/router.mock.ts` — 无后端时可跑 |
| 导航 | `config/alarm-nav.ts` — 侧边栏「告警管理」入口 |
| 页面骨架 | `pages/alarm/` 下 6 个占位页（policy 列表/新建/详情/编辑、通知模板、历史） |
| 公共组件 | `condition-editor.vue`、`alarm-level-badge.vue`、`alarm-enum-options.ts` |

**同时删除 45 个模板演示文件**——这是模板裁剪，不是功能改动：
`pages/marketing`、`pages/billing`、`pages/ai-talk`、`pages/apps`、
`layouts/marketing.vue`、`components/marketing/*`、`components/inspira-ui/*`。

改动量：+2811 / −2754。

---

### `5ce0286` — 2026-10-01 04:42 · `feat(alarm): notification template + alarm history pages`

**21 个文件，+5135 / −19。** 两大模块从占位页变成可用实现。

- **通知模板**：列表、表单（渠道配置器 `notification-channel-editor.vue`）、删除确认、行操作
- **告警历史**：统计概览卡（`history-overview-cards.vue`）、时间范围选择器、行操作（处理/忽略/恢复）
- 两者都遵循同一套分层：`logic.ts`（业务）+ `refresh.ts`（刷新信号）+ `components/` + `__tests__/`

---

### `144017e` — 2026-10-01 04:43 · `feat(alarm): policy list + wizard + detail`

**17 个文件，+5791 / −49。** 改动量最大的一次提交。

- **列表页**：`policy-filters.vue` 多条件筛选 + 分页
- **三步向导**：`create.vue` / `[id]/edit.vue` 共用 `policy-form.vue`（60KB，本项目最大的单文件）
- **详情页**：`policy-detail.vue`
- **策略操作**：复制、删除、启停（`policy-row-actions.vue`）
- **校验**：`validators/policy.validator.ts` — 独立于表单组件，可单测

---

### `1eb81d3` — 2026-10-01 05:24 · `fix(alarm): separate request/response channel types + enum narrowing helpers`

**4 个文件，+192 / −3。** 修两个契约层面的隐患。

1. **请求/响应类型分离** — 新增 `NotificationChannelPayload`。此前通知渠道的请求和响应共用一个类型，
   契约里可选字段（`receivers` 等）在请求侧被误判为必填。
2. **枚举收窄工具** — 保留严格枚举类型（不放宽成 `number`），新增 `toAlarm*` 系列函数在运行时收窄。
   校验器强制 `cast`，避免用类型断言掩盖真实数据问题。

---

### `00c3ec8` — 2026-10-02 01:39 · `fix(alarm): 回调渠道误填接收人显式提示，不再静默丢弃`

**2 个文件，+87 / −4。** 跨端审计发现的中等问题。

回调渠道填了 `receivers` 时，旧实现会**静默丢弃**该字段——用户以为配了接收人，实际没生效。
改为显式提示。修复过程同步补了测试。

---

## 后端 `server/` — 无 Git 历史

后端 64 个 PHP 文件 / 约 7030 行，**从未被 Git 管理**，因此没有逐次提交记录。
按开发阶段归纳：

| 阶段 | 内容 |
|---|---|
| 规格冻结 | 以 `docs/alarm/contract.md` 为唯一事实来源，锁定 19 端点、12 组枚举、业务规则 |
| 骨架与迁移 | 19 个业务端点 + 7 个按表拆分的迁移文件（每条迁移只执行一条 `Db::statement()`） |
| DTO 与校验 | 请求/响应对象、枚举校验、业务规则实现 |
| 测试 | 109 个测试方法代码 |
| 缺陷修复 | 修 4 个致命缺陷（见下） |

### 审查中修复的 4 个致命缺陷

| 缺陷 | 后果 |
|---|---|
| `Router::addGroup` 签名用错 | 服务无法启动 |
| `operator` 被按数字校验 | 全部写入操作被拒（它必须是 `>` `>=` `<` `<=` `==` `!=` 符号字符串）|
| 更新逻辑静默不落库 | 数据丢失 |
| 成功响应 HTTP 状态为 0 | 违反响应契约 |

---

## 验证状态（重要）

| | 状态 | 依据 |
|---|---|---|
| **前端** | ✅ 验证过能跑 | `lint` / `vue-tsc` / **424 个测试** / `build` 四项退出码全 0 |
| **后端** | ⚠️ **从未运行过** | 沙箱无 PHP / Composer / MySQL，109 个测试、迁移、启动一次都没执行 |

后端是「**经多轮对抗式静态审查的代码**」，不是「验证过能跑的代码」。
静态审查发现不了运行时问题——第一次在真实环境启动时很可能还要修一轮。
详见 [`INTEGRATION.md`](./INTEGRATION.md)。
