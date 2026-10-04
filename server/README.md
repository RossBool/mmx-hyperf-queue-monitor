# 告警管理后端（Hyperf v3.2）

> 契约：`/workspace/docs/alarm/contract.md`（唯一事实来源）
> 建表 DDL：`/workspace/docs/alarm/schema.sql`　指标字典：`/workspace/docs/alarm/metrics.md`
>
> 实现 19 个 REST 端点（Base URL `/api/alarm`），响应统一包在
> `{ data, extra, code, message, success }` 信封中。

---

## ⚠️ 关于运行时验证的声明（请先读这一段）

**本代码是在一个没有 PHP、没有 Composer、没有 MySQL、没有 Redis 的沙箱里写出来的，
从未执行过。** 具体地，以下事情**一次都没有发生过**：

- ❌ `composer install`（依赖从未安装，`vendor/` 不存在）
- ❌ `php -l`（没有任何一个文件被 PHP 解释器解析过，因此**不保证没有语法错误**）
- ❌ `phpunit` / `composer test`（0 个测试被运行过）
- ❌ `php bin/hyperf.php migrate`（DDL 从未在真实 MySQL 上执行过）
- ❌ `php bin/hyperf.php start`（Swoole 服务从未启动过，没有任何接口返回过 200）

**因此：本项目不存在任何"测试通过""接口返回 200"之类的运行结果。** 交付物
`deliverable.md` 里逐条列出了哪些东西经过核对、哪些没有。

代码的**写法**已逐个对照 Hyperf v3.2 官方源码核对（`hyperf/database` v3.2.5、
`hyperf/validation` v3.2.5、`hyperf/http-server` v3.2.0、`hyperf/db-connection` v3.2.0、
`hyperf/framework` v3.2.0、`hyperf/di` v3.2.2 的 dist 包逐文件阅读），
但**"读起来对"不等于"跑得起来"**。首次部署请严格按下面的自查步骤走。

---

## 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| **MySQL** | **≥ 8.0.16** | ⚠️ **不是 8.0.13**。8.0.16 之前 MySQL 只会*解析* `CHECK` 约束而**静默忽略**，本项目的 29 个 CHECK 会全部失效且**不报任何错**（详见下方"最低版本原因"） |
| PHP | ≥ 8.2 | `composer.json` 约束 |
| Swoole | ≥ 2.10 | `hyperf/engine: ^2.10` |
| 扩展 | `pdo`, `pdo_mysql`, `json`, `redis` | 见 `composer.json` 的 `suggest` / `require` |
| Redis | ≥ 5.0 | `hyperf/cache` 默认 store 使用 |

### 为什么下限是 8.0.16 而不是 8.0.13

MySQL 8.0.16 发布说明原文：

> "Previously, MySQL permitted a limited form of CHECK constraint syntax, but **parsed and
> ignored it**. MySQL now implements the core features of table and column CHECK constraints."
> —— [Oracle Help Center, Changes in MySQL 8.0.16](https://docs.oracle.com/cd/E17952_01/mysql-8.0-relnotes-en/news-8-0-16.html)

8.0.15 上的实测行为（[MySQL 官方博客](https://dev.mysql.com/blog-archive/mysql-8-0-16-introducing-check-constraint)）：

```sql
mysql> CREATE TABLE t1(c1 INTEGER CHECK (c1>0));
Query OK, 0 rows affected
mysql> SHOW CREATE TABLE t1;
CREATE TABLE `t1` (`c1` int(11) DEFAULT NULL) ...   -- 约束直接消失
mysql> INSERT INTO t1 VALUES (0);
Query OK, 1 row affected                              -- 脏数据照进不误
```

**对本项目的意义**：整套设计有 29 个 CHECK 约束在兜底（枚举取值域、`continuity ∈ [1,10]`、
名称长度、`operator` 合法性…）。跑在 8.0.13~8.0.15 上**不会报任何错**，但这 29 条全部静默失效 ——
应用层校验一旦有漏，数据直接变脏，而且症状极难定位。这比迁移直接失败糟糕得多。

> 注意：`utf8mb4_0900_ai_ci` 这个排序规则本身是 MySQL 8.0.0 就有的，**不是**版本下限的原因。

---

## 首次运行自查步骤（务必按顺序执行）

### 第 0 步：安装依赖

```bash
composer install
```

> 如果这一步就报错，多半是 PHP 版本或扩展缺失（`pdo_mysql` / `redis`）。本沙箱从未跑过此命令。

### 第 1 步：先用 mysql 客户端手工验证 DDL（**必做**）

迁移文件里的 DDL 是从 `schema.sql` 逐字抄的，但**从未被执行过**。先手工跑一遍：

```bash
mysql -u<user> -p <db> < /workspace/docs/alarm/schema.sql
```

应无报错。重复执行一次也应无报错（`DROP IF EXISTS` + `INSERT IGNORE`，幂等）。

### 第 2 步：验证 CHECK 约束真的存活（**必做**）

```sql
-- 期望返回 29
-- 若返回 0，说明你的 MySQL < 8.0.16，CHECK 被静默忽略了，数据完整性形同虚设
SELECT COUNT(*) AS alive_checks
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE();
```

```sql
-- 期望 6 张表
SELECT COUNT(*) FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('alarm_policy','alarm_policy_condition','alarm_condition_template',
                     'alarm_notification_template','alarm_notification_receiver','alarm_history');
```

### 第 3 步：配置 `.env`

```bash
cp .env.example .env
```

必改项：

```ini
DB_HOST=127.0.0.1
DB_DATABASE=alarm
DB_USERNAME=root
DB_PASSWORD=你的密码
# 必须与 schema.sql 的表定义一致
DB_CHARSET=utf8mb4
DB_COLLATION=utf8mb4_0900_ai_ci
```

可选：

```ini
# 鉴权占位中间件的 token 白名单（逗号分隔）。
# ⚠️ 留空 = **拒绝所有请求**（fail-closed）。必须显式配置，否则全部告警接口返回 401。
# 生成一个随机 token（不要复用任何示例值，也不要写回 .env.example）：
#     php -r 'echo bin2hex(random_bytes(24)), PHP_EOL;'
ALARM_STATIC_TOKENS=把上一步生成的token粘到这里
# 仅本地联调用：显式关闭鉴权。生产环境禁止设置。
# ALARM_AUTH_DISABLED=true
# 当前登录人姓名（creatorName / handlerName）。接入真实用户服务后由 token 解析。
ALARM_CURRENT_USER=张三
SERVER_PORT=9501
```

> ⚠️ **前端也要配**：`web/.env` 的 `VITE_SERVER_API_TOKEN` 必须与上面的白名单一致，否则所有请求 401。
> 仓库里两份示例 env 的 token **都是空的**——这是故意的，照抄 README 不会得到一个能用的环境。
> 开发期最省事的做法是本地设 `ALARM_AUTH_DISABLED=true` + 前端 `VITE_USE_MOCK=true`，先跑通再接真后端。

### 第 4 步：执行迁移

> ⚠️ **前置**：第 1~2 步的表如果已经手工建好了，`up()` 里的 `DROP TABLE IF EXISTS`
> 会把它们**全部删掉重建**（历史数据丢失）。二选一，不要都做：
>
> - 方案 A（推荐）：**不要**手工执行 schema.sql，直接跑 `migrate`（迁移自带 DDL + 种子数据）
> - 方案 B：只手工执行 schema.sql 做 DDL 验证，验证完 `DROP` 掉，再跑 `migrate`

```bash
php bin/hyperf.php migrate          # 建表 + 写入 3 个通知模板 + 6 个条件模板
php bin/hyperf.php migrate:status   # 确认 7 个迁移全部 ran
```

回滚：`php bin/hyperf.php migrate:rollback`（按 batch **逆序**执行 `down()`，子表先于父表 drop）

### 第 5 步：启动

```bash
php bin/hyperf.php start
```

### 第 6 步：冒烟

```bash
# 指标字典（无需 token 白名单时可直接访问）
curl -s http://127.0.0.1:9501/api/alarm/metrics | head -c 400

# 策略列表（把 $TOKEN 换成你 .env 里配的那个）
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:9501/api/alarm/policies?page=1&pageSize=20'

# 404 语义
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9501/api/alarm/policies/999999
# 期望：{"data":null,"extra":{},"code":404,"message":"资源不存在","success":false}

# 白名单未配置时的行为（fail-closed，应为 401）
# 先 unset ALARM_STATIC_TOKENS 重启，再执行：
curl -s -i http://127.0.0.1:9501/api/alarm/policies | head -1
# 期望：HTTP/1.1 401
```

### 第 7 步：跑测试

```bash
composer test
# 或
vendor/bin/co-phpunit --prepend test/bootstrap.php
```

> `co-phpunit` 是 **`hyperf/testing` v3.2.0 自带的 bin**（已核对该包 `composer.json` 的
> `"bin": ["co-phpunit"]`），所以 `composer install` 之后该命令就可用；
> Hyperf 测试需要 Swoole 协程运行时，不能用裸 `phpunit`。

| 测试套件 | 是否需要数据库 | 覆盖内容 |
| --- | --- | --- |
| `test/Cases/Unit/AlarmRuleTest.php` | ❌ 不需要 | 条件数量/范围、枚举、字典回填、渠道校验、状态机映射、JSON 归一化、指标字典 38 条自检 |
| `test/Cases/Unit/CopyNameTest.php` | ❌ 不需要 | 复制命名顺序、99 次上限、按字符截断、长度 ≤ 128 |
| `test/Cases/Unit/PolicyPayloadValidatorTest.php` | ❌ 不需要 | P12 / P13 / **P14 四类型矩阵 + 12 个反例** / N9 + 真实 `Pagination::fromRequest()`（含非数字 -> 422） |
| `test/Cases/Feature/PolicyPersistenceTest.php` | ✅ **需要** | **update() 全链路（读库断言）**、名称唯一、删除限制、复制、monitorType 联动、启停幂等、历史状态机、时间区间 |

---

## 目录结构

```
server/
├── bin/hyperf.php                 Swoole 服务入口（唯一的 HTTP 服务入口）
├── public/index.php               容器引导脚本（⚠️ 不是服务入口，见文件内注释）
├── deps.php                       容器构建闭包
├── composer.json
├── config/
│   ├── config.php                 应用配置
│   ├── container.php              容器初始化（复用 deps.php）
│   ├── routes.php                 19 个路由，prefix = /api/alarm
│   └── autoload/
│       ├── annotations.php        扫描 src/
│       ├── aspects.php
│       ├── cache.php              hyperf/cache（Redis）
│       ├── commands.php
│       ├── databases.php          MySQL 连接，全部走 env
│       ├── dependencies.php
│       ├── exceptions.php         全局异常处理器注册
│       ├── metrics.php            ★ 38 个指标字典（metrics.md 的机器可读副本）
│       ├── middlewares.php        鉴权中间件
│       └── server.php             Swoole server 配置
├── migrations/                    7 个迁移（6 建表 + 1 种子）
│   ├── 2026_09_30_000100_create_alarm_policy_table.php
│   ├── 2026_09_30_000200_create_alarm_policy_condition_table.php
│   ├── 2026_09_30_000300_create_alarm_condition_template_table.php
│   ├── 2026_09_30_000400_create_alarm_notification_template_table.php
│   ├── 2026_09_30_000500_create_alarm_notification_receiver_table.php
│   ├── 2026_09_30_000600_create_alarm_history_table.php
│   └── 2026_09_30_000700_seed_preset_templates.php
├── src/
│   ├── ApplicationContext.php
│   ├── Constants/
│   │   ├── AlarmEnum.php          ★ 12 组枚举（契约 §1）
│   │   └── ErrorCode.php          ★ 9 个错误码 + 文案（契约 §0.5）
│   ├── Controller/
│   │   ├── AbstractController.php
│   │   └── Alarm/                 6 个控制器，19 个端点
│   ├── Exception/
│   │   ├── BusinessException.php
│   │   └── Handler/AlarmExceptionHandler.php   异常 -> 契约信封
│   ├── Middleware/AuthMiddleware.php
│   ├── Model/                     7 个 Model
│   ├── Service/
│   │   ├── AlarmPolicyService.php
│   │   ├── AlarmConditionTemplateService.php
│   │   ├── AlarmNotificationTemplateService.php
│   │   ├── AlarmHistoryService.php
│   │   ├── AlarmOverviewService.php
│   │   ├── Metric/MetricDictionary.php
│   │   └── Validator/
│   │       ├── ConditionValidator.php   P4-P11 / T2-T3（含 P9 operator 字符串枚举）
│   │       ├── ChannelValidator.php     N2-N6
│   │       └── PolicyPayloadValidator.php  P12 / P13 / P14 / N9
│   └── Support/
│       ├── Pagination.php         分页（v1.0 不开放排序参数）
│       ├── Presenter.php          ★ DB -> API DTO 映射（契约 §2）
│       ├── Response.php           ★ 统一响应信封（契约 §0.2）
│       ├── Text.php               按字符截断 / LIKE 转义
│       ├── Time.php               Y-m-d H:i:s
│       └── Validator.php          字段级错误收集 -> extra.errors
└── test/
    ├── bootstrap.php
    ├── TestCase.php
    └── Cases/{Unit,Feature}/
```

---

## 端点速查

| # | 方法 | 路径 | 响应 `data` |
| --- | --- | --- | --- |
| ① | GET | `/api/alarm/policies` | `Page<AlarmPolicyListItem>` |
| ② | GET | `/api/alarm/policies/{id}` | `AlarmPolicyDetail` |
| ③ | POST | `/api/alarm/policies` | `AlarmPolicyDetail` |
| ④ | PUT | `/api/alarm/policies/{id}` | `AlarmPolicyDetail` |
| ⑤ | DELETE | `/api/alarm/policies/{id}` | `true` |
| ⑥ | POST | `/api/alarm/policies/{id}/status` | `AlarmPolicyDetail` |
| ⑦ | POST | `/api/alarm/policies/{id}/copy` | `{id, name}` |
| ⑧ | GET | `/api/alarm/metrics` | `AlarmMetric[]`（38 条，不分页） |
| ⑨ | GET | `/api/alarm/condition-templates` | `Page<AlarmConditionTemplate>` |
| ⑩ | POST | `/api/alarm/condition-templates` | `AlarmConditionTemplate` |
| ⑪ | PUT | `/api/alarm/condition-templates/{id}` | `AlarmConditionTemplate` |
| ⑫ | DELETE | `/api/alarm/condition-templates/{id}` | `true` |
| ⑬ | GET | `/api/alarm/notification-templates` | `Page<AlarmNotificationTemplate>` |
| ⑭ | POST | `/api/alarm/notification-templates` | `AlarmNotificationTemplate` |
| ⑮ | PUT | `/api/alarm/notification-templates/{id}` | `AlarmNotificationTemplate` |
| ⑯ | DELETE | `/api/alarm/notification-templates/{id}` | `true` |
| ⑰ | GET | `/api/alarm/histories` | `Page<AlarmHistory>` |
| ⑱ | POST | `/api/alarm/histories/{id}/handle` | `AlarmHistory` |
| ⑲ | GET | `/api/alarm/overview` | `AlarmOverview` |

---

## 几个容易踩坑的实现点（都已在代码里标注）

1. **JSON 列归一化（契约 §0.6）**
   - `objectIds` / `objectGroupIds` / `objectFilters` → DB `NULL` 时响应输出 **`null`**，不是 `[]`（R-JSON-1）
   - `notificationTemplateIds` → DB `NULL` 时响应补成 **`[]`**（R-JSON-2）
   - 写库时两者一律落 SQL `NULL`。**绝不能把 PHP 的 `null` 交给 `json_encode`** —— 那样库里会存下
     字面量 `null`，`JSON_CONTAINS(notification_template_ids, ...)` 引用检查会失效。

2. **N9 绑定校验**：预置通知模板出厂 `receivers` 就是 `[]`，所以绑定时会返回 422 并列出未配置完成的模板名。
   `receivers` 的范围是 **0-100**（不是 1-100），见契约 §2.5 / N5。

3. **复制策略命名按字符截断**：后缀 ` - 副本` = 5 字符 / 9 字节，` - 副本(2)` = 8 字符 / 12 字节。
   utf8mb4 下 128 个汉字 = 384 字节，**按字节截断会切出半截字符**。

4. **排序参数未开放**（契约 §0.3）：排序固定 `created_at DESC, id DESC`
   （`alarm_history` 为 `triggered_at DESC, id DESC`），代码里没有 orderBy 入口，从根上杜绝排序注入。

5. **`#[RequestValidator]` 在 Hyperf 3.2 中不存在**。3.x 移除了 2.x 的 `Hyperf\Contract\RequestValidator`，
   因此校验走 `App\Support\Validator` + `ValidationException` 等价路径。
   同样地，`hyperf/validation` 自带的 `ValidationExceptionHandler` 返回的是 `text/plain` + 第一条错误文案，
   完全不满足契约 §0.4 的 `extra.errors[]` 结构，所以 `App\Exception\Handler\AlarmExceptionHandler` 自行实现了翻译。

6. **`PUT /policies/{id}` 是全量更新**，`status` 是唯一不回落默认的字段（只走 `POST /status`）。
   实现为事务内 `DELETE` 子条件 → 批量重新插入。

7. **不要用 `fill() + setRawAttributes($attrs, true)` 更新已存在的模型。**
   第二个参数 `true` 会调 `syncOriginal()` 把 `original` 与 `attributes` 对齐，
   随后 `save()` → `performUpdate()` → `getDirty()` 返回空数组，
   **一条 UPDATE 都不会发出**。本项目改用 `Db::table()->update()` 显式写入。
   参见 `AlarmPolicyService::update()` 内的注释。

8. **`operator` 是字符串枚举**（`> >= < <= == !=`），不能用带 `is_numeric()` 判定的
   数值枚举校验器，否则 `is_numeric('>') === false` 会把所有合法值判为非法。
   见 `ConditionValidator::assertStringEnum()`。

9. **`callbackUrl` 严格按契约的 500 上限**（`AlarmEnum::CALLBACK_URL_MAX = 500`）。
   早期版本为了塞进 `alarm_notification_receiver.contact`（`VARCHAR(255)`）把它收到 255，
   那是对契约的私自偏离。现已改为**不再把回调地址镜像进该冗余表** —— 契约 §2.8 规定
   「读取一律以 `channels` 为准」，`channels` JSON 无长度限制，冲突自然消失。

10. **非数字分页参数一律 422，不静默回落默认值**。`page=abc` 与「没传 page」必须可区分，
    否则会掩盖调用方的 bug。`Pagination::intParam()` 记录字段级错误后由上层一次性收集
    （契约 §0.4 的 `extra.errors` 是数组）。

11. **LIKE 模糊查询的 `ESCAPE` 是真的写进 SQL 的**（`Text::likeCondition()` ->
    `whereRaw()`）。注释不再声称有、代码却没有 —— 见
    `src/Service/{AlarmPolicy,AlarmConditionTemplate,AlarmNotificationTemplate,AlarmHistory}Service.php`
    共 9 处。
