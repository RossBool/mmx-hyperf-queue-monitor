<?php

declare(strict_types=1);

namespace App\Model;

/**
 * 告警历史 alarm_history（只增不改状态；无外键；永不删除）。
 * threshold / actual_value 为 DECIMAL(20,4)，序列化为 number（契约 §0.1）。
 */
class AlarmHistory extends Model
{
    protected ?string $table = 'alarm_history';

    protected ?string $primaryKey = 'id';

    protected ?string $keyType = 'int';

    protected ?string $connection = 'default';

    public $timestamps = true;

    protected $fillable = [
        'policy_id', 'policy_name', 'level', 'status', 'condition_id',
        'metric_namespace', 'metric_name', 'metric_name_cn', 'unit', 'operator',
        'threshold', 'actual_value', 'period', 'continuity', 'object_type', 'object_id',
        'object_name', 'content', 'triggered_at', 'duration', 'recovered_at',
        'handled_at', 'handle_action', 'handler_name', 'handle_remark', 'notify_count',
    ];

    protected $casts = [
        'id' => 'int',
        'policy_id' => 'int',
        'level' => 'int',
        'status' => 'int',
        'condition_id' => 'int',
        'threshold' => 'float',
        'actual_value' => 'float',
        'period' => 'int',
        'continuity' => 'int',
        'object_type' => 'int',
        'object_id' => 'int',
        'duration' => 'int',
        'notify_count' => 'int',
        'triggered_at' => 'datetime',
        'recovered_at' => 'datetime',
        'handled_at' => 'datetime',
        'created_at' => 'datetime',
        'updated_at' => 'datetime',
    ];
}
