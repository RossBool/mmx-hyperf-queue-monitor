<?php

declare(strict_types=1);

namespace App\Support;

use App\Constants\AlarmEnum;
use App\Exception\BusinessException;

/**
 * 字段级校验器。
 *
 * 一次性收集**全部**错误后抛出（domain.md §5.1 校验执行顺序第 5 步），
 * 由 AlarmExceptionHandler 渲染成契约 §0.4 的 extra.errors[{field, message}]。
 *
 * field 使用点分路径，数组用下标，如 `conditions.0.period`（契约 §0.4）。
 */
class Validator
{
    /** @var array<string, string> */
    private array $errors = [];

    /**
     * @param mixed $value
     */
    public function required($value, string $field, string $message): self
    {
        if ($value === null || $value === '') {
            $this->add($field, $message);
        }
        return $this;
    }

    public function stringLen(?string $value, int $min, int $max, string $field, ?string $message = null): self
    {
        if ($value === null) {
            return $this;
        }
        $len = Text::length($value);
        if ($len < $min || $len > $max) {
            $this->add($field, $message ?? sprintf('长度必须为 %d-%d 个字符', $min, $max));
        }
        return $this;
    }

    /**
     * 枚举校验。$values 是 contract.md §1 的枚举取值。
     */
    public function enumInt(mixed $value, array $values, string $field, string $message): self
    {
        if ($value === null) {
            return $this;
        }
        if (! is_numeric($value) || ! in_array((int) $value, $values, true)) {
            $this->add($field, $message);
        }
        return $this;
    }

    public function enumString(mixed $value, array $values, string $field, string $message): self
    {
        if ($value === null) {
            return $this;
        }
        if (! is_string($value) || ! in_array($value, $values, true)) {
            $this->add($field, $message);
        }
        return $this;
    }

    public function intRange(mixed $value, int $min, int $max, string $field, string $message): self
    {
        if ($value === null) {
            return $this;
        }
        if (! is_numeric($value) || (int) $value != $value) {
            $this->add($field, $message);
            return $this;
        }
        $int = (int) $value;
        if ($int < $min || $int > $max) {
            $this->add($field, $message);
        }
        return $this;
    }

    /** pageSize：1-100，超出返回 422（契约 §0.3） */
    public function pageSize(mixed $value): self
    {
        return $this->intRange($value, AlarmEnum::PAGE_SIZE_MIN, AlarmEnum::PAGE_SIZE_MAX, 'pageSize', '每页条数必须是 1-100 的整数');
    }

    public function add(string $field, string $message): self
    {
        // 同一字段只保留第一条错误，避免 extra.errors 出现重复项
        if (! isset($this->errors[$field])) {
            $this->errors[$field] = $message;
        }
        return $this;
    }

    public function passes(): bool
    {
        return $this->errors === [];
    }

    /** 该字段是否已经记录了错误（用于分阶段校验时提前短路） */
    public function hasError(string $field): bool
    {
        return array_key_exists($field, $this->errors);
    }

    /** @return array<string, string> */
    public function errors(): array
    {
        return $this->errors;
    }

    /** 存在错误则抛 422 */
    public function validate(): void
    {
        if ($this->errors !== []) {
            throw BusinessException::validation($this->errors);
        }
    }
}
