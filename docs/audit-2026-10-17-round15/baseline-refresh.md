# 第十五批冻结基线与并行主分支更新

本批所有产品首跑和静态候选固定在 `ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`。收尾 fetch 已完成，origin/main 仍为 `02d5d9a9ecbbb206d5f3d8a1d367e7081d937101`，本地主分支由其他任务推进到 `41429f1b93f0316c019b8246b54d26585832c8bc`。相关六个提交和四个变更路径保存在 [并行更新收据](evidence/main-refresh.json)。本批分支随后只快进同步主分支；没有重跑产品验证。

四个变更路径涉及 Web JPEG 别名、其新增回归测试、Desktop acceptance workflow 和另一任务的发布验收记录。CODESHELL.md、AGENTS.md 及本批各 worker 固定的源码均无变化。冻结 Git blob、当前字节与选读范围分别由 [source manifest](source-manifest.json) 及专项 manifests 说明。

旧 [WEB-R8-02](../audit-2026-10-17-round8/web.md) 在其他任务提交 `c1bee99b4` 中获得源码修复：`image/jpg` 先包装成 `image/jpeg`，随后继续走普通大小限制/转换分支，避免旧提前返回。本轮只阅读该 diff 及新增受控回归测试源码，没有执行新增测试、图片解码、上传或 UI；因此仅标为其他任务已修改源码，不能据此声称本轮验证修复。此状态记录不计入本批 4 个新候选或 1 个旧候选关联。

启动时 primary HEAD 和原有未提交字节保留在 [初始快照](evidence/integration-before.json)。主分支外部推进后重新保存 [集成前快照](evidence/integration-premerge.json)，只比较并保留原有 dirty/untracked 内容；不恢复他人 HEAD 或修改。所有审查写入仅属于本批 docs 目录。
