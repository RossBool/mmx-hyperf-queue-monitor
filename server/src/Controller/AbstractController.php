<?php

declare(strict_types=1);

namespace App\Controller;

use App\Exception\BusinessException;
use App\Support\Response;
use Hyperf\HttpServer\Contract\ResponseInterface;
use Hyperf\HttpServer\Contract\RequestInterface;

use function Hyperf\Support\env;

abstract class AbstractController
{
    protected Response $reply;

    /**
     * hyperf/http-server 的 ConfigProvider 把 Hyperf\HttpServer\Contract\ResponseInterface
     * 绑定到 Hyperf\HttpServer\Response（它同时实现 PSR-7 ResponseInterface，
     * 通过 __call 转发 withStatus/withHeader/withBody）。
     */
    public function __construct(ResponseInterface $response)
    {
        $this->reply = new Response($response);
    }

    /**
     * 当前登录人。契约 §2.4/§2.5/§2.6 的 creatorName / handlerName 都取自这里。
     *
     * ⚠️ 当前由 AuthMiddleware 的占位鉴权 + env 兜底提供，
     * 接入真实用户服务后改为从 token 解析。
     *
     * @return array{id:int,name:string}
     */
    protected function currentUser(): array
    {
        return [
            'id' => 0,
            'name' => (string) env('ALARM_CURRENT_USER', 'system'),
        ];
    }

    /** 路径参数 {id}，非正整数一律 422（domain.md §5.1：先校验参数格式，再查存在性） */
    protected function pathId(RequestInterface $request): int
    {
        $id = $request->route('id');
        if (! is_numeric($id) || (int) $id < 1) {
            throw BusinessException::validation(['id' => 'id 必须是正整数']);
        }
        return (int) $id;
    }

    /**
     * JSON 请求体。契约 §0.1：Content-Type: application/json; charset=utf-8。
     * 空体按空数组处理（复制端点的请求体可以为空对象 {}）。
     */
    protected function body(RequestInterface $request): array
    {
        $body = (string) $request->getBody();
        if ($body === '') {
            return [];
        }
        $decoded = json_decode($body, true);

        return is_array($decoded) ? $decoded : [];
    }
}
