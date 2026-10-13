# Server/Desktop 文件传输与历史恢复复核 — 第十二轮

审查快照：`/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，`a66f4ef291f304ee4df9da8095a90671d9a8f140`。先读 CODESHELL.md 和当前 R01–R54 索引，产品、主报告、goal、构建产物均未修改；没有 build、Electron、独立 native 子进程、第三方下载、真实模型/账号或用户数据操作。

**新增确认缺陷：0。** 本轮收束正常路径及反证，不把测试框架的取消语义扩大成 Node/Electron 生产缺陷，不重报 R09/R17/R20/R29/R34/R39 或第十一轮候选。

## 可便携证据及最终计数

证据目录：`/tmp/codeshell-review-20261012-transfer-round12/`。

| 可运行源码 | 最终日志 | 原始分片结果 |
| --- | --- | --- |
| `transfer-recovery.test.ts` | `transfer-recovery.log` | 3 pass / 112 expect() calls / 0 fail / 0 skip，599ms |
| `desktop-save-import.test.tsx` | `desktop-save-import.log` | 2 pass / 24 expect() calls / 0 fail / 0 skip，755ms |

总计 **5 个测试 / 136 个断言 / 0 失败 / 0 跳过**。两日志均有 `Completed Bun shard` 完整收尾。通过表示这些正常控制和恢复条件成立，不表示已有正式问题已修复。

两文件以 `process.cwd()` 找产品根，须从已构建的 CodeShell checkout 执行；没有固定的 worktree import。/tmp React 解析用本任务的 node_modules symlink；复制入仓库后可用祖先 node_modules 正常解析。

```sh
node scripts/run-bun-test-shard.mjs --timeout 20000 /tmp/codeshell-review-20261012-transfer-round12/transfer-recovery.test.ts
node scripts/run-bun-test-shard.mjs --timeout 15000 /tmp/codeshell-review-20261012-transfer-round12/desktop-save-import.test.tsx
```

**不依赖 0.9.33 新增 API。** 本轮调用的 SessionManager、HubFiles/HubSessions、Lightbox、useAutomationSessionImport、ProjectStore、SessionCwdIndex、server listDiskSessions 均在初始 `84740d56` 已存在；这些对应生产文件从 `84740d56` 到 `a66f4ef2` 的 git diff 为空。本代理只在 a66f 上执行本轮测试，旧基线是否通过由 root 的复跑确认，不提前宣称两基线实测。

隔离：两个分片都强制检查 guarded runner 的真实 HOME 标记。HTTP fixture 只在本任务临时目录中建一个临时端口的 `127.0.0.1` 服务，并在所有 Core/Host import 前安装仓库 `installLocalNetworkGuard(exactOrigin)`，限制 fetch/http/https 到该精确 origin；同时禁止直接 net/tls 外连。Desktop fixture 在所有动态生产导入前禁止 fetch/http/https/net/tls。没有 worker/真实 Engine/model 请求。这些是进程内 guard，不声称 OS 网络沙箱。ProjectStore 对本任务普通临时文件夹进行 Git 根探测时出现一条正常的 `not a git repository` 诊断，不是失败。

## 1. 中断接收端后，文件服务释放读资源和配额

生产入口为 Web 文件预览的下载链接 `packages/web/app/HubFiles.tsx:212–214`，进入 `packages/server/src/hub/files.ts` 的文件 GET 路由；Desktop Web 复用该服务。

最终测试调用**实际 createHubFiles.handle**，目的端为可控的 Node Writable：收到第一个块即 destroy，且验证只读到原 2 MiB 文件的一部分。生产 `pipeline` 在 `files.ts:249–253` 遇到该中断后退出，`finally` 在 :270–273 关闭打开的句柄链并从 active 移除响应。连续 17 次中断后，下一次真实精确 origin HTTP 小文件下载返回 200，内容完整；原大文件 SHA-256 未改变。由此排除“该清理分支必然泄漏 16 个读请求 slot、之后无法下载”的假设。

**限定：**这是生产文件 handler/pipeline 与可控 Writable 中断证据；不是系统浏览器 Cancel 按钮或 Node 原生 HTTP socket 生命周期的端到端验证。没有由此声称所有平台断线行为已测完。

服务 close 的正常控制另验证：close 后新请求返回 503；源文件不变；新建相同服务后能够继续读取完整源文件（`files.ts:279–282`）。不将新建服务误称为同一 closed 实例可以重新打开。

## 2. 导出错误保留源记录，并释放导出并发限制

实际 Web 历史页“导出”链接在 `packages/web/app/HubSessions.tsx:440–453`；运行中 UI 禁止导出。生产 HTTP 服务在 `packages/server/src/hub/session-management.ts:279–308` 校验运行状态、格式、导出大小和授权，:358–359 释放 activeExports。

测试通过实际 SessionManager.create + Transcript.appendMessage + updateSessionState 建立普通持久会话，用实际 createHubSessions 执行：

- 连续三次不支持的格式均 400，state.json 和 transcript.jsonl 保持原字节；之后有效导出仍 200，未卡住 2 个导出 slot。
- isRunning 为真时，导出和归档均 409，state 未变、onChanged 未触发。移除 fixture 的 running 状态后可继续合法操作。
- 完整内部坏行返回 422，原损坏记录未被读取操作重写、截断或“自动修复”。测试随后用自己先前保存的字节还原 fixture 备份，JSON 导出返回 200，包含实际用户及助手消息；这只是受控备份修复对照，不宣称存在自动修复 UI。
- archive→restore 两个合法 PATCH 完成后，独立新 SessionManager.resume 仍能读取两条原消息。

读取坏行的拒绝逻辑在 `session-management.ts:107–128`，运行中归档/恢复拒绝在 :333–336。没有重新报告 R39 的恢复成功后 UI dirty 误判；本测试只验证 HTTP 持久化与导出契约。

## 3. 图片保存取消、失败及重试保留明确结果

实际 React Lightbox + ToastProvider 用仓库 MiniDOM 挂载，未替换这两个组件；仅 `window.codeshell.saveImage` 代表 Main IPC 返回的值由 fixture 控制。实际 onDownload 位于 `packages/desktop/src/renderer/chat/Lightbox.tsx:105–113`：

- 返回 null（取消）没有假“保存成功”或错误提示。
- 拒绝时出现“保存失败”，图片仍留在 viewer，可继续重试。
- 切至第二张图重试，其 src/name 在调用时正确传给保存桥。等待保存完成期间切回第一张图，既有请求仍保存第二张图的 payload，未被画廊后续状态替换；成功回复产生成功提示。

**限定：**此控制证明 renderer 的保存结果、错误反馈与 payload 生命周期，不证明真实 native 对话框曾打开或任意目的地实际已写入。静态核对 Main `images:save` 于 `packages/desktop/src/main/index.ts:5123–5142`：解析在等待前完成；对话框归属发送者窗口；取消/无路径于 :5140 返回 null，只有明确返回路径后才 :5141 写字节。没有观察到可报告的错误目标场景。

此外静态核对媒体导出：`main/panel-app-bridge.ts:1756–1767` 使用 binding.ownerWindowId 找 owner，等待选择后再次 assertProjectBinding，取消直接返回；`main/media/panel-media-service.ts:390–396` 重新授权/校验原件后仅向该 Host 所选目的地 copy。未执行 native 对话框或真实媒体处理，不把该静态检查算入测试数。

## 4. 磁盘历史导入失败可重试，已有会话和快照保留

App 调用真实 `useAutomationSessionImport`；该 hook 在 `packages/desktop/src/renderer/app/useAutomationSessionImport.ts:127–130` 请求 50 条，:183–192 保留失败 cursor 并释放 loading 门禁。App 把该状态传给 Sidebar；`renderer/Sidebar.tsx:500–514` 在非 loading 且存在 cursor 时提供下一次入口。空字符串 cursor 是首次失败后的合法重试哨兵，不是已无剩余历史。

测试在真实 hook + useTrackedProjects 中：第一次 listDiskSessions IPC 明确失败，已存在 A 的索引/活动选择/原快照仍保留，catalog 变为 `{initialized:true,loading:false,nextCursor:""}`；再次通过 hook 的公开 loadDiskSessionCatalogPage 调用重试。第二次实际 `server listDiskSessions` 读取真实 Core 会话 B，实际 ProjectStore.resolveProjectForCwdBatch 映射当前受追踪项目；B 被导入，A 仍活动，A 快照完全相等，getSessionTranscript 调用次数为 0。独立新 SessionManager.resume 验证 B 的原消息仍在磁盘。

该证据排除“首次磁盘目录失败必然丢旧历史/永久禁用恢复/导入本身覆盖 live transcript”的假设。没有绕过 Main 根目录校验；不重报 R23 的无效项目批量映射、R29 的启动项目旧快照或第十一轮 W21 迟到导航。

## 范围、排除及未实测部分

- 当前会话导入的真实流程主要是 Desktop catalog/legacy cache 迁移、磁盘历史及 automation metadata 导入。Web 页提供 Markdown/JSON 导出；没有找到“任意会话 JSON 上传后导入”的实际用户入口。未将缺少该能力列为新缺陷。
- Cloud Workbench 的 `will-download` 处理在 `main/cloud-workbench-window.ts:175–199` 检查具体 webContents 及同源/blob URL，设置 Downloads 目录下 basename 的保存建议，窗口关闭移除 listener。没有 native/Electron 实验，因此不宣称原生 DownloadItem 取消/多窗口选择已实测。
- Hub 文件下载 100 MiB、预览 512 KiB、目录 500 项及 Session 浏览器导出 32 MiB 都有明确产品限制/提示，本轮没有把这些边界本身算问题。
- R09 Hub 多实例初始化清理、R17 上传配额不释放、R20 图片大小不一致、R34 手机断线上传、R39 archive 打开 dirty 对话框均已在主报告，不再增加计数。

### Bun HTTP 取消诊断（不计确认测试/不计缺陷）

最初尝试在 Bun HTTP fixture 中用 fetch reader.cancel 验证实际 transport 中断：server 可能在观测时已完成写出，无法证明中断发生。改用 Bun 的 node:http 兼容客户端 destroy 后，fixture 的 server handler 未在 2 秒内完成，得到 harness timeout。保存诊断日志 `bun-http-cancel-inconclusive.log`；该日志是一次 **2 pass / 1 fail / 26 断言** 的诊断运行，不是最终分片结果，不能算入通过计数。

这属于本轮 harness/运行时语义差异导致的不可比结果，**没有确认 Node/Electron 的生产取消清理缺陷**。仓库已有独立 native revocation 测试以原生 Node 进程验证真实 transport，但本轮按要求不 build、不启动 native 子进程，未复跑。最终保留的是上文更窄且稳定的生产 handler + 可控 Writable 中断测试，两个最终日志都为 0 失败；不可用其结果声称原生网络取消已经端到端验证。

## Root归档复跑

[便携证据目录](reproductions/transfer-round12/)已将根路径改为import.meta.url定位当前checkout。84740d56和a66f4ef2两个快照分别通过最终两分片：5tests、136assertions、0fail/skip。最终日志与源码同目录，旧/新快照记录分别在validation/reproduction-results.json和validation/latest-a66f4ef2/reproduction-results.json。初始不可比较的Bun取消诊断完整保留在validation/transfer-round12/bun-http-cancel-inconclusive.log，不算通过或产品缺陷。通用组现52文件138测试，正式发现仍57项。
