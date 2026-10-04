<?php

declare(strict_types=1);

use Hyperf\Contract\ApplicationInterface;
use Hyperf\Di\ClassLoader;
use Hyperf\Engine\DefaultOption;

ini_set('display_errors', 'on');
ini_set('display_startup_errors', 'on');

error_reporting(E_ALL);
// 契约 §0.1：服务器时区 Asia/Shanghai，时间串不带时区后缀
date_default_timezone_set('Asia/Shanghai');

! defined('BASE_PATH') && define('BASE_PATH', dirname(__DIR__, 1));

require BASE_PATH . '/vendor/autoload.php';

// ⚠️ 必须加载 .env，否则测试里的 env() 读不到任何配置：
//    DB_* 拿不到 → 连不上库；ALARM_STATIC_TOKENS 拿不到 → 鉴权用例全走 fail-closed 分支，
//    测的就不再是「配对了能不能过」，而是「没配会不会拒」—— 后者已在 AuthMiddlewareTest
//    里用 putenv 单独覆盖，不需要靠 .env。
require BASE_PATH . '/config/bootstrap.php';

! defined('SWOOLE_HOOK_FLAGS') && define('SWOOLE_HOOK_FLAGS', DefaultOption::hookFlags());

ClassLoader::init();

$container = require BASE_PATH . '/config/container.php';

$container->get(ApplicationInterface::class);
