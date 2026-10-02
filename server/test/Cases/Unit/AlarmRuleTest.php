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
        $config = new class() implements ConfigInterface {
            public function get(string $key, mixed $default = null): mixed
            {
                if ($key !== 'metrics') {
                    return $default;
                }
                return require BASE_PATH . '/config/autoload/metrics.php';
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
            ['sort' => 1] + $this->validCondition(),
            ['sort' => 3] + $this->validCondition(),   // 跳号
        ], 2, $errors);

        $this->assertStringContainsString('1..N', $errors->errors()['conditions']);
    }

    public function testSortMustNotDuplicate(): void
    {
        $errors = new Validator();
        $this->conditions()->validate([
            ['sort' => 1] + $this->validCondition(),
            ['sort' => 1] + $this->validCondition(),   // 重复
        ], 2, $errors);

        $this->assertFalse($errors->passes());
    }

    // ------------------------------------------------------------ P6 threshold

    public function testThresholdAcceptsNegativeAndFourDecimals(): void
    {
        $errors = new Validator();
        $result = $this->conditions()->validate(
            [['sort' => 1] + $this->validCondition() + ['threshold' => -12.3456]],
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
            [['sort' => 1] + $this->validCondition() + ['threshold' => 1.234567]],
            2,
            $errors
        );

        $this->assertArrayHasKey('conditions.0.threshold', $errors->errors());
    }

    public function testThresholdRejectsNonNumeric(): void
    {
        $errors = new Validator();
        $this->conditions()->validate(
            [['sort' => 1] + $this->validCondition() + ['threshold' => 'abc']],
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
        $this->conditions()->validate([['sort' => 1] + $this->validCondition() + ['continuity' => $value]], 2, $errors);

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
        $this->conditions()->validate([['sort' => 1] + $this->validCondition() + ['period' => 3]], 2, $errors);

        $this->assertArrayHasKey('conditions.0.period', $errors->errors());
    }

    #[DataProvider('operatorProvider')]
    public function testOperatorEnum(string $operator, bool $valid): void
    {
        $errors = new Validator();
        $this->conditions()->validate([['sort' => 1] + $this->validCondition() + ['operator' => $operator]], 2, $errors);

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
        $this->conditions()->validate([['sort' => 1] + $this->validCondition() + ['frequency' => $value]], 2, $errors);

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
            ['sort' => 1] + $this->validCondition() + ['metricName' => 'NoSuchMetric'],
        ], 2, $errors);

        $this->assertArrayHasKey('conditions.0.metricName', $errors->errors());
    }

    // ------------------------------------------------------------ 字典回填

    public function testDictionaryFieldsAreBackfilledAndRequestValuesIgnored(): void
    {
        $errors = new Validator();
        $result = $this->conditions()->validate([
            ['sort' => 1] + $this->validCondition() + ['metricNameCn' => '前端乱填', 'unit' => 'X'],
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
        // 契约 §0.5「同码多义」：409 下 5 个语义分支，code 相同、message 不同
        $messages = [];
        foreach ([
            ErrorCode::POLICY_STATUS_CONFLICT,
            ErrorCode::POLICY_NAME_DUPLICATED,
            ErrorCode::TEMPLATE_IN_USE,
            ErrorCode::PRESET_READONLY,
            ErrorCode::HISTORY_ALREADY_HANDLED,
        ] as $code) {
            $this->assertSame(409, $code);
            $messages[] = ErrorCode::message($code);
        }
        $this->assertCount(5, array_unique($messages), '5 个 409 分支的 message 必须各不相同');
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

    public function testPolicyJsonColumnsAreNormalizedToSqlNullOnWrite(): void
    {
        $policy = new \App\Model\AlarmPolicy();
        $normalized = $policy->normalizeForWrite([
            'object_ids' => [],
            'object_group_ids' => null,
            'object_filters' => null,
            'notification_template_ids' => [],
        ]);

        // ⚠️ 绝不能是字符串 'null' 或 '[]'，否则 JSON_CONTAINS 引用检查会失效
        $this->assertNull($normalized['object_ids']);
        $this->assertNull($normalized['object_group_ids']);
        $this->assertNull($normalized['object_filters']);
        $this->assertNull($normalized['notification_template_ids']);
    }

    public function testPolicyJsonColumnsKeepRealArrays(): void
    {
        $policy = new \App\Model\AlarmPolicy();
        $normalized = $policy->normalizeForWrite([
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
        $this->assertSame(' - 副本', substr($truncated, -5) === ' - 副本' ? ' - 副本' : '');
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

    public function testMetricDictionaryHasTwentyEightEntries(): void
    {
        $all = $this->dictionary()->all();

        $this->assertCount(28, $all);
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

        $this->assertCount(8, $dictionary->filter(1, null, null));   // WEB 8
        $this->assertCount(4, $dictionary->filter(3, null, null));   // CLB 4
        $this->assertCount(1, $dictionary->filter(null, 'CVM', 'CPU 使用率'));
        $this->assertCount(10, $dictionary->filter(2, 'CVM', null));
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
