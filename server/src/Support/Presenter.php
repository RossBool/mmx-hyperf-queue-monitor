<?php

declare(strict_types=1);

namespace App\Support;

use App\Constants\AlarmEnum;
use App\Model\AlarmConditionTemplate;
use App\Model\AlarmHistory;
use App\Model\AlarmNotificationTemplate;
use App\Model\AlarmPolicy;
use App\Model\AlarmPolicyCondition;

/**
 * DB -> API DTO 映射。**逐字段照抄契约 §2**，字段名不许自创、不许漂移。
 */
class Presenter
{
    /**
     * 策略列表项 —— 契约 §2.2。列表接口**不返回** conditions 明细与 objectIds。
     */
    public static function policyListItem(AlarmPolicy $policy, int $conditionCount): array
    {
        return [
            'id' => $policy->id,
            'name' => $policy->name,
            'remark' => $policy->remark,
            'monitorType' => $policy->monitor_type,
            'monitorTypeCn' => AlarmEnum::label(AlarmEnum::MONITOR_TYPE, $policy->monitor_type),
            'policyType' => $policy->policy_type,
            'policyTypeCn' => AlarmEnum::label(AlarmEnum::POLICY_TYPE, $policy->policy_type),
            'status' => $policy->status,
            'level' => $policy->level,
            'projectId' => $policy->project_id,
            'objectType' => $policy->object_type,
            'conditionCount' => $conditionCount,
            // R-JSON-2：唯一声明为非空 int[] 的 JSON 字段，DB NULL -> []
            'notificationTemplateIds' => self::intList($policy->notification_template_ids),
            'conditionTemplateId' => $policy->condition_template_id,
            'creatorName' => $policy->creator_name,
            'createdAt' => Time::formatOrEmpty($policy->created_at),
            'updatedAt' => Time::formatOrEmpty($policy->updated_at),
        ];
    }

    /**
     * 策略详情 —— 契约 §2.3 = AlarmPolicyListItem + conditions/objectIds/objectGroupIds/
     * objectFilters/conditionLogic/notificationTemplates。
     *
     * @param AlarmPolicyCondition[] $conditions
     * @param array<int, array{id:int,name:string,isPreset:int,channels:int[]}> $notificationTemplates
     */
    public static function policyDetail(
        AlarmPolicy $policy,
        array $conditions,
        int $conditionCount,
        array $notificationTemplates
    ): array {
        return self::policyListItem($policy, $conditionCount) + [
            // R-JSON-1：这三个字段永远输出 null，不是 []
            'objectIds' => self::nullableIntList($policy->object_ids),
            'objectGroupIds' => self::nullableIntList($policy->object_group_ids),
            'objectFilters' => $policy->object_filters === null ? null : array_values($policy->object_filters),
            'conditionLogic' => $policy->condition_logic,
            'conditions' => array_map([self::class, 'condition'], $conditions),
            'notificationTemplates' => $notificationTemplates,
        ];
    }

    /** 触发条件 —— 契约 §2.1。id 仅响应返回。 */
    public static function condition(AlarmPolicyCondition $condition): array
    {
        return [
            'id' => $condition->id,
            'sort' => $condition->sort,
            'metricNamespace' => $condition->metric_namespace,
            'metricName' => $condition->metric_name,
            'metricNameCn' => $condition->metric_name_cn,
            'unit' => $condition->unit,
            'operator' => $condition->operator,
            'threshold' => (float) $condition->threshold,
            'period' => $condition->period,
            'continuity' => $condition->continuity,
            'level' => $condition->level,
            'frequency' => $condition->frequency,
        ];
    }

    /** 条件模板 —— 契约 §2.4 */
    public static function conditionTemplate(AlarmConditionTemplate $template): array
    {
        return [
            'id' => $template->id,
            'name' => $template->name,
            'remark' => $template->remark,
            'policyType' => $template->policy_type,
            'conditions' => self::normalizeConditions($template->conditions),
            'isPreset' => $template->is_preset,
            'creatorName' => $template->creator_name,
            'createdAt' => Time::formatOrEmpty($template->created_at),
            'updatedAt' => Time::formatOrEmpty($template->updated_at),
        ];
    }

    /**
     * 通知模板 —— 契约 §2.5。列表接口返回**完整 channels**（模板管理页需要编辑接收人）。
     */
    public static function notificationTemplate(AlarmNotificationTemplate $template): array
    {
        return [
            'id' => $template->id,
            'name' => $template->name,
            'remark' => $template->remark,
            'channels' => self::normalizeChannels($template->channels),
            'isPreset' => $template->is_preset,
            'creatorName' => $template->creator_name,
            'createdAt' => Time::formatOrEmpty($template->created_at),
            'updatedAt' => Time::formatOrEmpty($template->updated_at),
        ];
    }

    /**
     * 策略详情里的通知模板**摘要** —— 契约 §2.3。
     * channels 只给编码数组，不泄漏接收人明细。
     */
    public static function notificationTemplateSummary(AlarmNotificationTemplate $template): array
    {
        return [
            'id' => $template->id,
            'name' => $template->name,
            'isPreset' => $template->is_preset,
            'channels' => self::channelCodes($template->channels),
        ];
    }

    /** 告警历史 —— 契约 §2.6（逐字段照抄） */
    public static function history(AlarmHistory $history): array
    {
        return [
            'id' => $history->id,
            'policyId' => $history->policy_id,
            'policyName' => $history->policy_name,
            'level' => $history->level,
            'status' => $history->status,
            'conditionId' => $history->condition_id,
            'metricNamespace' => $history->metric_namespace,
            'metricName' => $history->metric_name,
            'metricNameCn' => $history->metric_name_cn,
            'unit' => $history->unit,
            'operator' => $history->operator,
            'threshold' => (float) $history->threshold,
            'actualValue' => $history->actual_value === null ? null : (float) $history->actual_value,
            'period' => $history->period,
            'continuity' => $history->continuity,
            'objectType' => $history->object_type,
            'objectId' => $history->object_id,
            'objectName' => $history->object_name,
            'content' => $history->content,
            'triggeredAt' => Time::formatOrEmpty($history->triggered_at),
            'duration' => $history->duration,
            'recoveredAt' => Time::format($history->recovered_at),
            'handledAt' => Time::format($history->handled_at),
            'handleAction' => $history->handle_action,
            'handlerName' => $history->handler_name,
            'handleRemark' => $history->handle_remark,
            'notifyCount' => $history->notify_count,
            'createdAt' => Time::formatOrEmpty($history->created_at),
        ];
    }

    /** 首页统计 —— 契约 §3.3 ⑲ */
    public static function overview(array $data): array
    {
        return [
            'todayTotal' => (int) $data['todayTotal'],
            'todayUnhandled' => (int) $data['todayUnhandled'],
            'policyTotal' => (int) $data['policyTotal'],
            'policyEnabledTotal' => (int) $data['policyEnabledTotal'],
            'levelDistribution' => $data['levelDistribution'],
            'trend7Days' => $data['trend7Days'],
        ];
    }

    /**
     * 条件数组归一化：模板 conditions 是 JSON 数组（契约 §0.6 直传，不接受 null），
     * 逐条补齐 id=0（模板内的条件没有独立 id）。
     *
     * @return array<int, array<string, mixed>>
     */
    public static function normalizeConditions(mixed $conditions): array
    {
        $result = [];
        foreach ((array) ($conditions ?? []) as $index => $condition) {
            $condition = (array) $condition;
            $condition['id'] = 0;
            $condition['metricNameCn'] = (string) ($condition['metricNameCn'] ?? '');
            $condition['unit'] = (string) ($condition['unit'] ?? '');
            $condition['threshold'] = (float) $condition['threshold'];
            $result[] = $condition;
        }
        usort($result, static fn (array $a, array $b): int => ($a['sort'] ?? 0) <=> ($b['sort'] ?? 0));
        return $result;
    }

    /**
     * 渠道数组归一化（契约 §0.6 直传）。
     *
     * @return array<int, array<string, mixed>>
     */
    public static function normalizeChannels(mixed $channels): array
    {
        $result = [];
        foreach ((array) ($channels ?? []) as $channel) {
            $channel = (array) $channel;
            $channel['channel'] = (int) $channel['channel'];
            $channel['receivers'] = array_values((array) ($channel['receivers'] ?? []));
            $channel['callbackUrl'] = $channel['callbackUrl'] ?? null;
            $channel['silenceTime'] = (int) ($channel['silenceTime'] ?? 0);
            $result[] = $channel;
        }
        return $result;
    }

    /** 渠道编码数组（策略详情摘要用） */
    public static function channelCodes(mixed $channels): array
    {
        return array_map(
            static fn ($channel): int => (int) ((array) $channel)['channel'],
            self::normalizeChannels($channels)
        );
    }

    /** DB NULL -> []（R-JSON-2） */
    public static function intList(mixed $value): array
    {
        return array_map('intval', array_values((array) ($value ?? [])));
    }

    /** DB NULL -> null（R-JSON-1） */
    public static function nullableIntList(mixed $value): ?array
    {
        if ($value === null) {
            return null;
        }
        return array_map('intval', array_values((array) $value));
    }
}
