<?php

declare(strict_types=1);

use Hyperf\Database\Migrations\Migration;
use Hyperf\DbConnection\Db;

/**
 * 告警「活动记录」唯一性约束。
 *
 * ## 为什么加这条
 *
 * `alarm_history` 的设计前提是「同一条告警在未恢复期间只有一条活跃记录」，
 * 重复命中只更新那一行（`updated_at` / `notify_count`）。
 *
 * 但**数据库层面没有任何东西保证这一点** —— 原来只有普通索引。
 * 而 `first()` 再 `create()` 的写法在并发下必然有窗口，
 * 一个持续两小时的故障可能产生上百条重复行。
 *
 * 设计见 `docs/alarm/alert-lifecycle.md` §5。
 */
return new class extends Migration
{
    private function columnExists(string $table, string $column): bool
    {
        $row = Db::select(
            'SELECT COUNT(*) AS c FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [$table, $column]
        );

        return (int) ($row[0]->c ?? 0) > 0;
    }

    private function indexExists(string $table, string $name): bool
    {
        $row = Db::select(
            'SELECT COUNT(*) AS c FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
            [$table, $name]
        );

        return (int) ($row[0]->c ?? 0) > 0;
    }

    public function up(): void
    {
        // ── 幂等：列已存在就跳过 ────────────────────────────────────
        if (! $this->columnExists('alarm_history', 'active_key')) {
            // ⚠️ 用**生成列**而不是普通列 + 应用层维护：
            //   生成列由 MySQL 保证与源列同步，不可能出现
            //   「active_key 忘了更新」这种不一致。
            //
            // ⚠️ MySQL 不支持 `CREATE UNIQUE INDEX ... WHERE`，
            //   所以「只约束未恢复的行」只能靠 NULL 语义实现：
            //   UNIQUE 索引允许**多个 NULL 共存**，
            //   于是恢复后的行 active_key=NULL → 不参与唯一性检查。
            //   已实测 MySQL 8.0.46：重复活跃行报 1062，
            //   已恢复行可任意多条共存。
            Db::statement(
                'ALTER TABLE `alarm_history` ADD COLUMN `active_key` VARCHAR(96) '
                . "GENERATED ALWAYS AS (IF(`recovered_at` IS NULL, "
                . "CONCAT(`policy_id`, ':', `condition_id`, ':', `object_id`), NULL)) STORED "
                . "COMMENT '活动告警唯一键：policy:condition:object；已恢复为 NULL 故不参与唯一约束'"
            );
            echo "  + alarm_history.active_key\n";
        }

        // ⚠️ 加唯一索引前必须先清理历史脏数据，否则 ALTER 会直接失败。
        //   策略：同一 (policy_id, condition_id, object_id) 下若有**多条**未恢复行，
        //   保留 triggered_at 最早的那条（最贴近真实触发时刻），其余标记为已恢复。
        $dupes = Db::select(
            'SELECT `policy_id`, `condition_id`, `object_id`, COUNT(*) AS c
             FROM `alarm_history`
             WHERE `recovered_at` IS NULL
             GROUP BY `policy_id`, `condition_id`, `object_id`
             HAVING c > 1'
        );
        if ($dupes !== []) {
            echo sprintf("  ! 发现 %d 组重复活跃告警，保留最早一条，其余标记为已恢复\n", count($dupes));
            foreach ($dupes as $d) {
                Db::statement(
                    'UPDATE `alarm_history` SET `recovered_at` = `triggered_at`, `duration` = 0
                     WHERE `policy_id` = ? AND `condition_id` = ? AND `object_id` = ?
                       AND `recovered_at` IS NULL
                       AND `id` <> (
                         SELECT k FROM (
                           SELECT MIN(`id`) AS k FROM `alarm_history`
                           WHERE `policy_id` = ? AND `condition_id` = ? AND `object_id` = ?
                             AND `recovered_at` IS NULL
                         ) t
                       )',
                    [$d->policy_id, $d->condition_id, $d->object_id, $d->policy_id, $d->condition_id, $d->object_id]
                );
            }
        }

        if (! $this->indexExists('alarm_history', 'uk_history_active')) {
            Db::statement('ALTER TABLE `alarm_history` ADD UNIQUE KEY `uk_history_active` (`active_key`)');
            echo "  + alarm_history.uk_history_active\n";
        }


    }

    public function down(): void
    {
        // ⚠️ 顺序与 up() 相反：先删索引再删列。
        //    MySQL 3959：CHECK/生成列被索引引用时不能先删列。
        if ($this->indexExists('alarm_history', 'uk_history_active')) {
            Db::statement('ALTER TABLE `alarm_history` DROP INDEX `uk_history_active`');
        }
        if ($this->columnExists('alarm_history', 'active_key')) {
            Db::statement('ALTER TABLE `alarm_history` DROP COLUMN `active_key`');
        }
    }
};
