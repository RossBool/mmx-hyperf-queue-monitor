<?php

declare(strict_types=1);

namespace App\Service\Validator;

use App\Constants\AlarmEnum;
use App\Service\Metric\MetricDictionary;
use App\Support\Validator;

/**
 * 触发条件校验 —— 契约 §4.1 P4-P11 / §4.2 T2-T3。
 *
 * 规则落点（domain.md §5.2）：
 *   P4  1-4 条                        -> validate() 条数判断
 *   P5  sort 为 1..N 连续升序不重复    -> assertSortSequence()
 *   P6  threshold 可负、<=4 位小数     -> assertThreshold()
 *   P7  continuity ∈ [1,10]          -> assertEnum()
 *   P8  period ∈ 枚举 且 ∈ periodOptions -> assertPeriodOptions()
 *   P9  operator ∈ 六种              -> assertStringEnum()（字符串枚举，⚠️ 不能用 assertEnum）
 *   P10 八字段完整，**不做默认值兜底**   -> required()
 *   P11 level / frequency 枚举       -> assertEnum()
 *   T2  字段完整性同 P4-P11
 *   T3  namespace 属于模板的 policyType -> belongsToPolicyType()
 */
class ConditionValidator
{
    public function __construct(private MetricDictionary $metrics)
    {
    }

    /**
     * 校验并归一化 conditions。
     *
     * @param mixed $conditions 请求体里的 conditions 数组
     * @param int|null $policyType 传入时校验 namespace 归属（T3 / P3）
     * @return array<int, array<string, mixed>> 归一化后的条件（含服务端回填的 metricNameCn/unit）
     */
    public function validate(mixed $conditions, ?int $policyType, Validator $errors, string $prefix = 'conditions'): array
    {
        // P10：只要条件数 >= 1，每条必须字段完整；conditions 省略或空 -> 1-4 条约束直接 422
        if (! is_array($conditions) || $conditions === []) {
            $errors->add($prefix, sprintf(
                '触发条件必须为 %d-%d 条',
                AlarmEnum::CONDITION_MIN,
                AlarmEnum::CONDITION_MAX
            ));
            return [];
        }

        $count = count($conditions);
        // P4
        if ($count < AlarmEnum::CONDITION_MIN || $count > AlarmEnum::CONDITION_MAX) {
            $errors->add($prefix, sprintf(
                '触发条件必须为 %d-%d 条',
                AlarmEnum::CONDITION_MIN,
                AlarmEnum::CONDITION_MAX
            ));
            return [];
        }

        $normalized = [];
        $sorts = [];
        foreach (array_values($conditions) as $index => $raw) {
            $path = $prefix . '.' . $index;
            $condition = $this->validateOne((array) $raw, $path, $errors, $policyType);
            if ($condition !== []) {
                $normalized[] = $condition;
                $sorts[] = (int) $condition['sort'];
            }
        }

        // P5
        $this->assertSortSequence($sorts, $count, $errors, $prefix);

        return $normalized;
    }

    /**
     * @return array<string, mixed> 单条归一化后的条件；出错时返回 []
     */
    private function validateOne(array $raw, string $path, Validator $errors, ?int $policyType): array
    {
        $before = count($errors->errors());

        // P10：八字段必填，不做默认值兜底
        $required = [
            'sort' => '条件排序必须提供',
            'metricNamespace' => '指标命名空间必须提供',
            'metricName' => '指标英文名必须提供',
            'operator' => '比较关系必须提供',
            'threshold' => '阈值必须提供',
            'period' => '统计周期必须提供',
            'continuity' => '持续周期必须提供',
            'level' => '告警等级必须提供',
            'frequency' => '重复通知频率必须提供',
        ];
        foreach ($required as $key => $message) {
            if (! array_key_exists($key, $raw) || $raw[$key] === null || $raw[$key] === '') {
                $errors->add($path . '.' . $key, $message);
            }
        }

        $this->assertEnum($raw, 'sort', [1, 2, 3, 4], $path, $errors, '排序必须是 1-4 的整数');
        $this->assertEnum($raw, 'period', AlarmEnum::PERIOD, $path, $errors, '统计周期必须是 1/5/10/30/60 之一');
        $this->assertEnum($raw, 'continuity', range(AlarmEnum::CONTINUITY_MIN, AlarmEnum::CONTINUITY_MAX), $path, $errors, '持续周期必须是 1-10 的整数');
        $this->assertEnum($raw, 'level', array_keys(AlarmEnum::LEVEL), $path, $errors, '告警等级必须是 1/2/3 之一');
        $this->assertEnum($raw, 'frequency', AlarmEnum::FREQUENCY, $path, $errors, '重复通知频率必须是 0/5/15/30/60/180/360/720/1440 之一');
        // ⚠️ operator 是字符串枚举（> >= < <= == !=），**不能**走 assertEnum()：
        //    assertEnum() 内部用 is_numeric() 判定，is_numeric('>') === false，
        //    会把所有合法 operator 全部判为非法。必须走 assertStringEnum()。
        $this->assertStringEnum($raw, 'operator', AlarmEnum::OPERATOR, $path, $errors, '比较关系必须是 > >= < <= == != 之一');

        $threshold = $this->assertThreshold($raw['threshold'] ?? null, $path, $errors);
        $period = $this->assertPeriodOptions(
            (string) ($raw['metricNamespace'] ?? ''),
            (string) ($raw['metricName'] ?? ''),
            $raw['period'] ?? null,
            $path,
            $errors
        );

        $namespace = (string) ($raw['metricNamespace'] ?? '');
        $metricName = (string) ($raw['metricName'] ?? '');
        $metric = $this->metrics->find($namespace, $metricName);
        if ($namespace !== '' && $metricName !== '' && $metric === null) {
            $errors->add($path . '.metricName', '指标不存在于指标字典（namespace.metricName 未找到）');
        }

        // T3 / P3：namespace 必须属于该 policyType
        if ($policyType !== null && $metric !== null && ! $this->metrics->belongsToPolicyType($metric, $policyType)) {
            $errors->add($path . '.metricNamespace', sprintf('指标命名空间 %s 不属于该策略类型', $namespace));
        }

        if (count($errors->errors()) > $before) {
            return [];
        }

        // metricNameCn / unit 是派生数据，**永远由服务端从字典回填**（契约 §2.1），请求值一律忽略
        return [
            'sort' => (int) $raw['sort'],
            'metricNamespace' => $namespace,
            'metricName' => $metricName,
            'metricNameCn' => (string) ($metric['metricNameCn'] ?? ''),
            'unit' => (string) ($metric['unit'] ?? ''),
            'operator' => (string) $raw['operator'],
            'threshold' => $threshold,
            'period' => $period,
            'continuity' => (int) $raw['continuity'],
            'level' => (int) $raw['level'],
            'frequency' => (int) $raw['frequency'],
        ];
    }

    /** P5：sort 必须是 1..N 连续升序且不重复 */
    private function assertSortSequence(array $sorts, int $count, Validator $errors, string $prefix): void
    {
        if (count($sorts) !== $count) {
            return; // 已有 per-field 错误，不重复报
        }
        sort($sorts);
        if ($sorts !== range(1, $count)) {
            $errors->add($prefix, 'conditions[].sort 必须为 1..N 连续升序且不重复');
        }
    }

    /** P6：数值、可负、最多 4 位小数 */
    private function assertThreshold(mixed $raw, string $path, Validator $errors): ?float
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        if (! is_int($raw) && ! is_float($raw) && ! (is_string($raw) && is_numeric($raw))) {
            $errors->add($path . '.threshold', '阈值必须是数值，可为负数');
            return null;
        }
        $value = (float) $raw;
        // 用字符串比对小数位数，避免 0.1+0.2 类浮点误差误判
        $text = rtrim(rtrim(sprintf('%.10F', $value), '0'), '.');
        $dot = strpos($text, '.');
        if ($dot !== false && strlen($text) - $dot - 1 > AlarmEnum::THRESHOLD_SCALE) {
            $errors->add($path . '.threshold', '阈值最多 4 位小数');
            return null;
        }
        return $value;
    }

    /** P8：period 既要在全局枚举内，也要在该指标的 periodOptions 子集内 */
    private function assertPeriodOptions(string $namespace, string $metricName, mixed $period, string $path, Validator $errors): ?int
    {
        if ($period === null || $period === '' || ! is_numeric($period)) {
            return null;
        }
        $metric = $this->metrics->find($namespace, $metricName);
        if ($metric === null) {
            return (int) $period; // 指标不存在已单独报错
        }
        $value = (int) $period;
        if (! in_array($value, $metric['periodOptions'], true)) {
            $errors->add($path . '.period', sprintf('该指标的统计周期必须是 %s 之一', implode('/', $metric['periodOptions'])));
        }
        return $value;
    }

    private function assertEnum(array $raw, string $key, array $allowed, string $path, Validator $errors, string $message): void
    {
        $value = $raw[$key] ?? null;
        if ($value === null || $value === '') {
            return; // required() 已记录
        }
        if (! is_numeric($value) || ! in_array((int) $value, $allowed, true)) {
            $errors->add($path . '.' . $key, $message);
        }
    }

    /**
     * 字符串枚举断言（契约 §1.5 的 operator、以及 §1.7 的 matchType 形态）。
     *
     * ⚠️ 绝不能用 assertEnum() 处理字符串枚举：它先做 is_numeric() 判定，
     *    而 is_numeric('>') === false，会把全部合法值判为非法。
     */
    private function assertStringEnum(array $raw, string $key, array $allowed, string $path, Validator $errors, string $message): void
    {
        $value = $raw[$key] ?? null;
        if ($value === null || $value === '') {
            return; // required() 已记录
        }
        if (! is_string($value) || ! in_array($value, $allowed, true)) {
            $errors->add($path . '.' . $key, $message);
        }
    }
}
