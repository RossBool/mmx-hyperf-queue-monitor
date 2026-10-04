<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Constants\AlarmEnum;
use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use App\Service\Metric\MetricDictionary;
use App\Service\Validator\ChannelValidator;
use App\Service\Validator\ConditionValidator;
use App\Support\Text;
use App\Support\Validator;
use Hyperf\Contract\ConfigInterface;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * 业务规则单元测试（不连数据库）。
 *
 * 覆盖契约 §4 的核心规则：
 *   名称唯一（P1/T1/N1 的长度与唯一性前置）、删除限制（P15 的前置条件）、
 *   复制命名（P16 / 契约 §3.1 ⑦）、条件数量与范围校验（P4-P11 / T2-T3）、
 *   历史状态机（H1 / H3）、JSON 归一化（§0.6 R-JSON-1/2）。
 */
class AlarmRuleTest extends TestCase
{
    private function dictionary(): MetricDictionary
    {
        // 指标字典来自 config/autoload/metrics.php（metrics.md 的机器可读副本）
        //
        // ⚠️ ConfigInterface 在 hyperf/contract 3.2 里有 **3 个**方法：
        //    get / has / set。只实现 get 会在**类加载时**致命错误：
        //      Class ...@anonymous contains 2 abstract methods and must therefore
        //      be declared abstract or implement the remaining methods
        //    这条错误发生在 PHPUnit 收集阶段，表现为「一个测试都没跑」。
        $config = new class() implements ConfigInterface {
            public function get(string $key, mixed $default = null): mixed
            {
                if ($key !== 'metrics') {
                    return $default;
                }
                return require BASE_PATH . '/config/autoload/metrics.php';
            }

            public function has(string $keys): bool
            {
                return $keys === 'metrics';
            }

            public function set(string $key, mixed $value): void
            {
                // 测试只读，不需要写
            }
        };

        return new MetricDictionary($config);
    }

    private function conditions(): ConditionValidator
    {
        return new ConditionValidator($this->dictionary());
    }

    /** @return array<int, array<string, mixed>> */
    private function validCondition(int $sort = 1): array
    {
        return [
            'sort' => $sort,
            'metricNamespace' => 'CVM',
            'metricName' => 'CpuUtilizationRate',
            'operator' => '>',
            'threshold' => 80,
            'period' => 5,
            'continuity' => 3,
            'level' => 2,
            'frequency' => 30,
        ];
    }

    // ------------------------------------------------------------ P4 / T2 条件条数

    public function testConditionsMustBeBetweenOneAndFour(): void
    {
        $errors = new Validator();
        $result = $this->conditions()->validate([], 2, $errors);

        $this->assertSame([], $result);
        $this->assertArrayHasKey('conditions', $errors->errors());
    }

    public function testFiveConditionsAreRejected(): void
    {
        $errors = new Validator();
        $conditions = [];
        for ($i = 1; $i <= 5; $i++) {
            $conditions[] = $this->validCondition($i);
        }

        $this->conditions()->validate($conditions, 2, $errors);

        $this->assertFalse($errors->passes());
        $this->assertStringContainsString('1-4', $errors->errors()['conditions']);
    }

    // ------------------------------------------------------------ P5 sort 连续升序

    public function testSortMustBeContinuousAscending(): void
    {
        $errors = new Validator();
        $this->conditions()->validate([
            array_merge(['sort' => 1], $this->validCondition()),
            ['sort' => 3] + $this->validCondition(),   // 跳号
        ], 2, $errors);

        $this->assertStringContainsString('1..N', $errors->errors()['conditions']);
    }

    public function testSortMustNotDuplicate(): void
    {
        $errors = new Validator();
        $this->conditions()->validate([
            array_merge(['sort' => 1], $this->validCondition()),
            array_merge(['sort' => 1], $this->validCondition()),   // 重复
        ], 2, $errors);

        $this->assertFalse($errors->passes());
    }

    // ------------------------------------------------------------ P6 threshold

    public function testThresholdAcceptsNegativeAndFourDecimals(): void
    {
        $errors = new Validator();
        $result = $this->conditions()->validate(
            [array_merge(['sort' => 1], $this->validCondition(), ['threshold' => -12.3456])],
            2,
            $errors
        );

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame(-12.3456, $result[0]['threshold']);
    }

    public function testThresholdRejectsMoreThanFourDecimals(): void
    {
        $errors = new Validator();
        $this->conditions()->validate(
            [array_merge(['sort' => 1], $this->validCondition(), ['threshold' => 1.234567])],
            2,
            $errors
        );

        $this->assertArrayHasKey('conditions.0.threshold', $errors->errors());
    }

    public function testThresholdRejectsNonNumeric(): void
    {
        $errors = new Validator();
        $this->conditions()->validate(
            [array_merge(['sort' => 1], $this->validCondition(), ['threshold' => 'abc'])],
            2,
            $errors
        );

        $this->assertArrayHasKey('conditions.0.threshold', $errors->errors());
    }

    // ------------------------------------------------------------ P7 / P8 / P9 / P11 枚举与范围

    #[DataProvider('continuityProvider')]
    public function testContinuityRange(int $value, bool $valid): void
    {
        $errors = new Validator();
        $this->conditions()->validate([array_merge(['sort' => 1], $this->validCondition(), ['continuity' => $value])], 2, $errors);

        $this->assertSame($valid, ! array_key_exists('conditions.0.continuity', $errors->errors()));
    }

    public static function continuityProvider(): array
    {
        return [[0, false], [1, true], [5, true], [10, true], [11, false]];
    }

    public function testPeriodMustBeInGlobalEnumAndMetricPeriodOptions(): void
    {
        // CVM.DiskUsageRate 的 periodOptions 是 [30,60]，period=5 全局合法但不在子集内
        $errors = new Validator();
        $this->conditions()->validate([[
            'sort' => 1,
            'metricNamespace' => 'CVM',
            'metricName' => 'DiskUsageRate',
            'operator' => '>',
            'threshold' => 85,
            'period' => 5,
            'continuity' => 2,
            'level' => 2,
            'frequency' => 180,
        ]], 2, $errors);

        $this->assertArrayHasKey('conditions.0.period', $errors->errors());
        $this->assertStringContainsString('30/60', $errors->errors()['conditions.0.period']);
    }

    public function testPeriodNotInGlobalEnumIsRejected(): void
    {
        $errors = new Validator();
        $this->conditions()->validate([array_merge(['sort' => 1], $this->validCondition(), ['period' => 3])], 2, $errors);

        $this->assertArrayHasKey('conditions.0.period', $errors->errors());
    }

    #[DataProvider('operatorProvider')]
    public function testOperatorEnum(string $operator, bool $valid): void
    {
        $errors = new Validator();
        $this->conditions()->validate([array_merge(['sort' => 1], $this->validCondition(), ['operator' => $operator])], 2, $errors);

        $this->assertSame($valid, ! array_key_exists('conditions.0.operator', $errors->errors()));
    }

    public static function operatorProvider(): array
    {
        return [['>', true], ['>=', true], ['<', true], ['<=', true], ['==', true], ['!=', true], ['大于', false]];
    }

    #[DataProvider('frequencyProvider')]
    public function testFrequencyEnum(int $value, bool $valid): void
    {
        $errors = new Validator();
        $this->conditions()->validate([array_merge(['sort' => 1], $this->validCondition(), ['frequency' => $value])], 2, $errors);

        $this->assertSame($valid, ! array_key_exists('conditions.0.frequency', $errors->errors()));
    }

    public static function frequencyProvider(): array
    {
        // 0=不重复 是本模块扩展值，9 个取值全部合法
        return [[0, true], [5, true], [1440, true], [1, false], [10, false]];
    }

    // ------------------------------------------------------------ P10 字段完整性

    public function testConditionFieldsAreAllRequired(): void
    {
        $errors = new Validator();
        $this->conditions()->validate([['sort' => 1]], 2, $errors);

        foreach (['metricNamespace', 'metricName', 'operator', 'threshold', 'period', 'continuity', 'level', 'frequency'] as $field) {
            $this->assertArrayHasKey('conditions.0.' . $field, $errors->errors(), $field . ' 应当必填');
        }
    }

    // ------------------------------------------------------------ T3 / P3 namespace 归属

    public function testNamespaceMustBelongToPolicyType(): void
    {
        // policyType=1（通用 Web 服务）只能用 WEB namespace
        $errors = new Validator();
        $this->conditions()->validate([$this->validCondition()], 1, $errors);

        $this->assertArrayHasKey('conditions.0.metricNamespace', $errors->errors());
    }

    public function testUnknownMetricIsRejected(): void
    {
        $errors = new Validator();
        $this->conditions()->validate([
            array_merge(['sort' => 1], $this->validCondition(), ['metricName' => 'NoSuchMetric']),
        ], 2, $errors);

        $this->assertArrayHasKey('conditions.0.metricName', $errors->errors());
    }

    // ------------------------------------------------------------ 字典回填

    public function testDictionaryFieldsAreBackfilledAndRequestValuesIgnored(): void
    {
        $errors = new Validator();
        $result = $this->conditions()->validate([
            array_merge(['sort' => 1], $this->validCondition(), ['metricNameCn' => '前端乱填', 'unit' => 'X']),
        ], 2, $errors);

        $this->assertTrue($errors->passes());
        $this->assertSame('CPU 使用率', $result[0]['metricNameCn']);
        $this->assertSame('%', $result[0]['unit']);
    }

    // ------------------------------------------------------------ P17 level 派生

    public function testPolicyLevelIsMinOfConditionLevels(): void
    {
        $method = new \ReflectionMethod(\App\Service\AlarmPolicyService::class, 'deriveLevel');
        $method->setAccessible(true);

        $this->assertSame(1, $method->invoke(null, [['level' => 2], ['level' => 1], ['level' => 3]]));
        $this->assertSame(3, $method->invoke(null, [['level' => 3], ['level' => 3]]));
    }

    // ------------------------------------------------------------ N2-N6 渠道校验

    public function testChannelsMustBeBetweenOneAndFive(): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([], $errors);

        $this->assertArrayHasKey('channels', $errors->errors());
    }

    public function testChannelMustNotDuplicate(): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([
            ['channel' => 1, 'receivers' => ['a@b.com'], 'callbackUrl' => null, 'silenceTime' => 0],
            ['channel' => 1, 'receivers' => ['c@d.com'], 'callbackUrl' => null, 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.1.channel', $errors->errors());
    }

    public function testCallbackChannelRequiresUrlAndEmptyReceivers(): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([
            ['channel' => 5, 'receivers' => ['someone'], 'callbackUrl' => null, 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.0.callbackUrl', $errors->errors());
        $this->assertArrayHasKey('channels.0.receivers', $errors->errors());
    }

    public function testCallbackChannelAcceptsHttpUrl(): void
    {
        $errors = new Validator();
        $result = (new ChannelValidator())->validate([
            ['channel' => 5, 'receivers' => [], 'callbackUrl' => 'https://example.com/hook', 'silenceTime' => 0],
        ], $errors);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame('https://example.com/hook', $result[0]['callbackUrl']);
    }

    public function testNonCallbackChannelRejectsCallbackUrl(): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([
            ['channel' => 1, 'receivers' => ['a@b.com'], 'callbackUrl' => 'https://x.com', 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.0.callbackUrl', $errors->errors());
    }

    /**
     * N3：callbackUrl 最长 **500** 字符。
     *
     * ⚠️ 上一轮为了塞进 alarm_notification_receiver.contact 的 VARCHAR(255)，
     *    把这个上限私自收到了 255 —— 那是对契约的偏离。现已改为不再把回调地址
     *    镜像进该冗余表（契约 §2.8：读取一律以 channels 为准），冲突消失，
     *    这里恢复并锁定契约的 500。
     */
    public function testCallbackUrlAcceptsUpToFiveHundredChars(): void
    {
        $errors = new Validator();
        $url = 'https://example.com/' . str_repeat('a', 500 - strlen('https://example.com/'));
        $this->assertSame(500, mb_strlen($url));

        (new ChannelValidator())->validate([
            ['channel' => 5, 'receivers' => [], 'callbackUrl' => $url, 'silenceTime' => 0],
        ], $errors);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
    }

    public function testCallbackUrlRejectsOverFiveHundredChars(): void
    {
        $errors = new Validator();
        $url = 'https://example.com/' . str_repeat('a', 501 - strlen('https://example.com/'));

        (new ChannelValidator())->validate([
            ['channel' => 5, 'receivers' => [], 'callbackUrl' => $url, 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.0.callbackUrl', $errors->errors());
    }

    /** 接收人仍受 contract VARCHAR(255) 约束（这不偏离契约，是实现 DDL 列宽） */
    public function testReceiversAreCappedAtColumnWidth(): void
    {
        $this->assertSame(255, AlarmEnum::RECEIVER_CONTACT_MAX);
        $this->assertSame(500, AlarmEnum::CALLBACK_URL_MAX);
    }

    public function testCallbackUrlMustStartWithHttpScheme(): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([
            ['channel' => 5, 'receivers' => [], 'callbackUrl' => 'ftp://example.com', 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.0.callbackUrl', $errors->errors());
    }

    /** N5：receivers 是 0-100（预置模板出厂即为空占位），不是 1-100 */
    public function testReceiversMayBeEmptyForPresetTemplates(): void
    {
        $errors = new Validator();
        $result = (new ChannelValidator())->validate([
            ['channel' => 1, 'receivers' => [], 'callbackUrl' => null, 'silenceTime' => 0],
        ], $errors);

        $this->assertTrue($errors->passes(), json_encode($errors->errors(), JSON_UNESCAPED_UNICODE));
        $this->assertSame([], $result[0]['receivers']);
    }

    public function testReceiversAreFormatCheckedPerChannel(): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([
            ['channel' => 1, 'receivers' => ['not-an-email'], 'callbackUrl' => null, 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.0.receivers.0', $errors->errors());
    }

    public function testReceiversCannotExceedOneHundred(): void
    {
        $errors = new Validator();
        $receivers = [];
        for ($i = 0; $i < AlarmEnum::RECEIVER_MAX + 1; $i++) {
            $receivers[] = "user{$i}@example.com";
        }
        (new ChannelValidator())->validate([
            ['channel' => 1, 'receivers' => $receivers, 'callbackUrl' => null, 'silenceTime' => 0],
        ], $errors);

        $this->assertArrayHasKey('channels.0.receivers', $errors->errors());
    }

    #[DataProvider('silenceTimeProvider')]
    public function testSilenceTimeRange(int $value, bool $valid): void
    {
        $errors = new Validator();
        (new ChannelValidator())->validate([
            ['channel' => 1, 'receivers' => ['a@b.com'], 'callbackUrl' => null, 'silenceTime' => $value],
        ], $errors);

        $this->assertSame($valid, ! array_key_exists('channels.0.silenceTime', $errors->errors()));
    }

    public static function silenceTimeProvider(): array
    {
        return [[0, true], [60, true], [1440, true], [-1, false], [1441, false]];
    }

    // ------------------------------------------------------------ H1 历史状态机

    #[DataProvider('handleActionProvider')]
    public function testHandleActionMapping(string $action, int $expectedStatus): void
    {
        $this->assertSame($expectedStatus, AlarmEnum::HANDLE_ACTION[$action]);
    }

    public static function handleActionProvider(): array
    {
        return [['handle', 2], ['ignore', 3], ['recover', 4]];
    }

    public function testHandleActionEnumHasExactlyThreeValues(): void
    {
        $this->assertSame(['handle', 'ignore', 'recover'], array_keys(AlarmEnum::HANDLE_ACTION));
        $this->assertSame(1, AlarmEnum::HISTORY_STATUS_UNHANDLED);
    }

    // ------------------------------------------------------------ P15 / T4 / N7 冲突码

    public function testConflictCodesShareCodeWithDistinctMessages(): void
    {
        // 契约 §0.5「同码多义」：409 下 5 个契约语义分支 + S-09 增量扩展的 RELATION_CONFLICT = 6。
        // code 相同、message 不同。
        //
        // ⚠️ 必须按**语义分支**取值：5 个数值常量求值都是 409，
        // `ErrorCode::message(409)` 只能返回一个字符串，这个断言在按数值码写时
        // 永远不可能成立（早期实现因此让 5 条文案塌缩成 1 条）。
        $reasons = [
            ErrorCode::REASON_POLICY_STATUS_CONFLICT,
            ErrorCode::REASON_POLICY_NAME_DUPLICATED,
            ErrorCode::REASON_TEMPLATE_IN_USE,
            ErrorCode::REASON_PRESET_READONLY,
            ErrorCode::REASON_HISTORY_ALREADY_HANDLED,
        ];

        $messages = [];
        foreach ($reasons as $reason) {
            $this->assertSame(409, ErrorCode::codeForReason($reason), '5 个 409 分支上线码必须都是 409');
            $messages[] = ErrorCode::messageForReason($reason);
        }
        $this->assertCount(5, array_unique($messages), '5 个 409 分支的 message 必须各不相同');
    }

    public function testConflictMustGoThroughSemanticReason(): void
    {
        // 409 的文案不能靠数值码兜底：直接 new BusinessException(409) 必须当场报错，
        // 而不是静默发出错误文案。
        $this->expectException(\LogicException::class);
        new BusinessException(ErrorCode::POLICY_STATUS_CONFLICT);
    }

    public function testConflictFactoryResolvesReasonToCodeAndMessage(): void
    {
        $e = BusinessException::conflict(ErrorCode::REASON_PRESET_READONLY);
        $this->assertSame(409, $e->getBizCode());
        $this->assertSame('预置模板不可删除', $e->getMessage());

        $e2 = BusinessException::conflict(
            ErrorCode::REASON_TEMPLATE_IN_USE,
            '模板已被策略「生产 CVM」引用，不可删除',
        );
        $this->assertSame(409, $e2->getBizCode(), '显式文案不应改变上线码');
        $this->assertSame('模板已被策略「生产 CVM」引用，不可删除', $e2->getMessage());
    }

    public function testBusinessExceptionCarriesFieldErrors(): void
    {
        $e = BusinessException::validation(['conditions.0.period' => '统计周期必须是 1/5/10/30/60 之一']);

        $this->assertSame(422, $e->getBizCode());
        $errors = $e->getErrors();
        $this->assertSame('conditions.0.period', $errors[0]['field']);
        $this->assertSame('统计周期必须是 1/5/10/30/60 之一', $errors[0]['message']);
    }

    // ------------------------------------------------------------ §0.6 JSON 归一化

    public function testNullIntListStaysNullForObjectFields(): void
    {
        // R-JSON-1：objectIds / objectGroupIds / objectFilters 永远输出 null
        $this->assertNull(\App\Support\Presenter::nullableIntList(null));
        $this->assertSame([8801, 8802], \App\Support\Presenter::nullableIntList('[8801,8802]'));
    }

    public function testNullIntListBecomesEmptyArrayForNotificationTemplateIds(): void
    {
        // R-JSON-2：notificationTemplateIds 是唯一声明为非空 int[] 的 JSON 字段
        $this->assertSame([], \App\Support\Presenter::intList(null));
        $this->assertSame([3, 5], \App\Support\Presenter::intList('[3,5]'));
    }

    /**
     * 真实 bug 回归：`intList('[8801,8802]')` 曾返回 `[0]`。
     *
     * 旧实现 `array_map('intval', array_values((array) $value))` 遇到 JSON 字符串时
     * 先 `(array)` 成 `['[8801,8802]']`，再 `intval('[8801,8802]')` —— 字符串以 `[`
     * 开头没有数字前缀，PHP 直接给 **0**。
     * 于是 `notificationTemplateIds` 变成 `[0]`，
     * `notificationTemplateSummaries([0])` 去查一个不存在的模板 id。
     *
     * 主路径靠 Model 的 `'array'` cast 侥幸没踩到，
     * 但任何 `Db::table()->select()` 或漏配 cast 的 Model 都会踩。
     * 所以这里逐个输入形态都钉死，不只测「有 cast 的那条路」。
     */
    #[DataProvider('intListInputProvider')]
    public function testIntListHandlesEveryInputShape(mixed $input, array $expected): void
    {
        $this->assertSame($expected, \App\Support\Presenter::intList($input));
    }

    public static function intListInputProvider(): array
    {
        return [
            'SQL NULL'          => [null, []],
            '空 PHP 数组'        => [[], []],
            '空 JSON 串'         => ['[]', []],
            '空串'              => ['', []],
            '纯空白'             => ['   ', []],
            'JSON 数组串（DB 原生）' => ['[8801,8802]', [8801, 8802]],
            'PHP 数组（cast 后）'  => [[8801, 8802], [8801, 8802]],
            '逗号分隔'           => ['8801,8802', [8801, 8802]],
            '单值'              => [8801, [8801]],
            '脏数据跳过非数字'    => ['[8801,"x",8802]', [8801, 8802]],
            '嵌套结构被跳过'      => ['[{"a":1}]', []],
            '无法解析的串不伪造 id' => ['[not json', []],
        ];
    }

    /** nullableIntList 必须在「真的是 null」时保持 null，其余形态与 intList 一致 */
    #[DataProvider('intListInputProvider')]
    public function testNullableIntListMirrorsIntListExceptForNull(mixed $input, array $expected): void
    {
        $this->assertSame(
            $input === null ? null : $expected,
            \App\Support\Presenter::nullableIntList($input)
        );
    }

    public function testPolicyJsonColumnsAreNormalizedToSqlNullOnWrite(): void
    {
        // ⚠️ 调 `AlarmPolicy::normalizeJsonForWrite()`（**静态**），
        //    不是 `$policy->normalizeForWrite()` —— 后者在本项目里根本不存在，
        //    调用会抛 `Call to undefined method Hyperf\Database\Query\Builder::normalizeForWrite()`。
        //    方法名和静态性都写错，说明这条测试从写下来那天起就没被执行过。
        $normalized = \App\Model\AlarmPolicy::normalizeJsonForWrite([
            'object_ids' => [],
            'object_group_ids' => null,
            'object_filters' => null,
            'notification_template_ids' => [],
        ]);

        // ⚠️ 绝不能是字符串 'null' 或 '[]'，否则 JSON_CONTAINS 引用检查会失效
        foreach (['object_ids', 'object_group_ids', 'object_filters', 'notification_template_ids'] as $col) {
            $this->assertArrayHasKey($col, $normalized, $col . ' 应被处理而不是被丢掉');
            $this->assertNull($normalized[$col], $col . ' 必须是真正的 SQL NULL');
        }
    }

    public function testPolicyJsonColumnsKeepRealArrays(): void
    {
        $normalized = \App\Model\AlarmPolicy::normalizeJsonForWrite([
            'object_ids' => [8801, 8802],
            'notification_template_ids' => [3, 5],
        ]);

        $this->assertSame('[8801,8802]', $normalized['object_ids']);
        $this->assertSame('[3,5]', $normalized['notification_template_ids']);
    }

    // ------------------------------------------------------------ 复制命名（契约 §3.1 ⑦）

    public function testCopySuffixIsFiveCharacters(): void
    {
        // ` - 副本` = 5 字符 / 9 字节（契约 §3.1 ⑦）
        $this->assertSame(5, Text::length(' - 副本'));
        $this->assertSame(8, Text::length(' - 副本(2)'));
        $this->assertSame(9, strlen(' - 副本'));
    }

    public function testTruncateUsesCharactersNotBytes(): void
    {
        $name = str_repeat('告', 128);   // 128 字符 = 384 字节

        $truncated = Text::truncateChars($name, AlarmEnum::POLICY_NAME_MAX - 5);

        $this->assertSame(123, Text::length($truncated));
        $this->assertSame(123 * 3, strlen($truncated), '按字符截断后不应切出半截字符');
        $this->assertTrue(mb_check_encoding($truncated, 'UTF-8'), '不得切出半截 UTF-8 字符');

        // ⚠️ 关键区分用例：ASCII + 汉字混排。
        //    旧实现用 `mb_strcut($s, 0, 123, 'UTF-8')`，第三个参数是**字节宽度**，
        //    它保证不切出半个字符，代价是**凑不满就少给** ——
        //    `"ABC" + 100 个"告"` 切 5 字节时只得到 `"ABC"`，后面的字被静默丢弃。
        //    用 `mb_substr` 才是「取前 N 个字符」。
        $mixed = 'ABC' . str_repeat('告', 100);
        $this->assertSame(5, Text::length(Text::truncateChars($mixed, 5)));
        $this->assertSame('ABC告告', Text::truncateChars($mixed, 5));

        // 123 是「字符数上限」而不是「字节数上限」：纯中文串必须真的给出 123 个字
        $this->assertSame(
            str_repeat('告', 123),
            $truncated,
            'mb_strcut 会把 123 当字节数用，只给出 41 个字；必须是 mb_substr 的按字符语义。'
        );
    }

    /** 注释声称的 ESCAPE 子句必须真的出现在 SQL 片段里（上一轮只写在注释里） */
    public function testLikeConditionEmitsEscapeClause(): void
    {
        $fragment = Text::likeCondition('name');

        $this->assertStringContainsString('name', $fragment);
        $this->assertStringContainsString('LIKE ?', $fragment);
        $this->assertStringContainsString('ESCAPE', $fragment);
        // PHP 单引号 '\\\\' -> 两个字面反斜杠 -> MySQL 解析成一个反斜杠转义符
        $this->assertSame("name LIKE ? ESCAPE '\\\\'", $fragment);
    }

    public function testLikeKeywordIsEscaped(): void
    {
        $this->assertSame('100\\%', Text::escapeLike('100%'));
        $this->assertSame('a\\_b', Text::escapeLike('a_b'));
        $this->assertSame('\\\\x', Text::escapeLike('\\x'));
        $this->assertSame('%CPU%', Text::likeExpression('CPU'));
    }

    public function testValidatorReportsWhetherAFieldFailed(): void
    {
        $errors = new Validator();
        $this->assertFalse($errors->hasError('name'));

        $errors->add('name', '策略名称长度必须为 1-128 个字符');
        $this->assertTrue($errors->hasError('name'));
        $this->assertFalse($errors->hasError('remark'));
    }

    // ------------------------------------------------------------ 指标字典自检

    public function testMetricDictionaryHasThirtyEightEntries(): void
    {
        $all = $this->dictionary()->all();

        $this->assertCount(38, $all);
        $this->assertSame('CPU 使用率', $this->dictionary()->find('CVM', 'CpuUtilizationRate')['metricNameCn']);
    }

    public function testEveryMetricHasTenFields(): void
    {
        foreach ($this->dictionary()->all() as $metric) {
            $this->assertCount(10, $metric, $metric['namespace'] . '.' . $metric['metricName']);
        }
    }

    public function testMetricFilterByPolicyTypeAndKeyword(): void
    {
        $dictionary = $this->dictionary();

        // 38 条 = CVM 15 / WEB 9 / CLB 5 / MYSQL 9（第一性原理扩充 10 条后）
        $this->assertCount(9, $dictionary->filter(1, null, null));    // WEB
        $this->assertCount(5, $dictionary->filter(3, null, null));    // CLB
        $this->assertCount(9, $dictionary->filter(4, null, null));    // MYSQL
        $this->assertCount(1, $dictionary->filter(null, 'CVM', 'CPU 使用率'));
        $this->assertCount(15, $dictionary->filter(2, 'CVM', null));
    }

    /**
     * 4 个 namespace 的条数必须同时成立：加任何一条指标、删任何一条指标，这里都会红。
     *
     * 之前 MYSQL 完全没有条数断言（只有 WEB/CLB/CVM 三条），
     * 扩充指标时 MYSQL 少一条都发现不了 —— 这里补上。
     */
    public function testMetricNamespaceCounts(): void
    {
        $counts = ['CVM' => 0, 'WEB' => 0, 'CLB' => 0, 'MYSQL' => 0];
        foreach ($this->dictionary()->all() as $metric) {
            $this->assertArrayHasKey($metric['namespace'], $counts, $metric['metricName'] . ' 的 namespace 非法');
            ++$counts[$metric['namespace']];
        }

        $this->assertSame(['CVM' => 15, 'WEB' => 9, 'CLB' => 5, 'MYSQL' => 9], $counts);
    }

    // ------------------------------------------------------------ monitorType / policyType 联动

    public function testMonitorTypePolicyTypeMapping(): void
    {
        $this->assertSame([2, 3, 4], AlarmEnum::MONITOR_TYPE_POLICY_TYPES[1]);
        $this->assertSame([1], AlarmEnum::MONITOR_TYPE_POLICY_TYPES[2]);
        // 3/4/5 在 v1.0 暂无策略类型
        $this->assertSame([], AlarmEnum::MONITOR_TYPE_POLICY_TYPES[3]);
        $this->assertSame([], AlarmEnum::MONITOR_TYPE_POLICY_TYPES[4]);
        $this->assertSame([], AlarmEnum::MONITOR_TYPE_POLICY_TYPES[5]);
    }

    public function testPolicyTypeNamespaceMapping(): void
    {
        $this->assertSame('WEB', AlarmEnum::POLICY_TYPE_NAMESPACE[1]);
        $this->assertSame('CVM', AlarmEnum::POLICY_TYPE_NAMESPACE[2]);
        $this->assertSame('CLB', AlarmEnum::POLICY_TYPE_NAMESPACE[3]);
        $this->assertSame('MYSQL', AlarmEnum::POLICY_TYPE_NAMESPACE[4]);
    }
}
