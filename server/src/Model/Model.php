<?php

declare(strict_types=1);

namespace App\Model;

use Hyperf\Database\Model\Model as HyperfModel;

/**
 * 项目内所有 Model 的基类。
 * 时间列统一按契约 §0.1 的 `Y-m-d H:i:s` 输出，由 App\Support\Time 负责。
 */
abstract class Model extends HyperfModel
{
    /**
     * ⚠️ 类型必须与父类 `HasAttributes::$dateFormat` **完全一致**（`?string`）。
     *
     * 写成 `string`（非空）会在**类加载时**直接致命错误：
     *   Type of App\Model\Model::$dateFormat must be ?string
     *   (as in class Hyperf\Database\Model\Model)
     *
     * PHP 禁止子类把父类的可空属性收窄成非空。这条错误发生得太早 ——
     * 任何 autoload 到本类的请求都会崩，且 PHPUnit 会在 bootstrap 阶段就死掉，
     * 表现为「一条测试都没跑」，很容易被误读成环境问题。
     * 只有真正加载这个类才会暴露，静态审查看不出来。
     */
    protected ?string $dateFormat = 'Y-m-d H:i:s';
}
