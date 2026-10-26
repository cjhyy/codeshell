# Windows 启动诊断：批次 3 本地交接（2026-10-26）

当前状态（2026-10-27）：来源批次已获原 CC **161 pass / 0 fail**，现已精确转入[2026-10-27 组合候选](audit-integration-20261027.md)，原 CC session `3e34f601-e67b-4de4-a43f-eba9cf0283f3` 最终组合验收已 PASS，已快进合入本地 main；未推送、未发布。
以下独立 worktree、执行与安全回执均为来源阶段历史。此处 done 仅指一次有界首窗状态 probe
和显式本地 dump 收集工具；Windows 首窗超时、`0xC0000005` 和原生验收仍未关闭。

工作分支 `codex/desktop/windows-launch-diagnostics-20261026`，基线
`55dce40442926c83995d1c76c78e47f10d71c625`。仅本 worktree 由主代理写入，两个内部代理
只读复核；未读取或修改批 1 NSIS、批 2 Mobile 的实现，未依赖其未合入改动，未继续 Panel 批 4。
遵照本批授权保留既有 worktree/基线；没有 fetch、commit、push、merge 或运行 CI。

## 计划与实际实现

1. 先补真实 driver 首窗失败路由、字段投影及合成 dump 边界测试，确认红灯。
2. 接入 opt-in probe，不改身份、completion、settlement schema 或清理授权。
3. 新增独立本地 collector，沿用现有 evidence 脚本结构与 reviewed 文件检查模式。
4. 只读复审发现问题后先补失败用例再修复，分组重跑 Node/Bun 合同和静态检查。

### 首窗 probe

`e2e-ui-packaged.mjs` 在真实 `findCodeShellWindow(app)` 前后设置首窗 pending 状态。
仅该调用失败后，外层 catch 先调用已有 `recordFirstError` / `fixture.recordLaunchFailure()`
同步冻结首次 timing、保存原错误对象，再 await `fixture.probeFirstWindow(app)`。
后续 UI 错误不触发 probe；probe 自身意外拒绝也不会跳过原错入账和原有 settlement/cleanup。

沿用现有 hosted Windows x64/win22 opt-in；未新增其他平台自动探测。fixture 将 probe
绑定到已 captured 的同一 ChildProcess，每次 launch 最多一次。`packagedLaunchDiagnostics`
的每个 launch 新增 `windowProbe`，未探测为 null，其余状态固定为 observed / failed / timeout。
controller 使用一个 3000ms timer 与 evaluate race，finally 清 timer；evaluate 的拒绝处理器
在 race 前安装，不等待迟到 evaluate，迟到成功/拒绝不会回写已决定的状态。
这是 controller 事件循环上的期限，不是实时 OS 调度保证，也不能取消已经发送的 evaluate。

实际 API 形状已核对本 worktree 安装的 Playwright 1.64.0 和 Electron 33.4.11：
`evaluate` 回调收到 Electron 模块；`application.windows()` 是 Playwright `Page[]`，
独立记录为 `playwrightWindowCount`，不能当作 Electron BrowserWindow 数。
Electron 侧实际采样 `app.isReady()`、`BrowserWindow.getAllWindows()` 及最多 8 个窗口的
id / visible / destroyed / crashed / loading / urlKind。destroyed 窗口不读取 id、visible、
webContents；destroyed webContents 不调用其状态或 URL 方法。销毁竞态返回固定缺失值或
固定 failed 状态，异常细节不进入 probe。API 参考：[Playwright ElectronApplication](https://playwright.dev/docs/api/class-electronapplication)、
[Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)，以本地 pin 的类型及运行实现为准。

URL 在 Electron evaluate 内就投影为固定分类：empty、file:index.html、file:other、http、
https、about:blank、data、other、invalid、unavailable。原始 URL、目录、query、credentials
从不作为返回值传出；没有新增页面文本、截图或 renderer 内容采集。
controller 侧沿用 `projectSnapshotTiming` 的 own data-descriptor 读取方式，拒绝 getter、
非有限数、负数/小数/不安全整数及超过 8 元素的数组，仅复制白名单字段，无动态属性展开。
坏投影仅标 recordingFailed 并留下固定 failed probe；首次 timing、后续 probe、settled timing
分别保存，互不覆盖。

严格消费者已全查：`windows-packaged-main-crash-evidence.mjs` 的 checkedTarget/source pins、
`windows-nsis-crash-evidence.mjs` 的 exactKeys/事件 accounting、
`windows-nsis-acceptance.mjs` 的身份/settlement gate，以及 packaged shutdown。
它们不读取这个诊断字段，原有严格结构测试继续通过；没有改身份或 settlement schema。

### 显式本地 dump collector

新增 `packages/desktop/scripts/windows-wer-dump-evidence.mjs`，导出可测试的
`collectWerDumpEvidence` / `runWerDumpEvidenceCli`。两个目录均须用户显式给出、已存在、
为绝对规范路径，目录和全部祖先均须普通非链接目录；拒绝 source/output 同目录、
同 dev/ino 或相互嵌套。CLI 没有系统 WER 目录默认值，不读取真实 HOME/config/crash 数据。

```powershell
node packages/desktop/scripts/windows-wer-dump-evidence.mjs --help
# 用户自行选定、事先准备且受私有 ACL 保护的两个目录：
node packages/desktop/scripts/windows-wer-dump-evidence.mjs --source C:\private\synthetic-input --output C:\private\synthetic-output
```

文件名完整匹配 `^(code-shell|electron|code-shell-Setup-[\w.-]+)\.exe\.\d+\.dmp$`，
在所有平台显式使用 case-insensitive 语义；额外要求匹配消耗全部字符串，拒绝末尾换行。
产品依据是 Desktop package.json 的 `build.productName=code-shell`、
`build.nsis.artifactName=${productName}-Setup-${version}.${ext}` 和现有
`windows-nsis-acceptance.mjs` 的 code-shell.exe 合同。匹配不证明 dump 属于本次运行。
普通无关文件/目录垃圾仅消耗枚举预算，不算 dump；匹配候选若是目录、链接或 FIFO 则整次拒绝。

固定资源预算及行为实证：

| 资源          | 上限与测试                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| dump 数量     | 最多 4；6 个候选按 basename 排序后复制前 4，余项逐一 file-count-limit                                             |
| 单文件        | 64MiB（含边界）；64MiB+1 sparse 文件跳过，file-size-limit，完全不读取该文件字节                                   |
| 全部新输出    | 256MiB，包含 manifest；先预留 64KiB manifest，3×64MiB + (64MiB−64KiB) 可复制，4×64MiB 最后一个 total-output-limit |
| manifest      | 最多 64KiB，最终编码后再核总输出；仅含 bounded 元数据、limits/boundary/reasons                                    |
| 枚举          | 最多处理 128 项、最多 129 次 readSync 判断超量，opendir bufferSize=1；垃圾也计入预算                              |
| 名称          | 单名最多 255 UTF-8 bytes；累计最多 16KiB，分别有超限注入/长垃圾目录测试                                           |
| 路径          | 每个输入最多 4096 字符，祖先最多 64 层，超限在文件 open 前拒绝                                                    |
| 读取内存/句柄 | 64KiB 固定块；源读取及目标/manifest 读回总计最多 512MiB；最多 5 个同时打开的文件 fd，成功全部关闭                 |

达到可截断预算时 `truncated=true`，reasons 仅取固定的 entry-limit、name-limit、
listed-name-limit、file-size-limit、file-count-limit、total-output-limit。
有文件名的已枚举候选在 skipped 中记 name/size/reason。超过枚举或名称预算的未观察部分
不虚构具体 dump 数量；只对已观察的有界子集排序，不声称全目录排序或完整发现。

文件系统校验沿用 `windows-nsis-leftover-metadata.mjs` 的逐祖先 lstat/realpath/身份复核，
以及 `composer-operation-diagnostics.mjs` 的 lstat→nofollow open→fstat→同 fd 读取→末尾
fd/path/parent 复核模式；未抽通用框架。source fd 仅 O_RDONLY，兼有可用的 O_NOFOLLOW
和 O_NONBLOCK（防 lstat 后被换 FIFO 导致 open 阻塞）。copy 与 SHA256 使用同一打开的
source fd；固定长度读、尾部额外 1-byte read 和 size/mtimeNs/ctimeNs/dev/ino/mode/path
复核覆盖复制期间的截断、增长、替换。测试核对原 source hash 不变。

output 只用 create-exclusive + O_RDWR 新建文件，先复核目标 fd 与目录/祖先，再写任何 dump 字节；
所有写入走该 fd，已有任何同名未知文件（含旧 manifest）均不覆盖。写完从同一目标 fd
有界分块读回 SHA，与同一 source fd 所算摘要核对，读回前后核完整 stat/path/nlink；
source fd 在目标校验后再复核一次才关闭。各 dump 复制完成后的
fd/path 身份、nlink、完整 stat 在写 manifest 前后再次复核，拒绝此前目标被改写/替换/硬链接。
manifest 最后新建，并从同一目标 fd 逐块读回与预期编码 Buffer 逐字节比较；
源始终 O_RDONLY，没有读取或改写任何已有 output 文件。失败时通过仍持有的 manifest fd 清空无效化，再仅删除本轮创建且
仍同身份的目标。测试含完整 manifest 写入后目录换位、部分写入错误和未知替换目标保留，
失败不遗留可被解析为本次成功的 manifest。目录移动时可能留下私有 dump 残片或空文件，
不会为删除残片追踪到未知路径。

`wer-dumps.json` 的每个成功条目仅 name / size / sha256 / mtime（bigint stat 的 UTC
整毫秒投影），不记录完整本机路径或内存内容；CLI 错误也不打印底层含路径异常。
但 dump 文件本身包含敏感内存，basename 也由用户输入派生，manifest/hash 不能视作匿名化或根因证据。
POSIX 文件及 manifest 请求 0o600，并实测私密 mode；**Node mode 不是 Windows ACL**，
Windows 必须由用户预先选择受私有 ACL 保护的目录，本批没有配置 ACL/注册表。
这些 portable 身份复核不是内核级 rename/symlink 竞态沙箱；原生 Windows/reparse point
语义仍需独立验收。收集器不运行进程、不改 source，不启动 WER、不联网、不上传。

## TDD、修正与验证记录

环境：macOS arm64，Node v25.8.1，Bun 1.3.11；依赖仅在本 worktree 用
`bun install --frozen-lockfile` 安装（exit 0，2099 packages），未改 lockfile，未安装系统软件。
测试 HOME、配置与所有数据均为 guarded runner / mkdtemp 下的合成隔离夹具；未访问真实 crash、
Keychain、secrets 或操作员 HOME。网络拒绝 guard 在 collector import 前安装并在所有合成用例后
核实没有网络调用；FIFO 夹具只使用已有 mkfifo，不启动真实应用或 WER。

| 阶段                             | 实际结果                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 初轮 A+B 红灯（实现前）          | 21 pass / 6 fail，含 4 个缺失 probe 行为、真实 driver probe 次数为 0、collector 模块未存在                            |
| 初轮实现                         | 44 pass / 1 fail：mtime 普通 stat 与 bigint stat 毫秒舍入断言不一致；改用同 bigint 元数据核对                         |
| 增补资源/竞态第一轮绿灯          | 55 pass / 0 fail                                                                                                      |
| 只读复审后先补红灯               | 56 pass / 6 fail：timer 清理异常、probe 意外拒绝、appReady=false 推断窗口数、3 种此前目标变更                         |
| 修复并补同目录身份门禁           | 63 pass / 0 fail                                                                                                      |
| 枚举预取预算补红灯               | 定向 0 pass / 1 fail；补 bufferSize=1 后纳入最终绿灯                                                                  |
| 目标写入期间改写补红灯           | 定向 0 pass / 2 fail；dump 与 manifest 曾被接受错误 baseline，补同 fd 读回后通过；manifest 仍合法 JSON 的变更也被拒绝 |
| 校验期间源变化补红灯             | 定向 0 pass / 1 fail；补目标校验后的源 fd/path 再复核后通过                                                           |
| 中途错误 runner 分组（如实保留） | 138 pass / 2 loading fail：误将两个 bun:test 的 mjs 交给 Node；核对 imports 后改用指定 Bun shard                      |
| 最终 Node 六文件                 | 143 pass / 0 fail / 0 skipped；含 3s 实际期限与全部合成边界                                                           |
| Bun 两文件                       | 18 pass / 0 fail / 0 skipped，42 expect calls，完整 JUnit 校验通过                                                    |
| workflow paths                   | 97 literal paths 全部存在；未改 workflow                                                                              |
| lint                             | 首次 2 errors / 99 warnings（新测试漏导入 performance）；最终 exit 0，0 errors / 99 既有 warnings                     |
| Prettier / diff                  | 所有 6 个 mjs 源/测试及本文 Prettier check 通过；git diff --check exit 0                                              |

可复跑的精确最终命令：

```sh
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/electron-harness.test.mjs packages/desktop/scripts/windows-source-harness.test.mjs packages/desktop/scripts/windows-packaged-main-crash-evidence.test.mjs packages/desktop/scripts/windows-nsis-crash-evidence.test.mjs packages/desktop/scripts/windows-wer-dump-evidence.test.mjs
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/scripts/run-packaged-ui-acceptance.test.mjs packages/desktop/scripts/packaged-pet-shutdown.test.mjs
node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/windows-wer-dump-evidence.mjs --help
node scripts/check-workflow-test-paths.mjs
bun run lint
bunx prettier --check packages/desktop/scripts/e2e-ui-packaged.mjs packages/desktop/scripts/packaged-pet-fixture.mjs packages/desktop/scripts/packaged-startup-observation.mjs packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/windows-wer-dump-evidence.mjs packages/desktop/scripts/windows-wer-dump-evidence.test.mjs docs/todo/windows-launch-diagnostics-20261026.md
git diff --check
```

红绿阶段重复使用的精确命令（实现前及各轮修正前后，计数见表）：

```sh
node scripts/run-isolated-node-smoke.mjs --test packages/desktop/scripts/packaged-startup-observation.test.mjs packages/desktop/scripts/windows-wer-dump-evidence.test.mjs
node scripts/run-isolated-node-smoke.mjs --test --test-name-pattern 'enumeration and name budgets' packages/desktop/scripts/windows-wer-dump-evidence.test.mjs
node scripts/run-isolated-node-smoke.mjs --test --test-name-pattern 'modified in place during its own write' packages/desktop/scripts/windows-wer-dump-evidence.test.mjs
node scripts/run-isolated-node-smoke.mjs --test --test-name-pattern 'source changed during destination verification' packages/desktop/scripts/windows-wer-dump-evidence.test.mjs
```

新增 A 用例直接在已有 workflow 列出的 packaged-startup-observation.test.mjs 内，执行实际
driver launch/findCodeShellWindow/catch 源码、实际 fixture probe 方法、真实 findCodeShellWindow
和真实 observation/shutdown leaf，mock 仅替代 Electron/进程/文件边界；不是 grep 判断功能。
另有实际 3s pending-evaluate 期限测试、late reject/late success、坏 getter、非有限数、destroyed
竞态、首错保留和 timing/settled 共存。新增独立 windows-wer-dump-evidence.test.mjs **暂未接 CI**，
上列本地命令显式执行；没有为接入而修改 workflow。本批只改 mjs/Markdown，未触 TS，
按授权没有运行全 build/typecheck，也未改 dist 或其他 worktree 的 node_modules。

## 缺少的原生证据与仅文档候选

本机不是 Windows，没有执行 Windows 真包/CI40、没有读取真实 WER 或生成/分析真实 dump。
尚无异常模块/地址、符号栈与对应进程完整 birth 的 dump 绑定，因此不能判断
`0xC0000005` 根因；probe 也只说明一次采样时的窗口状态，不证明超时成因。
后续仍需准确 installer/app/ASAR/source 摘要、Windows OS/架构、UTC 时序、
PID/PPID/birth、异常模块/地址、dump 与符号一致性证据。现有身份与清理门禁未放宽。

以下只是后续独立方案候选，本批没有执行或修改相应配置：

- Windows 独立 job 可考虑临时 WER LocalDumps，DumpType=1 / DumpCount=8，指定该 job
  独占的临时目录，并设计注册表恢复与清理。但需要另行授权及原生验证；本工具不设置这些项。
- dump 含敏感内存，默认仅本地保留；公开仓库不得把 dump 自动上传公开工件，任何未来上传
  必须先由用户专门确认目标、可见性、内容及保留期。当前 artifact retention-days=7 只是已有
  配置事实，不是 dump 上传许可；保留期调整只列候选，不改 workflow、不删除历史工件。
- release workflow 中历史 “nine tarballs” 文案可候选改为 “ten tarballs”，另批核对实际十包
  清单后再做；本批不改发行、CI、workflow 或发布状态。

来源阶段安全边界：未提交/推送/合并、未触发 CI/workflow、未改 WER 注册表/真实 HOME/secrets、
未读取真实 crash/dump、未上传工件、未安装系统软件。停在本地交接，等待原 CC 验收。
