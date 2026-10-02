<?php

declare(strict_types=1);

/**
 * DI 依赖的惰性闭包。
 *
 * Hyperf 3.2 的 `config/container.php` 只需要 `new Container(...)`，
 * 本文件把「容器实例的构建过程」独立出来，使 config/container.php 与本文件共用同一份逻辑，
 * 避免容器装配代码出现两份。
 */

use Hyperf\Di\Container;
use Hyperf\Di\Definition\DefinitionSourceFactory;
use Psr\Container\ContainerInterface;

return function (): ContainerInterface {
    return new Container((new DefinitionSourceFactory())());
};
