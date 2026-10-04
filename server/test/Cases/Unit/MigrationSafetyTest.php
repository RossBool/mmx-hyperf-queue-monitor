<?php

declare(strict_types=1);
/**
 * 迁移幂等性与外键包裹的**源码级**回归测试。
 *
 * ## 为什么是"源码级"
 *
 * 沙箱里没有 PHP / Composer / MySQL，这两条修复只做过静态核对。
 * 本测试**不连接数据库**——它读迁移文件本身，把两条不变量钉死。
 * 等本地有 PHP 后 `phpunit` 可直接跑；即使 MySQL 还没起也拦得住回归。
 *
 * ## 两条不变量
 *
 * **S-07**：`up()` 里不得出现 `DROP TABLE`。
 *   原实现是 `DROP TABLE IF EXISTS` + `CREATE TABLE`，重跑会静默清空整表。
 *   `alarm_history` 尤其致命——同一模块的 schema 自称"永不删除"，
 *   而迁移第 27 行就把它 drop 掉。
 *
 * **S-17**：`up()` 必须被 `SET FOREIGN_KEY_CHECKS = 0/1` 包裹，且用 try/finally 兜住。
 *   该开关是**会话级**的：建表抛异常时不恢复，连接池会把这条已经关掉外键检查的
 *   session 交给下一个请求——那比本 bug 更隐蔽，因为它不在任何日志里。
 */
namespace Tests\Cases\Unit;

use Hyperf\Testing\TestCase;
use PHPUnit\Framework\Attributes\DataProvider;

final class MigrationSafetyTest extends TestCase
{
    private const MIGRATION_DIR = __DIR__ . '/../../../migrations';

    /**
     * 6 个建表迁移。seed 迁移（000700 / 000800）不建表，不受这两条约束。
     *
     * ⚠️ 这里**从目录实扫**，不写死文件名。
     * 写死的版本用的是 `..._create_alarm_condition_template.php`，
     * 而磁盘上的实际文件名带 `_table` 后缀
     * （`..._create_alarm_condition_template_table.php`）——
     * 6 条断言里有 4 条指向不存在的文件，**全部报「file does not exist」**。
     * 实扫之后新增/改名迁移不会再让这个测试无声地指向空气。
     */
    public static function createTableMigrationProvider(): array
    {
        $files = glob(self::MIGRATION_DIR . '/*_create_*.php') ?: [];
        sort($files);
        self::assertNotEmpty($files, 'migrations 目录下没扫到建表迁移');

        $out = [];
        foreach ($files as $path) {
            $out[basename($path, '.php')] = [basename($path)];
        }

        return $out;
    }

    private static function upBody(string $file): string
    {
        $path = self::MIGRATION_DIR . '/' . $file;
        self::assertFileExists($path);

        $src = (string) file_get_contents($path);
        $start = strpos($src, 'public function up');
        $end = strpos($src, 'public function down');
        self::assertNotFalse($start, $file . ' 找不到 up()');
        self::assertNotFalse($end, $file . ' 找不到 down()');

        return substr($src, $start, $end - $start);
    }

    /** 剥掉 `//` 行注释，避免注释里引用的原文被当成真实代码。 */
    private static function codeOnly(string $php): string
    {
        return (string) preg_replace('#^\s*//.*$#m', '', $php);
    }

    #[DataProvider('createTableMigrationProvider')]
    public function testUpDoesNotDropTable(string $file): void
    {
        $code = self::codeOnly(self::upBody($file));
        self::assertStringNotContainsString(
            'DROP TABLE',
            $code,
            $file . ' 的 up() 仍会 DROP TABLE —— 重跑该迁移会静默清空整表（S-07）。'
                . '应改为 CREATE TABLE IF NOT EXISTS。'
        );
    }

    #[DataProvider('createTableMigrationProvider')]
    public function testUpUsesCreateIfNotExists(string $file): void
    {
        $code = self::codeOnly(self::upBody($file));
        self::assertStringContainsString(
            'CREATE TABLE IF NOT EXISTS',
            $code,
            $file . ' 缺少 IF NOT EXISTS —— 迁移不幂等，重跑会因表已存在而报错（S-07）。'
        );
    }

    #[DataProvider('createTableMigrationProvider')]
    public function testUpWrapsForeignKeyChecksInTryFinally(string $file): void
    {
        $body = self::upBody($file);
        $code = self::codeOnly($body);

        self::assertStringContainsString(
            'SET FOREIGN_KEY_CHECKS = 0',
            $code,
            $file . ' 的 up() 没有关闭外键检查 —— 父表被子表 FK 挡住时会 errno 3730（S-17）。'
        );
        self::assertStringContainsString(
            'SET FOREIGN_KEY_CHECKS = 1',
            $code,
            $file . ' 的 up() 没有恢复外键检查（S-17）。'
        );

        // 关键：必须落在 finally 里，否则建表抛异常时会话开关泄漏。
        self::assertMatchesRegularExpression(
            '/finally\s*\{[^}]*SET FOREIGN_KEY_CHECKS = 1/s',
            $code,
            $file . ' 的 FOREIGN_KEY_CHECKS = 1 不在 finally 里 —— '
                . '建表失败时开关不恢复，连接池会把关掉外键检查的 session 交给下一个请求。'
        );
    }

    /**
     * down() 必须同样包裹：`migrate:rollback` 整批回滚时按 batch 逆序，子表先于父表，
     * 正常路径不撞 FK；但 `--step=1` 单步回滚 000100（父表）时 000200（子表，仍带 FK）
     * 还活着，不包裹就是 errno 3730。
     */
    #[DataProvider('createTableMigrationProvider')]
    public function testDownAlsoWrapsForeignKeyChecks(string $file): void
    {
        $src = (string) file_get_contents(self::MIGRATION_DIR . '/' . $file);
        $start = strpos($src, 'public function down');
        self::assertNotFalse($start, $file . ' 找不到 down()');

        $code = self::codeOnly(substr($src, $start));
        self::assertStringContainsString(
            'SET FOREIGN_KEY_CHECKS = 0',
            $code,
            $file . ' 的 down() 没有关闭外键检查 —— 单步回滚父表会 errno 3730（S-17）。'
        );
        self::assertMatchesRegularExpression(
            '/finally\s*\{[^}]*SET FOREIGN_KEY_CHECKS = 1/s',
            $code,
            $file . ' 的 down() 未在 finally 里恢复外键检查（S-17）。'
        );
    }

    /**
     * 顺带守住 S-08：schema.sql 声明的最低版本必须是 8.0.16。
     * 8.0.16 以下 MySQL 对 CHECK **只解析不执行**，29 条约束会静默失效且不报错。
     */
    public function testSchemaDeclaresMinimumMysqlVersion(): void
    {
        // ⚠️ 四层 `../` 不是笔误：从 `server/test/Cases/Unit/` 往上 3 层只到 `server/`，
        //    而 schema.sql 在**仓库根**的 `docs/` 下，与 `server/` 平级。
        //    原来写的是 3 层 → 指向 `server/docs/alarm/schema.sql`（不存在），
        //    这条断言从来没读到过文件内容，等于**S-08 的守卫一直是空转**。
        $path = __DIR__ . '/../../../../docs/alarm/schema.sql';
        self::assertFileExists($path);

        $src = (string) file_get_contents($path);
        self::assertMatchesRegularExpression(
            '/MySQL\s*>=\s*8\.0\.16/',
            $src,
            'schema.sql 声明的最低 MySQL 版本必须是 8.0.16 —— 8.0.16 以下只解析不执行 CHECK 约束。'
        );
        self::assertDoesNotMatchRegularExpression(
            '/MySQL\s*>=\s*8\.0\.1[0-5]\b/',
            $src,
            'schema.sql 仍声明着 < 8.0.16 的版本，29 条 CHECK 会静默失效。'
        );
    }
}
