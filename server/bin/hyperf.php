#!/usr/bin/env php
<?php

declare(strict_types=1);
/**
 * Hyperf 3.2 服务启动入口（Swoole Server）。
 *
 * 这是本项目**唯一**提供 HTTP 服务的入口：
 *   php bin/hyperf.php start
 * public/index.php 不是服务入口，仅用于容器引导（见该文件内注释）。
 */
use Hyperf\Contract\ApplicationInterface;
use Hyperf\Di\ClassLoader;
use Hyperf\Engine\DefaultOption;
use Psr\Container\ContainerInterface;

ini_set('display_errors', 'on');
ini_set('display_startup_errors', 'on');
ini_set('memory_limit', '1G');

error_reporting(E_ALL);

// 契约 §0.1：服务器时区 Asia/Shanghai，时间串不带时区后缀。
// 必须在任何 date()/Carbon 调用之前设置，否则容器默认 UTC 会让所有时间戳偏移 8 小时。
date_default_timezone_set('Asia/Shanghai');

! defined('BASE_PATH') && define('BASE_PATH', dirname(__DIR__, 1));

require BASE_PATH . '/vendor/autoload.php';

! defined('SWOOLE_HOOK_FLAGS') && define('SWOOLE_HOOK_FLAGS', DefaultOption::hookFlags());

(function () {
    ClassLoader::init();
    /** @var ContainerInterface $container */
    $container = require BASE_PATH . '/config/container.php';

    $application = $container->get(ApplicationInterface::class);
    $application->run();
})();
