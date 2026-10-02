<?php

declare(strict_types=1);

namespace App\Constants;

/**
 * 业务错误码 —— 契约 §0.5 错误码表，逐条照抄。
 *
 * 409 下有 5 个语义分支：code 相同、message 不同（契约 §0.5「同码多义说明」）。
 */
final class ErrorCode
{
    public const SUCCESS = 0;
    public const UNAUTHORIZED = 401;
    public const FORBIDDEN = 403;
    public const NOT_FOUND = 404;

    public const POLICY_STATUS_CONFLICT = 409;
    public const POLICY_NAME_DUPLICATED = 409;
    public const TEMPLATE_IN_USE = 409;
    public const PRESET_READONLY = 409;
    public const HISTORY_ALREADY_HANDLED = 409;

    public const VALIDATION_ERROR = 422;
    public const INTERNAL_ERROR = 500;

    /** 契约 §0.5 规定的 message 文案，前端可直接弹窗 */
    public const MESSAGES = [
        self::SUCCESS => 'success',
        self::UNAUTHORIZED => '未登录或登录已过期',
        self::FORBIDDEN => '无权限操作该资源',
        self::NOT_FOUND => '资源不存在',
        self::POLICY_STATUS_CONFLICT => '已启用的策略不可删除，请先停用',
        self::POLICY_NAME_DUPLICATED => '策略名称已存在',
        self::TEMPLATE_IN_USE => '模板已被策略引用，不可删除',
        self::PRESET_READONLY => '预置模板不可删除',
        self::HISTORY_ALREADY_HANDLED => '该告警已处理，不可重复处理',
        self::VALIDATION_ERROR => '参数校验失败',
        self::INTERNAL_ERROR => '服务器内部错误',
    ];

    public static function message(int $code): string
    {
        return self::MESSAGES[$code] ?? self::MESSAGES[self::INTERNAL_ERROR];
    }
}
