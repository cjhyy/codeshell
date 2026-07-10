# 手机遥控支持发送图片

## 1. 问题与现状

移动遥控当前从 UI 到 main 的协议只允许纯文本：

- `packages/desktop/src/main/mobile-remote/types.ts:63-67` 的 `chat.send` 只有 `text/sessionId`；`:98-111` 的 `room.send` 只有 `roomId/text`。
- `packages/desktop/src/mobile/components/Composer.tsx:7-17` 的 `onSend` 只接收 string；`:43-53` 拒绝空文本，组件中只有 textarea、发送和停止按钮，没有 file input、图片预览或附件状态。
- `packages/desktop/src/mobile/hooks/useRemoteApp.ts:64-92` 将 `sendChat` 声明为 `(text: string) => void`；`:773-788` 分别发送 `room.send` 或 `chat.send` 文本。
- `packages/desktop/src/main/index.ts:833-868` 把 `chat.send.text` 直接组装成 `agent/run.params.task`，未传 attachments；`:1148-1156` 把 `room.send.text` 直接交给 `roomManager.send()`。
- RoomManager/外部 CLI 也是 string-only：`packages/desktop/src/main/mobile-remote/room-manager.ts:136-145` 的 `RoomAgent.send(text)`、`:565-576` 的 `RoomManager.send(id, text)`、`resident-agent.ts:222-227` 和 `codex-room-agent.ts:124-137` 都只处理文本。

手机的本地文件路径不能交给 desktop 使用。移动页面由 desktop 的 HTTP host 提供，但浏览器选图得到的是 `File/Blob`；所谓 `/private/var/mobile/...` 路径既不会暴露给网页，也不在桌面机器上。协议必须传图片字节或一个由 desktop HTTP host 管理的上传 token。

仓库已有一条可复用的“统一输入附件总线”，不应另造第二种 engine 输入格式：

- `packages/desktop/src/main/attachment-service.ts:115-172` 的 `stageImageDataUrl()` 验证 MIME/大小，将图片安全落到 `<cwd>/.code-shell/attachments/<sessionId>/`，生成包含真实 `absPath/relPath/sha256/vision` 的 `InputAttachmentMeta`；单图上限为 `10 MiB`（`:95-111`）。
- preload/renderer 的结构化附件定义位于 `packages/desktop/src/preload/index.ts:87-120` 与 `preload/types.d.ts:445-482`；desktop run 在 `preload/index.ts:366-381` 已能传 `attachments`。
- core 的同形类型位于 `packages/core/src/protocol/types.ts:72-109`；`RunParams.attachments` 在 `:111-117`。
- `packages/core/src/protocol/server.ts:565-568` 将 RPC attachments 交给 session；`packages/core/src/engine/input-attachments.ts:51-67` 与 `run-image-input.ts:61-108` 校验 session/path、读取图片并合入模型输入。
- `packages/desktop/src/main/index.ts:2163-2245` 已把 stage/inspect/markSent 暴露给 desktop renderer，但 mobile 页面没有 preload，不能直接调用这些 IPC；main 的 mobile event handler 应直接复用同一 service。

移动 HTTP/WS host 的安全边界也已确认：

- `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:133-164` 当前只提供 `/health` 与 `/mobile` 静态资源；`:194-231` 在 WebSocket 内完成 pairing/device auth，只有已认证 socket 的业务事件才交给 main。
- tunnel 模式在所有 HTTP route 和 WS upgrade 前经过 passcode gate（`:138-142`、`:165-192`）。新增上传 route 必须位于相同 gate 后，不能绕开它。
- trusted-device 凭据由 `TrustedDeviceStore.authenticate()` 做 timing-safe compare（`trusted-device-store.ts:56-64`）。大图上传最好使用已认证 WS 签发的一次性 ticket，避免在每个 HTTP 请求头重复暴露设备 bearer secret。

因此推荐方案是：小图在 `chat.send/room.send` 中携带 data URL；大图先通过受控 HTTP endpoint 上传到 desktop 临时 spool，发送事件只携带 upload ID。main 在确定目标 session/cwd 后统一落盘为 `InputAttachmentMeta`，再分别交给 CodeShell engine 或外部 CLI room。

## 2. 目标

- 手机可从相册选图，也可调用相机拍照；发送前显示缩略图、文件名/大小并支持移除。
- 支持“只有图片没有文字”的消息。
- 小图可内联，但 WS payload 有明确上限；大图必须走流式 HTTP 上传，不能把大段 base64 塞进单个 WebSocket frame。
- desktop 收到的最终字节落入现有 `.code-shell/attachments/<sessionId>/` 安全目录，生成统一 `InputAttachmentMeta`，而不是引用手机路径或长期保留临时上传路径。
- `chat.send` 把结构化附件放进正常 `agent/run.params.attachments`；`room.send` 把同一落盘文件交给 Claude Code/Codex room 的附件适配层。
- 上传与发送均受 trusted-device、session/room ownership、MIME、数量、大小、路径和过期清理约束。
- 旧手机 client 与纯文本消息保持兼容：attachments 缺省即现有行为。

## 3. 详细修改方案

### 3.1 协议：区分 inline 与 uploaded descriptor

修改 `packages/desktop/src/main/mobile-remote/types.ts`，新增只包含传输信息、绝不包含 desktop 路径的 wire type：

```ts
interface MobileImageBase {
  clientId: string;
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}

type MobileImageAttachment =
  | (MobileImageBase & { transport: "inline"; dataUrl: string })
  | (MobileImageBase & { transport: "upload"; uploadId: string });
```

扩展业务事件，字段保持 optional 以兼容旧 client：

```ts
{ type: "chat.send"; text: string; sessionId?: string; attachments?: MobileImageAttachment[] }
{ type: "room.send"; roomId: string; text: string; attachments?: MobileImageAttachment[] }
```

增加大图上传握手事件：

```ts
{ type: "attachment.upload.begin"; clientId: string; name: string; mime: string; size: number }
{ type: "attachment.upload.ready"; clientId: string; uploadId: string; putUrl: string; expiresAt: number }
{ type: "attachment.upload.failed"; clientId: string; message: string }
```

建议限制常量集中在协议/上传 service：

- 最多 4 张/消息；
- inline 单图 decoded size 不超过 256 KiB，inline 总 decoded size 不超过 512 KiB；
- 单图最终上限 10 MiB（与 attachment service 一致）；
- 单条消息附件总量不超过 20 MiB；
- upload ticket 5 分钟过期且绑定签发它的 device ID。

server 必须根据 data URL 实际解码长度/HTTP 实收字节复核，不能信任 client 的 `size`。

### 3.2 Mobile Composer：选图、拍照、预览与发送状态

修改 `packages/desktop/src/mobile/components/Composer.tsx`：

- 增加附件按钮与两个隐藏 input：
  - 相册：`type="file" accept="image/*" multiple`；
  - 拍照：`type="file" accept="image/*" capture="environment"`。
- 将选中的 `File` 转成 composer-local draft：`clientId/file/name/mime/size/previewUrl/status/progress`。预览用 `URL.createObjectURL()`，移除或 unmount 时必须 `revokeObjectURL()`。
- unsupported MIME（常见如 HEIC）不要原样上传到现有 service。优先在浏览器端按最大边长/质量用 canvas 转为 JPEG；无法解码时给出明确错误。要保留 EXIF orientation 后的视觉方向。
- 在 textarea 上方渲染缩略图 chip，可逐张删除；上传中显示进度/忙碌态。
- `onSend` 改成结构化输入，例如：

  ```ts
  onSend(input: { text: string; attachments: MobileComposerAttachment[] }): Promise<boolean>
  ```

- submit 条件改为 `text.trim() || attachments.length > 0`。只有当上传和 socket send 都成功排队后才清空 textarea/附件；失败时保留 draft 便于重试。
- `pending` 应覆盖“转换 + 上传 + 发 WS”全过程，阻止重复提交；stop run 与附件上传是不同状态，不应误把取消 agent run 当成取消上传。
- 为图片按钮、相机、移除、上传中、超限、格式不支持、发送失败补 `packages/desktop/src/renderer/i18n/ns/mobile.ts` 中英文文案（mobile 的 alias 最终使用同一 i18n 资源体系）。

同时修改 `packages/desktop/src/mobile/App.tsx:116-121` 与 `useRemoteApp.RemoteApp.sendChat` 的签名，保持 Promise/结果向 Composer 反馈。

### 3.3 Mobile 上传 client：小图内联，大图走 ticket + PUT

建议新增 `packages/desktop/src/mobile/lib/mobileAttachments.ts`：

1. 规范化/压缩选中的 File，计算实际 MIME/size。
2. 小于 inline 阈值时用 `FileReader.readAsDataURL()` 生成 inline descriptor。
3. 大于阈值时：
   - 通过已认证 socket 发 `attachment.upload.begin`；
   - `useRemoteSocket` 或独立 hook 用 `clientId` 关联 `ready/failed`，设 10 秒握手超时；
   - 对 `putUrl` 执行 `fetch(..., { method: "PUT", body: blob, headers: { "Content-Type": mime } })`；
   - 成功后生成 `{ transport: "upload", uploadId, ... }`。
4. 所有 attachment descriptor 准备完毕后一次性发送 `chat.send`/`room.send`，保证文本与图片同属一个用户 turn。

不要把 device secret 放在 put request。`putUrl` 中的一次性高熵 token 就是短期上传凭据；它由已认证 WS 签发、绑定 device、MIME、声明 size 和过期时间。tunnel 模式下 fetch 自动带 passcode cookie并仍先过现有 gate。

### 3.4 Main：新增流式临时上传服务和 HTTP route

建议新增 `packages/desktop/src/main/mobile-remote/mobile-upload-service.ts`，职责与 workspace attachment service 分离：

- `begin(deviceId, metadata)`：验证 count-independent metadata，生成 128-bit 以上随机 uploadId/ticket，记录 deviceId、MIME、expected size、expiresAt。
- `acceptPut(uploadId, req)`：
  - ticket 必须存在、未过期、未完成；
  - 只接受 PUT 和匹配的 image content-type；
  - 检查 `Content-Length`，但同时逐 chunk 累加，超过 10 MiB 立即 destroy/413；不得只依赖 header；
  - 写入应用 userData 下的临时目录，例如 `mobile-remote/uploads/<generated-id>.part`，完成后原子 rename；文件名完全由 server 生成；
  - 校验实收 size，记录 sha256，状态改为 ready。
- `resolve(deviceId, uploadId)`：只向签发设备返回 ready spool，禁止另一个已认证手机引用。
- `consume/finalize`：目标附件成功 stage 后删除临时文件和 ticket；失败时保留到短 TTL 供同一消息重试。
- 周期清理过期、断开的 `.part` 和未消费 ready 文件；RemoteHostManager.stop 时清理 timer/句柄。

修改 `packages/desktop/src/main/mobile-remote/remote-host-manager.ts:138-164`：

- 在 passcode gate 之后、`/mobile` 静态 route 之前增加精确匹配的 `/api/mobile/uploads/<ticket>` PUT route。
- route 只将 request/response 交给 upload service，不进入 static proxy。
- `attachment.upload.begin` 仍走 WS normal event path，因此只有 `authed` socket 可签发；RemoteHostManager 把已经绑定在 socket 上的 deviceId 注入 main（现有 `:228-230`），main 再调用 upload service。
- 若使用 `WebSocketServer` 的 `maxPayload`，把上限设为略高于允许的 inline 总量和协议开销；超大 WS frame 直接拒绝。HTTP 大图不受该 frame 限制。

在 `packages/desktop/src/main/index.ts` 创建 upload service，并注入 RemoteHostManager/handler。新增 server event 应使用 `sendToDevice()` 回复，不能 broadcast ticket 给其他已认证设备。

### 3.5 统一落盘：扩展 attachment-service 而不是二次实现

大图已经是 raw file/buffer，不能为了调用现有 `stageImageDataUrl()` 再整体转 base64。修改 `packages/desktop/src/main/attachment-service.ts`：

- 抽取内部统一实现 `stageImageBytes({ cwd, sessionId, name, mime, bytesOrSourceFile, origin })`；
- `stageImageDataUrl()` 只负责解析 data URL，然后调用统一实现；
- mobile upload spool 走受限的 source file/stream 版本，复制/原子写入 canonical `.code-shell/attachments/<sessionId>/`；
- 保留现有 MIME allowlist、sha256 去重、安全 session dir、symlink/realpath 检查、manifest staged record 和 10 MiB 限制。

在所有 `InputAttachmentOrigin` 镜像中增加 `"mobile"`：

- `packages/desktop/src/main/attachment-service.ts:18-25`；
- `packages/core/src/protocol/types.ts:74-81`；
- `packages/desktop/src/preload/index.ts:89-96`；
- `packages/desktop/src/preload/types.d.ts:447-454`；
- renderer 的 `chat/attachments.ts` 本地 origin 联合，保持跨层合同一致。

最终路径沿用仓库已有 `.code-shell/attachments/<sessionId>`，比需求示例中的新 `.code-shell/uploads` 更合适：core `input-attachments.ts:180-186` 后续会强制验证 staged attachment 必须位于预期 session 目录，另造目录会被统一附件总线拒绝。

### 3.6 chat.send：解析 session workspace、stage 后传给 agent/run

修改 `packages/desktop/src/main/index.ts:833-868`：

1. 按现有优先级解析 sessionId。
2. 计算 fallback cwd 后，若 session 已存在，调用 `getSessionWorkspaceForUi(sessionId, fallbackCwd)` 并使用其 `root` 作为 run/stage cwd。这样 worktree session 的附件不会落在主仓库；新 mobile session 使用 fallback/no-repo cwd。
3. 调用共享 `materializeMobileAttachments({ deviceId, sessionId, cwd, descriptors })`：
   - 验证数量/总量/字段；
   - inline 走 `stageImageDataUrl(..., origin: "mobile")`；
   - upload descriptor 从 upload service resolve，走 raw bytes stage；
   - 保持客户端顺序，任何一个失败则整条消息返回 typed error，不启动半附件 turn。
4. 构造 `agent/run` 时增加 `attachments: stagedMetas`（core 已支持）。`task` 可为空字符串，但 attachments 非空时允许运行。
5. `clientMessageId` 的稳定哈希加入附件 sha256 列表；否则“相同文字、不同图片”的重试可能被错误去重。
6. 注入 worker 后调用 `markAttachmentsSent(cwd, sessionId, stagedMetas)`，并 consume 对应 upload tickets。
7. `chat.accepted` 可增加安全的 attachment summary（clientId/name/mime/size），不得返回 absPath。

错误应只回复发起 device，不能 broadcast 到所有手机。stage 成功但 run 注入失败时保留 canonical staged 文件为 draft，交现有 TTL cleanup 回收。

### 3.7 room.send：复用落盘文件并适配外部 CLI

`room.send` 的目标 cwd 来自 `RoomMeta.cwd`（`room-manager.ts:98-108`），session directory 可使用安全、稳定的 room ID。handler 流程：

1. 先 `roomManager.getRoom(roomId)` 获取并验证 room；
2. 以 `{ cwd: room.cwd, sessionId: room.id }` materialize descriptors；
3. 调用扩展后的 `roomManager.send(roomId, text, stagedMetas)`。

修改 RoomManager/RoomAgent 合同为结构化输入，例如：

```ts
interface RoomTurnInput {
  text: string;
  attachments?: InputAttachmentMeta[];
}
```

外部 CLI 适配策略：

- 统一先生成简短的 model-facing path block，列出 workspace-relative staged paths 和 MIME，附在用户文本后。Claude Code 可通过其 Read 工具读取图片；这比传手机路径可靠，也不依赖未验证的 stream-json image block shape。
- Codex room 在 CLI probe 确认支持 `-i/--image` 时把每个 image `absPath` 作为 `-i` 参数。core 已有可复用行为参考：`packages/core/src/cc-orchestrator/agent-adapter.ts:106-127`。建议抽取/复用其 image-support detector，而不是在 desktop main 再写一套版本猜测。
- 不支持 native image flag 时仍保留 path block，让 CLI 至少能读取本地文件；UI 可提示“当前 CLI 版本将图片作为工作区文件提供”。
- RoomMessage 只持久化安全 summary（名称、MIME、size、workspace-relative path），不要把绝对路径或 base64 写进 `messages.jsonl`/广播。

纯文本调用继续接受旧 `send(id, text)`，可在内部 overload/normalize 成 `{ text, attachments: [] }`，降低 desktop CC room 的迁移风险。

### 3.8 Mobile feed 中的用户消息展示

session 分支目前在 `useRemoteApp.ts:783-787` 做 optimistic echo，因为 worker stream 不回显 user turn；room 分支依赖 RoomManager 广播。附件需要两条都可见：

- 扩展 mobile reducer 的 user action，携带安全 `MobileAttachmentSummary[]`，渲染缩略图/“图片 N 张”占位；本地刚发送时可继续使用 object URL，离开页面后只保留名称/数量。
- RoomManager 的 user message broadcast 携带同样 summary，room 分支仍不要本地重复 echo。
- 历史 transcript 如果暂未保存附件 summary，至少从文本 path block 隐藏内部标记并显示“图片附件”；不要把 base64 塞入 transcript。

这部分是发送反馈的一部分：用户必须能确认图片与哪条文字属于同一 turn，但不要求在第一版为历史附件增加下载 API。

## 4. 分步骤实施顺序

1. 定义 mobile wire descriptor、上传握手事件、限制常量和 `origin: "mobile"` 跨层类型。
2. 将 attachment-service 重构出 raw bytes/file staging，并补齐与 data URL 路径等价的安全测试。
3. 实现 mobile upload service、一次性 ticket、HTTP PUT route、设备绑定和过期清理。
4. 在 main 实现 `materializeMobileAttachments()`，接入 `chat.send` 的 workspace 解析、agent/run attachments 和 markSent。
5. 扩展 RoomManager/RoomAgent 输入，先完成 path block，再为 Codex 接入能力探测后的 `-i`。
6. 实现 mobile 侧图片选择/拍照/转换/预览/上传 helper，并修改 Composer/useRemoteApp 协议调用。
7. 扩展用户消息附件 summary 展示和 i18n。
8. 最后做 LAN/tunnel、session/room、inline/HTTP 四个组合的集成验证。

## 5. 测试策略

### 协议与 mobile UI

- types/normalizer 测试：旧纯文本 event、image-only、inline/upload 混合、未知 transport、重复 clientId、超过数量/总量。
- Composer 组件测试：相册/相机 input、预览、删除、object URL 回收、空文字+图片可发送、pending 防双击、失败保留 draft。
- upload helper 测试：阈值内 data URL、阈值外 begin→PUT→descriptor、超时/413/断网重试、顺序保持。
- useRemoteApp 测试：session 发送 attachments 并 optimistic echo 一次；room 发送 attachments 但不本地重复 echo。

### Main 上传与落盘

- `mobile-upload-service.test.ts`：
  - 未认证 socket不能签发 ticket；
  - ticket 绑定 device且过期；
  - 非 PUT/错误 MIME/size mismatch/超限 chunk 返回 4xx；
  - 中断上传清理 `.part`；
  - ticket 不可被另一设备 resolve/consume；
  - 完成、重试和 TTL cleanup 行为。
- 扩展 `remote-host-manager.test.ts`：LAN 和 tunnel route 都工作；tunnel 无 passcode cookie 的 PUT 被 gate 拒绝；static `/mobile` 与 `/health` 不回归。
- 扩展 `attachment-service.test.ts`：raw bytes/source file 与 data URL 生成相同 canonical meta；去重、MIME、10 MiB、symlink escape、unsafe sessionId 均拒绝。

### Engine / room 集成

- main mobile handler 测试捕获注入的 JSON-RPC，断言 `agent/run.params.attachments` 具有真实 canonical path、正确 sessionId/origin/sha256，且 run cwd 与 session worktree root 一致。
- core 已有 `engine/input-attachments.test.ts` 和 structured vision gate 测试；增加一例 `origin: mobile` 即可验证联合类型/路径政策不回归。
- RoomManager 测试：attachments summary 只出现一次、没有 base64/absPath；Claude 输入带相对 path block；Codex 支持时 argv 含有按顺序的 `-i`，不支持时回退 path block。
- image-only room turn 可发送；agent 未就绪时 upload 不被误报为已消费。

### 手工矩阵

- iOS Safari 与 Android Chrome：相册、后置相机、横竖照片、JPEG/PNG/HEIC 转换。
- 纯文本、小图 inline、大图 HTTP、四图混合、图片-only。
- CodeShell 普通 session、worktree session、no-repo session、Claude room、Codex room。
- LAN 明文模式与 Cloudflare tunnel 模式；弱网断开、手机后台恢复、ticket 过期后重试。
- 发送后检查 desktop 实际文件位于目标 workspace 的 `.code-shell/attachments/<sessionId>/`，且临时 spool 被清理。

## 6. 风险与兼容性注意

- **不能信任手机路径或 metadata**：文件名只用于 display/safe slug；MIME、size、hash 全由 desktop 复核，最终路径由 server 生成。
- **base64 膨胀**：base64 约增加 33% 体积。inline 阈值必须按 decoded bytes 与总量双重限制，大图强制 HTTP。
- **内存与磁盘 DoS**：HTTP 必须流式计数、设置单图/总量/ticket 数上限并清理过期 `.part`；不能先把整个 request 读入 Buffer 再检查。
- **鉴权**：上传 ticket 只能由已认证 WS 签发并绑定 device。tunnel passcode gate 仍覆盖 PUT；ticket 不应 broadcast 或写日志全文。
- **workspace 一致性**：stage cwd、agent/run cwd 和 `InputAttachmentMeta.sessionId` 必须来自同一次目标解析。否则 core 会以“outside expected session dir/session mismatch”拒绝。
- **HEIC 与动画图**：现有 allowlist不含 HEIC。移动端需要转换或明确拒绝；GIF 压缩时不要不提示地丢动画语义。
- **模型能力**：CodeShell engine 会按当前模型 vision capability 拒绝不支持图片的模型（`run-image-input.ts:111-124`）；mobile 应展示该错误并保留可重试语义，而不是自动换模型。
- **外部 CLI 能力差异**：Claude/Codex room 不等于 core vision API。基线以安全本地路径 + 工具读取为准，Codex 的 `-i` 仅在 probe 确认后使用。
- **隐私**：不要在 WebSocket、room history、日志或 server event 中回传 base64、临时绝对路径、device secret。manifest 中的 canonical absPath只留在 desktop 本地。
- **兼容性**：`attachments` 全部 optional；旧 mobile bundle继续发送文本。server 解析未知字段时忽略，但未知 transport/MIME 必须拒绝该附件而不是猜测。
- **幂等性**：重试同一 upload/message 时用 clientId + sha256 去重；`clientMessageId` 必须包含附件 hash，避免不同图片的同文案互相吞掉。
