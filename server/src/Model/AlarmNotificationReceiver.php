<?php

declare(strict_types=1);

namespace App\Model;

/**
 * 通知接收人明细 alarm_notification_receiver（冗余表，非权威）。
 * template_id / contact 是契约 §2.8 声明的内部列，不出现在任何 DTO。
 */
class AlarmNotificationReceiver extends Model
{
    protected ?string $table = 'alarm_notification_receiver';

    protected ?string $primaryKey = 'id';

    protected ?string $keyType = 'int';

    protected ?string $connection = 'default';

    public $timestamps = true;

    protected $fillable = ['template_id', 'channel', 'contact'];

    protected $casts = [
        'id' => 'int',
        'template_id' => 'int',
        'channel' => 'int',
    ];
}
