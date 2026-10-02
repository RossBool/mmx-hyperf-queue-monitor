<?php

declare(strict_types=1);

namespace HyperfTest;

use Hyperf\Testing\TestCase as BaseTestCase;

/**
 * 需要容器的测试基类（仅 Feature 套件使用）。
 *
 * `Hyperf\Testing\TestCase::setUp()` 会 `refreshContainer()` 拉起完整容器，
 * 因此**只有真正需要从容器取 Service 的用例才应该继承它**。
 * 纯逻辑的单元测试（`test/Cases/Unit/`）直接继承 `PHPUnit\Framework\TestCase`，
 * 避免为一个不需要容器的断言付出启动容器的代价与失败面。
 */
abstract class TestCase extends BaseTestCase
{
}
