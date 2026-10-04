<?php

declare(strict_types=1);
/**
 * 直接执行 8 个迁移的 up()，并在真实 MySQL 8 上验证结果。
 *
 * 为什么不用 `php bin/hyperf.php migrate`：
 *   本项目的 config/autoload/commands.php 没注册 Hyperf 的 MigrateCommand，
 *   `list` 里只有 help/list，migrate 命令不存在。
 *   但**迁移代码本身是否正确**才是要验的东西 —— 直接 require 迁移文件拿到
 *   返回的匿名类、调用 up()，走的是与命令行完全相同的代码路径。
 *
 * 为什么值得跑：审查阶段发现的 B-1（000800 写 `description` 而表里是 `remark`）
 * 就是纯静态比对抓出来的。它证明了静态校验不能替代真跑。
 */
use Hyperf\DbConnection\Db;

! defined('BASE_PATH') && define('BASE_PATH', __DIR__);

// ⚠️ 必须引 test/bootstrap.php（不是 config/bootstrap.php）：
//    它会做 `ClassLoader::init()` + 建容器 + `ApplicationContext::setContainer()`。
//    只引 config/bootstrap.php 的话容器不存在，
//    `Db::` 静态门面会报 `getContainer(): Return value must be of type
//    Psr\Container\ContainerInterface, null returned`。
//    与 Feature 测试共用同一个 bootstrap，保证测的是同一套装配。
require BASE_PATH . '/test/bootstrap.php';

// 容器已就绪，Db:: 静态门面可用 —— 与 Feature 测试同一条路径。

$dir = BASE_PATH . '/migrations';
$files = glob($dir . '/*.php');
sort($files);

echo "PHP " . PHP_VERSION . " / MySQL " . Db::selectOne('SELECT VERSION() v')->v . "\n";
echo "迁移文件 " . count($files) . " 个\n\n";

$fail = 0;
foreach ($files as $file) {
    $name = basename($file);
    $migration = require $file;
    if (! is_object($migration) || ! method_exists($migration, 'up')) {
        echo "  ✗ $name  不是合法迁移（没有 up()）\n";
        $fail++;
        continue;
    }
    try {
        $migration->up();
        echo "  ✓ up()   $name\n";
    } catch (Throwable $e) {
        printf("  ✗ up()   %s\n      %s: %s\n", $name, get_class($e), $e->getMessage());
        $fail++;
    }
}

echo "\n── 建表结果 ──\n";
$tables = Db::select('SHOW TABLES');
foreach ($tables as $t) {
    $tn = array_values((array) $t)[0];
    $cols = Db::select("SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [$tn]);
    $idx = Db::select("SELECT COUNT(DISTINCT INDEX_NAME) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [$tn]);
    $ck = Db::select("SELECT COUNT(*) c FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK'", [$tn]);
    $fk = Db::select("SELECT COUNT(*) c FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='FOREIGN KEY'", [$tn]);
    printf(
        "  %-30s %2d 列  %2d 索引  %2d CHECK  %d FK\n",
        $tn,
        $cols[0]->c,
        $idx[0]->c,
        $ck[0]->c,
        $fk[0]->c
    );
}

echo "\n── 预置模板 ──\n";
$rows = Db::select('SELECT id, name, policy_type, is_preset, remark IS NULL AS remark_null FROM alarm_condition_template ORDER BY id');
foreach ($rows as $r) {
    printf("  #%d %-16s policy_type=%d is_preset=%d\n", $r->id, $r->name, $r->policy_type, $r->is_preset);
}
printf("  共 %d 条（契约要求 7 条）\n", count($rows));

echo "\n── 模板 7 的条件 JSON ──\n";
$t7 = Db::select("SELECT conditions FROM alarm_condition_template WHERE name='流量断流'");
if ($t7) {
    echo '  ' . $t7[0]->conditions . "\n";
} else {
    echo "  ✗ 找不到「流量断流」\n";
    $fail++;
}

echo "\n" . ($fail ? "✗ $fail 个迁移失败\n" : "✓ 8 个迁移全部执行成功\n");
exit($fail ? 1 : 0);
