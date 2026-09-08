import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "./manager.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs-settings-tombstones-"));
  directories.push(root);
  const cwd = join(root, "workspace");
  const userConfig = join(root, "user-config");
  mkdirSync(join(cwd, ".code-shell"), { recursive: true });
  mkdirSync(userConfig);
  writeFileSync(
    join(userConfig, "settings.json"),
    JSON.stringify({
      mcpServers: {
        demo: {
          command: "node",
          env: { TOKEN: "inherited-secret", KEEP: "keep" },
          headers: { Authorization: "inherited-header", "X-Trace": "trace" },
        },
      },
    }),
  );
  const manager = new SettingsManager(cwd, "full", true, userConfig);
  return { cwd, manager, localFile: join(cwd, ".code-shell", "settings.local.json") };
}

test("atomic local edits remove inherited MCP secrets without dropping other settings", () => {
  const { cwd, manager, localFile } = fixture();
  manager.mutateSettingsForScope("local", cwd, (current) => {
    current.mcpServers = { demo: { env: { TOKEN: null }, headers: { Authorization: null } } };
  });
  const effective = manager.get().mcpServers.demo!;
  expect(effective.command).toBe("node");
  expect(effective.env).toEqual({ KEEP: "keep" });
  expect(effective.headers).toEqual({ "X-Trace": "trace" });
  expect(JSON.parse(readFileSync(localFile, "utf8")).mcpServers.demo.env.TOKEN).toBeNull();
  expect(() => manager.getForScope("local", cwd)).not.toThrow();
  const raw = manager.getRawForScope("local", cwd);
  expect((raw.mcpServers as any).demo.env.TOKEN).toBeNull();
  (raw.mcpServers as any).demo.env.TOKEN = "must-not-change-the-cache";
  expect(manager.get().mcpServers.demo!.env).toEqual({ KEEP: "keep" });
  expect((manager.getRawForScope("local", cwd).mcpServers as any).demo.env.TOKEN).toBeNull();
  const fresh = new SettingsManager(cwd, "project");
  expect(fresh.get().mcpServers.demo!.env).toEqual({});
});

test("nested tombstones resolve even when no lower layer contains the object", () => {
  const { cwd, manager } = fixture();
  manager.mutateSettingsForScope("local", cwd, (current) => {
    current.mcpServers = { fresh: { command: "node", env: { REMOVED: null, KEEP: "yes" } } };
    current.theme = null;
  });
  expect(manager.get().mcpServers.fresh!.env).toEqual({ KEEP: "yes" });
  expect(manager.getForScope("local", cwd)).not.toHaveProperty("theme");
});

test("tombstone-aware validation still refuses invalid values without overwriting the file", () => {
  const { cwd, manager, localFile } = fixture();
  manager.saveLocalSetting("theme", "dark", cwd);
  const before = readFileSync(localFile, "utf8");
  expect(() =>
    manager.mutateSettingsForScope("local", cwd, (current) => {
      current.mcpServers = { demo: { env: { TOKEN: null }, enabled: "invalid" } };
    }),
  ).toThrow();
  expect(readFileSync(localFile, "utf8")).toBe(before);
});
