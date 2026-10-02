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
    protected string $dateFormat = 'Y-m-d H:i:s';
}
