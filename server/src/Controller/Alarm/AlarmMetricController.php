<?php

declare(strict_types=1);

namespace App\Controller\Alarm;

use App\Support\Query;
use App\Constants\AlarmEnum;
use App\Controller\AbstractController;
use App\Service\Metric\MetricDictionary;
use App\Support\Pagination;
use App\Support\Validator;
use Hyperf\HttpServer\Contract\RequestInterface;
use Psr\Http\Message\ResponseInterface;
// 构造参数必须用**容器绑定**的那个（hyperf/http-server 的 ConfigProvider
// 把它绑到 Hyperf\HttpServer\Response）。纯 PSR-7 的 ResponseInterface 是抽象接口，
// 容器无法实例化，会报 "cannot be resolved: the class is not instantiable" → 全部 500。
// ⚠️ 方法的**返回类型**仍然用 PSR-7 的，那是接口约束，与容器无关。
use Hyperf\HttpServer\Contract\ResponseInterface as HyperfResponse;

/**
 * ⑧ GET /api/alarm/metrics —— 指标字典，**不分页**，固定 38 条（契约 §3.2 ⑧）。
 */
class AlarmMetricController extends AbstractController
{
    public function __construct(
        HyperfResponse $response,
        private MetricDictionary $dictionary
    ) {
        parent::__construct($response);
    }

    public function index(RequestInterface $request): ResponseInterface
    {
        // 非数字按 422 处理而不是静默忽略（与 Pagination::intParam 口径一致）
        $errors = new Validator();
        $policyType = Pagination::intParam(Query::get($request, 'policyType'), 'policyType', $errors);
        if ($policyType !== null && ! isset(AlarmEnum::POLICY_TYPE[$policyType])) {
            $errors->add('policyType', '策略类型必须是 1/2/3/4 之一');
        }
        $errors->validate();

        $namespace = Query::get($request, 'namespace');
        $namespace = ($namespace === null || trim((string) $namespace) === '') ? null : trim((string) $namespace);

        $keyword = Query::get($request, 'keyword');
        $keyword = ($keyword === null || trim((string) $keyword) === '') ? null : trim((string) $keyword);

        return $this->reply->success($this->dictionary->filter($policyType, $namespace, $keyword));
    }

}
