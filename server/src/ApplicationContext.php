<?php

declare(strict_types=1);

namespace App;

use Hyperf\Context\ApplicationContext as HyperfApplicationContext;
use Psr\Container\ContainerInterface;

/**
 * 容器访问的薄封装，便于全项目统一从 `App\ApplicationContext` 取容器，
 * 同时保持与 Hyperf 官方 `Hyperf\Context\ApplicationContext` 的行为一致
 * （Hyperf 的类是 `class` 而非 `final class`，可安全继承）。
 */
class ApplicationContext extends HyperfApplicationContext
{
    public static function get(): ContainerInterface
    {
        return static::getContainer();
    }
}
