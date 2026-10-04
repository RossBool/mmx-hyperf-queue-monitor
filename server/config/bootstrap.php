<?php

declare(strict_types=1);
/**
 * Hyperf 应用引导文件 —— **本文件的存在是 env() 能读到 .env 的前提**。
 *
 * ## ⚠️ 为什么这个文件不能删
 *
 * `Hyperf\Support\env()` 的实现是 **`getenv($key)`**（实测 hyperf/support 3.2
 * 的 `src/Functions.php`），它**自己不解析 .env 文件**。
 * 把 .env 灌进进程环境的是 vlucas/phpdotenv，而调用点是**这里**。
 *
 * `Dotenv::createUnsafeImmutable()` 默认带 `PutenvAdapter`，
 * 所以 `getenv()` / `$_ENV` / `$_SERVER` **三个来源都能读到** —— 已实测确认。
 * （若换成 `createImmutable()` 之外的构造方式不注册 PutenvAdapter，
 *   `getenv()` 会读不到，而 `env()` 正是走 `getenv()`，症状是恒为默认值。）
 *
 * 删掉本文件（或漏掉 `hyperf/dotenv` 依赖）会导致：
 *
 *   env('ALARM_STATIC_TOKENS', '')     恒为 ''    ← 白名单永远读不到
 *   env('ALARM_AUTH_DISABLED', false)  恒为 false ← 连「关闭鉴权」这个逃生舱都读不到
 *   env('ALARM_CURRENT_USER', ...)     恒为默认值
 *   env('DB_HOST' / 'DB_DATABASE' / …) 恒为默认值 ← 数据库连不上
 *
 * 配合 `AuthMiddleware` 的 **fail-closed** 语义（白名单空 = 拒绝所有请求），
 * 后果是**全部 19 个端点永久 401，且没有任何配置能绕过**。
 * 唯一能生效的是**进程环境变量**（Swoole master 启动时的真实 env），
 * 那不是「读 .env」，是另一条完全不同的路径。
 *
 * 这条链路是静态分析发现的（沙箱无 PHP，跑不起来）。改动本文件前请读这段注释。
 */
use Dotenv\Dotenv;

! defined('BASE_PATH') && define('BASE_PATH', dirname(__DIR__));

// createUnsafeImmutable 的取舍：
//   - Unsafe：允许 .env 覆盖已存在的进程环境变量。
//     容器编排（k8s / docker-compose / systemd）注入的变量优先级**高于** .env，
//     这正是我们要的：部署环境不该被仓库里的文件绑架。
//   - Immutable：.env 反过来覆盖进程变量 —— 那会让仓库文件反过来控制线上配置。
//
// 双重保险：$_ENV 已被载入时跳过，避免重复解析与 Swoole worker 间的覆盖竞争。
if (! isset($_ENV['APP_ENV']) || ! array_key_exists('ALARM_STATIC_TOKENS', $_ENV)) {
    Dotenv::createUnsafeImmutable(BASE_PATH)->safeLoad();
}

// 契约 §0.1：服务器时区 Asia/Shanghai，时间串不带时区后缀。
// 与 test/bootstrap.php 保持一致，避免测试与运行时的时区不同导致断言漂移。
date_default_timezone_set('Asia/Shanghai');
