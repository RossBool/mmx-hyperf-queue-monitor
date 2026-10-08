<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmOverviewService;
use Psr\Http\Message\ResponseInterface;
// 构造参数必须用**容器绑定**的那个（hyperf/http-server 的 ConfigProvider
// 把它绑到 Hyperf\HttpServer\Response）。纯 PSR-7 的 ResponseInterface 是抽象接口，
// 容器无法实例化，会报 "cannot be resolved: the class is not instantiable" → 全部 500。
// ⚠️ 方法的**返回类型**仍然用 PSR-7 的，那是接口约束，与容器无关。
use Hyperf\HttpServer\Contract\ResponseInterface as HyperfResponse;

/**
 * ⑲ GET /api/alarm/overview —— 首页统计（契约 §3.3 ⑲，无查询参数）。
 */
class AlarmOverviewController extends AbstractController
{
    public function __construct(
        HyperfResponse $response,
        private AlarmOverviewService $service
    ) {
        parent::__construct($response);
    }

    public function index(): ResponseInterface
    {
        return $this->reply->success($this->service->overview());
    }
}
