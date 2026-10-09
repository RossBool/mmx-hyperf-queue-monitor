<?php

declare(strict_types=1);
/**
 * 迁移：v1.1 契约扩展 —— E 类（相对判据）+ F 类（无数据检测）。
 *
 * ## 为什么是新文件
 *
 * 000100–000800 都已经在别的环境执行过。改已应用的迁移不会重跑，
 * 改动只对**新部署**生效 —— 那是「字段在测试库有、生产库没有」的经典成因。
 * 每个迁移的 docblock 都写着「改结构必须新建迁移文件」，这里同样。
 *
 * ## 兼容性保证
 *
 * **全部是加法**，v1.0 存量数据一行都不用改：
 *   - 新列全部 `NULL` 可空（`ALTER TABLE ... ADD COLUMN` 不带 NOT NULL / 无默认值）
 *   - 心跳表是全新表
 *
 * 读侧一律用「NULL 表示 absolute / 不适用」兜底，
 * 所以旧策略被读出来时 `compare_mode` 就是 NULL，行为与 v1.0 完全一致。
 *
 * 详见 `docs/alarm/metrics-v1.1-design.md`。
 */
use Hyperf\Database\Migrations\Migration;
use Hyperf\DbConnection\Db;

return new class extends Migration
{
    /**
     * 列是否已存在。
     *
     * ## 为什么必须探测，而不能写 `ADD COLUMN IF NOT EXISTS`
     *
     * **MySQL 不支持那个语法** —— 实测 MySQL 8.0.46：
     *   ALTER TABLE probe ADD COLUMN IF NOT EXISTS c1 INT
     *   → ERROR 1064 (42000) ... near 'IF NOT EXISTS c1 INT'
     * 那是 **MariaDB** 的扩展语法。两个都叫「MySQL」，抄到 MariaDB 的写法会在
     * 官方 MySQL 上直接语法报错 —— 而且是在**迁移执行时**才炸。
     *
     * ## 为什么幂等这么重要
     *
     * S-07 定的规矩是「迁移重跑必须可自愈」：000100–000800 全部用
     * `CREATE TABLE IF NOT EXISTS`，重跑无害。
     * 本迁移第一版直接 `ADD COLUMN`，**重跑必然 1060 Duplicate column name** ——
     * 自己把 S-07 破掉了。
     *
     * 触发场景很常见：CI 每次都从同一个库快照起；运维手工重跑一次迁移；
     * 部署脚本失败后重试。任一种都会让第二次执行炸掉，
     * 而「第一次明明成功了」的现场很难排查。
     */
    private function columnExists(string $table, string $column): bool
    {
        $row = Db::select(
            'SELECT COUNT(*) AS c FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [$table, $column]
        );

        return (int) ($row[0]->c ?? 0) > 0;
    }

    /** 表是否已存在 */
    private function tableExists(string $table): bool
    {
        $row = Db::select(
            'SELECT COUNT(*) AS c FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
            [$table]
        );

        return (int) ($row[0]->c ?? 0) > 0;
    }

    public function up(): void
    {
        try {
            Db::statement('SET FOREIGN_KEY_CHECKS = 0');

            // ── 1. 条件表：相对判据的三个正交字段 ─────────────────────
            // compare_mode      : absolute（默认行为）/ relative
            // baseline_type     : period（环比）/ day（同比昨日）/ week（同比上周）
            // baseline_count    : baseline_type=period 时前移几个统计周期
            //
            // ⚠️ 全部可空且无默认值 —— 存量行的这三列是 NULL，
            //    读侧按「NULL 等价于 absolute」处理，行为与 v1.0 一致。
            //    如果这里给了 DEFAULT 'absolute'，就等于给存量行批量改写了语义，
            //    一旦将来默认值要改就会变成一场事故。
            $this->addColumnIfMissing('alarm_policy_condition', 'compare_mode',
                "VARCHAR(16) NULL COMMENT '判据模式 absolute=绝对阈值(默认) relative=相对基线偏离'");
            $this->addColumnIfMissing('alarm_policy_condition', 'baseline_type',
                "VARCHAR(16) NULL COMMENT '基线类型 period=环比 day=同比昨日 week=同比上周，仅 relative 时有值'");
            $this->addColumnIfMissing('alarm_policy_condition', 'baseline_count',
                "SMALLINT UNSIGNED NULL COMMENT '环比前移的统计周期数 1-60，仅 baseline_type=period 时有值'");

            // ── 2. 策略表：无数据检测的两个字段 ────────────────────────
            // target_type             : 仅 policyType=5「采集静默」时有值
            // target_freshness_minutes: 静默多久（分钟）算异常，5-10080
            // 采集静默条件**不含**指标判据（契约 §2.1 规则 3），这 4 列必须可空。
            //
            // ⚠️ 这是 v1.0 → v1.1 唯一的破坏性 schema 变化。放宽可空是安全方向
            //    （允许 NULL 不会让任何现存行为变坏），但**收紧**不是 ——
            //    所以 down() 必须先清掉采集静默的策略，否则
            //    `MODIFY ... NOT NULL` 会因为存量 NULL 直接失败。
            Db::statement(
                'ALTER TABLE `alarm_policy_condition` '
                . 'MODIFY COLUMN `metric_namespace` VARCHAR(64) NULL, '
                . 'MODIFY COLUMN `metric_name` VARCHAR(64) NULL, '
                . 'MODIFY COLUMN `operator` VARCHAR(2) NULL, '
                . 'MODIFY COLUMN `threshold` DECIMAL(20,4) NULL'
            );

            $this->addColumnIfMissing('alarm_policy', 'target_type',
                "TINYINT UNSIGNED NULL COMMENT '静默检测的目标类型 1CVM 2CLB 3MySQL 4WEB，仅 policyType=5 时有值'");
            $this->addColumnIfMissing('alarm_policy', 'target_freshness_minutes',
                "SMALLINT UNSIGNED NULL COMMENT '数据静默超过该分钟数即告警 5-10080，仅 policyType=5 时有值'");

            // ── 3. 心跳表：采集侧写入，告警侧读取 ──────────────────────
            // ⚠️ 本项目**不写这张表**。它是管理面交付的一部分，
            //    写入方是采集侧 agent。判定逻辑属于告警引擎，同样不在本项目。
            //
            // 没有它就没法做「F 类」判定，但它本身不是告警数据 ——
            // 放独立的表而不是塞进 alarm_policy，是为了让采集侧可以独立写入、
            // 独立清理，且不需要理解任何告警语义。
            // CREATE TABLE IF NOT EXISTS 本身幂等，这里额外判断只是为了在日志里
            // 区分「新建」和「已存在」，方便排查半完成的迁移。
            if ($this->tableExists('alarm_target_heartbeat')) {
                echo "  · alarm_target_heartbeat 已存在，跳过建表\n";
            }
            $this->replaceCheck('alarm_policy', 'ck_policy_policy_type',
                '(`policy_type` IN (1, 2, 3, 4, 5))');

            Db::statement(
                'CREATE TABLE IF NOT EXISTS `alarm_target_heartbeat` ('
                . '`target_type` TINYINT UNSIGNED NOT NULL COMMENT \'目标类型 1CVM 2CLB 3MySQL 4WEB\','
                . '`target_id` VARCHAR(128) NOT NULL COMMENT \'目标唯一标识\','
                . '`last_metric_at` DATETIME NULL COMMENT \'最后一次收到该目标指标数据的时间；NULL=从未上报\','
                . '`updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,'
                . 'PRIMARY KEY (`target_type`, `target_id`)'
                . ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT=\'采集心跳表：由采集侧写入，告警侧只读\''
            );

            $this->addV11Checks();
        } finally {
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }

    /** CHECK 存在则删除 */
    private function dropCheckIfExists(string $table, string $name): void
    {
        if (! $this->checkExists($table, $name)) {
            return;
        }
        Db::statement(sprintf('ALTER TABLE `%s` DROP CHECK `%s`', $table, $name));
        echo "  - {$table}.{$name}\n";
    }

    /** CHECK 约束是否已存在 */
    private function checkExists(string $table, string $name): bool
    {
        $row = Db::select(
            'SELECT COUNT(*) AS c FROM information_schema.TABLE_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?',
            [$table, $name]
        );

        return (int) ($row[0]->c ?? 0) > 0;
    }

    /**
     * 用指定表达式重建一个 CHECK 约束（不存在则新建，已存在则先删后建）。
     *
     * 之所以用「先删后建」而不是「不存在才建」：CHECK 的表达式会随 v1.1
     * 需求变化（比如 policy_type 的取值域从 1-4 扩到 1-5），
     * 「已存在就跳过」会让旧表达式永远留在库里。
     */
    private function replaceCheck(string $table, string $name, string $clause): void
    {
        if ($this->checkExists($table, $name)) {
            Db::statement(sprintf('ALTER TABLE `%s` DROP CHECK `%s`', $table, $name));
        }
        Db::statement(sprintf('ALTER TABLE `%s` ADD CONSTRAINT `%s` CHECK %s', $table, $name, $clause));
        echo "  ~ {$table}.{$name}\n";
    }

    /** 列不存在时才加。幂等的关键 —— 见 columnExists() 的说明。 */
    private function addColumnIfMissing(string $table, string $column, string $definition): void
    {
        if ($this->columnExists($table, $column)) {
            echo "  · {$table}.{$column} 已存在，跳过\n";

            return;
        }

        Db::statement(sprintf(
            'ALTER TABLE `%s` ADD COLUMN `%s` %s',
            $table,
            $column,
            $definition
        ));
        echo "  + {$table}.{$column}\n";
    }

    /**
     * 补齐 v1.1 新列的 CHECK 约束。
     *
     * ## 为什么不能只靠应用层校验
     *
     * v1.0 靠 29 个 CHECK 兜底，是因为「应用层可能不是唯一的写入方」：
     * 运维手工改库、数据修复脚本、后续迁移直接 UPDATE。
     * 这些路径**全都不经过 ConditionValidator**。
     *
     * v1.1 第一版新增了 5 个列却一个 CHECK 都没加，等于把这层防线在
     * 新字段上整个丢掉了 —— 写进去一个 `compare_mode='garbage'` 或者
     * `target_freshness_minutes = 0`，没有任何东西会拦。
     *
     * 而 `target_freshness_minutes = 0` 意味着「数据静默 0 分钟就告警」——
     * 引擎会**持续不断地**报同一条告警。这类脏数据在监控平台上通常
     * 要等几天后才从告警风暴里反查出来。
     *
     * ## 为什么 MySQL 最低版本锁 8.0.16
     *
     * 8.0.15 及更早**会静默忽略 CHECK**（解析后直接丢弃，不报错）。
     * 换句话说这些约束在低版本上形同虚设，却不会有任何提示。
     * 8.0.16 才是真正开始执行 CHECK 的版本。
     */
    private function addV11Checks(): void
    {
        // 条件：判据模式
        $this->replaceCheck('alarm_policy_condition', 'ck_condition_compare_mode',
            "(`compare_mode` IS NULL OR `compare_mode` IN ('absolute', 'relative'))");

        // 条件：基线类型
        $this->replaceCheck('alarm_policy_condition', 'ck_condition_baseline_type',
            "(`baseline_type` IS NULL OR `baseline_type` IN ('period', 'day', 'week'))");

        // 条件：环比前移周期数 1-60
        $this->replaceCheck('alarm_policy_condition', 'ck_condition_baseline_count',
            '(`baseline_count` IS NULL OR (`baseline_count` BETWEEN 1 AND 60))');

        // 条件：相对判据的组合一致性
        // 「absolute 却带着 baselineType」这种行一旦落库，半年后才会有人
        // 排查「为什么这条策略不触发」—— 那时它已经是个灵异事件了。
        // ⚠️ CHECK 表达式必须写成**单行**。跨行（PHP 字符串里的换行）在
        //    MySQL 8.0 上会直接 1064 语法错误，而且错误信息指向第 2 行
        //    的 OR 开头处，看起来像括号不配对，其实是换行本身。
        $this->replaceCheck('alarm_policy_condition', 'ck_condition_relative_pair',
            "( (`compare_mode` = 'relative' AND `baseline_type` IS NOT NULL AND `baseline_count` IS NOT NULL)"
            . " OR (`compare_mode` = 'relative' AND `baseline_type` IN ('day', 'week') AND `baseline_count` IS NULL)"
            . " OR ((`compare_mode` IS NULL OR `compare_mode` = 'absolute') AND `baseline_type` IS NULL AND `baseline_count` IS NULL) )");

        // 策略：静默目标类型 1-4
        $this->replaceCheck('alarm_policy', 'ck_policy_target_type',
            '(`target_type` IS NULL OR `target_type` BETWEEN 1 AND 4)');

        // 策略：静默时长 5-10080 分钟
        $this->replaceCheck('alarm_policy', 'ck_policy_freshness',
            '(`target_freshness_minutes` IS NULL OR `target_freshness_minutes` BETWEEN 5 AND 10080)');

        // 策略：静默字段与 policyType 的一致性
        // 双向锁死：既不许「静默策略没配静默参数」，也不许「普通策略偷挂静默参数」。
        $this->replaceCheck('alarm_policy', 'ck_policy_silence_pair',
            "( (`policy_type` = 5 AND `target_type` IS NOT NULL AND `target_freshness_minutes` IS NOT NULL)"
            . " OR (`policy_type` <> 5 AND `target_type` IS NULL AND `target_freshness_minutes` IS NULL) )");
    }

    /**
     * ⚠️ **drop 顺序与 add 顺序相反**。
     * 先删心跳表（它不依赖其他表），再删新增列。
     * ADD COLUMN 的逆操作就是 DROP COLUMN，不需要重建表。
     */
    public function down(): void
    {
        // ⚠️ 这里**不能**关 FOREIGN_KEY_CHECKS。
        //
        //    第 2 步 `DELETE FROM alarm_policy WHERE policy_type = 5` 依赖
        //    `alarm_policy_condition.policy_id` 的 ON DELETE CASCADE 清理条件行。
        //    一旦关掉外键检查，CASCADE 就不触发了，于是留下一批
        //    threshold/metric_* 为 NULL 的**孤儿行**，
        //    第 3 步的 `MODIFY ... NOT NULL` 必然失败 ——
        //    而报错信息只会说「数据违反非空约束」，完全看不出
        //    真正的原因是上一行的删除没级联。
        try {
            // ── 第 1 步：先删掉引用新列的 CHECK ──────────────────────────
            //
            // ⚠️ MySQL 3959：`Check constraint 'X' uses column 'Y', hence column
            //    cannot be dropped or renamed.`
            //    只要有 CHECK 引用了某列，**那个列就不能删**。
            //    第一版 down() 直接 DROP COLUMN，被这条规则拦在中间 ——
            //    表处于「心跳表已删、列还在、CHECK 已回退」的半完成状态，
            //    而 CREATE TABLE IF NOT EXISTS / information_schema 探测
            //    都不认为这是错误状态，之后每次重跑都从这里继续，非常难查。
            //
            //    正确顺序：约束 → 数据 → 列宽 → 列 → 其余。
            foreach ([
                'ck_condition_relative_pair',
                'ck_condition_compare_mode',
                'ck_condition_baseline_type',
                'ck_condition_baseline_count',
            ] as $name) {
                $this->dropCheckIfExists('alarm_policy_condition', $name);
            }
            foreach ([
                'ck_policy_silence_pair',
                'ck_policy_target_type',
                'ck_policy_freshness',
            ] as $name) {
                $this->dropCheckIfExists('alarm_policy', $name);
            }

            // ── 第 2 步：清掉采集静默的策略与条件 ────────────────────────
            // 它们的指标字段按契约就是 NULL。不先删，第 3 步的 NOT NULL 会失败。
            Db::statement('DELETE FROM `alarm_policy` WHERE `policy_type` = 5');

            // ── 第 3 步：把 4 个指标列收回 NOT NULL ──────────────────────
            Db::statement(
                'ALTER TABLE `alarm_policy_condition` '
                . 'MODIFY COLUMN `metric_namespace` VARCHAR(64) NOT NULL, '
                . 'MODIFY COLUMN `metric_name` VARCHAR(64) NOT NULL, '
                . 'MODIFY COLUMN `operator` VARCHAR(2) NOT NULL, '
                . 'MODIFY COLUMN `threshold` DECIMAL(20,4) NOT NULL'
            );

            // ── 第 4 步：policy_type 的 CHECK 收回 1-4 ───────────────────
            $this->replaceCheck('alarm_policy', 'ck_policy_policy_type', '(`policy_type` IN (1, 2, 3, 4))');

            // ── 第 5 步：删列、删表 ─────────────────────────────────────
            Db::statement(
                'ALTER TABLE `alarm_policy_condition` '
                . 'DROP COLUMN `baseline_count`, '
                . 'DROP COLUMN `baseline_type`, '
                . 'DROP COLUMN `compare_mode`'
            );
            Db::statement(
                'ALTER TABLE `alarm_policy` '
                . 'DROP COLUMN `target_freshness_minutes`, '
                . 'DROP COLUMN `target_type`'
            );
            Db::statement('DROP TABLE IF EXISTS `alarm_target_heartbeat`');
        } finally {
            // 外键检查保持开启；这里只是确保异常路径下也能继续。
            Db::statement('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
};
