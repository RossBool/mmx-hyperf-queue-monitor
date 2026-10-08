<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmHistoryService;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;
// 构造参数必须用**容器绑定**的那个（hyperf/http-server 的 ConfigProvider
// 把它绑到 Hyperf\HttpServer\Response）。纯 PSR-7 的 ResponseInterface 是抽象接口，
// 容器无法实例化，会报 "cannot be resolved: the class is not instantiable" → 全部 500。
// ⚠️ 方法的**返回类型**仍然用 PSR-7 的，那是接口约束，与容器无关。
use Hyperf\HttpServer\Contract\ResponseInterface as HyperfResponse;

/**
 * 告警历史端点 —— 契约 §3.3 ⑰-⑱。
 * ⚠️ 本模块**不提供删除端点**（契约 §4.4 H5）。
 */
class AlarmHistoryController extends AbstractController
{
    public function __construct(
        HyperfResponse $response,
        private AlarmHistoryService $service
    ) {
        parent::__construct($response);
    }

    /** ⑰ GET /api/alarm/histories */
    public function index(RequestInterface $request): ResponseInterface
    {
        $page = $this->service->paginate($request);

        return $this->reply->paginated($page['list'], $page['total'], $page['page'], $page['pageSize']);
    }

    /** ⑱ POST /api/alarm/histories/{id}/handle */
    public function handle(RequestInterface $request): ResponseInterface
    {
        $body = $this->body($request);

        return $this->reply->success($this->service->handle(
            $this->pathId($request),
            $body['action'] ?? null,
            $body['remark'] ?? null,
            $this->currentUser()
        ));
    }
}
