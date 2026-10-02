<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Controller\AbstractController;
use App\Service\AlarmOverviewService;
use Psr\Http\Message\ResponseInterface;

/**
 * ⑲ GET /api/alarm/overview —— 首页统计（契约 §3.3 ⑲，无查询参数）。
 */
class AlarmOverviewController extends AbstractController
{
    public function __construct(
        ResponseInterface $response,
        private AlarmOverviewService $service
    ) {
        parent::__construct($response);
    }

    public function index(): ResponseInterface
    {
        return $this->reply->success($this->service->overview());
    }
}
