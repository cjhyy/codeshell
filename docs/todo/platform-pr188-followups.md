# PR188 非阻断修复清单

PR188 已通过整批 CC 静态审查、宿主原 smoke/完整 overlays 和远端 12 项 CI，并合入 `fc0af197078d4433a9f2cfca8668bdf95a3ffb7e`。以下 3 个 P2 不阻断该次合并，安排在第 8 批开头由 Codex 修复，再随本批代码交 CC review。未完成前保持未勾选。

- [ ] **账本归属不可认领时提供可恢复提示。** `desktop/src/main/external-runtime-operations.ts` / `external-runtime-service.ts`：搬迁或导入目录会使 usage-ledger 的 sessionScopeId 不再匹配。保留归属校验与 fail-closed，不能认领其他 owner 的账本；给出可操作提示（如在 Native 重建归属），不要把该情况误当 CLI 进程损坏而永久置 faulted。覆盖目录迁移/非法引用/再次提交，不修改已有归属或费用。
- [ ] **已发送终态的初始化失败不要重复显示。** `core/src/engine/engine.ts` 的 failClaimedRun 已发送 error/turn_complete 后 RPC 仍 reject，`desktop/renderer/app/useRunController.ts` catch 不应为同一 run 再追加终态和 toast。按本次 run/bucket 判断，不能用旧终态掩盖新失败；来自其他窗口的 abort 也不误报红色失败。覆盖已发终态、纯 RPC 失败、跨窗口取消、下一次真实失败。
- [ ] **修正提醒 intent 注释。** `external-runtime-service.ts` 的 injected reminder 沿用最近真实用户 intent，不会新增写入槽；完全没有用户消息才用空 origin。更新注释并核对对应去重/conflict 断言，不放宽实际授权机制。

CC 另外提到的旧 legacy SDK costStore 兼容、空闲 ownership pending、窗口失焦菜单行为和主线程同步 I/O 是可选后续项，不以本清单声称已解决。
