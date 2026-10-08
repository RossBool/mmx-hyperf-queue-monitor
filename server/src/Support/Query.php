<?php

declare(strict_types=1);

namespace App\Support;

use Psr\Http\Message\ServerRequestInterface;

/**
 * 查询参数读取助手。
 *
 * ## 为什么需要它
 *
 * `Query::get($request, 'policyType')` 是 **Laravel / Symfony 风格**的便捷方法，
 * **PSR-7 没有这个方法**，Hyperf 3.2 的 `Hyperf\HttpMessage\Server\Request` 也不提供。
 *
 * 实测：`method_exists(Request::class, 'input')` → `false`，
 * `method_exists(Request::class, 'header')` → `false`。
 * 一旦真起服务，每个列表端点都会 500：
 *   Call to undefined method Hyperf\HttpMessage\Server\Request::input()
 *
 * ## 为什么单测没抓到
 *
 * 列表/筛选/分页这 28 处全在 **Service** 层，Service 测试直接传数组或桩请求，
 * 从不经过 Hyperf 的请求对象。只有起真实服务才会碰到这个方法名。
 *
 * ## 本类的取值顺序
 *
 * 1. `getQueryParams()` —— 列表/筛选/分页参数走这里
 * 2. `getBodyParams()` —— 兜底：万一某个 GET 端点从 body 取值
 *
 * 刻意**不**引入 `input()` 这种 Laravel 兼容别名：
 * 名字一旦和 Laravel 对齐，读代码的人会以为这里跑的是 Laravel 语义，
 * 而底层根本不是。宁可让调用点多一层 `Query::get()`。
 */
final class Query
{
    /**
     * 取一个查询参数，缺失返回 null。
     *
     * 用 `??` 而不是 `array_key_exists` 是有意的：
     * `?foo=`（空串）与 `?foo=0` 都要能被上层区分开处理，
     * 而 `??` 只在键**不存在**时返回 null，正好匹配「没传就是没传」的语义。
     */
    public static function get(ServerRequestInterface $request, string $key, mixed $default = null): mixed
    {
        $query = $request->getQueryParams();
        if (array_key_exists($key, $query)) {
            return $query[$key];
        }

        // ⚠️ 兜底读 body 时必须用 `is_callable()`，**不能用 `method_exists()`**。
        //
        //    容器注入的是 `Hyperf\HttpServer\Request`。它的 body 数据方法
        //    `getInputData()` 是 **protected**，公开入口是 `all()`。
        //    `method_exists()` **只判断方法存在、不判断可见性**，对 protected 方法
        //    同样返回 true —— 于是直接调用会落到 `Macroable::__call()`，得到
        //      Method Hyperf\HttpServer\Request::getInputData does not exist
        //    这个报错极具误导性：明明「方法存在」，却说「不存在」。
        //
        //    `is_callable()` 同时考虑可见性，才是这里正确的判据。
        //    公开可调的 `all()` 内部就是 `getInputData()`，语义一致。
        if (is_callable([$request, 'all'])) {
            $all = $request->all();
            if (is_array($all) && array_key_exists($key, $all)) {
                return $all[$key];
            }
        }

        return $default;
    }
}
