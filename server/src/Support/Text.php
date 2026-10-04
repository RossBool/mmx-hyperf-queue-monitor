<?php

declare(strict_types=1);

namespace App\Support;

/**
 * 文本工具。
 */
class Text
{
    /**
     * 按**字符**（不是字节）截断。
     *
     * ⚠️ 契约 §3.1 ⑦ 明令禁止按字节截断：utf8mb4 下 128 个汉字 = 384 字节，
     * 按字节截断会切出半截字符。VARCHAR(128) 与 ck_policy_name_len 的
     * CHAR_LENGTH 都按字符计，所以这里用 mb_* 系列。
     */
    public static function truncateChars(string $value, int $maxChars): string
    {
        if ($maxChars <= 0) {
            return '';
        }
        // ⚠️ 必须是 `mb_substr`，**不能**用 `mb_strcut`。
        //    `mb_strcut($s, $start, $width, $enc)` 的第三个参数是**字节宽度**，
        //    不是字符数 —— 函数名里的 "cut" 指的就是「按显示宽度切」，
        //    它保证不切出半个字符，代价是**凑不满就少给几个字**。
        //    实测：`mb_strcut(str_repeat('告',200), 0, 123, 'UTF-8')`
        //          返回 41 字符 / 123 字节（123/3=41），而不是 123 字符；
        //          混排 `"ABC" + 50 个"告"` 切 5 字节时只得到 `"ABC"`，静默丢掉后面的字。
        //    旧实现用 mb_strcut，导致 VARCHAR(128) 按字符计的语义在中文名下
        //    实际只允许约 42 个字，而 ck_policy_name_len 允许 128 —— 两边不一致。
        return mb_substr($value, 0, $maxChars, 'UTF-8');
    }

    public static function length(string $value): int
    {
        return mb_strlen($value, 'UTF-8');
    }

    /**
     * LIKE 模糊查询转义。
     *
     * ⚠️ 契约 §3.x 要求 keyword 模糊查询必须转义，否则用户传 `%` / `_` 会变成全表通配，
     * 既是性能问题也是语义问题。这里转义 `\` `%` `_`。
     *
     * ⚠️ 配套的 `ESCAPE '\\'` 子句由 `likeCondition()` **真的写进 SQL**。
     *    MySQL 的 LIKE 默认转义符就是反斜杠，但显式写出来有两个好处：
     *      1. 行为不依赖服务端默认值；
     *      2. 在 `NO_BACKSLASH_ESCAPES` sql_mode 下语义仍然确定。
     *    （早前这里只有注释声称有 ESCAPE、SQL 里却没有，现已让代码与注释一致。）
     */
    public static function escapeLike(string $keyword): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $keyword);
    }

    /** 转义后的匹配值（配合 `likeCondition()` 使用） */
    public static function likeExpression(string $keyword): string
    {
        return '%' . self::escapeLike($keyword) . '%';
    }

    /**
     * 生成 `col LIKE ? ESCAPE '\\'` 片段，供 `whereRaw()` 使用。
     *
     * @param string $column **硬编码的列名常量**，不可来自用户输入
     * @return string 含一个 `?` 占位符
     */
    public static function likeCondition(string $column): string
    {
        return sprintf("%s LIKE ? ESCAPE '\\\\'", $column);
    }
}
