<?php

declare(strict_types=1);
/**
 * 运行期验证：把沙箱里静态审查看不到的那几条真的跑一遍。
 *
 * 覆盖：
 *   1. 29 条 CHECK 约束**真的在执行**（8.0.16 以下是静默失效的，这是选型的硬前提）
 *   2. 字典 38 条 + namespace 分布
 *   3. env() 链路（bootstrap → getenv）
 *   4. 409 六个语义分支的文案互不塌缩
 *   5. 契约 §0.6 JSON 空值归一化
 */
require __DIR__ . '/test/bootstrap.php';

use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use Hyperf\DbConnection\Db;

$container = \Hyperf\Context\ApplicationContext::getContainer();
// 容器里没有 DatabaseInterface 这个绑定，用 Db:: 静态门面（Feature 测试同一条路）。


$pass = 0;
$fail = 0;
function check(string $label, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    $ok ? $pass++ : $fail++;
    printf("  %s %-52s %s\n", $ok ? '✓' : '✗', $label, $detail);
}

echo "PHP " . PHP_VERSION . "  /  MySQL " . Db::selectOne('SELECT VERSION() v')->v . "\n\n";

// ── 1. CHECK 约束真的在执行吗 ────────────────────────────────────────
echo "【1】CHECK 约束执行性（MySQL < 8.0.16 会静默忽略，这是选型硬前提）\n";
Db::statement('SET FOREIGN_KEY_CHECKS = 0');
Db::statement('DROP TABLE IF EXISTS probe_check');
Db::statement('CREATE TABLE probe_check (id INT PRIMARY KEY, n INT, CONSTRAINT ck_probe CHECK (n BETWEEN 1 AND 10))');
Db::statement('INSERT INTO probe_check (id, n) VALUES (1, 5)');
try {
    Db::statement('INSERT INTO probe_check (id, n) VALUES (2, 999)');
    check('越界值被 CHECK 拒绝', false, '插进去了 → CHECK 没生效');
} catch (Throwable $e) {
    check('越界值被 CHECK 拒绝', true, get_class($e));
}
Db::statement('DROP TABLE probe_check');
Db::statement('SET FOREIGN_KEY_CHECKS = 1');
echo "\n";

// ── 2. 指标字典 ──────────────────────────────────────────────────────
echo "【2】指标字典\n";
$dict = (new \App\Service\Metric\MetricDictionary($container->get(\Hyperf\Contract\ConfigInterface::class)))->all();
$byNs = [];
foreach ($dict as $m) {
    $byNs[$m['namespace']] = ($byNs[$m['namespace']] ?? 0) + 1;
}
check('字典共 38 条', count($dict) === 38, '实际 ' . count($dict));
check('CVM 15 / WEB 9 / CLB 5 / MYSQL 9', $byNs === ['CVM' => 15, 'WEB' => 9, 'CLB' => 5, 'MYSQL' => 9], json_encode($byNs));
$keys = array_map(static fn ($m) => $m['namespace'] . '.' . $m['metricName'], $dict);
check('唯一键无重复', count($keys) === count(array_unique($keys)));
$bad = [];
foreach ($dict as $m) {
    if (count($m) !== 10) {
        $bad[] = $m['metricName'] . '=' . count($m);
    }
    if (str_contains((string) $m['description'], '`')) {
        $bad[] = $m['metricName'] . ' description 含反引号';
    }
}
check('每条 10 字段且 description 无反引号', $bad === [], implode(', ', array_slice($bad, 0, 3)));
$dtf = null;
foreach ($dict as $m) {
    if ($m['metricName'] === 'DiskDaysToFull') {
        $dtf = $m;
    }
}
check('DiskDaysToFull 仍是唯一 < 方向的 CVM 指标', $dtf !== null && $dtf['defaultOperator'] === '<' && $dtf['defaultThreshold'] === 7);
echo "\n";

// ── 3. env() 链路 ────────────────────────────────────────────────────
echo "【3】env() 链路（bootstrap → getenv）\n";
check('getenv(DB_DATABASE) 有值', getenv('DB_DATABASE') !== false, (string) getenv('DB_DATABASE'));
check('getenv(ALARM_AUTH_DISABLED) 有值', getenv('ALARM_AUTH_DISABLED') !== false, var_export(getenv('ALARM_AUTH_DISABLED'), true));
echo "\n";

// ── 4. 409 六个语义分支 ──────────────────────────────────────────────
echo "【4】409 语义分支文案互不塌缩\n";
$reasons = ErrorCode::knownReasons();
check('knownReasons() 有 6 个', count($reasons) === 6, implode(',', $reasons));
$msgs = [];
foreach ($reasons as $r) {
    $m = ErrorCode::messageForReason($r);
    $msgs[$r] = $m;
    printf("      %-28s → %s\n", $r, $m);
}
check('6 条文案两两不同', count(array_unique($msgs)) === count($msgs));
check('6 条文案都非空', count(array_filter($msgs, static fn ($x) => trim((string) $x) !== '')) === count($msgs));
check('每个分支的 code 都是 409', count(array_unique(array_map(static fn ($r) => ErrorCode::codeForReason($r), $reasons))) === 1);
echo "\n";

// ── 5. JSON 归一化 ───────────────────────────────────────────────────
echo "【5】契约 §0.6 JSON 空值归一化\n";
$j = \App\Model\AlarmPolicy::normalizeJsonForWrite([
    'object_ids' => [], 'object_group_ids' => null,
    'object_filters' => null, 'notification_template_ids' => [],
]);
$allNull = true;
foreach (['object_ids', 'object_group_ids', 'object_filters', 'notification_template_ids'] as $c) {
    if (! array_key_exists($c, $j) || $j[$c] !== null) {
        $allNull = false;
    }
}
check('空值统一归一化成 SQL NULL（非 \x27[]\x27/\x27null\x27 字符串）', $allNull, json_encode($j));
$k = \App\Model\AlarmPolicy::normalizeJsonForWrite(['object_ids' => [8801, 8802]]);
check('真实数组保持 JSON', $k['object_ids'] === '[8801,8802]', $k['object_ids']);
check('intList 解析 JSON 字符串（曾返回 [0]）', \App\Support\Presenter::intList('[8801,8802]') === [8801, 8802]);
echo "\n";

printf("  ── %d 通过 / %d 失败 ──\n", $pass, $fail);
exit($fail ? 1 : 0);
