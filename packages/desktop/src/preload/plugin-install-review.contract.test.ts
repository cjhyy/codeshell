import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CodeshellApi } from "./types";

type ReviewMethods = Pick<CodeshellApi, "previewLocalPlugin" | "installLocalPlugin">;

describe("preload local plugin review contract", () => {
  test("previews before the reviewed-token install channel", () => {
    const preload = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
    const main = readFileSync(join(import.meta.dir, "..", "main", "index.ts"), "utf-8");
    const methods: Array<keyof ReviewMethods> = ["previewLocalPlugin", "installLocalPlugin"];

    for (const method of methods) expect(preload).toContain(`${method}:`);
    expect(preload).toContain('ipcRenderer.invoke("plugins:previewLocal"');
    expect(preload).toContain('ipcRenderer.invoke("plugins:installLocal"');
    expect(preload).toContain("reviewToken: string");
    expect(main).toMatch(/ipcMain\.handle\(\s*"plugins:previewLocal"/);
    expect(main).toContain("reviewToken: string");
    expect(main).toContain("previewLocalPluginForUi(input)");
  });
});
