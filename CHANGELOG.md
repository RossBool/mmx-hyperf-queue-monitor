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

## 2026-10-03 · 五批修复 + 对抗式复核

一轮**四线对抗式审查**（51 条原始发现去重为 44 条）之后，做了五批修复，
随后又发起了**针对修复本身的对抗式复核**（54 个攻击/探针）。

### 修复清单

| 编号 | 问题 | 级别 |
| --- | --- | --- |
| S-01 | `insertConditions()` 把 camelCase 条件键直接写入 snake_case 表 → 全部落库失败 | 阻塞 |
| S-02 | `computed(() => form.state.values)` 响应式依赖图为空 → 向导永远停在第 1 步 | 阻塞 |
| S-03 | 5 个语义常量求值都是 409，被当数组键 → 5 条文案塌缩成 1 条 | 严重 |
| S-04 | 启停接口缺 `status` 时静默停用线上策略并返回 200 | 严重 |
| S-05 | 通知模板字典 `pageSize:100` 截断 → 字典外的 id 被判「不存在」，保存必失败 | 严重 |
| S-07 | 6 个 `up()` 无条件 `DROP TABLE` → 重跑迁移静默清空整表 | 严重 |
| S-08 | `schema.sql` 声明 `MySQL >= 8.0.13`，而 8.0.16 以下**只解析不执行 CHECK** → 29 条约束静默失效 | 严重 |
| S-09 | `isDuplicateKey()` 把整个 SQLSTATE `23xxx` 当「重名」→ 外键失败被报成「策略名称已存在」 | 严重 |
| S-10 | 鉴权中间件白名单为空时 fail-open → 漏配一个环境变量即全部接口无鉴权 | 严重 |
| S-17 | 迁移不设 `FOREIGN_KEY_CHECKS` → 失败后 errno 3730 不可自愈 | 中等 |

### 复核过程中发现并修掉的、**由修复本身引入**的问题

这几条值得单独记，因为它们是「改完之后才发现」：

- **本以为 fail-closed 是纯收益，结果它把服务锁死了。**
  `composer.json` 缺 `hyperf/dotenv`、`config/bootstrap.php` 不存在 →
  `env()` 没有数据源 → `ALARM_STATIC_TOKENS` 恒为空 → 配合新的 fail-closed
  语义，**19 个端点永久 401，且 `ALARM_AUTH_DISABLED` 这个逃生舱同样读不到**。
  修复前的 fail-open 在这个仓库里**恰好是能用的**（不安全但通）。
- **`.env.example` 预填了可用的 `dev-token-1`**，而 `composer.json` 的
  `post-root-package-install` 会自动 copy 成 `.env` → 白送公开凭据。
- **S-04 改了行为却没有一条测试**：既有 5 处 `changeStatus` 全传 0/1，从没传过 `null`/``。
- **S-10 改了全部 19 个端点的鉴权语义，后端零测试**。
- **401 在默认态被完全吞掉**：`handleUnauthorized()` 第一行就早退，
  无 toast、无跳转、无日志 —— 正好是 S-10 声称要避免的「静默」。
  顺带发现原来 `isLogin` **兼职当了去重器**，把 toast 移出守卫会导致并发 401 刷屏。

### 验证边界（务必阅读）

- ✅ **前端**：`lint` / `vue-tsc` / `test:run` / `build` 全 0，**431 用例 / 23 个测试文件**
- ✅ 后端 56 个 PHP 文件通过结构检查；3 个可复现的验证脚本（迁移幂等性、S-09 分类表）
- ❌ **后端一行 PHP 都没执行过**。`server/vendor` 不存在，沙箱无 PHP / Composer / MySQL / Redis。
  151 个测试方法**从未运行**，D-2 的超全局变量优先级是静态推理而非实测。
- ❌ **未做前后端真实联调**，告警引擎的触发/去重/投递完全未审。

> 因此后端只能称为「经过多轮静态审查的代码」，**不能**称为「运行验证通过」。

### 本次新增

- `server/config/bootstrap.php` —— env() 的唯一数据源加载点
- 4 个后端测试文件（`AuthMiddlewareTest` / `PolicyStatusValidationTest` /
  `IntegrityViolationMappingTest` / `EnvBootstrapTest`），
  测试方法数 **109 → 151**
- `web/src/lib/__tests__/api-client.auth.test.ts` —— Bearer 头回归
- `.audit/` 8 份审查与复核报告（84KB 主报告 + 4 份攻击报告 + 汇总判定）
- `scripts/` 3 个可复现的验证脚本


---

## 2026-10-04（第二段）· 指标覆盖度第一性原理分析 + 扩充至 38 个

### 起因

前一轮把 44 条审查发现修掉约 10 条后，暴露出一个更根本的问题：
**28 个指标是按「资源清单」枚举的，不是按「失效模式」枚举的。**

### 分析方法

新建 `docs/alarm/metrics-gap-analysis.md`。不从「腾讯云有什么指标」出发，
而是从**监控系统为什么存在**推导它必须能发现什么，得到 A–F 六类故障语义，
再用三个判据筛掉那些「靠别的指标就能发现」的伪缺口：

| 判据 | 问题 |
| --- | --- |
| R1 故障可达性 | 对应故障用户真的会遇到吗？ |
| R2 状态不可见性 | 这类故障不告警，用户多久会发现？ |
| R3 现有覆盖 | 现有指标里有没有别的能间接发现它？ |

### 三条最重要的发现

1. **E 类「异常」整类缺失** —— 28 个指标全是静态绝对阈值，
   契约 `operator` 只有 `> >= < <= == !=` 六个比较算子，
   **没有同比/环比/突变判据**。QPS 从 100 跌到 10、延迟从 20ms 涨到 300ms
   这类「相对自身基线的异常」全部逃逸。
2. **A 类「流量断流」无专用指标** —— `HttpRequestCount` 阈值 10000 只能发现「QPS 冲到一万」，
   发现不了「QPS 归零」。理论上 `HttpSuccessRate` 能兜底，但 QPS=0 时分母也是 0，
   不同实现返回 0% 还是 100% 没有统一约定 —— **靠语义未定义的指标兜底最严重的故障不可接受**。
3. **D 类「将耗尽」看着最全、实际漏 4 项** —— CPU/内存/磁盘/IO/连接数五项齐全，
   但漏了 FD 耗尽、inode 耗尽、预计写满天数、IOPS。
   根因是按资源种类枚举：同一份资源有多种耗尽方式（块满 / inode 满 / FD 满 / 配额满），每种独立失效。

### 已落地（不涉及契约变更的 10 个新指标）

| namespace | 新增 | 补的是哪一类缺口 |
| --- | --- | --- |
| CVM +5 | `FileDescriptorUsageRate` / `InodeUsageRate` / `DiskDaysToFull` / `DiskReadIops` / `DiskWriteIops` | D 将耗尽 |
| WEB +1 | `HttpMaxDuration` | B 变慢（P99 之后的长尾） |
| CLB +1 | `ClbBackendResponseTime` | B 变慢（与 `HttpP99Duration` 交叉定位） |
| MYSQL +3 | `MysqlDeadlockCount` / `MysqlLockWaitTime` / `MysqlConnectionRejectCount` | C 错误 |

**指标总数 28 → 38**（CVM 15 / WEB 9 / CLB 5 / MYSQL 9）。

`DiskDaysToFull` 是全字典**唯一** `defaultOperator` 为 `<` 的指标（「越低越糟」），
已确认 `ConditionValidator::assertThreshold` 用的是 `===` 严格比较，
`threshold = 0` 不会被 falsy 误判成缺省（S-04 踩过的坑没有重演）。

### 预置模板 7「流量断流」

A 类缺口的唯一落地方式：`HttpRequestCount` + `<` + 阈值 `1` + 紧急等级。
落在**新建的迁移文件** `2026_10_04_000800_*.php`，
**不改已应用的 000700**（改已应用迁移是「模板在不同环境行为不同」的经典成因）。

### UI 死胡同修复（F-a）

契约说 `monitorType` 的 3/4/5 不可选，但向导此前把它们**全列在下拉里**。
用户选「前端性能监控」→ 策略类型为空 → 提示「暂无可用策略类型」
→ **既走不完向导，也退不出这个选择**。这是功能不可用，不是体验瑕疵。

修法是**不提供不可选项**（`alarmSelectableMonitorTypeOptions`，按联动表数据驱动过滤），
**同时**让存量值可见：若表单当前值是 3/4/5，追加一项并标注「（v1.0 不可选）」。
不这么做的话，编辑这类存量策略时 Reka Select 找不到匹配 item 会回退显示 placeholder，
**真实值凭空消失**（数据库层没有 CHECK 强制，这类数据确实可能存在）。

列表筛选器**保留全量 5 项** —— 筛选项要能查存量，筛选器不负责「新建时能不能选」。

### mock 与文档一致性

- `web/src/mocks/index.ts` 的 `/metrics` 原先只有 **1 条手写** 指标，
  注释还写着「不要把这份数据当字典用」。现改为从后端字典生成（`gen-mock-metrics.mjs`），
  **mock 与真实字典不可能漂移**。
- 新增 `verify-metrics-consistency.mjs`：**三处 × 10 字段 × 38 指标**全比对
  （metrics.md ↔ metrics.php ↔ generated.ts），
  并校验 contract.md 的计数与两个文件的头注释。
  已验证它能抓出：改一个 threshold / 往 description 塞反引号 / 删掉一个指标。

### 交叉校验发现并修掉的 3 处漂移

独立复核（自写 Python 解析器，未复用任何现成脚本）判定
**「单一事实来源」不变量不成立** —— 原先的校验只比 9 个字段，**漏了 `description`**：

| 漂移 | 归属 |
| --- | --- |
| 8 个字面反引号残留（`long_query_time`、`max_connections`…） | **原有 28 条就有的**，扩充时原样保留 |
| `DiskDaysToFull` 多一个空格 | **本轮引入** |
| `metrics.php` 头注释仍写「共 28 个」 | **本轮引入** |

反引号那条的实质：metrics.md 里反引号是 markdown 行内代码（渲染后消失），
而 php 是纯文本字符串，**接口会把带反引号的文本原样显示给用户**。已全部剥离。

### 验证边界

- ✅ 前端四项基线全 0；`verify-metrics-consistency.mjs` 与
  `verify-preset-template.mjs` 均通过且有牙齿
- ❌ **后端仍一行 PHP 都没跑过**；新增迁移 000800 从未执行；
  10 个新指标的 `defaultThreshold` 未经真实监控数据校准（文档中已标注为占位）


---

## 2026-10-04（第三段）· 指标扩充轮的对抗复核与修复

对上一段的 10 个新指标 + 模板 7 + 守卫脚本 + UI 死胡同修复做了对抗式复核。
两条攻击线，一条专攻新指标本身，一条专攻跨源一致性。
**攻破 3 个 BLOCKER / 2 个 HIGH / 4 个 MEDIUM / 2 个 LOW，全部已修。**

### 3 个 BLOCKER

**B-1 迁移 000800 写了一个不存在的列 —— 模板 7 在任何环境都插不进去**

建表迁移里该列叫 `remark`，新迁移写成了 `description`。
真实 MySQL 上是 `ER_BAD_FIELD_ERROR (1054)`，
而 `INSERT IGNORE` 只降级**数据类**错误，**列名解析错误发生在 prepare 阶段，异常照抛** →
`up()` 的 `try/finally` 只恢复 `FOREIGN_KEY_CHECKS`，迁移失败，发布卡住。

这类错误属沙箱盲区（无 PHP/MySQL），补了 `verify-migration-columns.mjs`：
解析每张表真实列，核对所有 INSERT 的列名与必填项。
**顺带修掉一个老问题**：`alarm_history` 缺 `created_at`，在 `000200` 里补上。

**B-2 后端测试套件是红的**

`AlarmRuleTest` 仍断言 28/8/4/10，而字典已是 38/9/5/15。
这条印证了一条判据：**「断言了实现给不出的值」= 证明测试从未运行**。
已改数字，并**补上 MYSQL 的条数断言**（它之前完全没有保护）。

**B-3 「前端基线全 0」这句话当时是假的**

加完 `alarmMonitorTypeOptions` 那行 import 后没重跑 lint，`pnpm lint` 实际退出码 1。
印证另一条：**「构建和类型检查全绿」不等于 lint 也绿**。

### 2 个 HIGH：两个守卫脚本在夸大自己的作用

| 脚本 | 它的文案声称 | 实际只做 | 复核实测 |
| --- | --- | --- | --- |
| `verify-preset-template.mjs` | 「三处逐字一致，漂移就报错」 | 只比 `conditions` 那段 JSON，**6 项内容守 1 项** | 改模板名 / 改 policy_type / 改文案，**全部 EXIT=0** |
| `sync-metrics-backend.mjs` | 「38 个指标**逐项一致**且顺序一致」 | 只比 `namespace.metricName` | 阈值 7→99、单位 IOPS→GB/s，**全部 EXIT=0** |

H-4 的盲区**恰好包含 B-1 出错的那一列**。

**这比没有守卫更危险 —— 它给人虚假的安全感。**
已把两处措辞改成各自真正做的事，补上缺失断言，
并新增真正逐字段比对的 `verify-metrics-consistency.mjs`（三处 × 10 字段 × 38 指标）。

### 4 个 MEDIUM

- **`DiskDaysToFull` 的 description 自称「本字典中唯一一个『越低越糟』的指标」—— 是假的**，
  `HttpSuccessRate` 早就在字典里且同为 `<`。
  这段文案会经接口返回给用户、进指标选择器展示，是**面向用户的数据字段**，不是注释。
- **模板数 6→7 一个地方都没改**：`metrics.md` 的章节标题写着
  「## 3. 6 条预置触发条件模板」，而**模板 7 就写在这个章节里**。
  对比：`contract.md` 的 28→38 改了，同一文件里的 6→7 一次没扫 —— **28→38 是部分扫过的**。
- **13 处「28」残留**：改掉描述当前状态的 11 处；
  **保留 `metrics-gap-analysis.md` 的 4 处**（那是对扩充前现状的历史陈述，
  改了等于篡改分析记录的前提）。判断写进了 `fix-stale-metric-counts.mjs`，不靠人肉 grep。
- **`metrics.md` 自相矛盾**：§1.5.2 说流量断流「仍缺」，§1.5.3 说模板 7 补上了。
  技术上两边各自成立（「覆盖」列统计**指标**，模板 7 是给已有指标换算子方向），
  是**措辞没交代统计口径**。已补口径说明。

### 2 个 LOW

- **存量 monitorType 兼容路径，仓内测试是复刻件**（docblock 自己写着「复刻」）——
  复刻件**可以和生产代码一起错**。复核方挂载真组件验证了产品行为正确，
  但那份测试写在 `/tmp` 没进仓，等于**仓里对这条路径零真组件覆盖**。
  已把真挂载测试补进 `policy-form.mount.test.ts`，并做负对照：
  拆掉存量值合并 → 3 个测试红；关掉新建态过滤 → 1 个测试红。
- **`gen-mock-metrics.mjs` 遇多行 description 会静默产出 null**。
  PHP 单引号字符串允许含换行，若其中一行恰好是 `    ],`，
  `BLOCK` 正则会提前截断。已补结构性断言
  （解析条数必须等于源文件 4 空格缩进数组块数）+ 换行禁令 + 报错指向真正成因，
  并用复核方给的构造用例做负对照。

### 修复后的验证边界

**✅ 真跑过并全绿**

- 前端四项基线：lint 0 / vue-tsc 0 / **449 个测试通过（24 个文件）** / build 18.49s
- 6 个守卫脚本 EXIT=0，且**逐个验证过注入错误会变红**（见报告 §4）

**❌ 仍未运行**

- **后端 151+ 个测试方法一行都没执行过**
- 迁移 000100～000800 **从未在真实 MySQL 上跑过**；
  B-1 那个 1054 正是纯静态比对抓出来的 —— **静态校验不能替代真跑**
- `env(` / Dotenv 在真实 Hyperf 3.2 + Swoole 下的行为未验证
- 10 个新指标的 `defaultThreshold` **未经真实监控数据校准**（文档已标注为占位）

**本轮交付可称「经过多轮静态审查与对抗式复核」，不能称「运行验证通过」。**

---

## 2026-10-04（第四段）· 后端首次真实运行：PHP 8.2.33 + MySQL 8.0.46 + Swoole 6.2.3

前三段的所有后端结论都基于**静态审查**。这一段把整套环境在云端装起来，
第一次真正执行了 PHP、MySQL 和测试套件。

### 环境

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| PHP | 8.2.33 | Debian 12 自带，满足 `php >= 8.2` |
| Swoole | 6.2.3 | pecl 源码编译，`co-phpunit` 依赖它 |
| MySQL | **8.0.46** | 满足 `>= 8.0.16` 的 CHECK 约束硬前提 |
| Composer | 2.10.3 | — |
| PHPUnit | 11.5.56 | Hyperf `hyperf/testing` 附带 |

> MySQL 官方 APT 源的 GPG key 已过期（EXPKEYSIG / NO_PUBKEY B7B3B788A8D3785C），
> 验证环境用了 `[trusted=yes]` + 官方源。只影响本机，不影响交付代码。

### 结果

**252 个测试 / 730 个断言全绿**（首次执行，此前从未跑过一条）。

首次执行时是 **33 failures + 17 errors**。逐条回源码核实后全部处理，
其中 **4 个是真生产 bug**，只有真跑才暴露得了。

### 4 个真生产 bug

#### P-1 依赖包名不存在 → 整个项目无法部署

`composer.json` 里写的是 `hyperf/dotenv`。**Packagist 上没有这个包**
（`p2/hyperf/dotenv.json` → 404），`composer install` 直接失败。

这是我上一轮为修 `env()` 阻塞而**自己引入**的：当时只做了静态判断，没跑 install。
正确包名是 `vlucas/phpdotenv`（hyperf 自己用的也是这个）。

#### P-2 通知模板「配置完成度」恒为 false → 任何模板都绑不上策略

`AlarmNotificationTemplate` 的 `$casts` 里**没有** `channels`，
所以模型属性读出来是**原始 JSON 字符串**。而 `Presenter::normalizeChannels()` 
直接 `(array) $channels`，字符串被当成单元素数组 → 读不到 `channel` 键
→ PHP 8 抛 Undefined array key，值退化成 0 → `isUnconfigured()` 看到
`channel=0`（不是回调）+ `receivers=[]` → **恒返回 true**。

后果：用户把配好接收人的通知模板绑到策略上，会被 422 拒绝并提示
「以下通知模板尚未配置接收人」。这是**每个用户必经的主路径**。

#### P-3 ID 列表解析把 JSON 字符串变成 `[0]`

`Presenter::intList('[8801,8802]')` 曾返回 `[0]`：
`(array) '[8801,8802]'` = `['[8801,8802]']`，再 `intval('[8801,8802]')` = 0
（字符串以 `[` 开头，没有数字前缀）。主路径靠 Model 的 `'array'` cast 侥幸没踩到，
但任何 `Db::table()->select()` 或漏配 cast 的 Model 都会踩。

#### P-4 中文名按字节截断 → 128 字只允许约 42 字

`Text::truncateChars()` 用的是 `mb_strcut($s, 0, $maxChars)`，
而 `mb_strcut` 的第三个参数是**字节宽度**，不是字符数
（函数名里的 “cut” 就是「按显示宽度切」）。

实测：`mb_strcut(str_repeat("告",200), 0, 123, "UTF-8")` → **41 字符 / 123 字节**。
混排 `"ABC" + 100 个"告"` 切 5 字节时只得到 `"ABC"`，后面的字**静默丢失**。
应为 `mb_substr`。

`VARCHAR(128)` 与 `ck_policy_name_len` 都按字符计，
所以这条让「中文策略名实际只能写 42 个字」，而 DB 允许 128 —— **应用层和存储层约束不一致**。

### 5 类启动期致命错误（一条测试都跑不起来）

| 位置 | 问题 |
| --- | --- |
| `config/autoload/aspects.php` | 返回 `['aspects' => []]`，但 Hyperf 要的是**扁平类名列表**。那个键被当成名叫 `aspects` 的切面类去反射 → `Class aspects not exist` |
| `config/autoload/server.php` | 用 `env()` 却没 `use function Hyperf\Support\env;` → `Call to undefined function env()` |
| 6 个 Model | 属性类型与父类不符：`$primaryKey/$keyType` 父类是**非空** `string`，子类写 `?string`；`$casts/$fillable` 父类是 `array`，子类无类型 |
| `App\Model\Model` | `$dateFormat` 写成非空 `string`，父类是 `?string` |
| 2 个测试文件 | 匿名类只实现 `ConfigInterface::get`，3.2 有 3 个方法；用匿名子类覆盖 `getCode()`（PHP 里是 `final`） |

PHP 的属性类型规则比方法参数严格：**子类不能把父类的可空属性收窄成非空，
也不能用无类型覆盖有类型的父属性**。这些全部是**类加载时**致命错误，
症状统一表现为「一条测试都没跑」—— 极易被误读成环境问题。

### 11 条测试自身写错（代码是对的，测试是错的）

| 测试 | 错在哪 |
| --- | --- |
| `AlarmRuleTest` ×12 | `['sort'=>1] + validCondition() + ['threshold'=>X']` —— PHP 的 `+` **左边的键优先**，`validCondition()` 里已有 `threshold`，第三段是**空操作**。这批用例从来没测过它声称的东西 |
| `MigrationSafetyTest` | 数据提供器写死旧文件名（少了 `_table` 后缀），6 条里 4 条指向不存在的文件 |
| 同上 | `schema.sql` 路径少一层 `../`，**S-08 的守卫一直在空转** |
| `AuthMiddlewareTest` | 正则用 `\s*` 会**吃掉换行**，跨行匹配到下一行的 `#`，把正确的空值配置判成「有预填值」 |
| `PolicyPersistenceTest` | 契约 §0.4 规定 `extra.errors` 是**列表**，测试按 map 的 `assertArrayHasKey` 断言 |
| 同上 | 源策略用 `status=1` 创建却直接删，与「已启用不可删除」自相矛盾 |
| 同上 | 断言 `'[8801,8802]'` —— 那是 MySQL JSON 列的输出格式，与本项目无关 |
| `AlarmRuleTest` | 断言截断结果以 ` - 副本` 结尾，但 `truncateChars` 不追加后缀（那是 `copyNameCandidates` 的职责） |

### 守卫升级

`MigrationSafetyTest` 的数据提供器改成**实扫目录**，新增/改名迁移不会再指向空气。
`EnvBootstrapTest` 加了两条行为断言：`class_exists(Dotenv::class)`
（挡住「包名写对但没装」）、以及**真的**往 `getenv()` 里灌一次值
（挡住「换了不带 PutenvAdapter 的构造方式」）。
`intList` 补了 12 个输入形态的 data provider，把 JSON 字符串这条真实形态钉死。

### 迁移在真实 MySQL 上的结果

`run-migrations.php` —— 8 个迁移 `up()` **全部成功**：

| 表 | 列 | 索引 | CHECK | FK |
| --- | --- | --- | --- | --- |
| `alarm_policy` | 19 | 8 | 8 | 0 |
| `alarm_policy_condition` | 15 | 4 | 6 | 1 |
| `alarm_condition_template` | 10 | 4 | 4 | 0 |
| `alarm_notification_template` | 9 | 4 | 3 | 0 |
| `alarm_notification_receiver` | 6 | 4 | 1 | 1 |
| `alarm_history` | 29 | 6 | 7 | 0 |

- 6 表 / **29 CHECK** / 30 索引 / **2 FK** / **7 条预置模板** —— 与 schema 一致
- **幂等性**：重跑 8 个迁移，模板数 7 → 7，无重复
- **回滚**：000800 `down()` → 6 条，再 `up()` → 7 条
- **FK 开关**：`try/finally` 生效，全局 `@@FOREIGN_KEY_CHECKS = 1`
- **CHECK 真的在执行**：建带 CHECK 的探针表插越界值被拒
  （8.0.16 以下会静默插进去，这正是版本硬下限的原因）

### 运行期验证（`verify-runtime.php`，15 项全过）

- CHECK 约束执行性
- 字典 38 条 / CVM 15 WEB 9 CLB 5 MYSQL 9 / 唯一键无重复 / 每条 10 字段 / description 无反引号
- `env()` 链路：`getenv(DB_DATABASE)` 与 `getenv(ALARM_AUTH_DISABLED)` 均读到值
- 409 **六个**语义分支文案两两不同、都非空、code 都是 409
- JSON 空值归一化：空值统一为真 `SQL NULL`，不是 `'[]'` / `'null'` 字符串

### 仍未验证

- **HTTP 层端到端**：19 个端点没走过真实请求。Swoole 已装、`bin/hyperf.php start` 可用，
  但本轮未启动服务（需要 Redis，且起服务的价值低于直接验 Service 层）。
- **告警引擎**：触发 / 去重 / 投递本项目只做管理面，不含引擎。
- **10 个新指标的 `defaultThreshold`**：仍未经真实监控数据校准。

VERDICT: PASS

---

## 2026-10-05（第五段）· HTTP 端到端：19 个端点真跑，抓出 5 个真生产 bug

第四段把后端跑到了 Service 层，HTTP 层仍是一整条**从未被执行过**的链路：
中间件 → 路由 → 容器装配 → 参数绑定 → 异常处理 → HTTP 状态码。
契约 §0.5 把业务 code 和 HTTP 状态码绑定（409 / 422 / 401 各不相同），
这一层错了，前端拿到的状态码就和契约对不上。

这次装齐 Redis，用 `scripts/setup-backend-env.sh` 把环境固化成可复现脚本，
起真实 Swoole 服务，用 `scripts/e2e-http.mjs` 打真实 HTTP 请求。

### 结果

**19 个端点 + favicon，60 条断言全绿。**

首轮 31 条失败。逐条回源码核实后，**5 个是真生产 bug**，其中 3 个是致命的。

### 致命级：整个 API 是死的

#### H-1 鉴权中间件调用了不存在的方法 → 每个请求 500

`AuthMiddleware` 用 `$request->header('authorization', '')` 取 token。
`header()` 是 **Laravel / Symfony 风格**的便捷方法，PSR-7 没有，
Hyperf 3.2 的 `Hyperf\HttpServer\Request` 也不提供。
实测 `method_exists(Request::class, 'header')` → `false`。

后果：**每一个请求都 500**，19 个端点全部不可用。
之所以单测没抓到：`AuthMiddlewareTest` 用的是手写桩对象，
桩上恰好定义了 `header()` —— **桩比真实实现更宽松 = 测试在验证一个不存在的 API**。
已改用 PSR-7 标准的 `getHeaderLine()`。

#### H-2 列表/筛选/分页的 26 处取参全部调用不存在的方法

`$request->input(...)` 同理不存在。这 26 处覆盖**全部**列表端点的查询参数：
keyword / page / pageSize / policyType / status / level / projectId / monitorType / isPreset / channel / startTime / endTime。
后果：除了 `/metrics`（当时还没走到取参）之外，**所有列表端点一律 500**。

修法：新增 `App\Support\Query::get()`，明确走 PSR-7 的 `getQueryParams()`。
**刻意不引入** `input()` 这种 Laravel 兼容别名 —— 名字一旦对齐，
读代码的人会以为这里跑的是 Laravel 语义，而底层根本不是。

#### H-3 6 个控制器的构造函数注入了未绑定的接口 → 全部无法实例化

`AbstractController` 注入的是 `Hyperf\HttpServer\Contract\ResponseInterface`（**已绑定**），
而 6 个子类注入的是 `Psr\Http\Message\ResponseInterface`（**纯 PSR-7，未绑定**）：

    Entry "App\Controller\Alarm\AlarmMetricController" cannot be resolved:
    Entry "Psr\Http\Message\ResponseInterface" cannot be resolved:
    the class is not instantiable

后果：6 个控制器**全部**无法实例化，19 个端点无一可用。
已改为构造参数用绑定类型、方法返回类型仍用 PSR-7。

### 严重级

#### H-4 唯一键冲突被降级成 422 —— 上一轮 S-09 的修复在真实驱动下一直是坏的

这是本轮**最值得记的一条**，因为它打的是我自己上一轮修复的脸。

真连 MySQL 8.0.46 触发唯一键冲突时实测：

    Hyperf\Database\Exception\UniqueConstraintViolationException
      getCode() = '23000'                            ← **SQLSTATE 字符串**
      errorInfo = ['23000', 1062, "Duplicate entry ..."]   ← errno 在 [1]

S-09 的 `driverErrorCodes()` 写的是 `(int) $t->getCode()`，
把 SQLSTATE `'23000'` 转成了整数 **23000**，于是 `=== 1062` 永不成立，
「策略名称已存在」被降级成「参数校验失败」—— 用户看到参数错误，**运维查错方向**。

为什么上一轮没发现：单测用 `new PDOException($msg, 1062)` 造异常，
那个构造器第二个参数**确实**会写进 `getCode()` —— 
**测试桩比真实驱动更「听话」，于是一条针对不存在行为的断言绿灯了**。

S-09 想解决的问题本身是对的（MySQL 的 1062/1451/1452/1048 的 SQLSTATE 都是 `23000`，
不能只按 `23` 前缀判重名），但**取 errno 的来源取错了**。
已改为优先读 `errorInfo[1]`（PDO 的权威来源），
并补了一组**用真实驱动形态**的回归测试（反射把 `Exception::$code` 写成 SQLSTATE 字符串）。

修完实测：`driverErrorCodes()` 返回 `[1062,"23000"]` → **409「策略名称已存在」**。

#### H-5 favicon 被鉴权拦成 401

`AuthMiddleware` 是**全局**中间件，会拦下每个请求，
而浏览器请求 `/favicon.ico` 不会带 Authorization 头 → 401。
契约把 401 的适用范围定义为「`/api/alarm` 下的业务端点」，favicon 不属于。
已改为按 `/api/` **路径前缀**放行 —— 新增业务端点时自动被覆盖，
不会因为忘了加白名单而漏鉴权。

### 三条测试桩与现实脱节（代码是对的，测试是错的）

这三条与 H-1/H-2 同源，值得单列：

| 测试 | 桩怎么写的 | 现实 |
| --- | --- | --- |
| `PolicyPayloadValidatorTest` | stub `input()` | 生产读 `getQueryParams()` |
| 同上（分页） | stub `input()` | 同上，`page/pageSize` 永远读到默认值 |
| `PolicyPersistenceTest`（时间范围） | stub `input()` | 同上，`startTime>endTime` 永远测不到 |

第三条尤其隐蔽：参数全变 null → 不触发校验 → `$this->fail()` 触发，
看起来是「测试失败」，实际是「这条断言从建立起就没生效过」。

另外两条 E2E 期望也写错了（**实现是对的**）：

- copy 端点：契约 ⑦ 规定响应体**只有** `{id, name}`，
  我却按「响应里就该有 status/creatorName」断言 —— status 确实为 0、creatorName 确实归位，只是要在详情里读。
- `POST /histories/{id}/handle` 传不存在的 id：契约 ⑱ 第 1 条「历史不存在 → 404」**排在最前**，
  action 校验在之后。拿不存在的 id 测「非法 action → 422」永远拿不到 422。
- 短信渠道接收人：`ChannelValidator` 明确要求**纯大陆手机号**，
  我写的 `'sms:13800000000'` 带前缀，被正确地拒了。

**断言必须贴着契约，不能贴着想象。**

### 端到端覆盖

| 分组 | 覆盖 |
| --- | --- |
| 鉴权 | 无 token → 401；错 token → 401；`ALARM_STATIC_TOKENS` 未配置 → fail-closed |
| ⑧ 指标 | 38 条 / 15-9-5-9 / 唯一键无重复 / 每条 10 字段 / `policyType`+`namespace` 筛选 |
| ⑨ 条件模板 | 7 条预置，含「流量断流」 |
| ③④⑤⑦ 策略 | 创建 / 列表 / 详情 / 复制 / 更新 / 启停 / 删除，逐个断言**值真的落库**而非只回显 |
| 409 | 重名、已启用删除、模板被引用 —— HTTP 状态码也必须是 409 |
| 422 | `objectType` 与 `objectIds` 不匹配、指标不存在、缺 `status`、非法 action |
| ⑩⑪⑫⑬ 通知模板 | 增删改查 + 绑定到策略（`channels` 无 cast 的真实路径）+ 引用中删除 409 |
| ⑭⑮ 历史 | 列表 / 处理 / 重复处理 409 / 404 优先于 422 |
| ⑯ favicon | 概览 + favicon 不走鉴权 |

### 本轮最终状态

- 后端测试：**260 个 / 740 断言全绿**
- HTTP 端到端：**60 条断言全绿**
- 运行期验证：**15 项全过**
- 迁移：8 个 `up()` 幂等，`down()`/`up()` 可回滚可恢复

### 仍未验证

- **告警引擎**：触发 / 去重 / 投递。本项目只做管理面，不含引擎，
  种子历史是直接写库造的，测的是**处理**路径不是**产生**路径。
- **10 个新指标的 `defaultThreshold`**：仍未经真实监控数据校准。
- **前端 ↔ 后端联调**：本轮只验了后端，前端基线（lint / tsc / 449 测试 / build）
  是上一轮的结果，未与本轮后端改动一起重跑。

VERDICT: PASS

---

## 2026-10-08（第六段）· 前后端联调：接缝验通，环境脚本修掉一个静默失败

### 为什么还要做这一层

前面所有验证都是**单侧**的：

- 后端侧：curl 打真实 HTTP（60 条断言）
- 前端侧：vitest 打 mock（449 个测试）

两侧各自都对，**接缝仍可能错**。接缝上最隐蔽的一条：

> **mock 和后端可能同时写错成 snake_case，两侧测试都绿。**

契约规定 camelCase，但没有任何一侧的测试能证明它 —— mock 是照着契约手写的，
后端的单测也不经过 HTTP 序列化。只有拿**真后端**的响应对**真前端类型定义**
逐字段核对才可能暴露。

第二条是错误形态：契约 §0.4 规定 `extra.errors` 是 `[{field, message}]` 列表。
前端若按 map（以 field 为键）读，真实 422 到来时会拿到 undefined，
而前端的 mock 错误响应是手写的，永远「符合」它自己的读法。

### 结果

**22 条接缝断言全绿**（`scripts/integration-check.mjs`）。

| 组 | 验了什么 |
| --- | --- |
| ① 传输层 | baseURL 走 app-config；token 进了配置 |
| ② 字段命名 | 真响应的 `metricNameCn` / `creatorName` / `conditionLogic` 全是 camelCase，**没有 snake_case 残留** |
| ② JSON 空值 | `notificationTemplateIds` 是 `[]`，不是 `null` 也不是 `""` |
| ③ 422 形态 | `extra.errors` 是 `[{field, message}]` 列表；HTTP 422 与 code 422 一致 |
| ④ 409 | 重名 → HTTP 409 + code 409 + 「策略名称已存在」（S-09 修复在真实驱动下生效） |
| ⑤ 查询参数 | `policyType`/`namespace`/`pageIndex`/`pageSize` 都被后端接受 |
| ⑥ channels | 回读结构正确（`isUnconfigured` 不会恒为 true）；配好接收人的模板**能绑到策略上**（P-2 回归）；引用中删除 409 |
| ⑧ 类型对账 | 前端 `AlarmMetric` 声明 10 个字段 ↔ 真响应 10 个字段，**双向零差异** |

### 本轮修掉的环境脚本缺陷

`setup-backend-env.sh` 里 MySQL root 密码的设置带着 `2>/dev/null`，
**静默失败**。后果是：

- CLI 走 unix socket 能连 → 看起来「环境好了」
- 应用走 TCP（127.0.0.1）被拒 → `Access denied for user 'root'@'localhost' (1698)` → **全部端点 500**

这是最难判断的一类环境问题：**同一个 MySQL，两种连接方式结果相反**。
已改为显式设置 + **当场用 TCP 验证**，不验证不算成功。

### 本轮最终状态

| | |
| --- | --- |
| 后端单元/Feature | **260 个 / 740 断言全绿** |
| HTTP 端到端 | **60 条断言全绿** |
| 前后端联调 | **22 条断言全绿** |
| 运行期验证 | **15 项全过** |
| 迁移 | 6 表 / 29 CHECK / 30 索引 / 2 FK / 7 模板 |

### 仍未验证

- **告警引擎**：触发 / 去重 / 投递。本项目只做管理面，不含引擎。
- **10 个新指标的 `defaultThreshold`**：仍未经真实监控数据校准。
- **浏览器端真实渲染**：本轮验的是前端传输层与服务层逻辑，
  没有起真实浏览器点真实页面（沙箱无浏览器）。

VERDICT: PASS
