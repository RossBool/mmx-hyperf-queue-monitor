<?php

declare(strict_types=1);

namespace App\Exception;

use App\Constants\ErrorCode;
use LogicException;
use RuntimeException;
use Throwable;

/**
 * 业务异常。code 为契约 §0.5 的业务码，HTTP 状态码与 code 保持一致（契约 §0.2 约束 2）。
 */
class BusinessException extends RuntimeException
{
    /**
     * @param array<int, array{field: string, message: string}> $errors 422 时承载 extra.errors
     * @param array<string, mixed> $extra 附加信息
     */
    public function __construct(
        private int $bizCode,
        ?string $message = null,
        private array $errors = [],
        private array $extra = [],
        ?Throwable $previous = null,
    ) {
        if ($bizCode === 409 && $message === null) {
            // 409 下有 6 个同码分支，数值码无法定位文案，ErrorCode::message(409)
            // 只会给兜底文案 —— 那是「静默发错文案给运维」，比报错危险得多。
            // 正确写法是走 self::conflict(ErrorCode::REASON_*)。
            throw new LogicException(
                '409 必须经由 BusinessException::conflict(ErrorCode::REASON_*) 抛出，'
                . '直接 new BusinessException(409) 无法确定文案分支。',
            );
        }
        parent::__construct($message ?? ErrorCode::message($bizCode), $bizCode, $previous);
    }

    public function getBizCode(): int
    {
        return $this->bizCode;
    }

    public function getErrors(): array
    {
        return $this->errors;
    }

    public function getExtra(): array
    {
        return $this->extra;
    }

    public static function notFound(string $message = null): self
    {
        return new self(ErrorCode::NOT_FOUND, $message);
    }

    /**
     * 409 冲突。**必须传语义分支标识**（`ErrorCode::REASON_*`）而不是数值码 ——
     * 409 下有 6 个同码分支（契约 §0.5），只有语义标识能定位到正确文案。
     *
     * @param string $reason ErrorCode::REASON_* 之一
     */
    public static function conflict(string $reason, ?string $message = null): self
    {
        // 审查 B-7：拼错的分支名（如 'POLICY_STATUS_CONFIC'）过去会静默走到
        // `codeForReason()` 的 `?? INTERNAL_ERROR` 兜底 —— 用户收到 500，
        // 开发者却什么都看不到。构造器里的 `LogicException` 守卫拦不住这种：
        // 那时 bizCode 已经是兜底后的 500，不是 409，守卫根本不触发。
        // 正确的位置是**抛出处**：分支名是白名单拼出来的，拼错就是代码 bug，
        // 必须当场炸出来，而不是降级成一个没人会查的 500。
        if (! in_array($reason, ErrorCode::knownReasons(), true)) {
            throw new LogicException(sprintf(
                '未知的 409 语义分支 "%s"。已知分支：%s',
                $reason,
                implode(', ', ErrorCode::knownReasons()),
            ));
        }

        return new self(
            ErrorCode::codeForReason($reason),
            $message ?? ErrorCode::messageForReason($reason),
        );
    }

    /**
     * 422 字段级校验失败。
     *
     * @param array<string, string> $errors field => message（点分路径，如 conditions.0.period）
     */
    public static function validation(array $errors, string $message = null): self
    {
        $list = [];
        foreach ($errors as $field => $msg) {
            $list[] = ['field' => (string) $field, 'message' => $msg];
        }
        return new self(ErrorCode::VALIDATION_ERROR, $message, $list);
    }

    public static function unauthorized(string $message = null): self
    {
        return new self(ErrorCode::UNAUTHORIZED, $message);
    }
}
