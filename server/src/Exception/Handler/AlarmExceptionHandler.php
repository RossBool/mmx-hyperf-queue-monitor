<?php

declare(strict_types=1);

namespace App\Exception\Handler;

use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use Hyperf\Contract\StdoutLoggerInterface;
use Hyperf\ExceptionHandler\ExceptionHandler;
use Hyperf\HttpMessage\Stream\SwooleStream;
use Swow\Psr7\Message\ResponsePlusInterface;
use Throwable;

/**
 * 全局异常处理器：把异常翻译成契约 §0.2 的统一信封。
 *
 * ⚠️ 为什么不用 hyperf/validation 自带的 ValidationExceptionHandler：
 * 它返回的是 `text/plain` + 第一条错误文案（见 hyperf/validation 3.2.5
 * src/ValidationExceptionHandler.php），完全不满足契约 §0.4 要求的
 * `extra.errors[] = {field, message}` 结构，因此这里自行实现。
 *
 * 唯一键冲突（MySQL 1062 / SQLSTATE 23000）在这里统一转成 409
 * （契约 §0.5 POLICY_NAME_DUPLICATED / TEMPLATE_IN_USE 语义）。
 */
class AlarmExceptionHandler extends ExceptionHandler
{
    public function __construct(protected StdoutLoggerInterface $logger)
    {
    }

    public function handle(Throwable $throwable, ResponsePlusInterface $response)
    {
        $this->stopPropagation();

        [$code, $message, $data, $extra] = $this->resolve($throwable);

        if ($code === ErrorCode::INTERNAL_ERROR) {
            $this->logger->error(sprintf('%s [%s] in %s', $throwable->getMessage(), $throwable->getLine(), $throwable->getFile()));
            $this->logger->error($throwable->getTraceAsString());
        }

        $payload = [
            'data' => $data,
            'extra' => (object) $extra,
            'code' => $code,
            'message' => $message,
            'success' => false,
        ];

        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        // ⚠️ 契约 §0.1：响应编码 application/json; charset=utf-8。
        //    官方 hyperf/validation 的 ValidationExceptionHandler 用的就是 addHeader()，
        //    这里沿用同一个 API（ResponsePlusInterface 的 setHeader 未在官方代码中出现，不冒险）。
        return $response
            ->addHeader('content-type', 'application/json; charset=utf-8')
            ->setStatus($code === ErrorCode::SUCCESS ? 200 : $code)
            ->setBody(new SwooleStream($body === false ? '{}' : $body));
    }

    public function isValid(Throwable $throwable): bool
    {
        return true;
    }

    /**
     * @return array{0: int, 1: string, 2: mixed, 3: array}
     */
    private function resolve(Throwable $throwable): array
    {
        if ($throwable instanceof BusinessException) {
            return [$throwable->getBizCode(), $throwable->getMessage(), null, $throwable->getExtra() + $this->errorsExtra($throwable)];
        }

        $integrity = $this->classifyIntegrityViolation($throwable);
        if ($integrity !== null) {
            return $integrity;
        }

        return [ErrorCode::INTERNAL_ERROR, ErrorCode::message(ErrorCode::INTERNAL_ERROR), null, []];
    }

    /** @return array<string, mixed> */
    private function errorsExtra(BusinessException $e): array
    {
        $errors = $e->getErrors();
        return $errors === [] ? [] : ['errors' => $errors];
    }

    /**
     * 把数据库层的完整性约束失败翻译成**正确的**契约语义（审查 S-09 / B-6）。
     *
     * ## 旧实现的错在哪
     *
     * 旧代码是 `str_starts_with($state, '23')` —— 把 SQLSTATE **23 类**（整类
     * 「完整性约束违反」）一律当成「唯一键冲突 → 409 策略名称已存在」。
     * 但 23 类里塞着完全不同的事，于是：
     *
     * | 实际情况 | MySQL code | SQLSTATE | 旧实现报成 |
     * |---|---|---|---|
     * | 唯一键冲突（真·重名） | 1062 | 23000 | 策略名称已存在 ✅ |
     * | 外键被引用 / 无对应行 | 1451 / 1452 | 23000 | **策略名称已存在** ❌ |
     * | 非空列写 NULL | 1048 | 23000 | **策略名称已存在** ❌ |
     * | CHECK 违反 | 3819 | HY000 | 策略名称已存在 ❌ |
     * | 越界（`DECIMAL(20,4)` 溢出） | 1264 | 22003 | **500** ❌ |
     *
     * 确定性触发路径：`AlarmConditionTemplateService::create()` 与
     * `AlarmNotificationTemplateService::create()` 都**不做 name 预检**，
     * 唯一性完全靠 DDL 唯一键。提交一个已存在的**模板名** →
     * 1062 → 用户收到「**策略**名称已存在」。用户建的是条件模板，被告知策略重名。
     *
     * ## ⚠️ 为什么必须按 MySQL 驱动码判，不能按 SQLSTATE
     *
     * MySQL 把 `1062`(重名) / `1451` / `1452`(外键) / `1048`(非空)
     **全部映射到同一个 SQLSTATE `23000`**。SQLSTATE 在这里根本没有区分度，
     * 只有驱动错误码能分辨。SQLSTATE 仅在它**本身无歧义**时作为兜底
     * （`23505` 唯一 / `23503` 外键 / `23514` CHECK）。
     *
     * @return array{0: int, 1: string, 2: mixed, 3: array}|null null = 不是完整性约束失败
     */
    private function classifyIntegrityViolation(Throwable $throwable): ?array
    {
        [$errno, $sqlstate] = $this->driverErrorCodes($throwable);
        if ($errno === null && $sqlstate === null) {
            return null;
        }

        // ① 唯一键冲突 —— 唯一真正叫「重名」的一类
        if ($errno === 1062 || $sqlstate === '23505') {
            return [
                ErrorCode::POLICY_NAME_DUPLICATED,
                ErrorCode::messageForReason(ErrorCode::REASON_POLICY_NAME_DUPLICATED),
                null,
                [],
            ];
        }

        // ② 外键冲突 —— 并发删除/更新导致的关联不一致，与重名无关
        if (in_array($errno, [1451, 1452], true) || in_array($sqlstate, ['23001', '23503'], true)) {
            return [
                ErrorCode::RELATION_CONFLICT,
                ErrorCode::messageForReason(ErrorCode::REASON_RELATION_CONFLICT),
                null,
                [],
            ];
        }

        // ③ 「用户载荷不合法」→ 422。
        //    ⚠️ 必须用**显式白名单**，不能写 `errno >= 1000` 这种范围判断：
        //    那会把 ER_NO_SUCH_TABLE(1146，表不存在＝部署/迁移没跑) 和
        //    CR_SERVER_GONE_ERROR(2006，连接断开) 也扫进来，
        //    把服务器自己的故障报成「参数校验失败」—— 运维会查错方向。
        if (in_array($errno, self::PAYLOAD_REJECTED_ERRNOS, true)) {
            return [
                ErrorCode::VALIDATION_ERROR,
                ErrorCode::message(ErrorCode::VALIDATION_ERROR),
                null,
                ['errors' => [['field' => 'payload', 'message' => $this->driverMessage($throwable)]]],
            ];
        }

        // SQLSTATE 兜底：只认**本身无歧义**的几个。
        // HY000 不在其中 —— 它是通用兜底状态，2006 连接断开也是 HY000。
        if (in_array($sqlstate, ['22001', '22003', '23514'], true)) {
            return [
                ErrorCode::VALIDATION_ERROR,
                ErrorCode::message(ErrorCode::VALIDATION_ERROR),
                null,
                ['errors' => [['field' => 'payload', 'message' => $this->driverMessage($throwable)]]],
            ];
        }

        // 23000 且拿不到 errno：无法区分是重名/外键/非空（MySQL 三者共用它），
        // 宁可给一条诚实的「数据不满足数据库约束」，也不猜。
        if ($sqlstate === '23000') {
            return [
                ErrorCode::VALIDATION_ERROR,
                ErrorCode::message(ErrorCode::VALIDATION_ERROR),
                null,
                ['errors' => [['field' => 'payload', 'message' => $this->driverMessage($throwable)]]],
            ];
        }

        return null;
    }

    /**
     * 「载荷不合法」类 MySQL errno 白名单。
     *
     * 每一条都代表**调用方给的参数**有问题，而不是服务器配置有问题。
     * 反例（必须落在列表外，最终走 500）：
     *   1064 ER_PARSE_ERROR      —— SQL 写错了，是代码 bug
     *   1146 ER_NO_SUCH_TABLE    —— 迁移没跑，是部署问题
     *   2006 CR_SERVER_GONE_ERROR / 2013 —— 连接断了，是基础设施问题
     */
    private const PAYLOAD_REJECTED_ERRNOS = [
        1048, // ER_BAD_NULL_ERROR          非空列写 NULL
        1052, // ER_BAD_FIELD_ERROR         未知列
        1121, // ER_WRONG_COL_NAME          排序规则不匹配
        1136, // ER_WRONG_VALUE_COUNT       值个数不符
        1137, // ER_TOO_BIG_SCALE           小数位超范围（DECIMAL 精度）
        1264, // ER_WARN_DATA_OUT_OF_RANGE  数值越界（DECIMAL(20,4) 溢出）
        1265, // ER_WARN_DATA_TRUNCATED     截断告警
        1364, // ER_NO_DEFAULT_FOR_FIELD    无默认值且未给值
        1365, // ER_DIVISION_BY_ZERO
        1366, // ER_TRUNCATED_WRONG_VALUE   类型转换截断
        1406, // ER_DATA_TOO_LONG           超长
        3819, // ER_CHECK_CONSTRAINT_VIOLATED  CHECK 违反
        4025, // ER_CONSTRAINT_FAILED       GENERATED 列 CHECK 违反
    ];

    /**
     * 沿异常链取 (MySQL 驱动错误码, SQLSTATE)。
     *
     * ## ⚠️ errno 只能从 `errorInfo[1]` 取，**不能从 `getCode()` 取**
     *
     * 真实 MySQL 8.0.46 + hyperf/database 3.2 实测（`probe-dup.php` 复现唯一键冲突）：
     *
     *     Hyperf\Database\Exception\UniqueConstraintViolationException
     *       getCode()   = '23000'    ← **SQLSTATE 字符串，不是 errno！**
     *       errorInfo   = ['23000', 1062, "Duplicate entry ..."]
     *                                     ↑ errno 在这里
     *
     * 旧实现 `(int) $t->getCode()` 把 SQLSTATE `'23000'` 转成了整数 **23000**，
     * 于是 `=== 1062` 永远不成立，唯一键冲突被降级成 **422 参数校验失败**，
     * 用户看到的是「参数错误」，运维查错方向。
     *
     * 之所以之前没发现：单元测试用 `new PDOException($msg, 1062)` 造异常，
     * 那个构造器第二个参数**确实**会写进 `getCode()` —— 测试桩比真实驱动更「听话」，
     * 于是一条针对不存在行为的断言绿灯了。**这条只有真连 MySQL 才暴露。**
     *
     * `errorInfo` 是 PDO 的权威来源，顺序固定为 `[SQLSTATE, driver_errno, driver_message]`。
     * 只有在 `errorInfo` 缺失时（部分驱动路径）才退回 `getCode()`，
     * 且此时**必须确认它长得像 errno**（纯数字且不是 5 位的 SQLSTATE）。
     *
     * @return array{0: int|null, 1: string|null}
     */
    private function driverErrorCodes(Throwable $throwable): array
    {
        for ($t = $throwable; $t !== null; $t = $t->getPrevious()) {
            $info = property_exists($t, 'errorInfo') ? $t->errorInfo : null;
            $info = is_array($info) ? array_values($info) : [];

            // SQLSTATE：优先 errorInfo[0]
            $state = (string) ($info[0] ?? '');
            if ($state === '' && is_string($t->getCode()) && preg_match('/^[0-9A-Z]{5}$/', $t->getCode())) {
                $state = (string) $t->getCode();
            }

            // 驱动 errno：优先 errorInfo[1]
            $errno = null;
            if (isset($info[1]) && is_numeric($info[1])) {
                $errno = (int) $info[1];
            } elseif (is_int($t->getCode())) {
                // 兜底：只有当 getCode() 本来就是整数时才能当 errno 用。
                // 若是 '23000' 这种 SQLSTATE 字符串，is_int 为 false，不会误用。
                $errno = $t->getCode();
            }

            if ($errno !== null || $state !== '') {
                return [$errno, $state === '' ? null : $state];
            }
        }

        return [null, null];
    }

    /** 提取驱动原文用于 extra.errors（不含 SQL 与参数，避免回显敏感值）。 */
    private function driverMessage(Throwable $throwable): string
    {
        for ($t = $throwable; $t !== null; $t = $t->getPrevious()) {
            $info = property_exists($t, 'errorInfo') ? $t->errorInfo : null;
            if (is_array($info) && isset($info[2]) && $info[2] !== '') {
                return (string) $info[2];
            }
        }

        return '数据不满足数据库约束';
    }
}
