import { describe, expect, it } from 'vitest'

import {
  toAlarmHandleAction,
  toAlarmLevel,
  toAlarmNotifyChannel,
  toAlarmObjectType,
  toAlarmOperator,
  toAlarmPeriod,
  toAlarmPolicyType,
} from '../alarm'

describe('枚举收窄工具', () => {
  it('合法数值原样返回精确类型', () => {
    expect(toAlarmLevel(1)).toBe(1)
    expect(toAlarmLevel(3)).toBe(3)
    expect(toAlarmPolicyType(2)).toBe(2)
    expect(toAlarmPeriod(30)).toBe(30)
    expect(toAlarmObjectType(4)).toBe(4)
  })
  it('越界数值返回 undefined（不静默兜底）', () => {
    expect(toAlarmLevel(0)).toBeUndefined()
    expect(toAlarmLevel(4)).toBeUndefined()
    expect(toAlarmPeriod(7)).toBeUndefined()
    expect(toAlarmPolicyType(99)).toBeUndefined()
  })
  it('operator 是符号字符串，绝不能当数字处理', () => {
    expect(toAlarmOperator('>')).toBe('>')
    expect(toAlarmOperator('!=')).toBe('!=')
    // 关键回归：以前按数字处理会导致所有策略写入 422
    expect(toAlarmOperator(1)).toBeUndefined()
    expect(toAlarmOperator('大于')).toBeUndefined()
  })
  it('字符串枚举不与数字互相误判', () => {
    expect(toAlarmHandleAction('handle')).toBe('handle')
    expect(toAlarmHandleAction('recover')).toBe('recover')
    expect(toAlarmHandleAction('resolved')).toBeUndefined()
    expect(toAlarmNotifyChannel(5)).toBe(5)
  })
  it('字符串形态的数字不被误收（form select 的经典坑）', () => {
    expect(toAlarmLevel('1' as unknown)).toBeUndefined()
    expect(toAlarmNotifyChannel('5' as unknown)).toBeUndefined()
  })
  it('null / undefined / 布尔 / 对象全部拒绝', () => {
    for (const bad of [null, undefined, true, {}, [], NaN])
      expect(toAlarmLevel(bad)).toBeUndefined()
  })
})
