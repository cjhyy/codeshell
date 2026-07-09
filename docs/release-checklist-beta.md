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
- [ ] `bun.lock` 仍包含 workspace 版本 `0.6.0-rc.12`（cdp/core/desktop/tui）。
  beta 版本提交前需要同步或重新生成 lockfile，否则 `bun install --frozen-lockfile`
  在 CI 中可能暴露版本不一致。

## Release Workflow

- [x] `.github/workflows/release.yml` 是 tag 驱动：push `v*` tag 触发发布。
- [x] `verify-version` 会校验五个 package 的版本必须等于 tag 去掉前缀 `v`
  后的版本号；这覆盖 root、core、tui、cdp、desktop。
- [x] GitHub Release 的 prerelease 判定是 `case "$TAG" in *-*)`；因此
  `v0.6.0-beta.1` 这类带连字符的 tag 会创建 GitHub prerelease。
- [x] npm dist-tag 判定是 `if [[ "${{ github.ref_name }}" == *-* ]]`；因此
  beta tag 会用 `next`，普通 `vX.Y.Z` 才会用 `latest`。
- [x] npm 发布顺序是 core -> tui -> meta；`packages/cdp` 和
  `packages/desktop` 当前为 `private: true`，不会发布到 npm，但仍参与版本校验。
- [ ] `scripts/release.ts` 当前只接受 `X.Y.Z` 或 `X.Y.Z-rc.N`，不接受
  `X.Y.Z-beta.N`；它也不会同步 `packages/core/src/index.ts` 的 `VERSION`。
  发 beta 前需决定：扩展 release helper，或按下方手动动作同步。

## Ignored Build Artifacts

- [x] `.gitignore` 已覆盖常见构建/缓存产物：`dist/`、`out/`、`.turbo/`、
  `.vite/`、`*.tsbuildinfo`、logs、coverage、`.code-shell/` 等。
- [x] `packages/desktop/.preview/` 已忽略。
- [x] `packages/desktop/src/renderer/logs/` 有显式反忽略，避免误伤源码目录。

## Package Metadata

| Package | Publish state | Current status |
| --- | --- | --- |
| `@cjhyy/code-shell` | public npm meta package | OK: MIT, description, repository, homepage, bugs, `engines.node >=20.10`, `files`, `bin`, `publishConfig.access=public` all present. |
| `@cjhyy/code-shell-core` | public npm package | OK: MIT, description, repository with `directory`, homepage, bugs, `engines.node >=20.10`, `files=["dist"]`, `publishConfig.access=public` present. |
| `@cjhyy/code-shell-tui` | public npm package | Needs metadata polish: MIT, description, `files`, `bin`, and `publishConfig` are present, but `repository` and `homepage` are missing. Suggested repository: `{"type":"git","url":"git+https://github.com/cjhyy/codeshell.git","directory":"packages/tui"}`. Suggested homepage: `https://github.com/cjhyy/codeshell/tree/main/packages/tui#readme`. |
| `@cjhyy/code-shell-cdp` | private workspace package | OK for current private state: MIT, description, repository with `directory`, `engines.node >=20.10`, and `files` present. Homepage is missing; add `https://github.com/cjhyy/codeshell/tree/main/packages/cdp#readme` if this package becomes public. |
| `@cjhyy/code-shell-desktop` | private Electron package | Needs public-facing polish before beta installers: MIT and description are present, but description still says `(POC)`, and `repository`/`homepage` are missing. Suggested repository: `{"type":"git","url":"git+https://github.com/cjhyy/codeshell.git","directory":"packages/desktop"}`. Suggested homepage can be the root README (`https://github.com/cjhyy/codeshell#readme`) unless a desktop-specific README is added. No npm `files` field is required while private; electron-builder uses `build.files`. |

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

Do not run these until the target beta version is chosen.

1. Pick the beta version, for example `0.6.0-beta.1`.
2. Update all five package versions to that exact beta version:
   `package.json`, `packages/core/package.json`, `packages/tui/package.json`,
   `packages/cdp/package.json`, and `packages/desktop/package.json`.
3. Update `packages/core/src/index.ts` `VERSION` to the same beta version.
4. Sync `bun.lock` so workspace versions match the beta version.
5. Run the release preflight checks:
   `bun run typecheck`, `bun test`, and any desktop build/package smoke test
   卡密sama wants before public beta.
6. Commit the version bump and release-prep docs.
7. Create an annotated tag `v<beta-version>`.
8. Push `main` and the tag; the tag should trigger GitHub prerelease assets and
   npm `next` publishing.
9. After CI finishes, verify GitHub Release is marked prerelease and npm shows
   the beta under the `next` dist-tag.

## Needs 卡密sama Decision

- Whether to update `scripts/release.ts` for beta tags and `VERSION` syncing, or
  do the beta bump manually.
- Whether `packages/desktop/package.json` should drop `(POC)` from its
  description before beta.
- Whether to add repository/homepage metadata to `packages/tui` and
  `packages/desktop` before the public beta commit.
- Whether `packages/cdp` should remain private for beta; if not, it needs final
  public package metadata and npm publish workflow updates.
