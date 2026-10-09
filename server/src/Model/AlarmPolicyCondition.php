<?php

declare(strict_types=1);

namespace App\Model;

/**
 * 告警策略触发条件 alarm_policy_condition。
 * created_at / updated_at 是契约 §2.8 声明的「服务端内部列」，不出现在任何 DTO。
 */
class AlarmPolicyCondition extends Model
{
    protected ?string $table = 'alarm_policy_condition';

    protected string $primaryKey = 'id';

    protected string $keyType = 'int';

    protected ?string $connection = 'default';

    public bool $timestamps = true;

    protected array $fillable = [
        'policy_id', 'sort', 'metric_namespace', 'metric_name', 'metric_name_cn',
        'unit', 'operator', 'threshold', 'period', 'continuity', 'level', 'frequency',
        // v1.1 相对判据
        'compare_mode', 'baseline_type', 'baseline_count',
    ];

    protected array $casts = [
        'id' => 'int',
        'policy_id' => 'int',
        'sort' => 'int',
        'period' => 'int',
        'continuity' => 'int',
        'level' => 'int',
        'frequency' => 'int',
        // v1.1：baseline_count 可为 NULL，cast 成 int 后仍为 null
        'baseline_count' => 'int',
        // DECIMAL(20,4) -> float，保证接口输出 number 而非 string（契约 §0.1）
        'threshold' => 'float',
    ];
}
