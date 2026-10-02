<?php

declare(strict_types=1);

namespace App\Service\Metric;

use App\Constants\AlarmEnum;
use Hyperf\Contract\ConfigInterface;

/**
 * 指标字典（契约 §2.7 / metrics.md）。
 *
 * 数据源是 `config/autoload/metrics.php`（metrics.md §1 的机器可读副本，共 28 条），
 * **不入库**（metrics.md §5：系统元数据，非租户数据）。
 * 唯一键 = namespace + "." + metricName。
 */
class MetricDictionary
{
    /** @var array<int, array<string, mixed>>|null */
    private ?array $metrics = null;

    /** @var array<string, array<string, mixed>>|null 唯一键 => 指标 */
    private ?array $indexed = null;

    public function __construct(private ConfigInterface $config)
    {
    }

    /**
     * GET /api/alarm/metrics 的数据源，不分页（契约 §3.2 ⑧，固定 28 条）。
     *
     * @return array<int, array<string, mixed>>
     */
    public function all(): array
    {
        if ($this->metrics === null) {
            /** @var array<int, array<string, mixed>> $metrics */
            $metrics = (array) $this->config->get('metrics', []);
            $this->metrics = $metrics;
            $indexed = [];
            foreach ($metrics as $metric) {
                $indexed[self::key($metric['namespace'], $metric['metricName'])] = $metric;
            }
            $this->indexed = $indexed;
        }
        return $this->metrics;
    }

    /**
     * 按查询参数过滤（契约 §3.2 ⑧：policyType / namespace / keyword）。
     *
     * @return array<int, array<string, mixed>>
     */
    public function filter(?int $policyType, ?string $namespace, ?string $keyword): array
    {
        $result = [];
        foreach ($this->all() as $metric) {
            if ($namespace !== null && $metric['namespace'] !== $namespace) {
                continue;
            }
            if ($policyType !== null && ! in_array($policyType, $metric['policyType'], true)) {
                continue;
            }
            if ($keyword !== null && $keyword !== '') {
                $hit = stripos($metric['metricName'], $keyword) !== false
                    || stripos($metric['metricNameCn'], $keyword) !== false;
                if (! $hit) {
                    continue;
                }
            }
            $result[] = $metric;
        }
        return $result;
    }

    /**
     * 查指标。返回 null 表示字典里没有该 namespace.metricName。
     *
     * @return array<string, mixed>|null
     */
    public function find(string $namespace, string $metricName): ?array
    {
        $this->all();
        return $this->indexed[self::key($namespace, $metricName)] ?? null;
    }

    /** 该 policyType 对应的唯一 namespace（metrics.md §0.2） */
    public function namespaceOf(int $policyType): ?string
    {
        return AlarmEnum::POLICY_TYPE_NAMESPACE[$policyType] ?? null;
    }

    /** 指标是否适用于该 policyType（契约 T3 / P3 的跨字段校验） */
    public function belongsToPolicyType(array $metric, int $policyType): bool
    {
        return in_array($policyType, $metric['policyType'], true);
    }

    public static function key(string $namespace, string $metricName): string
    {
        return $namespace . '.' . $metricName;
    }
}
