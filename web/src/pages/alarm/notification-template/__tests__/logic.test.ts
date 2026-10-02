/**
 * 通知模板 —— 纯逻辑层单测。
 *
 * 覆盖契约 §4.3 的**真正边界**（N1-N6 / N9）与 §0.3 分页归一化，
 * 每条断言都指向一个「漏了就会 422 / 崩 / 静默失败」的具体场景。
 */
import { describe, expect, it } from 'vitest'

import type { AlarmNotifyChannel } from '@/types/alarm'

import {
  ALARM_NOTIFY_CHANNEL,
  ALARM_PRESET_FLAG,

} from '@/types/alarm'

import {
  buildChannelsPayload,
  buildTemplateListQuery,
  buildTemplateRowMeta,
  channelLabel,
  CHANNELS_MAX,
  channelsToDrafts,
  clampPage,
  clampPageSize,
  countReceivers,
  createChannelDraft,
  draftToPayloadChannel,
  getTemplateReadiness,
  isNotifyChannel,
  validateReceiver,
  validateTemplateDraft,
} from '../logic'

const { EMAIL, SMS, WECHAT, VOICE, CALLBACK } = ALARM_NOTIFY_CHANNEL

function draft(overrides: { channel: AlarmNotifyChannel, receivers?: string[], callbackUrl?: string, silenceTime?: number } = { channel: EMAIL }) {
  return {
    key: `k-${overrides.channel}`,
    channel: overrides.channel,
    receivers: overrides.receivers ?? [],
    callbackUrl: overrides.callbackUrl ?? '',
    silenceTime: overrides.silenceTime ?? 0,
  }
}

describe('validateTemplateDraft —— N2 渠道至少 1 个', () => {
  it('选 0 个渠道时**被拦住**，不产出 payload', () => {
    const result = validateTemplateDraft({ name: '值班组', remark: '', channels: [] })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')

    expect(result.errors).toContainEqual({ field: 'channels', message: '至少需要选择 1 个接收渠道' })
  })

  it('选了 1 个渠道即可提交，且 payload 里只有这一个渠道', () => {
    const result = validateTemplateDraft({
      name: '  值班组  ',
      remark: '  核心交易  ',
      channels: [draft({ channel: EMAIL, receivers: ['ops@example.com'] })],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error('应当校验通过')

    // name / remark 去首尾空格后提交
    expect(result.payload.name).toBe('值班组')
    expect(result.payload.remark).toBe('核心交易')
    expect(result.payload.channels).toHaveLength(1)
    expect(result.payload.channels[0]).toEqual({
      channel: EMAIL,
      receivers: ['ops@example.com'],
      callbackUrl: null,
      silenceTime: 0,
    })
  })

  it('n2：契约只有 5 个渠道，第 6 条（含越界脏数据）被上限拦下', () => {
    // 契约 §1.11 只定义了 5 个渠道，N2 的「最多 5 条」是对脏数据的防御性上限。
    // 表单用多选构造，理论上到不了；这里用越界渠道值 99 构造出第 6 条，验证闸门确实存在。
    expect(CHANNELS_MAX).toBe(5)

    const result = validateTemplateDraft({
      name: 'x',
      remark: '',
      channels: [
        draft({ channel: EMAIL, receivers: ['a@b.com'] }),
        draft({ channel: SMS, receivers: ['13800000000'] }),
        draft({ channel: WECHAT }),
        draft({ channel: VOICE }),
        draft({ channel: CALLBACK, callbackUrl: 'https://x.com/h' }),
        draft({ channel: 99 as AlarmNotifyChannel }),
      ],
    })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors.some(error => error.message.includes('最多 5 个'))).toBe(true)
  })

  it('n2：重复 channel 在 payload 构造阶段就被去重（只留首个）', () => {
    const channels = buildChannelsPayload([
      draft({ channel: SMS, receivers: ['13800000000'] }),
      draft({ channel: SMS, receivers: ['13900000000'] }),
    ])

    expect(channels).toHaveLength(1)
    expect(channels[0].receivers).toEqual(['13800000000'])
  })
})

describe('validateTemplateDraft —— N3 回调 Webhook URL', () => {
  const callbackDraft = (callbackUrl: string) => draft({ channel: CALLBACK, callbackUrl })

  it('仅选中回调渠道时：URL 必填', () => {
    const result = validateTemplateDraft({ name: '回调组', remark: '', channels: [callbackDraft('')] })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors).toContainEqual({
      field: 'channels.0.callbackUrl',
      message: '选择「回调」渠道时，回调 Webhook URL 必填',
    })
  })

  it.each([
    ['ftp://example.com/hook', '必须以 http:// 或 https:// 开头'],
    ['example.com/hook', '必须以 http:// 或 https:// 开头'],
    ['https://', '必须以 http:// 或 https:// 开头'],
  ])('非法 URL %s 被格式校验拦下', (url, expected) => {
    const result = validateTemplateDraft({ name: '回调组', remark: '', channels: [callbackDraft(url)] })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors.some(error => error.message.includes(expected))).toBe(true)
  })

  it('合法 http/https URL 通过', () => {
    for (const url of ['http://example.com/hook', 'https://open.example.com/alarm?token=1']) {
      const result = validateTemplateDraft({ name: '回调组', remark: '', channels: [callbackDraft(url)] })
      expect(result.ok, `${url} 应当通过`).toBe(true)
    }
  })

  it('n3：URL 超过 500 字符被拦', () => {
    const result = validateTemplateDraft({
      name: '回调组',
      remark: '',
      channels: [callbackDraft(`https://example.com/${'a'.repeat(500)}`)],
    })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors.some(error => error.message.includes('不能超过 500'))).toBe(true)
  })

  it('n3：回调渠道的 receivers 在 payload 里被强制清空（契约要求必须为 []）', () => {
    const result = validateTemplateDraft({
      name: '回调组',
      remark: '',
      channels: [draft({ channel: CALLBACK, callbackUrl: 'https://example.com/hook', receivers: ['不该留下'] })],
    })

    // payload 归一化行为不变：接收人一定被清空，绝不会带着脏数据发到后端
    const payload = buildChannelsPayload([
      draft({ channel: CALLBACK, callbackUrl: 'https://example.com/hook', receivers: ['不该留下'] }),
    ])
    expect(payload[0].receivers).toEqual([])
    expect(payload[0].callbackUrl).toBe('https://example.com/hook')

    // 但草稿校验必须**显式报错**而不是放行：用户填的接收人不会被保存，
    // 静默丢弃比报错更糟——用户以为配好了，实际一条也发不出去。
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('回调渠道误填接收人应当校验不通过')
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'channels.0.receivers' }),
    ]))
  })

  it('n3：回调渠道正确用法（不填接收人）校验通过', () => {
    const result = validateTemplateDraft({
      name: '回调组',
      remark: '',
      channels: [draft({ channel: CALLBACK, callbackUrl: 'https://example.com/hook', receivers: [] })],
    })
    expect(result.ok).toBe(true)
  })

  it('n4：非回调渠道的 callbackUrl 在 payload 里被强制为 null', () => {
    const channel = draftToPayloadChannel(draft({ channel: EMAIL, receivers: ['ops@example.com'] }))
    expect(channel.callbackUrl).toBeNull()

    const sms = draftToPayloadChannel(draft({ channel: SMS, receivers: ['13800000000'] }))
    expect(sms.callbackUrl).toBeNull()
  })

  it('n4：非回调渠道填了 URL 时给出提示（即使 payload 已被归一化成 null）', () => {
    const result = validateTemplateDraft({
      name: '邮件组',
      remark: '',
      channels: [draft({ channel: EMAIL, receivers: ['ops@example.com'], callbackUrl: 'https://example.com/hook' })],
    })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors).toContainEqual({
      field: 'channels.0.callbackUrl',
      message: '仅「回调」渠道可以填写 Webhook URL',
    })
  })
})

describe('validateTemplateDraft —— N1 / N5 / N6', () => {
  it('n1：name 为空被拦；超 64 字符被拦', () => {
    const empty = validateTemplateDraft({ name: '   ', remark: '', channels: [draft({ channel: EMAIL })] })
    expect(empty.ok).toBe(false)

    const tooLong = validateTemplateDraft({
      name: 'a'.repeat(65),
      remark: '',
      channels: [draft({ channel: EMAIL })],
    })
    expect(tooLong.ok).toBe(false)
    if (tooLong.ok)
      throw new Error('应当校验失败')
    expect(tooLong.errors.some(error => error.field === 'name')).toBe(true)
  })

  it('n1：name 恰好 64 字符通过', () => {
    const result = validateTemplateDraft({ name: 'a'.repeat(64), remark: '', channels: [draft({ channel: EMAIL })] })
    expect(result.ok).toBe(true)
  })

  it('remark 超过 500 字符被拦', () => {
    const result = validateTemplateDraft({
      name: '模板',
      remark: 'a'.repeat(501),
      channels: [draft({ channel: EMAIL })],
    })
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors.some(error => error.field === 'remark')).toBe(true)
  })

  it('n5：receivers 恰好 100 个通过，101 个被拦', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => `ops${i}@example.com`)
    const okResult = validateTemplateDraft({ name: '模板', remark: '', channels: [draft({ channel: EMAIL, receivers: hundred })] })
    expect(okResult.ok).toBe(true)

    const overflow = validateTemplateDraft({
      name: '模板',
      remark: '',
      channels: [draft({ channel: EMAIL, receivers: [...hundred, 'extra@example.com'] })],
    })
    expect(overflow.ok).toBe(false)
    if (overflow.ok)
      throw new Error('应当校验失败')
    expect(overflow.errors.some(error => error.message.includes('不能超过 100 个'))).toBe(true)
  })

  it('n5：receivers 为 0 个**不拦**（min=1 已取消，预置模板出厂即空数组）', () => {
    const result = validateTemplateDraft({ name: '系统预置-邮件通知', remark: '', channels: [draft({ channel: EMAIL, receivers: [] })] })
    expect(result.ok).toBe(true)
  })

  it('n5：邮箱/手机号基础格式校验会报出具体是第几个接收人', () => {
    const result = validateTemplateDraft({
      name: '模板',
      remark: '',
      channels: [draft({ channel: EMAIL, receivers: ['ok@example.com', 'not-an-email'] })],
    })

    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors.some(error => error.message.includes('第 2 个接收人'))).toBe(true)
  })

  it('电话渠道只接受大陆手机号', () => {
    expect(validateReceiver(VOICE, '13800000000')).toBeNull()
    expect(validateReceiver(VOICE, '021-12345678')).toContain('大陆手机号')
  })

  it('n6：silenceTime 超出 [0, 1440] 被拦', () => {
    const tooBig = validateTemplateDraft({ name: '模板', remark: '', channels: [draft({ channel: EMAIL, silenceTime: 1441 })] })
    expect(tooBig.ok).toBe(false)

    const negative = validateTemplateDraft({ name: '模板', remark: '', channels: [draft({ channel: EMAIL, silenceTime: -1 })] })
    expect(negative.ok).toBe(false)

    const edge = validateTemplateDraft({ name: '模板', remark: '', channels: [draft({ channel: EMAIL, silenceTime: 1440 })] })
    expect(edge.ok).toBe(true)
  })

  it('空名称 + 0 渠道会**同时**报两条错误，不会只报第一条', () => {
    const result = validateTemplateDraft({ name: '', remark: '', channels: [] })
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('应当校验失败')
    expect(result.errors).toHaveLength(2)
  })

  it('payload 不携带 isPreset（契约：请求体传入无效，仅服务端写入）', () => {
    const result = validateTemplateDraft({ name: '模板', remark: '', channels: [draft({ channel: EMAIL })] })
    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error('应当校验通过')
    expect(result.payload).not.toHaveProperty('isPreset')
    expect(result.payload).not.toHaveProperty('id')
  })
})

describe('n9 —— 绑定就绪度', () => {
  it('channel≠5 且 receivers 为空 → 视为未配置完成', () => {
    const readiness = getTemplateReadiness([
      { channel: EMAIL, receivers: [], callbackUrl: null, silenceTime: 0 },
    ])

    expect(readiness.ready).toBe(false)
    expect(readiness.unconfiguredChannels).toEqual([EMAIL])
    expect(readiness.message).toContain('请补充接收人后才能绑定到策略')
    expect(readiness.message).toContain('邮件')
  })

  it('回调渠道（5）receivers 本就为空，**不**参与判定', () => {
    const readiness = getTemplateReadiness([
      { channel: CALLBACK, receivers: [], callbackUrl: 'https://example.com/hook', silenceTime: 0 },
    ])

    expect(readiness.ready).toBe(true)
    expect(readiness.unconfiguredChannels).toEqual([])
    expect(readiness.message).toBeNull()
  })

  it('多个未配置渠道会一并列出（按契约渠道顺序）', () => {
    const readiness = getTemplateReadiness([
      { channel: VOICE, receivers: [], callbackUrl: null, silenceTime: 0 },
      { channel: EMAIL, receivers: [], callbackUrl: null, silenceTime: 0 },
    ])

    expect(readiness.unconfiguredChannels).toEqual([EMAIL, VOICE])
    expect(readiness.message).toContain('邮件')
    expect(readiness.message).toContain('电话')
  })

  it('全部配好接收人时 ready=true', () => {
    const readiness = getTemplateReadiness([
      { channel: EMAIL, receivers: ['ops@example.com'], callbackUrl: null, silenceTime: 0 },
      { channel: CALLBACK, receivers: [], callbackUrl: 'https://x.com/h', silenceTime: 0 },
    ])

    expect(readiness.ready).toBe(true)
    expect(readiness.message).toBeNull()
  })

  it('channels 缺失 / 非数组 / 空数组时按「未配置完成」处理，不崩（失效关闭）', () => {
    for (const input of [undefined, null, [] as never]) {
      const readiness = getTemplateReadiness(input)
      expect(readiness.ready).toBe(false)
      expect(readiness.message).toContain('绑定到策略')
    }
  })
})

describe('展示派生', () => {
  it('countReceivers 统计所有渠道接收人，回调渠道不计', () => {
    expect(countReceivers([
      { channel: EMAIL, receivers: ['a@x.com', 'b@x.com'], callbackUrl: null, silenceTime: 0 },
      { channel: SMS, receivers: ['13800000000'], callbackUrl: null, silenceTime: 0 },
      { channel: CALLBACK, receivers: [], callbackUrl: 'https://x.com/h', silenceTime: 0 },
    ])).toBe(3)
  })

  it('buildTemplateRowMeta 输出渠道编码（契约顺序）+ 接收人数 + N9 提示', () => {
    const meta = buildTemplateRowMeta({
      id: 5,
      name: '系统预置-邮件通知',
      remark: '',
      channels: [
        { channel: CALLBACK, receivers: [], callbackUrl: 'https://x.com/h', silenceTime: 0 },
        { channel: EMAIL, receivers: [], callbackUrl: null, silenceTime: 0 },
      ],
      isPreset: ALARM_PRESET_FLAG.PRESET,
      creatorName: 'system',
      createdAt: '2026-09-01 09:00:00',
      updatedAt: '2026-09-01 09:00:00',
    })

    expect(meta.channelValues).toEqual([EMAIL, CALLBACK])
    expect(meta.receiverCount).toBe(0)
    expect(meta.readiness.ready).toBe(false)
  })

  it('channelsToDrafts 把 null 的 callbackUrl 归一成空串，供表单绑定', () => {
    const drafts = channelsToDrafts([
      { channel: EMAIL, receivers: ['a@x.com'], callbackUrl: null, silenceTime: 5 },
    ])

    expect(drafts[0].callbackUrl).toBe('')
    expect(drafts[0].silenceTime).toBe(5)
    expect(drafts[0].receivers).toEqual(['a@x.com'])
  })

  it('channelsToDrafts 遇到非数组输入返回空数组，不崩', () => {
    expect(channelsToDrafts(undefined)).toEqual([])
    expect(channelsToDrafts(null as never)).toEqual([])
  })

  it('createChannelDraft 默认 silenceTime=0（N6 默认不静默）', () => {
    expect(createChannelDraft(EMAIL, 'k1').silenceTime).toBe(0)
  })

  it('channelLabel 对未知渠道有兜底，不返回 undefined', () => {
    expect(channelLabel(EMAIL)).toBe('邮件')
    expect(channelLabel(99 as AlarmNotifyChannel)).toBe('未知渠道(99)')
  })
})

/**
 * 接收人基础格式（N5）。
 *
 * 这里对**每个渠道**逐个断言，是为了让「`validateReceiver` 改成按渠道查表后漏配某个渠道」
 * 这种回归变成编译期 + 运行期双重失败——漏配会得到 `undefined` 的 pattern，
 * 表现是「该渠道的格式校验被静默跳过」，属于失效开放，必须被测出来。
 */
describe('validateReceiver —— 逐渠道基础格式', () => {
  it.each([
    ['空串（任何渠道）', EMAIL, '   ', '接收人不能为空'],
    ['邮件 · 正常', EMAIL, 'ops@example.com', null],
    ['邮件 · 多级子域名', EMAIL, 'ops@sub.domain.co.uk', null],
    ['邮件 · 缺 TLD', EMAIL, 'ops@example', '邮箱格式不正确'],
    ['邮件 · 多个 @', EMAIL, 'a@@b.com', '邮箱格式不正确'],
    ['邮件 · 空标签段', EMAIL, 'a@b..com', '邮箱格式不正确'],
    ['邮件 · 含空格', EMAIL, 'a b@example.com', '邮箱格式不正确'],
    ['短信 · 大陆手机号', SMS, '13800000000', null],
    ['短信 · 国际区号', SMS, '+8613800000000', null],
    ['短信 · 含字母', SMS, '1380000000a', '手机号格式不正确'],
    ['短信 · 太短', SMS, '12345', '手机号格式不正确'],
    ['电话 · 大陆手机号', VOICE, '13800000000', null],
    ['电话 · 座机号', VOICE, '021-12345678', '电话渠道仅支持大陆手机号'],
    ['电话 · 首位非 1', VOICE, '23800000000', '电话渠道仅支持大陆手机号'],
    // 契约未规定微信号 / 公众号格式，只挡空白
    ['微信 · 任意标识', WECHAT, 'ops-wechat', null],
    ['微信 · 空白', WECHAT, '   ', '接收人不能为空'],
  ])('%s', (_label, channel, receiver, expected) => {
    expect(validateReceiver(channel, receiver)).toBe(expected)
  })

  it('回调渠道不校验接收人格式（契约 N3：它的 receivers 恒为 []）', () => {
    expect(validateReceiver(CALLBACK, '随便什么')).toBeNull()
  })

  it('首尾空格会被 trim 后再校验（粘贴邮箱常见的脏输入）', () => {
    expect(validateReceiver(EMAIL, '  ops@example.com  ')).toBeNull()
  })
})

describe('buildTemplateListQuery —— §0.3 / ⑬', () => {
  it('空关键词视为未传；合法关键词去空格后带上', () => {
    expect(buildTemplateListQuery({ keyword: '   ' })).toEqual({ page: 1, pageSize: 20 })
    expect(buildTemplateListQuery({ keyword: '  值班  ' }).keyword).toBe('值班')
  })

  it('渠道 + 预置标记都带上', () => {
    const query = buildTemplateListQuery({ keyword: '', channel: SMS, isPreset: ALARM_PRESET_FLAG.PRESET }, 2, 50)
    expect(query).toEqual({ page: 2, pageSize: 50, channel: SMS, isPreset: 1 })
  })

  it('非法渠道值被丢弃（宁可不过滤，也不要让后端返 422）', () => {
    expect(buildTemplateListQuery({ keyword: '', channel: 99 as AlarmNotifyChannel })).not.toHaveProperty('channel')
  })

  it.each([
    ['abc', 1],
    [0, 1],
    [-3, 1],
    [undefined, 1],
    [2, 2],
  ])('页码 %s 归一化为 %s', (page, expected) => {
    expect(clampPage(page)).toBe(expected)
  })

  it.each([
    [0, 1],
    [101, 100],
    [50, 50],
    ['abc', 20],
  ])('每页条数 %s 归一化为 %s', (pageSize, expected) => {
    expect(clampPageSize(pageSize)).toBe(expected)
  })

  it('isNotifyChannel 覆盖全部 5 个渠道', () => {
    expect([EMAIL, SMS, WECHAT, VOICE, CALLBACK].every(isNotifyChannel)).toBe(true)
    expect(isNotifyChannel(0)).toBe(false)
    expect(isNotifyChannel('1')).toBe(false)
  })
})

describe('回调渠道误填接收人必须显式提示（不得静默丢弃）', () => {
  const draftWith = (channels: unknown[]) => ({
    name: '回调模板',
    channels,
  }) as never

  it('回调渠道填了接收人 → 报错提示，且错误定位到 channels.<i>.receivers', () => {
    const result = validateTemplateDraft(draftWith([
      { channel: 5, receivers: ['someone@example.com'], callbackUrl: 'https://hooks.example.com/x', silenceTime: 0 },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('回调渠道误填接收人应当校验不通过')
    if (result.ok)
      throw new Error('应当校验不通过')
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'channels.0.receivers' }),
    ]))
  })

  it('回调渠道只填了空白接收人 → 不报错（去空白后为空，等价于没填）', () => {
    const result = validateTemplateDraft(draftWith([
      { channel: 5, receivers: ['   ', ''], callbackUrl: 'https://hooks.example.com/x', silenceTime: 0 },
    ]))
    expect(result.ok).toBe(true)
  })

  it('回调渠道未填接收人 → 正常通过（这是合法用法）', () => {
    const result = validateTemplateDraft(draftWith([
      { channel: 5, receivers: [], callbackUrl: 'https://hooks.example.com/x', silenceTime: 0 },
    ]))
    expect(result.ok).toBe(true)
  })

  it('对称性：非回调渠道填 callbackUrl 同样报错（N4）', () => {
    const result = validateTemplateDraft(draftWith([
      { channel: 1, receivers: ['a@example.com'], callbackUrl: 'https://hooks.example.com/x', silenceTime: 0 },
    ]))
    expect(result.ok).toBe(false)
    if (result.ok)
      throw new Error('非回调渠道填写 URL 应当校验不通过')
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'channels.0.callbackUrl' }),
    ]))
  })
})
