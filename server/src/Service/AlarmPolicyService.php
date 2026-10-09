<?php

declare(strict_types=1);

namespace App\Service;

use App\Support\Query;
use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use App\Model\AlarmConditionTemplate;
use App\Model\AlarmNotificationTemplate;
use App\Model\AlarmPolicy;
use App\Model\AlarmPolicyCondition;
use App\Service\Validator\ConditionValidator;
use App\Service\Validator\PolicyPayloadValidator;
use App\Support\Pagination;
use App\Support\Presenter;
use App\Support\Time;
use App\Support\Text;
use App\Support\Validator;
use Hyperf\DbConnection\Db;
use Hyperf\HttpServer\Contract\RequestInterface;

/**
 * 告警策略服务 —— 契约 §3.1 ①-⑦。
 *
 * 业务规则落点（契约 §4.1）：
 *   P1  name 1-128 + 全局唯一        -> assertName() / DB uk_policy_name 兜底
 *   P2  remark <= 500                -> assertNameAndRemark()
 *   P3  monitorType 与 policyType 匹配 -> assertMonitorAndPolicyType()
 *   P4  conditions 1-4 条            -> ConditionValidator
 *   P5  sort 1..N 连续升序           -> ConditionValidator
 *   P6  threshold 可负 <=4 位小数    -> ConditionValidator
 *   P7  continuity ∈ [1,10]          -> ConditionValidator
 *   P8  period ∈ 枚举 ∩ periodOptions -> ConditionValidator
 *   P9  operator ∈ 六种              -> ConditionValidator
 *   P10 八字段完整无兜底             -> ConditionValidator
 *   P11 level / frequency 枚举       -> ConditionValidator
 *   P12 通知模板 <= 3 个             -> assertNotificationTemplateIds()
 *   P13 不重复 + id 存在 + N9        -> assertNotificationTemplateIds()
 *   P14 objectType 与三字段一一对应  -> assertObjectBinding()
 *   P15 仅 status=0 可删，否则 409    -> destroy()
 *   P16 复制不继承 id/创建人，status=0 -> copy()
 *   P17 level = min(conditions.level) -> deriveLevel()
 *   P18 PUT 全量更新，status 不回落   -> update()
 *   P19 POST /status 幂等            -> changeStatus()
 */
class AlarmPolicyService
{
    /** 复制策略时副本后缀（契约 §3.1 ⑦） */
    private const COPY_SUFFIX = ' - 副本';
    private const COPY_MAX_ATTEMPTS = 99;

    public function __construct(
        private ConditionValidator $conditionValidator,
        private PolicyPayloadValidator $payloadValidator
    ) {
    }

    /**
     * ① GET /api/alarm/policies —— 策略分页列表。
     * 排序固定 created_at DESC, id DESC（契约 §0.3，不开放排序参数）。
     */
    public function paginate(RequestInterface $request): array
    {
        ['page' => $page, 'pageSize' => $pageSize] = Pagination::fromRequest($request);

        $query = AlarmPolicy::query();
        $errors = new Validator();

        $keyword = $this->strOrNull(Query::get($request, 'keyword'));
        if ($keyword !== null) {
            // keyword 必须转义，并由 likeCondition() 真的写进 SQL 的 ESCAPE 子句，
            // 否则 % / _ 会变成通配符（全表扫 + 语义错误）
            $like = Text::likeExpression($keyword);
            $query->where(function ($q) use ($like): void {
                $q->whereRaw(Text::likeCondition('name'), [$like])
                    ->orWhereRaw(Text::likeCondition('remark'), [$like]);
            });
        }

        // 非法枚举值返回 422（契约 §3.1 ①）
        $monitorType = Pagination::intParam(Query::get($request, 'monitorType'), 'monitorType', $errors);
        if ($monitorType !== null) {
            $errors->enumInt($monitorType, array_keys(AlarmEnum::MONITOR_TYPE), 'monitorType', '监控类型必须是 1/2/3/4/5 之一');
            $query->where('monitor_type', $monitorType);
        }
        $policyType = Pagination::intParam(Query::get($request, 'policyType'), 'policyType', $errors);
        if ($policyType !== null) {
            $errors->enumInt($policyType, array_keys(AlarmEnum::POLICY_TYPE), 'policyType', '策略类型必须是 1/2/3/4 之一');
            $query->where('policy_type', $policyType);
        }
        $status = Pagination::intParam(Query::get($request, 'status'), 'status', $errors);
        if ($status !== null) {
            $errors->enumInt($status, array_keys(AlarmEnum::STATUS), 'status', '策略状态必须是 0/1 之一');
            $query->where('status', $status);
        }
        $level = Pagination::intParam(Query::get($request, 'level'), 'level', $errors);
        if ($level !== null) {
            $errors->enumInt($level, array_keys(AlarmEnum::LEVEL), 'level', '告警等级必须是 1/2/3 之一');
            $query->where('level', $level);
        }
        $projectId = Pagination::intParam(Query::get($request, 'projectId'), 'projectId', $errors);
        if ($projectId !== null) {
            $query->where('project_id', $projectId);
        }
        $errors->validate();

        $total = (int) $query->count();
        $rows = $query
            ->orderBy('created_at', 'desc')
            ->orderBy('id', 'desc')
            ->forPage($page, $pageSize)
            ->get();

        $counts = $this->conditionCounts($rows->pluck('id')->all());
        $list = [];
        foreach ($rows as $policy) {
            $list[] = Presenter::policyListItem($policy, $counts[$policy->id] ?? 0);
        }

        return ['list' => $list, 'total' => $total, 'page' => $page, 'pageSize' => $pageSize];
    }

    /**
     * ② GET /api/alarm/policies/{id} —— 策略详情。
     */
    public function detail(int $id): array
    {
        $policy = $this->findOrFail($id);
        $conditions = $this->conditionsOf($policy->id);
        $summaries = $this->notificationTemplateSummaries(Presenter::intList($policy->notification_template_ids));

        return Presenter::policyDetail($policy, $conditions, count($conditions), $summaries);
    }

    /**
     * ③ POST /api/alarm/policies —— 创建策略。
     *
     * @param array{id:int,name:string}|null $currentUser 当前登录人（creatorId / creatorName）
     */
    public function create(array $payload, array $currentUser): array
    {
        $errors = new Validator();
        $name = $this->assertName($payload['name'] ?? null, $errors);
        $remark = $this->assertRemark($payload['remark'] ?? null, $errors);
        [$monitorType, $policyType] = $this->assertMonitorAndPolicyType($payload, $errors);
        $projectId = $this->assertProjectId($payload['projectId'] ?? null, $errors);
        $objectType = $this->assertObjectType($payload['objectType'] ?? null, $errors);
        $objectBinding = $this->payloadValidator->assertObjectBinding($payload, $objectType, $errors);
        $conditionLogic = $this->assertConditionLogic($payload['conditionLogic'] ?? null, $errors);
        // v1.1 无数据检测（F 类）：仅 policyType=5 有值
        $silenceTarget = $this->payloadValidator->assertSilenceTarget($payload, $policyType, $errors);
        $conditions = $this->conditionValidator->validate($payload['conditions'] ?? null, $policyType, $errors);
        $notificationTemplateIds = $this->resolveNotificationTemplateIds($payload['notificationTemplateIds'] ?? null, $errors);
        $conditionTemplateId = $this->assertConditionTemplateId($payload['conditionTemplateId'] ?? null, $policyType, $errors);
        $status = $this->assertStatus($payload['status'] ?? null, $errors);
        $errors->validate();

        $id = Db::transaction(function () use (
            $name, $remark, $monitorType, $policyType, $projectId, $objectType, $objectBinding,
            $conditionLogic,
            $silenceTarget, $conditions, $notificationTemplateIds, $conditionTemplateId, $status, $currentUser
        ): int {
            $now = Time::now();
            $row = AlarmPolicy::normalizeJsonForWrite([
                'name' => $name,
                'remark' => $remark,
                'monitor_type' => $monitorType,
                'policy_type' => $policyType,
                'status' => $status,
                'level' => self::deriveLevel($conditions),
                'project_id' => $projectId,
                'object_type' => $objectType,
                'object_ids' => $objectBinding['object_ids'],
                'object_group_ids' => $objectBinding['object_group_ids'],
                'object_filters' => $objectBinding['object_filters'],
                'condition_logic' => $conditionLogic,
                // v1.1 无数据检测：非采集静默策略恒为 NULL（契约 §2.3）
                'target_type' => $silenceTarget['target_type'],
                'target_freshness_minutes' => $silenceTarget['target_freshness_minutes'],
                'notification_template_ids' => $notificationTemplateIds,
                'condition_template_id' => $conditionTemplateId,
                'creator_id' => $currentUser['id'],
                'creator_name' => $currentUser['name'],
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            // 显式 insertGetId：不经过 Model 的 casts / dirty 计算，
            // JSON 列的 NULL 语义由 normalizeJsonForWrite() 唯一决定。
            $id = (int) Db::table('alarm_policy')->insertGetId($row);

            $this->insertConditions($id, $conditions);

            return $id;
        });

        return $this->detail($id);
    }

    /**
     * ④ PUT /api/alarm/policies/{id} —— **全量更新**（契约 §3.1 ④）。
     *
     * 未传字段回落默认值；`status` 是唯一不回落默认的字段（保持原值）。
     * 事务内先 DELETE 子条件再批量插入。
     */
    public function update(int $id, array $payload): array
    {
        $policy = $this->findOrFail($id);

        $errors = new Validator();
        $name = $this->assertName($payload['name'] ?? null, $errors);
        $remark = $this->assertRemark($payload['remark'] ?? null, $errors);
        [$monitorType, $policyType] = $this->assertMonitorAndPolicyType($payload, $errors);
        $projectId = $this->assertProjectId($payload['projectId'] ?? null, $errors);
        $objectType = $this->assertObjectType($payload['objectType'] ?? null, $errors);
        $objectBinding = $this->payloadValidator->assertObjectBinding($payload, $objectType, $errors);
        $conditionLogic = $this->assertConditionLogic($payload['conditionLogic'] ?? null, $errors);
        // v1.1 无数据检测（F 类）：仅 policyType=5 有值
        $silenceTarget = $this->payloadValidator->assertSilenceTarget($payload, $policyType, $errors);
        $conditions = $this->conditionValidator->validate($payload['conditions'] ?? null, $policyType, $errors);
        $notificationTemplateIds = $this->resolveNotificationTemplateIds($payload['notificationTemplateIds'] ?? null, $errors);
        $conditionTemplateId = $this->assertConditionTemplateId($payload['conditionTemplateId'] ?? null, $policyType, $errors);
        $errors->validate();

        // ⚠️ $silenceTarget 必须在 use 列表里。闭包不会自动捕获外层变量 ——
        //    漏掉的后果不是报错，而是**每次更新策略都把静默配置写成 NULL**：
        //    静默策略一旦被编辑（改个名字、改个阈值），targetType / freshness 就没了，
        //    而且没有任何错误提示。PHP 只在日志里留一条 warning。
        Db::transaction(function () use ($policy, $name, $remark, $monitorType, $policyType, $projectId, $objectType, $objectBinding, $conditionLogic, $conditions, $notificationTemplateIds, $conditionTemplateId, $silenceTarget): void {
            AlarmPolicyCondition::query()->where('policy_id', $policy->id)->delete();

            $row = AlarmPolicy::normalizeJsonForWrite([
                'name' => $name,
                'remark' => $remark,
                'monitor_type' => $monitorType,
                'policy_type' => $policyType,
                // P18：status 是唯一不回落默认的字段，**不出现在这条 UPDATE 里**，
                // 启停只能走 POST /status
                'level' => self::deriveLevel($conditions),
                'project_id' => $projectId,
                'object_type' => $objectType,
                'object_ids' => $objectBinding['object_ids'],
                'object_group_ids' => $objectBinding['object_group_ids'],
                'object_filters' => $objectBinding['object_filters'],
                'condition_logic' => $conditionLogic,
                // v1.1 无数据检测：非采集静默策略恒为 NULL（契约 §2.3）
                'target_type' => $silenceTarget['target_type'],
                'target_freshness_minutes' => $silenceTarget['target_freshness_minutes'],
                'notification_template_ids' => $notificationTemplateIds,
                'condition_template_id' => $conditionTemplateId,
                'updated_at' => Time::now(),
            ]);

            // ⚠️ 用查询构造器显式 UPDATE，而不是 `$policy->fill(...)->save()`：
            // 配合 setRawAttributes($attrs, true) 的话，syncOriginal() 会让
            // getDirty() 恒为空，导致一条 UPDATE 都不发出（静默无操作）。
            Db::table('alarm_policy')->where('id', $policy->id)->update($row);

            $this->insertConditions((int) $policy->id, $conditions);
        });

        return $this->detail($id);
    }

    /**
     * ⑤ DELETE /api/alarm/policies/{id} —— 前置校验顺序固定（契约 §3.1 ⑤）：
     *   不存在 -> 404；status=1 -> 409 POLICY_STATUS_CONFLICT；否则删除。
     * alarm_policy_condition 由外键 ON DELETE CASCADE 物理级联删除；alarm_history **保留**。
     */
    public function destroy(int $id): bool
    {
        $policy = $this->findOrFail($id);

        if ((int) $policy->status === 1) {
            throw BusinessException::conflict(ErrorCode::REASON_POLICY_STATUS_CONFLICT);
        }

        AlarmPolicy::query()->where('id', $id)->delete();

        return true;
    }

    /**
     * ⑥ POST /api/alarm/policies/{id}/status —— 启停，**幂等**（P19）。
     */
    public function changeStatus(int $id, mixed $rawStatus): array
    {
        $policy = $this->findOrFail($id);

        $errors = new Validator();
        // 契约 §3.1 ⑥：status 必填，缺省/空串必须 422，不能静默按 0 停用
        $status = $this->assertStatus($rawStatus, $errors, true);
        $errors->validate();

        if ((int) $policy->status !== $status) {
            $policy->status = $status;
            $policy->save();
        }

        return $this->detail($id);
    }

    /**
     * ⑦ POST /api/alarm/policies/{id}/copy —— 复制策略。
     *
     * P16：不继承 id / creatorId / creatorName / createdAt / updatedAt，新策略 status=0。
     * 命名：`{原名} - 副本`，冲突时追加 (2)(3)...(99)，仍冲突返回 409。
     * 长度保护按**字符**截断（禁止按字节，契约 §3.1 ⑦）。
     */
    public function copy(int $id, array $currentUser): array
    {
        $source = $this->findOrFail($id);
        $sourceConditions = $this->conditionsOf($source->id);
        $newName = $this->generateCopyName((string) $source->name);

        $newId = Db::transaction(function () use ($source, $sourceConditions, $newName, $currentUser): int {
            $now = Time::now();
            $row = AlarmPolicy::normalizeJsonForWrite([
                'name' => $newName,
                'remark' => $source->remark,               // 继承
                'monitor_type' => $source->monitor_type,
                'policy_type' => $source->policy_type,
                'status' => 0,                              // P16：强制停用
                'level' => $source->level,
                'project_id' => $source->project_id,
                'object_type' => $source->object_type,
                // 源模型上这四列读出来是数组 / null，统一交给 normalizeJsonForWrite 归一化
                'object_ids' => $source->object_ids,
                'object_group_ids' => $source->object_group_ids,
                'object_filters' => $source->object_filters,
                'condition_logic' => $source->condition_logic,
                'notification_template_ids' => Presenter::intList($source->notification_template_ids),
                'condition_template_id' => $source->condition_template_id,
                'creator_id' => $currentUser['id'],         // 归当前登录人
                'creator_name' => $currentUser['name'],
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            $newId = (int) Db::table('alarm_policy')->insertGetId($row);

            $rows = [];
            foreach ($sourceConditions as $condition) {
                $rows[] = [
                    'policy_id' => $newId,
                    'sort' => $condition->sort,
                    'metric_namespace' => $condition->metric_namespace,
                    'metric_name' => $condition->metric_name,
                    'metric_name_cn' => $condition->metric_name_cn,
                    'unit' => $condition->unit,
                    'operator' => $condition->operator,
                    'threshold' => $condition->threshold,
                    'period' => $condition->period,
                    'continuity' => $condition->continuity,
                    'level' => $condition->level,
                    'frequency' => $condition->frequency,
                    // v1.1：相对判据设置**原样继承**。
                    // ⚠️ 用 `?? 'absolute'` 而不是 `?? null` ——
                    //    副本的 compare_mode 若是 NULL，读取侧会归一化成 absolute，
                    //    行为一致；但写成 'absolute' 让列语义在库里就自解释。
                    'compare_mode' => $condition->compare_mode ?? 'absolute',
                    'baseline_type' => $condition->baseline_type,
                    'baseline_count' => $condition->baseline_count,
                    'created_at' => $now,
                    'updated_at' => $now,
                ];
            }
            if ($rows !== []) {
                AlarmPolicyCondition::query()->insert($rows);
            }

            return $newId;
        });

        return ['id' => $newId, 'name' => $newName];
    }

    // ---------------------------------------------------------------- 校验辅助

    /** P1：trim 后 1-128；唯一性靠 DB uk_policy_name 兜底（并发下更安全，domain.md §5.3） */
    private function assertName(mixed $raw, Validator $errors): string
    {
        if (! is_string($raw)) {
            $errors->add('name', '策略名称必须提供');
            return '';
        }
        $name = trim($raw);
        if ($name === '') {
            $errors->add('name', '策略名称长度必须为 1-128 个字符');
            return '';
        }
        if (Text::length($name) > AlarmEnum::POLICY_NAME_MAX) {
            $errors->add('name', '策略名称长度必须为 1-128 个字符');
        }
        return $name;
    }

    /** P2：remark <= 500，省略时回落 ''（契约 §3.1 ④） */
    private function assertRemark(mixed $raw, Validator $errors): string
    {
        if ($raw === null) {
            return '';
        }
        if (! is_string($raw)) {
            $errors->add('remark', '备注必须是字符串');
            return '';
        }
        if (Text::length($raw) > AlarmEnum::REMARK_MAX) {
            $errors->add('remark', '备注长度不能超过 500 个字符');
        }
        return $raw;
    }

    /**
     * P3：monitorType 与 policyType 必须匹配（契约 §1.1 联动表）。
     * monitorType 3/4/5 在 v1.0 暂无策略类型，选了返回 422。
     *
     * @return array{0: int, 1: int}
     */
    private function assertMonitorAndPolicyType(array $payload, Validator $errors): array
    {
        $monitorType = Pagination::intParam($payload['monitorType'] ?? null, 'monitorType', $errors);
        $policyType = Pagination::intParam($payload['policyType'] ?? null, 'policyType', $errors);

        if ($monitorType === null) {
            $errors->add('monitorType', '监控类型必须提供');
        } elseif (! isset(AlarmEnum::MONITOR_TYPE[$monitorType])) {
            $errors->add('monitorType', '监控类型必须是 1/2/3/4/5 之一');
        }

        if ($policyType === null) {
            $errors->add('policyType', '策略类型必须提供');
        } elseif (! isset(AlarmEnum::POLICY_TYPE[$policyType])) {
            $errors->add('policyType', '策略类型必须是 1/2/3/4 之一');
        }

        if ($monitorType !== null && $policyType !== null
            && isset(AlarmEnum::MONITOR_TYPE[$monitorType]) && isset(AlarmEnum::POLICY_TYPE[$policyType])
        ) {
            $allowed = AlarmEnum::MONITOR_TYPE_POLICY_TYPES[$monitorType] ?? [];
            if ($allowed === []) {
                $errors->add('policyType', sprintf('监控类型「%s」在当前版本暂无策略类型', AlarmEnum::MONITOR_TYPE[$monitorType]));
            } elseif (! in_array($policyType, $allowed, true)) {
                $errors->add('policyType', sprintf('策略类型不属于监控类型「%s」', AlarmEnum::MONITOR_TYPE[$monitorType]));
            }
        }

        return [$monitorType ?? 0, $policyType ?? 0];
    }

    private function assertProjectId(mixed $raw, Validator $errors): int
    {
        if ($raw === null || $raw === '') {
            return 0; // 契约：projectId 可选，默认 0（未分配）
        }
        if (! is_numeric($raw) || (int) $raw < 0) {
            $errors->add('projectId', '项目 id 必须是大于等于 0 的整数');
            return 0;
        }
        return (int) $raw;
    }

    private function assertObjectType(mixed $raw, Validator $errors): int
    {
        $objectType = Pagination::intParam($raw, 'objectType', $errors);
        if ($objectType === null || ! isset(AlarmEnum::OBJECT_TYPE[$objectType])) {
            $errors->add('objectType', '告警对象类型必须是 1/2/3/4 之一');
            return 1;
        }
        return $objectType;
    }

    private function assertConditionLogic(mixed $raw, Validator $errors): int
    {
        if ($raw === null || $raw === '') {
            return 1; // 契约默认 1（满足所有条件）
        }
        $value = Pagination::intParam($raw, 'conditionLogic', $errors);
        if ($value === null || ! in_array($value, array_keys(AlarmEnum::CONDITION_LOGIC), true)) {
            $errors->add('conditionLogic', '条件间逻辑必须是 1/2 之一');
            return 1;
        }
        return $value;
    }

    /**
     * P12 / P13 / N9：先做结构校验（数量/重复），再查库做存在性与 N9 校验。
     */
    private function resolveNotificationTemplateIds(mixed $raw, Validator $errors): array
    {
        $ids = $this->payloadValidator->assertNotificationTemplateIds($raw, $errors);
        if ($ids === [] || $errors->hasError('notificationTemplateIds')) {
            return $ids;
        }

        return $this->payloadValidator->assertNotificationTemplateIds(
            $ids,
            $errors,
            $this->payloadValidator->loadTemplates($ids)
        );
    }

    /** conditionTemplateId > 0 时模板须存在且 policyType 一致（契约 §3.1 ③） */
    private function assertConditionTemplateId(mixed $raw, int $policyType, Validator $errors): int
    {
        if ($raw === null || $raw === '') {
            return 0;
        }
        $id = Pagination::intParam($raw, 'conditionTemplateId', $errors);
        if ($id === null || $id < 0) {
            $errors->add('conditionTemplateId', '条件模板 id 必须是大于等于 0 的整数');
            return 0;
        }
        if ($id === 0) {
            return 0;
        }
        $template = AlarmConditionTemplate::query()->find($id);
        if ($template === null) {
            $errors->add('conditionTemplateId', '触发条件模板不存在');
        } elseif ((int) $template->policy_type !== $policyType) {
            $errors->add('conditionTemplateId', '触发条件模板的策略类型与本策略不一致');
        }
        return $id;
    }

    /**
     * 校验并归一化 status。
     *
     * ⚠️ `$required` 区分两个语义**完全不同**的调用方（契约 §3.1）：
     *   - `false`（③ 创建 / ④ 更新）：`status` 可缺省，缺省为 0（停用）
     *   - `true`（⑥ 启停）：`status` **必填**。缺省或空串时若静默按 0 处理，
     *     一次 `POST /status` 空 body 就会把线上策略停掉并返回 200。
     */
    private function assertStatus(mixed $raw, Validator $errors, bool $required = false): int
    {
        if ($raw === null || $raw === '') {
            if ($required) {
                $errors->add('status', '策略状态为必填字段，0=停用 / 1=启用');
            }
            return 0; // 创建/更新时契约允许缺省为 0（停用）
        }
        $value = Pagination::intParam($raw, 'status', $errors);
        if ($value === null || ! in_array($value, array_keys(AlarmEnum::STATUS), true)) {
            $errors->add('status', '策略状态必须是 0/1 之一');
            return 0;
        }
        return $value;
    }

    /**
     * P17：策略 level = min(conditions[].level)（数值越小越严重）。
     * 该列是冗余派生列，唯一目的是支撑列表筛选走 idx_policy_status_level_created。
     */
    public static function deriveLevel(array $conditions): int
    {
        $levels = array_map(static fn (array $c): int => (int) $c['level'], $conditions);
        return $levels === [] ? 3 : min($levels);
    }

    /**
     * 复制策略的名称生成（domain.md §5.4）。
     *
     * ⚠️ 截断按**字符**而非字节：VARCHAR(128) 与 ck_policy_name_len 的 CHAR_LENGTH 都按字符计。
     *    后缀 ` - 副本` = 5 字符，带序号的 ` - 副本(2)` = 8 字符。
     */
    /**
     * 可空字符串列的落库值：**null 就保持 null**。
     *
     * PHP 的 `(string) null === ''`。对可空列用强转，等于往库里塞空串 ——
     * 读回来前端拿到 `''` 而不是 `null`，`=== null` 判断直接失效；
     * 若该列有 CHECK 枚举，空串还会被 DB 拒绝，报错信息指向一个看起来
     * 完全无辜的字段。
     */
    private static function nullableString(mixed $value): ?string
    {
        return $value === null ? null : (string) $value;
    }

    private function generateCopyName(string $sourceName): string
    {
        foreach (self::copyNameCandidates($sourceName) as $candidate) {
            if (! $this->nameExists($candidate)) {
                return $candidate;
            }
        }

        throw BusinessException::conflict(ErrorCode::REASON_POLICY_NAME_DUPLICATED);
    }

    /**
     * 复制策略的候选名称序列（domain.md §5.4）。
     *
     * ` - 副本` = 5 字符 / 9 字节，` - 副本(2)` = 8 字符 / 12 字节。
     * ⚠️ 截断按**字符**而非字节（契约 §3.1 ⑦ 明令禁止按字节截断：
     *    utf8mb4 下 128 个汉字 = 384 字节，按字节截断会切出半截字符）。
     *
     * 抽出为纯函数，使命名规则**不需要连数据库**就能被单元测试覆盖。
     *
     * @return string[] 按尝试顺序排列的候选名，最多 1 + 98 = 99 个
     */
    public static function copyNameCandidates(string $sourceName): array
    {
        $base = trim($sourceName);
        $suffixChars = Text::length(self::COPY_SUFFIX);

        $candidates = [Text::truncateChars($base, AlarmEnum::POLICY_NAME_MAX - $suffixChars) . self::COPY_SUFFIX];

        for ($i = 2; $i <= self::COPY_MAX_ATTEMPTS; $i++) {
            $numbered = '(' . $i . ')';
            $candidates[] = Text::truncateChars(
                $base,
                AlarmEnum::POLICY_NAME_MAX - $suffixChars - strlen($numbered)
            ) . self::COPY_SUFFIX . $numbered;
        }

        return $candidates;
    }

    private function nameExists(string $name): bool
    {
        return AlarmPolicy::query()->where('name', $name)->exists();
    }

    // ---------------------------------------------------------------- 数据读取

    public function findOrFail(int $id): AlarmPolicy
    {
        $policy = AlarmPolicy::query()->find($id);
        if ($policy === null) {
            throw BusinessException::notFound();
        }
        return $policy;
    }

    /** @return AlarmPolicyCondition[] */
    public function conditionsOf(int $policyId): array
    {
        return AlarmPolicyCondition::query()
            ->where('policy_id', $policyId)
            ->orderBy('sort', 'asc')
            ->get()
            ->all();
    }

    /**
     * 通知模板摘要（契约 §2.3：只给渠道编码数组，不泄漏接收人）。
     *
     * @param int[] $ids
     * @return array<int, array{id:int,name:string,isPreset:int,channels:int[]}>
     */
    private function notificationTemplateSummaries(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $templates = AlarmNotificationTemplate::query()->whereIn('id', $ids)->get();
        $indexed = [];
        foreach ($templates as $template) {
            $indexed[(int) $template->id] = Presenter::notificationTemplateSummary($template);
        }
        // 保持与 notificationTemplateIds 一致的顺序
        $result = [];
        foreach ($ids as $id) {
            if (isset($indexed[$id])) {
                $result[] = $indexed[$id];
            }
        }
        return $result;
    }

    /**
     * 批量取 conditionCount —— 一次 GROUP BY，避免 N+1（domain.md §5.6 第 2 条）。
     *
     * @param array<int, int> $policyIds
     * @return array<int, int>
     */
    private function conditionCounts(array $policyIds): array
    {
        if ($policyIds === []) {
            return [];
        }
        $rows = Db::table('alarm_policy_condition')
            ->selectRaw('policy_id, COUNT(*) AS cnt')
            ->whereIn('policy_id', $policyIds)
            ->groupBy('policy_id')
            ->get();
        $counts = [];
        foreach ($rows as $row) {
            $counts[(int) $row->policy_id] = (int) $row->cnt;
        }
        return $counts;
    }

    /**
     * 批量写入 conditions。
     *
     * ⚠️ 必须显式把 ConditionValidator 返回的 camelCase 键映射成表列名。
     * `$fillable` 与 `alarm_policy_condition` 的列全是 snake_case，而
     * ConditionValidator 按契约 §2.1 返回 camelCase（metricNamespace / metricName /
     * metricNameCn）。这里若原样 array_merge，`Builder::insert()` 收到的是
     * 驼峰键名 → 全部落不到真实列上，③POST / ④PUT 必然报 unknown column。
     *
     * 同表另一条写路径 `copy()` 已经这么做了，两条路径必须保持同一套映射。
     * 用白名单而非 foreach 遍历：即使 validator 将来多返回一个键，也不会被
     * 静默写进 INSERT。
     *
     * @param array<int, array<string, mixed>> $conditions ConditionValidator 产出的 camelCase 数组
     */
    private function insertConditions(int $policyId, array $conditions): void
    {
        if ($conditions === []) {
            return;
        }
        $now = Time::now();
        $rows = [];
        foreach ($conditions as $condition) {
            $rows[] = [
                'policy_id' => $policyId,
                'sort' => (int) $condition['sort'],
                // ⚠️ 这 4 列在 v1.1 起**可空**（采集静默条件不含指标判据），
                //    所以不能用 `(string)` 强转 —— PHP 会把 null 变成 `''`，
                //    写进去一个「看着有值、其实是空串」的行：
                //      · 违反 ck_condition_compare_mode（'' 不在枚举里）
                //      · 违反 ck_condition_operator
                //      · 语义上也错了：契约要求恒为 NULL，不是空串
                'metric_namespace' => self::nullableString($condition['metricNamespace']),
                'metric_name' => self::nullableString($condition['metricName']),
                'metric_name_cn' => (string) $condition['metricNameCn'],
                'unit' => (string) $condition['unit'],
                'operator' => self::nullableString($condition['operator']),
                'threshold' => $condition['threshold'],
                'period' => (int) $condition['period'],
                'continuity' => (int) $condition['continuity'],
                'level' => (int) $condition['level'],
                'frequency' => (int) $condition['frequency'],
                // v1.1 相对判据：absolute 模式下这两列写 NULL（契约 §1.5.1）
                // 同一个 (string) null → '' 的坑，静默条件下 compareMode 就是 null
                'compare_mode' => self::nullableString($condition['compareMode']),
                'baseline_type' => $condition['baselineType'],
                'baseline_count' => $condition['baselineCount'],
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        AlarmPolicyCondition::query()->insert($rows);
    }

    // ---------------------------------------------------------------- 小工具

    private function strOrNull(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $value = trim((string) $value);
        return $value === '' ? null : $value;
    }

}
