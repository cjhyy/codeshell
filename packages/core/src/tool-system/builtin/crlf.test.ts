import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit.js";
import { detectEol, toLf, applyEol } from "./eol.js";

// P4: Windows files are CRLF; the model emits LF. Edit/ApplyPatch must match
// across the EOL difference AND preserve the file's original line endings on
// write (so a CRLF file doesn't get silently rewritten to LF → whole-file diff).

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cs-crlf-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("eol helpers", () => {
  test("detectEol", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("noeol")).toBe("\n");
  });
  test("toLf collapses CRLF and lone CR", () => {
    expect(toLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
  test("applyEol round-trips", () => {
    expect(applyEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(applyEol("a\nb\n", "\n")).toBe("a\nb\n");
  });
});

describe("Edit on a CRLF file (P4)", () => {
  test("matches an LF old_string against CRLF content and keeps CRLF on write", async () => {
    const dir = tmp();
    const file = join(dir, "auth.ts");
    // CRLF file (as a Windows editor would save it).
    writeFileSync(file, "function login() {\r\n  return token;\r\n}\r\n");

    // old_string / new_string use LF, like the model emits.
    const res = await editTool(
      { file_path: file, old_string: "  return token;", new_string: "  return refresh();" },
      { cwd: dir } as never,
    );
    expect(res).toContain("Successfully edited");

    const after = readFileSync(file, "utf-8");
    // Edit applied…
    expect(after).toContain("return refresh();");
    // …and the file is STILL CRLF (not silently converted to LF).
    expect(after).toBe("function login() {\r\n  return refresh();\r\n}\r\n");
  });

  test("an LF file stays LF", async () => {
    const dir = tmp();
    const file = join(dir, "x.ts");
    writeFileSync(file, "a\nb\nc\n");
    await editTool({ file_path: file, old_string: "b", new_string: "B" }, { cwd: dir } as never);
    expect(readFileSync(file, "utf-8")).toBe("a\nB\nc\n");
  });
});
