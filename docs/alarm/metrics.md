# 告警管理模块 — 指标字典（metrics.md）

> 版本：v1.0　　最后更新：2026-09-30　　状态：**已冻结**
>
> 本文件是 `GET /api/alarm/metrics` 的**唯一数据源**，同时是 7 条预置触发条件模板的来源
> （`schema.sql` 末尾的 `INSERT` 与本文 §3 严格一一对应）。
>
> 配套文档：`contract.md`（API 契约）、`schema.sql`（DDL）、`domain.md`（领域模型）

---

## 0. 使用说明

### 0.1 字段定义

`GET /api/alarm/metrics` 返回数组，每个元素结构固定为 **10** 个字段（对应 `contract.md` §2.7 `AlarmMetric`）：
（`namespace` / `metricName` / `metricNameCn` / `unit` / `policyType` / `periodOptions` / `defaultOperator` /
`defaultThreshold` / `suggestedContinuity` / `description`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `namespace` | string | 指标命名空间 |
| `metricName` | string | 指标英文名（与 namespace 组合成唯一键） |
| `metricNameCn` | string | 指标中文名 |
| `unit` | string | 单位 |
| `policyType` | int[] | 适用的策略类型（取 `contract.md` §1.2 数值） |
| `periodOptions` | int[] | 该指标允许的 `period` 取值子集（取 §1.4 数值） |
| `defaultOperator` | string | 默认比较关系（`contract.md` §1.5） |
| `defaultThreshold` | number | 推荐阈值（可负） |
| `suggestedContinuity` | int | 推荐持续周期，1-10 |
| `description` | string | 指标说明 |

**唯一键** = `namespace` + `"."` + `metricName`，例如 `CVM.CpuUtilizationRate`。

**字段映射（勿漂移）**

| metrics.md | `alarm_policy_condition` 列 | 契约字段 |
| --- | --- | --- |
| `namespace` | `metric_namespace` | `metricNamespace` |
| `metricName` | `metric_name` | `metricName` |
| `metricNameCn` | `metric_name_cn` | `metricNameCn`（服务端回填） |
| `unit` | `unit` | `unit`（服务端回填） |
| `periodOptions` | — | 校验 `period` 是否在子集内 |
| `defaultOperator` | — | 预填 `operator` |
| `defaultThreshold` | `threshold` | 预填 `threshold` |
| `suggestedContinuity` | `continuity` | 预填 `continuity` |

### 0.2 namespace 与 policyType / monitorType 的对应

| namespace | 含义 | policyType | monitorType |
| --- | --- | --- | --- |
| `WEB` | 通用 Web 服务（APM 拨测/日志上报） | `1` 通用 Web 服务 | `2` 应用性能监控 |
| `CVM` | 云服务器 CVM | `2` 云服务器 CVM | `1` 云产品监控 |
| `CLB` | 负载均衡 CLB | `3` 负载均衡 CLB | `1` 云产品监控 |
| `MYSQL` | 云数据库 MySQL | `4` 云数据库 MySQL | `1` 云产品监控 |

**约束**：创建/更新策略时，条件中出现的每个 `metricNamespace` 必须等于策略的 `policyType` 所对应的 namespace
（见 §0.2 映射），否则返回 422。

### 0.3 通用取值域

- `period`（统计粒度，分钟）枚举：`1 / 5 / 10 / 30 / 60`
- `operator` 枚举：`> / >= / < / <= / == / !=`
- `continuity`（持续周期/数据点数）：`1 - 10`
- 所有 `defaultThreshold` 为**推荐起点**，用户可改；`threshold` 允许负数
- 比例类指标（unit = `%`）取值域 0-100

---

## 1. 指标清单（共 38 个）

### 1.1 `CVM` — 云服务器（policyType = 2）

| metricName | metricNameCn | unit | policyType | periodOptions | defaultOperator | defaultThreshold | suggestedContinuity | description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `CpuUtilizationRate` | CPU 使用率 | `%` | `[2]` | `[1,5,10,30,60]` | `>` | `80` | `3` | 统计周期内实例 CPU 使用率平均值，取值 0-100。持续偏高通常意味着计算资源打满、需扩容或存在死循环。 |
| `MemoryUsageRate` | 内存使用率 | `%` | `[2]` | `[1,5,10,30,60]` | `>` | `90` | `3` | 统计周期内实例已用内存占物理内存比例，取值 0-100。接近 100% 时进程易被 OOM Killer 终止。 |
| `DiskUsageRate` | 磁盘使用率 | `%` | `[2]` | `[30,60]` | `>` | `85` | `2` | 已用磁盘容量占分区总容量比例，取值 0-100。属慢变量，仅提供 30/60 分钟粒度。写满会导致服务不可写。 |
| `LanInTraffic` | 网络入带宽 | `Mbps` | `[2]` | `[1,5,10,30,60]` | `>` | `500` | `3` | 统计周期内网卡平均入方向带宽。持续超限通常触发限流或丢包。 |
| `LanOutTraffic` | 网络出带宽 | `Mbps` | `[2]` | `[1,5,10,30,60]` | `>` | `500` | `3` | 统计周期内网卡平均出方向带宽。超限常伴随出口链路拥塞。 |
| `DiskReadTraffic` | 磁盘读吞吐 | `MB/s` | `[2]` | `[1,5,10,30,60]` | `>` | `100` | `3` | 统计周期内云盘平均读吞吐。持续偏高可能是缓存失效或全表扫描。 |
| `DiskWriteTraffic` | 磁盘写吞吐 | `MB/s` | `[2]` | `[1,5,10,30,60]` | `>` | `100` | `3` | 统计周期内云盘平均写吞吐。持续偏高需关注磁盘寿命与写入瓶颈。 |
| `DiskIoUtilization` | 磁盘 IO 使用率 | `%` | `[2]` | `[1,5,10,30,60]` | `>` | `85` | `3` | 磁盘忙碌时间占比，取值 0-100。长期 >85% 会显著抬高业务延迟。 |
| `TcpCurrEstab` | TCP 连接数 | `个` | `[2]` | `[1,5,10,30,60]` | `>` | `5000` | `3` | 统计周期内平均处于 ESTABLISHED 状态的 TCP 连接数。持续增长需排查连接泄漏。 |
| `LoadAverage1m` | 一分钟平均负载 | `无` | `[2]` | `[1,5,10,30,60]` | `>` | `8` | `3` | 一分钟平均负载（Linux loadavg）。经验阈值约为 vCPU 核数，需按实例规格调整。 |
| `FileDescriptorUsageRate` | 文件描述符使用率 | `%` | `[2]` | `[1,5,10,30,60]` | `>` | `80` | `3` | 已打开 FD 数占进程 FD 上限（`ulimit -n` / `LimitNOFILE`）比例，取值 0-100。**「Too many open files」是 Linux Top 5 故障，且通常先于内存耗尽出现**；内存与连接数指标都发现不了它——进程可以只开文件、不占多少内存、连接数也正常。 |
| `InodeUsageRate` | inode 使用率 | `%` | `[2]` | `[30,60]` | `>` | `85` | `2` | 已用 inode 数占文件系统 inode 总数比例，取值 0-100。**与 `DiskUsageRate` 正交**：磁盘有空间但 inode 用完时，磁盘指标全绿而任何文件创建都会失败（写日志、落临时文件全挂）。慢变量。 |
| `DiskDaysToFull` | 预计写满天数 | `天` | `[2]` | `[30,60]` | **`<`** | `7` | `1` | 按近 7 天平均增速外推，距离磁盘写满还剩多少天。**取值越小越危险，因此默认算子是 `<`**——本字典中第二个「越低越糟」的指标（另一个是 HttpSuccessRate）。同一个 `DiskUsageRate=85%` 对 50G/天涨 2G 的盘只剩 3 天、对 1T/天涨 2G 的盘还剩 75 天，绝对阈值表达不了这个差异。 |
| `DiskReadIops` | 磁盘读 IOPS | `IOPS` | `[2]` | `[1,5,10,30,60]` | `>` | `5000` | `3` | 统计周期内云盘平均每秒读操作数。**与 `DiskReadTraffic`(MB/s) 正交**：大量小文件/随机读场景吞吐很低但 IOPS 打满，只看 MB/s 会漏。 |
| `DiskWriteIops` | 磁盘写 IOPS | `IOPS` | `[2]` | `[1,5,10,30,60]` | `>` | `5000` | `3` | 统计周期内云盘平均每秒写操作数。与 `DiskWriteTraffic`(MB/s) 正交，理由同上。日志密集型服务的高频小写入是典型场景。 |

### 1.2 `WEB` — 通用 Web 服务（policyType = 1）

| metricName | metricNameCn | unit | policyType | periodOptions | defaultOperator | defaultThreshold | suggestedContinuity | description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `HttpRequestCount` | 请求数（QPS） | `次/秒` | `[1]` | `[1,5,10,30,60]` | `>` | `10000` | `3` | 统计周期内平均每秒请求数（QPS）。持续突增需确认是否流量异常或压测。 |
| `Http4xxCount` | HTTP 4xx 错误数 | `次` | `[1]` | `[1,5,10,30,60]` | `>` | `100` | `2` | 统计周期内 4xx 响应数量。4xx 多为客户端参数/鉴权问题，不一定需值班介入。 |
| `Http5xxCount` | HTTP 5xx 错误数 | `次` | `[1]` | `[1,5,10,30,60]` | `>` | `10` | `2` | 统计周期内 5xx 响应数量。非零即代表服务端异常，量级越大越紧急。 |
| `Http5xxRatio` | 5xx 错误率 | `%` | `[1]` | `[1,5,10,30,60]` | `>` | `5` | `3` | 5xx 请求数 / 总请求数 × 100，取值 0-100。比率比绝对值更抗流量波动影响。 |
| `HttpAvgDuration` | 平均响应延迟 | `ms` | `[1]` | `[1,5,10,30,60]` | `>` | `500` | `3` | 统计周期内全量请求的平均响应耗时。平均值会掩盖长尾，需与 P99 搭配。 |
| `HttpP99Duration` | P99 响应延迟 | `ms` | `[1]` | `[1,5,10,30,60]` | `>` | `1000` | `5` | 统计周期内响应耗时 99 分位值。更早暴露长尾劣化，建议作为对外 SLA 主指标。 |
| `HttpTimeoutCount` | 超时请求数 | `次` | `[1]` | `[1,5,10,30,60]` | `>` | `5` | `2` | 统计周期内客户端/网关判定超时的请求数量。反映链路最差表现。 |
| `HttpSuccessRate` | 服务成功率 | `%` | `[1]` | `[1,5,10,30,60]` | `<` | `99` | `3` | 非 5xx 且未超时的请求占比，取值 0-100。作为 SLA 视角的补充指标。 |
| `HttpMaxDuration` | 最大响应延迟 | `ms` | `[1]` | `[1,5,10,30,60]` | `>` | `5000` | `2` | 统计周期内单次请求的最大耗时。P99 之后仍有 1% 的请求更慢，**在低 QPS 服务上这 1% 可能就是全部用户**——此时 P99 看起来完全正常。 |

### 1.3 `CLB` — 负载均衡（policyType = 3）

| metricName | metricNameCn | unit | policyType | periodOptions | defaultOperator | defaultThreshold | suggestedContinuity | description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ClbBackendUnhealthyCount` | 后端异常数 | `个` | `[3]` | `[1,5,10,30,60]` | `>` | `1` | `2` | 统计周期内健康检查判定为异常的后端 RS 数量。非零即已影响可用性。 |
| `ClbHttp5xxRatio` | 5xx 比例 | `%` | `[3]` | `[1,5,10,30,60]` | `>` | `5` | `3` | CLB 侧转发的 5xx 响应占比，取值 0-100。与后端 `WEB.Http5xxRatio` 可交叉定位问题在 LB 还是后端。 |
| `ClbActiveConnections` | 活跃连接数 | `个` | `[3]` | `[1,5,10,30,60]` | `>` | `10000` | `3` | 统计周期内 CLB 活跃连接数。接近实例规格上限会触发限流。 |
| `ClbQps` | 请求数 | `次/秒` | `[3]` | `[1,5,10,30,60]` | `>` | `20000` | `3` | 统计周期内 CLB 平均每秒转发请求数。用于判断是否触及带宽/QPS 配额。 |
| `ClbBackendResponseTime` | 后端响应时间 | `ms` | `[3]` | `[1,5,10,30,60]` | `>` | `500` | `3` | CLB 侧观测到的后端 RS 响应耗时。与 `WEB.HttpP99Duration` 交叉可定位「慢在 LB 还是后端」——这是 `ClbHttp5xxRatio` 已采用的定位思路，响应时间侧此前缺失，导致**同一个设计原则只落实了一半**。 |

### 1.4 `MYSQL` — 云数据库 MySQL（policyType = 4）

| metricName | metricNameCn | unit | policyType | periodOptions | defaultOperator | defaultThreshold | suggestedContinuity | description |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `MysqlCpuUsageRate` | MySQL CPU 使用率 | `%` | `[4]` | `[1,5,10,30,60]` | `>` | `80` | `3` | MySQL 实例 CPU 使用率，取值 0-100。持续偏高需排查慢 SQL 或缺少索引。 |
| `MysqlSlowQueryCount` | 慢查询数 | `次` | `[4]` | `[1,5,10,30,60]` | `>` | `10` | `2` | 统计周期内超过 `long_query_time` 的查询条数。激增通常伴随锁等待或全表扫描。 |
| `MysqlConnectionCount` | 连接数 | `个` | `[4]` | `[1,5,10,30,60]` | `>` | `1000` | `3` | 当前活跃连接数。需结合实例规格调整，接近 `max_connections` 会导致连接被拒。 |
| `MysqlConnectionRatio` | 连接数使用率 | `%` | `[4]` | `[1,5,10,30,60]` | `>` | `80` | `3` | 当前连接数 / `max_connections` × 100。百分比口径比绝对值更可移植。 |
| `MysqlReplicationDelay` | 主从延迟 | `秒` | `[4]` | `[1,5,10,30,60]` | `>` | `30` | `2` | 主从复制秒级延迟。持续升高会导致读到旧数据，通常指向大事务或主库 IO 瓶颈。 |
| `MysqlDiskUsageRate` | 磁盘使用率 | `%` | `[4]` | `[30,60]` | `>` | `85` | `2` | 实例磁盘已用容量占比，取值 0-100。慢变量，仅 30/60 分钟粒度。写满会导致实例只读。 |
| `MysqlDeadlockCount` | 死锁数 | `次` | `[4]` | `[1,5,10,30,60]` | `>` | `0` | `2` | 统计周期内 InnoDB 死锁并被回滚的事务对数。**`MysqlSlowQueryCount` 发现不了死锁**——死锁涉及的两条 SQL 各自都不慢，它们是互相等锁。表现为间歇性请求超时，极难定位。 |
| `MysqlLockWaitTime` | 锁等待平均时长 | `ms` | `[4]` | `[1,5,10,30,60]` | `>` | `1000` | `3` | 统计周期内行锁/元数据锁的平均等待时长。持续偏高说明存在热点行或长事务，是死锁的前兆信号。 |
| `MysqlConnectionRejectCount` | 连接被拒数 | `次` | `[4]` | `[1,5,10,30,60]` | `>` | `0` | `2` | 触及 `max_connections` 时 MySQL 直接拒绝新连接的次数（`Too many connections`）。**`MysqlConnectionRatio` 只在连接数逼近上限时告警**；瞬时打满再回落时采样点上 ratio 可能根本没超阈值，**但用户已经被拒了**。 |

### 1.5 覆盖度自检

> ⚠️ **不要用这张表当新增指标的依据。** 它是「任务要求 → 指标」的对照，
> 按它打勾会把字典往「资源清单」方向带偏（CPU/内存/磁盘/网络逐项满足），
> 而漏掉同一份资源的**其他耗尽方式**（FD 满、inode 满、写满预测、IOPS 打满）。
>
> 新增指标请改用 `metrics-gap-analysis.md` 的 **A–F 六类故障语义**：
> 先定「它对应哪一类失效模式，该类是否已覆盖」，再定指标。
> 本表的 10 个新指标全部来自那份分析，**没有一个来自这张表**。

#### 1.5.1 任务要求对照（原表）

| 任务要求的指标 | 本文件对应项 |
| --- | --- |
| CPU 使用率 | `CVM.CpuUtilizationRate` |
| 内存使用率 | `CVM.MemoryUsageRate` |
| 磁盘使用率 | `CVM.DiskUsageRate` |
| 网络入带宽 | `CVM.LanInTraffic` |
| 网络出带宽 | `CVM.LanOutTraffic` |
| 磁盘 IO 读 | `CVM.DiskReadTraffic` |
| 磁盘 IO 写 | `CVM.DiskWriteTraffic` |
| TCP 连接数 | `CVM.TcpCurrEstab` |
| HTTP 5xx 错误数 | `WEB.Http5xxCount` |
| HTTP 4xx 错误数 | `WEB.Http4xxCount` |
| 请求数（QPS） | `WEB.HttpRequestCount` |
| 平均响应延迟 | `WEB.HttpAvgDuration` |
| P99 响应延迟 | `WEB.HttpP99Duration` |
| MySQL CPU 使用率 | `MYSQL.MysqlCpuUsageRate` |
| MySQL 慢查询数 | `MYSQL.MysqlSlowQueryCount` |
| MySQL 连接数 | `MYSQL.MysqlConnectionCount` |
| MySQL 主从延迟 | `MYSQL.MysqlReplicationDelay` |
| CLB 后端异常数 | `CLB.ClbBackendUnhealthyCount` |
| CLB 5xx 比例 | `CLB.ClbHttp5xxRatio` |
| **合计** | **38 个**（要求 ≥20） |

#### 1.5.2 按故障语义对照（**新增指标的主要依据**）

| 类 | 语义 | 覆盖 | 仍缺 |
| --- | --- | --- | --- |
| **A** | 不可用（服务不了） | 5xx、成功率、超时、CLB 后端异常 | 流量断流（QPS=0）**无专用指标**（已有 6 个指标不含它），但已由预置模板 7 覆盖，见 1.5.3 |
| **B** | 变慢（还能用但快崩） | 平均、P99、CLB 后端耗时 | 最大延迟（已补 `HttpMaxDuration`） |
| **C** | 错误（返回错东西） | 4xx、5xx、慢查询、死锁、锁等待、连接被拒 | 细粒度错误归因（tag 维度） |
| **D** | 将耗尽（还能跑但快没了） | CPU、内存、磁盘、IO、吞吐、连接数、**FD、inode、写满预测、IOPS** | inode/FD 的绝对条数口径（当前只有使用率） |
| **E** | 异常（不极端但不正常） | **0** | 同比/环比/突变判据 —— **契约 §1.5 无此类算子**，见 `metrics-gap-analysis.md` §3.2 D-1 |
| **F** | 无数据（监控系统自己瞎了） | **0** | 需心跳/freshness 机制，非加指标可解，见 §3.2 E-1 |

#### 1.5.3 ⚠️ 流量断流：不要指望 `HttpSuccessRate` 兜底

`HttpRequestCount` 的 `defaultOperator` 是 `>`，只能发现「QPS 冲到一万」，
**发现不了「QPS 归零」**。而服务进程存活、健康检查通过、却一个请求都处理不了
是真实存在的故障形态。

理论上 `HttpSuccessRate`（`< 99`）能兜底，但 **QPS=0 时分母也是 0**，
不同监控系统对该情形的取值约定不统一（部分实现返回 100%）。
**依赖语义未定义的指标去兜底最严重的故障是不可接受的。**

→ 预置模板「模板 7 —— 流量断流」用 `HttpRequestCount` + `<` + 极小阈值表达该场景。

**统计口径说明**（避免与上表对读时困惑）：上表的「覆盖」列统计的是**字典里的指标**，
所以流量断流记为「无专用指标」；模板 7 并不新增指标，
而是**给已有指标换一个算子方向**（`>` → `<`）来表达同一个场景。两者不矛盾。

---

## 2. 预置触发条件模板使用说明

`schema.sql` 末尾以 `INSERT IGNORE` 写入 **6 条** `is_preset = 1` 的 `alarm_condition_template`。

- 对应端点：`GET /api/alarm/condition-templates?isPreset=1`
- **可修改、不可删除**（`contract.md` §4.2 T4，删除返回 `409 PRESET_READONLY`）
- 新建策略时选择模板，会把模板的 `conditions` 深拷贝到策略，并记录
  `alarm_policy.condition_template_id` 供溯源；此后模板的后续修改**不会**回灌到已创建的策略
- 预置模板 `creator_name = 'system'`，`creator_id = 0`

---

## 3. 7 条预置触发条件模板

### 模板 1 —— CPU 持续过高

| 项 | 值 |
| --- | --- |
| 模板名称 | `CPU 持续过高` |
| 适用 policyType | `2` 云服务器 CVM（`monitorType=1`） |
| 指标 | `CVM.CpuUtilizationRate`（CPU 使用率，`%`） |
| operator / threshold | `>` / `80` |
| period / continuity | `5`（5 分钟） / `3`（连续 3 个数据点） |
| level | `2` 严重 |
| frequency | `30`（每 30 分钟重复通知） |
| 适用场景 | 所有 CVM 实例的**基础资源策略**。表示每 5 分钟采样一次 CPU 使用率，连续 3 次超过 80% 触发严重告警。适合绝大多数常规业务实例；核心交易库可上调至 90。 |
| 不适用场景 | 批处理/离线计算节点（CPU 常态高水位会产生噪声），建议改用 `LoadAverage1m` 并调高阈值。 |

### 模板 2 —— 内存即将耗尽

| 项 | 值 |
| --- | --- |
| 模板名称 | `内存即将耗尽` |
| 适用 policyType | `2` 云服务器 CVM（`monitorType=1`） |
| 指标 | `CVM.MemoryUsageRate`（内存使用率，`%`） |
| operator / threshold | `>` / `90` |
| period / continuity | `5`（5 分钟） / `3` |
| level | `1` 紧急 |
| frequency | `15`（每 15 分钟重复通知） |
| 适用场景 | 需要为 OOM 处置预留时间的核心服务。内存一旦打满，进程会被 OOM Killer 直接杀死，表现为无预警的 5xx 突增，因此级别设为紧急、通知频率加密到 15 分钟。 |
| 不适用场景 | 内存大户型实例（如 JVM 堆已固定 `-Xmx` 的服务）可将阈值下调至 80 提前预警。 |

### 模板 3 —— 磁盘空间不足

| 项 | 值 |
| --- | --- |
| 模板名称 | `磁盘空间不足` |
| 适用 policyType | `2` 云服务器 CVM（`monitorType=1`） |
| 指标 | `CVM.DiskUsageRate`（磁盘使用率，`%`） |
| operator / threshold | `>` / `85` |
| period / continuity | `60`（60 分钟） / `2` |
| level | `2` 严重 |
| frequency | `180`（每 3 小时重复通知） |
| 适用场景 | 磁盘是慢变量，变化以小时/天计，因此采样周期放宽到 60 分钟、通知间隔放到 3 小时，避免刷屏。适用于几乎所有会写盘的实例（日志、缓存、数据目录）。 |
| 不适用场景 | 日志频繁轮转且单文件巨大的实例，磁盘可能在 1 小时内暴涨，建议改用 `WEB` 侧日志量指标监控。 |

### 模板 4 —— 服务错误率升高

| 项 | 值 |
| --- | --- |
| 模板名称 | `服务错误率升高` |
| 适用 policyType | `1` 通用 Web 服务（`monitorType=2`） |
| 指标 | `WEB.Http5xxRatio`（5xx 错误率，`%`） |
| operator / threshold | `>` / `5` |
| period / continuity | `1`（1 分钟） / `3` |
| level | `1` 紧急 |
| frequency | `15`（每 15 分钟重复通知） |
| 适用场景 | **发布后守门指标**。1 分钟粒度保证快速发现，连续 3 次超过 5% 可过滤偶发抖动，真实故障基本不会漏报。比率口径比绝对错误数更抗流量波动。 |
| 不适用场景 | QPS 极低的内部服务（个位数请求），单个请求失败即造成 >5% 比率，建议改用绝对值 `WEB.Http5xxCount` 配 `>= 1`。 |

### 模板 5 —— 响应延迟劣化

| 项 | 值 |
| --- | --- |
| 模板名称 | `响应延迟劣化` |
| 适用 policyType | `1` 通用 Web 服务（`monitorType=2`） |
| 指标 | `WEB.HttpP99Duration`（P99 响应延迟，`ms`） |
| operator / threshold | `>` / `1000` |
| period / continuity | `1`（1 分钟） / `5`（连续 5 个数据点） |
| level | `2` 严重 |
| frequency | `30`（每 30 分钟重复通知） |
| 适用场景 | 对外 SLA 服务。刻意选 P99 而非平均值：平均值会被大量快请求稀释，长尾劣化往往先在 P99 上显现。连续 5 个点（5 分钟）确认可避免 GC/网络抖动误报。 |
| 不适用场景 | 天然长耗时接口（报表导出、批量任务）所在的服务，应按接口拆分指标或上调阈值至 3000ms。 |

### 模板 6 —— 数据库主从延迟异常

| 项 | 值 |
| --- | --- |
| 模板名称 | `数据库主从延迟异常` |
| 适用 policyType | `4` 云数据库 MySQL（`monitorType=1`） |
| 指标 | `MYSQL.MysqlReplicationDelay`（主从延迟，`秒`） |
| operator / threshold | `>` / `30` |
| period / continuity | `1`（1 分钟） / `2` |
| level | `1` 紧急 |
| frequency | `30`（每 30 分钟重复通知） |
| 适用场景 | 有只读实例 + 读写分离架构的 MySQL。延迟持续升高会导致应用读到旧数据（缓存穿透、读己之写失效），属于**静默故障**，必须紧急介入。1 分钟粒度保证及时发现。 |
| 不适用场景 | 无只读实例的主库实例（无复制延迟可言）；高写入、大事务场景可上调至 60-120 秒避免误报。 |

### 模板 7 —— 流量断流（新增，2026-10-04）

| 项 | 值 |
| --- | --- |
| 模板名称 | `流量断流` |
| 适用 policyType | `1` 通用 Web 服务（`monitorType=2`） |
| 指标 | `WEB.HttpRequestCount`（请求数 QPS，`次/秒`） |
| operator / threshold | **`<` / `1`** |
| period / continuity | `1`（1 分钟） / `2` |
| level | `1` 紧急 |
| frequency | `15`（每 15 分钟重复通知） |
| 适用场景 | 服务进程存活、健康检查通过，但**一个请求都处理不了**。这是最严重的故障形态之一，而 `HttpRequestCount` 的默认算子是 `>`，**只能发现「QPS 冲到一万」，发现不了「QPS 归零」**。 |
| 为什么不用 `HttpSuccessRate` 兜底 | QPS=0 时成功率的分母也是 0，不同监控系统对该情形的取值约定不统一（部分返回 100%）。**依赖语义未定义的指标去兜底最严重的故障是不可接受的。** |
| 不适用场景 | 正常就有低峰期的服务（如凌晨无人访问的内部系统）会误报。**这类服务应当用「同比/环比突变」而不是绝对阈值** —— 见 `metrics-gap-analysis.md` §3.2 D-1（契约 §1.5 当前无此类算子，v1.1 立项）。 |

> ⚠️ 这是全字典**第 7 条**预置模板，也是**第一条 `operator` 为 `<` 且作用于「次数类」指标**的模板。
> 唯一键 `uk_condition_template` 按 `name` 去重，重跑 `INSERT` 不会产生重复。

### 3.1 模板参数汇总表

| # | 模板名称 | policyType | metric | operator | threshold | period | continuity | level | frequency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | CPU 持续过高 | `2` | `CVM.CpuUtilizationRate` | `>` | `80` | `5` | `3` | `2` | `30` |
| 2 | 内存即将耗尽 | `2` | `CVM.MemoryUsageRate` | `>` | `90` | `5` | `3` | `1` | `15` |
| 3 | 磁盘空间不足 | `2` | `CVM.DiskUsageRate` | `>` | `85` | `60` | `2` | `2` | `180` |
| 4 | 服务错误率升高 | `1` | `WEB.Http5xxRatio` | `>` | `5` | `1` | `3` | `1` | `15` |
| 5 | 响应延迟劣化 | `1` | `WEB.HttpP99Duration` | `>` | `1000` | `1` | `5` | `2` | `30` |
| 6 | 数据库主从延迟异常 | `4` | `MYSQL.MysqlReplicationDelay` | `>` | `30` | `1` | `2` | `1` | `30` |
| 7 | **流量断流** | `1` | `WEB.HttpRequestCount` | **`<`** | **`1`** | `1` | `2` | `1` | `15` |

> 校验自查：全部 7 条的 `period` 均在对应指标的 `periodOptions` 子集内
> （模板 7 用 `HttpRequestCount` 的 `periodOptions=[1,5,10,30,60]`，取 `1` 合法）；
> 全部 `continuity ∈ [1,10]`；全部 `level ∈ {1,2,3}`；全部 `frequency ∈ {0,5,15,30,60,180,360,720,1440}`；
> 全部 `operator ∈ {>,>=,<,<=,==,!=}`；每条模板 1 个条件，满足「1-4 条」约束。

---

## 4. 机器可读副本（`GET /api/alarm/metrics` 预期响应节选）

后端可直接把本段作为实现的比对基准（仅列 3 条，实际接口返回全部 38 条）。

```jsonc
{
  "data": [
    {
      "namespace": "CVM",
      "metricName": "CpuUtilizationRate",
      "metricNameCn": "CPU 使用率",
      "unit": "%",
      "policyType": [2],
      "periodOptions": [1, 5, 10, 30, 60],
      "defaultOperator": ">",
      "defaultThreshold": 80,
      "suggestedContinuity": 3,
      "description": "统计周期内实例 CPU 使用率平均值，取值 0-100。持续偏高通常意味着计算资源打满、需扩容或存在死循环。"
    },
    {
      "namespace": "WEB",
      "metricName": "HttpP99Duration",
      "metricNameCn": "P99 响应延迟",
      "unit": "ms",
      "policyType": [1],
      "periodOptions": [1, 5, 10, 30, 60],
      "defaultOperator": ">",
      "defaultThreshold": 1000,
      "suggestedContinuity": 5,
      "description": "统计周期内响应耗时 99 分位值。更早暴露长尾劣化，建议作为对外 SLA 主指标。"
    },
    {
      "namespace": "MYSQL",
      "metricName": "MysqlReplicationDelay",
      "metricNameCn": "主从延迟",
      "unit": "秒",
      "policyType": [4],
      "periodOptions": [1, 5, 10, 30, 60],
      "defaultOperator": ">",
      "defaultThreshold": 30,
      "suggestedContinuity": 2,
      "description": "主从复制秒级延迟。持续升高会导致读到旧数据，通常指向大事务或主库 IO 瓶颈。"
    }
  ],
  "extra": {},
  "code": 0,
  "message": "success",
  "success": true
}
```

---

## 5. 扩展规则（未来新增指标时）

1. 新指标必须落在 §0.2 的 4 个 namespace 之一；若新增 policyType，需先在 `contract.md` §1.1 / §1.2 补枚举。
2. `metricName` 遵循命名约定：
   - CVM / CLB / MYSQL 指标以所属产品名开头（`Mysql*` / `Clb*`），CVM 通用指标直接用指标语义名（`CpuUtilizationRate`）
   - WEB 指标统一以 `Http` 开头
3. `metricNameCn` 不含单位（单位在 `unit` 字段）。
4. 新增指标**不破坏**已有 7 条预置模板引用的唯一键。
5. 指标字典为**代码内常量**（建议放 `config/metrics.php` 或独立 YAML），**不入库** —— 它是系统元数据而非租户数据，避免被误删/误改。
