<?php

declare(strict_types=1);

namespace App\Service;

use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use App\Model\AlarmNotificationReceiver;
use App\Model\AlarmNotificationTemplate;
use App\Service\Validator\ChannelValidator;
use App\Support\Pagination;
use App\Support\Presenter;
use App\Support\Text;
use App\Support\Validator;
use Hyperf\DbConnection\Db;
use Hyperf\HttpServer\Contract\RequestInterface;

/**
 * 通知模板服务 —— 契约 §3.2 ⑬-⑯。
 *
 * 业务规则落点（契约 §4.3）：
 *   N1 name 1-64 + 全局唯一
 *   N2/N3/N4/N5/N6 渠道校验        -> ChannelValidator
 *   N7 isPreset=1 禁止删除         -> destroy()
 *   N8 被任意策略 notification_template_ids 引用禁止删除 -> destroy()
 *   N9 「未配置完成」的模板不可被绑定（校验点在策略侧，见 AlarmPolicyService）
 *
 * 写入约束（契约 §2.8 提示）：channels JSON 与 alarm_notification_receiver 明细
 * 必须在**同一事务**内写入；读取一律以 channels 为准。
 */
class AlarmNotificationTemplateService
{
    public function __construct(private ChannelValidator $channelValidator)
    {
    }

    /** ⑬ GET /api/alarm/notification-templates —— 分页，列表返回**完整 channels** */
    public function paginate(RequestInterface $request): array
    {
        ['page' => $page, 'pageSize' => $pageSize] = Pagination::fromRequest($request);

        $query = AlarmNotificationTemplate::query();
        $errors = new Validator();

        $isPreset = Pagination::intParam($request->input('isPreset'), 'isPreset', $errors);
        if ($isPreset !== null) {
            $errors->enumInt($isPreset, [0, 1], 'isPreset', 'isPreset 必须是 0/1 之一');
            $query->where('is_preset', $isPreset);
        }
        $keyword = $this->strOrNull($request->input('keyword'));
        if ($keyword !== null) {
            $like = Text::likeExpression($keyword);
            $query->where(function ($q) use ($like): void {
                $q->whereRaw(Text::likeCondition('name'), [$like])
                    ->orWhereRaw(Text::likeCondition('remark'), [$like]);
            });
        }
        $channel = Pagination::intParam($request->input('channel'), 'channel', $errors);
        if ($channel !== null) {
            $errors->enumInt($channel, array_keys(AlarmEnum::NOTIFY_CHANNEL), 'channel', '通知渠道必须是 1/2/3/4/5 之一');
        }
        $errors->validate();

        if ($channel === null) {
            $total = (int) $query->count();
            $rows = $query
                ->orderBy('created_at', 'desc')
                ->orderBy('id', 'desc')
                ->forPage($page, $pageSize)
                ->get();

            return [
                'list' => array_map([Presenter::class, 'notificationTemplate'], $rows->all()),
                'total' => $total,
                'page' => $page,
                'pageSize' => $pageSize,
            ];
        }

        // ?channel= 过滤：channels 是 JSON 数组，无法走索引（schema.sql 头注已声明共两处 JSON 检索）。
        // 既定方案：先按 is_preset / keyword 缩小集合，再在应用层过滤。
        // 模板数量级很小（预置 3 条 + 用户自定义），此路径 EXPLAIN type:ALL 属预期内。
        $matched = [];
        foreach ($query->orderBy('created_at', 'desc')->orderBy('id', 'desc')->get() as $template) {
            if (in_array($channel, Presenter::channelCodes($template->channels), true)) {
                $matched[] = Presenter::notificationTemplate($template);
            }
        }

        return [
            'list' => array_slice($matched, ($page - 1) * $pageSize, $pageSize),
            'total' => count($matched),
            'page' => $page,
            'pageSize' => $pageSize,
        ];
    }

    /** ⑭ POST 创建 */
    public function create(array $payload, array $currentUser): array
    {
        [$name, $remark, $channels] = $this->validatePayload($payload);

        $template = Db::transaction(function () use ($name, $remark, $channels, $currentUser): AlarmNotificationTemplate {
            $template = new AlarmNotificationTemplate();
            $template->fill([
                'name' => $name,
                'remark' => $remark,
                'channels' => json_encode($channels, JSON_UNESCAPED_UNICODE),
                'is_preset' => 0, // §2.5：isPreset 请求体传入无效
                'creator_id' => $currentUser['id'],
                'creator_name' => $currentUser['name'],
            ]);
            $template->save();

            $this->syncReceivers((int) $template->id, $channels);

            return $template;
        });

        return Presenter::notificationTemplate($template->fresh());
    }

    /** ⑮ PUT 更新（全量更新；isPreset=1 允许修改） */
    public function update(int $id, array $payload): array
    {
        $template = $this->findOrFail($id);
        [$name, $remark, $channels] = $this->validatePayload($payload);

        $template = Db::transaction(function () use ($template, $name, $remark, $channels): AlarmNotificationTemplate {
            $template->fill([
                'name' => $name,
                'remark' => $remark,
                'channels' => json_encode($channels, JSON_UNESCAPED_UNICODE),
            ]);
            $template->save();

            $this->syncReceivers((int) $template->id, $channels);

            return $template;
        });

        return Presenter::notificationTemplate($template->fresh());
    }

    /**
     * ⑯ DELETE —— 前置校验顺序固定（契约 §3.2 ⑯）：
     *   不存在 -> 404；isPreset=1 -> 409 PRESET_READONLY；被引用 -> 409 TEMPLATE_IN_USE。
     *
     * 引用检查 SQL（契约给出的原文，走不了索引，EXPLAIN type:ALL，
     * 本版本假设 alarm_policy 为百~千级；万级演进方案见 domain.md §5.6）：
     *   SELECT id, name FROM alarm_policy
     *   WHERE JSON_CONTAINS(notification_template_ids, CAST(:tid AS JSON)) LIMIT 1;
     */
    public function destroy(int $id): bool
    {
        $template = $this->findOrFail($id);

        if ((int) $template->is_preset === 1) {
            throw BusinessException::conflict(ErrorCode::PRESET_READONLY);
        }

        $referrer = Db::selectOne(
            'SELECT id, name FROM alarm_policy
             WHERE JSON_CONTAINS(notification_template_ids, CAST(:tid AS JSON))
             LIMIT 1',
            ['tid' => $id]
        );
        if ($referrer !== null) {
            throw new BusinessException(
                ErrorCode::TEMPLATE_IN_USE,
                sprintf('模板已被策略「%s」引用，不可删除', $referrer->name ?? '')
            );
        }

        Db::transaction(function () use ($id): void {
            // 冗余明细先清（虽有 FK CASCADE，显式删除可避免依赖外键行为）
            AlarmNotificationReceiver::query()->where('template_id', $id)->delete();
            AlarmNotificationTemplate::query()->where('id', $id)->delete();
        });

        return true;
    }

    public function findOrFail(int $id): AlarmNotificationTemplate
    {
        $template = AlarmNotificationTemplate::query()->find($id);
        if ($template === null) {
            throw BusinessException::notFound();
        }
        return $template;
    }

    /**
     * N1 + N2-N6
     *
     * @return array{0: string, 1: string, 2: array}
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

        $channels = $this->channelValidator->validate($payload['channels'] ?? null, $errors);
        $errors->validate();

        return [$name, $remark, $channels];
    }

    /**
     * 把 channels 展开写入冗余明细表（与 channels JSON 同事务，契约 §2.8）。
     * 唯一键 (template_id, channel, contact) 只保证**同一模板内**不重复（schema.sql §5）。
     */
    private function syncReceivers(int $templateId, array $channels): void
    {
        AlarmNotificationReceiver::query()->where('template_id', $templateId)->delete();

        $rows = [];
        foreach ($channels as $channel) {
            foreach ($channel['receivers'] as $contact) {
                $rows[] = [
                    'template_id' => $templateId,
                    'channel' => $channel['channel'],
                    'contact' => $contact,
                ];
            }
        }

        // 本表只镜像**真正的接收人**（邮箱/手机号/微信号），即上面 foreach 里的 $channel['receivers']。
        // 回调地址（channel=5）永远不会进 $rows —— 循环只取 receivers，从不取 callbackUrl；
        // 且 N3 强制 channel=5 的 receivers 必须为空数组（ChannelValidator::assertReceivers() 末尾），
        // 所以该渠道根本不产生行。回调地址 500 字符的契约上限（N3）与本表 contact VARCHAR(255)
        // 之间**不存在冲突**，契约的 500 无需被私自收紧。
        //
        // 下面是**纵深防御**，不是主校验：进入本方法的 $channels 来自 ChannelValidator，
        // 其中每个 contact 都已被 `Text::length($contact) > 255 -> 422` 拦过
        // （ChannelValidator::assertReceivers()），因此正常生产路径下这个 array_filter
        // 恒为无操作、不会丢任何行。
        //
        // ⚠️ 它的真实行为是**静默丢弃**超长行（不报错、不抛异常）。之所以可以接受：
        // 契约 §2.8 规定「读取一律以 channels 为准」，本表是可丢弃的冗余明细
        // （schema.sql §5 亦写明「若确定不需要可直接 DROP 本表，接口契约不变」），
        // 少镜像一行不会让任何读取结果失真。
        $rows = array_values(array_filter(
            $rows,
            static fn (array $row): bool => Text::length((string) $row['contact']) <= AlarmEnum::RECEIVER_CONTACT_MAX
        ));

        if ($rows !== []) {
            AlarmNotificationReceiver::query()->insert($rows);
        }
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
