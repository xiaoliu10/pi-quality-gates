# Changelog

## [0.1.0] - 2026-10-17

首个可用版本。

- **settle-gate**：`agent_before_settle` 边界上跑验证电池；失败时返回 `continue:true` + `custom_message` 强制返工（默认最多 2 轮，超过则带「NOT verified」显式放行，防死循环）。
- **lint-inject**：edit/write 后跑快速诊断（tsc/lint/check 类命令）并把结果注入 `tool_result` content；干净时静默。
- **宿主无关 core**：`decideSettle` / `SettleGateState` / `runChecks` 不依赖 pi，pi 插件壳与 pi-virtual-employee 等宿主可共用。
- 纪律：闸门自身 fail-open（扩展异常不 wedge 宿主）、每检查墙钟预算（edit 10s / read-only 500ms）、输出尾部截断、无 verify 命令时整体 no-op。
- 测试：17 条单测 + 端到端冒烟（真起 bundled pi 1.3.0 RPC + 脚本化 provider，断言返工闭环与无扩展对照）。
