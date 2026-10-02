<?php

declare(strict_types=1);

namespace App\Constants;

/**
 * 12 组枚举 —— 契约 §1 的唯一代码化实现。
 * ⚠️ 禁止在业务代码里另立一套（domain.md §1 第 7 条）。
 */
final class AlarmEnum
{
    /** §1.1 monitorType：1 云产品监控 2 应用性能监控 3 前端性能监控 4 云拨测 5 终端性能监控 */
    public const MONITOR_TYPE = [1 => '云产品监控', 2 => '应用性能监控', 3 => '前端性能监控', 4 => '云拨测', 5 => '终端性能监控'];

    /**
     * §1.1 联动规则：monitorType -> 允许的 policyType。
     * 3/4/5 在 v1.0 暂无策略类型（选了返回 422）。
     */
    public const MONITOR_TYPE_POLICY_TYPES = [
        1 => [2, 3, 4],
        2 => [1],
        3 => [],
        4 => [],
        5 => [],
    ];

    /** §1.2 policyType：1 通用 Web 2 CVM 3 CLB 4 MySQL */
    public const POLICY_TYPE = [1 => '通用 Web 服务', 2 => '云服务器 CVM', 3 => '负载均衡 CLB', 4 => '云数据库 MySQL'];

    /** §1.2 / metrics.md §0.2：policyType -> 唯一 namespace */
    public const POLICY_TYPE_NAMESPACE = [1 => 'WEB', 2 => 'CVM', 3 => 'CLB', 4 => 'MYSQL'];

    /** §1.3 level：1 紧急 2 严重 3 提示（数值越小越严重） */
    public const LEVEL = [1 => '紧急', 2 => '严重', 3 => '提示'];

    /** §1.4 period（分钟） */
    public const PERIOD = [1, 5, 10, 30, 60];

    /** §1.5 operator（原样存取，禁本地化） */
    public const OPERATOR = ['>', '>=', '<', '<=', '==', '!='];

    /** §1.6 frequency（分钟）；0=不重复 是本模块的扩展值 */
    public const FREQUENCY = [0, 5, 15, 30, 60, 180, 360, 720, 1440];

    /** §1.7 objectType */
    public const OBJECT_TYPE = [1 => '全部对象', 2 => '指定实例', 3 => '实例分组', 4 => '多维筛选'];

    /** §1.7 多维筛选 operator 复用 §1.5 六种取值 */
    public const FILTER_MATCH_TYPE = ['include', 'exclude'];

    /** §1.8 conditionLogic：1 满足所有(AND) 2 满足任意(OR) */
    public const CONDITION_LOGIC = [1 => '满足所有条件', 2 => '满足任意条件'];

    /** §1.9 status：0 停用 1 启用 */
    public const STATUS = [0 => '停用', 1 => '启用'];

    /** §1.10 historyStatus（DB 列名 status） */
    public const HISTORY_STATUS = [1 => '未处理', 2 => '已处理', 3 => '已忽略', 4 => '已恢复'];

    /** §1.10 唯一允许人工处理的状态（H3） */
    public const HISTORY_STATUS_UNHANDLED = 1;

    /** §1.11 notifyChannel（DB 列名 channel） */
    public const NOTIFY_CHANNEL = [1 => '邮件', 2 => '短信', 3 => '微信', 4 => '电话', 5 => '回调'];

    /** §1.11 channel=5 回调：receivers 必须为空、callbackUrl 必填 */
    public const CHANNEL_CALLBACK = 5;

    /** §1.12 handleAction -> 落库后的 historyStatus */
    public const HANDLE_ACTION = [
        'handle' => 2,
        'ignore' => 3,
        'recover' => 4,
    ];

    /** §2.1 conditions 每条策略 1-4 条 */
    public const CONDITION_MIN = 1;
    public const CONDITION_MAX = 4;

    /** P7 continuity ∈ [1, 10] */
    public const CONTINUITY_MIN = 1;
    public const CONTINUITY_MAX = 10;

    /** P12 每策略最多 3 个通知模板 */
    public const NOTIFICATION_TEMPLATE_MAX = 3;

    /** N2 channels 1-5 条 */
    public const CHANNEL_MIN = 1;
    public const CHANNEL_MAX = 5;

    /** N5 / §2.5 receivers 0-100 个（预置模板允许空数组） */
    public const RECEIVER_MIN = 0;
    public const RECEIVER_MAX = 100;

    /**
     * `alarm_notification_receiver.contact` 是 VARCHAR(255)（schema.sql §5）。
     * 接收人与回调地址都会原样落到该列。
     */
    public const RECEIVER_CONTACT_MAX = 255;

    /** N3：callbackUrl 最长 500 字符（契约 §2.5 字段表同样写 <=500） */
    public const CALLBACK_URL_MAX = 500;

    /** N6 silenceTime ∈ [0, 1440] */
    public const SILENCE_TIME_MIN = 0;
    public const SILENCE_TIME_MAX = 1440;

    /** §1.7 objectType=2/3/4 的数量上下限 */
    public const OBJECT_IDS_MAX = 1000;
    public const OBJECT_GROUP_IDS_MAX = 100;
    public const OBJECT_FILTERS_MAX = 10;
    public const OBJECT_FILTER_VALUES_MAX = 200;

    /** §0.3 分页 */
    public const PAGE_DEFAULT = 1;
    public const PAGE_SIZE_DEFAULT = 20;
    public const PAGE_SIZE_MIN = 1;
    public const PAGE_SIZE_MAX = 100;

    /** P1 / T1 / N1 名称长度 */
    public const POLICY_NAME_MAX = 128;
    public const TEMPLATE_NAME_MAX = 64;

    /** P2 / H2 / T1 备注长度 */
    public const REMARK_MAX = 500;

    /** P6 threshold 最多 4 位小数 */
    public const THRESHOLD_SCALE = 4;

    public static function inArray(int|string|null $value, array $allowed): bool
    {
        if ($value === null || $value === '') {
            return false;
        }
        if (is_int($value)) {
            return in_array($value, $allowed, true);
        }
        return in_array($value, $allowed, true);
    }

    /** 取中文名，未知值原样返回 */
    public static function label(array $map, int|string|null $value): string
    {
        if ($value === null) {
            return '';
        }
        return $map[$value] ?? (string) $value;
    }
}
