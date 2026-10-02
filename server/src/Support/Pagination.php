<?php

declare(strict_types=1);

namespace App\Support;

use App\Constants\AlarmEnum;
use App\Exception\BusinessException;
use Hyperf\HttpServer\Contract\RequestInterface;

/**
 * 分页参数解析（契约 §0.3）。
 *
 * ⚠️ v1.0 **不开放排序参数**（契约 §0.3：排序固定 created_at DESC, id DESC；
 *    alarm_history 为 triggered_at DESC, id DESC），因此这里没有 orderBy 入口，
 *    从根上杜绝「用户传任意 orderBy 造成 SQL 注入」。
 */
class Pagination
{
    /**
     * @return array{page: int, pageSize: int}
     * @throws BusinessException 422
     */
    public static function fromRequest(RequestInterface $request): array
    {
        $errors = new Validator();

        $page = self::intParam($request->input('page'), 'page', $errors);
        $pageSize = self::intParam($request->input('pageSize'), 'pageSize', $errors);

        if ($page !== null && $page < 1) {
            $errors->add('page', '页码必须是大于等于 1 的整数');
        }
        if ($pageSize !== null && ($pageSize < AlarmEnum::PAGE_SIZE_MIN || $pageSize > AlarmEnum::PAGE_SIZE_MAX)) {
            $errors->add('pageSize', '每页条数必须是 1-100 的整数');
        }
        $errors->validate();

        return [
            'page' => $page ?? AlarmEnum::PAGE_DEFAULT,
            'pageSize' => $pageSize ?? AlarmEnum::PAGE_SIZE_DEFAULT,
        ];
    }

    /**
     * 解析一个「可选整型」参数。
     *
     * 三种情形（**刻意区分**，不要合并）：
     *   1. 缺省 / 空串   -> null（调用方回落默认值）
     *   2. 纯整数字面量  -> int
     *   3. 其它任何值    -> 记一条 422 错误（`abc` / `1.5` / `1e3` / 数组 …），返回 null
     *
     * ⚠️ 情形 3 报错而不是静默回落：契约 §0.5 把非数字归为 `422 VALIDATION_ERROR`。
     *    若静默回落，前端无法区分「没传」与「传错了」，会掩盖调用方的 bug。
     *
     * ⚠️ 这里**记录**错误而不是直接抛，是为了让上层能一次性收集多个字段的错误
     *    （契约 §0.4 的 extra.errors 是数组，示例里就同时列了 name 与 conditions.0.period）。
     *    调用方**必须**在合适的位置调用 `$errors->validate()`。
     *
     * @param string $field 错误路径（点分路径），用于 extra.errors
     */
    public static function intParam(mixed $value, string $field, Validator $errors): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (is_int($value)) {
            return $value;
        }
        // 只接受整数字面量：'3' / 3 收；'3.5' / 'abc' / '1e3' / [] 一律拒
        if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
            return (int) $value;
        }

        $errors->add($field, '必须是整数');

        return null;
    }
}
