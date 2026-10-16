import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../../core/src/credentials/store.js";
import { runLegacyLinkCleanupCli } from "./legacy-cleanup-cli.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("cleanup CLI help and malformed options require no credential reads", async () => {
  let output = "";
  const io = {
    write: (value: string) => {
      output += value;
    },
  };
  expect(await runLegacyLinkCleanupCli(["--help"], io)).toBe(0);
  expect(output).toContain("Offline cleanup");
  output = "";
  expect(await runLegacyLinkCleanupCli(["remove", "--scope", "user"], io)).toBe(1);
  expect(output).not.toContain("PRIVATE");
});

test("CLI inspect is read-only and explicit remove preserves unrelated credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "link-cleanup-cli-"));
  roots.push(root);
  const user = join(root, "user");
  const store = new CredentialStore(root, undefined, user);
  store.save("user", {
    id: "old",
    type: "link",
    label: "PRIVATE_LABEL",
    secret: "PRIVATE_TOKEN",
    meta: {
      linkProvider: "github",
      linkConnectionMethod: "pat",
      linkExecutionRuntime: "local",
      linkExecutionBackend: "http-token",
    },
  });
  store.save("user", { id: "model", type: "token", label: "model", secret: "KEEP" });
  const before = readFileSync(join(user, "credentials.json"), "utf8");
  let output = "";
  const io = {
    write: (value: string) => {
      output += value;
    },
  };
  const args = [
    "--project",
    root,
    "--user-dir",
    user,
    "--operations-root",
    join(root, "operations"),
  ];
  expect(await runLegacyLinkCleanupCli(["inspect", ...args], io)).toBe(0);
  expect(JSON.parse(output).count).toBe(1);
  expect(output).not.toContain("PRIVATE");
  expect(readFileSync(join(user, "credentials.json"), "utf8")).toBe(before);
  output = "";
  expect(await runLegacyLinkCleanupCli(["remove", ...args], io)).toBe(0);
  expect(JSON.parse(output).removed).toHaveLength(1);
  expect(store.resolve("old")).toBeUndefined();
  expect(store.resolve("model")?.secret).toBe("KEEP");
});
