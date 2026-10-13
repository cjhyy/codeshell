import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const protocol = { handle: mock(() => undefined) };
const defaultSession = { protocol };
mock.module("electron", () => ({ session: { defaultSession } }));
const { handleThemeAssetRequest, installThemeAssetProtocol } =
  await import("./theme-asset-protocol.js");

const WAV = Buffer.alloc(60);
WAV.write("RIFF");
WAV.writeUInt32LE(52, 4);
WAV.write("WAVEfmt ", 8);
WAV.writeUInt32LE(16, 16);
WAV.writeUInt16LE(1, 20);
WAV.writeUInt16LE(1, 22);
WAV.writeUInt32LE(8_000, 24);
WAV.writeUInt32LE(16_000, 28);
WAV.writeUInt16LE(2, 32);
WAV.writeUInt16LE(16, 34);
WAV.write("data", 36);
WAV.writeUInt32LE(16, 40);

describe("installed theme asset protocol", () => {
  let home: string;
  let assets: string;
  let previousHome: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cs-theme-protocol-"));
    previousHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    assets = join(home, ".code-shell", "themes", "audio-theme", ".cs-theme-assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "music-1.wav"), WAV);
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  function request(init?: RequestInit, file = "music-1.wav") {
    return handleThemeAssetRequest(
      new Request(`cstheme://audio-theme/.cs-theme-assets/${file}`, init),
    );
  }

  test("serves validated WAV with MIME, size and range metadata", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("content-length")).toBe(String(WAV.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(WAV);
    const head = await request({ method: "HEAD", headers: { range: "bytes=4-8" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(WAV.length));
    expect(await head.text()).toBe("");
  });

  test.each([
    ["bytes=0-3", 0, 3],
    ["bytes=44-", 44, 59],
    ["bytes=-4", 56, 59],
    ["bytes=50-999", 50, 59],
  ] as const)("returns a bounded single range for %s", async (range, start, end) => {
    const response = await request({ headers: { range } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/60`);
    expect(response.headers.get("content-length")).toBe(String(end - start + 1));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(WAV.subarray(start, end + 1));
  });

  test.each([
    "bytes=60-",
    "bytes=9-1",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,4-5",
    "bytes=999999999999999999999999-",
    "items=0-1",
  ])("rejects unsupported or unsatisfiable range %s", async (range) => {
    const response = await request({ headers: { range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */60");
  });

  test("rejects unsupported formats and verbs, missing files and malformed WAV", async () => {
    expect((await request({ method: "POST" })).status).toBe(405);
    expect((await request(undefined, "song.mp3")).status).toBe(415);
    expect((await request(undefined, "missing.wav")).status).toBe(404);
    await writeFile(join(assets, "music-1.wav"), "not a WAV");
    expect((await request()).status).toBe(415);
  });

  test("retains containment checks for audio symlinks", async () => {
    const outside = join(home, "outside.wav");
    await writeFile(outside, WAV);
    await rm(join(assets, "music-1.wav"));
    await symlink(outside, join(assets, "music-1.wav"));
    expect((await request()).status).toBe(403);
  });

  test("checks audio size before reading bytes", async () => {
    await truncate(join(assets, "music-1.wav"), 32 * 1024 * 1024 + 1);
    expect((await request()).status).toBe(413);
  });

  test("rejects special files without blocking on a FIFO", async () => {
    if (process.platform === "win32") return;
    await rm(join(assets, "music-1.wav"));
    expect(spawnSync("mkfifo", [join(assets, "music-1.wav")]).status).toBe(0);
    expect((await request()).status).toBe(403);
  });

  test("registers the protocol once per session", () => {
    installThemeAssetProtocol();
    installThemeAssetProtocol();
    expect(protocol.handle).toHaveBeenCalledTimes(1);
  });
});
