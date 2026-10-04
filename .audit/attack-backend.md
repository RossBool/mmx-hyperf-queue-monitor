# 攻击线 B-2 — 对抗式复核：S-01 / S-03 / S-04 / S-10

**审查对象**：2026-10-03 第二批修复（owner 直做）的四处改动
**立场**：默认「修复引入了新缺陷」。本轮共发起 **28 条攻击**，逐条给出「我试图这样攻破它 → 结果 → 判定」。
**基线**：`/workspace/.audit/audit-backend.md`、`/workspace/.audit/FINAL-REPORT.md` §9/§10。**基线的结论一律不采信，只用它定位行号，全部结论重走源码。**

---

## 0. 运行环境与诚实性声明

```
$ which php composer mysql redis-cli
（沙箱无输出 / not found）
$ ls /workspace/server/vendor
ls: cannot access 'vendor': No such file or directory
$ ls /workspace/server/.env
ls: cannot access '.env': No such file or directory
```

**本报告 100% 为静态复核。**

* 没有执行过一行 PHP、没有跑过 `php -l`、没有启动过服务、没有跑过 `composer test`、没有执行过一条 DDL。
* 报告中所有 **node 脚本都是「PHP 语义模拟」**，**不是 PHP 实跑**。模拟脚本留在 `/tmp/atk/`，未写入 `/workspace`。
* 沙箱无 PHP，因此「PHP 语法是否正确」「Hyperf 容器能否解析某个类型」「MySQL 是否接受某个值」**一律未经机器验证**。凡结论依赖这些的，逐条标注。

### 0.1 审查快照（防止并发改动污染结论）

审查期间 `server/migrations/*.php` 与 `test/Cases/Unit/MigrationSafetyTest.php` 的 mtime 落在 22:55–22:57
（= 14:55–14:57 UTC，即本会话进行中），**有另一个会话正在并发修改它们**。本报告对被审 5 个文件取 md5 钉死快照：

```
4ccc09dacb50c978857a7576affb17f8  src/Service/AlarmPolicyService.php
34a82a758bc99e629b24724eb50f5d33  src/Constants/ErrorCode.php
3d59e822410f7ddddcd8dc989d97a4d6  src/Exception/BusinessException.php
d5509defbf2c432fc9748186333b9d21  src/Middleware/AuthMiddleware.php
38cd5a7d0fd055499ea4d2ba49498859  src/Exception/Handler/AlarmExceptionHandler.php
```

未修改 `/workspace` 下任何文件。

---

## 1. S-01 — `insertConditions()` 白名单映射

### A-1 攻击：把 `ConditionValidator` 返回的**每一个键**与白名单**每一个键**机械对照
**方法**：`/tmp/atk/s01c.js` 解析 `ConditionValidator::validateOne()` 的 return 字面量（源行 141–151）与
`insertConditions()` 的 `$rows[] = [...]`（源行 685–698），按 camel→snake 机械转换后逐条配对。
**证据**：
```
A) ConditionValidator::validateOne() 返回的键 (行 141-151), 共 11:
   sort / metricNamespace / metricName / metricNameCn / unit / operator / threshold / period / continuity / level / frequency

E) 逐键对照:
   OK    sort            -> sort              列存在=true  绑定 $condition['sort']=true
   OK    metricNamespace -> metric_namespace  列存在=true  绑定 $condition['metricNamespace']=true
   OK    metricName      -> metric_name       列存在=true  绑定 $condition['metricName']=true
   OK    metricNameCn    -> metric_name_cn    列存在=true  绑定 $condition['metricNameCn']=true
   OK    unit            -> unit              列存在=true  绑定 $condition['unit']=true
   OK    operator        -> operator          列存在=true  绑定 $condition['operator']=true
   OK    threshold       -> threshold         列存在=true  绑定 $condition['threshold']=true
   OK    period          -> period            列存在=true  绑定 $condition['period']=true
   OK    continuity      -> continuity        列存在=true  绑定 $condition['continuity']=true
   OK    level           -> level             列存在=true  绑定 $condition['level']=true
   OK    frequency       -> frequency         列存在=true  绑定 $condition['frequency']=true
   >>> 漏键=0  多写键=（无）  额外列=policy_id,created_at,updated_at
```
**判定：没攻破。** 11 键零漏、零多写、零拼写偏差。

### A-2 攻击：`metric_name_cn` 拼写逐字符与表列比对（这类错静态最难发现）
**方法**：从 `migrations/…000200…` 的 DDL 反解列名，逐个输出 Unicode 码位，并与白名单、`$fillable`、`Presenter`、`copy()` 四处交叉。
**证据**：
```
F) DDL(000200) 列: id, policy_id, sort, metric_namespace, metric_name, metric_name_cn, unit, operator, threshold, period, continuity, level, frequency, created_at, updated_at
   白名单中 DDL 无此列: [无]
   DDL 中白名单未覆盖: [id]        ← AUTO_INCREMENT，insert 路径本就不该写
G) 拼写逐字符（码位）:
   metric_namespace   DDL=true 白名单=true 长度=16 码位=6d 65 74 72 69 63 5f 6e 61 6d 65 73 70 61 63 65
   metric_name_cn     DDL=true 白名单=true 长度=14 码位=6d 65 74 72 69 63 5f 6e 61 6d 65 5f 63 6e
   metric_name        DDL=true 白名单=true 长度=11 码位=6d 65 74 72 69 63 5f 6e 61 6d 65
   DDL 中所有 16 字符列(形近排查): metric_namespace
   白名单中所有 16 字符键(形近排查): metric_namespace     ← 集合唯一，无形近候选
```
**判定：没攻破。** `metric_name_cn` 在 DDL / 白名单 / `$fillable` / `Presenter::condition()` / `copy()` 五处码位完全一致。
顺带核过字典侧：`metrics.php` 里 `unit` 最长 4 字符（列 `VARCHAR(16)`）、`metricNameCn` 最长 13 字符（列 `VARCHAR(64)`）、`metricName` 最长 24 字符（列 `VARCHAR(64)`）——**没有可触发 1406 的值**。

### A-3 攻击：`copy()` 与 `insertConditions()` 是否真的等价
**方法**：解析两个 `$rows[]` 字面量，比对列集合**与顺序**。
**证据**：
```
B) copy()          (行 332-345) 14 列
C) insertConditions() (行 685-698) 14 列
D) 列集合相同: true    顺序逐位相同: true
   仅 insert 有: []   仅 copy 有: []
```
**判定：没攻破。** 14 列、逐位同序。

### A-4 攻击：`threshold` 没转 float，两条路径是否真的类型一致
**方法**：不靠感觉，回读两端的**类型来源**。
* `insertConditions` 侧：`AlarmPolicyService.php:692` `'threshold' => $condition['threshold']` 原值。该值来自
  `ConditionValidator::assertThreshold()`（`ConditionValidator.php:168-186`），其**每一个非错误 return 都是 `(float) $raw`**（:177 `return $value;`）。
  且 `?float` 的 null 分支不可能到达成功路径——`validateOne` 的 required 循环（:99-101）对 null/`''` 已记错，
  `assertThreshold` 另两条 null 分支（:174 非数值、:182 超过 4 位小数）各自记错，:135 `count($errors->errors()) > $before` 即 `return []`。
* `copy()` 侧：`AlarmPolicyService.php:339` `'threshold' => $condition->threshold`，模型 `AlarmPolicyCondition.php:37` 有 `'threshold' => 'float'` cast。
**证据**：两侧到 INSERT 都是 PHP float。**判定：没攻破。**

### A-5 攻击：`insertConditions` 数组直取 `$condition['x']`，缺键会不会 500
**方法**：反向证明——成功路径上 11 个键是否**恒定存在**。
**证据**：`validate()`（:62-76）只在 `validateOne` 返回非 `[]` 时才 push，且 `validateOne` 的 return（:140-152）是**一个字面量**，
不存在「条件分支导致少键」；`validate()` 返回 `[]` 的三条路径（:42-49 非数组/空、:53-60 条数越界）都同时记了错，
`create()`/`update()` 的 `$errors->validate()`（:156 / :217）先行抛出。`insertConditions` 另有 `$conditions === []` 早退（:678-680）。
**判定：没攻破。**

### A-6 攻击（本轮**攻破**）：修好列名后，被原来的 500 掩盖的第二条 500 路径浮出水面
**方法**：`threshold` 的量级没有任何上界，而列是 `DECIMAL(20,4)`（`migrations/…000200…:51`）。逐字复刻 `assertThreshold`
的 `rtrim/rtrim/strpos` 链（node 模拟 `sprintf('%.10F')`），算整数位数与 DECIMAL 上限。
**证据**：
```
input                -> 判定                                    整数位数  DECIMAL(20,4) 整数部分上限=16
0.00005              -> {"ok":false,"why":"小数位 5 > 4"}            3      被 422 拦下
1e16                 -> {"ok":true, "text":"10000000000000000"}     17      ** 溢出 -> MySQL 1264 -> 500 **
1e17                 -> {"ok":true, "text":"100000000000000000"}    18      ** 溢出 -> MySQL 1264 -> 500 **
9999999999999999     -> {"ok":true, "text":"10000000000000000"}     17      ** 溢出 -> MySQL 1264 -> 500 **
1e-20                -> {"ok":true, "text":"0"}                     0      静默写成 0
```
推理链闭合：
1. `is_numeric("1e17")` 为真（PHP 接受前导数字+指数）→ 不被 :173 拦下；
2. `(float)"1e17"` = 1.0E+17；`sprintf('%.10F')` = `"100000000000000000.0000000000"`；两次 `rtrim` 后 = `"100000000000000000"`；
3. `strpos(..., '.')` 为 `false` → **:181 的小数位检查整段跳过**（这是设计如此：小数位检查对整数无意义）；
4. 返回 1.0E+17，`:692` 原值入库 → `DECIMAL(20,4)` 整数部分上限 16 位 → MySQL **1264 / SQLSTATE 22003**；
5. `AlarmExceptionHandler::isDuplicateKey()`（:95-110）：`$code===1062` 否，`str_starts_with('22003','23')` 否 → 落到 `:81 INTERNAL_ERROR`；
6. → **HTTP 500「服务器内部错误」**。

契约 `docs/alarm/contract.md:321` 只规定「number，可负数，最多 4 位小数」，未给量级上界，所以**这不是违反契约，是契约缺口**。

**这条与 S-01 的关系**：修复前 POST/PUT 一律在 unknown column 处 500，这条路径根本到不了；**修复后它是 POST/PUT 仅剩的 500 来源**。
不是修复写错了，是修复把一个潜伏缺陷暴露成了唯一可达路径。
**判定：攻破（MEDIUM，非本轮引入，但由本轮解除遮蔽）。**

### A-7 攻击：`threshold: 1e-20` 静默变 0
**证据**：上表第 5 行——`toFixed(10)` 得 `"0.0000000000"`，两次 rtrim 得 `"0"`，`strpos` 为 `false` 跳过检查，
`(float)` 值 1e-20 仍原样入库，但 MySQL `DECIMAL(20,4)` 只有 4 位小数 → 落库 `0.0000`。**用户传 1e-20，读回来是 0，无任何报错。**
**判定：攻破（LOW，静默数据失真）。**

---

## 2. S-03 — 409 文案改为语义分支索引

### B-1 攻击：全仓 grep `BusinessException::conflict(`，是否还有传数值 int 的
**方法**：`grep -rn "::conflict(" --include=*.php .`（含 test/），逐个回读实参。
**证据**：
```
src/Service/AlarmConditionTemplateService.php:125   conflict(ErrorCode::REASON_PRESET_READONLY)
src/Service/AlarmConditionTemplateService.php:130   conflict(ErrorCode::REASON_TEMPLATE_IN_USE, sprintf(...))
src/Service/AlarmHistoryService.php:143             conflict(ErrorCode::REASON_HISTORY_ALREADY_HANDLED)
src/Service/AlarmHistoryService.php:169             conflict(ErrorCode::REASON_HISTORY_ALREADY_HANDLED)
src/Service/AlarmNotificationTemplateService.php:161 conflict(ErrorCode::REASON_PRESET_READONLY)
src/Service/AlarmNotificationTemplateService.php:171 conflict(ErrorCode::REASON_TEMPLATE_IN_USE, sprintf(...))
src/Service/AlarmPolicyService.php:262              conflict(ErrorCode::REASON_POLICY_STATUS_CONFLICT)
src/Service/AlarmPolicyService.php:554              conflict(ErrorCode::REASON_POLICY_NAME_DUPLICATED)
test/Cases/Unit/AlarmRuleTest.php:494,498           conflict(ErrorCode::REASON_PRESET_READONLY) / (REASON_TEMPLATE_IN_USE, ...)
```
8 个生产调用点，**全部是字符串语义常量**，无一处传 int。签名 `conflict(string $reason, ...)`（:66）在 `strict_types=1` 下传 int 会 TypeError——不存在的风险。
**判定：没攻破。**

### B-2 攻击：全仓 grep `new BusinessException(`，是否还有传 409 的
**证据**：
```
src/Exception/BusinessException.php:57  new self(ErrorCode::NOT_FOUND,   $message)
src/Exception/BusinessException.php:68  new self(ErrorCode::codeForReason($reason), ...)   ← conflict() 内部
src/Exception/BusinessException.php:85  new self(ErrorCode::VALIDATION_ERROR, ...)
src/Exception/BusinessException.php:90  new self(ErrorCode::UNAUTHORIZED, ...)
test/Cases/Unit/AlarmRuleTest.php:489   new BusinessException(ErrorCode::POLICY_STATUS_CONFLICT)   ← 负对照测试
```
**判定：没攻破。** 唯一的 409 直连是那条**故意**的负对照测试（:486-490 注释写明「必须当场报错」）。

### B-3 攻击：`LogicException` 守卫会不会误伤合法路径
**方法**：枚举所有能构造 `BusinessException` 的入口，检查有没有一条会合法地产生 `bizCode===409 && $message===null`。
**证据**：`notFound()`→404、`validation()`→422、`unauthorized()`→401 三条 `new self` 都不可能是 409；
`conflict()` 的 `$message ?? messageForReason($reason)` 在 `$reason` 合法时**恒为非 null**（`REASON_MESSAGES` 5 键齐全，见 B-4）。
且 `AlarmExceptionHandler:78` 的 duplicate-key 分支**根本不构造 BusinessException**，直接返回元组，不受守卫约束。
**判定：没攻破。** 守卫无误伤面。

### B-4 攻击：`MESSAGES` 的塌缩是否真的消除了（用 PHP 数组同值键后写覆盖语义复现原 bug）
**方法**：`/tmp/atk/s03.js` 解析 `ErrorCode.php` 三个数组字面量，模拟 PHP「重复键后者覆盖」。
**证据**：
```
1) 5 个 409 数值常量当前求值: 全部 = 409
2) 修复后 MESSAGES: 源码 6 条 -> 去重后存活 6 条
   [0]=>success [401]=>未登录或登录已过期 [403]=>无权限操作该资源 [404]=>资源不存在 [422]=>参数校验失败 [500]=>服务器内部错误
   >>> 含 409 键? false
3) 复现修复前（把 5 个 REASON_* 换成数值常量当键）: 源码 5 条 -> 存活 1 条
   [409] => 该告警已处理，不可重复处理          ← 原 B-2 精确复现
4) REASON_MESSAGES: 5 条, 文案去重后 = 5   >>> 互不相同? true
5) REASON_CODES: 5 个分支全部 => 409       >>> 未知分支回退 INTERNAL_ERROR(500)
6) 5 个 REASON_* 字符串常量值互不重复
```
**判定：没攻破。** 塌缩根因已消除（`MESSAGES` 干脆不收 409），5 条文案互异，5 个分支上线码全 409。

### B-5 攻击：响应信封的 `code` 与 HTTP 状态是否一致，会不会变 500
**方法**：沿 `BusinessException` → `AlarmExceptionHandler::handle` 的完整链路读。
**证据**：
* `BusinessException::conflict()` → `codeForReason()` 返回 `self::POLICY_*` = **409**（`ErrorCode.php:65-71`）。
* `handle()` `:59`：`->setStatus($code === ErrorCode::SUCCESS ? 200 : $code)` → **HTTP 409**。
* `:47` 信封 `code` 字段 = 同一 `$code` = **409**。
* 契约 §0.2 约束 2 要求二者一致 → 一致。
* 另一条出口 `Response::json()` `:68` `->withStatus($code === SUCCESS ? 200 : $code)` 同构。
**判定：没攻破。** 409 分支不可能落到 500（唯一例外见 B-6 的未知 reason，且当前 8 个调用点都传对了常量）。

### B-6 攻击（**攻破**，但按指示**只指出不动手**）：duplicate-key 分支在**非重名**时仍然给错语义
**方法**：`AlarmExceptionHandler:78` 现在返回
`[ErrorCode::POLICY_NAME_DUPLICATED, messageForReason(REASON_POLICY_NAME_DUPLICATED)]` = 409「**策略**名称已存在」；
而它由 `isDuplicateKey()`（:95-110）判定，后者把 `str_starts_with($state,'23')` 当成重名。MySQL SQLSTATE 23xxx 是整个
「完整性约束违反」类，不止 1062。逐个对照本仓约束：
* 1062 重复键 → SQLSTATE **23000**（这一条确实是重名）
* 1452 外键无对应行 / 1451 外键被引用 → SQLSTATE **23000** → 命中
* 1048 非空列写 NULL → SQLSTATE **23000** → 命中
* 3819 CHECK 违反 → SQLSTATE **HY000** → 不命中（不误伤）
* 1264 越界 / 1406 超长 → 22003 / 22001 → 不命中

**并且这条有一个单请求、确定性的触发路径**（不是推测）：
`AlarmConditionTemplateService::create()`（:78-93）与 `AlarmNotificationTemplateService::create()`（:103+）
**都不做 name 存在性预检**——`grep -n "nameExists|where('name'|重名"` 在这两个文件里**零命中**，
`validatePayload()` 只校验长度。唯一性完全依赖 DDL 的 `uk_condition_template_name`（`…000300…:55`）与
`uk_notification_template_name`（`…000400…:54`）。

> 于是：`POST /api/alarm/condition-templates` 提交一个已存在的模板名 → MySQL 1062/23000 →
> `isDuplicateKey()` 为真 → 客户端收到 **HTTP 409「策略名称已存在」**。
> 用户建的是**条件模板**，被告知**策略**重名。

S-03 让文案从「笼统错」变成「自信地错」。这是 S-09，本轮未修（`FINAL-REPORT.md` §10 末段自己列了「S-09 未触碰」），
但 `AlarmExceptionHandler.php` 在本轮被改过（mtime 21:26，:78 一行），修复者路过而未收口。
**判定：攻破（MEDIUM，S-09 残留；按指示不改代码）。**

### B-7 攻击：`conflict()` 传错 reason 会怎样——守卫是不是修在了错误的层
**方法**：读 `codeForReason()` / `messageForReason()` 的兜底（`ErrorCode.php:86, 92`）与守卫的触发条件（`BusinessException.php:28`）。
**证据**：`conflict('POLICY_STATUS_CONFLIC')`（少个 T）→ `codeForReason` 落 `?? INTERNAL_ERROR` = 500，
`messageForReason` 落 `'服务器内部错误'`，于是 `new self(500, '服务器内部错误')` —— **守卫的 `bizCode === 409` 条件不成立，不抛 LogicException**。
即：加守卫想防的「静默发错文案」，在拼错常量名这一条路上**仍然静默**，只是错码从 409 变成 500。
当前 8 个调用点全部正确（见 B-1），所以不是活 bug。
**判定：攻破（LOW，加固点错层，未构成当前缺陷）。**

---

## 3. S-04 — `assertStatus()` 新增 `$required`

### C-1 攻击：创建/更新路径的行为是否真的没变（逐行比两处调用）
**方法**：grep `assertStatus` 的**全部**调用点。
**证据**：
```
src/Service/AlarmPolicyService.php:155  create():       $this->assertStatus($payload['status'] ?? null, $errors);        // 2 参 -> $required=false
src/Service/AlarmPolicyService.php:279  changeStatus(): $this->assertStatus($rawStatus, $errors, true);
（update() 根本不调用 assertStatus —— P18 要求 status 不出现在 UPDATE 里，见 :227-229）
```
即**只有一处默认路径调用**。`$required=false` 时 `:516-521` 的分支退化为
`if (null===null||''==='') { /* if(false){...} 不执行 */ return 0; }`，与修复前逐字节等价。
**判定：没攻破。** 任务书假设的「create 与 update 两处调用」实际不存在，update 路径不碰 status。

### C-2 攻击（本轮最关键的一条）：**显式 `status: 0` 会不会被判成「缺省」**
**方法**：不信直觉，读 `assertStatus():516` 的比较运算符。
**证据**：
```php
// AlarmPolicyService.php:516
if ($raw === null || $raw === '') {      // ← 严格相等 ===，不是 ==
```
`0 === null` = false，`0 === ''` = false（类型都不同）。node 模拟（`phpStrictEq`）结果：
```
关键结论:
  * 显式 status=0 在 ⑥ 下 -> {"ret":0,"errs":[]}  (0 === null? false ; 0 === ""? false) => 不被判缺省
```
**判定：没攻破。** 这是本条修复最容易写错的地方，写对了。

### C-3 攻击：`[]` 会不会触发 `$raw === ''` 的误判（PHP 里 `[] == ''` 为真）
**方法**：确认是 `===` 还是 `==`，并模拟 `[]`/`false`/`"0"`/`0.0`/`{}`。
**证据**（`/tmp/atk/s04-matrix.js`，18 例全表）：
```
输入                                      | ⑥required=true                     | ③required=false
{"status": null}                          | 422 [策略状态为必填字段…]             | 200 status=0
{"status": ""}                            | 422 [策略状态为必填字段…]             | 200 status=0
{"status": 0}  (合法停用值, falsy)         | 200 status=0                       | 200 status=0
{"status": 1}                             | 200 status=1                       | 200 status=1
{"status": "0"}                           | 200 status=0                       | 200 status=0
{"status": false}                         | 422 [必须是整数]                    | 422 [必须是整数]
{"status": true}                          | 422 [必须是整数]                    | 422 [必须是整数]
{"status": []}                            | 422 [必须是整数]                    | 422 [必须是整数]
{"status": {}}                            | 422 [必须是整数]                    | 422 [必须是整数]
{"status": 2}                             | 422 [策略状态必须是 0/1 之一]         | 422 [策略状态必须是 0/1 之一]
{"status": -1}                            | 422 [策略状态必须是 0/1 之一]         | 422 [策略状态必须是 0/1 之一]
{"status": "abc"} / " 1" / "1e0"          | 422 [必须是整数]                    | 422 [必须是整数]
```
`[]` 走 `Pagination::intParam`（`Pagination.php:64-77`）：`[] === ''` 为 false → 不早退；`is_int([])` 否；`is_string([])` 否 → 记 422「必须是整数」。
**判定：没攻破。**

> **模拟与真实 PHP 的偏差（自我更正）**：上表 `0.0` / `1.0` 两行模拟给了 200，**真实 PHP 会给 422**——
> 因为 `json_decode('0.0')` 得到 `float`，而 `Pagination::intParam` 的快路径是 `is_int($value)`，`is_int(0.0)` 为 false。
> node 的 `Number.isInteger(0.0)` 为 true 造成了这处偏差。**真实行为是 422，结论方向不变**（不是 500，也不误判为缺省）。

### C-4 攻击：`$errors->validate()` 抛的是什么，会不会走 500 而不是 422
**方法**：读 `Validator::validate()` 与 `BusinessException::validation()`。
**证据**：
```
src/Support/Validator.php:120-125   if ($errors !== []) throw BusinessException::validation($this->errors);
src/Exception/BusinessException.php:79-86  new self(ErrorCode::VALIDATION_ERROR=422, $message, $list)   // 构造器守卫只拦 409，不拦 422
AlarmExceptionHandler::73-74  instanceof BusinessException -> [getBizCode()=422, message, null, extra+{errors:[…]}]
AlarmExceptionHandler:59      setStatus(422)
```
**判定：没攻破。** `changeStatus` 的 `$errors->validate()`（:280）在任何写库动作之前，422 携带 `extra.errors[{field:'status'}]`。
且前端调用点 `web/src/pages/alarm/policy/index.vue:143` 是 `setAlarmPolicyStatus(policy.id, { status: next })`——**UI 永远带 status**，S-04 的收紧不会打断现有启停按钮。

### C-5 攻击：守卫修完后是否**零回归覆盖**
**方法**：`grep -rn "changeStatus|assertStatus|必填" server/test/`。
**证据**：
```
test/Cases/Feature/PolicyPersistenceTest.php:449  assertSame(0, $service->changeStatus($id, 0)['status']);
test/Cases/Feature/PolicyPersistenceTest.php:450  assertSame(0, $service->changeStatus($id, 0)['status']);
test/Cases/Feature/PolicyPersistenceTest.php:451  assertSame(1, $service->changeStatus($id, 1)['status']);
test/Cases/Feature/PolicyPersistenceTest.php:452  assertSame(1, $service->changeStatus($id, 1)['status']);
（全部传 0/1，没有一条传 null / '' / 缺参数）
```
**判定：攻破（HIGH，测试覆盖）。** S-04 新引入的行为（⑥ 缺 `status` → 422）**没有任何一条测试**。
`assertStatus` 是 private、无法直接测，唯一的入口 `changeStatus` 又需要活库；现有 5 处调用全是修复前就有的幂等性用例。
**这正是「断言了实现给不出的值」的反面：连断言都不存在。**

---

## 4. S-10 — `AuthMiddleware` fail-open → fail-closed

### D-1 攻击：`filter_var(..., FILTER_VALIDATE_BOOLEAN)` 对 `1/true/TRUE/yes/""` 各自返回什么，`""` 会不会意外成 true
**方法**：按 PHP 手册语义列出完整真值表（**沙箱无 PHP，此表为文档化推导，非实跑**）。
**证据**（`/tmp/atk/s10b.js`）：
```
(未设置) env() 返回默认值 false             | false
""    空串                              | false      ← 关键
"0" / "false" / "FALSE" / "off" / "no"   | false
"flase" 拼错                            | false
"2" / "enabled" / "y"                   | false
PHP [] 数组 / PHP null                   | false
"1" / "true" / "TRUE" / "True"           | true
"on" / "yes" / "YES"                     | true
唯一返回 true 的输入（= 关闭鉴权）共 7 种
""  -> false   「空串意外关掉鉴权」的陷阱: 不存在
```
**判定：没攻破。** `""` 返回 false；无法识别的字符串也返回 false——**方向是 fail-secure**，
把开关名拼错只会让鉴权保持开启，不会静默关闭。写法正确。

### D-2 攻击：`ALARM_STATIC_TOKENS` 只配空白 / 逗号残留时会不会被绕过
**方法**：读 `:64-77` 的 trim / explode / in_array 链。
**证据**：`:64` `trim((string) env(...))` → `"   "` 被 trim 成 `''` → 走 `:65` fail-closed 分支 → 401。
`:77` `in_array($token, array_map('trim', explode(',', $allow)), true)`；`$token` 来自 `:44` 的
`preg_match('/^Bearer\s+(\S+)$/i', ...)`，`\S+` 保证**永不为空串**，所以 `",,"` 产生的空元素匹配不到任何东西。
**判定：没攻破。**

### D-3 攻击（本轮**攻破**）：fail-closed 之后，这个仓库**按提交状态开箱即全线 401**
**方法**：把后端与前端两侧的实际 env 文件读出来对撞。
**证据**：
```
server/.env          不存在（只有 server/.env.example）
server/.env.example:28   ALARM_STATIC_TOKENS=dev-token-1,dev-token-2
web/.env             VITE_SERVER_API_TOKEN=          ← 空
web/.env.example     VITE_SERVER_API_TOKEN=          ← 空
web/.env:9           VITE_USE_MOCK=false              ← 指向 http://localhost:3000 真后端，不走 mock
web/src/lib/api-client.ts:41-46   if (!API_TOKEN) { return }   // 不配置就不发该头
server/config/routes.php:28-59  1 个 addGroup('/api/alarm') + 19 个业务端点（契约 ①-⑲）+ 1 个 /favicon.ico
```
**判定：攻破（MEDIUM，部署面）。** 后端 fail-closed、前端 token 留空，两侧默认值**互相不匹配**。
后果不是「静默不安全」，而是「**默认不可用**」——从安全角度是净改善，方向正确；
但两份示例 env 各自看都自洽，**合起来跑就是 100% 401**，且 `AuthMiddleware` 的 error 日志只在**服务端**打印，
前端只会看到一个没有解释的 401。
同时 `server/README.md:110` 教的是 `cp .env.example .env`——照做就把**仓库里公开的** `dev-token-1` 变成生产白名单。

### D-4 攻击（本轮**攻破**，安全向）：`.env.example` 把一个**公开的固定 token** 变成默认白名单
**方法**：读本轮被修改的 `.env.example`（mtime 21:29 落在本轮窗口）。
**证据**：
```ini
# server/.env.example:26-28
# ---- 鉴权（占位中间件，契约 §0.1）----
# token 白名单，逗号分隔。⚠️ 留空 = 拒绝所有请求（fail-closed），必须显式配置。
ALARM_STATIC_TOKENS=dev-token-1,dev-token-2
```
`server/README.md:130-131` 也照抄同一组值。而 `composer.json` 的 `post-root-package-install`
是 `file_exists('.env') || copy('.env.example', '.env')`——**新建项目会自动落进这个值**。
fail-closed 防的是「忘配」，但一份**已提交、可被任何人读到**的默认白名单，
把「无鉴权」换成了「用仓库公开 token 的有鉴权」，且 `:59` 的 warning 只在 `ALARM_AUTH_DISABLED` 时打，
**这条路径一声不吭**。
**判定：攻破（MEDIUM）。** 建议 `.env.example` 里该行留空（`ALARM_STATIC_TOKENS=`），
让 fail-closed 真正 fail-closed；README 里的示例值加注「仅本地，切勿照抄」。

### D-5 攻击：构造函数注入 `StdoutLoggerInterface` 能不能解析，解析失败会不会让**服务起不来**
**方法**：查绑定来源，并判断这是不是**本轮新引入**的依赖形态。
**证据**：
```
config/autoload/dependencies.php   返回空数组（只有注释），【没有任何绑定】
全仓 StdoutLoggerInterface 引用点只有 4 处：
  src/Middleware/AuthMiddleware.php:8,29
  src/Exception/Handler/AlarmExceptionHandler.php:9,29
  config/config.php:5,14
config/autoload/logger.php          不存在
config/config.php:14-23             以 StdoutLoggerInterface::class 作【配置键】塞了一份 log_level
```
绑定只能来自 `hyperf/logger`（`composer.json` 已 require）的 ConfigProvider——`vendor/` 不存在，**我读不到源码，无法证实**。

**但「是不是本轮新引入」可以静态定案**，用行号不变性：
`audit-backend.md` 在修复前引用了三处行号 —— `AlarmExceptionHandler.php:101`（`str_starts_with($state,'23')`）、
`:81`（`INTERNAL_ERROR` 分支）、`:78`（duplicate-key 分支）。当前文件里这三处**行号完全相同**（本轮 :78 只改了行内内容，未增删行）。
构造器占 :29-31。**若构造器是本轮新加的，它后面的所有行号都会整体下移。** 行号未移 ⟹
**`AlarmExceptionHandler` 早在审查之前就注入了 `StdoutLoggerInterface`**。
旁证：`config/config.php` 的 mtime 是 `Sep 30 15:42`，早于本轮窗口（`Oct 3 21:25`），它已经 `use` 了这个接口。

**真实的新增风险不是「这个类型解析不了」，而是「解析时机从惰性变成急切」**：
* 异常处理器的依赖只在**真的发生异常**时才被解析（解析失败也只在出错路径上暴露）；
* `AuthMiddleware` 是 `config/autoload/middlewares.php` 里的**全局 http 中间件**，它的依赖在**第一个请求**构建容器实例时就要解析。Swoole 下容器是单例，之后复用。
* 即便真解析不了，故障面也从「出错时才 500」扩大到「所有请求 500」。`dependencies.php` 为空 + 无 `logger.php` + `config.php` 用 FQCN 当配置键，这三点**合起来是个可疑的配置形态**，但我无法在没有 vendor 的沙箱里证实。

**判定：存疑。** 需在装好 vendor 的环境里跑一条命令定案（见 §6 收口清单第 1 条）。
**不构成「修复写错了」——它只是把一个既有的、可能存在的配置问题从惰性路径搬到了急切路径。**

### D-6 攻击：S-10 有没有任何测试
**方法**：`grep -rn "AuthMiddleware|ALARM_AUTH_DISABLED|ALARM_STATIC_TOKENS" server/test/`。
**证据**：**零命中。**
**判定：攻破（HIGH，测试覆盖）。** 这次改的是**全部 19 个端点**的公共入口，行为从「无鉴权」翻转为「无白名单即 401」，
**一条测试都没有**。前端那边补了 `web/src/lib/__tests__/api-client.auth.test.ts`（3 用例），
**后端这一侧完全裸奔**——两边不对称。

---

## 5. 汇总

| 编号 | 攻击 | 结果 | 判定 | 级别 |
|---|---|---|---|---|
| A-1 | 11 键 vs 白名单逐键对照 | 漏 0 / 多 0 | 没攻破 | — |
| A-2 | `metric_name_cn` 逐码位比对 | 五处码位一致 | 没攻破 | — |
| A-3 | `copy()` vs `insertConditions()` 等价 | 14 列同序一致 | 没攻破 | — |
| A-4 | `threshold` 两侧类型一致 | 两侧皆 PHP float | 没攻破 | — |
| A-5 | 数组直取缺键 | 成功路径键恒存在 | 没攻破 | — |
| **A-6** | **threshold 量级无上界 → DECIMAL(20,4) 溢出 → 500** | **可复现** | **攻破** | MEDIUM |
| **A-7** | **threshold 1e-20 静默落库为 0** | **可复现** | **攻破** | LOW |
| B-1 | `conflict()` 残留 int 实参 | 8/8 全是语义常量 | 没攻破 | — |
| B-2 | `new BusinessException(409)` 残留 | 仅负对照测试里有 | 没攻破 | — |
| B-3 | `LogicException` 守卫误伤 | 无合法路径命中 | 没攻破 | — |
| B-4 | 塌缩是否真消除 | 6 键无 409 / 5 文案互异 | 没攻破 | — |
| B-5 | code 与 HTTP 状态一致性 | 双 409 | 没攻破 | — |
| **B-6** | **duplicate-key 分支在模板重名时说「策略名称已存在」** | **确定性可复现** | **攻破（S-09，只指出）** | MEDIUM |
| **B-7** | **`conflict()` 拼错 reason → 静默 500** | **可复现（当前调用点全对）** | **攻破** | LOW |
| C-1 | create/update 行为未变 | 只有 1 处默认调用 | 没攻破 | — |
| C-2 | **显式 `status:0` 被误判缺省** | `===` 严格比较，未误判 | 没攻破 | — |
| C-3 | `[]`/`false`/`"0"` 触发 `=== ''` | 全部 422 | 没攻破 | — |
| C-4 | `validate()` 抛 500 而非 422 | 抛 422 + extra.errors | 没攻破 | — |
| **C-5** | **S-04 回归覆盖** | **0 条** | **攻破** | HIGH |
| D-1 | `filter_var` 对 `""`/拼错值 | `""`→false，fail-secure | 没攻破 | — |
| D-2 | 空白/逗号残留绕过 | 白名单 trim 后为空 → 401 | 没攻破 | — |
| **D-3** | **仓库开箱即全线 401** | **两侧默认 env 不匹配** | **攻破** | MEDIUM |
| **D-4** | **`.env.example` 提交了公开默认 token** | **可复现** | **攻破** | MEDIUM |
| **D-5** | `StdoutLoggerInterface` 解析 | 行号不变性证明构造器非本轮新增；风险是惰性→急切 | **存疑** | — |
| **D-6** | S-10 测试覆盖 | 0 条 | **攻破** | HIGH |

**四处修复的「写法」本身：我一条都没攻破。** 真正被攻破的是它们周围的四件事：
修复解除遮蔽后浮出的 500（A-6/A-7）、修复路过但未收口的 S-09（B-6）、修复引入的默认凭据（D-4）、
以及两处**新行为零回归覆盖**（C-5/D-6）。

---

## 6. 收口前必须补的证据（我不代写测试）

1. **D-5 定案**（装好 `vendor` 后执行）：
   `php -r 'require "vendor/autoload.php"; $c=(require "config/container.php"); var_dump(get_class($c->get(Hyperf\Contract\StdoutLoggerInterface::class)));'`
   以及 `php bin/hyperf.php start` 后发一个**不带 token** 的请求，确认返回的是 401 信封而不是 500。
2. **S-01 落库证据**（`PolicyPersistenceTest` 已有用例但从未跑过）：
   `composer test`，并附 `SELECT metric_namespace, metric_name, metric_name_cn, threshold FROM alarm_policy_condition` 的真实输出。
   **额外补一条**：`threshold = 1e16` 的用例应断言 422（当前会 500，见 A-6）。
3. **S-04 回归用例**（缺口 C-5）：`changeStatus($id, null)` / `changeStatus($id, '')` 应抛 422 且 `extra.errors[0].field === 'status'`；
   `changeStatus($id, 0)` 应成功并落库 0（防 A-4 那类回归）。
4. **S-10 回归用例**（缺口 D-6）：至少 3 条 ——
   `ALARM_STATIC_TOKENS` 未配置 + 合法 Bearer → 401；配置且命中 → 放行；
   `ALARM_AUTH_DISABLED=1` → 放行且 `ALARM_STATIC_TOKENS` 未配置也不报错。
5. **D-4**：把 `server/.env.example` 的 `ALARM_STATIC_TOKENS` 置空，或至少让 `composer.json` 的
   `post-root-package-install` 不自动 copy 这份带凭据的示例。
6. **端到端**：`FINAL-REPORT.md` §10 记录了攻击线 A 在 `policy-form.vue` 的独立阻塞。
   收口必须有一份**端到端实跑记录**（前端向导走完 → POST /policies 200 → GET /policies/{id} 能读回
   `metricNamespace/metricName/metricNameCn`），不能用任一线的「已修复」互相代替验收。

---

**VERDICT: FAIL**

四条修复的**代码逻辑**经 28 条攻击未被攻破。判 FAIL 的理由是四条**可复现的、有推理链的**问题：

| # | 阻塞项 | 级别 | 归属 |
|---|---|---|---|
| 1 | `.env.example` 提交了公开的固定白名单 token，fail-closed 被默认凭据抵消 | MEDIUM | 本轮引入 |
| 2 | 模板重名确定性返回 409「策略名称已存在」（`AlarmExceptionHandler:78` + 两个 Service 无预检） | MEDIUM | S-09 残留，修复者路过未收口 |
| 3 | S-04 新行为**零回归测试** | HIGH | 本轮引入 |
| 4 | S-10 改动全部 19 个端点，**零回归测试**（前端有 3 条，后端 0 条） | HIGH | 本轮引入 |

外加 1 条 MEDIUM（threshold 量级无上界 → DECIMAL(20,4) 溢出 → 500，**由 S-01 修复解除遮蔽后成为 POST/PUT 唯一的 500 来源**），
1 条 LOW（threshold 1e-20 静默落库为 0），1 条 LOW（`conflict()` 拼错 reason → 静默 500，守卫修在了错误的层），
1 条存疑（`StdoutLoggerInterface` 的急切解析，需装好 vendor 后用 §6 第 1 条命令定案）。
