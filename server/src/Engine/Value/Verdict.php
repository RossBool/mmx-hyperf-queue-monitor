<?php

declare(strict_types=1);

namespace App\Engine\Value;

/**
 * 判据求值的结果。
 *
 * ## 为什么命中结果要带「为什么没命中」
 *
 * 引擎出问题时（该报不报），排查的第一句话永远是「为什么」。
 * 只返回一个 bool 的话，运维只能去翻日志、猜基线算成了多少。
 * 所以这里强制带上**不命中的原因**——这是引擎唯一有价值的可观测性。
 */
final class Verdict
{
    private function __construct(
        public readonly bool $hit,
        /** 人类可读的判据说明，会写进告警记录 */
        public readonly string $reason,
        /** 求值时用到的当前值；数据不足时为 null */
        public readonly ?float $value,
        /** 实际采用的基线；absolute 模式或基线不可用时为 null */
        public readonly ?float $baseline,
        /** 相对模式下的偏离百分比（已含符号） */
        public readonly ?float $deviationPercent,
    ) {
    }

    /**
     * @param float|null $value 静默判定里「当前值」是静默秒数；
     *                           采集静默的「从未上报」场景下没有可测量的值，为 null
     */
    public static function hit(?float $value, ?float $baseline, ?float $deviation, string $reason): self
    {
        return new self(true, $reason, $value, $baseline, $deviation);
    }

    public static function miss(string $reason, ?float $value = null, ?float $baseline = null, ?float $deviation = null): self
    {
        return new self(false, $reason, $value, $baseline, $deviation);
    }

    public function toArray(): array
    {
        return [
            'hit' => $this->hit,
            'reason' => $this->reason,
            'value' => $this->value,
            'baseline' => $this->baseline,
            'deviationPercent' => $this->deviationPercent,
        ];
    }
}
