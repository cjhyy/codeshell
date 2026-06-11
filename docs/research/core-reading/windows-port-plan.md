# Windows 版落地计划(档 3:完整 Windows,含 desktop)

> 起于 2026-06-11。目标:原生 Windows 10/11 跑通 TUI/CLI + desktop 全功能,可接受降级但基础能力必须有。
> sandbox 决策:**fail-open 降级 + 启动警告**(与 Claude Code 一致,CC 沙箱也明说不支持 Windows)。
> 依据:本目录 1.0 review 之外的 Windows 兼容三维核查(spawn/shell、path/fs/CRLF、sandbox/平台依赖)+ 记忆 [[project_windows_compat_audit]] / [[reference_cc_codex_windows]]。

## 原则
- 每个阶段独立可验证、可 commit;按依赖与风险从低到高排。
- core 的缺口在 TUI 和 desktop 都会触发 → 优先修 core,宿主再跟。
- 不引第三方重依赖能不引则不引(kill 优先用系统 taskkill,不上 tree-kill 库,除非必要)。
- 改 core 公共类型后必 rebuild core,否则 tui/desktop 经 dist 取旧类型 typecheck 报错。
- 学 CC:原生支持 + 沙箱显式跳过(不引导 WSL 作为「唯一」路径,但文档给 WSL 作为可选增强)。

## 阶段(对应 TaskList P1–P8)

### P1 统一 shell 选择 ★先做(其它依赖它)
抽一个 `resolveShellInvocation(command, opts)` helper(放 runtime/spawn-common 或 utils/env):
- win32:`cmd.exe /c <command>`(默认)或 `pwsh -Command`(若检测到/配置);
- 非 win:`<SHELL ?? /bin/bash> -c <command>`。
替换 5 处硬编码:`safe-spawn.ts:145`、`safe-spawn.ts`(注释默认值)、`bash.ts:75`、`background-shell.ts:170`、`git/worktree.ts:154`。`process.env.SHELL` 回退在 win 不能落到 `/bin/bash`。
验证:helper 单测(win/posix 分支各断言 file+args 形状)。

### P2 进程 kill 加 win32 分支 ★依赖 P1
`spawn-common.ts` 的 `killProcessGroup`/`groupAlive`(负 PID `process.kill(-pgid)`)只在 POSIX 用;win32:
- 杀树:`taskkill /PID <pid> /T /F`(spawn,不依赖信号);
- `groupAlive` 在 win 用 `tasklist`/`process.kill(pid,0)` 探活;
- `safe-spawn.ts` 的 SIGTERM→grace→SIGKILL 级联,win 直接 `child.kill()`(TerminateProcess);
- `detached:true` 在 win 显式给 `stdio` 避免继承 stdin。
也覆盖 `pluginCommandHook.ts`、`hooks/shell-runner.ts` 的 SIGTERM/SIGKILL。
验证:`spawn-common.test.ts` 现假设负 PID==pgid,需加 win 分支用例(或 platform-gate)。

### P3 路径 path.join + 大小写归一
- `path-policy.ts:168/215-216` 的 `${cwd}/.code-shell/...` 字符串拼接 → `path.join`;
- `isInsideDir`/`matchSensitiveDir`/路径前缀比对:win32 `toLowerCase` 归一(盘符+大小写不敏感);
- `matchSensitiveDir` 返回 `"~/"+rel` → 用 `sep`;
- `settings/manager.ts` `userHome()` 在 win 优先 `USERPROFILE`(再 homedir 兜底)。
验证:path-policy 加 win 路径用例(`C:\Users\...` 前缀/敏感/大小写)——bun 在 mac 跑需 mock platform 或纯函数化比对。

### P4 Edit/ApplyPatch/diff 兼容 CRLF ★用户最痛
`edit.ts`、`apply-patch/applier.ts`、`apply-patch/parser.ts`、`session/simple-diff.ts`、`notebook-edit.ts`、`read.ts`:
- 读入后检测原 EOL(含 `\r\n` 即 CRLF);
- 匹配/比对前把 needle 与 haystack 都归一为 LF;
- 写回时按原 EOL 恢复(不把 CRLF 文件偷偷转 LF,否则 git diff 全文件变动);
- Read 显示去 `\r`(或保留但不当作内容)。
验证:edit/apply-patch 加 CRLF fixture 用例(old_string 用 LF、文件用 CRLF 应能匹配且写回仍 CRLF)。

### P5 sandbox win32 fail-open + 警告
`sandbox/index.ts` win 已降级 off(确认);加启动一次性警告(无沙箱直通);`defaultSandboxConfig` 的 `/tmp`/`/private/tmp`/`/var/tmp` 在 win 用 `os.tmpdir()`。验证:win 下 resolveSandboxBackend(auto)==off 且不抛。

### P6 外部命令 PATHEXT(git/gh 等)
把 `lsp/manager.ts:151-157` 的 `candidateCommandNames`(PATHEXT)抽共享;`gitOps.ts:46`、`safe-spawn.ts:61`、`git/worktree.ts` 的 `git` spawn 复用,使 `git.exe`/`git.cmd` 在 win 找得到;`nonInteractiveGitEnv` 在 win 检查 ssh。验证:win 下 git 命令能跑(真机)。

### P7 desktop Windows 适配
- `pty-service.ts`:win 用 `powershell.exe`/`cmd.exe` + ConPTY,login flag `-il` 不适用 win;
- `rebuild-native.ts`:win 需 MSVC build tools,node-pty 1.1 ConPTY;electron-builder win=nsis 已配;
- `worktree.ts:272` `symlinkSync`:win EPERM 时回退 junction(`fs.symlink(...,'junction')`)或复制 node_modules;
- `cloudflared-binary.ts`:加 `windows-amd64` 下载 URL,解压用 node(不依赖 `tar` 二进制);`chmod 0o755` 在 win no-op 可接受。
验证:真机起 desktop,终端面板/worktree 会话/手机遥控 tunnel。

### P8 Windows 真机集成测试 + CI(依赖 P1–P7)
Win10/11 真机冒烟:Bash/Edit/ApplyPatch/后台 shell+kill/worktree/终端面板/手机遥控/git 插件安装。补 win spawn 测试。考虑 GitHub Actions `windows-latest` 跑 core 测试。

## 风险/坑
- bun test 跑在 mac,win 专属分支大多只能纯函数单测 + 真机手测覆盖;别假装 mac 上测过 win 路径。
- 改 CRLF 处理要小心「写回保留原 EOL」,否则触发项目 prettier/.editorconfig 把文件全量改写。
- node-pty/symlink/cloudflared 是 desktop 真机才暴露的问题,P7 务必真机验。
- core 公共类型改动后 rebuild core(见本会话 #9 sandboxMode 的坑)。

## 当前进度(2026-06-11)

P1–P7 全部实现并 commit 到 main(每步 TDD + 全 core 0 fail + typecheck/lint 干净):
- P1 统一 shell 选择 — 0da4d22
- P2 进程 kill win32(taskkill /T /F)— 506a231
- P3 path.join + win32 大小写归一 — b957369
- P4 Edit/ApplyPatch/diff/Read 兼容 CRLF — f4c7a4c
- P5 sandbox win32 fail-open + OS 临时目录 — 8851f0c
- P6 外部命令 PATH×PATHEXT(git/gh)— 8af85fa
- P7 desktop(pty COMSPEC / worktree junction / cloudflared win)— fe2eced

P8(真机)= **进行中,需用户在 Windows 机器执行**(mac 无法跑)。已做的 mac 侧:
- 所有 win32 分支都有 redefine-platform 的单测(shell-invocation/kill-win32/
  path-policy-win32/crlf/sandbox-win32/exec)——但 mac 上 realpath/FS 行为不同,
  不能完全替代真机。
- CI 加 `tests-windows`(windows-latest)job,在真 Windows 跑上述 win32 单测,
  让分支真的执行一遍(.github/workflows/ci.yml)。

### Windows 真机冒烟清单(请在 Win10/11 跑)
前置:Node ≥20.10;git(PATH 上);desktop 终端需 MSVC build tools(node-pty 重编)。
TUI/CLI:
1. `code-shell` 起 REPL,发一句话能回复(管线通)。
2. Bash 工具:`echo hi`、`dir`、带管道/重定向的命令能跑(cmd.exe /c)。
3. 后台 shell:`run_in_background` 起一个长任务 → ListShells 看到 → KillShell
   能真杀掉(taskkill /T,无孤儿;任务管理器确认)。
4. Edit:改一个 CRLF 文件(用记事本存的),old_string 用普通文本能匹配,
   保存后文件仍是 CRLF(git diff 不显示全文件变动)。
5. ApplyPatch:对 CRLF 文件打补丁,同上验证。
6. Read:读 CRLF 文件,显示无 ^M。
7. 路径:在 `C:\Users\...` 下的工作区,读写文件不误报「工作区外」;
   写 `~/.ssh` 下文件被拒(敏感路径,大小写变体也拒)。
8. git 插件:装一个远程插件(走 git clone)能成功;若 git 是 .cmd 蒙皮也能找到。
9. cron:建一个 cron 任务能触发、能 abort 取消在飞 run。
Desktop:
10. 终端面板:能开 powershell/cmd,输入输出正常(node-pty/ConPTY)。
11. worktree 会话:能创建隔离 worktree(junction 共享 node_modules 或回退复制)。
12. 手机遥控 tunnel:cloudflared 能下载(windows-amd64.exe)、隧道能起。

### 已知降级/未做(可接受或后续)
- sandbox 在 win 为 off(无隔离)——用户已确认 fail-open + 警告。
- arena/* 的 git 调用未走 resolveExecutable(分析功能,非基础能力)。
- node-pty 需用户装 MSVC build tools(@electron/rebuild 跨平台,属前置条件)。
