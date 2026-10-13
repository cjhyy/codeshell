# Desktop Agent Plugins lifecycle — round 7

Reviewed snapshot: `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`, `a66f4ef291f304ee4df9da8095a90671d9a8f140` (0.9.33). Read CODESHELL.md and main report R01–R50. These findings concern Agent Plugins, not Panel Apps. R28 initial disabled-list loading and R26 Skills write conflicts are excluded. All three root causes already existed at initial baseline `84740d56`; `git diff 84740d56..a66f4ef2` is empty for the implicated installer/service/renderer files. They are discoveries in this round, not regressions introduced by 0.9.33.

Product code was read-only. No build/clean, user plugins/accounts, third-party source downloads, real model requests or executable plugin behavior. Temporary plugins contain inert manifests and a text Skill. Git repositories and their commits are created entirely locally.

## Evidence and boundary

- Script: `/tmp/codeshell-review-20261012-plugins-round7/plugins-lifecycle.test.tsx`.
- Final log: `/tmp/codeshell-review-20261012-plugins-round7/plugins-lifecycle.log`.
- Command, from the reviewed snapshot: `node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-plugins-round7/plugins-lifecycle.test.tsx`.
- Final result: **7 pass, 0 fail, 0 skipped, 61 assertions, 4.13 seconds**. Passing defect tests characterize current broken behavior; they do not indicate a fix.
- Guarded runner supplies isolated HOME; the script checks that marker. Before Core-facing dynamic imports it denies global fetch, http/https request/get, net connect/createConnection, tls connect, and sets Git transport to `file` only. This is an in-process network guard plus local-only Git, not OS-level confinement of arbitrary subprocesses.
- Actual renderer function components run React hooks/effects under the existing mini DOM fixture; tests capture their returned React element tree and invoke the **actual action callbacks**. Actual Main services and built Core installers run against real temporary files/Git, with no installer/update service mocks. Confirmation/alert hooks are mocked and recorded; file chooser is a fixture. Preload and Main IPC forwarding were inspected in source. This is not an Electron screenshot or browser end-to-end test.
- Earlier diagnostic failures were harness issues (unstable fixture configuration object, then an incorrect directory-button label); excluded from the final counts and findings.

## W18 — P2: successful install job blocks reinstall after a successful uninstall

**Trigger:** In one Desktop Main process, install a plugin from a marketplace, then uninstall it from Extensions → Plugins → More → Uninstall, then return to the same marketplace detail page. Scope is a plugin successfully installed through the queued marketplace installer in that Main process; plugins installed in an earlier process without a retained job are not covered.

**Observed:** Uninstall correctly deletes the cache directory and `installed_plugins.json` entry. Reopened MarketDetail still labels the plugin 已安装 and disables its install button. Even calling the real `installPluginForUi` service again returns the old successful job without copying files or rebuilding registration. Thus ordinary reinstall is unavailable for the remainder of that Main service lifetime.

**Production entry and cause:**

- `packages/desktop/src/renderer/extensions/MarketDetail.tsx:104–110` invokes `window.codeshell.installPlugin`; `:164–166` treats an old job with status `installed` as current installation independently of the installed map; `:195–203` disables the button. The `:92–100` effect also copies successful historical jobs into the installed map on a new mount.
- `packages/desktop/src/preload/index.ts:1241–1243` forwards install/retry; `packages/desktop/src/main/index.ts:4771–4775` binds the actual service.
- `packages/desktop/src/main/marketplace-service.ts:379–385` retains jobs in a process-lifetime map keyed only by marketplace/plugin; `:435–439` stores installed; **`:473–481` returns that completed job unconditionally**, without checking installed state or starting another operation.
- Actual uninstall callback `packages/desktop/src/renderer/extensions/PluginsTab.tsx:140–155` is reachable through `:485–489`; Main IPC `packages/desktop/src/main/index.ts:4638–4641` only uninstalls and broadcasts commands. `packages/desktop/src/main/plugins-service.ts:198–208` delegates Core uninstall without invalidating the completed job.
- `packages/core/src/plugins/pluginInstaller.ts:441–473` correctly removes files and registration; this is not an uninstall failure.
- The completed job badge hiding after 12 seconds (`PluginInstallJobsPanel.tsx:16`, `:50–55`) only filters panel display; it does not delete the job or change MarketDetail's installed check.

**Reproduction:** First test invokes actual MarketDetail 安装, waits for its job and disk contents; invokes actual PluginsTab 卸载 with recorded destructive confirmation; checks catalog, disk **and actual registry** absent; remounts MarketDetail and verifies disabled 已安装. It calls Main install again and verifies no recreation. Log:

```json
{"registryPresent":false,"diskPresent":false,"jobStatus":"installed","reinstallButtonDisabled":true}
```

**Normal/recovery control:** A fresh service-module instance with an empty map successfully reinstalls the exact same source and disk path. This models Main-process state reset; it is not a real app-restart test. Failed initial jobs can also retry after correcting the source (separate passing test). The bug is completed-success retention, not all job retries.

**Fix direction/test gap:** Reconcile completed jobs with authoritative installed state and invalidate/reset them on uninstall, or use operation identities instead of letting an old completion permanently represent inventory. Test install → uninstall → reopen market → reinstall in the same Main lifetime. High confidence.

## W19 — P2: failed marketplace path-source update removes the previous working plugin

**Trigger:** An installed marketplace entry uses a relative path source, e.g. `"source":"./payload"`. The marketplace receives a commit whose marketplace index is still valid but whose plugin manifest is invalid. In Extensions → Plugins → More → Update, refreshing that marketplace succeeds, then plugin normalization fails.

**Observed:** The previous installed plugin directory is deleted. The failed new directory is also deleted, while the old `installed_plugins.json` row still points at that missing path. Fresh runtime catalog and refreshed plugin list omit the plugin. The currently mounted PluginsTab keeps the stale row because its failure path does not reload, and repeating update fails `no installed plugin`. The tested inert Skill file from v1 is no longer available on disk. This proves removal of the previous usable runtime files and disappearance from subsequent catalog loads; it does **not** prove every already-running MCP process or cached hook stops immediately.

**Production entry and cause:**

- Actual manual update item: `packages/desktop/src/renderer/extensions/PluginsTab.tsx:482–484`; action `:165–184` calls `window.codeshell.updatePlugin(p.installKey)`, then only alerts on failure. `:180` assumes Core kept the old version.
- `packages/desktop/src/preload/index.ts:1190`, `packages/desktop/src/main/index.ts:4648–4651` forward to actual Main service.
- `packages/desktop/src/main/plugins-service.ts:283–298` resolves installed catalog identity, refreshes marketplace and invokes the real marketplace installer; failed install throws.
- **`packages/core/src/plugins/pluginInstaller.ts:264–271` materializes a path source into the constant `local` cache path and deletes the existing final directory at `:267` before validating the new plugin.** Validation happens later at `:380–388`; failure removes that same final path at `:389–394` without restoring the old tree. Old registry removal/replacement only begins after validation at `:403–405`, so the old row survives pointing at absent files.
- `packages/core/src/plugins/pluginCatalog.ts:117–122` skips a registry row whose path is missing/unsafe. Do not generalize this failure to Git sources using a new SHA cache path or to the atomic direct/local update path.

**Reproduction:** Second test installs v1 using the actual Core marketplace installer (models an existing installation without W18's current-process job), commits malformed plugin JSON into the local marketplace, and invokes the real PluginsTab Update callback. Main refresh and Core install are unmocked. It checks the failure alert, old directory missing, runtime catalog absent, old registry path still present, stale UI row present and second update rejection. Log:

```json
{"oldDiskPresent":false,"runtimeCatalogPresent":false,"registryEntryPresent":true,"failedAlert":true,"unchangedListStillHasRow":true}
```

**Normal/recovery controls:** A valid v2 marketplace update succeeds in a separate test. In the defect test, correcting the source manifest, refreshing the marketplace, and calling the normal install service recreates the plugin and leaves exactly one correct registry row. No manual registry edit is needed if a corrected source is available and installation is reachable. If there is also a retained completed job from this process, W18 is an independent additional obstruction; W19 reproduces without it. Atomic direct/local updates keep their old files and registration on invalid source, also tested.

**Fix direction/test gap:** Stage/project/validate new marketplace content before replacing the old cache path; swap with rollback and preserve registration consistently. Refresh UI after a failed operation that may have mutated state. Test valid old path-source → invalid new plugin manifest → old files/catalog/registration preserved → corrected-source retry. High confidence.

## W20 — P2: Desktop reviewed directory install records a deleted snapshot as its update source

**Trigger:** Extensions → Plugins → From folder → review → Install, using a valid original local plugin directory. Keep that directory present, edit it to v2, then More → Update on the installed plugin.

**Observed:** Installation succeeds, but `.cs-meta.json.source` is the installer's private `/tmp/cs-plugin-reviewed-…/source`, already deleted before installation returns. Update therefore fails `source no longer exists`, despite the original chosen directory remaining present and valid. v1's installed files and registration remain intact; this finding concerns unusable updates, not plugin removal.

**Production entry and cause:**

- `packages/desktop/src/renderer/extensions/PluginsTab.tsx:330–342` offers 从文件夹; `:209–224` keeps the original selected path through preview; `:232–254` sends that path and review token to install; review dialog `:362–368` invokes that actual action. This is a supported UI path, not a missing TODO.
- `packages/desktop/src/preload/index.ts:1244–1263`, `packages/desktop/src/main/index.ts:4776–4780` and `packages/desktop/src/main/marketplace-service.ts:578–604` bind real preview/reviewed-install services using the original input.
- **`packages/core/src/plugins/installer/preview.ts:468–483` snapshots reviewed content, passes `snapshotRoot` as the source path to `installLocalPlugin`, and `:484–485` deletes the snapshot before returning.** The immutable snapshot is appropriate for preventing source changes after review; the defect is losing durable provenance, not creating the snapshot.
- `packages/core/src/plugins/installer/installFromArchive.ts:12–20`, `:73–86`, `:128–142` carry overwrite only and call `installPluginFromPath` without an explicit durable `source` option.
- `packages/core/src/plugins/installer/install.ts:47–55` persists `options.source ?? sourceDir`, hence the temporary snapshot location.
- Manual update uses `packages/desktop/src/main/plugins-service.ts:283–285`, then `packages/core/src/plugins/installer/update.ts:137–142`, `:158–159` reads that stored path and rejects when it is missing.
- CLI `plugin update [--force]` also invokes this same Core updater (`packages/tui/src/cli/commands/plugin.ts:64–72`); switching to CLI does not repair a GUI-installed plugin's bad recorded source.

**Reproduction:** Fifth test now invokes the actual PluginsTab 从文件夹 callback (file chooser fixture), waits for the actual review-dialog element, invokes its actual onInstall callback, then real Main/Core reviewed install. It confirms review identity, actual source provenance and deleted snapshot, edits the still-existing original directory, and invokes actual PluginsTab Update. Log:

```json
{"originalSourcePresent":true,"storedSourceIsPrivateSnapshot":true,"storedSourcePresent":false,"installedVersion":"1.0.0","requestedSourceVersion":"2.0.0"}
```

**Normal controls/recovery distinction:** Direct installation from a durable local directory via `installPluginFromPath` stores that directory correctly; real Main update then succeeds to v2 and retains durable source, and a later malformed-source update restores v2 files/metadata/registration. That is the Core entry used by CLI direct install (`packages/tui/src/cli/commands/plugin.ts:42–45`), **not** an automatic repair preserving an existing reviewed-install provenance. Uninstall/direct reinstall is a different installation operation; do not present it as a harmless update workaround. Source changes between Desktop preview and install are correctly rejected as `previewChanged` before installation (separate passing test). ZIP source/update semantics were not generalized from this directory reproduction.

**Fix direction/test gap:** Continue installing only immutable reviewed snapshot bytes, but explicitly carry durable original directory/root provenance through `installLocalPlugin` to metadata instead of persisting the temporary content location. Preserve review-token validation and any existing overwrite/rollback behavior. Test reviewed directory install → original path remains → edit original → update succeeds with durable provenance; additionally preserve preview/source-change rejection. High confidence.

## Why these are three independent issues

W18 needs successful queued install then uninstall, and is fixed in job/inventory lifecycle. W19 needs a marketplace relative-path source and invalid new content, reproduces without a queued job, and requires installer atomicity/rollback. W20 needs reviewed local-directory installation and fails even with valid v2 source, requiring content/provenance separation. Their user actions, persisted/in-memory state and repair locations differ; merging would obscure independently necessary fixes.

No additional formal finding is claimed for update badges, hook hot-reload on uninstall, disable toggles, or explicit Phase-A npm auto-update TODOs. The supplied normal controls do not imply all plugin formats/providers or live Electron UI flows have been tested.

## 主审便携复核

本附录前文 `/tmp` 路径是代理原始记录。最终脚本已复制到 [`reproductions/plugins-round7/`](reproductions/plugins-round7/)，转换为仓库相对导入，并在 `84740d56` 与 `a66f4ef2` 分别通过 guarded runner。最终计数与上文一致；新快照日志另存 `validation/latest-a66f4ef2/`。
