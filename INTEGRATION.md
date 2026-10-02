# 告警管理 — 前后端契约一致性审计 + 端到端冒烟（最终验收）

> 审计日期：2026-10-02　　裁判文档：`docs/alarm/contract.md` v1.0（已冻结）
> 审计人：验证方（独立核验，未参与实现）
> 结论：**三方零漂移**，5 项观察级问题，**0 处代码修改**

---

## 0. 先说环境事实与诚实性边界

| 项 | 事实 | 对审计的影响 |
| --- | --- | --- |
| PHP / composer / MySQL | **沙箱内不存在** | 后端**从未运行过**。本报告所有后端结论均为**静态比对**，未执行 `composer install` / `migrate` / `start` / 109 个测试中的任何一个 |
| Node / pnpm | v22.19.0 / **11.27.1** | 前端**全部真实执行** |
| pnpm 激活 | `corepack enable && corepack prepare pnpm@11.27.1 --activate` → `which pnpm => /usr/local/bin/pnpm`，`pnpm --version => 11.27.1` | 已激活，**四条命令无一为 127**。每条命令退出码均为真实回显 |
| 浏览器 / Playwright | **不存在** | 无法截图。端到端冒烟改用「真实页面组件 + 真实 api-client + 真实 mock 路由」在 happy-dom 中挂载驱动（见 §1 方法学与局限） |

**本次审计未主动修改任何项目代码。** 所有审计脚本与冒烟用例都写在 `/tmp/audit/` 下，
通过 `--config` 指向外部配置的 vitest 运行，不落地到仓库。

> ⚠️ **需要声明的副作用**：任务要求执行的 `pnpm build`（以及冒烟时启动的 `pnpm dev`）会触发
> `vite.config.ts` 里 `unplugin-vue-router` / `unplugin-auto-import` / `unplugin-vue-components`
> 三个插件**自动重写**下列声明文件（`vite.config.ts` 的 `dts:` 选项，第 23 / 48 / 56 行）：
>
> | 文件 | mtime |
> | --- | --- |
> | `web/src/types/route-map.d.ts` | 2026-10-02 01:15 |
> | `web/src/types/auto-import.d.ts` | 2026-10-02 01:15 |
>
> 这两个文件是**构建产物**（内容由 `src/pages/**` 与 `src/components/**` 确定性生成），
> 非人工编写；`vue-tsc -b` 在其上通过。仓库无 git（`fatal: not a git repository`），
> **无法用 diff 证明内容逐字节未变**，此处据实声明。

---

## 1. 端到端冒烟清单与结果

### 1.1 方法学

后端跑不起来，因此**不能**用「前端页面 + 真实后端」联调。采用的方法是：

```
真实 .vue 页面组件  →  真实 @/services/api/alarm-*.api.ts  →  真实 src/lib/api-client.ts
      →  （VITE_USE_MOCK=true）→  真实 src/mocks/router.mock.ts  →  src/mocks/alarm.mock.ts
```

即：**只有 HTTP 出口被替换成 mock，页面、逻辑层、校验层、传输层、mock 分发层全部是项目真实代码**。
运行时用 `@vitejs/plugin-vue` + `unplugin-auto-import` + `unplugin-vue-components`
复刻了 `web/vite.config.ts` 的插件配置，使 `<script setup>` 的 `ref/computed/useRouter`
与 `<ConfirmDialog>` 等自动导入与真实构建一致。

命令：

```bash
cd /workspace/web
pnpm exec vitest run --config /tmp/audit/vitest.smoke.config.ts /tmp/audit/*.smoke.test.ts
```

`/tmp/audit/vitest.smoke.config.ts` 中唯一的人为设定是
`define: { 'import.meta.env.VITE_USE_MOCK': '"true"' }`，即任务要求的 mock 开关。

### 1.2 冒烟结果（全部真实执行）

| # | 场景 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| S1.1 | 策略列表加载（端点 ①） | ✅ 通过 | `rows=1 total=1 errorMessage=""`，行字段 `生产 CVM CPU 监控 / status=1 / level=1 / conditionCount=2 / notificationTemplateIds=[3,5] / createdAt=2026-09-20 10:12:33`（时间格式符合 §0.1） |
| S1.2 | 筛选组装 + 翻页（①） | ✅ 通过 | `buildPolicyListQuery` 空串被剔除 → `{"page":1,"pageSize":20}`；`pageIndex+1` 换算正确；非数字 `projectId:"abc"` 不进 query（避免后端 422） |
| S1.3 | **启停失败必须回滚**（⑥） | ✅ 通过 | mock 未注册 ⑥ → 返回 404 契约信封 → `status 前=1 后=1 rolledBack=true`，行状态未被乐观更新污染 |
| S1.4 | 删除 409 提示（⑤） | ✅ 通过 | `{"success":false,"code":409,"data":null,"message":"已启用的策略不可删除，请先停用"}`；`data` 恒为 `null`（§0.2 约束 1），前端采用后端 message |
| S1.5 | 复制 / 查看告警历史跳转 | ✅ 通过 | `复制 -> /alarm/policy/create?copyFrom=1001`；`历史 -> /alarm/history?policyId=1001` |
| S1.6 | §0.6 JSON 空值归一化（②） | ✅ 通过 | `objectIds=[8801,8802] objectGroupIds=null objectFilters=null notificationTemplateIds=[3,5] notificationTemplates[0].channels=[1,2]`（**编码数组，不是对象数组**）；`conditions[0].operator=">"`（字符串） |
| S2.1/S2.2 | 新建向导校验拦截（P4/P5） | ✅ 通过 | 空表单被 `policyFormSchema` 拒；5 条条件被拒（`触发条件最多 4 条`） |
| S2.3 | **operator 必须是符号字符串**（P9） | ✅ 通过 | `> >= < <= == !=` 六个全通过；`大于 / 1 / 0 / GT` 四个全被拒 |
| S2.4 | 通知模板最多 3 个（P12） | ✅ 通过 | 4 个被拒、3 个通过 |
| S2.5 | **提交 payload 与契约 ③ 逐字段一致** | ✅ 通过 | `name` 去首尾空格；`objectGroupIds/objectFilters` 收敛为 `null`；`conditions[0]` 恰好 9 个字段且**不含** `id`/`metricNameCn`/`unit`；`notificationTemplateIds=[3,5]`；update 模式**无** `status` |
| S2.6 | 复制命名按**字符**截断（§3.1 ⑦） | ✅ 通过 | 200 个汉字 → 长度精确 128，尾部 `" - 副本"` / `" - 副本(2)"`，无半截字符 |
| S2.7 | 新建页真实挂载 | ✅ 通过 | 渲染出「新建告警策略 / 基本信息 / 下一步」 |
| S3.1 | 通知模板列表（⑬） | ✅ 通过 | ⑬ 返回**完整 channels 含接收人**：`receivers=["ops@example.com"]`（与策略详情页的编码数组不同） |
| S3.2 | 通知模板删除（⑯） | ✅ 通过 | 预置 id=5 → 409；自定义 id=3 → `{"success":true,"data":true}` |
| S3.3 | N3/N4/N2/N5/N6 渠道规则 | ✅ 通过 | 回调缺 URL → 拒；非回调带 URL → 拒；非回调归一化为 `callbackUrl:null`；`channel` 重复去重；邮箱格式校验；`silenceTime=1441` 拒；0 条渠道拒；`isPreset` 不进 payload |
| S4.1 | 历史页 + ⑲ 统计（⑰/⑲） | ✅ 通过 | `levelDistribution` 恒 3 项、`trend7Days` 恒 7 项 |
| S4.2 | `?policyId=` 跳转 | ✅ 通过 | `policyId=1001 → 1001`；`abc / -5 → undefined`（降级为不过滤，不白屏）；页面正常出数据 |
| S4.3 | 时间范围 H4 本地拦截 | ✅ 通过 | `start=09-30 end=09-01 → error="开始时间不能晚于结束时间"`，且 query 中**不含** startTime（不发必然 422 的请求）；合法区间产出 `2026-09-01 00:00:00` / `2026-09-30 23:59:59` |
| S4.4 | 三种处理动作（⑱） | ✅ 通过 | `handle / ignore / recover` 均返回契约信封；不存在的 id → `{"success":false,"code":404,"data":null}` |
| S4.5 | **历史状态机：已忽略 → 已处理 非法 → 409** | ✅ 通过 | `{"success":false,"code":409,"message":"该告警已处理，不可重复处理","data":null}` |
| S4.6 | §0.6 历史页空值 | ✅ 通过 | `actualValue/recoveredAt/handledAt/handleAction` 可为 `null`，但 `handlerName`/`handleRemark` 是 `""`（两者行为不同，未混淆） |
| S5.1 | **编辑回填 + PUT 全量语义** | ✅ 通过（逻辑层） | ② 详情 → 表单态 `name="生产 CVM CPU 监控" objectType=2 objectIds=[8801,8802] conditions=2`；表单态过 `policyFormSchema`；PUT payload **含全部 2 条 conditions**、`sort=[1,2]`、**省略 status**、不适用字段为 `null`、条件中无 `id` |
| S5.2 | 回填丢弃条件 `id` | ✅ 通过 | `conditions[0]` 中 `id` 已被剔除 |
| E3 | 复制入口预填 | ✅ 通过（逻辑层） | `name="生产 CVM CPU 监控 - 副本"`、`status=0`、conditions=2、无 `creatorName`（服务端取）、无 `id`（服务端生成） |
| E4 | §0.2 信封 + §0.3 分页 | ✅ 通过 | 6 个读接口的键集均为 `code,data,extra,message,success`，`extra={}`；列表 `data` 均为 `{list,total,page,pageSize}`，**无裸数组**；`/metrics` 为不分页数组 |
| E5 | 未注册端点 | ✅ 通过 | 返回 `{"success":false,"code":404,"data":null}`（契约形状的空态而非白屏） |
| E7 | **N9 绑定时拒绝未配置完成的模板** | ✅ 通过 | 模板 5（预置、`receivers:[]`）→ 配置完成度 `false`；绑定 `[3]` 通过，绑定 `[3,5]` 被拒且**点名**「系统预置-邮件通知」；超 3 个 / 重复 / 不存在 三类错误同时报出 |
| E8 | P8 period 子集 | ✅ 通过 | `CVM.CpuUtilizationRate periodOptions=[1,5,10,30,60] defaultOperator=">"`（字符串） |
| A1–A9 | **对抗性探针 9 项** | ✅ 全通过 | 见 §4.3 |

### 1.3 冒烟中**未能**验证的部分（诚实声明）

**新建 / 编辑向导（`policy-form.vue`，1517 行）的 DOM 绑定没有完成运行时验证。**

原因不是产品缺陷，而是沙箱缺少真实浏览器。已用隔离探针证明是**测试环境问题**：

```
DBG4 after setFieldValue DOM="|0"  state={"name":"SET_BY_SETFIELD","n":0}
DBG4 -> setFieldValue 路径是否有响应式: false
DBG3 isReactive(state)=false  isRef(state)=false
```

`@tanstack/vue-form` 的 `form.state` 在 happy-dom 下**完全不具备响应性**——
连最基本的 `setFieldValue` 都不会触发重渲染（与 `reset` 无关，两条路径表现一致）。
若这是产品缺陷，则「在名称框里打字」都不会生效，属于不可能漏到验收的级别；
且项目自带 419 个测试全部通过。据此判定为**环境限制，不作为缺陷上报**。

**替代验证**：向导的契约关键逻辑（回填 / 组装 / 校验 / PUT 语义）已通过 S5.1、E3 走
`detailToFormValues → policyFormSchema → buildPolicyPayload` 的**真实函数链**完整验证通过。

---

## 2. 跨端契约一致性矩阵

### 2.1 端点矩阵（19/19）

三方对照 `web/src/services/api/alarm-*.api.ts` ↔ `server/config/routes.php` ↔ `contract.md §5`。

| # | 方法 | 路径 | web | server | 契约 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | GET | `/api/alarm/policies` | ✅ | ✅ | ✅ | 通过 |
| ② | GET | `/api/alarm/policies/{id}` | ✅ | ✅ | ✅ | 通过 |
| ③ | POST | `/api/alarm/policies` | ✅ | ✅ | ✅ | 通过 |
| ④ | PUT | `/api/alarm/policies/{id}` | ✅ | ✅ | ✅ | 通过 |
| ⑤ | DELETE | `/api/alarm/policies/{id}` | ✅ | ✅ | ✅ | 通过 |
| ⑥ | POST | `/api/alarm/policies/{id}/status` | ✅ | ✅ | ✅ | 通过 |
| ⑦ | POST | `/api/alarm/policies/{id}/copy` | ✅ | ✅ | ✅ | 通过 |
| ⑧ | GET | `/api/alarm/metrics` | ✅ | ✅ | ✅ | 通过 |
| ⑨ | GET | `/api/alarm/condition-templates` | ✅ | ✅ | ✅ | 通过 |
| ⑩ | POST | `/api/alarm/condition-templates` | ✅ | ✅ | ✅ | 通过 |
| ⑪ | PUT | `/api/alarm/condition-templates/{id}` | ✅ | ✅ | ✅ | 通过 |
| ⑫ | DELETE | `/api/alarm/condition-templates/{id}` | ✅ | ✅ | ✅ | 通过 |
| ⑬ | GET | `/api/alarm/notification-templates` | ✅ | ✅ | ✅ | 通过 |
| ⑭ | POST | `/api/alarm/notification-templates` | ✅ | ✅ | ✅ | 通过 |
| ⑮ | PUT | `/api/alarm/notification-templates/{id}` | ✅ | ✅ | ✅ | 通过 |
| ⑯ | DELETE | `/api/alarm/notification-templates/{id}` | ✅ | ✅ | ✅ | 通过 |
| ⑰ | GET | `/api/alarm/histories` | ✅ | ✅ | ✅ | 通过 |
| ⑱ | POST | `/api/alarm/histories/{id}/handle` | ✅ | ✅ | ✅ | 通过 |
| ⑲ | GET | `/api/alarm/overview` | ✅ | ✅ | ✅ | 通过 |

- **web `apiFetch` 调用数 = 19，server 路由数 = 19（另 1 条 `/favicon.ico` 非告警端点）**
- **多出端点：0；缺失端点：0**
- 路径基准核对：契约 `/api/alarm/...`、web 相对 baseURL(`…/api`) 写 `/alarm/...`、server 在 `Router::addGroup('/api/alarm', …)` 内写 `/...` —— 三者拼接后**完全等价**
- 分页：仅列表端点带 `page/pageSize`；⑧ `metrics` 不分页（契约明文），三边一致
- 请求体：⑤⑦ 无 body；⑥ `{status}`；⑱ `{action,remark}`；③④⑩⑪⑭⑮ 全量 payload —— 三边一致

### 2.2 字段矩阵（7 组 DTO / 94 个字段）

`contract.md §2` ↔ `web/src/types/alarm.ts` ↔ `server/src/Support/Presenter.php`。

| DTO | 契约字段数 | web | server | 命名风格 | 类型 | 可选性 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| §2.1 `AlarmPolicyCondition` | 12 | 12 | 12 | ✅ camelCase 一致 | ✅ `operator` 两侧均 `string` | ✅ `id?` 仅响应；`Payload` 类型把 `metricNameCn/unit` 降为可选、`id` 剔除 | 通过 |
| §2.2 `AlarmPolicyListItem` | 17 | 17 | 17 | ✅ | ✅ | ✅ | 通过 |
| §2.3 `AlarmPolicyDetail`（= §2.2 + 6） | 6 增量 | 6 | 6 | ✅ | ✅ | ✅ | 通过 |
| §2.4 `AlarmConditionTemplate` | 9 | 9 | 9 | ✅ | ✅ | ✅ | 通过 |
| §2.5 `AlarmNotificationTemplate` | 8 | 8 | 8 | ✅ | ✅ | ✅ | 通过 |
| §2.5 `NotificationChannel` | 4 | 4 | 4 | ✅ | ✅ | ✅ `callbackUrl: string \| null` 三边一致 | 通过 |
| §2.6 `AlarmHistory` | 28 | 28 | 28 | ✅ | ✅ | ✅ `actualValue:number\|null`、`recoveredAt/handledAt/handleAction` 可空、`handlerName/handleRemark` 非空 | 通过 |
| §2.7 `AlarmMetric` | 10 | 10 | `MetricDictionary` + `config/autoload/metrics.php` | ✅ | ✅ | ✅ | 通过 |

**命名风格**：DB 是 snake_case（`monitor_type` / `metric_name_cn` / `notification_template_ids`），
API 是 camelCase，`Model $fillable` 与 `Presenter` 逐字段做了这一跳映射，**无一处漏映射或多映射**。
`schema.sql` 6 张表与 6 个 Model 的列名**零漂移**（`id`/`created_at`/`updated_at` 不在 `$fillable` 属正确设计）。

**关键差异点（请求侧 vs 响应侧，已核对）**：
- `AlarmPolicyCondition.id` —— 响应必返、请求必须省略；前端用独立的 `AlarmPolicyConditionPayload` 类型（`Omit<…, 'id'|'metricNameCn'|'unit'> & Partial<…>`）在**编译期**挡住误传
- `NotificationChannel.callbackUrl / silenceTime` —— 响应必填、请求可选；前端用 `NotificationChannelPayload` 区分
- `metricNameCn / unit` —— 契约允许前端带上但后端一律忽略；前端**选择不提交**，与契约 ③ 官方示例请求体一致
- `isPreset` —— 通知模板「请求体传入无效」；前端 `validateTemplateDraft` 确认不写入 payload

### 2.3 枚举矩阵（12 组 + 3 项派生，全部逐值核对）

| 契约小节 | 枚举 | contract | web (`alarm.ts`) | server (`AlarmEnum.php`) | 结论 |
| --- | --- | --- | --- | --- | --- |
| §1.1 | `monitorType` | 1,2,3,4,5 | 1,2,3,4,5 | 1,2,3,4,5 | ✅ |
| §1.2 | `policyType` | 1,2,3,4 | 1,2,3,4 | 1,2,3,4 | ✅ |
| §1.3 | `level` | 1,2,3 | 1,2,3 | 1,2,3 | ✅ |
| §1.4 | `period` | 1,5,10,30,60 | 1,5,10,30,60 | 1,5,10,30,60 | ✅ |
| §1.5 | **`operator`** | `> >= < <= == !=` | `> >= < <= == !=` | `> >= < <= == !=` | ✅ **三边均无数字假设** |
| §1.6 | `frequency` | 0,5,15,30,60,180,360,720,1440 | 同 | 同 | ✅ 含扩展值 `0` |
| §1.7 | `objectType` | 1,2,3,4 | 1,2,3,4 | 1,2,3,4 | ✅ |
| §1.7 | `matchType` | include,exclude | include,exclude | include,exclude | ✅ |
| §1.8 | `conditionLogic` | 1,2 | 1,2 | 1,2 | ✅ |
| §1.9 | `status` | 0,1 | 0,1 | 0,1 | ✅ |
| §1.10 | `historyStatus` | 1,2,3,4 | 1,2,3,4 | 1,2,3,4 | ✅ |
| §1.11 | `notifyChannel` | 1..5 | 1..5 | 1..5 | ✅ |
| §1.12 | `handleAction` | handle,ignore,recover | 同 | 同 | ✅ |
| §1.1 | monitorType→policyType 联动 | 1→[2,3,4], 2→[1], 3/4/5→[] | 同 | 同 | ✅ |
| §1.12 | handleAction→status | 2,3,4 | 2,3,4 | 2,3,4 | ✅ |
| §0.5 | 错误码 | 0,401,403,404,409,422,500 | 同 | 同 | ✅ |

**`operator` 专项（三方 grep + 运行时）**：
- web：`ALARM_OPERATOR` 为字符串字面量对象；`policy-logic.ts:195` `describeCondition` 直接插值符号；
  `policy.validator.ts:99-102` 用 `enumOf(Object.values(ALARM_OPERATOR))` 走 `z.custom`（不是 `z.enum`，
  注释已说明 zod v4 的 `z.enum` 对数值枚举会判失败）；`objectFilters[].operator` 同走字符串校验
- server：`AlarmEnum::OPERATOR = ['>', '>=', '<', '<=', '==', '!=']`；
  `ConditionValidator.php:112` `assertStringEnum(...)`（注释明确写了「不能用数值枚举的判定方式」）；
  `PolicyPayloadValidator.php:204` `is_string($operator) && in_array(…, true)`
- 全仓 grep：`web` 侧**无**任何 `operator: number` / `Number(operator)` / 数值集合包含 operator 的写法
- 运行时 A1：`toAlarmOperator('>')='>'` … `toAlarmOperator(1)=undefined`、`toAlarmOperator('大于')=undefined`

### 2.4 响应信封与分页

| 契约 | web | server | 结论 |
| --- | --- | --- | --- |
| §0.2 `{data, extra, code, message, success}` | `IResponse<T>`（契约要求「不要动」，已核对未动） | `Support/Response.php::json()` 逐字段构造 | ✅ |
| §0.2 失败时 `data` 恒为 `null` | 所有调用点先判 `res.success` | `fail()` 显式传 `$data = null` 默认值 | ✅ 实测 404/409 响应 `data:null` |
| §0.2 `extra` 成功为 `{}` | — | `(object) $extra` 保证 JSON 里是 `{}` 而非 `[]` | ✅ 实测 `extra={}` |
| §0.2 HTTP 码 == 业务码 | — | `withStatus($code === 0 ? 200 : $code)`，注释解释了 0 非法 | ✅ |
| §0.2 `message` 中文可读 | 直接 `toast` 展示 | `ErrorCode::message()` | ✅ |
| §0.3 `{list,total,page,pageSize}` | `AlarmPage<T>` | `Response::paginated()` | ✅ 6 个读接口实测均为分页对象，无裸数组 |
| §0.3 `page` 从 1 开始 | 前端 0-based `pageIndex` +1 换算 | `PAGE_DEFAULT=1` | ✅ |
| §0.3 `pageSize` 1..100 越界 422 | — | `Pagination::fromRequest` 校验 | ✅ |
| §0.3 分页非数字 → 422 | 前端非法值不进 query | `intParam()` 对 `abc/1.5/1e3/[]` 记 422 错误 | ✅ |
| §0.4 422 的 `extra.errors` 点分路径 | 读取路径与契约示例一致 | `Validator::add('conditions.0.threshold', …)` 形式 | ✅ |

### 2.5 §0.6 JSON 空值归一化（最易错处）

| DB 列 | 契约声明 | **读（DB→API）** | **写（API→DB）** | 结论 |
| --- | --- | --- | --- | --- |
| `object_ids` | `null` | `Presenter::nullableIntList()`：`null` → `null` | `assertObjectBinding` 返回 `null`，`normalizeJsonForWrite` 再兜一层 | ✅ |
| `object_group_ids` | `null` | 同上 | 同上 | ✅ |
| `object_filters` | `null` | 同上（`$policy->object_filters === null ? null : array_values(…)`） | 同上 | ✅ |
| `notification_template_ids` | **`[]`** | `Presenter::intList()`：`null` → `[]` | `[]`/`null` 均落 `NULL` | ✅ |
| `conditions` | 必填 1-4 | 直传 + 补 `id=0`、按 `sort` 升序 | 直传，不接受 null | ✅ |
| `channels` | 必填 1-5 | `normalizeChannels()` 补齐 4 字段 | 直传 | ✅ |

- **R-JSON-1（三个 object 字段读出永远是 `null`）**：后端 `nullableIntList` 返回 `?array` 且 `$value === null` 时返回 `null`；
  前端类型是 `number[] | null`，渲染前判空 —— 实测 S1.6 `objectGroupIds=null objectFilters=null`
- **R-JSON-2（`notificationTemplateIds` 读出永远是数组）**：后端 `intList` 兜底 `[]`；前端类型 `number[]`，不判空 —— 实测 S1.1 `[3,5]`
- **R-JSON-3（标量列 DB DEFAULT 不是契约默认值）**：`AlarmPolicyService` 的 `store/update` 显式写入
  `monitor_type/object_type/level/sort/frequency`，未依赖 DB 补值；P10 缺字段 422（实测 A5，9 个字段逐一验证）
- **写侧归一化**：`AlarmPolicy::normalizeJsonForWrite()` 对 4 个 JSON 列统一 `null|[] → NULL`，
  避免库里出现字面量 `null` 字符串破坏 `JSON_CONTAINS`（⑯ 的引用检查依赖它）

### 2.6 业务规则落地矩阵（§4 的 P/T/N/H 条）

| 规则 | 契约 | 前端实现 | 后端实现 | 验证方式 | 结论 |
| --- | --- | --- | --- | --- | --- |
| P1 名称 1-128 去空格、全局唯一 | 1-128、409 | `normalizePolicyName`+`isValidPolicyName` | `POLICY_NAME_MAX=128` + `nameExists` + `POLICY_NAME_DUPLICATED` | A9 运行时 + 静态 | ✅ |
| P2 remark ≤500 | ≤500 | `isValidPolicyRemark` | `REMARK_MAX=500` | A9 运行时 | ✅ |
| P3 monitorType↔policyType | 联动表 | `getPolicyTypeOptions` + `superRefine` | `MONITOR_TYPE_POLICY_TYPES` 写死 | A3 运行时（错配/3-4-5 均拒） | ✅ |
| P4 conditions 1-4 条 | 1-4 | `canAdd/canRemoveCondition` + zod `.min/.max` | `CONDITION_MIN/MAX` | S2.2、S5.4 | ✅ |
| P5 sort 1..N 连续不重复 | 连续升序 | `refine(c.sort === index+1)` | `conditionsSchema` 等价校验 | A6（`[1,2]`✓ `[1,1]`✗ `[1,3]`✗ `[0,1]`✗） | ✅ |
| P6 threshold 可负、≤4 位小数 | 可负/4 位 | `hasValidThresholdDecimals`（字符串判定，规避浮点误差） | `THRESHOLD_SCALE=4` | A4（负数✓ 4 位✓ 5 位✗） | ✅ |
| P7 continuity ∈[1,10] | [1,10] | zod min/max | `CONTINUITY_MIN/MAX` | A4（0✗ 11✗ 1✓ 10✓） | ✅ |
| P8 period ∈ 枚举且 ⊆ periodOptions | 子集 | `periodSchema` 收窄 + `periodOptionsOf()` 限定下拉 | `PERIOD` + 字典子集校验 | E8 + A4（`period=3`✗） | ✅ |
| P9 operator ∈ 6 个符号 | 符号字符串 | `operatorSchema` 字符串枚举 | `assertStringEnum` | A1 运行时 + A5 | ✅ |
| P10 条件 9 字段缺一即 422 | 缺一 422 | zod 逐字段必填 | `ConditionValidator` | **A5：9 个字段逐一删除，全部被拒** | ✅ |
| P11 level/frequency 枚举 | 1-4 / 1.6 | `levelSchema`/`frequencySchema` | `assertEnum` | A2（`level=4`✗ `frequency=7`✗ `0`✓） | ✅ |
| P12 最多 3 个通知模板 | ≤3 | `MAX_NOTIFICATION_TEMPLATES=3` | `NOTIFICATION_TEMPLATE_MAX=3` | S2.4 + E7 | ✅ |
| P13 不重复 + 须存在 | 唯一 + 存在 | `validateNotificationTemplateIds` | `in_array` 去重 + `array_diff` 存在性 | E7（4 个同时报出「超 3」「重复 3」「不存在 7」） | ✅ |
| P14 objectType 四方向一一对应 | 一一对应 | `resolveObjectBinding` + `collectObjectBindingErrors` + `superRefine` | `assertObjectBinding` 四个分支 | **E6：1→全 null，2→objectIds，3→objectGroupIds，4→objectFilters** | ✅ |
| P15 仅停用可删 | 409 | `canDeletePolicy` 禁用按钮 + `describePolicyDeleteFailure` | 先 404 再 409 | S1.4 | ✅ |
| P16 复制不继承 id/创建人、status=0 | — | `buildCopyName` + 新建表单 | `status=0`、`creator_*=$currentUser` | E3 + S2.6 | ✅ |
| P17 策略 level = min(条件 level) | — | — | `store/update` 由条件派生 | 静态核对 | ✅ |
| P18 PUT 全量、status 唯一不回落 | 全量 | `buildPolicyPayload(v,'update')` 省略 status | `UPDATE ... status` 不在 SET 列表 | S5.1（conditions=2、无 status） | ✅ |
| P19 ⑥ 幂等 | 幂等 | — | 不对相同值报错 | 静态核对 | ✅ |
| T1/T3 条件模板名唯一、namespace 归属 | — | — | 模板 Service + `assertNamespaceBelongs` | 静态核对 | ✅ |
| T4/T5 预置不可删、被引用不可删 | 409 | 删除按钮按 `isPreset` 禁用 | `PRESET_READONLY` / `TEMPLATE_IN_USE` | 静态核对 | ✅ |
| N1/N2 名称 1-64 唯一、渠道 1-5 不重复 | — | `validateTemplateDraft` + `buildChannelsPayload` 去重 | `TEMPLATE_NAME_MAX=64`、`CHANNEL_MIN/MAX` | S3.3 | ✅ |
| **N3 回调必填 URL + receivers 必须空** | 422 | `validateTemplateDraft` 校验 URL；`draftToPayloadChannel` 强制 `receivers:[]` | `CHANNEL_CALLBACK` 分支校验 | S3.3 / S3.3b（见 §3 问题 1） | ⚠️ 见问题 1 |
| **N4 非回调 callbackUrl 必须 null** | 422 | 非回调强制 `null` | 校验非回调不得带 URL | S3.3（`ftp://`✗ / 非回调带 URL✗ / 归一化 `null`✓） | ✅ |
| N5 receivers 0-100 + 格式 | 0-100 | `validateReceiver` 邮箱/手机号正则 | `RECEIVER_MIN/MAX` + 格式校验 | S3.3 | ✅ |
| **N9 绑定时拒绝未配置完成的模板** | 422 + 点名 | `collectNotificationBindingErrors` | `isUnconfigured` + `implode('、', $names)` | **E7 实测点名「系统预置-邮件通知」** | ✅ |
| N6 silenceTime ∈[0,1440] | 0-1440 | `SILENCE_TIME_MIN/MAX` | 同 | S3.3（1441✗） | ✅ |
| N7/N8 预置不可删、被引用不可删 | 409 | — | 删除前置校验顺序 | S3.2 实测 409 | ✅ |
| H1 action ∈ 3 值 | 422 | `HANDLE_ACTIONS` | `isset(AlarmEnum::HANDLE_ACTION[$action])` | S4.4 | ✅ |
| H2 remark ≤500 | 500 | `validateHandleRemark` | `Text::length > REMARK_MAX` | 静态核对 | ✅ |
| **H3 仅未处理可处理，否则 409** | 409 | 非未处理行禁用操作按钮 | 先 `findOrFail` → 再 `status !== 1 → 409`，UPDATE 带 `status=1` 守卫 + `affected_rows` 二次确认 | **S4.5：已忽略→已处理 = 409** | ✅ |
| H4 startTime ≤ endTime | 422 | 本地拦截**不发请求** | 服务端二次校验 | S4.3 | ✅ |
| H5 历史无删除端点 | — | 页面无删除按钮 | 无 DELETE 路由 | 端点矩阵确认 | ✅ |

### 2.7 其它三方一致性

| 项 | 结论 |
| --- | --- |
| `metrics.md §1` ↔ `server/config/autoload/metrics.php` | **28 条 / 28 条**，`metricNameCn`/`unit`/`policyType`/`periodOptions`/`defaultOperator`/`defaultThreshold`/`suggestedContinuity` 七个字段**逐条相同** |
| `schema.sql` ↔ 6 个 Model | 6 张表列名**零漂移**；JSON 列均在 `$casts` 中声明 |
| `schema.sql` CHECK 约束 | **29 条 `ck_*`**，与 `RESUME.md` 期望一致 |
| 生产构建 mock 开关 | `.env` = `VITE_USE_MOCK=false`；`EnvSchema` 默认 `'false'`→`false`；构建产物中编译为 `VITE_USE_MOCK:!1`（false）。**生产构建不可能默认走 mock** |

### 2.8 矩阵通过率

| 维度 | 项数 | 通过 | 漂移 | 已修复 | 通过率 |
| --- | --- | --- | --- | --- | --- |
| 端点 | 19 | 19 | 0 | 0 | **100%** |
| DTO 字段组 | 8 | 8 | 0 | 0 | **100%** |
| DTO 字段数 | 94 | 94 | 0 | 0 | **100%** |
| 枚举组 | 12 | 12 | 0 | 0 | **100%** |
| 派生映射 | 3 | 3 | 0 | 0 | **100%** |
| 响应信封/分页 | 10 | 10 | 0 | 0 | **100%** |
| §0.6 归一化 | 6 | 6 | 0 | 0 | **100%** |
| 业务规则（P/T/N/H） | 42 | 42 | 0 | 0 | **100%** |
| 指标字典 | 28 | 28 | 0 | 0 | **100%** |
| DDL 列 | 6 表 | 6 | 0 | 0 | **100%** |
| **合计** | **228** | **228** | **0** | **0** | **100%** |

> ⚠️ 「100%」的含义是**静态比对 + 前端运行时验证均未发现漂移**，
> 不等于后端运行时正确 —— 见 §5 遗留风险第 1 条。

---

## 3. 发现的问题清单（按严重度排序）

> **本次审计未修改任何项目文件。** 以下均为观察项，其中无一构成「契约漂移」。

### 🔴 严重（阻断验收）

**无。**

### 🟠 中等

#### 问题 1：回调渠道填了接收人时**静默丢弃**，用户无任何提示

- **文件:行号**：`web/src/pages/alarm/notification-template/logic.ts:190-208`（`draftToPayloadChannel`）
- **问题**：契约 N3 要求 `channel=5`（回调）时 `receivers` **必须为空**，违反返回 422。
  前端既不报校验错误、也不提示，直接在 `draftToPayloadChannel` 里
  `receivers: isCallback ? [] : receivers` 把用户输入**丢弃**。
  实测：草稿 `receivers: ['should-be-dropped']` → 提交 payload `receivers: []`，且 `validateTemplateDraft` 返回 `ok: true`。
- **契约依据**：§2.5 `NotificationChannel.receivers`「`channel=5`（回调）时必须为 `[]`」；§4.3 N3；§0.6
- **是否违约**：**否**。线上 payload 是 `receivers: []`，完全符合契约，不会触发后端 422。
- **实际影响**：**UX / 数据丢失**。用户在回调渠道里填了接收人，点保存后内容无声消失，且再次打开表单也是空的，
  用户会以为是自己没保存成功。属于「用户明确表达的数据被丢弃且无反馈」。
- **建议修法**（未实施，仅建议）：在 `validateTemplateDraft` 中对 `channel === 5 && receivers.length > 0`
  追加一条 `{ field: 'channels.N.receivers', message: '回调渠道不支持接收人，请填写回调 Webhook URL' }`，
  与已实现的「回调缺 URL」提示对称。**一行改动，风险极低。**

#### 问题 2：新建 / 编辑向导的 DOM 绑定**零自动化覆盖**

- **文件:行号**：`web/src/pages/alarm/policy/components/policy-form.vue`（1517 行，全文件）
- **问题**：全仓 `grep -rln "useForm|@tanstack/vue-form" src --include=*.test.ts` → **0 命中**。
  419 个测试中**没有任何一个挂载 `policy-form.vue`**。
- **契约依据**：§3.1 ③④（创建/全量更新是本模块最复杂的两个端点）、P4/P5/P10/P14/P18
- **实际影响**：向导的**契约关键逻辑**（回填、组装、校验、PUT 语义）本次已通过真实函数链验证通过，
  但**表单 ↔ DOM 的双向绑定**（输入框 → `form.setFieldValue`、下一步 → `validateStep`、
  提交 → `onSubmit`）没有自动化证据。§1.3 已说明本次也无法用冒烟补上（vue-form 在 happy-dom 下无响应性）。
- **建议修法**（未实施）：在有真实浏览器（Playwright/Vitest browser mode）的环境补一条
  挂载 `policy-form.vue` 的组件测试，覆盖「填名称 → 下一步 → 拦截 → 选指标 → 提交」主链路。

### 🟡 低

#### 问题 3：mock 层能力远低于真实后端，易被误读为 bug

- **文件:行号**：`web/src/mocks/index.ts:26` / `router.mock.ts:100`
- **问题**：mock **丢弃 query**（列表筛选/分页不生效）、**只注册 6 个读接口 + 2 个删除 + 1 个处理**，
  `/metrics` 只给 1 条（真实 28 条）；任何未注册端点返回 404 契约信封。
- **实际影响**：**非缺陷**（任务书已列为已知限制）。但需注意：§1.3 的冒烟中
  「启停」走的是 404 失败路径，「复制 / 提交」并未真正打到后端语义。
- **建议**：在 `INTEGRATION.md` 与 `README` 中保留该说明（本文档已记录）。

#### 问题 4：契约 §2.8 自身的自检算式与实测不符（**未修改契约，仅报告**）

- **文件:行号**：`docs/alarm/contract.md:478`
- **问题**：原文「合计 **4** 个内部列（字段一致性自检按 `45 − 4 = 41` 组计）」。
  按 §2 逐表实测，唯一字段总数为 **94**
  （Condition 12 + Detail 17+6 + CondTemplate 9 + NotifTemplate 8 + NotifChannel 4 + History 28 + Metric 10），
  扣掉 4 个内部列后为 **90**，与「45 − 4 = 41」不符。
- **判定**：**不影响任何实现**。DTO 已逐字段三方核对通过（§2.2）。`41` / `45` 疑为早期版本遗留的自检口径。
- **处置**：**按任务要求「不擅自改契约」**，此处**仅报告**。若要订正，建议改为「字段一致性自检按 94 − 4 = 90 组计」。

### ⚪ 提示（无需动作）

- `contract.md §4.3` 中 **N9 插在 N5 与 N6 之间**，编号顺序与列举顺序不一致（不影响实现）。
- `server/README.md` / `web` 的 `dist/` 中残留旧构建产物（`dist/` 由本次 `pnpm build` 重新生成）。

---

## 4. 验证证据

### 4.1 收尾四命令（真实退出码）

```
which pnpm => /usr/local/bin/pnpm
pnpm --version => 11.27.1
LINT=0
TEST=0
TSC=0
BUILD=0
```

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `pnpm lint` | **0** | 无任何输出（clean） |
| `pnpm test:run` | **0** | `Test Files 21 passed (21)` / `Tests 419 passed (419)` / `Duration 78.94s` |
| `pnpm exec vue-tsc -b --force` | **0** | 输出为空 → `grep -c "error TS"` = 0（**且退出码 0 证明命令真的跑了，不是 127**） |
| `pnpm build` | **0** | `✓ built in 47.73s` |

> 127 陷阱已规避：先 `corepack enable && corepack prepare pnpm@11.27.1 --activate`，
> 并以 `which pnpm` + `pnpm --version` + 每条命令的真实 `$?` 三重确认。

### 4.2 五个静态审计脚本（各自退出码 0）

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `enum2.py` | 12 组枚举 + matchType + 2 个派生映射，三方逐值 | `EXIT=0` — PASS |
| `ep.py` | 19 个端点 URL/method，web ↔ server ↔ 契约 | `EXIT=0` — PASS，零多余零缺失 |
| `fields.py` | 8 组 DTO / 94 字段，三方（自动解析 `extends` mixin 与 `$var['k']=` 赋值两种写法） | `EXIT=0` — PASS |
| `metrics.py` | `metrics.md §1` ↔ `config/autoload/metrics.php`，28×7 字段 | `EXIT=0` — PASS |
| `schema2.py` | `schema.sql` ↔ 6 个 Model，列名 + JSON cast | `EXIT=0` — PASS |

> 脚本在开发过程中先后报出 13 / 19 / 5 / 2 处「漂移」，逐条追查后**全部确认为解析器缺陷**
> （契约表头行漏采、TS `extends` mixin、PHP `1 => 'x'` 无引号数值键、CJK 正则、缺 `re.S`），
> 修正解析器后复跑均为 0。**这几次「假阳性」是本次审计最需要记录的部分**：
> 若只看脚本输出就下结论，会凭空报出 39 处不存在的漂移。

### 4.3 对抗性探针（9 项全通过）

| 探针 | 内容 | 结果 |
| --- | --- | --- |
| A1 | **operator 按数字处理**（历史致命 bug 的回归探针） | 6 符号全收窄成功；`1`/`0`/`'大于'`/`'GT'`/`''`/`'=>'` 全部 `undefined` ✅ |
| A2 | 枚举越界值 | `level=4`✗ `status=2`✗ `channel=6`✗ `objectType=0`✗ `period=7`✗ `frequency=7`✗；`frequency=0`✓ `frequency=1440`✓ ✅ |
| A3 | P3 联动 + monitorType 3/4/5 无可用类型 | 错配✗ 正确✓ 无可用✗（文案「该监控类型在 v1.0 暂无可用策略类型」）✅ |
| A4 | P6 负数/小数位 + P7 边界 + P8/P11 越界 | `-12.5`✓ `1.2345`✓ `1.23456`✗ `continuity 0/11`✗ `1/10`✓ `period=3`✗ `level=4`✗ ✅ |
| A5 | **P10 缺任一必填字段** | 9 个字段逐一删除，**9/9 全部被拒** ✅ |
| A6 | P5 sort 连续性 | `[1,2]`✓ `[1,1]`✗ `[1,3]`✗ `[0,1]`✗ ✅ |
| A7 | 非法筛选值污染 query | `projectId:"abc"` 被剔除；空筛选 → `{page:1,pageSize:20}` ✅ |
| A8 | N3/N6 回调与静默时间 | `ftp://`✗ 514 字符✗ `silenceTime=1441`✗ ✅ |
| A9 | P1/P2 名称与备注边界 | 128 汉字✓ 129✗ 空串✗ 全空格✗ 去首尾空格✓；500✓ 501✗ ✅ |

### 4.4 生产构建 mock 开关

```
$ grep -o 'VITE_USE_MOCK:!1' dist/assets/*.js
VITE_USE_MOCK:!1, gn=mn.safeParse({BASE_URL:`/`,DEV:!1,MODE:`production`,
```

```
$ grep VITE_USE_MOCK /workspace/web/.env
VITE_USE_MOCK=false
```

`src/utils/env.ts` 的 `FALLBACK_ENV.VITE_USE_MOCK = false`；
`src/validators/env.validator.ts` 用字符串比较而非 `z.coerce.boolean()`
（注释已说明 `Boolean('false') === true` 的坑）。**三层兜底，生产构建不可能默认走 mock。**

---

## 5. 遗留风险

### 风险 1（最高）：后端**完全没有任何运行时验证**

**这是本次交付最大的未覆盖面。**

- 沙箱内**无 PHP / composer / MySQL / Redis**
- `composer install`、`migrate`、`start`、**109 个 phpunit 测试**（4 个测试文件 / 109 个 test 方法）**一次都没执行过**
- 本报告中所有后端结论均来自**静态比对**（逐行阅读 + 脚本交叉验证）
- 因此以下几类问题**静态审查无法发现**，必须首次本地启动后才能确认：
  1. **路由是否真的注册成功**。`routes.php` 19 行注册写法正确、`addGroup('/api/alarm', …)` 的位置参数签名已核对
     （历史上曾误写成 `addGroup(['prefix'=>…])` 导致 `TypeError`、19 个端点全注册不上），
     但**只有真正启动才能证明 19 条路由全部生效**
  2. **DB 交互层**：`JSON_CONTAINS` 引用检查、`ON DUPLICATE` / 事务边界、`affected_rows` 守卫、
     `DECIMAL(20,4)` → PHP `string` → `(float)` 转换、`utf8mb4` 实际排序与 `CHAR_LENGTH` 行为
  3. **中间件与鉴权**：`401/403` 的实际触发、`Authorization: Bearer` 解析
  4. **Hyperf 容器注入**：Controller → Service → Model 的依赖注入是否全部解析成功
  5. **`extra.errors` 的实际 JSON 形状**（`(object)` 强转在嵌套数组下的表现）

### 风险 2：DDL 从未在真实 MySQL 上执行

`schema.sql` 含 **29 条 CHECK 约束**。MySQL **≥ 8.0.16** 才真正执行 CHECK；
更早版本会**静默忽略全部 29 条且不报错**。首次运行必须按 §6 第 1、2 步验证。

### 风险 3：向导表单绑定的运行时证据缺失

见 §3 问题 2 与 §1.3。逻辑层已验证，DOM 绑定层**没有**任何自动化证据。

### 风险 4：端到端链路从未「双端同跑」

本次是「真实前端 + mock 后端」。**真实前端 + 真实后端**的联调**一次都没有做过**，
两侧各自的正确性都有证据，但**交界处**（例如 Hyperf 的 JSON 序列化细节、
`extra` 空对象 vs 空数组、前端 `ofetch` 对非 2xx 的处理）仍属未验证区。

### 风险 5：契约 §2.8 自检算式陈旧

见 §3 问题 4。仅文档层面，不影响实现。

---

## 6. 用户首次在本地的运行步骤

### 6.1 后端（Hyperf + MySQL）

> 沙箱无法验证，以下命令**基于项目配置推导**，请以实际报错为准。

```bash
# ── 0. 环境要求 ──────────────────────────────────────────────
#   PHP >= 8.1（swoole 扩展）、Composer 2.x、MySQL >= 8.0.16
php -v && composer -V && mysql --version
php -m | grep -i swoole        # 必须有，否则 Hyperf 起不来

# ── 1. 建库并导入 DDL（含 29 条 CHECK 约束）──────────────────
mysql -u root -p -e "CREATE DATABASE alarm DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p alarm < docs/alarm/schema.sql

# ── 2. 验证 CHECK 约束真的生效（期望返回 29，返回 0 说明 MySQL < 8.0.16，
#      29 条约束被静默忽略且不报错）──────────────────────────
mysql -u root -p -e "
  SELECT COUNT(*) AS check_constraints
  FROM information_schema.CHECK_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = 'alarm';"
#   MySQL < 8.0.16 请升级，否则整条防线失效

# ── 3. 安装依赖 ──────────────────────────────────────────────
cd server
composer install

# ── 4. 配置 ──────────────────────────────────────────────────
cp .env.example .env      # 若无 .env.example，按下表手写
#   DB_DRIVER=mysql
#   DB_HOST=127.0.0.1
#   DB_PORT=3306
#   DB_DATABASE=alarm
#   DB_USERNAME=root
#   DB_PASSWORD=<你的密码>
#   APP_ENV=dev

# ── 5. 跑后端测试（109 个，此前从未执行过）──────────────────
composer test            # 或 ./vendor/bin/phpunit

# ── 6. 启动 ──────────────────────────────────────────────────
php bin/hyperf.php start
#   ⚠️ 启动后第一件事：确认 19 个端点真的注册成功
curl -s http://127.0.0.1:9500/api/alarm/overview | head
#   期望：{"data":{...},"extra":{},"code":401,...}（无 token 时 401 说明路由通）
```

### 6.2 前端（Vue 3 + Vite）

```bash
# ── 1. 激活 pnpm（沙箱每次重启都会丢，务必先做）──────────────
corepack enable && corepack prepare pnpm@11.27.1 --activate
pnpm --version            # 必须是 11.27.1；若报 127 说明没激活成功

cd web
pnpm install

# ── 2. 接真实后端（.env 默认 VITE_USE_MOCK=false，保持即可）──
grep VITE_USE_MOCK .env   # 期望 false
#   API 前缀 = VITE_SERVER_API_URL + VITE_SERVER_API_PREFIX
#   默认 http://localhost:3000 + /api
#   ⚠️ Hyperf 默认监听 9501 端口，请把 VITE_SERVER_API_URL 改成 http://localhost:9501

# ── 3. 开发模式（接真实后端）─────────────────────────────────
pnpm dev                  # http://localhost:5173
#   登录后进入：侧边栏「告警管理」→ 告警策略 / 通知模板 / 告警历史

# ── 4. 无后端时用 mock 跑通页面 ─────────────────────────────
#   临时：VITE_USE_MOCK=true pnpm dev
#   注意：mock 会丢弃 query（筛选/分页不生效）、/metrics 只有 1 条
#         （真实 28 条以 docs/alarm/metrics.md 为准）

# ── 5. 验收四命令 ────────────────────────────────────────────
pnpm lint;                echo "LINT=$?"
pnpm test:run;            echo "TEST=$?"
pnpm exec vue-tsc -b --force; echo "TSC=$?"
pnpm build;               echo "BUILD=$?"
#   ⚠️ 任何一条出现 127 = pnpm 没激活，不是「零错误」

# ── 6. 建议的首次冒烟顺序 ────────────────────────────────────
#   ① 告警策略列表 → 新建策略（三步向导，选指标自动预填 operator/threshold）
#   ② 编辑刚建的策略（确认回填完整，PUT 全量更新）
#   ③ 通知模板 → 建一个带接收人的模板 + 一个回调渠道模板（填 URL）
#   ④ 回到策略第 3 步绑定模板 → 验证 N9：绑未配接收人的预置模板应被点名拒绝
#   ⑤ 启用策略 → 尝试删除 → 应被 P15 拦截；停用后可删
#   ⑥ 告警历史 → 三种处理动作；对已处理记录再次处理应得 409
```

### 6.3 首次启动后请优先回报这三项

1. `composer test` 的 109 个测试结果（此前从未运行）
2. `curl /api/alarm/overview` 是否返回 401（证明路由注册成功）
3. `SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS` 是否为 29

---

## 7. 审计方法学附注（可复现）

全部审计脚本位于 `/tmp/audit/`（**不在仓库内**，本次未改动任何项目文件）：

```
/tmp/audit/enum2.py       12 组枚举三方逐值比对
/tmp/audit/ep.py          19 个端点三方比对
/tmp/audit/fields.py      8 组 DTO / 94 字段三方比对
/tmp/audit/metrics.py     metrics.md ↔ metrics.php（28×7）
/tmp/audit/schema2.py     schema.sql ↔ Model 列名 + JSON cast
/tmp/audit/vitest.smoke.config.ts   真实页面挂载配置（VITE_USE_MOCK=true）
/tmp/audit/*.smoke.test.ts         冒烟 + 对抗性探针
```

复现方式：

```bash
cd /workspace/web
corepack enable && corepack prepare pnpm@11.27.1 --activate
for f in enum2 ep fields metrics schema2; do
  printf "%-10s " "$f"; python3 /tmp/audit/$f.py >/dev/null 2>&1; echo "EXIT=$?"
done
pnpm exec vitest run --config /tmp/audit/vitest.smoke.config.ts
```

---

## 补充：owner 复核后的追加修复（2026-10-02）

审计结论为「228 项全过、0 漂移、0 严重问题」，其中中等问题 M1 已由 owner 复核并修复：

**M1 — 回调渠道误填接收人被静默丢弃**（`web/src/pages/alarm/notification-template/logic.ts`）
- 原行为：payload 归一化会把回调渠道的 `receivers` 强制清空（正确，N3 要求），
  但草稿校验**无任何提示**——用户填的接收人无声消失，不报错、不提示。
- 判断：这比报错更危险。用户以为配好了，实际一条也发不出去。
- 修复：**payload 行为完全不变**（接收人一定清空，绝不带脏数据到后端），
  草稿校验新增对称提示，与已有的 N4 分支（非回调渠道填 callbackUrl 会报错）逻辑对齐。
- 测试：4 条回归用例（误填报错 / 空白接收人不误报 / 正确用法通过 / N4 对称性）。
  同时修正了原 `n3` 用例——它把「校验通过」当作正确行为断言，与新行为冲突；
  现拆为「payload 仍清空」+「草稿应报错」两条断言，两侧都被钉住。
- 提交：`00c3ec8`

修复后四项复跑：`LINT=0 / TEST=0(21 files, 424 tests) / TSC=0 / BUILD=0`。

### 一处对审计报告的更正

审计报告称「仓库无 git，无法 diff 证明生成文件逐字节未变」。
经 owner 复核**该结论有误**：`/workspace/web` 是 git 仓库，`src/types/route-map.d.ts` 与
`src/types/auto-import.d.ts` **均被跟踪**；构建后 `git status` 为**空**，
证明这两个文件确实未被构建改动。审计当时的工作目录判断有误。
