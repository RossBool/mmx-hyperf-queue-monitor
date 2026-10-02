<?php

declare(strict_types=1);

namespace App\Support;

use Carbon\CarbonImmutable;

/**
 * 时间格式化 —— 契约 §0.1：时间字符串统一 `YYYY-MM-DD HH:mm:ss`（Asia/Shanghai，不带时区后缀）。
 */
class Time
{
    public const DATETIME_FORMAT = 'Y-m-d H:i:s';
    public const DATE_FORMAT = 'Y-m-d';

    public static function now(): string
    {
        return CarbonImmutable::now()->format(self::DATETIME_FORMAT);
    }

    /** DB DATETIME -> API 时间字符串（null 原样返回） */
    public static function format(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        if ($value instanceof \DateTimeInterface) {
            return $value->format(self::DATETIME_FORMAT);
        }
        return CarbonImmutable::parse((string) $value)->format(self::DATETIME_FORMAT);
    }

    /** 非空时间字符串（契约中该字段声明为 string 而非 string|null） */
    public static function formatOrEmpty(mixed $value): string
    {
        return self::format($value) ?? '';
    }

    /**
     * 解析 `YYYY-MM-DD HH:mm:ss`；失败返回 null（由调用方转 422）。
     */
    public static function tryParse(?string $value): ?CarbonImmutable
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        try {
            return CarbonImmutable::createFromFormat(self::DATETIME_FORMAT, trim($value));
        } catch (\Throwable) {
            return null;
        }
    }

    /** 服务器自然日 00:00:00 */
    public static function todayStart(): string
    {
        return CarbonImmutable::now()->startOfDay()->format(self::DATETIME_FORMAT);
    }

    public static function date(int $daysAgo = 0): string
    {
        return CarbonImmutable::now()->subDays($daysAgo)->format(self::DATE_FORMAT);
    }

    public static function dayStartOfDaysAgo(int $daysAgo): string
    {
        return CarbonImmutable::now()->subDays($daysAgo)->startOfDay()->format(self::DATETIME_FORMAT);
    }
}
