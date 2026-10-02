<?php

declare(strict_types=1);

namespace App\Model;

/**
 * 告警策略主表 alarm_policy。
 *
 * ⚠️ JSON 列归一化（契约 §0.6，实现时最容易踩坑的一节）：
 *   - objectIds / objectGroupIds / objectFilters：契约声明为 `int[]|null`，
 *     DB 存 NULL 时**必须输出 null 而不是 []**（R-JSON-1），所以 cast 用 'array' 而非 'json'（'array' 遇 null 返回 null）。
 *   - notificationTemplateIds：契约声明为**非空** int[]，
 *     DB 存 NULL 时**必须补成 []**（R-JSON-2），见 toArray()。
 *   - 写入时 null/[] 一律落 NULL（R-JSON-2 写列），见 normalizeJsonForWrite()，
 *     绝不能把 PHP 的 null 交给 json_encode —— 那会在库里写入字面量 `null`，
 *     破坏 JSON_CONTAINS(notification_template_ids, ...) 的引用检查。
 */
class AlarmPolicy extends Model
{
    protected ?string $table = 'alarm_policy';

    protected ?string $primaryKey = 'id';

    public bool $incrementing = true;

    protected ?string $keyType = 'int';

    protected ?string $connection = 'default';

    public $timestamps = true;

    protected ?string $createdAt = 'created_at';

    protected ?string $updatedAt = 'updated_at';

    protected $fillable = [
        'name', 'remark', 'monitor_type', 'policy_type', 'status', 'level', 'project_id',
        'object_type', 'object_ids', 'object_group_ids', 'object_filters', 'condition_logic',
        'notification_template_ids', 'condition_template_id', 'creator_id', 'creator_name',
    ];

    protected $casts = [
        'id' => 'int',
        'monitor_type' => 'int',
        'policy_type' => 'int',
        'status' => 'int',
        'level' => 'int',
        'project_id' => 'int',
        'object_type' => 'int',
        'condition_logic' => 'int',
        'condition_template_id' => 'int',
        'creator_id' => 'int',
        // 'array'：DB NULL -> null（满足 R-JSON-1）
        'object_ids' => 'array',
        'object_group_ids' => 'array',
        'object_filters' => 'array',
        'notification_template_ids' => 'array',
    ];

    /**
     * 写库前的 JSON 归一化（契约 §0.6 写列）。
     *
     *  - objectIds / objectGroupIds / objectFilters：null 与 [] 都写 NULL
     *  - notificationTemplateIds：null 与 [] 都写 NULL（R-JSON-2）
     *
     * ⚠️ 写成 JSON 字符串 `'null'` 或 `'[]'` 都是错的：前者会让
     *    `JSON_CONTAINS(notification_template_ids, CAST(:tid AS JSON))` 引用检查失效，
     *    后者会与契约声明的「NULL 即未绑定」语义冲突。
     *
     * ⚠️ 本方法是**纯函数**（static），供 Service 直接配合 `Db::table()->insert/update()` 使用。
     *    刻意不走 `fill() + setRawAttributes($attrs, true)`：`setRawAttributes` 的第二参数
     *    会调用 `syncOriginal()` 把 `original` 与 `attributes` 对齐，随后 `Model::save()`
     *    在已存在模型上走 `performUpdate() -> getDirty()`，结果恒为空数组，
     *    **一条 UPDATE 都不会发出**。已用查询构造器显式写入来规避该陷阱。
     *
     * @param array<string, mixed> $row 待写入的行（键为 snake_case 列名）
     * @return array<string, mixed>
     */
    public static function normalizeJsonForWrite(array $row): array
    {
        foreach (self::JSON_COLUMNS as $column) {
            if (! array_key_exists($column, $row)) {
                continue;
            }
            $value = $row[$column];
            $row[$column] = ($value === null || $value === []) ? null : json_encode($value, JSON_UNESCAPED_UNICODE);
        }

        return $row;
    }

    /** 契约 §0.6 涉及的全部 JSON 列 */
    public const JSON_COLUMNS = [
        'object_ids',
        'object_group_ids',
        'object_filters',
        'notification_template_ids',
    ];
}
