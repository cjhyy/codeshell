/** Synthetic storage seed only. Call in guarded Main after production startup.
 * No credential-access adapter, batch resolver, dialog or Engine is replaced. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const nativeBatchIds = Object.freeze({
  projectId: "native-batch-project",
  rootId: "native-batch-root",
  sessionId: "native-batch-session",
  connectionId: "00000000-0000-4000-8000-000000000008",
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const saveJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });

/** Complete eight-item proposal, sixteen bytes below the 160KiB JSON limit.
 * Every body retains distinct first/middle/last markers; none is truncated. */
export function makeNativeBatchManifest() {
  const markers = [];
  const bodyFor = (number, length) => {
    const prefix = `NATIVE-ITEM-${number}-START `;
    const middle = ` NATIVE-ITEM-${number}-MIDDLE `;
    const suffix = ` NATIVE-ITEM-${number}-END`;
    const fill = length - prefix.length - middle.length - suffix.length;
    assert.ok(fill >= 0);
    const left = Math.floor(fill / 2);
    const words = "synthetic review text ";
    const padding = (count) => words.repeat(Math.ceil(count / words.length)).slice(0, count);
    return prefix + padding(left) + middle + padding(fill - left) + suffix;
  };
  const items = Array.from({ length: 8 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    markers.push({
      item: index + 1,
      first: `NATIVE-ITEM-${number}-START`,
      middle: `NATIVE-ITEM-${number}-MIDDLE`,
      last: `NATIVE-ITEM-${number}-END`,
    });
    return {
      owner: "synthetic-owner-".padEnd(100, "o"),
      repo: "synthetic-repository-".padEnd(100, "r"),
      title: `Native capacity item ${number} `.padEnd(256, "t"),
      body: bodyFor(number, 20_000),
    };
  });
  const targetBytes = 160 * 1024 - 16;
  const excess = Buffer.byteLength(JSON.stringify(items)) - targetBytes;
  assert.ok(excess > 0 && excess < 1_000);
  items[7].body = bodyFor("08", 20_000 - excess);
  const bytes = Buffer.from(JSON.stringify(items));
  assert.equal(bytes.length, targetBytes);
  for (const [index, item] of items.entries()) {
    assert.ok(item.body.length <= 20_000 && item.body.length >= 19_000);
    for (const marker of Object.values(markers[index]).filter((value) => typeof value === "string"))
      assert.equal(item.body.split(marker).length, 2);
  }
  return { items, markers, manifestBytes: bytes.length, manifestSha256: hash(bytes) };
}

/** Before Main: private project registry, trust and inert first-run settings. */
export async function prepareOperationBatchHome({ home, codeShellHome, projectRoot }) {
  assert.equal(codeShellHome, join(home, ".code-shell"));
  assert.equal(projectRoot, join(home, "synthetic-project"));
  await mkdir(join(projectRoot, ".code-shell"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(codeShellHome, "settings.json"),
    JSON.stringify({ autoUpdates: false, language: "en", featureFlags: { taskInboxV1: true } }),
    { mode: 0o600 },
  );
  await saveJson(join(projectRoot, ".code-shell/settings.json"), {});
  await mkdir(join(codeShellHome, "desktop"), { recursive: true, mode: 0o700 });
  await saveJson(join(codeShellHome, "desktop/projects.json"), {
    version: 2,
    projects: [
      {
        id: nativeBatchIds.projectId,
        name: "Synthetic Native batch project",
        primaryRootId: nativeBatchIds.rootId,
        roots: [
          {
            id: nativeBatchIds.rootId,
            name: "Synthetic root",
            path: projectRoot,
            canonicalIdentity: projectRoot,
            addedAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        revision: 1,
      },
    ],
  });
  await saveJson(join(codeShellHome, "desktop/trust.json"), { [projectRoot]: "trusted" });
  const plugins = join(codeShellHome, "plugins");
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  await saveJson(join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });
  await saveJson(join(plugins, "core_plugins_installed.json"), {
    "skill-creator@mimi-plugins": "synthetic-offline-fixture",
    "model-fact-finder@mimi-plugins": "synthetic-offline-fixture",
  });
  await saveJson(
    join(plugins, "known_marketplaces.json"),
    Object.fromEntries(
      ["official", "mimi-plugins"].map((name) => [
        name,
        {
          source: { source: "github", repo: "synthetic/offline" },
          installLocation: join(plugins, "offline", name),
          lastUpdated: "2026-10-10T00:00:00Z",
        },
      ]),
    ),
  );
}

/** core must be the same external Core singleton imported by production Main.
 * Waiting for SafeStorageCipher avoids creating an early PlaintextCipher store. */
export async function installOperationBatchNativeFixture(core, { home, projectRoot, origin }) {
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.USERPROFILE, home);
  assert.equal(process.env.CODE_SHELL_HOME, join(home, ".code-shell"));
  assert.equal(process.env.CODE_SHELL_TEST_HOME, process.env.CODE_SHELL_HOME);
  assert.equal(process.env.CODE_SHELL_DATA_ROOT, undefined);
  const deadline = Date.now() + 15_000;
  while (core.getDefaultCredentialCipher().constructor.name !== "SafeStorageCipher") {
    if (Date.now() >= deadline)
      throw new Error("Production Main did not install SafeStorageCipher");
    await new Promise((done) => setTimeout(done, 50));
  }
  const credential = {
    id: nativeBatchIds.connectionId,
    type: "oauth",
    label: "Synthetic Native capacity connection",
    secret: JSON.stringify({
      version: 1,
      accessToken: "synthetic-native-batch-access-token",
      refreshToken: "synthetic-native-batch-refresh-token",
      expiresAt: "2099-01-01T00:00:00Z",
      tokenType: "Bearer",
      scope: "github:list_issues github:create_issue github:get_issue",
      scopes: ["github:list_issues", "github:create_issue", "github:get_issue"],
      issuer: origin,
      clientId: "synthetic-native-client",
    }),
    meta: {
      linkProvider: "github",
      linkExecutionRuntime: "server",
      linkExecutionBackend: "remote",
      linkRemoteIssuer: origin,
      linkRemoteConnectionId: "00000000-0000-4000-8000-000000000009",
      linkRemoteGrantId: "00000000-0000-4000-8000-000000000010",
      linkRemoteState: "connected",
      linkAccountId: "synthetic-native-batch-account",
      linkAccountLabel: "Synthetic Native capacity account",
      linkResourceLabels: ["fixture/repo"],
      linkResourceGroups: [
        { id: "repositories", items: [{ id: "fixture/repo", label: "fixture/repo" }] },
      ],
      linkLastVerifiedAt: "2026-10-10T00:00:00Z",
      linkCapabilityIds: ["github.list_issues", "github.create_issue", "github.get_issue"],
      agentExposable: false,
    },
  };
  const store = new core.CredentialStore();
  store.save("user", credential);
  assert.equal(store.resolve(credential.id)?.secret, credential.secret);
  const masked = store.listMasked().find((entry) => entry.id === credential.id);
  assert.ok(masked?.hasSecret && masked.oauthStatus?.state === "valid");
  const saved = JSON.parse(await readFile(join(home, ".code-shell/credentials.json"), "utf8"));
  const storedSecret = saved.credentials.find((entry) => entry.id === credential.id)?.secret;
  assert.ok(typeof storedSecret === "string");
  assert.ok(storedSecret.startsWith("enc:safeStorage:") || storedSecret.startsWith("plain:"));
  if (process.platform === "darwin")
    assert.ok(storedSecret.startsWith("enc:safeStorage:"), "macOS requires actual Main encryption");
  const root = core.sessionsRoot();
  assert.equal(root, join(home, ".code-shell/sessions"));
  const sessions = new core.SessionManager(root);
  const bundle = sessions.create(
    projectRoot,
    "synthetic-native-no-model",
    "synthetic-native-no-provider",
    nativeBatchIds.sessionId,
    null,
    "desktop",
  );
  bundle.state.status = "paused";
  bundle.state.project = { projectId: nativeBatchIds.projectId, mainRootId: nativeBatchIds.rootId };
  bundle.state.costState = new core.UsageLedger({
    storageDir: join(root, ".usage-ledger"),
  }).sessionState(nativeBatchIds.sessionId, root);
  assert.equal(sessions.saveState(bundle.state), true);
  const statePath = join(root, nativeBatchIds.sessionId, "state.json");
  const transcriptPath = join(root, nativeBatchIds.sessionId, "transcript.jsonl");
  const stateBytes = await readFile(statePath);
  const transcriptBytes = await readFile(transcriptPath);
  const state = sessions.readSessionState(nativeBatchIds.sessionId);
  assert.equal(state?.status, "paused");
  assert.equal(state.runId, undefined);
  const receipt = {
    pid: process.pid,
    ppid: process.ppid,
    projectId: nativeBatchIds.projectId,
    sessionId: nativeBatchIds.sessionId,
    connectionId: nativeBatchIds.connectionId,
    cipherType: core.getDefaultCredentialCipher().constructor.name,
    storedForm: storedSecret.startsWith("enc:safeStorage:") ? "enc:safeStorage" : "plain-fallback",
    hasSecret: masked.hasSecret,
    oauthState: masked.oauthStatus.state,
    status: state.status,
    stateSha256: hash(stateBytes),
    transcriptSha256: hash(transcriptBytes),
    scope: "synthetic persistent seed through actual Main Core; no Engine/Run or external service",
  };
  await saveJson(join(home, "native-batch-main-seed.json"), receipt);
  return receipt;
}
