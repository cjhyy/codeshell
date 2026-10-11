import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

expect(process.env.HOME).toContain("codeshell-bun-completion-");
const attempts: string[] = [];
for (const [object, key] of [[globalThis, "fetch"], [http, "request"], [http, "get"],
  [https, "request"], [https, "get"], [net, "connect"], [net, "createConnection"],
  [net.Socket.prototype, "connect"], [tls, "connect"]] as const) {
  Reflect.set(object, key, () => { attempts.push(key); throw new Error("round9 transport denied"); });
}
syncBuiltinESMExports();
expect(() => fetch("https://outside.invalid/")).toThrow("transport denied");
expect(() => net.connect(9, "127.0.0.1")).toThrow("transport denied");
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const market = await import(`${workspace}/packages/desktop/src/main/marketplace-service.ts`);
const plugins = await import(`${workspace}/packages/desktop/src/main/plugins-service.ts`);
const { readInstalledPlugins } = await import(`${workspace}/packages/core/src/plugins/installedPlugins.ts`);

test("explicit reviewed folder overwrite updates content without uninstall, but retains the broken temporary update provenance", async () => {
  const source = mkdtempSync(join(tmpdir(), "round9-review-overwrite-"));
  const name = "round9-reviewed-overwrite";
  mkdirSync(join(source, ".codex-plugin"));
  const manifest = join(source, ".codex-plugin", "plugin.json");
  const install = async (version: string, overwrite: boolean) => {
    writeFileSync(manifest, JSON.stringify({ name, version }));
    const preview = await market.previewLocalPluginForUi({ kind: "dir", path: source });
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(preview.error);
    expect(preview.preview.alreadyInstalled).toBe(overwrite);
    const result = await market.installLocalPluginForUi({ kind: "dir", path: source,
      reviewToken: preview.preview.reviewToken, overwrite });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  try {
    await install("1.0.0", false);
    const before = plugins.listPlugins("").find((p: any) => p.installKey === `${name}@local`)!;
    expect(before).toBeDefined();
    const oldMeta = JSON.parse(readFileSync(join(before.installPath, ".cs-meta.json"), "utf8"));
    expect(existsSync(oldMeta.source)).toBe(false);
    await expect(plugins.updatePluginEntry(`${name}@local`)).rejects.toThrow("source no longer exists");
    await install("2.0.0", true);
    const after = plugins.listPlugins("").find((p: any) => p.installKey === `${name}@local`)!;
    expect(after.installPath).toBe(before.installPath);
    const newMeta = JSON.parse(readFileSync(join(after.installPath, ".cs-meta.json"), "utf8"));
    expect(newMeta.version).toBe("2.0.0");
    expect(readFileSync(join(after.installPath, ".codex-plugin", "plugin.json"), "utf8")).toContain("2.0.0");
    expect(readInstalledPlugins().plugins[`${name}@local`]).toHaveLength(1);
    expect(existsSync(source)).toBe(true); expect(existsSync(newMeta.source)).toBe(false);
    expect(newMeta.source).not.toBe(oldMeta.source);
    await expect(plugins.updatePluginEntry(`${name}@local`)).rejects.toThrow("source no longer exists");
    expect(attempts).toHaveLength(2);
    writeFileSync(new URL("./recovery-observation.json", import.meta.url), JSON.stringify({
      fixtureSourceBaseline: "a66f4ef291f304ee4df9da8095a90671d9a8f140", oldVersion: oldMeta.version,
      overwriteVersion: newMeta.version, sameInstallPath: after.installPath === before.installPath,
      registryEntries: readInstalledPlugins().plugins[`${name}@local`].length,
      originalDirectoryPresent: existsSync(source), storedUpdateSourcePresent: existsSync(newMeta.source),
      explicitOverwriteRestoresContent: true, subsequentMoreUpdateStillFails: true,
      negativeProbes: 2, unexpectedTransports: attempts.length - 2,
    }, null, 2));
  } finally { rmSync(source, { recursive: true, force: true }); }
});
