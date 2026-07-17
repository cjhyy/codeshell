import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractNpmTar } from "./npmTar.js";

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, "0") + "\0", "ascii");
}

function tarEntry(name: string, content: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(type === "5" ? 0o755 : 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(content.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function tar(entries: Array<{ name: string; content?: string; type?: string }>): Buffer {
  return Buffer.concat([
    ...entries.map((entry) =>
      tarEntry(entry.name, Buffer.from(entry.content ?? ""), entry.type ?? "0"),
    ),
    Buffer.alloc(1024),
  ]);
}

async function withTar(
  archive: Buffer,
  operation: (tarPath: string, output: string, root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cs-npm-tar-test-"));
  const tarPath = join(root, "input.tar");
  const output = join(root, "output");
  writeFileSync(tarPath, archive);
  try {
    await operation(tarPath, output, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("secure npm tar extraction", () => {
  test("extracts regular files and directories with private materialization", async () => {
    await withTar(
      tar([
        { name: "package/", type: "5" },
        { name: "package/skills/", type: "5" },
        { name: "package/skills/demo/SKILL.md", content: "safe" },
      ]),
      async (tarPath, output) => {
        await extractNpmTar(tarPath, output);
        expect(readFileSync(join(output, "package", "skills", "demo", "SKILL.md"), "utf8")).toBe(
          "safe",
        );
      },
    );
  });

  test("rejects absolute, traversal, backslash and overly-deep paths", async () => {
    const unsafe = [
      "../../escape",
      "/absolute",
      "package\\outside",
      `package/${Array.from({ length: 33 }, () => "d").join("/")}`,
    ];
    for (const name of unsafe) {
      await withTar(tar([{ name, content: "bad" }]), async (tarPath, output) => {
        await expect(extractNpmTar(tarPath, output)).rejects.toThrow(/unsafe|escapes/);
      });
    }
  });

  test("fails closed for links, devices, FIFOs and unknown special types", async () => {
    for (const type of ["1", "2", "3", "4", "6", "7"]) {
      await withTar(tar([{ name: `package/special-${type}`, type }]), async (tarPath, output) => {
        await expect(extractNpmTar(tarPath, output)).rejects.toThrow(/forbidden/);
      });
    }
  });

  test("rejects duplicate portable paths and corrupt checksums", async () => {
    await withTar(
      tar([
        { name: "package/A.txt", content: "a" },
        { name: "package/a.txt", content: "b" },
      ]),
      async (tarPath, output) => {
        await expect(extractNpmTar(tarPath, output)).rejects.toThrow(/duplicate/);
      },
    );

    const corrupt = tar([{ name: "package/a.txt", content: "a" }]);
    corrupt[0] = corrupt[0]! ^ 1;
    await withTar(corrupt, async (tarPath, output) => {
      await expect(extractNpmTar(tarPath, output)).rejects.toThrow(/checksum/);
    });
  });

  test("rejects archives without the two-block tar end marker", async () => {
    const valid = tar([{ name: "package/a.txt", content: "a" }]);
    await withTar(valid.subarray(0, valid.length - 1024), async (tarPath, output) => {
      await expect(extractNpmTar(tarPath, output)).rejects.toThrow(/end marker/);
    });
  });
});
