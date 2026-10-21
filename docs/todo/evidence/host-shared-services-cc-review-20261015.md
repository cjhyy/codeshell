# Host 1.2a：CC 审查与 CI 修复清单

当前接续输入为 `cb2c652b5da37ffa301759a4351a5eb7bf30b7a8`。主控已补交上轮全部文档；旧 head 的正常宿主结果见“主控接续”节。本轮五组实现、可运行验证及未完成宿主门槛见文末；两个剩余 CC P2 尚待同一 CC 复审，不能将历史勾选理解为本轮全 closed/CI 全绿。

审查 base `19bc2167402da53caeace26ac69207822c166448` → head `5d891c836fe99f67f104c96646d6d4b5d59ac2ed`，CC session `c6bcaca0-6811-42f4-a928-2aeb810c7a7d`。结论：1 个 P1 需先修复；以下 9 个 P2 非阻断，本轮在同一相关范围内一起处理。PR188 的原 3 个 P2 已由 CC 确认关闭。

主控正常宿主 bg_5u1l8 已通过完整 package-release、84 项真实 HTTP/账本契约、完整 typecheck、Desktop main 与 Node identity smoke。但 PR190 的全量 core-rest/rest 分片另有失败，必须修复；不得把本地子集绿当 CI 绿。

## P1

- [x] `core/src/tool-system/mcp-probe-connection.ts:183–193` 将所有 `client.onerror` 作为永久失败。SDK 对可选 GET SSE 的 404/400/403 也回调 onerror，而 POST 初始化及 listTools 仍可成功，导致可用服务偶发失败。仅将本方明确的致命连接/帧限额错误作为失败信号，SDK 非致命诊断不污染后续请求；请求自身 reject、取消、超时、关闭仍有效。补真实 SDK HTTP fixture：GET404、POST正常，结果应成功。
- [x] 同一 finding 的 stdio 兼容：新 parser 对任意非 JSON 横幅关闭，而旧 Desktop 与真实 runtime 会跳过。保留 Desktop 的兼容行为及全部帧/总量/超时限制；Hub 原严格语义可由显式策略保留。用实际 stdio fixture 分别验证，不仅调用假 onerror。

## P2

1. [x] `host/services/mcp-probe.ts:134–139,201,250–251` 过度脱敏将全部 argv/header 值当秘密，`run` 导致 `run_query` 被改名，content-type/协议版本也误伤。区分认证类 header/credential/envHeaders/真正 token 类参数与普通参数，保留明确秘密的脱敏；测试普通名字/描述不变且真实 auth/env/token 不泄漏。
2. [x] `desktop/main/mcp-probe-service.ts:90–126,167–184` Desktop 现在收到 Hub 的“服务器上…”文案，缺失 env 不再指名，errorDetail 与 errorMessage 相同；humanizeError/buildProbeHttpHeaders 仅测试使用。Host 提供 code/安全 detail，由 Desktop/Hub adapter 映射原语义文案；删除死 helper/改测真实生产路径。
3. [x] `host/services/session-files.ts:75–76,139–140` state.json 原子 rename 后身份比对抛 changed，Desktop listDisk 吞错跳过运行中会话并越过 cursor。列表读取对普通文件 changed 有界重试1–2次，保留 Hub 单 session 授权读取严格性；不去掉 symlink/root/identity 校验，不无限重试。测试原子 rename、连续替换有界失败、恶意 symlink/目录替换拒绝。
4. [x] 同文件 candidates:200–223 为每项 state/transcript 做约19次同步 syscalls（原约4次），transcript EACCES 隐藏整条会话。候选阶段仅安全 lstat/普通文件/限额判断；完整 open/fstat/read 身份校验留实际 readState。保留有不可读 transcript 的会话元数据；覆盖行为与扫描开销契约，不用脆弱毫秒阈值。
5. [x] `server/sessions-service.ts:323` listDisk 新2MiB state上限是行为变化，超限静默消失。保留有界读取，记录安全诊断/文档说明；不打印 state 内容/凭据。
6. [x] `tests/helpers/network-fixture.ts:21` guard 强制替生产加 redirect:error，使 mcp HTTP 的 redirect 断言自证。guard 应检查契约而非替待测代码修正；补删掉生产 redirect 即会失败的有效测试，保留 exact-origin/禁止外联，不为绿灯取消保护。
7. [x] 同 helper 注释承诺宽于覆盖：只补丁 fetch/http(s)/net，不覆盖 Bun.fetch/Bun.connect/WebSocket/http2；共享模块缓存使 imports 只首文件满足先guard，restore只逆序安全。最小明确适用范围/限制，保证当前套件正确安装恢复，勿声称网络沙箱；无需无界补全所有网络API。
8. [x] `server/hub/skills-management.ts:123,303,346,399` 名字检查只需definitions却重复构建完整inventory并双扫描（还在mutation gate），refresh选项未使用。用共用 definitions helper 或 Core scanSkills，保留权限/revision顺序，删除或实际使用无效 refresh。
9. [x] `server/sessions-service.ts:7` storage入口import Host root使其加载probe/model/skills，偏离storage入口边界。提供Host ./session-files窄子路径，更新生产import、exports/类型别名、声明/运行时/package smoke与边界契约；Host依赖仍Core-only。

可随相关改动处理的非必需项：已stream终态时仍保留 run.rejected 诊断日志；修改文件读取时补 sync/async失败重试与句柄关闭断言。不得扩张到下一阶段。

## CI 必修

日志 `/tmp/codeshell-pr190-ci-failures-20261015.log` 含 NUL，读取用 `rg -a`。

- [x] core-rest：`core/src/index.exports.test.ts:470` 的完整 internal runtime 导出列表未更新，实际多 `McpProbeConnectionError`、`createMcpProbeConnection`、`listSessionEntries`。精确批准必要的3个 runtime symbols、保持 stable/extension 排除，不移除严格列表/预算断言。原设计是两个窄服务边界，不等于仅两个 runtime 值，文档计数应准确。
- [x] rest：5033pass/3fail，三个都在 `host/services/model-connection-probe.test.ts`：connected/unauthorized/timeout/cancelled均得invalid_response。该测试单跑过，但CI大进程失败；应复现 test-order/native SDK browser guard/模块与全局隔离。旧 Hub model-probe.test 会清除并恢复继承 miniDOM 的 window/document，新 Host 文件没有这层处理，这是待核实线索。不要放宽生产 SDK browser 凭据保护、改预期为invalid_response、skip/retry/加超时遮盖。用真实客户端+原限额断言证明修复。

修复后由同一 CC 复审本轮差异，再推送 CI；不进入第9项。以下勾选表示 Codex 已实施并完成可运行的定向验证，尚不表示 CC 复审通过或新 head 全量 CI 成功。首轮受限项已由 bg_5u1l8 验证 resolved；本轮受限项独立记录。

## 本轮实现与根因证据

本轮输入 head：`5d891c836fe99f67f104c96646d6d4b5d59ac2ed`；累计任务 base 仍为 `19bc2167402da53caeace26ac69207822c166448`。始终在指定工作树与分支；未操作 main、其他任务树、Claude、写入 worker，未 push/merge/release。只读辅助审计复核 FS/guard，不替代 CC。

| 项 | 实际修复与验证 |
| --- | --- |
| P1 HTTP | `client.onerror` 仅把本方 `McpProbeConnectionError` 作为 fatal；SDK 普通诊断不设置永久 failure。connect/listTools 自身 rejection、close、timeout、cancel 保留。真实 SDK + 注入 HTTP transport 对 GET 400/403/404 各测两种时序：GET body 被 SDK cancel 后才返回首/次 tools page，成功 2 tools；不只 fake 调用 onerror。真实 TCP 的 Hub fixture 另改 GET404/POST成功并断言发生 GET，受限补跑见下。 |
| P1 stdio | Desktop 明确 `skip-banner`，Hub 默认 `strict`；实际子进程先输出非 JSON banner，Desktop 成功、Hub invalid_protocol。Desktop 同时跳过不能通过 JSON-RPC validation 的结构化日志，Hub strict 仍拒绝；此前“两方拒绝”的兼容描述已在本轮更正。512 KiB frame/2 MiB total、分页、重复 cursor、超时子孙回收等原 fixture 保留并通过。 |
| P2-1 | 只收集明确 auth/cookie/token/key/credential header、env/envHeaders、认证参数及敏感 URL 参数；保留 `run_query`、`run`、`application/json`、协议版本。真实 SDK tools preview 同时验证 auth/env/token/credential 参数与 header 不泄漏；credentialRef/OAuth 刷新走实际 Desktop adapter。 |
| P2-2 | Host 返回中立 code、受控 detail，不返回原 SDK body/stack；缺失 env 名字/字段须与真实 config 引用匹配才返回。Desktop 映射本地文案、Hub 映射服务器文案；删除死 humanizeError/buildProbeHttpHeaders。Desktop 9 个真实生产路径测试覆盖缺失命令/env、HTTP auth、credentialRef、OAuth refresh/expiry、外来密文不被发出。 |
| P2-3 | 列表读取固定原目录 dev/ino，只有 changed/file 且替代是安全普通文件才最多重试两次。Hub 单会话授权仍严格 read，无 retry。隔离 Node 验 sync/async 一次 rename 成功、连续替换三次失败、symlink/目录置换立即失败，每次所有 fd/handle 关闭，并验证真实 Desktop list/Hub read。 |
| P2-4 | candidates 每个普通项固定三次 lstat（目录/state/transcript），零 open；transcript ENOENT/EACCES/EPERM 保留 state 元数据/mtime fallback。实际 readState 才做 open/fstat/read 身份校验。Node syscall 计数和 Core list 结果断言通过，不用耗时阈值。 |
| P2-5 | Desktop 保留 2 MiB cap；仅 emit `SESSION_LIST_STATE_TOO_LARGE` + 安全 session ID/固定说明，省略 entry，不含 root、state 或凭据。Node 实际 listDisk 超限 fixture 验诊断和不泄密；Host README/架构/CHANGELOG 明确行为。 |
| P2-6 | guard 仅检查调用方 Request/init 的 redirect:error，原样交给 transport；缺 flag 会在零 transport 调用时失败，foreign origin 同样拒绝。SDK HTTP fixture 仍验证生产自身 flag。原测试客户端显式设置 flag；账本泛用客户端由注入 fixture transport 自己约束，未修改生产模型行为。 |
| P2-7 | helper 注释/架构明确只覆盖 global fetch、Node http(s) request/get、Socket.connect，不涵盖 Bun.fetch/connect、WebSocket/http2、预捕获函数，不是网络沙箱。安装先于首个 producer evaluation；缓存模块不会重跑 imports，当前 probe 用注入/调用时 fetch。stack 检查 LIFO，拒绝乱序 restore，正确/idempotent restore 有测试。 |
| P2-8 | Hub listed/重名/来源预览使用一次 Core scanSkills definitions，不再重复完整 inventory 双扫描；snapshot 仍真调用共享 inventory，并实际使用 refresh:true。原 owner/project-only/revision/review/revoke/gate 顺序未改；Desktop inventory/权限 fixture 通过，Hub HTTP 权限 fixture 仍待本轮宿主重验。 |
| P2-9 | 增加 Host `./session-files` types/runtime 窄入口、root TS alias，Desktop storage/Hub FS 生产 imports 使用该入口。实际 esbuild storage graph 只含两个 Host FS dist modules；Node 验 narrow bindings；packed 新入口声明/runtime 通过。Host runtime dependency 仍只有 Core；无直接 SDK/server/Electron 依赖。 |
| CI core-rest | 完整 runtime list 精确增加三个已批准 internal 值：McpProbeConnectionError/createMcpProbeConnection/listSessionEntries；stable root 与 extension 明确排除，完整 equality/dedup/预算保留。两个服务边界/两个 export 语句与三个 runtime 值在文档分开计数。Node smoke 同时补齐原本漏列但早已导出的两个 DesktopOperationBatchAuthority 类型，不新增类型导出。 |
| CI rest | 原 Host test 缺 nativeHostGlobals，继承 miniDOM 后触发 SDK 浏览器凭据保护。用旧 head 临时测试文件复现：显式 `./miniDomStyle.test.ts` 后运行原模型文件，4 pass/3 fail，均 invalid_response；临时文件已删。修复保存/删除/恢复 window/document 描述符，同顺序通过。另用真实 Core client 验浏览器上下文仍拒绝且零请求，未加 dangerouslyAllowBrowser/skip/retry。 |

`run.rejected` 诊断现在始终保留；已 stream 终态时只抑制重复终态/toast/sound，原 generation/run/bucket 判定不变。真实 renderer hook 回归通过。

## 本轮验证

全部 Bun 单测使用 guarded runner，隔离 HOME/应用状态/凭据；网络 fixture 在生产 imports 前安装 exact-origin guard，模型均用 fixture transport，没有调用真实 provider/付费服务/操作者 MCP，也未读取真实 credentials。Core → Host → 下游已构建；package-release 串行完成后才启动其他读 dist 检查。

| 命令/范围 | 结果 |
| --- | --- |
| 下方契约组（8 文件，含显式 miniDOM → Host 模型顺序） | **60 pass / 0 fail / 0 skipped，503 assertions**。最终 credential 分类收尾后重跑仍通过。 |
| 下方 adapter/预算组（9 文件） | **70 pass / 0 fail / 0 skipped，291 assertions**。两组共 130 pass / 794 assertions。 |
| Node `smoke-host-shared-session-files.mjs` | exit 0，严格身份/有界重试/每次 close/candidate syscall/EACCES/真实 adapter/安全超限诊断。 |
| Node `smoke-core-exports.mjs` | exit 0，264 internal runtime/115 type exports 完整 pin、public/internal identity 与 Host-only 排除。 |
| 完整 `bun run typecheck` | exit 0，14 workspace，含 Desktop main/preload/renderer/mobile 与 Web SPA；最终 credential 收尾后完整再跑仍 exit 0。 |
| `bun run --cwd packages/desktop build:main` | exit 0，实际 main bundle。 |
| targeted ESLint/Prettier | 本轮全部修改/新增 TS/TSX/MJS（格式另含 JSON）通过；最后按输入 head → 代码 HEAD 的精确完整差异再次执行同一检查，exit 0。 |
| `bun run lint:engine-bypass` / `lint:workflow-test-paths` / `git diff --check` | exit 0；20 workflow 路径存在。预算/包边界/发布清单已含上述组。 |
| `bun run test:package-release` | exit 1：10 包 clean build/pack/extract、**49 strict NodeNext declarations/47 runtime entries**（含新 Host 窄入口）、published owner-auth consumer 编译均通过；随后 Node listen 127.0.0.1 EPERM，uploaded-document consumer 未到达。不能标完整通过。 |
| 下方真实 TCP/CI 顺序组合（8 文件） | 24 pass / 68 fail / 0 skipped，136 assertions；68 项均 fixture 启动 server 失败，模型 Host 的真实 Core 客户端4项与 miniDOM等通过。没有 skip 或放宽断言。 |
| CI 原 core-rest 命令 | 完整导出四项已通过；广泛 TCP/HTTP fixture 的 listen 启动失败、子进程 fixture 失败和每项 30s hook timeout，另一个 GitHub 错误文案 fixture 因网络受限得到“无法连接 GitHub”而非 missing repo 提示。持续出现相同监听失败后整体中断（exit 130），无成功 JUnit，不标完整分片通过；原命令必须正常宿主/CI 补跑。未改 skip/timeout/预期。 |
| Git | 三个代码提交已成功；随后文档精确 git add 再次被共享 `.git/worktrees/host-shared-services-20261015/index.lock` Operation not permitted 拒绝（exit 128）。文档 commit 未执行；8 份文档保留在任务树，补交命令见下，不提升/绕过。 |

中途失败均保留定位：窄 bundle 检查初次从 root 解析未声明的 esbuild 失败，改为使用 Desktop 已声明依赖；graph 实际按生产 package exports 解析 dist，精确期望改为实际两个 dist modules，未增加依赖或放宽匹配。Node 完整声明 smoke 初次发现既存 DesktopOperationBatchAuthority 两类型漏 pin，已精确补齐。两项修复后对应完整契约组/Node smoke 重跑通过。旧模型文件的 3 个失败是保留的回归复现，未提交临时文件。

本轮日志均在 `/private/tmp/codeshell-shared-review-*.log`：`ci-model-baseline`（旧文件复现）、`contracts-final`、`adapters-final`、`fs-smoke-final`、`core-exports-final`、`typecheck-final`、`desktop-build-final`、`source-checks-final`、`lint`/`lint-final`、`format-final`、`package-release`、`http-restricted`、`core-rest`。旧 head bg_5u1l8 成功不替代这里的受限复验。

### 可复验命令与正常宿主补验

所有命令均在本任务目录执行；`./` 显式文件路径保留 Bun 指定顺序，不用发现过滤器来声称复现顺序。完整 CI 两分片由主控复审后接续，新 head 尚无远端 CI 结论。

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
cd "$TASK"
# 以下三项已本地运行；完整 package-release 监听段需正常宿主补验。
bun run test:package-release
# package-release 会清 dist，完成后才执行其余命令。
bun run typecheck
bun run --cwd packages/desktop build:main

# 本地通过的契约组，miniDOM 必须显式先执行：
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/web/src/test-utils/miniDomStyle.test.ts \
  ./packages/host/src/services/model-connection-probe.test.ts \
  ./packages/host/src/services/mcp-probe.http-transport.test.ts \
  ./packages/host/src/services/mcp-probe.integration.test.ts \
  ./packages/desktop/src/main/mcp-probe-service.test.ts \
  ./tests/helpers/network-fixture.test.ts \
  ./packages/core/src/index.exports.test.ts \
  ./tests/package-boundaries.test.ts

node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/host/src/services/session-files.test.ts \
  ./packages/server/src/hub/session-files.integration.test.ts \
  ./packages/server/src/sessions-service.disk.test.ts \
  ./packages/server/src/sessions-service.home.test.ts \
  ./packages/desktop/src/main/skill-inventory.integration.test.ts \
  ./packages/desktop/src/main/skills-service.test.ts \
  ./packages/desktop/src/renderer/app/useRunController.launch.test.tsx \
  ./tests/architecture-budgets.test.ts \
  ./tests/publish-release-packages.test.ts
node scripts/run-isolated-node-smoke.mjs scripts/smoke-host-shared-session-files.mjs
node scripts/run-isolated-node-smoke.mjs scripts/smoke-core-exports.mjs
bun run lint:engine-bypass
bun run lint:workflow-test-paths
git diff --check

# 对本轮精确源码差异执行 lint/格式（不扫描其他树）：
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', [
  'diff', '--name-only', '-z', '5d891c836fe99f67f104c96646d6d4b5d59ac2ed', 'HEAD',
], { encoding: 'utf8' }).split('\0');
execFileSync('bunx', ['--no-install', 'eslint', ...files.filter(p => /\.(ts|tsx|mjs)$/.test(p))], { stdio: 'inherit' });
execFileSync('bunx', ['--no-install', 'prettier', '--check', ...files.filter(p => /\.(ts|tsx|mjs|json)$/.test(p))], { stdio: 'inherit' });
NODE

# 正常宿主必须补跑真实 TCP 和 CI 的 native-global 组合：
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/web/src/test-utils/miniDomStyle.test.ts \
  ./packages/server/src/hub/model-probe.test.ts \
  ./packages/server/src/hub/mcp-configuration.test.ts \
  ./packages/server/src/hub/skills-management.test.ts \
  ./packages/server/src/hub/session-management.test.ts \
  ./packages/server/src/hub/configuration.test.ts \
  ./packages/core/src/cost-ledger/ledger.test.ts \
  ./packages/host/src/services/model-connection-probe.test.ts

# PR190 实际 CI 分片路径/参数，不能仅用孤立模型文件替代：
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  --path-ignore-patterns '**/src/engine/**' \
  --path-ignore-patterns '**/src/tool-system/**' packages/core
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  tests packages/coding packages/tui packages/pet packages/server packages/chat \
  packages/web packages/arena packages/cdp packages/link packages/optimization-lab \
  packages/browser-devtools packages/host
```

代码均逐路径暂存并成功提交：`5e6eabdf5`（MCP/CI/guard）、`4b9a76286`（FS/窄入口/Skills扫描）、`f48ca6bab`（保留 run 诊断）。实际 newhead 为 `f48ca6bab3538c9f9d41217dc08250f986348eeb`。最后文档 add 遇到 index.lock 权限拒绝，未执行文档 commit；主控正常宿主仅需补交下列 8 路径，不碰其他任务文件：

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
git -C "$TASK" add -- \
  CHANGELOG.md \
  TODO.md \
  docs/architecture/16-platform-consolidation.md \
  docs/todo/evidence/host-shared-services-20261015.md \
  docs/todo/evidence/host-shared-services-cc-review-20261015.md \
  docs/todo/platform-first-version-plan.md \
  docs/todo/platform-pr188-followups.md \
  packages/host/README.md
git -C "$TASK" commit -m 'docs(platform): record Host shared-service review fixes and evidence'
git -C "$TASK" rev-parse HEAD
git -C "$TASK" status --short
```

只停供同一 CC 复审，不开始 9 credentials/OAuth 或 8b replay，未 push/merge/release。

## 主控接续：同一 CC 第二轮复审与正常宿主实测（cb2c652b5）

主控已补交八份文档为 `cb2c652b5da37ffa301759a4351a5eb7bf30b7a8`，源码仍对应 `f48ca6bab`。同一 CC session `c6bcaca0-6811-42f4-a928-2aeb810c7a7d` 的 job `cc-crmj845sol` 对 `5d891c836..cb2c652b5` 只读复审：原 P1 与其余发现关闭，P2-1 的 env 部分和 Desktop JSON 日志兼容仍需收尾。静态“无阻断”不能代替以下宿主失败的修复。

主控给定的五组修复范围（勾选表示本轮代码与可运行本地验证完成，尚待同一 CC 复审及正常宿主复验）：

- [x] **普通 env 误脱敏（CC P2-1 剩余）**。`config.env` 和 `envVars` 所有值仍加入秘密集合。DEBUG=1、MODE=read、LOG_LEVEL=info 不应改坏 read_file、普通数字和描述；按认证字段识别真实凭据，真实短 token 仍须隐藏，长私有配置值不能回显。`apikey`/`x-apikey` 认证 header 一并识别；envHeaders/bearerTokenEnvVar 始终按凭据处理。增加生产 fixture 同时验证显示与不泄漏。
- [x] **Desktop 结构化日志兼容（CC P2）**。`skip-banner` 当前只跳过 JSON.parse 失败；pino 风格合法 JSON、非 JSON-RPC 日志也要与旧 Desktop SDK/Core runtime 一样跳过。Hub strict 保持失败；所有行仍计帧/总量，超限、关闭、超时、取消及进程回收不退化。修正相关测试和文档既存“有效 JSON 但非法 JSON-RPC 两方都拒绝”的表述。
- [x] **Hub 原位置参数隐私契约回归（宿主实测）**。`packages/server/src/hub/mcp-configuration.test.ts:326`：args `[script, "argument-secret"]` 与 TOKEN env 由真实 stdio 服务回显；当前只隐藏 TOKEN，位置参数泄漏。不得删除原断言，不能只把 fixture 改成 --token 掩盖，也不能重新无差别替换短 launcher/run 参数而改坏 run_query。可建立明确的秘密/配置私有值策略，兼容 Hub 的既有隐私要求，普通工具标识保持正确。
- [x] **新测试污染全局 cipher（完整 rest 实测）**。`packages/host/src/services/mcp-probe.http-transport.test.ts` afterEach 调 `setDefaultCredentialCipher(null)`；新 Desktop `mcp-probe-service.test.ts` 也有同样错误。API 要求 EncryptionCipher，不支持 null reset。完整 rest 后续 `server/src/panels/runtime.test.ts` 七个 Cookie 场景因 `this.cipher.encrypt` null 失败。测试须保存并恢复准确的原 cipher，不能将生产接口放宽为 null 或移除真实 Cookie 场景。用指定执行顺序证明隔离。
- [x] **中文路径 fixture 两处解码错误（本机完整 rest 暴露的既有问题）**。34 项 `tests/docker-candidate-browser-guard.test.ts` 将 `new URL(...).pathname` 交给 createRequire，导致路径仍含 `%E4...`，找不到 ws/package.json；3 项 `tests/docker-candidate-pdf-argv.test.ts` 的 `tests/fixtures/docker-candidate-pdf-argv-case.mjs:14-15` 用同样 pathname 读 preload/guard 报 ENOENT。修为标准 fileURLToPath，保留原权限/哈希/进程/路径拒绝断言，验证含中文/空格路径；不改安全机制或引入临时 ASCII checkout 回避。此两文件在本任务旧累计 diff 中未修改，须明确属于宿主暴露的原有 fixture 缺陷。

固定 head 宿主 bg_62zyzf（日志 `/tmp/codeshell-pr190-repaired-host-20261015.log`）：冻结安装、**完整 package-release（10 tarballs / 49 typed / 47 runtime，含真实 Node HTTP owner/auth 和 uploaded docs）**、14 workspace typecheck、Desktop main、两组 **130 pass / 0 fail / 794 assertions** 均通过；第三组真实 HTTP/账本/native-global 组合 **91 pass / 1 fail / 532 assertions**，失败即位置参数隐私断言。后续步骤因 set -e 未执行，主控已另行补跑。

固定同 head 宿主 bg_755wdm（日志 `/tmp/codeshell-pr190-repaired-full-shards-20261015.log`）：Node Session FS 与 Core exports smoke 均 exit0；**完整 core-rest 3620 pass / 0 fail**；完整 rest **5009 pass / 72 skip / 45 fail，577 files / 22054 assertions**。45 个失败完整归类为上述 34 个 Unicode fixture + 3 个 PDF fixture + 7 个 cipher 污染 + 1 个位置参数回显。两个分片完整执行，最终 `NODE_FS=0 NODE_EXPORTS=0 CORE_REST=0 REST=1`，结束 head 未变。不能将 rest 标绿；skip 为原测试显式条件，不是本轮新增。

上文旧限制仅代表历史。本轮以上五组收尾必须由 Codex 实际修复、同 CC 复审，然后正常宿主/CI 重新验证最终源码，才允许 PR190 合并；不进入第9项。

## cb2c652b5 后五组修复（本轮 Codex，待同 CC 复审）

输入 `cb2c652b5da37ffa301759a4351a5eb7bf30b7a8`，累计任务 base 仍为 `19bc2167402da53caeace26ac69207822c166448`。仅指定任务树 `codex/host/shared-services-20261015`；保留并整理主控原有的本文件变更。未改 main/其他任务树，未调用 CC/Claude 或写入 worker；只读辅助审计没有写文件。没有进入第 9 项、8b、v2，没有 push/merge/release。

| 组 | 根因、修复与有效证据 |
| --- | --- |
| 1 普通 env 与认证 header | 原所有 env/envVars 值进入秘密集合，导致 `1/read/info` 字串替换破坏预览。Host 统一规则：认证键（包括 camelCase、apikey/x-apikey）、envHeaders、bearerTokenEnvVar、显式认证 argv 不设最短长度；其余 env/envVars/argv 值长至少 **8 字符**仍按私有配置隐藏，flag 名是语法。普通短值保留；不会以“不是认证键”公开所有长值。实际 SDK stdio 的两 adapter fixture 保留 run_query/read_file、`run read info 1 42`，同时拒绝 TOKEN/APIKEY、长未标注 env/envVars、位置参数和短 token/access-key/key/passwd/cookie 回显；HTTP transport fixture 验 apikey/x-apikey 和非认证变量名的短 envHeaders/bearer 值。原 protocol/content-type 断言保留。 |
| 2 Desktop JSON 日志 | 原兼容模式只跳过 parse 失败，validation 失败仍 fatal。Core 仅在 skip-banner 下也跳过合法 JSON 非 JSON-RPC logger 记录；Hub strict 未变。实际子进程分别输出非 JSON 横幅/pino 日志：Desktop 成功、Hub invalid_protocol 并关闭。新增兼容日志单行超限/总量超限断言；strict 与 skip-banner 都实际验证 timeout、取消、已撤销不启动和忽略 SIGTERM 的子孙回收。原分页/重复 cursor/512 KiB frame/2 MiB total 断言未删，旧“两方拒绝有效 JSON 非 RPC”的文档已更正。 |
| 3 原 Hub 位置参数隐私 | 原命名 token-only 策略漏 `[script, "argument-secret"]`。共享 Host 的未标注长配置规则补齐，不新增 adapter 脱敏副本；Host stdio fixture 恢复该原始位置参数形态并经真实 Desktop/Hub adapter 通过。原 `server/hub/mcp-configuration.test.ts` 的 args/TOKEN/安全断言完全未改；其 HTTP 原用例在本沙箱仍被监听限制挡住，必须正常宿主补验，未声称本地原 HTTP 用例通过。 |
| 4 cipher 与全局恢复 | 两新测试的 null 不是 reset，污染后续默认 CredentialStore。使用现成 getter，在每次覆盖前保存，finally 恢复同一 cipher 对象并断言身份；生产 setter/类型/exports 未改。两处遗漏的临时 env 也恢复旧值而非只 delete。HOME、DOM descriptor、network LIFO 恢复已核对。正序与逆序 MCP 测试之后运行现有真实 CredentialStore 加解密/持久化测试均通过；foreign encrypted-store failclosed 断言保留。七个真实 Cookie HTTP 场景未改，需正常宿主执行两种顺序；本地仅做一次监听确认后停止，不反复整片超时。 |
| 5 Unicode/空格 fixture | 两处既有 fixture 把 URL.pathname 当文件路径，残留百分号编码。browser anchor 与 PDF preload/guard 来源改用 fileURLToPath。PDF 沿用既有 guard test 的两文件私有字节 bundle 准备，保持 preload/guard 哈希和严格 NODE_OPTIONS 契约；未修改任何 `scripts/docker-candidate-*` 安全机制。当前中文工作树全套通过；另用真实含中文/空格的 require anchor、以及 `--preserve-symlinks-main` 的中文/空格源码入口执行完整 18 个 PDF 边界并断言实际入口路径。仅建 tests/scripts 的临时别名和私有字节 bundle，未创建 ASCII checkout。原权限、哈希、拒绝、进程、字节断言全部保留。 |

本轮源码/测试三个内聚提交：

- `51d6008d9733f6fb07f791b4de36c273642b7c1d` — 共享脱敏与 Desktop logger 兼容及真实 stdio 回归。
- `28a1cad75bb44d927acb94c0d60b3496bc359117` — cipher/env 精确恢复、认证 header fixture。
- `11d602198da6c31643c2070fa0d4662a64bee0e3` — Unicode/空格 fixture 可移植性。

Host 运行依赖仍仅 Core/Node builtin；未新增 runtime export、稳定 public SDK、adapter 权限、缓存 target 或调用模型的入口，未抬预算。

### 本轮验证结果

所有 Bun 测试经 guarded runner 隔离 HOME/应用状态/凭据；Node smoke 用现有隔离 launcher。MCP HTTP 为真实 SDK + 注入 fixture transport，stdio 为真实子进程；自身 guard 在生产 imports 前安装，其覆盖/模块缓存边界仍按前节说明。无真实 provider/付费调用/MCP 账户/操作者 credentials。先构建 Core/Host；package-release 串行结束后才 typecheck/读 dist。

| 命令/范围 | 本轮结果 |
| --- | --- |
| 最终顺序契约组（下方 10 文件） | **98 pass / 0 fail / 0 skipped，699 assertions**。显式 miniDOM → Host 模型 → Host HTTP → Desktop MCP → stdio → 现有 CredentialStore，再检查 guard/export/预算/包边界。 |
| Unicode/browser/PDF 两文件全量 | **43 pass / 0 fail / 0 skipped，152 assertions**，包括新增真实中文/空格路径用例。与前组共 **141 pass / 851 assertions**。 |
| cipher 逆序组合（下方 3 文件） | **49 pass / 0 fail / 0 skipped，300 assertions**；与前组重叠，不重复累加。 |
| `bun run typecheck` | exit 0，完整 14 workspace，含 Desktop/Web。最终认证 flag 复用规则后执行，构建声明也通过。 |
| Desktop `build:main` | exit 0，实际 19.4 MB main bundle。 |
| 两个隔离 Node smoke | exit 0；Session FS 身份/close/有界重试/候选预算、Core 精确 exports/identity 均通过（264 runtime/115 internal types）。 |
| targeted ESLint / Prettier | 8 个本轮精确 TS/MJS 源码/测试全部 exit 0；最终 flag 收尾后再次检查。 |
| engine-bypass/workflow paths/diff whitespace | exit 0；20 个 workflow 路径存在，架构/包边界已含最终 98 项组。 |
| `bun run test:package-release` | exit 1；10 包 build/pack/extract、49 typed/47 runtime（含 Host 窄入口）与 owner-auth consumer 编译通过，Node HTTP owner-auth listen EPERM，uploaded-docs 未到达。最终 flag 收尾只改变内部值分类，无 export/声明变化；最终 typecheck 和 Node exports 另通过。必须正常宿主完整复验，不沿用 cb2 的完整成功。 |
| 原 Hub 单用例 TCP 定向尝试 | exit 1，0 pass / 1 fail，14 filtered；原用例在 server 启动时报 Failed to start server，未到达 stdio/隐私断言。未改测试预期或新增 skip。 |
| 原 Cookie HTTP 单用例定向尝试 | exit 1，0 pass / 1 fail，54 filtered；同样在监听时失败，未到达 Cookie 行为。仅确认限制一次，未再跑已知会阻塞的整片。 |

原始日志 `/private/tmp/codeshell-shared-third-{core-build,host-build,contracts-final,cipher-reverse-final,unicode,stdio-final,typecheck,desktop-main,node-fs,node-exports,source-checks-final,lint-final,package-release,hub-tcp,cookie-tcp}.log`。最初契约 96 pass、cipher 逆序 49 pass；扩充两种 policy 的进程回收与认证 flags 后最终契约重跑为 98 pass，上表以最终组为准。没有把旧 cb2 的 3620/5009 或其 package-release 结果充作本轮新 head 的全量成功。

### 精确复验与正常宿主待验

本轮已跑的可运行组：

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
cd "$TASK"
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/web/src/test-utils/miniDomStyle.test.ts \
  ./packages/host/src/services/model-connection-probe.test.ts \
  ./packages/host/src/services/mcp-probe.http-transport.test.ts \
  ./packages/desktop/src/main/mcp-probe-service.test.ts \
  ./packages/host/src/services/mcp-probe.integration.test.ts \
  ./packages/core/src/credentials/store.test.ts \
  ./tests/helpers/network-fixture.test.ts \
  ./packages/core/src/index.exports.test.ts \
  ./tests/architecture-budgets.test.ts \
  ./tests/package-boundaries.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./tests/docker-candidate-browser-guard.test.ts \
  ./tests/docker-candidate-pdf-argv.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/desktop/src/main/mcp-probe-service.test.ts \
  ./packages/host/src/services/mcp-probe.http-transport.test.ts \
  ./packages/core/src/credentials/store.test.ts
node scripts/run-isolated-node-smoke.mjs scripts/smoke-host-shared-session-files.mjs
node scripts/run-isolated-node-smoke.mjs scripts/smoke-core-exports.mjs
```

源码格式/静态检查采用精确八路径（无全树写入）：

```sh
cd "$TASK"
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', [
  'diff', '--name-only', '-z', 'cb2c652b5da37ffa301759a4351a5eb7bf30b7a8', 'HEAD',
], { encoding: 'utf8' }).split('\0').filter(p => /\.(ts|tsx|mjs)$/.test(p));
execFileSync('bunx', ['--no-install', 'eslint', ...files], { stdio: 'inherit' });
execFileSync('bunx', ['--no-install', 'prettier', '--check', ...files], { stdio: 'inherit' });
NODE
bun run lint:engine-bypass
bun run lint:workflow-test-paths
git diff --check
```

正常宿主必须接续（始终同一任务 cwd，所有 `./` 文件顺序保留；package-release 不与任何读 dist 检查并发）：

```sh
cd "$TASK"
bun run test:package-release
bun run typecheck
bun run --cwd packages/desktop build:main

# 完整原 Hub fixtures：包含未改的原位置参数隐私断言和真实 GET/SSE。
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/server/src/hub/mcp-configuration.test.ts

# 正序与逆序的后续七个真实 Cookie 场景，不能只跑孤立 MCP 测试：
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/web/src/test-utils/miniDomStyle.test.ts \
  ./packages/host/src/services/model-connection-probe.test.ts \
  ./packages/host/src/services/mcp-probe.http-transport.test.ts \
  ./packages/desktop/src/main/mcp-probe-service.test.ts \
  ./packages/server/src/panels/runtime.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  ./packages/desktop/src/main/mcp-probe-service.test.ts \
  ./packages/host/src/services/mcp-probe.http-transport.test.ts \
  ./packages/server/src/panels/runtime.test.ts

# 同 CC 复审后，对最终准确 checkout 运行 PR190 两分片：
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  --path-ignore-patterns '**/src/engine/**' \
  --path-ignore-patterns '**/src/tool-system/**' packages/core
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  tests packages/coding packages/tui packages/pet packages/server packages/chat \
  packages/web packages/arena packages/cdp packages/link packages/optimization-lab \
  packages/browser-devtools packages/host
```

源码已逐路径提交；文档同步更新本清单、计划、TODO、架构、Host README 与 CHANGELOG。当前两项 CC 剩余 P2 的实现及宿主 45 fail 对应代码均已修复，**CC 复审和最终源码的正常宿主/CI 门槛仍待执行**。停供同一 CC 只读复审，不自行调用 CC 或进入下一批。

本轮实际 newhead：`11d602198da6c31643c2070fa0d4662a64bee0e3`。三个源码提交成功后，文档精确 git add 再次被共享 `.git/worktrees/host-shared-services-20261015/index.lock` 的 `Operation not permitted` 拒绝（exit 128），文档 commit 未执行；未提升权限或绕过。六份未提交文档全部属于本任务（本文件含主控原变更），正常宿主精确补交命令：

```sh
TASK='/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/host-shared-services-20261015'
git -C "$TASK" add -- \
  CHANGELOG.md \
  TODO.md \
  docs/architecture/16-platform-consolidation.md \
  docs/todo/evidence/host-shared-services-cc-review-20261015.md \
  docs/todo/platform-first-version-plan.md \
  packages/host/README.md
git -C "$TASK" commit -m 'docs(platform): record remaining Host review fixes and host gates'
git -C "$TASK" rev-parse HEAD
git -C "$TASK" status --short
```
