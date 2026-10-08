import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.env.CODE_SHELL_TEST_HOME && process.env.CODE_SHELL_HOME);
assert.equal(process.env.HOME, fs.realpathSync(process.env.HOME));
const denyNetwork = () => {
  throw new Error("Static plugin export fixture refuses all network access");
};
globalThis.fetch = denyNetwork;
http.request = http.get = https.request = https.get = denyNetwork;
net.connect = net.createConnection = tls.connect = denyNetwork;
syncBuiltinESMExports();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adapter = join(
  repo,
  "packages/desktop/node_modules/.cache/profile-plugin-export.fixture.mjs",
);
fs.mkdirSync(dirname(adapter), { recursive: true });
const built = spawnSync(
  "bun",
  [
    "build",
    "scripts/fixtures/profile-plugin-export-adapters.ts",
    "--target=node",
    "--packages=external",
    "--outfile",
    adapter,
  ],
  { cwd: repo, env: process.env, encoding: "utf8" },
);
assert.equal(built.status, 0, built.stderr);
const root = fs.mkdtempSync(join(tmpdir(), "codeshell-static-plugin-native-"));
const cwd = join(root, "project");
const upstream = join(root, "upstream");
const output = join(root, "reviewed.plugin");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const put = (path, text) => {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, text);
};
const sentinel = "NEVER_READ_MEMORY_CREDENTIAL_SOURCE_SECRET";
const forbidden = new Set([
  join(process.env.CODE_SHELL_HOME, "profiles", "native", "MEMORY.md"),
  join(process.env.CODE_SHELL_HOME, "credentials.json"),
  join(upstream, ".mcp.json"),
  join(upstream, "sources.json"),
  join(upstream, "skills", "origin", ".credentials.txt"),
]);
for (const path of forbidden) put(path, sentinel);
for (const path of [...forbidden]) forbidden.add(fs.realpathSync(path));
fs.mkdirSync(cwd);
put(
  join(upstream, "skills", "origin", "SKILL.md"),
  "---\nname: origin\ndescription: Static upstream Skill\nallowed-tools: []\n---\nNATIVE_SKILL_BODY\n",
);
put(join(upstream, "skills", "origin", "reference.txt"), "SELECTED_SUPPORT_TEXT\n");
put(
  join(upstream, "agents", "role.md"),
  "---\nname: upstream-role\ndescription: Bounded role\ntools: []\nskills: [origin]\nmcp: []\nsandbox: auto\n---\nNATIVE_AGENT_BODY\n",
);
const originalOpen = fs.openSync,
  originalRead = fs.readFileSync,
  originalSync = fs.fsyncSync;
let forbiddenReads = 0;
const guardPath = (path) => {
  if (typeof path === "string" && forbidden.has(path)) {
    forbiddenReads++;
    throw new Error("Fixture caught forbidden private read");
  }
};
fs.openSync = (path, ...args) => {
  guardPath(path);
  return originalOpen(path, ...args);
};
fs.readFileSync = (path, ...args) => {
  guardPath(path);
  return originalRead(path, ...args);
};
syncBuiltinESMExports();
try {
  const core = await import("@cjhyy/code-shell-core");
  const internal = await import("@cjhyy/code-shell-core/internal");
  const { writeInstalledPlugins } =
    await import("../packages/core/dist/plugins/installedPlugins.js");
  const host = await import(pathToFileURL(adapter).href);
  writeInstalledPlugins({
    version: 2,
    plugins: {
      "upstream@local": [
        {
          scope: "user",
          installPath: upstream,
          version: "1.0.0",
          installedAt: "fixture",
          lastUpdated: "fixture",
        },
      ],
    },
  });
  internal.saveWorkspaceProfile({
    name: "native",
    label: "Native fixture",
    basePreset: "general",
    skills: ["upstream:origin"],
    agents: ["upstream-role"],
    plugins: [sentinel],
    mcp: [sentinel],
    sourceAccess: [],
    portableMemory: true,
    mainInstruction: "REFERENCE_INSTRUCTION_ONLY",
  });
  const empty = { componentIds: [], textFileIds: [], includeInstruction: false };
  const offered = internal.previewProfilePluginExport("native", cwd, empty);
  const selected = { ...empty, componentIds: offered.components.map((item) => item.id) };
  const withSupport = internal.previewProfilePluginExport("native", cwd, selected);
  selected.textFileIds = withSupport.components.flatMap((item) =>
    item.textFiles.map((file) => file.id),
  );
  const reviews = new host.ProfilePluginExportReviews();
  const preview = reviews.preview(1, "authorized-native-context", "native", cwd, selected);
  assert.equal(preview.canExport, true, JSON.stringify(preview.components));
  assert.ok(!JSON.stringify(preview).includes(sentinel));
  assert.ok(!JSON.stringify(preview).includes(upstream));
  assert.ok(!preview.files.some((file) => file.text.includes("REFERENCE_INSTRUCTION_ONLY")));
  // Confirmed writes use precisely the reviewed RAM snapshot after source replacement.
  put(join(upstream, "skills", "origin", "SKILL.md"), "REPLACED_AFTER_REVIEW");
  reviews.commit(1, "authorized-native-context", preview.reviewToken, true, output);
  for (const file of preview.files)
    assert.equal(hash(fs.readFileSync(join(output, file.path))), file.sha256);
  const before = core.readInstalledPlugins();
  const installerPreview = await internal.previewLocalPlugin({ kind: "dir", path: output });
  assert.equal(installerPreview.format, "cc");
  assert.equal(installerPreview.skills.length, 1);
  assert.equal(installerPreview.agents.length, 1);
  assert.deepEqual(installerPreview.hooks, []);
  assert.deepEqual(installerPreview.mcpServers, []);
  assert.deepEqual(core.readInstalledPlugins(), before);
  await internal.installReviewedLocalPlugin(
    { kind: "dir", path: output },
    installerPreview.reviewToken,
    "2026-10-09T00:00:00.000Z",
  );
  core.invalidateSkillCache();
  const skill = preview.components.find((item) => item.kind === "skill");
  const agent = preview.components.find((item) => item.kind === "agent");
  const loadedSkill = core
    .scanSkills(cwd)
    .find((item) => item.name === `${preview.pluginName}:${skill.exportName}`);
  assert.ok(loadedSkill.content.includes("NATIVE_SKILL_BODY"));
  assert.ok(
    fs
      .readFileSync(join(dirname(loadedSkill.filePath), "reference.txt"), "utf8")
      .includes("SELECTED_SUPPORT_TEXT"),
  );
  const loadedAgent = core.loadAgentDefinitionsForCwd(cwd).get(agent.exportName);
  assert.deepEqual(loadedAgent.tools, []);
  assert.deepEqual(loadedAgent.mcp, []);
  assert.deepEqual(loadedAgent.skills, [skill.exportName]);
  assert.equal(loadedAgent.pluginName, preview.pluginName);
  const report = JSON.parse(fs.readFileSync(join(output, "export-report.json"), "utf8"));
  assert.equal(report.schemaVersion, 1);
  for (const file of report.files)
    assert.equal(hash(fs.readFileSync(join(output, file.path))), file.sha256);
  // Real native EIO path: retain an unknown addition while removing only owned output.
  const failed = join(root, "failed.plugin");
  let injected = false;
  fs.fsyncSync = (fd) => {
    if (!injected && fs.fstatSync(fd).isDirectory()) {
      injected = true;
      put(join(failed, "unknown.txt"), "PRESERVE_UNKNOWN");
      throw Object.assign(new Error("fixture EIO"), { code: "EIO" });
    }
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  assert.throws(() => host.writeProfilePluginSnapshot(preview, failed), /export failed/);
  assert.equal(fs.readFileSync(join(failed, "unknown.txt"), "utf8"), "PRESERVE_UNKNOWN");
  assert.equal(fs.existsSync(join(failed, ".claude-plugin", "plugin.json")), false);
  assert.equal(forbiddenReads, 0);
  console.log(
    JSON.stringify({
      fixture: "profile-static-plugin-native",
      pid: process.pid,
      homeHash: hash(process.env.HOME),
      format: installerPreview.format,
      files: preview.files.length,
      bytes: preview.totalBytes,
      selectedSupport: true,
      originalLoaders: true,
      denyAlllistsPreserved: true,
      sourceReplacementFrozen: true,
      forbiddenReads,
      eioPreservesUnknown: true,
      networkRequests: 0,
    }),
  );
} finally {
  fs.openSync = originalOpen;
  fs.readFileSync = originalRead;
  fs.fsyncSync = originalSync;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(adapter, { force: true });
}
