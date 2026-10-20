import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "./applier.js";
import { parsePatch } from "./parser.js";

describe("applyPatch file bytes and permissions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-applypatch-metadata-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function apply(body: string) {
    const { hunks } = parsePatch(`*** Begin Patch\n${body}*** End Patch\n`);
    return applyPatch(hunks, { cwd: dir });
  }

  function blockLaterWrite(): string {
    writeFileSync(join(dir, "blocked"), "not a directory\n");
    return "*** Add File: blocked/file.txt\n+cannot be written\n";
  }

  function expectMode(path: string, mode: number): void {
    if (process.platform !== "win32") expect(statSync(path).mode & 0o7777).toBe(mode);
  }

  test.skipIf(process.platform === "win32")(
    "a move preserves executable permissions despite the creation umask",
    async () => {
      const source = join(dir, "script.sh");
      const target = join(dir, "nested/moved.sh");
      writeFileSync(source, "before\n");
      chmodSync(source, 0o751);
      const previousUmask = process.umask(0o077);
      try {
        await apply("*** Update File: script.sh\n*** Move to: nested/moved.sh\n-before\n+after\n");
      } finally {
        process.umask(previousUmask);
      }
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("after\n");
      expectMode(target, 0o751);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a move overwriting a target inherits the source permissions",
    async () => {
      const source = join(dir, "script.sh");
      const target = join(dir, "target.sh");
      writeFileSync(source, "before\n");
      chmodSync(source, 0o755);
      writeFileSync(target, "old target\n");
      chmodSync(target, 0o600);

      await apply("*** Update File: script.sh\n*** Move to: target.sh\n-before\n+after\n");

      expect(existsSync(source)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("after\n");
      expectMode(target, 0o755);
    },
  );

  test.each(["", "*** Move to: script.sh\n"])(
    "an in-place update preserves permissions (move header: %j)",
    async (move) => {
      const source = join(dir, "script.sh");
      writeFileSync(source, "before\n");
      chmodSync(source, 0o751);

      await apply(`*** Update File: script.sh\n${move}-before\n+after\n`);

      expect(readFileSync(source, "utf8")).toBe("after\n");
      expectMode(source, 0o751);
    },
  );

  test("rollback restores deleted binary bytes and permissions", async () => {
    const path = join(dir, "binary.dat");
    const bytes = Buffer.from([0xff, 0x80, 0x00, 0x0d, 0x0a, 0xfe]);
    writeFileSync(path, bytes);
    chmodSync(path, 0o751);

    await expect(apply("*** Delete File: binary.dat\n" + blockLaterWrite())).rejects.toThrow();

    expect(readFileSync(path)).toEqual(bytes);
    expectMode(path, 0o751);
  });

  test("rollback restores binary bytes overwritten by Add File", async () => {
    const path = join(dir, "binary.dat");
    const bytes = Buffer.from([0x00, 0xfe, 0xff, 0x80]);
    writeFileSync(path, bytes);
    chmodSync(path, 0o640);

    await expect(
      apply("*** Add File: binary.dat\n+replacement\n" + blockLaterWrite()),
    ).rejects.toThrow();

    expect(readFileSync(path)).toEqual(bytes);
    expectMode(path, 0o640);
  });

  test("rollback restores both sides of a move over an existing binary target", async () => {
    const source = join(dir, "source.sh");
    const target = join(dir, "target.dat");
    const targetBytes = Buffer.from([0xff, 0x00, 0x80]);
    writeFileSync(source, "before\r\n");
    chmodSync(source, 0o751);
    writeFileSync(target, targetBytes);
    chmodSync(target, 0o600);

    await expect(
      apply(
        "*** Update File: source.sh\n*** Move to: target.dat\n-before\n+after\n" +
          blockLaterWrite(),
      ),
    ).rejects.toThrow();

    expect(readFileSync(source)).toEqual(Buffer.from("before\r\n"));
    expectMode(source, 0o751);
    expect(readFileSync(target)).toEqual(targetBytes);
    expectMode(target, 0o600);
  });

  describe.skipIf(process.platform === "win32")("read-only rollback", () => {
    test.each([0o444, 0o555])(
      "restores an overwritten target made read-only by a move (source mode: %o)",
      async (mode) => {
        const source = join(dir, "source.sh");
        const target = join(dir, "target.dat");
        const targetBytes = Buffer.from([0xff, 0x00, 0x80]);
        writeFileSync(source, "before\n");
        chmodSync(source, mode);
        writeFileSync(target, targetBytes);
        chmodSync(target, 0o600);

        await expect(
          apply(
            "*** Update File: source.sh\n*** Move to: target.dat\n-before\n+after\n" +
              blockLaterWrite(),
          ),
        ).rejects.toThrow();

        expect(readFileSync(source, "utf8")).toBe("before\n");
        expectMode(source, mode);
        expect(readFileSync(target)).toEqual(targetBytes);
        expectMode(target, 0o600);
      },
    );

    test.each([0o444, 0o555])(
      "recreates a deleted read-only snapshot and restores its mode (%o)",
      async (mode) => {
        const path = join(dir, "binary.dat");
        const bytes = Buffer.from([0xff, 0x80, 0x00]);
        writeFileSync(path, bytes);
        chmodSync(path, mode);

        await expect(apply("*** Delete File: binary.dat\n" + blockLaterWrite())).rejects.toThrow();

        expect(readFileSync(path)).toEqual(bytes);
        expectMode(path, mode);
      },
    );

    test("restores original permissions even when restoring the bytes fails", async () => {
      const path = join(dir, "source.sh");
      writeFileSync(path, "before\n");
      chmodSync(path, 0o444);
      const writeFile = fs.writeFile;
      const failure = new Error("injected commit failure");
      let restoreAttempted = false;
      const spy = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
        if (target === path) {
          if (typeof data === "string") {
            chmodSync(path, 0o600);
            await writeFile(target, "partially written");
            throw failure;
          }
          restoreAttempted = true;
          throw new Error("injected restore failure");
        }
        await writeFile(target, data, options);
      });
      try {
        await expect(apply("*** Add File: source.sh\n+replacement\n")).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }

      expect(restoreAttempted).toBe(true);
      expectMode(path, 0o444);
    });
  });

  test("rollback removes a new move destination and restores the source", async () => {
    const source = join(dir, "source.sh");
    const target = join(dir, "target.sh");
    writeFileSync(source, "before\n");
    chmodSync(source, 0o751);

    await expect(
      apply(
        "*** Update File: source.sh\n*** Move to: target.sh\n-before\n+after\n" + blockLaterWrite(),
      ),
    ).rejects.toThrow();

    expect(readFileSync(source, "utf8")).toBe("before\n");
    expectMode(source, 0o751);
    expect(existsSync(target)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a chmod failure rolls back the destination already written by the failing change",
    async () => {
      const source = join(dir, "source.sh");
      const target = join(dir, "target.dat");
      const targetBytes = Buffer.from([0xff, 0x00, 0x80]);
      writeFileSync(source, "before\n");
      chmodSync(source, 0o751);
      writeFileSync(target, targetBytes);
      chmodSync(target, 0o600);
      const chmod = fs.chmod;
      const failure = new Error("injected chmod failure");
      let failed = false;
      const spy = spyOn(fs, "chmod").mockImplementation(async (path, mode) => {
        if (path === target && !failed) {
          failed = true;
          throw failure;
        }
        await chmod(path, mode);
      });
      try {
        await expect(
          apply("*** Update File: source.sh\n*** Move to: target.dat\n-before\n+after\n"),
        ).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }

      expect(failed).toBe(true);
      expect(readFileSync(source, "utf8")).toBe("before\n");
      expectMode(source, 0o751);
      expect(readFileSync(target)).toEqual(targetBytes);
      expectMode(target, 0o600);
    },
  );

  test("a partially failing write restores that change's original bytes", async () => {
    const path = join(dir, "binary.dat");
    const bytes = Buffer.from([0xff, 0x00, 0x80]);
    writeFileSync(path, bytes);
    chmodSync(path, 0o640);
    const writeFile = fs.writeFile;
    const failure = new Error("injected partial write failure");
    let failed = false;
    const spy = spyOn(fs, "writeFile").mockImplementation(async (target, data, options) => {
      if (target === path && !failed) {
        failed = true;
        await writeFile(target, "partially written");
        throw failure;
      }
      await writeFile(target, data, options);
    });
    try {
      await expect(apply("*** Add File: binary.dat\n+replacement\n")).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }

    expect(failed).toBe(true);
    expect(readFileSync(path)).toEqual(bytes);
    expectMode(path, 0o640);
  });

  test("an existing directory is preserved when an Add File targets it", async () => {
    const path = join(dir, "directory");
    mkdirSync(path);
    writeFileSync(join(path, "kept.txt"), "keep\n");
    writeFileSync(join(dir, "before.txt"), "before\n");

    await expect(
      apply(
        "*** Update File: before.txt\n-before\n+after\n" +
          "*** Add File: directory\n+cannot replace a directory\n",
      ),
    ).rejects.toThrow();

    expect(statSync(path).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "kept.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(dir, "before.txt"), "utf8")).toBe("before\n");
  });
});
