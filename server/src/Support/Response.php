<?php

declare(strict_types=1);

namespace App\Support;

use App\Constants\ErrorCode;
use Hyperf\HttpServer\Contract\ResponseInterface;
use Hyperf\HttpMessage\Stream\SwooleStream;

/**
 * 统一响应封装 —— 契约 §0.2 信封，逐字段照抄：
 *
 *   { "data": {}, "extra": {}, "code": 0, "message": "success", "success": true }
 *
 * 约束：
 *   1. 业务失败时 success=false、code != 0，data 固定为 null（不是 {} 也不是 []）。
 *   2. HTTP 状态码与 code 保持一致。
 *   3. message 为中文可读文案；422 时 extra.errors 承载字段级明细（契约 §0.4）。
 */
class Response
{
    public function __construct(private ResponseInterface $response)
    {
    }

    public function success(mixed $data = true, array $extra = []): ResponseInterface
    {
        return $this->json(ErrorCode::SUCCESS, $data, $extra, ErrorCode::message(ErrorCode::SUCCESS));
    }

    public function fail(int $code, ?string $message = null, mixed $data = null, array $extra = []): ResponseInterface
    {
        // 契约 §0.2 约束 1：失败时 data 恒为 null
        return $this->json($code, $data, $extra, $message ?? ErrorCode::message($code));
    }

    /**
     * 分页响应 —— 契约 §0.3。data 恒为 {list,total,page,pageSize}，不是裸数组。
     *
     * @param array<int, mixed> $list
     */
    public function paginated(array $list, int $total, int $page, int $pageSize): ResponseInterface
    {
        return $this->success([
            'list' => $list,
            'total' => $total,
            'page' => $page,
            'pageSize' => $pageSize,
        ]);
    }

    private function json(int $code, mixed $data, array $extra, string $message): ResponseInterface
    {
        $payload = [
            'data' => $data,
            'extra' => (object) $extra,
            'code' => $code,
            'message' => $message,
            'success' => $code === ErrorCode::SUCCESS,
        ];

        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        // ⚠️ 业务成功码是 0，但 0 不是合法 HTTP 状态码，必须映射成 200。
        //    契约 §0.5 规定 HTTP 状态码与 code 保持一致（0 对应 200）。
        return $this->response
            ->withStatus($code === ErrorCode::SUCCESS ? 200 : $code)
            ->withHeader('content-type', 'application/json; charset=utf-8')
            ->withBody(new SwooleStream($body === false ? '{}' : $body));
    }
}
