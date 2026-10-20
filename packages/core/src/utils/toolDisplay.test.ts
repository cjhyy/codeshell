import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { formatToolArgs, relativizeDisplayPath } from "./toolDisplay.js";

describe("relativizeDisplayPath", () => {
  test("shortens a native Windows absolute path under cwd", () => {
    const cwd = "C:\\Users\\dev\\projects\\a-long-workspace-name\\packages\\service";
    expect(relativizeDisplayPath(`${cwd}\\src\\alpha.ts`, cwd, path.win32)).toBe("src\\alpha.ts");
    expect(relativizeDisplayPath(cwd, cwd, path.win32)).toBe(".");
  });

  test("keeps Windows paths outside cwd and relative paths unchanged", () => {
    const cwd = "C:\\work\\repo";
    expect(relativizeDisplayPath("D:\\other\\file.ts", cwd, path.win32)).toBe("D:\\other\\file.ts");
    expect(relativizeDisplayPath("C:\\work\\repository\\x.ts", cwd, path.win32)).toBe(
      "C:\\work\\repository\\x.ts",
    );
    expect(relativizeDisplayPath("src\\x.ts", cwd, path.win32)).toBe("src\\x.ts");
  });

  test("POSIX paths keep their cwd-relative display", () => {
    expect(relativizeDisplayPath("/work/repo/src/x.ts", "/work/repo", path.posix)).toBe("src/x.ts");
    expect(relativizeDisplayPath("/work/repository/x.ts", "/work/repo", path.posix)).toBe(
      "/work/repository/x.ts",
    );
  });

  test("formatToolArgs shows the cwd-relative file path", () => {
    expect(formatToolArgs("Read", { file_path: path.join(process.cwd(), "src", "x.ts") })).toBe(
      path.join("src", "x.ts"),
    );
  });
});
