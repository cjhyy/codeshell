# 第十八批冻结基线与并行主分支变化

本批产品首跑固定于 `65691923fa629970ac26dc04e35362a9c4ab57a8`。收尾 fetch 已完成，origin/main 仍为 `02d5d9a9ecbbb206d5f3d8a1d367e7081d937101`；其他任务将 main 推进至 `67e09d1f6dda855b0d7e888769133128b0bc54ae`。本批工作树随后只快进同步，没有重跑产品。

[更新收据](evidence/main-refresh.json) 列出 5 个提交、5 个路径：CI workflow/test-path 修正、Write 工具卡与新回归、另一路验收文档。Root 只读旧 Write 候选对应的产品 diff，其余路径作为变化库存，不当作本批完整阅读/测试证据。本批实际 helper 和所选 worker sources 未变，仓库指令未变。

旧 [DESKTOP-R12-C1](../audit-2026-10-17-round12/desktop.md) 是未挂载工具卡的静态候选。其他任务提交 `656310a7c` 将 `FileToolCard.tsx` 的 `content.length` 字节标签改为缓存计算 `new TextEncoder().encode(content).byteLength`。本轮只确认源码变化；没有挂载卡片、调用 Write、写文件、跑新增回归或 UI/CI 验收，也不将旧候选改记为已复验确认/修复。

[addressed-sources](addressed-sources.json) 将该旧状态与本批 0 formal / 1 candidate / 0 related 分开。[source manifest](source-manifest.json) 中，单列的旧卡片是唯一冻结/当前/main 差异；source pins 不扩张 full-file/transitive/runtime 覆盖。其他审查动态方向及旧失败 backend/i18n/approval/replay 路线未重启。

历史查重收据保存的是同步前的冻结语料库存；另一路验收 Markdown 随 main 后来改变，不把旧 inventory SHA 与最终 main 全语料混为同一时点。查重数量、限定上下文和新问题证据各自独立保存。

[启动快照](evidence/integration-before.json) 和 [刷新快照](evidence/integration-premerge.json) 除 HEAD 外全部相等：原 tracked deletion 与 4 个普通 untracked 文件字节保留。只有本批 docs 属于待提交内容；全仓持续审查未完成。
