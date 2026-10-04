<?php

declare(strict_types=1);
/**
 * 切面（AOP）注册表。
 *
 * ## ⚠️ 这里必须返回**扁平的类名列表**，不能嵌套一层 'aspects' 键
 *
 * Hyperf\Di\Annotation\Scanner::loadAspects() 的实际读法是：
 *
 *     $aspects = file_exists($aspectsPath) ? include $aspectsPath : [];
 *     ...
 *     $aspects = array_merge($providerConfig['aspects'], $baseConfig['aspects'], $aspects);
 *     foreach ($aspects as $key => $value) {
 *         if (is_numeric($key)) { $aspect = $value; $priority = null; }
 *         else                  { $aspect = $key;  $priority = (int) $value; }
 *         AspectLoader::load($aspect);   // ← 这里会去反射 $aspect
 *     }
 *
 * 本文件是被**整个 include 进 `$aspects` 变量**的，不是被 merge 进去的配置。
 * 所以写成 `return ['aspects' => []];` 会让 `$aspects = ['aspects' => []]`，
 * 循环里 `$key = 'aspects'`（非数字）→ `$aspect = 'aspects'` →
 * `ReflectionManager::reflectClass('aspects')` → **Class aspects not exist**。
 *
 * 后果：`ClassLoader::init()` 直接抛异常，**一条测试都跑不起来**，
 * PHPUnit 在 bootstrap 阶段就死掉。这个项目**没有使用任何 AOP 切面**，
 * 所以正确的返回就是空数组。
 *
 * 将来真要加切面，写成：
 *     return [
 *         \App\Aspect\LoggingAspect::class,       // 数字键 = 默认优先级
 *         \App\Aspect\AuditAspect::class => 10,   // 字符串键 = 显式优先级
 *     ];
 * 同时在 composer.json 的 autoload 里加 `"aspects\\": "src/Aspect/"`。
 */
return [];
