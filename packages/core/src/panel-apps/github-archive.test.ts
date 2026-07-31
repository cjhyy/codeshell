import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadGitHubPanelAppArchive, type PanelAppArchiveFetch } from "./github-archive.js";

describe("GitHub Panel App source archives", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "cs-panel-archive-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("downloads a bounded codeload snapshot for the selected ref", async () => {
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]);
    let requestedUrl = "";
    const fetchImpl: PanelAppArchiveFetch = async (input) => {
      requestedUrl = String(input);
      return new Response(archive, {
        status: 200,
        headers: {
          "content-length": String(archive.length),
          "content-type": "application/zip",
        },
      });
    };
    const target = join(scratch, "source.zip");

    await downloadGitHubPanelAppArchive(
      {
        url: "https://github.com/acme/panels.git",
        ref: "feature/responsive",
      },
      target,
      fetchImpl,
    );

    expect(requestedUrl).toBe("https://codeload.github.com/acme/panels/zip/feature/responsive");
    expect(readFileSync(target)).toEqual(archive);
  });

  test("rejects non-ZIP responses and removes the partial download", async () => {
    const target = join(scratch, "source.zip");
    const fetchImpl: PanelAppArchiveFetch = async () =>
      new Response("not a zip", {
        status: 200,
        headers: { "content-length": "9" },
      });

    await expect(
      downloadGitHubPanelAppArchive(
        { url: "https://github.com/acme/panels.git", ref: "main" },
        target,
        fetchImpl,
      ),
    ).rejects.toThrow(/not a ZIP archive/);
    expect(existsSync(target)).toBe(false);
  });

  test("rejects an oversized archive before reading the body", async () => {
    const target = join(scratch, "source.zip");
    const fetchImpl: PanelAppArchiveFetch = async () =>
      new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "content-length": String(128 * 1024 * 1024 + 1) },
      });

    await expect(
      downloadGitHubPanelAppArchive(
        { url: "https://github.com/acme/panels.git", ref: "main" },
        target,
        fetchImpl,
      ),
    ).rejects.toThrow(/exceeds/);
    expect(existsSync(target)).toBe(false);
  });
});
