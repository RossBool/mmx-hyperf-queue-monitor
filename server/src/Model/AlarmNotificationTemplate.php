<?php

declare(strict_types=1);

namespace App\Model;

/**
 * 通知模板 alarm_notification_template。channels 为 JSON 数组（契约 §0.6：不接受 null，直传）。
 * 权威配置是本表 channels；alarm_notification_receiver 只是冗余明细，读取一律以 channels 为准（契约 §2.8）。
 */
class AlarmNotificationTemplate extends Model
{
    protected ?string $table = 'alarm_notification_template';

    protected ?string $primaryKey = 'id';

    protected ?string $keyType = 'int';

    protected ?string $connection = 'default';

    public $timestamps = true;

    protected $fillable = [
        'name', 'remark', 'channels', 'is_preset', 'creator_id', 'creator_name',
    ];

    protected $casts = [
        'id' => 'int',
        'is_preset' => 'int',
        'creator_id' => 'int',
        'channels' => 'array',
    ];
}
