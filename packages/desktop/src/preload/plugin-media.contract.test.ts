import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeshellApi } from "./types";

type MediaMethod = Pick<CodeshellApi, "getPluginMedia">;
const channel = "plugins:media" satisfies string;

describe("preload plugin media contract", () => {
  test("returns DTO media through a dedicated main IPC channel", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf8");
    const method: keyof MediaMethod = "getPluginMedia";

    expect(preload).toContain(`${method}:`);
    expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
    expect(main).toContain(`"plugins:media"`);
    expect(main).toContain("return getPluginMedia(installKey");
  });
});
