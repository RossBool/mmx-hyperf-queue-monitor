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
     * 采集静默条件（policyType=5）的校验与归一化。
     *
     * 允许的字段：sort / period / continuity / level / frequency。
     * 禁止的字段：metricNamespace / metricName / operator / threshold /
     *            compareMode / baselineType / baselineCount
     *
     * ⚠️ 禁止字段采用「**给了就报错**」而不是「静默忽略」。
     *    静默忽略的前端会以为配置生效了，实际上引擎根本不看这些字段 ——
     *    等发现「策略怎么都不触发」时，已经过了两个告警周期。
     *
     * 空串按「没传」处理：HTML 表单提交空输入框就是空串，不是 null。
     *
     * @return array<string, mixed> 出错时返回 []
     */
    private function validateSilenceCondition(array $raw, string $path, Validator $errors, int $before): array
    {
        $required = [
            'sort' => '条件排序必须提供',
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

        // 给了就报错（空串除外）
        $forbidden = [
            'metricNamespace' => '采集静默策略不绑定指标，不能设置 metricNamespace',
            'metricName' => '采集静默策略不绑定指标，不能设置 metricName',
            'operator' => '采集静默策略不绑定指标，不能设置 operator',
            'threshold' => '采集静默策略不绑定指标，静默时长请用策略的 targetFreshnessMinutes',
            'compareMode' => '采集静默策略没有相对判据，不能设置 compareMode',
            'baselineType' => '采集静默策略没有基线，不能设置 baselineType',
            'baselineCount' => '采集静默策略没有基线，不能设置 baselineCount',
        ];
        foreach ($forbidden as $key => $message) {
            if (! array_key_exists($key, $raw)) {
                continue;
            }
            $value = $raw[$key];
            if ($value === null || $value === '' || $value === []) {
                continue; // 空串 / 空数组 = 没传
            }
            $errors->add($path . '.' . $key, $message);
        }

        if (count($errors->errors()) > $before) {
            return [];
        }

        // 指标字段统一归一化成 null —— 不是 ''、不是 0。
        // Presenter 再把它们统一输出成 null，契约 §0.6 R-JSON-1。
        return [
            'sort' => (int) $raw['sort'],
            'metricNamespace' => null,
            'metricName' => null,
            'metricNameCn' => '',
            'unit' => '',
            'operator' => null,
            'threshold' => null,
            'period' => (int) $raw['period'],
            'continuity' => (int) $raw['continuity'],
            'level' => (int) $raw['level'],
            'frequency' => (int) $raw['frequency'],
            'compareMode' => null,
            'baselineType' => null,
            'baselineCount' => null,
        ];
    }

    /**
     * @return array<string, mixed> 单条归一化后的条件；出错时返回 []
     */
    private function validateOne(array $raw, string $path, Validator $errors, ?int $policyType): array
    {
        $before = count($errors->errors());

        // ── v1.1 policyType=5（采集静默）：条件不含任何指标判据 ──────────
        // 契约 §2.1 规则 3：policyType=5 时 6 个指标判据字段全部必须缺省。
        //
        // 判据本身是「目标的数据多久没上报」，写在**策略**的
        // targetType / targetFreshnessMinutes 上，条件只保留告警属性
        // （等级、频次、统计粒度、持续周期、排序位）。
        //
        // ⚠️ 不能让 5 走进下面的通用分支：`POLICY_TYPE_NAMESPACE[5]` 刻意不存在
        //    （采集静默不是指标，不塞进 namespace 映射），于是
        //    `belongsToPolicyType()` 恒为 false，每条条件都会报
        //    「指标命名空间 X 不属于该策略类型」—— 采集静默策略**一条也建不出来**。
        //    这个 bug 只有真发 HTTP 请求才暴露：Service 层测试用的是 policyType=2。
        if ($policyType === 5) {
            return $this->validateSilenceCondition($raw, $path, $errors, $before);
        }

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

        // ── v1.1 相对判据（契约 §1.5.1-1.5.3）────────────────────────
        $relative = $this->assertRelativeFields($raw, $path, $errors);

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
            // 归一化后的三字段：absolute 时 baselineType/baselineCount 恒为 null，
            // **不是** 「原样透传请求值」—— 传了也要按契约清掉，否则库里会留下
            // 「absolute 却带着 baselineType」这种自相矛盾的行。
            'compareMode' => $relative['compareMode'],
            'baselineType' => $relative['baselineType'],
            'baselineCount' => $relative['baselineCount'],
        ];
    }

    /**
     * v1.1 相对判据字段校验（契约 §1.5.1-1.5.3 + §2.1 校验规则）。
     *
     * 设计取舍：**宁可过度拒绝，不放过矛盾组合。**
     * 「absolute 却带着 baselineType」这种行在写入后没有任何地方会报错，
     * 只会在半年后有人排查「为什么这条策略不触发」时变成灵异事件。
     * 在入口挡掉，错误信息还带字段名。
     *
     * @return array{compareMode: string, baselineType: ?string, baselineCount: ?int}
     */
    private function assertRelativeFields(array $raw, string $path, Validator $errors): array
    {
        $rawMode = $raw['compareMode'] ?? null;
        // ⚠️ 空串按「没传」处理：HTML 表单提交时空值就是空串，
        //    与 null 语义相同（都表示「用默认的 absolute」）。
        $mode = ($rawMode === null || $rawMode === '') ? 'absolute' : (string) $rawMode;

        if (! isset(AlarmEnum::COMPARE_MODE[$mode])) {
            $errors->add(
                $path . '.compareMode',
                '判据模式必须是 absolute / relative 之一'
            );
            // 模式非法时后续判断没有意义，统一按 absolute 归一化继续走，
            // 避免同一条条件刷出一堆互相矛盾的错误。
            return ['compareMode' => 'absolute', 'baselineType' => null, 'baselineCount' => null];
        }

        $rawBaselineType = $raw['baselineType'] ?? null;
        $baselineType = ($rawBaselineType === null || $rawBaselineType === '') ? null : (string) $rawBaselineType;
        $rawCount = $raw['baselineCount'] ?? null;
        $baselineCount = ($rawCount === null || $rawCount === '') ? null : (int) $rawCount;

        // ① absolute 必须干净
        if ($mode === 'absolute') {
            if ($baselineType !== null) {
                $errors->add($path . '.baselineType', 'compareMode=absolute 时不允许传 baselineType');
            }
            if ($baselineCount !== null) {
                $errors->add($path . '.baselineCount', 'compareMode=absolute 时不允许传 baselineCount');
            }
            return ['compareMode' => 'absolute', 'baselineType' => null, 'baselineCount' => null];
        }

        // ② relative 必须给 baselineType
        if ($baselineType === null) {
            $errors->add($path . '.baselineType', 'compareMode=relative 时必须指定基线类型 period / day / week');
            return ['compareMode' => $mode, 'baselineType' => null, 'baselineCount' => null];
        }
        if (! isset(AlarmEnum::BASELINE_TYPE[$baselineType])) {
            $errors->add($path . '.baselineType', '基线类型必须是 period / day / week 之一');
            return ['compareMode' => $mode, 'baselineType' => null, 'baselineCount' => null];
        }

        // ③ period 必须给 baselineCount；day/week 必须不给
        if ($baselineType === 'period') {
            if ($baselineCount === null) {
                $errors->add(
                    $path . '.baselineCount',
                    sprintf('基线类型为环比时必须指定前移周期数 %d-%d',
                        AlarmEnum::BASELINE_COUNT_MIN, AlarmEnum::BASELINE_COUNT_MAX)
                );
            } elseif ($baselineCount < AlarmEnum::BASELINE_COUNT_MIN || $baselineCount > AlarmEnum::BASELINE_COUNT_MAX) {
                $errors->add(
                    $path . '.baselineCount',
                    sprintf('环比前移周期数必须是 %d-%d 的整数',
                        AlarmEnum::BASELINE_COUNT_MIN, AlarmEnum::BASELINE_COUNT_MAX)
                );
            }
        } elseif ($baselineCount !== null) {
            // 同比已经隐含了「往前一天/一周」，再给 count 就是语义冲突
            $errors->add($path . '.baselineCount', '同比基线（day/week）不接受 baselineCount');
        }

        return [
            'compareMode' => $mode,
            'baselineType' => $baselineType,
            'baselineCount' => $baselineType === 'period' ? $baselineCount : null,
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
