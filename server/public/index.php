<?php

declare(strict_types=1);
/**
 * 容器引导脚本。
 *
 * ⚠️ 本文件**不是** HTTP 服务入口。Hyperf 3.2 抛弃了 Hyperf 2.x 的 FPM/RoadRunner 形态，
 * 只支持 Swoole Server，对外 HTTP 由 `php bin/hyperf.php start` 提供的 `Hyperf\HttpServer\Server` 处理。
 *
 * 保留本文件的用途：
 *   1. CLI 工具/IDE/静态分析可 `require` 它来拿到已初始化的容器（等价于 test/bootstrap.php）；
 *   2. 若把 Swoole 的静态资源根指向 public/，可用于放 favicon 等前端产物。
 *
 * 用法：php public/index.php  -> 打印容器内绑定的关键服务，验证引导链路是否正常。
 */
use Hyperf\Contract\ApplicationInterface;
use Hyperf\Di\ClassLoader;
use Hyperf\Engine\DefaultOption;
use Psr\Container\ContainerInterface;

ini_set('display_errors', 'on');
error_reporting(E_ALL);

// 契约 §0.1：服务器时区 Asia/Shanghai，时间串不带时区后缀。
// 必须在任何 date()/Carbon 调用之前设置，否则容器默认 UTC 会让所有时间戳偏移 8 小时。
date_default_timezone_set('Asia/Shanghai');

! defined('BASE_PATH') && define('BASE_PATH', dirname(__DIR__, 1));

require BASE_PATH . '/vendor/autoload.php';

! defined('SWOOLE_HOOK_FLAGS') && define('SWOOLE_HOOK_FLAGS', DefaultOption::hookFlags());

ClassLoader::init();

/** @var ContainerInterface $container */
$container = require BASE_PATH . '/config/container.php';

if (PHP_SAPI === 'cli') {
    $container->get(ApplicationInterface::class);
    echo 'container bootstrapped: ', get_class($container), PHP_EOL;
    exit(0);
}

echo 'alarm-server: HTTP 由 `php bin/hyperf.php start` 提供，本文件不处理请求。', PHP_EOL;
