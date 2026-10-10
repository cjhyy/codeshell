import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";
import { officeZip, textPdf, wordXml } from "../../../../tests/fixtures/upload-documents.mjs";

const marker = Symbol.for("codeshell.cost-smoke.network-guard");
const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
const surfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
] as const;
const saved = surfaces.map(([object, key]) => ({
  object,
  key,
  descriptor: Object.getOwnPropertyDescriptor(object, key),
}));
installLocalNetworkGuard("http://127.0.0.1:9");
const owned = saved.map(({ object, key }) => Reflect.get(object, key));
expect(() => fetch("https://outside.invalid/probe")).toThrow("non-fixture");
expect(() => https.request("https://outside.invalid/probe")).toThrow("non-fixture");
afterAll(() => {
  for (const [i, { object, key, descriptor }] of saved.entries()) {
    expect(Reflect.get(object, key)).toBe(owned[i]);
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  }
  if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
  else Reflect.deleteProperty(globalThis, marker);
  syncBuiltinESMExports();
});
// Source aliases use actual exports; no Main/catalog implementation is replaced.
const core = await import("../../../core/src/index.js");
const internal = await import("../../../core/src/index.internal.js");
const urlModule = await import("../../../core/src/sources/collection-url.js");
mock.module("@cjhyy/code-shell-core", () => core);
mock.module("@cjhyy/code-shell-core/internal", () => internal);
const ORIGIN = "https://files.example";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("Main names an extensionless redirect from its final response, not its requested endpoint", async () => {
  const bytes = officeZip({ "word/document.xml": wordXml("redirected Office document") });
  const download = spyOn(urlModule, "downloadCollectionUrl")
    .mockResolvedValueOnce({
      bytes,
      proof: {
        requestedUrl: ORIGIN + "/download",
        finalUrl: ORIGIN + "/manual.docx",
        sizeBytes: bytes.length,
        sha256: digest(bytes),
        mimeType: "application/octet-stream",
      },
    })
    .mockResolvedValueOnce({
      bytes: textPdf(),
      proof: {
        requestedUrl: ORIGIN + "/download",
        finalUrl: ORIGIN + "/download",
        sizeBytes: textPdf().length,
        sha256: digest(textPdf()),
        mimeType: "application/pdf",
      },
    });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "collection-url-name-")));
  const previous = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "state");
  try {
    const { createSourceCollectionService } = await import("./source-collections-service.js");
    const api = createSourceCollectionService({
      assertCurrent: () => {},
      pick: async () => {
        throw new Error("No local picker in URL fixture");
      },
      references: async () => [],
    });
    let value = await api.create({ label: "Static manuals" });
    value = await api.update(value.definition.id, value.revision, {
      kind: "url",
      url: ORIGIN + "/download",
    });
    expect(value.entries[0]!.entry.name).toBe("manual.docx");
    expect(value.entries[0]!.entry).toMatchObject({
      kind: "url",
      url: ORIGIN + "/download",
      sizeBytes: bytes.length,
      sha256: digest(bytes),
    });
    const entryId = value.entries[0]!.entry.id;
    value = await api.update(value.definition.id, value.revision, {
      kind: "refresh",
      entryId,
    });
    expect(value.entries[0]!.entry).toMatchObject({
      id: entryId,
      name: "download.pdf",
      url: ORIGIN + "/download",
      sha256: digest(textPdf()),
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(download.mock.calls.every(([input]) => input.url === ORIGIN + "/download")).toBe(true);
  } finally {
    download.mockRestore();
    if (previous === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
