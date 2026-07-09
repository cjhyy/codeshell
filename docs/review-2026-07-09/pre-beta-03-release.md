# Pre-beta 全 repo 体检 · 03 发版链路

> 范围：scripts/release.ts、release.yml、5 个 package.json 发布字段、bun.lock、.gitignore、electron-builder、release-checklist。codex 独立只读会话，主编排代为落盘。基线 HEAD `ccef4283`。

## 结论：HOLD

Blocker 2 · Major 4。

## semver 版本号建议（卡密sama 决策项）
**不要发 `0.6.0-beta.1`**——它 semver 低于当前 `0.6.0-rc.17`，会造成版本线倒退。建议：
- 发 beta 用 **`0.6.1-beta.1`**（> rc.17）；
- 或若 0.6.0 线已可给公众，直接发 **`0.6.0`** 正式版。

## Blocker

### B1 0.6.0-beta.1 低于 0.6.0-rc.17，npm/updater 版本线倒退（确证）
- 证据：5 package + `core/src/index.ts:7` 均 `0.6.0-rc.17`；semver 推演 `0.6.0-beta.1 < 0.6.0-rc.17`。electron-updater 只在 `latest>current` 或 `allowDowngrade && latest<current` 才更新（`electron-updater/AppUpdater.js:357-362`）；`updater.ts:176` 只设 `allowPrerelease`，未设 `allowDowngrade`。
- 影响：已装 rc.17 的用户不会自动更新到 beta.1；npm range/updater 比较视 beta 为降级。
- 建议：改用 `0.6.1-beta.1` 或 `0.6.0`。阻塞 beta：是。

### B2 release.ts 显式版本参数路径坏了（确证）
- 证据：`release.ts:104-116`，`bumpIdx===-1` 时 `i !== bumpIdx+1` 等价 `i !== 0`，第一个裸版本参数被过滤 → `["0.6.0-beta.1"] => []` → 报 "give a version"。
- 影响：文档里的 `bun run scripts/release.ts 0.6.1-beta.1` 显式发版路径不可用。
- 建议：修正 positional 过滤，只在存在 `--bump` 时排除其值。阻塞 beta：是（阻塞推荐的显式发版）。

## Major
- **M1** workflow `verify-version` 只校验 5 package.json，不校验 core VERSION 和 bun.lock（`release.yml:45-59`）；release 不跑 version.test。建议 verify-version 断言 core VERSION==tag、bun.lock 无旧版本。
- **M2** GitHub Release 可在 npm publish 失败时照发，半发布（`release.yml:61-65` npm-publish 独立 job，`:257-263` release 只 needs package）。建议 release 依赖 [package, npm-publish]，或 checklist 明确接受半发布。
- **M3** mac ad-hoc 签名失败被吞（`after-pack-adhoc-sign.cjs:45-68` catch 只 warn），CI 可能上传坏 mac artifact。建议 CI 下签名失败直接 fail。
- **M4** checklist 仍把 `0.6.0-beta.1` 作待执行示例（`release-checklist-beta.md:92-95`、`:59`）。建议改 `0.6.1-beta.1` 或 `0.6.0`。

## Minor/Nit
- tui 缺 `engines.node`（root/core/cdp 都有 >=20.10）。
- `docs/architecture/00-overview.md:14` 仍提 rc.12。
- `release.yml:3-7` 注释只写 rc 示例，未同步 beta 支持。

## 已确认 OK
- beta/rc 正则支持（`release.ts:55`，拒 alpha/无编号 beta）✓
- release.ts rewrite 输入干净：5 package 各 1 处、bun.lock 4 处 rc.17、无 rc.12 ✓
- GitHub prerelease 判定正确（`release.yml:285-287` 带 `-` → --prerelease）✓
- npm dist-tag 正确（`:105-113` 带 `-` → next，不写 latest）✓
- npm 发布顺序 core→tui→meta，cdp/desktop private 不发 ✓
- Windows NSIS artifactName 无空格（`package.json:33/100`）✓
- 三平台目标齐全（mac dmg+zip / win nsis / linux AppImage）✓
- gh release 幂等（create-if-absent + upload --clobber）✓

## 验证
- typecheck 通过；version.test 1 pass。
- node 推演：裸版本参数被过滤为空（B2）；`0.6.0-beta.1 < 0.6.0-rc.17`、`0.6.1-beta.1 > 0.6.0-rc.17`。
- npm registry 查询因无网络未确证线上 dist-tags。
