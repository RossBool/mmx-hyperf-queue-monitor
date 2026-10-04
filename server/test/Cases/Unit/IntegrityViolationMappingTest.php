<?php

declare(strict_types=1);
/**
 * 409/422 语义分类的回归测试 —— 审查 S-09 / B-6 / B-7。
 *
 * ## 旧实现的错
 *
 * `isDuplicateKey()` 是 `str_starts_with($state, '23')`，把 SQLSTATE **23 类**
 * （整类「完整性约束违反」）一律当「唯一键冲突 → 409 策略名称已存在」。
 * 确定性触发路径：`AlarmConditionTemplateService::create()` 与
 * `AlarmNotificationTemplateService::create()` 都不做 name 预检，
 * 提交一个已存在的**模板名** → 1062 → 用户收到「**策略**名称已存在」。
 *
 * ## ⚠️ 为什么按 MySQL errno 判而不是 SQLSTATE
 *
 * MySQL 把 1062(重名) / 1451 / 1452(外键) / 1048(非空) **全部映射到 SQLSTATE
 * `23000`**。SQLSTATE 在这里零区分度，只有驱动错误码能分辨。
 * 旧实现按 SQLSTATE 判，等于把四件事混成一件事。
 *
 * ⚠️ 本测试**不连数据库**：直接构造带 `errorInfo` 的假异常喂给 handler。
 * ⚠️ 但它**不覆盖** `$errno >= 1000` 这类范围判断的回归 —— 那正是
 *    首版修复里出错的点（把 1146 表不存在、2006 连接断开也扫成 422），
 *    对应的等价验证在 `scripts/verify-s09-classify.mjs`。
 */
namespace Tests\Cases\Unit;

use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use ReflectionMethod;

final class IntegrityViolationMappingTest extends TestCase
{
    /**
     * 造一个形状与 PDOException 一致的异常：
     * `getCode()` = MySQL 驱动错误码，`errorInfo` = [SQLSTATE, driverCode, message]。
     */
    private function dbError(int $errno, string $sqlstate, string $message = "db error"): \PDOException
    {
        // PDOException::getCode() 是只读的，用匿名子类把它设成 MySQL errno
        return new class($errno, $sqlstate, $message) extends \PDOException {
            public function __construct(private int $errno, string $sqlstate, string $message)
            {
                parent::__construct($message, 0);
                $this->errorInfo = [$sqlstate, (string) $errno, $message];
            }

            public function getCode(): int
            {
                return $this->errno;
            }
        };
    }

    /** @return array{0: int, 1: string} [bizCode, message] */
    private function resolve(\Throwable $throwable): array
    {
        $handler = (new \ReflectionClass(\App\Exception\Handler\AlarmExceptionHandler::class))
            ->newInstanceWithoutConstructor();
        $method = new ReflectionMethod($handler, 'classifyIntegrityViolation');
        $result = $method->invoke($handler, $throwable);

        return $result === null ? [ErrorCode::INTERNAL_ERROR, ErrorCode::message(ErrorCode::INTERNAL_ERROR)] : [$result[0], $result[1]];
    }

    // ── 唯一键冲突：唯一真正叫「重名」的一类 ──────────────────────────

    public function testDuplicateKeyStillReportsPolicyNameDuplicated(): void
    {
        [$code, $message] = $this->resolve($this->dbError(1062, '23000'));

        self::assertSame(409, $code);
        self::assertSame('策略名称已存在', $message, '1062 必须仍是 409 策略名称已存在 —— 这是唯一合法的「重名」文案。');
    }

    public function testUniqueViolationSqlstateWithoutErrnoStillWorks(): void
    {
        [$code] = $this->resolve($this->dbError(0, '23505'));

        self::assertSame(409, $code, 'SQLSTATE 23505 是无歧义的唯一性冲突，应作 409。');
    }

    // ── 外键：并发删除/更新，绝不能说「重名」 ──────────────────────────

    public function testForeignKeyRejectsDeletionReportsRelationConflict(): void
    {
        [$code, $message] = $this->resolve($this->dbError(1451, '23000'));

        self::assertSame(409, $code);
        self::assertSame(
            '关联数据已变更，请刷新后重试',
            $message,
            '1451（父行仍被引用）必须报关联冲突，不能报「策略名称已存在」。'
        );
    }

    public function testMissingForeignKeyRowReportsRelationConflict(): void
    {
        [$code, $message] = $this->resolve($this->dbError(1452, '23000'));

        self::assertSame(409, $code);
        self::assertSame('关联数据已变更，请刷新后重试', $message);
    }

    // ── 载荷类失败一律 422，不是 500 ─────────────────────────────────

    public static function payloadErrnoProvider(): array
    {
        return [
            'CHECK 违反' => [3819, 'HY000'],
            '非空列写 NULL' => [1048, '23000'],
            '数值越界（DECIMAL(20,4) 溢出）' => [1264, '22003'],
            '超长' => [1406, '22001'],
            '类型转换截断' => [1366, '22007'],
            '小数位超范围' => [1137, 'HY000'],
        ];
    }

    /**
     * @dataProvider payloadErrnoProvider
     */
    public function testPayloadViolationsReport422(int $errno, string $sqlstate): void
    {
        [$code] = $this->resolve($this->dbError($errno, $sqlstate));

        self::assertSame(
            ErrorCode::VALIDATION_ERROR,
            $code,
            sprintf('errno %d 是「载荷不合法」，应报 422 而不是 500。', $errno)
        );
    }

    // ── 服务器自己的问题必须留在 500，不能甩给用户 ────────────────────

    public static function serverFaultProvider(): array
    {
        return [
            'SQL 写错（代码 bug）' => [1064, '42000'],
            '表不存在（迁移没跑）' => [1146, '42S02'],
            '连接断开' => [2006, 'HY000'],
        ];
    }

    /**
     * ⚠️ 这组是**反回归**用例。
     * 首版修复写的是 `errno >= 1000` 的范围判断，会把下面三条全扫成 422 ——
     * 那是把部署问题和基础设施故障报成「参数校验失败」，运维会查错方向。
     *
     * @dataProvider serverFaultProvider
     */
    #[DataProvider('serverFaultProvider')]
    public function testServerFaultsStayInternalError(int $errno, string $sqlstate): void
    {
        [$code] = $this->resolve($this->dbError($errno, $sqlstate));

        self::assertSame(
            ErrorCode::INTERNAL_ERROR,
            $code,
            sprintf('errno %d 是服务器自身的问题，必须回 500，不能报成 422。', $errno)
        );
    }

    public function testNonDatabaseThrowableIsNotClaimed(): void
    {
        self::assertSame(
            [ErrorCode::INTERNAL_ERROR, ErrorCode::message(ErrorCode::INTERNAL_ERROR)],
            $this->resolve(new \RuntimeException('普通异常')),
            '非数据库异常不得被完整性分类器接管。'
        );
    }

    // ── B-7：拼错的语义分支必须在抛出处当场报错 ───────────────────────

    public function testTypoInReasonThrowsLogicException(): void
    {
        $this->expectException(\LogicException::class);
        $this->expectExceptionMessage('未知的 409 语义分支');

        // 旧实现：这里会静默返回一个 bizCode=500 的异常，开发者什么都看不到。
        BusinessException::conflict('POLICY_STATUS_CONFIC');
    }

    public function testKnownReasonsAllResolveTo409(): void
    {
        foreach (ErrorCode::knownReasons() as $reason) {
            $e = BusinessException::conflict($reason);
            self::assertSame(
                409,
                $e->getBizCode(),
                $reason . ' 应映射到 409'
            );
            self::assertNotSame(
                ErrorCode::message(ErrorCode::INTERNAL_ERROR),
                $e->getMessage(),
                $reason . ' 落到了兜底文案 —— REASON_MESSAGES 缺键'
            );
        }
    }

    public function testSixReasonsAreDistinct(): void
    {
        $messages = array_map(
            static fn (string $r): string => BusinessException::conflict($r)->getMessage(),
            ErrorCode::knownReasons()
        );

        self::assertCount(
            6,
            ErrorCode::knownReasons(),
            '契约 §0.5 原有 5 个分支 + 本轮新增的 RELATION_CONFLICT = 6。'
        );
        self::assertSame(
            count($messages),
            count(array_unique($messages)),
            '6 条 409 文案必须互不相同 —— 塌缩会退回 S-03 的老 bug。'
        );
    }
}
