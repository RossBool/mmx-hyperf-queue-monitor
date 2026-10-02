<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmHistoryService;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * 告警历史端点 —— 契约 §3.3 ⑰-⑱。
 * ⚠️ 本模块**不提供删除端点**（契约 §4.4 H5）。
 */
class AlarmHistoryController extends AbstractController
{
    public function __construct(
        ResponseInterface $response,
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
