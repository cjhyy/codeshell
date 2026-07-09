# Pre-beta Final · 03 发版就绪（46 未 push commit，目标 rc.18）

> codex 独立只读，主编排代为落盘。范围：origin/main..HEAD 全部改动。

## 结论：HOLD（作为公开 desktop 安装包发布）

Blocker 1 · Major 3 · Minor/Nit 若干。若 rc.18 仅 npm/自测、不公开分发 desktop 安装包，B1 不阻塞。

## Blocker
### B1 desktop 安装包不携带第三方 notice（公开分发时阻塞）
- 证据：`packages/desktop/scripts/predist.ts:88-95` 只物化 core 的 dist+package.json，不复制 `packages/core/THIRD_PARTY_NOTICES.md`；`packages/desktop/package.json:43-65` files/extraResources 无 notice；`packages/cdp/src/keymap.ts:1-5` 来自 browser-use，cdp 被 desktop bundle 用。`rg THIRD_PARTY_NOTICES packages/desktop` 无命中。
- 影响：GitHub Release 桌面 artifact 分发 ApplyPatch/browser-use 派生代码但无 license/notice。npm core/tui 的 notice 配置是好的。
- 建议：加 `packages/desktop/THIRD_PARTY_NOTICES.md` 入 extraResources，或 predist 复制 core/cdp notices 到 app resources；CI 验证存在。
- 阻塞 rc：**是，除非 rc.18 不公开发布 desktop artifacts**（纯 npm/自测则否）。

## Major
- **M1** workflow verify-version 只查 5 package.json，不查 core VERSION / bun.lock（`release.yml:45-59`）。建议加断言。不阻塞（前提用 release helper）。
- **M2** npm-publish 与 GitHub Release 可半发布（job 依赖不足，`release.yml:61-65/257-263`）。建议 release 依赖 [package, npm-publish]。不阻塞但发版后须核对两边一致。
- **M3** mac ad-hoc 签名失败只 warn 不 fail CI（`after-pack-adhoc-sign.cjs:45-68`）。建议 CI 下失败即 exit non-zero。不阻塞但 mac 自测风险高。

## rc.18 发版动作清单
1. （若公开桌面包）先修 B1 notice。
2. 清理 dirty tree（TODO.md 未提交，release.ts:127 拒 dirty）。
3. 干净 main 跑 `bun run scripts/release.ts --bump rc` → 0.6.0-rc.18。
4. review release commit：只改 5 package.json + core VERSION + bun.lock。
5. 可写环境重跑 bun test/typecheck×2/lint/pack dry-run。
6. `git push origin main` → `git tag -a v0.6.0-rc.18` → `git push origin v0.6.0-rc.18`。
7. tag 含 `-` → GitHub prerelease + npm next，不顶 latest。
8. CI 后验：latest*.yml 存在且 version=0.6.0-rc.18；npm next 指 rc.18；mac 签名人工核验。

## 已确认 OK
- 版本现状一致 rc.17（5 package + index.ts:7 + bun.lock）。
- computeBump("0.6.0-rc.17","rc")→"0.6.0-rc.18"，正则接受；静态 rewrite 后无 rc.17 残留。
- dist-tag/prerelease 判定正确（release.yml:285-287 / 105-113）。
- 三平台产物齐全；Windows artifactName 无空格。
- root+desktop typecheck 通过；lint 0 errors；lint:engine-bypass 通过；release-workflow.test + version.test 4 pass。
- 全量 bun test 沙箱不可判定（mkdtemp EPERM，非代码失败）。
- 改动 markdown 相对链接缺失 0。

## Minor/Nit
- dirty worktree（TODO.md）须先处理。
- release-checklist-beta.md:92-95 仍以 0.6.0-beta.1 为例（会 semver 倒退，误导后续）；:48 写 core files=["dist"] 已过期（实含 THIRD_PARTY_NOTICES.md）。
