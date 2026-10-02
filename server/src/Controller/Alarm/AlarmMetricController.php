<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Constants\AlarmEnum;
use App\Controller\AbstractController;
use App\Service\Metric\MetricDictionary;
use App\Support\Pagination;
use App\Support\Validator;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * ⑧ GET /api/alarm/metrics —— 指标字典，**不分页**，固定 28 条（契约 §3.2 ⑧）。
 */
class AlarmMetricController extends AbstractController
{
    public function __construct(
        ResponseInterface $response,
        private MetricDictionary $dictionary
    ) {
        parent::__construct($response);
    }

    public function index(RequestInterface $request): ResponseInterface
    {
        // 非数字按 422 处理而不是静默忽略（与 Pagination::intParam 口径一致）
        $errors = new Validator();
        $policyType = Pagination::intParam($request->input('policyType'), 'policyType', $errors);
        if ($policyType !== null && ! isset(AlarmEnum::POLICY_TYPE[$policyType])) {
            $errors->add('policyType', '策略类型必须是 1/2/3/4 之一');
        }
        $errors->validate();

        $namespace = $request->input('namespace');
        $namespace = ($namespace === null || trim((string) $namespace) === '') ? null : trim((string) $namespace);

        $keyword = $request->input('keyword');
        $keyword = ($keyword === null || trim((string) $keyword) === '') ? null : trim((string) $keyword);

        return $this->reply->success($this->dictionary->filter($policyType, $namespace, $keyword));
    }

}
