<?php

declare(strict_types=1);

use function Hyperf\Support\env;

return [
    'default' => [
        'driver' => env('DB_DRIVER', 'mysql'),
        'host' => env('DB_HOST', '127.0.0.1'),
        'port' => (int) env('DB_PORT', 3306),
        'database' => env('DB_DATABASE', 'alarm'),
        'username' => env('DB_USERNAME', 'root'),
        'password' => (string) env('DB_PASSWORD', ''),
        // 必须与 schema.sql 的表定义保持一致，否则 CHECK 中文字面量比较行为会不一致
        'charset' => env('DB_CHARSET', 'utf8mb4'),
        'collation' => env('DB_COLLATION', 'utf8mb4_0900_ai_ci'),
        'prefix' => (string) env('DB_PREFIX', ''),
        'pool' => [
            'min_connections' => (int) env('DB_POOL_MIN', 1),
            'max_connections' => (int) env('DB_POOL_MAX', 10),
            'connect_timeout' => 10.0,
            'wait_timeout' => 3.0,
            'heartbeat' => -1,
            'max_idle_time' => (float) env('DB_MAX_IDLE_TIME', 60),
        ],
        // 迁移记录表名，Hyperf 3.2 读取 databases.default.migrations
        'migrations' => 'migrations',
        'commands' => [
            'gen:model' => [
                'path' => 'src/Model',
                'force_casts' => true,
                'inheritance' => 'App\Model\Model',
            ],
        ],
    ],
    'migrations' => [
        'table' => 'migrations',
        'paths' => [BASE_PATH . '/migrations'],
    ],
];
