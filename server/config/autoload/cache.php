<?php

declare(strict_types=1);

use Hyperf\Cache\Driver\RedisDriver;
use Hyperf\Codec\Packer\PhpSerializerPacker;

use function Hyperf\Support\env;

return [
    'default' => env('CACHE_DRIVER', 'default'),
    'stores' => [
        'default' => [
            'driver' => RedisDriver::class,
            'packer' => PhpSerializerPacker::class,
            'prefix' => 'alarm:',
            'skip_cache_results' => [],
            'options' => [
                'pool' => 'default',
            ],
        ],
    ],
];
