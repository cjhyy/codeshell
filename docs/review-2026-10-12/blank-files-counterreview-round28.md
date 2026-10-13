# 第二十八轮：空白会话打开 Files 的正常回退

**未确认新问题，新增动态执行 0。** 正常已注册项目中，首次发送前打开 Files 虽会遇到尚未持久化的 UI 会话 ID，实际 Files 仍通过当前项目的主目录接口读取。不能从中间的 unknown-session 状态推导文件面板不可用。正式仍为86项（1P1/52P2/33P3），通用仍86文件251测试。

实际入口先由 [usePanelBuckets](../../packages/desktop/src/renderer/app/usePanelBuckets.ts:657) 调用 [App](../../packages/desktop/src/renderer/App.tsx:647) materialize，生成 [pendingFirstRun UI 行](../../packages/desktop/src/renderer/transcripts.ts:863)，没有启动模型。解析器 [仍返回 UI ID](../../packages/desktop/src/renderer/app/useRunController.ts:1000)，Main 未知会话使 [panel hook](../../packages/desktop/src/renderer/panels/usePanelWorkspaceRoot.ts:122) 得到root=null、mainRootId=null、ready=true。

关键反证在实际消费者：[PanelWorkspaceRootConsumer](../../packages/desktop/src/renderer/panels/PanelWorkspaceRootConsumer.tsx:4) 允许ready=true的body挂载，[PanelArea](../../packages/desktop/src/renderer/panels/PanelArea.tsx:474) 独立保留完整project，Files是 [alwaysEnabled内置项](../../packages/desktop/src/renderer/panels/PanelRegistry.ts:95)。[FilesPanel](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:142) 以当前primary.id查注册根，null workspace不会覆盖primary.path；其内部cwd随后来自该activeRoot，并 [选择project API](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:177)。所以实际静态参数是P/B.id/B.path，Main按同一B授权；无须先发送一条消息才能取得该回退。

R86恰好具有不同输入：真实摘要target继承**非null旧workspaceA**且暂无session根ID，覆盖了当前B.id的path；新空白会话的null则保留B.path。本轮不扩大R86、不重复R65，也不将Review的会话/仓库门禁套到Files。no-repo仍为现有“先选择项目”空态，未发现必须提前暴露沙盒树的新合同。

本轮是完整生产接线的**静态反证**，没有运行完整App、真实Electron或新fixture。既有App测试mock了PanelArea和authority，hook无ID与Files bare-props测试各有自己的覆盖范围，不能合称一次端到端通过。作者与独立审计均保留这些限制。

[作者原稿](validation/original-blank-files-round28/author-static.raw.md)、[独立最终反证](validation/original-blank-files-round28/independent-contract.final.raw.md)、[25路径双树指纹](validation/original-blank-files-round28/source-manifest.json)与[主审收据](validation/round28-static-review-results.json)已归档。24整文件相同，Main整体版本不同但相关字节段一致。[指纹范围说明](validation/original-blank-files-round28/hash-span-audit.md)区分846-byte三fsRoot注册封套与219-byte readDir箭头；两个SHA各自正确，原标签稿也保留。所有材料只有读文件/哈希和文档归档，不计产品执行或新测试。
