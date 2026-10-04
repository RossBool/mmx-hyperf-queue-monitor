<?php

declare(strict_types=1);

namespace App\Constants;

/**
 * 业务错误码 —— 契约 §0.5 错误码表，逐条照抄。
 *
 * 409 下有 6 个语义分支：code 相同、message 不同（契约 §0.5「同码多义说明」）。
 * 其中 5 个来自契约 §0.5，RELATION_CONFLICT 是本轮为 S-09 增量扩展的第 6 个。
 *
 * ⚠️ 因此 `MESSAGES` **不能**用数值码做键：`self::POLICY_STATUS_CONFLICT` 等 5 个常量
 * 求值都是 409，写进同一个数组字面量时 PHP 会让后写的键覆盖先写的，结果只剩最后一条
 * 文案存活 —— 所有 409 都会返回「该告警已处理，不可重复处理」。
 * 409 的文案改由 `REASON_MESSAGES` 按**语义分支**索引，`message()` 形参是数值码。
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
    /** 关联完整性冲突（外键）：契约 §0.5 未列举，属**增量扩展**的第 6 个 409 语义分支。 */
    public const RELATION_CONFLICT = 409;

    public const VALIDATION_ERROR = 422;
    public const INTERNAL_ERROR = 500;

    /**
     * 409 的 6 个**语义分支标识**。
     *
     * 数值码不足以区分这 5 个分支（它们都是 409），所以抛出点必须传语义标识，
     * 由 {@see codeForReason()} 映射回数值码 409 上线。
     */
    public const REASON_POLICY_STATUS_CONFLICT = 'POLICY_STATUS_CONFLICT';
    public const REASON_POLICY_NAME_DUPLICATED = 'POLICY_NAME_DUPLICATED';
    public const REASON_TEMPLATE_IN_USE = 'TEMPLATE_IN_USE';
    public const REASON_PRESET_READONLY = 'PRESET_READONLY';
    public const REASON_HISTORY_ALREADY_HANDLED = 'HISTORY_ALREADY_HANDLED';
    public const REASON_RELATION_CONFLICT = 'RELATION_CONFLICT';

    /** 契约 §0.5 规定的 message 文案，前端可直接弹窗。**仅含数值唯一的码**。 */
    public const MESSAGES = [
        self::SUCCESS => 'success',
        self::UNAUTHORIZED => '未登录或登录已过期',
        self::FORBIDDEN => '无权限操作该资源',
        self::NOT_FOUND => '资源不存在',
        self::VALIDATION_ERROR => '参数校验失败',
        self::INTERNAL_ERROR => '服务器内部错误',
    ];

    /** 409 的 6 条文案，按语义分支索引（契约 §0.5「同码多义说明」）。 */
    public const REASON_MESSAGES = [
        self::REASON_POLICY_STATUS_CONFLICT => '已启用的策略不可删除，请先停用',
        self::REASON_POLICY_NAME_DUPLICATED => '策略名称已存在',
        self::REASON_TEMPLATE_IN_USE => '模板已被策略引用，不可删除',
        self::REASON_PRESET_READONLY => '预置模板不可删除',
        self::REASON_HISTORY_ALREADY_HANDLED => '该告警已处理，不可重复处理',
        // S-09：外键冲突。真实场景是并发删除/更新（另一请求先改了这条数据），
        // 与「重名」毫无关系，绝不能复用 POLICY_NAME_DUPLICATED 的文案。
        self::REASON_RELATION_CONFLICT => '关联数据已变更，请刷新后重试',
    ];

    /** 语义分支 → 上线用的数值码。6 个分支当前都映射到 409。 */
    public const REASON_CODES = [
        self::REASON_POLICY_STATUS_CONFLICT => self::POLICY_STATUS_CONFLICT,
        self::REASON_POLICY_NAME_DUPLICATED => self::POLICY_NAME_DUPLICATED,
        self::REASON_TEMPLATE_IN_USE => self::TEMPLATE_IN_USE,
        self::REASON_PRESET_READONLY => self::PRESET_READONLY,
        self::REASON_HISTORY_ALREADY_HANDLED => self::HISTORY_ALREADY_HANDLED,
        self::REASON_RELATION_CONFLICT => self::RELATION_CONFLICT,
    ];

    /**
     * 已知语义分支的集合。
     *
     * 存在意义：`codeForReason()` 对**拼错**的分支名会静默回退成 500
     * （审查 B-7：守卫加在 BusinessException 里只能拦「传了 409 却没传文案」，
     * 拦不住「分支名拼错」——那种情况 bizCode 是兜底后的 500，守卫根本不触发）。
     * 抛出点改走 {@see knownReasons()} 后，拼错会在**抛出处**当场报错。
     *
     * @return list<string>
     */
    public static function knownReasons(): array
    {
        return array_keys(self::REASON_MESSAGES);
    }

    /**
     * 按数值码取文案。**只适用于数值唯一的码**（0/401/403/404/422/500）。
     *
     * 409 请用 {@see messageForReason()}：所有 409 分支在此都会落到兜底文案。
     */
    public static function message(int $code): string
    {
        return self::MESSAGES[$code] ?? self::MESSAGES[self::INTERNAL_ERROR];
    }

    /** 按语义分支取 409 的文案。 */
    public static function messageForReason(string $reason): string
    {
        return self::REASON_MESSAGES[$reason] ?? self::MESSAGES[self::INTERNAL_ERROR];
    }

    /** 语义分支 → 数值码；未知分支按 500 处理（宁可暴露也不要静默发错码）。 */
    public static function codeForReason(string $reason): int
    {
        return self::REASON_CODES[$reason] ?? self::INTERNAL_ERROR;
    }
}
