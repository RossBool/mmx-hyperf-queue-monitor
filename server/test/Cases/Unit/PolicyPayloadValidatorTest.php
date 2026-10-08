<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Constants\AlarmEnum;
use App\Exception\BusinessException;
use App\Model\AlarmNotificationTemplate;
use App\Service\Validator\PolicyPayloadValidator;
use App\Support\Pagination;
use App\Support\Validator;
use Hyperf\HttpServer\Contract\RequestInterface;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * 策略请求体的纯校验部分 —— 契约 P12 / P13 / P14 / N9 与分页参数。
 *
 * 全部**不连数据库**：
 *   - P14 对象字段一一对应是纯逻辑
 *   - P12/P13 的结构校验（数量上限 / 重复 / 整数）传入 `$templates = null` 即可
 *   - P13 存在性与 N9 通过构造 `AlarmNotificationTemplate` 模型实例来验证
 *   - 分页走**真实的** `Pagination::fromRequest()`，用 PHPUnit 生成的
 *     `RequestInterface` 替身，stub 的是 PSR-7 标准的 `getQueryParams()`
 */
class PolicyPayloadValidatorTest extends TestCase
{
    private function validator(): PolicyPayloadValidator
    {
        return new PolicyPayloadValidator();
    }

    // ------------------------------------------------------------ P12 / P13 结构校验

    public function testNullNotificationTemplateIdsDefaultsToEmpty(): void
    {
        $errors = new Validator();

        $this->assertSame([], $this->validator()->assertNotificationTemplateIds(null, $errors));
        $this->assertTrue($errors->passes());
    }

    public function testEmptyNotificationTemplateIdsIsValid(): void
    {
        $errors = new Validator();

        $this->assertSame([], $this->validator()->assertNotificationTemplateIds([], $errors));
        $this->assertTrue($errors->passes());
    }

    /** P12：最多 3 个 */
    public function testAtMostThreeNotificationTemplateIds(): void
    {
        $errors = new Validator();
        $ids = $this->validator()->assertNotificationTemplateIds([1, 2, 3], $errors);
        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame([1, 2, 3], $ids);

        $errors = new Validator();
        $this->validator()->assertNotificationTemplateIds([1, 2, 3, 4], $errors);
        $this->assertArrayHasKey('notificationTemplateIds', $errors->errors());
    }

    /** P13：不得重复 */
    public function testDuplicateNotificationTemplateIdsAreRejected(): void
    {
        $errors = new Validator();
        $this->validator()->assertNotificationTemplateIds([3, 5, 3], $errors);

        $this->assertArrayHasKey('notificationTemplateIds.2', $errors->errors());
    }

    public function testNonIntegerNotificationTemplateIdIsRejected(): void
    {
        $errors = new Validator();
        $this->validator()->assertNotificationTemplateIds([1, 'abc'], $errors);

        $this->assertArrayHasKey('notificationTemplateIds.1', $errors->errors());
    }

    public function testNonArrayNotificationTemplateIdsIsRejected(): void
    {
        $errors = new Validator();
        $this->validator()->assertNotificationTemplateIds('3,5', $errors);

        $this->assertArrayHasKey('notificationTemplateIds', $errors->errors());
    }

    /** P13：id 均须存在 */
    public function testMissingNotificationTemplateIdsAreReported(): void
    {
        $errors = new Validator();
        $templates = [
            3 => $this->makeTemplate(3, '运维值班组', 1, false),
        ];

        $this->validator()->assertNotificationTemplateIds([3, 999], $errors, $templates);

        $this->assertArrayHasKey('notificationTemplateIds', $errors->errors());
        $this->assertStringContainsString('999', $errors->errors()['notificationTemplateIds']);
    }

    // ------------------------------------------------------------ N9 未配置完成

    /** N9：channel≠5 且 receivers 为空 -> 拒绝绑定，并点名模板 */
    public function testUnconfiguredTemplateCannotBeBound(): void
    {
        $errors = new Validator();
        $templates = [
            3 => $this->makeTemplate(3, '系统预置-邮件通知', 1, false, []),   // 邮件但没接收人
        ];

        $this->validator()->assertNotificationTemplateIds([3], $errors, $templates);

        $this->assertArrayHasKey('notificationTemplateIds', $errors->errors());
        $this->assertStringContainsString('系统预置-邮件通知', $errors->errors()['notificationTemplateIds']);
    }

    /** N9：配好接收人的模板可以绑定 */
    public function testConfiguredTemplateCanBeBound(): void
    {
        $errors = new Validator();
        $templates = [
            3 => $this->makeTemplate(3, '运维值班组', 1, false, ['a@b.com']),
        ];

        $this->validator()->assertNotificationTemplateIds([3], $errors, $templates);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
    }

    /** N9：纯回调模板（channel=5）没有接收人，不算「未配置完成」 */
    public function testCallbackOnlyTemplateIsNotConsideredUnconfigured(): void
    {
        $errors = new Validator();
        $template = new AlarmNotificationTemplate();
        $template->id = 9;
        $template->name = '系统预置-回调通知';
        $template->channels = json_encode([
            ['channel' => AlarmEnum::CHANNEL_CALLBACK, 'receivers' => [], 'callbackUrl' => 'https://example.com/hook', 'silenceTime' => 0],
        ], JSON_UNESCAPED_UNICODE);

        $this->assertFalse(PolicyPayloadValidator::isUnconfigured($template));

        $this->validator()->assertNotificationTemplateIds([9], $errors, [9 => $template]);
        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
    }

    public function testIsUnconfiguredDetectsEmptyReceivers(): void
    {
        $this->assertTrue(PolicyPayloadValidator::isUnconfigured($this->makeTemplate(1, '空邮件', 1, false, [])));
        $this->assertFalse(PolicyPayloadValidator::isUnconfigured($this->makeTemplate(2, '有邮件', 1, false, ['a@b.com'])));
        // 多渠道：只要有一个非回调渠道没接收人，就算未配置完成
        $multi = new AlarmNotificationTemplate();
        $multi->id = 3;
        $multi->name = '混合';
        $multi->channels = json_encode([
            ['channel' => AlarmEnum::CHANNEL_CALLBACK, 'receivers' => [], 'callbackUrl' => 'https://a.com', 'silenceTime' => 0],
            ['channel' => 2, 'receivers' => [], 'callbackUrl' => null, 'silenceTime' => 0],
        ], JSON_UNESCAPED_UNICODE);
        $this->assertTrue(PolicyPayloadValidator::isUnconfigured($multi));
    }

    // ------------------------------------------------------------ P14 objectType 一一对应

    /**
     * 审查要求的 4 个 objectType 用例：1/2/3/4 各一个。
     *
     * ⚠️ 上一轮把「三个字段必须为空」的断言写成了**无条件**执行，
     *    导致 objectType=2/3/4 时连自己该填的那个字段也被判为空 -> P14 反向失效、
     *    POST/PUT /policies 对 2/3/4 全部 422。这 4 个用例是回归防线。
     */
    public function testObjectTypeMatrixAllFourTypes(): void
    {
        // ---- objectType=1 全部对象：三个字段都可以不给 ----
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding([], 1, $errors);
        $this->assertTrue($errors->passes(), 'objectType=1 应当通过：' . json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertNull($result['object_ids']);
        $this->assertNull($result['object_group_ids']);
        $this->assertNull($result['object_filters']);

        // ---- objectType=2 指定实例：只给 objectIds ----
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding(['objectIds' => [8801, 8802]], 2, $errors);
        $this->assertTrue($errors->passes(), 'objectType=2 应当通过：' . json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame([8801, 8802], $result['object_ids']);

        // ---- objectType=3 实例分组：只给 objectGroupIds ----
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding(['objectGroupIds' => [11, 12]], 3, $errors);
        $this->assertTrue($errors->passes(), 'objectType=3 应当通过：' . json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame([11, 12], $result['object_group_ids']);

        // ---- objectType=4 多维筛选：只给 objectFilters ----
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding([
            'objectFilters' => [['key' => 'env', 'operator' => '==', 'values' => ['prod']]],
        ], 4, $errors);
        $this->assertTrue($errors->passes(), 'objectType=4 应当通过：' . json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame('env', $result['object_filters'][0]['key']);
    }

    /** objectType=1 时带上任一绑定字段都必须被拒（4 个类型里唯一的「全空」约束） */
    #[DataProvider('objectFieldProvider')]
    public function testObjectTypeOneRejectsAnyBoundField(string $field, array $value): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([$field => $value], 1, $errors);

        $this->assertArrayHasKey($field, $errors->errors(), "objectType=1 不应接受 $field");
    }

    public static function objectFieldProvider(): array
    {
        return [
            'objectIds' => ['objectIds', [8801]],
            'objectGroupIds' => ['objectGroupIds', [11]],
            'objectFilters' => ['objectFilters', [['key' => 'env', 'operator' => '==', 'values' => ['prod']]]],
        ];
    }

    /** 2/3/4 之间不能串字段：objectType=2 不接受 objectGroupIds，以此类推 */
    #[DataProvider('crossFieldProvider')]
    public function testObjectTypeRejectsFieldsOfOtherTypes(int $objectType, string $field, array $value): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([$field => $value], $objectType, $errors);

        $this->assertArrayHasKey($field, $errors->errors());
    }

    public static function crossFieldProvider(): array
    {
        return [
            '2 + groupIds' => [2, 'objectGroupIds', [11]],
            '2 + filters' => [2, 'objectFilters', [['key' => 'env', 'operator' => '==', 'values' => ['p']]]],
            '3 + objectIds' => [3, 'objectIds', [8801]],
            '3 + filters' => [3, 'objectFilters', [['key' => 'env', 'operator' => '==', 'values' => ['p']]]],
            '4 + objectIds' => [4, 'objectIds', [8801]],
            '4 + groupIds' => [4, 'objectGroupIds', [11]],
        ];
    }

    public function testObjectTypeOneRejectsAnyObjectField(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding(['objectIds' => [1]], 1, $errors);

        $this->assertArrayHasKey('objectIds', $errors->errors());
    }

    public function testObjectTypeTwoRequiresObjectIds(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([], 2, $errors);

        $this->assertArrayHasKey('objectIds', $errors->errors());
    }

    public function testObjectTypeTwoAcceptsObjectIds(): void
    {
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding(['objectIds' => [8801, 8802]], 2, $errors);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame([8801, 8802], $result['object_ids']);
        // R-JSON-1 写列：不适用的字段必须是 null 而不是 []
        $this->assertNull($result['object_group_ids']);
        $this->assertNull($result['object_filters']);
    }

    public function testObjectTypeTwoRejectsGroupIds(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding(['objectIds' => [1], 'objectGroupIds' => [9]], 2, $errors);

        $this->assertArrayHasKey('objectGroupIds', $errors->errors());
    }

    public function testObjectTypeThreeRequiresGroupIds(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([], 3, $errors);

        $this->assertArrayHasKey('objectGroupIds', $errors->errors());
    }

    public function testObjectTypeFourRequiresFilters(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([], 4, $errors);

        $this->assertArrayHasKey('objectFilters', $errors->errors());
    }

    public function testObjectTypeFourAcceptsValidFilters(): void
    {
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding([
            'objectFilters' => [
                ['key' => 'region', 'operator' => '==', 'values' => ['ap-guangzhou'], 'matchType' => 'include'],
            ],
        ], 4, $errors);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertNull($result['object_ids']);
        $this->assertSame('region', $result['object_filters'][0]['key']);
    }

    /** objectFilters[].operator 是字符串枚举，不能用数值枚举的判定方式 */
    public function testObjectFilterOperatorIsStringEnum(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([
            'objectFilters' => [['key' => 'region', 'operator' => '>', 'values' => ['a']]],
        ], 4, $errors);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
    }

    public function testObjectFilterOperatorRejectsChineseLabel(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([
            'objectFilters' => [['key' => 'region', 'operator' => '大于', 'values' => ['a']]],
        ], 4, $errors);

        $this->assertArrayHasKey('objectFilters.0.operator', $errors->errors());
    }

    public function testObjectFilterRequiresKeyAndValues(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([
            'objectFilters' => [['operator' => '==', 'values' => []]],
        ], 4, $errors);

        $this->assertArrayHasKey('objectFilters.0.key', $errors->errors());
        $this->assertArrayHasKey('objectFilters.0.values', $errors->errors());
    }

    public function testObjectFilterMatchTypeMustBeIncludeOrExclude(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([
            'objectFilters' => [['key' => 'env', 'operator' => '==', 'values' => ['prod'], 'matchType' => 'both']],
        ], 4, $errors);

        $this->assertArrayHasKey('objectFilters.0.matchType', $errors->errors());
    }

    public function testObjectIdsUpperBound(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([
            'objectIds' => range(1, AlarmEnum::OBJECT_IDS_MAX + 1),
        ], 2, $errors);

        $this->assertArrayHasKey('objectIds', $errors->errors());
    }

    public function testObjectGroupIdsUpperBound(): void
    {
        $errors = new Validator();
        $this->validator()->assertObjectBinding([
            'objectGroupIds' => range(1, AlarmEnum::OBJECT_GROUP_IDS_MAX + 1),
        ], 3, $errors);

        $this->assertArrayHasKey('objectGroupIds', $errors->errors());
    }

    public function testObjectFiltersUpperBound(): void
    {
        $errors = new Validator();
        $filters = [];
        for ($i = 0; $i <= AlarmEnum::OBJECT_FILTERS_MAX; $i++) {
            $filters[] = ['key' => 'k' . $i, 'operator' => '==', 'values' => ['v']];
        }
        $this->validator()->assertObjectBinding(['objectFilters' => $filters], 4, $errors);

        $this->assertArrayHasKey('objectFilters', $errors->errors());
    }

    /** 三个字段全为空时，归一化成 NULL（R-JSON-1 写列） */
    public function testAllObjectFieldsNormalizeToNull(): void
    {
        $errors = new Validator();
        $result = $this->validator()->assertObjectBinding([
            'objectIds' => [], 'objectGroupIds' => [], 'objectFilters' => [],
        ], 1, $errors);

        $this->assertTrue($errors->passes());
        $this->assertNull($result['object_ids']);
        $this->assertNull($result['object_group_ids']);
        $this->assertNull($result['object_filters']);
    }

    // ------------------------------------------------------------ 分页（真实路径）

    /**
     * @param array<string, mixed> $query
     * @return array{page: int, pageSize: int}
     */
    private function paginate(array $query): array
    {
        // ⚠️ stub 的是 'getQueryParams()'（PSR-7 标准方法），
        //    不是 'input()'。input() 是 Hyperf 的 Macroable 扩展，
        //    只有起真实服务、由 http-server 的 ConfigProvider 注册宏之后才存在。
        //    桩上只定义 input() 会让测试「通过」，而生产代码走的是另一条路 ——
        //    这正是本轮 3 个真生产 bug 之一的成因模式。
        $request = $this->createMock(RequestInterface::class);
        $request->method('getQueryParams')->willReturn($query);

        return Pagination::fromRequest($request);
    }

    public function testPaginationDefaults(): void
    {
        $this->assertSame(
            ['page' => AlarmEnum::PAGE_DEFAULT, 'pageSize' => AlarmEnum::PAGE_SIZE_DEFAULT],
            $this->paginate([])
        );
    }

    public function testPaginationAcceptsValidValues(): void
    {
        $this->assertSame(['page' => 3, 'pageSize' => 50], $this->paginate(['page' => '3', 'pageSize' => '50']));
    }

    #[DataProvider('pageSizeProvider')]
    public function testPaginationRejectsOutOfRangePageSize(mixed $pageSize): void
    {
        try {
            $this->paginate(['pageSize' => $pageSize]);
            $this->fail('pageSize=' . var_export($pageSize, true) . ' 应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(422, $e->getBizCode());
            $this->assertSame('pageSize', $e->getErrors()[0]['field']);
        }
    }

    /** 越界 + 非数字，两类都必须是 422 */
    public static function pageSizeProvider(): array
    {
        return [[0], [101], [-1], ['abc'], ['1.5'], ['1e3'], [[]]];
    }

    /** 非数字**不再**静默回落默认值（审查第 2 条：回落会掩盖调用方 bug） */
    #[DataProvider('nonNumericProvider')]
    public function testPaginationRejectsNonNumericInput(string $field, mixed $value): void
    {
        try {
            $this->paginate([$field => $value]);
            $this->fail($field . '=' . var_export($value, true) . ' 应当 422 而不是回落默认值');
        } catch (BusinessException $e) {
            $this->assertSame(422, $e->getBizCode());
            $errors = $e->getErrors();
            $this->assertSame($field, $errors[0]['field'], '422 必须指明是哪个字段坏了');
            $this->assertSame('必须是整数', $errors[0]['message']);
        }
    }

    public static function nonNumericProvider(): array
    {
        return [
            ['page', 'abc'], ['page', '1.5'], ['page', '1e3'],
            ['pageSize', 'abc'], ['pageSize', '20.0'], ['pageSize', 'twenty'],
        ];
    }

    /** 缺省 / 空串才回落默认值，与「非数字报错」严格区分 */
    public function testPaginationAbsentFallsBackButGarbageDoesNot(): void
    {
        // 缺省 -> 默认值
        $this->assertSame(['page' => 1, 'pageSize' => 20], $this->paginate([]));
        // 空串 -> 默认值
        $this->assertSame(['page' => 1, 'pageSize' => 20], $this->paginate(['page' => '', 'pageSize' => '']));
        // 非数字 -> 422（由上面的 testPaginationRejectsNonNumericInput 覆盖）
        $this->expectException(BusinessException::class);
        $this->paginate(['page' => 'abc']);
    }

    public function testPaginationRejectsPageBelowOne(): void
    {
        try {
            $this->paginate(['page' => 0]);
            $this->fail('page=0 应当 422');
        } catch (BusinessException $e) {
            $this->assertSame(422, $e->getBizCode());
            $this->assertSame('page', $e->getErrors()[0]['field']);
        }
    }

    public function testPaginationEmptyStringFallsBackToDefault(): void
    {
        $this->assertSame(
            ['page' => AlarmEnum::PAGE_DEFAULT, 'pageSize' => AlarmEnum::PAGE_SIZE_DEFAULT],
            $this->paginate(['page' => '', 'pageSize' => ''])
        );
    }

    // ------------------------------------------------------------------ 辅助

    private function makeTemplate(int $id, string $name, int $channel, bool $isPreset, array $receivers = null): AlarmNotificationTemplate
    {
        $template = new AlarmNotificationTemplate();
        $template->id = $id;
        $template->name = $name;
        $template->is_preset = $isPreset ? 1 : 0;
        $template->channels = json_encode([
            [
                'channel' => $channel,
                'receivers' => $receivers ?? [],
                'callbackUrl' => $channel === AlarmEnum::CHANNEL_CALLBACK ? 'https://example.com/hook' : null,
                'silenceTime' => 0,
            ],
        ], JSON_UNESCAPED_UNICODE);

        return $template;
    }
}
