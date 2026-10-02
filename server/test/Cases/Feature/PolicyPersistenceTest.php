<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Feature;

use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use App\Model\AlarmPolicy;
use App\Model\AlarmPolicyCondition;
use App\Service\AlarmHistoryService;
use App\Service\AlarmPolicyService;
use Hyperf\DbConnection\Db;
use HyperfTest\TestCase;

/**
 * 需要真实 MySQL 的业务规则测试。
 *
 * ⚠️ 本沙箱没有 PHP / MySQL，**这些用例从未被执行过**。首次运行前请先：
 *   1. `mysql -u<user> -p <db> < docs/alarm/schema.sql` 验证 DDL；
 *   2. `php bin/hyperf.php migrate`；
 *   3. 配好 .env 的 DB_* 后 `composer test`。
 *
 * 覆盖需要真实落库才能验证的规则：
 *   P1  策略名唯一 -> 唯一键冲突转 409
 *   P15 仅 status=0 可删除，status=1 -> 409 POLICY_STATUS_CONFLICT
 *   H3  仅 status=1 可处理，重复处理 -> 409 HISTORY_ALREADY_HANDLED
 */
class PolicyPersistenceTest extends TestCase
{
    private function makeService(): AlarmPolicyService
    {
        /** @var AlarmPolicyService $service */
        $service = $this->getContainer()->get(AlarmPolicyService::class);

        return $service;
    }

    private function makeHistoryService(): AlarmHistoryService
    {
        /** @var AlarmHistoryService $service */
        $service = $this->getContainer()->get(AlarmHistoryService::class);

        return $service;
    }

    private function validPayload(string $name, int $status = 0): array
    {
        return [
            'name' => $name,
            'remark' => 'feature test',
            'monitorType' => 1,
            'policyType' => 2,
            'projectId' => 0,
            'objectType' => 1,
            'conditionLogic' => 1,
            'status' => $status,
            'conditions' => [[
                'sort' => 1,
                'metricNamespace' => 'CVM',
                'metricName' => 'CpuUtilizationRate',
                'operator' => '>',
                'threshold' => 90,
                'period' => 5,
                'continuity' => 3,
                'level' => 1,
                'frequency' => 15,
            ]],
        ];
    }

    private function user(): array
    {
        return ['id' => 0, 'name' => 'feature-test'];
    }

    /** P1：策略名全局唯一。DB uk_policy_name 冲突由 AlarmExceptionHandler 转成 409。 */
    public function testPolicyNameMustBeGloballyUnique(): void
    {
        $service = $this->makeService();
        $name = '唯一性测试-' . uniqid();

        $created = $service->create($this->validPayload($name), $this->user());
        $this->assertSame($name, $created['name']);

        try {
            $service->create($this->validPayload($name), $this->user());
            $this->fail('重名策略应当被 uk_policy_name 拦下');
        } catch (\Throwable $e) {
            // 唯一键冲突的 QueryException 会被 AlarmExceptionHandler 翻译成 409；
            // 这里断言异常确实来自唯一键，而不是任何别的校验。
            $this->assertStringContainsString('uk_policy_name', $e->getMessage());
        } finally {
            AlarmPolicy::query()->where('name', $name)->delete();
        }
    }

    /** P15：启用的策略不可删除 -> 409；停用后可删。 */
    public function testEnabledPolicyCannotBeDeleted(): void
    {
        $service = $this->makeService();
        $enabled = $service->create($this->validPayload('删除测试-启用-' . uniqid(), 1), $this->user());

        try {
            $service->destroy((int) $enabled['id']);
            $this->fail('启用中的策略应当返回 409');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::POLICY_STATUS_CONFLICT, $e->getBizCode());
            $this->assertSame('已启用的策略不可删除，请先停用', $e->getMessage());
        } finally {
            AlarmPolicyCondition::query()->where('policy_id', $enabled['id'])->delete();
            AlarmPolicy::query()->where('id', $enabled['id'])->delete();
        }
    }

    public function testDisabledPolicyCanBeDeleted(): void
    {
        $service = $this->makeService();
        $disabled = $service->create($this->validPayload('删除测试-停用-' . uniqid(), 0), $this->user());

        $this->assertTrue($service->destroy((int) $disabled['id']));
        $this->assertSame(0, AlarmPolicy::query()->where('id', $disabled['id'])->count());
        // 子条件随主记录外键 CASCADE 物理删除
        $this->assertSame(0, AlarmPolicyCondition::query()->where('policy_id', $disabled['id'])->count());
    }

    /** P16：副本不继承 id / 创建人，status 强制为 0。 */
    public function testCopyResetsStatusAndCreator(): void
    {
        $service = $this->makeService();
        $source = $service->create($this->validPayload('复制测试源-' . uniqid(), 1), ['id' => 7, 'name' => '源创建人']);

        $copy = $service->copy((int) $source['id'], ['id' => 99, 'name' => '当前登录人']);

        $this->assertNotSame((int) $source['id'], $copy['id']);
        $this->assertStringEndsWith(' - 副本', $copy['name']);

        $copied = $service->detail((int) $copy['id']);
        $this->assertSame(0, $copied['status'], 'P16：副本强制停用');
        $this->assertSame('当前登录人', $copied['creatorName']);

        $service->destroy((int) $copy['id']);
        $service->destroy((int) $source['id']);
    }

    /** H3：仅 status=1 可处理；重复处理 -> 409。 */
    public function testHistoryCanOnlyBeHandledOnce(): void
    {
        $service = $this->makeHistoryService();

        $id = Db::table('alarm_history')->insertGetId([
            'policy_id' => 0,
            'policy_name' => '状态机测试',
            'level' => 1,
            'status' => AlarmEnum::HISTORY_STATUS_UNHANDLED,
            'condition_id' => 0,
            'metric_namespace' => 'CVM',
            'metric_name' => 'CpuUtilizationRate',
            'metric_name_cn' => 'CPU 使用率',
            'unit' => '%',
            'operator' => '>',
            'threshold' => 90,
            'actual_value' => 96.4,
            'period' => 5,
            'continuity' => 3,
            'object_type' => 2,
            'object_id' => 8801,
            'object_name' => 'prod-web-01',
            'content' => 'CVM prod-web-01 CPU 使用率 > 90%，实际 96.4%',
            'triggered_at' => '2026-09-30 03:15:00',
            'duration' => 0,
            'notify_count' => 1,
        ]);

        $handled = $service->handle((int) $id, 'handle', '已扩容并重启服务', $this->user());
        $this->assertSame(2, $handled['status']);
        $this->assertSame('handle', $handled['handleAction']);
        $this->assertSame('已扩容并重启服务', $handled['handleRemark']);
        $this->assertNotNull($handled['handledAt']);
        $this->assertNull($handled['recoveredAt']);

        try {
            $service->handle((int) $id, 'ignore', null, $this->user());
            $this->fail('重复处理应当返回 409');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::HISTORY_ALREADY_HANDLED, $e->getBizCode());
            $this->assertSame('该告警已处理，不可重复处理', $e->getMessage());
        } finally {
            Db::table('alarm_history')->where('id', $id)->delete();
        }
    }

    /** action=recover 时额外置 recovered_at 与 duration。 */
    public function testRecoverActionSetsRecoveredAtAndDuration(): void
    {
        $service = $this->makeHistoryService();

        $id = Db::table('alarm_history')->insertGetId([
            'policy_id' => 0,
            'policy_name' => '恢复测试',
            'level' => 2,
            'status' => AlarmEnum::HISTORY_STATUS_UNHANDLED,
            'condition_id' => 0,
            'metric_namespace' => 'CVM',
            'metric_name' => 'MemoryUsageRate',
            'metric_name_cn' => '内存使用率',
            'unit' => '%',
            'operator' => '>',
            'threshold' => 90,
            'actual_value' => 95,
            'period' => 5,
            'continuity' => 3,
            'object_type' => 1,
            'object_id' => 0,
            'object_name' => '',
            'content' => 'test',
            'triggered_at' => date('Y-m-d H:i:s', time() - 120),
            'duration' => 0,
            'notify_count' => 1,
        ]);

        $recovered = $service->handle((int) $id, 'recover', '', $this->user());

        $this->assertSame(4, $recovered['status']);
        $this->assertSame('recover', $recovered['handleAction']);
        $this->assertNotNull($recovered['recoveredAt']);
        $this->assertGreaterThanOrEqual(120, $recovered['duration']);

        Db::table('alarm_history')->where('id', $id)->delete();
    }

    /** H1：非法 action -> 422 字段级错误。 */
    public function testInvalidActionIsRejected(): void
    {
        $service = $this->makeHistoryService();

        $id = Db::table('alarm_history')->insertGetId([
            'policy_id' => 0, 'policy_name' => '非法动作', 'level' => 3,
            'status' => AlarmEnum::HISTORY_STATUS_UNHANDLED, 'condition_id' => 0,
            'metric_namespace' => 'CVM', 'metric_name' => 'CpuUtilizationRate',
            'metric_name_cn' => 'CPU 使用率', 'unit' => '%', 'operator' => '>',
            'threshold' => 80, 'actual_value' => 90, 'period' => 5, 'continuity' => 3,
            'object_type' => 1, 'object_id' => 0, 'object_name' => '', 'content' => 'test',
            'triggered_at' => date('Y-m-d H:i:s'), 'duration' => 0, 'notify_count' => 0,
        ]);

        try {
            $service->handle((int) $id, 'delete', null, $this->user());
            $this->fail('非法 action 应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::VALIDATION_ERROR, $e->getBizCode());
            $errors = $e->getErrors();
            $this->assertSame('action', $errors[0]['field']);
        } finally {
            Db::table('alarm_history')->where('id', $id)->delete();
        }
    }

    /** P17：策略 level = min(conditions.level)，落库为冗余派生列。 */
    public function testPolicyLevelColumnIsDerived(): void
    {
        $service = $this->makeService();
        $payload = $this->validPayload('派生等级-' . uniqid());
        $payload['conditions'][] = [
            'sort' => 2, 'metricNamespace' => 'CVM', 'metricName' => 'MemoryUsageRate',
            'operator' => '>', 'threshold' => 85, 'period' => 5, 'continuity' => 2,
            'level' => 3, 'frequency' => 30,
        ];
        $payload['conditions'][0]['level'] = 2;

        $created = $service->create($payload, $this->user());

        $this->assertSame(2, $created['level']);

        $service->destroy((int) $created['id']);
    }

    /**
     * P18 全量更新：所有可写字段真正落库，且 level 随条件重算（P17）。
     *
     * ⚠️ 这条用例是「update() 真的发出 UPDATE」的回归防线：
     *    早先的实现用 `fill() + setRawAttributes($attrs, true)`，而该方法的第二参数会
     *    调 `syncOriginal()`，导致 `Model::save()` 在已存在模型上算出空的 `getDirty()`，
     *    **一条 UPDATE 都不会发出**，全量更新静默变成空操作。
     */
    public function testUpdateIsFullAndActuallyPersists(): void
    {
        $service = $this->makeService();
        $name = '全量更新-' . uniqid();
        $created = $service->create($this->validPayload($name, 0), $this->user());

        $updated = $service->update((int) $created['id'], [
            'name' => $name . '-改',
            'remark' => '改过的备注',
            'monitorType' => 1,
            'policyType' => 2,
            'projectId' => 42,
            'objectType' => 2,
            'objectIds' => [8801, 8802],
            'conditionLogic' => 2,
            // 两条条件：level 1 与 3 -> P17 派生 level 应为 1
            'conditions' => [
                [
                    'sort' => 1, 'metricNamespace' => 'CVM', 'metricName' => 'CpuUtilizationRate',
                    'operator' => '>', 'threshold' => 90, 'period' => 5,
                    'continuity' => 3, 'level' => 1, 'frequency' => 15,
                ],
                [
                    'sort' => 2, 'metricNamespace' => 'CVM', 'metricName' => 'MemoryUsageRate',
                    'operator' => '>', 'threshold' => 85, 'period' => 5,
                    'continuity' => 2, 'level' => 3, 'frequency' => 30,
                ],
            ],
            'notificationTemplateIds' => [],
            'conditionTemplateId' => 0,
            // ⚠️ 请求体里**故意**带一个 status=1：P18 规定 status 只能通过
            //    POST /status 变更，全量更新必须忽略它。
            'status' => 1,
        ]);

        // 读库确认真的写进去了（而不是只返回了内存里的对象）
        $row = Db::table('alarm_policy')->where('id', $created['id'])->first();
        $this->assertNotNull($row);
        $this->assertSame($name . '-改', $row->name);
        $this->assertSame('改过的备注', $row->remark);
        $this->assertSame(42, (int) $row->project_id);
        $this->assertSame(2, (int) $row->condition_logic);
        $this->assertSame(2, (int) $row->object_type);
        $this->assertSame('[8801,8802]', $row->object_ids);
        $this->assertNull($row->object_group_ids, 'P14：不适用的字段应落 NULL');
        $this->assertNull($row->notification_template_ids, 'R-JSON-2：[] 落 NULL');

        // P17：派生 level 重算为 1
        $this->assertSame(1, (int) $row->level);
        $this->assertSame(1, $updated['level']);

        // P18：status 保持原值 0，忽略请求体里的 status=1
        $this->assertSame(0, (int) $row->status);
        $this->assertSame(0, $updated['status']);

        // 子条件被「先删后插」重建为 2 条
        $this->assertSame(2, (int) AlarmPolicyCondition::query()->where('policy_id', $created['id'])->count());
        $this->assertSame(2, $updated['conditionCount']);

        $service->destroy((int) $created['id']);
    }

    /** 启停后 status 改变；再全量更新时 status 不被回滚。 */
    public function testUpdateDoesNotRevertStatusAfterEnable(): void
    {
        $service = $this->makeService();
        $name = '状态保持-' . uniqid();
        $created = $service->create($this->validPayload($name, 0), $this->user());
        $service->changeStatus((int) $created['id'], 1);

        $updated = $service->update((int) $created['id'], $this->validPayload($name . '-2', 0));

        $this->assertSame(1, $updated['status'], 'P18：全量更新不得把启用的策略停用');
        $this->assertSame(1, (int) Db::table('alarm_policy')->where('id', $created['id'])->value('status'));

        $service->changeStatus((int) $created['id'], 0);
        $service->destroy((int) $created['id']);
    }

    /** P14：objectType=2 时省略 objectIds -> 422，且不落库。 */
    public function testUpdateRejectsObjectTypeWithoutObjectIds(): void
    {
        $service = $this->makeService();
        $created = $service->create($this->validPayload('对象校验-' . uniqid(), 0), $this->user());
        $before = Db::table('alarm_policy')->where('id', $created['id'])->value('name');

        try {
            $service->update((int) $created['id'], [
                'name' => '不该被写入', 'remark' => '', 'monitorType' => 1, 'policyType' => 2,
                'objectType' => 2,            // 声称指定实例
                'conditions' => $this->validPayload('x')['conditions'],
            ]);
            $this->fail('objectType=2 缺少 objectIds 应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::VALIDATION_ERROR, $e->getBizCode());
            $fields = array_column($e->getErrors(), 'field');
            $this->assertContains('objectIds', $fields);
        }

        $this->assertSame($before, Db::table('alarm_policy')->where('id', $created['id'])->value('name'), '422 后不得有任何写入');

        $service->destroy((int) $created['id']);
    }

    /** P4：省略 conditions -> 422（契约 §3.1 ④：这是刻意的，避免误清空）。 */
    public function testUpdateWithoutConditionsIsRejected(): void
    {
        $service = $this->makeService();
        $created = $service->create($this->validPayload('缺条件-' . uniqid(), 0), $this->user());

        try {
            $service->update((int) $created['id'], [
                'name' => 'x', 'remark' => '', 'monitorType' => 1, 'policyType' => 2, 'objectType' => 1,
            ]);
            $this->fail('省略 conditions 应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::VALIDATION_ERROR, $e->getBizCode());
            $this->assertSame('conditions', $e->getErrors()[0]['field']);
        }

        $service->destroy((int) $created['id']);
    }

    /** P3：monitorType=2（应用性能监控）只能配 policyType=1。 */
    public function testMonitorTypeAndPolicyTypeMustMatch(): void
    {
        $service = $this->makeService();
        $payload = $this->validPayload('联动校验-' . uniqid(), 0);
        $payload['monitorType'] = 2;
        $payload['policyType'] = 2;   // CVM 属于 monitorType=1，冲突

        try {
            $service->create($payload, $this->user());
            $this->fail('monitorType/policyType 不匹配应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::VALIDATION_ERROR, $e->getBizCode());
            $this->assertSame('policyType', $e->getErrors()[0]['field']);
        }
    }

    /** monitorType=3/4/5 在 v1.0 暂无策略类型，选了 422。 */
    public function testMonitorTypeWithoutPolicyTypesIsRejected(): void
    {
        $service = $this->makeService();
        $payload = $this->validPayload('无策略类型-' . uniqid(), 0);
        $payload['monitorType'] = 3;

        try {
            $service->create($payload, $this->user());
            $this->fail('monitorType=3 在 v1.0 不应有可用策略类型');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::VALIDATION_ERROR, $e->getBizCode());
            $this->assertSame('policyType', $e->getErrors()[0]['field']);
        }
    }

    /** P19：重复设置相同 status 幂等，不报错。 */
    public function testStatusToggleIsIdempotent(): void
    {
        $service = $this->makeService();
        $created = $service->create($this->validPayload('幂等启停-' . uniqid(), 0), $this->user());

        $this->assertSame(0, $service->changeStatus((int) $created['id'], 0)['status']);
        $this->assertSame(0, $service->changeStatus((int) $created['id'], 0)['status']);
        $this->assertSame(1, $service->changeStatus((int) $created['id'], 1)['status']);
        $this->assertSame(1, $service->changeStatus((int) $created['id'], 1)['status']);

        $service->changeStatus((int) $created['id'], 0);
        $service->destroy((int) $created['id']);
    }

    /** H4：startTime > endTime -> 422。 */
    public function testHistoryTimeRangeMustBeOrdered(): void
    {
        $service = $this->makeHistoryService();

        $request = $this->createMock(\Hyperf\HttpServer\Contract\RequestInterface::class);
        $request->method('input')->willReturnCallback(static function (string $key, $default = null) {
            return match ($key) {
                'startTime' => '2026-09-30 10:00:00',
                'endTime' => '2026-09-01 00:00:00',
                default => $default,
            };
        });

        try {
            $service->paginate($request);
            $this->fail('startTime > endTime 应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(ErrorCode::VALIDATION_ERROR, $e->getBizCode());
            $this->assertSame('startTime', $e->getErrors()[0]['field']);
        }
    }
}
