# Windows 兼容性审计 + CC/Codex 对照

> 2026-06-10。全仓库(core / tui / desktop)Windows 兼容性审计,配套对照 Claude Code 与 OpenAI Codex CLI 的真实做法。
> 本文是**结论文档**,初稿,后续随实现迭代。审计方法:7 维度并行扫描 + 对每条发现做对抗性验证(读真实代码,过滤被 `process.platform` 守卫挡住的假阳性)。结果:**34 条确认,38 条假阳性驳回**。

---

## TL;DR

- 项目现状是 **"半支持" Windows**:desktop 的 electron-builder 实际打 Windows 包,`worktree.ts` 的 `PlatformScripts` / `pty-service.ts` 都有 win32 分支,但 Bash 工具、后台 shell、沙箱、公网隧道在原生 Windows 上都是坏的。
- **根因高度集中在 2 处**,修这两块能消掉大半 blocker:
  1. **shell 选择没统一**——`utils/env.ts:15` 已有正确的跨平台模式,但多个文件各自写死 `/bin/bash` / `sh`。
  2. **进程组终止**——`killProcessGroup()` 用 Unix-only 的负 PID + 信号名。
- **方向建议(经 CC/Codex 对照后)**:做**原生 Windows 支持**,但沙箱**学 CC 显式跳过**(文档明说不支持、引导 WSL2),而不是静默降级。Codex 那套原生 Windows ACL 沙箱是重投入,不在当前范围。

---

## 一、CC / Codex 怎么做的(决策依据)

2026 年两家都已把**原生 Windows 当一等公民**(非 WSL-only),WSL 仅为可选项。但路线分叉很大。

| 维度 | Claude Code | OpenAI Codex CLI |
|---|---|---|
| **官方姿态** | 原生 Win10 1809+,代码签名 win32-x64/arm64,winget 安装 | Microsoft Store 原生 app(2026-03),CLI/IDE 扩展 |
| **Shell 选择** | 装了 Git for Windows → Bash 工具走 Git Bash;没装 → 独立 PowerShell 工具(探 `pwsh.exe`→`powershell.exe`),有 `CLAUDE_CODE_GIT_BASH_PATH` 覆盖 | 原生 Windows 直接在 PowerShell 跑命令 |
| **沙箱** | **原生 Windows 不沙箱**,文档明说 "run inside WSL2"(WSL2=bubblewrap,mac=Seatbelt)。feature request #46740 仍未做 | **专写原生 Windows 沙箱**(Rust crate `codex-rs/windows-sandbox-rs`:受限令牌 + 文件 ACL + 低权限沙箱用户 + 防火墙);默认推原生不推 WSL2 |
| **进程树终止** | Windows 杀树机制未查到确证(open question) | 0.72.0 按 Esc **不杀子进程树**,有 Windows 孤儿进程 bug(#7985/#14949);后续 changelog 暗示部分修了 |
| **二进制打包** | 按平台放 ripgrep(`vendor/ripgrep/<arch>-<platform>/rg`,win 为 `rg.exe`);踩过 npm 丢 execute 位 → 644 → `EACCES` → 技能静默发现失败(#42068) | 打包/下载机制未查到确证(open question) |

**两个诚实的盲点**:CC 在 Windows 上具体怎么杀进程树、Codex 怎么打包 ripgrep——研究未查到确证,属 open question 而非结论。

---

## 二、确认问题清单(34 条,去重后)

严重度定义:**blocker** = 功能在 Windows 上直接死;**degraded** = 能跑但丢安全/质量;**minor** = 边角/静默无效。

### 🔴 Blocker

| # | 问题 | 文件:行 | 为什么 |
|---|---|---|---|
| 1 | Bash 工具默认 `/bin/bash` | `core/src/tool-system/builtin/bash.ts:75` | Windows 无 `/bin/bash`、`SHELL` 通常未设 → spawn ENOENT,Bash 工具整个用不了 |
| 2 | 后台 shell 默认 `/bin/bash` | `core/src/runtime/background-shell.ts:170` | `Bash(run_in_background)` 启动即失败 |
| 3 | safe-spawn 默认 `/bin/bash` | `core/src/runtime/safe-spawn.ts:145` | 兜底 shell 写死 Unix |
| 4 | 进程组 kill 用负 PID | `core/src/runtime/spawn-common.ts:159,174,196` | `process.kill(-pgid)` Unix-only → 后台 shell 无法终止,子进程(vite/dev server)泄漏、端口占用 |
| 5 | worktree setup 默认 `/bin/bash` | `core/src/git/worktree.ts:154` | `selectPlatformScript` 已处理 win32,但 shell 选择没跟上 |
| 6 | 自动更新器 spawn `sh -c` | `core/src/updater.ts:351` | 写死 `sh`,命令含 `rm -f`;Windows 自更新静默失败(错误被吞) |
| 7 | MCP 图片落盘兜底 `/tmp` | `core/src/tool-system/mcp-manager.ts:64` | `HOME` 未设时 fallback `/tmp`,Windows 无此目录 → MCP 出图工具崩 |
| 8 | cloudflared 只下 macOS 二进制 | `desktop/src/main/mobile-remote/cloudflared-binary.ts:24-30` | 只产 `darwin-arm64/amd64` URL,无 `windows-amd64.exe` |
| 9 | cloudflared 解压用 `tar` | `desktop/src/main/mobile-remote/cloudflared-binary.ts:183-193` | `spawn("tar")`,老 Windows 无 tar;且解压的还是 mac 二进制。公网隧道完全死 |
| 10 | core build 用 `mkdir -p`/`cp *.md` | `core/package.json:25` | Unix 命令 + shell globbing,Windows cmd 跑不了,源码构建失败 |
| 11 | tui build 用 `cp -r` | `tui/package.json:21` | 同上,且 templates 不拷进 dist → `/init` 运行时读不到模板 |

### 🟡 Degraded

| # | 问题 | 文件:行 | 为什么 |
|---|---|---|---|
| 12 | 无 Windows 沙箱后端,静默降级 `off` | `core/src/tool-system/sandbox/index.ts:68-76` | 只有 seatbelt(mac)/bwrap(linux);Windows 下 shell 命令零隔离,警告还能被 `CODE_SHELL_SANDBOX_QUIET=1` 关掉 |
| 13 | PTY 先读 `SHELL` 再判平台 | `desktop/src/main/pty-service.ts:44-52` | Git Bash/WSL 把 `SHELL` 设成 `/bin/bash`,被直接返回喂给 node-pty → 终端面板 spawn 失败。**应先判平台再读 SHELL** |
| 14 | SIGTERM/SIGKILL 信号名 | `core/src/runtime/spawn-common.ts:159,174` | Windows 不认这俩信号名,优雅终止失效,可能留孤儿进程 |
| 15 | clean 脚本 `rm -rf dist` | `core/package.json:26`, `tui/package.json:22` | `npm run clean` 在原生 Windows 失败 |
| 16 | lint 脚本直调 `bash xxx.sh` | `package.json:27` | `lint:engine-bypass` 在无 Git Bash 的 Windows 本地跑不了(CI 在 ubuntu 不受影响) |

### 🟢 Minor

| # | 问题 | 文件:行 |
|---|---|---|
| 17 | cloudflared `chmod 0o755` / `mode & 0o100`(Unix 权限位,NTFS 无意义) | `desktop/src/main/mobile-remote/cloudflared-binary.ts:76,101` |
| 18 | 历史文件 `mode: 0o600` 在 Windows 被静默忽略 → owner-only 保护失效 | `tui/src/ui/input-history.ts:173` |
| 19 | resident-agent 给 PATH 写死 `/opt/homebrew/bin` 等 Unix 路径(应 `darwin` 守卫) | `desktop/src/main/mobile-remote/resident-agent.ts:82` |

---

## 三、修复路线(对照 CC/Codex 后的建议)

按优先级 / 投入排序:

1. **shell 选择统一(必修,有现成抄法)** — 解 #1/#2/#3/#5/#6/#13
   抄 CC:抽一个 `resolveShell()` helper,逻辑 = 探测 Git Bash(若存在则 POSIX 脚本走它),否则 win32 回退 `cmd.exe` / PowerShell。复用 `utils/env.ts:15` 已有的 `win32?cmd.exe:/bin/bash` 模式,全仓库替换写死的 `/bin/bash`。`pty-service.ts` 改成先判平台再读 `SHELL`。

2. **进程树终止(必修,当难点)** — 解 #4/#14
   win32 分支走 `taskkill /T /F /PID`(或 job objects / `node-tree-kill`),不用 `process.kill(-pgid)`。**连 Codex 都反复翻车**(孤儿进程 bug),这块要专门写测试,别指望一次写对。

3. **沙箱:改静默为显式** — 解 #12
   学 CC:**不做原生 Windows 沙箱**,但在文档 + 启动时**明确告知**"Windows 无 OS 级隔离,建议 WSL2",而不是闷着降级 + `QUIET` 关警告。Codex 那套 ACL 沙箱(受限令牌)是 Rust crate 级重投入,不在当前范围。

4. **二进制按平台打包** — 解 #8/#9/#17
   抄 CC 的 per-platform 资产:cloudflared 按 `process.platform` 选 `windows-amd64.exe`(官方有 Windows 构建,且是裸 .exe,win 上跳过 `tar`)。chmod 加 `process.platform !== 'win32'` 守卫(NTFS 忽略 POSIX exec 位)。
   **CC 的血泪教训**:npm 打包可能丢 execute 位 → 644 → `EACCES` → 静默失败。bundle 原生二进制时务必验证可执行位。

5. **构建脚本卫生(顺手做)** — 解 #10/#11/#15
   `cp -r` / `mkdir -p` / `rm -rf` 换成 Node `fs.cpSync` / `fs.mkdirSync({recursive})` / `fs.rmSync`(参考已有的 `scripts/build-meta.ts`)。与 CC/Codex 无关,纯跨平台卫生。

---

## 附:被驳回的假阳性(避免重复排查)

38 条假阳性多属这几类,**不是 bug**:
- **沙箱 Unix 路径**(`~/.ssh`、`/tmp`、bwrap/seatbelt 探测路径):被 `process.platform === "darwin"/"linux"` 守卫挡住,Windows 走 `off` 后端,这些路径根本不求值。
- **PTY `/bin/zsh`/`/bin/bash` 兜底**(`pty-service.ts:51`):被 line 48 的 win32 早返回守住,只在非 Windows 可达。(注意:#13 是另一个真问题——先读 SHELL 的顺序 bug,不是这条。)
- **`execFile('git'/'code')` 无 .exe**:Node `execFile` 在 Windows 自动按 PATHEXT 解析 .exe/.cmd。
- **`userHome()` 缺 USERPROFILE 兜底**:`os.homedir()` 内部已读 USERPROFILE,跨平台正确。
- **bin shebang `#!/usr/bin/env node`**:npm 安装时自动生成 .cmd shim。
- **开发者手动脚本**(`logs.sh`、`migrate-stub-gen.sh`):不进 npm 包、不进 CI,仅本地手动跑,不需要 Windows 兼容。

---

## Open Questions(尚未确证)

- CC 在原生 Windows 上具体怎么杀进程树(`taskkill /T` vs Win32 job objects)?
- Codex 0.72.0 之后(PR #22729/#19880/#23943)进程树终止是否真修好、用什么机制?
- Codex 怎么跨平台 bundle/下载 ripgrep,是否踩过同样的 execute-bit 坑?
- 是否要正经支持原生 Windows,还是明确只支持 WSL?**这是上游决策,决定上面哪些必修、哪些只写文档。**(用户尚未拍板。)
