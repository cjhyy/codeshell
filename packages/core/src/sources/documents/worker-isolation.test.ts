import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { officeZip, wordXml } from "../../../../../tests/fixtures/upload-documents.mjs";
import { parseDocumentIsolated, type ParserProcessReceipt } from "./worker.js";

test("actual concurrent parser children own distinct private HOME/config/cwd and clean up after close", async () => {
  const receipts: ParserProcessReceipt[] = [];
  const outputs = await Promise.all(
    ["first", "second"].map((text) =>
      parseDocumentIsolated(officeZip({ "word/document.xml": wordXml(text) }), "brief.docx", {
        onProcessExit: (receipt) => receipts.push(receipt),
      }),
    ),
  );
  expect(outputs.map((output) => output.parts[0].text)).toEqual(["first\n", "second\n"]);
  expect(receipts).toHaveLength(2);
  expect(new Set(receipts.map((receipt) => receipt.pid)).size).toBe(2);
  expect(new Set(receipts.map((receipt) => receipt.home)).size).toBe(2);
  for (const receipt of receipts) {
    expect(receipt.outcome).toBe("success");
    expect(receipt.code).toBe(0);
    expect(receipt.signal).toBe(null);
    expect(receipt.cleanedUp).toBe(true);
    expect(existsSync(receipt.home)).toBe(false);
    expect(receipt.runtime?.pid).toBe(receipt.pid!);
    expect(receipt.runtime?.ppid).toBe(process.pid);
    expect(receipt.runtime?.home).toBe(receipt.home);
    expect(receipt.runtime?.cwd).toBe(receipt.home);
    expect(receipt.home).not.toBe(process.env.HOME!);
    expect(receipt.runtime?.environment.XDG_CONFIG_HOME).toBe(join(receipt.home, "config"));
    expect(receipt.runtime?.environment.CODE_SHELL_HOME).toBe(join(receipt.home, "host-state"));
    expect(receipt.runtime?.networkProbesBeforeImport).toBe(17);
    if (process.platform !== "win32")
      expect(Object.values(receipt.runtime!.directoryModes).every((mode) => mode === 0o700)).toBe(
        true,
      );
    expect(Object.keys(outputs[0]).sort()).toEqual(["format", "parts", "truncated"]);
  }
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  console.log(
    JSON.stringify({
      fixture: "parser-child-isolation",
      children: receipts.map((receipt) => ({
        pid: receipt.runtime!.pid,
        ppid: receipt.runtime!.ppid,
        bun: receipt.runtime!.bun,
        node: receipt.runtime!.node,
        executableSha256: hash(readFileSync(receipt.runtime!.executable)),
        homeSha256: hash(receipt.runtime!.home),
        negativeProbesBeforeParserImport: receipt.runtime!.networkProbesBeforeImport,
        privateDirectoryRemoved: receipt.cleanedUp && !existsSync(receipt.home),
      })),
    }),
  );
});

test("parser errors and actual spawn failure clean only their own private directories", async () => {
  const receipts: ParserProcessReceipt[] = [];
  await expect(
    parseDocumentIsolated(Buffer.from("not a ZIP"), "invalid.docx", {
      onProcessExit: (receipt) => receipts.push(receipt),
    }),
  ).rejects.toThrow();
  // Other suites exercise HOME removal. Own the unrelated sentinel directory
  // rather than relying on a mutable global environment for this spawn fixture.
  const owner = mkdtempSync(join(tmpdir(), "codeshell-parser-owner-test-"));
  try {
    const absentExecutable = join(owner, "absent-parser-executable");
    await expect(
      parseDocumentIsolated(Buffer.from("unused"), "absent.pdf", {
        resolveExecutable: async () => absentExecutable,
        onProcessExit: (receipt) => receipts.push(receipt),
      }),
    ).rejects.toThrow();
    expect(receipts.map((receipt) => receipt.outcome)).toEqual(["failed", "spawn-error"]);
    expect(receipts[0].runtime?.networkProbesBeforeImport).toBe(17);
    expect(receipts[1].runtime).toBe(undefined);
    expect(receipts.every((receipt) => receipt.cleanedUp && !existsSync(receipt.home))).toBe(true);
    expect(existsSync(owner)).toBe(true);
  } finally {
    rmSync(owner, { recursive: true, force: true });
  }
});

test("actual timeout and cancellation close children before removing their private HOME", async () => {
  const receipts: ParserProcessReceipt[] = [];
  await expect(
    parseDocumentIsolated(Buffer.from("fixture"), "timeout.txt", {
      timeoutMs: 0,
      onProcessExit: (receipt) => receipts.push(receipt),
    }),
  ).rejects.toThrow("time limit");
  const controller = new AbortController();
  const pending = parseDocumentIsolated(Buffer.from("fixture"), "cancel.txt", {
    signal: controller.signal,
    onProcessExit: (receipt) => receipts.push(receipt),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("private parser cancelled"));
  await expect(pending).rejects.toThrow("private parser cancelled");
  expect(receipts.map((receipt) => receipt.outcome)).toEqual(["timeout", "cancelled"]);
  for (const receipt of receipts) {
    expect(receipt.pid).toBeGreaterThan(0);
    expect(receipt.signal).toBe("SIGKILL");
    expect(receipt.cleanedUp).toBe(true);
    expect(existsSync(receipt.home)).toBe(false);
  }
});
