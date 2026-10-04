# 攻击前端两条修复：S-02 表单响应式 + Authorization 集成

- 审查者：Verifier（对抗式，默认立场「修复引入了新缺陷」）
- 日期：2026-10-03
- 被审对象：
  - `web/src/pages/alarm/policy/components/policy-form.vue`（S-02：`computed(() => form.state.values)` → `form.useSelector(state => state.values) as Ref<PolicyFormValues>`，第 238 行）
  - `web/src/lib/api-client.ts`（S-10 配套：`onRequest` 钩子第 40-48 行 + `API_TOKEN`）
  - `web/src/lib/__tests__/api-client.auth.test.ts`（新增）
  - `web/src/pages/alarm/policy/__tests__/policy-form.mount.test.ts`（新增）
- 环境：`corepack prepare pnpm@11.27.1 --activate`，pnpm 11.27.1 / node v22.19.0，`web/node_modules` 完整
- 临时攻击测试写在 `web/src/__tmp_attack__/`（4 个文件、26 个用例），**已全部删除**，`git status --short` 与开工前基线逐字节一致（见文末「清理确认」）

> **结论先行：我没能攻破这两条修复。** 26 个对抗探针全部通过，基线四件套全绿。
> 但有 3 个**非阻断**的缺口必须点名，其中 1 个是**产品层缺口而非代码缺陷**：
> **S-10 在仓库所有已提交配置下都是空转的** —— 详见 G-3。

---

## 0. 怎么攻（攻击面清单）

| # | 攻击面 | 方法 | 结论 |
|---|---|---|---|
| A | `setValue` 是否绕过真实打字路径 | 纯 DOM 事件驱动，禁用 `setupState` | 修复前测不出、修复后测得出；测试**没有**自欺欺人 |
| B | 派生 `computed` 是否仍冻结 | 真实 Select 交互 + DOM 文案观测 | 攻击失败（已修好） |
| C | `deep: true` watch / `dirty` | DOM 徽标 + 路由守卫返回值 | 攻击失败（已修好） |
| D | `loadDetail`/`resetForm`/`copyFrom`/`discardChanges` 回填 | mock 详情 + `currentValues()` | 攻击失败（已修好） |
| E | `useSelector` vs `ComputedRef` 语义等价性 | 受控复刻件做机制对照 | **不等价**，但方向对修复有利 |
| F | `onRequest` 是否真被 ofetch 调用 | 真实 `node:http` 服务器，无 `doMock` | 攻击失败（真被调用） |
| G | `Headers` 包装 / mock 分支 / token 捕获 | 网线抓包 + 负对照 | 攻击失败；但 G-3 命中产品缺口 |
| H | `useSelector` 越出作用域 / 卸载泄漏 | 捕获 Vue 全部 warn/error | 攻击失败 |

---

## 1. 针对 S-02

### Check A-1：`setupState.setValue` 是否绕过用户真实打字路径

**Method**：先读代码回答「是否等价」，再用**纯 DOM 事件**独立复现一条不含 `setupState` 的用户路径。

代码层面：`setValue()`（`policy-form.vue:241-243`）只是 `form.setFieldValue(key, value)` 的薄包装。
真实用户的 Select 走 `@update:model-value="(v) => field.handleChange(Number(v) as never)"`（如 `policy-form.vue:936`），
`FieldApi.handleChange` 内部同样落到 `form.setFieldValue`。**同一条 store 入口**。
`name` 字段在生产者的测试里已经走真实 DOM（`policy-form.mount.test.ts:139-141`）。

**Evidence**（我写的 `src/__tmp_attack__/s02-dom.test.ts`，**完全不使用** `setupState` 写值）：

```
[dom] after name typing, input value = 生产 CVM CPU 监控
[dom] select-trigger count on step1 = 4
[dom] monitorType select opened by pointer = true
[dom] visible items = 云产品监控 | 应用性能监控 | 前端性能监控 | 云拨测 | 终端性能监控
[dom] monitorType picked 云产品监控 = true
[dom] trigger[0] text now = 云产品监控
[dom] policyType picked 云服务器 CVM = true
[dom] trigger[1] text now = 云服务器 CVM
[dom] currentValues = {"name":"生产 CVM CPU 监控","monitorType":1,"policyType":2,"projectId":0}
[dom] currentStep after 下一步 = 1
[dom] step0 error text = 
 ✓ 不用 setupState，只用 DOM 事件能否填完第 1 步并推进  891ms
```

用的是 `pointerdown`/`pointerup` + `document.querySelectorAll('[data-slot="select-item"]')`（Reka Select 的内容 Teleport 到 body，`wrapper.find*` 抓不到，必须走 document）。
**只填用户实际能填的 3 个字段**（名称 / 监控类型 / 策略类型），`projectId` 留默认 0。

**Result: PASS** — 纯 DOM 路径下向导**确实推进到第 2 步**（`currentStep === 1`）。

> 顺带纠正一个我自己的假警报：第一版探针我断言 `policyType === 1` 失败、实际拿到 `2`，
> 一度以为是产品 bug。查 `src/types/alarm.ts:113-118` 后确认 `ALARM_POLICY_TYPE.CVM === 2`，
> 是我的断言写错了。**这条我自查掉了，不计入缺陷。**

### Check A-2：回归测试是不是自欺欺人

**结论：不是自欺欺人，但覆盖不完整。**

不欺骗的部分（可证伪）：`policy-form.mount.test.ts:133-154` 真的挂载了真 SFC、真的点 DOM 按钮、
真的断言步骤条当前下标从 0 变 1；`:115-131` 断言的 `currentValues()` 在修复前会返回冻结快照。
我另外验证了这些断言**能失败**：机制对照探针（Check E-2）显示修复前派生值重算次数 = 0。

**不完整的部分（真实缺口，已被我补上验证）**：
该测试只断言 `currentValues()`（一个在事件回调里**非跟踪地**读 `values.value` 的普通函数）。
它**完全没有**覆盖 `values` 真正被响应式消费的两条路径 —— 派生 `computed` 与 `deep: true` watch。
我补的攻击见 B-1 / B-2，两条都通过。

**附带的测试卫生问题（LOW，非阻断）**：
- `policy-form.mount.test.ts` **没有** mock `@/services/api/alarm-policy.api`（`grep -c "alarm-policy.api"` = 0），
  于是 `loadMetrics`/`loadConditionTemplates` 走真实 `apiFetch` → 真实 fetch → `localhost:3000`。
  跑这一个文件时产生 **60 次 ECONNREFUSED**。测试非 hermetic：若开发机上 3000 端口有东西在跑，行为会变。
- 它给 `fetchAlarmNotificationTemplateList` 的 mock 返回 `{code: 0, message: 'ok', data: {...}}`，
  **漏了 `success: true`**（`apiFetch` 信封里 `success` 是必填，见 `src/mocks` 返回体）。
  于是组件走的是 `toast.error('通知模板加载失败')` 分支，通知模板恒为空。
  测试只跑第 1 步所以没暴露，但这个 mock 实际在模拟「一个失败响应」。

**Result: PASS（带 2 条 LOW 卫生问题）**

### Check B-1：派生 `computed(() => values.value.x)` 是否仍冻结

**Method**：`policyTypeOptions`（`policy-form.vue:250-253`）是 `computed(() => values.value.monitorType)` 的下游。
选「前端性能监控」(RUM，`ALARM_MONITOR_TYPE_POLICY_TYPES[3] === []`) 后，模板
`v-if="values.monitorType && !policyTypeOptions.length"`（`:983`）应出现文案「该监控类型在 v1.0 暂无可用策略类型」。
这是**纯 DOM 可观测**的，不依赖 `setupState`。

**Evidence**：
```
[A] monitorType 切到 RUM 后，派生 computed 派生的空列表提示 = true
[A] policyType trigger text = 请选择策略类型
[A] 切回云产品后提示仍在 = false      ← 负对照，证明上一条不是恒真
 ✓ 切到「前端性能监控」→ 派生 computed 应给出空列表 + 提示文案  567ms
 ✓ 切回「云产品监控」→ 提示应消失（证明上一条不是恒真）  633ms
```

**Result: PASS** — 派生 computed 真的跟着 `values` 重算了，且 Select 的 placeholder 也同步变了。

### Check B-2：`watch(values, cb, { deep: true })` → `dirty`

**Method**：`dirty` 的两个用户可见观测点：顶部 Badge「有未保存的修改」（`:850-852`）、
以及 `onBeforeRouteLeave`（`:795-801`）的返回值。两条都走真实 DOM 输入（`#policy-name` 敲 1 个字）。

**Evidence**：
```
[B] 打字 1 字后 dirty badge = true  ss.dirty = true
[B] 改脏后 guard 返回 = false （false = 被拦下）
```
（守卫行为：`guard({path:'/other'})` 干净时返回 `true` 放行，改脏后返回 `false` 拦下。）

**Result: PASS** — `deep: true` watch 真的触发，离开确认链路是通的。

### Check C-1：`loadDetail` / `resetForm` / `copyFrom` / `discardChanges` 是否被改坏

**Method**：mock `fetchAlarmPolicyDetail` 返回一条含 1 条 condition 的完整详情，分别以
`mode=update+policyId` 和 `mode=create+copyFrom` 挂载，再调 `discardChanges`。
除了值正确，**还专门查「回填完会不会误报 dirty」** —— 这是本次改动最可能引入的新缺陷：
`resetForm` 里 `form.reset()` 之后才设 `snapshot`，而 watch 是 `flush:'pre'`（下一轮微任务才跑），
若 `form.reset` 规范化了任何字段，watch 就会算出 `JSON.stringify(currentValues()) !== snapshot` → 刚打开编辑页就弹「确定要离开吗」。

**Evidence**：
```
[C] 回填 name = "源策略" conditions = [{"_key":"c1","sort":1,"metricNamespace":"CVM","metricName":"CpuUsage",...,"frequency":1}]
[C] 回填后 dirty badge = false  ss.dirty = false          ← 关键：没有误报 dirty
[C] copyFrom 后 name = "源策略 - 副本"  status = 0          ← status 被置为 DISABLED
[C] discard 后 name = "源策略"  dirty = false
```
另有 P14 字段联动：
```
[E] objectType=3 后 objectIds = []  objectGroupIds = []
```

**Result: PASS** — 三条回填路径全部正确，且**没有**引入「刚加载就报未保存」的回归。

> 诚实记录一次**我自己制造的假 FAIL**：第一轮这三条全红（`name = ""`）。
> 根因是**我的 mock 漏了 `success: true`**，组件走 `if (!res.success)` 提前 return，`resetForm` 根本没执行。
> 补上 `success: true` 后全绿。这是我的探针 bug，不是产品缺陷，已自查剔除。

### Check D-1：同一 tick 内连续写入是否丢数据

**Method**：`updateObjectFilter`（`:634-639`）是 read-modify-write：
`setValue('objectFilters', values.value.objectFilters.map(...))`。
若 `useSelector` 的 ref 在 store 通知后**不是同步刷新**，同一 tick 内第二次写会读到第一次之前的快照 → 打字丢字。
同步连续调两次（中间不 `await nextTick`）。

**Evidence**：
```
[D] 同 tick 两次写入后 key = "re"
```

**Result: PASS** — `@tanstack/store` 的通知是同步的，`readonly(shallowRef)` 读到的是新值。
（原理见下：form-core 的 `setBy` 每次产出新对象引用 → `useSelector` 的 `a === b` 去重不会误判为「没变」。）

### Check E-1：`useSelector` 返回的 `Ref` 与原 `ComputedRef` 在**所有**用法上等价吗

**Method**：先读库源码定性，再逐个核对 `policy-form.vue` 里 `values` 的每一处用法。

**库源码（决定性）**：
- `node_modules/.pnpm/@tanstack+vue-store@0.11.1/.../src/useSelector.ts:49-58` —
  返回的是 **`readonly(shallowRef)` + `store.subscribe()` 回调**，**不是 computed**；
  且有 `if (compare(toRaw(slice.value), selected)) return` 的 `a === b` 去重。
- `node_modules/.pnpm/@tanstack+form-core@1.33.5/.../dist/esm/FormApi.js:663-668` —
  `setFieldValue` 走 `values: setBy(prev.values, field, updater)`，**每次产出新对象引用**。
  → 所以去重不会误判。这条是整个修复能成立的前提。

逐用法核对（**不等价，但方向对修复有利**）：

| 用法 | 位置 | `ComputedRef`（修复前） | `useSelector`（修复后） | 结论 |
|---|---|---|---|---|
| `watch(values, cb, {deep:true})` | `:512-515` | 永不触发（computed 依赖图为空） | 触发，`dirty` 正确 | **不等价 → 修好了** |
| `computed(() => values.value.x)` ×5 | `:250,255,611,612,680` | 冻结在首次求值 | 正常重算 | **不等价 → 修好了** |
| `JSON.parse(JSON.stringify(values.value))` | `:439-441` | 读到同一对象引用，直接读**本来就**是对的 | 读到新引用 | 等价（这条正是 424 个纯函数测试全绿却漏掉 bug 的原因） |
| 模板直接读 `values.*` | `:964,1029,1089,1232,1391,1451,1475` | 冻结 | 正常 | **不等价 → 修好了** |
| read-modify-write ×7 | `:521-548,622-643,657-678` | 直接读也能工作 | 正常工作 | 等价 |
| `onMounted` 复制路径读 `values.value.name` | `:768` | 能工作 | 能工作 | 等价 |
| `values.value` 赋值 | 全文件无 | — | — | `grep` 确认 0 处 |

**关于 `deep: true` 对 Ref vs ComputedRef 是否一致**：不一致。`ComputedRef` 版本因为上游 computed 永不失效，
watch 永远不触发；`Ref` 版本在上游引用变化时触发。由于 form-core 的 `setBy` 总是产出新引用，
两者在本代码库的行为差异只体现为「一个坏、一个好」。

**一个潜在脆弱点（LOW）**：`deep: true` 只能感知**引用替换**。若将来 form-core 或某处改成**原地修改**
`state.values` 而不换引用，`dirty` 会静默失效。当前代码路径（`setFieldValue` / `reset`）都换引用，故当前安全。

**Result: PASS（语义不等价，但差异全部是「修复前坏 → 修复后好」）**

### Check E-2：`useSelector` 是组合式函数，会不会在生命周期之外被调用

**Method**：源码定位 + 运行时捕获 Vue 的全部 `console.warn`/`console.error`（挂载 → 打字 → 写 conditions → 卸载 → 卸载后再写一次）。

**源码**：`form.useSelector` 只在 `policy-form.vue:238`（`<script setup>` 顶层，组件 scope 内）调用一次。
`setValue()` 里**没有**再调用 `useSelector` —— store 通知时执行的是 selector 函数 `state => state.values`，
那是一个**普通函数**，不是组合式函数。`useSelector` 内部 `onScopeDispose(() => unsubscribe())`
（`useSelector.ts:53-55`）能正确绑定到组件 scope。

**Evidence**：
```
[H] 捕获 warn 数 = 0  error 数 = 0
[H] 其中与响应式/作用域相关的 = []
 ✓ 挂载→打字→卸载全程不得出现 Vue 响应式告警  367ms
```
（若 `useSelector` 在无 active effect scope 下被调用，Vue 会报 `onScopeDispose() is called when there is no active effect scope`；若订阅未释放，卸载后写会异常。两者都没发生。）

**Result: PASS**

### Check E-3：修复的代价（受控复刻件，**非产品代码**）

**Method**：`⚠️ 复刻件`。同一个 `useForm` 实例，两种写法挂在读 `values` 的 render effect + 派生 computed + `watch(deep)` 上，各写 3 次。

**Evidence**：
```
[F] 3 次写入后：
[F]   写法A(computed, 修复前)  render=0  派生computed重算=0  deepWatch=0
[F]   写法B(useSelector, 修复后) render=3  派生computed重算=3  deepWatch=3
```

结论：修复让三条链路全部恢复；代价是**组件 render 现在会跟着每次字段写入重跑**。
在真实组件上，3 次按键触发子树 **159 次** `updated`（含约 40 个 Reka Select）。

**判定：这是修复的应有代价，不是缺陷**（修复前 `dirty` 恒 false、派生值冻结，本来就是错的）。
但它是一个**行为变化**，值得在评审记录里留痕。**我无法给出真实组件的前后对照**——
那需要改动项目文件（禁止），故此处只有机制级复刻数据 + 真实组件的绝对值，不做前后归因。

> 诚实记录一次**我自己制造的假 FAIL**：第一版这个探针报「修复后派生 computed 重算 = 0」，
> 一度像是指控 `useSelector` 没生效。根因是 **Vue `computed` 惰性**——我写完 3 次后没有重新读 `.value`，
> getter 根本没执行。补上重读后得到上表。已自查剔除。

---

## 2. 针对 Authorization

### Check F-1：`onRequest` 到底有没有被 ofetch 调用——被验证了，还是被 mock 掉了

**Method**：不信生产者的测试，自己写一个**起真实 `node:http` 服务器**的探针：
- 不用 `vi.doMock('@/constants/app-config')`（用 `vi.stubEnv` 走**生产模块的正常加载路径**）
- 不用 `vi.stubGlobal('fetch')`（让 undici 真发一次 TCP 请求）
- 看服务器收到的**原始 header**

**Evidence**：
```
[wire] method=GET url=/alarm/policies
[wire] rawHeaders = ["host","127.0.0.1:42201","connection","keep-alive","Authorization","Bearer wire-token-abc","accept","*/*",...]
[wire-neg] rawHeaders = [... 无 Authorization ...]          ← 负对照
 ✓ 服务器真的收到了 Authorization: Bearer <token>  1496ms
 ✓ 负对照：token 为空时服务器不应收到 Authorization  1ms
 ✓ onRequest 回调本身确实被调用 ... token-1 / token-2  1ms
```

**回答生产者的测试有没有自欺欺人：没有。** `api-client.auth.test.ts` **没有** mock `ofetch`，
只 `vi.stubGlobal('fetch', …)`；断言读的是 `fetchMock.mock.calls.at(-1)[1].headers`，
也就是 ofetch 真正交给 fetch 的 init 对象。`vi.resetModules()` + `vi.doMock` 的组合
**没有**把被测的 `onRequest` 短路掉——它是被真跑的。我另外用网线抓包独立复核了一遍，结论一致。

**Result: PASS**

### Check G-1：`new Headers(options.headers as HeadersInit | undefined)` 会不会丢头

**Method**：5 种调用形态各打一次真实请求，看服务器 `rawHeaders`。

**Evidence**：
```
[probe] options.headers ctor 序列 = ["Headers"]                     ← ofetch 在 onRequest 时给的已是 Headers 实例
[hdrs:object]  ... "X-Request-Id","trace-1","X-Multi","a","Authorization","Bearer tok-b1" ...
[hdrs:Headers] ... "X-From-Headers-Instance","yes","X-Other","z","Authorization","Bearer tok-b2" ...
[hdrs:tuples]  ... "X-Tuple","v1, v2","Authorization","Bearer tok-b3" ...
[hdrs:none]    ... "Authorization","Bearer tok-b4" ...
[hdrs:auth-conflict] 最终 authorization = Bearer tok-from-env
```

逐条回答任务里的问题：
- **`options.headers` 在所有调用形态下都是 `Headers` 实例**（`[probe] ctor = ["Headers"]`）。
  ofetch 在进 `onRequest` 前已把 headers 规范化成 `Headers`。
- **`undefined` 时 `new Headers(undefined)` 合法吗？** 合法，且这条路径根本走不到——
  `onRequest` 里的 `if (!API_TOKEN) return` 在前面短路；即使走到，`new Headers(undefined)` 返回空 Headers。
  `[hdrs:none]` 用例（不传 headers + 有 token）证明新 Headers 构造正常。
- **已经是 `Headers` 实例时再包一层会不会丢东西？** 不会。`new Headers(headersInstance)` 是全量拷贝。
- **多值头会不会被破坏？** `[['X-Tuple','v1'],['X-Tuple','v2']]` → 服务器收到 `"v1, v2"`。
  这是 `Headers` 规范本身的合并行为（同名非 set-cookie 用 `, ` 连接），**即使不包这一层**，
  ofetch/undici 也会产生同样结果。**无信息丢失。**（`set-cookie` 是响应头，不出现在请求路径上。）
- **调用方自己设 `Authorization` 谁赢？** env token 赢（`headers.set()` 是覆盖不是追加）。
  这是**有意设计**（单一静态 token），但如果将来接入「用户自己的 token」，这里会静默覆盖调用方 —— 记为设计约束，不是缺陷。

**Result: PASS**

### Check G-2：mock 模式下会发这个头吗？mock 行为会变吗

**Evidence**：
```
[mock] 返回 = {"data":{...},"extra":{},"code":0,"message":"success","success":true}
[mock] 服务器新增请求数 = 0
[mock-1] 服务器新增请求数 = 0        ← VITE_USE_MOCK=1 同样识别为 true
 ✓ USE_MOCK=true 时不发真实请求、不带 token、且 mock 行为不变
 ✓ USE_MOCK=1 同样识别为 true
```
`apiFetch`（`api-client.ts:65-70`）在 `USE_MOCK` 为真时直接 `return import('@/mocks')…`，
**根本不碰 `httpClient`**，`onRequest` 不会执行。返回信封与修复前逐字节一致（含 `success: true`）。
`.env.demo` 设 `VITE_USE_MOCK=true`（公网演示站），那条路径上永远不发 Authorization。

**Result: PASS**

### Check G-3：`API_TOKEN` 在模块加载时被捕获 —— 运行期改 token 会生效吗

**Method**：加载 api-client（token=`token-at-load`）→ 发一次 → 运行期改 `import.meta.env` 与 `process.env` → 再发一次。

**Evidence**：
```
[runtime-token] 改 env 后服务器收到 = Bearer token-at-load
 ✓ 运行期修改 import.meta.env / process.env 后，模块已加载的实例仍用旧 token
```

**我的判断（区分「事实」与「评价」）**

- **事实（已复现）**：改不动。`API_TOKEN` 是 `app-config.ts:14` 的 `const`，由 `import.meta.env` 派生；
  Vite 在**构建期**就把 `import.meta.env.*` 内联成字面量。所以这不只是「模块级单例捕获」，
  **运行期根本没有可改的量**。即使把 `httpClient` 改成非单例也没用。
- **评价：这不是本次修复引入的缺陷，也不该算 BLOCKER。** 理由：
  1. 它是 `VITE_*` 机制的固有属性，任何用 `import.meta.env` 读配置的地方都一样，与 S-10 写法无关；
  2. 代码注释已经**显式声明**了这个限制（`app-config.ts:12-13`「接入真实登录态后应改为运行时读取」、
     `api-client.ts:33-39`），属于已记录的已知取舍；
  3. 当前需求就是一个 env 占位 token，**该场景下行为完全正确**（`[wire]` 用例证明）。
- **但它有一个必须被点名的推论**（见 G-4）：正因为它是构建期常量，
  一个静态 bearer token 会被**打进前端产物**，任何能加载页面的人都能从 bundle 里读到。
  这是「浏览器端静态 token」这一方案本身的属性，不是这次改动的属性，但评审应当知情。

**Result: PASS（附条件：仅对「env 占位 token」这一既定场景成立）**

### Check G-4 ⚠️：S-10 在仓库所有已提交配置下都是空转的

这是本轮**唯一有分量的问题**，但它是**产品/配置缺口，不是代码缺陷**。

**Method**：全仓搜 `VITE_SERVER_API_TOKEN` 的赋值点 + 逐个读 env 文件。

**Evidence**（`grep -rn "VITE_SERVER_API_TOKEN"`，排除 node_modules）：

| 文件 | 值 |
|---|---|
| `web/.env:20` | `VITE_SERVER_API_TOKEN=` （**空**） |
| `web/.env.example:20` | `VITE_SERVER_API_TOKEN=` （**空**） |
| `web/.env.demo` | **根本没有这一行**（且 `VITE_USE_MOCK=true`，走 mock） |
| `src/validators/env.validator.ts:18` | `z.string().default('')` |
| `src/utils/env.ts:15` | `VITE_SERVER_API_TOKEN: ''`（fallback 也空） |

**推论链（每一步都有上面/前面的证据）**：
1. 已提交配置里没有任何一个给 `VITE_SERVER_API_TOKEN` 赋值 → `API_TOKEN === ''`；
2. `onRequest` 首行 `if (!API_TOKEN) return`（`api-client.ts:41`）→ **不发 Authorization**；
3. 后端 `AuthMiddleware` fail-closed → 真实后端对每个请求 401；
4. 401 → `onResponseError` → `handleUnauthorized()`（`api-client.ts:50-53`）→ `isLogin = false` + `router.push('/auth/sign-in')`
   （该路径已有既存测试覆盖：`src/lib/__tests__/api-client.test.ts:93-108`）。
5. 唯一不发头的场景是 mock（`.env.demo`），但那条路径压根不连后端。

**判定**：
- `onRequest` **这个机制**是对的，我用网线抓包证明了（Check F-1）。
- 但「Authorization 集成」这个**交付物**，在当前仓库状态下**没有真正生效**：
  开发者 `pnpm dev` + 起后端 → 第一个告警接口就 401 → 被踢回登录页。
- 这**不是回归**（修复前也不发头，结果完全一样），所以不该判 FAIL；
  但 S-10 的验收**不能**写成「Authorization 已集成完成」。

**建议**（不属代码缺陷，属交付/文档）：
要么在 `.env.example` 里给出可用的示例值并写明「必须与后端 `ALARM_STATIC_TOKENS` 一致」，
要么在验收标准里明确「本轮只交付机制，token 配置由部署方提供」。

**Result: FAIL（仅对「S-10 已集成」这一验收声明；对代码本身 PASS）**

---

## 3. 基线（真实退出码，非推断）

在**已删除全部临时测试**、工作区与开工前基线一致的状态下运行：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `pnpm lint` | **0** | eslint 无输出 |
| `pnpm test:run` | **0** | `Test Files 23 passed (23)` / `Tests 430 passed (430)` / `Duration 76.69s` |
| `pnpm exec vue-tsc -b --force` | **0** | 无输出 |
| `pnpm build` | **0** | `vite v8.3.1 building client environment for production...` / `✓ built in 35.97s` |

原始记录（`/tmp/exit-codes.txt`）：

```
LINT_EXIT=0
TEST_EXIT=0
TSC_EXIT=0
BUILD_EXIT=0
```

> 基线里 `430 passed` 包含本轮新增的 `api-client.auth.test.ts`（3）与 `policy-form.mount.test.ts`（3）。
> **无 127。**

---

## 4. 缺陷汇总

| ID | 严重度 | 位置 | 描述 | 复现状态 |
|---|---|---|---|---|
| G-4 | **MEDIUM**（交付缺口，非代码缺陷） | `.env` / `.env.example` / `.env.demo` | 三个已提交 env 都没配非空 `VITE_SERVER_API_TOKEN`，S-10 在所有已提交配置下不发头 → 真实后端 401 → `handleUnauthorized` 把用户踢回登录页 | **已复现**（静态证据链完整，行为端到端已由既存 401 测试覆盖） |
| A-2a | LOW | `policy-form.mount.test.ts` | 未 mock `@/services/api/alarm-policy.api`，跑该文件产生 60 次真实 `localhost:3000` 连接失败；测试非 hermetic | **已复现** |
| A-2b | LOW | `policy-form.mount.test.ts:49-53` | notification mock 漏 `success: true`，组件实际走 `toast.error` 分支，通知模板恒空 | **已复现**（读组件 `:337-340` + mock 逐字比对） |
| E-1a | LOW | `policy-form.vue:238` | `form.useSelector` 实际返回 `Readonly<Ref>`，被 `as Ref<PolicyFormValues>` 洗成可写；将来若有人写 `values.value = x` 会静默失效/告警 | 静态确认（当前 0 处赋值） |
| E-1b | LOW（行为变化，非缺陷） | `policy-form.vue` | 修复后 render effect 依赖 store，每次字段写入都会重跑组件（真实组件 3 次按键 → 子树 159 次 `updated`） | **已复现** |
| E-1c | LOW（潜在） | `policy-form.vue:512` | `deep: true` 只感知引用替换；若将来 form-core 改为原地改 `state.values`，`dirty` 会静默失效 | 静态推演（当前所有路径都换引用） |

**无 BLOCKER。无 HIGH。**

---

## 5. 清理确认

```
$ rm -rf src/__tmp_attack__
$ git status --short > /tmp/final-git-status.txt
$ diff /tmp/baseline-git-status.txt /tmp/final-git-status.txt
FINAL GIT STATUS == BASELINE ✓
```

（该 diff 在**跑完基线四件套之后**又做了一次；`pnpm build` 产出的 `dist/` 已被 `.gitignore` 覆盖，未污染工作区。）

临时文件（4 个，均已删除）：
`src/__tmp_attack__/s02-dom.test.ts`、`s02-derived.test.ts`、`auth-wire.test.ts`、`render-and-401.test.ts`

除上述临时测试外，**未修改 `/workspace` 下任何项目文件**。`/workspace` 非 git 仓库，
所有 `git status` 均在 `/workspace/web` 下执行。

---

## 6. 判定

**两条修复我都没能攻破。** 我按「默认立场：修复引入了新缺陷」去打，用了 26 个探针
（含一条真实 HTTP 服务器抓包、一条纯 DOM 驱动 Reka Select、三个我自查剔除的假警报），
全部通过。S-02 的响应式链路在**所有**消费点（派生 computed、deep watch、模板直读、
read-modify-write、三条回填路径）上都被证明是通的；S-10 的 `onRequest` 被证明真的被 ofetch 调用、
真的落到网线上，且不丢任何调用方请求头。

**唯一需要处理的是 G-4**：代码机制正确，但**没有任何已提交配置让它真正生效**。
它不是回归，不判 FAIL；但 S-10 的验收声明必须改写成「机制已交付，token 由部署方配置」，
否则会误导后续收口。另外两条 LOW 是新测试自身的卫生问题（不 hermetic、mock 漏字段），
建议顺手修掉，否则这台机器上碰巧有 3000 端口服务时该测试的行为会变。

VERDICT: PASS
