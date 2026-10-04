# ATTACK-RESULT — 5 条修复（S-01 / S-02 / S-03 / S-04 / S-10）到底是变好还是变坏

- 复核者：General（review-synthesis）
- 日期：2026-10-03
- 输入：`/workspace/.audit/attack-backend.md`（28 条攻击，23:06）、`/workspace/.audit/attack-frontend.md`（26 探针，23:23）、`FINAL-REPORT.md` §9/§10（修复记录）、§12（第四批收口）
- 方法：**逐条回源码**。两条复核线的结论一律不采信，只用来定位怀疑点。行号一律以当前文件为准 —— `ErrorCode.php` / `BusinessException.php` / `AlarmExceptionHandler.php` 在 `attack-backend.md` 写完（23:06）之后又被改过（23:14–23:16），报告里的行号已部分失效。
- **只读声明**：本次未修改 `/workspace` 下任何项目文件。唯一的执行动作是 `cd web && pnpm test:run`（只读、不改源码），其余全部为 `read` / `grep` / `stat` / `cat`。

---

## 1. 总判定

> **净收益，但有一条修复的风险大于它修的 bug。**
>
> **S-01 / S-02 / S-03 / S-04 四条是无条件净收益**：核心不变量我逐条回源码确认成立，§12 对 C-5/D-6/D-4/B-7/S-09 的收口在当前树里**物理存在**（不是纸面承诺），引入的真缺陷没有一条落在这四条的核心逻辑上。
>
> **S-10 在当前仓库状态下是净损失**。它修的 fail-open 是真缺陷，方向也对；但它换来的是**一个按 README 的步骤无法恢复的全站 401** —— 因为 `server/` 侧**没有任何代码加载 `.env`**（`composer.json` 无 `hyperf/dotenv`、`config/bootstrap.php` 不存在、`deps.php` 是裸容器），而 README 恰恰教人把 token 写进 `.env`。再加上前端 `api-client.ts:21` 的早退，S-10 制造的 401 在默认态**完全静默**、在 mock 登录后**无限重定向** —— 这正是 S-10 的设计注释（`api-client.ts:37-38`「让 401 暴露出来，而不是静默发一个空 token」）声称要避免的那件事。
>
> 它**不是**要重做设计：装上 dotenv bootstrap + 修掉前端那一行早退，S-10 就从净损失翻成净收益。这是我把它单列、而不是建议回滚的原因。

**三类条目计数：真缺陷 3 / 误报 3 / 遗留暴露 5。**

| 类别 | 条数 | 说明 |
|---|---|---|
| **真缺陷** | **3** | 修复确实引入了问题。1 条 MEDIUM（前端 401 处理）、1 条 LOW-MEDIUM（新测试的环境依赖）、1 条 LOW（注释漂移）。 |
| **误报** | **3** | 复核者攻错了或不成立。含 1 条两份报告都漏掉的、且正是 MEDIUM 真缺陷的根因。 |
| **遗留暴露** | **5** | 不是本轮引入的，但被本轮修复**照亮或放大**了。 |

---

## 2. 真缺陷清单（修复引入的）

### D-1 · MEDIUM · S-10 制造的 401，前端要么完全静默、要么无限重定向

**文件:行号**
- `web/src/lib/api-client.ts:20-27`（`handleUnauthorized`）
- `web/src/stores/auth.ts:4`（`const isLogin = shallowRef(false)`）
- `web/src/router/guard/auth-guard.ts:18-24`
- `web/src/composables/use-auth.ts:26`（唯一把 `isLogin` 置 true 的地方，是 **mock 登录**）

**源码事实**（逐条可核）：

```ts
// api-client.ts:20-27
async function handleUnauthorized() {
  ...
  const authStore = useAuthStore(pinia)
  if (!authStore.isLogin)
    return                       // ← 早退：toast 与 router.push 都在它之后
  authStore.isLogin = false
  toast.error('Your session has expired, please sign in again.')
  await router.push({ path: '/auth/sign-in' })
}
```

`isLogin` 的默认值是 `false`（`auth.ts:4`），全仓只有 mock 登录的 `use-auth.ts:26` 会把它置 true。
而告警页**没有** `<route meta.auth>` —— `<route>` 块只存在于 `src/pages/[...path].vue`、`auth.vue`、`errors*.vue`，所以 `auth-guard.ts:28` 的 `to.meta.auth && !isLogin.value` 这条重定向**不触发**，用户带着 `isLogin === false` 就进了 `/alarm/policy`。

于是有两种失败形态，**都不是**「被踢回登录页」：

| 前置状态 | 401 时的实际行为 |
|---|---|
| 未登录（**默认态**） | `handleUnauthorized` 在第 22 行早退 → **无 toast、无跳转、无任何日志**。页面正常渲染，指标字典 / 策略列表 / 模板字典全部为空，用户看不到任何错误。 |
| 已用假登录页登录 | 401 → toast + `push('/auth/sign-in')` → `auth-guard.ts:19-24` 见 `isLogin && isAuthPage` 且 `from.path === '/alarm/policy'` 合法 → `return from` → **弹回 `/alarm/policy`** → 再次 401 → **无限重定向循环 + toast 风暴**。 |

**为什么这条要紧**：S-10 的整个设计意图是「让 401 暴露出来，而不是静默」。机制层（`onRequest` 不发空 token）做到了，但**最外层的 401 处理器把信号吃掉了**，而且吃掉的方式恰好是静默 —— 比修复前的 fail-open 更难定位，因为它连一条错误信息都不留。

**最小修复**（不要粗暴删掉早退 —— 那个早退本来是为了防止登录页自身 401 时自锁）：
1. `api-client.ts` —— 把 `toast.error(...)` 提到 `if (!authStore.isLogin) return` **之前**，只把 `router.push` 留在守卫之后。改动 1 行位置。
2. `auth-guard.ts:19-24` —— 已经是登录态时不要 `return from` 弹回一个已知会 401 的页面，或让 `policy/index.vue` 在首屏 401 时给出「后端未配置鉴权」的显式提示。

**这是两条复核报告都没抓到的。** 前端报告 G-4 的推理链第 4 步声称的正是被我推翻的那句话（见 §3 误报 M-1）。

---

### D-2 · LOW-MEDIUM · `AuthMiddlewareTest` 的 9 条安全测试建立在一个未声明、未强制的环境前提上

**文件:行号**
- `server/test/Cases/Unit/AuthMiddlewareTest.php:37-43`（`setUp`）、`:68-71`（`withEnv`）
- `server/composer.json` → `"test": "co-phpunit --prepend test/bootstrap.php"`
- `server/test/bootstrap.php:26-28` → `$container->get(ApplicationInterface::class);`
- `server/README.md:110`（`cp .env.example .env`）、`:132`（`ALARM_STATIC_TOKENS=把上一步生成的token粘到这里`）

**源码事实**：这 9 个用例**只**通过 `putenv()` 控制环境变量。但 `test/bootstrap.php` 拉起的是**完整 Hyperf 应用**，而 Hyperf 的 `env()` 仓库里 `EnvConstAdapter`（读 `$_ENV`）与 `ServerConstAdapter`（读 `$_SERVER`）的优先级**高于** `PutenvAdapter` —— 已经存在于 `$_ENV`/`$_SERVER` 的值会盖住 `putenv()`。

具体会炸的是 `testAcceptsTokenOnWhitelist()`（`:101-108`）：`putenv('ALARM_STATIC_TOKENS=tok-aaa,tok-bbb')` 后断言 `isValid('tok-aaa') === true`。一旦任何 adapter 先供出另一个 `ALARM_STATIC_TOKENS`，断言就**因为与被测代码无关的原因**变红。而 README 恰恰教人建 `.env` 并把 token 写进去。

**我没有说它现在就是红的** —— 沙箱无 PHP，PHPUnit 一次都没跑过，我无法判定当前是红是绿。我说的是：**§12.3 声称「D-6 已收口」的覆盖强度，取决于一个既没写进测试、也没写进 README 的环境前提。**

**最小修复**：`setUp()` 里同时清掉超全局变量，`tearDown()` 还原：

```php
unset($_ENV['ALARM_STATIC_TOKENS'], $_SERVER['ALARM_STATIC_TOKENS'],
      $_ENV['ALARM_AUTH_DISABLED'], $_SERVER['ALARM_AUTH_DISABLED']);
```

并在类 docblock 里写明「本测试要求 `ALARM_STATIC_TOKENS` 未被 `.env` / 进程环境预置」，否则后续维护者会把红当成代码坏了去改被测代码。

> 对照组：同批新增的 `PolicyStatusValidationTest` 与 `IntegrityViolationMappingTest` **没有这个问题** —— 它们用 `newInstanceWithoutConstructor()` + 纯入参矩阵，完全不碰进程环境。问题只在 `AuthMiddlewareTest` 这一个文件。

---

### D-3 · LOW · S-03 / S-09 修复留下的注释漂移（纯文档，不影响运行）

| 位置 | 问题 |
|---|---|
| `server/src/Constants/ErrorCode.php:86` | `{@see assertKnownReason()}` —— 全仓不存在这个方法（`grep -rn assertKnownReason` 只命中这行注释本身）。真实方法名是 `knownReasons()`（`:90`）。 |
| `server/src/Constants/ErrorCode.php:36` | 写「409 的 **5** 个语义分支标识」，紧接着 `:41-46` 列出 **6** 个常量（S-09 新增了 `REASON_RELATION_CONFLICT`）。 |
| `server/src/Exception/BusinessException.php:29`、`:62` | 两处都写「409 下有 **5** 个同码分支」，现已是 6 个。 |

**最小修复**：三处 `5` → `6`，`assertKnownReason()` → `knownReasons()`。共 4 个词的改动。

> 为什么单列而不是并进 LOW 堆：这 4 处都精确描述了「409 有几个分支、怎么取文案」这条**正确性不变量**。注释说 5 个而代码有 6 个，下一个照着注释推理的人会得出错误结论 —— 这类漂移在本次审查的语境下（塌缩根因正是同值键覆盖）代价偏高。

---

## 3. 误报清单（复核者攻错了）

### M-1 · 攻击前端 G-4 推理链第 4 步 —— 且它正是 D-1 的根因

**攻击前端 `attack-frontend.md:361` 原文**：
> 4. 401 → `onResponseError` → `handleUnauthorized()`（`api-client.ts:50-53`）→ `isLogin = false` + `router.push('/auth/sign-in')`（该路径已有既存测试覆盖：`src/lib/__tests__/api-client.test.ts:93-108`）

**攻不破的理由 —— 两半都不成立**：

1. **行为不成立。** `handleUnauthorized()` 第 21-22 行是 `if (!authStore.isLogin) return`。`isLogin` 默认 `false`（`stores/auth.ts:4`），告警页无 `meta.auth` 所以用户带着 `false` 就进来了 → 直接早退 → **`isLogin = false` 和 `router.push` 两件事都不会发生**。报告描述的那条路径只在 `isLogin` 已经为 true 时才成立 —— 而那恰恰是会产生**无限重定向循环**的分支。

2. **「已有既存测试覆盖」不成立。** `src/lib/__tests__/api-client.test.ts:48-49`：
   ```ts
   beforeEach(() => {
     vi.resetAllMocks()
     authStore.isLogin = true   // ← 每个用例都从这里开始
   })
   ```
   这个文件的 `beforeEach` **强制把 `isLogin` 置为 true**，所以它**只覆盖已登录分支**；第 97-100 行那句「`isLogin` 为 false 时仍断言 notify/push 被调用」之所以能过，正是因为 `beforeEach` 已经把它改成了 true。**它声称覆盖的分支，恰恰是全仓唯一没有被任何测试走到的分支。**

**影响**：G-4 的**结论**（「S-10 在所有已提交配置下空转」）是对的，**推理链**是错的。而错的推理链掩盖了真实的故障形态（D-1），也掩盖了「已有测试兜底」这个安全错觉。

---

### M-2 · 攻击后端 D-5 把 `AlarmExceptionHandler` 的论证套用到了 `AuthMiddleware`

**攻击后端 `attack-backend.md:401-406` 原文**：
> 「若构造器是本轮新加的，它后面的所有行号都会整体下移。行号未移 ⟹ `AlarmExceptionHandler` 早在审查之前就注入了 `StdoutLoggerInterface`。」
> 随后整节转而论述 `AuthMiddleware` 的「惰性 → 急切」解析风险。

**攻不破的理由**：行号不变性论证**只对 `AlarmExceptionHandler` 成立**，对 `AuthMiddleware` **不成立**：

```
2026-10-03 21:29:40  server/src/Middleware/AuthMiddleware.php   ← 落在 S-10 修复窗口内
```

`AuthMiddleware` 在 S-10 这一轮被整体重写，mtime 就在修复窗口里。而且它此前**根本没有 logger** —— 新增 `private readonly StdoutLoggerInterface $logger`（`:29`）的唯一理由就是给新的 `logger->error()`（`:69`）和 `logger->warning()`（`:59`）用。所以「非本轮引入」的结论对 `AuthMiddleware` **被推翻了**：「急切解析」这个风险面确实是本轮引入的。

**诚实的保留**：我没有推翻这条的**风险存在性**。`AuthMiddleware` 是 `config/autoload/middlewares.php:10` 里的全局 http 中间件，它的依赖会在**第一个请求**构建容器实例时解析（异常处理器的依赖则只在真的抛异常时才解析）。报告怀疑的「`config/autoload/dependencies.php` 为空 + 无 `logger.php` + `config.php` 用 FQCN 当配置键」这个配置形态，**大概率是无辜的**（`config/config.php` 用 FQCN 作 logger 配置键正是 Hyperf 的标准写法；依赖绑定由 `hyperf/logger` 的 ConfigProvider 提供，不依赖 `dependencies.php`），但**无 vendor 无法定案**。§12.9 第 1 条命令至今没执行过。

**归属**：这条不是「攻错了」而是「归因错了，结论侥幸正确」。我放在误报里是因为它给出的确定性（「非本轮引入」）会让读者跳过那个仍未执行的验证命令。

---

### M-3 · 攻击后端 A-6 / C-5 / D-6 —— 成立过，但现在是过期结论，不能按原文继续挂着

这三条在 23:06 写下时**全部正确**，不是编造。但当前树已经变了，按报告原文继续引用就是错的：

| 原报告条目 | 原文判定 | 当前树的实际状态（我逐条回源码确认） |
|---|---|---|
| **A-6** `threshold=1e16` → DECIMAL(20,4) 溢出 → **500** | 攻破 / MEDIUM / 「S-01 修复解除遮蔽后成为 POST/PUT 唯一的 500 来源」 | **已收口。** `AlarmExceptionHandler.php:203` 把 errno `1264` 放进 `PAYLOAD_REJECTED_ERRNOS` → 现在返回 **422**。不再有 500。 |
| **C-5** S-04 新行为零回归测试 | 攻破 / **HIGH** | **已收口。** `server/test/Cases/Unit/PolicyStatusValidationTest.php` 9 个用例，`:53/:61/:81/:89/:97/:125/:135/:141/:148` 覆盖 `required=true` 的 null/空串/显式 0/显式 1/字符串形式/非法值矩阵 + `required=false` 的逐字节不变断言。用反射调私有方法，不碰 DB。 |
| **D-6** S-10 后端零回归测试 | 攻破 / **HIGH** | **部分收口。** `AuthMiddlewareTest` 9 个用例确实存在且有断言（空/纯空白拒绝、trim、显式放行、**拼错开关名必须 fail-secure**、`.env.example` 不得带凭据）—— 但见 D-2，它的有效性有未声明前提。 |

**为什么单列**：这三条是两份报告里**唯一带 HIGH/MEDIUM 权重的「阻塞项」**。它们已经过期但仍以原文形态存在于 `attack-backend.md` 的判定表里，任何直接引用那份报告收口的人都会去修一个已经修好的东西。**收口前必须先把它们标成 closed。**

---

## 4. 遗留暴露项清单（不是本轮引入，但被本轮照亮/放大）

### L-1 · HIGH · `server/` 侧**没有任何代码加载 `.env`** —— S-10 的恢复路径本身可能是断的

**这是本次复核最重要的发现，两条复核报告都没提。**

三条互相独立、各自可核的静态事实：

```
1. composer.json 的 require 里【没有 hyperf/dotenv】
   hyperf/cache, command, config, contract, database, db-connection, di,
   engine, exception-handler, framework, http-message, http-server,
   logger, memory, paginator, process, validation  —— 没有 dotenv

2. config/ 下【没有 bootstrap.php】
   annotations / aspects / cache / commands / databases / dependencies /
   exceptions / memory / metrics / middlewares / server  —— 没有 bootstrap.php

3. grep -rln "otenv" src/ config/  →  全仓零命中
   deps.php:15-18 是 new Container(new DefinitionSourceFactory()())，裸容器，无 bootstrap provider
```

Hyperf 的 `.env` 解析**只**由 `hyperf/dotenv` 包的 `BootEnvironmentProvider` 完成。三条全缺 ⇒ `server/.env` **从不被读入进程环境**，`env('ALARM_STATIC_TOKENS')` 只能看到真实的 shell/`php -S` 环境变量。

**与 S-10 的耦合**：
- `README.md:110` 教 `cp .env.example .env`；`:132` 教把生成的 token 粘进 `.env`；`:140` 教前端 `VITE_SERVER_API_TOKEN` 必须与之一致。
- **照做 ⇒ token 躺在永不被加载的文件里 ⇒ `env()` 返回默认 `''` ⇒ `AuthMiddleware.php:65-75` 走 fail-closed ⇒ 19 个端点全部 401**，`error` 日志只会说「ALARM_STATIC_TOKENS 未配置」。
- 逃生舱 `ALARM_AUTH_DISABLED=true`（`README.md:134`）写在 `.env` 里**同样不生效** —— 只有 `export` 到真实进程环境才有用。

**修复前 vs 修复后**：修复前 `.env` 加载不了 = 白名单读不到 = fail-open = 无鉴权（本来就坏，但**能用**）。修复后 = **按文档配置也无法恢复**。**一个不可诊断的降级，换成了一个不可恢复的降级。** 这就是我判定 S-10 现阶段为净损失的全部理由。

**⚠️ 置信度声明**：这是静态推断，沙箱无 `vendor`、无 PHP，**我无法证实 `hyperf/dotenv` 是通过某个我没找到的传递依赖进来的**。一条命令可定案：

```bash
cd server && composer show hyperf/dotenv 2>&1; \
  php -r 'require "vendor/autoload.php"; \
    putenv("ALARM_STATIC_TOKENS=probe"); \
    echo \Hyperf\Support\env("ALARM_STATIC_TOKENS"), PHP_EOL;'
# 期望：echo 出 probe。若输出空行 → 本条成立，S-10 的恢复路径确实断了。
```

**最小修复**（二选一，都很小）：
- (a) `composer require hyperf/dotenv`，并在 `config/bootstrap.php` 里注册 `BootEnvironmentProvider`（同时让 `deps.php` 的容器构建走到 bootstrap）；
- (b) 接受「只认真实环境变量」，把 `README.md:110-142` 整段改成 `export ALARM_STATIC_TOKENS=...` 并删掉 `cp .env.example .env` 的引导 —— 诚实地告诉部署方 `.env` 在这个项目里不生效。

---

### L-2 · MEDIUM · 前端在所有已提交配置下都不发 token（G-4，§12.7 已承认，至今未处理）

```
web/.env:18          VITE_SERVER_API_TOKEN=     （空）
web/.env.example:18  VITE_SERVER_API_TOKEN=     （空）
web/.env.demo        根本没有这一行（且 VITE_USE_MOCK=true，走 mock）
web/.env:12          VITE_USE_MOCK=false        ← 指向 http://localhost:3000 真后端
server/.env          不存在
```

`api-client.ts:41` 的 `if (!API_TOKEN) return` 正确地不发头；后端已 fail-closed。**两侧默认值互相不匹配 ⇒ 开箱即全线 401。** §12.7 的处理是「等部署方决策」，我认同不该往仓库塞凭据，但**「不塞凭据」和「让部署方知道必须配」是两件事** —— 目前后者只在 `server/README.md:140` 有一句，**前端侧没有任何提示**（`.env.example:18` 是一行空的 `VITE_SERVER_API_TOKEN=`，没有任何说明文字）。

叠加 D-1 之后，这条的实际后果是**静默**的：用户看到的不是 401，而是一个空的告警页。

---

### L-3 · MEDIUM · `threshold` 的量级上界在应用层从未校验（根因未修，只是把 500 换成了 422）

`server/src/Service/Validator/ConditionValidator.php:168-186`（mtime **2026-09-30**，本轮从未改动）只校验「是数值」+「≤4 位小数」，没有量级上界。`assertThreshold` 的小数位检查（`:181`）在 `strpos($text, '.') === false` 时**整段跳过**，所以 `1e16` / `1e17` / `9999999999999999` 全部放行。

- **A-6（500）已由 §12.4 收口**：errno 1264 现在映射为 422（`AlarmExceptionHandler.php:203`）。**已验证。**
- **但根因没修**：应用层仍然可以把任意量级的值送进 `DECIMAL(20,4)`，只是现在由数据库来兜底报错。契约 `docs/alarm/contract.md` 对 `threshold` 也只写了「number，可负数，最多 4 位小数」，**没有量级上界** —— 这是契约缺口，不是实现偏离。
- **A-7（静默失真）完全未修**：`1e-20` → `sprintf('%.10F')` 得 `"0.0000000000"` → 两次 `rtrim` 得 `"0"` → `strpos` 为 false 跳过小数位检查 → `(float)1e-20` 原值入库 → `DECIMAL(20,4)` 落库 `0.0000`。**用户传 1e-20，读回来是 0，全程无任何报错。** 这条仍是有效的 LOW 级遗留。

**最小修复**：`ConditionValidator::assertThreshold` 在 `:181` 之前补一条整数位上界检查（`strlen($intPart) > 16 → 记错 422`），契约同步补一句量级说明。**不要**依赖数据库的 1264。

---

### L-4 · LOW · 模板 `create()` 仍不做 name 预检 —— S-09 改了「怎么报」，没改「为什么会撞」

`AlarmConditionTemplateService::create()` 与 `AlarmNotificationTemplateService::create()` **至今没有任何 name 存在性预检**（`grep -n "nameExists\|where('name'"` 在这两个文件里零命中），唯一性完全依赖 DDL 唯一键 `uk_condition_template_name` / `uk_notification_template_name`。

§12.4 的 `classifyIntegrityViolation()` 确实修好了**误报文案**（1062 → 「策略名称已存在」… 但注意这仍然只对**策略**正确；条件模板/通知模板重名依然会走到同一个分支拿「策略名称已存在」的文案 —— **B-6 报的那个确定性错配，文案层面并没有被真正区分**）。

**最小修复**（不是本轮必须，但既然路过就该记）：`create()` 里先 `where('name', $name)->exists()` 预检，或给 handler 一个「当前请求正在写哪张表」的上下文以选对应 reason。

---

### L-5 · 未决 · S-10 新增的 logger 依赖把容器解析从「惰性」变成「急切」

见 §3 M-2 的保留意见。`AuthMiddleware`（全局 http 中间件）的构造器依赖会在**第一个请求**时解析，而 `AlarmExceptionHandler` 的依赖只在真的抛异常时解析。**若 `StdoutLoggerInterface` 解析失败，故障面从「出错路径 500」扩大到「全站 500」。**

`§12.9` 第 1 条给了定案命令，**至今未执行**。这是 D-6 声称收口后**唯一还没有被任何一轮验证过**的安全关键路径。

---

## 5. 本次复核的覆盖边界与未覆盖项

**先说本次做了什么**：逐条回源码复核 5 条修复；核对 §12 声称的 7 项收口在当前树里**物理存在**；重测了前端基线；发现 2 条两份报告都没有的缺陷。

**本次没有做 / 没有覆盖的**：

1. **后端运行时：仍然为零。** 沙箱无 PHP、无 Composer、`server/vendor/` 不存在、无 MySQL、无 Redis。**本次没有执行过一行 PHP**，`php -l` 都没有跑过。本文的 L-1、D-2、M-2 全部是静态推断。
2. **PHPUnit 仍然一次都没跑过。** §12.3 新增的 20 个用例（`AuthMiddlewareTest` 9 / `PolicyStatusValidationTest` 9 / `IntegrityViolationMappingTest` 10）**全部未执行**。我按测试代码内容判断它们有牙齿（反射调用、`newInstanceWithoutConstructor` 避开依赖图、errno 白名单矩阵齐全、含「服务器自己的问题必须留在 500」的反回归组），但**「有牙齿」不等于「跑过」**，更不等于「跑绿」。
3. **DDL 一次都没执行过。** S-07 / S-17 的 `CREATE TABLE IF NOT EXISTS` + `FOREIGN_KEY_CHECKS` 的 `try/finally` 只有启发式结构检查 + Node 等价实现（`scripts/verify-migration-safety.mjs`）。`information_schema.CHECK_CONSTRAINTS` 里那 29 条 CHECK 是否真的存在，至今无人验证。
4. **前后端真实联调：没有，一次都没有。** 我重跑了 `pnpm test:run`（23 files / **430 passed** / exit 0 / **ECONNREFUSED 计数 0**，后者独立证明 A-2a 的 mock 确实修好了），但**这只证明前端自洽**。没有任何一条 HTTP 请求真正打到过后端。D-1 关于 401 静默/重定向的结论是基于 store 默认值 + guard 源码 + `beforeEach` 实证的**静态推导，未在浏览器中观测**。
   > 附注：`attack-frontend.md` §3 的「430 passed」是在 **23:23** 测的，而 `policy-form.mount.test.ts` 在 **23:42** 又被改过（A-2a/A-2b 收口）、`policy-form.vue` 在 **23:17** 被改过（E-1a）。**该报告 §5「FINAL GIT STATUS == BASELINE ✓」的自证，对它实际报告的那棵树不成立** —— 文件在复核进行到一半时被改了。我重测的数字恰好相同（430），但那是**当前树**的结果，不是那份报告的。
5. **跨端漂移：未处理，且已经产生了一处。** `docs/alarm/contract.md` 的 mtime 仍是 **2026-09-30 15:38**（本轮从未改）。代码里现有 **6** 个 409 语义分支（`ErrorCode.php:30` `RELATION_CONFLICT`，`ErrorCode.php:29` 自己标注为「契约 §0.5 未列举，属增量扩展」），而 `contract.md:111-115` 只列了 **5** 个。
   > 这处漂移是 **§12 的 S-09 修复**带进来的，严格说不在本次「5 条修复」的范围内 —— 但既然本轮要回答「代码是不是更好了」，必须点名：**契约欠了一次同步。**
6. **并发与事务：未压测。** L-4 依赖的 1451/1452 触发路径（并发删除/更新）、S-18 的 TOCTOU，全部只是代码顺序推理。
7. **真实浏览器：无。** 没有 Chrome / Playwright。D-1 的两种失败形态、§9 里所有「已复现」的前端结论，都不是真实浏览器行为。
8. **我没跑的基线项**：`pnpm lint` / `vue-tsc` / `pnpm build` 我**没有**重跑（只重跑了 vitest）。§12.8 声称的前端四项基线我**只独立验证了 test 一项**。
9. **我没有修任何东西。** 本次为只读复核，未修改任何项目文件；上述所有「最小修复建议」都只是建议。

### 尚未被任何一轮验证过的部分（汇总）

| # | 未验证项 | 卡在哪 | 定案成本 |
|---|---|---|---|
| 1 | **`.env` 是否真的不被加载**（L-1，决定 S-10 是净损失还是净收益） | 无 PHP / 无 vendor | 1 条 `composer show` + 1 条 `php -r` |
| 2 | `StdoutLoggerInterface` 能否从容器解析（L-5） | 同上 | `§12.9` 第 1 条已写好 |
| 3 | S-01 落库是否真的成功 | 无 MySQL | `composer test` + 一条 `SELECT metric_namespace, metric_name, metric_name_cn, threshold FROM alarm_policy_condition` |
| 4 | 5+1 个 409 场景各自的文案 | 无运行时 | 6 个 curl |
| 5 | `threshold=1e16` 返回 422 | 无运行时 | 1 个 curl（**注意**：`AlarmExceptionHandler.php:203` 的修复依赖 errno 能被正确取到，PDO `errorInfo` 的实际形态未验证） |
| 6 | 空白名单返回 401 / `ALARM_AUTH_DISABLED` 放行 | 无运行时 | 2 个 curl |
| 7 | **前后端联调：向导走完 → POST 200 → GET 读回三个 metric 字段** | 两端从未同时运行过 | 一条端到端脚本。**这是唯一能一次性证伪 S-01+S-02+S-10 三条修复的实验，目前没人做过。** |
| 8 | 29 条 CHECK 真实存在 | 无 MySQL | `information_schema.CHECK_CONSTRAINTS` |
| 9 | 146 个 PHP 用例真实通过 | 无 PHP | `composer test` |
| 10 | `contract.md` 的 409 分支表与 `ErrorCode` 对齐 | 无人做 | 人工同步 |

---

## 6. 收口建议（按投入产出比排序，均未执行）

1. **跑 L-1 的那一条命令**（1 分钟，决定 S-10 的最终定性）。
2. **修 D-1 的那一行**（把 toast 提到早退之前）—— 这是唯一一条会让用户「什么都不知道」的缺陷。
3. **把 §3 的 M-3 三条在 `attack-backend.md` 里标成 closed**，避免后续收口去修已修好的东西。
4. **补 `contract.md` 的第 6 个 409 分支**，消除已存在的跨端漂移。
5. 装上 `vendor` + MySQL 后按上表 2–9 逐条打勾。**在第 7 条（端到端）跑通之前，不要声称这 5 条修复「已验证」。**

---

**一句话**：**S-01/S-02/S-03/S-04 净收益，S-10 现阶段净损失（一行 `api-client.ts` + 一个缺失的 dotenv bootstrap 就能翻正），3 条真缺陷 3 条误报 5 条遗留，没有一条需要推倒重做 —— 但 146 个后端用例、29 条 CHECK、5 条修复的落库行为，至今一条都没有被真正执行过。**

VERDICT: FAIL（针对「5 条修复已可收口」这一声明；对 5 条修复的代码逻辑本身，4 条 PASS、1 条条件性 FAIL）
