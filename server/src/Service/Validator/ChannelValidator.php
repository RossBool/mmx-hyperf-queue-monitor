<?php

declare(strict_types=1);

namespace App\Service\Validator;

use App\Constants\AlarmEnum;
use App\Support\Text;
use App\Support\Validator;

/**
 * 通知渠道校验 —— 契约 §4.3 N2-N6。
 *   N2 channels 1-5 条，channel 不得重复
 *   N3 channel=5：callbackUrl 必填（http(s):// 开头，<=500），receivers 必须为空
 *   N4 channel!=5：callbackUrl 必须为 null
 *   N5 receivers 0-100 个；邮箱/手机号基础格式校验；**预置模板允许空数组**
 *   N6 silenceTime ∈ [0,1440]，默认 0
 */
class ChannelValidator
{
    /**
     * @return array<int, array{channel:int,receivers:string[],callbackUrl:?string,silenceTime:int}>
     */
    public function validate(mixed $channels, Validator $errors, string $prefix = 'channels'): array
    {
        if (! is_array($channels) || $channels === []) {
            $errors->add($prefix, '通知渠道必须为 1-5 条');
            return [];
        }
        if (count($channels) < AlarmEnum::CHANNEL_MIN || count($channels) > AlarmEnum::CHANNEL_MAX) {
            $errors->add($prefix, '通知渠道必须为 1-5 条');
            return [];
        }

        $normalized = [];
        $seen = [];
        foreach (array_values($channels) as $index => $raw) {
            $path = $prefix . '.' . $index;
            $raw = (array) $raw;
            $before = count($errors->errors());

            if (! isset($raw['channel']) || ! is_numeric($raw['channel'])) {
                $errors->add($path . '.channel', '通知渠道必须提供');
                continue;
            }
            $channel = (int) $raw['channel'];
            if (! isset(AlarmEnum::NOTIFY_CHANNEL[$channel])) {
                $errors->add($path . '.channel', '通知渠道必须是 1/2/3/4/5 之一');
                continue;
            }
            if (isset($seen[$channel])) {
                $errors->add($path . '.channel', '同一通知渠道不可重复');
                continue;
            }
            $seen[$channel] = true;

            $receivers = $this->assertReceivers($raw['receivers'] ?? null, $channel, $path, $errors);
            $callbackUrl = $this->assertCallbackUrl($raw['callbackUrl'] ?? null, $channel, $path, $errors);
            $silenceTime = $this->assertSilenceTime($raw['silenceTime'] ?? null, $path, $errors);

            if (count($errors->errors()) > $before) {
                continue;
            }

            $normalized[] = [
                'channel' => $channel,
                'receivers' => $receivers,
                'callbackUrl' => $callbackUrl,
                'silenceTime' => $silenceTime,
            ];
        }

        return $normalized;
    }

    /**
     * N5：0-100 个；邮箱/手机号基础格式校验。
     * ⚠️ 注意是 **0-100**（不是 1-100）—— 预置模板出厂即为空占位（契约 §2.5 / N5）。
     *
     * @return string[]
     */
    private function assertReceivers(mixed $raw, int $channel, string $path, Validator $errors): array
    {
        if ($raw === null) {
            $errors->add($path . '.receivers', '接收人列表必须提供（无接收人时传空数组）');
            return [];
        }
        if (! is_array($raw)) {
            $errors->add($path . '.receivers', '接收人必须是数组');
            return [];
        }
        if (count($raw) > AlarmEnum::RECEIVER_MAX) {
            $errors->add($path . '.receivers', '接收人最多 100 个');
            return array_map('strval', array_values($raw));
        }

        $receivers = [];
        foreach (array_values($raw) as $i => $contact) {
            if (! is_string($contact) && ! is_numeric($contact)) {
                $errors->add($path . '.receivers.' . $i, '接收人必须是字符串');
                continue;
            }
            $contact = trim((string) $contact);
            if ($contact === '') {
                $errors->add($path . '.receivers.' . $i, '接收人不能为空字符串');
                continue;
            }
            if (Text::length($contact) > AlarmEnum::RECEIVER_CONTACT_MAX) {
                $errors->add($path . '.receivers.' . $i, sprintf('接收人长度不能超过 %d 个字符', AlarmEnum::RECEIVER_CONTACT_MAX));
                continue;
            }
            if (! $this->matchesChannelFormat($contact, $channel)) {
                $errors->add($path . '.receivers.' . $i, $this->formatHint($channel));
                continue;
            }
            $receivers[] = $contact;
        }

        // N3：channel=5（回调）receivers 必须为空
        if ($channel === AlarmEnum::CHANNEL_CALLBACK && $receivers !== []) {
            $errors->add($path . '.receivers', '回调渠道的接收人必须为空数组');
        }

        return $receivers;
    }

    /** N3 / N4 */
    private function assertCallbackUrl(mixed $raw, int $channel, string $path, Validator $errors): ?string
    {
        $url = ($raw === null || $raw === '') ? null : (string) $raw;

        if ($channel === AlarmEnum::CHANNEL_CALLBACK) {
            if ($url === null) {
                $errors->add($path . '.callbackUrl', '回调渠道必须填写回调地址');
                return null;
            }
            // 契约 N3：callbackUrl <= 500 字符。**严格按契约执行，不私自收紧。**
            // （曾经为了塞进 alarm_notification_receiver.contact 的 VARCHAR(255) 而收到 255，
            //   那是对契约的私自偏离；现已改为不再把回调地址镜像进该冗余表，冲突自然消失。）
            if (Text::length($url) > AlarmEnum::CALLBACK_URL_MAX) {
                $errors->add($path . '.callbackUrl', sprintf(
                    '回调地址长度不能超过 %d 个字符',
                    AlarmEnum::CALLBACK_URL_MAX
                ));
                return null;
            }
            if (! preg_match('#^https?://#i', $url)) {
                $errors->add($path . '.callbackUrl', '回调地址必须以 http:// 或 https:// 开头');
                return null;
            }
            return $url;
        }

        // N4：非回调渠道 callbackUrl 必须为 null
        if ($url !== null) {
            $errors->add($path . '.callbackUrl', '非回调渠道的 callbackUrl 必须为 null');
        }
        return null;
    }

    /** N6：silenceTime ∈ [0,1440]，默认 0 */
    private function assertSilenceTime(mixed $raw, string $path, Validator $errors): int
    {
        if ($raw === null || $raw === '') {
            return 0;
        }
        if (! is_numeric($raw)
            || (int) $raw < AlarmEnum::SILENCE_TIME_MIN
            || (int) $raw > AlarmEnum::SILENCE_TIME_MAX) {
            $errors->add($path . '.silenceTime', '静默时间必须是 0-1440 的整数');
            return 0;
        }
        return (int) $raw;
    }

    private function matchesChannelFormat(string $contact, int $channel): bool
    {
        return match ($channel) {
            1 => (bool) filter_var($contact, FILTER_VALIDATE_EMAIL),
            2, 4 => (bool) preg_match('/^1[3-9]\d{9}$/', $contact),
            3 => (bool) preg_match('/^[A-Za-z0-9_@-]{1,64}$/', $contact),
            default => true,
        };
    }

    private function formatHint(int $channel): string
    {
        return match ($channel) {
            1 => '邮件渠道的接收人必须是合法邮箱地址',
            2, 4 => '短信/电话渠道的接收人必须是合法的大陆手机号',
            3 => '微信渠道的接收人格式不合法',
            default => '接收人格式不合法',
        };
    }
}
