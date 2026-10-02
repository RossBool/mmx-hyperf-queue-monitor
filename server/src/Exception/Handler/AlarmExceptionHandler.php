<?php

declare(strict_types=1);

namespace App\Exception\Handler;

use App\Constants\ErrorCode;
use App\Exception\BusinessException;
use Hyperf\Contract\StdoutLoggerInterface;
use Hyperf\Database\Exception\QueryException;
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

        if ($this->isDuplicateKey($throwable)) {
            return [ErrorCode::POLICY_NAME_DUPLICATED, ErrorCode::message(ErrorCode::POLICY_NAME_DUPLICATED), null, []];
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
     * 唯一键冲突判定：MySQL 错误码 1062，SQLSTATE 23000。
     * hyperf/database 的 QueryException 继承 PDOException 并保留 previous 的 code。
     */
    private function isDuplicateKey(Throwable $throwable): bool
    {
        for ($t = $throwable; $t !== null; $t = $t->getPrevious()) {
            if ($t instanceof QueryException) {
                $code = (int) $t->getCode();
                $state = (string) ($t->errorInfo[0] ?? $t->getCode());
                if ($code === 1062 || str_starts_with($state, '23')) {
                    return true;
                }
            }
            if ((int) $t->getCode() === 1062) {
                return true;
            }
        }
        return false;
    }
}
