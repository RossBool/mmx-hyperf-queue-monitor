# 告警管理功能 — 交付说明

参照腾讯云可观测平台的告警策略模型，用 **Hyperf v3.2 + shadcn-vue-admin** 实现的告警管理模块。

---

## ⚠️ 先看这里：两端的质量是不对等的

| | 状态 | 依据 |
|---|---|---|
| **前端** | ✅ **验证过能跑** | `lint` / `vue-tsc` / **424 个测试** / `build` 四项全 0，全部真实执行过 |
| **后端** | ⚠️ **从未运行过** | 沙箱无 PHP/Composer/MySQL，109 个测试、迁移、启动**一次都没执行** |

后端是「**经多轮对抗式静态审查的代码**」，不是「验证过能跑的代码」。
审查过程中挖出并修复了 **4 个致命缺陷**（服务无法启动 / 全部写入被拒 / 更新静默丢数据 / 状态码违约），
但**静态审查发现不了运行时问题**。第一次在你本地启动时，很可能还要修一轮。

详细审计见 [`INTEGRATION.md`](./INTEGRATION.md)。

---

## 目录结构

```
docs/alarm/          规格（唯一事实来源，已冻结）
  contract.md          19 个端点 · 12 组枚举 · 46 条业务约束 · JSON 归一化规则
  schema.sql           6 张表 DDL（29 CHECK / 30 索引 / 2 外键）
  metrics.md           38 个指标 + 7 条预置触发条件模板
  domain.md            领域模型 / ER / 状态机

server/              Hyperf v3.2 后端（64 PHP 文件 / 19 端点）
web/                 shadcn-vue-admin 前端（20 组件 / 21 测试文件）
```

---

## 前端（可直接跑）

```bash
cd web
corepack enable && corepack prepare pnpm@11.27.1 --activate   # 首次需要
pnpm install
pnpm dev                      # http://localhost:5173
```

无后端时用 mock 模式体验完整页面流程：

```bash
cd web && VITE_USE_MOCK=true pnpm dev
```

> ⚠️ mock 有已知限制：`query` 参数被丢弃、列表筛选不生效、`/metrics` 只返回 1 条
> （真实 28 条以 `metrics.md` 为准）。**mock 只用于看页面，不要用它判断筛选逻辑是否正确。**
> mock 开关**默认关闭**，生产构建不会走 mock。

验证：

```bash
pnpm lint && pnpm test:run && pnpm build
```

## 后端（需你本地验证）

**前置：PHP ≥ 8.2 + Swoole ≥ 5.0 + 扩展 `bcmath/json/pdo/redis`，MySQL ≥ 8.0.16。**

> 🔴 **MySQL 版本是硬要求，不是建议。** 8.0.16 之前 MySQL 只*解析* `CHECK` 约束而**静默忽略**——
> 本项目 29 条 CHECK 会全部失效，**且不报任何错**。

```bash
cd server
composer install
cp .env.example .env            # 填 DB 连接
php bin/hyperf.php migrate      # 建表
php bin/hyperf.php start
```

### 首次运行必做的两步自查

```bash
# ① 先手工验证 DDL 能干净执行（迁移从未被真实执行过）
mysql -u<user> -p<pass> <db> < ../docs/alarm/schema.sql

# ② 确认 CHECK 约束真的被强制执行了（返回 0 = 你的 MySQL 太老，约束形同虚设）
SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE();
```

**启动后第一个要验的**：`GET /api/alarm/policies` 是否能通。
路由是启动期代码，静态审查只核对了官方签名，**19 个端点是否真注册成功只有启动才知道**。

---

## 已实现的功能

**告警策略**：列表（多维筛选/条件摘要/启停开关）、三步新建向导（支持套用预置模板）、
编辑（全量更新语义）、详情、复制（`- 副本` + 按字符截断保证唯一）、
删除（仅停用可删，409 有专门提示）

**通知模板**：列表/新建/编辑/删除、渠道多选、回调 URL 条件必填、
**N9 绑定校验**（接收人为空视为未配置完成，绑定时拦截）

**告警历史**：统计卡片、策略/等级/状态/关键词/时间范围筛选、
三种处理动作（处理/忽略/已恢复）、从策略页带参跳转、请求竞态防护

**后端**：19 个端点全实现，统一响应信封、分页、异常处理中间件、
按表拆分的迁移（一条语句一次执行）、109 个测试方法

---

## 两个**已知契约缺口**（未自创字段，需要你决策）

**1. 通知模板没有启用/停用状态。**
契约 §2.5 的 `AlarmNotificationTemplate` **无 `status` 字段**，⑬ 的查询参数也只有
`keyword` / `channel` / `isPreset` / 分页。所以列表的第三个筛选做的是
「系统预置 / 自定义」，**没有启停开关**。
→ 若确需启停，**要先给后端加契约**，不是前端能补的。

**2. 接收人没有数据源。**
契约未提供人员/用户组端点，因此做成可增删的标签式手动录入，
并在表单说明里注明了原因。→ 接入真实人员系统需要补契约。

---

## 跨端一致性

审计矩阵 **228 项全部通过，0 漂移**（端点 19 / DTO 字段 94 / 枚举 12+3 /
信封分页 10 / JSON 归一化 6 / 业务规则 42 / 指标 28 / DDL 列 6）。

> 审计过程本身值得记一笔：脚本先后报出 13/19/5/2 处「漂移」，逐条追查后**全部是解析器缺陷**
> （契约表头漏采、TS `extends` mixin、PHP 无引号数值键、CJK 正则、缺 `re.S`）。
> **只看脚本输出就下结论，会凭空报出 39 处不存在的漂移。**
