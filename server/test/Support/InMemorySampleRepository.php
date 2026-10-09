<?php

declare(strict_types=1);

namespace HyperfTest\Support;

use App\Engine\Data\SampleRepository;
use App\Engine\Value\Sample;
use PHPUnit\Framework\TestCase;

/**
 * 内存版 SampleRepository。
 *
 * ## 为什么要它
 *
 * 引擎的求值逻辑必须能脱离数据库验证 —— 时序对齐、基线定位这类代码
 * 一旦掺进 SQL，测试就只能靠「造数据 → 跑查询 → 断言结果」，
 * 既慢又会在改库结构时连带炸测试。
 *
 * ## 它怎么模拟「无数据」
 *
 * 关键：`fetch()` 只返回**确实存在**的采样点，不补齐。
 * 所以要造出「基线窗口无数据」，只要不往那个时间点放数据即可 ——
 * 而不是往里放 0。放 0 会让「无数据」和「值真的是 0」两种情况混在一起，
 * 而契约要求它们走**不同**的判定分支。
 */
final class InMemorySampleRepository implements SampleRepository
{
    /** @var array<string, Sample[]> key = "ns.name:period"，按时间升序 */
    private array $store = [];

    /** @param array<int, array{ns?:string,name?:string,period?:int,ts:int,value:float}> $rows */
    public function __construct(array $rows = [], private readonly string $ns = 'CVM', private readonly string $name = 'CpuUtilizationRate', private readonly int $period = 5)
    {
        foreach ($rows as $r) {
            $this->put(
                $r['ns'] ?? $ns,
                $r['name'] ?? $name,
                $r['period'] ?? $period,
                $r['ts'],
                $r['value']
            );
        }
    }

    public function put(string $ns, string $name, int $period, int $ts, float $value): void
    {
        $key = $ns . '.' . $name . ':' . $period;
        $this->store[$key][] = new Sample($ts, $value);
    }

    public function fetch(string $namespace, string $metricName, int $period, int $fromTs, int $toTs): array
    {
        $key = $namespace . '.' . $metricName . ':' . $period;
        if (! isset($this->store[$key])) {
            return [];
        }

        // 闭区间 —— 与接口注释一致：相邻窗口的边界点必须能被两个窗口同时引用
        return array_values(array_filter(
            $this->store[$key],
            static fn (Sample $s): bool => $s->timestamp >= $fromTs && $s->timestamp <= $toTs
        ));
    }

    public function count(): int
    {
        return array_sum(array_map('count', $this->store));
    }
}
