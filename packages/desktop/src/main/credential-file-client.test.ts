import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialFileCommand } from "@cjhyy/code-shell-core/internal/storage";
import { getDefaultCredentialCipher, setDefaultCredentialCipher } from "@cjhyy/code-shell-core";
import {
  desktopPendingLinkRetirements,
  runDesktopCredentialOperation,
  setDesktopCredentialFiles,
} from "./credential-file-client.js";

test("Main asks for only the retirement count and never calls the credential cipher", async () => {
  const calls: unknown[] = [];
  const restore = setDesktopCredentialFiles(async <T>(method: string, payload: unknown) => {
    calls.push({ method, payload });
    return 2 as T;
  });
  const original = getDefaultCredentialCipher();
  const noCipher = () => {
    throw Error("unexpected cipher request");
  };
  setDefaultCredentialCipher({ encrypt: noCipher, decrypt: noCipher, canDecrypt: noCipher });
  try {
    expect(await desktopPendingLinkRetirements()).toBe(2);
    expect(calls).toEqual([{ method: "credentials/pendingRetirements", payload: {} }]);
  } finally {
    restore();
    setDefaultCredentialCipher(original);
  }
});

test("an asynchronous document check and a project shadow are both resolved before a user commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "link-shadow-cas-"));
  const user = join(root, "user");
  const cwd = join(root, "workspace");
  mkdirSync(user);
  mkdirSync(cwd);
  const path = join(user, "credentials.json");
  const local = { type: "token" as const, id: "fixture", label: "user", secret: "fixture" };
  const original = JSON.stringify({ version: 1, credentials: [local] });
  writeFileSync(path, original);
  const methods: string[] = [];
  const restore = setDesktopCredentialFiles(
    async <T>(method: Parameters<typeof credentialFileCommand>[1], payload: unknown) => {
      methods.push(method);
      return credentialFileCommand(user, method, payload) as T;
    },
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  const update = () =>
    runDesktopCredentialOperation(
      cwd,
      ["user", "project"],
      "user",
      (s) => {
        ++attempts;
        if (s.resolve("fixture", "project")) return "shadow";
        s.save("user", { ...local, label: "changed" });
        return "updated";
      },
      async () => {
        entered.resolve();
        await release.promise;
      },
      { guardProjectRevision: true },
    );
  try {
    const first = update();
    await entered.promise;
    expect(methods).not.toContain("credentials/commit");
    mkdirSync(join(cwd, ".code-shell"));
    writeFileSync(
      join(cwd, ".code-shell", "credentials.json"),
      JSON.stringify({ version: 1, credentials: [{ ...local, label: "project" }] }),
    );
    release.resolve();
    expect(await first).toBe("shadow");
    expect(attempts).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(original);
    methods.length = 0;
    await expect(
      runDesktopCredentialOperation(
        cwd,
        ["user"],
        "user",
        (s) => s.save("user", { ...local, label: "revoked" }),
        async () => {
          await Promise.resolve();
          throw Error("revoked");
        },
      ),
    ).rejects.toThrow("revoked");
    expect(methods).not.toContain("credentials/commit");
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
