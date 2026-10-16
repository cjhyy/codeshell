# Desktop 从零审查（本轮收尾）

基线：`66ee7737a7d6203319834e601c84afe6757f801e`。产品代码只读；记录及独立最小复现仅位于本目录。旧审查材料只用于对新发现查重，不作为证据来源。

## 已确认问题

### D01 / P2：Git 项目的中文及带特殊字符文件名被当成 Git 转义字面量，@ 搜索找不到真实文件

- 位置：`packages/desktop/src/main/file-search-service.ts:59`（`git ls-files` 没有 `-z`）、`:90-93`（按换行再 `trim`）、`:102-103`（将输出原样当路径）。调用链：`renderer/chat/MentionPopover.tsx:107` → preload `index.ts:1046` → Main `index.ts:5019-5023` → `searchProjectFiles` → `searchFiles` → `listViaGit`。
- 触发：正常 Git 项目、默认 `core.quotePath` 配置，存在 `报告.md`，用户输入 `@报告`。不需要提交文件，普通未忽略的新文件即可。Git 默认输出 `"\346\212\245\345\221\212.md"`；源码没有解码，并用转义结果匹配查询/拼接绝对路径。
- 预期：按真实 Unicode 文件名搜索并返回可读取的相对路径。实际：`searchFiles(root, "报告")` 为 `[]`；空查询返回带引号和八进制转义的不存在路径。带换行文件名同样变为 `"line\nbreak.md"`，不能读取。ASCII 文件及非 Git 目录中的相同中文文件均通过对照。
- 影响：中文文件常见项目无法使用 @ 引用；空查询选择这些候选还会插入错误路径。没有推导任意文件读取或安全绕过。
- 验证层级：**真实生产 service + 临时磁盘 + 真实 Git 子进程**，未运行 Electron 端到端。独立源码相对导入，无 workspace `dist` 替代；所有磁盘在 owned 临时目录，afterEach 清理。`desktop-file-search.test.ts` 中前两个测试。
- 是否已知：针对旧 `docs/review-*` 的 `file-search`、`quotePath`、`git ls-files`、中文搜索关键词查重，未找到同根因已记录项。现有 `file-search-service.test.ts` 只测试非 Git 目录。

### D02 / P2：多根项目先全局截断，再筛当前根，使当前根匹配文件无故消失

- 位置：`packages/desktop/src/main/file-search-service.ts:231-233` 全局 top30；`packages/desktop/src/renderer/chat/MentionPopover.tsx:109-110` 再按 `rootId` 筛选。
- 触发：正常挂载的多根项目中，选中根 A 有 `a-long-directory/needle-document.md`，另一个根 B 有 30 个得分更高的 `needle-00.md` 至 `needle-29.md`。用户在根 A 的聊天输入 `@needle`。
- 调用链与 D01 相同，但本项完全使用 ASCII、健康 Git 项目，不依赖文件名解码。`searchFiles(A,"needle")` 正确返回 1 个文件；项目搜索先让 B 占满 30 个结果；Popover 再 `.filter(hit.rootId === rootId)`，最终为空。
- 预期：当前授权根有匹配时能够从该根搜索选择。实际：其他根的候选占满全局上限后被 UI 全部删掉，当前根候选没有机会进入 UI。
- 影响：文件发现性随项目另一根内容变化而消失；用户不能通过当前 UI 选择已存在的匹配文件。服务全局排名本身符合其注释，本项为服务与当前根 UI 的组合错误。
- 验证层级：**真实生产 service + 临时双根磁盘 + 真实 Git 子进程**；复现仅对返回结果执行与生产 Popover 完全相同的筛选，未声称真实渲染器/Electron 已执行。`desktop-file-search.test.ts` 第三个测试。
- 是否已知：搜索旧审查的 `MentionPopover`、多根与 30 上限关键词，未找到同根因已记录项。

### D03 / P2：Chrome Native 的 JSON-lines 分片解码会静默损坏中文或 emoji

- 位置：`packages/desktop/src/main/browser-runtime/chrome-native-protocol.ts:63-64`，在缓存完整 JSON 行之前对每个 Buffer 单独 `.toString()`。使用点：Main 的 `chrome-native-server.ts:132,135,142` 接收 TCP chunk；Native relay 的 `chrome-native-protocol.ts:126-128` 接收相反方向 TCP chunk。
- 触发：已授权 Chrome Native Messaging 连接传递包含中文或 emoji 的正常 JSON，loopback TCP 在一个 UTF-8 多字节字符内部切开 chunk。TCP 的合法分片边界没有字符对齐承诺；不需要畸形 JSON、未授权消息或恶意内容。
- 预期：拼接接收到的字节后按完整 UTF-8 解码，得到原对象。实际：`中文 🐈` 在「中」第一个字节后切开会得到 `���文 🐈`，`JSON.parse` 仍然成功。这会把损坏值继续交付 request result/extension action，而非可诊断的解码错误。
- 影响：Chrome 页面读取的非 ASCII 文本可随机乱码；反向输入的非 ASCII 文本也可能被改写。确证范围是共享 decoder 的数据完整性；没有声称特定真实浏览器操作在原生端到端实验中已输入错误。
- 验证层级：**真实生产 decoder、逐字节边界动态复现**。包含中文和 emoji 的样本 7 个切分位置损坏；ASCII 的全部位置、完整 JSON 行、4 字节长度前缀的 `ChromeNativeMessageDecoder` 全部位置均保持原对象。没有启动真实 Chrome/Electron 或网络连接。
- 是否已知：在旧 `docs/review-*` 查 `JsonLineDecoder` / UTF-8 分片 / 多字节 / 乱码，无同根因记录。

## 验证收据

命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-16/evidence/desktop-file-search.test.ts`。guarded runner 创建隔离 HOME 并清除继承凭据。最终 **3 pass / 0 fail / 9 expect / 0 skipped / Completed**。

- [最小复现](evidence/desktop-file-search.test.ts)
- [完整日志](evidence/desktop-file-search.log)

第二轮协议命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-16/evidence/desktop-chrome-protocol.test.ts`。最终 **3 pass / 0 fail / 45 expect / 0 skipped / Completed**。

- [协议最小复现](evidence/desktop-chrome-protocol.test.ts)
- [协议完整日志](evidence/desktop-chrome-protocol.log)

## 覆盖与边界

第一轮已精读：文件搜索/FS containment/图片与 IM 附件可读性、recents 与标题适配器、Panel package inspection cache/文档版本序列化、Puppeteer driver 观测/refs/输入/截图/取消的主要实现、mobile App 入口与审批路由、renderer 目录/凭据/设置/通知导航 hooks、CloudProjectRuntime 主要状态机及绑定缓存。

暂未确证的观察不计 bug：FS 检查与打开之间的通用竞态没有构造生产触发；Cloud 绑定 controller 按 id 缓存只在显示名更新时可能旧值，`ProjectRuntimeStore` 对不同目标会生成新 id，尚不足认定身份错误；`useSettingsResource` 仅 loader 变更不 reload 当前没有生产调用消费者。未运行原生 Electron/Chrome、真实凭据、模型、云或外部网络。

Desktop 约 1600+ 源码/测试文件，未完成逐行全覆盖；native 工具进程、Panel bridge 所有方法、PTY 与其他长流程仍待后续抽查，不能把已读范围宣传为全面通过。

第二轮已继续精读 PTY 生命周期/owner/preload IPC、Panel bridge 的 call 限流/超时/结果授权/工作区与凭据 process grants、Panel protocol 资源权限和录屏处理、Native relay/server/framing、legacy media job/import/document custody、transcript history conversion/subagent enrichment、流 coalescer 与缓存回收、外部编辑器与 OAuth 导航政策。

独立静态重新发现但不计新：ChromeNativeBridgeServer 未保存未认证 socket，`stop()` 会 await 它们退出；父审查协调者查重确认旧 `docs/review-remaining-2026-10-12` **N18 / hosts N01** 已记，故本轮不再加缺陷编号且没有为此重复运行网络实验。PTY 的旧 exit 仅按 key 删除替换 entry 同样只记潜在 seam：renderer 没有原位 kill/restart 入口，不能凭测试 seam 认定常规用户可达。

验证限制：协调者告知平台内容检查中止了相关上轮工作，要求停止所有 Chrome native/socket/shutdown/认证动态实验。已按要求停止，不换工具重试。D03 已有证据仅是内存中直接调用生产 decoder，**没有运行 socket、认证、shutdown、Chrome 或 Electron 实验**；已知 N18 也仅源码查重。本限制之后转向独立的纯 renderer 状态、普通文件显示和非安全 Panel 保存恢复。
