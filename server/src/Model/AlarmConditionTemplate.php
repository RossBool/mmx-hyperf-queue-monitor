<?php

declare(strict_types=1);

namespace App\Model;

/**
 * 触发条件模板 alarm_condition_template。conditions 为 JSON 数组（契约 §0.6：不接受 null，直传）。
 */
class AlarmConditionTemplate extends Model
{
    protected ?string $table = 'alarm_condition_template';

    protected string $primaryKey = 'id';

    protected string $keyType = 'int';

    protected ?string $connection = 'default';

    public bool $timestamps = true;

    protected array $fillable = [
        'name', 'remark', 'policy_type', 'conditions', 'is_preset', 'creator_id', 'creator_name',
    ];

    protected array $casts = [
        'id' => 'int',
        'policy_type' => 'int',
        'is_preset' => 'int',
        'creator_id' => 'int',
        'conditions' => 'array',
    ];
}
