# CodeShell Beta Release Checklist

核实日期：2026-07-09。

本清单只记录 beta 发布前的状态与待确认项；不要在未确认目标版本前改版本号。

## Current State

- [x] 五个 package 的 `version` 当前一致：`0.6.0-rc.17`。
  - `package.json`
  - `packages/core/package.json`
  - `packages/tui/package.json`
  - `packages/cdp/package.json`
  - `packages/desktop/package.json`
- [x] `packages/core/src/index.ts` 的 `VERSION` 当前为 `0.6.0-rc.17`，与
  `packages/core/package.json` 一致。
- [x] 已有版本断言测试：
  `packages/core/src/version.test.ts` 校验 `VERSION === package.json.version`。
- [x] `bun.lock` 已通过 `bun install --lockfile-only` 同步 workspace 版本到
  `0.6.0-rc.17`，确认不再包含 `0.6.0-rc.12`。

## Release Workflow

- [x] `.github/workflows/release.yml` 是 tag 驱动：push `v*` tag 触发发布。
- [x] `verify-version` 会校验五个 package 的版本必须等于 tag 去掉前缀 `v`
  后的版本号；这覆盖 root、core、tui、cdp、desktop。
- [x] GitHub Release 的 prerelease 判定是 `case "$TAG" in *-*)`；因此
  `v0.7.0-beta.1` 这类带连字符的 tag 会创建 GitHub prerelease。
- [x] npm dist-tag 判定是 `if [[ "${{ github.ref_name }}" == *-* ]]`；因此
  beta tag 会用 `next`，普通 `vX.Y.Z` 才会用 `latest`。
- [x] npm 发布顺序是 core -> tui -> meta；`packages/cdp` 和
  `packages/desktop` 当前为 `private: true`，不会发布到 npm，但仍参与版本校验。
- [x] `scripts/release.ts` 已接受 `X.Y.Z-beta.N`，`--bump beta` 可用，并会同步
  `packages/core/src/index.ts` 的 `VERSION`。

## Ignored Build Artifacts

- [x] `.gitignore` 已覆盖常见构建/缓存产物：`dist/`、`out/`、`.turbo/`、
  `.vite/`、`*.tsbuildinfo`、logs、coverage、`.code-shell/` 等。
- [x] `packages/desktop/.preview/` 已忽略。
- [x] `packages/desktop/src/renderer/logs/` 有显式反忽略，避免误伤源码目录。

## Package Metadata

| Package | Publish state | Current status |
| --- | --- | --- |
| `@cjhyy/code-shell` | public npm meta package | OK: MIT, description, repository, homepage, bugs, `engines.node >=20.10`, `files`, `bin`, `publishConfig.access=public` all present. |
| `@cjhyy/code-shell-core` | public npm package | OK: MIT, description, repository with `directory`, homepage, bugs, `engines.node >=20.10`, `files=["dist","THIRD_PARTY_NOTICES.md"]`, `publishConfig.access=public` present. |
| `@cjhyy/code-shell-tui` | public npm package | OK: MIT, description, repository with `directory`, homepage, `files`, `bin`, and `publishConfig.access=public` are present. |
| `@cjhyy/code-shell-cdp` | private workspace package | OK for current private state: MIT, description, repository with `directory`, `engines.node >=20.10`, and `files` present. Homepage is missing; add `https://github.com/cjhyy/codeshell/tree/main/packages/cdp#readme` if this package becomes public. |
| `@cjhyy/code-shell-desktop` | private Electron package | OK for beta installers: MIT, formal description, repository with `directory`, and root homepage are present. No npm `files` field is required while private; electron-builder uses `build.files`. |

## Release-script & metadata fixes

- [x] `scripts/release.ts` now uses one prerelease-aware version regex:
  `X.Y.Z`, `X.Y.Z-rc.N`, or `X.Y.Z-beta.N`.
- [x] `--bump beta` and `--bump rc` share symmetric prerelease logic. Use `--bump rc`
  for same-line rc increments; when moving from the rc line to the public beta line,
  pass an explicit target such as `0.7.0-beta.1` so semver does not move backward.
- [x] Release rewriting now includes `packages/core/src/index.ts` via an exact
  `export const VERSION = "..."` line replacement, and the final consistency
  check asserts core `VERSION === target`.
- [x] `bun.lock` was regenerated with `bun install --lockfile-only`; diff only updates
  workspace versions from `0.6.0-rc.12` to `0.6.0-rc.17`.
- [x] `packages/tui/package.json` and `packages/desktop/package.json` now include
  repository/homepage metadata, and the desktop description no longer says `(POC)`.
- [x] Verification run on 2026-07-09: `bun run typecheck` and
  `bun test packages/core/src/version.test.ts` both passed.

## Docs And Badges

- [x] `README.md` and `README.zh-CN.md` now use the same badge row:
  npm version, MIT license, Node >=20.10, TypeScript, and macOS/Windows/Linux.
- [x] README status copy no longer hardcodes an rc number; it says `0.6.x,
  entering beta` / `0.6.x，进入 beta 阶段`。
- [x] README relative links and image paths were checked; all referenced local
  targets exist after the HANDOFF archive move.
- [x] `CHANGELOG.md` has an `[Unreleased]` section at the top with beta-track
  summaries for unified input attachments, architecture-review fixes, and
  release/documentation hygiene.
- [x] npm package badge target exists: `npm view @cjhyy/code-shell` returns the
  package with MIT license. The badge will show the registry version until beta
  is published.

## Beta Release Actions To Run Later

Do not run these until the target beta version is chosen. For the first public beta
after `0.6.0-rc.18`, the target is `0.7.0-beta.1`.

1. Pick the beta version: `0.7.0-beta.1`. Do not use `0.6.0-beta.1`; it sorts lower
   than `0.6.0-rc.18`.
2. Run the release helper with the explicit target:
   `bun run scripts/release.ts 0.7.0-beta.1`. Use `--bump rc` for same-line rc
   increments; use explicit `X.Y.0-beta.N` when crossing to a new beta line. The
   helper updates all five package versions, `packages/core/src/index.ts` `VERSION`,
   and `bun.lock`, then commits locally without pushing unless `--push` is passed.
3. Review the local release commit before pushing.
4. If anything was adjusted manually, sync `bun.lock` so workspace versions match the
   beta version.
5. Run the release preflight checks:
   `bun run typecheck`, `bun test`, and any desktop build/package smoke test
   卡密sama wants before public beta.
6. Ensure the version bump and release-prep docs are committed.
7. Create an annotated tag `v<beta-version>`.
8. Push `main` and the tag; the tag should trigger GitHub prerelease assets and
   npm `next` publishing.
9. After CI finishes, verify GitHub Release is marked prerelease and npm shows
   the beta under the `next` dist-tag.

## Needs 卡密sama Decision

- Whether `packages/cdp` should remain private for beta; if not, it needs final
  public package metadata and npm publish workflow updates.
