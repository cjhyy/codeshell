# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。只保留未完成/进行中的。

## 待办

| 状态 | #   | 任务                          | 备注 / 关键落点                                                                                                                                                                                                                            |
| ---- | --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 | 4   | plugin / skill 系统跟 Codex 对齐 | 本地安装 / 转换 / 运行时加载 / list-update-uninstall 已完成。**剩**:#11 远程安装 + 跨 MCP/builtin/skill 统一能力注册表收尾(core 大改) |
| 🟡 | 11  | 远程插件安装(git 来源)        | spec `docs/superpowers/specs/2026-05-29-plugin-remote-install-design.md`,**待实现**。`plugin install <source>` 支持 `github:org/repo`/https/ssh + `@ref`/`#subdir`;薄桥 = `gitClone` 拉临时目录 → `installPluginFromPath` 转换+装 → 删临时目录 |
| 🟡 | 10  | 多 session 上下文/串台 + 慢 修复 | 辅助任务模型已落地。**剩**:见「遗留 / 待确认」 |

## 遗留 / 待确认

- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增又掉回 1772,原因未查。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接 OpenAI-compat 路径;接非视觉 anthropic-style 模型时会漏(当前 claude 全支持视觉,YAGNI)。
- [ ] **main 领先 origin/main 未 push**。
- [ ] **并行 session 撞车风险** —— 同仓库可能有另一 session 在写+提交;在 main 上干活前先确认。
- [ ] **根 `tsup.config.ts` 是死配置**(指向不存在的 `src/run`/`src/product`,真实构建走 workspaces `--filter`),可顺手删/更新(低优先)。

## 📚 相关研究 / 资料

- 多 session 隔离/上下文装配调研:`docs/research/session-isolation-state.md`
- [CC vs Codex 图片处理对比](./docs/research-cc-vs-codex-image-handling.md)
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
