<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmPolicyService;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;
// 构造参数必须用**容器绑定**的那个（hyperf/http-server 的 ConfigProvider
// 把它绑到 Hyperf\HttpServer\Response）。纯 PSR-7 的 ResponseInterface 是抽象接口，
// 容器无法实例化，会报 "cannot be resolved: the class is not instantiable" → 全部 500。
// ⚠️ 方法的**返回类型**仍然用 PSR-7 的，那是接口约束，与容器无关。
use Hyperf\HttpServer\Contract\ResponseInterface as HyperfResponse;

/**
 * 告警策略端点 —— 契约 §3.1 ①-⑦（Base URL /api/alarm）。
 */
class AlarmPolicyController extends AbstractController
{
    public function __construct(
        HyperfResponse $response,
        private AlarmPolicyService $service
    ) {
        parent::__construct($response);
    }

    /** ① GET /api/alarm/policies */
    public function index(RequestInterface $request): ResponseInterface
    {
        $page = $this->service->paginate($request);

        return $this->reply->paginated($page['list'], $page['total'], $page['page'], $page['pageSize']);
    }

    /** ② GET /api/alarm/policies/{id} */
    public function show(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->detail($this->pathId($request)));
    }

    /** ③ POST /api/alarm/policies */
    public function store(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->create($this->body($request), $this->currentUser()));
    }

    /** ④ PUT /api/alarm/policies/{id}（全量更新） */
    public function update(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->update($this->pathId($request), $this->body($request)));
    }

    /** ⑤ DELETE /api/alarm/policies/{id} */
    public function destroy(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->destroy($this->pathId($request)));
    }

    /** ⑥ POST /api/alarm/policies/{id}/status（幂等） */
    public function changeStatus(RequestInterface $request): ResponseInterface
    {
        $body = $this->body($request);

        return $this->reply->success(
            $this->service->changeStatus($this->pathId($request), $body['status'] ?? null)
        );
    }

    /** ⑦ POST /api/alarm/policies/{id}/copy */
    public function copy(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->copy($this->pathId($request), $this->currentUser()));
    }
}
