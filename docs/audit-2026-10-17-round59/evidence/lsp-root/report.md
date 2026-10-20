# LSP workspace/root 初始化：有限静态审查

**0 正式 / 0 候选 / 0 新 related**。本次未建立新的正常 root/init 输入反例，不表示全部 LSP 行为正确。Root 提供冻结上下文 `c39eb6f987b7bd5d740fee6d8ab5b46718f9c9af`、branch59；未自行 Git 认证。只写本 tmp，0 产品导入/函数/helper/fixture/测试、实际 LSP 进程、native、网络与 Git 执行。

**先核旧范围。** [读前 pins](initial-pins.json)与[共享导航投影](shared-history-projection.json)保留时点。共享6010份 MD/JSON、4291442 JSON value scalars、纳冻58排59+、含档案；三目标命中37/37/56，cap100，均保存，无 parse error。这些是机器导航，未宣称读完130窗口。亲读[原 canonical](prior-canonical-read.json)：R4 source-manifest `/files/12,14,15` 和 coding-receipts `/sources/1,2,4` 与当前同 SHA，但行内仅 hash 绑定，不自动泛化全文。R4 `coding.md:1–47` 已记录 rootUriToPath 正常控制、CODING-R4-01 结果 URI、CODING-R4-02 diagnostics、languageId 静态候选和 N12 排除。原 `coding-tui-chat.md:84–111` 的 C4启动所有权及C5死client/并发等待是旧原因。旧类保持原状态，不重报、不重跑。

**实际链与反证。** `index.capability.ts:190–199` 把定义交给实际 lspTool（相邻权限字段不认证）。`tools/lsp.ts:66–91` 取 `ctx.cwd`，相对文件用该 cwd resolve，manager 也以同 cwd 获取，扩展名选 server，再发送该文件 URI。`manager.ts:26–32,72–83` 每个 root 有自己的 server 状态，将 cwd 转 URI，启动时用 `rootUriToPath` 还原 cwd，并将同 rootUri 交给 initialize。`client.ts:68–86` 原样发送 rootUri，随后发送 initialized。`root-path.ts:11–12` 已用 fileURLToPath；没有把旧 manager replace 修复重复记为新问题。按 cwd 分离、同 cwd 复用、读时更新 recency、四项 cap 和删除/关闭入口有明确实现；真实工具传 cwd，未使用模糊的无参 fallback。见[原显示](initial-source-display.json)、[真实 consumer/client 与声明](consumer-source-display.json)和[分类边界](classification.json)。没有凭不正常路径、任意初始化失败或真实服务器假设凑项。

**范围与限制。** 6产品源共456行声明语义：root-path13与servers71全文，manager/tools/client/registration四源选段；2个既有测试只读167行声明，0运行。产品/测试显示725行，显示中的 PATH/执行文件、spawn/listeners、权限字段等不冒充语义审查。另2份指令仅核同 SHA 复用、manager.test仅hash/no-match导航，3 hash-only。被动 registry 声明没有启动 client，不能证明真实初始化、active eviction、退出或 readiness；N12及旧动态失败永久 SKIP，没有用本次静态阅读替代验证。所有范围含既有重叠，不称首次、全局唯一覆盖或机制正确性。详细计数见[source-manifest](source-manifest.json)，首诊断/正常无命中与相邻显示边界见[diagnostics](diagnostics.json)。

11个源/instruction pins、4份所读旧 canonical 文档及共享 batch 结束 SHA 全同；[ending](ending-checks.json)只核自身输入，未重扫6010库存，Root另绑定完整共享历史。本包[收据](reviewer-receipt.json)自排除，冻结有限0结论。
