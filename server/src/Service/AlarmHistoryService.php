<?php

declare(strict_types=1);

namespace App\Service;

use App\Support\Query;
use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use App\Model\AlarmHistory;
use App\Support\Pagination;
use App\Support\Presenter;
use App\Support\Text;
use App\Support\Time;
use App\Support\Validator;
use Carbon\CarbonImmutable;
use Hyperf\DbConnection\Db;
use Hyperf\HttpServer\Contract\RequestInterface;

/**
 * 告警历史服务 —— 契约 §3.3 ⑰-⑱。
 *
 * 业务规则落点（契约 §4.4 + domain.md §5.3）：
 *   H1 action ∈ {handle,ignore,recover}   -> handle()
 *   H2 remark <= 500                      -> handle()
 *   H3 仅 status=1 可处理，否则 409        -> handle()（并发保护见下）
 *   H4 startTime <= endTime，否则 422      -> paginate()
 *   H5 历史不提供删除端点                 —— 本服务无 destroy()
 *
 * ⚠️ 本模块**不写入**历史：告警产生由采集/计算模块负责（domain.md §2 边界说明）。
 */
class AlarmHistoryService
{
    /** ⑰ GET /api/alarm/histories —— 排序固定 triggered_at DESC, id DESC */
    public function paginate(RequestInterface $request): array
    {
        ['page' => $page, 'pageSize' => $pageSize] = Pagination::fromRequest($request);

        $query = AlarmHistory::query();
        $errors = new Validator();

        $policyId = Pagination::intParam(Query::get($request, 'policyId'), 'policyId', $errors);
        if ($policyId !== null) {
            $query->where('policy_id', $policyId);
        }
        $level = Pagination::intParam(Query::get($request, 'level'), 'level', $errors);
        if ($level !== null) {
            $errors->enumInt($level, array_keys(AlarmEnum::LEVEL), 'level', '告警等级必须是 1/2/3 之一');
            $query->where('level', $level);
        }
        $status = Pagination::intParam(Query::get($request, 'status'), 'status', $errors);
        if ($status !== null) {
            $errors->enumInt($status, array_keys(AlarmEnum::HISTORY_STATUS), 'status', '告警状态必须是 1/2/3/4 之一');
            $query->where('status', $status);
        }
        $keyword = $this->strOrNull(Query::get($request, 'keyword'));
        if ($keyword !== null) {
            if (Text::length($keyword) > AlarmEnum::POLICY_NAME_MAX) {
                $errors->add('keyword', 'keyword 长度不能超过 128 个字符');
            }
            $like = Text::likeExpression($keyword);
            $query->where(function ($q) use ($like): void {
                $q->whereRaw(Text::likeCondition('policy_name'), [$like])
                    ->orWhereRaw(Text::likeCondition('object_name'), [$like])
                    ->orWhereRaw(Text::likeCondition('metric_name_cn'), [$like]);
            });
        }

        // H4：startTime <= endTime，否则 422
        $startTime = Time::tryParse($this->strOrNull(Query::get($request, 'startTime')));
        $endTime = Time::tryParse($this->strOrNull(Query::get($request, 'endTime')));
        $rawStart = $this->strOrNull(Query::get($request, 'startTime'));
        $rawEnd = $this->strOrNull(Query::get($request, 'endTime'));
        if ($rawStart !== null && $startTime === null) {
            $errors->add('startTime', '开始时间格式必须是 YYYY-MM-DD HH:mm:ss');
        }
        if ($rawEnd !== null && $endTime === null) {
            $errors->add('endTime', '结束时间格式必须是 YYYY-MM-DD HH:mm:ss');
        }
        if ($startTime !== null && $endTime !== null && $startTime->gt($endTime)) {
            $errors->add('startTime', '开始时间不能晚于结束时间');
        }
        $errors->validate();

        if ($startTime !== null) {
            $query->where('triggered_at', '>=', $startTime->format(Time::DATETIME_FORMAT));
        }
        if ($endTime !== null) {
            $query->where('triggered_at', '<=', $endTime->format(Time::DATETIME_FORMAT));
        }

        $total = (int) $query->count();
        $rows = $query
            ->orderBy('triggered_at', 'desc')
            ->orderBy('id', 'desc')
            ->forPage($page, $pageSize)
            ->get();

        return [
            'list' => array_map([Presenter::class, 'history'], $rows->all()),
            'total' => $total,
            'page' => $page,
            'pageSize' => $pageSize,
        ];
    }

    /**
     * ⑱ POST /api/alarm/histories/{id}/handle —— 处理告警。
     *
     * 状态机（domain.md §4.2）：仅 status=1（未处理）可处理，
     * action 映射到 2/3/4 三个**终态**；任何终态再次处理 -> 409 HISTORY_ALREADY_HANDLED。
     *
     * ⚠️ 并发保护（domain.md §5.3 第 1 条）：UPDATE 的 WHERE 里同时带 status=1，
     *    再检查 affected_rows === 1。比「先 SELECT 再 UPDATE」更安全，
     *    两个人同时点处理时只有一个会成功。
     */
    public function handle(int $id, mixed $action, mixed $remark, array $currentUser): array
    {
        $history = $this->findOrFail($id);

        // H1
        $errors = new Validator();
        if (! is_string($action) || ! isset(AlarmEnum::HANDLE_ACTION[$action])) {
            $errors->add('action', '处理动作必须是 handle / ignore / recover 之一');
            $action = '';
        }
        // H2
        $remarkText = '';
        if ($remark !== null) {
            if (! is_string($remark)) {
                $errors->add('remark', '处理备注必须是字符串');
            } else {
                if (Text::length($remark) > AlarmEnum::REMARK_MAX) {
                    $errors->add('remark', '处理备注长度不能超过 500 个字符');
                }
                $remarkText = $remark;
            }
        }
        $errors->validate();

        // H3 快速失败：已处理直接 409（UPDATE 的 status=1 守卫是第二道防线）
        if ((int) $history->status !== AlarmEnum::HISTORY_STATUS_UNHANDLED) {
            throw BusinessException::conflict(ErrorCode::REASON_HISTORY_ALREADY_HANDLED);
        }

        $now = Time::now();
        $newStatus = AlarmEnum::HANDLE_ACTION[$action];

        $attributes = [
            'status' => $newStatus,
            'handle_action' => $action,
            'handled_at' => $now,
            'handler_name' => $currentUser['name'],
            'handle_remark' => $remarkText,
        ];

        // action=recover 时额外置 recovered_at 与 duration
        if ($action === 'recover') {
            $attributes['recovered_at'] = $now;
            $attributes['duration'] = $this->durationSeconds($history->triggered_at, $now);
        }

        $affected = Db::table('alarm_history')
            ->where('id', $id)
            ->where('status', AlarmEnum::HISTORY_STATUS_UNHANDLED)
            ->update($attributes);

        if ($affected !== 1) {
            throw BusinessException::conflict(ErrorCode::REASON_HISTORY_ALREADY_HANDLED);
        }

        return Presenter::history($this->findOrFail($id));
    }

    public function findOrFail(int $id): AlarmHistory
    {
        $history = AlarmHistory::query()->find($id);
        if ($history === null) {
            throw BusinessException::notFound();
        }
        return $history;
    }

    /** duration = recovered_at - triggered_at（秒，最小 0） */
    private function durationSeconds(mixed $triggeredAt, string $now): int
    {
        $triggered = Time::tryParse(Time::format($triggeredAt));
        if ($triggered === null) {
            return 0;
        }
        $recovered = CarbonImmutable::createFromFormat(Time::DATETIME_FORMAT, $now);
        $seconds = $recovered->getTimestamp() - $triggered->getTimestamp();
        return max(0, $seconds);
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
