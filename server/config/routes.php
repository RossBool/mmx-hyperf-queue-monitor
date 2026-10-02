<?php

declare(strict_types=1);

use App\Controller\Alarm\AlarmConditionTemplateController;
use App\Controller\Alarm\AlarmHistoryController;
use App\Controller\Alarm\AlarmMetricController;
use App\Controller\Alarm\AlarmNotificationTemplateController;
use App\Controller\Alarm\AlarmOverviewController;
use App\Controller\Alarm\AlarmPolicyController;
use Hyperf\HttpServer\Router\Router;

// 契约 §0.1：Base URL = /api/alarm
//
// ⚠️ `prefix` 是 addGroup() 的**第一个位置参数**，不是 options 里的一个键。
//    官方签名（hyperf/http-server v3.2.0 dist 包逐文件核对）：
//      RouteCollector::addGroup(string $prefix, callable $callback, array $options = []): void
//      —— src/Router/RouteCollector.php:60
//    `Router::addGroup()` 本身只是 `__callStatic` 转发（src/Router/Router.php:32-36）：
//        return $router->{$name}(...$arguments);
//    曾经误写成 `Router::addGroup(['prefix' => '/api/alarm'], function () {})`，
//    把数组塞进第 1 个参数。Router.php 与本文件都是 declare(strict_types=1)，
//    且**数组在任何情况下都不可强制转换为 string**（非弱标量转换），
//    因此启动时立刻抛
//      TypeError: Argument #1 ($prefix) must be of type string, array given
//    ——19 个端点一个都注册不上，服务直接起不来。
//    需要给分组附加选项时用第三个参数 `['middleware' => [...]]` 这类键，prefix 不在其中。
Router::addGroup('/api/alarm', function (): void {
    // ①-⑦ 策略
    Router::get('/policies', [AlarmPolicyController::class, 'index']);
    Router::post('/policies', [AlarmPolicyController::class, 'store']);
    Router::put('/policies/{id}', [AlarmPolicyController::class, 'update']);
    Router::delete('/policies/{id}', [AlarmPolicyController::class, 'destroy']);
    Router::get('/policies/{id}', [AlarmPolicyController::class, 'show']);
    Router::post('/policies/{id}/status', [AlarmPolicyController::class, 'changeStatus']);
    Router::post('/policies/{id}/copy', [AlarmPolicyController::class, 'copy']);

    // ⑧ 指标字典
    Router::get('/metrics', [AlarmMetricController::class, 'index']);

    // ⑨-⑫ 触发条件模板
    Router::get('/condition-templates', [AlarmConditionTemplateController::class, 'index']);
    Router::post('/condition-templates', [AlarmConditionTemplateController::class, 'store']);
    Router::put('/condition-templates/{id}', [AlarmConditionTemplateController::class, 'update']);
    Router::delete('/condition-templates/{id}', [AlarmConditionTemplateController::class, 'destroy']);

    // ⑬-⑯ 通知模板
    Router::get('/notification-templates', [AlarmNotificationTemplateController::class, 'index']);
    Router::post('/notification-templates', [AlarmNotificationTemplateController::class, 'store']);
    Router::put('/notification-templates/{id}', [AlarmNotificationTemplateController::class, 'update']);
    Router::delete('/notification-templates/{id}', [AlarmNotificationTemplateController::class, 'destroy']);

    // ⑰-⑲ 告警历史与统计
    Router::get('/histories', [AlarmHistoryController::class, 'index']);
    Router::post('/histories/{id}/handle', [AlarmHistoryController::class, 'handle']);
    Router::get('/overview', [AlarmOverviewController::class, 'index']);
});

Router::get('/favicon.ico', static fn (): string => '');
