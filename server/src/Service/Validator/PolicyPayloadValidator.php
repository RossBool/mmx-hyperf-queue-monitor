<?php

declare(strict_types=1);

namespace App\Service\Validator;

use App\Constants\AlarmEnum;
use App\Model\AlarmNotificationTemplate;
use App\Support\Presenter;
use App\Support\Validator;

/**
 * 策略请求体的**纯校验**部分 —— 契约 §4.1 P12 / P13 / P14 + §4.3 N9。
 *
 * 之所以把这几条从 `AlarmPolicyService` 抽出来：它们是契约里最容易被漏实现、
 * 又最需要独立验证的规则（数量上限、重复、存在性、对象字段一一对应、
 * 「未配置完成」的模板不可绑定）。抽成 public 方法后，
 * 单元测试可以**不打数据库**就覆盖它们。
 *
 * ⚠️ 唯一还依赖数据库的是 `assertNotificationTemplateIds()` 里「id 是否存在」
 * 与 N9 的模板内容读取（契约要求必须查真实模板），该方法在无库环境下
 * 传入空 `$templates` 即可退化为纯结构校验（见方法签名）。
 */
class PolicyPayloadValidator
{
    /** 契约 §1.2 policyType=5「采集静默」 */
    public const POLICY_TYPE_SILENCE = 5;

    /**
     * P12 / P13 / N9：通知模板 id 列表。
     *
     * @param int[] $raw
     * @param array<int, AlarmNotificationTemplate>|null $templates 已按 id 索引的模板表；
     *        传 null 表示「尚未查库」，此时只做结构校验（数量/重复/整数），
     *        存在性与 N9 会被跳过。生产路径由 Service 查库后传入。
     * @return int[] 归一化（去重后）的 id 列表
     */
    public function assertNotificationTemplateIds(mixed $raw, Validator $errors, ?array $templates = null): array
    {
        if ($raw === null) {
            return [];
        }
        if (! is_array($raw)) {
            $errors->add('notificationTemplateIds', '通知模板 id 必须是数组');
            return [];
        }

        $ids = [];
        foreach (array_values($raw) as $i => $id) {
            if (! is_numeric($id)) {
                $errors->add('notificationTemplateIds.' . $i, '通知模板 id 必须是整数');
                continue;
            }
            $id = (int) $id;
            if (in_array($id, $ids, true)) {
                $errors->add('notificationTemplateIds.' . $i, '通知模板 id 不可重复');
                continue;
            }
            $ids[] = $id;
        }

        // P12：每策略最多绑定 3 个
        if (count($ids) > AlarmEnum::NOTIFICATION_TEMPLATE_MAX) {
            $errors->add('notificationTemplateIds', sprintf('每策略最多绑定 %d 个通知模板', AlarmEnum::NOTIFICATION_TEMPLATE_MAX));
        }

        if ($ids === [] || $templates === null) {
            return $ids;
        }

        // P13：id 均须存在
        $existing = array_map(static fn ($k): int => (int) $k, array_keys($templates));
        $missing = array_values(array_diff($ids, $existing));
        if ($missing !== []) {
            $errors->add('notificationTemplateIds', '通知模板不存在：' . implode(',', $missing));
        }

        // N9：凡存在 channel != 5 且该渠道 receivers 为空的模板，视为「未配置完成」，拒绝绑定
        $unconfigured = [];
        foreach ($ids as $id) {
            $template = $templates[$id] ?? null;
            if ($template instanceof AlarmNotificationTemplate && self::isUnconfigured($template)) {
                $unconfigured[] = (string) $template->name;
            }
        }
        if ($unconfigured !== []) {
            $errors->add(
                'notificationTemplateIds',
                '以下通知模板尚未配置接收人，请补充后再绑定：' . implode('、', $unconfigured)
            );
        }

        return $ids;
    }

    /**
     * 查库拿模板（生产路径用）。抽成方法以便 Service 复用。
     *
     * @param int[] $ids
     * @return array<int, AlarmNotificationTemplate>
     */
    public function loadTemplates(array $ids): array
    {
        if ($ids === []) {
            return [];
        }

        $indexed = [];
        foreach (AlarmNotificationTemplate::query()->whereIn('id', $ids)->get() as $template) {
            $indexed[(int) $template->id] = $template;
        }

        return $indexed;
    }

    /**
     * N9：模板中凡存在 `channel != 5` 且该渠道 receivers 为空的，即视为未配置完成。
     */
    public static function isUnconfigured(AlarmNotificationTemplate $template): bool
    {
        foreach (Presenter::normalizeChannels($template->channels) as $channel) {
            if ($channel['channel'] === AlarmEnum::CHANNEL_CALLBACK) {
                continue;   // 回调渠道没有接收人，不参与「配置完成度」判定
            }
            if ($channel['receivers'] === []) {
                return true;
            }
        }

        return false;
    }

    /**
     * P14：objectType 与 objectIds / objectGroupIds / objectFilters 三者一一对应，
     *      其余必须为 null / []（契约 §1.7）。**纯逻辑，不查库。**
     *
     * @param array<string, mixed> $payload
     * @return array{object_ids: ?array, object_group_ids: ?array, object_filters: ?array}
     */
    /**
     * v1.1 无数据检测（F 类）字段校验 —— 契约 §1.2.1 / §2.3。
     *
     * 与 `assertObjectBinding` 同样的思路：**双向校验**。
     * 既要求 policyType=5 时必须给，也要求非 5 时必须不给 ——
     * 只做前者的话，policyType=2 的策略里会残留一段没人读的 targetType 数据，
     * 半年后有人看到就开始猜「这个值到底起没起作用」。
     *
     * @return array{target_type: ?int, target_freshness_minutes: ?int}
     */
    public function assertSilenceTarget(array $payload, int $policyType, Validator $errors): array
    {
        $rawType = $payload['targetType'] ?? null;
        $rawMinutes = $payload['targetFreshnessMinutes'] ?? null;
        $type = ($rawType === null || $rawType === '') ? null : (int) $rawType;
        $minutes = ($rawMinutes === null || $rawMinutes === '') ? null : (int) $rawMinutes;

        if ($policyType !== self::POLICY_TYPE_SILENCE) {
            if ($type !== null) {
                $errors->add('targetType', '只有 policyType=5（采集静默）才能设置 targetType');
            }
            if ($minutes !== null) {
                $errors->add('targetFreshnessMinutes', '只有 policyType=5（采集静默）才能设置 targetFreshnessMinutes');
            }
            return ['target_type' => null, 'target_freshness_minutes' => null];
        }

        if ($type === null) {
            $errors->add('targetType', '采集静默策略必须指定监控目标类型');
        } elseif (! isset(\App\Constants\AlarmEnum::TARGET_TYPE[$type])) {
            $errors->add('targetType', '监控目标类型必须是 1/2/3/4 之一');
        }

        if ($minutes === null) {
            $errors->add('targetFreshnessMinutes', '采集静默策略必须指定静默时长（分钟）');
        } elseif ($minutes < \App\Constants\AlarmEnum::FRESHNESS_MIN_MINUTES
            || $minutes > \App\Constants\AlarmEnum::FRESHNESS_MAX_MINUTES) {
            $errors->add(
                'targetFreshnessMinutes',
                sprintf(
                    '静默时长必须是 %d-%d 分钟的整数',
                    \App\Constants\AlarmEnum::FRESHNESS_MIN_MINUTES,
                    \App\Constants\AlarmEnum::FRESHNESS_MAX_MINUTES
                )
            );
        }

        return [
            'target_type' => isset(\App\Constants\AlarmEnum::TARGET_TYPE[$type ?? 0]) ? $type : null,
            'target_freshness_minutes' => $minutes,
        ];
    }

    public function assertObjectBinding(array $payload, int $objectType, Validator $errors): array
    {
        $objectIds = self::intListOrNull($payload['objectIds'] ?? null);
        $groupIds = self::intListOrNull($payload['objectGroupIds'] ?? null);
        $filters = self::filterListOrNull($payload['objectFilters'] ?? null);

        if ($objectType === 2) {
            if ($objectIds === null || $objectIds === []) {
                $errors->add('objectIds', '告警对象类型为「指定实例」时，objectIds 必须为 1-1000 个');
            } elseif (count($objectIds) > AlarmEnum::OBJECT_IDS_MAX) {
                $errors->add('objectIds', sprintf('objectIds 最多 %d 个', AlarmEnum::OBJECT_IDS_MAX));
            }
            $this->assertEmpty($groupIds, 'objectGroupIds', $errors);
            $this->assertEmpty($filters, 'objectFilters', $errors);
        }

        if ($objectType === 3) {
            if ($groupIds === null || $groupIds === []) {
                $errors->add('objectGroupIds', '告警对象类型为「实例分组」时，objectGroupIds 必须为 1-100 个');
            } elseif (count($groupIds) > AlarmEnum::OBJECT_GROUP_IDS_MAX) {
                $errors->add('objectGroupIds', sprintf('objectGroupIds 最多 %d 个', AlarmEnum::OBJECT_GROUP_IDS_MAX));
            }
            $this->assertEmpty($objectIds, 'objectIds', $errors);
            $this->assertEmpty($filters, 'objectFilters', $errors);
        }

        if ($objectType === 4) {
            if ($filters === null || $filters === []) {
                $errors->add('objectFilters', '告警对象类型为「多维筛选」时，objectFilters 必须为 1-10 条');
            } elseif (count($filters) > AlarmEnum::OBJECT_FILTERS_MAX) {
                $errors->add('objectFilters', sprintf('objectFilters 最多 %d 条', AlarmEnum::OBJECT_FILTERS_MAX));
            } else {
                $this->assertObjectFilters($filters, $errors);
            }
            $this->assertEmpty($objectIds, 'objectIds', $errors);
            $this->assertEmpty($groupIds, 'objectGroupIds', $errors);
        }

        if ($objectType === 1) {
            // objectType=1（全部对象）：三个字段**都**必须为 null / []
            $this->assertEmpty($objectIds, 'objectIds', $errors);
            $this->assertEmpty($groupIds, 'objectGroupIds', $errors);
            $this->assertEmpty($filters, 'objectFilters', $errors);
        }

        return [
            // R-JSON-1 写列：null 与 [] 一律落 SQL NULL
            'object_ids' => ($objectIds === null || $objectIds === []) ? null : $objectIds,
            'object_group_ids' => ($groupIds === null || $groupIds === []) ? null : $groupIds,
            'object_filters' => ($filters === null || $filters === []) ? null : $filters,
        ];
    }

    /** objectFilters[] 元素结构（契约 §1.7）：key / operator / values[] / matchType */
    private function assertObjectFilters(array $filters, Validator $errors): void
    {
        foreach (array_values($filters) as $i => $filter) {
            $path = 'objectFilters.' . $i;
            $filter = (array) $filter;

            $key = $filter['key'] ?? null;
            if (! is_string($key) || trim($key) === '') {
                $errors->add($path . '.key', '维度名必须提供');
            }

            // operator 是字符串枚举（§1.5 六种），不能用数值枚举的判定方式
            $operator = $filter['operator'] ?? null;
            if (! is_string($operator) || ! in_array($operator, AlarmEnum::OPERATOR, true)) {
                $errors->add($path . '.operator', '比较关系必须是 > >= < <= == != 之一');
            }

            $values = $filter['values'] ?? null;
            if (! is_array($values) || $values === []) {
                $errors->add($path . '.values', '候选值必须为 1-200 个');
            } elseif (count($values) > AlarmEnum::OBJECT_FILTER_VALUES_MAX) {
                $errors->add($path . '.values', sprintf('候选值最多 %d 个', AlarmEnum::OBJECT_FILTER_VALUES_MAX));
            }

            $matchType = $filter['matchType'] ?? 'include';
            if (! in_array($matchType, AlarmEnum::FILTER_MATCH_TYPE, true)) {
                $errors->add($path . '.matchType', '匹配方式必须是 include / exclude 之一');
            }
        }
    }

    private function assertEmpty(?array $value, string $field, Validator $errors): void
    {
        if ($value !== null && $value !== []) {
            $errors->add($field, sprintf('%s 与当前 objectType 不匹配，必须为 null 或空数组', $field));
        }
    }

    private static function intListOrNull(mixed $value): ?array
    {
        if ($value === null || ! is_array($value)) {
            return null;
        }
        $result = [];
        foreach ($value as $item) {
            if (is_numeric($item)) {
                $result[] = (int) $item;
            }
        }

        return $result;
    }

    private static function filterListOrNull(mixed $value): ?array
    {
        if ($value === null || ! is_array($value)) {
            return null;
        }
        $result = [];
        foreach ($value as $filter) {
            $filter = (array) $filter;
            $result[] = [
                'key' => (string) ($filter['key'] ?? ''),
                'operator' => (string) ($filter['operator'] ?? ''),
                'values' => array_map('strval', (array) ($filter['values'] ?? [])),
                'matchType' => (string) ($filter['matchType'] ?? 'include'),
            ];
        }

        return $result;
    }
}
