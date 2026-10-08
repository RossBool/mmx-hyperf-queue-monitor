<?php

declare(strict_types=1);

namespace App\Service;

use App\Support\Query;
use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use App\Model\AlarmConditionTemplate;
use App\Model\AlarmPolicy;
use App\Service\Validator\ConditionValidator;
use App\Support\Pagination;
use App\Support\Presenter;
use App\Support\Text;
use App\Support\Validator;
use Hyperf\HttpServer\Contract\RequestInterface;

/**
 * 触发条件模板服务 —— 契约 §3.2 ⑨-⑫。
 *
 * 业务规则落点（契约 §4.2）：
 *   T1 name 1-64 + 全局唯一
 *   T2 conditions 1-4 条，字段完整性同 P4-P11   -> ConditionValidator
 *   T3 模板内所有 metricNamespace 必须属于模板的 policyType -> ConditionValidator
 *   T4 isPreset=1 禁止删除（可修改）           -> destroy()
 *   T5 被 alarm_policy.condition_template_id 引用禁止删除 -> destroy()
 */
class AlarmConditionTemplateService
{
    public function __construct(private ConditionValidator $conditionValidator)
    {
    }

    /** ⑨ GET /api/alarm/condition-templates —— 分页 */
    public function paginate(RequestInterface $request): array
    {
        ['page' => $page, 'pageSize' => $pageSize] = Pagination::fromRequest($request);

        $query = AlarmConditionTemplate::query();
        $errors = new Validator();

        $policyType = Pagination::intParam(Query::get($request, 'policyType'), 'policyType', $errors);
        if ($policyType !== null) {
            $errors->enumInt($policyType, array_keys(AlarmEnum::POLICY_TYPE), 'policyType', '策略类型必须是 1/2/3/4 之一');
            $query->where('policy_type', $policyType);
        }
        $isPreset = Pagination::intParam(Query::get($request, 'isPreset'), 'isPreset', $errors);
        if ($isPreset !== null) {
            $errors->enumInt($isPreset, [0, 1], 'isPreset', 'isPreset 必须是 0/1 之一');
            $query->where('is_preset', $isPreset);
        }
        $keyword = $this->strOrNull(Query::get($request, 'keyword'));
        if ($keyword !== null) {
            $like = Text::likeExpression($keyword);
            $query->where(function ($q) use ($like): void {
                $q->whereRaw(Text::likeCondition('name'), [$like])
                    ->orWhereRaw(Text::likeCondition('remark'), [$like]);
            });
        }
        $errors->validate();

        $total = (int) $query->count();
        $rows = $query
            ->orderBy('created_at', 'desc')
            ->orderBy('id', 'desc')
            ->forPage($page, $pageSize)
            ->get();

        return [
            'list' => array_map([Presenter::class, 'conditionTemplate'], $rows->all()),
            'total' => $total,
            'page' => $page,
            'pageSize' => $pageSize,
        ];
    }

    /** ⑩ POST 创建 */
    public function create(array $payload, array $currentUser): array
    {
        [$name, $remark, $policyType, $conditions] = $this->validatePayload($payload);

        $template = new AlarmConditionTemplate();
        $template->fill([
            'name' => $name,
            'remark' => $remark,
            'policy_type' => $policyType,
            'conditions' => json_encode($conditions, JSON_UNESCAPED_UNICODE),
            // §2.4：isPreset 请求体传入无效，仅服务端写入
            'is_preset' => 0,
            'creator_id' => $currentUser['id'],
            'creator_name' => $currentUser['name'],
        ]);
        $template->save();

        return Presenter::conditionTemplate($template->fresh());
    }

    /** ⑪ PUT 更新（全量更新语义；isPreset=1 允许修改，修改后仍为 1） */
    public function update(int $id, array $payload): array
    {
        $template = $this->findOrFail($id);
        [$name, $remark, $policyType, $conditions] = $this->validatePayload($payload);

        $template->fill([
            'name' => $name,
            'remark' => $remark,
            'policy_type' => $policyType,
            'conditions' => json_encode($conditions, JSON_UNESCAPED_UNICODE),
        ]);
        $template->save();

        return Presenter::conditionTemplate($template->fresh());
    }

    /**
     * ⑫ DELETE —— 前置校验顺序固定（契约 §3.2 ⑫）：
     *   不存在 -> 404；isPreset=1 -> 409 PRESET_READONLY；被引用 -> 409 TEMPLATE_IN_USE。
     */
    public function destroy(int $id): bool
    {
        $template = $this->findOrFail($id);

        if ((int) $template->is_preset === 1) {
            throw BusinessException::conflict(ErrorCode::REASON_PRESET_READONLY);
        }

        $referrer = AlarmPolicy::query()->where('condition_template_id', $id)->first();
        if ($referrer !== null) {
            throw BusinessException::conflict(
                ErrorCode::REASON_TEMPLATE_IN_USE,
                sprintf('模板已被策略「%s」引用，不可删除', $referrer->name)
            );
        }

        AlarmConditionTemplate::query()->where('id', $id)->delete();

        return true;
    }

    public function findOrFail(int $id): AlarmConditionTemplate
    {
        $template = AlarmConditionTemplate::query()->find($id);
        if ($template === null) {
            throw BusinessException::notFound();
        }
        return $template;
    }

    /**
     * T1 / T2 / T3
     *
     * @return array{0: string, 1: string, 2: int, 3: array}
     */
    private function validatePayload(array $payload): array
    {
        $errors = new Validator();

        $name = $payload['name'] ?? null;
        if (! is_string($name) || trim($name) === '') {
            $errors->add('name', '模板名称长度必须为 1-64 个字符');
            $name = '';
        } else {
            $name = trim($name);
            if (Text::length($name) > AlarmEnum::TEMPLATE_NAME_MAX) {
                $errors->add('name', '模板名称长度必须为 1-64 个字符');
            }
        }

        $remark = '';
        if (($payload['remark'] ?? null) !== null) {
            if (! is_string($payload['remark'])) {
                $errors->add('remark', '备注必须是字符串');
            } else {
                if (Text::length($payload['remark']) > AlarmEnum::REMARK_MAX) {
                    $errors->add('remark', '备注长度不能超过 500 个字符');
                }
                $remark = $payload['remark'];
            }
        }

        $policyType = Pagination::intParam($payload['policyType'] ?? null, 'policyType', $errors);
        if ($policyType === null || ! isset(AlarmEnum::POLICY_TYPE[$policyType])) {
            $errors->add('policyType', '策略类型必须是 1/2/3/4 之一');
            $policyType = 0;
        }

        $conditions = $this->conditionValidator->validate($payload['conditions'] ?? null, $policyType ?: null, $errors);
        $errors->validate();

        return [$name, $remark, $policyType, $conditions];
    }

    private function strOrNull(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $value = trim((string) $value);
        return $value === '' ? null : $value;
    }
}
