# Pre-beta 05 · 安全调查（M2 明文凭证 / M3 browser 跨 session）

> codex 独立只读调查，主编排代为落盘。基线 HEAD `1f20b875`。

## M3 browser automation / cookie 注入跨 session：**修了一半**

### 结论
renderer 面板分区隔离已修、手动 cookie capture/restore 已对齐 bucket；但 **main 侧 automation / InjectCredential 仍按全局最近 active guest 路由**。session A 的 AI `browser_navigate`/`browser_act`/InjectCredential 可能操作你正聚焦的 session B 的 partition。**阻塞 beta**（前提：browser automation 或 InjectCredential 在 beta 默认可用）。

### 已修
- renderer 分区：`PanelArea.tsx:425-429` 按 bucket 传 `persist:browser:<bucket>`；`WebviewHost.tsx:23-32` 冻结 partition。
- main webview 允许并限制 `persist:browser` 前缀分区：`main/index.ts:1217-1227`。
- 手动凭证 capture/restore 带 bucket：`index.ts:1814-1872`；`CookieTab.tsx:190-197/239-243`。
- git 历史：`cdd09aac`（面板隔离）、`d1fd6b50`（cookie partition 对齐）。

### 未修
- `browser-driver/active-guest.ts:13-35` 仍是全局单例 registry，无 sessionId/bucket/partition。
- attach 只 `registerGuest(guest)` 不带 bucket（`index.ts:1229-1231`）。
- browser action 已解析出 sessionId 但 bridge 忽略（`intercept.ts:40-43` vs `agent-bridge.ts:398-419`）。
- auto-open 无 session（`agent-bridge.ts:553-564`、`preload/index.ts:171-172`、`App.tsx:3061-3075`）。
- InjectCredential 用 originating session 解析凭证但注入目标是 `activeGuest()?.session`（`agent-bridge.ts:471-492`）。
- reload 广播无 bucket（`agent-bridge.ts:493-495`、`useBrowserTabs.ts:287-290`）。

### 修法（体量 M 偏 L）
guest registry 按 bucket 索引（activeGuestForBucket/listGuestsForBucket/focusGuestForBucket）→ attach 时登记 bucket/partition → browser action 用 sessionId→bucket 映射路由 → open-url/InjectCredential/reload 都携带并校验目标 bucket，找不到 fail-closed。回归风险：单面板低、多 session 中（缺映射会 fail-closed 更安全但 UX 提示"请打开目标 session browser"）、popout 需明确 legacy/global。

## M2 明文凭证：SafeStorageCipher 已实现但故意未启用

### 现状
- 落盘：`~/.code-shell/credentials.json`（user）/ `<cwd>/.code-shell/credentials.json`（project），tmp+rename mode 0o600；secret 默认 `plain:<secret>`（`cipher.ts:41-44`）。
- `SafeStorageCipher` 已实现（`credential-cipher.ts:19-51`），main 已 import 但 `index.ts:1595-1604` 明确不启用——因为 agent worker 是独立进程（`agent-bridge.ts:157-160`），用默认 PlaintextCipher；main 写 `enc:safeStorage:*` 后 worker 的 UseCredential/exposeAsEnv/MCP credentialRef/tool guard 全解不开。
- `EncryptionCipher` 是同步接口，safeStorage 在 main，worker 不能同步跨 stdio 逐个 decrypt → 不能"调用 main 一下"无侵入解决。

### 三档方案
- **S 档（半天）**：UI 明示"本地 0o600 明文/OS 未加密"，保持 autoUse/autoInject 默认 false（现状已是），credentials 目录显式 0o700。收益：降误用；不解决恶意软件/备份读取。
- **M 档（1-2 天，推荐）**：只加密 cookie jar secret（最敏感），cookie 的 UseCredential materialize 与 InjectCredential restore 改 main 解密后执行；token/link 暂 plaintext。需给 core 加 host callback / hidden action。收益：显著降低完整登录态 jar at-rest 暴露。
- **L 档（数天-一周）**：全凭证 host-owned credential service，worker 不再直接读 secret，覆盖所有路径。范围大，不适合临近 beta。

### 建议
最值得做 M 档；赶 beta 可先 S 档 + beta notes/UI 明示。按卡密sama"明文可先接受"立场，M2 不单独阻塞 public beta。

## 是否阻塞 public beta 小结
- M3：阻塞（若 automation/InjectCredential 默认开）——要么修 registry，要么 beta 前禁用/隐藏 AI 自动注入。
- M2：不单独阻塞（接受明文前提下），建议至少 S 档明示。
