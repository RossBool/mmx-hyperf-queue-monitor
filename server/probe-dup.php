<?php

declare(strict_types=1);
/** 探针：真实触发一次唯一键冲突，把异常链的结构 dump 出来。 */
require __DIR__ . '/test/bootstrap.php';

use Hyperf\DbConnection\Db;

$name = 'PROBE-DUP-' . bin2hex(random_bytes(4));
$row = [
    'name' => $name, 'remark' => '', 'monitor_type' => 1, 'policy_type' => 2,
    'status' => 0, 'level' => 2, 'project_id' => 1, 'object_type' => 1,
    'object_ids' => null, 'object_group_ids' => null, 'object_filters' => null,
    'condition_logic' => 1, 'notification_template_ids' => null,
    'condition_template_id' => 0, 'creator_id' => 0, 'creator_name' => 'probe',
    'created_at' => date('Y-m-d H:i:s'), 'updated_at' => date('Y-m-d H:i:s'),
];

Db::table('alarm_policy')->insert($row);
echo "  第一次插入成功：{$name}\n\n";

try {
    Db::table('alarm_policy')->insert($row);
    echo "  ✗ 第二次插入竟然成功了\n";
} catch (Throwable $e) {
    echo "  异常链:\n";
    for ($t = $e, $i = 0; $t !== null && $i < 5; $t = $t->getPrevious(), $i++) {
        printf(
            "    #%d %s\n        getCode() = %s\n        errorInfo  = %s\n        message    = %s\n",
            $i,
            get_class($t),
            var_export($t->getCode(), true),
            property_exists($t, 'errorInfo') ? json_encode($t->errorInfo) : '(无该属性)',
            substr($t->getMessage(), 0, 90),
        );
    }

    // 用生产代码的同一套判据验证
    $handler = (new ReflectionClass(\App\Exception\Handler\AlarmExceptionHandler::class))
        ->newInstanceWithoutConstructor();
    $m = new ReflectionMethod($handler, 'driverErrorCodes');
    $r = $m->invoke($handler, $e);
    printf("\n  driverErrorCodes() 返回: %s\n", json_encode($r));
    $m2 = new ReflectionMethod($handler, 'classifyIntegrityViolation');
    $r2 = $m2->invoke($handler, $e);
    printf("  classifyIntegrityViolation() 返回: %s\n", $r2 === null ? 'null（→ 500）' : json_encode(array_slice($r2, 0, 2), JSON_UNESCAPED_UNICODE));
}

Db::table('alarm_policy')->where('name', $name)->delete();
