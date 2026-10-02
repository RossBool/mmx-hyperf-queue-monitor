<?php

declare(strict_types=1);

namespace HyperfTest\Cases\Unit;

use App\Constants\AlarmEnum;
use App\Service\AlarmPolicyService;
use App\Support\Text;
use PHPUnit\Framework\TestCase;

/**
 * 复制策略命名规则（契约 §3.1 ⑦ / P16 / domain.md §5.4）。
 *
 * 覆盖：名称生成顺序、重试上限 99、按**字符**（非字节）截断、长度 <= 128。
 * 这部分逻辑已抽成纯函数 `copyNameCandidates()`，因此**不需要连数据库**。
 */
class CopyNameTest extends TestCase
{
    public function testFirstCandidateIsPlainCopySuffix(): void
    {
        $candidates = AlarmPolicyService::copyNameCandidates('生产 CVM CPU 监控');

        $this->assertSame('生产 CVM CPU 监控 - 副本', $candidates[0]);
    }

    public function testCandidatesIncrementWithParenthesisedNumber(): void
    {
        $candidates = AlarmPolicyService::copyNameCandidates('CPU');

        $this->assertSame('CPU - 副本', $candidates[0]);
        $this->assertSame('CPU - 副本(2)', $candidates[1]);
        $this->assertSame('CPU - 副本(3)', $candidates[2]);
        $this->assertSame('CPU - 副本(99)', $candidates[98]);
    }

    /** 重试到 (99) 为止，仍冲突返回 409（契约 §3.1 ⑦） */
    public function testCandidatesStopAtNinetyNine(): void
    {
        $candidates = AlarmPolicyService::copyNameCandidates('CPU');

        $this->assertCount(99, $candidates);
        $this->assertStringEndsWith('(99)', $candidates[98]);
    }

    public function testCandidateNamesAreAllUnique(): void
    {
        $candidates = AlarmPolicyService::copyNameCandidates('边缘节点告警');

        $this->assertCount(99, array_unique($candidates));
    }

    /** ⚠️ 关键用例：超长中文名必须按字符截断，不能按字节切出半截字符 */
    public function testLongChineseNameIsTruncatedByCharacters(): void
    {
        $longName = str_repeat('告', 128);          // 128 字符 = 384 字节
        $candidates = AlarmPolicyService::copyNameCandidates($longName);

        $first = $candidates[0];
        $this->assertSame(128, Text::length($first), '拼接后总长必须 <= 128 字符');
        $this->assertSame(str_repeat('告', 123) . ' - 副本', $first);
        // 断言没有半截 UTF-8 字符：mb_check_encoding 对非法序列返回 false
        $this->assertTrue(mb_check_encoding($first, 'UTF-8'));
    }

    public function testNumberedCandidateAlsoRespectsCharacterLimit(): void
    {
        $longName = str_repeat('警', 128);
        $candidates = AlarmPolicyService::copyNameCandidates($longName);

        $second = $candidates[1];
        $this->assertSame(128, Text::length($second));
        // ` - 副本(2)` = 8 字符，所以原名只保留 120 字符
        $this->assertSame(str_repeat('警', 120) . ' - 副本(2)', $second);
        $this->assertTrue(mb_check_encoding($second, 'UTF-8'));
    }

    public function testShortNameIsNotTruncated(): void
    {
        $candidates = AlarmPolicyService::copyNameCandidates('A');

        $this->assertSame('A - 副本', $candidates[0]);
        $this->assertLessThanOrEqual(AlarmEnum::POLICY_NAME_MAX, Text::length($candidates[0]));
    }

    public function testSourceNameIsTrimmed(): void
    {
        $candidates = AlarmPolicyService::copyNameCandidates('  前后有空格  ');

        $this->assertSame('前后有空格 - 副本', $candidates[0]);
    }

    public function testCopyAlwaysYieldsADisabledNameCandidate(): void
    {
        // P16：新策略 status 强制为 0，由 copy() 的 fill() 保证；
        // 这里只锁定「副本命名不含任何状态语义」，避免误把状态编进名字。
        foreach (AlarmPolicyService::copyNameCandidates('X') as $candidate) {
            $this->assertStringEndsNotWith(' - 副本-启用', $candidate);
        }
    }
}
