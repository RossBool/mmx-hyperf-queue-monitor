/**
 * 告警模块公共组件 —— 统一出口。
 *
 * ## 目录归属与并行分工（重要）
 *
 * 本目录（`src/pages/alarm/components/**`）与 `src/config/**` 由**脚手架任务**预先建好骨架。
 * 后续两个前端任务**只允许在自己目录下新增文件，不得改动本目录与 `src/config/**`**：
 *
 * | 任务 | 可写目录（只新增） | 只读依赖 |
 * | --- | --- | --- |
 * | 告警策略任务 | `src/pages/alarm/policy/**` | `src/pages/alarm/components/**`、`src/types/alarm.ts`、`src/services/api/alarm-*.api.ts` |
 * | 通知模板 + 告警历史任务 | `src/pages/alarm/notification-template/**`、`src/pages/alarm/history/**` | 同上 |
 *
 * 因此本目录只放**跨三个页面共用、且不会随业务迭代而频繁改形状**的东西：
 * 纯展示组件 + 枚举选项转换。需要新的公共件时，请**在本目录新增文件**并回写本 barrel，
 * 不要修改已有文件。
 *
 * ## 契约位置
 *
 * 所有类型、枚举取值、中文 label 都来自 `/workspace/docs/alarm/contract.md`（v1.0，已冻结），
 * 本目录**不重新定义任何枚举值**，统一从 `@/types/alarm` 引入。
 */
export * from './alarm-enum-options'
export { default as AlarmLevelBadge } from './alarm-level-badge.vue'
export { default as AlarmModulePlaceholder } from './alarm-module-placeholder.vue'

export { default as ConditionEditor } from './condition-editor.vue'
