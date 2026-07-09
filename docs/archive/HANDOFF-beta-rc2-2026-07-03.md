# beta rc.2 反馈修复 — 交接 (2026-07-03)

分支:`worktree-beta-rc2-fixes`(worktree,fork 自 `1208cee4`)
5 个 commit:`014ce6fc` `6e3cc83f` `facb857b` `cdd09aac` `8ce50521`

## 已修 + 测试(typecheck 0 错 / CI gate 173 pass / 各专项全绿)

1. **macOS 包"损坏"** — afterPack ad-hoc 深签名(`after-pack-adhoc-sign.cjs`),seal
   resources → Gatekeeper 从 "damaged" 降为普通"未验证开发者"(右键可开)。本地已验。
2. **Windows Bash 卡死** — `off.ts` wrap 改走 resolveShellInvocation(平台正确 flag)。
   **真实 Windows 日志已证实**(见 docs/evidence/):cmd 收 -c 掉交互模式 10-15s 超时,
   修后 84ms。且更完整:加了 Git Bash 探测(defaultShellBinary win 优先 Git Bash)。
3. **权限弹窗归属错 session** — App.tsx approvalForActiveBucket 按来源 session 归桶。
4. **切会话闪新建态** — hydratingExistingSession 区分已存在未 hydrate vs 真新建。
5. **面板按钮非 chat 页残留** — panelAvailable 加 `&& view.viewMode==="chat"`。
6. **nsis 安装器** — 加 nsis 段(oneClick:false + 可选目录)。⚠️ 待 Win 验。
7. **语音 catalog** — 编辑器补 audio 选项 + 凭证跨 provider 复用(adapterKind)+ STT
   回退渲染成连接卡。带单测。
8. **git 回显 + Git Bash 探测** — checkGit 返回 path 自动回填;resolveGitBash。
   ⚠️ core 逻辑单测过,真实行为待 Win 验。
9. **项目边界(最小版)** — resolveProjectRoot:添加项目时 git 子目录归仓库根。带单测。
10. **窗口控件/标题栏** — 红绿灯占位按 platform+fullscreen 动态收起。⚠️ 待 Win+全屏验。
11. **Windows 菜单栏** — autoHideMenuBar(非 mac)。⚠️ 待 Win 验。
12. **浏览器面板跨 session 串** — webview 按 bucket 分 partition(persist:browser:<bucket>)。
    ⚠️ 待真机验 webview 隔离。

## ⚠️ 合入注意
- **`git merge-tree` 干跑显示与当前 main 有冲突** —— main 有 10 个未 push 的 commit,
  改了同名文件(App.tsx/index.ts 等)。**没自动合**(怕盲合出错)。需你手动 merge/rebase
  解冲突(你了解那 10 个 commit 的内容)。
- 合完 → bump rc.3 → push + tag → CI 出三端包 + npm。版本号/dist-tag 你定。

## 未做(需真机/需设计,已记 TODO)
- #1 项目边界完整版(其他映射点 + 存量迁移)
- 语音回退"可提升为正式连接"(UX 待定)
- 一堆 Windows/mac 真机验证项(上面标 ⚠️ 的)
