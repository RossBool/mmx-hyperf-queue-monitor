// @vitest-environment happy-dom
/**
 * 策略表单的**组件挂载**回归测试。
 *
 * 用 per-file docblock 指定 happy-dom，不改 vite.config.ts 的全局 test 配置，
 * 避免让 424 个纯函数测试的运行环境被牵连。
 *
 * ## 为什么必须有这个文件
 *
 * S-02：`policy-form.vue` 曾用 `computed(() => form.state.values)` 读取表单值。
 * `FormApi` 的 `get state()` 是普通 getter（@tanstack/form-core 的 dist/esm/FormApi.js
 * 里 0 处 `import vue`），computed 只求值一次并永久缓存 —— 响应式依赖图为空。
 *
 * 后果是向导永远停在第 1 步：点「下一步」→ `validateStep()` → `currentValues()`
 * 读到首次求值时的陈旧快照 → `name` 仍为空 → 校验失败早退 → 0 次请求。
 *
 * ## 为什么 424 个既有测试没抓到
 *
 * 全部是纯函数 / 传输层断言，没有一个挂载组件。而 `values.value` **直接读是有值的**
 * （store 原地改同一对象引用，computed 缓存的引用照样看到新值），所以纯函数层面
 * 完全正常 —— 断掉的只有 watch 和派生 computed。
 *
 * ## 两个实现取舍
 *
 * 1. **断言方式**：步骤容器用的是 `v-show` 而非 `v-if`，所有步骤的 DOM 始终存在，
 *    断言 `wrapper.html()` 里有没有某段文字是无效的。因此从步骤条读当前步
 *    （当前步按钮带 `bg-accent`）。
 * 2. **写入方式**：`monitorType` / `policyType` 是 shadcn Select（Radix 弹层，
 *    驱动方式在测试里极脆）。这里走组件自己的 `setValue` 写入入口 —— 它正是
 *    S-02 断掉的那条链路的起点（`setValue` → form store → `values.value` →
 *    `currentValues()`），用它反而更贴近缺陷本身。`name` 仍走真实 DOM 输入。
 */
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { ALARM_MONITOR_TYPE, ALARM_POLICY_TYPE } from '@/types/alarm'

import PolicyForm from '../components/policy-form.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  onBeforeRouteLeave: vi.fn(),
  useRoute: () => ({ query: {} }),
}))

// 被 mock 的 API 模块（审查 A-2a/A-2b）：
// 组件挂载后会拉**指标字典**与**通知模板字典**（`policy-form.vue:42,44-49`），
// 不 mock 会真的去连 localhost:3000 —— 实测一次跑测产生 60 次真实连接失败，
// 测试非 hermetic：这台机器上碰巧有 3000 端口服务时行为还会变。
function emptyPage() {
  return {
    code: 0,
    // ⚠️ 审查 A-2b：漏了 `success: true` 时组件走 `toast.error` 分支，
    //    字典恒为空 —— 测试照样「通过」，但测的不是组件真实行为。
    success: true,
    message: 'ok',
    data: { list: [], total: 0, pageIndex: 1, pageSize: 100, hasMore: false },
  }
}

vi.mock('@/services/api/alarm-notification.api', () => ({
  fetchAlarmNotificationTemplateList: vi.fn(async () => emptyPage()),
}))

vi.mock('@/services/api/alarm-policy.api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/api/alarm-policy.api')>()),
  fetchAlarmMetrics: vi.fn(async () => emptyPage()),
  fetchAlarmConditionTemplateList: vi.fn(async () => emptyPage()),
}))

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

const STEP_TITLES = ['基本信息', '告警条件', '告警通知', '确认'] as const

interface SetupState {
  setValue: (key: string, value: unknown) => void
  currentStep: number
  currentValues: () => Record<string, unknown>
}

function mountForm() {
  return mount(PolicyForm, {
    props: { mode: 'create' },
    global: { stubs: { RouterLink: true, RouterView: true } },
  })
}

function setupStateOf(wrapper: ReturnType<typeof mountForm>): SetupState {
  return (wrapper.vm as unknown as { $: { setupState: SetupState } }).$.setupState
}

/** 从步骤条读出当前步下标：带 bg-accent 的那个按钮 */
function currentStepIndex(wrapper: ReturnType<typeof mountForm>): number {
  // 按钮文本形如「1基本信息名称、监控类型与所属项目」，故用 includes 匹配标题
  const buttons = wrapper.findAll('button').filter(b => STEP_TITLES.some(t => b.text().includes(t)))
  expect(buttons, '步骤条应渲染 4 个步骤按钮').toHaveLength(4)
  const idx = buttons.findIndex(b => b.classes().includes('bg-accent'))
  expect(idx, '应有且只有一个当前步（bg-accent）').toBeGreaterThanOrEqual(0)
  return idx
}

async function clickNext(wrapper: ReturnType<typeof mountForm>) {
  const btn = wrapper.findAll('button').find(b => b.text().trim() === '下一步')
  expect(btn, '模板里应存在「下一步」按钮').toBeTruthy()
  await btn!.trigger('click')
  await nextTick()
}

describe('s-02 回归：策略向导必须能响应式地推进', () => {
  beforeEach(() => {
    push.mockClear()
  })

  it('未填名称时第 1 步校验应拦住，不放行', async () => {
    const wrapper = mountForm()
    await nextTick()
    const ss = setupStateOf(wrapper)
    // 补齐联动字段，只留 name 为空
    ss.setValue('monitorType', ALARM_MONITOR_TYPE.CLOUD_PRODUCT)
    ss.setValue('policyType', ALARM_POLICY_TYPE.CVM)
    await nextTick()

    expect(currentStepIndex(wrapper), '初始应停在第 1 步').toBe(0)
    await clickNext(wrapper)
    expect(currentStepIndex(wrapper), 'name 为空时必须停在第 1 步').toBe(0)
  })

  it('currentValues() 必须反映 setValue 之后的值（核心回归断言）', async () => {
    const wrapper = mountForm()
    await nextTick()
    const ss = setupStateOf(wrapper)

    ss.setValue('name', '生产 CVM CPU 监控')
    ss.setValue('monitorType', ALARM_MONITOR_TYPE.CLOUD_PRODUCT)
    ss.setValue('policyType', ALARM_POLICY_TYPE.CVM)
    await nextTick()

    // 修复前：currentValues() 走的是冻结快照，这里仍是初始的 '' / undefined
    const values = ss.currentValues()
    expect(values.name, 'currentValues() 应读到 setValue 写入的名称').toBe('生产 CVM CPU 监控')
    expect(values.monitorType, 'currentValues() 应读到 setValue 写入的 monitorType').toBe(
      ALARM_MONITOR_TYPE.CLOUD_PRODUCT,
    )
  })

  it('填入合法表单后点「下一步」能推进到第 2 步（用户可见症状的回归）', async () => {
    const wrapper = mountForm()
    await nextTick()
    const ss = setupStateOf(wrapper)

    // name 走真实 DOM 输入，模拟用户打字
    const input = wrapper.find('#policy-name')
    expect(input.exists(), '模板里应存在 #policy-name 输入框').toBe(true)
    await input.setValue('生产 CVM CPU 监控')
    await nextTick()

    ss.setValue('monitorType', ALARM_MONITOR_TYPE.CLOUD_PRODUCT)
    ss.setValue('policyType', ALARM_POLICY_TYPE.CVM)
    await nextTick()

    // 修复前：validateStep 读到冻结快照里的 name='' → 校验失败 → 永远停在第 1 步
    await clickNext(wrapper)
    expect(
      currentStepIndex(wrapper),
      '填了合法表单后点「下一步」应进入第 2 步（若仍为 0，说明 values 仍是冻结快照）',
    ).toBe(1)
  })
})

/**
 * S-14 存量兼容路径的**真组件**回归。
 *
 * ## 为什么不复用 `monitor-type-selectable.test.ts` 里那份
 *
 * 那份测试的 docblock 自己写着「复刻 policy-form.vue 里 monitorTypeOptions 的计算逻辑」——
 * 复刻件**可以和生产代码一起错**。对抗复核里我自己挂载真组件验证过产品行为是对的，
 * 但那次测试写在 /tmp 没进仓，等于仓里对这条路径零真组件覆盖。
 * 本块把同样的断言落在**真的 policy-form.vue** 上。
 *
 * ## 这里守的是什么
 *
 * 数据库层没有 CHECK 强制 monitorType ∈ 1..5，所以 monitorType=3/4/5 的存量数据
 * 确实可能存在。编辑这类策略时：
 *   - 选项里必须**看得到**当前值（否则 Reka Select 找不到匹配 item，
 *     trigger 回退显示 placeholder，真实值在用户眼前凭空消失）；
 *   - 必须**标注不可选**，让用户知道为什么选不了它；
 *   - 选中后 form.monitorType 要**原样回填**，不能被静默改成别的值。
 */
describe('s-14 回归：存量 monitorType=3/4/5 必须可见、可标注、可回填', () => {
  const LEGACY = [
    { value: 3, label: '前端性能监控' },
    { value: 4, label: '云拨测' },
    { value: 5, label: '终端性能监控' },
  ] as const

  for (const { value, label } of LEGACY) {
    it(`monitorType=${value} 时选项含「${label}（v1.0 不可选）」且不吞掉当前值`, async () => {
      const wrapper = mountForm()
      await nextTick()
      const ss = setupStateOf(wrapper) as unknown as {
        setValue: (k: string, v: unknown) => void
        monitorTypeOptions: { value: number, label: string }[]
      }

      ss.setValue('monitorType', value)
      await nextTick()

      const opts = ss.monitorTypeOptions
      const values = opts.map(o => o.value)
      const labels = opts.map(o => o.label)

      expect(values, `monitorType=${value} 应出现在选项里，否则编辑存量策略时显示不出真实值`).toContain(value)
      expect(
        labels.find(l => l.includes(label)),
        `应有「${label}（v1.0 不可选）」这样一项，注明为什么选不了`,
      ).toBeTruthy()

      // 不可选 ≠ 唯一：1/2 仍必须可选，否则新建路径也一起坏掉
      expect(values, '云产品/应用性能监控在任何状态下都应可选').toEqual(expect.arrayContaining([1, 2]))

      // 回填必须原样，不能被静默改写
      const after = (ss as unknown as { currentValues: () => Record<string, unknown> }).currentValues()
      expect(after.monitorType, '回填后 monitorType 必须保持原值').toBe(value)
    })
  }

  it('新建态（无存量值）不得出现 3/4/5 —— 这是死胡同修复的核心', async () => {
    const wrapper = mountForm()
    await nextTick()
    const ss = setupStateOf(wrapper) as unknown as {
      monitorTypeOptions: { value: number }[]
    }

    const values = ss.monitorTypeOptions.map(o => o.value)
    expect(values, '向导不该提供用户选了就走不完的选项').not.toContain(3)
    expect(values).not.toContain(4)
    expect(values).not.toContain(5)
    expect(values, '新建态应恰好是 1 和 2').toEqual([1, 2])
  })

  it('存量 monitorType=3 时策略类型为空，页面要说明原因而不是静默', async () => {
    const wrapper = mountForm()
    await nextTick()
    const ss = setupStateOf(wrapper) as unknown as {
      setValue: (k: string, v: unknown) => void
      policyTypeOptions: unknown[]
    }

    ss.setValue('monitorType', 3)
    await nextTick()

    expect(ss.policyTypeOptions, 'monitorType=3 在 v1.0 没有可用策略类型').toHaveLength(0)
    // 步骤容器用 v-show，DOM 一直在，所以这段提示对所有步骤都存在
    expect(
      wrapper.html(),
      '应出现「该监控类型在 v1.0 暂无可用策略类型」提示，让用户知道为什么走不下去',
    ).toContain('该监控类型在 v1.0 暂无可用策略类型')
  })
})
