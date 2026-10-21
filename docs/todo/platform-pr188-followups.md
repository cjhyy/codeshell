# PR188 非阻断修复清单

PR188 已通过整批 CC 静态审查、宿主原 smoke/完整 overlays 和远端 12 项 CI，并合入 `fc0af197078d4433a9f2cfca8668bdf95a3ffb7e`。以下 3 个 P2 不阻断该次合并，在第 8 批开头由 Codex 修复。CC 已审查至 `5d891c836fe99f67f104c96646d6d4b5d59ac2ed` 并确认这三项 closed；主控正常宿主 bg_5u1l8 的真实 HTTP/账本契约也已通过。第 8a 新发现另见[本轮审查清单](evidence/host-shared-services-cc-review-20261015.md)，不与本清单混算。

- [x] **账本归属不可认领时提供可恢复提示。** `desktop/src/main/external-runtime-operations.ts` / `external-runtime-service.ts`：搬迁或导入目录会使 usage-ledger 的 sessionScopeId 不再匹配。保留归属校验与 fail-closed，不能认领其他 owner 的账本；给出可操作提示（如在 Native 重建归属），不要把该情况误当 CLI 进程损坏而永久置 faulted。覆盖目录迁移/非法引用/再次提交，不修改已有归属或费用。
- [x] **已发送终态的初始化失败不要重复显示。** `core/src/engine/engine.ts` 的 failClaimedRun 已发送 error/turn_complete 后 RPC 仍 reject，`desktop/renderer/app/useRunController.ts` catch 不应为同一 run 再追加终态和 toast。按本次 run/bucket 判断，不能用旧终态掩盖新失败；来自其他窗口的 abort 也不误报红色失败。覆盖已发终态、纯 RPC 失败、跨窗口取消、下一次真实失败。
- [x] **修正提醒 intent 注释。** `external-runtime-service.ts` 的 injected reminder 沿用最近真实用户 intent，不会新增写入槽；完全没有用户消息才用空 origin。更新注释并核对对应去重/conflict 断言，不放宽实际授权机制。

CC 另外提到的旧 legacy SDK costStore 兼容、空闲 ownership pending、窗口失焦菜单行为和主线程同步 I/O 是可选后续项，不以本清单声称已解决。

## 第 8 批修复证据（2026-10-15）

- 账本：新增 `ExternalAccountingOwnershipError`，adopt 仍使用原 owner/scope/namespace 校验。拒绝归属时明确提示先 Native 运行一轮重建当前目录归属，保持 `model_error` wire，但不标记健康 CLI faulted。迁移目录重复尝试、非法 reference、旧账本/费用与 costState 保全、恢复后复用同一 provider 已有断言。
- renderer：本次 launch generation + bucket + clientMessageId + 非前次 runId 的 completed projection 才覆盖 RPC rejection。已有 stream 终态（包括其他窗口 abort）不再追加终态/toast；纯 RPC、新一次失败仍展示，旧 launch settlement 不影响新 launch。
- reminder：注释改为最近真实用户 intent；现有真实 recorder/controller 集成验证跨 send/restart 去重、conflict 和首条 injected 无写入授权，授权逻辑未放宽。
- 初始修复 shard：27 pass / 0 fail / 0 skipped，158 assertions，三个文件：`external-runtime-operations.test.ts`、`external-runtime-service.operations.test.ts`、`useRunController.launch.test.tsx`。最终合并验证、受限项和逐路径提交方案见 [本批交付记录](evidence/host-shared-services-20261015.md)。
