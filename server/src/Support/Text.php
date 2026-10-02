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
        return mb_strcut($value, 0, $maxChars, 'UTF-8');
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
