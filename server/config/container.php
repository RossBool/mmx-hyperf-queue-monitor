<?php

declare(strict_types=1);

/**
 * 初始化 PSR-11 容器并返回。容器构建逻辑统一放在 deps.php。
 */
use Psr\Container\ContainerInterface;

/** @var callable(): ContainerInterface $factory */
$factory = require BASE_PATH . '/deps.php';

return App\ApplicationContext::setContainer($factory());
