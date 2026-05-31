# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。**只保留未完成/进行中的**——已完成的请移除。

## 待办

| 状态 | #   | 任务                          | 备注 / 关键落点 |
| ---- | --- | ----------------------------- | --------------- |
| 🟡 | 4   | 跨 MCP/builtin/skill/plugin 统一能力注册表 | **后端已全部完成**:core `capability-control/`(`types`/`project`/`service` + TDD 测试)、desktop `capabilities-service.ts` 薄转发、`index.ts` 两个 `ipcMain.handle`(`capabilities:list` / `capabilities:setEnabled`)。spec:`docs/superpowers/specs/2026-05-29-capability-control-design.md`。**剩**:① preload 桥(`listCapabilities`/`setCapabilityEnabled`)—— **2026-05-31 已改 `preload/index.ts` + `types.d.ts`,但未 typecheck/未提交**,下个 session 先 `cd packages/desktop && bun run typecheck`(根 typecheck 不覆盖 desktop!)绿了再 commit;② 一个**用它的统一「能力」UI**(替代/并列现有分散的 插件/技能/MCP tab)—— 产品决策,需定方向后再做 |
| 🟡 | 10  | 多 session 上下文/串台 + 慢 修复 | 辅助任务模型已落地。**剩**:见「遗留 / 待确认」 |

## 遗留 / 待确认

- [ ] **#4 preload 桥未提交** —— 2026-05-31 改了 `packages/desktop/src/preload/index.ts`(加 `listCapabilities`/`setCapabilityEnabled` 桥)+ `types.d.ts`(加 `CodeshellApi` 类型 + 引入 `CapabilityDescriptor`),**还没跑 desktop typecheck、没 commit**。新 session 第一件事:验证 + 提交。改动小、低风险。
- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增又掉回 1772,原因未查。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接 OpenAI-compat 路径;接非视觉 anthropic-style 模型时会漏(当前 claude 全支持视觉,YAGNI)。
- [ ] **本地 main 领先 origin/main 未 push**(~94 commit;此前选择本地合并不 push)。
- [ ] **并行 session 撞车风险** —— 同仓库可能有另一 session 在写+提交;在 main 上干活前先确认。
- [ ] **根 `tsup.config.ts` 是死配置**(指向不存在的 `src/run`/`src/product`,真实构建走 workspaces `--filter`),可顺手删/更新(低优先)。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研:`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
- 统一能力控制层设计:`docs/superpowers/specs/2026-05-29-capability-control-design.md`
- 扩展 UI:`docs/superpowers/specs/2026-05-29-extensions-ui-*.md`(已实现)

---

> **已完成并从本表移除**(2026-05-30 ~ 05-31):#11 远程插件安装(git 来源)、#12 全量逐文件 review(121 条已验证项全处理)、Extensions/自动化界面 UI、插件安装卡死修复(git 非交互)。详见 git log。
