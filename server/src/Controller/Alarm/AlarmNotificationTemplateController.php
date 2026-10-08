<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmNotificationTemplateService;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;
// 构造参数必须用**容器绑定**的那个（hyperf/http-server 的 ConfigProvider
// 把它绑到 Hyperf\HttpServer\Response）。纯 PSR-7 的 ResponseInterface 是抽象接口，
// 容器无法实例化，会报 "cannot be resolved: the class is not instantiable" → 全部 500。
// ⚠️ 方法的**返回类型**仍然用 PSR-7 的，那是接口约束，与容器无关。
use Hyperf\HttpServer\Contract\ResponseInterface as HyperfResponse;

/**
 * 通知模板端点 —— 契约 §3.2 ⑬-⑯。
 */
class AlarmNotificationTemplateController extends AbstractController
{
    public function __construct(
        HyperfResponse $response,
        private AlarmNotificationTemplateService $service
    ) {
        parent::__construct($response);
    }

    /** ⑬ GET /api/alarm/notification-templates */
    public function index(RequestInterface $request): ResponseInterface
    {
        $page = $this->service->paginate($request);

        return $this->reply->paginated($page['list'], $page['total'], $page['page'], $page['pageSize']);
    }

    /** ⑭ POST /api/alarm/notification-templates */
    public function store(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->create($this->body($request), $this->currentUser()));
    }

    /** ⑮ PUT /api/alarm/notification-templates/{id} */
    public function update(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->update($this->pathId($request), $this->body($request)));
    }

    /** ⑯ DELETE /api/alarm/notification-templates/{id} */
    public function destroy(RequestInterface $request): ResponseInterface
    {
        return $this->reply->success($this->service->destroy($this->pathId($request)));
    }
}
