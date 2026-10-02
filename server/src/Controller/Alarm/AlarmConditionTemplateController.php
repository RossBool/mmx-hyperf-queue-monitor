<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmConditionTemplateService;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * 触发条件模板端点 —— 契约 §3.2 ⑨-⑫。
 */
class AlarmConditionTemplateController extends AbstractController
{
    public function __construct(
        ResponseInterface $response,
        private AlarmConditionTemplateService $service
    ) {
        parent::__construct($response);
    }

    /** ⑨ GET /api/alarm/condition-templates */
    public function index(RequestInterface $request): ResponseInterface
    {
        $page = $this->service->paginate($request);

        return $this->reply->paginated($page['list'], $page['total'], $page['page'], $page['pageSize']);
    }

    /** ⑩ POST /api/alarm/condition-templates */
    public function store(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->create($this->body($request), $this->currentUser()));
    }

    /** ⑪ PUT /api/alarm/condition-templates/{id} */
    public function update(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->update($this->pathId($request), $this->body($request)));
    }

    /** ⑫ DELETE /api/alarm/condition-templates/{id} */
    public function destroy(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->destroy($this->pathId($request)));
    }
}
