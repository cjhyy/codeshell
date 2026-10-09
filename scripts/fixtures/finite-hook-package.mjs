/** Synthetic files only. Caller must install its exact network guards before calling. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const finiteNodeCommand = "node declared-entry.mjs";
export const finiteShCommand = "sh declared-entry.sh";
export const finiteArguments = ["--eval", "-c", "literal; $(no-expansion)"];
export const finiteEvents = [
  "pre_tool_use",
  "on_permission_check",
  "on_tool_start",
  "on_tool_end",
  "post_tool_use",
];
export const finiteSettingsHooks = () =>
  finiteEvents.map((event, index) => ({
    event,
    command: index % 2 ? finiteShCommand : finiteNodeCommand,
    timeout_ms: 5000,
  }));
export const finiteBoundSettings = () => ({
  permissions: { rules: [{ tool: "LinkAction", decision: "allow" }] },
  disabledPlugins: ["finite-hook-fixture"],
  hooks: [finiteSettingsHooks()[0]],
  agent: { appendSystemPrompt: "x".repeat(4 * 1024 * 1024 - 4096) },
});
const hash = (value) => createHash("sha256").update(value).digest("hex");

const nodeEntry = `import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {check} from './helper.mjs';
assert.deepEqual(process.argv.slice(2),${JSON.stringify(finiteArguments)});
assert.ok(process.execArgv.includes('--max-old-space-size=64'));
const envelope=JSON.parse(readFileSync(0,'utf8'));
assert.equal(envelope.eventName,process.env.CODESHELL_HOOK_EVENT);
assert.equal(envelope.data.toolName,'LinkAction');
assert.equal(process.cwd(),process.env.CODESHELL_HOOK_CWD);
check(JSON.parse(readFileSync(new URL('../assets/data.json',import.meta.url),'utf8')));
writeFileSync(join(process.env.HOME,'private-proof'),'private');
if(process.env.CODESHELL_PLUGIN_DATA)writeFileSync(join(process.env.CODESHELL_PLUGIN_DATA,'private-proof'),'private');
assert.throws(()=>writeFileSync(join(process.cwd(),'snapshot-write'),'denied'),{code:'EROFS'});
process.stdout.write(JSON.stringify({decision:'allow'}));
`;
const shEntry = `set -eu
[ "$#" = 3 ]
[ "$1" = '--eval' ]
[ "$2" = '-c' ]
[ "$3" = 'literal; $(no-expansion)' ]
[ "$PWD" = "$CODESHELL_HOOK_CWD" ]
. /resources/scripts/helper.sh
finite_check
cat >/dev/null
printf private > "$HOME/private-proof"
if [ -n "\${CODESHELL_PLUGIN_DATA:-}" ]; then printf private > "$CODESHELL_PLUGIN_DATA/private-proof"; fi
if (printf denied > "$PWD/snapshot-write") 2>/dev/null; then exit 9; fi
printf '%s' '{"decision":"allow"}'
`;

export async function prepareFiniteHookFixture({
  coreUrl,
  home,
  cwd,
  settingsScope,
  settingsBytes,
  settingsHooks = finiteSettingsHooks(),
  pluginName = "finite-hook-fixture",
}) {
  const { installPluginFromPath } = await import(new URL("plugins/installer/install.js", coreUrl));
  const { approvePluginHooks } = await import(new URL("plugins/pluginHookApproval.js", coreUrl));
  const { listPluginHooksForHost } = await import(new URL("plugins/loadPluginHooks.js", coreUrl));
  const { readInstalledPlugins } = await import(new URL("plugins/installedPlugins.js", coreUrl));
  const { settingsHookDefinitionSha256 } = await import(
    new URL("settings/hook-provenance.js", coreUrl)
  );
  const packageRoot = join(home, "finite-package-source");
  mkdirSync(join(packageRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(join(packageRoot, "hooks"), { recursive: true });
  writeFileSync(
    join(packageRoot, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: pluginName,
      version: "1.0.0",
      description: "Synthetic finite Hook acceptance",
    }),
  );
  const pluginCommands = [
    'node "${CODESHELL_PLUGIN_ROOT}/scripts/entry.mjs"',
    'sh "${CODESHELL_PLUGIN_ROOT}/scripts/entry.sh"',
  ];
  writeFileSync(
    join(packageRoot, "hooks/hooks.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "^LinkAction$", hooks: [{ type: "command", command: pluginCommands[0] }] },
        ],
        PostToolUse: [
          { matcher: "^LinkAction$", hooks: [{ type: "command", command: pluginCommands[1] }] },
        ],
      },
    }),
  );
  const files = {
    "scripts/entry.mjs": nodeEntry,
    "scripts/helper.mjs":
      "import assert from 'node:assert/strict'; export function check(value){assert.deepEqual(value,{ok:true});}\n",
    "scripts/entry.sh": shEntry,
    "scripts/helper.sh": `finite_check(){ [ "$(cat /resources/assets/data.json)" = '{"ok":true}' ]; }\n`,
    "assets/data.json": '{"ok":true}',
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(packageRoot, name, ".."), { recursive: true });
    writeFileSync(join(packageRoot, name), bytes);
  }
  const installPath = realpathSync(
    await installPluginFromPath(packageRoot, pluginName, "2026-10-09T00:00:00Z"),
  );
  const approval = approvePluginHooks(`${pluginName}@local`);
  assert.equal(approval.length, 1);
  assert.equal(approval[0].status, "approved");
  const plugins = listPluginHooksForHost().filter(
    (hook) => hook.installKey === `${pluginName}@local`,
  );
  assert.equal(plugins.length, 2);
  assert.ok(plugins.every((hook) => hook.source.custody && hook.approval === "approved"));
  const context = { cwd, settingsScope, profileName: null };
  const directories = ["assets", "empty", "scripts"];
  const manifest = (plugin) =>
    Object.keys(files).map((name) => {
      const path = join(plugin ? installPath : packageRoot, name);
      const bytes = readFileSync(path);
      return { source: plugin ? name : path, name, bytes: bytes.length, sha256: hash(bytes) };
    });
  const launch = (interpreter) => ({
    interpreter,
    entry: `scripts/entry.${interpreter === "node" ? "mjs" : "sh"}`,
    argv: [...finiteArguments],
    cwd: "empty",
  });
  const plans = [
    ...settingsHooks.map((hook, sourceLayerIndex) => ({
      commandSha256: hash(hook.command),
      event: hook.event,
      source: {
        kind: "settings",
        layer: "project",
        path: join(cwd, ".code-shell/settings.json"),
        rawSha256: hash(settingsBytes),
        sourceLayerIndex,
        definitionSha256: settingsHookDefinitionSha256(hook),
      },
      context,
      definitionCwd: hook.cwd ?? null,
      files: manifest(false),
      directories,
      launch: launch(hook.command === finiteNodeCommand ? "node" : "sh"),
    })),
    ...plugins.map((hook) => {
      const { custody: _custody, ...source } = hook.source;
      return {
        commandSha256: hash(hook.command),
        event: hook.event,
        source,
        context,
        definitionCwd: null,
        files: manifest(true),
        directories,
        launch: launch(hook.event === "pre_tool_use" ? "node" : "sh"),
      };
    }),
  ];
  return {
    plans,
    pluginRegistry: readInstalledPlugins(),
    installPath,
    packageRoot,
    approval,
    pluginKey: `${pluginName}@local`,
    settingsHooks,
    files,
  };
}

/** The declared native limits, with one shared source just below its RAW bound. */
export async function prepareFiniteHookBoundsFixture({ largeResources = false, ...options }) {
  const fixture = await prepareFiniteHookFixture({
    ...options,
    settingsHooks: [finiteSettingsHooks()[0]],
  });
  const plan = fixture.plans.find((item) => item.source.kind === "settings");
  const remaining = 64 - plan.files.length;
  const initialBytes = plan.files.reduce((total, file) => total + file.bytes, 0);
  const largeBytes = Math.floor((32 * 1024 * 1024 - 4096 - initialBytes) / remaining);
  for (let index = plan.files.length; index < 64; index++) {
    const name = `assets/bound-${index}.txt`;
    const source = join(fixture.packageRoot, name);
    const bytes = largeResources
      ? Buffer.alloc(largeBytes, 65 + (index % 26))
      : Buffer.from(`synthetic finite resource ${index}\n`);
    writeFileSync(source, bytes);
    plan.files.push({ source, name, bytes: bytes.length, sha256: hash(bytes) });
  }
  fixture.plans = [plan];
  return fixture;
}
