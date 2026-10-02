<?php

declare(strict_types=1);

namespace App\Exception;

use App\Constants\ErrorCode;
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

    public static function conflict(int $code, string $message = null): self
    {
        return new self($code, $message);
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
