# 攻击线 A：前端规则配置交互与校验 — 对抗式审查报告

- **审查对象**：`web/src/pages/alarm/policy/`（15 文件 5636 行）、`pages/alarm/components/condition-editor.vue`、`pages/alarm/components/alarm-enum-options.ts`、`services/api/alarm-policy.api.ts`
- **事实来源**：`/workspace/docs/alarm/contract.md` v1.0（§0.1-§0.6、§1.1-§1.12、§2.1-§2.3、§3.1 ①-⑦）
- **默认立场**：证伪。共 10 条发现，全部**已复现**（无「未复现」条目），另有 9 条 PASS 记录。
- **结论**：**VERDICT: FAIL** —— 存在 2 条阻塞级缺陷，告警策略的**新建/编辑 UI 完全不可用**（0 次请求发出），且「复制策略」预填名错误。

> 独立声明：本报告未参考其它审查线的报告文件。项目文件**零修改**；所有测试文件写在 `/tmp/audit/`，运行后未污染仓库。

---

## 0. 基线（真实退出码，非推断）

环境：`node v22.19.0` / `pnpm 11.27.1`（`which pnpm` → `/usr/local/bin/pnpm`，**无需 corepack 兜底**；无 127）。

| 命令 | 退出码 | 关键输出（逐字摘录） |
| --- | --- | --- |
| `pnpm lint` | **0** | `$ eslint .`（无输出） |
| `pnpm test:run` | **0** | `Test Files 21 passed (21)` / `Tests 424 passed (424)` / `Duration 73.85s` |
| `pnpm exec vue-tsc -b --force` | **0** | 无输出，日志仅含 `TSC_EXIT=0` |
| `pnpm build` | **0** | `✓ built in 29.60s` |

**基线全绿，但 UI 不可用**（见 F-01）。这本身就是第一条结论：单测与构建对本次缺陷**零覆盖**。

### 自建验证工况（写在 /tmp，未污染项目）

`/tmp/audit/vitest.config.mjs`：`root=/workspace/web` + `alias @ → /workspace/web/src` + `unplugin-auto-import`（与项目同配置）+ `unplugin-vue-components` + 一个把裸包导入解析回 `web/node_modules` 的 pre 插件 + `test.root=/tmp/audit`。
已验证可挂载**真实** `index.vue` / `policy-form.vue` / `ConfirmDialog.vue`（非复刻件）。

---

## 1. 发现清单

| # | 级别 | 标题 | 状态 |
| --- | --- | --- | --- |
| F-01 | **阻塞** | `values` computed 永久冻结 → 向导卡死在第 1 步，**UI 无法创建/编辑任何策略** | 已复现 |
| F-02 | **阻塞** | 「复制策略」预填名变成 `" - 副本"`，源策略名丢失 | 已复现 |
| F-03 | 严重 | 复制态 `baseline` 是**空表单** → 「放弃修改」把已加载配置清空 | 已复现 |
| F-04 | 严重 | 通知模板字典 `pageSize:100` 截断 → 绑定字典外模板的策略**永远无法保存** | 已复现 |
| F-05 | 严重 | 契约 ⑦ `POST /policies/{id}/copy` 在 UI 中**从未被调用**，复制语义与契约不符 | 已复现 |
| F-06 | 中等 | `buildPolicyListQuery` 只过滤 `isFinite`，非法枚举值原样透传 → 必然 422 | 已复现 |
| F-07 | 中等 | 确认页静默丢弃字典外的 `notificationTemplateIds`（ID 引用「错位/丢弃」） | 已复现 |
| F-08 | 轻微 | `pendingId` 全局单值：其它行控件可点但点击被静默吞掉 | 已复现 |
| F-09 | 轻微 | `confirmDelete` 无重入保护（同 tick 双击发 2 次 DELETE） | 已复现（含反证） |
| F-10 | 轻微 | `ConfirmDialog` 无条件关闭 → 409 失败时弹窗仍关闭，失败分支清理是死代码 | 已复现 |

---

### F-01 【阻塞】`values` computed 永久冻结 —— 策略新建/编辑 UI 完全不可用

**涉及文件:行号**
- `web/src/pages/alarm/policy/components/policy-form.vue:223` — `const values = computed(() => form.state.values as PolicyFormValues)`
- 连带失效：`:425 currentValues()`、`:428 validateStep()`、`:497 watch(values,…)`、`:725 policyFormSchema.safeParse(currentValues())`、`:753`、`:757-758`
- 根因（第三方库，非本仓库）：`node_modules/.pnpm/@tanstack+form-core@1.33.5/.../dist/esm/FormApi.js:1178-1180`
  ```js
  get state() {
    return this.store.state;
  }
  ```
  `grep -c 'from "vue"' FormApi.js` → **0**（该包完全不依赖 vue）。`@tanstack/vue-form@1.33.5/dist/esm/useForm.js:38` 提供的响应式入口是 `form.useSelector(store, selector)`（来自 `@tanstack/vue-store`），**本组件从未使用**。

**复现步骤（挂载真实 `policy-form.vue`，mock 掉 4 个 API，`mode=update, policyId=1001`，服务端返回 1 条条件）**
1. 挂载组件，`await` 若干 tick
2. 点击底部「下一步」按钮

**实际观察到的现象（逐字）**
```
#policy-name = "生产 CVM CPU 监控"            <- form.Field 绑定是活的（用户看得到数据）
form.state.values.name = "生产 CVM CPU 监控"    <- 底层 form 状态也是对的
组件内 values.name = ""                        <- computed 读到的却是空表单
组件自身 currentValues() = {"name":"","conditions":0}
【S2】条件数提示文案 = "触发条件 0/4 条，已低于契约下限（1-4 条）"   <- 服务端明明返回了 1 条
【S5】点「添加条件」后 条件数提示 = "触发条件 0/4 条…"              <- 加了也不显示
【S6】点「添加条件」后 form.state.values.conditions.length = 1（写进去了）| 组件 values.conditions.length = 0（读不到）
【S7】连点 3 次「下一步」后 步骤 = "第 1 / 4 步"
【S8】错误文案 = ["策略名称不能为空","请选择监控类型","请选择策略类型"]
【S9】请求次数 = 0 | router.push = []
【S10】dirty = false （watch(values) 从未触发）
【S4】4 处「未选择」
```
补充实验：把 `name` 改成 `ZZZ` 后，**DOM 输入框显示 `ZZZ`（表单确实是活的）**，但 `st.values.name` 仍是 `""`，`validateStep(0)` 仍返回 `false`。

**根因判定（做了排除实验，不是靠猜）**
- 控制实验 C1：独立 `useForm`，先读一次 `computed(() => form.state.values)`（模拟模板预热）→ 之后 `setFieldValue('A')` 与 `reset({name:'B'})` 均**不更新**；**新建**一个 computed 立刻读到 `"B"`。证明是 computed 缓存后永不失效。
- 控制实验 C2：`watch(() => form.state.values, cb, {deep:true})` 命中数 = **0**（reset/setFieldValue 都不触发）。
- 控制实验 C4：把同一 `useForm` 放进真实挂载组件，模板里直接 `{{ form.state.values.name }}`，`reset({name:'ZZZ'})` 后 DOM 仍是 `"|0"` —— 连**不经 computed** 的直接插值都不更新。
- **排除 harness 伪影**：`require.resolve('vue', {paths:[@tanstack/vue-form 目录]})` 与 `require.resolve('vue')` 返回**同一绝对路径**（`.../vue@3.5.43_typescript@6.0.3/node_modules/vue/index.js`），不存在双 `vue` 实例。
- 库源码直读确认 `FormApi.state` 是普通 getter、不 import vue。

**期望行为**
`validateStep()` 校验用户当前所见的数据；向导可从第 1 步走到第 4 步并提交；编辑页条件数显示 `1/4`；「添加条件」后显示 `2/4`；离开确认的脏检查能触发。

**实际后果**
- **通过前端 UI 无法创建（③ POST）也无法编辑（④ PUT）任何告警策略**：0 次请求、0 次 `router.push`。
- 编辑页把已有配置显示成「0 条条件」「未选择」，用户会以为数据被清空。
- 离开确认（`onBeforeRouteLeave`）因 `dirty` 恒为 `false` 而从不生效。
- 契约 §3.1 ③/④ 的全量更新语义、§2.1 的条件回显，全部无法通过 UI 触达。

**修复方向（供生产者参考，本线不改代码）**
用 `form.useSelector(s => s.values)`（`@tanstack/vue-store`）替代 `computed(() => form.state.values)`，或把整份表单状态移出 vue-form、用 `reactive`/`ref` 自持（vue-form 只做字段渲染）。

**为什么 424 个单测全绿却没抓到**
`src/pages/alarm/policy/__tests__/` 下 3 个文件（policy-logic 87 / policy-validator 42 / policy-view 23）+ `src/services/api/__tests__/alarm-policy.api.test.ts`（16）**共 168 条**，全部是纯函数与传输层断言。
`grep -rl "mount(" src --include=*.test.ts` 只命中 3 个文件：`components/data-table/table.test.ts`、`pages/alarm/history/refresh.test.ts`、`pages/alarm/notification-template/refresh.test.ts`。
**策略相关页面 0 个组件挂载测试** —— 这正是 F-01 能带着 100% 绿色基线出厂的原因。

---

### F-02 【阻塞】「复制策略」预填名变成 `" - 副本"`，源策略名丢失

**涉及文件:行号**：`policy-form.vue:749-761`，具体是 `:753` `const source = values.value.name`

**复现步骤**
1. mock `fetchAlarmPolicyDetail` 返回 `name = "生产 CVM CPU 监控"`
2. `mount(PolicyForm, { props: { mode: 'create', copyFrom: 1001 } })`
3. 读 `#policy-name` 的 value

**实际观察到的现象**
```
#policy-name 实际值 = " - 副本"
期望               = "生产 CVM CPU 监控 - 副本"
对照组（mode=update，同一份 detail）：#policy-name = "生产 CVM CPU 监控"   <- 正常
```
根因同 F-01：`values` computed 冻结在空表单，`values.value.name === ''`，`buildCopyName('')` 返回 `' - 副本'`（`policy-logic.ts:119-126` 本身是正确的）。

**期望行为**：契约 §3.1 ⑦ 规定新名 `{原名} - 副本`。

**实际后果**
- 复制出的策略名恒为 `" - 副本"`（去首尾空格后仍是 `"- 副本"`）。
- **复制同一策略第二次必然 409** `POLICY_NAME_DUPLICATED`（契约 §0.5）。
- `buildCopyName` 的 128 字符截断保护（契约明令「禁止按字节截断」）在真实路径上完全没机会生效。

---

### F-03 【严重】复制态 `baseline` 是空表单 →「放弃修改」把已加载配置清空

**涉及文件:行号**：`policy-form.vue:757-758`
```js
baseline = currentValues()
snapshot = JSON.stringify(currentValues())
```

**复现步骤**：`mode=create, copyFrom=1001` 挂载后，直接调用组件自身的 `discardChanges()`。

**实际观察到的现象**
```
baseline = {"name":"","conditions":0,"remark":""}          <- 空表单
真实回填 = {"name":"生产 CVM CPU 监控","conditions":1,"remark":"核心交易集群"}
discardChanges 后 #policy-name = "" | form.state.values.conditions = 0
```

**期望行为**：`discardChanges()`（`:412-418`）应还原到「最近一次加载/复制的基线值」——注释就是这么写的；实际还原到空表单，**把已加载的源策略配置全部抹掉**，且用户无从恢复。

**说明**：`mode=update` 路径不受影响，因为 `resetForm()`（`:401-409`）用形参 `next` 赋 `baseline`，只有复制路径在 `:757` 又用 `currentValues()` 覆盖了一次。离开确认弹窗本身需要先触发路由跳转才会渲染，本条用组件自身函数直接复现，**未走完整 UI 导航路径**。

---

### F-04 【严重】通知模板字典 `pageSize:100` 截断 → 绑定字典外模板的策略永远无法保存

**涉及文件:行号**
- `policy-form.vue:321` — `fetchAlarmNotificationTemplateList({ page: 1, pageSize: 100 })`
- `policy-form.vue:678-684` — `collectNotificationBindingErrors(...)` 非空即 `return`，**不发请求**
- `policy-logic.ts:367-371` — `missing = ids.filter(id => !templateMap.has(id))` → 报错
- 契约 §0.3：`pageSize` 上限 **100**

**复现步骤**
1. 账号下有 >100 个通知模板
2. 某策略绑定了排序在第 101 位之后的模板（如 `id=1001`）
3. 打开编辑页 → 走完 4 步 → 提交

**实际观察到的现象**
```
⑬ 请求 = [{"page":1,"pageSize":100}]        <- 只能拿到前 100 个
errors = ["通知模板不存在：1001"]              <- 详情回填把 id 1001 完整带回来了
回填后 notificationTemplateIds = [3,5,1001]
提交请求次数 = 0 | 被弹回步骤 = 第 1 / 4 步
```
`detailToFormValues`（`policy-view.ts:353`）用 `[...detail.notificationTemplateIds]` **不会**丢掉 id，但 `collectNotificationBindingErrors` 会把不在字典里的 id 判成「不存在」并**硬阻断提交**。

**期望行为**：契约 §3.1 ③ 的 `notificationTemplateIds` 只要求「最多 3 个、不重复、id 均须存在」。前端把**分页截断**误判成「id 不存在」，是对后端约束的误用。

**实际后果**：**这类策略打开编辑页后就再也保存不了**（不是「这次失败」，是每次都失败），用户无任何自救入口。同一问题也影响 F-05 的复制流程。

**修复方向**：字典缺失时应区分「没加载到这一页」与「真不存在」；至少在确认页把未加载的 id 显式列出并允许分页补齐。

---

### F-05 【严重】契约 ⑦ `POST /policies/{id}/copy` 在 UI 中从未被调用

**涉及文件:行号**
- `services/api/alarm-policy.api.ts:150-154` — `copyAlarmPolicy()` **已实现**
- 全仓引用点：`grep copyAlarmPolicy src` → 只有 `alarm-policy.api.ts:150` 定义 + `src/services/api/__tests__/alarm-policy.api.test.ts:154` 自身单测
- `policy/index.vue:181-184` — 「复制」改成 `router.push({ path:'/alarm/policy/create', query:{ copyFrom } })`

**复现步骤**：全仓文本检索 `copyAlarmPolicy` / `copyFrom`；再挂载真实 `policy-form.vue`。

**实际观察到的现象**
- UI 的「复制」= 拉详情 → 走 4 步向导 → `POST /policies`。
- `buildCopyName` 只有在显式传 `seq>1` 时才产出 `(2)`，而调用点 `policy-form.vue:754` 是 `buildCopyName(source)`，**永远不传 seq**：
  ```
  buildCopyName("A")    = "A - 副本"
  buildCopyName("A", 2) = "A - 副本(2)"     <- UI 永远不会走到这里
  ```
- 叠加 F-02：UI 实际产出的名字恒为 `" - 副本"`，**任何第二次复制都撞名 409**。

**期望行为**（契约 §3.1 ⑦）：服务端重命名 `{原名} - 副本` → `副本(2)` … 最�� `(99)`，且为**原子操作**（深拷贝 conditions/notificationTemplateIds/objectIds 并强制 `status=0`）。

**实际后果**
- 契约规定的 `(2)..(99)` 冲突重试语义**在前端一行都没实现**。
- 复制不是一次原子操作，而是要求用户手工走完 4 步向导 —— 叠加 F-01，用户根本走不完。
- `policy-logic.ts:15` 的注释把 `buildCopyName` 标注为「契约 §3.1 ⑦」，但它只实现了 ⑦ 的一小片，容易误导后续维护者以为 ⑦ 已覆盖。

---

### F-06 【中等】列表筛选：非法枚举值原样透传，必然 422

**涉及文件:行号**：`policy-logic.ts:556-597`（尤其 `:569-574` 的 `numeric()`）；输入口 `components/policy-filters.vue:143-150`

**复现步骤**：直接调用 `buildPolicyListQuery(filters, {pageIndex:0,pageSize:20})`

**实际观察到的现象**
```
{"monitorType":1.5}     -> {"page":1,"pageSize":20,"monitorType":1.5}
{"status":-1}           -> {"page":1,"pageSize":20,"status":-1}
{"level":99}            -> {"page":1,"pageSize":20,"level":99}
{"monitorType":true}    -> {"page":1,"pageSize":20,"monitorType":1}
{"status":1e+21}        -> {"page":1,"pageSize":20,"status":1e+21}
{"projectId":"  "}      -> {"page":1,"pageSize":20,"projectId":0}    <- 静默变成「按 0 过滤」
```
契约 §3.1 ① 明写「非法枚举值返回 422」。函数注释（`:553-555`）自称「只透传**有值且为合法数字**的项」，实际只做了 `Number.isFinite`，**没做枚举成员判定**——注释与实现不符。

**可达性**：`monitorType/policyType/status/level` 走 `Select` 固定选项，正常点不到非法值。**但 `projectId` 是 `type="number" min="0"` 的自由输入**（`policy-filters.vue:143-150`），`min` 只是浏览器提示不拦值；`1.5` / `-5` 可直接输入并透传。另外 `Number('  ') === 0` 使「只输入空格」静默变成 `projectId=0` 过滤（契约里 `0` 表示未分配），而不是「不过滤」。

**期望行为**：枚举类筛选项应在发送前按 `ALARM_*` 成员过滤；`projectId` 应做整数/非负校验并把空白串视为未传。

---

### F-07 【中等】确认页静默丢弃字典外的 `notificationTemplateIds`

**涉及文件:行号**：`policy-view.ts:116-133`（`toNotificationBrief`）

**复现步骤**：`toPolicySectionModelFromForm(values, { mode:'create', notificationTemplates: <仅含 id 1..100> })`，其中 `values.notificationTemplateIds = [3, 1001]`

**实际观察到的现象**
```
确认页 notificationTemplates = [3]          <- id 1001 被 filter(Boolean) 静默丢弃
确认页 notificationTemplateIds = [3,1001]    <- 但 id 列表仍显示 2 个
```
**期望行为**：第 4 步「确认」页要如实反映将提交的请求体。契约 §3.1 ⑦ 明确点名 `notificationTemplateIds` 是复制时**原样继承**的字段。

**实际后果**：用户看到的通知模板数与实际提交的数不一致，且缺口无任何提示。叠加 F-04，用户会先看到「1 个」，提交时才被告知「不存在」。

---

### F-08 【轻微】`pendingId` 是全局单值，其它行控件可点但点击被静默吞掉

**涉及文件:行号**：`policy/index.vue:69`（`const pendingId = ref<number|null>(null)`）、`:134-135`（`if (pendingId.value !== null) return`）、`policy-columns.ts:116`（`disabled: handlers.pendingId() === policy.id`）

**复现步骤**（真实 `index.vue` 挂载，2 行数据）：让行 A 的 `setAlarmPolicyStatus` 挂起不 resolve，然后点行 B 的开关。

**实际观察到的现象**
```
行A请求中 -> 行A disabled = true | 行B disabled = false   （行B 看起来可点）
点击行B后 status api 调用次数 = 0                        （守卫是全局 pendingId，非按行）
```

**期望行为**：要么按行加锁（`pendingIds: Set<number>`），要么把**所有**行开关都置灰。
**实际后果**：行 B 的开关可点击、UI 有按压反馈、但什么都不发生，也没有任何提示——死控件。

---

### F-09 【轻微】`confirmDelete` 无重入保护（同 tick 双击会发 2 次 DELETE）

**涉及文件:行号**：`policy/index.vue:200-229`（缺 `if (deleting.value) return`）

**复现步骤**：挂载真实 `ConfirmDialog.vue`，`confirmDelete` 复刻 `index.vue:200-229` 的函数体，同一 tick 内连续 `btn.click()` 两次。

**实际观察到的现象**
```
--- 同一 tick 内两次 click()：DELETE 次数 = 2 ---
DELETE#1 id=1001 (deleting was false)
DELETE#2 id=1001 (deleting was true)      <- 第二个请求已经发出
按钮 disabled = true
```
**同时给出反证（避免夸大）**：按真实浏览器时序（两次 `click` 之间跑一次 `nextTick`）重测：
```
--- 真实浏览器时序：DELETE 次数 = 1 ---
按钮 disabled = true
```

**结论**：双击保护**完全依赖 `:is-loading="deleting"` 触发的渲染 flush**，不是函数内的重入检查。真实浏览器下双击被挡住，所以**不是可利用的重复提交**；但契约 §0.1 要求「非幂等端点前端需禁用重复提交」，当前实现的正确性挂在渲染时序上，属于健壮性缺口。`toggleStatus`（`:134`）有显式守卫，删除路径没有，两者不一致。

---

### F-10 【轻微】`ConfirmDialog` 无条件关闭，409 失败时弹窗仍关闭

**涉及文件:行号**：`web/src/components/confirm-dialog.vue:35-38`、`policy/index.vue:209-216`

```js
function handleConfirm() {
  emits('confirm')
  openModel.value = false      // 与 emit 的成功/失败无关，无条件执行
}
```

**实际观察到的现象**
```
409 -> return（confirmDelete 里不清 deleteTarget）
ConfirmDialog 内部 open = false（handleConfirm 无条件置 false，与成功/失败无关）
deleteTarget = 1001   <- index.vue:216 的 deleteTarget = null 是死代码
```

**期望行为**：删除失败（409「已启用的策略不可删除，请先停用」/ 404）时保留弹窗让用户看到上下文。
**实际后果**：弹窗瞬间消失，只剩一条转瞬即逝的 toast。另外 `policy/index.vue:216` 的 `deleteTarget.value = null` 永远执行不到——该分支是死代码，说明作者以为失败时弹窗会留着。

---

## 2. PASS 记录（同样附证据，避免只报负面）

| 攻击面 | 方法 | 证据 | 结论 |
| --- | --- | --- | --- |
| `operator` 当数字处理 / 空串 / 大小写 / 空格 | 对 `policyConditionSchema` 喂 21 个非法值 + 6 个合法值 | `''` `' '` `'  >'` `'>  '` `'GT'` `'gt'` `'＞'` `'=~'` `'=<'` `'<>'` `'>=='` `'大於'` `'==='` `0` `1` `null` `undefined` `true` `[]` `['>']` `{}` `NaN` **全部 rejected**；`'>' '>=' '<' '<=' '==' '!='` **全部 ACCEPTED**。`operatorSchema.safeParse(1)` 亦 rejected | **PASS**（zod 层无 `is_numeric` 之类数字化处理，符号原样传输） |
| 阈值边界 | 18 个取值 | `0`/`-0`/`-273.15`/`1.2345`/`0.0001` ACCEPTED；`0.00001`/`1e-7` REJECT(最多4位小数)；`NaN`/`Infinity`/`null`/`''`/`undefined`/`true`/`'90'` REJECT(必须是数字) | **PASS** |
| 持续周期边界 | 9 个取值 | `1`/`10` ACCEPT；`0`/`-1`/`11`/`100`/`1.5`/`NaN`/`null`/`'3'` REJECT | **PASS**（契约 1..10） |
| 统计粒度边界 | 9 个取值 | `1/5/10/30/60` ACCEPT；`0/2/15/61/-5/7/'5'/null` REJECT | **PASS** |
| 等级 / 频次 | 12 个取值 | level `1/2/3` ACCEPT，`0/4/-1` REJECT；frequency 9 个合法值全 ACCEPT，`1/10/1441/-5` REJECT | **PASS** |
| 条件集合为空 / 单条 / AND-OR | `policyFormSchema` | `0条` REJECT(至少1条)；`1条` ACCEPT；`4条` ACCEPT；`5条` REJECT；`sort=[1,1]/[2,1]/[1,3]/[0,1]` 全部 REJECT(必须1..N连续升序且不重复) | **PASS** |
| 列表 `conditionCount` vs 详情 | 真实 `index.vue` 挂载 | 列表渲染「共 2 条触发条件 / 共 1 条触发条件」（取服务端 `conditionCount`）；详情页取 `detail.conditions.length`。两者互不校验，**一致性取决于后端**（无后端，未运行时验证）。但**编辑页因 F-01 显示「0/4 条」**，构成列表/详情/编辑三方不一致 | 见 F-01 |
| 启停乐观更新 + 失败回滚 | 真实 `index.vue` 挂载，后端返 422 | `初始 [checked, unchecked]` → `乐观更新后 [unchecked, unchecked]` → `后端 422 之后 [checked, unchecked]`（已回滚）；`api 调用 = [{"api":"status","id":1,"d":{"status":0}}]` | **PASS** |
| 删除前置校验 | 真实 `index.vue` 菜单 | `status=1` 行的「删除」项 `disabled=""`（已禁用），其余项可用 | **PASS** |
| `notificationTemplateIds` 复制重建 | `buildPolicyPayload` + `detailToFormValues` | 详情回填 `[...detail.notificationTemplateIds]` 完整保留；`buildPolicyPayload` 用 `[...values.notificationTemplateIds]` 浅拷贝，无错位 | **PASS**（缺口在 F-04/F-07 的字典侧，不在 ID 重建本身） |
| `conditions` 复制重建 | `toConditionPayload` / `toConditionFormItem` | 条件行只提交 P10 的 9 个必填字段，`id`/`metricNameCn`/`unit` 不进请求体（契约 §2.1 要求）；`sort` 提交时按 `index+1` 重排 | **PASS** |
| 复制名按字符截断（契约「禁止按字节截断」） | `buildCopyName` | 128 个 `x` → 长度 128；128 个汉字 → 长度 128 / **378 字节**（按字节会切出半截字符）；`'😀'.repeat(200)` → 码点 128 / utf16 251 / 501 字节（代理对未被切半） | **PASS**（函数本身正确；但因 F-02 在真实路径上拿不到源名） |
| §0.6 JSON 空值方向 | `resolveObjectBinding` | `objectType=1` + 三个字段都有值 → `{"objectIds":null,"objectGroupIds":null,"objectFilters":null}`（R-JSON-1 正确）；`notificationTemplateIds` 恒为数组（R-JSON-2 正确） | **PASS** |
| 条件数增删边界 | `canAddCondition`/`canRemoveCondition` + 真实 UI | 契约 1-4 条；4 条时「添加条件」禁用，1 条时删除禁用 | **PASS**（但受 F-01 影响，用户看不到条件行） |
| 枚举类型断言绕过 | 全量读 `policy-form.vue` / `policy-logic.ts` / `policy-view.ts` | `as never`（`:1254 operator`、`:1282 period`、`:1320 level`、`:1337 frequency`）只作用于**下拉框的 Select 回传值**，运行时仍由 `policyFormSchema` 兜底；`as AlarmPolicyListQuery['monitorType']`（`policy-logic.ts:578`）同理。**未发现绕过运行时校验的路径** | **PASS** |
| `AlarmPolicyCreatePayload` 契约一致性 | 对 `types/alarm.ts` 逐字段核对契约 §3.1 ③ | 字段与默认值全部对齐；`status` 在 update 模式**被刻意省略**（契约 §3.1 ④ 唯一不回落默认的字段）—— 代码路径正确 | **PASS** |
| 幽灵字段 `callbackUrl` | `buildPolicyPayload` + `types/alarm.ts` | 契约的 `AlarmPolicyDetail`/`AlarmPolicyCreatePayload` **没有** `callbackUrl`（它只属于 §2.5 的 `NotificationChannel`）。表单第 3 步收集并展示它（`FIELD_STEP:162`），`buildPolicyPayload` 直接丢弃 | 记为轻微（见下） |

**「幽灵字段 callbackUrl」补充说明**：用户填的回调地址永远不会被提交，界面却把它当必填项展示在第 3 步和第 4 步确认页。这不是契约违规（不违反 §2.3），但是一个**永远无效的输入项**，容易让用户误以为策略配了回调。归入轻微，不单独编号。

---

## 3. 未覆盖 / 未运行时验证（诚实声明）

1. **无后端**：本沙箱无 PHP/Composer/MySQL/Redis，`server/vendor` 缺失。所有关于**真实 HTTP 交互**（422/409 实际返回、契约 ⑦ 服务端重命名）的结论均为**代码层推断 + 前端侧复现**，未与真实后端联调。
2. **未跑真实浏览器**：组件行为通过 `@vue/test-utils` + `happy-dom` 挂载真实 `.vue` 文件复现，**没有**用 Chrome/Playwright 做过端到端点击。F-01/F-02/F-03 的证据是组件内 `setupState` + 真实 DOM 查询 + 组件自身函数调用，属黑盒+白盒混合，不依赖任何内部假设。
3. **F-03 的 UI 路径未走通**：「放弃修改」按钮需先触发路由跳转会渲染，用组件自身 `discardChanges()` 直接复现。
4. **`toast` mock 失效**：`vi.mock('vue-sonner')` 后组件内 `toast.*` 未被我的 spy 捕获（`toast.error` 调用数为 0，而回滚路径确定执行过），故**任何基于 toast 文案的结论都未采信**；所有结论均基于 DOM / API 调用次数 / 内部状态。
5. **列表 `conditionCount` 与详情条件数的一致性**需要后端配合才能真正判定，本次只确认了前端两侧取值来源不同、且不互相校验。

---

## 4. 复现命令

```bash
cd /workspace/web
# 基线
pnpm lint; echo "lint=$?"
pnpm test:run; echo "test=$?"
pnpm exec vue-tsc -b --force; echo "tsc=$?"
pnpm build; echo "build=$?"

# 审查用例（工况与用例都在 /tmp，未写入仓库）
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe1-operator    # operator 符号串
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe2-bounds       # 阈值/周期/粒度/等级/频次/sort/条数
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe3-notify       # 通知模板字典截断 + 复制命名
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe4-confirm      # ConfirmDialog 时序/双击
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe5-index        # 真实 index.vue：回滚/行锁/删除禁用
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe6-form         # 真实 policy-form.vue：字典请求/提交
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe7b-copy        # 【F-02 决定性】
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe9-debug        # 【F-01 决定性】
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe10-control     # 根因控制实验 + 排除 harness 伪影
pnpm exec vitest run --config /tmp/audit/vitest.config.mjs probe11-symptoms    # 【F-01/F-03 黑盒症状清单】
```

根因库源码直读：
```bash
sed -n '1176,1182p' web/node_modules/.pnpm/@tanstack+form-core@1.33.5/node_modules/@tanstack/form-core/dist/esm/FormApi.js
grep -c 'from "vue"' web/node_modules/.pnpm/@tanstack+form-core@1.33.5/node_modules/@tanstack/form-core/dist/esm/index.js   # -> 0
```

---

## 5. 结论

基线 4 条命令全绿（退出码均为 0），但这只证明「类型与纯函数自洽」。
**真实挂载 `policy-form.vue` 后，告警策略的新建与编辑在 UI 上完全不可用**：向导永远停在第 1 步，0 次请求发出，0 次跳转。根因是 `policy-form.vue:223` 的 `computed(() => form.state.values)` —— 在 `@tanstack/form-core@1.33.5` 中 `form.state` 是不依赖 Vue 的普通 getter，computed 缓存后永不失效；该库提供的响应式入口 `form.useSelector` 从未被使用。

这一条缺陷同时污染了复制预填名（F-02）、放弃修改的还原基线（F-03）、以及整个页面的条件/摘要展示。即便修好它，F-04（字典分页截断导致策略不可保存）、F-05（契约 ⑦ 从未实现）仍是独立的严重缺陷。

**VERDICT: FAIL**
